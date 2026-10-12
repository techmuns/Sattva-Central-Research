import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false, failed = false, checks = 0;
const book = [0, 1].map(i => ({ isin: `INE${String(i).padStart(9, '0')}`, name: `Company ${i}`, sector: 'Test', ticker: `A${i}`, weightPct: i ? 80 : 20 }));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/ai-alerts.js';import * as coverage from '/js/data/coverage.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
import { currentDay } from '/js/ui/ai-alert-utils.js';
coverage.prime({holdings:${JSON.stringify(book)}});
window.fixtureEvents=${JSON.stringify(book)}.flatMap(h=>['earnings','announcements','insider'].map((feed,i)=>({id:h.ticker+feed,ticker:h.ticker,company:h.name,feed,feedLabel:feed,day:currentDay(),time:'12:00',headline:h.name+' material fraud risk '+i,keywordIds:['fraud'],importance:'high',direction:'negative',tab:'daily-alerts'})));
window.ctx={root:document.querySelector('#root'),scope:'portfolio',params:{}};tab.render(window.ctx);
window.hideAlerts=()=>{tab.destroy();document.querySelector('#root').innerHTML='';};window.showAlerts=()=>tab.render(window.ctx);
window.refreshSizes=async()=>{await (await import('/js/core/refresh.js')).refreshAll();};
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const daily = `import {currentDay} from '../ui/ai-alert-utils.js';export const today=currentDay;export const onChange=()=>()=>{};export const readCachedAlertWindow=async()=>null;
export async function collect({scope}){return {day:currentDay(),scope,events:window.fixtureEvents,feeds:['earnings','announcements','insider'].map(id=>({id,status:'ok',reachesToday:true})),pending:0};}`;
// Model the old authenticated-only reader inside the real immutable module cache.
let previous = readFileSync(resolve(root, 'js/tabs/ai-alerts.js'), 'utf8')
  .replace("import { readHoldingSizes as readPositionSizes, cachedHoldingSizes as cachedPositionSizes } from '../data/holding-sizes.js';",
    "import { readPositionSizes, cachedPositionSizes } from '../research/portfolio-bridge.js';");
const start = previous.indexOf('function positionStatus() {'), end = previous.indexOf('function searchMarkup()', start);
previous = previous.slice(0, start) + `function positionStatus(){return '<p><button data-ai-unlock>Unlock portfolio to include holding sizes</button></p>'; }\n` + previous.slice(end);
const server = createServer((req,res)=>{
  const p=new URL(req.url,'http://local').pathname;res.setHeader('cache-control','no-cache');
  if(p==='/'||p==='/index.html'){res.setHeader('content-type','text/html');return res.end(html);}
  if(p==='/api/holding-sizes'){
    checks++;res.setHeader('content-type','application/json');res.setHeader('cache-control','private, no-store');
    if(failed){res.statusCode=503;return res.end('{}');}
    return res.end(JSON.stringify({sizes:{basis:'listed-market-value',valuation:'workbook',complete:true,bookAsOf:'2026-08-31',checkedAt:new Date().toISOString(),archiveVersion:2,sourceRevision:'a'.repeat(64)},holdings:book}));
  }
  if(p==='/sdk-fixture.js'){res.setHeader('content-type','text/javascript');return res.end('/* fixture */');}
  if(p==='/js/data/daily-alerts.js'){res.setHeader('content-type','text/javascript');return res.end(daily);}
  try{
    const path=resolve(root,'.'+p);if(!path.startsWith(root+sep))throw Error('path');let content=readFileSync(path);
    if(p==='/js/tabs/ai-alerts.js'&&!upgraded)content=previous;
    if(p==='/sw.js'){
      content=content.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js',self.location).href;");
      if(!upgraded)content=content.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}previous-holding-sizes-release`;');
    }
    res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(path)]||'application/octet-stream');res.end(content);
  }catch{res.statusCode=404;res.end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url==='https://sattva-family.pages.dev/research-bridge')return route.fulfill({contentType:'text/html',body:`<script>addEventListener('message',e=>parent.postMessage({channel:'sattva-portfolio-v1',type:'auth-required'},e.origin))</script>`});
    return url.startsWith(`http://127.0.0.1:${server.address().port}`)?route.continue():route.fulfill({status:503,body:'{}'});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
  await page.reload();await page.waitForFunction(()=>window.ready);
  await page.locator('[data-ai-unlock]').waitFor();
  const before=await page.evaluate(()=>caches.keys());upgraded=true;
  await page.evaluate(async()=> (await navigator.serviceWorker.getRegistration()).update());
  await page.locator('[data-ai-holding-size]').first().waitFor({timeout:30000});
  assert.equal(await page.locator('[data-ai-unlock]').count(),0);
  assert.equal(await page.locator('iframe').count(),0,'default sizes create no Family sign-in frame');
  assert.equal(await page.locator('[data-ai-sort]').inputValue(),'newest','sizes never change the chosen sort');
  await page.locator('[data-ai-sort]').selectOption('holdings');
  assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'),'A1');
  book[0].weightPct=90;book[1].weightPct=10;
  await page.evaluate(async()=> (await import('/js/data/holding-sizes.js')).readHoldingSizes(undefined,{force:true}));
  await page.waitForFunction(()=>document.querySelector('[data-ai-card]')?.dataset.ticker==='A0');
  assert.equal(await page.locator('[data-ai-sort]').inputValue(),'holdings','background weights retain the chosen sort');
  await page.evaluate(()=>window.refreshSizes());assert(checks>=2,'manual revalidation checks the source');
  failed=true;await page.evaluate(()=>window.refreshSizes());
  assert.equal(await page.locator('[data-ai-holding-size]').count(),0);
  assert.equal(await page.locator('[data-ai-card]').count(),2,'failure retains public evidence');
  assert.equal(await page.locator('[data-ai-unlock]').count(),0);
  failed=false;await page.evaluate(()=>window.refreshSizes());
  assert.equal(await page.locator('[data-ai-holding-size]').count(),2);
  await page.evaluate(()=>window.hideAlerts());failed=true;
  await page.evaluate(async()=>{try{await (await import('/js/data/holding-sizes.js')).readHoldingSizes(undefined,{force:true});}catch{}});
  await page.evaluate(()=>window.showAlerts());
  assert.equal(await page.locator('[data-ai-holding-size]').count(),0,'returning to alerts cannot restore weights after a background failure');
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('weightPct')),false);
  const after=await page.evaluate(()=>caches.keys());assert(after.some(k=>!before.includes(k)));assert(!after.some(k=>k.includes('previous-holding-sizes-release')));
  assert.equal(await page.evaluate(async()=>{for(const key of await caches.keys()){const c=await caches.open(key);if((await c.keys()).some(r=>r.url.includes('/api/holding-sizes')))return true;}return false;}),false);
  assert.deepEqual(errors,[]);
  console.log('PASS returning session upgrades automatically; default/background sizes, chosen sort, failure/recovery and cache privacy');
}finally{await browser.close();await new Promise(done=>server.close(done));}
