// Local opening, complete cached evidence and obsolete-import races. No upstream reads/writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), baseline = process.env.STARTUP_BASE_DIR;
const small = new Set(['/data/portfolio-companies.json', '/data/sector-kpis.json', '/data/book.json']);
let releaseSources, releaseTab, tabRequested;
const sourcesPending = new Promise(done => { releaseSources = done; });
const tabPending = new Promise(done => { releaseTab = done; });
const requestedTab = new Promise(done => { tabRequested = done; });
let gateTab = false;
const requests = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET') { res.writeHead(405).end('{}'); return; }
  if (path === '/seed') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local cache seed</title>'); return; }
  requests.push(path);
  if (path.startsWith('/api/')) { res.writeHead(503).end('{}'); return; }
  if (path.startsWith('/data/') && !small.has(path)) {
    await sourcesPending;
    res.writeHead(503).end('{}'); return;
  }
  if (gateTab && path === '/js/tabs/ask-research.js') { tabRequested(); await tabPending; }
  const asset = path === '/' ? '/index.html' : path;
  const file = resolve(baseline && /\.(js|html)$/.test(asset) ? baseline : root, '.' + asset);
  if (!file.startsWith((baseline && /\.(js|html)$/.test(asset) ? resolve(baseline) : root) + sep)) {
    res.writeHead(403).end(); return;
  }
  try {
    const body = readFileSync(file);
    if (asset.startsWith('/js/') && process.env.STARTUP_LATENCY_MS) await new Promise(done => setTimeout(done, Number(process.env.STARTUP_LATENCY_MS)));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
      '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/seed');
  const companies = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json')));
  const saved = await page.evaluate(async companies => {
    const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const events = companies.holdings.filter(h => h.ticker).slice(0, 30).map((h, i) => ({
      id: `saved-${i}`, ticker: h.ticker, company: h.name, day, time: '10:00',
      feed: 'announcements', feedLabel: 'Corporate announcements', importance: 'high', direction: 'positive',
      headline: `Board approves a material acquisition worth Rs 500 crore — evidence ${i}`,
      url: `https://www.bseindia.com/fixture/${i}`, tab: 'corp-announcements',
    }));
    await new Promise((done, reject) => {
      const request = indexedDB.open('sattva-cache', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('payloads');
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('payloads', 'readwrite');
        transaction.objectStore('payloads').put({ savedAt: Date.now(), value: { version: 1, day, events,
          feeds: [{ id: 'announcements', status: 'ok', reachesToday: false }] } }, 'ai-alerts:public-window:v1');
        transaction.oncomplete = () => { db.close(); done(); };
        transaction.onerror = reject;
      };
    });
    return events;
  }, companies);
  await page.addInitScript(() => {
    window.openingTimes = {};
    const observer = new MutationObserver(() => {
      if (!openingTimes.nav && document.querySelector('[data-app-nav]')) openingTimes.nav = performance.now();
      if (!openingTimes.cards && document.querySelector('[data-ai-card]')) openingTimes.cards = performance.now();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  if (process.env.STARTUP_CPU_RATE) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.STARTUP_CPU_RATE) });
  requests.length = 0;
  await page.goto(origin + '/#/research/ai-alerts', { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('[data-ai-card]').first().waitFor({ timeout: 20000 });
  } catch (error) {
    console.log(JSON.stringify({ errors, text: await page.locator('#app').innerText(),
      cache: await page.evaluate(async () => (await import('/js/data/daily-alerts.js')).readCachedAlertWindow({ scope: 'portfolio' })) }));
    throw error;
  }
  const timing = await page.evaluate(() => ({ ...openingTimes,
    modules: performance.getEntriesByType('resource').filter(r => r.name.includes('/js/')).length,
    moduleBytes: performance.getEntriesByType('resource').filter(r => r.name.includes('/js/')).reduce((sum, r) => sum + r.decodedBodySize, 0) }));
  console.log(JSON.stringify({ baseline: baseline || null, ...timing }));
  if (baseline) { assert.deepEqual(errors, []); }
  else {
    const interfaceRequests = requests.filter(path => /^\/js\/tabs\/[^/]+\.js$/.test(path));
    assert(interfaceRequests.includes('/js/tabs/ai-alerts.js'));
    assert(!interfaceRequests.includes('/js/tabs/ask-research.js'), 'unselected research interface stays deferred');
    assert(!interfaceRequests.includes('/js/tabs/news.js'), 'unselected news interface stays deferred');
    for (const path of small) if (path !== '/data/book.json') assert.equal(requests.filter(p => p === path).length, 1, `${path}: opening promise avoids a duplicate read`);
    const restored = await page.evaluate(async () => (await (await import('/js/data/daily-alerts.js')).readCachedAlertWindow({ scope: 'portfolio' })).events);
    assert.deepEqual(restored, saved, 'every cached record and field survives the faster opening');
    assert.equal(await page.locator('[data-ai-card]').count(), 8, 'only the first screen is mounted');
    const last = saved.at(-1);
    await page.locator('[data-ai-search]').fill(last.ticker);
    const resultCard = page.locator(`[data-ai-card][data-ticker="${last.ticker}"]`);
    await resultCard.waitFor();
    // Cards use content-visibility:auto. Attachment/visibility can precede its
    // viewport paint, when innerText is still empty despite complete cached markup.
    await resultCard.scrollIntoViewIfNeeded();
    await page.waitForFunction(({ ticker, headline }) => [...document.querySelectorAll('[data-ai-card]')]
      .some(card => card.dataset.ticker === ticker && card.innerText.includes(headline)), { ticker: last.ticker, headline: last.headline });
    assert.match(await resultCard.innerText(), /evidence 29/, 'offscreen evidence is searchable and painted');
    releaseSources();
    gateTab = true;
    await page.evaluate(() => { location.hash = '#/research/ask-research'; });
    await requestedTab;
    assert.equal(await page.locator('#content-host').evaluate(node => node.inert), true, 'old controls stay covered while the replacement imports');
    await page.locator('[data-header-bookmarks]').click();
    await page.locator('#content-host[data-active-tab="bookmarks"]').waitFor();
    releaseTab();
    await page.evaluate(async () => { await (await import('/js/tabs/registry.js')).researchTabs.find(tab => tab.meta.id === 'ask-research').load(); });
    assert.equal(await page.locator('#content-host').getAttribute('data-active-tab'), 'bookmarks', 'late import completion cannot repaint the newer route');
    const metadata = await page.evaluate(async () => {
      const { researchTabs } = await import('/js/tabs/registry.js');
      const fields = ['id', 'title', 'navigationTitle', 'subviews', 'layout', 'inlineSubviews', 'allowEmptyScope', 'scopeIndependent', 'hideFromNavigation'];
      const pick = meta => Object.fromEntries(fields.map(field => [field, meta[field] ?? null]));
      return Promise.all(researchTabs.map(async tab => ({ routing: pick(tab.meta), actual: pick((await tab.load()).meta) })));
    });
    for (const { routing, actual } of metadata) assert.deepEqual(routing, actual, `${routing.id}: routing metadata preserves all flags/views`);
    assert.deepEqual(errors, []);
    console.log('PASS: cached first screen before slow sources, exact retained records/fields, offscreen search, shared opening reads, all route metadata and cancelled import ownership.');
  }
} finally {
  releaseSources(); releaseTab();
  await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
