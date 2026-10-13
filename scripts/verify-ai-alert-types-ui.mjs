// Local fixture, actual card renderer and service worker; no production writes or AI requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let legacy = true;
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body><main id="root" style="padding:24px;max-width:1200px;margin:auto"></main><script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
window.show = (scope='universe') => { tab.destroy(); tab.render({root:document.querySelector('#root'),scope,params:{}}); };
window.show();
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script></body></html>`;
const feedModule = `
import { currentDay } from '../ui/ai-alert-utils.js';
export { currentDay as today } from '../ui/ai-alert-utils.js';
const listeners=new Set();export const onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
export async function readCachedAlertWindow(){return null}
window.arrive=()=>{window.arrived=true;listeners.forEach(fn=>fn())};
export async function collect({scope,onPartial}) {
 const event=(ticker,headline,i=0)=>({id:ticker+headline,ticker,company:ticker+' Limited',headline,filingSubject:headline,
  feed:'announcements',feedLabel:'NSE',day:currentDay(),time:'10:00',importance:'high',direction:'negative',url:'https://example.test/'+ticker+i+'.pdf'});
 const events=[event('MIXED','Loss of share certificates'),event('MIXED','Resignation of Director',1),
  {...event('MIXED','Newspaper advertisement for buyback',2),filingSubCategory:'Buyback'},
  event('ROUTINE','Loss of share certificates'),event('WARRANT','Preferential issue of warrants'),
  event('SCHEME','Scheme of arrangement'),event('UNKNOWN','General Updates'),
  ...Array.from({length:10},(_,i)=>event('R'+i,'Resignation of auditor'))];
 if(window.arrived)events.push(event('NEW','Resignation of CFO'));
 const result={scope,day:currentDay(),events,feeds:[{id:'announcements',status:'ok',reachesToday:true}],pending:0};
 onPartial?.({...result,pending:1});return result;
}`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if(path==='/js/data/holding-sizes.js'){res.setHeader('content-type','text/javascript');res.end("import * as b from '../research/portfolio-bridge.js';export const cachedHoldingSizes=b.cachedPositionSizes;export const readHoldingSizes=(...args)=>b.portfolioConnectionState()==='locked'?Promise.resolve(null):b.readPositionSizes(...args);");return;}
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(html); }
    if (path === '/sdk-fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end('/* no host */'); }
    if (path === '/glow-bridge.html') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<script>addEventListener('message', e => { if (e.data.channel === 'sattva-portfolio-v1') parent.postMessage({channel:e.data.channel,id:e.data.id,type:'auth-required'}, '*'); });</script>`);
    }
    if (path.startsWith('/api/')) { res.writeHead(503); return res.end('{}'); }
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error();
    let body = path === '/js/data/daily-alerts.js' ? feedModule : readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (legacy) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-event-filter-release`;');
    }
    if (legacy && path === '/js/tabs/ai-alerts.js') body = body.toString().replace('${eventTypesControl()}', '')
      .replace('Object.entries(SORTS).map', "Object.entries(SORTS).filter(([value]) => value !== 'holdings' || ctxRef?.scope === 'portfolio').map");
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.request().url() === 'https://sattva-family.pages.dev/research-bridge' ? route.fulfill({ contentType:'text/html', body:`<script>addEventListener('message', e => { if (e.data.channel === 'sattva-portfolio-v1') parent.postMessage({channel:e.data.channel,id:e.data.id,type:'auth-required'}, '*'); });</script>` }) : new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
const card = ticker => page.locator(`[data-ai-card][data-ticker="${ticker}"]`);
const open = async () => { if (!await page.locator('[data-ai-types-menu]').getAttribute('open').then(value => value !== null)) await page.locator('[data-ai-types-menu] summary').click(); };
const pick = async id => { await open(); await page.locator(`[data-ai-type="${id}"]`).check(); };
const close = async () => { await page.locator('[data-ai-types-menu] summary').focus(); await page.keyboard.press('Escape'); };
try {
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForSelector('[data-ai-card]');
  // register() on this reload also checks for an update. Let that old-version check finish
  // before changing the fixture, or update() can join it and never request the new worker.
  await page.waitForFunction(() => window.ready);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  // This case upgrades an already warm visit; let its initial reads and cache writes settle.
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('[data-ai-types-menu]').count(), 0);
  assert.equal(await page.locator('[data-ai-sort] option[value="holdings"]').count(), 0, 'old cached Universe menu hides Largest holdings');
  legacy = false;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('[data-ai-types-menu]');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(async () => (await import('/js/research/portfolio-bridge.js')).portfolioConnectionState() === 'locked');
  await page.waitForSelector('[data-ai-card]');
  assert.equal(await page.locator('[data-ai-sort] option[value="holdings"]').count(), 1, 'an existing session upgrades to the restored menu');
  assert(!(await page.evaluate(() => caches.keys())).some(key => key.includes('previous-event-filter-release')));
  assert.equal(await card('ROUTINE').count(), 0);
  assert.match(await card('MIXED').locator('[data-ai-insight]').textContent(), /Resignation/);
  assert(!/Loss of share/.test(await card('MIXED').textContent()));
  assert(!/Newspaper/.test(await card('MIXED').textContent()), 'a coarse Buyback label cannot reveal a hidden newspaper copy');
  await card('MIXED').locator('[data-ai-notebook-card] button').click();
  await page.waitForFunction(async () => (await import('/js/core/bookmarks.js')).all().length === 1);
  await pick('resignation');
  await pick('warrants');
  assert.equal(await page.locator('[data-ai-remove-type]').count(), 2);
  await close();
  await page.locator('[data-ai-search]').fill('WARRANT');
  assert.equal(await page.locator('[data-ai-card]').count(), 1);
  assert.match(await card('WARRANT').textContent(), /Preferential issue of warrants/);
  await page.locator('[data-ai-search]').fill('');
  assert.equal(await page.locator('[data-ai-more]').count(), 0);
  const seen = new Set();
  for (let step = 0; step < 20 && seen.size < 12; step++) {
    for (const key of await page.locator('[data-ai-card]').evaluateAll(nodes => nodes.map(node => node.dataset.aiKey))) seen.add(key);
    await page.evaluate(() => window.scrollBy(0, innerHeight * .75));
    await page.waitForTimeout(50);
  }
  assert.equal(seen.size, 12, 'scrolling exposes every company matching either selected type');
  await page.reload(); await page.waitForSelector('[data-ai-remove-type="warrants"]');
  assert.equal(await page.locator('[data-ai-remove-type]').count(), 2, 'choices survive reload');
  await page.evaluate(() => window.arrive());
  await page.locator('[data-ai-search]').fill('NEW');
  await card('NEW').waitFor();
  assert.equal(await page.locator('[data-ai-remove-type]').count(), 2, 'new arrivals retain choices');
  await page.locator('[data-ai-search]').fill('');
  await open(); await page.locator('[data-ai-types-clear]').click();
  await pick('routine'); await close();
  assert.equal(await page.locator('[data-ai-hide-routine]').isChecked(), false, 'routine selection reveals notices');
  assert.equal(await page.locator('[data-ai-card]').count(), 2);
  assert.match(await card('MIXED').locator('[data-ai-insight]').textContent(), /Loss of share/);
  assert(!/Resignation/.test(await card('MIXED').locator('[data-ai-evidence]').textContent()));
  const routineSave = card('MIXED').locator('[data-ai-notebook-card] button');
  const routineKey = await routineSave.getAttribute('data-bookmark-key');
  await routineSave.click();
  await page.waitForFunction(async key => !!(await import('/js/core/bookmarks.js')).get(key), routineKey);
  await page.waitForFunction(async () => (await import('/js/core/bookmarks.js')).all().length === 2);
  const saved = await page.evaluate(async () => (await import('/js/core/bookmarks.js')).all());
  const savedBodies = JSON.stringify(saved.map(({ title, body }) => ({ title, body })));
  assert(saved.some(entry => /Resignation/.test(entry.body) && !/Loss of share/.test(entry.body)), savedBodies);
  assert(saved.some(entry => /Loss of share/.test(entry.body) && !/Resignation/.test(entry.body)), savedBodies);
  await page.locator('[data-ai-hide-routine]').check();
  assert.equal(await page.locator('[data-ai-remove-type="routine"]').count(), 0);
  await pick('scheme'); await close();
  await card('SCHEME').waitFor();
  assert.equal(await page.locator('[data-ai-card]').count(), 1);
  await card('SCHEME').locator('[data-ai-mute]').click();
  assert.match(await page.locator('[data-ai-empty]').textContent(), /No alerts match/);
  await page.locator('[data-ai-filter="archived"]').click();
  await card('SCHEME').waitFor();
  await card('SCHEME').locator('[data-ai-unmute]').click();
  await page.locator('[data-ai-filter="all"]').click();
  await pick('resignation'); await close();
  await page.locator('[data-ai-sort]').selectOption('priority');
  for (const width of [1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}`);
    const box = await page.locator('[data-ai-types-menu] > div').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, `menu fits at ${width}`);
    await close();
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await open(); await page.screenshot({ path: '/tmp/sattva-ai-alert-event-filters.png' });
  await close(); await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await open();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-ai-lead-link]')).color === 'rgb(241, 245, 249)');
  await page.screenshot({ path: '/tmp/sattva-ai-alert-event-filters-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: warm-session upgrade, matching cards, OR filters, search, counts/infinite scrolling, saved choices, arrivals, routine recovery, archive, keyboard and 320–1280px layouts.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
