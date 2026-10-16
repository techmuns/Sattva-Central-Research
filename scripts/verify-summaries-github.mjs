import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {localSummaries} from './lib/summaries-local.mjs';
import {githubSummaries} from './lib/summaries-github.mjs';
import {exportSummaries} from '../worker/summaries-export.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleConcallSummaries} from '../worker/concall-summaries.mjs';
import {runSummaryCollection} from './collect-screener-summaries.mjs';
import {SUMMARY_ORIGIN,SUMMARY_SOURCE_INTERVAL_MS} from '../public/js/data/concall-summaries-shared.js';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/summary-github-'));
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789';
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789'};
let exists=false,sequence=1,body='',assetReads=0;const remote=new Map(),tag='summary-data';
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
let source,runtime,restarted,opened=0,paidReads=0,at=Date.now()-SUMMARY_SOURCE_INTERVAL_MS-16000;
const stamp=()=>new Date(at).toISOString();
const target=id=>({id,isin:'INE000000001',name:'Private Fixture',ticker:'TEST',companyKey:'TEST',companyUrl:'https://www.screener.in/company/TEST/',publishedDate:'2026-10-01',kind:'Transcript',sourceName:'Fixture transcript',rank:Number(id),url:'https://www.screener.in/concalls/summary/'+id+'/'});
const inventory=ids=>({version:1,portfolioRevision:'a'.repeat(64),portfolioCheckedAt:stamp(),sourceCheckedAt:stamp(),portfolioAsOf:'2026-10-01',portfolioWorkbookUploadedAt:stamp(),holdings:[{isin:'INE000000001',name:'Private Fixture',ticker:'TEST',companyKey:'TEST',discovery:'matched'}],targets:ids.map(target)});
const summary={title:'Concall Summary - Private Fixture - October 2026',blocks:[{type:'paragraph',text:'The company discussed its operating performance and management provided its outlook for the current financial year. These captured source notes retain the original evidence without adding new conclusions or guesses.'}]};
try {
 source=localSummaries(path.join(root,'old-source.sqlite'),{env,now:()=>at,checkpoint:async()=>{}});source.store.sync(inventory(['1','2']));
 const complete=source.store.reserve('1:1',randomUUID());source.store.complete('1:1',{...complete,outcome:'ready',body:summary});at+=SUMMARY_SOURCE_INTERVAL_MS;
 const interrupted=source.store.reserve('1:1',randomUUID());assert(interrupted.reserved);
 const before=source.db.prepare('SELECT total_changes() n').get().n,keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
 const options={env,fetcher,recipient,now:()=>at,transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubSummaries({...options,file:path.join(root,'state.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportSummaries(source.storage,input)});
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before,'Migration never writes source rows');
 assert.equal(runtime.store.status().automatedRequestsLast24h,2);assert.deepEqual(runtime.store.read(['1'])[0].body,summary);assert.equal(runtime.store.read(['2'])[0].status,'interrupted');
 const result=await runSummaryCollection({client:runtime.client,inventory:async()=>inventory(['1','2','3']),openSession:async()=>{
   opened++;restarted=await githubSummaries({...options,env:{...env,GITHUB_RUN_ID:'12346'},file:path.join(root,'inspection.sqlite'),out:path.join(root,'inspection'),legacyClient:async()=>{throw Error('No source fallback');}});
   assert.equal(restarted.store.status().automatedRequestsLast24h,3,'The paid claim is already retained on GitHub before login');await restarted.close();restarted=null;return {page:{},close:async()=>{}};
 },read:async()=>{paidReads++;return summary;}});
 assert.equal(result.reason,'busy');assert.equal(opened,0,'The imported interrupted lease blocks additional paid pages until it expires');
 // Complete only the imported claim using its original source owner. This local
 // fixture acknowledgement models the source result already known by that owner.
 runtime.store.complete('1:1',{...interrupted,outcome:'ready',body:summary});await runtime.publish();at+=SUMMARY_SOURCE_INTERVAL_MS;
 const collected=await runSummaryCollection({client:runtime.client,inventory:async()=>inventory(['1','2','3']),openSession:async()=>{
   opened++;restarted=await githubSummaries({...options,env:{...env,GITHUB_RUN_ID:'12346'},file:path.join(root,'inspection.sqlite'),out:path.join(root,'inspection'),legacyClient:async()=>{throw Error('No source fallback');}});
   assert.equal(restarted.store.status().automatedRequestsLast24h,3);await restarted.close();restarted=null;return {page:{},close:async()=>{}};
 },read:async()=>{paidReads++;return summary;}});
 assert.equal(collected.saved,1);assert.equal(opened,1);assert.equal(paidReads,1);
 const previousName=[...remote.values()].sort((a,b)=>b.id-a.id)[0].name;
 await runtime.close();runtime=await githubSummaries({...options,file:path.join(root,'state.sqlite'),out:path.join(root,'publication'),legacyClient:async()=>{throw Error('No reset between workflow steps');}});
 await runtime.publish();
 const site=path.join(root,'public'),latest=[...remote.values()].sort((a,b)=>b.id-a.id)[0];assert.notEqual(latest.name,previousName,'The next process in the same workflow continues immutable checkpoint generations');await installPreparedBackground([{repo,feature:'summaries',asset:latest}],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,SCREENER_SUMMARIES_ENABLED:'true',SCREENER_SUMMARY_READER_EMAILS:'allowed@fixture.test',SCREENER_SUMMARIES:{getByName(){throw Error('No Cloudflare summary reads');}},ASSETS:{fetch:async request=>{assetReads++;const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 const api=(method,body,token='fixture-reader-token-123456789')=>handleConcallSummaries(new Request(SUMMARY_ORIGIN+'/api/concall-summaries',{method,headers:{...(token?{authorization:'Bearer '+token}:{}),origin:SUMMARY_ORIGIN},...(body?{body:JSON.stringify(body)}:{})}),worker,{fetcher:async url=>{assert.equal(url,'https://fastapi.muns.io/auth/me');return Response.json({email:'allowed@fixture.test'});}});
 const count=assetReads;assert.equal((await api('GET',null,null)).status,401);assert.equal(assetReads,count,'Reader authorization precedes static lookup');
 let response=await api('POST',{ids:['1','2','3','99']});assert.equal(response.status,200);let data=await response.json();assert.deepEqual(data.records.slice(0,3).map(row=>row.body),[summary,summary,summary]);assert.equal(data.records[3].status,'not-collected');assert.match(response.headers.get('cache-control'),/private.*no-store/);
 response=await api('GET');data=await response.json();assert.equal(data.schedule.runtime,'github-actions');assert.equal(data.automatedRequestsLast24h,3);
 const files=fs.readdirSync(path.join(site,'generated-views/summaries'));for(const name of files)assert(!fs.readFileSync(path.join(site,'generated-views/summaries',name)).includes(Buffer.from(summary.blocks[0].text)));
 await runtime.close();runtime=null;restarted=await githubSummaries({...options,env:{...env,GITHUB_RUN_ID:'12347'},file:path.join(root,'restart.sqlite'),out:path.join(root,'restart'),legacyClient:async()=>{throw Error('No legacy reset');}});assert.equal(restarted.store.status().automatedRequestsLast24h,3);assert.deepEqual(restarted.store.read(['1','2','3']).map(row=>row.body),[summary,summary,summary]);
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before);
 console.log('PASS private summary GitHub migration: all historical claims/body/cooldowns, acknowledged claim before source I/O, zero legacy writes, encrypted static records, exact authenticated reads, missing IDs and restart without source fallback');
}finally{await restarted?.close();await runtime?.close();await source?.close();fs.rmSync(root,{recursive:true,force:true});}
