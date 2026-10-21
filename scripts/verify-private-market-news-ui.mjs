import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { emptyCapture } from './lib/private-market-news.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const sourceUrl='https://inc42.com/buzz/fixture-funding-this-week/';
let capture=emptyCapture(), unavailable=false, reads=0;
capture.generatedAt=new Date().toISOString();capture.sourceCheckedAt=capture.generatedAt;capture.archive.complete=true;
capture.articles=[{url:sourceUrl,title:'Fixture funding this week',status:'ok',publishedAt:'2026-10-17T09:00:00+05:30',notes:['* Mix of equity and debt']}];
const row=(i)=>({id:i.toString(16).padStart(24,'0'),company:`Fixture Company ${i}`,date:i===499?'01 Jan 2020':'16 Oct 2026',dateISO:i===499?'2020-01-01':'2026-10-16',sector:i%2?'AI':'Health Tech',subsector:'Software',businessModel:'B2B',amount:'$11.4 Mn *',round:'Series A',investors:i===499?'Older History Investor':'Fixture Investor',leadInvestor:'Fixture Investor',sourceFields:{Date:'16 Oct 2026',Name:`Fixture Company ${i}`},sourceUrl:i===499?'https://inc42.com/buzz/older-funding-this-week/':sourceUrl,sourceTitle:'Fixture funding this week',publishedAt:i===499?'2020-01-04T09:00:00+05:30':'2026-10-17T09:00:00+05:30',firstSeenAt:capture.generatedAt,updatedAt:capture.generatedAt,revisions:[]});
capture.deals=Array.from({length:500},(_,i)=>row(i));
const index=readFileSync('public/index.html','utf8');
const overlays=index.slice(index.indexOf('    <div id="drill-overlay"'),index.indexOf('    <!--',index.indexOf('id="workspace-content"')));
const html=`<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><main id="root"></main>${overlays}<script type="module">import * as tab from '/js/tabs/private-market-news.js';import * as feed from '/js/data/private-market-news.js';window.fixture={tab,feed};tab.render({root:document.querySelector('#root'),scope:'watchlist'});</script>`;
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(pathname==='/data/private-market-news.json'){reads++;res.setHeader('content-type','application/json');if(unavailable){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify(capture));return;}
  const path=resolve(root,`.${pathname}`);if(!path.startsWith(root+sep)){res.writeHead(404);res.end();return;}
  try{res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'text/plain');res.end(readFileSync(path));}catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await page.clock.install({time:new Date(capture.generatedAt)});
  await page.goto(origin);await page.getByRole('heading',{name:'Private Market News',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-table-count]')?.textContent.includes('499')||document.querySelector('main')?.textContent.includes('499 of 500'));
  assert.equal(await page.locator('[data-watch-toggle]').count(),0);
  assert(await page.locator('tbody tr[data-row-key]').count()<100,'Shared table bounds mounted rows');
  const period=page.getByRole('combobox',{name:'Funding period',exact:true});await period.selectOption('all');
  const search=page.getByPlaceholder('Search company, investor, sector or round...');await search.fill('Older History Investor');
  await page.getByText('Fixture Company 499',{exact:true}).waitFor();
  assert.equal(await page.locator('tbody tr[data-row-key]').count(),1,'Search reaches retained history beyond mounted rows');
  await search.fill('');await period.selectOption('latest');
  await page.getByRole('combobox',{name:'Sectors',exact:true}).selectOption('AI');await search.fill('Fixture Investor');
  capture={...capture,generatedAt:new Date(Date.parse(capture.generatedAt)+60000).toISOString(),deals:[...capture.deals,{...row(500),sector:'AI'}]};
  await page.clock.fastForward(5*60000);await page.waitForFunction(()=>window.fixture.feed.rows().length===501);
  assert.equal(await search.inputValue(),'Fixture Investor');assert.equal(await page.getByRole('combobox',{name:'Sectors',exact:true}).inputValue(),'AI');
  assert.equal(await search.evaluate(el=>document.activeElement===el),true,'Incoming captures retain active search focus');
  unavailable=true;await page.clock.fastForward(5*60000);await page.waitForFunction(()=>!!window.fixture.feed.meta().readError);assert.equal(await search.inputValue(),'Fixture Investor');assert(await page.locator('tbody tr[data-row-key]').count()>0);
  await page.getByRole('button',{name:'Coverage & source notes'}).click();assert((await page.locator('#modal-content').textContent()).includes('Saved rows remain readable'));
  await page.keyboard.press('Escape');
  await page.reload();await page.waitForFunction(()=>window.fixture?.feed.rows().length===501 && !!window.fixture.feed.meta().readError);
  assert(await page.locator('tbody tr[data-row-key]').count()>0,'IndexedDB preserves captured history across an offline reload');
  unavailable=false;await page.evaluate(()=>window.fixture.feed.refresh());
  await page.getByPlaceholder('Search company, investor, sector or round...').fill('Fixture Investor');
  await page.evaluate(()=>{window.fixture.tab.destroy();window.fixture.tab.render({root:document.querySelector('#root'),scope:'portfolio'});});
  await page.getByRole('heading',{name:'Private Market News',exact:true}).waitFor();assert.equal(await search.inputValue(),'Fixture Investor');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Wide funding columns stay inside their scroller');
  mkdirSync('.cache/private-market',{recursive:true});await page.screenshot({path:'.cache/private-market/reader-light.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'.cache/private-market/reader-dark.png',fullPage:true});
  assert.deepEqual(errors,[]);assert(reads>=4);console.log('PASS private funding browser: lazy read, empty Watchlist, bounded rows, complete-history search, filters/focus across arrivals and failures, source coverage, reopen and contained table.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
