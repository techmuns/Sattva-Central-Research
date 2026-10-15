import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {localMutualFunds} from './lib/mutual-funds-local.mjs';
import {publishStaticMutualFunds,restoreStaticMutualFunds} from './lib/mutual-funds-static.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleMutualFunds} from '../worker/mutual-funds.mjs';
import {MF_ORIGIN,targetMonth,previousMonth} from '../worker/mutual-funds-model.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/mf-static-'));
const repo='techmuns/Sattva-Central-Research',file=path.join(root,'state.sqlite'),secret='fixture-reader-secret-only-123456789',isin='INE090A01021',month=targetMonth(),prior=previousMonth(month),stamp=new Date().toISOString();
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',MF_STATE_KEY:'fixture-master-secret-only-123456789'};
let local,exists=false,sequence=1,body='',assetReads=0;const remote=new Map(),tag='mutual-funds-runner-data';
const fetcher=async(raw,options={})=>{
  const url=new URL(raw),method=options.method||'GET';
  if(['api.github.com','uploads.github.com'].includes(url.hostname)) {
    assert.equal(options.headers.authorization,`Bearer ${env.GITHUB_TOKEN}`);assert(url.pathname.startsWith(`/repos/${repo}/`));
    if(url.hostname==='uploads.github.com'){
      const chunks=[];for await(const chunk of options.body)chunks.push(chunk);const bytes=Buffer.concat(chunks),name=url.searchParams.get('name');
      const asset={id:sequence++,name,size:bytes.length,state:'uploaded',created_at:new Date().toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`,bytes};remote.set(name,asset);const {bytes:_,...metadata}=asset;return Response.json(metadata);
    }
    if(method==='POST'){exists=true;return Response.json({id:77,tag_name:tag});}
    if(method==='PATCH'){body=JSON.parse(options.body).body;return Response.json({id:77,tag_name:tag,body});}
    if(method==='DELETE'){const id=Number(url.pathname.split('/').at(-1)),asset=[...remote.values()].find(a=>a.id===id);assert(asset);remote.delete(asset.name);return new Response(null,{status:204});}
    if(url.pathname.endsWith('/assets'))return Response.json([...remote.values()].map(({bytes,...asset})=>asset));
    assert(url.pathname.endsWith('/releases/tags/'+tag));return exists?Response.json({id:77,tag_name:tag,body}):new Response(null,{status:404});
  }
  assert.equal(options.headers?.authorization,undefined);const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset);return new Response(asset.bytes);
};
try {
  local=localMutualFunds(file);local.primary.begin('1:1',{targets:[isin],amcs:[{slug:'hdfc',status:'partial',month}],checkedAt:stamp});
  local.primary.checkpoint('1:1',[{isin,name:'Public Fixture',funds:[{id:'hdfc:fixture',amc:'HDFC',name:'Fixture Fund',months:{[prior]:{shares:100,checkedAt:stamp}}}]}]);local.primary.finish('1:1');
  local.scanner.inventory([{isin,name:'Public Fixture'}]);const lease=local.scanner.reserve('2:1','1');
  const sourceUrl='https://mfscanner.com/stock/public-fixture';local.scanner.complete('2:1',{reservation:lease.reservation,isin,page:{isin,month,priorMonth:prior,checkedAt:stamp,sourceUrl,reportedFunds:1,unreportedFunds:0,unknownAmcs:0,funds:[{id:'scanner:fixture',amc:'hdfc',name:'Fixture Fund',months:{[month]:{shares:150,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp},[prior]:{shares:100,valueCr:null,pctOfAum:null,source:'MF Scanner',sourceUrl,checkedAt:stamp}}}]}});
  const history=local.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n;local.close();local=null;
  const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
  const publish=(run,reader=recipient)=>publishStaticMutualFunds(reader,{env:{...env,GITHUB_RUN_ID:run},fetcher,file,out:path.join(root,'publish-'+run),sleep:async()=>{},head:()=>env.GITHUB_SHA});
  const first=await publish('12345'),site=path.join(root,'public');
  await installPreparedBackground([first],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
  const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,CAPTURE_REGISTRY:{getByName(){throw Error('Prepared readers must never touch Cloudflare SQL');}},ASSETS:{fetch:async request=>{assetReads++;assert.equal(request.headers.get('authorization'),null);const target=path.join(site,new URL(request.url).pathname);return fs.existsSync(target)?new Response(fs.readFileSync(target)):new Response(null,{status:404});}}};
  const read=(suffix,options={})=>handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds'+suffix),worker,{fetcher:async()=>{throw Error('Readers must not use GitHub API or external network');},authorise:async()=>({ok:true}),...options});
  let response=await read(`?isins=${isin}`),value=await response.json();assert.equal(response.status,200);assert.equal(value.rows[0].totalShares,100);assert.equal(value.meta.delivery,'static-assets');
  response=await read(`/private?isins=${isin}`);assert.match(response.headers.get('cache-control'),/private.*no-store/);assert.equal((await response.json()).rows[0].totalShares,150);
  response=await read(`/private/company?isin=${isin}&month=${prior}`);assert.equal((await response.json()).company.totalShares,100);
  const before=assetReads;response=await read('/private',{authorise:async()=>({ok:false,reason:'no-session'})});assert.equal(response.status,401);assert.equal(assetReads,before,'Authorization precedes even the encrypted head lookup');
  const names=fs.readdirSync(path.join(site,'generated-views/mutual-funds'));assert(names.every(name=>name.endsWith('.json')));assert(names.every(name=>!name.includes('state')),'Restart databases never enter static hosting');
  for(const name of names)assert(!fs.readFileSync(path.join(site,'generated-views/mutual-funds',name)).includes(Buffer.from(sourceUrl)),'Private source facts remain ciphertext in every delivered file');
  const restored=path.join(root,'restored.sqlite');await restoreStaticMutualFunds({env,fetcher,file:restored,legacyClient:async()=>{throw Error('Published archives must never restore Cloudflare history');}});
  local=localMutualFunds(restored);assert.equal(local.scanner.read([isin]).rows[0].totalShares,150);assert.equal(local.db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,history);
  const firstIndex=JSON.parse(local.db.prepare("SELECT value FROM github_mf_prepared_meta WHERE key='manifest'").get().value).publicIndex;local.close();local=null;
  await publish('12346');local=localMutualFunds(file);assert.equal(JSON.parse(local.db.prepare("SELECT value FROM github_mf_prepared_meta WHERE key='manifest'").get().value).publicIndex,firstIndex,'Unchanged encrypted reader parts survive restart in the encrypted master without repeated re-encryption');local.close();local=null;
  const rotatedKeys=await readerKeys(secret+'-rotated'),rotated={kid:rotatedKeys.kid,publicKey:encode64(rotatedKeys.publicKey)};
  const rotatedPublication=await publish('12347',rotated);local=localMutualFunds(file);const rotatedIndex=JSON.parse(local.db.prepare("SELECT value FROM github_mf_prepared_meta WHERE key='manifest'").get().value).publicIndex;assert.notEqual(rotatedIndex,firstIndex,'Reader key rotation regenerates public ciphertext too');local.close();local=null;
  const rotatedSite=path.join(root,'rotated-public');await installPreparedBackground([rotatedPublication],{env,fetcher,publicRoot:rotatedSite,scratch:path.join(root,'rotated-install')});
  const rotatedWorker={...worker,GH_DISPATCH_TOKEN:secret+'-rotated',ASSETS:{fetch:async request=>{const file=path.join(rotatedSite,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
  const rotatedResponse=await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/private?isins='+isin),rotatedWorker,{authorise:async()=>({ok:true}),fetcher:async()=>{throw Error('No external reads');}});assert.equal(rotatedResponse.status,200);assert.equal((await rotatedResponse.json()).rows[0].totalShares,150);
  await assert.rejects(restoreStaticMutualFunds({env:{...env,MF_STATE_KEY:'incorrect-archive-secret-key-12345'},fetcher,file:path.join(root,'wrong-key.sqlite'),legacyClient:async()=>{throw Error('No reset permitted');}}));
  const indexFile=path.join(site,'generated-views/mutual-funds',firstIndex),original=fs.readFileSync(indexFile);fs.writeFileSync(indexFile,'invalid prepared file');response=await read(`?isins=${isin}`);assert.equal(response.status,503,'A corrupt prepared file cannot silently choose old SQL or a different dataset');fs.writeFileSync(indexFile,original);
  console.log('PASS static MF delivery: exact public/private/current/historical values, authorization before asset reads, no reader GitHub API/network/SQL, encrypted-only static files, complete master restoration and unchanged ciphertext reuse');
}finally{local?.close();fs.rmSync(root,{recursive:true,force:true});}
