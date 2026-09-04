#!/usr/bin/env node
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { normaliseCorporateAnnouncements, announcementRange, mergeAnnouncements } from '../public/js/data/announcements-shared.js';
import { withAnnouncementLookups } from '../public/js/data/announcements-extra.js';
import { clearAll } from '../public/js/core/store.js';

const pdf = 'a1111111-1111-1111-1111-111111111111.pdf';
const fixture = [
  { source: 'BSE', data: [{ symbol: '500325', title: 'Board meeting', date: '2026-07-10T17:46:25.00', attachment: `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${pdf}` }] },
  { source: 'NSE', data: [{ symbol: 'RELIANCE', title: 'Analyst meet', date: '2026-07-10T17:46:25.00', attachment: 'https://nsearchives.nseindia.com/corporate/meet.pdf' }] },
  { source: 'DRHP', data: [{ title: 'Draft prospectus', link: 'https://www.sebi.gov.in/prospectus.pdf' }] },
];
const parsed = normaliseCorporateAnnouncements(fixture, 'RELIANCE');
assert.deepEqual(parsed.groups, ['BSE', 'NSE', 'DRHP']);
assert.equal(parsed.announcements.length, 3);
assert.equal(parsed.announcements[0].ticker, 'RELIANCE', 'BSE scrip codes never replace the scope ticker');
assert.equal(parsed.announcements[0].scripCode, '500325');
assert.equal(parsed.announcements[0].time, '17:46:25');
assert.equal(parsed.announcements[2].date, null, 'undated DRHP is preserved without inventing a date');
assert.equal(normaliseCorporateAnnouncements([], 'TEST').announcements.length, 0);
assert.throws(() => normaliseCorporateAnnouncements({ error: 'Expired token' }, 'TEST'));
assert.throws(() => normaliseCorporateAnnouncements({ message: 'unknown' }, 'TEST'));
assert.equal(normaliseCorporateAnnouncements([...fixture, { source: 'NSE', error: 'Failed' }], 'TEST').skipped, 1);
assert.equal(announcementRange('20250101', '2026-07-15').from, '2025-01-01');
for (const [a,b] of [['20260230','20260301'],['20260801','20260101'],['','20260101']]) assert.throws(() => announcementRange(a,b));
const baseRow = { ...parsed.announcements[0], company: 'Reliance Industries', url: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pdf}`, providers: ['BSE date index'] };
const merged = mergeAnnouncements([baseRow], parsed.announcements);
assert.equal(merged.length, 3);
assert.deepEqual(merged.find(r=>r.source==='BSE').providers, ['BSE date index','Muns corporate announcements']);
assert.equal(mergeAnnouncements(merged, parsed.announcements).length, 3);
const noLink = { ticker: 'TEST', date: '2026-01-01', title: 'No document', source: 'NSE' };
assert.equal(mergeAnnouncements([noLink,noLink], [noLink]).length, 2, 'identical no-link multiplicity survives repeated answers');
assert.equal(mergeAnnouncements([noLink], [{...noLink,title:'Different filing'}]).length, 2);

const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
const cached = new Map(), jobs = [];
globalThis.caches = {default:{match:async key=>cached.get(key.url)?.clone(),put:async(key,value)=>cached.set(key.url,value.clone())}};
let calls = [];
try {
  globalThis.fetch=async(url, init)=>{calls.push({url,...init});return Response.json(fixture)};
  async function route(path, env={MUNS_TOKEN:'fixture-server-token'}, headers={}) {
    const res=await worker.fetch(new Request(`http://localhost${path}`,{headers}),env,{waitUntil:job=>jobs.push(job)});
    await Promise.all(jobs.splice(0)); return res;
  }
  const path='/api/announcements/reliance?from=2025-01-01&to=2026-07-15';
  const body=await (await route(path)).json();
  assert.equal(body.ok,true); assert.equal(body.count,3);
  assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].url,'https://devde.muns.io/filings/corp/announcements/RELIANCE?fromDate=20250101&toDate=20260715');
  assert.equal(calls[0].headers.authorization,'Bearer fixture-server-token');
  assert(!JSON.stringify(body).includes('fixture-server-token'));
  await route('/api/announcements/RELIANCE?fromDate=20250101&toDate=20260715');
  assert.equal(calls.length,1,'equivalent date formats share a cache entry');
  await route('/api/announcements/RELIANCE?from=2026-01-01&to=2026-07-15');
  assert.equal(calls.length,2,'different date ranges do not share responses');
  for (const invalid of ['/api/announcements/TEST','/api/announcements/TEST?from=2026-02-30&to=2026-03-01','/api/announcements/%E0%A4?from=20260101&to=20260715']) assert.equal((await route(invalid)).status,400);
  await route('/api/announcements/INFY?from=20260101&to=20260715',{}, {authorization:'Bearer fixture-caller-token'});
  assert.equal(calls.at(-1).headers.authorization,'Bearer fixture-caller-token');
  const missing=await (await route('/api/announcements/NOAUTH?from=20260101&to=20260715',{})).json();
  assert.equal(missing.reason,'no-token');
  globalThis.fetch=async()=>new Response('',{status:401});
  assert.equal((await (await route('/api/announcements/EXPIRED?from=20260101&to=20260715')).json()).reason,'unauthorised');

  await clearAll();
  let baseRows=[baseRow];
  const base={rows:()=>baseRows,meta:()=>({kind:'announcements',rowCount:baseRows.length,covered:baseRows.length,coversUniverse:true,windowDays:3}),seed:async()=>{},load:async()=>{},onChange:()=>()=>{},invalidate:()=>{},refresh:async()=>{},refreshSnapshot:async()=>{baseRows=[]}};
  const feed=withAnnouncementLookups(base);
  globalThis.fetch=async()=>{throw new Error('No per-company calls allowed during seed')};
  await feed.seed(); assert.equal(feed.rows().length,1);
  globalThis.fetch=async()=>Response.json({...body,fetchedAt:'2026-09-04T07:00:00Z'});
  const query={ticker:'RELIANCE',fromDate:'20250101',toDate:'20260715'};
  await feed.lookup(query); assert.equal(feed.rows().length,3);
  await feed.refreshSnapshot(); assert.equal(feed.rows().length,3,'BSE snapshot replacement cannot erase supplementary history');
  globalThis.fetch=async()=>Response.json({ok:true,announcements:[],fetchedAt:'2026-09-04T08:00:00Z'});
  await feed.lookup(query); assert.equal(feed.rows().length,3,'empty answers cannot retract filings');
  globalThis.fetch=async()=>Response.json({ok:false,message:'Session expired'});
  await feed.lookup(query); assert.equal(feed.rows().length,3); assert.equal(feed.lookupMeta().failed,1);
  const reloaded=withAnnouncementLookups(base); await reloaded.seed();
  assert.equal(reloaded.rows().length,3,'additional rows survive reload');
  assert.match(reloaded.lookupMeta().last.error,/expired/);
} finally {globalThis.fetch=originalFetch;globalThis.caches=originalCaches;await clearAll()}
console.log('PASS grouped announcements, scope identity, date contract, auth/cache and additive device retention');
