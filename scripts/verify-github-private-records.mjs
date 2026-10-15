import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {readerKeys,encode64,hash} from '../worker/mutual-funds-seal.mjs';
import {privateRecordBucket,readPrivateRecord} from '../worker/github-private-records.mjs';
import {readBackgroundView} from '../worker/github-background-views.mjs';
import {privateRecordViews} from './lib/github-private-records.mjs';
import {packBackgroundViews,installBackgroundViews} from './lib/github-background-package.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/private-records-'));
const repo='techmuns/Sattva-Central-Research',feature='summaries',secret='fixture-reader-secret-123456789',env={BACKGROUND_STATE_KEY:'fixture-opaque-name-secret-1234567890'},sourceSignature='a'.repeat(64);
try {
  const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)},ids=[];
  for(let n=0;n<1000&&ids.length<3;n++){const id=String(12345678901234560000n+BigInt(n));if(privateRecordBucket(id)===0)ids.push(id);}
  assert.equal(ids.length,3);
  const records=new Map(ids.map(id=>[id,{id,body:'PRIVATE SOURCE HISTORY '+id}])),file=path.join(root,'package.gz'),site=path.join(root,'public');
  await packBackgroundViews(privateRecordViews(ids,id=>records.get(id),{state:{readyIds:ids}},{repo,feature,env,partBytes:200}),recipient,file,{repo,feature,sourceSignature});
  const publicTransport=gunzipSync(fs.readFileSync(file)).toString();
  for(const id of ids){assert(!publicTransport.includes(id));assert(!publicTransport.includes(await hash(new TextEncoder().encode(id))),'Public names cannot expose enumerable private source hashes');}
  assert(!publicTransport.includes('PRIVATE SOURCE HISTORY'));
  await installBackgroundViews(file,site,{repo,feature,sourceSignature});
  let missing=false;
  const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>missing?new Response(null,{status:404}):new Response(fs.readFileSync(path.join(site,new URL(request.url).pathname)))}};
  const head=await readBackgroundView(worker,'https://fixture.research',feature,'head.json');assert.equal(head.parts[0].length,3,'Growing private history is split into bounded independently addressed pages');
  const memo=new Map();for(const id of ids)assert.deepEqual(await readPrivateRecord(worker,'https://fixture.research',feature,head,id,{memo}),records.get(id));assert(memo.size<=2,'Per-request plaintext memo stays bounded');
  assert.equal(await readPrivateRecord(worker,'https://fixture.research',feature,head,'99999999999999999999'),null);
  missing=true;await assert.rejects(readPrivateRecord(worker,'https://fixture.research',feature,head,ids[0]),/page missing/,'An unavailable stored page cannot become an apparently empty private record');
  console.log('PASS private record delivery: encrypted directory and source facts, keyed opaque filenames, bounded history pages, exact record access, small request-local memo and missing-page fail-closed behavior');
}finally{fs.rmSync(root,{recursive:true,force:true});}
