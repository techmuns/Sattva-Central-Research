import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {githubBackgroundRelease} from './lib/github-background-release.mjs';
import {sealBackgroundState} from './lib/github-background-seal.mjs';
import {packBackgroundViews} from './lib/github-background-package.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {backgroundContract} from '../worker/github-background-contract.mjs';
import {readBackgroundView} from '../worker/github-background-views.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/background-release-'));
const repo='techmuns/Sattva-Central-Research',env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-only',BACKGROUND_STATE_KEY:'fixture-state-key-1234567890'};
let at=Date.parse('2026-10-15T10:00:00Z'),exists=false,sequence=1000,failUpload=false,tamper=false,assetPages=0,releaseBody='';
const remote=new Map(),mutations=[],pauses=[],removed=[],signature=await backgroundContract('breakouts'),secret='fixture-reader-key-123456789';
const metadata=asset=>{const {bytes,...rest}=asset;return rest;};
const fetcher=async(raw,options={})=>{
  const url=new URL(raw),method=options.method||'GET';
  if(['api.github.com','uploads.github.com'].includes(url.hostname)) {
    assert.equal(options.headers.authorization,`Bearer ${env.GITHUB_TOKEN}`);assert.equal(options.redirect,'manual');
    assert(url.pathname.startsWith(`/repos/${repo}/`),'Token is scoped to the fixed repository origin');
    if(method!=='GET')mutations.push({url:raw,method});
    if(url.hostname==='uploads.github.com') {
      const name=url.searchParams.get('name');
      if(failUpload){remote.set(name,{id:sequence++,name,size:0,state:'starter'});return new Response('',{status:503});}
      assert(!remote.has(name),'Interrupted transports are pruned before their filename is retried');
      const chunks=[];if(Buffer.isBuffer(options.body))chunks.push(options.body);else for await(const chunk of options.body)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
      const asset={id:sequence++,name,size:bytes.length,state:'uploaded',created_at:new Date(at).toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/breakout-data/${name}`,bytes};remote.set(name,asset);return Response.json(metadata(asset));
    }
    if(method==='DELETE'){const id=Number(url.pathname.split('/').at(-1)),entry=[...remote.values()].find(a=>a.id===id);assert(entry);removed.push(entry.name);remote.delete(entry.name);return new Response(null,{status:204});}
    if(method==='POST'){assert.equal(url.pathname,`/repos/${repo}/releases`);exists=true;return Response.json({id:77,tag_name:'breakout-data'});}
    if(method==='PATCH'){assert(url.pathname.endsWith('/releases/77'));releaseBody=JSON.parse(options.body).body;return Response.json({id:77,tag_name:'breakout-data',body:releaseBody});}
    if(url.pathname.endsWith('/assets')){assetPages++;const page=Number(url.searchParams.get('page'));return Response.json([...remote.values()].slice((page-1)*100,page*100).map(metadata));}
    assert(url.pathname.endsWith('/releases/tags/breakout-data'));return exists?Response.json({id:77,tag_name:'breakout-data',body:releaseBody}):new Response(null,{status:404});
  }
  assert.equal(options.headers?.authorization,undefined,'No credential is forwarded to release download/CDN redirects');
  assert.equal(url.hostname,'github.com');assert(url.pathname.startsWith(`/${repo}/releases/download/breakout-data/`));
  const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset?.bytes);
  return new Response(tamper&&asset.name.endsWith('-bundle.bin')?Buffer.from('damaged snapshot'):asset.bytes);
};
try {
  const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
  const plain=path.join(root,'state.sqlite'),state=path.join(root,'state.bin'),views=path.join(root,'views.gz');fs.writeFileSync(plain,'PRIVATE HISTORY THAT MUST STAY ENCRYPTED');
  await sealBackgroundState(plain,state,'breakouts',{env});await packBackgroundViews([{name:'head.json',value:{privateHistory:'PRIVATE HISTORY'}}],recipient,views,{repo,feature:'breakouts',sourceSignature:signature});
  const transport=githubBackgroundRelease('breakouts',{env,fetcher,sleep:async ms=>pauses.push(ms),now:()=>at,head:()=>env.GITHUB_SHA});assert.equal(await transport.latest(),null);
  // More than one page of unrelated assets must neither disappear nor hide a
  // later publication. Only this transport's exact names may be pruned.
  for(let i=0;i<101;i++)remote.set(`unrelated-${i}`,{id:i+1,name:`unrelated-${i}`,size:1,state:'uploaded'});
  const first=await transport.publish({cycle:1,state,views,sourceSignature:signature});assert.equal(first.manifest.sourceSignature,signature);assert(assetPages>=2);
  const site=path.join(root,'public');
  await installPreparedBackground([first],{env,fetcher,publicRoot:site,scratch:path.join(root,'delivery')});
  assert.deepEqual(fs.readdirSync(path.join(site,'generated-views/breakouts')),['head.json'],'Only encrypted reader files enter static hosting; no restart state is installed');
  const reader={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>new Response(fs.readFileSync(path.join(site,new URL(request.url).pathname)))}};
  assert.deepEqual(await readBackgroundView(reader,'https://fixture.research','breakouts','head.json'),{privateHistory:'PRIVATE HISTORY'});
  const copied=path.join(root,'copied.bin');await transport.download(first,'state',copied);assert.deepEqual(fs.readFileSync(copied),fs.readFileSync(state));
  tamper=true;await assert.rejects(transport.download(first,'state',copied));assert.deepEqual(fs.readFileSync(copied),fs.readFileSync(state),'A corrupt replacement never overwrites the last verified download');tamper=false;
  const before=mutations.length;
  await assert.rejects(githubBackgroundRelease('breakouts',{env:{...env,GITHUB_REF:'refs/heads/codex/test'},fetcher}).publish({cycle:2,state,views,sourceSignature:signature}),/main-branch/);assert.equal(mutations.length,before);
  await assert.rejects(githubBackgroundRelease('breakouts',{env,fetcher,head:()=> 'c'.repeat(40)}).publish({cycle:2,state,views,sourceSignature:signature}),/checkout/);assert.equal(mutations.length,before);
  await assert.rejects(transport.publish({cycle:2,state:plain,views,sourceSignature:signature}),/Plaintext/);assert.equal(mutations.length,before);
  const badViews=path.join(root,'plain-views.gz');fs.writeFileSync(badViews,'PRIVATE RAW SOURCE');await assert.rejects(transport.publish({cycle:2,state,views:badViews,sourceSignature:signature}));assert.equal(mutations.length,before);
  at+=11*60000;await transport.publish({cycle:2,state,views,sourceSignature:signature});
  at+=11*60000;failUpload=true;await assert.rejects(transport.publish({cycle:3,state,views,sourceSignature:signature}),/503/);
  assert.equal((await transport.latest()).asset.name,'br-12345-1-2-bundle.bin','An interrupted upload leaves the last complete generation current');assert(remote.has(first.asset.name));
  failUpload=false;await transport.publish({cycle:3,state,views,sourceSignature:signature});
  assert(!remote.has(first.asset.name));assert(remote.has('br-12345-1-2-bundle.bin'));assert(remote.has('br-12345-1-3-bundle.bin'));
  assert(removed.includes('br-12345-1-3-bundle.bin'),'Recovery clears an incomplete upload before retry');
  assert([...remote.keys()].filter(name=>name.startsWith('unrelated-')).length===101);
  assert(pauses.length===mutations.length-1&&pauses.every(ms=>ms===1000),'Every mutative request after the first is paced');
  assert.throws(()=>githubBackgroundRelease('breakouts',{env:{...env,GITHUB_REPOSITORY:'fixture/other'}}));
  for(const name of [...remote.keys()])if(name.startsWith('br-'))remote.delete(name);
  await assert.rejects(transport.latest(),/refusing a reset/,'A previously initialized archive cannot silently revert to an older bootstrap source');
  console.log('PASS GitHub retained-state transport: complete paginated inventory, encrypted-only publication, fixed-origin credentials, single-upload recovery, two retained generations, download integrity, isolated pruning and paced mutations');
}finally{fs.rmSync(root,{recursive:true,force:true});}
