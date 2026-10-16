import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {createHash} from 'node:crypto';
import {localBreakouts} from './lib/breakout-local.mjs';
import {githubBreakouts} from './lib/breakouts-github.mjs';
import {exportBreakouts} from '../worker/breakout-export.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleBreakouts} from '../worker/breakouts.mjs';
import {readLiveBreakouts} from '../worker/breakout-live-delivery.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/breakout-live-'));
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789';
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789',UPSTOX_ACCESS_TOKEN:'fixture-quotes-only',BREAKOUT_LIVE_DELIVERY:'github-release'};
let at=Date.parse('2026-10-16T06:30Z'),sequence=100,transferred=0,ignoreRange=false,corrupt=false;
const releases=new Map(),cacheEntries=new Map();let metadataReads=0;
const metadata=asset=>{const {bytes,...rest}=asset;return rest;};
const fetcher=async(raw,options={})=>{
 const url=new URL(raw),method=options.method||'GET';
 if(['api.github.com','uploads.github.com'].includes(url.hostname)){
  assert([`Bearer ${env.GITHUB_TOKEN}`,`Bearer ${secret}`].includes(options.headers.authorization));assert.equal(options.redirect,'manual');
  if(url.hostname==='uploads.github.com'){
   const id=Number(url.pathname.split('/').at(-2)),release=[...releases.values()].find(r=>r.id===id);assert(release);
   const chunks=[];for await(const chunk of options.body)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),name=url.searchParams.get('name');
   const asset={id:sequence++,name,size:bytes.length,state:'uploaded',created_at:new Date(at).toISOString(),digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),browser_download_url:`https://github.com/${repo}/releases/download/${release.tag_name}/${name}`,bytes};release.assets.push(asset);return Response.json(metadata(asset));
  }
  if(method==='POST'){const input=JSON.parse(options.body),release={id:sequence++,tag_name:input.tag_name,assets:[],body:input.body};releases.set(release.tag_name,release);return Response.json({...release,assets:[]});}
  const id=Number(url.pathname.split('/').at(-1));
  if(method==='PATCH'){const release=[...releases.values()].find(r=>r.id===id);release.body=JSON.parse(options.body).body;return Response.json({...release,assets:release.assets.map(metadata)});}
  if(method==='DELETE'){for(const release of releases.values())release.assets=release.assets.filter(a=>a.id!==id);return new Response(null,{status:204});}
  if(url.pathname.endsWith('/assets')){const release=[...releases.values()].find(r=>r.id===Number(url.pathname.split('/').at(-2)));return Response.json(release.assets.map(metadata));}
  metadataReads++;const release=releases.get(url.pathname.split('/').at(-1));return release?Response.json({...release,assets:release.assets.map(metadata)}):new Response(null,{status:404});
 }
 assert.equal(options.headers?.authorization,undefined,'No secret travels to a release/CDN request');assert.equal(url.hostname,'github.com');
 const asset=[...releases.values()].flatMap(r=>r.assets).find(a=>a.name===url.pathname.split('/').at(-1));assert(asset);
 const range=options.headers?.range;
 if(range){const [,start,end]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);const bytes=asset.bytes.subarray(start,end+1);transferred+=bytes.length;return new Response(corrupt?new Uint8Array(bytes.length):bytes,{status:ignoreRange?200:206,headers:{'content-range':`bytes ${start}-${end}/${asset.size}`}});}
 return new Response(asset.bytes);
};
const cache={match:async request=>{const row=cacheEntries.get(request.url);return row&&row.until>at?row.response.clone():undefined;},put:async(request,response)=>{const ttl=Number(/max-age=(\d+)/.exec(response.headers.get('cache-control'))?.[1]);cacheEntries.set(request.url,{until:at+ttl*1000,response});}};
let source,runtime,restarted;
try{
 source=localBreakouts(path.join(root,'source.sqlite'),{env,now:()=>at});source.primary.config('upstox-inventory');const tickers=Array.from({length:600},(_,i)=>`T${i}`);
 const rows=tickers.map(ticker=>({ticker,name:'Fixture Company',price:108,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-10-16',provider:'Upstox',exchange:'NSE',kind:'quote',base:{high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-10-15'}}));
 source.beginCycle(1);await source.client({action:'begin',targets:tickers});for(let i=0;i<rows.length;i+=50)await source.client({action:'checkpoint',rows:rows.slice(i,i+50)});await source.client({action:'finish'});
 source.store.primarySave({at,completedAt:at,targets:tickers,rows,failures:[],discoveryFailed:false});
 const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)},options={env,fetcher,recipient,localOptions:{now:()=>at},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubBreakouts({...options,file:path.join(root,'runner.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportBreakouts(source.storage,input)});
 await runtime.storage.put('upstox-minute-timer',{started:true,lastAttemptAt:at,nextAt:at+60000,completedAt:at,reason:'ok',saved:600,failed:0});
 await runtime.storage.put('github-breakout-fallback',{lastAttemptAt:at,lastCompletedAt:at,reason:'ok',failed:false});
 const saved=await runtime.publish();assert.equal(saved.feature,'breakouts-live');
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,BREAKOUT_LIVE_DELIVERY:'github-release',ASSETS:{fetch(){throw Error('Current prices must not await a website deployment');}},CAPTURE_REGISTRY:{getByName(){throw Error('No Cloudflare capture work');}}};
 const read=pathname=>handleBreakouts(new Request('https://fixture.research'+pathname),worker,{fetcher,edgeCache:cache,now:()=>at});
 let response=await read('/api/breakouts'),capture=await response.json();assert.equal(response.status,200);assert.equal(capture.rows.length,600);assert.equal(capture.health.checked,600);assert.equal(capture.delivery,'github-release');assert.equal(capture.primarySchedule.overdue,false,'A GitHub runner does not need a retired Cloudflare alarm');
 const after=metadataReads,downloaded=transferred;for(let i=0;i<10;i++)assert.equal((await read('/api/breakouts/health')).status,200);assert.equal(metadataReads,after);assert.equal(transferred,downloaded,'Visible readers share cached immutable prepared files');
 assert(transferred<150000,'A 600-company current read never downloads the complete restart/history database');
 response=await read('/api/breakouts/fallback');assert.equal((await response.json()).primary,undefined,'Fallback reads never mistake a primary success for a completed fallback');
 at+=60000;runtime.store.primarySave({at,completedAt:at,targets:tickers,rows:rows.map(row=>({...row,price:112,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString()})),failures:[],discoveryFailed:false});
 await runtime.storage.put('upstox-minute-timer',{started:true,lastAttemptAt:at,nextAt:at+60000,completedAt:at,reason:'ok',saved:600,failed:0});
 await runtime.publish();response=await read('/api/breakouts');capture=await response.json();assert.equal(capture.rows[0].price,112,'An existing reader receives a new generation without a static redeployment');assert.equal(capture.health.checked,600);
 const expectedHistory=runtime.store.history('T0');
 at+=3*60000;response=await read('/api/breakouts/health');assert.equal(response.status,503);assert.equal((await response.json()).primarySchedule.overdue,true,'Cached generations age honestly when a runner stops');
 cacheEntries.clear();ignoreRange=true;await assert.rejects(readLiveBreakouts(worker,'https://fixture.research',{fetcher,edgeCache:cache,now:at}),/range/);ignoreRange=false;
 cacheEntries.clear();corrupt=true;await assert.rejects(readLiveBreakouts(worker,'https://fixture.research',{fetcher,edgeCache:cache,now:at}));corrupt=false;
 await assert.rejects(readLiveBreakouts(worker,'https://fixture.research',{fetcher:async()=>new Response(null,{status:404}),edgeCache:null,now:at}),/unavailable/,'Missing live publication must explicitly degrade saved-data health');
 await runtime.close();runtime=null;
 restarted=await githubBreakouts({...options,env:{...env,GITHUB_RUN_ID:'12346'},file:path.join(root,'restarted.sqlite'),out:path.join(root,'restart-publication'),legacyClient:async()=>{throw Error('Live checkpoint must restore all retained history');}});
 assert.deepEqual(restarted.store.history('T0'),expectedHistory);assert.equal(restarted.store.read().rows.length,600);
 assert.equal((await restarted.storage.get('upstox-minute-timer')).saved,600);
 console.log('PASS 600-company live delivery: encrypted current-only byte ranges, shared cache, unchanged source clocks, overdue health, rejected corrupt/ignored ranges, independent fallback and complete retained-history restart');
}finally{await runtime?.close();await restarted?.close();await source?.close();fs.rmSync(root,{recursive:true,force:true});}
