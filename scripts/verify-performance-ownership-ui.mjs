// Real table/renderers, fixed local data. PERF_BASE_REF runs the identical experiment on an old tree.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), baseline = process.env.PERF_BASE_REF;
const sources = new Map();
const source = path => {
  if (!sources.has(path)) sources.set(path, baseline && path.startsWith('/js/')
    ? execFileSync('git', ['show', `${baseline}:public${path}`], { maxBuffer: 10 * 1024 * 1024 })
    : readFileSync(resolve(root, '.' + path)));
  return sources.get(path);
};
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/earnings-hub.js';
import * as live from '/js/core/live.js';
import { scoreTable } from '/js/ui/screener.js';
window.tab=tab;
window.ctx={root:document.querySelector('#root'),scope:'universe',params:{},data:{},live,
  setParams(params){this.params=params;tab.render(this)},setParamsQuiet(params){this.params=params}};
window.repaint=()=>tab.ownershipRepaint(ctx);
window.mountTable=()=>{
  tab.destroy();ctx.root.innerHTML='';window.work={cells:0,parsedRows:0};
  window.rows=Array.from({length:50000},(_,i)=>({id:i===0?'__top':i===1?'__bottom':String(i),title:'Record '+i,detail:'Evidence '+i,value:i}));
  window.table=scoreTable({rows,key:r=>r.id,name:r=>r.title,showAvatar:false,showRank:false,stickyHead:'600px',
    fillMode:'windowed',virtualRowHeight:48,searchable:r=>r.title+' '+r.detail,
    columns:[{label:'Evidence',get:r=>{work.cells++;return r.detail;}}],
    onExport:rows=>window.exported=rows.map(r=>r.id)});
  ctx.root.innerHTML=table.html;window.offTable=table.wire(ctx.root);
};
tab.render(ctx);
</script>`;
const alertHtml = `<!doctype html><script type="module">
import * as alerts from '/js/data/daily-alerts.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({holdings:[{ticker:'STLTECH',name:'Sterlite Technologies'},{ticker:'RELIANCE',name:'Reliance Industries'}]});
await alerts.prepareSources();
window.runQuery=async()=>{const day='2026-09-16',started=performance.now();
  window.result=await alerts.collect({scope:'portfolio',day,includeHistory:true,load:false,queryWindow:{from:day,to:day,includeUndated:false}});
  return {ms:performance.now()-started,events:result.events.length,today:result.events.filter(e=>e.day===day).length};};
