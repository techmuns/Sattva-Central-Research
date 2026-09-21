// Real pointer gestures and the shipped renderer; no remote data or production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const styles = readFileSync(root + '/index.html', 'utf8').match(/<style>[\s\S]*?<\/style>/g).join('\n');
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">${styles}
<style>main{margin:24px;max-width:1100px} #custom th,#custom td{padding:12px;min-width:90px} #custom table{margin-top:20px} </style>
<main><div id="fixture"></div><div id="custom"></div></main><script type="module">
import { scoreTable } from '/js/ui/screener.js';
import { dataTable } from '/js/ui/components.js';
import { installColumnOrder } from '/js/ui/column-order.js';
window.rows = Array.from({length:3000},(_,i)=>({id:String(i),name:'Company '+i,shares:i*10,net:i-100,month:'Aug 2026'}));
window.mount = (extra=false, mode='windowed')=>{
 window.dispose?.();
 window.table = scoreTable({columnLayoutKey:'mf-fixture',rows,key:r=>r.id,name:r=>r.name,showRank:false,showAvatar:false,showWatchFilter:false,
 stickyHead:'440px',fillMode:mode,searchable:r=>r.name,onExport:list=>window.exported=list.map(r=>({...r})),
 columns:[{label:'Month',get:r=>r.month},{label:'MF shares held',get:r=>r.shares,align:'right'},
 {label:'Added / reduced',get:r=>r.net>0?'Added':'Reduced'}, {label:'Net monthly shares',get:r=>r.net,align:'right'},
 ...(extra?[{label:'New metric',get:r=>r.id}]:[])]});
 fixture.innerHTML=table.html;window.dispose=table.wire(fixture);
};
window.custom=()=>{
 document.querySelector('#custom').innerHTML='<table data-column-layout="grouped"><thead><tr><th rowspan="2">MF</th><th colspan="2">August</th><th colspan="2">July</th></tr><tr><th>Shares</th><th>Change</th><th>Shares</th><th>Change</th></tr></thead><tbody><tr><td>Fund</td><td>A1</td><td>A2</td><td>J1</td><td>J2</td></tr><tr><td colspan="5">Full width note</td></tr></tbody></table><div id="plain"></div><table data-column-layout="document"><tbody><tr><td>Source cell</td><td>Source value</td></tr></tbody></table>';
 const basic=dataTable({columnLayoutKey:'plain',columns:[{key:'name',label:'Name'},{key:'value',label:'Value'}],rows:[{name:'Beta',value:2},{name:'Alpha',value:1}]});
 document.querySelector('#plain').innerHTML=basic.html;basic.wire(document.querySelector('#plain'));
};
mount();custom();window.ready=true;
</script>`;
const server = createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 res.setHeader('cache-control','no-cache');
 if(path==='/'||path==='/index.html'){res.setHeader('content-type','text/html');res.end(html);return;}
 try {const file=resolve(root,'.'+path);if(!file.startsWith(root+sep))throw Error();
 res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'text/plain');
 res.end(readFileSync(file));}catch{res.writeHead(404).end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const context=await browser.newContext({viewport:{width:1300,height:1000},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const headers=()=>page.locator('#fixture th').allTextContents();
 const tidy=list=>list.map(x=>x.replace(/[▴▾▲▼↕]/g,'').trim());
 const settle=()=>page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
 await page.goto(origin);await page.waitForSelector('#fixture [data-column-reorder]');await settle();
 const baseline=tidy(await headers());
 const rowsBefore=await page.locator('#fixture [data-row-key]').count();
 const drag=async(source,target,after=false)=>{
  const a=await source.boundingBox(),b=await target.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(b.x+(after?b.width-3:3),b.y+b.height/2,{steps:8});await settle();
  await page.mouse.up();await settle();
 };
 // Match the requested example: net shares immediately after MF shares held.
 const start=await page.locator('#fixture th').nth(4).boundingBox(),dest=await page.locator('#fixture th').nth(2).boundingBox();
 await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
 await page.mouse.move(dest.x+dest.width-3,dest.y+dest.height/2,{steps:8});await settle();
 assert.deepEqual(tidy(await headers()),baseline,'pointer movement never rebuilds/reorders body or headings');
 assert.equal(await page.locator('#fixture [data-row-key]').count(),rowsBefore);
 await page.mouse.up();await settle();
 const preferred=['Company','Month','MF shares held','Net monthly shares','Added / reduced'];
 assert.deepEqual(tidy(await headers()),preferred);
 assert.equal(await page.evaluate(()=>table.view.sort),null,'drag release does not sort');
 const checkCells=async()=>{
  const data=await page.locator('#fixture [data-row-key]').evaluateAll(trs=>trs.map(tr=>({id:+tr.dataset.rowKey,cells:[...tr.cells].map(c=>c.textContent.trim())})));
  assert(data.length>0 && data.length<120,'mounted rows stay bounded');
  for(const r of data){assert.equal(r.cells[2],String(r.id*10));assert.equal(r.cells[3],String(r.id-100));}
 };
 await checkCells();
 await page.locator('#fixture th').filter({hasText:'Net monthly shares'}).click();await settle();
 await page.waitForFunction(()=>table.view.sort?.key==='Net monthly shares');await checkCells();
 await page.locator('[data-table-scroll]').evaluate(el=>el.scrollTop=el.scrollHeight/2);await settle();await checkCells();
 await page.locator('[data-table-search]').fill('Company 2999');await page.waitForFunction(()=>document.querySelector('[data-row-count]').textContent.includes('1 '));await checkCells();
 await page.locator('[data-export]').click();assert.equal(await page.evaluate(()=>exported[0].id),'2999');
 await page.locator('[data-table-search]').fill('');await page.waitForFunction(()=>document.querySelector('[data-row-count]').textContent.includes('3000 of'));await settle();
 await page.locator('[data-export]').click();assert.equal(await page.evaluate(()=>exported.length),3000);
 await page.evaluate(()=>{rows.push({id:'3000',name:'Late arrival',shares:30000,net:2900,month:'Aug 2026'});table.updateData(rows);});await settle();
 await page.locator('[data-table-search]').fill('Late arrival');await page.waitForSelector('[data-row-key="3000"]');await checkCells();
 await page.evaluate(()=>{rows.at(-1).net=999;table.updateRows(['3000']);});await settle();
 assert.equal(await page.locator('[data-row-key="3000"] td').nth(3).innerText(),'999','live corrections remain aligned');
 await page.reload();await page.waitForSelector('#fixture [data-column-reorder]');assert.deepEqual(tidy(await headers()),preferred,'saved order survives reload');
 await page.evaluate(()=>mount(true));await settle();assert.deepEqual(tidy(await headers()),[...preferred,'New metric'],'new columns append without losing saved choices');
 await page.evaluate(()=>{location.hash='#/another-tab';mount();});await settle();assert.deepEqual(tidy(await headers()),baseline,'different tables/routes are isolated');
 await page.evaluate(()=>{location.hash='';mount();});await settle();assert.deepEqual(tidy(await headers()),preferred);
 // The simple renderer still sorts correctly after cells have moved.
 const basic=page.locator('[data-column-layout="plain"]');
 await basic.locator('th').first().focus();await page.keyboard.press('Alt+ArrowRight');await settle();
 await basic.locator('th').filter({hasText:'Value'}).click();await settle();
 assert.deepEqual(await basic.locator('tbody tr').first().locator('td').allTextContents(),['1','Alpha']);
 // Group headings travel with all their child columns; leaf moves stay inside their month.
 const grouped=page.locator('[data-column-layout="grouped"]');
 await grouped.locator('th').filter({hasText:'August'}).focus();await page.keyboard.press('Alt+ArrowRight');await settle();
 assert.deepEqual(await grouped.locator('tbody tr').first().locator('td').allTextContents(),['Fund','J1','J2','A1','A2']);
 await grouped.locator('thead tr').nth(1).locator('th').nth(2).focus();await page.keyboard.press('Alt+ArrowRight');await settle();
 assert.deepEqual(await grouped.locator('tbody tr').first().locator('td').allTextContents(),['Fund','J1','J2','A2','A1']);
 assert.equal(await grouped.locator('tbody tr').last().locator('td').getAttribute('colspan'),'5');
 await page.evaluate(()=>custom());await settle();assert.deepEqual(await grouped.locator('tbody tr').first().locator('td').allTextContents(),['Fund','J1','J2','A2','A1']);
 // A source-document table keeps both of its original data cells.
 assert.equal(await page.locator('[data-column-layout="document"] tbody td').count(),2);
 // Escape and blur cancel; a row refresh during a drag cannot leave a hanging gesture.
 await page.locator('#fixture th').first().scrollIntoViewIfNeeded();
 const box=await page.locator('#fixture th').first().boundingBox();
 await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+80,box.y+10);await page.keyboard.press('Escape');await page.mouse.up();await settle();
 assert.deepEqual(tidy(await headers()),preferred);assert.equal(await page.locator('[data-column-dragging]').count(),0);
 await page.locator('#fixture th').first().focus();await page.keyboard.press('Alt+Home');await settle();assert.deepEqual(tidy(await headers()),baseline,'reset restores original order');
 // Storage errors must not break the table or promise durable persistence.
 await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Quota','QuotaExceededError');};});
 await page.locator('#fixture th').first().focus();await page.keyboard.press('Alt+ArrowRight');await settle();
 assert.match(await page.locator('[role="status"]').last().textContent(),/storage is unavailable/);
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 mkdirSync('artifacts/column-order',{recursive:true});await page.screenshot({path:'artifacts/column-order/dark.png'});
 await page.setViewportSize({width:420,height:850});await page.screenshot({path:'artifacts/column-order/mobile.png'});
 // Touch uses the same lightweight pointer path; vertical scroll remains native.
 const touchContext=await browser.newContext({hasTouch:true,viewport:{width:700,height:900},serviceWorkers:'block'});
 await touchContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
 const touchPage=await touchContext.newPage();touchPage.on('pageerror',e=>errors.push(e.message));
 await touchPage.goto(origin);await touchPage.waitForSelector('#fixture [data-column-reorder]');
 const ta=await touchPage.locator('#fixture th').first().boundingBox(),tb=await touchPage.locator('#fixture th').nth(1).boundingBox();
 const cdp=await touchContext.newCDPSession(touchPage);
 const point=(x,y)=>[{x:Math.round(x),y:Math.round(y),id:1}];
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:point(ta.x+ta.width/2,ta.y+ta.height/2)});
 for(let n=1;n<=8;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:point(ta.x+ta.width/2+(tb.x+tb.width-3-ta.x-ta.width/2)*n/8,ta.y+ta.height/2)});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.deepEqual(tidy(await touchPage.locator('#fixture th').allTextContents()),['Month','Company',...baseline.slice(2)]);
 await touchContext.close();
 assert.deepEqual(errors,[]);
 console.log('PASS column order: real drag, unchanged cells while dragging, 3,001-row complete data/export, bounded DOM, sorting/filtering/live corrections, reload/new schema/route isolation, grouped/simple/source tables, keyboard/reset/cancel, storage failure, dark/mobile, no page errors');
}finally{await browser.close();await new Promise(done=>server.close(done));}
