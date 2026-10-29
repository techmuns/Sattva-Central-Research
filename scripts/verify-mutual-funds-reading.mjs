// Isolated public fixtures. No source collection, private session or production requests.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {comparisonStatus} from '../public/js/data/mutual-funds-status.js';
globalThis.location=new URL('https://mf-reading.test');
// Hold a real store-open completion behind the first network read.
let storageRequest;
globalThis.indexedDB={open:()=>storageRequest={}};
const feed=await import('../public/js/data/mutual-funds.js');
const rows=Array.from({length:251},(_,i)=>({activityBasis:'equity-hybrid-ex-arbitrage-v1',isin:'INE'+String(i).padStart(9,'0'),name:`Fixture ${i}`,month:'2026-09',totalShares:i,netChange:1,comparableFunds:1,addedFunds:1,reducedFunds:0}));
const stamp='2026-10-22T07:00:00Z';
let snapshotId='a'.repeat(64),lastValue=250,failTail=true,repeatCursor=false,badScope=false,reads=0,finished=false;
let releaseTail,releaseAll;const tailGate=new Promise(resolve=>releaseTail=resolve);let allGate=null;
globalThis.fetch=async raw=>{
  reads++;const url=new URL(raw,location);assert.equal(url.pathname,'/api/mutual-funds');
  if(allGate)await allGate;
  const ids=url.searchParams.get('isins')?.split(','),cursor=url.searchParams.get('cursor');
  if(cursor){await tailGate;if(failTail)throw Error('Fixture delivery failure');}
  const source=rows.map((row,i)=>i===250?{...row,totalShares:lastValue}:row);
  const value={rows:ids?(badScope?[{...source[0],isin:'INE999999999',totalShares:999999}]:source.filter(row=>ids.includes(row.isin))):cursor?source.slice(250):source.slice(0,250),
    meta:{checkedAt:stamp,run:'123:1',...(snapshotId?{publicSnapshotId:snapshotId}:{})},
    nextCursor:ids?null:cursor?(repeatCursor?cursor:null):source[249].isin};
  const body=JSON.stringify(value);return new Response(body,{headers:{'content-type':'application/json',etag:createHash('sha256').update(body).digest('hex')}});
};
const began=performance.now();let firstMs;
const first=new Promise(resolve=>feed.onUpdate(()=>{if(feed.all().length&&firstMs===undefined){firstMs=performance.now()-began;resolve();}}));
const work=feed.load('universe',{holdings:[]}).then(value=>{finished=true;return value;});
await Promise.race([first,new Promise((_,reject)=>setTimeout(()=>reject(Error('Blocked storage delayed first public page')),1000))]);
assert.equal(feed.all().length,250);assert.equal(finished,false);assert.equal(feed.meta().viewIncomplete,true);
assert.equal(feed.meta().checkedAt,stamp,'Reading source data cannot advance its source clock');
releaseTail();await work;
assert.equal(feed.all().length,250,'A later failed page keeps the verified first page');assert.equal(feed.meta().readFailed,true);assert.equal(feed.meta().viewIncomplete,true,'A first-page subset cannot become a complete export');
const restored=new Promise(resolve=>{const off=feed.onUpdate(()=>{if(feed.all().length===251){off();resolve();}});});
const older={value:{rows:rows.map(row=>({...row,totalShares:-5})),meta:{checkedAt:'2026-10-21T07:00:00Z',publicSnapshotId:'0'.repeat(64)}}};
storageRequest.result={transaction(){
  const transaction={objectStore:()=>({get(key){const request={result:key==='mf-snapshot:universe'?older:null};queueMicrotask(()=>request.onsuccess?.());return request;},put:(_value,key)=>({result:key})})};
  setTimeout(()=>transaction.oncomplete?.(),0);return transaction;
}};
storageRequest.onsuccess();await restored;
assert.equal(feed.all()[0].totalShares,0,'A late older cache cannot overwrite a newly verified page');
assert.equal(feed.meta().checkedAt,stamp,'Restoration cannot replace the verified source clock');
assert.equal(feed.meta().viewIncomplete,true,'A late full cache cannot certify mixed-generation pages after a failed read');
failTail=false;let before=reads;
await Promise.all([feed.load('universe',{holdings:[]}),feed.load('universe',{holdings:[]})]);
assert.equal(reads-before,2,'Concurrent callers share one complete walk');assert.equal(feed.all().length,251);assert.equal(feed.meta().viewIncomplete,false);
before=reads;const same=await feed.load('universe',{holdings:[]});
assert.equal(reads-before,1,'A verified whole-index digest revalidates the complete saved universe with one probe');assert.equal(same.rows.length,251);
snapshotId='b'.repeat(64);lastValue=777;before=reads;
await feed.load('universe',{holdings:[]});
assert.equal(reads-before,2,'A change outside the first page requires full pagination');assert.equal(feed.all().at(-1).totalShares,777);
allGate=new Promise(resolve=>releaseAll=resolve);
const scoped=feed.load('portfolio',{holdings:[rows.at(-1)]});
assert.equal(feed.scopedRows('portfolio',[rows.at(-1)])[0].totalShares,777,'Universe cache supplies a new scope before its response');
assert.equal(feed.meta().publicRevalidating,true);releaseAll();allGate=null;await scoped;
snapshotId=null;lastValue=888;before=reads;await feed.load('universe',{holdings:[]});
assert.equal(reads-before,2,'Older API versions without a whole-index digest keep full pagination');assert.equal(feed.all().at(-1).totalShares,888);
snapshotId='c'.repeat(64);repeatCursor=true;before=reads;await feed.load('universe',{holdings:[]});
assert.equal(reads-before,2,'A repeated cursor stops instead of spinning indefinitely');assert.equal(feed.meta().readFailed,true);assert.equal(feed.all().length,251);
assert.equal(feed.meta().viewIncomplete,true,'A failed refresh cannot certify a mixture of old and new pages for export');
badScope=true;await feed.load('portfolio',{holdings:[rows[0]]});
assert.equal(feed.meta().readFailed,true,'A scoped response cannot include an unrequested issuer');
assert.equal(feed.all().some(row=>row.isin==='INE999999999'),false,'Rejected pages never enter the retained view');
assert.equal(comparisonStatus({missing:true,checking:true}).label,'Loading report');assert.equal(comparisonStatus({missing:true}).label,'Unavailable');
console.log(`PASS MF reading: first page ${Math.round(firstMs)}ms with stalled storage; progressive failures, full-cache scope reuse, unchanged probe, later-page corrections, legacy pagination and repeated-cursor protection.`);
