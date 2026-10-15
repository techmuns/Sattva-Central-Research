import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {localPriceLevels} from './lib/price-levels-local.mjs';
import {githubPriceLevels} from './lib/price-levels-github.mjs';
import {exportPriceLevels} from '../worker/price-levels-export.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handlePriceLevels} from '../worker/price-levels.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/price-levels-github-'));
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789';let at=Date.parse('2026-09-15T06:30:00Z');const now=()=>at;
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789',UPSTOX_ACCESS_TOKEN:'fixture-quotes-only'};
let exists=false,sequence=1,body='',assetReads=0;const remote=new Map(),tag='price-level-data';
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
let source,runtime,restarted;
try{
 source=localPriceLevels(path.join(root,'old.sqlite'),{env,now});
 const edit=value=>[{op:'patch',ticker:'TEST',isin:'INE000000001',name:'Fixture',levels:{sellAt:value}}];
 for(let index=0;index<505;index++){at++;source.store.apply(edit(100+index));at++;source.store.recordCheck(at,new Map([['TEST',{price:1000,sessionDate:'2026-09-15',quoteAt:new Date(at).toISOString()}]]));}
 at++;source.store.apply(edit(50));
 const before=source.db.prepare('SELECT total_changes() n').get().n,keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
 const sourceInputs=()=>exportPriceLevels(source.storage,{inputs:true});
 const options={env,fetcher,recipient,inputs:sourceInputs,localOptions:{now},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubPriceLevels({...options,file:path.join(root,'runner.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportPriceLevels(source.storage,input)});
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(runtime.store.snapshot(),source.store.snapshot());
 await runtime.applyInputs(await sourceInputs());at++;runtime.store.recordCheck(at,new Map([['TEST',{price:1000,sessionDate:'2026-09-15',quoteAt:new Date(at).toISOString()}]]));
 assert.equal(runtime.store.snapshot().retainedHits,506);
 const saved=await runtime.publish(),site=path.join(root,'public');await installPreparedBackground([saved],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
 const token='fixture-private-service-token-000000001';let lookups=0;
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,FAMILY_PRICE_LEVELS_TOKEN:token,CAPTURE_REGISTRY:{getByName(){lookups++;return {priceLevelsSnapshot:cursor=>source.schedule.snapshot(cursor),priceLevelsApply:input=>{const result=source.store.apply(input);return {...result.snapshot,outcomes:result.outcomes};}};}},ASSETS:{fetch:async request=>{assetReads++;assert.equal(request.headers.get('authorization'),null);const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 const read=async cursor=>{const response=await handlePriceLevels(new Request('https://fixture.test/api/price-levels'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{headers:{authorization:'Bearer '+token}}),worker);assert.equal(response.status,200);return response.json();};
 assert.equal((await handlePriceLevels(new Request('https://fixture.test/api/price-levels'),worker)).status,401);assert.equal(lookups,0);assert.equal(assetReads,0,'Authentication precedes both source and private static access');
 let page=await read(),hits=[...page.hits];assert(page.companies[0].levels.sellAt.reached);assert.equal(page.retainedHits,506);
 while(page.nextCursor){page=await read(page.nextCursor);hits.push(...page.hits);}assert.equal(hits.length,506);assert.equal(new Set(hits.map(hit=>hit.id)).size,506);
 at++;source.store.apply(edit(900));page=await read();assert.equal(page.companies[0].levels.sellAt.value,900);assert.equal(page.companies[0].levels.sellAt.reached,null);assert.equal(page.check.current,false);assert.equal(page.check.state,'waiting');
 await runtime.applyInputs(await sourceInputs());assert.equal(runtime.store.snapshot().companies[0].levels.sellAt.reached,null);assert.equal(runtime.store.snapshot().retainedHits,506);
 at++;source.store.apply([{op:'clear',ticker:'TEST'}]);page=await read();assert.equal(page.companies.length,0,'A delayed publication cannot resurrect a cleared company');assert.equal(page.retainedHits,506);
 await runtime.applyInputs(await sourceInputs());assert.equal(runtime.store.snapshot().companies.length,0);assert.equal(runtime.store.snapshot().retainedHits,506);
 await runtime.publish();await runtime.close();runtime=null;
 restarted=await githubPriceLevels({...options,file:path.join(root,'restarted.sqlite'),out:path.join(root,'restarted-publication'),legacyClient:async()=>{throw Error('Initialized history cannot reset');}});assert.equal(restarted.store.snapshot().retainedHits,506);assert.equal(restarted.store.snapshot().companies.length,0);
 console.log('PASS retained price levels: exact read-only import, 506 historical hits through encrypted static paging, private service auth first, delayed edits/clears never resurrect, local reconciliation retains history, encrypted restart');
}finally{await restarted?.close();await runtime?.close();await source?.close();fs.rmSync(root,{recursive:true,force:true});}