window.ready=true;
</script>`;
const server = createServer((req,res) => {
  const url = new URL(req.url,'http://localhost'), path=url.pathname;
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (path === '/') { res.setHeader('content-type','text/html');res.end(html);return; }
  if (path === '/alerts') { res.setHeader('content-type','text/html');res.end(alertHtml);return; }
  if (path === '/api/earnings-calendar') {
    const date=url.searchParams.get('date')||'2026-09-16';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,date,from:date,to:date,listRequested:true,listSource:'snapshot',
      listCapturedAt:'2026-09-16T07:00:00Z',complete:true,resultComplete:true,concallComplete:true,scheduledCount:100,
      days:[{date,count:100}],rows:Array.from({length:100},(_,i)=>({eventId:'cal:'+i,scId:String(i),ticker:'T'+i,name:'Calendar company '+i,
        eventType:'Result',eventSource:'Moneycontrol',resultDate:date,exchange:'N',quarter:'Q1 FY27'}))}));return;
  }
  const asset = ({'/api/earnings':'/data/earnings-live.json','/api/concalls':'/data/concall-scans.json',
    '/api/nse-announcements':'/data/nse-announcements.json','/api/ipo-filings':'/data/ipo-filings.json'})[path]||path;
  if (!resolve(root,'.'+asset).startsWith(root+sep)) { res.writeHead(403).end();return; }
  try {
    let body=source(asset);
    if (asset === '/js/tabs/earnings-hub.js') body=body.toString()+'\nexport const ownershipRepaint=ctx=>viewOf(ctx)==="calendar"?renderCalendar(ctx):renderLatest(ctx);';
    if (asset === '/js/ui/screener.js') body=body.toString().replace('export function scoreTable(', 'function realScoreTable(')
      .replace('const rowHtmlCache = new Map();', 'const rowHtmlCache = new Map(); window.cachedRowKeys=()=>[...rowHtmlCache.keys()];')+`
      export function scoreTable(options){
        const table=realScoreTable(options),wire=table.wire;
        table.wire=root=>{window.lifetimes||={made:0,disposed:0};lifetimes.made++;
          const off=wire(root);return()=>{lifetimes.disposed++;off()}};return table;
      }`;
    res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(asset)]||'text/plain');res.end(body);
  } catch { res.writeHead(404).end('{}'); }
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.fulfill({status:503,body:'{}'}));
  await context.addInitScript(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
    Object.defineProperty(Element.prototype,'innerHTML',{...descriptor,set(value){
      if(window.work)work.parsedRows+=(String(value).match(/<tr data-row-key=/g)||[]).length;
      descriptor.set.call(this,value);
    }});
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('tr[data-row-key]').first().waitFor();
  const cdp=await context.newCDPSession(page);
  const memory=async()=>{await cdp.send('HeapProfiler.collectGarbage');return {
    heapBytes:(await cdp.send('Runtime.getHeapUsage')).usedSize,...await cdp.send('Memory.getDOMCounters')};};
  const before=await memory();
  await page.evaluate(async()=>{for(let i=0;i<100;i++){repaint();await new Promise(requestAnimationFrame)}});
  const after=await memory(),lifetime=await page.evaluate(()=>({...lifetimes,active:lifetimes.made-lifetimes.disposed}));
  console.log(JSON.stringify({experiment:'100 Earnings updates',baseline:baseline||null,lifetime,before,after}));
  if(!baseline){assert.equal(lifetime.active,1);assert.equal(lifetime.made,1);assert(after.nodes<before.nodes+1000,'no accumulating detached table generations');}
  await page.evaluate(()=>tab.destroy());
  assert.equal(await page.evaluate(()=>lifetimes.made-lifetimes.disposed),0,'exit disposes every owned table');

  await page.evaluate(()=>{ctx.params={view:'calendar',date:'2026-09-16'};tab.render(ctx)});
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Calendar company'));
  await page.waitForFunction(()=>Number(document.querySelector('[data-score-table]')?.dataset.rowsPending||0)===0);
  await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)});
  const calendarBefore=await memory();
  await page.evaluate(async()=>{for(let i=0;i<100;i++){repaint();await new Promise(requestAnimationFrame)}});
  const calendarAfter=await memory(),calendarActive=await page.evaluate(()=>lifetimes.made-lifetimes.disposed);
  console.log(JSON.stringify({experiment:'100 Calendar updates',baseline:baseline||null,active:calendarActive,before:calendarBefore,after:calendarAfter}));
  if(!baseline){assert.equal(calendarActive,1);assert(calendarAfter.nodes<calendarBefore.nodes+1000);}

  await page.evaluate(()=>mountTable());
  await page.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length>=40);
  if(!baseline) assert.deepEqual(await page.locator('tr[data-row-key]').evaluateAll(rows=>rows.slice(0,2).map(r=>r.dataset.rowKey)),['__top','__bottom']);
  const scroll=await page.evaluate(async()=>{
    const scroller=document.querySelector('[data-table-scroll]'),checks=[],before={...work};
    const started=performance.now();
    for(let i=1;i<=30;i++){
      scroller.scrollTop=i*240;scroller.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const boundary=scroller.getBoundingClientRect(),head=scroller.querySelector('thead').getBoundingClientRect();
      const boxes=[...scroller.querySelectorAll('tr[data-row-key]')].map(r=>r.getBoundingClientRect());
      checks.push({mounted:boxes.length,covered:boxes.some(r=>r.top<=head.bottom+2&&r.bottom>head.bottom)&&
        boxes.some(r=>r.top<boundary.bottom-2&&r.bottom>=boundary.bottom-2)});
    }
    return {ms:performance.now()-started,cells:work.cells-before.cells,parsedRows:work.parsedRows-before.parsedRows,checks};
  });
  assert(scroll.checks.every(c=>c.mounted<=100&&c.covered),'every observed viewport has rows from header to bottom');
  console.log(JSON.stringify({experiment:'30 scroll steps over 50000 rows',baseline:baseline||null,...scroll,checks:undefined}));
  if(!baseline){assert(scroll.cells<220,'unchanged cells are reused');assert(scroll.parsedRows<220,'unchanged rows are not reparsed');}
  if(!baseline){
    await page.setViewportSize({width:1440,height:2600});
    await page.locator('[data-table-scroll]').evaluate(node=>{node.style.maxHeight='2200px';node.style.height='2200px'});
    await page.waitForFunction(()=>{
      const scroller=document.querySelector('[data-table-scroll]'),bottom=scroller.getBoundingClientRect().bottom;
      return [...scroller.querySelectorAll('tr[data-row-key]')].some(row=>row.getBoundingClientRect().bottom>=bottom-2);
    });
    assert(await page.locator('tr[data-row-key]').count()<=100,'taller viewport remains bounded');
    await page.locator('[data-table-scroll]').evaluate(node=>{node.style.maxHeight='600px';node.style.height='600px'});
    await page.setViewportSize({width:1440,height:1000});
  }
  await page.evaluate(()=>{
    const row=document.querySelectorAll('tr[data-row-key]')[20];window.heldKey=row.dataset.rowKey;
    rows=rows.map(r=>r.id===heldKey?{...r,detail:'Corrected source evidence'}:r);table.updateData(rows);
  });
  assert.match(await page.locator('tbody').innerText(),/Corrected source evidence/);
  await page.evaluate(()=>{rows=rows.filter(r=>r.id!==heldKey);table.updateData(rows)});
  assert(!(await page.locator('tbody').innerText()).includes('Corrected source evidence'),'removed evidence disappears immediately');
  if(!baseline)assert(await page.evaluate(()=>!cachedRowKeys().includes(heldKey)), 'removed evidence leaves the markup cache immediately too');
  await page.locator('[data-table-search]').fill('Record 49999');
  await page.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length===1&&!document.querySelector('[data-table-loading]'));
  assert.match(await page.locator('tbody').innerText(),/Record 49999/);
  await page.locator('[data-table-search]').fill('');
  await page.waitForFunction(()=>!document.querySelector('[data-table-loading]'));
  await page.locator('[data-export]').click();
  assert.equal(await page.evaluate(()=>exported.length),49999,'export includes every matching retained row');
  await page.evaluate(()=>offTable());assert.deepEqual(errors,[]);
  console.log(baseline?'PASS baseline comparison completed.':'PASS bounded ownership, viewport coverage, corrections, removals, complete search/export and cleanup.');
  if(process.env.PERF_QUERY_BENCH){
    await page.goto(origin+'/alerts');await page.waitForFunction(()=>window.ready,null,{timeout:120000});
    const before=await memory(),query=await page.evaluate(()=>runQuery()),after=await memory();
    console.log(JSON.stringify({experiment:'Prepare Today from loaded source records',baseline:baseline||null,...query,before,after}));
    assert(query.today>0);if(!baseline)assert.equal(query.events,query.today);
  }
} finally {await browser.close();await new Promise(done=>server.close(done));}
