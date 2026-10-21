// A real warm service-worker upgrade, three-column reader, lifecycle and publication failure check.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public');let upgraded=false,unavailable=false;
const now=new Date().toISOString();
const one={id:'fixture-1',isin:'INE372C01037',ticker:'PRECWIRE',company:'Fixture Precision',model:'earnings',modelName:'Improving earnings',score:80,
  catalyst:'Revenue and underlying earnings improved in the original filing.',price:'125.50',priceAsOf:now.slice(0,10),priceCheckedAt:now,issuedAt:now,evidenceDate:now.slice(0,10),
  sourceUrl:'https://nsearchives.nseindia.com/corporate/fixture.pdf',details:{basis:'Consolidated',reasons:['Revenue grew 25%'],valuation:{pe:'12.5',period:'annual'},fieldEvidence:{}}};
let capture={version:1,stage:'research-candidates',modelVersion:'catalysts-1',status:'partial',generatedAt:now,rows:[one],rowCount:1,backtest:{strategyValidation:'not-established',models:{}},coverage:{financialCompanies:1,assessments:1,pendingDocuments:20,failedDocuments:1}};
const html=`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">
<style>:root{--brand-600:#4f46e5;--brand-500:#6366f1;--positive:#059669;--page-bg:#f8fafc}body{margin:0;padding:16px}#root{max-width:1400px;margin:auto}nav{display:flex;gap:12px;overflow:auto}button{padding:8px}</style>
<nav id="tabs"></nav><div id="root"></div><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><div id="drill-overlay" class="hidden"><div id="drill-container"><div id="drill-content"></div></div></div>
<script type="module">
import {researchTabs} from '/js/tabs/registry.js';import * as feed from '/js/data/ai-recommendations.js';import {watchWorkerChanges} from '/js/core/app-updates.js';
const tabs=researchTabs.filter(t=>t.meta.navigationGroup==='alerts');let active=null,scope='universe';
for(const tab of tabs){const b=document.createElement('button');b.textContent=tab.meta.title;b.dataset.tab=tab.meta.id;b.onclick=async()=>{active?.destroy?.();active=await tab.load();if(tab.meta.id==='ai-recommendations')active.render({root:document.querySelector('#root'),scope,params:{},data:{},live:{}});};document.querySelector('#tabs').append(b);}
window.refreshRecommendations=feed.refresh;window.setFixtureScope=next=>{scope=next;active?.render({root:document.querySelector('#root'),scope,params:{},data:{},live:{}});};
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('cache-control','no-cache');
  try{
    if(['/','/index.html'].includes(url.pathname)){res.setHeader('content-type','text/html');res.end(html);return;}
    if(url.pathname==='/sdk-fixture.js'){res.setHeader('content-type','text/javascript');res.end('/* isolated SDK */');return;}
    if(url.pathname==='/data/ai-recommendations.json'){if(unavailable){res.writeHead(503).end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(capture));return;}
    if(url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,companies:[],people:[],views:[],order:[],revision:0}));return;}
    const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+sep))throw Error();let body=readFileSync(file);
    if(url.pathname==='/sw.js'){body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}before-recommendations`;');}
    if(url.pathname==='/js/tabs/registry.js'&&!upgraded)body=body.toString().replace(/^.*lazyTab\(TAB_META\['ai-recommendations'\].*\n/m,'');
    res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream');res.end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  context.on('request',r=>assert.equal(new URL(r.url()).origin,origin,'All test requests stay on the local fixture'));
  await page.goto(origin);await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
  await page.reload();await page.waitForFunction(()=>window.ready);
  assert.deepEqual(await page.locator('#tabs button').allTextContents(),['AI Alerts','All Alerts']);
  assert.ok((await page.evaluate(()=>caches.keys())).some(k=>k.includes('before-recommendations')));
  upgraded=true;await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update();});
  await page.locator('[data-tab="ai-recommendations"]').waitFor({timeout:120000});
  assert.deepEqual(await page.locator('#tabs button').allTextContents(),['AI Alerts','AI Recommendations','All Alerts']);
  await page.locator('[data-tab="ai-recommendations"]').click();
  await page.getByText('Fixture Precision',{exact:true}).waitFor();
  const headings=await page.locator('#root thead th').allTextContents();
  assert.ok(headings.some(x=>x.includes('Company'))&&headings.some(x=>x.includes('Current market price'))&&headings.some(x=>x.includes('Catalyst')));
  assert.match(await page.locator('#root').innerText(),/Close/);
  const search=page.locator('[data-table-search]');await search.fill('Fixture Precision');
  const second={...one,id:'fixture-2',isin:'INE002A01018',ticker:'RELIANCE',company:'Fixture Reliance'};
  capture={...capture,generatedAt:new Date(Date.parse(now)+1000).toISOString(),rows:[one,second],rowCount:2};
  await page.evaluate(()=>window.refreshRecommendations());
  assert.equal(await search.inputValue(),'Fixture Precision');assert.equal(await page.getByText('Fixture Reliance',{exact:true}).count(),0);
  await search.fill('');await page.getByText('Fixture Reliance',{exact:true}).waitFor();
  unavailable=true;await page.evaluate(()=>window.refreshRecommendations());assert.equal(await page.getByText('Fixture Precision',{exact:true}).count(),1);assert.match(await page.locator('[data-recommendation-status]').innerText(),/could not be confirmed/);
  await page.evaluate(()=>window.setFixtureScope('watchlist'));assert.equal(await page.getByText('Fixture Precision',{exact:true}).count(),0);
  await page.evaluate(()=>window.setFixtureScope('universe'));await page.getByText('Fixture Precision',{exact:true}).waitFor();
  await page.locator('[data-recommendation-coverage]').click();assert.match(await page.locator('#modal-content').innerText(),/Not yet established/);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Table stays inside the mobile viewport');
  mkdirSync('.cache/recommendation-models',{recursive:true});await page.screenshot({path:'.cache/recommendation-models/recommendations-mobile.png'});
  await page.reload();await page.waitForFunction(()=>window.ready);await page.locator('[data-tab="ai-recommendations"]').click();await page.getByText('Fixture Precision',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  assert.ok(!(await page.evaluate(()=>caches.keys())).some(k=>k.includes('before-recommendations')));
  console.log('PASS warm upgrade, ordered recommendation tab, three columns, new arrivals, search, scopes, failure/reload retention and mobile width');
}finally{await browser.close();await new Promise(done=>server.close(done));}
