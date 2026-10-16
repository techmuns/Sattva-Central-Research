// Actual AI cards and shared quote reader over local fixtures; no broker or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const companies = ['BHEL', 'SBIN', 'LUPIN', 'ZZUNKNOWN'];
const day = '2026-10-16', at = `${day}T06:00:00Z`, revision = 'a'.repeat(40);
const row = (ticker, price, prevClose) => ({ ticker, price, prevClose, volume: 1000,
  quoteAt: at, checkedAt: at, sessionDate: day, provider: 'Upstox', exchange: 'NSE' });
let quotes = [row('BHEL', 102, 100), row('SBIN', 99, 100)], failed = false, reads = 0;
const daily = { deliveryRevision: revision, generated_at: at,
  companies: [{ ticker: 'LUPIN', name: 'Lupin', cmp: 150, pct_change_today: 1.25, price_date: '2026-10-15' }] };
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body style="padding:16px"><main id="root"></main><script type="module">
import * as coverage from '/js/data/coverage.js';
import * as tab from '/js/tabs/ai-alerts.js';
window.tab=tab;
coverage.prime({holdings:${JSON.stringify(companies.map(ticker => ({ ticker, name: `${ticker} Industries Limited` })))}});
tab.render({root:document.querySelector('#root'),scope:'universe',params:{}});
</script></body></html>`;
const feed = `export const onChange=()=>()=>{}; export const today=()=> '${day}';
export async function readCachedAlertWindow(){return null;}
export async function collect({scope}){return {scope,day:today(),pending:0,
feeds:[{id:'earnings',status:'ok',reachesToday:true}],events:${JSON.stringify(companies)}.map(ticker=>({
 id:'result:'+ticker,ticker,company:ticker+' Industries Limited',feed:'earnings',feedLabel:'Earnings',
 day:today(),time:'10:00',headline:'Quarterly result filed',importance:'high',direction:'negative',
 aiEligible:true,url:'https://source.example/'+ticker,tab:'earnings-hub'}))};}`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  const send = (value, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
  if (pathname === '/') return send(html, 'text/html');
  if (pathname === '/js/data/daily-alerts.js') return send(feed, 'text/javascript');
  if (pathname === '/js/data/capture-watchdog.js') return send('export const onCaptureLanded=()=>()=>{};', 'text/javascript');
  if (pathname === '/api/breakouts') {
    reads++;
    return send({ version: 1, rows: quotes, targets: companies, failures: [] }, 'application/json', failed ? 503 : 200);
  }
  if (pathname === '/api/technicals') return send(daily);
  if (pathname.startsWith('/api/technicals/')) return send({ deliveryRevision: revision });
  if (pathname.startsWith('/api/')) return send({});
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) return send({}, 'application/json', 403);
  try { send(readFileSync(file).toString(), { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain'); }
  catch { send({}, 'application/json', 404); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '{}' }));
const card = ticker => page.locator(`[data-ai-card][data-ticker="${ticker}"]`);
const cmp = ticker => card(ticker).locator('[data-ai-cmp]');
const change = ticker => card(ticker).locator('[data-ai-price-change]');
try {
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin);
  await cmp('BHEL').getByText('₹102.00', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-ai-card]').count(), 4);
  assert.equal(await page.locator('[data-ai-price]').count(), 4, 'Every mounted company has a quote slot');
  assert.equal(reads, 1, 'One shared opening request, independent of the number of cards');
  assert.equal(await change('BHEL').innerText(), '+2.00% daily');
  assert.equal(await change('SBIN').innerText(), '-1.00% daily');
  assert.equal(await cmp('LUPIN').innerText(), '₹150.00');
  assert.match(await card('LUPIN').locator('[data-ai-price-status]').innerText(), /Close · 2026-10-15/);
  assert.equal(await cmp('ZZUNKNOWN').innerText(), '—');
  assert.equal(await change('ZZUNKNOWN').innerText(), 'Daily change —');
  assert.equal(await card('ZZUNKNOWN').locator('[data-ai-price-status]').innerText(), 'Price unavailable');
  await card('BHEL').locator('[data-open-general]').first().focus();
  await card('BHEL').evaluate(node => { window.heldCard = node; window.heldTimeline = node.querySelector('[data-ai-timeline]'); window.heldFocus = document.activeElement; });
  quotes = [row('BHEL', 103, 100), row('SBIN', 100, 100)];
  await page.clock.runFor(15000);
  await cmp('BHEL').getByText('₹103.00', { exact: true }).waitFor();
  assert.equal(await change('SBIN').innerText(), '0.00% daily');
  assert.equal(await page.evaluate(() => window.heldCard === document.querySelector('[data-ai-card][data-ticker="BHEL"]') && window.heldTimeline === window.heldCard.querySelector('[data-ai-timeline]') && window.heldFocus === document.activeElement), true, 'Quote updates preserve the card, timeline and focused control');
  failed = true;
  await page.clock.runFor(15000);
  await card('BHEL').locator('[data-ai-price-status]').getByText(/^Saved/).waitFor();
  assert.equal(await cmp('BHEL').innerText(), '₹103.00', 'Failure retains the last good quote');
  failed = false; quotes = [row('BHEL', 104, null)];
  await page.clock.runFor(15000);
  await cmp('BHEL').getByText('₹104.00', { exact: true }).waitFor();
  assert.equal(await change('BHEL').innerText(), 'Daily change —', 'Missing previous close is unknown, never zero');
  await page.setViewportSize({ width: 375, height: 900 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}: no sideways scroll`);
    const geometry = await card('BHEL').evaluate(node => {
      const price = node.querySelector('[data-ai-price]').getBoundingClientRect(), title = node.querySelector('h3').getBoundingClientRect(), card = node.getBoundingClientRect();
      return price.right <= card.right && price.left >= title.right && price.top < node.querySelector('[data-ai-date]').getBoundingClientRect().top;
    });
    assert.equal(geometry, true, `${theme}: CMP stays at the top right without overlapping the company title`);
  }
  if (process.env.ALERT_PRICE_SCREENSHOTS) {
    mkdirSync(process.env.ALERT_PRICE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: resolve(process.env.ALERT_PRICE_SCREENSHOTS, 'phone.png'), fullPage: true });
  }
  const before = reads;
  await page.evaluate(() => window.tab.destroy());
  await page.clock.runFor(30000);
  assert.equal(reads, before, 'Leaving AI Alerts stops its quote watcher');
  assert.deepEqual(errors, []);
  console.log('AI card prices: shared automatic quotes, daily changes, dated fallbacks, preserved reading state and responsive layout verified.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
