import assert from 'node:assert/strict';
import {readerKeys,encode64,decode64} from '../worker/mutual-funds-seal.mjs';
import {sealBackgroundView} from './lib/github-background-views.mjs';
import {readBackgroundView} from '../worker/github-background-views.mjs';
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-key-secret-1234567890',keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
for(const length of [0,1,2,3,255,256,8193,1024*1024]){
 const bytes=Uint8Array.from({length},(_,i)=>i%256),base64=Buffer.from(bytes).toString('base64');
 assert.equal(encode64(bytes),base64);assert.deepEqual(decode64(base64),bytes,'Native and fallback codecs retain every binary byte, padding and large payload');
}
const value={rows:[{ticker:'FIXTURE',price:123.45}],privateHistory:'PRIVATE HISTORICAL SOURCE RECEIPT',checkedAt:'2026-10-15T09:00:00Z'};
const built=await sealBackgroundView(value,recipient,{repo,feature:'breakouts',name:'head.json'});assert(!built.bytes.includes(Buffer.from(value.privateHistory)));
let missing=false,calls=0;
const env={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{async fetch(request){calls++;assert.equal(request.headers.get('authorization'),null);assert.match(new URL(request.url).pathname,/^\/generated-views\/breakouts\/(?:head|other)\.json$/);return missing?new Response(null,{status:404}):new Response(built.bytes);}}};
assert.deepEqual(await readBackgroundView(env,'https://research.fixture/api/breakouts','breakouts','head.json'),value);
await assert.rejects(readBackgroundView({...env,GH_DISPATCH_TOKEN:'another-fixture-reader-key-123456'},'https://research.fixture','breakouts','head.json'));
await assert.rejects(readBackgroundView(env,'https://research.fixture','breakouts','other.json'),'A different document address cannot decrypt another view');
await assert.rejects(readBackgroundView(env,'https://research.fixture','breakouts','head.json',{maxBytes:10}),'Inflation is bounded before JSON parsing');
const before=calls;for(const name of ['../head.json','head.html','head.json?other=private','/head.json'])await assert.rejects(readBackgroundView(env,'https://research.fixture','breakouts',name));assert.equal(calls,before,'Invalid paths never reach the static asset binding');
missing=true;assert.equal(await readBackgroundView(env,'https://research.fixture','breakouts','head.json'),null,'Only a known missing file permits a migration fallback');
const corrupt={...env,ASSETS:{fetch:async()=>new Response('not JSON')}};await assert.rejects(readBackgroundView(corrupt,'https://research.fixture','breakouts','head.json'),'An existing corrupt file must not silently select old storage');
console.log('PASS prepared static delivery: encrypted source facts, exact document binding, bounded inflation, no credentials sent to ASSETS, and corrupt-file fail-closed behavior');
