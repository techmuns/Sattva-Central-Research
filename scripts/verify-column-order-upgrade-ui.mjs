// A genuinely warm, controlled page upgrades through the shipped service worker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public');let upgraded=false;
const html=`<!doctype html><main id="fixture"></main><script type="module">
import { scoreTable } from '/js/ui/screener.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
const table=scoreTable({columnLayoutKey:'upgrade',rows:[{name:'Company',value:123}],showRank:false,showAvatar:false,name:r=>r.name,key:r=>r.name,columns:[{label:'Shares',get:r=>r.value}]});
fixture.innerHTML=table.html;table.wire(fixture);
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;res.setHeader('cache-control','no-cache');
 try{
  if(path==='/'||path==='/index.html'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(path==='/sdk-fixture.js'){res.end('/* isolated SDK */');return;}
  const file=resolve(root,'.'+path);if(!file.startsWith(root+sep))throw Error();let body=readFileSync(file);
  if(path==='/sw.js'){
   body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
   if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}previous-column-release`;');
  }
  if(path==='/js/ui/column-order.js'&&!upgraded)body='export function installColumnOrder() {}';
  res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream');res.end(body);
 }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
 await page.goto(origin);await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
 await page.reload();await page.waitForFunction(()=>window.ready);
 assert.equal(await page.locator('[data-column-reorder]').count(),0);
 const before=await page.evaluate(()=>caches.keys());assert(before.some(key=>key.includes('previous-column-release')));
 upgraded=true;await page.evaluate(async()=>(await navigator.serviceWorker.getRegistration()).update());
 await page.waitForSelector('[data-column-reorder]');
 await page.locator('th').first().focus();await page.keyboard.press('Alt+ArrowRight');
 assert.deepEqual((await page.locator('th').allTextContents()).map(s=>s.trim()),['Shares','Company']);
 await page.reload();await page.waitForSelector('[data-column-reorder]');
 assert.deepEqual((await page.locator('th').allTextContents()).map(s=>s.trim()),['Shares','Company']);
 const after=await page.evaluate(()=>caches.keys());assert(!after.some(key=>key.includes('previous-column-release')));
 assert.deepEqual(errors,[]);console.log('PASS returning dashboard upgrades its warm immutable modules, gains column dragging, and retains its chosen layout after reload');
}finally{await browser.close();await new Promise(done=>server.close(done));}
