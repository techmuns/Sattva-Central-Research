import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {snapshotCapture} from '../public/js/data/breakout-snapshot.js';
import {openInterestForQuote,BREAKOUT_REPO} from '../public/js/data/breakout-live-shared.js';
import {conditionalJson,readEntry} from '../public/js/core/store.js';

const at=Date.parse('2026-10-16T06:30Z'),iso=new Date(at).toISOString();
const targets=Array.from({length:600},(_,i)=>`T${i}`),base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-10-15'};
const rows=targets.map((ticker,i)=>({ticker,price:108,volume:2300,prevClose:100,quoteAt:iso,checkedAt:iso,sessionDate:'2026-10-16',provider:'Upstox',exchange:'NSE',base,
  ...(i<2?{openInterest:{current:i?900:1100,previous:1000,instrumentKey:`NSE_FO|${12345+i}`,symbol:`${ticker} FUT 27 OCT 26`,expiry:'2026-10-27',quoteAt:iso,checkedAt:iso,sessionDate:'2026-10-16'}}:{})}));
const fallback={version:1,runId:'12345:1',state:'complete',startedAt:iso,completedAt:iso,targets,rows,failures:[],discoveryFailed:false};
const head={version:1,feature:'breakouts-live',repo:BREAKOUT_REPO,createdAt:iso,fallback,
  primary:{at,completedAt:at,targets,rows:rows.map(r=>({...r,price:111})),failures:[],discoveryFailed:false},
  schedule:{started:true,lastAttemptAt:at,overdue:false},primarySchedule:{started:true,configured:true,lastAttemptAt:at,nextAt:at+60000,reason:'ok',overdue:false}};
const pack=value=>({format:'gzip-json',gzip:gzipSync(JSON.stringify(value)).toString('base64')});
const packet=pack(head),current=await snapshotCapture(packet,at);
assert.equal(current.rows.length,600);assert.equal(current.rows[0].price,111);assert.equal(current.health.checked,600);
assert(Math.abs(openInterestForQuote(current.rows[0],at).changePercent-10)<1e-8);
assert(Math.abs(openInterestForQuote(current.rows[1],at).changePercent+10)<1e-8);
const aged=await snapshotCapture(packet,at+3*60000);
assert.equal(aged.rows[0].price,108,'An unchanged cached packet still switches to its fresh fallback');
assert.equal(aged.primarySchedule.overdue,true);assert.equal(aged.rows[0].quoteAt,iso);
const stale=await snapshotCapture(packet,at+21*60000);assert.equal(stale.health.checked,0);assert.equal(stale.health.partial,true);
assert.equal(openInterestForQuote(stale.rows[0],at+21*60000).changePercent,null,'A retained OI observation never acquires a fresh signal');
await assert.rejects(snapshotCapture({format:'gzip-json',gzip:'not gzip'},at));
await assert.rejects(snapshotCapture(pack({...head,feature:'summaries'}),at),/context/);
await assert.rejects(snapshotCapture(pack({...head,repo:'fixture/other'}),at),/context/);
await assert.rejects(snapshotCapture(pack({...head,createdAt:new Date(at+120000).toISOString()}),at),/context/);
await assert.rejects(snapshotCapture(pack({...head,fallback:{...fallback,rows:[{...rows[0],price:-1}]}}),at),/observation/);
await assert.rejects(snapshotCapture({format:'gzip-json',gzip:gzipSync(' '.repeat(5*1024*1024+1)).toString('base64')},at),/size limit/);
assert.equal((await snapshotCapture(packet,at)).rows.length,600,'Rejected packets preserve the last validated decode');

// The persistent store must await decompression and source validation before
// replacing last-good bytes, including both header- and body-tag cache hits.
const originalFetch=globalThis.fetch,key='verify:quote-snapshot:async';let incoming=packet,etag='"first"',checked=0;
try {
  globalThis.fetch=async()=>Response.json(incoming,{headers:etag?{etag}:{}});
  const validate=async value=>{await Promise.resolve();checked++;await snapshotCapture(value,at);};
  await conditionalJson('/api/breakouts/snapshot',{key,validate});assert.equal(checked,1);
  incoming={format:'gzip-json',gzip:'corrupt'};etag='"second"';
  await assert.rejects(conditionalJson('/api/breakouts/snapshot',{key,validate}));
  assert.equal((await readEntry(key)).value.gzip,packet.gzip,'An invalid asynchronous response cannot replace persistent last-good evidence');
  etag='"first"';
  await assert.rejects(conditionalJson('/api/breakouts/snapshot',{key,validate:async()=>{await Promise.resolve();throw Error('cached rejection');}}),/cached rejection/);
  etag=null;incoming={...packet,meta:{contentTag:'"first"'}};
  await assert.rejects(conditionalJson('/api/breakouts/snapshot',{key,validate:async()=>{await Promise.resolve();throw Error('body-tag rejection');}}),/body-tag rejection/);

  const live=await import('../public/js/data/breakout-live.js');let legacyReads=0;
  globalThis.fetch=async path=>{if(path!=='/api/breakouts/snapshot'){legacyReads++;throw Error('Healthy snapshot must not fall back');}return Response.json(packet);};
  await live.refresh();assert.equal(live.unavailable(),false);assert.equal(live.snapshot().rows.length,600);assert.equal(legacyReads,0);
  globalThis.fetch=async path=>path==='/api/breakouts/snapshot'?Response.json({format:'gzip-json',gzip:'broken'}):Response.json(fallback);
  await live.refresh();assert.equal(live.unavailable(),false);assert.equal(live.snapshot().rows[0].price,108,'Older or unavailable snapshot delivery keeps the compatibility reader');
  globalThis.fetch=async()=>{throw Error('offline fixture');};
  const reopened=await import('../public/js/data/breakout-live.js?offline-snapshot-fixture');await reopened.refresh();
  assert.equal(reopened.unavailable(),true);assert.equal(reopened.snapshot().rows.length,600);assert.equal(reopened.snapshot().rows[0].quoteAt,iso,'Reopening offline restores the validated source packet with its original source clock');
} finally {globalThis.fetch=originalFetch;}
console.log('PASS compressed quote reader: 600 rows, signed OI, read-time fallback/expiry, bounded inflation, rejected malformed contexts and awaited cache validation without losing last-good data');
