import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {localBreakouts} from './lib/breakout-local.mjs';
import {githubBreakouts} from './lib/breakouts-github.mjs';
import {exportBreakouts} from '../worker/breakout-export.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleBreakouts} from '../worker/breakouts.mjs';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/breakouts-github-'));
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789',at=Date.parse('2026-09-15T06:30:00Z');
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789',UPSTOX_ACCESS_TOKEN:'fixture-quotes-only'};
let exists=false,sequence=1,body='',assetReads=0;const remote=new Map(),tag='breakout-data';
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
let source,primary,runtime,restarted;
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'},row={ticker:'TEST',name:'Fixture',price:108,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider:'Upstox',exchange:'NSE',kind:'quote',base};
try{
 source=localBreakouts(path.join(root,'old-capture.sqlite'),{env,now:()=>at});source.beginCycle(1);await source.client({action:'begin',targets:['TEST']});await source.client({action:'checkpoint',rows:[row]});await source.client({action:'finish'});source.store.primarySave({at,completedAt:at,targets:['TEST'],rows:[{...row,price:111}],failures:[],discoveryFailed:false});
 source.db.prepare('INSERT OR IGNORE INTO breakout_primary_latest VALUES(?,?)').run(0,'{}');
 primary=localBreakouts(path.join(root,'old-primary.sqlite'),{env,now:()=>at});await primary.primary.inventory([{ticker:'TEST',isin:'INE000000001',name:'Fixture'}]);
 const changes=()=>[source,primary].map(store=>store.db.prepare('SELECT total_changes() n').get().n),before=changes(),keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
 const options={env,fetcher,recipient,localOptions:{now:()=>at},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubBreakouts({...options,file:path.join(root,'runner.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportBreakouts((input.part==='primary'?primary:source).storage,input)});
 assert.deepEqual(changes(),before);assert.deepEqual(runtime.store.history('TEST'),source.store.history('TEST'));assert.equal(runtime.primary.config('upstox-inventory').targets.length,1);
 await runtime.primary.arm();const saved=await runtime.publish(),site=path.join(root,'public');await installPreparedBackground([saved],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,CAPTURE_REGISTRY:{getByName(){throw Error('Prepared quote readers cannot touch Cloudflare SQL');}},ASSETS:{fetch:async request=>{assetReads++;assert.equal(request.headers.get('authorization'),null);const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 let readAt=at;const read=(suffix,headers)=>handleBreakouts(new Request(BREAKOUT_ORIGIN+suffix,{headers}),worker,{now:()=>readAt,edgeCache:null,fetcher:async()=>{throw Error('Prepared readers cannot use external metadata');}});
 let response=await read('/api/breakouts'),data=await response.json();assert.equal(response.status,200);assert.deepEqual(data.rows,runtime.store.read().rows);assert.equal(data.delivery,'static-assets');const tag=response.headers.get('etag');assert.match(tag,/^"[a-f0-9]{64}"$/);assert.equal(data.contentTag,tag.slice(1,-1));
 response=await read('/api/breakouts',{'if-none-match':tag});assert.equal(response.status,304);assert.equal(await response.text(),'','An unchanged complete capture revalidates without a body');
 readAt=at+3*60000;runtime.store.now=()=>readAt;response=await read('/api/breakouts');data=await response.json();assert.deepEqual(data.rows,runtime.store.read().rows);assert.equal(data.rows[0].price,108,'An aged minute snapshot selects the original fresh fallback rather than a frozen earlier merge');assert.notEqual(response.headers.get('etag'),tag,'Read-time source changes invalidate the capture tag');readAt=at;runtime.store.now=()=>at;
 response=await read('/api/breakouts/fallback');data=await response.json();assert.equal(data.rows[0].price,108);response=await read('/api/breakouts/history?ticker=TEST');assert.deepEqual(await response.json(),source.store.history('TEST'));
 response=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/collector',{method:'POST',body:JSON.stringify({action:'begin'})}),worker,{identity:async()=>'1:1'});assert.equal(response.status,410,'Legacy collector writes are rejected before any object call');
 await runtime.close();runtime=null;restarted=await githubBreakouts({...options,env:{...env,GITHUB_RUN_ID:'12346'},file:path.join(root,'restarted.sqlite'),out:path.join(root,'restarted-publication'),legacyClient:async()=>{throw Error('An initialized GitHub archive cannot bootstrap again');}});assert.deepEqual(restarted.store.history('TEST'),source.store.history('TEST'));assert.equal(restarted.primary.config('upstox-inventory').targets[0].isin,'INE000000001');assert.deepEqual(changes(),before);
 console.log('PASS GitHub breakout migration: every retained row and exact instrument inventory, encrypted master restart, exact current/fallback/history static reads, zero legacy writes and zero reader network/SQL, and rejected Cloudflare collector writes');
}finally{await restarted?.close();await runtime?.close();await source?.close();await primary?.close();fs.rmSync(root,{recursive:true,force:true});}
