#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { normaliseCorporateAnnouncements, announcementRange, announcementSourceUrls, announcementUrl, announcementDocumentIdentity, mergeAnnouncements } from '../public/js/data/announcements-shared.js';
import { withAnnouncementLookups } from '../public/js/data/announcements-extra.js';
import { clearAll } from '../public/js/core/store.js';
import { loadCompanyCaptureIndex } from '../public/js/data/company-captures.js';
import { CATEGORIES, annUrl, fetchAnnouncements, fetchCompanyAnnouncements } from '../worker/bse-ann.mjs';

const pdf = 'a1111111-1111-1111-1111-111111111111.pdf';
for (let repeat = 0; repeat < 2; repeat++) {
  for (const unsafe of [null, undefined, '', 'javascript:alert(1)', 'https://user:password@example.test/a.pdf', 'not a URL']) {
    assert.equal(announcementUrl(unsafe), null);
    assert.equal(announcementDocumentIdentity(unsafe), null);
  }
  assert.equal(announcementDocumentIdentity(`https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pdf}`), `bse:${pdf}`);
  assert.equal(announcementDocumentIdentity(`https://www.bseindia.com/xml-data/corpfiling/AttachHis/${pdf}`), `bse:${pdf}`);
}
const mutableUrl = new URL('https://example.test/report.pdf');
for (let i = 0; i < 17000; i++) {
  const url = `https://example.test/report-${i}.pdf`;
  assert.equal(announcementUrl(url), url);
  assert.equal(announcementDocumentIdentity(url), `example.test/report-${i}.pdf`);
}
assert.equal(announcementDocumentIdentity(`https://www.bseindia.com/xml-data/corpfiling/AttachHis/${pdf}`), `bse:${pdf}`,
  'document identities survive cache rotation across a long stream');
const longUrl = `https://example.test/${'a'.repeat(600)}.pdf`;
assert.equal(announcementUrl(longUrl), longUrl, 'cache bounds never reject a valid long source link');
assert.equal(announcementDocumentIdentity(longUrl), longUrl.slice('https://'.length));
assert.equal(announcementUrl(mutableUrl), mutableUrl.href);
mutableUrl.username = 'private';
assert.equal(announcementUrl(mutableUrl), null, 'a changed URL object is validated again');
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
const kisshtHash = `sha256:${'4c'.repeat(32)}`;
const kisshtPairId = `sha256:${'7a'.repeat(32)}`;
const kisshtBse = { ticker: 'KISSHT', date: '2026-09-01', time: '15:46:24', title: 'Analyst meet intimation',
  source: 'BSE', url: 'https://www.bseindia.com/onemi-investor-meet.pdf', documentHash: kisshtHash,
  crossExchangeDocumentId: kisshtPairId, providers: ['BSE company index'] };
const kisshtNse = { ticker: 'KISSHT', date: '2026-09-01', time: '15:56:52', title: 'Analysts/Institutional Investor Meet/Con. Call Updates',
  source: 'NSE', url: 'https://nsearchives.nseindia.com/corporate/onemi-investor-meet.pdf', documentHash: kisshtHash,
  crossExchangeDocumentId: kisshtPairId, providers: ['Muns corporate announcements'] };
const kisshtMerged = mergeAnnouncements([kisshtBse], [kisshtNse]);
assert.equal(kisshtMerged.length, 1, 'byte-identical cross-exchange PDFs appear once');
assert.equal(kisshtMerged[0].source, 'BSE / NSE');
assert.deepEqual(kisshtMerged[0].sources, ['BSE', 'NSE']);
assert.deepEqual(announcementSourceUrls(kisshtMerged[0]), [
  { source: 'BSE', url: kisshtBse.url }, { source: 'NSE', url: kisshtNse.url },
]);
const legacyKisshtMerged = mergeAnnouncements([{ ...kisshtBse, sourceUrls: undefined }], [kisshtNse]);
assert.deepEqual(announcementSourceUrls(legacyKisshtMerged[0]), [
  { source: 'BSE', url: kisshtBse.url }, { source: 'NSE', url: kisshtNse.url },
], 'a legacy single-source row keeps its primary link when a second exchange is merged');
assert.equal(mergeAnnouncements(kisshtMerged, [kisshtBse], [kisshtNse]).length, 1, 'cross-exchange merging is idempotent');
assert.equal(mergeAnnouncements([kisshtBse], [{ ...kisshtNse, documentHash: `sha256:${'5d'.repeat(32)}`, crossExchangeDocumentId: undefined }]).length, 2,
  'different documents remain separate even when their issuer, date and subject are similar');
