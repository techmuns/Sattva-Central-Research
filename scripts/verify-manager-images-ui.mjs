// Real image decoding and card lifecycles; public brands with synthetic amounts only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { MANAGER_IMAGES, managerImage } from '../public/js/investors/manager-images.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
for (const image of MANAGER_IMAGES) {
  for (const alias of image.aliases) for (const kind of image.kinds) {
    assert.equal(managerImage({ name: alias, kind })?.id, image.id);
    assert.equal(managerImage({ name: `${alias} Fund III`, kind })?.id, image.id);
    assert.equal(managerImage({ name: `Other ${alias}`, kind }), null, 'a mentioned brand is not a manager identity');
  }
  assert.equal(managerImage({ name: image.aliases[0], kind: 'unknown' }), null);
}
assert.equal(managerImage({ name: 'HDFCish Fund', kind: 'listed-fund' }), null);
assert.equal(managerImage({ name: 'Direct / In-house', kind: 'custodian' })?.id, 'sattva');
const privateManagers = MANAGER_IMAGES.filter(i => !i.kinds.includes('listed-fund'));
const schemes = MANAGER_IMAGES.filter(i => i.kinds.includes('listed-fund'));
const position = (image, i) => ({ isin: `INF${String(i).padStart(9, '0')}`, security: `${image.aliases[0]} Example ETF`, ticker: null, assetClass: 'ETF', quantity: 1, marketValue: 100, costBasis: 80, weightPct: null });
const record = (name, kind, id) => ({ name, kind, id, asOf: kind === 'fund' ? null : '2027-03-31', positions: [], transactions: [],
  values: { marketValue: 100, costBasis: kind === 'fund' ? null : 80, unrealised: kind === 'fund' ? null : 20, cashValue: null, positionCount: 0 },
  ...(kind === 'fund' ? { capital: { committed: 100, drawn: 80, distributed: 10, currentValue: 100, tvpi: 1.375, dpi: 0.125, firstInvest: '2020-01-01' } } : {}) });
const records = privateManagers.map(i => record(i.aliases[0], i.kinds[0], `${i.kinds[0]}-${i.id}`));
const ashika = records.find(r => r.id === 'custodian-ashika');
ashika.positions = schemes.map(position); ashika.values.positionCount = schemes.length;
const duplicate = record('tandem parallel fund', 'fund', 'fund-tandem-second');
records.push(duplicate, record('Direct / In-house', 'custodian', 'custodian-direct'), record('Future Example Fund', 'fund', 'fund-unknown'));
const fixture = { version: 1, valuation: 'workbook', bookAsOf: '2027-03-31', listedValuationAt: null, listedValuationBasis: null, archiveVersion: 1, sourceRevision: 'synthetic-image-fixture',
  privateWorkbook: null, coverage: { note: 'Synthetic manager image verification', transactionAsOf: '2026-10-01', sourceCount: 1, privateCount: records.filter(r => r.kind === 'fund').length }, managers: records };
const inlineStyles = readFileSync(resolve(root, 'index.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/g).join('\n');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">${inlineStyles}<body class="bg-slate-50"><main id="fixture" class="mx-auto max-w-7xl p-4"></main><script type="module">
import { renderManagers } from '/js/investors/my-managers.js';
const view = renderManagers({scope:'portfolio'}); fixture.innerHTML = view.html; view.wire(fixture, []);
</script>`;
let broken = false;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') { res.setHeader('content-type', 'text/html'); return res.end(html); }
  if (broken && path === '/assets/managers/tandem.webp') return res.writeHead(404).end();
  const file = resolve(root, '.' + path);
  try {
    if (!file.startsWith(root + sep)) throw Error();
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store'); res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://sattva-family.pages.dev/research-bridge') return route.fulfill({ contentType: 'text/html', body: `<script>
      const fixture = ${JSON.stringify(fixture)}, origin = ${JSON.stringify(origin)};
      const send = m => parent.postMessage({channel:'sattva-portfolio-v1',...m},origin);
      addEventListener('message',e=>{if(e.origin!==origin||e.source!==parent||e.data.channel!=='sattva-portfolio-v1')return;
        const m=e.data;if(m.type==='hello')send({id:m.id,type:'ready',capabilities:['manager-workbook']});
        if(m.type==='managers')send({id:m.id,type:'result',managers:{...fixture,checkedAt:new Date().toISOString()}});
      });
    </script>` });
    if (new URL(url).origin === origin) return route.continue();
    if (route.request().resourceType() === 'image') external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  await page.waitForSelector('[data-open-manager="custodian-ashika"]');
  assert.equal(await page.locator('[data-open-manager]').count(), records.length + schemes.length, 'images do not merge or omit investments');
  await page.locator('[data-manager-image]').evaluateAll(images => images.forEach(i => i.loading = 'eager'));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-manager-image]')].every(i => i.complete && i.naturalWidth > 0));
  await page.locator('[data-manager-image]').evaluateAll(images => images.forEach(i => i.loading = 'lazy'));
  assert.equal(await page.locator('[data-manager-image]').count(), records.length + schemes.length - 1);
  assert.equal(await page.locator('[data-manager-image="tandem"]').count(), 2, 'repeated fund entries keep separate cards with the same identity image');
  assert.equal(await page.locator('[data-open-manager^="fund-unknown-"] .manager-avatar-fallback').count(), 1, 'future unmatched managers still have a visual');
  const retained = await page.evaluate(async () => {
    const card = document.querySelector('[data-open-manager="custodian-ashika"]'), image = card.querySelector('img');
    await (await import('/js/data/managers.js')).load({force:true});
    return card === document.querySelector('[data-open-manager="custodian-ashika"]') && image === card.querySelector('img');
  });
  assert(retained, 'a source check retains card and image nodes');
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} cards fit at ${width}px`);
    assert.equal(await page.locator('.manager-avatar').first().evaluate(i => i.getBoundingClientRect().width), 44);
    if (process.env.SI_QA_DIR) await page.screenshot({ path: `${process.env.SI_QA_DIR}/manager-images-${width}-${theme}.png` });
  }
  await page.locator('[data-manager-search]').fill('tandem');
  assert.equal(await page.locator('[data-open-manager]').count(), 2);
  assert.equal(await page.locator('[data-manager-image]').count(), 2);
  broken = true;
  await page.reload();
  await page.waitForSelector('[data-open-manager="custodian-ashika"]');
  await page.locator('[data-manager-search]').fill('tandem');
  await page.waitForFunction(() => document.querySelectorAll('[data-open-manager]').length === 2 && !document.querySelector('[data-manager-image="tandem"]'));
  assert.equal(await page.locator('.manager-avatar-fallback:visible').count(), 2, 'a failed image restores a same-size fallback');
  assert.deepEqual(external, [], 'no manager name or image request is sent to a third-party image service');
  assert.deepEqual(errors, []);
  console.log(`PASS manager images: ${MANAGER_IMAGES.length} decoded local identities, separate investments, refresh retention, search, themes, mobile and failed-image recovery`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
