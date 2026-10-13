// Local publisher fixtures: current analysis, document-only coverage, free-index recovery and history.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = '2026-10-13T10:00:00Z';
const scan = (ticker, score, tracked = true) => ({ companyKey: ticker, ticker, companyId: `NSE:${ticker}`,
  name: `${ticker} Company`, when: '2026-08-11T16:00:00+05:30', date: '2026-08-11', resultScore: score,
  sentimentTier: score == null ? null : 3, notesReady: score != null, tags: score == null ? [] : ['▲ Published growth'],
  ssUrl: tracked ? `${ticker}.pdf` : null, analysisTracked: tracked,
  documents: [{ type: 'Transcript', url: `https://example.test/${ticker}.pdf` }] });
let payload = { ok: true, rows: [scan('SCORED', 82.6), scan('READY', null, false), scan('MISSING', null, false), scan('PENDING', null)],
  meta: { fetchedAt: at, analysisLive: true }, upcoming: [], today: { day: null, rows: [] } };
let indexFailed = true, indexReads = 0, dispatches = 0;
let summaries = [{ ticker: 'READY', slug: 'ready', quarter: 'Q1FY27', quarter_confirmed: true, transcript_available: true,
  result: 'Beat', verdict: 'Hold-watch', headline: 'Published exact-call headline', tags: ['Source tag'] }];
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
window.SATTVA_DEEPDIVE_URL=location.origin+'/publisher';
import * as tab from '/js/tabs/concall.js';
import * as feed from '/js/data/concall-scans.js';
window.feed=feed;
let subscriber=null;
tab.render({root:document.querySelector('#root'),scope:'universe',params:{},data:{},live:{register(_id,options){window.tick=async()=>{const value=await options.fetcher();subscriber?.(value);return !!value}},subscribe(_id,fn){subscriber=fn;return ()=>{subscriber=null}},start(){},stop(){}}});
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  const json = (value, status = 200) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  if (path === '/') { res.setHeader('content-type','text/html'); res.end(html); return; }
  if (path === '/api/concalls') return json(payload);
  if (path === '/publisher/api/summary') { indexReads++; return json(indexFailed ? { error:'temporary outage' } : { summaries }, indexFailed ? 503 : 200); }
  if (path === '/publisher/api/analyze') { dispatches++; return json({}, 500); }
  if (path.startsWith('/api/') || path.startsWith('/data/')) return json({}, 404);
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try { res.setHeader('content-type', {'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(file)] || 'text/plain'); res.end(readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({status:404,body:''}));
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({time:new Date(at)}); await page.goto(origin);
  const row = ticker => page.locator('tr[data-row-key]').filter({hasText:`${ticker} Company`}).first();
  await row('SCORED').waitFor();
  assert.match(await row('SCORED').innerText(), /82.6/);
  await row('READY').getByText('Assessment source unavailable', {exact:true}).first().waitFor();
  indexFailed = false; await page.clock.fastForward(31000);
  await row('READY').getByText('DD · Beat', {exact:true}).waitFor();
  assert.match(await row('READY').innerText(), /DD · Hold-watch/);
  assert.match(await row('READY').innerText(), /Published exact-call headline/);
  const blankFields = await page.locator('tbody tr[data-row-key]').evaluateAll(rows => {
    const heads = [...document.querySelectorAll('thead th')].map(h => h.textContent.trim());
    const indices = ['Result', 'Sentiment / View', 'Highlights'].map(label => heads.indexOf(label));
    return rows.flatMap(row => indices.map(i => row.cells[i]?.textContent.trim())).filter(value => !value || value === '—');
  });
  assert.deepEqual(blankFields, [], 'every assessment field contains published evidence or an honest status');
  assert.match(await row('MISSING').innerText(), /No matching assessment/);
  // The retained analysis remains readable through a smaller, older outage response and reload.
  payload = { ...payload, degraded:'Analysis temporarily unavailable', rows:[scan('MISSING',null,false)],
    meta:{fetchedAt:'2026-09-14T00:00:00Z',analysisLive:false} };
  await page.evaluate(async()=>{await window.tick()});
  assert.match(await row('SCORED').innerText(), /82.6/);
  assert.match(await row('SCORED').innerText(), /saved/);
  assert.equal(await page.evaluate(()=>window.tick()),false,'an unchanged outage response does not repaint retained rows');
  await page.waitForFunction(async()=>!!(await (await import('/js/core/store.js')).readEntry('concalls:published-analysis-history-v1'))?.value?.rows?.length);
  await page.reload(); await row('SCORED').waitFor();
  assert.match(await row('SCORED').innerText(), /82.6/);
  assert.equal(dispatches,0,'rendering, recovery, refresh and reload never generate a paid assessment');
  assert(indexReads>=2); assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/sattva-concall-assessment-coverage.png',fullPage:true});
  console.log('PASS populated assessment fields, exact-call fallback, free recovery, durable outage history and zero paid dispatches');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
