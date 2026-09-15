#!/usr/bin/env node
// Real table, cache, projections and lifecycle; only source completion order is controlled.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head><body><main id="root"></main><div id="table-test"></div><script type="module">
import * as alerts from '/js/data/daily-alerts.js';
import * as tab from '/js/tabs/daily-alerts.js';
import * as coverage from '/js/data/coverage.js';
import * as records from '/js/data/alert-records.js';
window.alerts=alerts; window.tab=tab; window.coverage=coverage; window.records=records;
coverage.prime({holdings:[{ticker:'AAA',name:'Alpha Ltd'}]});
window.calls=[];
window.event=(id,extra={})=>({id,day:alerts.today(),feed:'nse-filings',ticker:'AAA',company:'Alpha Ltd',headline:id,
  detail:'Original evidence',direction:'neutral',importance:'low',severity:'update',sourceRecord:{original:id},...extra});
window.make=(groups={},states={})=>({day:alerts.today(),sourceFeeds:alerts.FEEDS.map(feed=>({...feed,events:groups[feed.id]||[],
  status:states[feed.id]||'pending',asOf:alerts.today()+'T07:00:00Z',reachesToday:true}))});
window.show=(scope='portfolio')=>tab.render({root:document.querySelector('#root'),scope,params:{},data:{}});
const cached=alerts.adoptAllAlertsReport(window.make({'nse-filings':[window.event('Saved current-day alert'),
  window.event('Older history',{day:'2021-01-01'}),window.event('Future schedule',{day:'2028-01-01',kind:'scheduled'}),
  window.event('Unresolved undated',{day:null,ticker:null})]},{'nse-filings':'ok'}),null,{scope:'universe',holdings:[],day:alerts.today()});
