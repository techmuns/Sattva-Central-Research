#!/usr/bin/env node
// scripts/verify-momentum-scanner-ui.mjs — the Momentum Scanner's layout check, headless.
//
//   node scripts/verify-momentum-scanner-ui.mjs
//
// Mirrors verify-ui.mjs: it drives the REAL dashboard (served from public/) and prints one
// PASS/FAIL line per check, exiting non-zero on any failure so it can gate a push and the CI
// `browser` job. It asserts the Step-3 polish — the stat strip, the hand-built sector mini-bar,
// the ranked table's columns, the gate toggle, the threshold controls, the colourful condition
// pills, the empty state — plus NO horizontal page overflow at 1440px and 390px and zero console
// errors of ours.
//
// It serves a small DETERMINISTIC fixture at data/technicals.json (built by cloning a real row and
// overriding only the momentum fields) rather than the live committed capture, so the counts it
// asserts cannot drift when the daily Data refresh changes the real file. The engine MATH is proved
// separately and exhaustively by scripts/verify-momentum-scanner.mjs; this is the layout.
//
// SANDBOX NOTE: external requests (Google Fonts, the Munshot SDK bundle, the on-demand ExcelJS CDN)
// are fulfilled empty so no egress is attempted and the console stays clean; the SDK's absence is a
// supported no-op, exactly as verify-ui.mjs documents.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
let chromium;
try {
  ({ chromium } = await import(`${PW_ROOT}/index.mjs`));
} catch {
  console.error(`Could not load Playwright from ${PW_ROOT}. Set PLAYWRIGHT_ROOT to your install.`);
  process.exit(2);
}

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---- the deterministic fixture ---------------------------------------------------------------
// Clone a real, clean row so tech-scoring reads a valid shape, then override only what the momentum
// engine reads. A Wilder RSI state whose lastClose equals the live price advances with Δ = 0, so it
// stays at exactly `value` — which lets us place a stock cleanly above or below a threshold.
const root = resolve('public');
const original = JSON.parse(readFileSync(`${root}/data/technicals.json`));
const seed = original.companies.find((r) => !r.error && r.rsi_multi && r.macd && r.sma20 != null);
if (!seed) { console.error('No clean seed row in technicals.json'); process.exit(2); }

const rsiState = (value, cmp) => ({ value, avgGain: 100 / (100 - value) - 1, avgLoss: 1, lastClose: cmp });
function makeCompany({ ticker, name, sector, cmp = 100, d, w, m, belowDma = false, pending = false }) {
  const base = { ...seed, ticker, name, sector, cmp, bar_date: original.price_date || '2026-09-10', screenerUrl: `https://www.screener.in/company/${ticker}/` };
  if (pending) {
    // Strip the Step-1 momentum fields so the row is evaluable:false (awaiting the data refresh).
    delete base.rsi_multi; delete base.macd;
    base.sma20 = null; base.sma50 = null; base.sma100 = null; base.sma200 = null;
    base.avg_volume_10d = null;
    return base;
  }
  return {
    ...base,
    sma20: belowDma ? cmp + 20 : cmp - 10,
    sma50: cmp - 12, sma100: cmp - 14, sma200: cmp - 16,
    above_20dma: !belowDma,
    avg_volume_10d: 1000,
    rsi_multi: { daily: rsiState(d, cmp), weekly: rsiState(w, cmp), monthly: rsiState(m, cmp) },
    macd: { ema12: cmp * 0.1 + 2, ema26: cmp * 0.1, signal: 0.5, line: 2, positive_crossover: false },
  };
}

// 3 pass Filter 1 across 3 sectors, 1 fails Filter 1 (below its 20 DMA), 1 pending. With no live
// quote feed the volume ratio is null, so Filter 2 fails for everyone — which gives the passer rows
// an emerald Filter 1 pill AND a rose Filter 2 pill, the "colourful pills" the view is meant to show.
const companies = [
  makeCompany({ ticker: 'MOMOA', name: 'Alpha Momentum', sector: 'Capital Goods', d: 80, w: 80, m: 75 }),
  makeCompany({ ticker: 'MOMOB', name: 'Beta Systems', sector: 'Information Technology', d: 82, w: 78, m: 72 }),
  makeCompany({ ticker: 'MOMOC', name: 'Gamma Pharma', sector: 'Pharmaceuticals', d: 77, w: 76, m: 70 }),
  makeCompany({ ticker: 'MOMOD', name: 'Delta Holdings', sector: 'Capital Goods', d: 85, w: 85, m: 80, belowDma: true }),
  makeCompany({ ticker: 'MOMOE', name: 'Epsilon Pending', sector: 'Textiles', pending: true }),
];
const fixture = { ...original, companies, company_count: companies.length, failures: 0 };

