import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {packBackgroundViews,installBackgroundViews} from './lib/github-background-package.mjs';
import {readBackgroundView} from '../worker/github-background-views.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/background-package-'));
const options={repo:'techmuns/Sattva-Central-Research',feature:'breakouts',sourceSignature:'a'.repeat(64)},secret='fixture-reader-secret-123456789',keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
try {
  const file=path.join(root,'views.gz'),site=path.join(root,'public'),value={privateObservation:'PRIVATE SOURCE EVIDENCE',price:123.45};
  await packBackgroundViews([{name:'head.json',value},{name:'index.json',value:{pages:['head.json']}}],recipient,file,options);
  const decoded=gunzipSync(fs.readFileSync(file)).toString();assert(!decoded.includes(value.privateObservation),'Public transport contains only ciphertext');
  const result=await installBackgroundViews(file,site,options);assert.equal(result.files,2);
  const delivery={GH_REPO:options.repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>new Response(fs.readFileSync(path.join(site,new URL(request.url).pathname)))}};
  assert.deepEqual(await readBackgroundView(delivery,'https://research.fixture','breakouts','head.json'),value,'The installed static file decrypts using the existing Worker reader');
  const baseline=fs.readFileSync(path.join(site,'generated-views/breakouts/head.json'));
  const lines=decoded.trimEnd().split('\n').map(JSON.parse);
  const broken=path.join(root,'broken.gz');
  for(const mutate of [
    rows=>rows.slice(0,-1),
    rows=>[rows[0],{...rows[1],name:'../../worker/index.js'},...rows.slice(2)],
    rows=>[rows[0],{...rows[1],envelope:{...rows[1].envelope,privateObservation:value.privateObservation}},...rows.slice(2)],
    rows=>[rows[0],rows[1],rows[1],...rows.slice(2)],
    rows=>[rows[0],{...rows[1],envelope:{...rows[1].envelope,context:'wrong-document'}},...rows.slice(2)],
    rows=>[{...rows[0],repo:'fixture/other'},...rows.slice(1)],
    rows=>[{...rows[0],sourceSignature:'b'.repeat(64)},...rows.slice(1)],
    rows=>[...rows,rows[1]],
  ]) {
    fs.writeFileSync(broken,gzipSync(mutate(structuredClone(lines)).map(JSON.stringify).join('\n')+'\n'));
    await assert.rejects(installBackgroundViews(broken,site,options));
    assert.deepEqual(fs.readFileSync(path.join(site,'generated-views/breakouts/head.json')),baseline,'Rejected packages preserve the previous verified static directory');
  }
  await assert.rejects(packBackgroundViews([{name:'head.json',value},{name:'head.json',value}],recipient,file,options));
  assert.deepEqual(gunzipSync(fs.readFileSync(file)).toString(),decoded,'A failed package build preserves the complete prior package');
  assert.deepEqual(fs.readdirSync(path.join(site,'generated-views')),['breakouts'],'Failed staging directories are removed');
  const cipherCache=new Map(),cache={get:(name,fingerprint)=>cipherCache.get(name)?.fingerprint===fingerprint?cipherCache.get(name).value:null,put:(name,fingerprint,value)=>{cipherCache.set(name,{fingerprint,value});}};
  const cachedFile=path.join(root,'cached.gz');await packBackgroundViews([{name:'head.json',value}],recipient,cachedFile,{...options,cache});
  const firstCipher=JSON.parse(gunzipSync(fs.readFileSync(cachedFile)).toString().split('\n')[1]).envelope;
  await packBackgroundViews([{name:'head.json',value}],recipient,cachedFile,{...options,cache});assert.deepEqual(JSON.parse(gunzipSync(fs.readFileSync(cachedFile)).toString().split('\n')[1]).envelope,firstCipher);
  const nextKeys=await readerKeys('fixture-rotated-reader-secret-123456789'),nextRecipient={kid:nextKeys.kid,publicKey:encode64(nextKeys.publicKey)};
  await packBackgroundViews([{name:'head.json',value}],nextRecipient,cachedFile,{...options,cache});const nextCipher=JSON.parse(gunzipSync(fs.readFileSync(cachedFile)).toString().split('\n')[1]).envelope;assert.equal(nextCipher.kid,nextKeys.kid);assert.notDeepEqual(nextCipher,firstCipher);
  await assert.rejects(packBackgroundViews([{name:'head.json',value,maxBytes:1}],nextRecipient,cachedFile,{...options,cache}),'Cached envelopes cannot bypass a changed plaintext limit');
  console.log('PASS encrypted static package: authenticated reader round trip, no plaintext private facts, exact repository/code binding, complete inventory, path traversal/duplicate rejection and preservation on failure');
}finally{fs.rmSync(root,{recursive:true,force:true});}