await alerts.saveAllAlerts(cached);
window.ready=true;
</script></body></html>`;
const wrappers = `
export async function readCachedAllAlerts(options) {
  window.cacheReads=(window.cacheReads||0)+1;
  await new Promise(resolve => window.releaseCache=resolve);
  return realReadCachedAllAlerts(options);
}
export async function collect(options) {
  const make=(groups={},states={})=>adoptAllAlertsReport(window.make(groups,states),null,options);
  options.onPartial?.(make());
  return new Promise(resolve=>window.calls.push({options,
    partial:(groups,states)=>options.onPartial?.(make(groups,states)),
    complete:(groups,states)=>resolve(make(groups,states))}));
}
`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('Invalid path');
    let body = readFileSync(file);
    if (path === '/js/data/daily-alerts.js') body = body.toString()
      .replace('export async function readCachedAllAlerts(', 'async function realReadCachedAllAlerts(')
      .replace('export async function collect(', 'async function realCollect(') + wrappers;
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
const contains = text => page.waitForFunction(text => document.querySelector('#root tbody')?.textContent.includes(text), text);
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => { window.show(); window.show(); });
  await page.waitForFunction(() => window.calls.length === 2 && window.releaseCache);
  assert.equal(await page.evaluate(() => window.cacheReads), 1, 'a second render reuses the pending disk read after the empty seed');
  assert.equal(await page.locator('#root tbody tr[data-row-key]').count(), 0);
  await page.evaluate(() => window.releaseCache());
  await contains('Saved current-day alert');
  assert.equal(await page.locator('[data-arrival-badge]').count(), 0, 'saved records are baseline history');
  await page.evaluate(() => window.calls.at(-1).partial({ announcements: [window.event('Fast source alert', {feed:'announcements'})] }, {announcements:'ok'}));
  await contains('Fast source alert');
  assert((await page.locator('#root tbody').innerText()).includes('Saved current-day alert'), 'one ready source does not erase another source waiting to answer');
  await page.evaluate(() => window.calls.at(-1).complete({ announcements:[window.event('Fast source alert',{feed:'announcements'})] },
    Object.fromEntries(window.alerts.FEEDS.map(f=>[f.id,f.id==='nse-filings'?'failed':'ok']))));
  await contains('Saved current-day alert');
  console.log('PASS disk restores after an empty seed; fast sources publish independently; failed sources retain saved evidence.');

  // Invalidate while an old collection still holds callbacks, with the scope label unchanged.
  await page.evaluate(() => { window.show(); window.oldCall=window.calls.at(-1); window.coverage.useFamilyBook([{ticker:'BBB',name:'Beta Ltd'}]); });
  await page.waitForFunction(() => !document.querySelector('#root tbody')?.textContent.includes('Saved current-day alert'));
  await page.evaluate(() => window.oldCall.complete({'nse-filings':[window.event('Stale Alpha response')]},{'nse-filings':'ok'}));
  await page.evaluate(() => window.calls.at(-1).partial({'nse-filings':[window.event('Beta current alert',{ticker:'BBB',company:'Beta Ltd'})]}, {'nse-filings':'ok'}));
  await contains('Beta current alert');
  assert(!(await page.locator('#root tbody').innerText()).includes('Stale Alpha response'));
  assert((await page.locator('[data-alerts-meta]').innerText()).includes('1 of 1'));
  console.log('PASS same-scope membership changes revoke old rows and reject late callbacks.');

  await page.evaluate(() => {
    window.records.recordDocuments('company-documents',{rows:[{id:'secret',ticker:'BBB',date:window.alerts.today(),title:'Private current document'}]});
  });
  await contains('Private current document');
  await page.evaluate(() => { window.tab.destroy(); window.records.clearPrivateRecords(); window.show(); });
  assert(!(await page.locator('#root tbody').innerText()).includes('Private current document'), 'returning after logout cannot flash retained private rows');

  // Drive the status-only method over the real kit, including an active search. Counters prove
  // it does not rebuild key maps or the full search index while updating the existing cover.
  await page.evaluate(async () => {
    window.tab.destroy();
    const {scoreTable}=await import('/js/ui/screener.js');
    window.work={keys:0,search:0};
    const rows=Array.from({length:33568},(_,i)=>({id:String(i),name:'Row '+i}));
    const table=scoreTable({id:'status-test',rows,key:r=>{window.work.keys++;return r.id;},
      columns:[{key:'name',label:'Name',get:r=>r.name}],
      searchable:r=>{window.work.search++;return r.name;},virtual:true,loading:true});
    document.querySelector('#table-test').innerHTML=table.html;window.offTable=table.wire(document.querySelector('#table-test'));
    window.table=table;
  });
  await page.locator('#table-test [data-table-search]').fill('Row 123');
  await page.waitForFunction(() => !document.querySelector('#table-test [data-table-loading]'));
  const work = await page.evaluate(() => {
    const input=document.querySelector('#table-test [data-table-search]');const before={...window.work};
    window.table.updateStatus({loading:false});
    return {keys:window.work.keys-before.keys,search:window.work.search-before.search,same:input===document.querySelector('#table-test [data-table-search]'),q:input.value};
  });
  assert.deepEqual(work,{keys:0,search:0,same:true,q:'Row 123'});
  await page.evaluate(() => window.offTable());
  console.log('PASS private revocation on return and unchanged status update over 33,568 real table rows with search preserved.');

  // A new visit whose live source completes before disk must keep its correction and empty
  // result; the disk callback is intentionally released last.
  await page.reload(); await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.show());
  await page.waitForFunction(() => window.calls.length === 1 && window.releaseCache);
  await page.evaluate(() => window.calls[0].complete({'nse-filings':[window.event('Corrected live result')]},
    Object.fromEntries(window.alerts.FEEDS.map(f=>[f.id,'ok']))));
  await contains('Corrected live result');
  await page.evaluate(async () => { window.releaseCache(); await new Promise(resolve=>setTimeout(resolve,250)); });
  assert(!(await page.locator('#root tbody').innerText()).includes('Saved current-day alert'));
  await contains('Corrected live result');
  await page.evaluate(() => window.show());
  await page.evaluate(() => window.calls.at(-1).partial({'nse-filings':[window.event('Corrected live result'), window.event('Genuine new arrival')]}, {'nse-filings':'ok'}));
  await contains('Genuine new arrival');
  await page.waitForFunction(() => document.querySelector('[data-arrival-badge]'));
  assert.equal(await page.locator('[data-arrival-badge]').count(), 1, 'a ready memory view establishes the baseline before another refresh can finish');
  await page.evaluate(() => window.calls.at(-1).complete({},Object.fromEntries(window.alerts.FEEDS.map(f=>[f.id,'ok']))));
  await page.waitForFunction(() => !document.querySelector('#root tbody')?.textContent.includes('Corrected live result'));
  console.log('PASS late disk cannot replace a live correction; confirmed empty sources clear old rows.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