// ---- the server ------------------------------------------------------------------------------
const CT = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  // The fixture takes the place of the committed capture; the live route 304s nothing so the
  // module falls back to it. Every other /api/* answers a benign 200 so no same-origin 404 is logged.
  if (path === '/data/technicals.json') return json(fixture);
  if (path.startsWith('/api/')) return json({ ok: false });
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    const body = readFileSync(file);
    res.setHeader('content-type', CT[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    // A missing optional /data/*.json companion (atr-history, source overlay) is an empty object,
    // not a 404 — the loaders already treat it as absent, and a 404 would be a console error.
    if (path.startsWith('/data/') && path.endsWith('.json')) return json({});
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const ROUTE = `${origin}/#/research/breakouts/momentum-scanner?scope=universe`;

const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });

// Console errors that belong to the environment rather than the page, same families verify-ui.mjs
// filters: unreachable external assets and the Worker-only /api routes (benign here).
const ENV_ERROR = /exceljs|cdn\.jsdelivr|fonts\.g(oogleapis|static)|munshot|\.s3\.|net::ERR_/i;
const isOurError = (e) => !ENV_ERROR.test(e);

async function newPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  // No egress: anything off our origin is fulfilled empty (the SDK then falls back to its no-op).
  await context.route('**/*', (route) => (route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })));
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') { const u = (() => { try { return m.location()?.url || ''; } catch { return ''; } })(); errors.push(`${m.text()} ${u}`); } });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.stack || e)}`));
  return { context, page, errors };
}

// The structured read the assertions run against — one evaluate, so a mid-call remount cannot
// tear a sequence of queries apart.
const readView = () => ({
  statCards: [...document.querySelectorAll('#content-host .stat-card')].map((c) => ({
    text: c.textContent.replace(/\s+/g, ' ').trim(),
    gradient: /from-indigo-500/.test(c.className),
  })),
  sector: (() => {
    const s = document.querySelector('section[aria-label="Passing stocks by sector"]');
    if (!s) return null;
    const rects = [...s.querySelectorAll('svg rect')];
    const widths = rects.map((r) => parseFloat(r.getAttribute('width')) || 0);
    return { rects: rects.length, legend: s.querySelectorAll('.flex-wrap > span').length, widthSum: widths.reduce((a, b) => a + b, 0) };
  })(),
  ths: [...document.querySelectorAll('#content-host [data-score-table] thead th')].map((t) => t.textContent.replace(/[▾▴\s]+/g, ' ').trim()),
  gateButtons: document.querySelectorAll('#content-host [data-mgate]').length,
  thresholdInputs: document.querySelectorAll('#content-host [data-mthreshold]').length,
  emeraldPills: document.querySelectorAll('#content-host [data-score-table] tbody .bg-emerald-50.text-emerald-700').length,
  rosePills: document.querySelectorAll('#content-host [data-score-table] tbody .bg-rose-50.text-rose-700').length,
  pendingNote: document.querySelector('#content-host [data-momentum-pending]')?.textContent.replace(/\s+/g, ' ').trim() || null,
  docScrollW: document.documentElement.scrollWidth,
  bodyScrollW: document.body.scrollWidth,
  winW: window.innerWidth,
});

