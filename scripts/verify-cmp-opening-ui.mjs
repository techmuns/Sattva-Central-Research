// Saved-first price paint, automatic updates and the actual returning-reader cache.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {gzipSync} from 'node:zlib';
import {BREAKOUT_REPO} from '../public/js/data/breakout-live-shared.js';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public'),at=Date.parse('2026-10-29T09:46:00+05:30');
let quoteAt=at,price=870.25,blocked=true,failed=false,upgraded=false,reads=0;
const held=[];
const quote=(value,time)=>({ticker:'SKYGOLD',price:value,prevClose:858.3,volume:1000,quoteAt:new Date(time).toISOString(),checkedAt:new Date(time).toISOString(),sessionDate:new Date(time+19800000).toISOString().slice(0,10),provider:'Upstox',exchange:'NSE'});
const capture=row=>({version:1,state:'complete',rows:[row],targets:['SKYGOLD'],failures:[],discoveryFailed:false,completedAt:row.checkedAt});
const html=`<!doctype html><main id="reading"></main><script type="module">
import * as prices from '/js/data/breakout-live.js';
import {writeEntry} from '/js/core/store.js';
import {watchWorkerChanges} from '/js/core/app-updates.js';
if(location.search.includes('seed'))await writeEntry('sattva:breakout-capture:v1',{value:${JSON.stringify(capture(quote(858.3,at-18*3600000)))}});
const render=()=>{const info=prices.priceInfo({ticker:'SKYGOLD'});reading.textContent=JSON.stringify(info);};
prices.watch(render);render();
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;res.setHeader('cache-control','no-cache');
 if(path==='/api/breakouts/snapshot'){
  reads++;
  const send=()=>{
   if(failed){res.writeHead(503,{'content-type':'application/json'}).end('{}');return;}
   const tag=`"${price}-${quoteAt}"`;
   if(req.headers['if-none-match']===tag){res.writeHead(304,{etag:tag}).end();return;}
   const head={version:1,repo:BREAKOUT_REPO,feature:'breakouts-live',createdAt:new Date(quoteAt).toISOString(),fallback:capture(quote(price,quoteAt)),primary:null};
   res.writeHead(200,{'content-type':'application/json',etag:tag}).end(JSON.stringify({format:'gzip-json',gzip:gzipSync(JSON.stringify(head)).toString('base64')}));
  };
  if(blocked)held.push(send);else send();return;
 }
 if(path==='/api/breakouts'){res.writeHead(503,{'content-type':'application/json'}).end('{}');return;}
 if(path==='/'||path==='/index.html'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(path==='/sdk-fixture.js'){res.end('/* local fixture */');return;}
 try{
  const file=resolve(root,'.'+path);if(!file.startsWith(root+sep))throw Error('outside fixture');let body=readFileSync(file);
  if(path==='/sw.js'){
   body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js',self.location).href;");
   if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}previous-cmp-release`;');
  }
  if(path==='/js/data/breakout-live.js'&&!upgraded)body=body.toString().replace(' || minuteStale','');
  res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream');res.end(body);
 }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
 await page.clock.install({time:new Date(at)});
 await page.goto(origin+'/?seed');
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===858.3);
 assert.equal(await page.evaluate(()=>JSON.parse(reading.textContent||'{}').stale),true,'Saved price paints while network is still blocked');
 blocked=false;held.splice(0).forEach(send=>send());
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===870.25&&!JSON.parse(reading.textContent||'{}').stale);
 await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
 // Stop seeding before reloading a warm, immutable old module graph.
 await page.goto(origin);await page.waitForFunction(()=>window.ready);
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===870.25&&!JSON.parse(reading.textContent||'{}').stale);
 await page.evaluate(async()=>{await (await import('/js/data/breakout-live.js')).refresh();});
 await page.clock.fastForward(121000);
 await page.evaluate(async()=>{await (await import('/js/data/breakout-live.js')).refresh();});
 const oldReading=await page.evaluate(async()=>{const live=await import('/js/data/breakout-live.js');return {info:JSON.parse(reading.textContent||'{}'),failed:live.unavailable(),now:Date.now(),usesMinuteExpiry:live.priceInfo.toString().includes(' || minuteStale'),capture:live.snapshot()};});
 assert.equal(oldReading.info.stale,false,JSON.stringify(oldReading));
 assert((await page.evaluate(()=>caches.keys())).some(key=>key.includes('previous-cmp-release')));
 upgraded=true;await page.evaluate(async()=>(await navigator.serviceWorker.getRegistration()).update());
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===870.25&&JSON.parse(reading.textContent||'{}').stale===true);
 assert(!(await page.evaluate(()=>caches.keys())).some(key=>key.includes('previous-cmp-release')),'Old immutable modules are evicted');
 const originalAt=await page.evaluate(()=>JSON.parse(reading.textContent||'{}').at);
 await page.clock.runFor(15000);assert.equal(await page.evaluate(()=>JSON.parse(reading.textContent||'{}').at),originalAt,'304 reads never restamp source time');
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 const hiddenReads=reads;await page.clock.runFor(30000);assert.equal(reads,hiddenReads,'Hidden readers stop quote checks');
 quoteAt=await page.evaluate(()=>Date.now());price=871;
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});window.dispatchEvent(new Event('focus'));});
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===871&&!JSON.parse(reading.textContent||'{}').stale);
 failed=true;await page.clock.runFor(15000);
 await page.waitForFunction(()=>JSON.parse(reading.textContent||'{}').price===871&&JSON.parse(reading.textContent||'{}').stale);
 assert.deepEqual(errors,[]);
 console.log('PASS CMP: saved-first opening during a blocked network, current price arrival, real warm-session upgrade, source expiry after 304, hidden pause, focus recovery and last-good prices during failure');
}finally{blocked=false;held.splice(0).forEach(send=>send());await browser.close();await new Promise(done=>server.close(done));}
