#!/usr/bin/env node
// Real card/ranking/virtualizer over local captured-history fixtures; no production or paid calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body style="padding:16px"><main id="root"></main><script type="module">
import * as coverage from '/js/data/coverage.js';
import * as tab from '/js/tabs/ai-alerts.js';
import * as refresh from '/js/core/refresh.js';
coverage.prime({holdings:[{ticker:'KPIL',name:'Kalpataru Projects International'},{ticker:'OTHER',name:'Other Company'}]});
const event=(id,day,time,ticker='KPIL')=>({id,ticker,company:ticker==='KPIL'?'Kalpataru Projects International':'Other Company',feed:'earnings',feedLabel:'Earnings',
 day,time,headline:'Quarterly result report '+id,importance:'high',direction:'negative',aiEligible:true,url:'https://source.example/'+id,tab:'earnings-hub'});
window.events=Array.from({length:80},(_,i)=>event('recent-'+i,'2026-09-28',String(10+Math.floor(i/60)).padStart(2,'0')+':'+String(i%60).padStart(2,'0')));
window.events.push(event('other-recent','2026-09-28','09:00','OTHER'));
window.timelineArchive=Array.from({length:5000},(_,i)=>event('old-'+String(i).padStart(4,'0'),'2026-08-'+String(1+Math.floor(i/180)).padStart(2,'0'),String(Math.floor(i%180/60)+10).padStart(2,'0')+':'+String(i%60).padStart(2,'0')));
window.timelineArchive.push(event('other-old','2026-08-01','09:00','OTHER'));
window.historyReads=0;window.memoryReads=0;window.failHistory=false;window.holdHistory=false;window.alive=true;
window.refreshAlerts=()=>refresh.refreshAll();window.tab=tab;
window.heartbeat=0;setInterval(()=>window.heartbeat++,10);
window.render=()=>tab.render({root:document.querySelector('#root'),scope:'universe',params:{}});
// Establish the locked fixture before timeline interactions. A late auth-required
// correctly destroys private timeline state, which otherwise races this scroll test.
await (await import('/js/research/portfolio-bridge.js')).connectPortfolio();
window.render();
</script></body></html>`;
const feedModule = `
export const onChange=()=>()=>{};
export const today=()=> '2026-09-28';
export async function readCachedAlertWindow(){return null;}
export async function collect({scope,pool,load=true}){
 if(!pool){if(load)window.historyReads++;else window.memoryReads++;if(window.holdHistory)await new Promise(done=>window.releaseHistory=done);}
 const failed=!pool&&window.failHistory;
 return {scope,day:today(),events:pool?window.events:failed?[]:[...window.events,...window.timelineArchive],
 feeds:[{id:'earnings',status:failed?'failed':'ok',reachesToday:!failed}],pending:0};
}`;
let notePosts = 0;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control','no-store');
  if(pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(pathname==='/api/alert-notes')notePosts++;
  if(pathname==='/js/data/daily-alerts.js'){res.setHeader('content-type','text/javascript');res.end(feedModule);return;}
  if(pathname==='/js/data/capture-watchdog.js'){res.setHeader('content-type','text/javascript');res.end('export const onCaptureLanded=()=>()=>{};');return;}
  if(pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end('{}');return;}
  const file=resolve(root,'.'+pathname);if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}
  catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
await page.context().route('**/*',route=>route.request().url()==='https://sattva-family.pages.dev/research-bridge' ? route.fulfill({contentType:'text/html',body:`<script>addEventListener('message',e=>{if(e.data.channel==='sattva-portfolio-v1')setTimeout(()=>parent.postMessage({channel:e.data.channel,id:e.data.id,type:'auth-required'},'*'),100)});</script>`}) : new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'{}'}));
const card=page.locator('[data-ai-card][data-ticker="KPIL"]'), timeline=card.locator('[data-ai-timeline]'), rows=card.locator('[data-ai-timeline-row]');
const settled=()=>page.waitForFunction(()=>document.querySelector('[data-ticker="KPIL"] [data-ai-timeline]')?.getAttribute('aria-busy')==='false' && document.querySelector('[data-ticker="KPIL"] [data-ai-timeline-row]'));
const bottom=()=>timeline.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
const top=()=>card.locator('[data-ai-timeline-latest]').click();
const anchor=()=>timeline.evaluate(node=>{const y=node.getBoundingClientRect().top;const row=[...node.querySelectorAll('[data-ai-timeline-row]')].find(row=>row.getBoundingClientRect().bottom>y+1);return {id:row.dataset.rowKey,offset:row.getBoundingClientRect().top-y};});
try{
 await page.clock.install({time:'2026-09-28T08:00:00Z'});
 await page.goto(origin);await settled();
 assert.equal(await page.evaluate(()=>window.historyReads),0,'opening a card does not read full history');
 assert((await rows.count())<=20);assert.equal(await rows.first().getAttribute('data-row-key'),'recent-79');
 assert((await timeline.boundingBox()).height<=288);
 await card.locator('[data-ai-timeline-scroll-cue]').waitFor();
 assert(await page.locator('[data-ticker="OTHER"] [data-ai-timeline-scroll-cue]').isHidden(),'a fitting timeline must not suggest scrolling');
 await timeline.focus();await page.keyboard.press('PageDown');
 await page.waitForFunction(()=>document.querySelector('[data-ticker="KPIL"] [data-ai-timeline]').scrollTop>8);
 assert.equal(await page.evaluate(()=>window.historyReads),0,'the scroll cue and keyboard movement do not eagerly read the archive');
 await top();
 const headline=await card.locator('[data-ai-lead-link]').textContent();
 await page.evaluate(()=>{window.holdHistory=true;window.failHistory=true;});await bottom();
 await page.waitForFunction(()=>window.historyReads===1);assert((await rows.count())>0,'pending history leaves current evidence usable');
 const beats=await page.evaluate(()=>window.heartbeat);await page.waitForTimeout(150);assert((await page.evaluate(()=>window.heartbeat))>beats+2);
 await top();assert.equal(await timeline.evaluate(n=>n.scrollTop),0,'Latest works while archive read waits');
 await page.evaluate(()=>{window.holdHistory=false;window.releaseHistory();});await settled();
 assert.match(await card.locator('[data-ai-timeline-status]').textContent(),/unavailable/);
 await bottom();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.historyReads),1,'failure does not loop on scroll');
 await page.evaluate(()=>window.failHistory=false);await card.locator('[data-ai-timeline-older]').click();await settled();
 assert.equal(await page.evaluate(()=>window.historyReads),2);
 assert.equal(await card.locator('[data-ai-lead-link]').textContent(),headline,'old evidence cannot change the ranked headline');
 await bottom();await page.waitForTimeout(150);await bottom();
 await rows.locator('[data-ai-evidence-link][href="https://source.example/old-0000"]').waitFor();
 assert((await rows.count())<=20,'five thousand records keep a bounded DOM');
 assert(!(await card.textContent()).includes('other-old'),'company history cannot leak across cards');
 assert.equal(await rows.last().getAttribute('data-row-key'),'old-0000','oldest retained event is reachable');
 await page.waitForFunction(()=>document.querySelector('[data-ticker="KPIL"] [data-ai-timeline-scroll-cue]').hidden);
 await card.locator('[data-row-key="old-0000"] [data-bookmark-key]').click();
 await page.waitForFunction(async()=> (await import('/js/core/bookmarks.js')).all().some(entry=>entry.title==='Quarterly result report old-0000'));
 // Another card shares the one completed history read.
 await page.locator('[data-ticker="OTHER"] [data-ai-timeline-older]').click();
 await page.locator('[data-ticker="OTHER"] [data-row-key="other-old"]').waitFor();
 assert.equal(await page.evaluate(()=>window.historyReads),2);
 // A new current event appears without pushing a reader away from the older row.
 await timeline.evaluate(node=>{node.scrollTop=4000;});await page.waitForTimeout(150);
 const held=await anchor();
 await page.evaluate(async()=>{window.events=[{...window.events[0],id:'new-latest',headline:'New quarterly result',time:'16:00'},...window.events];await window.refreshAlerts();});
 await settled();await page.waitForTimeout(150);const after=await anchor();
 assert.equal(after.id,held.id);assert(Math.abs(after.offset-held.offset)<3,JSON.stringify({held,after}));
 assert.equal(await card.locator('[data-ai-timeline-latest]').textContent(),'New alerts ↑');await top();
 await page.waitForFunction(()=>document.querySelector('[data-ticker="KPIL"] [data-ai-timeline-row]')?.dataset.rowKey==='new-latest');
 await page.evaluate(async()=>{window.events=[{...window.events[0],id:'newest-at-top',headline:'Latest quarterly result',time:'17:00'},...window.events];await window.refreshAlerts();});await settled();
 assert.equal(await rows.first().getAttribute('data-row-key'),'newest-at-top');assert.equal(await timeline.evaluate(n=>n.scrollTop),0);
 // Failed revalidation retains public history and reports that coverage is incomplete.
 await page.evaluate(async()=>{window.failHistory=true;await window.refreshAlerts();});await settled();
 await page.waitForFunction(()=>document.querySelector('[data-ticker="KPIL"] [data-ai-timeline-status]')?.textContent.includes('unavailable'));
 await bottom();await page.waitForTimeout(100);await bottom();await rows.locator('[data-ai-evidence-link][href="https://source.example/old-0000"]').waitFor();
 await top();
 for(const width of [1280,390]){await page.setViewportSize({width,height:1000});for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert(await timeline.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  assert(await card.locator('[data-ai-timeline-scroll-cue]').isVisible(),'overflow is discoverable after theme and viewport changes');
  if(process.env.TIMELINE_SCREENSHOT)await page.screenshot({path:process.env.TIMELINE_SCREENSHOT+'-'+width+'-'+theme+'.png',fullPage:true,animations:'disabled'});
 }}
 // A history completion after leaving cannot repopulate the retired view or start model work.
 await page.evaluate(()=>{window.tab.destroy();document.querySelector('#root').replaceChildren();window.holdHistory=true;window.failHistory=false;window.render();});await settled();
 await bottom();await page.waitForFunction(()=>window.historyReads===3);
 await page.evaluate(()=>{window.tab.destroy();document.querySelector('#root').replaceChildren();window.holdHistory=false;window.releaseHistory();});await page.waitForTimeout(150);
 assert.equal(await page.locator('[data-ai-card]').count(),0);assert.equal(notePosts,0,'scrolling never generates an AI summary');assert.deepEqual(errors,[]);
 console.log('PASS 5,000-row scrollable card history: lazy/shared reads, bounded DOM, responsive pending reads, latest updates, preserved reading anchor, source links, partial retention/retry, cleanup, mobile/themes, and zero model calls.');
}catch(error){console.error('UI failure',errors,(await page.locator('#root').textContent()).slice(-3500));throw error;}finally{await browser.close();await new Promise(done=>server.close(done));}