assert.equal(mergeAnnouncements(
  [kisshtBse, { ...kisshtBse, time: '18:00:00', url: 'https://www.bseindia.com/second-filing.pdf', crossExchangeDocumentId: `sha256:${'8b'.repeat(32)}` }],
  [kisshtNse, { ...kisshtNse, time: '18:01:00', url: 'https://nsearchives.nseindia.com/corporate/second-filing.pdf', crossExchangeDocumentId: `sha256:${'8b'.repeat(32)}` }],
).length, 2, 'distinct same-day pairs survive even when their PDF bytes are identical');

// Customer-reported OnEMI history must remain in the durable archive after later capture runs.
const capturedKissht = JSON.parse(readFileSync(new URL('../public/data/filing-capture/announcements/KISSHT.json', import.meta.url), 'utf8'));
for (const [date, documentHash] of [
  ['2026-09-01', 'sha256:4c53840f1b4d242abc6000acea05b3c4327ae45156c37ec3cb26e7596cd1e51f'],
  ['2026-08-31', 'sha256:41ede8673108b8c6ed6fc5d10e702039c7b6379910aa2df6f5771ecf621b8c10'],
]) {
  const rows = capturedKissht.rows.filter(row => row.date === date && row.documentHash === documentHash);
  assert.equal(rows.length, 1, `${date} OnEMI filing remains one durable row`);
  assert.deepEqual(rows[0].sources, ['BSE', 'NSE']);
  assert.equal(rows[0].source, 'BSE / NSE');
  assert.deepEqual(new Set(announcementSourceUrls(rows[0]).map(item => item.source)), new Set(['BSE', 'NSE']));
}

assert(CATEGORIES.includes('Insider Trading / SAST'));
assert(CATEGORIES.includes('Others'));
const companyUrl = new URL(annUrl({ category: '-1', from: '2026-05-01', to: '2026-09-07', page: 2, scripCode: 544754 }));
assert.equal(companyUrl.searchParams.get('strScrip'), '544754');
assert.equal(companyUrl.searchParams.get('strCat'), '-1');
assert.equal(companyUrl.searchParams.get('pageno'), '2');
assert.equal(new URL(annUrl({ category: 'Company Update', from: '2026-09-07', to: '2026-09-07' })).searchParams.get('strScrip'), '');
assert.throws(() => annUrl({ category: '-1', from: '2026-05-01', to: '2026-09-07', scripCode: 'KISSHT' }), /six digits/);
assert.throws(() => annUrl({ category: '-1', from: '2026-05-01', to: '2026-09-07', page: 0, scripCode: '544754' }), /positive integer/);
assert.throws(() => annUrl({ category: '-1', from: '2026-02-30', to: '2026-09-07', scripCode: '544754' }), /valid YYYYMMDD/);
assert.throws(() => annUrl({ category: '-1', from: '2026-09-08', to: '2026-09-07', scripCode: '544754' }), /ordered/);
assert.throws(() => annUrl({ category: '-1', from: '2026-09-01garbage', to: '2026-09-07', scripCode: '544754' }), /valid YYYYMMDD/);
assert.throws(() => annUrl({ category: '-1', from: '202609011234', to: '2026-09-07', scripCode: '544754' }), /valid YYYYMMDD/);
assert.throws(() => annUrl({ category: '-1', from: new Date('invalid'), to: '2026-09-07', scripCode: '544754' }), /valid YYYYMMDD/);

