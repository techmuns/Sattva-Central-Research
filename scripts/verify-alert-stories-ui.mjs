// Real AI Alerts, refresh/mute logic and immutable service-worker upgrade; local public fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const event = (id, headline, extra = {}) => ({ id, headline, ticker: 'ALPHA', company: 'Alpha Bank', day, time: '09:00',
  feed: 'news', feedLabel: 'Company news', importance: 'high', direction: 'neutral', namesCompany: true,
  url: `https://${id}.example/merger`, detail: '', sourceRecord: { publisher: id.toUpperCase() }, keywords: ['Merger'],
  attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed' }, ...extra });
const initial = [event('et', 'Alpha Bank proposes merger with Beta Bank'), event('reuters', 'Alpha Bank plans merger with Beta Bank')];
let upgraded = false, apiCalls = 0, debugPage;
// An already-cached pre-grouping reader, with the real immutable-cache/update lifecycle.
const oldFiles = new Map([['/js/data/alert-stories.js', `export const storyGrouping={project:e=>e,revision:()=>0,
 status:()=>({total:0}),onChange:()=>()=>{},load:async()=>{},review:async()=>{}};`]]);
const fixture = `const listeners=new Set(); export const onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
window.changed=()=>listeners.forEach(fn=>fn());
export {currentDay as today} from '../ui/ai-alert-utils.js';
import {currentDay} from '../ui/ai-alert-utils.js';
export async function readCachedAlertWindow(){return null;}
export async function collect({scope,onPartial}) { const r={scope,day:currentDay(),events:window.fixtureEvents,feeds:[{id:'news',status:'ok',reachesToday:true}],pending:0};onPartial?.(r);return r; }`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body style="padding:24px;background:#f6f4fb"><main id="root" class="mx-auto max-w-7xl"></main><script>window.fixtureEvents=${JSON.stringify(initial)};</script><script type="module">
import * as tab from '/js/tabs/ai-alerts.js';import * as coverage from '/js/data/coverage.js';import {watchWorkerChanges} from '/js/core/app-updates.js';
coverage.prime({holdings:[{ticker:'ALPHA',name:'Alpha Bank'}]});
window.show=()=>tab.render({root:document.querySelector('#root'),scope:'universe',params:{}});window.show();
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script></body></html>`;
const classify = reports => {
  const groups = new Map();
  for (const r of reports) {
    const change = /RBI approves/.test(r.headline) ? 'approval' : /cancels/.test(r.headline) ? 'cancellation' : 'new';
    const knownCopy = change === 'new' && reports.find(x => x.known && /proposes|plans/.test(x.headline));
    const key = r.known?.development || knownCopy?.known?.development || change;
    if (!groups.has(key)) groups.set(key, { reports: [], change });
    groups.get(key).reports.push(r.id);
  }
  return [{ developments: [...groups.values()] }];
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (pathname === '/' || pathname === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (pathname === '/api/alert-stories') {
      let text='';for await(const part of req)text+=part;apiCalls++;
      res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,stories:classify(JSON.parse(text).reports)}));return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (pathname.startsWith('/api/')) { res.setHeader('content-type','application/json'); res.end('{}'); return; }
    if (pathname === '/sdk-fixture.js') { res.end('/* no external SDK */'); return; }
    if (pathname === '/js/data/daily-alerts.js') { res.setHeader('content-type','text/javascript');res.end(fixture);return; }
    const file=resolve(root, '.'+pathname);if(!file.startsWith(root+sep))throw Error('path');
    let body=!upgraded&&oldFiles.has(pathname)?oldFiles.get(pathname):readFileSync(file);
    if(pathname==='/sw.js') {
      body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js',self.location).href;");
      if(!upgraded)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}before-story-grouping`;');
    }
    res.setHeader('content-type', {'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream');res.end(body);
  } catch {res.writeHead(404);res.end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  const page=debugPage=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.ready&&navigator.serviceWorker.controller);
  await page.reload();await page.waitForFunction(()=>window.ready);
  const card=page.locator('[data-ai-card]');await card.waitFor();
  assert.equal(await card.locator('[data-ai-evidence] > li').count(),2);
  const before=await page.evaluate(()=>caches.keys());assert(before.some(k=>k.includes('before-story-grouping')));
  upgraded=true;await page.evaluate(async()=>await(await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(()=>document.querySelectorAll('[data-ai-story-source]').length===2&&document.querySelectorAll('[data-ai-evidence] > li').length===1);
  assert.equal(await card.locator('[data-ai-story-source]').count(),2);
  assert(!(await page.evaluate(()=>caches.keys())).some(k=>k.includes('before-story-grouping')));
  const initialScore=await card.getAttribute('data-score');
  await card.locator('[data-ai-mute]').click();assert.equal(await card.count(),0);
  await page.evaluate(e=>{window.fixtureEvents.push(e);window.changed();},event('bse','Alpha Bank plans merger with Beta Bank',{time:'10:00'}));
  // Wait for the NEW input's review; the previous paint can still say grouped before recollection.
  await page.waitForFunction(async()=>{const {storyGrouping}=await import('/js/data/alert-stories.js');const state=storyGrouping.status(window.fixtureEvents);return state.reviewed===3&&!state.checking;});
  await page.waitForFunction(()=>document.querySelector('[data-ai-story-status]')?.textContent==='Repeated coverage grouped');
  await card.waitFor({state:'detached'});
  assert.equal(await card.count(),0,'more coverage remains archived');
  await page.evaluate(e=>{window.fixtureEvents.push(e);window.changed();},event('rbi','RBI approves Alpha Bank merger with Beta Bank',{time:'11:00',importance:'low'}));
  await card.locator('[data-ai-updated]').waitFor();
  assert.match(await card.locator('[data-ai-insight]').innerText(),/RBI approves/);
  assert.equal(await card.locator('[data-ai-evidence] > li').count(),1);
  await card.locator('[data-ai-story-history] summary').click();
  assert.match(await card.locator('[data-ai-story-history]').innerText(),/proposes|plans/);
  assert.equal(await card.locator('[data-ai-story-source]').count(),4,'new and earlier source links are accessible');
  const calls=apiCalls;await page.evaluate(()=>window.changed());await page.waitForTimeout(700);assert.equal(apiCalls,calls,'unchanged refresh does not request the model');
  assert(await card.locator('[data-ai-story-history]').getAttribute('open')!==null,'background paint keeps history open');
  await page.locator('[data-ai-search]').fill('proposes');assert.equal(await card.count(),1,'older evidence stays searchable');
  await page.locator('[data-ai-search]').fill('');
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile source links fit');
  await page.setViewportSize({width:1280,height:1000});
  mkdirSync('/tmp/sattva-story-review',{recursive:true});await page.screenshot({path:'/tmp/sattva-story-review/ai-alerts.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(`PASS: warm session upgrade, one news item with sources, archived copies stay quiet, material approval resurfaces, accessible history/search/mobile, zero page errors (${apiCalls} semantic fixture checks, original score ${initialScore}).`);
} catch (error) { console.log('UI DEBUG', apiCalls, await debugPage.locator('body').innerText()); throw error; } finally {await browser.close();await new Promise(done=>server.close(done));}
