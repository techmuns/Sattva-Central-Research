#!/usr/bin/env node
// Actual News renderer, deterministic source arrivals; no collector, publisher or production call.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPublisherName, newsPublisherFilter } from '../public/js/core/news-publishers.js';
import { newsViewStatus } from '../public/js/core/news-view-status.js';

assert.equal(canonicalPublisherName(' economic times '), 'The Economic Times');
assert.equal(canonicalPublisherName('The Economic Times'), 'The Economic Times');
assert.equal(canonicalPublisherName('LiveMint'), 'Mint');
assert.equal(canonicalPublisherName('BusinessWire'), 'Business Wire');
assert.equal(canonicalPublisherName('Money Control'), 'Moneycontrol');
assert.equal(canonicalPublisherName('Economic Times Commentary Blog'), 'Economic Times Commentary Blog', 'unknown publishers never broadly collapsed');
const sources = ['Economic Times', 'The Economic Times', 'Moneycontrol', ...Array.from({ length: 55 }, (_, n) => `A publisher ${n}`)];
const rows = sources.map(source => ({ source }));
const filter = newsPublisherFilter(rows);
assert.equal(filter.options.length, 58);
assert.equal(filter.options.filter(option => option.value === 'The Economic Times').length, 1);
assert.equal(rows.filter(row => filter.match(row, 'The Economic Times')).length, 2);
assert.deepEqual(rows.map(row => row.source), sources, 'normalizing display does not mutate provenance');
assert.equal(newsPublisherFilter([]).options.length, 1, 'publisher filter retains its slot before sources arrive');
assert.equal(newsViewStatus({ loaded: false, rowCount: 1 }).state, 'loading');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, reason: 'upstream' }).state, 'partial');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsDelivery: { core: { status: 'ok' }, publishers: { status: 'pending' } } }).state, 'loading');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsHistory: { loaded: false, pending: true } }).state, 'loading');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsDelivery: { publishers: { status: 'ok', historyPending: true } } }).state, 'loading');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsDelivery: { publishers: { status: 'ok', historyError: 'archive unavailable' } } }).state, 'partial');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsDelivery: { core: { status: 'ok' }, publishers: { status: 'partial' } } }).state, 'partial');
assert.equal(newsViewStatus({ loaded: true, rowCount: 1, newsHistory: { loaded: true } }).label, 'Published sources loaded');
const enrichment = { staleOrIncompleteQueries:39, pagesFailed:2, documentsPending:330 };
assert.equal(newsViewStatus({ loaded:true, rowCount:1, enrichmentCoverage:enrichment }).state, 'partial');
assert.match(newsViewStatus({ loaded:true, rowCount:1, enrichmentCoverage:enrichment }).detail, /39 queries.*2 page reads.*330 documents/);

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, '');
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/news.js';
import { recentNews as news } from '/js/data/filings.js';
import * as coverage from '/js/data/coverage.js';
const sources = ['Binance News', 'BusinessWire', 'CoinMarketCal', 'Coinpedia', 'Invezz', 'London Stock Exchange', 'Mint', 'Moneycontrol', 'PR Newswire', 'Quartr', 'Reuters', 'The Block', 'TradingView'];
const row = (source, n) => ({ ticker:'KISSHT', company:'OnEMI Technology Solutions', source,
 title: 'OnEMI Technology update ' + n, date:'2026-09-07', url:'https://example.test/' + n,
 companyAttribution: { status:'confirmed', companyTicker:'KISSHT', companyName:'OnEMI Technology Solutions', queryTicker:'KISSHT' } });
