import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`),root=resolve('public');let upgraded=false;
const html=`<!doctype html><output id="status"></output><script type="module">
import {summaryScheduleMessage} from '/js/data/concall-summaries-shared.js';
import {watchWorkerChanges} from '/js/core/app-updates.js';
document.querySelector('#status').textContent=summaryScheduleMessage({enabled:true,schedule:{runtime:'github-actions',started:true,lastAttemptAt:Date.now()}});
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const server=createServer((request,response)=>{
 const pathname=new URL(request.url,'http://fixture').pathname;response.setHeader('cache-control','no-cache');
 try{
  if(pathname==='/'||pathname==='/index.html'){response.setHeader('content-type','text/html');return response.end(html);}
  if(pathname==='/sdk-fixture.js')return response.end('/* isolated fixture */');
  const file=resolve(root,'.'+pathname);if(!file.startsWith(root+sep))throw Error('Path');let body=readFileSync(file);
  if(pathname==='/sw.js'){body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK=new URL('/sdk-fixture.js',self.location).href;");if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}previous-summary-release`;');}
  if(pathname==='/js/data/concall-summaries-shared.js'&&!upgraded)body=body.toString().split('\n').filter(line=>!line.includes("if(schedule?.runtime==='github-actions')")).join('\n');
  response.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(file)]||'application/octet-stream');response.end(body);
 }catch{response.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);await page.reload();await page.waitForFunction(()=>window.ready);
 assert.match(await page.locator('#status').innerText(),/no next check scheduled/);const before=await page.evaluate(()=>caches.keys());assert(before.some(name=>name.includes('previous-summary-release')));
 upgraded=true;await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update();});await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('GitHub checks automatically'));
 const after=await page.evaluate(()=>caches.keys());assert(!after.some(name=>name.includes('previous-summary-release')));assert.deepEqual(errors,[]);
 console.log('PASS warm summary session: automatic immutable-module upgrade replaces the retired alarm warning with honest GitHub scheduling status');
}finally{await browser.close();await new Promise(done=>server.close(done));}