try {
  // ---- 1440px: the full layout -------------------------------------------------------------
  {
    const { page, errors } = await newPage(1440, 1000);
    await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#content-host [data-score-table]', { timeout: 20000 });
    await page.waitForSelector('section[aria-label="Passing stocks by sector"]', { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('[data-rows-pending]'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(300);
    const v = await page.evaluate(readView);

    ok('stat strip renders four cards', v.statCards.length === 4, `${v.statCards.length} cards`);
    ok('stat strip reads Scanned · Strong Momentum · Volume + Momentum · Pass Both',
      /Scanned/.test(v.statCards[0]?.text) && /Strong Momentum/.test(v.statCards[1]?.text) && /Volume \+ Momentum/.test(v.statCards[2]?.text) && /Pass Both/.test(v.statCards[3]?.text),
      v.statCards.map((c) => c.text).join(' | '));
    ok('the fourth stat card is the gradient hero', v.statCards[3]?.gradient === true);
    ok('stat-strip counts reflect the fixture (Scanned 4, Strong Momentum = 3, Pass Both = 0)',
      // The "?" help glyph can sit between a card's label and its value, so skip non-digits to the count.
      /Scanned\D*4\b/.test(v.statCards[0]?.text) && /Strong Momentum\D*3\b/.test(v.statCards[1]?.text) && /Pass Both\D*0\b/.test(v.statCards[3]?.text),
      v.statCards.map((c) => c.text).join(' | '));
    ok('a pending stock is counted apart, never as passing', /1 pending/i.test(v.statCards[0]?.text || '') && /pending/i.test(v.pendingNote || ''));

    ok('sector mini-bar renders', !!v.sector);
    ok('sector mini-bar has one SVG segment per legend chip', v.sector && v.sector.rects === v.sector.legend && v.sector.rects >= 1, v.sector && `${v.sector.rects} rects / ${v.sector.legend} chips`);
    ok('sector mini-bar has three segments (three passer sectors)', v.sector?.rects === 3, v.sector && `${v.sector.rects}`);
    ok('sector segment widths sum to ~100%', v.sector && Math.abs(v.sector.widthSum - 100) < 0.5, v.sector && v.sector.widthSum.toFixed(2));

    const expectedCols = ['Stock', 'Price', 'Strong Momentum', 'Volume + Momentum', 'Volume vs 10D Avg', 'RSI Daily', 'RSI Weekly', 'RSI Monthly', 'MACD', '20-DMA Status'];
    ok('ranked table carries every momentum column', expectedCols.every((c) => v.ths.some((th) => th === c || th.startsWith(c))), v.ths.join(' · '));

    ok('the gate toggle offers three options', v.gateButtons === 3, `${v.gateButtons}`);
    ok('five adjustable threshold inputs', v.thresholdInputs === 5, `${v.thresholdInputs}`);

    ok('condition pills are colourful — emerald pass and rose fail both present', v.emeraldPills >= 1 && v.rosePills >= 1, `emerald ${v.emeraldPills}, rose ${v.rosePills}`);

    ok('no horizontal PAGE overflow at 1440px', v.docScrollW <= v.winW + 1 && v.bodyScrollW <= v.winW + 1, `doc ${v.docScrollW} / body ${v.bodyScrollW} vs win ${v.winW}`);

    // The gate toggle writes the URL and re-filters without a fetch.
    await page.click('#content-host [data-mgate="both"]');
    await page.waitForFunction(() => /mgate=both/.test(location.hash), { timeout: 5000 }).catch(() => {});
    ok('clicking a gate updates the URL', /mgate=both/.test(await page.evaluate(() => location.hash)));

    // Impossible thresholds → the polished empty state, and the sector bar stands down.
    await page.evaluate((o) => { location.hash = '#/research/breakouts/momentum-scanner?scope=universe&mrd1=99&mrw=99&mrm=99'; void o; }, origin);
    await page.waitForFunction(() => {
      const td = [...document.querySelectorAll('#content-host [data-score-table] tbody td')].find((t) => t.getAttribute('colspan'));
      return td && /relaxing a threshold/.test(td.textContent);
    }, { timeout: 6000 }).catch(() => {});
    const empty = await page.evaluate(() => {
      const td = [...document.querySelectorAll('#content-host [data-score-table] tbody td')].find((t) => t.getAttribute('colspan'));
      return { text: td ? td.textContent.replace(/\s+/g, ' ').trim() : null, sector: !!document.querySelector('section[aria-label="Passing stocks by sector"]') };
    });
    ok('empty state reads the polished copy', /No stocks currently meet these conditions — try relaxing a threshold/.test(empty.text || ''), empty.text || 'no empty cell');
    ok('the sector mini-bar is absent when nothing passes', empty.sector === false);

    const own = [...new Set(errors)].filter(isOurError);
    ok('zero application console errors at 1440px', own.length === 0, own.slice(0, 3).join(' | ') || `${errors.length - own.length} environment error(s) filtered`);
  }

  // ---- 390px: mobile layout holds ----------------------------------------------------------
  {
    const { page, errors } = await newPage(390, 844);
    await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#content-host [data-score-table]', { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('[data-rows-pending]'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(300);
    const v = await page.evaluate(readView);

    ok('stat strip still renders four cards at 390px', v.statCards.length === 4);
    ok('sector mini-bar still renders at 390px', !!v.sector && v.sector.rects === v.sector.legend);
    ok('gate toggle and thresholds still present at 390px', v.gateButtons === 3 && v.thresholdInputs === 5, `gates ${v.gateButtons}, inputs ${v.thresholdInputs}`);
    ok('no horizontal PAGE overflow at 390px', v.docScrollW <= v.winW + 1 && v.bodyScrollW <= v.winW + 1, `doc ${v.docScrollW} / body ${v.bodyScrollW} vs win ${v.winW}`);

    const own = [...new Set(errors)].filter(isOurError);
    ok('zero application console errors at 390px', own.length === 0, own.slice(0, 3).join(' | ') || `${errors.length - own.length} environment error(s) filtered`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll Momentum Scanner UI checks passed.');
process.exit(failures ? 1 : 0);