let rows = [], loaded = false;
let delivery = { core:{status:'pending',pending:true}, tradingView:{status:'pending',pending:true}, publishers:{status:'pending',pending:true} };
let history = {loaded:false,pending:false,error:null};
let enrichment = null;
let done;
const listeners = new Set();
const notify = () => listeners.forEach(fn=>fn());
Object.assign(news, {
 rows:()=>rows, isLoaded:()=>loaded, setWanted(){}, wasAskedEmpty:()=>false, failureFor:()=>null,
 meta:()=>({kind:'news',loaded,rows,covered:rows.length ? 1:0,rowCount:rows.length,capturedAt:'2026-09-07T07:00:00Z',windowDays:30,
  failed:0,pending:0,outstanding:0,newsDelivery:delivery,newsHistory:history,enrichmentCoverage:enrichment}),
 onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
 load:()=>new Promise(resolve=>{done=resolve}), refresh:async()=>({changed:false}),
});
coverage.prime({holdings:[{ticker:'KISSHT',isin:'INE12F801023',name:'OnEMI Technology Solutions'}]});
tab.render({root:document.querySelector('#root'),scope:'portfolio',live:{register(){},start(){},stop(){}}});
window.fixture = {
 tv(){rows=sources.map(row);delivery.tradingView={status:'ok'};notify()},
 core(){rows=[...rows,...Array.from({length:55},(_,n)=>row('A publisher '+n,'other-'+n)),row('Economic Times','ET-one'),row('The Economic Times','ET-two')];
  loaded=true;delivery={core:{status:'ok'},tradingView:{status:'ok'},publishers:{status:'ok'}};history={loaded:true,pending:false,error:null};notify();done()},
 fail(){delivery={...delivery,core:{status:'unavailable',error:'snapshot unavailable'}};notify()},
 recover(){delivery={...delivery,core:{status:'ok'}};notify()},
 add(){rows=[row('The Economic Times','ET-new'),...rows];notify()},
  discoveryGap(){enrichment={staleOrIncompleteQueries:39,pagesFailed:2,documentsPending:330};notify()},
  dates(){rows=['2026-09-08','2026-09-07','2026-09-06','2026-09-04','2026-09-02','2026-09-01','2026-08-26','2026-08-10','2026-08-09',null,'2026-09-09']
    .map((date,n)=>({...row('Economic Times','dated-'+n),date}));notify()},
  rows:()=>rows,
  universe:()=>tab.render({root:document.querySelector('#root'),scope:'universe',live:{register(){},start(){},stop(){}}}),
};
</script>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const body = readFileSync(path);
    res.setHeader('content-type', { '.js':'text/javascript', '.css':'text/css', '.json':'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport:{width:1440,height:1000} });
  const errors = [];
  page.on('pageerror', error=>errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date('2026-09-08T05:00:00Z') });
  await page.goto(origin);
  await page.waitForFunction(()=>window.fixture);
  await page.evaluate(()=>window.fixture.tv());
  const status = page.locator('[data-filings-info]');
  const outlet = page.locator('select[aria-label="Outlet"]');
  const search = page.locator('[data-table-search]');
  assert.match(await status.textContent(), /Loading remaining sources/);
  assert.ok((await outlet.locator('option').allTextContents()).includes('Moneycontrol'));
  assert.ok(!(await outlet.locator('option').allTextContents()).includes('the publisher'));
  await outlet.selectOption('Reuters');
  await search.fill('OnEMI');
  await page.evaluate(()=>window.fixture.core());
  assert.equal(await outlet.inputValue(), 'Reuters', 'selected publisher survives pending core arrival');
  assert.equal(await search.inputValue(), 'OnEMI', 'search survives pending core arrival');
  assert.match(await status.textContent(), /Published sources loaded/);
  assert.equal(await outlet.locator('option').count(), 70, 'all 69 distinct canonical publishers plus All');
  await outlet.selectOption('The Economic Times');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('ET-two'));
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 2, 'both ET spellings match one publisher option');
  assert.equal(await page.evaluate(()=>window.fixture.rows().find(row=>row.title.endsWith('ET-one')).source), 'Economic Times');
  await page.evaluate(()=>window.fixture.fail());
  assert.match(await status.textContent(), /Partial coverage.*retained articles shown/);
  assert.equal(await outlet.inputValue(), 'The Economic Times');
  assert.equal(await search.inputValue(), 'OnEMI');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 2, 'failed refresh leaves retained filtered articles visible');
  await page.evaluate(()=>{window.fixture.recover();window.fixture.add()});
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('ET-new'));
  assert.equal(await outlet.inputValue(), 'The Economic Times');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3);
  await page.evaluate(()=>window.fixture.discoveryGap());
  assert.match(await status.textContent(), /Partial coverage/);
  assert.match(await status.getAttribute('title'), /39 queries.*2 page reads.*330 documents/);
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3, 'incomplete enrichment never hides known articles');
  await search.fill('');
  await outlet.selectOption('all');
  await page.evaluate(()=>window.fixture.dates());
  const period = page.getByRole('combobox', { name:'News period', exact:true });
  assert.equal(await period.inputValue(), '30', 'News opens on last 30 days');
  assert.deepEqual(await period.locator('option').allTextContents(), ['Last 30 days','Today','Last 3 days','Last 7 days','Last 14 days','This month','Date not supplied']);
  for (const [value,count] of [['30',8],['today',1],['3',3],['7',5],['14',7],['month',6],['undated',1]]) {
    await period.selectOption(value);
    assert.equal(await page.locator('tbody tr[data-row-key]').count(), count, 'exact period membership: '+value);
  }
  await period.selectOption('7');
  await search.fill('dated-3');
  await page.evaluate(()=>window.fixture.fail());
  assert.equal(await period.inputValue(), '7', 'date period survives failed refresh');
  assert.equal(await search.inputValue(), 'dated-3');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'Sept 4 coverage remains visible in Last 7 days');
  await search.fill('');
  await period.selectOption('today');
  await page.clock.setSystemTime(new Date('2026-09-08T18:30:00Z'));
  await page.evaluate(()=>{window.fixture.recover();window.fixture.dates()});
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'today rolls over at IST midnight');
  assert.match(await page.locator('tbody').textContent(), /dated-10/);
  // Universe reads the actual publisher reader. Old partitions are advertised but must not
  // be requested by the recent view, even when scrolling or changing filters.
  await page.clock.setSystemTime(new Date('2026-09-08T05:00:00Z'));
  const requests = [];
  let publisherAt = '2026-09-08T05:00:00Z';
  const story = (id, publishedAt) => ({id,title:'Fixture story '+id,publisher:'Economic Times',publishedAt,url:'https://example.test/'+id});
  const datedStories = [story('today','2026-09-08T04:00:00Z'),story('last-week','2026-09-04T04:00:00Z')];
  await page.route(/\/data\/market-news(?:\.json|\/.*\.json)(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const body = path === '/data/market-news.json' ? {capturedAt:publisherAt,articles:datedStories,sources:[],archivedCount:5,archive:[
      {month:'2026-09',file:'market-news/2026-09.json',count:2,inHead:2},
      {month:'2026-08',file:'market-news/2026-08.json',count:1,inHead:0},
      {month:'undated',file:'market-news/undated.json',count:1,inHead:0},
      {month:'2020-01',file:'market-news/2020-01.json',count:1,inHead:0},
    ]} : path.endsWith('2026-08.json') ? {articles:[story('august','2026-08-20T04:00:00Z')]}
      : path.endsWith('undated.json') ? {articles:[story('unknown',null)]} : {articles:[story('old','2020-01-01T00:00:00Z')]};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/data/twitter-posts.json*', route => route.fulfill({contentType:'application/json',body:JSON.stringify({capturedAt:publisherAt,posts:[],byHandle:{},failed:{}})}));
  await page.evaluate(()=>window.fixture.universe());
  await page.waitForFunction(()=>document.querySelector('[data-news-more]')?.textContent.includes('Recent captured history loaded'));
  assert.equal(await page.locator('[data-news-key]').count(), 3);
  assert(!requests.some(path=>path.includes('2020-01')), 'Universe never walks older archive months');
  const recentRequests = requests.length;
  await period.selectOption('today');
  assert.equal(await page.locator('[data-news-key]').count(), 1);
  await period.selectOption('7');
  assert.equal(await page.locator('[data-news-key]').count(), 2);
  await period.selectOption('undated');
  assert.equal(await page.locator('[data-news-key]').count(), 1);
  assert.match(await page.locator('[data-news-key]').textContent(), /unknown/);
  assert.equal(requests.length, recentRequests, 'date switches do not fetch archives');
  await page.getByRole('textbox').fill('unknown');
  publisherAt = '2026-09-08T05:01:00Z';
  await page.evaluate(async()=>{const market=await import('/js/data/market-news.js');await market.refresh()});
  await page.waitForFunction(()=>document.querySelector('[data-news-more]')?.textContent.includes('Recent captured history loaded'));
  assert.equal(await period.inputValue(), 'undated', 'Universe refresh preserves date filter');
  assert.equal(await page.locator('[data-news-search]').inputValue(), 'unknown');
  assert.equal(await page.locator('[data-news-key]').count(), 1);
  for (const width of [1440,1024,390]) {
    await page.setViewportSize({width,height:850});
    assert(await period.isVisible(), 'date control remains reachable at '+width);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page overflow at '+width);
  }
  assert.deepEqual(errors, []);
  console.log('PASS News publishers: uncapped canonical outlet list, original provenance, TV-first partial loading, late ET delivery, retained search/filters and failure/recovery.');
} finally {
  await browser.close();
  await new Promise(done=>server.close(done));
}
