// A warm, already-open reader must replace the wrong baseline through the actual service worker.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public');let upgraded=false;
const html=`<!doctype html><main id="reading"></main><script type="module">
import * as momentum from '/js/scoring/momentum-live.js';
import {watchWorkerChanges} from '/js/core/app-updates.js';
const now=Date.parse('2026-10-09T06:30:00Z'),frame={value:80,avgGain:4,avgLoss:1,lastClose:100};
const company={cmp:100,bar_date:'2026-10-08',sma20:90,sma50:85,sma100:80,sma200:75,above_20dma:true,avg_volume_10d:136606,
  rsi_multi:{daily:frame,weekly:frame,monthly:frame},macd:{ema12:110,ema26:100,line:10,signal:1},closeHistory:{sourceSymbol:'TEST.NS'}};
const quote={price:102,prevClose:100,volume:136606*1.73,sessionDate:'2026-10-09',quoteAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),provider:'Upstox',exchange:'NSE',
  volumeBase:{average:188762.5,from:'2026-09-24',to:'2026-10-08',count:10,exchange:'NSE'}};
const values=momentum.scannerIndicators(company,quote,{now});
const pending=momentum.scannerIndicators({...company,bar_date:'2026-10-07'},quote,{now});
reading.textContent=JSON.stringify({ratio:values.volRatio10d,pass:momentum.evaluateFilter('volume-momentum',values).pass,
  pendingPrice:pending.price,pendingLive:pending.isLiveQuote,pendingPass:momentum.evaluateFilter('strong-momentum',pending).pass});
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const oldModule=`export function scannerIndicators(c,q){return {volRatio10d:q.volume/c.avg_volume_10d,price:c.cmp,isLiveQuote:false,evaluable:c.bar_date==='2026-10-08'};}
export function evaluateFilter(_,v){return {pass:v.evaluable&&v.volRatio10d>=1.5};}`;
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;res.setHeader('cache-control','no-cache');
  try {
    if(path==='/'||path==='/index.html'){res.setHeader('content-type','text/html');res.end(html);return;}
    if(path==='/sdk-fixture.js'){res.end('/* isolated SDK */');return;}
    const file=resolve(root,'.'+path);if(!file.startsWith(root+sep))throw Error('outside fixture');
    let body=readFileSync(file);
    if(path==='/sw.js'){
      body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js',self.location).href;");
      if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}previous-momentum-release`;');
    }
    if(path==='/js/scoring/momentum-live.js'&&!upgraded)body=oldModule;
    res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream');res.end(body);
  } catch {res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
  await page.goto(origin);await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
  await page.reload();await page.waitForFunction(()=>window.ready);
  assert.deepEqual(JSON.parse(await page.locator('#reading').innerText()),{ratio:1.73,pass:true,pendingPrice:100,pendingLive:false,pendingPass:false});
  assert((await page.evaluate(()=>caches.keys())).some(key=>key.includes('previous-momentum-release')));
  upgraded=true;await page.evaluate(async()=>(await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#reading').textContent).pass===false);
  const reading=JSON.parse(await page.locator('#reading').innerText());assert(reading.ratio>1.25&&reading.ratio<1.26);
  assert.equal(reading.pendingPrice,102);assert.equal(reading.pendingLive,true);assert.equal(reading.pendingPass,false);
  assert(!(await page.evaluate(()=>caches.keys())).some(key=>key.includes('previous-momentum-release')));
  assert.deepEqual(errors,[]);
  console.log('PASS warm momentum reader replaces the immutable module, corrects 1.73x to 1.25x, and removes the false pass without manual reload');
} finally {await browser.close();await new Promise(done=>server.close(done));}
