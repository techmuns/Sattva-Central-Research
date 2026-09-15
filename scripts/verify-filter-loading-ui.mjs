#!/usr/bin/env node
// Local fixtures only: delayed rendering, rapid filters, live arrivals and truthful empty states.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body style="padding:24px"><main id="fixture"></main><script type="module">
import { scoreTable } from '/js/ui/screener.js';
window.records = Array.from({length:3000}, (_,i) => ({id:String(i), name:'Record '+i, group:i%2?'old':'today'}));
window.filters = () => [{label:'Date range', value:'today', options:[{value:'all',label:'All history'},
  {value:'today',label:'Today'},{value:'old',label:'Older records'},{value:'none',label:'No matches'}], match:(row,value)=>row.group===value}];
window.mount = ({small=false,loading=false,empty=false,fillMode='windowed'}={}) => {
  window.dispose?.();
  window.table = scoreTable({rows:empty?[]:small?records.slice(0,8):records, key:r=>r.id, name:r=>r.name,
    filters:filters(), loading, fillMode, showAvatar:false, showRank:false, showWatchFilter:false,
    stickyHead:'450px', searchable:r=>r.name, columns:[{label:'Period',get:r=>r.group}],
    onExport:rows=>window.exported=rows.map(r=>r.id)});
  fixture.innerHTML=table.html; window.dispose=table.wire(fixture);
};
window.holdFrames = () => {
  const native = window.requestAnimationFrame;
  const callbacks=[];
  window.requestAnimationFrame=fn => {callbacks.push(fn);return callbacks.length;};
  window.releaseFrames=()=>{window.requestAnimationFrame=native;for(const fn of callbacks)native(fn);};
};
window.showMarket = async () => {
  window.dispose?.();
  const market = await import('/js/tabs/market-news-view.js');
  market.render({root:fixture,scope:'universe',live:{register(){},start(){},stop(){}}});
  window.leaveMarket = () => {market.destroy();fixture.innerHTML='<p>Another tab</p>';};
};
mount();
</script></body></html>`;
const server = createServer((req,res) => {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(url.pathname==='/data/market-news.json'){
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({capturedAt:new Date().toISOString(),sources:[],archivedCount:0,archive:[],
      articles:Array.from({length:3000},(_,i)=>({id:'story-'+i,title:'Market fixture '+i,publisher:'Fixture publisher',
        publishedAt:new Date(Date.now()-(i%2?7:0)*86400000).toISOString(),url:'https://example.test/story-'+i}))}));return;
  }
  if(url.pathname==='/data/twitter-posts.json'){
    res.setHeader('content-type','application/json');res.end(JSON.stringify({capturedAt:new Date().toISOString(),posts:[],byHandle:{},failed:{}}));return;
  }
  if(url.pathname.startsWith('/api/')){res.writeHead(503);res.end('{}');return;}
  const path=resolve(root,'.'+url.pathname);
  if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  try {res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream');res.end(readFileSync(path));}
  catch {res.writeHead(404);res.end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const page=await browser.newPage({viewport:{width:1280,height:850}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.fulfill({status:503,body:'{}'}));
const settled=()=>page.waitForFunction(()=>!document.querySelector('[data-table-loading]'));
try {
  await page.goto(origin);await page.locator('[data-score-table]').waitFor();
  const period=page.getByRole('combobox',{name:'Date range',exact:true});
  const before=await page.locator('[data-table-scroll]').boundingBox();
  await page.evaluate(()=>holdFrames());
  await period.selectOption('old');
  assert.equal(await period.inputValue(),'old');
  assert(await page.locator('[data-table-loading]').isVisible(),'pending selection shows empty pulsing rows');
  assert(await page.locator('[data-table-scroll]').evaluate(el=>el.inert),'old rows cannot be opened while the selected interval is pending');
  assert(await page.locator('[data-export]').isDisabled(),'export cannot use the previous selection');
  assert.equal(await page.locator('[data-table-scroll]').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('[data-table-loading] [role="status"]').getAttribute('aria-label'),'Loading results');
  assert.equal((await page.locator('[data-table-scroll]').boundingBox()).height,before.height,'placeholder keeps the result area steady');
  const line=page.locator('.loading-grid-line').first();
  assert.equal(await line.evaluate(el=>getComputedStyle(el).animationName),'loading-pulse');
  const lightColor=await line.evaluate(el=>getComputedStyle(el).backgroundColor);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.notEqual(await line.evaluate(el=>getComputedStyle(el).backgroundColor),lightColor,'placeholder follows the dark theme tokens');
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await line.evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  if(process.env.FILTER_LOADING_SCREENSHOT)await page.screenshot({path:process.env.FILTER_LOADING_SCREENSHOT});
  await period.selectOption('today');
  await period.selectOption('all');
  await page.evaluate(()=>{records.push({id:'new-live',name:'New live record',group:'today'});table.updateData(records,filters());});
  assert.equal(await period.inputValue(),'all');
  assert.equal(await page.evaluate(()=>table.view.filters[0]),'all','All history stays selected through new filter definitions');
  await page.evaluate(()=>releaseFrames());await settled();
  assert.match(await page.locator('[data-row-count]').innerText(),/^3001 of 3001/);
  await page.locator('[data-export]').click();
  assert.equal(await page.evaluate(()=>exported.length),3001,'latest selection includes arrivals while filtering');
  await page.evaluate(()=>holdFrames());
  await period.selectOption('all');
  await page.evaluate(()=>{records=records.filter(row=>row.id!=='0');table.updateData(records);});
  assert.equal(await page.locator('tr[data-row-key="0"]').count(),0,'a live removal clears the old DOM immediately during a pending filter');
  await page.evaluate(()=>releaseFrames());await settled();
  assert.equal(await period.inputValue(),'all');
  await period.selectOption('none');await settled();
  assert.match(await page.locator('tbody').innerText(),/No companies match/,'completed empty results stop loading');
  await page.evaluate(()=>mount({empty:true,loading:true}));
  assert(await page.locator('[data-table-loading]').isVisible(),'unfinished cold reads use placeholders');
  await page.evaluate(()=>table.updateData([],undefined,{loading:false}));await settled();
  assert.match(await page.locator('tbody').innerText(),/No companies match/,'failed or completed reads cannot leave an endless placeholder');
  await page.evaluate(()=>mount({loading:true}));await settled();
  assert(await page.locator('tr[data-row-key]').count()>0,'background refresh preserves usable matching rows');
  await page.evaluate(()=>mount({small:true}));
  await period.selectOption('old');
  assert.equal(await page.locator('[data-table-loading]').count(),0,'small local filters remain immediate');
  assert.equal(await page.locator('tr[data-row-key]').count(),4);
  await page.evaluate(()=>{mount();holdFrames();});
  await period.selectOption('old');
  await page.evaluate(()=>{dispose();fixture.innerHTML='<p>Another tab</p>';releaseFrames();});
  await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(resolve=>setTimeout(resolve,20));});
  assert.equal(await page.locator('#fixture').innerText(),'Another tab','a superseded table cannot paint over the next tab');
  for(const width of [390,1024]){
    await page.setViewportSize({width,height:844});
    await page.evaluate(()=>mount({empty:true,loading:true}));
    assert(await page.locator('[data-table-loading]').isVisible());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'placeholders fit the viewport');
  }
  await page.evaluate(()=>showMarket());
  await page.waitForFunction(()=>document.querySelector('[data-news-count]')?.textContent.includes('1,500'));
  const newsPeriod=page.getByRole('combobox',{name:'News period',exact:true});
  await newsPeriod.focus();
  await page.evaluate(()=>holdFrames());
  await newsPeriod.selectOption('3');
  assert(await page.locator('[data-table-loading]').isVisible(),'large market-news filters use the same placeholders');
  const mask=await page.locator('[data-table-loading]').boundingBox();
  const newsArea=await page.locator('[data-news-scroll]').boundingBox();
  assert(Math.abs(mask.height-newsArea.height)<=1,'the placeholder covers results without covering footer controls');
  assert(await page.locator('[data-news-export]').isDisabled());
  await newsPeriod.selectOption('30');
  await page.evaluate(()=>releaseFrames());await settled();
  assert.equal(await newsPeriod.inputValue(),'30','market-news rapid changes retain the latest interval');
  assert.match(await page.locator('[data-news-count]').innerText(),/^3,000 of 3,000/);
  assert(await newsPeriod.evaluate(el=>el===document.activeElement),'market-news dropdown keeps keyboard focus');
  await page.evaluate(()=>holdFrames());
  await newsPeriod.selectOption('7');
  await page.evaluate(()=>{leaveMarket();releaseFrames();});
  await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(resolve=>setTimeout(resolve,20));});
  assert.equal(await page.locator('#fixture').innerText(),'Another tab','pending market-news filters cannot overwrite navigation');
  assert.deepEqual(errors,[]);
  console.log('PASS: pulsing result placeholders, stable geometry, newest filter wins, retained All history, complete exports, reduced motion, mobile, empty/failure settlement and navigation cleanup.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
