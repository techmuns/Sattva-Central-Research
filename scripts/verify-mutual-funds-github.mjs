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

fs.mkdirSync('.cache',{recursive:true});
const root=fs.mkdtempSync(path.resolve('.cache/mf-github-'));
const file=path.join(root,'source.sqlite'),secret='fixture-worker-secret-only-123456789',repo='techmuns/Sattva-Central-Research';
const env={GITHUB_REPOSITORY:repo,GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',MF_STATE_KEY:'fixture-github-secret-only-987654321'};
const isin='INE090A01021',other='INE040A01034',month=targetMonth(),prior=previousMonth(month),stamp=new Date().toISOString();
try {
  let store=localMutualFunds(file);
  store.primary.begin('1:1',{targets:[isin,other],amcs:[{slug:'hdfc',status:'partial',month}],checkedAt:stamp});
  store.primary.checkpoint('1:1',[{isin,name:'Fixture Bank',funds:[{id:'hdfc:fixture',amc:'HDFC',name:'Fixture Fund',months:{[prior]:{shares:100,checkedAt:stamp}}}]},{isin:other,name:'Other Fixture',funds:[]}]);
  store.primary.finish('1:1');
  store.scanner.inventory([{isin,name:'Fixture Bank'}]);
  const lease=store.scanner.reserve('2:1','1','stock'),sourceUrl='https://mfscanner.com/stock/fixture-bank';
  store.scanner.complete('2:1',{reservation:lease.reservation,isin,page:{isin,month,priorMonth:prior,checkedAt:stamp,sourceUrl,reportedFunds:1,unreportedFunds:0,unknownAmcs:0,funds:[{id:'scanner:fixture',amc:'hdfc',name:'Fixture Fund',months:{[month]:{shares:150,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp},[prior]:{shares:100,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp}}}]}});
  assert.equal(store.scanner.read([isin]).rows[0].totalShares,150);
  const expectedHistory=store.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n;
  const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
  const built=await buildSnapshot(store,recipient,{env,out:path.join(root,'published'),file});
  const names=[...Object.keys(built.manifest.files),built.manifestName];
  const assets=names.map((name,i)=>({id:i+1,name,browser_download_url:`https://github.com/${repo}/releases/download/mutual-funds-data/${name}`}));
  let downloads=0;
  const fetcher=async url=>{
    if(String(url).startsWith('https://api.github.com/'))return Response.json({assets});
    const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));assert(names.includes(name));downloads++;
    return new Response(fs.readFileSync(path.join(built.out,name)));
  };
  const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,MF_RUNTIME:'github',CAPTURE_REGISTRY:{getByName(){throw Error('GitHub snapshot reads must not touch Durable Objects');}}};
  const read=(suffix,options={})=>handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds'+suffix),worker,{fetcher,authorise:async()=>({ok:true}),...options});
  let response=await read(`?isins=${isin}`);assert.equal(response.status,200);assert.equal((await response.json()).rows[0].totalShares,100);
  response=await read(`/private?isins=${isin}`);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private.*no-store/);assert.equal((await response.json()).rows[0].totalShares,150);
  response=await read(`/private/company?isin=${isin}&month=${month}`);assert.equal((await response.json()).company.totalShares,150);
  const before=downloads;
  response=await read('/private',{authorise:async()=>({ok:false,reason:'no-session'})});assert.equal(response.status,401);assert.equal(downloads,before);
  for(const action of ['arm','begin','fragment','confirm','scanner-inventory','scanner-complete']) {
    const request=new Request(MF_ORIGIN+'/api/mutual-funds/collector',{method:'POST',body:JSON.stringify({action})});
    assert.equal((await handleMutualFunds(request,worker,{identity:async()=> '3:1'})).status,410);
  }
  assert.throws(()=>collectorClient({env:{}}),/GitHub runner storage/);
  await assert.rejects(legacyExportClient()({action:'fragment'}),/writes are disabled/);
  for(const name of names.filter(n=>n.includes('private-')||n.endsWith('state.bin')))assert(!fs.readFileSync(path.join(built.out,name)).includes(Buffer.from('MF Scanner')),'Private facts are encrypted in every public asset');
  const restored=path.join(root,'restored.sqlite');
  await restoreState({env,fetcher,file:restored});
  store=localMutualFunds(restored);assert.equal(store.scanner.read([isin]).rows[0].totalShares,150);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,expectedHistory);
  const again=await buildSnapshot(store,recipient,{env:{...env,GITHUB_RUN_ID:'12346'},out:path.join(root,'next'),file:restored,previous:built.manifest});
  assert.equal(again.manifest.publicParts[Object.keys(built.manifest.publicParts)[0]],built.manifest.publicParts[Object.keys(built.manifest.publicParts)[0]],'Unchanged data parts are reused instead of repeatedly uploaded');
  assert.equal(again.manifest.privateIndex,built.manifest.privateIndex,'Unchanged encrypted views reuse their protected revision');
  await assert.rejects(decryptState(path.join(built.out,built.manifest.state),path.join(root,'wrong.sqlite'),{...env,MF_STATE_KEY:'different-fixture-key-000000000'}));
  assert(!fs.existsSync(path.join(root,'wrong.sqlite')),'Unauthenticated state never becomes the next database');
  const legacy=localMutualFunds(file),migrated=path.join(root,'migrated.sqlite');
  await restoreState({env,file:migrated,fetcher:async()=>new Response('',{status:404}),legacyClient:async body=>exportMutualFunds(legacy.storage.sql,body.table,body.cursor)});
  const copy=localMutualFunds(migrated);assert.equal(copy.scanner.read([isin]).rows[0].totalShares,150);assert.equal(copy.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,expectedHistory);copy.close();legacy.close();
  await assert.rejects(publishSnapshot(built,{env:{...env,GITHUB_ACTIONS:'false'}}),/main-branch/);
  console.log('PASS GitHub-only MF: retained SQLite history, encrypted private views/state, public/private separation, immutable-part reuse, read-only migration, zero DO reads after publication, and rejected Cloudflare capture writes');
}finally{fs.rmSync(root,{recursive:true,force:true});}