const bseCompanyRow = (id, code = 544754) => ({
  NEWSID: `kissht-${id}`, SCRIP_CD: code, SLONGNAME: 'OnEMI Technology Solutions Ltd',
  HEADLINE: `KISSHT filing ${id}`, NEWSSUB: `KISSHT filing ${id}`, CATEGORYNAME: id % 2 ? 'Others' : 'Company Update',
  SUBCATNAME: 'Analyst / Investor Meet', DissemDT: `2026-09-01T15:${String(id % 60).padStart(2, '0')}:00`,
  ATTACHMENTNAME: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}.pdf`,
});
const bsePage = (rows, declared = rows.length) => Response.json({ Table: rows, Table1: [{ ROWCNT: String(declared) }] });
const bseMarketRow = (id) => ({ ...bseCompanyRow(id), CATEGORYNAME: 'Company Update' });
let companyCalls = [], companyProgress = [];
const companyCapture = await fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-05-01', to: '2026-09-07' },
  { gapMs: 0, onProgress: value => companyProgress.push(value), fetchImpl: async url => {
    companyCalls.push(new URL(url));
    return companyCalls.length === 1
      ? bsePage(Array.from({ length: 50 }, (_, i) => bseCompanyRow(i)), 52)
      : bsePage([bseCompanyRow(50), bseCompanyRow(51)], 52);
  } },
);
assert.deepEqual({ declared: companyCapture.declared, collected: companyCapture.collected, pages: companyCapture.pages, requests: companyCapture.requests },
  { declared: 52, collected: 52, pages: 2, requests: 2 });
assert(companyCapture.rows.every(row => row.scripCode === '544754'));
assert(companyCapture.rows.some(row => row.category === 'Others'));
assert(companyCalls.every(url => url.searchParams.get('strScrip') === '544754' && url.searchParams.get('strCat') === '-1'));
assert.deepEqual(companyProgress.map(({ page, got, declared }) => ({ page, got, declared })), [
  { page: 1, got: 50, declared: 52 }, { page: 2, got: 52, declared: 52 },
]);

let marketPage = 0;
const marketCapture = await fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => ++marketPage === 1
    ? bsePage(Array.from({ length: 50 }, (_, i) => bseMarketRow(i)), 51)
    : bsePage([bseMarketRow(50)], 51) },
);
assert.deepEqual(marketCapture.byCategory['Company Update'], { declared: 51, collected: 51, pages: 2 });
assert.equal(marketCapture.rows.length, 51);
assert.deepEqual(marketCapture.shortfall, []);

await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, maxResponseBytes: 64, fetchImpl: async () => new Response(JSON.stringify({
    Table: [bseMarketRow(1)], Table1: [{ ROWCNT: '1' }], padding: 'x'.repeat(256),
  })) },
), /exceeded the 64-byte page limit/, 'market-wide capture bounds a BSE page even without Content-Length');

let timedOutSignal = null;
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, timeoutMs: 10, fetchImpl: async (_url, init) => {
    timedOutSignal = init.signal;
    return new Promise(() => {});
  } },
), /did not answer within 10ms/, 'company capture has a deadline even when an injected fetch ignores AbortSignal');
assert(timedOutSignal instanceof AbortSignal && timedOutSignal.aborted,
  'the centralized BSE deadline also aborts a cooperative injected fetch');

await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => Response.json({ Table: [bseMarketRow(1)], Table1: [] }) },
), /valid announcement count/, 'market-wide capture cannot claim coverage without BSE\'s declared count');
await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => bsePage([{ ...bseCompanyRow(1), CATEGORYNAME: 'Others' }], 1) },
), /while Company Update was requested/, 'an ignored category filter cannot be called complete');
let changingMarketPage = 0;
await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => ++changingMarketPage === 1
    ? bsePage(Array.from({ length: 50 }, (_, i) => bseMarketRow(i)), 51)
    : bsePage([bseMarketRow(50)], 52) },
), /changed the declared count/, 'market-wide pagination rejects a count that changes between pages');
await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => bsePage([bseMarketRow(1)], 0) },
), /more rows than it declared/, 'market-wide pagination rejects a page beyond the declared total');
await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'] },
  { gapMs: 0, fetchImpl: async () => bsePage(Array.from({ length: 49 }, (_, i) => bseMarketRow(i)), 51) },
), /before its declared count/, 'market-wide pagination rejects an early short page');
await assert.rejects(() => fetchAnnouncements(
  { from: '2026-09-01', to: '2026-09-01', categories: ['Company Update'], maxPages: 1 },
  { gapMs: 0, fetchImpl: async () => bsePage(Array.from({ length: 50 }, (_, i) => bseMarketRow(i)), 51) },
), /safety limit/, 'market-wide pagination never silently truncates at maxPages');

const emptyCompanyCapture = await fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-02', to: '2026-09-02' },
  { gapMs: 0, fetchImpl: async () => bsePage([], 0) },
);
assert.deepEqual({ declared: emptyCompanyCapture.declared, collected: emptyCompanyCapture.collected, pages: emptyCompanyCapture.pages },
  { declared: 0, collected: 0, pages: 1 }, 'a shape-valid declared zero is a proven empty company window');

await assert.rejects(() => {
  let page = 0;
  const repeated = bseCompanyRow(0); delete repeated.NEWSID;
  return fetchCompanyAnnouncements(
    { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
    { gapMs: 0, fetchImpl: async () => ++page === 1
      ? bsePage([repeated, ...Array.from({ length: 49 }, (_, i) => bseCompanyRow(i + 1))], 51)
      : bsePage([repeated], 51) },
  );
}, /repeated an announcement/, 'a repeated row without NEWSID cannot impersonate a complete second page');

await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => bsePage([bseCompanyRow(1, 500325)], 1) },
), /returned scrip 500325/);
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => bsePage([{ ...bseCompanyRow(1), DissemDT: '2020-01-01T15:01:00' }], 1) },
), /outside the requested date range/, 'an ignored BSE date filter cannot close the requested company window');
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => {
    const malformed = bseCompanyRow(1); delete malformed.HEADLINE; delete malformed.NEWSSUB;
    return bsePage([malformed], 1);
  } },
), /without a recognizable headline/, 'a BSE schema drift cannot advance company coverage with blank rows');
let changingPage = 0;
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => ++changingPage === 1
    ? bsePage(Array.from({ length: 50 }, (_, i) => bseCompanyRow(i)), 51)
    : bsePage([bseCompanyRow(50)], 52) },
), /changed the declared count/);
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => bsePage(Array.from({ length: 49 }, (_, i) => bseCompanyRow(i)), 51) },
), /before its declared count/);
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01', maxPages: 1 },
  { gapMs: 0, fetchImpl: async () => bsePage(Array.from({ length: 50 }, (_, i) => bseCompanyRow(i)), 51) },
), /safety limit/);
await assert.rejects(() => fetchCompanyAnnouncements(
  { scripCode: '544754', from: '2026-09-01', to: '2026-09-01' },
  { gapMs: 0, fetchImpl: async () => Response.json({ Table: [] }) },
), /valid announcement count/);

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

  await clearAll();
  let baseFails = true, companyReads = 0;
  const captured = { version: 1, companies: [{ ticker: 'A' }, { ticker: 'B' }], sources: { announcements: {
    A: { rowCount: 1, lastResponseAt: '2026-09-04T07:00:00Z' },
    B: { rowCount: 1, lastResponseAt: '2026-09-04T07:00:00Z' },
  } } };
  globalThis.fetch = async url => {
    if (String(url).endsWith('/index.json')) return Response.json(captured);
    companyReads++;
    const ticker = String(url).includes('/A.json') ? 'A' : 'B';
    return Response.json({ rows: [{ ticker, date: '2020-01-01', title: `${ticker} history`, url: `https://example.test/${ticker}.pdf` }] });
  };
  await loadCompanyCaptureIndex({ force: true });
  const archived = withAnnouncementLookups({ ...base, rows: () => [],
    loadArchive: async () => { if (baseFails) throw new Error('BSE archive unavailable'); } });
  await archived.loadArchive({ onlyChanged: true });
  assert.equal(archived.rows().length, 2, 'a base archive failure does not discard successful company histories');
  assert.equal(archived.meta().archive.pending, false, 'a rejected base archive cannot leave history stuck pending');
  assert(archived.meta().archive.error);
  assert.equal(companyReads, 2);
  baseFails = false;
  await archived.loadArchive({ onlyChanged: true });
  assert.equal(archived.meta().archive.error, null, 'the next refresh recovers after a base archive rejection');
  assert.equal(companyReads, 2, 'successful unchanged company files are not fetched again');
  captured.sources.announcements.A.lastResponseAt = '2026-09-04T08:00:00Z';
  await loadCompanyCaptureIndex({ force: true });
  await archived.loadArchive({ onlyChanged: true });
  assert.equal(companyReads, 3, 'newly parsed partial rows refresh even when a full-success timestamp has not advanced');
} finally {globalThis.fetch=originalFetch;globalThis.caches=originalCaches;await clearAll()}
console.log('PASS grouped announcements, scope identity, date contract, auth/cache and additive device retention');
