import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localMutualFunds } from './lib/mutual-funds-local.mjs';
import { buildSnapshot,restoreState,decryptState } from './lib/mutual-funds-state.mjs';
import { readerKeys,encode64 } from '../worker/mutual-funds-seal.mjs';
import { handleMutualFunds } from '../worker/mutual-funds.mjs';
import { exportMutualFunds } from '../worker/mutual-funds-export.mjs';
import { MF_ORIGIN,targetMonth,previousMonth } from '../worker/mutual-funds-model.mjs';
import { collectorClient,legacyExportClient } from './collect-mutual-funds.mjs';
import { publishSnapshot } from './mutual-funds-github.mjs';
import { mfManifest,mfRelease,mfSnapshotFile,mfDetailKey } from '../worker/mutual-funds-github.mjs';

fs.mkdirSync('.cache',{recursive:true});
const root=fs.mkdtempSync(path.resolve('.cache/mf-github-'));
const file=path.join(root,'source.sqlite'),secret='fixture-worker-secret-only-123456789',repo='techmuns/Sattva-Central-Research';
const env={GITHUB_REPOSITORY:repo,GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',MF_STATE_KEY:'fixture-github-secret-only-987654321'};
const isin='INE090A01021',other='INE040A01034',privateOnly='INE999Z01011',month=targetMonth(),prior=previousMonth(month),stamp=new Date().toISOString();
try {
  let store=localMutualFunds(file);
  store.primary.begin('1:1',{targets:[isin,other],amcs:[{slug:'hdfc',status:'partial',month}],checkedAt:stamp});
  store.primary.checkpoint('1:1',[{isin,name:'Fixture Bank',funds:[{id:'hdfc:fixture',amc:'HDFC',name:'Fixture Fund',months:{[prior]:{shares:100,checkedAt:stamp}}}]},{isin:other,name:'Other Fixture',funds:[]}]);
  store.primary.finish('1:1');
  store.scanner.inventory([{isin,name:'Fixture Bank'}]);
  const lease=store.scanner.reserve('2:1','1','stock'),sourceUrl='https://mfscanner.com/stock/fixture-bank';
  store.scanner.complete('2:1',{reservation:lease.reservation,isin,page:{isin,month,priorMonth:prior,checkedAt:stamp,sourceUrl,reportedFunds:1,unreportedFunds:0,unknownAmcs:0,funds:[{id:'scanner:fixture',amc:'hdfc',name:'Fixture Fund',months:{[month]:{shares:150,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp},[prior]:{shares:100,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp}}}]}});
  assert.equal(store.scanner.read([isin]).rows[0].totalShares,150);
  store.scanner.inventory([{isin,name:'Fixture Bank'},{isin:privateOnly,name:'Private-only Fixture'}]);
  const realNow=store.scanner.now;store.scanner.now=()=>Date.now()+60000;
  const privateLease=store.scanner.reserve('2:1','2','stock');assert.equal(privateLease.company.isin,privateOnly);
  store.scanner.complete('2:1',{reservation:privateLease.reservation,isin:privateOnly,page:{isin:privateOnly,month,priorMonth:prior,checkedAt:stamp,sourceUrl,reportedFunds:1,unreportedFunds:0,unknownAmcs:0,funds:[{id:'scanner:private',amc:'hdfc',name:'Private Fixture Fund',months:{[month]:{shares:73,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp}}}]}});
  store.scanner.now=realNow;
  const expectedHistory=store.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n;
  const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
  const built=await buildSnapshot(store,recipient,{env,out:path.join(root,'published'),file,partBytes:1800});
  assert.deepEqual(built.manifest.privateParts,{},'Public manifest contains no private routing ranges');
  const publicManifest=JSON.stringify(built.manifest);
  for(const identity of [privateOnly,await mfDetailKey(privateOnly),await mfDetailKey(privateOnly,month)])assert(!publicManifest.includes(identity),'Private identities cannot be enumerated from public routing hashes');
  assert(Object.keys(built.manifest.files).filter(name=>/private-/.test(name)&&!name.includes('private-index')).every(name=>/private-[a-f0-9]{64}-\d+\.json$/.test(name)),'Private filenames do not expose ISIN-derived bucket numbers');
  const names=[...Object.keys(built.manifest.files),built.manifestName];
  const assets=names.map((name,i)=>({id:i+1,name,browser_download_url:`https://github.com/${repo}/releases/download/mutual-funds-data/${name}`}));
  let downloads=0;
  const fetcher=async url=>{
    if(String(url).startsWith('https://api.github.com/'))return Response.json({assets});
    const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));assert(names.includes(name));downloads++;
    return new Response(fs.readFileSync(path.join(built.out,name)));
  };
  const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,MF_RUNTIME:'github',CAPTURE_REGISTRY:{getByName(){throw Error('GitHub snapshot reads must not touch Durable Objects');}}};
  const privateIndex=await mfSnapshotFile({manifest:built.manifest,assets:new Map(assets.map(a=>[a.name,a]))},built.manifest.privateIndex,worker,{privateRead:true,fetcher});
  assert(Object.values(privateIndex.parts).some(pages=>pages.length>1),'Encrypted directory retains bounded independently addressed history pages');
  const read=(suffix,options={})=>handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds'+suffix),worker,{fetcher,authorise:async()=>({ok:true}),...options});
  let response=await read(`?isins=${isin}`);assert.equal(response.status,200);assert.equal((await response.json()).rows[0].totalShares,100);
  response=await read(`/private?isins=${isin}`);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private.*no-store/);assert.equal((await response.json()).rows[0].totalShares,150);
  response=await read(`/private/company?isin=${isin}&month=${month}`);assert.equal((await response.json()).company.totalShares,150);
  response=await read(`/private/company?isin=${isin}&month=${prior}`);assert.equal((await response.json()).company.totalShares,100,'Historical months remain readable across split pages');
  response=await read(`/private/company?isin=${privateOnly}&month=${month}`);assert.equal((await response.json()).company.totalShares,73,'Private-only history resolves through the encrypted directory');
  response=await read(`/company?isin=${privateOnly}&month=${month}`);assert.equal((await response.json()).company,null,'Private-only history never enters the public view');
  const cacheBefore=globalThis.caches,immutable=new Map();
  try {
    globalThis.caches={default:{match:async request=>immutable.get(request.url)?.clone(),put:async(request,value)=>immutable.set(request.url,value.clone())}};
    await read(`?isins=${isin}`);const firstPageDownloads=downloads;
    await read(`?cursor=${isin}`);assert.equal(downloads,firstPageDownloads,'Next index page reuses immutable manifest and full index without another transfer');
    await read(`/private/company?isin=${isin}&month=${month}`);
    for(const value of immutable.values())assert(!(await value.clone().text()).includes(sourceUrl),'Only ciphertext, never private plaintext, is cached');
  }finally{globalThis.caches=cacheBefore;}
  const before=downloads;
  response=await read('/private',{authorise:async()=>({ok:false,reason:'no-session'})});assert.equal(response.status,401);assert.equal(downloads,before);
  for(const action of ['arm','begin','fragment','confirm','scanner-inventory','scanner-complete']) {
    const request=new Request(MF_ORIGIN+'/api/mutual-funds/collector',{method:'POST',body:JSON.stringify({action})});
    assert.equal((await handleMutualFunds(request,worker,{identity:async()=> '3:1'})).status,410);
  }
  for(const workflow of ['mutual-funds-refresh.yml','mutual-funds-scanner.yml']) {
    const exported=await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/collector',{method:'POST',body:JSON.stringify({action:'export'})}),{CAPTURE_REGISTRY:{getByName:()=>({mfExport:()=>({ok:true,tables:[]})})}},{identity:async(_request,options)=>{if(options.workflow!==workflow)throw Error('Wrong workflow');return '3:1';}});
    assert.equal(exported.status,200,'Either fixed main-branch MF workflow can restore legacy history');
  }
  assert.equal((await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/collector',{method:'POST',body:JSON.stringify({action:'export'})}),worker,{identity:async()=>{throw Error('Untrusted workflow');}})).status,403);
  assert.throws(()=>collectorClient({env:{}}),/GitHub runner storage/);
  await assert.rejects(legacyExportClient()({action:'fragment'}),/writes are disabled/);
  for(const name of names.filter(n=>n.includes('private-')||n.endsWith('state.bin')))assert(!fs.readFileSync(path.join(built.out,name)).includes(Buffer.from('MF Scanner')),'Private facts are encrypted in every public asset');
  const restored=path.join(root,'restored.sqlite');
  await restoreState({env,fetcher,file:restored});
  store=localMutualFunds(restored);assert.equal(store.scanner.read([isin]).rows[0].totalShares,150);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,expectedHistory);
  const again=await buildSnapshot(store,recipient,{env:{...env,GITHUB_RUN_ID:'12346'},out:path.join(root,'next'),file:restored,previous:built.manifest,partBytes:1800});
  assert.deepEqual(again.manifest.publicParts,built.manifest.publicParts,'Unchanged data parts are reused instead of repeatedly uploaded');
  assert.equal(again.manifest.privateIndex,built.manifest.privateIndex,'Unchanged encrypted views reuse their protected revision');
  await assert.rejects(decryptState(path.join(built.out,built.manifest.state),path.join(root,'wrong.sqlite'),{...env,MF_STATE_KEY:'different-fixture-key-000000000'}));
  assert(!fs.existsSync(path.join(root,'wrong.sqlite')),'Unauthenticated state never becomes the next database');
  const legacy=localMutualFunds(file),migrated=path.join(root,'migrated.sqlite');
  await restoreState({env,file:migrated,fetcher:async()=>new Response('',{status:404}),legacyClient:async body=>exportMutualFunds(legacy.storage.sql,body.table,body.cursor)});
  const copy=localMutualFunds(migrated);assert.equal(copy.scanner.read([isin]).rows[0].totalShares,150);assert.equal(copy.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,expectedHistory);copy.close();legacy.close();
  await assert.rejects(publishSnapshot(built,{env:{...env,GITHUB_ACTIONS:'false'}}),/main-branch/);
  assert.equal(await mfManifest(worker,{fetcher:async()=>Response.json({assets:[{id:1,name:'mf-999-1-manifest.json',state:'starter',size:0}]})}),null,'An interrupted FIRST upload still permits the authenticated legacy migration');
  let cachedMetadata=null,metadataCalls=0;
  const edgeCache={match:async()=>cachedMetadata?.clone(),put:async(_key,response)=>{assert.match(response.headers.get('cache-control'),/max-age=300/);cachedMetadata=response;}};
  const publicLookup=async(_url,options)=>{metadataCalls++;assert(!options.headers.authorization,'Actions-only Worker credential never authorizes public Contents API reads');return Response.json({assets});};
  await mfRelease(worker,{fetcher:publicLookup,edgeCache});await mfRelease(worker,{fetcher:publicLookup,edgeCache});assert.equal(metadataCalls,1,'Public release metadata is reused within the edge TTL');
  await mfRelease({...worker,GH_RELEASE_TOKEN:'fixture-runner-contents-token'},{fetcher:async(_url,options)=>{assert.equal(options.headers.authorization,'Bearer fixture-runner-contents-token');return Response.json({assets});},edgeCache});
  // Crash before the manifest: prior history remains usable, and the next run
  // clears orphaned transport uploads instead of exhausting the release limit.
  const remote=new Map(assets.map(asset=>[asset.name,{...asset,created_at:new Date().toISOString(),bytes:fs.readFileSync(path.join(built.out,asset.name))}]));
  remote.set('mf-12344-1-manifest.json',{id:0,name:'mf-12344-1-manifest.json',created_at:'2000-01-01T00:00:00Z',bytes:Buffer.from(JSON.stringify(built.manifest)),browser_download_url:`https://github.com/${repo}/releases/download/mutual-funds-data/mf-12344-1-manifest.json`});
  remote.set('mf-999-1-orphan.json',{id:500,name:'mf-999-1-orphan.json'});
  remote.set('mf-999-1-manifest.json',{id:501,name:'mf-999-1-manifest.json',state:'starter',size:0});
  remote.set('mf-999-2-manifest.json',{id:502,name:'mf-999-2-manifest.json',bytes:Buffer.from('invalid JSON'),browser_download_url:`https://github.com/${repo}/releases/download/mutual-funds-data/mf-999-2-manifest.json`});
  let sequence=600,failManifest=true;const removed=[];
  const publishing=async(raw,options={})=>{
    const url=new URL(raw);
    if(url.hostname==='api.github.com'&&options.method==='DELETE') {
      const id=Number(url.pathname.split('/').at(-1));
      const match=[...remote.values()].find(a=>a.id===id);assert(match);removed.push(match.name);remote.delete(match.name);return new Response(null,{status:204});
    }
    if(url.hostname==='api.github.com')return Response.json({id:77,assets:[...remote.values()].map(({bytes,...asset})=>asset)});
    if(url.hostname==='uploads.github.com') {
      const name=url.searchParams.get('name'),chunks=[];
      for await(const chunk of options.body)chunks.push(chunk);
      if(failManifest&&name===again.manifestName)return new Response('',{status:503});
      assert(!remote.has(name),'Orphaned uploads are removed before names can be retried');
      const asset={id:sequence++,name,created_at:new Date().toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/mutual-funds-data/${name}`,bytes:Buffer.concat(chunks)};
      remote.set(name,asset);return Response.json({id:asset.id,name});
    }
    const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset?.bytes);return new Response(asset.bytes);
  };
  const publisher={...env,GITHUB_RUN_ID:'12346',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_TOKEN:'fixture-actions-token'};
  const mutationPauses=[],paced={env:publisher,fetcher:publishing,sleep:async ms=>mutationPauses.push(ms)};
  await assert.rejects(publishSnapshot(again,paced),/503/);
  assert.equal((await mfManifest(worker,{fetcher:publishing})).manifest.state,built.manifest.state,'Previous complete generation survives a failed publish');
  assert.deepEqual(removed,['mf-999-1-orphan.json','mf-999-1-manifest.json','mf-999-2-manifest.json'],'No referenced history is deleted before the replacement is complete');
  failManifest=false;await publishSnapshot(again,paced);
  assert(mutationPauses.length>=3&&mutationPauses.every(ms=>ms===1000),'Uploads and pruning are paced below burst content-creation limits');
  assert.equal((await mfManifest(worker,{fetcher:publishing})).manifest.state,again.manifest.state);
  for(const name of names)assert(remote.has(name),'Both complete generations remain available after recovery');
  assert(remote.has('mf-12344-1-manifest.json'),'The generation preceding the cache grace window is retained through a burst of publications');

  for(const file of ['mutual-funds-refresh.yml','mutual-funds-scanner.yml'])assert.match(fs.readFileSync('.github/workflows/'+file,'utf8'),/group: mutual-funds-github-state\s+queue: max\s+cancel-in-progress: false/,'Both writers retain their pending runs');
  console.log('PASS GitHub-only MF: retained SQLite history, encrypted private views/state, public/private separation, immutable-part reuse, read-only migration, zero DO reads after publication, and rejected Cloudflare capture writes');
}finally{fs.rmSync(root,{recursive:true,force:true});}
