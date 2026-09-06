// Real app, static local data, no production requests. Exercises the CSS as well as preferences.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":false,"error":"Local appearance test"}'); return; }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'text/plain');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [];
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', colorScheme: 'light', ...options });
  ctx.setDefaultTimeout(15000);
  await ctx.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    const type = route.request().resourceType();
    return route.fulfill({ status: 200, contentType: type === 'script' ? 'text/javascript' : type === 'stylesheet' ? 'text/css' : 'application/json', body: ['script', 'stylesheet'].includes(type) ? '' : '{"ok":false}' });
  });
  ctx.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  });
  return ctx;
}
async function ready(page, route = 'ask-research') {
  await page.goto(`${origin}/#/research/${route}?scope=universe`);
  await page.locator('[data-theme-toggle]').waitFor();
}
const theme = page => page.locator('html').getAttribute('data-theme');
const toggle = page => page.getByRole('button', { name: 'Dark mode', exact: true });
async function shot(page, name) {
  if (!process.env.THEME_SCREENSHOTS) return;
  mkdirSync(process.env.THEME_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.THEME_SCREENSHOTS}/${name}.png`, fullPage: true });
}
async function surface(page, selector) {
  return page.locator(selector).first().evaluate(el => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
}
function rgb(color) { return color.match(/[\d.]+/g).slice(0, 3).map(Number); }
function luma(color) {
  const c = rgb(color).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
const contrast = (fg, bg) => (Math.max(luma(fg), luma(bg)) + 0.05) / (Math.min(luma(fg), luma(bg)) + 0.05);
try {
  const ctx = await context(), page = await ctx.newPage();
  await ready(page);
  assert.equal(await theme(page), 'light');
  assert.equal((await surface(page, '.research-workspace')).bg, 'rgba(255, 255, 255, 0.93)');
  await shot(page, 'research-light');
  // System changes apply until a user makes an explicit choice.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await toggle(page).getAttribute('aria-pressed'), 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  // Keyboard activation, unchanged route, retained content/focus and no data reload.
  await page.locator('.research-composer textarea').fill('Keep my research question');
  const before = page.url();
  await toggle(page).focus();
  await page.keyboard.press('Space');
  assert.equal(await theme(page), 'dark');
  assert.equal(page.url(), before);
  assert.equal(await page.locator('.research-composer textarea').inputValue(), 'Keep my research question');
  assert.equal(await page.evaluate(() => document.activeElement.matches('[data-theme-toggle]')), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('sattva:theme')), 'dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  await shot(page, 'research-dark');
  const studio = await surface(page, '.research-workspace');
  assert(luma(studio.bg) < 0.05, 'research surface is dark');
  assert(contrast(studio.color, studio.bg) >= 4.5, 'research text is readable');
  await page.reload(); await toggle(page).waitFor();
  assert.equal(await theme(page), 'dark', 'explicit preference survives reload');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await theme(page), 'dark', 'OS cannot override explicit preference');
  const second = await ctx.newPage(); await ready(second);
  await toggle(second).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await toggle(page).click();
  await second.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await second.close();

  // Source popover, modal, drill and workspace use the same tokens as the tab.
  await page.locator('[data-beacon-toggle]').click();
  assert(luma((await surface(page, '.beacon-panel')).bg) < 0.05);
  await shot(page, 'beacon-dark');
  await page.locator('[data-beacon-close]').click();
  await page.locator('[data-sources-open]').click();
  assert(luma((await surface(page, '#modal-container')).bg) < 0.05);
  await shot(page, 'sources-dark');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { openDrill, openWorkspace } = await import('/js/ui/screener.js');
    openDrill({ name: 'Drill evidence', beforeGroupsHtml: '<p class="text-slate-700">Filed holdings</p>' });
    openWorkspace({ title: 'Research workspace', tabs: [{ id: 'evidence', label: 'Evidence', render: () => '<p class="text-slate-700">Source evidence</p>' }] });
  });
  await page.getByRole('heading', { name: 'Research workspace', exact: true }).waitFor();
  assert(luma((await surface(page, '#drill-panel')).bg) < 0.05);
  assert(luma((await surface(page, '#workspace-container')).bg) < 0.05);
  await page.evaluate(async () => { const s = await import('/js/ui/screener.js'); s.closeWorkspace(); s.closeDrill(); });

  // Real route surfaces, including a sticky table and the source/semantic pills.
  for (const tab of ['daily-alerts', 'ai-alerts', 'earnings-hub', 'concall', 'public-chatter', 'breakouts', 'super-investors', 'news', 'ipos', 'corp-announcements', 'corporate-actions', 'nse-filings', 'insider-trades']) {
    await page.evaluate(tab => { location.hash = `#/research/${tab}?scope=universe`; }, tab);
    await page.waitForFunction(tab => document.querySelector('#tabbar-mount .tab-btn.is-active')?.dataset.tabId === tab, tab);
    assert.equal(await theme(page), 'dark', tab);
    assert(contrast((await surface(page, '[data-app-header] h1')).color, 'rgb(11,18,32)') >= 7);
    if (tab === 'ipos') {
      await page.locator('[data-table-body] tr:not([aria-hidden="true"])').first().waitFor();
      const head = await surface(page, '[data-table-head]');
      assert(luma(head.bg) < 0.05, 'sticky table header is dark');
      assert(contrast(head.color, head.bg) >= 4.5);
      await page.evaluate(() => { window.themeContentBefore = document.querySelector('#content-host').firstElementChild; });
      await toggle(page).click();
      assert.equal((await surface(page, '[data-table-head]')).bg, 'rgb(248, 250, 252)');
      await toggle(page).click();
      assert(await page.evaluate(() => window.themeContentBefore === document.querySelector('#content-host').firstElementChild), 'theme change does not remount the table');
    }
    await shot(page, `${tab}-dark`);
  }
  // A small component matrix tests actual generated utility selectors and alpha syntax.
  await page.evaluate(async () => {
    const { spark } = await import('/js/ui/components.js');
    const node = document.createElement('div'); node.id = 'theme-samples';
    node.innerHTML = `<div class="bg-white text-slate-700">Body</div><div class="bg-slate-50 text-slate-500">Secondary</div><div class="bg-emerald-50 text-emerald-700">Positive</div><div class="bg-amber-50 text-amber-700">Partial</div><div class="bg-rose-50 text-rose-700">Failed</div><div class="bg-indigo-50 text-indigo-700">Selected</div><div class="bg-indigo-600 text-white">Action</div><div class="bg-white/80 text-slate-600">Translucent</div>${spark({values:[1,2,3],tone:'positive'})}`;
    document.body.append(node);
  });
  const samples = await page.locator('#theme-samples > div').evaluateAll(nodes => nodes.map(node => ({ bg: getComputedStyle(node).backgroundColor, fg: getComputedStyle(node).color })));
  for (const sample of samples) assert(contrast(sample.fg, sample.bg) >= 4.5, JSON.stringify(sample));
  assert.equal(new Set(samples.slice(2, 5).map(s => s.fg)).size, 3, 'semantic colors remain distinct');
  assert.notEqual(await page.locator('#theme-samples polyline').evaluate(el => getComputedStyle(el).stroke), 'rgb(5, 150, 105)', 'SVG chart responds without remount');
  await page.locator('#theme-samples').evaluate(el => el.remove());
  await page.evaluate(() => { location.hash = '#/research/ask-research?scope=universe'; });
  await page.locator('.research-workspace').waitFor();
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await toggle(page).boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width, `toggle fits at ${width}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal page overflow at ${width}`);
    await shot(page, `mobile-${width}-dark`);
  }
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
  assert.equal((await surface(page, 'body')).bg, 'rgb(255, 255, 255)');
  await page.emulateMedia({ media: 'screen' });
  await ctx.close();

  // Theme is present before the first stylesheet finishes, not set after app boot.
  const early = await context({ colorScheme: 'dark' });
  const first = await early.newPage();
  await first.addInitScript(() => localStorage.setItem('sattva:theme', 'light'));
  let release, arrived;
  const held = new Promise(done => { release = done; });
  const seen = new Promise(done => { arrived = done; });
  await first.route('**/css/tailwind.css', async route => { arrived(); await held; await route.continue(); });
  const navigation = first.goto(origin, { waitUntil: 'domcontentloaded' });
  await seen;
  assert.equal(await theme(first), 'light', 'saved light choice applies before CSS, despite dark OS');
  release(); await navigation;
  await early.close();

  const blocked = await context({ colorScheme: 'dark' }), privatePage = await blocked.newPage();
  await privatePage.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await ready(privatePage);
  assert.equal(await theme(privatePage), 'dark');
  await toggle(privatePage).click();
  assert.equal(await theme(privatePage), 'light', 'toggle works with blocked storage');
  await blocked.close();
  assert.deepEqual(errors, []);
  console.log('PASS themes: every tab, overlays, contrast, SVG, keyboard, preference, system changes, cross-tab sync, early paint, blocked storage, print and mobile');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
