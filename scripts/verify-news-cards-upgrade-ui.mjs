// A returning, controlled reader upgrades the immutable News graph and semantic feedback.
// All reads and votes are local fixtures; the test never starts a collector or touches production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false;
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">
<style>:root{--ink-900:#0f172a;--ink-600:#475569;--ink-400:#94a3b8;--accent-600:#4f46e5}</style><main id="reading"></main><script type="module">
import * as tab from '/js/tabs/news.js';
import { recentNews as feed } from '/js/data/filings.js';
import * as coverage from '/js/data/coverage.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
const company={ticker:'LTIM',isin:'INE214T01019',name:'LTI Mindtree Limited'};
const rows=[{...company,company:company.name,title:'LTI Mindtree guidance update',source:'Mint',date:'2026-10-14',
 publishedAt:'2026-10-14T08:00:00+05:30',summary:'Original publisher standfirst.',url:'https://example.test/story',
 image:new URL('/assets/brand/sattva-ventures-wordmark.png',location).href}];
Object.assign(feed,{rows:()=>rows,isLoaded:()=>true,setWindow:()=>false,setWanted(){},wasAskedEmpty:()=>false,failureFor:()=>null,
 onChange:()=>()=>{},load:async()=>{},meta:()=>({kind:'news',loaded:true,covered:1,rowCount:1,rows,failed:0,pending:0,outstanding:0})});
coverage.prime({holdings:[company]});
tab.render({root:document.querySelector('#reading'),scope:'portfolio',live:{register(){},start(){},stop(){}}});
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
// The preceding immutable release serves the spacious News layout to a returning reader.
const legacy = `export function render(ctx){ctx.root.innerHTML='<article data-legacy-news style="padding:20px;min-height:150px"><h3>LTI Mindtree guidance update</h3><p>Original publisher standfirst.</p><p>Is this important?</p></article>';}`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
    if (path.startsWith('/api/')) { res.writeHead(404, { 'content-type':'application/json' }); res.end('{}'); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('outside fixture');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js',self.location).href;");
      if (!upgraded) body = body.replace('-compact-news-reader-v2', '');
    }
    if (path === '/js/tabs/news.js' && !upgraded) body = legacy;
    res.setHeader('content-type', { '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status:200, body:'' }));
  await page.clock.install({ time:new Date('2026-10-14T05:00:00Z') });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('[data-legacy-news]').count(), 1, 'returning reader starts on cached spacious view');
  assert(!(await page.evaluate(() => caches.keys())).some(key => key.includes('compact-news-reader-v2')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.locator('.news-card-table .news-story').waitFor();
  assert.equal(await page.locator('[data-legacy-news]').count(), 0, 'open reader replaces the spacious layout automatically');
  assert.equal(await page.locator('.news-story-summary').isVisible(), false, 'returning reader gets compact default rows');
  await page.locator('.news-story-details summary').click();
  assert(await page.locator('.news-story-thumbnail img').isVisible(), 'new image component is loaded through the upgraded graph');
  const colors = await page.locator('.news-story').evaluate(card => ['important','not-important'].map(value => getComputedStyle(card.querySelector('[data-vote="'+value+'"]')).color));
  assert.deepEqual(colors, ['rgb(4, 120, 87)','rgb(190, 18, 60)'], 'returning reader receives green/red feedback');
  const keys = await page.evaluate(() => caches.keys());
  assert(keys.every(key => key.includes('compact-news-reader-v2')), 'preceding immutable caches are removed');
  const cached = await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys())[0]);
    return !!(await cache.match('/js/ui/news-story.js'));
  });
  assert(cached, 'shared story component is included in the new immutable graph');
  assert.deepEqual(errors, []);
  console.log('PASS warm Portfolio session replaces its cached spacious cards with the compact expandable layout automatically, warms the new component and evicts the old graph');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
