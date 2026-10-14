#!/usr/bin/env node
// Long-lived shared profile lookups: full-directory supplement, exact identities and outages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), stamp = '2026-10-14T00:00:00Z';
const main = 'INE002A01018', prizor = 'INE0V9N01017', bse = 'INE658D01029';
let failed = false, updated = false, requests = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  if (path === '/fixture') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Profile fixture</title>'); return; }
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/api/announcement-index/profiles') {
    requests++;
    if (failed) { res.statusCode = 503; json({ ok: false }); return; }
    json({ ok: true, builtAt: stamp, rows: [['MAIN', null, main, 9000, 'mid', 'capital_goods']] }); return;
  }
  if (path === '/data/market-caps.json') {
    json({ version: 1, generated_at: updated ? '2026-10-14T00:16:00Z' : stamp,
      entries: [{ ticker: 'PRIZOR', isin: prizor, exchanges: ['NSE'], cr: updated ? 1600 : 1468.29, checkedAt: stamp },
        { ticker: 'MAIN', isin: main, exchanges: ['NSE'], cr: 8000, checkedAt: stamp },
        { ticker: 'SIMPLEXCAS', bseCode: '513472', isin: bse, exchanges: ['BSE'], cr: 537.05, checkedAt: stamp }] }); return;
  }
  if (path === '/data/mc-ticker-map.json') { json({ generated_at: stamp, map: {} }); return; }
  if (path === '/data/sector-kpis.json') { json({ companies: {} }); return; }
  if (path.startsWith('/api/') || path.startsWith('/data/')) { res.statusCode = 503; json({}); return; }
  try {
    const file = resolve(root, `.${path}`); if (!file.startsWith(root + sep)) throw Error('path');
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream'); res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.fulfill({ status: 503, body: '{}' }));
  await page.addInitScript(() => { window.profileClock = Date.now(); Date.now = () => window.profileClock; });
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async () => { window.lookup = await import('/js/data/company-profiles.js'); await window.lookup.loadProfiles(); });
  const values = () => page.evaluate(({ main, prizor, bse }) => ({
    main: window.lookup.profileOf({ ticker: 'MAIN', isin: main }).mcapCr,
    prizor: window.lookup.profileOf({ ticker: 'PRIZOR', isin: prizor }).mcapCr,
    bse: window.lookup.profileOf({ ticker: 'SIMPLEXCAS', bseCode: '513472', isin: bse }).mcapCr,
    revision: window.lookup.profilesRevision(),
  }), { main, prizor, bse });
  const initial = await values();
  assert.equal(initial.main, 9000, 'successful index value retained');
  assert.equal(initial.prizor, 1468.29, 'non-filing issuer receives directory cap despite successful index endpoint');
  assert.equal(initial.bse, 537.05);
  await page.evaluate(() => window.lookup.loadProfiles()); assert.equal(requests, 1, 'within-cadence use does not flood endpoints');
  failed = true; updated = true;
  await page.evaluate(async () => { window.profileClock += 16 * 60_000; await window.lookup.loadProfiles(); });
  const after = await values();
  assert.equal(after.main, 9000, 'failed API revalidation cannot replace the saved index cap with a partial fallback');
  assert.equal(after.prizor, 1600, 'verified directory update still reaches non-filing issuers');
  assert.equal(after.bse, 537.05); assert(after.revision > initial.revision);
  assert.deepEqual(errors, []);
  console.log('PASS shared profiles merge complete directory coverage with successful index rows and retain each saved component through fifteen-minute revalidation outages.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
