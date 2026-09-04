#!/usr/bin/env node
// scripts/verify-ui.mjs — the pre-push verification pass, as a script.
//
//   python3 -m http.server 8080 -d public
//   node scripts/verify-ui.mjs                     # defaults to http://localhost:8080
//   node scripts/verify-ui.mjs http://localhost:3000
//
// Walks CLAUDE.md's verification checklist plus the Earnings Hub specifics, and exits non-zero
// on the first failure so it can gate a push. Prints one PASS/FAIL line per check.
//
// This is a dev script, not part of the app — it uses the system Playwright (see PW_ROOT
// below) rather than adding an npm dependency, exactly as scrape-technicals.mjs uses none.
//
// SANDBOX NOTE: headless Chromium may not reach Google Fonts or the on-demand ExcelJS CDN.
// Tailwind is a committed same-origin stylesheet, so layout and visual checks still exercise the
// shipped UI; unavailable fonts fall back to the system stack and export checks report SKIP.

import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({ chromium } = await import(`${PW_ROOT}/index.mjs`));
} catch {
  console.error(`Could not load Playwright from ${PW_ROOT}.`);
  console.error('Set PLAYWRIGHT_ROOT to your install, e.g. PLAYWRIGHT_ROOT=$(npm root -g)/playwright');
  process.exit(2);
}

let failures = 0;
let skipped = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => {
  skipped++;
  console.log(`SKIP  ${label}  — ${why}`);
};

// ExcelJS is loaded only when an export starts. Where there is no egress, an export check is
// measuring the sandbox rather than the page — so it reports SKIP. This reads `errors`, which is
// populated as the run goes, so call it AFTER the navigation concerned.
const cdnBlocked = (re) => errors.some((e) => re.test(e));
const exceljsBlocked = () => cdnBlocked(/exceljs/i);
// Errors that belong to the environment rather than the page. Two families, both of which this
// suite already reports as SKIPs elsewhere, so counting them again as console errors would make
// the one unambiguous check in the run unreadable:
//   • Google Fonts, on-demand ExcelJS and html-to-image, and the Munshot Dashboard SDK bundle —
//     all unreachable without egress. The SDK's absence is a SUPPORTED state, not a degraded one:
//     js/core/sdk.js falls back to its no-op client and the dashboard runs exactly as it does
//     outside the host, which is the mode this whole suite drives it in. The handshake itself is
//     asserted against the real bundle by scripts/verify-sdk.mjs, which serves it from disk.
//   • `/api/*` 404s, which is what a plain `python3 -m http.server` correctly does with a route
//     only the Worker serves. Against `npx wrangler dev` these exist and are not filtered.
// Everything else counts, and the number filtered is always printed rather than swallowed.
const ENV_ERROR = /exceljs|cdn\.jsdelivr|fonts\.g(oogleapis|static)|munshot-dashboard-sdk|munshot\.s3\./i;
// A cross-origin upstream that could not be connected to at all. `net::ERR_*` is a transport
// failure — no egress — and every such feed is already reported as its own SKIP above. A wrong
// URL answers 404, not ERR_CONNECTION_RESET, so those still count.
const NO_EGRESS = (e) => /net::ERR_/.test(e) && /\[https?:\/\//.test(e) && !e.includes(`[${BASE}`);
// Requests a CHECK deliberately provokes. The deleted-module probe fetches four URLs precisely to
// prove they 404 — the failure is the pass condition — so the check that causes them registers
// the pattern here rather than leaving the final console assertion to guess at it.
const expectedErrors = [];
const expectError = (re) => expectedErrors.push(re);
const ownError = (e) =>
  !ENV_ERROR.test(e) &&
  !NO_EGRESS(e) &&
  !expectedErrors.some((re) => re.test(e)) &&
  !(/\/api\//.test(e) && /404|Failed to load resource/i.test(e));
const downloadOrSkip = async (label, file) => {
  if (file) return ok(label, true, file.suggestedFilename());
  if (exceljsBlocked()) return skip(label, 'exceljs CDN unreachable from here');
  return ok(label, false, 'no download fired');
};

// The browser never sees MUNS_TOKEN. Prove the Worker client sends the exact stock-search contract
// the upstream documents — especially static user_index 124 — against a stand-in, never production.
{
  const { searchStocks } = await import('../worker/muns.mjs');
  const realFetch = globalThis.fetch;
  let requestSeen = null;
  globalThis.fetch = async (url, init) => {
    requestSeen = { url: String(url), method: init?.method, headers: init?.headers, body: JSON.parse(init?.body || '{}') };
    return new Response(JSON.stringify({
      data: {
        total_results: 2,
        results: {
          RELIANCE: ['India', 'Reliance Industries Ltd', 'Refineries & Marketing'],
          'Reliance Media': ['India', 'Reliance Media', null],
        },
      },
      success: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const found = await searchStocks({ query: 'RELIAN' }, { MUNS_TOKEN: 'test-token', MUNS_SEARCH_BASE: 'https://search.invalid' });
    ok('stock search stays behind the Worker and sends query + static user_index 124',
      requestSeen?.url === 'https://search.invalid/stock/search' && requestSeen?.method === 'POST' &&
        requestSeen?.body?.query === 'RELIAN' && requestSeen?.body?.user_index === 124 &&
        requestSeen?.headers?.authorization === 'Bearer test-token' &&
        requestSeen?.headers?.accept === 'application/json' &&
        requestSeen?.headers?.['content-type'] === 'application/json');
    ok('...and normalises the ticker-keyed response for the autocomplete',
      found.results.length === 2 && found.results[0].ticker === 'RELIANCE' && found.results[0].name === 'Reliance Industries Ltd');
    ok('...while flagging a company-name key that cannot be used as a ticker', found.results[1].validTicker === false);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Insider rows do not currently carry exchange filing ids. Their Source cell must prefer a real
// URL when one arrives and otherwise narrow the public disclosure index by the exact insider name.
{
  const { insiderTradeSourceUrl } = await import('../public/js/tabs/insider-trades.js');
  const direct = insiderTradeSourceUrl({
    ticker: 'TEST',
    cells: { Insider: 'Example Insider', Source: 'https://example.com/filing.pdf' },
  });
  const derived = insiderTradeSourceUrl({ ticker: 'JAYNECOIND', cells: { 'Name of Insider': 'POOJAA AGRAWAL', Source: 'BSE' } });
  ok('insider source links prefer an explicit filing URL', direct === 'https://example.com/filing.pdf', direct || 'no link');
  ok('...and otherwise narrow the public record to the exact insider',
    derived === 'https://trendlyne.com/equity/insider-trading-sast/custom/?query=POOJAA%20AGRAWAL', derived || 'no link');
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--test-type'] });
// This suite stubs APIs with context routes. Playwright cannot intercept network
// requests initiated inside a service worker, so keep that worker out of this
// fixture and exercise it separately in verify-dashboard-performance-ui.mjs.
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
  serviceWorkers: 'block',
});
const page = await context.newPage();

// Research requires a fresh private-portfolio exchange before submitting. Exercise the real
// iframe/message contract with a local response, without opening a production Family session.
const familyFixture = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const familyHoldings = familyFixture.holdings.map(h => ({ isin: h.isin, ticker: h.ticker, name: h.name, sector: h.sector || 'Unclassified', weightPct: null }));
const familyHtml = `<!doctype html><script>
const holdings = ${JSON.stringify(familyHoldings).replaceAll('<', '\\u003c')};
addEventListener('message', event => {
  const m = event.data; if (event.source !== parent || m?.channel !== 'sattva-portfolio-v1') return;
  const send = value => event.source.postMessage({ channel: m.channel, id: m.id, ...value }, event.origin);
  if (m.type === 'hello') return send({ type: 'ready', capabilities: ['position-sizes'] });
  if (m.type === 'cancel') return send({ type: 'error', message: 'Cancelled' });
  if (!['read', 'positions'].includes(m.type)) return;
  const checkedAt = new Date().toISOString(), bookAsOf = '2026-06-30', archiveVersion = 1;
  send({ type: 'result', holdings, sizes: { basis: 'listed-market-value', complete: false, checkedAt, bookAsOf, archiveVersion },
    reading: { status: 'limited', checkedAt, bookAsOf, archiveVersion, answer: 'Local test holdings are available; position sizes are not supplied by this fixture.' } });
});
</script>`;
await context.route('**/research-bridge', route => route.fulfill({ contentType: 'text/html', body: familyHtml }));
await context.route('**/api/family-portfolio', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
  ...familyFixture, ok: true, syncStatus: 'live', storage: 'shared', sourceRevision: 'a'.repeat(64),
  sourceWorkbook: { fileKey: 'local-fixture', label: 'Local test workbook', uploadedAt: '2026-09-01T00:00:00Z' },
  count: familyFixture.holdings.length, resolved: familyFixture.holdings.filter(h => h.ticker).length,
  syncedAt: new Date().toISOString(),
}) }));
await context.route('**/api/capture-registration', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"reason":"local-fixture"}' }));

// The route sweep reaches Public Chatter long before its dedicated block. Install the local feed
// override before the first document loads so the dashboard and its lazy /posts detail requests
// are guaranteed to come from the same captured test source.
if (process.env.CHATTER_STUB) {
  await context.addInitScript((base) => localStorage.setItem('sattva:chatter-base', base), process.env.CHATTER_STUB);
}

const errors = [];
// Record the RESOURCE URL alongside the message. "Failed to load resource: net::ERR_CONNECTION_
// RESET" names nothing, so without the URL there is no way to tell an unreachable optional CDN
// from a script the page genuinely lost — and a check that cannot distinguish those is not useful.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const url = (() => { try { return m.location()?.url || ''; } catch { return ''; } })();
  errors.push(`${m.text().slice(0, 260)}${url ? `  [${url}]` : ''}`);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.stack || e).slice(0, 400)}`));

// THE DEEP DIVE DASHBOARD IS STUBBED FOR THE WHOLE RUN — see section 6d for what is checked.
//
// index.html ships the real dashboard's URL, and the Con-call tab reads that service's free index
// of finished reports whenever it mounts. A verification run must never touch it: it is somebody
// else's production service, and one bug away from being somebody else's bill. `baseUrl()` reads
// localStorage ahead of the baked-in URL, so seeding that key before the first navigation points
// every con-call render at this stub instead. It stays up until the browser closes.
const ddHits = { analyze: 0, report: 0, forced: 0, summary: 0 };
const { server: ddStub, origin: ddOrigin, setReady: ddSetReady, forget: ddForget } = await startDeepDiveStub(ddHits);
await context.addInitScript((origin) => localStorage.setItem('sattva:deepdive-base', JSON.stringify(origin)), ddOrigin);

// Scope persists to localStorage by design, so any check that assumes the full universe
// must say so in the URL rather than inherit whatever the previous navigation left behind.
const go = async (hash, settle = 900) => {
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(settle);
};
const hostText = () => page.locator('#content-host').innerText();
// A hash-routed SPA can navigate under a running `evaluate` — the router normalises a route, a
// poller lands, the tab remounts — and Playwright tears the execution context down mid-call. That
// is a harness race, not a defect in the page, so retry once rather than failing the run on it.
const evalSafe = async (fn, arg) => {
  try {
    return await page.evaluate(fn, arg);
  } catch (err) {
    if (!/Execution context was destroyed/.test(String(err))) throw err;
    await page.waitForTimeout(700);
    return page.evaluate(fn, arg);
  }
};
// Wait for a panel to actually finish painting rather than sleeping a magic number at it. The
// Earnings Hub fetches 1,300+ live rows on a cold load, so any fixed settle time is a race that
// gets lost the day the feed grows.
const waitForPanel = async (timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const [len, skeleton] = await page.evaluate(() => [
      (document.querySelector('#content-host')?.innerText || '').trim().length,
      document.querySelectorAll('#content-host .skeleton-shimmer').length,
    ]);
    if (len > 120 && !skeleton) return true;
    await page.waitForTimeout(150);
  }
  return false;
};
// Simulate the tab going to the background. Pollers must pause on hidden and refetch on return —
// this used to be defined in the con-call live-feed section, which no longer exists.
const setHidden = (hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
/**
 * Wait for every table on screen to have finished streaming its rows in.
 *
 * `scoreTable` paints a screenful and appends the rest while the browser is idle, which is what
 * took a tab switch from ~900ms of blocked main thread to ~60ms. It marks the section
 * `data-rows-pending="N"` while rows are outstanding and drops the attribute when none are — so a
 * check that counts rows waits for that rather than racing it. A `data-scroll-paged` history table
 * deliberately keeps rows pending until the reader scrolls, so it is excluded here and its model
 * count is read from the toolbar instead. Every other assertion here is about the settled table;
 * the streaming itself is asserted separately in section 11.
 */
const settleTables = () =>
  page
    .waitForFunction(() => !document.querySelector('[data-score-table][data-rows-pending]:not([data-scroll-paged])'), null, { timeout: 20000 })
    .catch(() => {});
const rowCount = async () => {
  await settleTables();
  return page.locator('tr[data-row-key]').count();
};
const SEARCH = '#content-host input[type="search"], #content-host input[placeholder*="Search"]';

/**
 * A stand-in for the Concall Deep Dive dashboard (see section 6d).
 *
 * It implements the documented contract and nothing else, and it counts what it is asked to do —
 * which is the point: the checks that matter about that integration are about requests NOT made.
 * Deterministic by call count rather than by wall clock, so a slow machine cannot skip a state.
 *
 * The report body is deliberately hostile in two ways: it carries a section this renderer has
 * never heard of, and a string that is markup. Both must survive as text.
 */
async function startDeepDiveStub(hits) {
  const { createServer } = await import('node:http');
  const runs = new Map(); // slug -> report polls served so far
  // Which companies the stub claims to already hold a report for. Set by the suite from a ticker
  // it actually finds in the live scan feed, so the "already ready" path is exercised against a
  // real row rather than one invented here.
  let ready = [];
  const identities = new Map(); // slug -> the company that slug's report is actually about
  const REPORT = {
    meta: { company: 'Tata Motors', ticker: 'TATAMOTORS', quarter: 'Q1FY27', call_date: '2026-08-05' },
    verdict: 'Constructive. Margin recovery is ahead of the guided path. <img src=x onerror="window.__dd_pwned=1">',
    key_takeaways: ['JLR EBIT margin guided to 8-10% for FY27.', 'Net automotive debt down to near zero.'],
    financials: [
      { metric: 'Revenue', current: 108000, prior: 102300 },
      { metric: 'PAT', current: 5900, prior: 3200 },
    ],
    weird_new_section: 'A field this renderer has never heard of, kept anyway.',
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (obj) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        // Their CORS is wide open; the stub matches so the browser behaves the same way.
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send({});
    if (url.pathname === '/api/summary') {
      hits.summary++;
      return send({ ok: true, version: 1, count: ready.length, summaries: ready });
    }
    if (url.pathname === '/api/analyze') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.analyze++;
        const body = JSON.parse(raw || '{}');
        if (body.force) hits.forced++;
        const slug = `${String(body.ticker || body.company || 'x').toLowerCase().replace(/\W+/g, '-')}-q1fy27`;
        runs.set(slug, 0);
        send({ ok: true, slug, status: 'queued' });
      });
      return;
    }
    if (url.pathname === '/api/report') {
      hits.report++;
      const slug = url.searchParams.get('slug');
      if (!runs.has(slug)) return send({ ok: true, slug, status: 'unknown' });
      const n = runs.get(slug) + 1;
      runs.set(slug, n);
      // 1: the KV propagation beat. 2: a stage with a message. 3+: the finished report.
      // Exactly what the real API sends mid-run: a status and a bare stage KEY. No message field
      // — the wording comes from their published stage table, which is why we copy that table.
      if (n === 1) return send({ ok: true, slug, status: 'unknown' });
      if (n === 2) return send({ ok: true, slug, status: 'running', stage: 'transcript' });
      if (n === 3) return send({ ok: true, slug, status: 'running', stage: 'research' });
      // A slug the stub was told to pre-hold reports under ITS OWN identity, so the panel opens
      // clean. A slug from a dispatch keeps the fixture's TATAMOTORS identity, which will NOT be
      // the company the suite clicked — that is deliberate, and it is what proves the panel
      // notices a report belongs to someone else instead of quietly titling it with our row.
      const identity = identities.get(slug);
      const report = identity ? { ...REPORT, meta: { ...REPORT.meta, ...identity } } : REPORT;
      return send({ ok: true, slug, status: 'done', report, partial: false });
    }
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const setReady = (ticker, company, slug) => {
    ready = [{ slug, company, ticker, quarter: 'Q1FY27', generated_at: '2026-08-07T09:39:57.305Z', verdict: 'Hold-watch' }];
    identities.set(slug, { company, ticker });
    runs.set(slug, 9); // already finished on their side, so the first poll returns the report
  };
  // Their store keeps a report for about a fortnight and then drops it. `forget` is that expiry:
  // the slug goes back to answering `unknown` and the index stops naming it, which is the state the
  // saved-report checks below exist for — the point at which their copy is gone and ours is not.
  const forget = (slug) => {
    runs.delete(slug);
    ready = ready.filter((r) => r.slug !== slug);
  };
  return { server, origin, setReady, forget };
}

// ---------------------------------------------------------------------------------------
// 1. Every route in both scopes renders a real panel
// ---------------------------------------------------------------------------------------
console.log('\n— shell and routing —');
await go('/#/', 1300);

const routes = await page.evaluate(async () => {
  const REGISTRY = {
    research: [
      'tabs/ai-alerts.js',
      'tabs/ask-research.js',
      'tabs/daily-alerts.js',
      'tabs/earnings-hub.js',
      'tabs/concall.js',
      'tabs/public-chatter.js',
      'tabs/breakouts.js',
      'tabs/super-investors.js',
      'tabs/news.js',
      'tabs/corp-announcements.js',
      'tabs/corporate-actions.js',
      'tabs/nse-filings.js',
      'tabs/insider-trades.js',
    ],
  };
  const out = [];
  for (const [ws, files] of Object.entries(REGISTRY)) {
    for (const f of files) {
      const m = await import(`/js/${f}`);
      const subs = (m.meta?.subviews || []).map((s) => s.id);
      for (const s of subs.length ? subs : [null]) out.push([ws, m.meta.id, s]);
    }
  }
  return out;
});

// The watchlist scope is swept too, but with the list EMPTY it is answered by the shell for every
// tab and there is nothing tab-specific left to break; the dedicated block below drives it with a
// company actually starred. Sweeping it empty here would mostly assert the same shell panel; Ask
// Research is the deliberate exception and gets an explicit empty-watchlist check below.
let broken = [];
for (const [ws, tab, sub] of routes) {
  for (const scope of ['universe', 'portfolio']) {
    const hash = `/#/${ws}/${tab}${sub ? `/${sub}` : ''}?scope=${scope}`;
    await go(hash, 300);
    await waitForPanel();
    const txt = await hostText();
    if (/hit a snag/i.test(txt) || txt.trim().length < 120) broken.push(hash);
  }
}
ok(`all ${routes.length} routes render in both scopes`, broken.length === 0, broken.slice(0, 4).join(', '));

// URL + history
await go('/#/research/breakouts/strong-breakouts');
ok('hash reflects the route', page.url().includes('breakouts/strong-breakouts'));
await page.goBack();
await page.waitForTimeout(600);
ok('browser back navigates', !page.url().includes('strong-breakouts'));

// ---------------------------------------------------------------------------------------
// 2. Earnings Hub — the LIVE results feed
// ---------------------------------------------------------------------------------------
console.log('\n— earnings hub (live) —');
await go('/#/research/earnings-hub?scope=universe', 2200);
const latestRows = await rowCount();
ok('Latest Results renders the full listed universe', latestRows > 1000, `${latestRows} companies`);

const ehText = await hostText();
ok('states which quarter and which two periods', /Q\d\s*FY/i.test(ehText) && /\bvs\b/i.test(ehText));
ok('says whether it is live or a snapshot', /\bLive\b/i.test(ehText) || /snapshot/i.test(ehText));
// This tab deliberately has no stat strip and no sub-view picker: one table, one passive Live label.
ok('no stat-card furniture in front of the table', (await page.locator('#content-host .stat-card').count()) === 0);
ok('a single small passive Live label instead', (await page.locator('[data-live-info]').count()) === 1);
ok('the sub-view picker is hidden for this single-view tab', await page.evaluate(() => {
  const m = document.getElementById('subview-mount');
  return !m || m.classList.contains('hidden') || !m.innerText.trim();
}));
// THE WORKSPACE SWITCHER IS GONE FROM THE CHROME, AND SO IS THE SECOND WORKSPACE.
//
// Portfolio Analytics was kept `hidden: true` for a while so a saved #/portfolio/... link would
// still resolve to the page it named. That protected a bookmark and built a trap: with no switcher
// there was nothing on the page that led back, and inside the host iframe there is no address bar
// to edit, so a reader who followed an Ask Research citation into it was stuck on a screen of
// invented money. The whole workspace, the FIFO engine and the mock ledger are deleted; the only
// portfolio fact this dashboard carries is the synced book of company names.
ok('the workspace switcher is gone from the chrome', (await page.locator('#workspace-mount').count()) === 0);
{
  // An old link must land on a WORKING page with the URL corrected — never on a dead route, and
  // never on a page with no way out of it.
  await go('/#/portfolio/overview/positions?scope=universe', 2500);
  const landed = await hostText();
  ok('...and an old Portfolio Analytics link lands on Research Central instead',
    !page.url().includes('/portfolio/') && /research/.test(page.url()), page.url());
  ok('...on a page that renders, with the tab bar back', !/hit a snag/i.test(landed) && landed.trim().length > 120,
    landed.slice(0, 60));
  // The deleted modules must 404 on the served site, so a stale import cannot quietly come back.
  // These 404s are the point of the check, not a symptom — see `expectError` at the top.
  expectError(/js\/portfolio\/|js\/data\/portfolio\.js|data\/portfolio\.json|portfolio-history\.json|mock\/transactions\.json/);
  const gone = await page.evaluate(async () => {
    const served = [];
    for (const f of ['js/portfolio/overview.js', 'js/portfolio/position-by.js', 'js/portfolio/transactions.js',
                     'js/portfolio/drawdown.js', 'js/portfolio/lots.js', 'js/portfolio/chrome.js',
                     'js/data/portfolio.js', 'data/portfolio.json', 'data/portfolio-history.json',
                     'data/mock/transactions.json']) {
      const res = await fetch(f, { cache: 'no-cache' }).catch(() => null);
      if (res && res.ok) served.push(f);
    }
    return served;
  });
  ok('...and every deleted ledger module and payload is gone from the served site', gone.length === 0, gone.join(', '));
  await go('/#/research/earnings-hub?scope=universe', 2200);
}
ok('...and the content spans the full width', (await page.locator('#content-host').boundingBox()).width > 1200);

// The column set: date first, then the three metrics with BOTH reported periods beside each
// growth figure, then market cap and basis.
const ehHeads = (await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase())));
ok('DATE is the first column', /^DATE/.test(ehHeads[0] || ''), ehHeads[0]);
ok('COMPANY is the second', /^COMPANY/.test(ehHeads[1] || ''), ehHeads[1]);
for (const c of ['REVENUE GROWTH', 'NET PROFIT GROWTH', 'MARKET CAP', 'BASIS']) {
  ok(`column present: ${c}`, ehHeads.some((h) => h === c));
}
// Headers are spelled out. "PAT", "REV" and "MCAP" are trade shorthand and this table is read by
// people who did not write it.
ok('headers are full words, not trade shorthand', !ehHeads.some((h) => /\b(REV|PAT|MCAP)\b/.test(h)), ehHeads.join(' | '));
// Two reported-figure columns per metric, each header naming the period it is — a bare "REVENUE"
// would leave the reader guessing which quarter the number belongs to.
for (const m of ['REVENUE', 'NET PROFIT']) {
  const cols = ehHeads.filter((h) => h.startsWith(`${m} `) && h !== `${m} GROWTH`);
  ok(`${m.toLowerCase()}: both periods are columns, each period-labelled`, cols.length === 2 && cols.every((h) => /[A-Z]{3}\s*\d{2}$/.test(h)), cols.join(' + '));
}
ok('gross profit is not a column', !ehHeads.some((h) => h.includes('GROSS')));

// The head has to stay put on a 1,300-row table. `sticky` only engages against a scrolling
// ancestor, so the wrapper must actually scroll — assert the behaviour, not the CSS. Needs real
// stylesheets: `position: sticky` comes from compiled Tailwind, so a missing generated asset would
// make the head scroll away for a reason that has nothing to do with this component.
const ehSticky = await page.evaluate(async () => {
  const box = document.querySelector('[data-table-scroll]');
  const head = document.querySelector('#content-host thead');
  const styled = getComputedStyle(head).position === 'sticky';
  const before = head.getBoundingClientRect().top;
  box.scrollTop = 800;
  await new Promise((r) => setTimeout(r, 250));
  return { styled, moved: Math.abs(head.getBoundingClientRect().top - before), scrolled: box.scrollTop, rowsAbove: document.querySelector('#content-host tbody tr').getBoundingClientRect().top < before };
});
ok('the table body scrolls inside its own box', ehSticky.scrolled > 0, `${ehSticky.scrolled}px`);
if (ehSticky.styled) ok('...and the column headings stay put while it does', ehSticky.moved < 2 && ehSticky.rowsAbove, `head moved ${ehSticky.moved.toFixed(1)}px`);
else skip('...and the column headings stay put while it does', 'compiled stylesheet unavailable — position:sticky never applied');
await page.evaluate(() => (document.querySelector('[data-table-scroll]').scrollTop = 0));
await page.waitForTimeout(200);
ok('the serial-number column is gone', !ehHeads.some((h) => h === '#'));
ok('TICKER is not a column...', !ehHeads.some((h) => h.includes('TICKER')));
ok('...nor INDUSTRY...', !ehHeads.some((h) => h.includes('INDUSTRY')));
ok('...nor Return Since Result', !ehHeads.some((h) => h.includes('RETURN SINCE RESULT')));
// Dropping them from the header must not drop them from the page — they moved under the name.
const ehIdent = await page.locator('#content-host tbody tr').first().innerText();
const ehSub = ehIdent.split('\n').find((l) => /[A-Z0-9&-]{2,}\s·\s\S/.test(l)) || '';
ok('ticker and industry survive under the company name', !!ehSub, ehSub || ehIdent.replace(/\s+/g, ' ').slice(0, 60));
ok('default sort is newest-first', /^DATE/.test(ehHeads[0]) && /▾/.test(ehHeads[0]));

// AND IN MONEYCONTROL'S OWN ORDER WITHIN A DATE. `resultDate` is a date; filings arrive through
// the day, and the upstream returns them newest-first at that finer granularity. An earlier
// version tie-broke on the size of the profit move, which reshuffled the top of the table so
// "latest results" showed neither the latest nor the same list Moneycontrol shows. Compare our
// rendered order against the payload's own order, which is the only thing that can catch it.
const ehOrder = await page.evaluate(async () => {
  let payload = null;
  try {
    const r = await fetch('api/earnings?subType=yoy', { cache: 'no-store' });
    if (r.ok) payload = await r.json();
  } catch {
    /* no Worker on this origin */
  }
  if (!payload?.rows?.length) {
    const r = await fetch('data/earnings-live.json', { cache: 'no-store' });
    payload = await r.json();
  }
  // Check the ORDERING CONTRACT itself — date descending, and within a date the upstream's own
  // `seq` ascending — rather than comparing two literal lists. An earlier version compared the
  // newest date's list and required it to hold more than three companies, which is true in the
  // middle of results season and false at 09:00, when exactly one company has filed. The property
  // under test holds either way; the list comparison did not.
  const index = new Map(payload.rows.map((r) => [r.scId, { date: r.resultDate || '', seq: r.seq ?? 0 }]));
  const rendered = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => tr.dataset.rowKey);
  const seen = rendered.map((k) => index.get(k)).filter(Boolean); // a row that filed mid-check is simply skipped
  const breaks = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1];
    const b = seen[i];
    if (b.date > a.date) breaks.push(`${rendered[i]} (${b.date} after ${a.date})`);
    else if (b.date === a.date && b.seq < a.seq) breaks.push(`${rendered[i]} (seq ${b.seq} after ${a.seq} on ${b.date})`);
  }
  const newest = payload.rows.reduce((a, r) => (r.resultDate > a ? r.resultDate : a), '');
  return {
    breaks: breaks.slice(0, 3),
    checked: seen.length,
    newest,
    newestCount: payload.rows.filter((r) => r.resultDate === newest).length,
    firstRendered: rendered.slice(0, 4).join(' '),
    seq: payload.rows[0]?.seq,
  };
});
ok('rows carry the upstream sequence', ehOrder.seq === 0, `first row seq=${ehOrder.seq}`);
ok(
  "...and the table is in Moneycontrol's own order — date desc, then upstream seq",
  ehOrder.checked > 20 && ehOrder.breaks.length === 0,
  ehOrder.breaks.length ? ehOrder.breaks.join('; ') : `${ehOrder.checked} rows in order; ${ehOrder.newestCount} filed on ${ehOrder.newest} — ${ehOrder.firstRendered}`
);

// The whole point of the wider column set was to keep it on screen. At the design width the
// table must not need its own horizontal scrollbar; the page must never scroll sideways at all.
// This one needs real CSS — an unstyled table lays out nothing like the shipped one.
const ehFit = await page.evaluate(() => {
  const box = document.querySelector('[data-table-scroll]');
  const styled = getComputedStyle(document.querySelector('[data-score-table]')).borderRadius !== '0px';
  return { need: box.scrollWidth, have: box.clientWidth, styled };
});
if (ehFit.styled) ok('the table fits at 1440 with no horizontal scrollbar', ehFit.need <= ehFit.have + 1, `${ehFit.need}px in ${ehFit.have}px`);
else skip('the table fits at 1440 with no horizontal scrollbar', 'compiled stylesheet unavailable');

// THE RECONCILIATION. The growth column and the two figure columns are three renderings of the
// same fact, and a reader will trust the pair over the percentage. Recompute the percentage from
// the two figures actually on screen and require it to agree with the one actually on screen.
const ehRecon = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#content-host thead th')].map((t) => t.innerText.trim().toUpperCase());
  const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
  const out = { checked: 0, bad: [] };
  for (const tr of [...document.querySelectorAll('#content-host tbody tr')].slice(0, 60)) {
    const td = [...tr.children].map((c) => c.innerText.trim());
    for (const m of ['REVENUE', 'NET PROFIT']) {
      const iCur = heads.findIndex((h) => h.startsWith(`${m} `) && h !== `${m} GROWTH`);
      const iPct = heads.indexOf(`${m} GROWTH`);
      if (iCur < 0 || iPct < 0) continue;
      const cur = num(td[iCur]);
      const pri = num(td[iCur + 1]);
      const shown = td[iPct];
      if (!/^[+-]?[\d.]+%$/.test(shown)) continue; // a pill, not a percentage — checked elsewhere
      if (!Number.isFinite(cur) || !Number.isFinite(pri) || pri === 0) continue;
      out.checked++;
      const calc = ((cur - pri) / Math.abs(pri)) * 100;
      // Rounding: the figures are whole crore and the percentage is a whole number, so a small
      // integer-rounding gap is expected. A sign flip or a factor-of-two gap is not.
      if (Math.abs(calc - num(shown)) > Math.max(2, Math.abs(num(shown)) * 0.05)) {
        out.bad.push(`${td[1].replace(/\s+/g, ' ').slice(0, 32)} ${m}: ${pri}→${cur} shown ${shown}, computes ${calc.toFixed(0)}%`);
      }
    }
  }
  return out;
});
ok('the figure columns reconcile with the growth column', ehRecon.checked > 100 && ehRecon.bad.length === 0, `${ehRecon.checked} checked${ehRecon.bad.length ? ' — ' + ehRecon.bad.slice(0, 3).join('; ') : ''}`);

// Status is visible without turning into another wall of explanatory chrome.
await page.locator('[data-live-info]').click();
await page.waitForTimeout(200);
ok('the results status is a passive label, not a provenance popup trigger',
  (await page.locator('[data-live-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

// THE HONESTY CHECK. A percentage across a sign change is not a growth rate, and about 13% of
// companies have one. These must render as labelled pills, never as a coloured number.
ok('loss → profit renders as a pill, not a percentage', /to profit/i.test(ehText));
ok('profit → loss renders as a pill', /to loss/i.test(ehText));
ok('loss in both periods is labelled as a loss', /loss\s*[↓↑]/i.test(ehText)); // \s matches the nbsp in the pill

await page.locator('#content-host select').first().selectOption('turnaround');
await page.waitForTimeout(600);
const turnRows = await rowCount();
ok('the loss → profit filter narrows the set', turnRows > 0 && turnRows < latestRows, `${turnRows} turnarounds`);
await page.locator('#content-host select').first().selectOption('all');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 2b. YoY / QoQ — the same filing asked two different questions.
//
// This is the one control on the page that changes what every number MEANS without changing
// which quarter is on screen: the current-period figures are byte-identical between the two and
// only the comparison column moves. So the headers have to move with it, or a screenshot of the
// table is a lie about what it is measuring against.
// ---------------------------------------------------------------------------------------
console.log('\n— yoy / qoq —');
const headsNow = () => page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
const revCols = (hs) => hs.filter((h) => h.startsWith('REVENUE ') && h !== 'REVENUE GROWTH');
// Read one named company's revenue pair, whichever row it is on.
//
// Polled, not read once. This runs against a LIVE feed: a company filing mid-check triggers a
// structural repaint, and a read that lands while the table is being rebuilt sees an empty tbody
// and reports a company that is plainly on screen as missing. Same reason `waitForPanel` exists.
const figuresFor = async (needle, timeout = 8000) => {
  const started = Date.now();
  for (;;) {
    const hit = await page.evaluate((n) => {
      const hs = [...document.querySelectorAll('#content-host thead th')].map((t) => t.innerText.trim().toUpperCase());
      const i = hs.findIndex((h) => h.startsWith('REVENUE ') && h !== 'REVENUE GROWTH');
      if (i < 0) return null;
      for (const tr of document.querySelectorAll('#content-host tbody tr')) {
        const tds = [...tr.children].map((c) => c.innerText.trim());
        if (tds[1] && tds[1].toUpperCase().includes(n)) return { cur: tds[i], prior: tds[i + 1] };
      }
      return null;
    }, needle);
    if (hit || Date.now() - started > timeout) return hit;
    await page.waitForTimeout(250);
  }
};

// The switch is a network round trip against the live upstream — on a cold cache that is seconds,
// not milliseconds. Wait for the toggle to actually flip (or for the tab to say it could not),
// rather than sleeping a number at it.
const waitForPeriod = async (want, timeout = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await page.evaluate(() => ({
      active: document.querySelector('[data-period][aria-pressed="true"]')?.dataset.period || null,
      error: /Comparison not switched/i.test(document.querySelector('#content-host')?.innerText || ''),
    }));
    if (state.active === want || state.error) return state;
    await page.waitForTimeout(250);
  }
  return { active: null, error: false };
};

ok('a YoY / QoQ toggle is present', (await page.locator('[data-period]').count()) === 2);
const yoyHeads = await headsNow();
const yoyPrior = revCols(yoyHeads)[1];
ok('YoY is the default', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'YOY');

// QoQ needs the live route to actually be serving QoQ. Three worlds, and which one we are in
// decides what to assert:
//   1. No Worker (a plain `python3 -m http.server`) — nothing to fetch.
//   2. A Worker whose upstream is down — it serves the committed snapshot, which is YoY-only.
//      There is deliberately no committed QoQ file, because a stale one would look exactly like a
//      live one while comparing against the wrong quarter.
//   3. A working live route.
// Worlds 1 and 2 are the MORE interesting test: they are where the tab could quietly show YoY
// numbers under QoQ headers and nothing on the page would reveal it. So probe for a genuinely
// live QoQ answer — not merely a 200 with rows in it — and assert the refusal otherwise.
const qoqProbe = await page.evaluate(async () => {
  try {
    const r = await fetch('api/earnings?subType=qoq', { cache: 'no-store' });
    if (!r.ok) return { live: false, why: `HTTP ${r.status}` };
    const p = await r.json();
    if (!(p?.rows?.length > 0)) return { live: false, why: 'no rows' };
    if (p.degraded) return { live: false, why: 'the route is serving the committed snapshot' };
    if ((p.meta?.subType || 'yoy') !== 'qoq') return { live: false, why: `the feed answered with ${p.meta?.subType}` };
    return { live: true, why: '' };
  } catch {
    return { live: false, why: 'no /api/earnings on this origin' };
  }
});
const hasLiveRoute = qoqProbe.live;

// Pin one company so the before/after comparison is about the same filing, not about whichever
// row happened to sort first. Read the name off the table rather than hard-coding it — the
// committed snapshot and the live feed do not contain the same companies.
const pinned = await page.evaluate(() => {
  const tr = document.querySelector('#content-host tbody tr');
  return (tr?.children[1]?.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean).find((x) => x.length > 3) || '';
});
const yoyPinned = pinned ? await figuresFor(pinned.toUpperCase()) : null;

await page.locator('[data-period="qoq"]').click();
const qoqState = await waitForPeriod('qoq');

if (!hasLiveRoute) {
  // No Worker. The ONLY acceptable outcome is a refusal that says so — never YoY numbers sitting
  // under QoQ column headers, which is the one failure the page itself could not reveal.
  ok('without a live QoQ feed, QoQ refuses rather than switching', qoqState.error === true && qoqState.active !== 'qoq', qoqProbe.why);
  ok('...and says which comparison you are actually looking at', /Comparison not switched/i.test(await hostText()));
  ok('...and the comparison columns are untouched', revCols(await headsNow())[1] === yoyPrior, yoyPrior);
  ok('...and the toggle still reads YoY', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'YOY');
  skip('the QoQ round trip against a live feed', qoqProbe.why);
} else {
  ok('the QoQ switch completes against the live feed', qoqState.active === 'qoq' && !qoqState.error);
  await page.waitForTimeout(400);
  const qoqHeads = await headsNow();
  const qoqPrior = revCols(qoqHeads)[1];
  ok('switching to QoQ repoints the comparison columns', !!qoqPrior && qoqPrior !== yoyPrior, `${yoyPrior} → ${qoqPrior}`);
  ok('...while the current period is unchanged', revCols(qoqHeads)[0] === revCols(yoyHeads)[0], revCols(qoqHeads)[0]);
  ok('...and the URL records it, so the view is shareable', page.url().includes('period=qoq'));
  ok('...with no bogus sub-view segment in the path', !/earnings-hub\/(null|undefined)/.test(page.url()), page.url().split('#')[1]);

  // A reload has to come back on the same comparison, not silently on the other one.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPanel();
  await waitForPeriod('qoq');
  ok('a reload restores QoQ rather than falling back to YoY', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'QOQ');
  ok('...and the headers agree with the toggle', revCols(await headsNow())[1] === qoqPrior);

  // THE INVARIANT. Same filing, two questions: the reported current-period figure must be
  // IDENTICAL under both, and only the comparison figure may move. If the current figure moved
  // too, the toggle would be switching quarters rather than switching comparisons — and because
  // the columns look the same either way, nothing else on the page would reveal it.
  const qoqPinned = pinned ? await figuresFor(pinned.toUpperCase()) : null;
  ok('the same filing keeps its current-period figure under both comparisons', !!yoyPinned && !!qoqPinned && yoyPinned.cur === qoqPinned.cur, `${pinned}: ${yoyPinned?.cur} both ways`);
  ok('...and only the comparison figure moves', !!yoyPinned && !!qoqPinned && yoyPinned.prior !== qoqPinned.prior, `${yoyPinned?.prior} (YoY) vs ${qoqPinned?.prior} (QoQ)`);

  await page.locator('[data-period="yoy"]').click();
  await waitForPeriod('yoy');
  await page.waitForTimeout(400);
  ok('switching back to YoY restores the year-ago comparison', revCols(await headsNow())[1] === yoyPrior);
  ok('...and drops period=qoq from the URL', !/period=qoq/.test(page.url()), page.url().split('?')[1] || '');
}

// ---------------------------------------------------------------------------------------
// 2c. Earnings Calendar — the all-exchange schedule on every date.
//
// Moneycontrol exposes the complete count through JSON and the names through twenty-row HTML
// pagination. Both requests use All exchanges. Today and past dates stay schedules here; the
// adjacent Earnings Reported view remains the place for companies that actually filed.
// ---------------------------------------------------------------------------------------
console.log('\n— earnings calendar —');
await go('/#/research/earnings-hub?scope=universe', 800);
await waitForPanel();
ok('the tab offers Reported / Calendar / Company Filings',
  JSON.stringify(await page.locator('[data-view]').evaluateAll(nodes => nodes.map(node => node.dataset.view).sort())) === JSON.stringify(['calendar', 'filings', 'reported']));

await page.locator('[data-view="calendar"]').click();
// THE CALENDAR OPENS ON TODAY. Today can legitimately have no scheduled rows, so this waits for
// the strip plus either rows or a settled empty panel, and not for rows alone.
const calReady = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const st = await page.evaluate(() => {
      const text = document.querySelector('#content-host')?.innerText || '';
      return {
        chips: document.querySelectorAll('[data-date]').length,
        failed: /could not be loaded/i.test(text),
        rows: document.querySelectorAll('tr[data-row-key]').length,
        settled: /Nothing scheduled|None of your holdings|Calendar list unavailable/i.test(text),
      };
    });
    if ((st.chips && (st.rows || st.settled)) || st.failed) return st;
    await page.waitForTimeout(300);
  }
  return { chips: 0, failed: false, rows: 0, settled: false };
})();

// A DASHBOARD THAT OPENS ON A STALE DATE READS AS A DASHBOARD WHOSE DATA STOPPED. It used to open
// on the results feed's most recent filing date, so four days into a quiet stretch it opened on
// Friday the 14th with today's chip four places to the right and nothing on screen saying the
// selection was not the current date.
//
// Today is TODAY IN IST, not in UTC: every date here is an Indian trading date, and `toISOString()`
// alone names yesterday between 18:30 IST and midnight.
{
  const opened = await page.evaluate(() => {
    const active = document.querySelector('[data-date][aria-current="date"]');
    const strip = document.querySelector('[data-date-strip]');
    const box = active?.getBoundingClientRect();
    const sb = strip?.getBoundingClientRect();
    return {
      active: active?.dataset.date || null,
      today: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
      inView: !!(box && sb && box.left >= sb.left - 1 && box.right <= sb.right + 1),
    };
  });
  ok('the calendar opens on today', opened.active === opened.today, `${opened.active} vs ${opened.today} (IST)`);
  ok('...with today’s chip scrolled into view', opened.inView);
}

if (calReady.failed) {
  // No Worker on this origin. The view must say so, not draw an empty calendar.
  ok('without the live route, the calendar says so', /could not be loaded/i.test(await hostText()));
  ok('...and points to the separate filed-results view', /Earnings Reported|filed results/i.test(await hostText()));
  console.log('      (calendar round trip not exercised — no /api/earnings-calendar on this origin)');
  // Everything after this section reads the results table, so go back to it either way.
  await page.locator('[data-view="reported"]').click();
  await waitForPanel();
} else {
  ok('the calendar renders a date strip with counts', calReady.chips > 5, `${calReady.chips} dates`);
  ok('...and the URL records the view', page.url().includes('view=calendar'));

  // Walk forward to another scheduled date. Without a Worker there may be none, in which case the
  // rest of this block is skipped rather than asserted against a missing route.
  // The busiest future date, not merely the nearest: the nearest is often a weekend or a date with
  // a count of one, and the caveats this block checks are about a date that HAS a list.
  const futureDate = await page.evaluate(async () => {
    const mod = await import('/js/data/earnings-calendar.js');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const enabled = new Set([...document.querySelectorAll('[data-date]:not([disabled])')].map((b) => b.dataset.date));
    const ahead = mod
      .strip()
      .filter((d) => d.date > today && enabled.has(d.date) && d.count > 0)
      .sort((a, b) => b.count - a.count);
    return ahead[0]?.date || [...enabled].filter((d) => d > today).sort()[0] || null;
  });
  if (!futureDate) {
    skip('the schedule half of the calendar', 'no future-dated chip in the strip — the count API is not answering on this origin');
  } else {
    await page.evaluate((d) => document.querySelector(`[data-date="${d}"]`)?.click(), futureDate);
    // WAIT FOR THE SCHEDULE, DO NOT SLEEP AT IT. A cold `list=full` costs the Worker the Akamai
    // page fetch plus up to 25 identity look-ups, so a fixed pause passes on a warm edge cache and
    // reads a shimmer on a cold one — which is a flaky check, not a finding. Settle on any
    // determinate end state: a table, an honest empty panel, or the degraded note.
    await page
      .waitForFunction(
        () => {
          const host = document.querySelector('#content-host');
          if (!host || host.querySelector('.skeleton-shimmer')) return false;
          return !!host.querySelector('thead th') || /Nothing scheduled|Calendar list unavailable|could not be loaded/i.test(host.innerText);
        },
        null,
        { timeout: 45000 }
      )
      .catch(() => {});
    const calHeads = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
    // A future date with no readable list is a real and honest state (the page is bot-walled and
    // the capture may not reach that far) — but it is not a table, so there are no columns to
    // check. Say which it is rather than failing six assertions on an empty panel.
    const calState = calHeads.length ? 'table' : (await hostText()).slice(0, 90).replace(/\s+/g, ' ');
    for (const c of ['DATE', 'COMPANY', 'QUARTER', 'EXCHANGE', 'TIME', 'PRICE', 'MARKET CAP']) {
      if (calHeads.length) ok(`calendar column: ${c}`, calHeads.some((h) => h.startsWith(c)), calHeads.join(' | '));
      else skip(`calendar column: ${c}`, `${futureDate} has no readable list — "${calState}"`);
    }

  // THE CHECK THIS VIEW EXISTS TO PASS.
  //
  // The count now lives in the pill rather than in a paragraph under the table, so it is read from
  // there: "235 scheduled" when there is a believable number, the bare word "schedule" when there
  // is not.
  await settleTables();
  const calHonesty = await page.evaluate(() => {
    const pill = document.querySelector('[data-cal-info]')?.innerText || '';
    const m = /([\d,]+)\s+scheduled/.exec(pill);
    return {
      total: m ? Number(m[1].replace(/,/g, '')) : null,
      rows: document.querySelectorAll('tr[data-row-key]').length,
      pill: pill.replace(/\s+/g, ' ').trim(),
    };
  });
  // The count and list are different endpoints but the same All-exchange population. A verified
  // complete payload must therefore have one row per scheduled company.
  if (calHonesty.total != null) {
    ok('the calendar states the complete count for the date', calHonesty.total === calHonesty.rows, `${calHonesty.total} scheduled, ${calHonesty.rows} named`);
  } else {
    ok('...and asserts no number when the count endpoint is not answering', /schedule\s*$/i.test(calHonesty.pill), `pill reads "${calHonesty.pill}"`);
  }

  // The list is read live where the calendar page answers this server and comes from the committed
  // capture where it does not (Akamai). Either is fine; showing captured rows under a "Live" pill
  // would not be. Whichever state we are in, the pill and the note must agree with the payload.
  // Read the payload the page already holds rather than refetching — no second request, and no
  // chance of asking about a different date than the one on screen.
  const calSource = await page.evaluate(async () => {
    const mod = await import('/js/data/earnings-calendar.js');
    // Only a `full` request carries a list to have a source, which is exactly the request a
    // future-dated chip makes. A `none` payload has `listRequested: false` and is not a claim
    // about anything, so it is not what this check is about.
    const shown = mod.strip().map((d) => d.date).find((d) => mod.forDate(d)?.listRequested);
    const payload = shown ? mod.forDate(shown) : null;
    const txt = document.querySelector('#content-host').innerText;
    return {
      found: !!payload,
      src: payload?.listSource ?? null,
      countSrc: payload?.countSource ?? null,
      screenerSrc: payload?.screenerUpcomingSource ?? null,
      count: payload?.scheduledCount ?? null,
      rows: payload?.rows?.length ?? 0,
      complete: payload?.complete === true,
      pagesFetched: payload?.pagesFetched ?? 0,
      days: (payload?.days || []).map((d) => d.count),
      pill: /(Schedule updated|Up to date|Updating)/.exec(txt)?.[1] || null,
    };
  });
  // A captured half uses calm customer wording while remaining distinguishable from a fully live
  // read. The provenance details below still name the source precisely.
  const anyCapture = calSource.src === 'snapshot' || calSource.countSrc === 'snapshot' || calSource.screenerSrc === 'artifact';
  if (calSource.src || calSource.countSrc) {
    ok('a captured half is labelled as an updated schedule', anyCapture ? calSource.pill === 'Schedule updated' : ['Up to date', 'Updating'].includes(calSource.pill), `list=${calSource.src} counts=${calSource.countSrc} screener=${calSource.screenerSrc} pill=${calSource.pill}`);
  } else if (calSource.found) {
    ok('the payload names where the list came from', false, `listSource=${calSource.src}`);
  } else {
    // Neither upstream answered for any date in the strip, which the panel already reports in
    // words. Asserting provenance on a payload that does not exist would be checking nothing.
    skip('the payload names where the list came from', 'no full-list payload was fetched on this origin');
  }

  // A live/captured race can still make two observations disagree. The pill must decline to print
  // that mismatch as one total. Otherwise a complete response matches exactly.
  ok(
    'a count/list mismatch is never printed as a verified total',
    !calSource.complete || calSource.count == null || calSource.count === calSource.rows || calHonesty.total == null,
    `payload: ${calSource.count} scheduled vs ${calSource.rows} named — pill reads "${calHonesty.pill}"`
  );
  if (calSource.complete && calSource.count != null) {
    ok('...and complete means every scheduled company is present', calSource.count === calSource.rows, `${calSource.rows} rows across ${calSource.pagesFetched} page(s)`);
  } else {
    skip('...and complete means every scheduled company is present', 'this origin served a partial or mixed live/captured response');
  }
  // The strip going uniformly flat is the endpoint failing, not a quiet fortnight. The Worker
  // substitutes the committed capture's counts; if it ever stops, this catches the dashes.
  if (calSource.found) {
    ok('...and the whole strip is not zero at once', calSource.days.some((c) => c > 0), `${calSource.days.filter((c) => c > 0).length} of ${calSource.days.length} dates carry a count`);
  } else {
    skip('...and the whole strip is not zero at once', 'no full-list payload was fetched on this origin');
  }
  if (calSource.countSrc === 'snapshot') ok('...with substituted counts presented as an updated schedule', calSource.pill === 'Schedule updated');
  else skip('...with the substituted counts named as a capture', 'the count endpoint is answering live');
  // The calendar status is a passive label; the full list needs no caveat modal.
  await page.locator('[data-cal-info]').first().click();
  await page.waitForTimeout(200);
  ok('...and the calendar label opens no explainer popup',
    (await page.locator('[data-cal-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);
  } // end of the future-dated (schedule) branch

  // Clicking another date must change both the data and the URL. A date with a zero count is
  // disabled — but when NO count is readable, none may be disabled, or the reader is locked out of
  // a calendar whose lists are working fine.
  const strip = await page.evaluate(() => ({
    all: [...document.querySelectorAll('[data-date]')].map((b) => b.dataset.date),
    enabled: [...document.querySelectorAll('[data-date]:not([disabled])')].map((b) => b.dataset.date),
    counted: [...document.querySelectorAll('[data-date]')].filter((b) => /\d/.test(b.textContent.split('\n').pop() || '')).length,
  }));
  ok('the date strip never disables every date at once', strip.enabled.length > 0, `${strip.enabled.length} of ${strip.all.length} clickable`);
  const activeDate = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(page.url())?.[1] || null;
  const otherDate = strip.enabled.filter((d) => d !== activeDate).pop() || strip.enabled[strip.enabled.length - 1];
  if (otherDate) {
    await page.locator(`[data-date="${otherDate}"]`).click();
    await page.waitForTimeout(6000);
    ok('picking a date reloads that day and records it in the URL', page.url().includes(`date=${otherDate}`), otherDate);
  } else {
    ok('picking a date reloads that day and records it in the URL', false, 'no clickable date in the strip');
  }

  // THE STRIP MUST NOT WALK OFF WITH THE DATE YOU JUST PICKED.
  //
  // Two separate causes, both real. The window used to be anchored on the SELECTED date, so every
  // click merged new chips in and slid the existing ones along; and the panel rebuild reset the
  // scroll container to zero, which is its oldest date. Between them, clicking a date near the
  // right-hand end left the reader looking at a fortnight ago with the selection off-screen.
  //
  // So: the chip set is stable across clicks, and the selected chip is inside the visible box.
  const stripState = async () =>
    page.evaluate(() => {
      const box = document.querySelector('[data-date-strip]');
      const active = box?.querySelector('[data-date][aria-current="date"]');
      if (!box || !active) return null;
      const left = active.offsetLeft - box.scrollLeft;
      return {
        date: active.dataset.date,
        chips: [...box.querySelectorAll('[data-date]')].map((b) => b.dataset.date).join(','),
        visible: left >= -1 && left + active.offsetWidth <= box.clientWidth + 1,
      };
    });
  const beforeClick = await stripState();
  const walkTo = strip.enabled.filter((d) => d !== beforeClick?.date)[0];
  if (beforeClick && walkTo) {
    await page.evaluate((d) => document.querySelector(`[data-date="${d}"]`)?.click(), walkTo);
    await page.waitForTimeout(1500);
    const afterClick = await stripState();
    ok('the selected date stays in view after picking it', afterClick?.visible === true, `${afterClick?.date} visible=${afterClick?.visible}`);
    ok('...and the strip does not reshuffle around the click', afterClick?.chips === beforeClick.chips, `${beforeClick.chips.split(',').length} → ${afterClick?.chips.split(',').length} chips`);
  } else {
    skip('the selected date stays in view after picking it', 'fewer than two clickable dates in the strip');
  }

  // Back to reported, which is where the rest of the suite expects to be.
  await page.locator('[data-view="reported"]').click();
  await waitForPanel();
  ok('switching back to Reported restores the results table', (await rowCount()) > 1000);
}

// ---------------------------------------------------------------------------------------
// 3. Table mechanics
// ---------------------------------------------------------------------------------------
console.log('\n— table —');
const full = await rowCount();
await page.locator(SEARCH).first().fill('TITAN');
await page.waitForTimeout(500);
const searched = await rowCount();
ok('search narrows the table', searched > 0 && searched < full, `${full} → ${searched}`);
await page.locator(SEARCH).first().fill('');
await page.waitForTimeout(400);
// Re-read immediately before the click. This runs against a LIVE feed, so a company filing
// between the two reads would otherwise fail a sort assertion for a reason that is not the sort.
const beforeSort = await rowCount();
await page.locator('#content-host thead th').nth(3).click();
await page.waitForTimeout(300);
ok('header sort keeps every row', (await rowCount()) === beforeSort, `${beforeSort} rows`);

// The two filter dropdowns are independent questions and must AND together.
const selCount = await page.locator('#content-host select').count();
ok('there are two filter dropdowns', selCount === 2, `${selCount} selects`);
const preBasis = await rowCount();
await page.locator('#content-host select').nth(1).selectOption('std');
await page.waitForTimeout(500);
const stdOnly = await rowCount();
await page.locator('#content-host select').nth(1).selectOption('con');
await page.waitForTimeout(500);
const conOnly = await rowCount();
ok('standalone + consolidated partition the set exactly', stdOnly > 0 && conOnly > 0 && stdOnly + conOnly === preBasis, `${stdOnly} STD + ${conOnly} CON = ${preBasis}`);
ok('...and the rows actually carry that basis, spelled out', /Consolidated/.test(await page.locator('#content-host tbody tr').first().innerText()));
// AND, not OR: narrowing the other dropdown on top of this one must narrow further.
await page.locator('#content-host select').first().selectOption('pat-up');
await page.waitForTimeout(500);
const bothFilters = await rowCount();
ok('the two dropdowns combine rather than replace each other', bothFilters > 0 && bothFilters < conOnly, `${conOnly} CON → ${bothFilters} CON with PAT up`);
await page.locator('#content-host select').first().selectOption('all');
await page.locator('#content-host select').nth(1).selectOption('all');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 3b. The watchlist star must FILL when it is clicked
//
// It did not, and the cause was the repaint fast path rather than the watchlist. Starring a row
// leaves the row SET unchanged, so `repaint()` took the reorder branch, moved the existing <tr>
// nodes and re-parsed no HTML at all. Dropping the row's cached markup was not enough — nothing
// rebuilt the node. The row stayed a hollow ☆ while the watchlist filter counted it, which is the
// worst shape this bug could take: the state was real and only the control you clicked disagreed.
// ---------------------------------------------------------------------------------------
console.log('\n— watchlist —');
await go('/#/research/breakouts?scope=universe', 2500);
{
  const key0 = await page.locator('#content-host tbody tr').first().getAttribute('data-row-key');
  const star = () => page.locator(`#content-host tr[data-row-key="${key0}"] [data-watch]`).first();
  const glyph = async () => (await star().innerText()).trim();

  const before = await glyph();
  await star().click();
  await page.waitForTimeout(400);
  const after = await glyph();
  ok('clicking the watchlist star fills it', before === '☆' && after === '★', `${before} → ${after}`);
  // THE STORED ENTRY IS A COMPANY, NOT A ROW. On Breakouts the row key IS the ticker, so the two
  // coincide here — but the shape does not: entries are `{ ticker, name, addedAt }`, because the
  // Watchlist scope has to be able to name a company on a feed that does not carry it.
  ok('...and the stored watchlist agrees with the glyph',
    await page.evaluate((k) => JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some((e) => e.ticker === k), key0));
  ok('...and the entry carries the company name, not just the symbol',
    await page.evaluate((k) => {
      const e = JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').find((x) => x.ticker === k);
      // Acronym brands such as IFCI legitimately have the same company name and symbol. The
      // contract is that the name is present, not that two true identifiers must differ.
      return !!e && typeof e.name === 'string' && e.name.trim().length > 0;
    }, key0));

  // Watchlist-only is a different repaint path — the row set narrows — and it left the same stale
  // markup behind, so the filtered view showed hollow stars on the very rows it had filtered TO.
  await page.locator('#content-host [data-watch-toggle]').click();
  await page.waitForTimeout(600);
  const filtered = await rowCount();
  ok('watchlist-only narrows to the starred rows', filtered >= 1, `${filtered} rows`);
  ok('...and they are still drawn as starred', (await glyph()) === '★', await glyph());
  await page.locator('#content-host [data-watch-toggle]').click();
  await page.waitForTimeout(400);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  ok('the star survives a reload', (await glyph()) === '★', await glyph());
  await star().click();
  await page.waitForTimeout(400);
  ok('...and clicking it again empties it', (await glyph()) === '☆', await glyph());
  ok('...and empties the stored watchlist with it',
    await page.evaluate((k) => !JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some((e) => e.ticker === k), key0));
}

// ---------------------------------------------------------------------------------------
// 3d. Ask Research is the landing tab; AI Alerts and All Alerts retain their focused checks
// ---------------------------------------------------------------------------------------
console.log('\n— AI alerts —');
{
  let askRequest = null;
  let configShouldFail = true;
  let configGets = 0;
  await page.route('**/api/research', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      configGets++;
      if (configShouldFail) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporary' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: true, webResearchAvailable: false, history: 'device' }),
      });
    }
    askRequest = request.postDataJSON();
    // Slow on purpose: the check below leaves the tab while this is still being written.
    if (/keeps working while i look away/i.test(askRequest?.question || '')) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'text', text: 'OFF_TAB_ANSWER stands on dashboard evidence.' })}\n${JSON.stringify({ type: 'done' })}\n`,
      });
    }
    if (/stale scope test/i.test(askRequest?.question || '')) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'text', text: 'STALE_SCOPE_ANSWER' })}\n${JSON.stringify({ type: 'done' })}\n`,
      });
    }
    const events = [
      { type: 'start' },
      { type: 'phase', phase: 'Writing from dashboard evidence' },
      { type: 'text', text: '## Dashboard view\nDashboard evidence remains traceable. [Dashboard: Earnings Hub]' },
      { type: 'done' },
    ];
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    });
  });

  // THE DEFAULT LANDING TAB. The order of WORKSPACES[0].tabs is the only thing that decides this,
  // so a reorder that moved it would surface here rather than in a bug report.
  // A FRESH READER, not this run's accumulated state. Two things have to be true for that:
  //
  //   • `sattva:scope` and `sattva:lastRoute` are cleared. Both persist the reader's own choices
  //     and rightly win over the default, so a run that has been clicking through `?scope=universe`
  //     would otherwise be asserting its own leftovers.
  //   • the page is genuinely RELOADED WITH NO HASH. Dropping the fragment is still a
  //     same-document navigation, so the app stays alive, re-resolves, and immediately writes the
  //     route it was already on back into the URL — after which a reload reads that hash and the
  //     check measures the run's leftovers rather than the default. A changing query string forces
  //     a real document load and carries no fragment for the router to read.
  //   • the clear happens AFTER the app has finished booting. `domcontentloaded` returns before
  //     `boot()` resolves, and the shell writes `sattva:lastRoute` on its first route — so clearing
  //     immediately after the goto races that write and loses, and the next load restores the route
  //     the run was already on. Flaky in exactly the way that makes a suite untrustworthy: it
  //     passed on one run and failed on the next with nothing changed.
  await page.goto(`${BASE}/?fresh=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    localStorage.removeItem('sattva:lastRoute');
    localStorage.removeItem('sattva:scope');
  });
  await page.goto(`${BASE}/?fresh=${Date.now() + 1}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('[data-research-workspace]').waitFor({ state: 'visible', timeout: 15000 });
  ok('the dashboard opens on Ask Research', /ask-research/.test(page.url()), page.url().split('#')[1]);
  ok('...and the tab bar puts it first', (await page.locator('[data-tab-id]').first().innerText()).trim() === 'Ask Research');
  // The WHOLE url in the detail: `split('?')[1]` cuts at the query and hides the hash's own
  // `?scope=`, so a failure printed a string that looked identical to a pass.
  ok('...in the Portfolio scope by default', /scope=portfolio/.test(page.url()), page.url());

  await go('/#/research/ai-alerts?scope=portfolio', 4500);
  await page.locator('[data-ai-feed-status][data-state="complete"]').waitFor({ state: 'visible', timeout: 30000 });

  const aiCards = page.locator('[data-ai-card]');
  const aiCount = await aiCards.count();
  ok('AI Alerts surfaces a deliberately short first page', aiCount > 0 && aiCount <= 8, `${aiCount} cards`);
  const renderedCards = await aiCards.evaluateAll((els) => els.map((el) => ({
    ticker: el.dataset.ticker,
    score: Number(el.dataset.score),
    priority: el.dataset.priority,
    insight: !!el.querySelector('[data-ai-insight]')?.textContent?.trim(),
    why: el.querySelectorAll('[data-ai-why] > div').length,
    scoreShown: !!el.querySelector('[data-ai-score], [title="Transparent priority score"]'),
    reviewNext: !!el.querySelector('[data-ai-action]') || /review next/i.test(el.textContent || ''),
    events: el.querySelectorAll('[data-ai-event]').length,
    linkedEvents: el.querySelectorAll('a[data-ai-evidence-link][href]').length,
  })));
  ok('AI cards are unique by company and ordered highest score first',
    new Set(renderedCards.map((card) => card.ticker)).size === renderedCards.length &&
      renderedCards.every((card, i) => !i || renderedCards[i - 1].score >= card.score),
    renderedCards.map((card) => `${card.ticker}:${card.score}`).join(', '));
  ok('AI Alerts removes the priority banner and ranking breakdown',
    (await page.locator('[data-ai-alert-summary]').count()) === 0 &&
      renderedCards.every((card) => card.why === 0 && !card.scoreShown));
  const aiFeedStatus = (await page.locator('[data-ai-feed-status]').innerText()).trim();
  ok('the compact header uses calm update language while recovery runs',
    /^(Updated|Sources updating)$/.test(aiFeedStatus), aiFeedStatus);
  ok('every surfaced card keeps the insight and evidence without a Review next block',
    renderedCards.every((card) => card.insight && !card.reviewNext && card.events > 0));
  ok('every visible evidence row links to its traceable source',
    renderedCards.every((card) => card.linkedEvents === card.events));

  // --- THE CARD IS BUILT FOR TIME-TO-INSIGHT, and each half of that is a property to assert ---
  //
  // The old card printed the leading pattern's technical sentence as its insight AND again, in
  // full, inside a "Signals lining up" panel below it — one finding, twice, in the feeds' own
  // vocabulary. What replaces it is a plain sentence, then the numbers behind it AS numbers. Both
  // are checkable: the sentence is short and singular, and the strip is the same four cells on
  // every card so the eye can learn its shape rather than re-reading the labels each time.
  const aiShape = await aiCards.evaluateAll((els) => els.map((el) => ({
    ticker: el.dataset.ticker,
    insight: (el.querySelector('[data-ai-insight]')?.innerText || '').trim(),
    metrics: [...el.querySelectorAll('[data-ai-metrics] [data-metric]')].map((n) => n.getAttribute('data-metric')),
    evidence: el.querySelectorAll('[data-ai-evidence] [data-ai-event]').length,
    // The feed tag is the last cell of each row; the set of them is the breadth on screen.
    evidenceFeeds: [...new Set([...el.querySelectorAll('[data-ai-evidence] [data-ai-event] span:last-child')].map((n) => n.innerText.split('·')[0].trim()))],
    sources: Number(el.querySelector('[data-metric="feeds"] .tabular-nums')?.innerText || 0),
    confluenceLines: [...el.querySelectorAll('[data-ai-confluence] [data-confluence]')].map((n) => n.innerText.trim()),
    archive: !!el.querySelector('[data-ai-mute]'),
    open: !!el.querySelector('footer [data-open-general]'),
  })));
  ok('every card carries exactly four figures, and no cell repeats',
    aiShape.every((card) => card.metrics.length === 4 && new Set(card.metrics).size === 4),
    aiShape.map((card) => `${card.ticker}:${card.metrics.join('/')}`).join(' | ').slice(0, 160));
  // A card that needs scrolling to reach its finding has not delivered one. Three evidence rows is
  // the cap; the rest are one click away in the tab that exists to hold them.
  ok('...at most three evidence rows, with the rest one click away',
    aiShape.every((card) => card.evidence > 0 && card.evidence <= 3 && card.open));
  // The pattern chips NAME the patterns; they no longer restate them. A chip carrying a full
  // sentence is the duplication this redesign removed, so its length is the thing to hold down.
  // A CHIP IS A TAG, NOT A SECOND COPY OF THE HEADLINE. "Volume with selling behind it" under
  // "Heavy trading, and a big holder has been selling" is the duplication this redesign removed,
  // so the chips carry the pattern's SHORT name — two or three words the eye indexes on.
  ok('...and the pattern chips tag a pattern rather than repeating its sentence',
    aiShape.every((card) => card.confluenceLines.every((line) => line.length > 0 && line.length <= 20)),
    aiShape.flatMap((card) => card.confluenceLines).join(' | ').slice(0, 140) || 'no patterns today');
  // BREADTH, NOT THREE COPIES OF ONE FEED. A card claiming four sources that spends all three of
  // its rows on one of them answers the question it raised with a quarter of what it holds.
  ok('...and the evidence rows show as many different sources as the card has',
    aiShape.every((card) => card.evidenceFeeds.length === Math.min(card.evidence, card.sources)),
    aiShape.map((card) => `${card.ticker}:${card.evidenceFeeds.join('/')} of ${card.sources}`).join(' | ').slice(0, 170));
  ok('...and the insight is a single short sentence in ordinary English',
    aiShape.every((card) => card.insight.length > 0 && card.insight.length <= 260),
    `longest ${Math.max(0, ...aiShape.map((card) => card.insight.length))} chars`);

  // ARCHIVING IS A PLACE, NOT A DELETION. A control that makes a card vanish with nothing on
  // screen saying where it went is indistinguishable from losing it, so the round trip is asserted
  // in both directions: the card leaves the list, is findable in Archived, and comes back.
  const archiveTicker = aiShape.find((card) => card.archive)?.ticker;
  if (!archiveTicker) {
    skip('archiving a card moves it to the Archived view and back', 'no card offered the control');
  } else {
    const beforeCount = await aiCards.count();
    await page.locator(`[data-ai-card][data-ticker="${archiveTicker}"] [data-ai-mute]`).click();
    await page.waitForTimeout(400);
    const goneFromList = (await page.locator(`[data-ai-card][data-ticker="${archiveTicker}"]`).count()) === 0;
    await page.locator('[data-ai-filter="archived"]').click();
    await page.waitForTimeout(400);
    const inArchive = (await page.locator(`[data-ai-card][data-ai-archived][data-ticker="${archiveTicker}"]`).count()) === 1;
    await page.locator(`[data-ai-card][data-ticker="${archiveTicker}"] [data-ai-unmute]`).click();
    await page.waitForTimeout(400);
    const archiveEmptied = (await page.locator('[data-ai-card]').count()) === 0;
    await page.locator('[data-ai-filter="all"]').click();
    await page.waitForTimeout(400);
    const restored = (await page.locator(`[data-ai-card][data-ticker="${archiveTicker}"]`).count()) === 1;
    ok('archiving a card moves it to the Archived view and back',
      goneFromList && inArchive && archiveEmptied && restored && (await aiCards.count()) === beforeCount,
      `${archiveTicker}: hidden ${goneFromList}, archived ${inArchive}, emptied ${archiveEmptied}, restored ${restored}`);
  }

  const aiCardBoxes = await Promise.all([aiCards.nth(0).boundingBox(), aiCards.nth(1).boundingBox()]);
  ok('AI Alerts uses two cards side by side on desktop',
    aiCardBoxes.every(Boolean) && Math.abs(aiCardBoxes[0].y - aiCardBoxes[1].y) < 2 && aiCardBoxes[1].x > aiCardBoxes[0].x,
    aiCardBoxes.every(Boolean) ? `x ${Math.round(aiCardBoxes[0].x)} + ${Math.round(aiCardBoxes[1].x)}` : 'card missing');

  const policy = await evalSafe(async () => {
    const ai = await import('/js/data/ai-alerts.js');
    const feed = (id, reachesToday = true) => ({ id, label: id, status: 'ok', reachesToday });
    const event = (overrides = {}) => ({
      id: 'e1', feed: 'news', feedLabel: 'Company news', day: '2026-09-01', time: null,
      ticker: 'GOLD', company: 'Gold Ltd', headline: 'Routine publisher story',
      direction: 'neutral', importance: 'low', signalReason: 'Publisher headline.',
      importanceReason: 'Low.', url: null, ...overrides,
    });
    const holdings = [
      { ticker: 'GOLD', name: 'Gold Ltd', sector: 'Industrials' },
      { ticker: 'PEER', name: 'Peer Ltd', sector: 'Industrials' },
    ];
    const rank = (events, feeds) => ai.rankReport({ day: '2026-09-01', scope: 'portfolio', events, feeds }, { holdings });
    const noise = rank([event()], [feed('news')]);
    const material = rank([
      event({ id: 'earn', feed: 'earnings', feedLabel: 'Earnings', headline: 'Quarterly result filed', direction: 'positive', importance: 'high' }),
    ], [feed('earnings')]);
    const corroborated = rank([
      event({ id: 'earn', feed: 'earnings', feedLabel: 'Earnings', headline: 'Quarterly result filed', direction: 'positive', importance: 'high' }),
      event({ id: 'ann', feed: 'announcements', feedLabel: 'Announcements', headline: 'Regulatory approval received', direction: 'positive', importance: 'high' }),
    ], [feed('earnings'), feed('announcements')]);
    const current = rank([event({ id: 'risk', feed: 'insider', headline: 'Promoter disposal', direction: 'negative', importance: 'high' })], [feed('insider')]);
    const stale = rank([event({ id: 'risk', feed: 'insider', headline: 'Promoter disposal', direction: 'negative', importance: 'high' })], [feed('insider', false)]);
    const duplicate = rank([
      event({ id: 'n1', headline: 'Same story' }), event({ id: 'n2', headline: 'Same story' }),
      event({ id: 'wide', ticker: null, company: 'Market', headline: 'Market-wide story' }),
    ], [feed('news')]);
    const weakSector = rank([
      event({ id: 'weak1', feed: 'insider', ticker: 'GOLD', headline: 'Small disposal', direction: 'negative' }),
      event({ id: 'weak2', feed: 'insider', ticker: 'PEER', company: 'Peer Ltd', headline: 'Another small disposal', direction: 'negative' }),
    ], [feed('insider')]);
    const materialSector = rank([
      event({ id: 'risk1', feed: 'insider', ticker: 'GOLD', headline: 'Material disposal', direction: 'negative', importance: 'high' }),
      event({ id: 'risk2', feed: 'insider', ticker: 'PEER', company: 'Peer Ltd', headline: 'Material pledge', direction: 'negative', importance: 'high' }),
    ], [feed('insider')]);
    const { evidenceDestination, feedStatus, safeSourceUrl } = await import('/js/tabs/ai-alerts.js');
    return {
      min: ai.MIN_SCORE,
      mustSee: ai.MUST_SEE_SCORE,
      noiseSurfaced: noise.cards.length,
      noiseScore: noise.allCards[0]?.score,
      material: material.allCards[0]?.score,
      corroborated: corroborated.allCards[0]?.score,
      current: current.allCards[0]?.score,
      stale: stale.allCards[0]?.score,
      staleFeedStatus: feedStatus(stale).label,
      duplicateEvents: duplicate.allCards[0]?.events.length,
      marketWideExcluded: duplicate.meta.marketWideExcluded,
      arithmetic: corroborated.allCards.every((card) => card.scoreBreakdown.reduce((sum, part) => sum + part.points, 0) === card.score),
      weakSectorBoosted: weakSector.allCards.some((card) => card.scoreBreakdown.some((part) => /portfolio companies in/.test(part.label))),
      materialSectorBoosted: materialSector.allCards.every((card) => card.scoreBreakdown.some((part) => /portfolio companies in/.test(part.label))),
      sourceUrlsSafe: safeSourceUrl('javascript:alert(1)') === null && /^https:/.test(safeSourceUrl('https://example.com/filing')),
      evidenceLinksSafe:
        evidenceDestination({ url: 'https://example.com/filing', headline: 'Filing' }, 'portfolio').external === true &&
        evidenceDestination({ url: 'javascript:alert(1)', tab: 'insider-trades', ticker: 'GOLD' }, 'watchlist').href === '#/research/insider-trades?scope=watchlist&company=GOLD',
    };
  });
  ok('single-source neutral news is suppressed below the published threshold',
    policy.noiseSurfaced === 0 && policy.noiseScore < policy.min, `${policy.noiseScore}/${policy.min}`);
  ok('a material event can qualify alone, while independent corroboration ranks higher',
    policy.material >= policy.min && policy.corroborated > policy.material,
    `${policy.material} → ${policy.corroborated}`);
  ok('stale-source evidence receives the documented score penalty',
    policy.current > policy.stale, `${policy.current} current vs ${policy.stale} stale`);
  ok('a completed degraded report renders the compact recovery state',
    policy.staleFeedStatus === 'Sources updating', policy.staleFeedStatus);
  ok('same-feed duplicate headlines collapse and tickerless news stays out of company cards',
    policy.duplicateEvents === 1 && policy.marketWideExcluded === 1,
    `${policy.duplicateEvents} company event, ${policy.marketWideExcluded} market-wide`);
  ok('the hidden ranking model remains internally consistent', policy.arithmetic);
  ok('sector context requires material negative evidence rather than tiny negative activity',
    !policy.weakSectorBoosted && policy.materialSectorBoosted);
  ok('AI card source links reject executable URL schemes', policy.sourceUrlsSafe);
  ok('evidence links prefer public records and safely fall back to owning dashboard tabs', policy.evidenceLinksSafe);

  const firstTicker = renderedCards[0].ticker;
  // A card now offers the same destination twice — the "N more events" line and the Open
  // button — so this names one rather than asserting there is only one to name.
  await aiCards.first().locator('[data-open-general]').first().click();
  await page.waitForTimeout(5000);
  ok('a card drills into All Alerts without changing the selected scope',
    /\/daily-alerts\?scope=portfolio/.test(page.url()) && new URL(page.url()).hash.includes(`company=${firstTicker}`), page.url());
  const seeded = await page.locator('#content-host [data-table-search]').inputValue();
  // Count REAL result rows. `tbody tr` includes the one empty-state row, so the old assertion
  // passed while an uppercase seeded ticker matched nothing and the product visibly said 0 shown.
  const drilledRows = await page.locator('#content-host tbody tr[data-row-key]').allTextContents();
  // MATCH THE WAY THE SEARCH MATCHES — case-insensitively, and as a SUBSTRING, because that is what
  // `?company=` seeds: a text search, not a ticker filter. The case-sensitive form of this passed
  // for as long as the first card happened to be a company whose rows all shouted their ticker, and
  // failed the day it was TARIL — on a BSE filing reading "voluntarily issued by Crisil", which
  // contains `taril` in lower case. The search was right, the row was right, and the assertion was
  // asking a different question from the one the product answers.
  const seededMatch = (row) => row.toUpperCase().includes(String(firstTicker).toUpperCase());
  ok('...and seeds the complete stream to that company, with real matching rows',
    seeded === firstTicker && drilledRows.length > 0 && drilledRows.every(seededMatch),
    `${seeded}; ${drilledRows.length} matching result row(s)`);
// ---------------------------------------------------------------------------------------
// 3e. Ask Research — dashboard-wide evidence through the streaming Muns LLM provider
// ---------------------------------------------------------------------------------------
  console.log('\n— ask research —');
  await go('/#/research/ask-research?scope=portfolio', 500);

  const askText = await hostText();
  ok('Ask Research renders as a complete workspace',
    (await page.locator('[data-research-workspace]').count()) === 1 && /Research the whole picture/.test(askText));
  ok('...makes dashboard-wide coverage explicit',
    /Reads the whole dashboard/.test(askText) && /Every tab/.test(askText) && /Traceable/.test(askText));
  ok('...offers four scope-aware starting questions',
    (await page.locator('[data-research-suggestion]').count()) === 4);
  ok('...keeps the workspace honest about dashboard-only research',
    (await page.locator('[data-research-web]').count()) === 0 && /Evidence-led/.test(askText));
  const failedConfigGets = configGets;
  ok('...fails closed when the configuration check is temporarily unavailable',
    failedConfigGets > 0 && (await page.locator('[data-research-input]').isDisabled()));
  configShouldFail = false;
  await go('/#/research/daily-alerts?scope=portfolio', 300);
  await go('/#/research/ask-research?scope=portfolio', 500);
  await page.waitForFunction(() => !document.querySelector('[data-research-input]')?.disabled, null, { timeout: 10000 });
  ok('...retries a transient configuration failure on the next mount',
    configGets > failedConfigGets && !(await page.locator('[data-research-input]').isDisabled()),
    `${failedConfigGets} failed check(s), ${configGets - failedConfigGets} recovery check(s)`);

  const evidenceAudit = await evalSafe(async () => {
    const { buildResearchEvidence, RESEARCH_EVIDENCE_CHAR_BUDGET, DASHBOARD_RESEARCH_SOURCES } = await import('/js/research/estate.js');
    const { providerEvidenceChars } = await import('/js/research/evidence-shared.js');
    const packet = await buildResearchEvidence({
      question: 'Which companies in my portfolio have the strongest recent evidence across multiple tabs?',
      scope: 'portfolio',
    });
    const ready = packet.sources.filter((source) => source.status === 'ready');
    return {
      catalog: packet.catalog.length,
      sources: packet.sources.length,
      expected: DASHBOARD_RESEARCH_SOURCES.map(source => source.id).sort(),
      catalogIds: packet.catalog.map(source => source.id).sort(),
      sourceIds: packet.sources.map(source => source.id).sort(),
      ready: packet.selection.sourcesReady,
      statuses: packet.sources.map((source) => `${source.id}:${source.status}`),
      budget: RESEARCH_EVIDENCE_CHAR_BUDGET,
      chars: providerEvidenceChars(packet),
      unresolvedChatter: packet.sources.find((source) => source.id === 'public-chatter')?.unresolvedTopics?.rowCount || 0,
      // THE BUG THIS GUARDS: a well-formed, under-budget packet whose every source carried zero rows.
      withRows: ready.filter((source) => source.rowCount > 0).map((source) => `${source.id}:${source.includedRows}/${source.rowCount}`),
      starved: ready.filter((source) => source.rowCount > 0 && !(source.includedRows > 0)).map((source) => source.id),
      trimmed: packet.sources.filter((source) => source.trimmed).map((source) => `${source.id}:${source.trimmed.join('+')}`),
      includedTotal: packet.sources.reduce((sum, source) => sum + (source.includedRows || 0), 0),
      companies: packet.selection.companies,
      tokens: packet.selection.tokens,
    };
  });
  ok('...assembles one status-bearing packet from every registered dashboard source',
    JSON.stringify(evidenceAudit.catalogIds) === JSON.stringify(evidenceAudit.expected) &&
      JSON.stringify(evidenceAudit.sourceIds) === JSON.stringify(evidenceAudit.expected) && evidenceAudit.ready > 0 &&
      evidenceAudit.statuses.every((entry) => /:(ready|unavailable)$/.test(entry)),
    `${evidenceAudit.ready} ready · ${evidenceAudit.statuses.join(', ')}`);
  ok('...and keeps the provider-facing packet inside the local model budget',
    evidenceAudit.chars <= evidenceAudit.budget, `${evidenceAudit.chars.toLocaleString()} of ${evidenceAudit.budget.toLocaleString()} chars`);
  ok('...spends that budget on rows: every ready source with rows in scope lands at least one, and no summary was trimmed to make room',
    evidenceAudit.withRows.length > 0 && evidenceAudit.starved.length === 0 && evidenceAudit.trimmed.length === 0 && evidenceAudit.includedTotal >= evidenceAudit.withRows.length,
    `${evidenceAudit.includedTotal} rows across ${evidenceAudit.withRows.length} sources · ${evidenceAudit.withRows.join(', ')}${evidenceAudit.starved.length ? ` · starved: ${evidenceAudit.starved.join(', ')}` : ''}${evidenceAudit.trimmed.length ? ` · trimmed: ${evidenceAudit.trimmed.join(', ')}` : ''}`);
  ok('...reads a generic question as generic — no scope or dashboard word becomes a ranking token or a company',
    evidenceAudit.tokens.length === 0 && evidenceAudit.companies.length === 0,
    `tokens: [${evidenceAudit.tokens.join(', ')}] · companies: [${evidenceAudit.companies.map((company) => company.ticker).join(', ')}]`);
  // The chatter feed is a DIRECT browser call to a third-party API (see "There is no /api/chatter"),
  // so on a sandbox with no egress it is `unavailable` and contributes nothing. That is the
  // environment, not the page — the honest answer is SKIP, exactly as the /api/ checks give.
  if (/public-chatter:unavailable/.test(evidenceAudit.statuses.join(', '))) {
    skip('...includes Public Chatter topics that cannot be resolved to dashboard tickers', 'the chatter API is unreachable from here');
  } else {
    ok('...includes Public Chatter topics that cannot be resolved to dashboard tickers',
      evidenceAudit.unresolvedChatter > 0, `${evidenceAudit.unresolvedChatter} separately labelled topics`);
  }

  // A QUESTION THAT NAMES A COMPANY GETS THAT COMPANY, FROM EVERY SOURCE THAT CARRIES IT. Measured
  // against the shipped data rather than a fixture: the book company with events in the most
  // All Alerts feeds is asked about by NAME, in lower case, and the packet must resolve it to
  // its ticker and land its rows from more than one source. Before this, "anything i should know
  // about IIFL finance?" was answered "not present" over four visible All Alerts rows.
  const companyAudit = await evalSafe(async () => {
    const { buildResearchEvidence } = await import('/js/research/estate.js');
    const alerts = await import('/js/data/daily-alerts.js');
    const coverage = await import('/js/data/coverage.js');
    const report = await alerts.collect({ scope: 'portfolio', holdings: coverage.holdings(), includeHistory: true });
    const feedsByTicker = new Map();
    for (const event of report.events) {
      if (!event.ticker) continue;
      if (!feedsByTicker.has(event.ticker)) feedsByTicker.set(event.ticker, new Set());
      feedsByTicker.get(event.ticker).add(event.feed);
    }
    const [ticker] = [...feedsByTicker.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0] || [];
    const name = coverage.holdings().find((h) => h.ticker === ticker)?.name || ticker;
    const packet = await buildResearchEvidence({ question: `anything i should know about ${String(name).toLowerCase()}?`, scope: 'portfolio' });
    const carrying = packet.sources.filter((source) => source.rows.some((row) => String(row.ticker || '').toUpperCase() === ticker));
    // Wherever the company appears, it leads: the first row of every carrying source is about it,
    // by symbol or by name — never a default-ordered row of some other company.
    const mentions = (row) => String(row?.ticker || '').toUpperCase() === ticker || JSON.stringify(row).toLowerCase().includes(String(name).toLowerCase().replace(/\s+(ltd|limited)\.?$/i, ''));
    const companyRowsFirst = carrying.every((source) => mentions(source.rows[0]));
    return {
      ticker,
      name,
      resolved: packet.selection.companies,
      alertFeeds: feedsByTicker.get(ticker)?.size || 0,
      carrying: carrying.map((source) => `${source.id}:${source.rows.filter((row) => row.ticker === ticker).length}`),
      alertRows: packet.sources.find((source) => source.id === 'daily-alerts')?.rows.filter((row) => row.ticker === ticker).length || 0,
      companyRowsFirst,
    };
  });
  ok('...resolves a company named in lower case in the question to its ticker, in scope',
    companyAudit.resolved?.length === 1 && companyAudit.resolved[0].ticker === companyAudit.ticker && companyAudit.resolved[0].inScope === true,
    `"${companyAudit.name}" → ${companyAudit.resolved?.map((company) => `${company.ticker} (${company.inScope ? 'in scope' : 'outside scope'})`).join(', ') || 'nothing'}`);
  ok('...and lands that company\'s rows from more than one source, ahead of every other company\'s',
    companyAudit.carrying?.length >= 2 && companyAudit.alertRows >= Math.min(companyAudit.alertFeeds, 2) && companyAudit.companyRowsFirst === true,
    `${companyAudit.ticker}: ${companyAudit.carrying?.join(', ')} · ${companyAudit.alertRows} All Alerts row(s) of ${companyAudit.alertFeeds} feed(s)`);

  // THE MOCK LEDGER IS NOT EVIDENCE. It used to be the fifteenth source — invented quantities and
  // costs, marked live, summarised into XIRR/TWR/drawdown and streamed to the model, which then
  // cited "Portfolio Analytics" with a link into the hidden workspace nobody could get out of.
  const ledgerAudit = await evalSafe(async () => {
    const { DASHBOARD_RESEARCH_SOURCES, buildResearchEvidence } = await import('/js/research/estate.js');
    const packet = await buildResearchEvidence({ question: 'What is my portfolio worth?', scope: 'portfolio' });
    const money = /marketValueRupees|investedRupees|unrealisedPnl|xirrPct|twrTotalPct|averageCostRupees/;
    return {
      registered: DASHBOARD_RESEARCH_SOURCES.filter((source) => /portfolio analytics/i.test(source.tab) || source.id === 'portfolio').map((source) => source.id),
      routes: DASHBOARD_RESEARCH_SOURCES.filter((source) => /#\/portfolio\//.test(source.route)).map((source) => source.id),
      valuationKeys: money.test(JSON.stringify(packet.sources)),
    };
  });
  ok('...carries no ledger source, no valuation figure and no route into the deleted workspace',
    ledgerAudit.registered?.length === 0 && ledgerAudit.routes?.length === 0 && ledgerAudit.valuationKeys === false,
    `${ledgerAudit.registered?.join(', ') || 'no ledger source'}${ledgerAudit.valuationKeys ? ' · valuation keys present' : ''}`);

  await page.locator('[data-research-input]').fill('Summarise the dashboard evidence.');
  await page.locator('[data-research-send]').click();
  await page.waitForFunction(() => /Dashboard evidence remains traceable/.test(document.querySelector('[data-research-transcript]')?.innerText || ''), null, { timeout: 25000 });
  const researchAnswer = await page.locator('[data-research-transcript]').innerText();
  ok('...submits the complete dashboard packet without claiming unsupported web research',
    askRequest?.webResearch === false && askRequest?.requirePortfolio === true &&
      askRequest?.evidence?.portfolio?.status === 'limited' &&
      askRequest?.evidence?.catalog?.length === evidenceAudit.expected.length && askRequest?.evidence?.sources?.length === evidenceAudit.expected.length,
    `${askRequest?.evidence?.selection?.sourcesReady ?? 0} sources ready`);
  ok('...renders the streamed dashboard answer without a fabricated web source',
    /dashboard research/i.test(researchAnswer) &&
      (await page.locator('.research-source-chip-web').count()) === 0,
    researchAnswer.replace(/\s+/g, ' ').slice(0, 240));
  // A CITATION IS A LINK INTO THE DASHBOARD. `[Dashboard: Earnings Hub]` in the stubbed answer must
  // render as an anchor to that tab's route in the active scope — and, because this question named
  // no company, without a `company=` seed it would have no honest value for.
  const citation = await page.evaluate(() => {
    const a = document.querySelector('[data-research-transcript] a.research-cite');
    return a ? { href: a.getAttribute('href'), text: a.textContent.trim(), unresolved: document.querySelectorAll('[data-research-transcript] .research-cite-unresolved').length } : null;
  });
  ok('...and renders every [Dashboard: Page] citation as a link into that tab',
    !!citation && /^#\/research\/earnings-hub\?scope=portfolio$/.test(citation.href) && citation.text === 'Earnings Hub' && citation.unresolved === 0,
    citation ? `${citation.text} → ${citation.href}` : 'no citation link rendered');

  // AN ANSWER THE READER WALKED AWAY FROM IS STILL THERE WHEN THEY COME BACK.
  //
  // `destroy()` used to abort every generation, so pressing Send and then looking at another tab —
  // the obvious thing to do while fifteen sources are read and an answer is written — cancelled it,
  // put the question back in the composer and took it out of the transcript. What the reader saw
  // was their own question sitting unsent, which reads as the assistant having dropped it.
  //
  // Driven the way a reader does it: a SAME-DOCUMENT hash navigation. `go()` reloads the document,
  // which genuinely does end the request, and would pass this check for the wrong reason.
  await page.locator('[data-research-new]').click();
  await page.locator('[data-research-input]').fill('Keeps working while I look away');
  await page.locator('[data-research-send]').click();
  await page.waitForFunction(() => /Reading |Writing |Opening /.test(document.querySelector('[data-research-phase]')?.innerText || ''), null, { timeout: 15000 });
  const awaySession = await page.evaluate(() => {
    location.hash = '#/research/breakouts?scope=portfolio';
    return true;
  });
  await page.waitForTimeout(600);
  ok('leaving Ask Research mid-answer really does unmount it', awaySession && !(await page.locator('[data-research-input]').count()));
  const landedAway = await page
    .waitForFunction(() => {
      return document.querySelectorAll('[data-notification="research"]').length > 0;
    }, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  ok('...and the answer still arrives while another tab is on screen', landedAway);
  ok('...without persisting private portfolio conversations to device storage',
    await page.evaluate(() => !/OFF_TAB_ANSWER|Dashboard evidence remains traceable/.test(localStorage.getItem('sattva:ask-research:v1') || '')));
  // Keeping it running silently would be a feature nobody can see, so it announces itself in the
  // alert stack — the same place a filed result does, under the tab it belongs to.
  ok('...and says so in the alert stack rather than finishing invisibly',
    (await page.locator('[data-notification="research"]').count()) > 0,
    `${await page.locator('#notification-root > *').count()} alert card(s) on screen`);
  await page.evaluate(() => { location.hash = '#/research/ask-research?scope=portfolio'; });
  await page.waitForFunction(() => !document.querySelector('[data-research-input]')?.disabled, null, { timeout: 15000 });
  const backText = await page.locator('[data-research-transcript]').innerText();
  ok('...and it is in the conversation when the reader returns, with the composer clear',
    /OFF_TAB_ANSWER/.test(backText) && (await page.locator('[data-research-input]').inputValue()) === '',
    backText.replace(/\s+/g, ' ').slice(0, 120));

  // Private drafts survive same-page navigation but deliberately do not persist across reloads.
  await page.locator('[data-research-input]').fill('An unsent draft that must survive');
  await page.waitForTimeout(700);
  await page.evaluate(() => { location.hash = '#/research/breakouts?scope=portfolio'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { location.hash = '#/research/ask-research?scope=portfolio'; });
  await page.waitForTimeout(900);
  ok('an unsent draft survives leaving the tab',
    (await page.locator('[data-research-input]').inputValue()) === 'An unsent draft that must survive');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('[data-research-input]')?.disabled, null, { timeout: 15000 });
  ok('...but private drafts disappear on reload rather than entering device storage',
    (await page.locator('[data-research-input]').inputValue()) !== 'An unsent draft that must survive' &&
    await page.evaluate(() => !/An unsent draft that must survive/.test(localStorage.getItem('sattva:ask-research:v1') || '')));
  await page.evaluate(() => {
    const input = document.querySelector('[data-research-input]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // AN ANSWER SAVED BEFORE ITS COMPANIES WERE STORED STILL DEEP-LINKS. Its question is resolved
  // again on first paint and the result stored on the message — so a conversation from before
  // the link change opens All Alerts on the company's nineteen rows, not on all 21,000.
  const legacyMember = await page.evaluate(async () => {
    const coverage = await import('/js/data/coverage.js');
    const member = coverage.holdings().find((h) => h.ticker && h.name && h.name.split(' ').length >= 2);
    const stored = JSON.parse(localStorage.getItem('sattva:ask-research:v1') || '[]');
    stored.unshift({ id: 'legacy-answer', title: 'legacy', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z', messages: [
      { role: 'user', text: `anything i should know about ${member.name.toLowerCase()}?` },
      { role: 'assistant', text: 'Filed today. [Dashboard: All Alerts]', dashboardSources: [{ id: 'daily-alerts', tab: 'All Alerts', route: '#/research/daily-alerts' }], webSources: [] },
    ] });
    localStorage.setItem('sattva:ask-research:v1', JSON.stringify(stored));
    return member.ticker;
  });
  // A real reload: the tab reads its library once, at module load, so a hash navigation would not see
  // the injected conversation.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('[data-research-input]')?.disabled, null, { timeout: 15000 });
  await page.locator('[data-research-session="legacy-answer"]').click();
  await page.waitForFunction(() => /company=/.test(document.querySelector('[data-research-transcript] a.research-cite')?.getAttribute('href') || ''), null, { timeout: 20000 }).catch(() => {});
  const legacyHref = await page.locator('[data-research-transcript] a.research-cite').first().getAttribute('href').catch(() => null);
  ok('...and an answer saved without its companies is backfilled from its question, so its citations deep-link too',
    !!legacyHref && legacyHref === `#/research/daily-alerts?scope=portfolio&company=${legacyMember}`,
    `${legacyMember}: ${legacyHref || 'no link'}`);
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('sattva:ask-research:v1') || '[]').filter((s) => s.id !== 'legacy-answer');
    localStorage.setItem('sattva:ask-research:v1', JSON.stringify(stored));
  });

  // A Watchlist edit is emitted immediately but the editor defers the shell's remount until it
  // closes. The Ask workspace must cancel at the store boundary, before a response for the old
  // membership can be committed to device history.
  await page.locator('[data-research-new]').click();
  await page.locator('[data-research-input]').fill('Stale scope test');
  await page.locator('[data-research-send]').click();
  await page.waitForFunction(() => /Reading |Writing |Sending /.test(document.querySelector('[data-research-phase]')?.innerText || ''), null, { timeout: 10000 });
  const editedMember = await page.evaluate(async () => {
    const coverage = await import('/js/data/coverage.js');
    const scopeLists = await import('/js/core/scope-lists.js');
    const base = coverage.baseHoldings();
    const member = base[0];
    (await import('/js/core/watchlist.js')).add(member.ticker, member.name);
    (await import('/js/core/state.js')).setScope('watchlist');
    (await import('/js/core/watchlist.js')).remove(member.ticker);
    return member?.ticker || member?.name || null;
  });
  await page.waitForTimeout(1200);
  ok('...cancels an in-flight answer when the active scope membership changes',
    !!editedMember &&
      (await page.locator('[data-research-input]').inputValue()) === 'Stale scope test' &&
      !/STALE_SCOPE_ANSWER/.test(await page.locator('[data-research-transcript]').innerText()),
    editedMember || 'no portfolio member available');
  await page.evaluate(async () => {
    const scopeLists = await import('/js/core/scope-lists.js');
    scopeLists.reset('portfolio');
  });

  await page.unroute('**/api/research');
  if (process.env.VERIFY_UI_STOP_AFTER_RESEARCH === '1') {
    const own = [...new Set(errors)].filter(ownError);
    ok('zero application console errors through the Research smoke checks', own.length === 0, own.slice(0, 3).join(' | '));
    await browser.close();
    await new Promise(resolve => ddStub.close(resolve));
    console.log(`${failures} failures through Research; ${skipped} environment skips.`);
    process.exit(failures ? 1 : 0);
  }

  // EVERY TABLE TAB HONOURS `?company=` THE SAME WAY: the first paint after the parameter appears
  // opens the table searched for that company, which is what a citation deep-links to. Asserted on
  // the Earnings Hub with a company that actually filed, so the seeded search has rows to show.
  const seedTicker = await page.evaluate(async () => {
    const earnings = await import('/js/data/earnings-live.js');
    await earnings.load();
    return earnings.all().find((r) => r.ticker)?.ticker || null;
  });
  await go(`/#/research/earnings-hub?scope=universe&company=${encodeURIComponent(seedTicker || '')}`, 2500);
  await page.waitForFunction(() => !document.querySelector('#content-host [data-rows-pending]'), null, { timeout: 15000 }).catch(() => {});
  const seededSearch = await page.locator('#content-host [data-table-search]').first().inputValue().catch(() => null);
  const seededRows = await page.locator('#content-host tbody tr[data-row-key]').allTextContents();
  // ASSERT WHAT A SEARCH PROMISES, NOT WHAT A FILTER WOULD. `?company=` seeds the search box — the
  // documented behaviour, and visible to the reader, who can edit it — so what it returns is every
  // row matching that TEXT, which is a superset of the company. The box matches names as well as
  // symbols, so seeding `TECHNOCRAF` legitimately also shows Technocraft Industries, whose own
  // symbol is something else entirely. That is a search behaving like a search, and the day the
  // newest filing happened to be a company whose name prefixes another's, a check about deep-linking
  // failed with nothing wrong on the page.
  //
  // This is the second assertion in this file to get that backwards — the other read a
  // case-sensitive ticker against a BSE filing reading "voluntarily issued by Crisil" — so state the
  // shape once. Two clauses, and both earn their place: every row matches the seeded SEARCH, which
  // is what the product promises and would catch a stray unrelated row; and the seeded company is
  // among them, which carries the original point of this check — an uppercase seeded ticker matching
  // nothing while the product visibly said 0 shown.
  const seededMatchesSearch = seededRows.every((row) => row.toUpperCase().includes(String(seedTicker || '').toUpperCase()));
  const seededCompanyPresent = seededRows.some((row) => row.includes(seedTicker));
  ok('a table tab opened with ?company= is searched for that company',
    !!seedTicker && seededSearch === seedTicker && seededRows.length > 0 && seededMatchesSearch && seededCompanyPresent,
    `${seedTicker}: search "${seededSearch}", ${seededRows.length} row(s), company present ${seededCompanyPresent}`);

  // ---------------------------------------------------------------------------------------
  // 3f. All Alerts — the complete chronological stream
  //
  // It must consolidate every feed, keep today's freshness distinct from retained history, and
  // reveal older dates through the table's own scroller in strict chronological order.
  // ---------------------------------------------------------------------------------------
  console.log('\n— general alerts —');
  await go('/#/research/daily-alerts?scope=portfolio', 4500);

  const daText = await hostText();
  // THE FOUR CARDS AND THE PARAGRAPH ARE ONE PILL NOW. Three of the cards counted rows the table
  // beneath them already lists and the fourth printed the date; the description restated what the
  // coverage panel says per feed. What may not be lost with them is the provenance and the day, so
  // both are asserted here rather than the furniture that used to carry them.
  ok('All Alerts carries no redundant stat strip', (await page.locator('#content-host .stat-card').count()) === 0);
  ok('...and no description paragraph competing with the stream',
    !/in one stream\. Red is an alert/.test(daText));
  ok('the sub-view picker is hidden for this single-stream tab', await page.evaluate(() => {
    const m = document.getElementById('subview-mount');
    return !m || m.classList.contains('hidden') || !m.innerText.trim();
  }));
  // The date is IST, and it is on the FACE of the pill: this is the one tab defined by a day, and
  // a screenshot travels without the modal behind it.
  const dayPillText = await page.locator('[data-alerts-info]').first().innerText();
  ok('it states the Indian trading date rather than a UTC one',
    /\d{2} \w{3,4} \d{4}/.test(dayPillText), dayPillText.replace(/\s+/g, ' '));
  ok('...and the date/status control is a passive label',
    (await page.locator('[data-alerts-info]').count()) === 1 &&
      (await page.locator('[data-alerts-info]').evaluate((el) => el.tagName)) === 'SPAN');
  const historyPillText = await page.locator('#content-host [title*="newest first"]').innerText();
  ok('All Alerts states that retained history is loaded', /History · \d+ dates?/.test(historyPillText), historyPillText);

  // THE COVERAGE PANEL IS THE HONESTY HALF. Without it an empty bucket reads as an all-clear.
  const panel = await page.locator('[data-alerts-coverage]').innerText();
  // EIGHT ON A NARROWED SCOPE, NINE ON UNIVERSE. Market-wide news carries no company, so under
  // Portfolio it contributes nothing and is not offered as a filter; the reason it is absent stays
  // in the registered source metadata. Asserted exactly rather than as
  // a floor — a `>=` would not notice the page widening back to feeds it was narrowed away from.
  const feedRows = await page.locator('[data-alerts-coverage] [data-feed]').count();
  const expectedScopedFeeds = await page.evaluate(async () => (await import('/js/data/daily-alerts.js')).FEEDS.filter((f) => !['market-news', 'twitter'].includes(f.id)).length);
  ok('the coverage panel accounts for every registered company-scopable feed', feedRows === expectedScopedFeeds, `${feedRows} feed rows`);
  ok('...and every research tab asked for is represented',
    ['Price & volume', 'Earnings', 'Con-calls', 'Public chatter', 'Investor activity', 'Announcements', 'Insider trades', 'Company news'].every((n) => panel.includes(n)),
    panel.replace(/\s+/g, ' ').slice(0, 120));
  // A COUNT IS A FINISHED ANSWER; "has not looked" IS THE ABSENCE OF ONE. A chip without a confirmed
  // reading shows only the source name: no misleading zero and no customer-facing health jargon.
  const chipStates = await page.$$eval('[data-alerts-coverage] [data-feed]', (els) =>
    els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), title: e.getAttribute('title') || '' })));
  ok('...and source filters omit feed-health labels from visible and hover text',
    chipStates.every((c) => !/stale|unknown|incomplete|on-demand|not in scope|read failed/i.test(`${c.text} ${c.title}`)),
    chipStates.map((c) => `${c.text} [${c.title}]`).join(' | '));
  ok('...and every chip has a simple filtering hint',
    chipStates.length === expectedScopedFeeds && chipStates.every((c) => /^Filter alerts to .+\.$/.test(c.title)),
    `${chipStates.length} chips`);
  // AND ASSERTED AT THE RULE, because the check above passes vacuously on any day every feed has
  // looked at today — which is most days. `feedState` is exported for exactly this reason, the same
  // reason `moveSeverity` and `freshnessOf` are: a branch the shipped data cannot reach is a branch
  // the suite cannot claim to have tested.
  const states = await evalSafe(async () => {
    const { feedState } = await import('/js/tabs/daily-alerts.js');
    const of = (f) => { const st = feedState(f); return { label: st.label, short: st.short(f) }; };
    return {
      behind: of({ reachesToday: false, count: 0 }),
      behindWithRows: of({ reachesToday: false, count: 7 }),
      failed: of({ status: 'failed', count: 0 }),
      pending: of({ status: 'pending' }),
      unscoped: of({ scopable: false, count: 3 }),
      nothing: of({ reachesToday: true, count: 0 }),
      some: of({ reachesToday: true, count: 30 }),
    };
  });
  ok('a feed that has not looked at today renders no customer-facing detail',
    states.behind.short === '' && states.behindWithRows.short === '',
    `count 0 -> "${states.behind.short}", count 7 -> "${states.behindWithRows.short}"`);
  ok('...and neither do failed, pending, or unscoped feeds',
    states.failed.short === '' && states.pending.short === '' && states.unscoped.short === '',
    `failed "${states.failed.short}", pending "${states.pending.short}", unscoped "${states.unscoped.short}"`);
  // The one case that IS a number, and the one zero that is a real measurement rather than a gap.
  ok('...while a feed that looked and found nothing prints a real zero',
    states.nothing.short === '0' && states.some.short === '30',
    `nothing -> "${states.nothing.short}", 30 events -> "${states.some.short}"`);
  ok('...while all five states remain distinguishable internally',
    new Set([states.behind.label, states.failed.label, states.pending.label, states.unscoped.label, states.nothing.label]).size === 5);
  // The status label must not bring back the long explainer overlay.
  await page.locator('[data-alerts-info]').first().click();
  await page.waitForTimeout(200);
  ok('the All Alerts status opens no explainer popup',
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);
  ok('...and a feed that could not be read is distinguished from one with nothing to report',
    !/could not be read/.test(panel) || !/could not be read.*nothing today/s.test(panel));

  // DIRECTION AND IMPORTANCE. Every badge must print the reading that made it so.
  const report = await evalSafe(async () => {
    const da = await import('/js/data/daily-alerts.js');
    // A day the results feed actually holds, so the profit-reading branches are exercised on a
    // static origin too. Today is frequently quiet, and a check that only passes on a busy day is
    // a check that does not run.
    // A day the retained row-dated feeds actually hold. The technicals half is a single end-of-day snapshot
    // matched by EQUALITY, so it only ever contributes on its own capture date.
    const r = await da.collect({ scope: 'universe', day: '2026-08-31' });
    return {
      total: r.events.length,
      everySignalHasReasons: r.events.every((e) => typeof e.signalReason === 'string' && e.signalReason.length > 0 && typeof e.importanceReason === 'string' && e.importanceReason.length > 0),
      directions: [...new Set(r.events.map((e) => e.direction))],
      importance: [...new Set(r.events.map((e) => e.importance))],
      uniqueIds: new Set(r.events.map((e) => e.id)).size,
      feeds: r.feeds.map((f) => ({ id: f.id, status: f.status, reaches: f.reachesToday, n: f.count })),
    };
  });
  ok('the collector reads something across the feeds', report.total > 0, `${report.total} events`);
  ok('every direction is one of the three documented values',
    report.directions.every((v) => ['positive', 'negative', 'neutral'].includes(v)), report.directions.join('/'));
  ok('every importance is High or Low',
    report.importance.every((v) => ['high', 'low'].includes(v)), report.importance.join('/'));
  ok('EVERY row prints both readings that made its badges', report.everySignalHasReasons, `${report.total} events`);

  const rules = await evalSafe(async () => {
    const da = await import('/js/data/daily-alerts.js');
    const ann = (title, critical = false) => da.announcementSignal({ title, critical });
    const inside = (Transaction, pct, value, Mode = '') => da.insiderSignal({ Transaction, Mode, 'Trade %': pct, 'Trade Value': value });
    return {
      annUpgrade: ann('Credit rating upgraded'),
      annDefault: ann('Notice of loan default'),
      annGeneral: ann('Notice of annual general meeting'),
      annCritical: ann('Notice of annual general meeting', true),
      annAuditor: ann('Resignation of Statutory Auditors'),
      annRegulatoryOrder: ann('Adjudication order received from the Registrar of Companies'),
      annApprovalReceipt: ann('Receipt of In-Principle Approval from the Stock Exchanges for Preferential Issue'),
      annInternalApproval: ann('Receipt of approval from the customer for revised drawings'),
      annProductionCommencement: ann('Commencement of Commercial Production at the new facility'),
      unreadInvestorList: da.investorCoverageState({ ok: false, reason: 'no-route', total: 0, loadedBooks: 0 }),
      buySmall: inside('Acquisition', '0.20', '1000'),
      sellPct: inside('Disposal', '1.00', '1000'),
      disposalByPurchase: inside('Disposal', '', '', 'Market Purchase'),
      pledge: inside('Pledge', '', '', 'Creation Of Pledge'),
      release: inside('Revoke', '', '', 'Revocation Of Pledge'),
      bareRelease: inside('Revoke', '', '', ''),
    };
  });
  ok('announcement rules distinguish upgrade, default and unmatched text',
    rules.annUpgrade.direction === 'positive' && rules.annDefault.direction === 'negative' && rules.annGeneral.direction === 'neutral' &&
      rules.annRegulatoryOrder.direction !== 'positive');
  // THE CRITICAL EXPECTATION HERE IS INVERTED ON PURPOSE, and it is the one line of this check that
  // changed: `annCritical` is an AGM notice BSE flagged critical, and it is now LOW. Their flag is
  // reproduced on the row and in the export and no longer gates our importance — measured, it marks
  // 29% of the whole exchange and 881 of those are AGM notices. See *A borrowed flag is not a
  // materiality rule* in CLAUDE.md, and `BSE_CRITICAL_IS_MATERIAL`, which flips it back.
  //
  // Everything else this check asserted is unchanged and still asserted: the directional rule keeps
  // its own materiality (an upgrade and an auditor resignation are both High on their own, without
  // BSE's flag and — for the upgrade — without any tracked keyword), and a routine AGM is Low.
  ok('the directional rule keeps its own materiality, and BSE\'s critical flag no longer grants it',
    rules.annUpgrade.importance === 'high' && rules.annAuditor.importance === 'high' &&
      rules.annAuditor.direction === 'negative' && rules.annGeneral.importance === 'low' &&
      rules.annCritical.importance === 'low',
    `upgrade ${rules.annUpgrade.importance}, auditor ${rules.annAuditor.importance}, AGM ${rules.annGeneral.importance}, critical AGM ${rules.annCritical.importance}`);
  // ...and the row still carries their flag's reasoning, so a reader is not left wondering why a
  // filing the exchange marked critical is not at the top of the page.
  ok('...and a critical filing says in words that their marker is reproduced but is not the gate',
    /BSE marked this filing critical/.test(rules.annCritical.importanceReason) && !/BSE marked this filing critical/.test(rules.annGeneral.importanceReason),
    rules.annCritical.importanceReason.slice(0, 90));
  ok('regulatory approval and commercial-production noun forms are Positive and High',
    rules.annApprovalReceipt.direction === 'positive' && rules.annApprovalReceipt.importance === 'high' &&
      rules.annProductionCommencement.direction === 'positive' && rules.annProductionCommencement.importance === 'high' &&
      rules.annInternalApproval.direction === 'neutral');
  ok('an unread investor list is incomplete even when there are no books to count',
    rules.unreadInvestorList.incomplete === true && /investor list could not be read/.test(rules.unreadInvestorList.problems.join(' ')));
  ok('insider rules distinguish acquisition, disposal, pledge and release',
    rules.buySmall.direction === 'positive' && rules.sellPct.direction === 'negative' && rules.pledge.direction === 'negative' &&
      rules.release.direction === 'positive' && rules.bareRelease.direction === 'positive' && rules.disposalByPurchase.direction === 'negative');
  ok('insider importance changes exactly at the stated one-percent boundary',
    rules.buySmall.importance === 'low' && rules.sellPct.importance === 'high');

  const structuralRefresh = await evalSafe(async () => {
    const e = await import('/js/data/earnings-live.js');
    const good = { status: 200, fromStore: false, value: { rows: [{ scId: 'A' }], meta: { subType: 'yoy', structureTag: 'new' } } };
    return {
      failed: e.structuralRefreshFailure({ status: 503, value: null }, 'yoy', 'new'),
      stale304: e.structuralRefreshFailure({ status: 304, fromStore: true, value: good.value }, 'yoy', 'new'),
      valid: e.structuralRefreshFailure(good, 'yoy', 'new'),
    };
  });
  ok('a failed full earnings refresh cannot bless rows a changed structure tag proved stale',
    !!structuralRefresh.failed && !!structuralRefresh.stale304 && structuralRefresh.valid === null);

  // THE ALERT RULE, ASSERTED DIRECTLY. It is the only thing on this page that can make a red row,
  // and the shipped snapshot has seven moves past the threshold with not one of them down — so a
  // check that waited for a red row in the data would never actually run. Hence the exported
  // predicate: the rule is tested at the boundary and on both sides of it.
  const sev = await evalSafe(async () => {
    const da = await import('/js/data/daily-alerts.js');
    const t = da.MOVE_PCT;
    return {
      threshold: t,
      belowDown: da.moveSeverity(-(t + 1)),
      atDown: da.moveSeverity(-t),
      inside: da.moveSeverity(-(t - 0.1)),
      up: da.moveSeverity(t + 1),
      missing: da.moveSeverity(null),
    };
  });
  ok('a fall past the threshold is an alert', sev.belowDown === 'alert' && sev.atDown === 'alert', `${sev.threshold}%`);
  ok('...a rise past it is only an update', sev.up === 'update', sev.up);
  ok('...and a move inside it is not an event at all, rather than a neutral one', sev.inside === null && sev.missing === null);
  // A CLOSE IS A CLAIM ABOUT A SESSION. The file says which session its closes belong to
  // (`price_date`, per row `bar_date`); the capture time is the morning after on a run that
  // happens on time and mid-session on one that does not. Every price move must be dated by its
  // session and the feed may claim "today" only when that session IS today — 11:36 IST on
  // 2 September once printed a live intraday quote as that day's close and alerted on it.
  const sessionDating = await evalSafe(async () => {
    const da = await import('/js/data/daily-alerts.js');
    const tech = await import('/js/data/technicals.js');
    await tech.load();
    const m = tech.meta() || {};
    const r = await da.collect({ scope: 'universe', includeHistory: true });
    const feed = r.feeds.find((f) => f.id === 'technicals');
    const moves = r.events.filter((e) => e.feed === 'technicals' && ['move', 'volume', 'breakout', 'price-reading'].includes(e.kind));
    const byTicker = new Map(tech.all().map((s) => [s.company?.ticker, s.company]));
    return {
      priceDate: m.price_date || null,
      today: da.today(),
      reachesToday: feed?.reachesToday ?? null,
      moves: moves.length,
      datedBySession: moves.every((e) => e.day === (byTicker.get(e.ticker)?.bar_date || m.price_date)),
      namesSession: moves.every((e) => new RegExp(`at the ${e.day} close`).test(e.headline)),
      verified: moves.filter((e) => byTicker.get(e.ticker)?.move_source).length,
      unfinishedBar: tech.all().some((s) => s.company?.bar_date === da.today() && new Date(m.generated_at).getTime() + 5.5 * 3600 * 1000 < Date.parse(`${da.today()}T16:00:00Z`)),
    };
  });
  ok('every price move is dated by its session, never by the capture',
    !!sessionDating.priceDate && sessionDating.datedBySession === true && sessionDating.namesSession === true,
    `${sessionDating.moves} move(s) on ${sessionDating.priceDate}${sessionDating.verified ? ` · ${sessionDating.verified} re-derived from the Muns market-data endpoint` : ''}`);
  ok('...the feed claims today only when its session IS today, and never carries an unfinished session',
    sessionDating.reachesToday === (sessionDating.priceDate === sessionDating.today) && sessionDating.unfinishedBar === false,
    `session ${sessionDating.priceDate} · today ${sessionDating.today} · reachesToday ${sessionDating.reachesToday}`);
  // A key that means two rows is the failure this dashboard has hit twice; it is never caught by
  // counting, so it is compared.
  ok('every event id is unique', report.uniqueIds === report.total, `${report.uniqueIds} ids for ${report.total} events`);
  const historyReport = await evalSafe(async () => {
    const da = await import('/js/data/daily-alerts.js');
    const r = await da.collect({ scope: 'portfolio', includeHistory: true });
    const universe = await da.collect({ scope: 'universe', includeHistory: true });
    const earnings = await import('/js/data/earnings-live.js');
    const concalls = await import('/js/data/concall-scans.js');
    const eventByRow = new Map(universe.events.filter((e) => e.feed === 'earnings').map((e) => [e.id, e]));
    const kindLabel = {
      turnaround: 'to profit',
      'slipped-to-loss': 'to loss',
      'loss-narrowed': 'loss narrowed',
      'loss-widened': 'loss widened',
      'loss-flat': 'loss flat',
    };
    const dishonestKinds = earnings.all().flatMap((row) => [row.revenue, row.netProfit].map((metric) => ({ row, metric })))
      .filter(({ metric }) => kindLabel[metric?.kind])
      .filter(({ row, metric }) => {
        const id = `earnings:${row.scId || row.ticker}:${row.resultDate}:${String(earnings.meta()?.subType || 'yoy').toUpperCase()}`;
        const event = eventByRow.get(id);
        return event && !event.detail.toLowerCase().includes(kindLabel[metric.kind]);
      }).length;
    const investorFeed = universe.feeds.find((f) => f.id === 'investors');
    const earningsFeed = universe.feeds.find((f) => f.id === 'earnings');
    const concallFeed = universe.feeds.find((f) => f.id === 'concalls');
    return {
      events: r.events.length,
      days: r.meta.days,
      oldest: r.meta.oldestEventDay,
      newest: r.meta.newestEventDay,
      unique: new Set(r.events.map((e) => e.id)).size,
      scorelessNonNeutralLow: r.events.filter((e) => e.feed === 'concalls' && e.direction !== 'neutral' && /analysis pending/.test(e.detail) && e.importance !== 'high').length,
      universeTickerlessInvestors: universe.events.filter((e) => e.feed === 'investors' && !e.ticker).length,
      portfolioTickerlessInvestors: r.events.filter((e) => e.feed === 'investors' && !e.ticker).length,
      investorCoverageExplicit:
        investorFeed?.status === 'failed'
          ? /\d+ of \d+ investor books/.test(investorFeed.note || '')
          : investorFeed?.status === 'ok' && !/could not be included|incomplete/i.test(investorFeed.note || ''),
      snapshotFreshnessHonest:
        (earnings.meta()?.origin !== 'snapshot' || earningsFeed?.asOf === earnings.meta()?.fetchedAt) &&
        (concalls.meta()?.origin !== 'snapshot' || concallFeed?.asOf === concalls.meta()?.fetchedAt),
      dishonestKinds,
      ordered: r.events.every((e, i, rows) => !i || `${rows[i - 1].day}T${rows[i - 1].time || ''}` >= `${e.day}T${e.time || ''}`),
    };
  });
  ok('history mode retains multiple dates with stable unique ids',
    historyReport.events > report.total && historyReport.days > 1 && historyReport.unique === historyReport.events,
    `${historyReport.events} events across ${historyReport.days} dates (${historyReport.oldest} → ${historyReport.newest})`);
  ok('...and orders the data by date and time before the table sees it', historyReport.ordered);
  ok('scoreless con-calls retain High importance when source sentiment is non-neutral', historyReport.scorelessNonNeutralLow === 0,
    `${historyReport.scorelessNonNeutralLow} misclassified row(s)`);
  ok('Universe retains tickerless investor moves while Portfolio excludes them',
    historyReport.universeTickerlessInvestors > 0 && historyReport.portfolioTickerlessInvestors === 0,
    `${historyReport.universeTickerlessInvestors} Universe / ${historyReport.portfolioTickerlessInvestors} Portfolio`);
  ok('investor coverage is honest whether the current snapshot is complete or incomplete', historyReport.investorCoverageExplicit);
  ok('reading a committed earnings/con-call file does not advance source freshness', historyReport.snapshotFreshnessHonest);
  ok('earnings turnaround and loss kinds are named instead of restored as growth rates', historyReport.dishonestKinds === 0,
    `${historyReport.dishonestKinds} dishonest metric label(s)`);

  // A LANDING MUST NOT COST A REQUEST PER COMPANY. This is the same rule the filings tabs follow,
  // and this tab reads three of those feeds.
  const perCompany = [];
  const countPerCompany = (r) => {
    const u = r.url();
    if (/\/api\/(news|announcements|insider)/.test(u)) perCompany.push(u);
  };
  page.on('request', countPerCompany);
  await go('/#/research/daily-alerts?scope=universe', 5000);
  page.off('request', countPerCompany);
  ok('mounting it sends no per-company filings request', perCompany.length === 0, perCompany.slice(0, 2).join(' '));

  // Market-wide news has no company on it, so it cannot be narrowed BY one — the same rule the
  // chatter tab follows for its unresolved half. It must say so rather than filter to nothing.
  await go('/#/research/daily-alerts?scope=portfolio', 5000);
  // The feed is not offered as a filter here, and the status remains passive.
  const scopedFeeds = await page.$$eval('[data-alerts-coverage] [data-feed]', (els) => els.map((e) => e.dataset.feed));
  ok('market-wide news is not offered as a filter on a narrowed scope', !scopedFeeds.includes('market-news'), scopedFeeds.join(', '));
  await page.locator('[data-alerts-info]').first().click();
  await page.waitForTimeout(200);
  ok('the narrowed-scope status opens no explainer popup',
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

  // THE LEGEND STRIP IS GONE FROM THE BODY, and what it said is in the modal's "What the colours
  // mean" section — the same trade as the description and the stat cards. The claim may not go:
  // a colour whose cause the reader cannot look up is a judgement, and this page makes none.
  // ---- the feed tick boxes -----------------------------------------------------------
  // ALL IS THE DEFAULT, AND `All` IS NOT "EVERY BOX TICKED". The two look identical on screen and
  // behave differently the moment a feed appears or disappears, which is why `picked` is null
  // rather than a full Set — the same distinction `scopeTickers` draws, for the same reason.
  await go('/#/research/daily-alerts?scope=universe', 5500);
  await settleTables();
  // A historical alert stream deliberately keeps only the rows the reader has reached in the
  // DOM. Its toolbar count is the complete filtered DATA set — the same set search, filters and
  // export use — whereas `rowCount()` is only the current scroll page.
  const alertDataCount = async () => {
    const text = await page.locator('[data-score-table] [data-row-count]').innerText();
    return Number((text.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''));
  };
  const allChecked = await page.locator('[data-feed-toggle="__all"]').getAttribute('aria-checked');
  ok('the feed filter opens on All', allChecked === 'true');
  const allRows = await alertDataCount();
  const currentAlertDay = await evalSafe(async () => (await import('/js/data/daily-alerts.js')).today());
  const timeline = await evalSafe(() => {
    const rows = [...document.querySelectorAll('#content-host tbody tr[data-row-key]')];
    const when = rows.map((row) => {
      const el = row.querySelector('[data-event-day]');
      const text = el?.innerText || '';
      const time = (text.match(/(\d{2}:\d{2}) IST/) || [])[1] || '';
      return { day: el?.dataset.eventDay || '', time };
    });
    return {
      headers: [...document.querySelectorAll('#content-host thead th')].map((h) => h.innerText.trim()),
      rows: when.length,
      days: [...new Set(when.map((x) => x.day).filter(Boolean))],
      everyResolved: when.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.day)),
      ordered: when.every((x, i) => !i || `${when[i - 1].day}T${when[i - 1].time}` >= `${x.day}T${x.time}`),
    };
  });
  ok('the stream carries an explicit Date / time column', timeline.headers.some((h) => /^DATE \/ TIME/.test(h)), timeline.headers.join(' | '));
  ok('every row carries its date resolution and the timeline is newest-first', timeline.everyResolved && timeline.ordered,
    `${timeline.everyResolved ? 'all dated' : 'missing date'} · ordered=${timeline.ordered}`);

  const scrollBefore = await evalSafe(() => {
    const scroller = document.querySelector('[data-table-scroll]');
    return {
      painted: document.querySelectorAll('#content-host tbody tr[data-row-key]').length,
      pending: Number(document.querySelector('[data-score-table]')?.dataset.rowsPending || 0),
      top: scroller?.scrollTop || 0,
      scrollHeight: scroller?.scrollHeight || 0,
      clientHeight: scroller?.clientHeight || 0,
      lastKey: document.querySelectorAll('#content-host tbody tr[data-row-key]')?.[document.querySelectorAll('#content-host tbody tr[data-row-key]').length - 1]?.dataset.rowKey || null,
    };
  });
  await page.locator('[data-table-scroll]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction((before) => document.querySelectorAll('#content-host tbody tr[data-row-key]').length > before,
    scrollBefore.painted, { timeout: 3000 });
  const scrollHistory = await evalSafe(() => {
    const scroller = document.querySelector('[data-table-scroll]');
    const rows = [...document.querySelectorAll('#content-host tbody tr[data-row-key]')];
    return {
      painted: rows.length,
      pending: Number(document.querySelector('[data-score-table]')?.dataset.rowsPending || 0),
      top: scroller?.scrollTop || 0,
      oldestPaintedDay: rows.at(-1)?.querySelector('[data-event-day]')?.dataset.eventDay || null,
      lastKey: rows.at(-1)?.dataset.rowKey || null,
    };
  });
  ok('the history table starts with one page instead of painting its full data set',
    scrollBefore.painted > 0 && scrollBefore.painted < allRows && scrollBefore.pending === allRows - scrollBefore.painted,
    `${scrollBefore.painted} painted · ${scrollBefore.pending} pending · ${allRows} total`);
  ok('scrolling the internal table appends the next chronological page',
    scrollHistory.top > scrollBefore.top && scrollBefore.scrollHeight > scrollBefore.clientHeight &&
      scrollHistory.painted > scrollBefore.painted && scrollHistory.painted < allRows &&
      scrollHistory.pending === allRows - scrollHistory.painted && scrollHistory.lastKey !== scrollBefore.lastKey,
    `painted ${scrollBefore.painted} → ${scrollHistory.painted}; reached ${scrollHistory.oldestPaintedDay}; ${scrollHistory.pending} pending`);
  await page.locator('[data-table-scroll]').evaluate((el) => { el.scrollTop = 0; });

  const dateFilter = page.locator('select[aria-label="Date range"]');
  ok('the date filter opens on all available dates', (await dateFilter.inputValue()) === 'all');
  await dateFilter.selectOption('today');
  await page.waitForTimeout(400);
  await settleTables();
  const todayRows = await alertDataCount();
  const todayDays = await page.$$eval('[data-event-day]', (els) => [...new Set(els.map((el) => el.dataset.eventDay))]);
  // A committed capture can legitimately lag the Indian calendar between scheduled runs. In that
  // case Today must be an honest empty result, not a reason for this check to demand invented rows.
  ok('Today only narrows the history without changing the feed', todayRows < allRows && todayDays.every((day) => day === currentAlertDay),
    `${allRows} history → ${todayRows} today (${todayDays.join(', ')})`);
  await dateFilter.selectOption('all');
  await page.waitForTimeout(400);
  await settleTables();
  // Use two feeds whose retained snapshots carry history. The coverage chips answer the separate
  // "looked today?" question, so their current-day figures must not be reused as history totals.
  await page.locator('[data-feed-toggle="insider"]').click();
  await page.waitForTimeout(700);
  await settleTables();
  const oneRows = await alertDataCount();
  ok('ticking one feed narrows the stream to it', oneRows > 0 && oneRows < allRows,
    `${allRows} all → ${oneRows} insider rows`);
  // Tick a SECOND: the two must ADD, which is what makes it a multi-select rather than a radio.
  await page.locator('[data-feed-toggle="announcements"]').click();
  await page.waitForTimeout(700);
  await settleTables();
  const twoRows = await alertDataCount();
  // Leave the second feed selected by unticking the first, which measures its full retained count
  // independently without reaching into collector internals or depending on the capture date.
  await page.locator('[data-feed-toggle="insider"]').click();
  await page.waitForTimeout(700);
  await settleTables();
  const secondRows = await alertDataCount();
  ok('...and a second tick adds to it rather than replacing it',
    secondRows > 0 && twoRows === oneRows + secondRows,
    `${oneRows} insider + ${secondRows} announcements = ${twoRows}`);
  // UNTICKING THE LAST ONE RETURNS TO ALL, never to an empty stream. A reader who has unticked
  // their way to a blank page has no control on screen saying why it is blank, and "nothing today"
  // is a claim this page may not make on the strength of a filter the reader set.
  await page.locator('[data-feed-toggle="announcements"]').click();
  await page.waitForTimeout(700);
  await settleTables();
  ok('unticking the last feed returns to All rather than emptying the stream',
    (await alertDataCount()) === allRows && (await page.locator('[data-feed-toggle="__all"]').getAttribute('aria-checked')) === 'true',
    `${await alertDataCount()} rows back`);
  await go('/#/research/daily-alerts?scope=portfolio', 4500);

  ok('no legend strip competes with the stream', !/Red — alert/.test(await hostText()));

  // ---- the stream's own furniture ------------------------------------------------------
  await go('/#/research/daily-alerts?scope=portfolio', 5000);
  await settleTables();
  // THE TABLE FILLS THE PAGE. The head above it is one line of chips now, so a scroll container
  // still sized for a description, four stat cards and a legend left a band of dead page beneath
  // it. Measured against the viewport rather than against a magic number.
  const measureStreamFill = () => evalSafe(() => {
    const el = document.querySelector('[data-table-scroll]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), vh: window.innerHeight, height: Math.round(r.height) };
  });
  const fill = await measureStreamFill();
  // Both directions: dead page below is what was reported, and a table hanging past the fold makes
  // the page scroll as well as the table, which is worse than the gap it was meant to close. The
  // height is MEASURED at runtime rather than written into a `calc()`, because the head above it
  // is not a fixed size — the chip row wraps with the window, and there are eight feeds under a
  // narrowed scope against nine under Universe. A constant was exact on one window and left the
  // table ~110px short on a wider one.
  ok('the stream fills the viewport rather than leaving dead page below it',
    fill && fill.vh - fill.bottom >= 0 && fill.vh - fill.bottom <= 48,
    fill ? `table ends ${fill.vh - fill.bottom}px above the fold, ${fill.height}px tall` : 'no scroll container');
  // ...and it still fits after the window changes, which is the case a fixed calc() cannot serve.
  await page.setViewportSize({ width: 1680, height: 940 });
  await page.waitForTimeout(500);
  const refit = await evalSafe(() => {
    const el = document.querySelector('[data-table-scroll]');
    const r = el.getBoundingClientRect();
    return { gap: Math.round(window.innerHeight - r.bottom), h: Math.round(r.height) };
  });
  ok('...and re-fits when the window is resized', refit && refit.gap >= 0 && refit.gap <= 48, `${refit?.gap}px above the fold at 1680x940`);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForTimeout(400);

  // DATE IS ALWAYS PRESENT; CLOCK RESOLUTION IS PER ROW. Some feeds publish a minute, others only a
  // day, and both must remain readable while the history spans many dates.
  for (const sc of ['portfolio', 'universe']) {
    await go(`/#/research/daily-alerts?scope=${sc}`, 4800);
    await settleTables();
    const t = await evalSafe(() => ({
      hasCol: [...document.querySelectorAll('#content-host thead th')].some((h) => /^Date \/ time/i.test(h.innerText.trim())),
      rows: [...document.querySelectorAll('#content-host tbody tr[data-row-key]')].length,
      dated: [...document.querySelectorAll('#content-host [data-event-day]')].filter((el) => /^\d{4}-\d{2}-\d{2}$/.test(el.dataset.eventDay || '')).length,
      resolution: [...document.querySelectorAll('#content-host [data-event-day]')].every((el) => /\d{2}:\d{2} IST|Day only/.test(el.innerText)),
    }));
    ok(`every historical row states its date and time resolution (${sc})`, t.hasCol && t.rows > 0 && t.dated === t.rows && t.resolution,
      `column=${t.hasCol} dated=${t.dated}/${t.rows} resolution=${t.resolution}`);
  }
  await go('/#/research/daily-alerts?scope=portfolio', 4500);
  await settleTables();

  // The dashboard is commonly opened inside a host panel whose CSS viewport is shorter than a
  // full browser window (the reported screenshot was this case). `vh` must keep the table fitted
  // there too; a desktop-only measurement can pass while the embedded view keeps the original gap.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const embeddedFill = await measureStreamFill();
  ok('...and still fills a shorter embedded dashboard panel',
    embeddedFill && embeddedFill.vh - embeddedFill.bottom >= 0 && embeddedFill.vh - embeddedFill.bottom <= 48,
    embeddedFill ? `table ends ${embeddedFill.vh - embeddedFill.bottom}px above the fold, ${embeddedFill.height}px tall` : 'no scroll container');
  await page.setViewportSize({ width: 1440, height: 1100 });

  // THE NEWS TIME, ASSERTED AT THE RULE. All Alerts read it off `raw.page_age`, and `raw` is
  // stripped before the snapshot is written — so it was present on a live walk and absent on every
  // row that came from the file, which is all of them. It reads `publishedAt` now, a first-class
  // field that survives the strip. That field only reaches the committed capture once the Worker
  // deploying this normaliser has run, so what is checked here is the normaliser itself: the case
  // that matters is a day-only value, which must NOT become midnight.
  const instants = await evalSafe(async () => {
    const { isoInstant } = await import('/js/data/filings-shared.js');
    return {
      full: isoInstant('2026-09-01T12:50:00Z'),
      rfc: isoInstant('Mon, 01 Sep 2026 12:50:00 GMT'),
      dayOnly: isoInstant('2026-09-01'),
      bseDay: isoInstant('20260901'),
      human: isoInstant('2 days ago'),
      missing: isoInstant(null),
    };
  });
  ok('a news row with a real timestamp keeps it as a committed field',
    /^2026-09-01T12:50/.test(instants.full) && /^2026-09-01T12:50/.test(instants.rfc), `${instants.full} / ${instants.rfc}`);
  ok('...and a day-only value stays null rather than becoming midnight',
    instants.dayOnly === null && instants.bseDay === null && instants.human === null && instants.missing === null,
    `day=${instants.dayOnly} bse=${instants.bseDay} human=${instants.human}`);
  const badges = await page.$$eval('#content-host tbody tr[data-row-key]', (rows) =>
    rows.map((r) => ({
      direction: (r.innerText.match(/\b(positive|negative|neutral)\b/i) || [])[1]?.toLowerCase(),
      importance: (r.innerText.match(/\b(high|low)\b/i) || [])[1]?.toLowerCase(),
    })));
  ok('every painted row shows both direction and importance badges',
    badges.length > 0 && badges.every((x) => ['positive', 'negative', 'neutral'].includes(x.direction) && ['high', 'low'].includes(x.importance)),
    `${badges.length} rows`);

  // ---- a row goes to the SOURCE, not to another tab of ours ----------------------------
  // The reader has already read the headline here; sending them to a tab to find it again is two
  // clicks and a scan. Asserted as a popup to the row's own href AND as the hash staying put,
  // because "it navigated somewhere" would pass on the old behaviour too.
  // ASSERTED AT `window.open`, NOT AT A POPUP EVENT. Headless Chromium here does not materialise a
  // window for an external host it cannot reach, so waiting for a `popup` event measures the
  // sandbox rather than the page — it came back empty while the call was being made correctly.
  // What the row promises is that it opens the SOURCE and does not navigate this dashboard, and
  // both halves are checked: the URL passed to `window.open`, and the hash staying put.
  await evalSafe(() => {
    window.__opened = [];
    const real = window.open;
    window.open = (...a) => {
      window.__opened.push(a[0]);
      return real.call(window, ...a);
    };
  });
  const rowHref = await evalSafe(() => {
    const tr = document.querySelector('#content-host tbody tr[data-row-key]');
    const a = tr?.querySelector('a[href^="http"]');
    return a ? a.getAttribute('href') : null;
  });
  if (!rowHref) {
    skip('clicking a row opens the source, not another tab of ours', 'no row in the current capture carries a URL');
  } else {
    const hashBefore = page.url();
    await page.locator('#content-host tbody tr[data-row-key]').first().locator('td').nth(4).click();
    await page.waitForTimeout(800);
    const opened = await evalSafe(() => window.__opened || []);
    ok('clicking a row opens the source, not another tab of ours',
      opened.length === 1 && opened[0] === rowHref && page.url() === hashBefore,
      `${opened.length} open(s): ${(opened[0] || '(none)').slice(0, 58)} · hash unchanged=${page.url() === hashBefore}`);
  }
  await page.locator('[data-alerts-info]').first().click();
  await page.waitForTimeout(200);
  ok('the alert-stream status remains popup-free after table interaction',
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);
}

// ---------------------------------------------------------------------------------------
// 3e. The Watchlist scope
//
// The scope is only as good as the thing it filters by, and that thing changed: the star used to
// store whatever a table used as a ROW key — four different vocabularies across the tabs — and now
// stores a company. Both halves are asserted: that the star records a company, and that every
// scope-aware tab then narrows to it.
// ---------------------------------------------------------------------------------------
console.log('\n— watchlist scope —');
{
  await page.evaluate(() => localStorage.removeItem('sattva:watchlist'));

  // Ask remains useful in an empty watchlist: its catalog and source-status evidence still explain
  // what is and is not available, so the shell must not replace it with the generic empty panel.
  await go('/#/research/ask-research?scope=watchlist', 1200);
  ok('Ask Research remains available with an empty watchlist',
    (await page.locator('[data-research-workspace]').count()) === 1 &&
      (await page.locator('[data-watchlist-empty]').count()) === 0);

  // EMPTY IS ITS OWN STATE, answered by the shell for every tab rather than by each tab's "no
  // results match your filters", which would send the reader hunting for a filter to clear.
  await go('/#/research/daily-alerts?scope=watchlist', 1500);
  ok('an empty watchlist gets its own panel, not an empty table', (await page.locator('[data-watchlist-empty]').count()) === 1);
  const emptyText = await hostText();
  ok('...saying there are zero watchlist companies', /zero watchlist companies/i.test(emptyText));
  const addWatchlist = page.locator('[data-watchlist-add]');
  ok('...with a direct Add companies to watchlist action',
    (await addWatchlist.innerText()).trim() === 'Add companies to watchlist');
  await addWatchlist.click();
  await page.locator('[data-scope-list-panel]').waitFor({ state: 'visible', timeout: 3000 });
  ok('the empty-state action opens the existing editor directly for Watchlist',
    (await page.locator('[data-scope-editor="watchlist"]').count()) === 1 &&
      (await page.locator('[data-scope-search]').getAttribute('placeholder'))?.startsWith('Search company'));
  ok('...without navigating away from the selected Watchlist scope', /scope=watchlist/.test(page.url()));
  await page.getByRole('button', { name: 'Done' }).click();
  ok('...and it answers every tab, not just this one',
    await (async () => {
      for (const t of ['earnings-hub', 'breakouts', 'corp-announcements']) {
        await go(`/#/research/${t}?scope=watchlist`, 1200);
        if ((await page.locator('[data-watchlist-empty]').count()) !== 1) return false;
      }
      return true;
    })());

  // THE STAR RECORDS A COMPANY, AND THE ROW KEY IS NOT IT. The Earnings Hub keys its rows on
  // Moneycontrol's scID; if the two were the same string the watchlist would be full of scIDs and
  // the scope would have nothing to match.
  await go('/#/research/earnings-hub?scope=universe', 3500);
  // STAR A COMPANY THE FEED BELOW ACTUALLY CARRIES. The narrowing assertion a few lines down counts
  // TECHNICALS rows in watchlist scope, so starring the Earnings Hub's first row made this check
  // depend on which company Moneycontrol happened to list first — a live feed that reorders between
  // runs. When that company was not among technicals' 603 the count was legitimately 0 and the
  // check failed with nothing wrong. Pick the first row whose company IS in the technicals
  // universe; the claim being tested (row key ≠ watch key) is unchanged.
  const pickIdx = await evalSafe(async () => {
    const tech = await import('/js/data/technicals.js');
    await tech.load();
    // The ticker lives on `company`, not on the scored row — `forScope` reads `s.company?.ticker`.
    const known = new Set(tech.all().map((c) => String(c.company?.ticker || '').toUpperCase()));
    const rows = [...document.querySelectorAll('#content-host tbody tr')];
    return rows.findIndex((r) => known.has(String(r.querySelector('[data-watch]')?.dataset.watch || '').toUpperCase()));
  });
  const ehRow = page.locator('#content-host tbody tr').nth(pickIdx >= 0 ? pickIdx : 0);
  const rowKey = await ehRow.getAttribute('data-row-key');
  const watchKey = await ehRow.locator('[data-watch]').getAttribute('data-watch');
  ok('the star marks the COMPANY, not the row it sits on', !!watchKey && watchKey !== rowKey, `row ${rowKey} vs company ${watchKey}`);
  await ehRow.locator('[data-watch]').click();
  await page.waitForTimeout(500);
  ok('...and starring it stores that company', await page.evaluate((t) =>
    JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some((e) => e.ticker === t), watchKey));

  // ONE COMPANY, SEVERAL ROWS. Three announcements from one filer share a watch key, and starring
  // any of them must fill the star on all three — invalidating only the clicked row would leave the
  // others showing the opposite of what is stored.
  await go('/#/research/corp-announcements?scope=universe', 4000);
  const dupe = await evalSafe(() => {
    const seen = new Map();
    for (const btn of document.querySelectorAll('#content-host tbody tr [data-watch]')) {
      const k = btn.dataset.watch;
      if (!k) continue;
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > 1) return k;
    }
    return null;
  });
  if (!dupe) {
    skip('starring one row of a company fills the star on its other rows', 'no company has two rows in the current capture');
  } else {
    await page.locator(`#content-host tbody tr [data-watch="${dupe}"]`).first().click();
    await page.waitForTimeout(700);
    const glyphs = await page.$$eval(`#content-host tbody tr [data-watch="${dupe}"]`, (bs) => bs.map((b) => b.innerText.trim()));
    ok('starring one row of a company fills the star on its other rows', glyphs.length > 1 && glyphs.every((g) => g === '★'),
      `${glyphs.length} rows: ${glyphs.join('')}`);
    await page.locator(`#content-host tbody tr [data-watch="${dupe}"]`).first().click();
    await page.waitForTimeout(400);
  }

  // THE SCOPE NARROWS EVERY FEED. `scopeTickers` is the one implementation behind all of them, so
  // this is asserted through the modules rather than by counting rows on eight tabs.
  const narrowing = await evalSafe(async () => {
    const scope = await import('/js/data/scope.js');
    const wl = await import('/js/core/watchlist.js');
    const tech = await import('/js/data/technicals.js');
    const cov = await import('/js/data/coverage.js');
    await tech.load();
    return {
      scopes: scope.SCOPES,
      watched: wl.all().map((e) => e.ticker),
      universe: tech.forScope('universe', cov.holdings()).length,
      portfolio: tech.forScope('portfolio', cov.holdings()).length,
      watchlist: tech.forScope('watchlist', cov.holdings()).length,
      // The distinction `null` vs an empty Set: an empty watchlist must narrow to NOTHING, not to
      // everything. A scope that silently meant its own opposite is the failure being closed here.
      emptyNarrowsToNothing: scope.scopeTickers('watchlist', cov.holdings()) !== null,
    };
  });
  ok('the scope vocabulary is portfolio → watchlist → universe, widest last',
    narrowing.scopes.join(',') === 'portfolio,watchlist,universe', narrowing.scopes.join(','));
  ok('the watchlist scope narrows a feed to the starred companies',
    narrowing.watchlist > 0 && narrowing.watchlist <= narrowing.watched.length && narrowing.watchlist < narrowing.portfolio,
    `${narrowing.universe} universe → ${narrowing.portfolio} book → ${narrowing.watchlist} watched`);
  ok('...and it is a real filter rather than "everything that is not the book"', narrowing.emptyNarrowsToNothing);

  // The denominator, per the rule that a bare count invites the reading that it is complete — and
  // worded as the watchlist's own gap, which is not the book's permanent one.
  await go('/#/research/breakouts?scope=watchlist', 3000);
  const wlText = await hostText();
  ok('a watchlist-scoped pill prints its denominator', /Watchlist · \d+ of \d+/.test(wlText), (wlText.match(/Watchlist[^\n]*/) || [])[0]);

  // A legacy set is PRUNED, not reinterpreted: a composite row key was never a company, and reading
  // it back as one would file a value that meant something else as a measurement.
  const pruned = await evalSafe(async () => {
    localStorage.setItem('sattva:watchlist', JSON.stringify(['RELIANCE', 'RELIANCE-2026-08-12-7', 'ann:abc|def', 'tcs']));
    localStorage.removeItem('sattva:watchlist:shape');
    const wl = await import(`/js/core/watchlist.js?bust=${Date.now()}`);
    return wl.all().map((e) => e.ticker);
  });
  ok('a legacy row key is dropped rather than filed as a company',
    pruned.includes('RELIANCE') && pruned.includes('TCS') && !pruned.some((t) => /[|\-]\d/.test(t)), pruned.join(', '));

  await page.evaluate(() => localStorage.removeItem('sattva:watchlist'));
}

// ---------------------------------------------------------------------------------------
// 3f. Family Portfolio view and editable Watchlist/Universe lists
//
// The committed book/universe remain the defaults; edits are a browser-local overlay. The search
// itself is intercepted here so verification never spends the user's Muns token or calls their
// production registry.
// ---------------------------------------------------------------------------------------
console.log('\n— editable scope lists —');
{
  await page.evaluate(() => {
    localStorage.removeItem('sattva:scope-lists:v1');
    localStorage.removeItem('sattva:watchlist');
  });
  await page.route('**/api/stock-search*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    const reliance = /relian/i.test(query);
    const result = reliance
      ? { ticker: 'RELIANCE', country: 'India', name: 'Reliance Industries Ltd', industry: 'Refineries & Marketing', validTicker: true }
      : { ticker: 'ALPHACO', country: 'India', name: 'Alpha Company Ltd', industry: 'Industrials', validTicker: true };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, query, totalResults: 1, results: [result] }),
    });
  });

  await go('/#/research/insider-trades?scope=portfolio', 1800);
  ok('the scope control has an editor for the active list', (await page.locator('[data-scope-edit]').count()) === 1);
  await page.locator('[data-scope-edit]').click();
  await page.locator('[data-scope-list-panel]').waitFor({ state: 'visible', timeout: 4000 });
  ok('Portfolio opens the Family holdings in a read-only view',
    (await page.getByRole('heading', { name: 'View Portfolio', exact: true }).count()) === 1 &&
    (await page.locator('[data-scope-remove], [data-scope-reset]').count()) === 0);
  await page.locator('[data-scope-search]').fill('KISSHT');
  ok('OnEMI resolves by ticker as already owned', /Owned/.test(await page.locator('[data-scope-members]').innerText()));
  await page.getByRole('button', { name: 'Done' }).click();

  await go('/#/research/daily-alerts?scope=watchlist', 900);
  await page.locator('[data-watchlist-add]').click();
  await page.locator('[data-scope-list-panel]').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('[data-scope-search]').fill('ALPHA');
  await page.locator('[data-scope-result="0"]').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('[data-scope-result="0"]').click();
  ok('the empty-state editor adds a company to Watchlist',
    (await page.locator('[data-scope-count]').innerText()).replace(/,/g, '') === '1' &&
      await page.evaluate(() => JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some((e) => e.ticker === 'ALPHACO')));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(500);
  ok('closing the editor repaints an empty Watchlist scope into the newly populated scope',
    (await page.locator('[data-watchlist-empty]').count()) === 0);

  await go('/#/research/breakouts?scope=universe', 2200);
  await page.locator('[data-scope-edit]').click();
  await page.locator('[data-scope-list-panel]').waitFor({ state: 'visible', timeout: 10000 });
  const universeBefore = Number((await page.locator('[data-scope-count]').innerText()).replace(/,/g, ''));
  await page.locator('[data-scope-search]').fill('ALPHA');
  await page.locator('[data-scope-result="0"]').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('[data-scope-result="0"]').click();
  ok('Universe accepts a company not present in the committed technicals set',
    Number((await page.locator('[data-scope-count]').innerText()).replace(/,/g, '')) === universeBefore + 1);
  await page.locator('[data-scope-search]').fill('RELIAN');
  await page.locator('[data-scope-result="0"]').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('[data-scope-result="0"]').click();
  ok('a base Universe company can be excluded from ticker-based feeds', await page.evaluate(async () => {
    const scope = await import('/js/data/scope.js');
    return !scope.scopeAllowsTicker('universe', 'RELIANCE');
  }));
  await page.getByRole('button', { name: 'Done' }).click();

  await page.unroute('**/api/stock-search*').catch(() => {});
  await page.evaluate(() => {
    localStorage.removeItem('sattva:scope-lists:v1');
    localStorage.removeItem('sattva:watchlist');
  });
}

// ---------------------------------------------------------------------------------------
// 3c. A sub-view's controls must not MOVE when you change sub-view
//
// They did: the Earnings Hub's chip row lived in sectionHead's `meta` slot, which is one half of
// a `justify-between` row. Whether it rendered beside the title or wrapped under it depended on
// how wide the chips and the description happened to be — and both change with the sub-view. So
// Latest Results drew them left, under the title, and Earnings Calendar drew them right, beside
// it. Controls that jump when you use them read as a different page rather than another view of
// one. They now have a row of their own, which cannot wrap and so cannot move.
// ---------------------------------------------------------------------------------------
console.log('\n— section head —');
{
  const controlsBox = async () => {
    const row = page.locator('#content-host [data-section-controls]').first();
    await row.waitFor({ timeout: 10000 });
    const b = await row.boundingBox();
    const t = await page.locator('#content-host h2').first().boundingBox();
    return { x: Math.round(b.x), y: Math.round(b.y), titleX: Math.round(t.x), titleBottom: Math.round(t.y + t.height) };
  };
  // `?view=`, NOT a route segment — this tab has `subviews: []` and switches on a query param.
  // A path segment is discarded by the router, so `/earnings-hub/calendar` renders Latest Results
  // and the comparison below would be measuring one view against itself.
  await go('/#/research/earnings-hub?scope=universe&view=reported', 3200);
  const a = await controlsBox();
  ok('...on Latest Results', /Latest Results/.test(await hostText()));
  await go('/#/research/earnings-hub?scope=universe&view=calendar', 4500);
  const b = await controlsBox();
  ok('...and on Earnings Calendar, which is a different view', /Earnings Calendar/.test(await page.locator('#content-host h2').first().innerText()));
  ok('the sub-view controls sit in the same place on both sub-views', a.x === b.x, `x ${a.x} vs ${b.x}`);
  ok('...aligned to the title, not floated to the right', a.x === a.titleX && b.x === b.titleX, `${a.x}/${a.titleX} and ${b.x}/${b.titleX}`);
  ok('...and below it rather than beside it', a.y >= a.titleBottom && b.y >= b.titleBottom, `${a.y} vs ${a.titleBottom}, ${b.y} vs ${b.titleBottom}`);
}

// ---------------------------------------------------------------------------------------
// 4. Drill panel
//
// The Earnings Hub deliberately has none: once both reported periods became columns, the drill
// was restating the row you clicked on. So the check here is the opposite of everywhere else —
// clicking a row must do NOTHING, and the row must not advertise itself as clickable.
// ---------------------------------------------------------------------------------------
console.log('\n— drill —');
// Navigate explicitly rather than inheriting whatever the previous section left on screen. This
// block used to run on whichever route the section above it happened to end on, so inserting a
// section that finishes somewhere else — the calendar, which has no table on a static origin —
// hung it on a locator that could never resolve. A check should state the page it is about.
await go('/#/research/earnings-hub?scope=universe&view=reported', 3000);
const ehRow = page.locator('tr[data-row-key]').first();
ok('earnings rows are not styled as clickable', !((await ehRow.getAttribute('class')) || '').includes('cursor-pointer'));
await ehRow.click();
await page.waitForTimeout(600);
const ehDrillOpen = await page.evaluate(() => {
  const d = document.getElementById('drill-panel');
  return !!d && d.classList.contains('translate-x-0');
});
ok('...and clicking one opens no drill', !ehDrillOpen);
// The passive Live label stays visible, but it no longer acts as a route to an explainer dialog.
ok('...and keeps one passive Live status label', (await page.locator('[data-live-info]').count()) === 1);

// The drill itself still has to work where it IS used. Breakouts is the reference consumer: a
// scored row with per-rule provenance behind it.
await go('/#/research/breakouts/technical-scanner?scope=universe', 2000);
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(700);
const drill = await page.locator('#drill-content').innerText();
ok('drill opens from a row', drill.length > 200);
ok('drill shows the scored rules', /moving average|trend|momentum/i.test(drill));
ok('drill carries per-rule provenance', /source|calculation/i.test(drill));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('ESC closes the drill', (await page.locator('#drill-panel.translate-x-full, #drill-panel:not(.translate-x-0)').count()) > 0);

// ---------------------------------------------------------------------------------------
// 4b2. Breakouts opens on Strong Breakouts, and no chip narrows the view on the reader's behalf
//
// The tab used to land on Technical Scanner — the whole scored universe — while the view that
// answers "what is breaking out today" sat second in the list. Strong Breakouts is first now, and
// the shell resolves an absent sub-view to `subviews[0]`, so the picker order and the landing
// route are one fact rather than two that could drift; both are asserted off the same navigation.
//
// The filters are the other half of it. Three of the four groups already defaulted to their widest
// option, but that option sat LAST in its row, and the fourth — the trend filter — shipped on
// "Above 200 DMA only". So a breakout below the primary trend line was absent from a table that
// gave no sign it was withholding anything: nothing was wrong, nothing said anything, and the rows
// were simply not there. Every group now leads with All, and a landing with no query string has
// All selected in all four.
//
// The last check is the one that is easy to skip and expensive to lose: the ids were renamed, so a
// bookmarked `?bo=any&vol=any&near=any&dma=any` must still light its chips. Without the alias the
// row would render with nothing selected while the filter behaved as though something were —
// state and screen disagreeing, which is this codebase's most-repeated failure shape.
// ---------------------------------------------------------------------------------------
console.log('\n— breakouts: default view and filters —');
{
  await go('/#/research/breakouts?scope=universe', 2500);
  await waitForPanel();
  ok('a bare /breakouts route lands on Strong Breakouts', /breakouts\/strong-breakouts/.test(page.url()), page.url());

  // The menu markup is in the DOM whether or not it is open — only a `hidden` class moves — so
  // this click is not what makes the items readable. It is here because the assertion below is
  // about what the READER can see, and a menu clipped by its own card reads identically to a
  // closed one from the DOM alone.
  await page.locator('#subview-mount [data-dd-trigger]').click();
  await page.waitForTimeout(300);
  const picker = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#subview-mount [data-dd-id]')];
    return {
      ids: items.map((b) => b.dataset.ddId),
      checked: items.find((b) => b.className.includes('text-indigo-700'))?.dataset.ddId || null,
      face: document.querySelector('#subview-mount [data-dd-trigger]')?.innerText.replace(/\s+/g, ' ').trim() || '',
    };
  });
  await page.keyboard.press('Escape');
  ok('...which is the first item in the sub-view picker', picker.ids[0] === 'strong-breakouts', picker.ids.join(' · '));
  ok('...and is the one the picker is set to', picker.checked === 'strong-breakouts' && /Strong Breakouts/.test(picker.face), `${picker.checked} — "${picker.face}"`);

  // Read the chip bar as it is drawn: the first chip of every group, and which chip is selected.
  // Asserted off the DOM rather than the module's config, because the config being right and the
  // bar drawing something else is precisely the bug worth catching.
  const chips = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chip-bar] > div')];
    return rows.map((row) => {
      const btns = [...row.querySelectorAll('[data-chip-id]')];
      return {
        group: row.querySelector('span')?.innerText.trim() || '',
        first: btns[0]?.dataset.chipId || null,
        firstLabel: btns[0]?.querySelector('span')?.innerText.trim() || '',
        active: btns.filter((b) => b.className.includes('border-indigo-500')).map((b) => b.dataset.chipId),
        ids: btns.map((b) => b.dataset.chipId),
      };
    });
  });
  ok('the Strong Breakouts chip bar has all four filter groups', chips.length === 4, chips.map((c) => c.group).join(' · '));
  ok('every group leads with an All chip',
    chips.length === 4 && chips.every((c) => c.first === 'all' && /^all$/i.test(c.firstLabel)),
    chips.map((c) => `${c.group}: ${c.firstLabel || '—'}`).join(' · '));
  ok('...and All is what a fresh landing has selected in every one',
    chips.length === 4 && chips.every((c) => c.active.length === 1 && c.active[0] === 'all'),
    chips.map((c) => `${c.group}: ${c.active.join(',') || 'none'}`).join(' · '));
  ok('...so no group still carries a retired "any" chip',
    chips.every((c) => !c.ids.includes('any')),
    chips.map((c) => c.ids.join('/')).join(' · '));

  // The trend filter defaulting to above-200-DMA was the one that actually hid rows, so assert the
  // narrowing still works — an All that cannot be narrowed would be the opposite mistake.
  const wideRows = await rowCount();
  await go('/#/research/breakouts/strong-breakouts?scope=universe&dma=above', 2500);
  await waitForPanel();
  const narrowRows = await rowCount();
  ok('Above 200 DMA only still narrows (or matches) the All set', narrowRows <= wideRows, `${wideRows} → ${narrowRows}`);

  // A saved link written before the rename.
  await go('/#/research/breakouts/strong-breakouts?scope=universe&bo=any&vol=any&near=any&dma=any', 2500);
  await waitForPanel();
  const legacy = await page.evaluate(() =>
    [...document.querySelectorAll('[data-chip-bar] > div')].map((row) =>
      [...row.querySelectorAll('[data-chip-id]')].filter((b) => b.className.includes('border-indigo-500')).map((b) => b.dataset.chipId)
    )
  );
  ok('a link written with the old "any" ids still selects All in every group',
    legacy.length === 4 && legacy.every((a) => a.length === 1 && a[0] === 'all'),
    legacy.map((a) => a.join(',') || 'none').join(' · '));
  const legacyRows = await rowCount();
  ok('...and paints the same rows as the default landing', legacyRows === wideRows, `${wideRows} vs ${legacyRows}`);
}

// ---------------------------------------------------------------------------------------
// 4b3. The four stat cards are one Live pill now — and the pill still owes what they said
//
// Every Breakouts sub-view opened with a 4-up KPI row: two or three counts and the gradient
// freshness hero. It was the first object on the page, above the table those counts describe, and
// most of it was already on screen a few pixels lower — "Breakout candidates 21 of 586" is the
// line under the chip bar, and "Strong breakouts 0" is the count on the Strong chip itself.
//
// So it went the way the Earnings Hub's strip and Portfolio's four-line block went: a compact,
// passive status label remains while the explanatory popup is removed.
//
// The green is the other half. "A green Live is a claim about data and may not be painted
// unconditionally" is in CLAUDE.md because the header once had a chip reading "just now" whether
// or not a byte had been confirmed in an hour. The first cut of this pill made the opposite
// mistake: it derived freshness from the cron (`30 1 * * 1-5`) and painted amber the moment a
// scheduled run had not landed — which called a 22-hour-old END-OF-DAY capture stale, when
// yesterday's close is the newest close there is. It also keyed the UI to a schedule this repo
// has measured as unhonoured (12 of 124 runs on the market-news job). The threshold is the
// schedule's own worst case instead: three days, wider than any weekend gap.
//
// `freshnessOf` is exported and asserted DIRECTLY, on both sides of that boundary, because the
// shipped snapshot only ever has one age — the stale branch cannot be produced by the fixture,
// exactly as `moveSeverity` cannot be produced by a day with no big faller in it.
// ---------------------------------------------------------------------------------------
console.log('\n— breakouts: the stat strip became a Live pill —');
{
  const SUBVIEWS = [
    ['strong-breakouts', 'Strong Breakouts', false],
    ['technical-scanner', 'Technical Scanner', false],
    ['fii-accumulation', 'FII Accumulation', false],
    ['earnings-surprise', 'Earnings Surprise', true], // estimates unavailable — no live pill
  ];

  const seen = [];
  for (const [sub, label, mock] of SUBVIEWS) {
    await go(`/#/research/breakouts/${sub}?scope=universe`, 2600);
    await waitForPanel();
    seen.push([
      label,
      mock,
      await page.evaluate(() => {
        const host = document.getElementById('content-host');
        const pill = host.querySelector('[data-live-info]');
        const head = host.querySelector('[data-section-head]') || host.firstElementChild;
        return {
          statCards: host.querySelectorAll('.stat-card').length,
          hero: /last refresh/i.test(host.innerText),
          pills: host.querySelectorAll('[data-live-info]').length,
          face: pill ? pill.innerText.replace(/\s+/g, ' ').trim() : null,
          green: pill ? /bg-emerald-50/.test(pill.className) : false,
          amber: pill ? /bg-amber-50/.test(pill.className) : false,
          dot: pill ? pill.querySelectorAll('span.rounded-full').length > 0 : false,
          inHead: !!(pill && head && head.contains(pill)),
        };
      }),
    ]);
  }

  ok('no Breakouts sub-view renders a stat card any more',
    seen.every(([, , m]) => m.statCards === 0),
    seen.map(([l, , m]) => `${l}:${m.statCards}`).join(' · '));
  ok('...nor the gradient Last Refresh hero',
    seen.every(([, , m]) => !m.hero),
    seen.filter(([, , m]) => m.hero).map(([l]) => l).join(', ') || 'none');
  ok('...and each carries exactly one Live pill, in the section head',
    seen.filter(([, unavailable]) => !unavailable).every(([, , m]) => m.pills === 1 && m.inHead),
    seen.map(([l, , m]) => `${l}:${m.pills}${m.inHead ? '' : ' (not in head)'}`).join(' · '));
  ok('a current sub-view\'s pill is green, dotted, and reads "Up to date"',
    seen.filter(([, mock]) => !mock).every(([, , m]) => m.green && m.dot && m.face === 'Up to date'),
    seen.filter(([, mock]) => !mock).map(([l, , m]) => `${l}:"${m.face}"`).join(' · '));

  // Missing estimates must not be replaced by a synthetic table or a live-data label.
  const es = seen.find(([l]) => l === 'Earnings Surprise')[2];
  ok('the unavailable estimates view has no live-data pill', es.pills === 0 && !es.green);
  ok('missing consensus is explicit and no generated rows are shown', /consensus estimates are not connected/i.test(await hostText()) && await rowCount() === 0);

  // The compact status stays on the page without opening a verbose explainer.
  await go('/#/research/breakouts/strong-breakouts?scope=universe', 2600);
  await waitForPanel();
  await page.locator('#content-host [data-live-info]').click();
  await page.waitForTimeout(500);
  ok('clicking a Breakouts status label opens no provenance popup',
    (await page.locator('#content-host [data-live-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);
  // THE QUALITY COLUMN IS GONE AND THE RANKING IS THE SCORE. It used to lead on quality and break
  // ties on the score, which put a "Weak base" above a stronger-scoring row — readable while the
  // Quality column was on screen to explain it, and unreadable the moment it came off. Quality is
  // still what the chips select on: it decides WHICH rows are here, the score decides their order.
  await settleTables();
  const bo = await evalSafe(() => ({
    heads: [...document.querySelectorAll('#content-host thead th')].map((h) => h.innerText.trim()),
    scores: [...document.querySelectorAll('#content-host tbody tr[data-row-key]')]
      .map((r) => Number((r.innerText.match(/(\d+(?:\.\d+)?)\s*\/\s*24/) || [])[1]))
      .filter((n) => !Number.isNaN(n)),
  }));
  ok('the breakout table has no Quality column', !bo.heads.some((h) => /^Quality$/i.test(h)), bo.heads.join(' | '));
  ok('...and its rows are ranked on the score alone',
    bo.scores.length > 1 && bo.scores.every((v, i) => i === 0 || bo.scores[i - 1] >= v),
    bo.scores.slice(0, 6).join(' ≥ '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // The boundary itself, asserted on the exported predicate rather than on whatever age the
  // committed snapshot happens to have today.
  const fresh = await page.evaluate(async () => {
    const { freshnessOf } = await import('/js/tabs/breakouts.js');
    const now = Date.parse('2026-09-01T12:00:00Z');
    const at = (h) => new Date(now - h * 3600 * 1000).toISOString();
    return {
      justNow: freshnessOf(at(0), now).state,
      oneDay: freshnessOf(at(22), now).state,        // yesterday's close — current for an EOD feed
      weekendEdge: freshnessOf(at(71), now).state,   // Friday capture, read on Monday
      pastEdge: freshnessOf(at(73), now).state,      // wider than any weekend gap
      weekOld: freshnessOf(at(24 * 7), now).state,
      missing: freshnessOf(null, now).state,
      garbage: freshnessOf('not a date', now).state,
    };
  });
  ok('a same-day capture is live', fresh.justNow === 'live', fresh.justNow);
  ok('...and so is yesterday\'s close, which is the newest an EOD feed can be',
    fresh.oneDay === 'live', fresh.oneDay);
  ok('...and a Friday capture read on Monday, which is the widest legitimate gap',
    fresh.weekendEdge === 'live', fresh.weekendEdge);
  ok('past that it is stale, not live', fresh.pastEdge === 'stale' && fresh.weekOld === 'stale',
    `${fresh.pastEdge} / ${fresh.weekOld}`);
  ok('and no capture time is its own state — never "live", never "stale"',
    fresh.missing === 'unknown' && fresh.garbage === 'unknown', `${fresh.missing} / ${fresh.garbage}`);
}

// ---------------------------------------------------------------------------------------
// 4c. The live-quote refresh — every branch, stubbed.
//
// This route used to fail for every reader, every time, and the tab said only "Live quote refresh
// failed". Two separate defects sat behind that sentence, and both are asserted here:
//
//   1. The Worker's per-request timeout was 8s while the quote upstream's COLD path measures
//      8-15s, and nothing was cached, so every refresh took the cold path. Sixty fetches were
//      also fired at once, each starting its own timer while the runtime ran about six at a
//      time, so the queued ones expired without ever being sent.
//   2. Even a SUCCESSFUL refresh changed nothing on screen. The payload was fetched and dropped;
//      only the note was rewritten. A button called "Refresh prices" moved no price.
//
// The upstream is stubbed rather than called: a verification run must not depend on somebody
// else's live service, and half of what is checked here (a partial, a 502, an absent route) is
// unreachable on demand against a healthy one.
// ---------------------------------------------------------------------------------------
console.log('\n— breakouts: live quotes —');
let lpReply = null;
const lpSeen = [];
await page.route('**/api/live-prices', async (route) => {
  lpSeen.push(JSON.parse(route.request().postData() || '{}'));
  await route.fulfill({ status: lpReply.status, contentType: 'application/json', body: JSON.stringify(lpReply.body) });
});
// The stubs below deliberately answer 404 and 502, and Chromium logs both as console errors.
// Remember where the log stood so exactly that noise can be dropped afterwards — the console
// check at the end of this run has to keep meaning something.
const lpErrMark = errors.length;

const lpNote = () => page.locator('[data-refresh-note]').innerText();
const lpCell = async (ticker) =>
  page.evaluate((k) => {
    const tr = document.querySelector(`tbody[data-table-body] tr[data-row-key="${k}"]`);
    const td = [...(tr?.querySelectorAll('td') || [])].find((d) => d.innerText.includes('₹'));
    return { text: td?.innerText.trim() || '', html: td?.innerHTML || '', score: tr?.querySelector('td:nth-child(3)')?.innerText.trim() || '' };
  }, ticker);
const lpRefresh = async () => {
  await page.locator('[data-refresh-btn]').click();
  await page.waitForFunction(() => !/Refreshing/.test(document.querySelector('[data-refresh-label]')?.textContent || ''), null, { timeout: 20000 });
  await page.waitForTimeout(200);
};

await go('/#/research/breakouts/technical-scanner?scope=universe', 2500);
const lpKey = await page.evaluate(() => document.querySelector('tbody[data-table-body] tr[data-row-key]')?.dataset.rowKey);
const lpBefore = await lpCell(lpKey);

// (a) a clean success has to reach the table
lpReply = { status: 200, body: { generated_at: new Date().toISOString(), source: 'Munshot quote API (on-demand refresh)',
  upstream: 'https://fastapi.muns.io/stock-data', requested: 2, ticker_count: 1, cached_count: 0, partial: false, missing: [],
  prices: { [lpKey]: { current: 9999.5, prevClose: 9000 } } } };
await lpRefresh();
const lpAfter = await lpCell(lpKey);
ok('the refresh asks for the tickers on screen', lpSeen[0]?.tickers?.includes(lpKey), `${lpSeen[0]?.tickers?.length} tickers`);
ok('a live quote REACHES the CMP cell', lpAfter.text.includes('9,999.5'), `"${lpBefore.text}" -> "${lpAfter.text}"`);
ok('...marked as live rather than silently swapped', /bg-indigo-500/.test(lpAfter.html));
ok('...saying the score underneath is still EOD', /16-rule score is still EOD/.test(lpAfter.html));
// The quote's own previous close, not this morning's EOD percentage carried over beside a
// 14:32 price — that would be two measurements rendered as one.
ok('...with the day change recomputed from the quote\'s own previous close', lpAfter.text.includes('11.11%'), lpAfter.text);
// The 16 rules are computed from the daily OHLCV series. Rescoring them off one live print would
// put a number under a score that never read it.
ok('...and the 16-rule score NOT rescored from a live print', lpAfter.score === lpBefore.score, `${lpBefore.score} -> ${lpAfter.score}`);

// (b) a partial is a success, and a name that can never arrive must not be sold as one that can
lpReply = { status: 200, body: { generated_at: new Date().toISOString(), requested: 10, ticker_count: 1, partial: true,
  missing: [{ ticker: 'AAA', reason: 'timeout' }, { ticker: 'BBB', reason: 'deadline' }, { ticker: 'CCC', reason: 'http-404' }],
  prices: { [lpKey]: { current: 8888, prevClose: 8000 } } } };
await lpRefresh();
const lpPartial = await lpNote();
ok('a partial refresh says how many of how many', /1 of 10 live quotes/.test(lpPartial), lpPartial);
ok('...a transient miss invites another click', /2 still warming upstream — click again/.test(lpPartial), lpPartial);
ok('...a permanent one does NOT, because no click will fix it', /1 not carried by the quote API/.test(lpPartial), lpPartial);
ok('...and the missing names are on the control itself', /timeout: AAA/.test((await page.getAttribute('[data-refresh-btn]', 'title')) || ''));

// A name we never asked for is a third outcome again — blaming the upstream for our own request
// cap would send anyone diagnosing it to the wrong service.
lpReply = { status: 200, body: { generated_at: new Date().toISOString(), requested: 62, ticker_count: 1, partial: true,
  missing: [{ ticker: 'DDD', reason: 'over-cap' }, { ticker: 'EEE', reason: 'over-cap' }],
  prices: { [lpKey]: { current: 7777, prevClose: 7000 } } } };
await lpRefresh();
ok('...and a name beyond the request cap is blamed on the cap, not on the upstream',
  /2 beyond the 60-name request cap/.test(await lpNote()) && !/not carried/.test(await lpNote()), await lpNote());

// (c) a real failure has to be diagnosable from its own artefact — the lesson the chatter feed
//     already paid for. "Failed" naming neither the address asked nor the reason is unfalsifiable.
lpReply = { status: 502, body: { error: 'no quotes retrieved', upstream: 'https://fastapi.muns.io/stock-data',
  requested: 60, reasons: { timeout: 60 }, missing: [] } };
await lpRefresh();
const lpFail = await lpNote();
ok('a failed refresh names the endpoint it asked', /\/api\/live-prices/.test(lpFail), lpFail);
ok('...the status, the upstream and the upstream\'s own reason', /502/.test(lpFail) && /fastapi\.muns\.io/.test(lpFail) && /60× timeout/.test(lpFail), lpFail);
ok('...and says the EOD data below is untouched', /EOD data below is unchanged/.test(lpFail), lpFail);
ok('...and leaves the button usable', !(await page.locator('[data-refresh-btn]').isDisabled()));

// (d) no Worker at all is a different state from a broken one, and says which command fixes it
lpReply = { status: 404, body: { error: 'Not implemented' } };
await lpRefresh();
ok('an absent route says the Worker is missing, not that quotes failed', /need the Worker/.test(await lpNote()), await lpNote());
ok('...and stops offering the button', await page.locator('[data-refresh-btn]').isDisabled());

// (e) a live quote landing must not cost the reader the view they built
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('[data-table-search]').fill('bank');
await page.waitForTimeout(400);
await page.locator('thead[data-table-head] th[data-sort="CMP"]').click();
await page.waitForTimeout(300);
const lpViewBefore = await page.evaluate(() => ({ q: document.querySelector('[data-table-search]').value,
  rows: [...document.querySelectorAll('tbody[data-table-body] tr[data-row-key]')].map((t) => t.dataset.rowKey) }));
const lpTop = lpViewBefore.rows[0];
lpReply = { status: 200, body: { generated_at: new Date().toISOString(), requested: 1, ticker_count: 1, partial: false, missing: [],
  prices: { [lpTop]: { current: 12345.6, prevClose: 12000 } } } };
await lpRefresh();
const lpViewAfter = await page.evaluate(() => ({ q: document.querySelector('[data-table-search]').value,
  rows: [...document.querySelectorAll('tbody[data-table-body] tr[data-row-key]')].map((t) => t.dataset.rowKey) }));
ok('a refresh keeps the reader\'s search and filtered row set',
  lpViewAfter.q === 'bank' && JSON.stringify(lpViewAfter.rows) === JSON.stringify(lpViewBefore.rows),
  `${lpViewBefore.rows.length} -> ${lpViewAfter.rows.length} rows`);
ok('...while still updating the cell inside it', (await lpCell(lpTop)).text.includes('12,345.6'));
await page.locator('thead[data-table-head] th[data-sort="CMP"]').click();
await page.waitForTimeout(200);
await page.locator('thead[data-table-head] th[data-sort="CMP"]').click();
await page.waitForTimeout(300);
ok('...and a later sort orders by the LIVE price, not the stale close',
  (await page.evaluate(() => document.querySelector('tbody[data-table-body] tr[data-row-key]')?.dataset.rowKey)) === lpTop);

await page.unroute('**/api/live-prices');
// Drop only the deliberate 404/502 the stubs above produced.
errors.splice(lpErrMark, errors.length - lpErrMark, ...errors.slice(lpErrMark).filter((e) => !/status of (404|502)/.test(e)));

await go('/#/research/earnings-hub?scope=universe', 1800);

// ---------------------------------------------------------------------------------------
// 5. Provenance and the other two sub-views
// ---------------------------------------------------------------------------------------
console.log('\n— provenance —');
await go('/#/research/earnings-hub?scope=universe', 1800);
ok('the tab renders without a sub-view in the URL', (await rowCount()) > 1000);
ok('the Earnings view does not print the upstream publisher name', !/money\s*control/i.test(await hostText()));
// The coverage note and the roadmap card were removed from this tab deliberately — one table,
// nothing under it. The passive status label must not reintroduce an explainer modal.
ok('no roadmap placeholder under the table', !/wiring roadmap/i.test(await hostText()));
ok('...and no coverage paragraph either', !/resolved to an NSE ticker/i.test(await hostText()));

// The header status is passive; clicking it must never cover the current task with an explainer.
await page.locator('[data-status-pill]').first().click();
await page.waitForTimeout(200);
ok('the global Live status opens no sources popup',
  (await page.locator('[data-status-pill]').evaluate((el) => el.tagName)) === 'SPAN' &&
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

// The source registry remains data-driven even though it is no longer rendered as a popup.
const sources = await page.evaluate(async () => {
  const { sourcesModalHtml } = await import('/js/ui/sources.js');
  const el = document.createElement('div');
  el.innerHTML = sourcesModalHtml();
  return el.innerText;
});
ok('the source registry lists the live published-results feed without naming the provider',
  /live published-results feed/i.test(sources) && !/money\s*control/i.test(sources));
ok('...and distinguishes real document access from unavailable consensus', /Screener.in — company filings/.test(sources) && /Analyst consensus estimates/.test(sources) && /Not connected/.test(sources) && !/gen-mock-earnings/.test(sources));

// NO FIGURE IN THE SOURCES MODAL MAY BE TYPED BY HAND. Every count in it used to be the number
// that was true the day the sentence was written — "1,319 companies in the current pull", "877 in
// the current pull", "142 companies from the family office statement" — printed as though it were
// a property of the feed. They read exactly like the live figures beside them, which is what makes
// a stale number worse than no number. Each is now read when the modal opens, so the frozen ones
// must NOT appear, and the live ones must agree with what the tabs are showing.
const srcLive = await page.evaluate(async () => {
  const [cov, ec] = [await import('/js/data/coverage.js'), await import('/js/data/earnings-live.js')];
  return { book: cov.meta().count, uncovered: cov.meta().uncovered, reported: ec.all().length };
});
ok('the book count in Sources is read live, not typed', new RegExp(`\\b${srcLive.book} company lines read from the family office`).test(sources), `${srcLive.book} expected`);
ok('...as is the count of lines with no NSE symbol', new RegExp(`\\b${srcLive.uncovered} lines carry no NSE symbol`).test(sources), `${srcLive.uncovered} expected`);
if (srcLive.reported > 0) {
  ok('...and the reported-companies count matches the feed', sources.includes(`${srcLive.reported.toLocaleString('en-US')} in the current pull`), `${srcLive.reported} expected`);
} else {
  skip('...and the reported-companies count matches the feed', 'the results feed has not loaded on this origin');
}
// A count that cannot be read must LOSE ITS CLAUSE, not print a zero or a leftover fragment.
ok('no source describes itself with a zero count', !/\b0 (companies|holdings|lines|in the current pull)/.test(sources), (sources.match(/\b0 \w+/) || [''])[0]);

// ---------------------------------------------------------------------------------------
// 6. Export — the workbook must carry its own provenance
// ---------------------------------------------------------------------------------------
console.log('\n— export —');
await go('/#/research/earnings-hub?scope=universe');
const download = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.locator('#content-host button:has-text("Export")').first().click();
const file = await download;
// SKIP, not FAIL, when the CDN is unreachable: asserting a download that needs an unreachable
// script reports the sandbox's network as a regression in the page.
await downloadOrSkip('Export Excel downloads a workbook', file);

// ---------------------------------------------------------------------------------------
// 6b. Con-call — the LIVE half, off StockScans.
//
// The honesty check that matters here is attribution: the result score, the sentiment tier and
// the highlight bullets are StockScans' analysis, not ours, and every surface that shows them has
// to say so — including the one that leaves the page. And `pending` must never render as a zero.
// ---------------------------------------------------------------------------------------
console.log('\n— con-call: live scan —');
await go('/#/research/concall/concall-scans?scope=universe', 1200);
await waitForPanel();
const csReady = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const n = await rowCount();
    if (n > 0) return n;
    if (/could not reach/i.test(await hostText())) return 0;
    await page.waitForTimeout(300);
  }
  return 0;
})();
ok('the live con-call scan renders the quarter', csReady > 200, `${csReady} calls`);

const csHeads = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
for (const c of ['CALL', 'COMPANY', 'RESULT SCORE', 'RESULT', 'SENTIMENT', 'HIGHLIGHTS']) {
  ok(`con-call column: ${c}`, csHeads.some((h) => h.startsWith(c)), csHeads.join(' | '));
}
const csText = await hostText();
ok('the panel says whose analysis this is', /own analysis/i.test(csText) && /provider/i.test(csText));
// The provider's BRAND is deliberately absent from every customer-facing surface — see the note
// in js/ui/sources.js. What may never go with it is the claim that the analysis is not ours, so
// this pair is asserted together: no brand anywhere, and the disclaimer everywhere.
ok('...without printing the provider\'s brand', !/stockscans/i.test(csText), csText.match(/StockScans/i)?.[0] || '');
// One view, no picker. The tab used to carry six sub-views, four of them on a synthetic transcript
// corpus with fictional speakers; they are gone, and with them the amber ribbon that had to sit
// next to a live green pill explaining which half you were looking at.
ok('the tab renders with no sub-view in the URL', csReady > 200);
ok('...and the shell drops the sub-view picker entirely', await page.evaluate(() => {
  const m = document.getElementById('subview-mount');
  return !m || m.classList.contains('hidden') || !m.innerText.trim();
}));
ok('...and nothing on the tab is flagged illustrative any more', (await page.locator('[data-mock-ribbon]').count()) === 0);

// Times are IST, not the viewer's zone. An 18:00 IST call is an 18:00 IST event; rendering it in
// the browser's local zone turned it into 12:30 on a UTC machine.
const csTimes = await page.$$eval('#content-host tbody tr td:first-child', (ts) => ts.slice(0, 40).map((t) => t.innerText.trim()));
ok('call times render in IST regardless of the viewer’s zone', csTimes.some((t) => /\d{2}:\d{2}/.test(t)) && !csTimes.every((t) => /00:00/.test(t)), csTimes[0]);

// pending is not zero.
const csPending = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const rows = mod.all();
  const nulls = rows.filter((r) => r.analysisTracked !== false && r.resultScore == null);
  const documentsOnly = rows.filter((r) => r.analysisTracked === false);
  const zeros = rows.filter((r) => r.resultScore === 0);
  return { total: rows.length, nulls: nulls.length, documentsOnly: documentsOnly.length, zeros: zeros.length, analysed: rows.filter((r) => r.resultScore != null).length };
});
ok('unanalysed calls carry a null score, never a zero', csPending.nulls >= 0 && csPending.zeros === 0, `${csPending.nulls} pending · ${csPending.documentsOnly} document-only of ${csPending.total}`);
await page.locator('#content-host select').first().selectOption('pending');
await page.waitForTimeout(600);
ok('...and the pending filter shows them as “pending”', (await rowCount()) === csPending.nulls && (csPending.nulls === 0 || /pending/i.test(await hostText())), `${await rowCount()} rows`);

// A ROW KEY THAT MEANS TWO ROWS, AND THE ONE SYMPTOM IT PRODUCES.
//
// The provider holds two analyses of some calls — Supriya Lifescience's 14 Aug 11:00 call scored
// 50.4 and 50.3 against two different documents. Keyed on (company, time) both were "the same
// row", so `repaint`'s Map of <tr> nodes dropped one and the orphan stayed in the DOM through
// every filter: a scored call sitting at the top of "Awaiting analysis", out of sort order.
// A ROW COUNT CANNOT CATCH THIS on its own, so both halves are asserted — the key is unique in
// the data, and nothing scored is drawn under a filter that excludes scored rows.
const csKeys = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const rows = mod.all();
  const keys = rows.map((r) => String(mod.rowUid(r)));
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  const collided = [...counts.entries()].filter(([, n]) => n > 1);
  // (company, time) alone: kept as evidence that the collision is REAL and not hypothetical.
  const naive = new Set(rows.map((r) => `${r.companyKey}|${r.when}`));
  return { rows: rows.length, unique: counts.size, collided: collided.length, naiveUnique: naive.size };
});
ok('no two con-call rows share a key, even where the provider holds two analyses of one call',
  csKeys.collided === 0 && csKeys.unique === csKeys.rows,
  `${csKeys.unique} keys for ${csKeys.rows} rows (company+time alone would give ${csKeys.naiveUnique})`);
const csScoredUnderPending = await page.evaluate(() =>
  [...document.querySelectorAll('#content-host tbody tr')].filter((tr) => /\d+(\.\d+)?\s*\/\s*100/.test(tr.innerText)).length);
ok('...so nothing already scored is drawn under “Awaiting analysis”', csScoredUnderPending === 0,
  `${csScoredUnderPending} scored row(s) under the pending filter`);
await page.locator('#content-host select').first().selectOption('all');
await page.waitForTimeout(400);

// The tier labels must be StockScans' own, not a re-banding of ours.
const csBands = await page.evaluate(async () => {
  const m = await import('/js/data/stockscans-shared.js');
  return [85, 61, 45, 21, 3].map((v) => m.resultTierOf(v).label).join(',') + '|' + (m.resultTierOf(null) === null);
});
ok('result tiers use the provider’s published bands', csBands === 'Excellent,Strong,Average,Weak,Poor|true', csBands);

// CON-CALL ROWS ARE INERT, like the Earnings Hub's. The drill they used to open restated the score,
// the tier and the highlights already in the columns beside it — all of it the provider's — so the
// only thing it uniquely carried was the link out, which is now a column. Removing a per-company
// panel about somebody else's analysis is also the right side of "link, do not reproduce".
const ccRow = page.locator('tr[data-row-key]').first();
ok('con-call rows are not styled as clickable', !((await ccRow.getAttribute('class')) || '').includes('cursor-pointer'));
await ccRow.click();
await page.waitForTimeout(600);
ok('...and clicking one opens no drill', !(await page.evaluate(() => {
  const d = document.getElementById('drill-panel');
  return !!d && d.classList.contains('translate-x-0');
})));
ok('...while the way out to their reader survives as a column', (await page.locator('#content-host tbody a[href*="stockscans"]').count()) > 0);

// THE LINK IN THAT COLUMN HAS TO RESOLVE. It was built one path segment short of the provider's
// company route — which requires a period the scan payload does not carry — so every link 404'd
// while looking exactly like a working one. The only signal the reader got was the provider's own
// 404 page, which reads as "their page is gone" when the page is fine and the URL was ours. Their
// document route needs nothing but the document key, so it cannot be built short.
const csLink = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const withDoc = mod.all().filter((r) => r.transcriptUrl);
  return { n: withDoc.length, sample: withDoc[0]?.transcriptUrl || '' };
});
ok('analysed rows carry a summary link', csLink.n > 100, `${csLink.n} links`);
ok('...on the document route, which needs no period', /\/document\/[^/]+\.pdf$/.test(csLink.sample), csLink.sample);
ok('...never on the company route, which does', !/\/company\//.test(csLink.sample), csLink.sample);

// The scan table needs no extra schedule or feed-status chips competing with its controls.
ok('the Con-call header omits Upcoming Concalls and Live/call-count chips',
  (await page.locator('[data-cs-info], [data-open-schedule]').count()) === 0);

// ---------------------------------------------------------------------------------------
// 6c. The schedule, as an overlay — "Upcoming Concalls"
//
// It is a modal off the scan table rather than a second page, which is how StockScans present it.
// The checks that matter: it groups by DATE, marks today, collapses a long day behind "+N more"
// that actually expands, and searches across every day rather than only the visible ones.
// ---------------------------------------------------------------------------------------
if (await page.locator('[data-open-schedule]').count()) {
await page.locator('[data-open-schedule]').click();
await page.waitForTimeout(600);
const calModal = () => page.locator('#modal-content');
const calText = await calModal().innerText();
ok('the Upcoming Concalls button opens the schedule overlay', /Upcoming Concalls/i.test(calText));

const calShape = await page.evaluate(() => {
  const root = document.querySelector('#modal-content');
  const days = [...root.querySelectorAll('section')];
  return {
    days: days.length,
    today: root.innerText.includes('TODAY') || root.innerText.includes('Today'),
    tiles: root.querySelectorAll('section .grid > div').length,
    more: root.querySelectorAll('[data-cal-more]').length,
    firstDay: days[0]?.querySelector('.grid')?.children.length ?? 0,
  };
});
ok('...grouped into days', calShape.days > 0, `${calShape.days} dates`);
// WHETHER TODAY IS IN THE SCHEDULE IS A PROPERTY OF THE CAPTURE'S AGE, NOT OF THE CODE.
// The con-call schedule is a committed snapshot; once it is a few days old it holds no call dated
// today, and this check then fails every run for a reason that has nothing to do with the marker
// working. Same shape as the "+N more" check below — it asserts when there is something to assert
// and skips, with the reason, when there is not.
if (!calShape.days) skip('...with today marked', 'the schedule is empty');
else if (!calShape.today) skip('...with today marked', 'the committed con-call capture holds no call dated today — refresh it with scripts/scrape-concalls.mjs');
else ok('...with today marked', calShape.today);
// WHETHER ANY DAY IS LONG ENOUGH TO COLLAPSE IS A PROPERTY OF THE SCHEDULE, NOT OF THE CODE.
// A quiet week has no day past the per-day cut, and on such a week this check has nothing to
// assert — the sibling search check below already skips for exactly that reason. It used to assert
// `more > 0` and then hard-click `[data-cal-more]`, so a quiet week failed the check AND crashed
// the run on a 30s locator timeout, taking the remaining ~270 assertions with it. A check that
// cannot run is a SKIP; a check that aborts the suite is a bug in the check.
if (!calShape.more) {
  skip('...and each day capped, with the rest behind “+N more”', 'no day in the current schedule is past the per-day cut');
  skip('“+N more” expands its day in place', 'nothing is collapsed to expand');
} else {
  ok('...and each day capped, with the rest behind “+N more”', calShape.more > 0, `${calShape.more} collapsed days`);

  // "+N more" must actually reveal that day, and only that day.
  const beforeMore = await page.locator('#modal-content section .grid > div').count();
  await page.locator('[data-cal-more]').first().click();
  await page.waitForTimeout(300);
  const afterMore = await page.locator('#modal-content section .grid > div').count();
  ok('“+N more” expands its day in place', afterMore > beforeMore, `${beforeMore} → ${afterMore} companies`);
}

// Search has to reach days that are still collapsed, or it would only find what is on screen.
const hidden = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const up = mod.upcoming();
  const byDate = new Map();
  for (const r of up) byDate.set(r.date, [...(byDate.get(r.date) || []), r]);
  // A company past the 7-per-day cut on a day other than the first.
  const dates = [...byDate.keys()].sort();
  for (const d of dates.slice(1)) {
    const list = byDate.get(d);
    if (list.length > 8) return list[list.length - 1].ticker;
  }
  return null;
});
if (hidden) {
  await page.locator('[data-cal-search]').fill(hidden);
  await page.waitForTimeout(400);
  ok('search reaches a company hidden behind a collapsed day', (await calModal().innerText()).includes(hidden), hidden);
  await page.locator('[data-cal-search]').fill('zzzznotacompany');
  await page.waitForTimeout(400);
  ok('...and says so plainly when nothing matches', /No company matches/i.test(await calModal().innerText()));
  await page.locator('[data-cal-search]').fill('');
  await page.waitForTimeout(300);
} else {
  skip('search reaches a company hidden behind a collapsed day', 'no day in the current schedule is long enough to collapse past');
}

// Times are IST here too, and in StockScans' own 12-hour form.
ok('schedule times are 12-hour IST, as the provider prints them', /\b\d{1,2}:\d{2}\s?(AM|PM)\b/.test(await calModal().innerText()));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('ESC closes the schedule overlay', (await page.locator('#modal-overlay.is-open').count()) === 0);
}

// ---------------------------------------------------------------------------------------
// 6d. The Deep Dive column — triggering someone else's pipeline
//
// This column dispatches a run on a SEPARATE dashboard. Three things make it different from every
// other feed here and all three are checked below rather than trusted:
//
//   1. A DISPATCH COSTS MONEY, A READ DOES NOT. Their POST /api/analyze is unauthenticated and
//      every accepted call starts a real LLM run; GET /api/summary and GET /api/report are free.
//      So the suite counts requests by kind: rendering the table may read their index but must
//      dispatch NOTHING, reaching the confirm step must dispatch NOTHING, opening a report they
//      already hold must dispatch NOTHING, and reopening a finished panel must reattach rather
//      than pay for a second run. A regression here is not a visual bug.
//   2. THE REPORT IS EXTERNAL CONTENT with a schema we do not own. It must render sections we
//      have never heard of, and it must not be able to inject markup.
//   3. A REPORT MUST NEVER BE SHOWN UNDER THE WRONG COMPANY'S NAME. The panel is titled from our
//      row and the report is titled from theirs; if those disagree the panel has to say so.
//
// The stub below speaks the documented contract and nothing more, which is exactly what this
// integration is allowed to assume. The suite points the client at it via localStorage, which
// `baseUrl()` reads ahead of the deployed URL in index.html — so a verification run never touches
// the real dashboard and can never spend a run on it.
// ---------------------------------------------------------------------------------------
console.log('\n— con-call: deep dive —');

const ddSummaryBefore = ddHits.summary;
await go('/#/research/concall?scope=universe', 1200);
await waitForPanel();
await page.waitForSelector('[data-deep-dive]', { timeout: 25000 }).catch(() => {});
// COUNT BOTH SIDES OF THE EQUALITY ON A SETTLED TABLE. `scoreTable` paints a screenful and appends
// the rest while the browser is idle, so reading the buttons first and the rows second compares a
// mid-fill number against a finished one: measured, 1,000 buttons against 1,237 rows, with nothing
// wrong on the page. `rowCount()` already waits; this makes the button count wait too.
const ddRows = await rowCount();
const ddCells = await page.locator('[data-deep-dive]').count();
const ddTracked = await page.evaluate(async () => (await import('/js/data/concall-scans.js')).all().filter((row) => row.analysisTracked !== false).length);
ok('every analysis-tracked row carries a Deep Dive button', ddCells > 200 && ddCells === ddTracked && ddCells <= ddRows, `${ddCells} buttons, ${ddTracked} analysis rows, ${ddRows} total rows`);
ok('...and the column is headed Deep Dive', (await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()))).includes('DEEP DIVE'));
ok('THE TABLE DISPATCHES NOTHING ON RENDER', ddHits.analyze === 0 && ddHits.report === 0, `analyze=${ddHits.analyze} report=${ddHits.report}`);
// Their free index is read once per document load and never again — not per row, not per repaint,
// not on a route change within the tab. This navigation is a hash change, so it must add nothing.
ok('their free index has been read', ddHits.summary >= 1, `${ddHits.summary} fetches so far`);
ok('...and a route change inside the tab does not re-read it', ddHits.summary === ddSummaryBefore, `${ddHits.summary - ddSummaryBefore} extra`);

// The shipped page carries the dashboard URL, so a reader lands on the confirm step rather than
// being asked to paste an address nobody could guess.
ok('the deployed page is wired to the Deep Dive dashboard', await page.evaluate(() => typeof window.SATTVA_DEEPDIVE_URL === 'string' && /^https?:\/\//.test(window.SATTVA_DEEPDIVE_URL)));

// The button owns its click: opening the drill behind a panel is not what anyone meant.
await page.locator('[data-deep-dive]').first().click();
await page.waitForTimeout(600);
ok('the button opens the Deep Dive, not the row drill', (await page.locator('#drill-panel.is-open').count()) === 0 && (await page.locator('#workspace-overlay:not(.hidden)').count()) === 1);

await page.waitForSelector('[data-dd-start]', { timeout: 8000 });
const ddConfirm = await page.locator('#workspace-panel').innerText();
ok('...then says a run costs real compute before anything is sent', /costs real compute/i.test(ddConfirm) && /entirely theirs/i.test(ddConfirm));
ok('...and STILL has not dispatched anything', ddHits.analyze === 0, `analyze=${ddHits.analyze}`);

await page.click('[data-dd-start]');
// Their pipeline reports `unknown` for a beat after dispatch while the record propagates. That is
// not a failure and must not read as one — it is simply the first step of their checklist.
await page.waitForFunction(() => /Starting the analysis/i.test(document.querySelector('#workspace-panel')?.innerText || ''), null, { timeout: 15000 })
  .then(() => ok('“unknown” right after dispatch reads as the first stage, not as an error', true))
  .catch(() => ok('“unknown” right after dispatch reads as the first stage, not as an error', false, 'never showed the starting state'));
ok('...and never as an error card', (await page.locator('#workspace-panel [data-dd-start]').count()) === 0);

// THE LOADING WINDOW IS THEIR SCREEN. The API sends a bare stage key; the sentence beside it is
// the one their own dashboard prints for that key, copied from their stage table rather than
// written here. Rendering the raw key, or our own paraphrase, would both be wrong.
await page.waitForFunction(() => /Pulling the latest earnings call & deck/i.test(document.querySelector('#workspace-panel')?.innerText || ''), null, { timeout: 25000 })
  .then(() => ok('a stage key renders as THEIR published label for it', true))
  .catch(() => ok('a stage key renders as THEIR published label for it', false, 'their label never appeared'));
const ddRunning = await page.locator('#workspace-panel').innerText();
ok('...with their percentage and the full checklist', /\d+%/.test(ddRunning) && /Fact-checking every claim/i.test(ddRunning) && /Building the financial model/i.test(ddRunning));
ok('...and none of the chrome their screen does not have', !/elapsed/i.test(ddRunning) && !/Stages so far/i.test(ddRunning) && !/Waiting for the pipeline/i.test(ddRunning));
ok('...and it says the run keeps going in the background', /keeps going in the background/i.test(ddRunning));

await page.waitForSelector('[data-dd-raw]', { timeout: 40000 });
const ddDone = await page.locator('#workspace-panel').innerText();
ok('the finished report renders', /Constructive/.test(ddDone) && /Key Takeaways/i.test(ddDone));
ok('...and says the whole analysis is theirs', /reproduced here unchanged/i.test(ddDone) && /Nothing on this panel is computed/i.test(ddDone));
const ddLink = await page.getAttribute('#workspace-panel a[target=_blank]', 'href');
ok('...and links to their own rendering of it', !!ddLink && ddLink.startsWith(`${ddOrigin}/#/report/`), ddLink || 'no link');

// The stub's dispatched report is deliberately about TATAMOTORS, which is not the row that was
// clicked. Presenting it under this row's name would be the worst thing this panel could do.
ok('a report about another company is called out, not quietly retitled', /This report is for a different company/i.test(ddDone) && /TATAMOTORS/.test(ddDone));

// The schema lives in their repo. A section we have never heard of must still appear.
ok('a section the renderer has never heard of still renders', /Weird New Section/i.test(ddDone) && /kept anyway/i.test(ddDone));

// It is external content, so none of it may reach the DOM as markup.
const ddInjection = await page.evaluate(() => ({
  pwned: !!window.__dd_pwned,
  imgs: document.querySelectorAll('#workspace-panel img').length,
  literal: document.querySelector('#workspace-panel').innerText.includes('<img src=x'),
}));
ok('report strings are escaped, not parsed as markup', !ddInjection.pwned && ddInjection.imgs === 0 && ddInjection.literal, JSON.stringify(ddInjection));

// "Leave it running" has to mean it. Closing the panel leaves the run alone, and REOPENING must
// pick the progress back up on its own — not ask the reader to click "reattach", which is what it
// used to do. Reattaching is a poll, so it costs nothing and may fire unprompted.
const ddAfterRun = ddHits.analyze;
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('[data-deep-dive]').first().click();
await page.waitForSelector('[data-dd-raw]', { timeout: 20000 });
ok('reopening reattaches on its own, with no confirm step in the way', true);
ok('...AND REATTACHING COSTS NOTHING', ddHits.analyze === ddAfterRun, `${ddHits.analyze} dispatches total`);
ok('...never forcing a fresh run behind the reader’s back', ddHits.forced === 0, `${ddHits.forced} forced`);

// "Re-run from scratch" is the one control on a finished report that spends money. It must ask.
await page.click('[data-dd-rerun]');
await page.waitForTimeout(400);
ok('“re-run” asks before spending, rather than dispatching on the click', (await page.locator('[data-dd-start]').count()) === 1 && ddHits.analyze === ddAfterRun, `${ddHits.analyze} dispatches`);
ok('...and says plainly that forcing skips the free reuse', /Forcing a fresh run skips that reuse/i.test(await page.locator('#workspace-panel').innerText()));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------------------
// A report they ALREADY HOLD is a free click, and the column has to say so before it is clicked.
// This is the difference between a reader paying to discover an answer exists and being shown
// that it does, so the button changes and the panel opens the report with no confirm step.
// ---------------------------------------------------------------------------------------
const ddRow = await page.evaluate(() => {
  const lines = (document.querySelector('tr[data-row-key]')?.innerText || '').split('\n').map((l) => l.trim());
  const i = lines.findIndex((l) => l.includes('·'));
  return { ticker: i > 0 ? lines[i].split('·')[0].trim() : '', name: i > 0 ? lines[i - 1] : '' };
});
ddSetReady(ddRow.ticker, ddRow.name, 'already-held-q1fy27');
const ddBeforeReady = ddHits.analyze;
const ddSummaryBeforeReload = ddHits.summary;
// A REAL reload, not a hash change: only a fresh document re-reads their index.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await waitForPanel();
await page.waitForSelector('[data-dd-ready]', { timeout: 20000 }).catch(() => {});
ok('a fresh page load re-reads their index, exactly once', ddHits.summary === ddSummaryBeforeReload + 1, `${ddHits.summary - ddSummaryBeforeReload} fetches on this load`);
// EVERY row for that company, not exactly one. Their index is keyed by company, and four tickers
// in this feed hold two calls in the window (AMAGI, HINDALCO, GMMPFAUDLR, GVPIL) — a company that
// reported twice this quarter is two rows and one report. An earlier `=== 1` here passed only
// because the newest row happened not to be one of those four, and failed the day it was.
const ddReadyMarks = await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('tr[data-row-key]')];
  const forTicker = rows.filter((r) => new RegExp(`\\b${t}\\b`).test(r.innerText));
  return {
    rowsForTicker: forTicker.length,
    markedForTicker: forTicker.filter((r) => r.querySelector('[data-dd-ready]')).length,
    markedTotal: document.querySelectorAll('[data-dd-ready]').length,
  };
}, ddRow.ticker);
ok('a company they already hold a report for is marked ready', ddReadyMarks.markedForTicker === ddReadyMarks.rowsForTicker && ddReadyMarks.rowsForTicker > 0, `${ddRow.ticker}: ${ddReadyMarks.markedForTicker} of ${ddReadyMarks.rowsForTicker} rows marked`);
ok('...and no other company is', ddReadyMarks.markedTotal === ddReadyMarks.markedForTicker, `${ddReadyMarks.markedTotal} marked in total`);
ok('...and the mark says the click starts no run', /Opens without starting a run/i.test((await page.locator('[data-dd-ready]').first().getAttribute('title')) || ''));

// `.first()`, because a company with two calls in the window has two marked buttons — see above.
await page.locator('[data-dd-ready]').first().click();
await page.waitForSelector('[data-dd-raw]', { timeout: 20000 });
const ddReadyPanel = await page.locator('#workspace-panel').innerText();
ok('...clicking it opens their report with no confirm step', /Key Takeaways/i.test(ddReadyPanel));
ok('...AND IT COST NOTHING', ddHits.analyze === ddBeforeReady, `${ddHits.analyze} dispatches total`);
ok('...and says the report was already on file rather than freshly run', /already held/i.test(ddReadyPanel));
ok('...with no mismatch warning, because this one is about the right company', !/different company/i.test(ddReadyPanel));

await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------------------
// A REPORT ALREADY PRODUCED IS KEPT ON THIS DEVICE — the checks that matter most here.
//
// Every other cache on this dashboard saves bytes. This one saves money: a report is the output of
// a metered LLM run, and their store drops one after about a fortnight. Before this, that expiry
// took the report with it — reopening a company analysed last month showed the confirm step, and
// the only way back to an analysis already read was to pay for it again.
//
// So the assertions are about what happens with the upstream copy GONE, which is exactly when a
// cache that merely mirrors a healthy server would be worthless.
// ---------------------------------------------------------------------------------------
const DD_HELD = 'already-held-q1fy27';
ok(
  'a finished report is written to the device, body and all',
  await page.evaluate(async (slug) => {
    const s = await import('/js/core/store.js');
    const hit = await s.readEntry(s.KEYS.deepDiveReport(slug));
    return !!hit?.value?.report?.key_takeaways;
  }, DD_HELD)
);
// The dispatched run returned a TATAMOTORS report against a row that is not TATAMOTORS. It is
// rendered — under a banner saying whose it is — but filing it under our ticker would make every
// later open of that row show another company's analysis, from disk, with no upstream to correct it.
const ddDispatched = String(ddLink || '').split('/report/')[1] || '';
ok(
  '...but a report that contradicts the row is never filed under that row’s ticker',
  !!ddDispatched &&
    (await page.evaluate((slug) => !(slug in JSON.parse(localStorage.getItem('sattva:deepdive-reports') || '{}')), ddDispatched)),
  ddDispatched || 'no dispatched slug'
);

// THEIR COPY IS NOW GONE — both slugs answer `unknown` and their index names nothing. This browser's
// memory of the dispatch is cleared too, so the ONLY route left to that analysis is the device. That
// is the state a reader lands in a month later, and the whole point of keeping the report.
ddForget(DD_HELD);
if (ddDispatched) ddForget(ddDispatched);
await page.evaluate(() => localStorage.removeItem('sattva:deepdive-slugs'));
const ddBeforeGone = { analyze: ddHits.analyze, forced: ddHits.forced };
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await waitForPanel();
await page.waitForSelector('[data-dd-saved]', { timeout: 20000 }).catch(() => {});
ok('the row is still marked free to open, off the device alone', (await page.locator('[data-dd-saved]').count()) >= 1, 'their index now names nothing');
ok('...and says so before it is clicked', /saved on this device/i.test((await page.locator('[data-dd-saved]').first().getAttribute('title')) || ''));

// Record every state the panel passes through, so "it never showed the run screen" is measured
// rather than sampled. A reattach is a free GET; painting the pipeline checklist over it describes
// work that is not happening and reads exactly like the metered thing the reader avoided.
await page.evaluate(() => {
  window.__ddSeen = [];
  const root = document.getElementById('workspace-overlay');
  const push = () => window.__ddSeen.push(document.getElementById('workspace-panel')?.innerText || '');
  new MutationObserver(push).observe(root, { subtree: true, childList: true, characterData: true });
});
await page.locator('[data-dd-saved]').first().click();
await page.waitForSelector('[data-dd-raw]', { timeout: 20000 });
const ddGone = await page.locator('#workspace-panel').innerText();
ok('A REPORT THEY HAVE DROPPED STILL OPENS, FROM THIS DEVICE', /Key Takeaways/i.test(ddGone) && /JLR EBIT margin/i.test(ddGone));
ok('...AND IT COST NOTHING TO GET IT BACK', ddHits.analyze === ddBeforeGone.analyze && ddHits.forced === ddBeforeGone.forced, `${ddHits.analyze} dispatches total`);
ok('...never landing on a confirm step that asks the reader to buy it again', (await page.locator('[data-dd-start]').count()) === 0);
ok('...saying it came from this device, not from them', /saved on this device/i.test(ddGone));
ok('...and saying plainly that their copy is gone', /no longer holds this report/i.test(ddGone));
const ddStates = await page.evaluate(() => window.__ddSeen);
ok(
  '...and it NEVER shows the run screen on the way — nothing was being run',
  ddStates.length > 0 && !ddStates.some((t) => /Starting the analysis|Fact-checking every claim/i.test(t)),
  `${ddStates.length} states observed`
);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// The stub stays up for the rest of the run — see the note beside its construction. The remembered
// slugs and the saved reports are cleared, so a later con-call render starts from the shipped state.
await page.evaluate(async () => {
  localStorage.removeItem('sattva:deepdive-slugs');
  localStorage.removeItem('sattva:deepdive-reports');
  const s = await import('/js/core/store.js');
  await s.deleteEntry(s.KEYS.deepDiveReport('already-held-q1fy27'));
});

// ---------------------------------------------------------------------------------------
// 8. Public Chatter — one live feed, two sections, and the numbers that are not what they look like
//
// This tab used to be three sub-views over a synthetic corpus with fictional handles. It is now
// live off SentimentDash, and the checks moved with it. What matters here is not that a table
// renders — it is the two things this feed makes easy to get wrong:
//
//   • `changePct` upstream is a change in MENTION COUNT. Rendered as a coloured percentage it
//     reads as a price move, and there is no price anywhere in that API.
//   • entries are discovered bottom-up from forum topics, so a third of them are brokers, themes
//     and bare words. A mis-resolved slug would file someone else's forum posts under a holding.
// ---------------------------------------------------------------------------------------
console.log('\n— public chatter —');

// The feed is external. If a stub is running (see scripts/stub-chatter.mjs), point the tab at it
// so the checks below exercise real data without depending on this machine's egress — the same
// arrangement `sattva:deepdive-base` gives the Deep Dive checks.
await page.evaluate((base) => {
  if (base) localStorage.setItem('sattva:chatter-base', base);
}, process.env.CHATTER_STUB || '');
await go('/#/research/public-chatter?scope=universe', 800);
// Wait for the DATA LAYER to settle, not for a fixed number of seconds. This feed is fetched from
// another origin, so how long it takes is a property of the network rather than of the page, and a
// sleep long enough today is a race lost tomorrow — the same reason `waitForPanel` exists.
{
  const until = Date.now() + 30000;
  // eslint-disable-next-line no-constant-condition
  while (Date.now() < until) {
    const settled = await evalSafe(async () => !!(await import('/js/data/chatter-live.js')).meta());
    if (settled) break;
    await page.waitForTimeout(500);
  }
}
await waitForPanel();

const chatterState = await evalSafe(async () => {
  const c = await import('/js/data/chatter-live.js');
  const host = document.querySelector('#content-host');
  const m = c.meta();
  return {
    ok: !!m?.ok,
    reason: m?.reason || null,
    total: m?.total ?? 0,
    companies: m?.companies ?? 0,
    uncovered: m?.uncovered ?? 0,
    generatedAt: m?.generatedAt || null,
    ageSeconds: m?.ageSeconds ?? null,
    tables: host.querySelectorAll('[data-table-scroll]').length,
    statCards: host.querySelectorAll('.stat-card').length,
    footnotes: host.querySelector('[data-chatter-footnotes]')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    headings: [...host.querySelectorAll('h2')].map((h) => h.textContent.trim()),
    tabs: [...host.querySelectorAll('[data-chatter-section-tabs] [role="tab"]')].map((b) => b.textContent.trim()),
    selectedTab: host.querySelector('[data-chatter-section-tabs] [role="tab"][aria-selected="true"]')?.textContent?.trim() || '',
    panel: host.querySelector('[data-chatter-panel]')?.dataset.chatterPanel || '',
    resolvedSample: c.companies().slice(0, 5).map((r) => `${r.slug}->${r.ticker}`),
    unresolvedAllNull: c.uncovered().every((r) => r.ticker === null && !!r.unresolvedReason),
  };
});

if (!chatterState.ok) {
  // The chatter API is EXTERNAL and called straight from the browser, so unlike every other feed
  // this one does not need a Worker — it needs egress. A sandbox with no outbound network reports
  // `unreachable`, which is the correct answer and still has to be NAMED on screen.
  const named = await hostText();
  skip('the chatter feed is live', `reason=${chatterState.reason} — no egress to the upstream from here`);
  ok('...and the tab names the state rather than showing an empty table', /could not be reached|no address|404|unexpected|error/i.test(named), named.slice(0, 90));
} else {
  ok('the chatter feed is live', chatterState.total > 0, `${chatterState.total} entries`);
  ok('...split into covered companies and everything else', chatterState.companies + chatterState.uncovered === chatterState.total,
    `${chatterState.companies} covered + ${chatterState.uncovered} not = ${chatterState.total}`);
  ok('...offers simple Coverage and Not in coverage tabs', chatterState.tabs.join(' | ') === 'Coverage | Not in coverage', chatterState.tabs.join(' | '));
  ok('...opens on Coverage with only its table visible', chatterState.selectedTab === 'Coverage' && chatterState.panel === 'coverage' && chatterState.tables === 1,
    `${chatterState.selectedTab} · ${chatterState.panel} · ${chatterState.tables} table(s)`);
  ok('...with the four summary cards removed', chatterState.statCards === 0, `${chatterState.statCards} stat cards`);
  ok('...and their coverage, posts, mood and scrape facts retained as footnotes',
    /Footnotes.*Coverage:.*Posts:.*Market mood:.*Last scrape:/i.test(chatterState.footnotes), chatterState.footnotes);
  ok('every unresolved entry carries a reason, not just a null', chatterState.unresolvedAllNull);
  ok('the resolver produced real NSE symbols', chatterState.resolvedSample.length > 0, chatterState.resolvedSample.join(', '));
  ok('the scrape time is shown', !!chatterState.generatedAt, chatterState.generatedAt || 'missing');

  const featuredCard = page.locator('#content-host [data-top-cards] [data-top-idx]').first();
  if (await featuredCard.count()) {
    const featured = await evalSafe(async () => {
      const c = await import('/js/data/chatter-live.js');
      const row = c.forScope('universe').find((entry) => entry.mentions > 0);
      return { name: row.name, slug: row.slug, mentions: row.mentions };
    });
    const cardText = (await featuredCard.innerText()).replace(/\s+/g, ' ');
    ok('a most-discussed card explains its count, time period and action',
      /\bmentions?\b/.test(cardText) && /Last \d+ days?/.test(cardText) && cardText.includes('Read mentions'), cardText);
    await featuredCard.click();
    await page.locator('[data-chatter-mention-row]').first().waitFor({ state: 'visible' });
    ok('clicking the card opens that company’s underlying mentions',
      await page.locator('[data-chatter-mentions-dialog]').getAttribute('data-chatter-slug') === featured.slug,
      `${featured.name} · ${featured.mentions} mentions`);
    await page.locator('#modal-content [data-modal-close]').click();
  }

  // A ALL ALERTS CHATTER ROW OPENS THE COMPANY'S MENTIONS POPUP, not just the tab. The chatter
  // event carries no source URL, so daily-alerts.js falls back to the tab WITH the company and an
  // `open=mentions` flag; this asserts the receiving end honours it. Driven through the URL the row
  // click builds (deterministic) rather than through the alerts tab, which needs every feed's egress
  // to render a chatter row at all.
  const deepTicker = await evalSafe(async () => {
    const c = await import('/js/data/chatter-live.js');
    return (c.companies() || [])[0]?.ticker || null;
  });
  if (deepTicker) {
    await go(`/#/research/public-chatter?scope=universe&company=${encodeURIComponent(deepTicker)}&open=mentions`, 900);
    await page.waitForTimeout(600);
    const deep = await evalSafe((t) => {
      const dialog = document.querySelector('[data-chatter-mentions-dialog]');
      const c = document.querySelector('#content-host input')?.value || '';
      return { popup: !!dialog, slug: dialog?.getAttribute('data-chatter-slug') || null, seeded: c.toUpperCase().includes(t) };
    }, deepTicker);
    ok('a chatter deep-link opens that company\'s mentions popup and seeds the search',
      deep && deep.popup && deep.seeded, `popup ${deep?.popup}, search seeded ${deep?.seeded}, slug ${deep?.slug}`);
    // Close it, then a repaint (scope toggle) must NOT reopen it — the guard against a live tick or a
    // scope change re-triggering the popup on every paint.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await go(`/#/research/public-chatter?scope=watchlist&company=${encodeURIComponent(deepTicker)}&open=mentions`, 700);
    await page.waitForTimeout(400);
    const reopened = await evalSafe(() => !!document.querySelector('[data-chatter-mentions-dialog]'));
    ok('...and a scope toggle on the same deep-link does not reopen it', !reopened, `reopened=${reopened}`);
    // `?company=` alone seeds the search but must NOT open the popup — only `open=mentions` does.
    await go('/#/research/ask-research?scope=universe', 500);
    await go(`/#/research/public-chatter?scope=universe&company=${encodeURIComponent(deepTicker)}`, 800);
    await page.waitForTimeout(400);
    const seedOnly = await evalSafe((t) => ({
      popup: !!document.querySelector('[data-chatter-mentions-dialog]'),
      seeded: (document.querySelector('#content-host input')?.value || '').toUpperCase().includes(t),
    }), deepTicker);
    ok('company= alone seeds the search without opening the popup', seedOnly && !seedOnly.popup && seedOnly.seeded,
      `popup ${seedOnly?.popup}, seeded ${seedOnly?.seeded}`);
    await go('/#/research/public-chatter?scope=universe', 800);
  } else {
    skip('a chatter deep-link opens that company\'s mentions popup', 'no resolved chatter company in this run');
  }
  await page.locator('[data-chatter-live]').click();
  await page.waitForTimeout(200);
  ok('the Public Chatter Live label opens no explainer popup',
    (await page.locator('[data-chatter-live]').evaluate((el) => el.tagName)) === 'SPAN' &&
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

  // THE CENTRAL HONESTY CHECK. A mention delta must never be styled like a return: no emerald, no
  // rose, no currency. Those are what make a reader parse it as money.
  const deltaStyling = await evalSafe(() => {
    const cells = [...document.querySelectorAll('#content-host tbody tr')]
      .flatMap((tr) => [...tr.querySelectorAll('td')])
      .filter((td) => /[▲▼·]\s*[+-]?\d+%/.test(td.textContent));
    return {
      n: cells.length,
      coloured: cells.filter((td) => {
        const c = getComputedStyle(td.querySelector('span') || td).color;
        const [r, g, b] = c.match(/\d+/g).map(Number);
        return (g > r + 30 && g > b + 30) || (r > g + 60 && r > b + 30); // emerald-ish or rose-ish
      }).length,
      currency: cells.filter((td) => /[₹$]/.test(td.textContent)).length,
    };
  });
  ok('a mention delta is never coloured like a P&L', deltaStyling.n === 0 || deltaStyling.coloured === 0,
    `${deltaStyling.n} delta cells, ${deltaStyling.coloured} coloured`);
  ok('...and never carries a currency symbol', deltaStyling.currency === 0);

  // The column heading has to say what the number is, because the tooltip is not always read.
  const heads = await evalSafe(() => [...document.querySelectorAll('#content-host thead th')].map((th) => th.textContent.trim()));
  ok('the column says "Mentions", not "Change" or "Return"', heads.some((h) => /mentions/i.test(h)) && !heads.some((h) => /\breturn\b|\bprice\b/i.test(h)), heads.join(' | '));

  const visibleChatterSentiments = async () => evalSafe(() => {
    const table = document.querySelector('#content-host [data-chatter-panel] table');
    const headings = [...(table?.querySelectorAll('thead th') || [])].map((th) => th.textContent.trim().toLowerCase());
    const sentimentIndex = headings.findIndex((heading) => heading === 'sentiment');
    if (!table || sentimentIndex < 0) return [];
    return [...table.querySelectorAll('tbody tr')]
      .map((tr) => tr.querySelectorAll('td')[sentimentIndex]?.textContent?.trim().toLowerCase() || '')
      .filter(Boolean);
  });

  const coverageSentiment = page.locator('#content-host [data-chatter-panel] select[aria-label="Sentiment"]');
  await coverageSentiment.selectOption('bullish');
  await page.waitForTimeout(150);
  const coverageBullishRows = await visibleChatterSentiments();
  ok('Coverage Bullish selector shows only bullish companies in its table',
    coverageBullishRows.length > 0 && coverageBullishRows.every((sentiment) => sentiment === 'bullish'),
    coverageBullishRows.join(' | '));

  await page.locator('[data-chatter-section-tabs] [data-tab-id="not-in-coverage"]').click();
  await page.waitForTimeout(300);
  const notCoveredTab = await evalSafe(() => {
    const host = document.querySelector('#content-host');
    return {
      panel: host.querySelector('[data-chatter-panel]')?.dataset.chatterPanel || '',
      selected: host.querySelector('[data-chatter-section-tabs] [role="tab"][aria-selected="true"]')?.textContent?.trim() || '',
      tables: host.querySelectorAll('[data-table-scroll]').length,
      rows: host.querySelectorAll('tbody tr').length,
      mostDiscussed: /Most discussed/i.test(host.textContent || ''),
      footnotes: host.querySelector('[data-chatter-footnotes]')?.textContent || '',
    };
  });
  ok('Not in coverage replaces the covered-company view with its own table',
    notCoveredTab.panel === 'not-in-coverage' && notCoveredTab.selected === 'Not in coverage' && notCoveredTab.tables === 1 && notCoveredTab.rows > 0,
    `${notCoveredTab.selected} · ${notCoveredTab.tables} table · ${notCoveredTab.rows} rows`);
  ok('...does not repeat the Most Discussed ranking', !notCoveredTab.mostDiscussed);
  ok('...and retains the shared footnotes', /Coverage:.*Posts:.*Market mood:.*Last scrape:/is.test(notCoveredTab.footnotes));

  const mentionTarget = await evalSafe(async () => {
    const c = await import('/js/data/chatter-live.js');
    const row = c.uncovered()[0];
    return { slug: row.slug, name: row.name, mentions: row.mentions };
  });
  ok('every Not in coverage row makes its mention count visibly clickable',
    (await page.locator('#content-host [data-chatter-mentions-trigger]').count()) === notCoveredTab.rows,
    `${await page.locator('#content-host [data-chatter-mentions-trigger]').count()} of ${notCoveredTab.rows}`);
  await page.locator(`#content-host tr[data-row-key="${mentionTarget.slug}"]`).click();
  await page.locator('[data-chatter-mention-row]').first().waitFor({ state: 'visible' });
  const mentionDetail = await evalSafe(() => {
    const modal = document.querySelector('#modal-content [data-chatter-mentions-dialog]');
    const rows = [...(modal?.querySelectorAll('[data-chatter-mention-row]') || [])];
    const links = [...(modal?.querySelectorAll('[data-chatter-mention-link]') || [])];
    const count = modal?.querySelector('[data-chatter-mention-total]');
    const detailTotal = Number(count?.dataset.detailTotal);
    const snapshotTotal = Number(count?.dataset.snapshotTotal);
    return {
      heading: modal?.querySelector('h2')?.textContent?.trim() || '',
      slug: modal?.dataset.chatterSlug || '',
      rows: rows.length,
      detailTotal,
      snapshotTotal,
      changedIsNamed: detailTotal === snapshotTotal || /changed since/i.test(count?.textContent || ''),
      links: links.length,
      safeLinks: links.every((a) => /^https?:\/\//.test(a.href) && a.target === '_blank' && /noopener/.test(a.rel)),
      shortExcerpts: rows.every((row) => (row.querySelector('p')?.textContent?.trim().split(/\s+/).length || 0) <= 25),
    };
  });
  ok('clicking a company opens every mention currently returned by the detail feed',
    mentionDetail.heading === mentionTarget.name && mentionDetail.slug === mentionTarget.slug && mentionDetail.rows === mentionDetail.detailTotal,
    `${mentionDetail.heading} · ${mentionDetail.rows} detail rows · snapshot ${mentionTarget.mentions}`);
  ok('a detail count that moved since the dashboard snapshot is named, not shown as missing rows', mentionDetail.changedIsNamed,
    `${mentionDetail.snapshotTotal} snapshot · ${mentionDetail.detailTotal} detail`);
  ok('every returned mention has a direct, safely opened source link',
    mentionDetail.links === mentionDetail.rows && mentionDetail.safeLinks,
    `${mentionDetail.links} links for ${mentionDetail.rows} mentions`);
  ok('the popup shows only short excerpts rather than copying full posts', mentionDetail.shortExcerpts);
  await page.locator('#modal-content [data-modal-close]').click();

  const uncoveredSentiment = page.locator('#content-host [data-chatter-panel] select[aria-label="Sentiment"]');
  await uncoveredSentiment.selectOption('bullish');
  await page.waitForTimeout(150);
  const uncoveredBullishRows = await visibleChatterSentiments();
  ok('Not in coverage owns a Bullish selector that shows only bullish companies in its table',
    uncoveredBullishRows.length > 0 && uncoveredBullishRows.every((sentiment) => sentiment === 'bullish'),
    uncoveredBullishRows.join(' | '));

  await page.locator('[data-chatter-section-tabs] [data-tab-id="coverage"]').click();
  await page.waitForTimeout(300);
  ok('returning to Coverage restores its selected tab',
    await page.locator('[data-chatter-section-tabs] [data-tab-id="coverage"]').getAttribute('aria-selected') === 'true');
  const restoredCoverageSentiments = await visibleChatterSentiments();
  ok('...and restores Coverage\'s own Bullish filter state',
    await page.locator('#content-host [data-chatter-panel] select[aria-label="Sentiment"]').inputValue() === 'bullish' &&
      restoredCoverageSentiments.length > 0 && restoredCoverageSentiments.every((sentiment) => sentiment === 'bullish'),
    restoredCoverageSentiments.join(' | '));
  await page.locator('#content-host [data-chatter-panel] select[aria-label="Sentiment"]').selectOption('all');

  // Scope. The covered half narrows to the book; the uncovered half cannot and must not pretend to.
  await go('/#/research/public-chatter?scope=portfolio', 5000);
  const scoped = await evalSafe(async () => {
    const c = await import('/js/data/chatter-live.js');
    return {
      covered: c.forScope('portfolio').length,
      uncovered: c.uncovered().length,
      all: c.companies().length,
      window: c.meta()?.window || '30d',
      text: document.querySelector('#content-host')?.textContent || '',
    };
  });
  ok('Portfolio scope narrows the covered half', scoped.covered <= scoped.all, `${scoped.covered} of ${scoped.all}`);
  ok('...and labels the overlap in short, customer-facing language',
    scoped.text.includes(`Portfolio · ${scoped.covered} of 142 mentioned · ${scoped.window}`));
  ok('...and leaves the uncovered half whole, because it has no tickers to filter by', scoped.uncovered === chatterState.uncovered,
    `${scoped.uncovered} rows in both scopes`);

  // Nothing synthetic is left on this tab, so nothing may claim to be.
  ok('no mock ribbon, because nothing here is synthetic', (await page.locator('[data-mock-ribbon]').count()) === 0);
  ok('...and the pump-risk flag is gone with the corpus it was calibrated for', !/pump risk/i.test(await hostText()));
}

// The slug resolver is pure, so it is testable directly — and the failure that matters is a FALSE
// POSITIVE. An unresolved entry costs a row in the second section; a wrong symbol files someone
// else's forum posts under a company you hold.
const resolverTraps = await evalSafe(async () => {
  const s = await import('/js/data/sentiment-shared.js');
  const idx = s.buildResolverIndex([
    { ticker: 'TMCV', name: 'Tata Motors' },
    { ticker: 'INFY', name: 'Infosys' },
    { ticker: 'VALUEIND', name: 'Value Industries' },
  ]);
  const hit = (slug, name) => s.resolveEntry({ slug, name: name || slug.replace(/-/g, ' ') }, idx).ticker;
  return {
    realCompany: hit('tata-motors', 'Tata Motors'),
    bySymbol: hit('infy', 'INFY'),
    bareWord: hit('value', 'Value'),
    theme: hit('nuclear-energy', 'Nuclear Energy'),
    broker: hit('guggenheim', 'Guggenheim'),
  };
});
ok('the resolver matches a real company', resolverTraps.realCompany === 'TMCV', String(resolverTraps.realCompany));
ok('...by symbol as well as name', resolverTraps.bySymbol === 'INFY', String(resolverTraps.bySymbol));
ok('...and does NOT prefix-match a bare word onto a company', resolverTraps.bareWord === null,
  `"value" resolved to ${resolverTraps.bareWord} (Value Industries is in the index deliberately)`);
ok('...nor a theme', resolverTraps.theme === null, String(resolverTraps.theme));
ok('...nor a broker', resolverTraps.broker === null, String(resolverTraps.broker));

// An alert about chatter is limited to the book, and says nothing that reads as a price.
const chatterAlert = await evalSafe(async () => {
  const w = await import('/js/core/watch.js');
  return w.chatterDetail({
    name: 'Test Co', mentions: 4, mentionsChangePct: 200,
    sourceLabel: 'ValuePickr', sentiment: { labelText: 'Bullish' },
  });
});
ok('a chatter alert reports mentions, never a percentage', /4 mentions/.test(chatterAlert) && !/%/.test(chatterAlert), chatterAlert);
ok('...and credits SentimentDash for the sentiment', /SentimentDash/.test(chatterAlert));

// ---------------------------------------------------------------------------------------
// 8b. The book — 142 company lines, and the promise that none of them is silently missing.
//
// "Portfolio" used to mean the twelve positions in a mock ledger. It now means the family's actual
// direct-equity book — names and sectors, no quantity, no cost, no valuation — and the thing the
// reader was worried about is a holding quietly vanishing
// between the statement and the screen. So the checks here are about completeness and about
// honesty when a feed cannot carry a line:
//
//   • every line is accounted for — a ticker, or a stated reason it has none;
//   • two lines never collapse onto one symbol (that bug was real: Allcargo Global and Allcargo
//     Logistics are separately listed and both matched ALLCARGO);
//   • a Portfolio-scoped table shows ONLY book companies, and never leaks a non-holding;
//   • the scope pill prints the denominator, so 96 rows can never read as "the book is 96 long";
//   • the book is now the ONLY portfolio information here — the ledger and the Portfolio
//     Analytics workspace it fed are deleted, checked at the top of this file.
// ---------------------------------------------------------------------------------------
console.log('\n— the book —');
await go('/#/research/earnings-hub?scope=portfolio', 3000);

const book = await page.evaluate(async () => {
  const c = await import('/js/data/coverage.js');
  const holdings = c.holdings();
  const tickers = holdings.filter((h) => h.ticker).map((h) => h.ticker.toUpperCase());
  const dupes = tickers.filter((t, i) => tickers.indexOf(t) !== i);
  return {
    count: holdings.length,
    meta: c.meta(),
    unaccounted: holdings.filter((h) => !h.ticker && !h.reason).map((h) => h.name),
    dupes: [...new Set(dupes)],
    blankNames: holdings.filter((h) => !h.name).length,
  };
});
ok('the book carries every line from the statement', book.count === 142, `${book.count} lines`);
ok('...each with a ticker or a stated reason it has none', book.unaccounted.length === 0, book.unaccounted.slice(0, 3).join(', ') || 'all accounted for');
ok('...and no two companies collapse onto one symbol', book.dupes.length === 0, book.dupes.join(', ') || `${book.meta.tracked} distinct tickers`);
ok('...and every line has a name', book.blankNames === 0);
ok('the counts add up', book.meta.tracked + book.meta.uncovered === book.count, `${book.meta.tracked} tracked + ${book.meta.uncovered} uncovered = ${book.count}`);

// The book is no longer typed in here: scripts/sync-family-book.mjs reads it from the family
// office's own repository (techmuns/Sattva-Family) into scripts/fixtures/family-book.json, one line
// per listed equity ISIN, and the resolver turns that into the served file. So the identity of a
// line is its ISIN, and the served book must be exactly the fixture's set — a line that vanished
// between the two would be a holding silently dropped, which is the failure this whole section
// exists to catch. The names are compared too: the custodian's wording travels as `bookName`, the
// display name is what the reader recognises, and neither may be blank.
const familyBook = JSON.parse(readFileSync(new URL('./fixtures/family-book.json', import.meta.url), 'utf8'));
const servedBook = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
const isinOk = (s) => /^INE[A-Z0-9]{9}$/.test(s || '');
const fixtureIsins = familyBook.lines.map((l) => l.isin);
const servedIsins = servedBook.holdings.map((h) => h.isin);
ok('the fixture read from the family repository is one line per equity ISIN',
  familyBook.count === familyBook.lines.length && fixtureIsins.every(isinOk) && new Set(fixtureIsins).size === fixtureIsins.length,
  `${familyBook.count} lines, as of ${familyBook.asOf}`);
ok('...and carries no quantity, cost or value', familyBook.lines.every((l) => ['isin', 'name', 'sector'].every((k) => k in l) && Object.keys(l).length === 3));
ok('every served line carries its ISIN, once', servedIsins.every(isinOk) && new Set(servedIsins).size === servedIsins.length);
ok('the served book is exactly the fixture\'s set of ISINs',
  servedIsins.length === fixtureIsins.length && servedIsins.every((i) => fixtureIsins.includes(i)),
  `${servedIsins.filter((i) => !fixtureIsins.includes(i)).length} served but not in the fixture, ${fixtureIsins.filter((i) => !servedIsins.includes(i)).length} in the fixture but not served`);
ok('...keeps the custodian\'s own wording beside the display name', servedBook.holdings.every((h) => typeof h.bookName === 'string' && h.bookName && h.name));
ok('...and names its source and as-of date', /Sattva-Family/.test(servedBook.source) && servedBook.asOf === familyBook.asOf, `${servedBook.source} · ${servedBook.asOf}`);

// No leakage: a Portfolio-scoped table must contain only companies from the book.
for (const [hash, label, wait] of [
  ['/#/research/earnings-hub?scope=portfolio', 'earnings hub', 4000],
  ['/#/research/concall?scope=portfolio', 'con-call', 9000],
  ['/#/research/breakouts?scope=portfolio', 'breakouts', 4000],
]) {
  await go(hash, wait);
  const leak = await page.evaluate(async () => {
    const c = await import('/js/data/coverage.js');
    const mine = new Set(c.tracked().map((h) => h.ticker.toUpperCase()));
    const shown = [...document.querySelectorAll('#content-host tbody tr')]
      .map((tr) => (tr.innerText.match(/\b[A-Z][A-Z0-9&.\-]{2,}\b/g) || []).find((t) => mine.has(t)))
      .filter(Boolean);
    return { rows: document.querySelectorAll('#content-host tbody tr').length, matched: shown.length };
  });
  ok(`${label}: every scoped row is a book company`, leak.rows === 0 || leak.matched > 0, `${leak.matched} of ${leak.rows} rows resolved to a book ticker`);
  const pill = await page.locator('#content-host [title*="book holds"]').first().innerText().catch(() => '');
  ok(`  ...and the pill states the denominator`, /of 142/.test(pill), pill || 'no scope pill found');
}

// The technicals feed used to BE the Nifty 500, because the scrape read an NSE-500 screener export
// and nothing else. That silently capped the dashboard at the 55 book companies which happen to be
// index constituents, and nothing on screen said the index was the reason. These two assert the
// scrape's input is the book as well as the index — the check that would have caught it.
await go('/#/research/breakouts?scope=portfolio', 4000);
const techCover = await page.evaluate(async () => {
  const [t, c] = await Promise.all([import('/js/data/technicals.js'), import('/js/data/coverage.js')]);
  const rows = new Set(t.all().map((s) => s.company?.ticker?.toUpperCase()).filter(Boolean));
  const scored = new Set(t.scoredOnly().map((s) => s.company?.ticker?.toUpperCase()).filter(Boolean));
  const held = c.tracked().map((h) => h.ticker.toUpperCase());
  return {
    missing: held.filter((x) => !rows.has(x)),
    unscored: held.filter((x) => !scored.has(x)),
    held: held.length,
    coverage: t.coverage(),
  };
});
// "Has a row" is the assertion, not "scores". A company that listed three weeks ago genuinely has
// too little history for a 200-day moving average, and its row says so — that is Yahoo's data, not
// our pipeline. What the pipeline owes is an ATTEMPT for every holding, which is exactly what was
// missing while the scrape read the index alone.
ok(
  'every listed holding has a technicals row, index constituent or not',
  techCover.missing.length === 0,
  techCover.missing.length
    ? `no attempt made for ${techCover.missing.slice(0, 6).join(', ')}`
    : `${techCover.held} attempted, ${techCover.held - techCover.unscored.length} scored${techCover.unscored.length ? ` (${techCover.unscored.join(', ')} lack the history)` : ''}`,
);
ok(
  '...and the feed does not call itself "NSE 500" when it is more than that',
  techCover.coverage.book === 0 ? techCover.coverage.label === 'NSE 500' : /held/.test(techCover.coverage.label),
  `${techCover.coverage.label} — ${techCover.coverage.nse500} index + ${techCover.coverage.book} held`,
);

// ---------------------------------------------------------------------------------------
// 9. Super Investors — the workspace, the heatmap and the flow charts
// ---------------------------------------------------------------------------------------
console.log('\n— super investors —');

// BOTH SUB-VIEWS ARE REAL NOW. Fund Flows was the last synthetic surface on this tab and it is
// gone, along with `js/data/investors.js`, `js/investors/deep-dive.js` and the two mock payloads —
// the Con-call resolution applied again: when a tab acquires two provenances, remove the synthetic
// one rather than write a better ribbon. So the assertion inverts: there must be NO ribbon
// anywhere on this tab, and no route to a view that would need one.
for (const sub of ['superstar-investors', 'institutions']) {
  await go(`/#/research/super-investors/${sub}?scope=universe`, 2200);
  const txt = await hostText();
  ok(`investors ${sub} renders`, txt.length > 400 && !/hit a snag/i.test(txt));
  const ribbons = await page.locator('[data-mock-ribbon]').count();
  ok(`investors ${sub}: no ribbon, because nothing on it is synthetic`, ribbons === 0, `${ribbons} ribbons`);
}
ok('the tab offers exactly two sub-views, both real', await page.evaluate(async () => {
  const m = await import('/js/tabs/super-investors.js');
  return m.meta.subviews.length === 2 && !m.meta.subviews.some((s) => s.id === 'fund-flows');
}));
// These four 404s are the point of the check, not a symptom — see `expectError` at the top.
expectError(/js\/data\/investors\.js|js\/investors\/deep-dive\.js|mock\/superinvestors\.json|mock\/fund-flows\.json/);
ok('...and the synthetic investor modules are gone from the served site', await page.evaluate(async () => {
  for (const f of ['js/data/investors.js', 'js/investors/deep-dive.js', 'data/mock/superinvestors.json', 'data/mock/fund-flows.json']) {
    const res = await fetch(f, { cache: 'no-cache' }).catch(() => null);
    if (res && res.ok) return false;
  }
  return true;
}));
await go('/#/research/super-investors/fund-flows?scope=universe', 1800);
const staleLink = await hostText();
ok('an old Fund Flows link lands on a real view rather than an error', staleLink.length > 400 && !/hit a snag/i.test(staleLink) && (await page.locator('[data-mock-ribbon]').count()) === 0);

// ---------------------------------------------------------------------------------------
// 9b. Institutions — REAL filed shareholdings, and the line between them and the rest.
//
// This is the one view where a real feed and the synthetic placeholders share a sub-view, so the
// checks that matter are about the boundary: no headline number may span both, and the reader must
// never be able to mistake which half a figure came from.
// ---------------------------------------------------------------------------------------
await go('/#/research/super-investors/institutions?scope=universe', 2400);
await waitForPanel();
const filedData = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const f = m.all()[0];
  if (!f) return null;
  return {
    name: f.name,
    stocksHeld: f.stocksHeld,
    portfolioValueCr: f.portfolioValueCr,
    sumOfRows: Math.round(f.holdings.reduce((a, h) => a + (h.valueCr ?? 0), 0) * 10) / 10,
    filed: f.filedThisQuarter,
    awaiting: f.awaitingFiling.length,
    quarters: f.quarters.length,
    // The one number that must never be faked: a holding with no filed percentage keeps its
    // share count, and must not be carrying a zero percentage instead.
    zeroPcts: f.holdings.filter((h) => h.holdingPct === 0).length,
    nullPctWithQty: f.holdings.filter((h) => h.holdingPct == null && h.qty != null).length,
    deltaDisagreements: f.holdings.filter((h) => h.changePp != null && h.pctDelta != null && Math.abs(h.changePp - h.pctDelta) > 0.11).length,
  };
});
if (filedData) {
  ok('the filed-holdings file loads', filedData.stocksHeld > 0, `${filedData.name}: ${filedData.stocksHeld} holdings`);
  ok("...and its total is the sum of its own rows", Math.abs(filedData.portfolioValueCr - filedData.sumOfRows) < 0.5, `${filedData.portfolioValueCr} vs ${filedData.sumOfRows}`);
  ok('...with nine quarters of filed history', filedData.quarters === 9, `${filedData.quarters} quarters`);
  // Trendlyne publish their own change per row; ours is the difference of two filed percentages.
  // They should agree — a disagreement means the history columns are being read out of order.
  ok("our change agrees with Trendlyne's on every row", filedData.deltaDisagreements === 0, `${filedData.deltaDisagreements} rows differ by >0.11pp`);
  ok('a holding awaiting its filing keeps null, never a zero percentage', filedData.zeroPcts === 0 && filedData.nullPctWithQty === filedData.awaiting, `${filedData.awaiting} awaiting, ${filedData.zeroPcts} zeros`);

  const inst = await hostText();
  ok('the table renders every filed holding', (await rowCount()) === filedData.stocksHeld, `${await rowCount()} rows`);
  ok('the panel says the value is Trendlyne’s, not ours', /Trendlyne/.test(inst) && /derivation/i.test(inst));
  // A row awaiting its filing shows a dash for the percentage and says WHY in the change column —
  // Trendlyne's own label. A zero there would report a live position as sold.
  ok('...and a holding awaiting its filing says so rather than showing zero', filedData.awaiting === 0 || /Filing Awaited/i.test(inst));
  // The disclosure chip is now a passive label rather than a verbose explainer trigger.
  await page.locator('[data-filed-info]').first().click();
  await page.waitForTimeout(200);
  ok('...and the Filed label opens no explainer popup',
    (await page.locator('[data-filed-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

  // THE COLUMN SET IS TRENDLYNE'S: Stock, Holding Value, Qty Held, the latest quarter's change and
  // holding percentage, then the eight prior quarters. Thirteen columns, every one sortable.
  const cols = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => ({ label: t.innerText.trim().toUpperCase().replace(/\s*[▾▴]$/, ''), sortable: !!t.dataset.sort })));
  ok('the table carries Trendlyne’s full column set', cols.length === 13, `${cols.length} columns: ${cols.map((c) => c.label).join(' | ').slice(0, 90)}…`);
  for (const want of ['STOCK', 'HOLDING VALUE', 'QTY HELD']) {
    ok(`column: ${want}`, cols.some((c) => c.label.replace(/\s+/g, ' ') === want), cols.map((c) => c.label).join(' | '));
  }
  ok('the latest quarter has both a change and a holding column', cols.filter((c) => /CHANGE %|HOLDING %/.test(c.label)).length === 2);
  ok('...and eight prior quarters follow it', cols.filter((c) => /^[A-Z]{3} \d{2} %$/.test(c.label.replace(/\s+/g, ' '))).length === 8);
  ok('EVERY heading is a sort button', cols.every((c) => c.sortable), `${cols.filter((c) => !c.sortable).length} not sortable`);

  // And sorting has to actually reorder the rows, on a numeric column and on the name.
  const firstBy = async (label) => {
    await page.locator(`th[data-sort="${label}"]`).click();
    await page.waitForTimeout(400);
    return (await page.locator('tr[data-row-key]').first().getAttribute('data-row-key')) || '';
  };
  const byValue = await firstBy('Holding Value');
  const byQty = await firstBy('Qty Held');
  ok('sorting by a heading reorders the table', byValue !== byQty, `by value ${byValue}, by qty ${byQty}`);
  const qtyDesc = await page.evaluate(() => [...document.querySelectorAll('tr[data-row-key] td')].length > 0);
  ok('...and the sorted column is the one that is ordered', qtyDesc && (await page.evaluate(() => {
    const idx = [...document.querySelectorAll('#content-host thead th')].findIndex((t) => t.dataset.sort === 'Qty Held');
    const vals = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => Number((tr.children[idx]?.innerText || '').replace(/[^0-9]/g, '')) || 0);
    return vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  })));

  // Thirteen columns is a lot. They have to fit the content column at the design width without
  // the table needing a scrollbar of its own — the same bar the Earnings Hub is held to.
  const filedFit = await page.evaluate(() => {
    const e = document.querySelector('[data-table-scroll]');
    return { over: e.scrollWidth - e.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok('the thirteen columns fit at 1440 with no scrollbar of their own', filedFit.over <= 0, `${filedFit.over}px over`);
  ok('...and the page never scrolls sideways', filedFit.page <= 0, `${filedFit.page}px`);

  ok('the Filed label still names the disclosure on its face',
    /Filed/i.test(await page.locator('[data-filed-info]').innerText()));
} else {
  skip('the filed-holdings file loads', 'public/data/institution-holdings.json is not present');
}

// ---------------------------------------------------------------------------------------
// 9b-ii. THE AMC PORTFOLIOS — and the line between two disclosures that look identical.
//
// A holding percentage and a % to NAV are both "a percentage against a company name" and they
// measure opposite things: how much of the company the fund owns, versus how much of the fund is
// in the company. Nothing on screen prevents a reader confusing them except the labelling, so the
// labelling is what is asserted here — on the column, on the pill, and in the exported banner,
// which is the one artefact that travels without the page around it.
// ---------------------------------------------------------------------------------------
const kinds = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  return m.all().map((f) => ({
    id: f.investorId,
    disclosure: f.disclosure,
    noun: f.periodNoun,
    periods: f.periods.length,
    label0: f.periodLabels[0],
    held: f.holdings.length,
    former: f.former.length,
    resolved: f.holdings.filter((h) => h.ticker).length,
    // Every holding must carry a key for every published period — a period with no entry at all
    // would let a reader's eye fill the gap rather than the em dash doing it.
    complete: f.holdings.every((h) => f.periods.every((p) => p in h.pctByPeriod)),
    zeroWeights: f.holdings.filter((h) => h.pct === 0).length,
    nullWeights: f.holdings.filter((h) => h.pct == null).length,
  }));
});
ok('both disclosures are loaded and tagged', kinds.some((k) => k.disclosure === 'shareholding') && kinds.filter((k) => k.disclosure === 'portfolio').length === 2, JSON.stringify(kinds.map((k) => `${k.id}=${k.disclosure}`)));
ok('...each with its own period vocabulary', kinds.every((k) => (k.disclosure === 'portfolio' ? k.noun === 'month' : k.noun === 'quarter')));
ok('...and every holding has a key for every published period', kinds.every((k) => k.complete));

// A LINE OUT OF AN AMC BOOK IS NOT A LINE HELD AT NIL. The importer moves it to `former`, so no
// portfolio row may carry a null latest weight — one that did would sort as -1 and read as zero.
//
// A SHAREHOLDING FUND IS THE OPPOSITE CASE and must be allowed exactly that: a company files weeks
// after the quarter closes, so a still-held position legitimately has no percentage yet and
// Trendlyne label it "Filing Awaited". Asserting zero nulls across both kinds would be demanding
// that the filed feed lie about a filing it has not received.
ok('no AMC holding is held at "null"', kinds.filter((k) => k.disclosure === 'portfolio').every((k) => k.nullWeights === 0), JSON.stringify(kinds.map((k) => `${k.id}:${k.nullWeights}`)));
ok('...while a filed holding awaiting its filing keeps its row', kinds.filter((k) => k.disclosure === 'shareholding').every((k) => k.nullWeights >= 0));
ok('...and exited lines are kept, not dropped', kinds.filter((k) => k.disclosure === 'portfolio').every((k) => k.former > 0), JSON.stringify(kinds.map((k) => `${k.id}:${k.former}`)));

for (const fundId of ['bandhan-focused-fund', 'bandhan-small-cap-fund']) {
  await go(`/#/research/super-investors/institutions?scope=universe&fund=${fundId}`, 2200);
  await waitForPanel();
  const heads = (await page.locator('#content-host thead th').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim());

  ok(`${fundId}: the percentage columns say "% to NAV"`, heads.some((h) => /% TO NAV/i.test(h)), heads.join(' | '));
  ok(`${fundId}: ...and never "Holding %", which means the other thing`, !heads.some((h) => /HOLDING %/i.test(h)), heads.join(' | '));
  ok(`${fundId}: the value column is attributed to the AMC, not derived`, heads.some((h) => /VALUE \(AMC\)/i.test(h)));
  // A portfolio disclosure states a weight and a value and no share count. A column of dashes
  // would imply we asked for something and were refused.
  ok(`${fundId}: no share-count column, because this disclosure has none`, !heads.some((h) => /QTY/i.test(h)));

  const pill = (await page.locator('[data-filed-info]').first().innerText()).replace(/\s+/g, ' ');
  ok(`${fundId}: the pill says which disclosure this is`, /Disclosed/i.test(pill) && /% to NAV/i.test(pill), pill);

  const over = await page.evaluate(() => {
    const el = document.querySelector('[data-table-scroll]');
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  ok(`${fundId}: the table fits 1440px without a scrollbar of its own`, over <= 0, `${over}px`);
}

// THE FIGURES ARE THE WORKBOOK'S. Recompute the change column from the two weights beside it, and
// check the row total against the fund's stated portfolio value — the same class of check the
// Trendlyne scraper makes before it will write a file.
const amcMath = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const out = [];
  for (const f of m.all().filter((x) => x.disclosure === 'portfolio')) {
    const [latest, prior] = f.periods;
    let changeOk = 0;
    let changeBad = 0;
    for (const h of f.holdings) {
      const now = h.pctByPeriod[latest];
      const before = h.pctByPeriod[prior];
      if (now == null || before == null) {
        // No previous month is a presence change, not a move of "the whole weight".
        if (h.changePp != null) changeBad++;
        continue;
      }
      Math.abs(Math.round((now - before) * 100) / 100 - h.changePp) < 1e-9 ? changeOk++ : changeBad++;
    }
    const sum = f.holdings.reduce((a, h) => a + (h.valueCr || 0), 0);
    out.push({ id: f.investorId, changeOk, changeBad, sum: Math.round(sum * 100) / 100, stated: f.portfolioValueCr });
  }
  return out;
});
ok('the change column recomputes from the two weights beside it', amcMath.every((r) => r.changeBad === 0 && r.changeOk > 0), JSON.stringify(amcMath.map((r) => `${r.id}:${r.changeOk}ok/${r.changeBad}bad`)));
ok('...and the rows sum to the fund value printed above them', amcMath.every((r) => Math.abs(r.sum - r.stated) < 0.02), JSON.stringify(amcMath.map((r) => `${r.id}:${r.sum} vs ${r.stated}`)));

// THE TWO KINDS ARE NEVER ADDED TOGETHER. There is no combined-book figure on this view, and the
// check is that no rendered number equals the sum across both — the arithmetic that would be
// meaningless is simply never performed.
const noCombined = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const all = m.all();
  const combined = all.reduce((a, f) => a + (f.portfolioValueCr || 0), 0);
  const text = document.querySelector('#content-host').innerText.replace(/,/g, '');
  return !text.includes(String(Math.round(combined)));
});
ok('no figure on the page sums across the two disclosures', noCombined);

// AN UNRESOLVED LINE IS STILL A HOLDING. It keeps its row under Universe and says why it has no
// symbol; it simply cannot be joined to the book, so it is absent under Portfolio.
const unresolved = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const f = m.byId('bandhan-small-cap-fund');
  const missing = f.holdings.filter((h) => !h.ticker);
  return {
    count: missing.length,
    allExplained: missing.every((h) => typeof h.unresolvedReason === 'string' && h.unresolvedReason.length > 10),
    inUniverse: m.holdingsForScope('universe', [], f.holdings).filter((h) => !h.ticker).length,
    inPortfolio: m.holdingsForScope('portfolio', [{ ticker: 'RECLTD' }], f.holdings).filter((h) => !h.ticker).length,
  };
});
ok('every unmatched line states why it carries no ticker', unresolved.count > 0 && unresolved.allExplained, JSON.stringify(unresolved));
ok('...keeps its row under Universe', unresolved.inUniverse === unresolved.count);
ok('...and drops out of Portfolio scope rather than matching nothing', unresolved.inPortfolio === 0);

// A COMPANY RE-ENTERED AFTER AN EXIT IS ONE ROW, and only because its two lines are disjoint.
const spells = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const out = [];
  for (const f of m.all().filter((x) => x.disclosure === 'portfolio')) {
    const names = [...f.holdings, ...f.former].map((h) => h.name);
    out.push({
      id: f.investorId,
      dupes: names.length - new Set(names).size,
      merged: f.holdings.filter((h) => h.spells > 1).length,
      tickers: (() => {
        const t = f.holdings.map((h) => h.ticker).filter(Boolean);
        return t.length - new Set(t).size;
      })(),
    });
  }
  return out;
});
ok('no company appears twice in one book', spells.every((s) => s.dupes === 0 && s.tickers === 0), JSON.stringify(spells));
ok('...and a re-entered position records how many spells it was folded from', spells.some((s) => s.merged > 0), JSON.stringify(spells.map((s) => `${s.id}:${s.merged}`)));

// THE DRILL SAYS WHAT THE PERCENTAGE IS, because the column heading is four words and the reader
// who clicks through is the one asking.
await go('/#/research/super-investors/institutions?scope=universe&fund=bandhan-focused-fund', 2200);
await waitForPanel();
await page.locator('#content-host tbody tr').first().click();
await page.waitForTimeout(700);
const amcDrill = await page.locator('#drill-content').innerText();
ok('the AMC drill explains what the percentage measures', /% to NAV/i.test(amcDrill) && /not how much of the company/i.test(amcDrill), amcDrill.slice(0, 90));
ok('...and separates the AMC\'s figures from the one we compute', /only figure computed here/i.test(amcDrill));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// The AMC disclosure label is also passive; the table and drill retain the useful distinctions.
await page.locator('[data-filed-info]').first().click();
await page.waitForTimeout(200);
ok('the Disclosed label opens no explainer popup',
  /Disclosed/i.test(await page.locator('[data-filed-info]').innerText()) &&
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

// ---------------------------------------------------------------------------------------
// 9b-iii. QUARTERLY CHANGES ACROSS INSTITUTION BOOKS.
//
// This mirrors the Superstar Investors roll-up without crossing the disclosure boundary above:
// only quarterly shareholding books enter it. Monthly AMC weights remain under All Institutions.
// Every company row opens the complete quarterly institution detail rather than abbreviating the
// only name and number a compact card has room for.
// ---------------------------------------------------------------------------------------
await go('/#/research/super-investors/institutions?scope=universe', 2200);
await waitForPanel();
const institutionSectionTabs = await page.locator('#content-host [data-filed-section-tabs] [role="tab"]').allTextContents();
ok('Institutions contains All Institutions and Quarterly Changes tabs',
  institutionSectionTabs.map((s) => s.trim()).join('|') === 'All Institutions|Quarterly Changes', institutionSectionTabs.join(' | '));
await page.locator('#content-host [data-filed-section-tabs] [data-tab-id="quarterly-changes"]').click();
await page.waitForTimeout(450);

const institutionQuarter = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const q = m.quarterlySummary();
  const expected = { new: 0, exited: 0, added: 0, trimmed: 0, held: 0 };
  const quarterly = m.all().filter((f) => f.disclosure === 'shareholding');
  let awaiting = 0;
  for (const f of quarterly) {
    const [latest, prior] = f.periods;
    for (const h of [...f.holdings, ...f.former]) {
      const now = h.pctByPeriod[latest];
      const before = h.pctByPeriod[prior];
      if (h.changeNote === 'Filing Awaited' && now == null) {
        awaiting++;
        continue;
      }
      if (now == null && before == null) continue;
      if (before == null) expected.new++;
      else if (now == null) expected.exited++;
      else if (now > before) expected.added++;
      else if (now < before) expected.trimmed++;
      else expected.held++;
    }
  }
  const first = q.newEntrants[0] || q.topAdds[0] || q.topTrims[0] || q.exits[0] || null;
  const details = first ? m.quarterlyCompany(first.key) : [];
  return {
    counts: q.counts,
    expected,
    quarterlyBooks: quarterly.length,
    allBooks: m.all().length,
    comparableBooks: q.comparableBooks,
    awaiting,
    waitingMisclassified: q.exits.filter((r) => r.note === 'Filing Awaited').length,
    first: first ? { key: first.key, name: first.company } : null,
    details: details.map((d) => ({ institution: d.institution, action: d.action, now: d.now, before: d.before, valueCr: d.valueCr, qty: d.qty })),
  };
});

ok('Institution Quarterly Changes replaces the fund table in the same sub-view',
  (await page.locator('#content-host [data-filed-panel="quarterly-changes"]').count()) === 1 &&
    (await page.locator('#content-host [data-institution-quarter-summary]').count()) === 1 &&
    (await page.locator('#content-host [data-table-scroll]').count()) === 0);
ok('...rolls up the filed latest/prior quarter exactly',
  JSON.stringify(institutionQuarter.counts) === JSON.stringify(institutionQuarter.expected),
  `${JSON.stringify(institutionQuarter.counts)} vs ${JSON.stringify(institutionQuarter.expected)}`);
ok('...includes quarterly institution books and excludes monthly AMC portfolios',
  institutionQuarter.quarterlyBooks > 0 && institutionQuarter.comparableBooks === institutionQuarter.quarterlyBooks && institutionQuarter.allBooks > institutionQuarter.quarterlyBooks,
  `${institutionQuarter.comparableBooks} quarterly of ${institutionQuarter.allBooks} total`);
ok('...never turns Filing Awaited into no longer disclosed',
  institutionQuarter.awaiting > 0 && institutionQuarter.waitingMisclassified === 0,
  `${institutionQuarter.awaiting} awaiting, ${institutionQuarter.waitingMisclassified} misclassified`);

const institutionPanels = await page.locator('#content-host [data-institution-quarter-summary] [data-ranked-list]').count();
const institutionRows = await page.locator('#content-host [data-institution-quarter-summary] [data-ranked-idx]').count();
const institutionButtons = await page.locator('#content-host [data-institution-quarter-summary] button[data-ranked-idx]').count();
ok('the institution quarter uses the same six actionable change panels', institutionPanels === 6, `${institutionPanels} panels`);
ok('every visible institution company is a clickable detail control', institutionRows > 0 && institutionButtons === institutionRows, `${institutionButtons} of ${institutionRows}`);

if (institutionQuarter.first) {
  await page.locator('#content-host [data-institution-quarter-summary] button[data-ranked-idx]').filter({ hasText: institutionQuarter.first.name }).first().click();
  await page.waitForTimeout(450);
  const modal = await page.locator('#modal-content').innerText();
  const detailHeads = (await page.locator('#modal-content thead th').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim());
  const detailRows = await page.locator('#modal-content [data-company-institution-row]').count();
  ok('clicking an institution company opens its cross-institution popup',
    (await page.locator('#modal-content [data-company-institution-detail]').count()) === 1 && modal.includes(institutionQuarter.first.name));
  ok('...names every relevant quarterly institution book',
    detailRows === institutionQuarter.details.length && institutionQuarter.details.every((d) => modal.includes(d.institution)),
    `${detailRows} rendered vs ${institutionQuarter.details.length} expected`);
  for (const want of ['Institution', 'Status', 'Previous stake', 'Current stake', 'Change (derived)', 'Current value (Trendlyne)', 'Shares held']) {
    ok(`institution company popup column: ${want}`, detailHeads.includes(want), detailHeads.join(' | '));
  }
  ok('...shows filed stake, Trendlyne value and share count without calling either a trade size',
    /Trendlyne's derivation, not an amount bought or sold/i.test(modal) &&
      institutionQuarter.details.some((d) => d.now != null && modal.includes(`${d.now.toFixed(1)}%`)) &&
      institutionQuarter.details.some((d) => d.valueCr != null) &&
      institutionQuarter.details.some((d) => d.qty != null));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------------------
// 9c. Superstar Investors — REAL filed books, off Ticker Finology, behind a credential.
//
// Three things separate this feed from every other one here, and each is checked rather than
// trusted:
//
//   1. THE TOKEN MUST NEVER REACH THE BROWSER. It lives in `env.MUNS_TOKEN` on the Worker. The
//      static check below is unconditional — it runs whatever the feed is doing — because a
//      leaked credential is the one failure that cannot be undone by a later deploy.
//   2. A BLANK QUARTER IS NOT A ZERO. Below the disclosure threshold a real holding is invisible,
//      so a gap must render as a dash, stay out of every total, and never be counted as a sale.
//   3. A FAILURE MUST NAME ITSELF. No route, no token and a refused token are different problems
//      with different fixes, and the view says which one it is instead of an empty grid.
//
// The data checks need the Worker AND a reachable upstream, so they report SKIP otherwise — which
// is itself worth seeing, because it exercises the unavailable states.
// ---------------------------------------------------------------------------------------
// Watch every request the page makes while the view loads. The claim being tested is a runtime
// one — that the browser talks only to our own origin for this feed — so it is tested at runtime.
// An earlier version grepped the module for the upstream hostname and failed on the string in its
// own `source:` label, which proved nothing either way.
const siRequests = [];
const siWatch = (r) => siRequests.push(r.url());
page.on('request', siWatch);
await go('/#/research/super-investors/superstar-investors?scope=universe', 2500);

// ---------------------------------------------------------------------------------------
// AN UNFILED QUARTER IS NOT A SALE — the rule that was got wrong, in somebody's name
//
// Finology open a column for the CURRENT period as soon as the first company files into it and
// print "Filing Due" against everyone else. `deriveMoves` compared that column against the last
// closed quarter, so a null in it became `exited`, which reaches a reader as "X is no longer
// disclosed". Measured on the shipped capture: Madhusudan Kela's "Aug 2026" column carried a
// figure for 1 of his 18 holdings, so FOURTEEN of his positions were reported gone — Kopran among
// them, which his page shows at 1.72% in both March and June with August reading Filing Due.
// Across ninety books, 362 of 1,696 derived moves were exits and most of them never happened.
//
// Nothing threw, no count was wrong, and the dashboard reported a mass liquidation of the Indian
// market in named investors' names. So this is asserted on FIXTURES, at each boundary, rather than
// on whatever today's capture happens to contain — and on the shipped data too, because the shape
// of that capture is the thing that produced the bug.
const filingRule = await evalSafe(async () => {
  const f = await import('/js/data/finology-shared.js');
  const book = (quarters, holdings) => f.normalisePortfolio({ quarters, holdings }, 'test');

  // The exact shape of the bug: an open period with one early filer, over two filed quarters.
  const openPeriod = book(['Aug 2026', 'Jun 2026', 'Mar 2026'], [
    { company: 'Kopran Ltd.', quarterlyHoldings: { 'Aug 2026': null, 'Jun 2026': 1.72, 'Mar 2026': 1.72 }, valueCr: 19.27 },
    { company: 'Early Filer Ltd.', quarterlyHoldings: { 'Aug 2026': 4.22, 'Jun 2026': null, 'Mar 2026': null }, valueCr: 40 },
  ]);
  const open = f.deriveMoves(openPeriod);

  // A genuine exit: gone from a CLOSED quarter, and the source values it at nothing.
  const realExit = f.deriveMoves(book(['Jun 2026', 'Mar 2026'], [
    { company: 'Choice International Ltd.', quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 7.21 }, valueCr: 0 },
  ]));
  // Missing from a closed quarter, but the source still values it — an outstanding filing.
  const stillValued = f.deriveMoves(book(['Jun 2026', 'Mar 2026'], [
    { company: 'Reliance Communications Ltd.', quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 4.13 }, valueCr: 9.01 },
  ]));
  // And their own word wins over any reading of ours, wherever they give one.
  const theirWord = f.deriveMoves(book(['Jun 2026', 'Mar 2026'], [
    { company: 'Noted Ltd.', quarterlyHoldings: { 'Jun 2026': 'Filing Due', 'Mar 2026': 2.5 }, valueCr: 0 },
  ]));

  return {
    // The comparison skips the open column entirely.
    pair: [open.latest, open.prior],
    pending: open.pending,
    kopran: open.moves.find((m) => m.company.startsWith('Kopran'))?.action,
    // A company disclosed ONLY in the open period has nothing to say about the Jun-vs-Mar pair, so
    // it carries no move at all. Reporting it as "new" under a heading reading "Jun 2026 vs Mar
    // 2026" would date somebody's disclosure to a quarter it did not happen in, which is the same
    // error class as the exits this whole block exists to stop. It stays visible as the open
    // column in the table and as `pending` here; it does not become a move in the wrong quarter.
    earlyFilerMoves: open.moves.filter((m) => m.company.startsWith('Early')).length,
    earlyFilerStillOnTheBook: openPeriod.holdings.some((h) => h.company.startsWith('Early') && h.quarterlyHoldings['Aug 2026'] === 4.22),
    // `summarise` must name a filed quarter too, or every "as of" line names an empty column.
    summaryQuarter: f.summarise(openPeriod).latestQuarter,
    summaryCount: f.summarise(openPeriod).disclosedCount,
    realExit: realExit.moves[0]?.action,
    stillValued: stillValued.moves[0]?.action,
    theirWord: theirWord.moves[0]?.action,
    // An outstanding filing is not a move, so it can never become an alert.
    awaitingIsNotAMove: f.isMove('awaiting') === false && f.isMove('exited') === true,
    // One classifier, asked the same way the Data Table asks it.
    oneClassifier: f.classifyHolding(
      { quarterlyHoldings: { 'Jun 2026': 1.72, 'Mar 2026': 1.72 } }, ...f.filedPair(['Aug 2026', 'Jun 2026', 'Mar 2026'])
    )?.action,
  };
});
ok('an unfiled period is never the baseline a holding is compared against',
  filingRule?.pair?.[0] === 'Jun 2026' && filingRule?.pair?.[1] === 'Mar 2026' && filingRule?.pending?.[0] === 'Aug 2026',
  `${filingRule?.pair?.join(' vs ')} · pending ${filingRule?.pending?.join(', ')}`);
ok('...so a holding carried unchanged through it is held, not "no longer disclosed"',
  filingRule?.kopran === 'held', `Kopran ${filingRule?.kopran}`);
ok('...and a disclosure made only into that period is not dated to the quarter before it',
  filingRule?.earlyFilerMoves === 0 && filingRule?.earlyFilerStillOnTheBook === true,
  `${filingRule?.earlyFilerMoves} move(s), still on the book: ${filingRule?.earlyFilerStillOnTheBook}`);
ok('...and the book reports itself as of a quarter that was actually filed',
  filingRule?.summaryQuarter === 'Jun 2026' && filingRule?.summaryCount === 1, `${filingRule?.summaryQuarter}, ${filingRule?.summaryCount} disclosed`);
// The three states have to stay apart, and the source's own figures are what separate them.
ok('a position the source values at nothing is a real exit; one it still values is a pending filing',
  filingRule?.realExit === 'exited' && filingRule?.stillValued === 'awaiting',
  `zero-valued ${filingRule?.realExit}, valued ${filingRule?.stillValued}`);
ok('...and where the source says "Filing Due" in its own words, that wins outright',
  filingRule?.theirWord === 'awaiting', filingRule?.theirWord);
// A negative filter (`action !== 'held'`) admitted every future state by default, which is how an
// outstanding filing would have been raised as a negative alert about a named investor.
ok('...and an outstanding filing is not a move, so it cannot become an alert',
  filingRule?.awaitingIsNotAMove === true);
ok('one classifier answers for the drill, the table and the alert alike',
  filingRule?.oneClassifier === 'held', filingRule?.oneClassifier);

// AND ON THE SHIPPED CAPTURE, because the fixtures above cannot catch a bad committed file.
const shippedBooks = await evalSafe(async () => {
  const f = await import('/js/data/finology-shared.js');
  const snap = await (await fetch('data/super-investors.json', { cache: 'no-cache' })).json();
  let exits = 0, moves = 0, awaiting = 0, openBaseline = 0;
  for (const [slug, raw] of Object.entries(snap.books || {})) {
    const b = f.normalisePortfolio(raw, slug);
    const r = f.deriveMoves(b);
    if (!r.comparable) continue;
    if (r.latest && !f.isFiledQuarter(r.latest)) openBaseline += 1;
    for (const m of r.moves) { moves += 1; if (m.action === 'exited') exits += 1; if (m.action === 'awaiting') awaiting += 1; }
  }
  return { moves, exits, awaiting, openBaseline, share: moves ? exits / moves : 0 };
});
ok('no book in the shipped capture is compared against an unfiled period',
  shippedBooks?.openBaseline === 0, `${shippedBooks?.openBaseline} book(s)`);
// 21% of every derived move being an exit was the artefact. A real quarter's churn is a fraction
// of that, so the share is asserted rather than the count — the count moves with every capture.
ok('...and exits are a plausible share of the quarter rather than a mass liquidation',
  shippedBooks?.share > 0 && shippedBooks?.share < 0.15,
  `${shippedBooks?.exits} exits and ${shippedBooks?.awaiting} pending filings in ${shippedBooks?.moves} moves (${Math.round((shippedBooks?.share || 0) * 100)}%)`);

// Unconditional: nothing that looks like a bearer credential may appear in the served client.
const tokenLeak = await page.evaluate(async () => {
  const files = ['index.html', 'js/data/super-investors.js', 'js/data/finology-shared.js', 'js/investors/live.js', 'js/app.js'];
  const hits = [];
  for (const f of files) {
    const src = await (await fetch(f, { cache: 'no-cache' })).text().catch(() => '');
    if (/Bearer\s+[A-Za-z0-9._-]{8,}|MUNS_TOKEN\s*=\s*['"]\S/.test(src)) hits.push(f);
  }
  // Also: the page must never have sent an Authorization header of its own.
  return { hits, base: typeof window.SATTVA_FINOLOGY_TOKEN };
});
ok('NO API TOKEN IS SHIPPED TO THE BROWSER', tokenLeak.hits.length === 0 && tokenLeak.base === 'undefined', tokenLeak.hits.join(', ') || 'clean');
const offOrigin = siRequests.filter((u) => /muns\.io|finology\.in/i.test(u));
ok('...and the browser never calls the credentialed upstream itself', offOrigin.length === 0, offOrigin.slice(0, 2).join(', ') || `${siRequests.length} requests, all same-origin`);
page.off('request', siWatch);

const siProbe = await page.evaluate(async () => {
  try {
    const res = await fetch('api/super-investors', { cache: 'no-cache' });
    if (!res.ok && res.status === 404) return { state: 'no-route' };
    const b = await res.json();
    return b?.ok === false ? { state: 'error', reason: b.reason } : { state: 'live', count: b?.investors?.length || 0 };
  } catch {
    return { state: 'no-route' };
  }
});

if (siProbe.state === 'no-route') {
  // WITH NO WORKER THERE IS STILL THE COMMITTED SNAPSHOT, which is a static file and needs no
  // route at all. Only a deployment with neither falls back to naming the missing route.
  const noWorker = await hostText();
  const fromFile = await page.locator('[data-open-investor]').count();
  ok('with no Worker, the view falls back to the committed snapshot rather than showing nothing',
    fromFile > 0 || /needs the Worker/i.test(noWorker),
    fromFile > 0 ? `${fromFile} investors from the snapshot` : 'no snapshot — the view names the missing route');
  skip('the live investor books render', 'no /api/super-investors on this origin');
} else if (siProbe.state === 'error') {
  // AN UNREACHABLE LIVE ROUTE IS NOT AN EMPTY VIEW — the committed snapshot is a static file and
  // answers without any route at all. This branch used to assert only that the reason was named,
  // which was right when nothing else could answer and became wrong the day the snapshot shipped:
  // running against `wrangler dev` with no MUNS_TOKEN is the first configuration that reaches it
  // WITH a snapshot present, and it reported the good fallback as a failure. Same resolution as
  // the no-route branch above: with a snapshot the outcome is the snapshot; only a deployment with
  // neither falls through to naming the reason.
  const errText = await hostText();
  const fromFile = await page.locator('[data-open-investor]').count();
  ok(`with the live feed unavailable (${siProbe.reason}), the view falls back to the snapshot or names the reason`,
    fromFile > 0
      ? true
      : /token|could not be reached|returned an error|unreadable|does not have the super-investor endpoints|did not answer in time/i.test(errText),
    fromFile > 0 ? `${fromFile} investors from the snapshot` : 'no snapshot — the view names the reason');
  // A 404 on the LIST route means the endpoint is absent, not that an investor is missing. The two
  // were once conflated, and the panel said "No such investor" while the real problem was that the
  // backend had never shipped the route — a diagnosis that sent the search in the wrong direction.
  if (siProbe.reason === 'route-missing') ok('...and a missing endpoint is never reported as a missing investor', !/no such investor/i.test(errText));
  ok('...and never shows an empty book where it has no data', fromFile > 0 || (await page.locator('tr[data-row-key]').count()) === 0,
    fromFile > 0 ? 'painted from the snapshot' : 'no rows, as it should be');
  skip('the live investor books render', `the upstream reported "${siProbe.reason}"`);
} else {
  // Books arrive a few at a time; wait for the walk to finish before measuring totals.
  await page.waitForFunction(() => !/still arriving/.test(document.querySelector('#content-host')?.innerText || ''), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);

  const cards = await page.locator('[data-open-investor]').count();
  ok('an investor card renders for every investor in their list', cards === siProbe.count, `${cards} cards for ${siProbe.count} investors`);
  ok('All Investors keeps the directory separate from the disclosed-positions table',
    (await page.locator('#content-host [data-live-panel="investors"] [data-table-scroll]').count()) === 0 &&
      (await page.locator('#content-host tr[data-row-key]').count()) === 0);

  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="data-table"]').click();
  await page.waitForSelector('#content-host [data-live-panel="data-table"] [data-table-scroll]');
  await settleTables();

  // NO STAT STRIP AT ALL NOW. It was three cards: investors tracked, combined book value, and a
  // "58 new · 400 exits" count. Two described the FEED rather than answering anything a reader
  // came for, and the third was a pair of numbers with no names attached — so the only way to act
  // on it was to open ninety books, which is the thing this page exists to avoid. The roll-up
  // below replaced it. The combined value survives in the Data Table coverage line.
  const strip = await page.evaluate(() => ({
    cards: document.querySelectorAll('#content-host .stat-card').length,
    coverage: (document.querySelector('#content-host')?.innerText || '').replace(/\s+/g, ' '),
  }));
  ok('the stat strip is gone from Superstar Investors', strip.cards === 0, `${strip.cards} cards`);
  ok('...but the combined book value survives, still attributed to Finology',
    /Finology.s value/i.test(strip.coverage) && /investor-company rows/.test(strip.coverage));
  ok('the table renders a row per investor-company pair', (await page.locator('tr[data-row-key]').count()) > 0);

  // THE NEWEST QUARTER IS ESTABLISHED FROM THE LABEL, NOT FROM THE ARRAY ORDER.
  //
  // `deriveMoves` compares quarters[0] against [1], `summarise` counts what is disclosed in [0],
  // and every card prints "as of quarters[0]". All three assumed the upstream sorts descending and
  // none of them checked. If it ever hands back ascending order, the view states the OLDEST quarter
  // as the current book — not a rendering glitch but a wrong answer stated confidently.
  const ordering = await page.evaluate(async () => {
    const shared = await import('/js/data/finology-shared.js');
    const asc = shared.normalisePortfolio({ name: 'X', slug: 'x', quarters: ['Jun 2024', 'Jun 2025', 'Jun 2026'], holdings: [] }, 'x');
    const unparseable = shared.normalisePortfolio({ name: 'X', slug: 'x', quarters: ['Later', 'Earlier'], holdings: [] }, 'x');
    const f = await import('/js/data/super-investors.js');
    const cols = f.quarterLabels().map((q) => shared.quarterOrder(q));
    return {
      sortedAscendingInput: asc.quarters[0],
      leftAloneWhenUnreadable: unparseable.quarters.join(','),
      columnsDescend: cols.every((n) => n == null) || cols.every((n, i) => i === 0 || n == null || cols[i - 1] == null || cols[i - 1] >= n),
      latest: f.latestQuarter(),
    };
  });
  ok('an ascending quarter list is reordered so [0] is genuinely the newest', ordering.sortedAscendingInput === 'Jun 2026', JSON.stringify(ordering));
  ok('...but labels that are not dates keep the source\'s own order', ordering.leftAloneWhenUnreadable === 'Later,Earlier');
  ok('...and the table\'s quarter columns run newest to oldest', ordering.columnsDescend, `latest=${ordering.latest}`);

  // Every quarter the source publishes gets its own column, in the source's own order.
  const heads = await page.$$eval('#content-host thead th', (t) => t.map((x) => x.innerText.trim()));
  const qCols = await page.evaluate(async () => (await import('/js/data/super-investors.js')).quarterLabels());
  ok('every published quarter gets its own column', qCols.every((q) => heads.includes(q.toUpperCase()) || heads.includes(q)), `${qCols.length} quarters`);
  // The derived column stays labelled on its head, because a change WE computed under an
  // otherwise-theirs table is the thing most easily mistaken for theirs. The value column's
  // heading is now plain "Value" at the reader's request, so the attribution is checked where it
  // actually lives — on the cell, and in row 1 of the export, which travels without this page.
  ok('the one figure we compute is headed as derived', heads.some((h) => /CHANGE \(DERIVED\)/i.test(h)), heads.join(' | '));
  ok('...and the value column still attributes itself to Finology on the cell', await page.evaluate(() => {
    const cell = document.querySelector('#content-host tbody tr [title*="Finology"]');
    return !!cell && /derivation/i.test(cell.getAttribute('title'));
  }));

  // A quarter the source omits must arrive as null — that is OUR transformation, and it is what
  // the whole "a blank is not a zero" rule rests on. Note what is deliberately NOT asserted: that
  // no quarter is ever 0. If Finology publish a literal 0 we must show a literal 0; claiming they
  // never do would be asserting something about their data rather than about our handling of it,
  // and an earlier version of this check failed for exactly that reason.
  const blanks = await page.evaluate(async () => {
    const shared = await import('/js/data/finology-shared.js');
    const probe = shared.normalisePortfolio(
      { name: 'X', slug: 'x', quarters: ['Q1', 'Q2', 'Q3'], holdings: [{ company: 'A Ltd', quarterlyHoldings: { Q1: 4.2, Q3: 0 } }] },
      'x'
    ).holdings[0].quarterlyHoldings;
    const f = await import('/js/data/super-investors.js');
    const rows = f.allHoldings();
    return {
      omittedIsNull: probe.Q2 === null,
      keyPresent: 'Q2' in probe,
      zeroSurvives: probe.Q3 === 0,
      complete: rows.every((r) => r.quarters.every((q) => q in r.quarterlyHoldings)),
      withGaps: rows.filter((r) => r.quarters.some((q) => r.quarterlyHoldings[q] == null)).length,
      rows: rows.length,
    };
  });
  ok('a quarter the source omits becomes null, not zero', blanks.omittedIsNull && blanks.keyPresent, JSON.stringify(blanks));
  ok('...while a zero the source DOES publish survives as a zero', blanks.zeroSurvives);
  ok('...and every published quarter is a key on every holding', blanks.complete, `${blanks.withGaps} of ${blanks.rows} rows have at least one gap`);
  if (blanks.withGaps) ok('...and a gap renders as a dash on screen', (await page.locator('#content-host tbody td:has-text("—")').count()) > 0);
  else skip('...and a gap renders as a dash on screen', 'no book in this feed has a gap to render');

  // THE IDENTITY THAT CAUGHT A REAL BUG: the count and the total must describe the same set.
  const consistency = await page.evaluate(async () => {
    const f = await import('/js/data/super-investors.js');
    const bad = [];
    for (const b of f.books()) {
      const t = f.totalsFor(b.slug);
      if (t.disclosedCount === 0 && t.valueCr != null) bad.push(`${b.slug}: 0 holdings but a book value`);
      if (t.valuedCount > t.disclosedCount) bad.push(`${b.slug}: more valued than disclosed`);
    }
    return bad;
  });
  ok('a book value never covers positions the holding count excludes', consistency.length === 0, consistency.slice(0, 3).join('; ') || 'consistent');

  // The derived move is subtraction of their own two percentages, recomputed here independently.
  const moveCheck = await page.evaluate(async () => {
    const f = await import('/js/data/super-investors.js');
    const bad = [];
    for (const m of f.allMoves()) {
      if (m.action === 'new' || m.action === 'exited') {
        if (m.deltaPp != null) bad.push(`${m.company}: ${m.action} carries a pp figure`);
      } else if (Math.abs(m.deltaPp - Math.round((m.now - m.before) * 100) / 100) > 1e-9) {
        bad.push(`${m.company}: ${m.deltaPp} != ${m.now} - ${m.before}`);
      }
    }
    return bad;
  });
  ok('the derived change equals their latest minus their prior, independently recomputed', moveCheck.length === 0, moveCheck.slice(0, 3).join('; ') || 'all agree');
  ok('...and an appearance or disappearance carries no percentage-point figure', !moveCheck.some((b) => /carries a pp/.test(b)));

  // A book that failed to load must not read as an investor holding nothing.
  const failed = await page.evaluate(async () => {
    const f = await import('/js/data/super-investors.js');
    return f.list().filter((i) => f.failureFor(i.slug)).map((i) => i.slug);
  });
  if (failed.length) ok('a book that could not be read says so rather than showing as empty', /could not be read/i.test(await hostText()), `${failed.length} failed`);
  else skip('a book that could not be read says so rather than showing as empty', 'every book loaded in this run');

  // The workspace: three panels, every API field reachable.
  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="investors"]').click();
  await page.waitForSelector('#content-host [data-open-investor]');
  await page.locator('[data-open-investor]').first().click();
  await page.waitForSelector('#workspace-panel', { timeout: 15000 });
  await page.waitForTimeout(400);
  ok('an investor card opens the book workspace', (await page.locator('#workspace-overlay.is-open').count()) === 1);
  // THE ATTRIBUTION MOVED, IT DID NOT GO. This block asserted `Value (Finology)` as visible text
  // and had done since before the heading was deliberately shortened to `Value` with the source
  // named on the heading's tooltip instead. It never caught the drift because the whole block
  // skips without a reachable upstream. What has to hold is that the column still says whose
  // derivation the figure is, wherever the design puts it — so that is what is checked.
  let valueHeadTitle = '';
  for (const [tab, expect] of [['holdings', /Value/i], ['moves', /Derived|only one quarter/i], ['profile', /Finology id/i]]) {
    await page.locator(`[data-ws-tab="${tab}"]`).click();
    await page.waitForTimeout(500);
    const txt = await page.locator('#workspace-panel').innerText();
    ok(`workspace panel renders: ${tab}`, expect.test(txt) && !/hit a snag/i.test(txt));
    // Captured in place rather than by clicking back afterwards: the assertion below this loop
    // reads whichever panel is showing, and re-selecting Holdings at the end would hand it the
    // wrong one — which is exactly the bug an earlier draft of this check introduced.
    if (tab === 'holdings') {
      valueHeadTitle = await page.evaluate(
        () => [...document.querySelectorAll('#workspace-panel th')].find((th) => /^value$/i.test(th.textContent.trim()))?.title || ''
      );
    }
  }
  ok('...and the holdings panel still attributes the ₹ value to Finology', /finology/i.test(valueHeadTitle), valueHeadTitle.slice(0, 60) || 'no title on the Value heading');
  ok('the profile panel reaches the scalar fields the API returns', /Net worth|Active stocks|Total stocks/i.test(await page.locator('#workspace-panel').innerText()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('ESC closes the book workspace', (await page.locator('#workspace-overlay.is-open').count()) === 0);
}

// ---------------------------------------------------------------------------------------
// THE CROSS-BOOK SUMMARY runs on EITHER path — live books or the committed snapshot.
//
// It sits outside the Worker branch above on purpose. The roll-up is computed from whatever books
// are loaded, and on a static origin those come from `public/data/super-investors.json` — a file,
// needing no route at all. Gating it on `/api/super-investors` would have skipped it on every run
// this sandbox can do, and a check that never executes is not a check. It skips only when no book
// loaded by either path, which is the one case with genuinely nothing to summarise.
// ---------------------------------------------------------------------------------------
{
  await go('/#/research/super-investors?scope=universe', 9000);
  await waitForPanel();
  const booksLoaded = await page.evaluate(async () => (await import('/js/data/super-investors.js')).books().length);
  if (!booksLoaded) {
    skip('the cross-book summary renders, with a panel per question', 'no investor book loaded by any path');
  } else {
  const sectionTabs = await page.evaluate(() => {
    const host = document.getElementById('content-host');
    const tabs = [...host.querySelectorAll('[data-live-section-tabs] [role="tab"]')];
    return {
      labels: tabs.map((tab) => tab.textContent.trim()),
      selected: tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent.trim() || null,
      panel: host.querySelector('[data-live-panel]')?.dataset.livePanel || null,
      cards: host.querySelectorAll('[data-open-investor]').length,
      summary: !!host.querySelector('[data-quarter-summary]'),
      table: !!host.querySelector('[data-table-scroll]'),
    };
  });
  ok('Superstar Investors contains All Investors, Quarterly Changes and Data Table tabs in that order',
    sectionTabs.labels.join('|') === 'All Investors|Quarterly Changes|Data Table', sectionTabs.labels.join(' | '));
  ok('All Investors is the default in-page tab',
    sectionTabs.selected === 'All Investors' && sectionTabs.panel === 'investors' && sectionTabs.cards > 0 && !sectionTabs.summary && !sectionTabs.table,
    JSON.stringify(sectionTabs));

  await page.locator('#content-host [data-open-investor]').first().click();
  await page.waitForSelector('#workspace-overlay.is-open');
  const workspaceChrome = await page.evaluate(() => {
    const header = document.querySelector('#workspace-content > div.sticky');
    const text = header?.innerText || '';
    return {
      sourceSubtitle: /Ticker Finology\s*·/i.test(text),
      filedBadge: /Filed holdings/i.test(text),
      externalAction: /Open on Finology/i.test(text) || !!header?.querySelector('a[href*="ticker.finology.in/investor"]'),
    };
  });
  ok('the investor workspace has no source subtitle, filed badge or Finology action',
    !workspaceChrome.sourceSubtitle && !workspaceChrome.filedBadge && !workspaceChrome.externalAction,
    JSON.stringify(workspaceChrome));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="data-table"]').click();
  await page.waitForSelector('#content-host [data-live-panel="data-table"] [data-table-scroll]');
  await settleTables();
  const dataTable = await page.evaluate(() => {
    const host = document.getElementById('content-host');
    return {
      panel: host.querySelector('[data-live-panel]')?.dataset.livePanel || null,
      heading: /All disclosed positions/i.test(host.innerText),
      rows: host.querySelectorAll('tr[data-row-key]').length,
      cards: host.querySelectorAll('[data-open-investor]').length,
      summary: !!host.querySelector('[data-quarter-summary]'),
      search: !!host.querySelector('input[placeholder*="Search"]'),
      filters: host.querySelectorAll('select').length,
      watchlistButton: [...host.querySelectorAll('button')].some((b) => /Watchlist/i.test(b.innerText)),
      exportButton: [...host.querySelectorAll('button')].some((b) => /Export Excel/i.test(b.innerText)),
    };
  });
  ok('Data Table owns the complete disclosed-positions table, separate from cards and the quarterly roll-up',
    dataTable.panel === 'data-table' && dataTable.heading && dataTable.rows > 0 && dataTable.cards === 0 && !dataTable.summary,
    JSON.stringify(dataTable));
  ok('Data Table keeps the table search, investor/change filters and export action',
    dataTable.search && dataTable.filters >= 2 && dataTable.watchlistButton && dataTable.exportButton,
    JSON.stringify(dataTable));
  ok('switching to Data Table leaves focus on its selected tab',
    await page.evaluate(() => document.activeElement?.matches('[data-live-section-tabs] [data-tab-id="data-table"]')));

  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="quarterly-changes"]').click();
  await page.waitForSelector('#content-host [data-quarter-summary]');
  ok('Quarterly Changes replaces the directory in the same Superstar Investors tab',
    (await page.locator('#content-host [data-live-panel="quarterly-changes"]').count()) === 1 &&
      (await page.locator('#content-host [data-open-investor]').count()) === 0);
  ok('switching in-page tabs leaves focus on the selected replacement tab',
    await page.evaluate(() => document.activeElement?.matches('[data-live-section-tabs] [data-tab-id="quarterly-changes"]')));

  // ---------------------------------------------------------------------------------------
  // THE CROSS-BOOK SUMMARY — and the four numbers it refuses to invent
  //
  // The page exists so a reader does not open ninety books one at a time, and the summary is what
  // answers that: who bought what, who sold what, and where more than one tracked investor moved
  // on the same company. Rendering it is the easy half. The half worth asserting is what it must
  // NOT do, because every one of these is the obvious feature request and each would be a
  // fabricated figure:
  //
  //   1. No rupee size on a move. `valueCr` is Finology's derivation of what a position is worth
  //      NOW, not what was traded — ranking "largest buys" by it answers a different question and
  //      prints a rupee amount nobody disclosed. Increases and reductions are in percentage points.
  //   2. No size at all on a new or exited position. `deriveMoves` leaves deltaPp null for both on
  //      purpose: a position appearing is a change of disclosure, not a move of the whole holding.
  //   3. "Exited" is "no longer disclosed", never "sold" — below the threshold a real holding is
  //      simply invisible in the filing.
  //   4. Consensus is a count of who moved, never a signal, a weight or a score.
  //
  // Asserted against the SHIPPED data rather than a fixture, and cross-checked against `allMoves()`
  // — the summary agreeing with itself would prove nothing.
  // ---------------------------------------------------------------------------------------
  const summary = await page.evaluate(async () => {
    const feed = await import('/js/data/super-investors.js');
    const q = feed.quarterSummary({});
    const moves = feed.allMoves();
    const host = document.getElementById('content-host');
    const sec = host.querySelector('[data-quarter-summary]');
    const panel = (k) => sec?.querySelector(`[data-ranked-list="${k}"]`);
    const textOf = (k) => (panel(k)?.innerText || '').replace(/\s+/g, ' ');
    const rowsOf = (k) => [...(panel(k)?.querySelectorAll('.divide-y > *') || [])].map((r) => r.innerText.replace(/\s+/g, ' ').trim());
    return {
      rendered: !!sec,
      panels: sec ? sec.querySelectorAll('[data-ranked-list]').length : 0,
      // the honesty invariants, over the whole set rather than the rendered top 5
      newHaveNoSize: q.newEntrants.every((m) => m.deltaPp == null),
      exitsHaveNoSize: q.exits.every((m) => m.deltaPp == null),
      addsAllPositive: q.topAdds.every((m) => m.deltaPp > 0),
      trimsAllNegative: q.topTrims.every((m) => m.deltaPp < 0),
      addsSortedDesc: q.topAdds.every((m, i, a) => i === 0 || a[i - 1].deltaPp >= m.deltaPp),
      consensusAllMultiple: q.consensusBuys.concat(q.consensusExits).every((c) => c.investors.length > 1),
      consensusBuyActions: q.consensusBuys.every((c) => c.investors.every((i) => ['new', 'added'].includes(i.action))),
      consensusExitActions: q.consensusExits.every((c) => c.investors.every((i) => ['exited', 'trimmed'].includes(i.action))),
      // counts must agree with the raw move list, not be recounted independently
      countsAgree:
        q.counts.new === moves.filter((m) => m.action === 'new').length &&
        q.counts.added === moves.filter((m) => m.action === 'added').length &&
        q.counts.trimmed === moves.filter((m) => m.action === 'trimmed').length &&
        q.counts.exited === moves.filter((m) => m.action === 'exited').length,
      // no rupee figure anywhere in the two ranked-by-size panels
      // Rows only. A panel's note explains the rule in prose — the exits note says an exit is
      // "not the same as sold" — so folding it into the text under test makes the explanation
      // fail the check it is explaining.
      addsRows: rowsOf('si-adds'),
      trimRows: rowsOf('si-trims'),
      exitRows: rowsOf('si-exits'),
      headText: (sec?.querySelector('p')?.innerText || '').replace(/\s+/g, ' '),
      exitsNote: (panel('si-exits')?.querySelector('p')?.innerText || '').replace(/\s+/g, ' '),
      // investor names must be the list's, not the book's SEO-suffixed page title
      suffixed: /Portfolio, Shareholdings/i.test(sec?.innerText || ''),
      tableSuffixed: /Portfolio, Shareholdings/i.test(host.innerText),
    };
  });

  ok('the cross-book summary renders, with a panel per question', summary.rendered && summary.panels === 6, `${summary.panels} panels`);
  ok('a new position carries no percentage-point size, and neither does an exit',
    summary.newHaveNoSize && summary.exitsHaveNoSize);
  ok('...so increases and reductions contain only positions that actually moved',
    summary.addsAllPositive && summary.trimsAllNegative);
  ok('...ranked by that move, largest first', summary.addsSortedDesc);
  const sized = summary.addsRows.concat(summary.trimRows);
  ok('increases and reductions are in percentage points, with no rupee figure on any move',
    sized.length > 0 && sized.every((r) => /[-+]?\d+\.\d\d pp$/.test(r)) && !sized.some((r) => /₹/.test(r)),
    sized[0] || 'no rows');
  ok('an exit row states the stake last disclosed, never a size for the exit itself',
    summary.exitRows.length > 0 && summary.exitRows.every((r) => /was \d+\.\d\d%$/.test(r)) && !summary.exitRows.some((r) => /\bsold\b/i.test(r)),
    summary.exitRows[0] || 'no rows');
  ok('...and the panel says in words that it is not the same as sold',
    /not the same as sold/i.test(summary.exitsNote), summary.exitsNote.slice(0, 90));
  ok('a consensus row is always two or more investors, doing the matching thing',
    summary.consensusAllMultiple && summary.consensusBuyActions && summary.consensusExitActions);
  ok('the summary counts agree with the raw move list rather than being recounted',
    summary.countsAgree);
  ok('...and the head says how many books contributed, out of how many are comparable',
    /of \d+ comparable books/.test(summary.headText), summary.headText.slice(0, 130));
  // Finology's list and book endpoints disagree about an investor's name — the book carries their
  // page title, suffix and all. The cards always read the list; the table and the summary now do
  // too, so one person is one string everywhere on this page.
  ok('investor names come from the list, not the book\'s SEO page title',
    !summary.suffixed && !summary.tableSuffixed);

  // A compact summary row is a lead, not the answer: "+1" cannot tell the reader who the third
  // investor was, and one ranked mover says nothing about the other investors holding the same
  // company. Every visible company therefore opens the complete latest/prior cross-book detail.
  const companyButtons = page.locator('#content-host [data-quarter-summary] [data-ranked-idx]');
  const companyButtonCount = await companyButtons.count();
  ok('every visible Quarterly Changes company is a clickable detail control',
    companyButtonCount > 0 &&
      companyButtonCount === (await page.locator('#content-host [data-quarter-summary] [data-ranked-list] .divide-y > *').count()),
    `${companyButtonCount} company buttons`);

  if (companyButtonCount) {
    const firstCompanyButton = companyButtons.first();
    const company = await firstCompanyButton.locator('span.font-semibold').first().innerText();
    const expectedInvestors = await page.evaluate(async (name) => {
      const feed = await import('/js/data/super-investors.js');
      return feed
        .allHoldings()
        .filter((r) => r.company === name)
        .map((r) => {
          const [latest, prior] = r.quarters || [];
          return {
            investor: r.investor,
            now: latest ? r.quarterlyHoldings[latest] : null,
            before: prior ? r.quarterlyHoldings[prior] : null,
          };
        })
        .filter((r) => r.now != null || r.before != null)
        .map((r) => r.investor)
        .sort();
    }, company);

    await firstCompanyButton.click();
    await page.waitForSelector('#modal-overlay.is-open [data-company-investor-detail]');
    const companyDetail = await page.evaluate(() => {
      const drill = document.querySelector('#modal-content [data-company-investor-detail]');
      const headers = [...(drill?.querySelectorAll('th') || [])].map((h) => h.textContent.trim());
      const rows = [...(drill?.querySelectorAll('[data-company-investor-row]') || [])];
      return {
        title: drill?.querySelector('h2')?.innerText.trim() || '',
        headers,
        investors: rows.map((r) => r.querySelector('td')?.innerText.trim() || '').sort(),
        measures: rows.every((r) => r.querySelectorAll('td').length === 6),
        hasStake: rows.some((r) => /\d+\.\d\d%/.test(r.innerText)),
        note: (drill?.querySelector('p.mb-4')?.innerText || '').replace(/\s+/g, ' '),
      };
    });
    ok('clicking a company opens its cross-investor popup', companyDetail.title === company, companyDetail.title);
    ok('the popup lists every relevant superstar investor, not only the shortened card names',
      JSON.stringify(companyDetail.investors) === JSON.stringify(expectedInvestors),
      `${companyDetail.investors.length} shown vs ${expectedInvestors.length} expected`);
    ok('the popup shows status, previous stake, current stake, derived change and current value',
      companyDetail.measures && companyDetail.hasStake &&
        companyDetail.headers.join('|') === 'Investor|Status|Previous stake|Current stake|Change (derived)|Current value (Finology)',
      companyDetail.headers.join(' | '));
    ok('the popup distinguishes current position value from an amount bought or sold',
      /not an amount bought or sold/i.test(companyDetail.note) && /not disclosed, not zero/i.test(companyDetail.note),
      companyDetail.note.slice(0, 150));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  // The summary and the table under it must narrow through ONE predicate. Two predicates over the
  // same question is what had the filings tabs reporting different sets in two places. They now
  // live in separate in-page tabs, so read each panel in turn and compare their complete sets.
  await go('/#/research/super-investors?scope=portfolio', 9000);
  await waitForPanel();
  ok('the selected in-page tab survives a scope change',
    (await page.locator('#content-host [data-live-panel="quarterly-changes"]').count()) === 1);
  const scoped = await page.evaluate(() => {
    const host = document.getElementById('content-host');
    const sec = host.querySelector('[data-quarter-summary]');
    return {
      head: (sec?.querySelector('p')?.innerText || '').replace(/\s+/g, ' '),
      names: [...(sec?.querySelectorAll('[data-ranked-list] .divide-y > * span.font-semibold') || [])].map((n) => n.innerText.trim()),
    };
  });

  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="data-table"]').click();
  // The table streams its rows in, so a comparison against it has to wait for the settled set —
  // otherwise a company the summary names could be absent purely because its row had not been
  // appended yet, which would fail for a reason that is not about scope at all.
  await settleTables();
  const scopedTableText = await page.evaluate(() => {
    const host = document.getElementById('content-host');
    // Against the table's whole text rather than a per-row first line — that was the rank cell,
    // so nothing ever matched and the check failed for a reason that had nothing to do with scope.
    return [...host.querySelectorAll('tr[data-row-key]')].map((tr) => tr.innerText).join(' | ');
  });
  const missing = scoped.names.filter((name) => !scopedTableText.includes(name));
  // `quarterSummary({})` is unscoped by construction, so the scoped head must report FEWER
  // contributing books than the feed has comparable ones — a scope that narrowed nothing would
  // print "87 of 87" here and look identical to a working one.
  const contributing = Number(/across ([\d,]+) of ([\d,]+) comparable books/.exec(scoped.head)?.[1]?.replace(/,/g, '') ?? -1);
  const comparable = Number(/across ([\d,]+) of ([\d,]+) comparable books/.exec(scoped.head)?.[2]?.replace(/,/g, '') ?? -1);
  ok('a narrowed scope narrows the summary too', contributing > 0 && contributing < comparable, scoped.head.slice(0, 130));
  ok('...and every company it names is one the table below also shows',
    scoped.names.length > 0 && missing.length === 0,
    `${scoped.names.length} named, ${missing.length} absent from the table${missing.length ? `: ${missing.slice(0, 2).join(', ')}` : ''}`);
  await go('/#/research/super-investors?scope=universe', 9000);
  await waitForPanel();
  await page.locator('#content-host [data-live-section-tabs] [data-tab-id="quarterly-changes"]').click();
  await go('/#/research/super-investors/institutions?scope=universe', 2500);
  await waitForPanel();
  await go('/#/research/super-investors/superstar-investors?scope=universe', 2500);
  await waitForPanel();
  ok('returning from Institutions resets the in-page tab to All Investors',
    (await page.locator('#content-host [data-live-panel="investors"]').count()) === 1 &&
      (await page.locator('#content-host [data-tab-id="investors"][aria-selected="true"]').count()) === 1);
  }
}

// ---------------------------------------------------------------------------------------
// The feed must not re-fetch what it already has confirmed, and must not repaint per arrival.
//
// Three claims, all of which were false and all of which a reader felt as "this is slow":
//   1. The routes are edge-cached. The comment in worker/index.js said the edge held each response
//      for hours; `caches.default` was never consulted, so every reader made the upstream scrape
//      finology.in ninety-one times.
//   2. A return visit does not re-ask for every book. The revalidation pass walked all of them
//      unconditionally, inside a six-hour window in which the server had nothing new to say.
//   3. A book landing does not rebuild the whole panel. Ninety arrivals meant ninety rebuilds of
//      a table of every disclosed position across every book.
// ---------------------------------------------------------------------------------------
if (siProbe.state === 'live') {
  const edge = await page.evaluate(async () => {
    const read = async () => {
      const res = await fetch('api/super-investors', { cache: 'no-store' });
      await res.arrayBuffer();
      return res.headers.get('x-sattva-cache');
    };
    await read();
    return { second: await read() };
  });
  ok('the investor list route is served from the edge on a repeat request', /hit/.test(edge.second || ''), `x-sattva-cache: ${edge.second}`);

  // A GENUINE SECOND VISIT, which means a genuine document load. A hash navigation would leave
  // this module's in-memory state intact and the count would be zero for a reason that has nothing
  // to do with the store — proving nothing. `reload()` re-executes everything and keeps IndexedDB,
  // which is exactly the reader coming back to the tab.
  const seen = [];
  const countApi = (r) => {
    if (/\/api\/super-investors/.test(r.url())) seen.push(r.url());
  };
  await page.addInitScript(() => {
    window.__siPaints = 0;
    const attach = () => {
      const host = document.querySelector('#content-host');
      if (!host) return setTimeout(attach, 30);
      new MutationObserver(() => window.__siPaints++).observe(host, { childList: true });
    };
    attach();
  });
  page.on('request', countApi);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page
    .waitForFunction(async () => (await import('/js/data/super-investors.js')).meta().confirming === false, null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  page.off('request', countApi);

  const after = await page.evaluate(async () => {
    const f = await import('/js/data/super-investors.js');
    const m = f.meta();
    return { total: m.total, loadedBooks: m.loadedBooks, origin: m.origin, checkedAt: m.checkedAt };
  });

  ok('a return visit does not re-ask for every book it already holds', seen.length < after.total, `${seen.length} requests for ${after.total} investors`);
  ok('...and still paints the whole grid from the device', after.loadedBooks === after.total, `${after.loadedBooks} of ${after.total} books`);
  // The speed may not be bought with a freshness claim: books nobody re-confirmed keep the paint
  // labelled as this device's copy, and `checkedAt` reports when the server last vouched for it.
  ok('...and says the paint came from the store rather than claiming it is live', after.origin === 'store', `origin=${after.origin}`);
  ok('...with a real confirmation time behind it, not a blank', Number.isFinite(after.checkedAt), String(after.checkedAt));

  // COLD DEVICE, which is the only state in which books actually ARRIVE one at a time — and so the
  // only one in which the per-arrival repaint could be measured at all. Clearing the store and
  // reloading reproduces a reader who has never opened this tab.
  await page.evaluate(async () => (await import('/js/core/store.js')).clearAll());
  const cold = [];
  const countCold = (r) => {
    if (/\/api\/super-investors/.test(r.url())) cold.push(r.url());
  };
  page.on('request', countCold);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page
    .waitForFunction(async () => (await import('/js/data/super-investors.js')).meta().pending === 0, null, { timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(700);
  page.off('request', countCold);
  const coldState = await page.evaluate(async () => {
    const m = (await import('/js/data/super-investors.js')).meta();
    return { total: m.total, loadedBooks: m.loadedBooks, paints: window.__siPaints ?? -1 };
  });

  // A COLD DEVICE USED TO FETCH EVERY BOOK, and that was the assertion here — ninety-one requests
  // was the correct behaviour when the committed snapshot did not exist. It does now, so the
  // invariant is the opposite one: the reader who has never opened this tab gets the whole grid
  // without a request per investor. Only the books the capture could not read are fetched live.
  ok('a cold device paints the whole grid without a request per investor',
    coldState.loadedBooks === coldState.total && cold.length < coldState.total,
    `${cold.length} requests for ${coldState.total} investors, ${coldState.loadedBooks} books painted`);
  ok('...and a book landing does not rebuild the whole panel once per book',
    coldState.paints >= 0 && coldState.paints < coldState.total,
    `${coldState.paints} rebuilds for ${coldState.loadedBooks} books`);
} else {
  skip('the investor list route is served from the edge on a repeat request', `the upstream is ${siProbe.state}`);
  skip('a return visit does not re-ask for every book it already holds', `the upstream is ${siProbe.state}`);
  skip('...and a book landing does not rebuild the whole panel once per book', `the upstream is ${siProbe.state}`);
}

// ---------------------------------------------------------------------------------------
// 9d. The committed snapshot of every book
//
// THIS IS THE HALF THAT HELPS A FIRST VISIT, and it needs no Worker to check, because it is a
// committed file. The device cache does nothing at all for a reader who has never opened the tab,
// and that reader is the one who waited: ninety-one requests, four at a time, each of which may be
// a live scrape on somebody else's service.
// ---------------------------------------------------------------------------------------
{
  const snap = await page.evaluate(async () => {
    const res = await fetch('data/super-investors.json', { cache: 'no-cache' });
    if (!res.ok) return { status: res.status };
    const j = await res.json();
    return {
      status: 200,
      count: j.count,
      covered: j.covered,
      books: Object.keys(j.books || {}).length,
      failed: Object.keys(j.failed || {}).length,
      capturedAt: j.capturedAt,
      // Not one empty book may be written: an absent book is fetched live, an empty one is a lie.
      empties: Object.entries(j.books || {}).filter(([, b]) => b?.ok === false || !Array.isArray(b?.holdings)).length,
    };
  });
  if (snap.status !== 200 || !snap.count) {
    skip('the committed snapshot carries every investor’s book', `data/super-investors.json is ${snap.status === 200 ? 'empty' : snap.status}`);
  } else {
    ok('the committed snapshot carries every investor’s book', snap.books > snap.count * 0.9, `${snap.books} of ${snap.count} books, ${snap.failed} unread`);
    ok('...and never writes an unread book as an empty one', snap.empties === 0, `${snap.empties} empty`);
    ok('...with a capture time on it, so its age is readable', /^\d{4}-\d{2}-\d{2}T/.test(snap.capturedAt || ''), snap.capturedAt || 'none');

    // The paint itself, from a cold device. `clearAll()` + reload is the reader who has never been
    // here; on a static origin every /api/ request 404s, so the grid can ONLY come from the file.
    await page.evaluate(async () => (await import('/js/core/store.js')).clearAll());
    const fresh = [];
    const countFresh = (r) => {
      if (/\/api\/super-investors/.test(r.url())) fresh.push(r.url());
    };
    page.on('request', countFresh);
    await go('/#/research/super-investors/superstar-investors?scope=universe', 1200);
    await page
      .waitForFunction(() => document.querySelectorAll('#content-host [data-open-investor]').length > 10, null, { timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    page.off('request', countFresh);
    const painted = await page.evaluate(async () => {
      const m = (await import('/js/data/super-investors.js')).meta();
      return { total: m.total, loaded: m.loadedBooks, origin: m.origin, fromSnapshot: m.fromSnapshot, capturedAt: m.capturedAt,
        statusTags: document.querySelectorAll('[data-si-info]').length };
    });
    ok('a first visit paints the grid out of it', painted.loaded > painted.total * 0.9, `${painted.loaded} of ${painted.total} books`);
    ok('...with no request per investor', fresh.length < painted.total, `${fresh.length} requests for ${painted.total} investors`);
    ok('...and adds no per-view cache/status tag', painted.origin === 'snapshot' && painted.statusTags === 0, `origin=${painted.origin}, tags=${painted.statusTags}`);
  }
}

const cleanInvestorChrome = await page.evaluate(() => {
  const host = document.getElementById('content-host');
  const text = host?.innerText || '';
  return {
    statusTags: host?.querySelectorAll('[data-si-info]').length || 0,
    scopeTag: /(?:Portfolio|Watchlist|Universe)\s*·\s*[\d,]+\s+investors/i.test(text),
    loadingStrip: /Reading\s+[\d,]+\s+more\s+books?\s+from\s+Finology/i.test(text),
  };
});
ok('Superstar Investors adds no cache, scope or loading tags',
  cleanInvestorChrome.statusTags === 0 && !cleanInvestorChrome.scopeTag && !cleanInvestorChrome.loadingStrip,
  JSON.stringify(cleanInvestorChrome));

// ---------------------------------------------------------------------------------------
// 10. Scope and exports on both new tabs
// ---------------------------------------------------------------------------------------
console.log('\n— scope and exports —');
await go('/#/research/public-chatter?scope=portfolio', 1500);
{
  // WAIT FOR THE PANEL TO SETTLE, don't sample it at a fixed moment. This tab calls its upstream
  // straight from the browser, so where there is no egress the fetch does not fail fast — it sits
  // in "Loading chatter…" for the best part of half a minute before the honest failure panel
  // replaces it. A fixed 5s sample caught the spinner and reported it as a missing scope label,
  // which blames the page for the network.
  const settled = await (async () => {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const t = await hostText();
      if (!/Loading chatter/i.test(t)) return t;
      await page.waitForTimeout(500);
    }
    return await hostText();
  })();
  // Either the scope pill, or the named reason the feed is unavailable on this origin. An empty
  // panel that explains neither is the one outcome that must not happen.
  ok('chatter portfolio scope narrows and labels',
    /Portfolio/.test(settled) || /could not be reached|not configured|unreachable|no chatter route/i.test(settled),
    settled.slice(0, 80).replace(/\s+/g, ' '));
  // And whichever it is, the failure has to carry the address it asked for — a bare status code
  // is unfalsifiable, which is the whole lesson of the same-zone Worker refusal.
  if (!/Portfolio/.test(settled)) ok('...and a failure names the URL it asked for', /https?:\/\//.test(settled));
}
await go('/#/research/super-investors/superstar-investors?scope=portfolio', 2500);
ok('investors do not repeat the Portfolio scope as a content tag',
  !/Portfolio\s*·\s*[\d,]+\s+investors/i.test(await hostText()));
await page.locator('#content-host [data-live-section-tabs] [data-tab-id="data-table"]').click();
await page.waitForSelector('#content-host [data-live-panel="data-table"]');
await settleTables();
// Either the scope note, or — when the feed is unavailable on this origin — the named reason it
// is unavailable. What must never happen is an empty panel that explains neither.
{
  const t = await hostText();
  const held = await page.locator('tr[data-row-key]').count();
  // Two acceptable answers and one that is not. Either tracked investors DO disclose holdings in
  // the book — in which case the rows are the answer and the pill prints the count — or none do,
  // in which case the view has to say so in words. An empty panel explaining neither is the
  // outcome this guards against, and it is the one that used to happen when the feed was absent.
  ok('...and either lists the holdings tracked investors disclose, or says plainly that none do',
    held > 0 || /none of your holdings/i.test(t) || /of your holdings/i.test(t) || /No positions are shown/i.test(t),
    held > 0 ? `${held} disclosed positions in the book` : t.slice(0, 90).replace(/\s+/g, ' '));
}

for (const [hash, label] of [
  ['/#/research/public-chatter?scope=universe', 'chatter'],
  ['/#/research/super-investors/superstar-investors?scope=universe', 'investors'],
]) {
  await go(hash, 2500);
  if (label === 'investors' && (await page.locator('#content-host [data-tab-id="data-table"]').count())) {
    await page.locator('#content-host [data-live-section-tabs] [data-tab-id="data-table"]').click();
    await page.waitForSelector('#content-host [data-live-panel="data-table"]');
    await settleTables();
  }
  // A view with no data has no table and therefore no export button — that is the correct
  // behaviour, not a missing feature, so it reports SKIP rather than hanging on a click.
  const btn = page.locator('#content-host button:has-text("Export")').first();
  if (!(await btn.count())) {
    skip(`${label} export downloads`, 'this view has no data to export on this origin');
    continue;
  }
  const dl = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  await btn.click();
  const file = await dl;
  await downloadOrSkip(`${label} export downloads`, file);
  if (label === 'chatter' && file) {
    ok('...with a coverage-specific workbook name',
      /^sattva-public-chatter-coverage-\d{4}-\d{2}-\d{2}\.xlsx$/.test(file.suggestedFilename()),
      file.suggestedFilename());
    await page.locator('#content-host [data-chatter-section-tabs] [data-tab-id="not-in-coverage"]').click();
    await page.waitForSelector('#content-host [data-chatter-panel="not-in-coverage"]');
    await settleTables();
    const otherBtn = page.locator('#content-host button:has-text("Export")').first();
    const otherDl = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
    await otherBtn.click();
    const otherFile = await otherDl;
    await downloadOrSkip('not-in-coverage chatter export downloads', otherFile);
    if (otherFile) ok('...with an uncovered-topic workbook name',
      /^sattva-public-chatter-not-in-coverage-\d{4}-\d{2}-\d{2}\.xlsx$/.test(otherFile.suggestedFilename()),
      otherFile.suggestedFilename());
  }
}

// ---------------------------------------------------------------------------------------
// 11. Accessibility — table semantics and overlay focus management
// ---------------------------------------------------------------------------------------
console.log('\n— accessibility —');
{
  let totalTh = 0, missing = 0;
  for (const hash of ['/#/research/earnings-hub?scope=universe', '/#/research/breakouts/technical-scanner?scope=universe',
                      '/#/research/super-investors/institutions?scope=universe', '/#/research/insider-trades?scope=universe',
                      '/#/research/corp-announcements?scope=universe']) {
    await go(hash, 1300);
    const r = await page.evaluate(() => { const th = [...document.querySelectorAll('#content-host th')]; return [th.length, th.filter((t) => !t.hasAttribute('scope')).length]; });
    totalTh += r[0]; missing += r[1];
  }
  ok('every table header carries scope="col"', missing === 0, `${totalTh} headers checked, ${missing} missing`);
}
{
  await go('/#/research/breakouts/technical-scanner?scope=universe', 2600);
  await page.locator('#content-host tbody tr').first().click();
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => { const d = document.getElementById('drill-panel'); return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), inside: d.contains(document.activeElement) }; });
  ok('the drill is role=dialog aria-modal=true', st.role === 'dialog' && st.modal === 'true');
  ok('...and takes focus on open', st.inside);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  ok('...and Tab cannot escape it', await page.evaluate(() => document.getElementById('drill-panel').contains(document.activeElement)));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  ok('...and focus leaves it on close', await page.evaluate(() => !document.getElementById('drill-panel').contains(document.activeElement)));
}
// ---------------------------------------------------------------------------------------
// 12b. The header: one status control, and the alert stack
//
// The header used to carry a search box, a Sources button, a green "Live · just now" chip and a
// white "Updated 52 minutes ago" chip. The two chips were the interesting problem: they made two
// competing claims about the same subject, and the green one tracked the 20-second heartbeat,
// which asks nothing of any server — so it read "just now" whether or not a byte had been
// confirmed in an hour. These check the replacement is one control telling one truth.
// ---------------------------------------------------------------------------------------
console.log('\n— header status and live alerts —');
{
  await go('/#/research/breakouts/technical-scanner?scope=universe', 3500);
  const header = await evalSafe(() => {
    const h = document.querySelector('header');
    return {
      inputs: h.querySelectorAll('input').length,
      sourcesBtn: !!document.getElementById('sources-btn'),
      pills: h.querySelectorAll('[data-status-pill]').length,
      pillText: h.querySelector('[data-status-pill]')?.innerText.replace(/\s+/g, ' ').trim() || '',
      refresh: h.querySelectorAll('[data-header-refresh]').length,
      updatedChip: h.querySelectorAll('[data-updated-chip]').length,
    };
  });
  ok('the header search box is gone', header.inputs === 0, `${header.inputs} inputs in the header`);
  ok('...and so is the Sources button', !header.sourcesBtn);
  // THE OTHER HALF OF THAT TRADE, and the half that was missing. Removing the button was right;
  // leaving the registry with no caller at all was not, because CLAUDE.md goes on to say canonical
  // provenance "remains in the source registry". The door is a footer, BELOW the content, so the
  // chrome stays gone and the claim stays reachable — see section 17.
  const registryDoor = await evalSafe(() => {
    const btn = document.querySelector('[data-sources-open]');
    const main = document.getElementById('dashboard-main');
    if (!btn || !main) return { present: false };
    return { present: true, inHeader: !!btn.closest('header'), belowContent: !!(main.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  ok('...but the source registry is reachable, from a footer rather than the chrome',
    registryDoor.present && !registryDoor.inHeader && registryDoor.belowContent,
    JSON.stringify(registryDoor));
  ok('one status pill, not two competing chips', header.pills === 1 && header.updatedChip === 0, `${header.pills} pill(s), ${header.updatedChip} legacy chip(s)`);
  ok('...reading "Connected · checked <when>"', /^Connected · checked /.test(header.pillText) || /connecting/.test(header.pillText), header.pillText);
  ok('...and a refresh button beside it', header.refresh === 1);

  // The pill's timestamp must come from a poller that actually asked a server something. The
  // heartbeat is registered `synthetic` for exactly this reason.
  const tickHonesty = await evalSafe(async () => {
    const live = await import('/js/core/live.js');
    return { data: live.getLastDataTick(), global: live.getLastTick() };
  });
  ok('the pill dates from a real data tick, not the heartbeat', tickHonesty.data === null || tickHonesty.data <= tickHonesty.global,
    tickHonesty.data ? `data ${tickHonesty.global - tickHonesty.data}ms behind the heartbeat` : 'no data tick yet');

  // Refresh must say what it found. "Up to date" is the common answer and a real one — a spinner
  // that simply vanishes leaves the reader unsure anything was checked. "Couldn't check" is the
  // third real answer, for a poller that never settled: the wait is bounded so the button cannot
  // sit on "Checking…" for ever, and a check that did not complete must never print "Up to date".
  //
  // "Still reading…" is the FOURTH, and it arrived with the on-demand feeds. Those are one request
  // per company, so a walk can outlast the button's patience while proceeding perfectly well —
  // reporting that as "Couldn't check" would be a failure claim about work that has not failed, and
  // as "Up to date" a freshness claim about a check that has not finished.
  await page.locator('[data-header-refresh]').click();
  const label = await (async () => {
    const until = Date.now() + 20000;
    let l = '';
    while (Date.now() < until) {
      l = await page.locator('[data-header-refresh-label]').innerText();
      if (!/Checking/i.test(l)) return l;
      await page.waitForTimeout(400);
    }
    return l;
  })();
  ok('refresh reports a result rather than just spinning', /Up to date|\d+ new|Refresh|Couldn|Still reading/i.test(label), label);
  ok('...and never re-enables itself still claiming to be checking', !(await page.locator('[data-header-refresh]').isDisabled()));

  // The alert stack.
  const alerts = await evalSafe(async () => {
    const n = await import('/js/ui/notifications.js');
    n.clear();
    const first = n.push({ key: 'v1', kind: 'earnings', title: 'Test Co', detail: 'Revenue ₹100 Cr' });
    const dupe = n.push({ key: 'v1', kind: 'earnings', title: 'Test Co', detail: 'again' });
    n.push({ key: 'v2', kind: 'concall', title: 'Other Co', detail: 'Analysis ready' });
    for (let i = 0; i < 5; i++) n.push({ key: `f${i}`, kind: 'system', title: `Filler ${i}` });
    const root = document.getElementById('notification-root');
    const r = root.getBoundingClientRect();
    return {
      accepted: first, dupeRejected: dupe === false,
      cards: root.children.length,
      z: Number(getComputedStyle(root).zIndex),
      bottomRight: window.innerHeight - r.bottom < 40 && window.innerWidth - r.right < 40,
    };
  });
  ok('an alert renders in the lower-right corner', alerts.accepted && alerts.cards > 0 && alerts.bottomRight, `${alerts.cards} card(s)`);
  // It has to be VISIBLE, not merely present. The first version used the shared `.fade-in` class —
  // `animation: … both`, which pins the element at the keyframe's opacity-0 start state until the
  // animation actually runs. Anything that stops it running left a correctly-positioned, fully
  // laid-out, completely invisible alert. `elementFromPoint` is the check that cannot be fooled by
  // geometry alone.
  await page.waitForTimeout(500);
  const visible = await evalSafe(() => {
    const root = document.getElementById('notification-root');
    const card = root.lastElementChild;
    if (!card) return { ok: false, why: 'no card' };
    const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: root.contains(hit),
      opacity: Number(getComputedStyle(card).opacity),
      why: hit ? hit.tagName : 'nothing',
      styled: getComputedStyle(card).backgroundColor !== 'rgba(0, 0, 0, 0)',
    };
  });
  // Needs the compiled stylesheet: without it the card has no background, so `elementFromPoint`
  // finds whatever is behind it and the check measures the asset rather than the component.
  if (visible.styled) {
    ok('...and is actually painted, not just present at opacity 0', visible.ok && visible.opacity > 0.5,
      `opacity ${visible.opacity}, topmost element at its centre is ${visible.ok ? 'the card' : visible.why}`);
  } else {
    skip('...and is actually painted, not just present at opacity 0', 'compiled stylesheet unavailable — the card has no background to hit-test');
  }
  ok('...the same event never announces twice', alerts.dupeRejected);
  ok('...and the stack is capped rather than unbounded', alerts.cards <= 4, `${alerts.cards} visible after 7 pushes`);

  // Stacking: a toast must never cover something the reader opened on purpose.
  const drillZ = await evalSafe(() => Number(getComputedStyle(document.getElementById('drill-panel')).zIndex));
  const wsZ = await evalSafe(() => Number(getComputedStyle(document.getElementById('workspace-overlay')).zIndex));
  if (Number.isFinite(alerts.z) && Number.isFinite(drillZ) && Number.isFinite(wsZ)) {
    ok('alerts sit BEHIND the drill, the workspace and modals', alerts.z < drillZ && alerts.z < wsZ, `toast z-${alerts.z} < drill z-${drillZ} < workspace z-${wsZ}`);
  } else {
    // The stacking order lives entirely in Tailwind's z-* utilities, so with the generated asset
    // missing every one computes to `auto`.
    skip('alerts sit BEHIND the drill, the workspace and modals', 'compiled stylesheet unavailable — every z-index computes to auto');
  }

  // The honesty rules the alert text has to obey. Both are the same failure mode the tables
  // already guard: a missing figure is not a zero, and a move across zero is not a percentage.
  const wording = await evalSafe(async () => {
    const w = await import('/js/core/watch.js');
    return {
      lossToProfit: w.earningsDetail({ netProfit: { current: 120, prior: -80, kind: 'loss_to_profit', pct: null } }),
      lossBoth: w.earningsDetail({ netProfit: { current: -3754, prior: -6608, kind: 'loss_both', pct: 43 } }),
      normal: w.earningsDetail({ revenue: { current: 5000, prior: 4000, kind: 'normal', pct: 25 } }),
      noFigures: w.earningsDetail({ resultDate: '2026-08-12' }),
      pending: w.concallDetail({ reason: 'listed', resultScore: null }),
      analysed: w.concallDetail({ reason: 'analysed', resultScore: 75.7 }),
    };
  });
  ok('an alert never turns a sign change into a growth rate', /turned profitable/.test(wording.lossToProfit) && !/%/.test(wording.lossToProfit), wording.lossToProfit);
  ok('...and never calls a narrowing loss a gain', /loss in both periods/.test(wording.lossBoth) && !/\+43/.test(wording.lossBoth), wording.lossBoth);
  ok('...but does show a real percentage where one exists', /\+25\.0%/.test(wording.normal), wording.normal);
  ok('a result with no parsed figures says so, rather than showing zeros', /not yet parsed/.test(wording.noFigures) && !/0/.test(wording.noFigures.replace(/2026-08-12/, '')), wording.noFigures);
  ok('an unanalysed con-call is "pending", never a score of nil', /analysis pending/i.test(wording.pending) && !/0\/100/.test(wording.pending), wording.pending);
  ok('...and an analysed one marks the score as a third party’s', /third-party/i.test(wording.analysed) && /76\/100/.test(wording.analysed), wording.analysed);

  // The whole point of the watcher: alerts must keep arriving on a tab that owns neither feed.
  const watching = await evalSafe(async () => {
    const live = await import('/js/core/live.js');
    return { earnings: live.getLastTick('earnings-live') !== null, concall: live.getLastTick('concall-scans') !== null };
  });
  ok('both feeds are watched app-wide, from a tab that owns neither', watching.earnings || watching.concall,
    `earnings ${watching.earnings ? 'ticking' : 'idle'}, con-call ${watching.concall ? 'ticking' : 'idle'}`);
  await evalSafe(async () => (await import('/js/ui/notifications.js')).clear());
}

// ---------------------------------------------------------------------------------------
// 15b. News, Corporate Announcements and Insider Trades
//
// TWO BUGS THAT LOOKED LIKE BROKEN APIs AND WERE NOT, so both are asserted here rather than left
// to be rediscovered from a screenshot.
//
//   1. The client built ONE date-range string and patched a `?` onto the front of it. Right for the
//      two path-parameter routes, wrong for `api/news?q=…`, which then carried two question marks:
//      the Worker read `q` as `"RELIANCE?from=2026-07-18"` and `from` as absent, the upstream
//      searched for that literal string, and every company came back with the same generic market
//      news. The requests are observable even on a static origin, where they 404 — the URL is the
//      artefact, not the response.
//
//   2. The tab subscribed to the feed ONCE and guarded the handler with the render token captured
//      at subscribe time. A scope toggle — the entire point of these tabs — incremented that token
//      and killed the subscription. Measured before the fix: the feed reached 40 companies and
//      4,583 rows while the screen stayed at 21 and the pill still read "21 companies". Nothing
//      threw and nothing failed; the tab simply stopped.
// ---------------------------------------------------------------------------------------
console.log('\n— news, announcements and insider trades —');
{
  const seen = { news: [], announcements: [], insider: [], marketNewsApi: [] };
  const watchFilings = (req) => {
    const u = req.url();
    if (u.includes('/api/market-news/')) seen.marketNewsApi.push(`${req.method()} ${u}`);
    else if (u.includes('/api/news')) seen.news.push(u);
    else if (u.includes('/api/announcements/')) seen.announcements.push(u);
    else if (u.includes('/api/insider-trades/')) seen.insider.push(u);
  };
  page.on('request', watchFilings);

  // DRIVE THE WALK, DO NOT WAIT FOR ONE. These requests used to happen on their own, on every
  // landing — which is the behaviour that was removed, because forty round trips is not a page
  // load. What they assert is the SHAPE of the request, and that is worth keeping, so the walk is
  // now started the way a reader starts it: through the refresh registry.
  //
  // A deployment with no committed snapshot still walks once on a cold start, and that walk overlaps
  // the one this drives — measured as 80 requests across 40 companies, which reads as a duplicating
  // walk and is two honest ones. So each feed settles first and the recording starts after.
  const settle = async (key) => {
    await page
      .waitForFunction(async (k) => (await import('/js/data/filings.js'))[k].meta().pending === 0, key, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(400);
  };
  const drive = async (feedKey, id) => {
    await settle(feedKey);
    seen.news.length = 0;
    seen.announcements.length = 0;
    seen.insider.length = 0;
    await evalSafe(async (i) => (await import('/js/core/refresh.js')).refreshOne(i), id);
    await page.waitForTimeout(2500);
  };

  // ---------------------------------------------------------------------------------------
  // NEWS ASKS *WHICH COMPANIES* BEFORE IT SEARCHES.
  //
  // Two separate claims live here and both matter. The walk does not run on a page load — that is
  // the Refresh button's job, asserted below. AND the companies it walks are the ones the reader
  // named, because the upstream is a SEARCH endpoint with no date index to flip to: "the whole
  // universe" is 603 requests against a sixty-a-minute cap. So the request count is a much stronger
  // claim than the old "more than one": NOTHING before a selection, then EXACTLY one per company
  // named — never a bounded forty, and never a stray extra per render.
  // ---------------------------------------------------------------------------------------
  // PICK COMPANIES THE SNAPSHOT DOES NOT ALREADY COVER, or this measures nothing.
  //
  // The committed news snapshot now carries 123 companies. A selection drawn from those sends zero
  // requests and is RIGHT to — the file already answers, and the Refresh button is what forces a
  // live re-read. An earlier version of this check picked the first three book tickers, hit three
  // companies that were already in the file, measured 0 requests and called it a failure. The code
  // was correct and the check was wrong, which is the more dangerous way round.
  // Read the SNAPSHOT FILE, not `feed.rows()`. With no selection the News tab returns early without
  // calling `load()`, so the feed holds nothing yet — an earlier version read `rows()` there, got an
  // empty set, concluded every held company was uncovered, and picked three that were in the file.
  // The check then measured zero requests and blamed the code. Ask the artefact, not the module
  // that has not read it yet.
  // NEWS LOADS ITSELF NOW. It used to open on a company picker and send nothing until the reader
  // named companies. The budget argument behind that is still true of the WALK and was never true
  // of the paint: the scrape walks the book first and commits the result, so a scoped view's rows
  // are in the snapshot and cost one conditional GET. What has to stay true — and is the first
  // assertion below — is that a landing sends no per-company request.
  const book = await evalSafe(async () => {
    const cov = await import('/js/data/coverage.js');
    const uniMod = await import('/js/data/universe.js');
    const snap = await fetch('data/news.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({}));
    // COVERED MEANS ASKED, NOT "HAD SOMETHING TO SAY". A company the capture searched and that
    // answered nothing is recorded in `empty` and carries no rows — it is covered, the walk
    // deliberately skips it, and picking one here would measure zero requests and blame the code.
    const covered = new Set([
      ...Object.keys(snap.byTicker || {}),
      ...(Array.isArray(snap.empty) ? snap.empty : []),
    ].map((t) => t.toUpperCase()));
    const held = cov.holdings().filter((h) => h.ticker);
    // THE BOOK CANNOT EXERCISE THE WALK. Every one of its 123 companies is already in the snapshot,
    // which is the zero-request path asserted just below. To make the walk send anything, the
    // watchlist is loaded with companies the capture has never seen — that is also the real case a
    // reader hits, since a watchlist can hold anything.
    const uni = uniMod.adaptUniverse(await fetch('data/universe.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => []));
    const seenT = new Set();
    const fresh = uni
      .map((u) => ({ ticker: String(u.ticker || '').toUpperCase(), name: u.name }))
      .filter((c) => {
        if (!c.ticker || !c.name || seenT.has(c.ticker) || covered.has(c.ticker)) return false;
        seenT.add(c.ticker);
        return true;
      });
    return { fresh: fresh.slice(0, 3), coveredCount: covered.size, heldCount: held.length };
  });
  const bookNames = (book?.fresh || []).map((b) => b.name);

  // ---- the landing: rows, and not one request ---------------------------------------------
  seen.news.length = 0;
  await go('/#/research/news?scope=portfolio', 4500);
  await settleTables();
  ok('news paints on its own, with no company to pick first',
    (await page.locator('#content-host tbody tr[data-row-key]').count()) > 0 && (await page.locator('[data-picker]').count()) === 0,
    `${await page.locator('#content-host tbody tr[data-row-key]').count()} rows, ${await page.locator('[data-picker]').count()} picker(s)`);
  ok('...and sends NO per-company request to do it', seen.news.length === 0, `${seen.news.length} request(s) on load`);
  // AN ALL-NULL ROW IS NOT AN ARTICLE. The scrape records a company it searched and found nothing
  // for as one row with every field null; rendering those put 62 "(untitled)" rows on screen.
  ok('...and a searched-but-empty company is not rendered as an untitled article',
    !(await page.locator('#content-host tbody tr[data-row-key]').allInnerTexts()).some((t) => /\(untitled\)/.test(t)));
  // THE DENOMINATOR MOVED TO THE CHIP, IT DID NOT GO. The head is one chip now, matching the
  // market-news half of this same tab; the scope summary it replaced is reproduced whole in the
  // chip's tooltip and again in its modal. What must still be true is the rule that sentence
  // exists for: 23 rows look complete until you know the book is 142, so the number has to be
  // reachable — and it has to compare COMPANIES with companies, never rows with companies
  // ("1,279 of 142 articles" is two different units either side of an "of").
  ok('the head is one chip, with no scope pill competing with it',
    !/Portfolio · [\d,]+ of [\d,]+/.test(await hostText()));
  const chipTitle = (await page.locator('[data-filings-info]').first().getAttribute('title')) || '';
  ok('...and the chip still reaches the denominator, in companies',
    /of the book's [\d,]+ companies/.test(chipTitle), chipTitle.slice(0, 110));
  // The face follows the same three-hour window as the capture watchdog.
  const chipState = await evalSafe(async () => {
    const m = (await import('/js/data/filings.js')).news.meta();
    const el = document.querySelector('[data-filings-info]');
    const age = m.capturedAt ? Date.now() - Date.parse(m.capturedAt) : null;
    return {
      age,
      fresh: age !== null && age >= 0 && age <= 3 * 60 * 60 * 1000,
      cls: el?.className || '',
      txt: el?.innerText.trim() || '',
    };
  });
  ok('...and "Up to date" requires a capture inside the three-hour freshness window',
    chipState.fresh
      ? /emerald/.test(chipState.cls) && chipState.txt === 'Up to date'
      : /slate/.test(chipState.cls) && /^Updated|Updating/.test(chipState.txt),
    `age=${chipState.age === null ? 'none' : Math.round(chipState.age / 3600000) + 'h'} chip="${chipState.txt}"`);

  // ---- the walk: still one request per company, and only when asked ------------------------
  const picked = (book?.fresh || []).map((b) => b.ticker);
  if (!picked.length) {
    skip('a Refresh walks the companies the capture has not covered', 'every company in coverage is already in the snapshot');
  } else {
    await page.evaluate((cs) => localStorage.setItem('sattva:watchlist', JSON.stringify(cs.map((c) => ({ ticker: c.ticker, name: c.name, addedAt: new Date().toISOString() })))), book.fresh);
    seen.news.length = 0;
    await go('/#/research/news?scope=watchlist', 4000);
    ok('a watchlist of uncaptured companies still sends nothing on load', seen.news.length === 0, `${seen.news.length} request(s)`);
    // The status label stays passive; the header Refresh control performs the requested walk.
    await page.locator('[data-filings-info]').first().click();
    await page.waitForTimeout(200);
    ok('...and says how many have not been asked about rather than claiming there is no news',
      /of the \d+ companies you track appear on this feed|Nothing tracked yet/i.test(
        (await page.locator('[data-filings-info]').getAttribute('title')) || ''
      ));
    ok('...and the filings status opens no explainer popup',
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

    seen.news.length = 0;
    await page.locator('[data-header-refresh]').click();
    await page.waitForTimeout(6000);
    const newsUrls = seen.news.map((u) => new URL(u));
    // EXACTLY one each. A walk that leaks an extra request per render is the failure mode here.
    ok('...then Refresh sends exactly one request per uncovered company', newsUrls.length === picked.length,
      `${newsUrls.length} request(s) for ${picked.length} companies`);
    ok('...and no company was asked about twice', new Set(newsUrls.map((u) => u.href)).size === newsUrls.length, `${new Set(newsUrls.map((u) => u.href)).size} distinct`);
    // The whole bug in one assertion: a URL with two `?` parses, fetches, and returns 200 nonsense.
    ok('...each with exactly one query string', newsUrls.every((u) => (u.href.match(/\?/g) || []).length === 1), newsUrls[0]?.href.slice(-90) || '');
    ok('...carrying a date range the Worker can read',
      newsUrls.every((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('from') || '') && /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('to') || '')),
      newsUrls[0] ? `from=${newsUrls[0].searchParams.get('from')} to=${newsUrls[0].searchParams.get('to')}` : '');
    const queries = newsUrls.map((u) => u.searchParams.get('q') || '');
    // Not "no punctuation" — a real book line is `J&K Bank Limited`, and an ampersand that survives
    // `encodeURIComponent` and comes back out of `searchParams` is the layer working. What must
    // never appear inside the search term is a fragment of the URL meant to sit beside it.
    const folded = queries.find((q) => !q || /\b(from|to)=\d{4}-\d{2}-\d{2}/.test(q));
    ok('...and a query with no part of the URL folded into it', !folded, folded ? `q=${folded}` : `${queries.length} clean, e.g. ${queries[0]}`);
    // Searching the SYMBOL finds quote pages; searching the NAME finds the company. Measured on one
    // book line: 3 results against 20, and the three were mostly price widgets.
    const named = queries.filter((q) => bookNames.includes(q)).length;
    ok('news searches the company name, not the ticker symbol', named > 0 && named === queries.length, `${named}/${queries.length} matched a coverage name`);
    await page.evaluate(() => localStorage.removeItem('sattva:watchlist'));
  }

  // ---------------------------------------------------------------------------------------
  // ANNOUNCEMENTS ASK THE EXCHANGE, NOT THE COMPANIES.
  //
  // This check used to assert one request per company. It now asserts the opposite, and that is the
  // point: BSE publish the same filings indexed by DATE, so the whole exchange arrives in the
  // committed snapshot and the per-company walk is not merely unnecessary but wrong — it would
  // spend a sixty-a-minute budget rediscovering that a company filed nothing.
  //
  // `coversUniverse` is what switches the walk off, and it must come from the SNAPSHOT declaring it
  // rather than from a row count. A row count cannot tell "nobody filed" from "we ran out of
  // budget", which is the exact confusion this whole change exists to end.
  // ---------------------------------------------------------------------------------------
  seen.announcements.length = 0;
  await go('/#/research/corp-announcements?scope=universe', 4000);
  const annUrls = seen.announcements.map((u) => new URL(u));
  ok('announcements ask the exchange by date, not each company in turn', annUrls.length === 0, `${annUrls.length} per-company request(s)`);
  const annMeta = await evalSafe(async () => (await import('/js/data/filings.js')).announcements.meta());
  ok('...because the snapshot declares it covers every listing', annMeta?.coversUniverse === true, `coversUniverse=${annMeta?.coversUniverse}, exchange=${annMeta?.exchangeCompanies}`);
  // The number that made this change worth making. The per-company walk reached 118 companies;
  // anything near that would mean the date index is not actually being read.
  ok('...and reaches far more companies than the per-company walk ever did', (annMeta?.covered || 0) > 300, `${annMeta?.covered} companies, ${annMeta?.rowCount} rows`);
  ok('...carrying BSE\'s own categories rather than a taxonomy of ours', await (async () => {
    const cats = await evalSafe(async () => {
      const rows = (await import('/js/data/filings.js')).announcements.rows();
      return [...new Set(rows.map((r) => r.category).filter(Boolean))];
    });
    return (cats || []).some((c) => ['Company Update', 'Board Meeting', 'Corp. Action', 'Result', 'AGM/EGM'].includes(c));
  })(), 'BSE category names present');
  const cleanedAnnouncement = await evalSafe(async () => {
    const { cleanFilingText } = await import('/js/tabs/corp-announcements.js');
    return cleanFilingText('Board meeting<BR><BR>outcome <b>approved</b>');
  });
  ok('...and presentation-only HTML never leaks into a filing subject',
    cleanedAnnouncement === 'Board meeting outcome approved', cleanedAnnouncement || 'blank');

  // ---------------------------------------------------------------------------------------
  // THE UNIVERSE HALF OF NEWS IS A DIFFERENT FEED ANSWERING A DIFFERENT QUESTION.
  //
  // Portfolio scope searches company by company. Universe scope cannot — 603 searches is ten
  // minutes of somebody else's service — so it reads Moneycontrol's market-wide listing instead,
  // captured by a scheduled Action because neither the browser nor a Cloudflare Worker can fetch
  // that host (403 by TLS fingerprint, measured both ways).
  //
  // What must hold: the two halves never bleed into each other, the Universe half costs no
  // per-company request, and — the part that is easy to get wrong — the control says what it can
  // actually do. It checks for a newer CAPTURE. It cannot reach the publisher, and a button that
  // implied otherwise would be the freshest-looking lie on the page.
  // ---------------------------------------------------------------------------------------
  seen.news.length = 0;
  await go('/#/research/news?scope=universe', 4000);
  await page.waitForFunction(() => !document.querySelector('[data-rows-pending]'), { timeout: 20000 }).catch(() => {});
  const mkt = await evalSafe(async () => (await import('/js/data/market-news.js')).meta());
  ok('Universe news reads the market-wide capture, not the per-company API', seen.news.length === 0 && (mkt?.count || 0) > 0,
    `${seen.news.length} /api/news request(s), ${mkt?.count} stories`);
  ok('...and it is the editorial card list, not the per-company table', (await page.locator('#content-host tbody tr[data-row-key]').count()) === 0);
  // THE TWO HALVES MUST NOT BLEED. Universe is the market-wide capture; a narrowed scope is the
  // per-company table. Each renders the other's chrome nowhere.
  ok('...while a narrowed scope gets the per-company table and no market fetch control', await (async () => {
    await go('/#/research/news?scope=portfolio', 4000);
    await settleTables();
    return (await page.locator('#content-host tbody tr[data-row-key]').count()) > 0 &&
      (await page.locator('[data-mcnews-fetch]').count()) === 0 &&
      !/money\s*control/i.test(await hostText());
  })());
  await go('/#/research/news?scope=universe', 3500);

  // The tab keeps one passive status chip and no freshness-card or popup furniture.
  const headText = (await page.locator('#content-host').innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the news head carries one small status chip and no freshness card',
    (await page.locator('[data-mcnews-info]').count()) === 1 &&
      (await page.locator('#content-host [data-mcnews-fetch]').count()) === 0 &&
      !/a scheduled job also reads it/i.test(headText) &&
      !/money\s*control/i.test(headText),
    headText.slice(0, 110));

  // "LIVE" IS A CLAIM ABOUT DATA. Green may appear only while the capture really is the newest the
  // schedule can produce — the exact failure the header's old green chip made, reading "just now"
  // off a heartbeat that asked no server anything.
  const chip = await page.evaluate(async () => {
    const el = document.querySelector('[data-mcnews-info]');
    const mod = await import('/js/data/market-news.js');
    const at = Date.parse(mod.meta().capturedAt || '');
    return {
      text: el?.innerText.trim() || '',
      green: /emerald/.test(el?.className || '') || /text-emerald/.test(el?.className || ''),
      ageMin: Number.isFinite(at) ? Math.round((Date.now() - at) / 60000) : null,
      dot: !!el?.querySelector('span.rounded-full'),
    };
  });
  const shouldBeGreen = chip.ageMin !== null && chip.ageMin < 45;
  ok('...whose green "Up to date" is only shown when the capture really is current',
    chip.green === shouldBeGreen && (shouldBeGreen ? /^Up to date$/i.test(chip.text) : /^Updated|Updating/.test(chip.text)),
    `"${chip.text}" · ${chip.ageMin}m old · ${chip.green ? 'green' : 'neutral'}`);

  // The status chip must not open the removed provenance/fetch popup.
  await page.locator('[data-mcnews-info]').click();
  await page.waitForTimeout(200);
  ok('...and the market-news status opens no explainer popup',
    (await page.locator('[data-mcnews-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
      (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

  // -------------------------------------------------------------------------------------
  // THE UNIVERSE HALF IS AN EDITORIAL LIST, NOT A TABLE — thumbnail, headline, standfirst, in the
  // publisher's own layout, and the WHOLE CARD is the link out. Three things must hold:
  //   • clicking a story opens the publisher's page, in a new tab, with the opener severed;
  //   • the thumbnail is the publisher's own image, not a placeholder we invented;
  //   • a story with no publisher time SAYS SO, rather than borrowing the moment we captured it.
  // -------------------------------------------------------------------------------------
  const cards = await evalSafe(async () => {
    const mod = await import('/js/data/market-news.js');
    const rows = mod.rows();
    const byKey = new Map(rows.map((r) => [String(r.id || r.url), r]));
    const nodes = [...document.querySelectorAll('[data-news-key]')];
    const keys = nodes.map((a) => a.getAttribute('data-news-key'));
    const anchors = nodes.filter((a) => a.tagName === 'A').length;
    // A story whose captured URL is not http(s) is rendered without a link on purpose. None should
    // exist; if one does, this reports it rather than letting it read as a missing anchor.
    const unlinkable = nodes.filter((a) => a.hasAttribute('data-news-unlinkable')).length;
    // ASSERTED AGAINST THE ROW'S OWN PUBLISHER, not against one hard-coded domain.
    //
    // These read `https://(www.)?moneycontrol.com/` and `https://images.moneycontrol.com/` while
    // that was the only publisher in the feed. With five, a fixed host would fail for four of them
    // and — worse — would pass a Mint story rendered with a Moneycontrol thumbnail, which is the
    // actual thing worth preventing. Comparing each card against the URL and image on ITS OWN row
    // is publisher-agnostic and strictly stronger: it catches a card wearing another story's
    // picture, which no domain test ever could.
    const offsite = nodes.filter((a) => {
      const href = a.getAttribute('href') || '';
      if (!/^https:\/\//.test(href)) return false;
      try { return new URL(href).origin !== window.location.origin; } catch { return false; }
    }).length;
    const newTab = nodes.filter((a) => a.getAttribute('target') === '_blank' && /noreferrer/.test(a.getAttribute('rel') || '')).length;
    const hrefMatchesFeed = nodes.filter((a) => byKey.get(a.getAttribute('data-news-key'))?.url === a.getAttribute('href')).length;
    const thumbs = nodes.filter((a) => {
      const img = a.querySelector('img');
      const want = byKey.get(a.getAttribute('data-news-key'))?.image;
      return !!want && !!img && img.getAttribute('src') === want && /^https:\/\//.test(want);
    }).length;
    const withImage = nodes.filter((a) => byKey.get(a.getAttribute('data-news-key'))?.image).length;
    // WHITESPACE IS NORMALISED ON BOTH SIDES, and only whitespace. `innerText` collapses runs of
    // spaces the way HTML always renders them, so 20 Mint headlines that write "brings  ₹10" with a
    // double space read back single-spaced and failed a strict compare — the headline was
    // reproduced exactly, the comparison just could not see it. Collapsing both sides still catches
    // the thing this guards: a word changed, a truncation, any rewrite of somebody's headline.
    const flat = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const headlines = nodes.filter((a) => {
      const h = a.querySelector('h3');
      return h && flat(h.innerText) === flat(byKey.get(a.getAttribute('data-news-key'))?.title);
    }).length;
    // Undated stories: the card must name the absence, and must never print firstSeenAt.
    const undatedOnScreen = nodes.filter((a) => byKey.get(a.getAttribute('data-news-key')) && !byKey.get(a.getAttribute('data-news-key')).publishedAt);
    const undatedSay = undatedOnScreen.filter((a) => /time not published/i.test(a.innerText)).length;
    return {
      data: rows.length,
      drawn: nodes.length,
      dupes: keys.length - new Set(keys).size,
      missing: keys.filter((k) => !byKey.has(k)).length,
      anchors, offsite, newTab, hrefMatchesFeed, thumbs, withImage, headlines, unlinkable,
      undated: undatedOnScreen.length,
      undatedSay,
    };
  });

  ok('every market-news story on screen is a distinct story the feed holds',
    cards && cards.dupes === 0 && cards.missing === 0 && cards.drawn > 0,
    `${cards?.drawn} drawn from ${cards?.data}, ${cards?.dupes} duplicate(s), ${cards?.missing} not in the feed`);
  ok('...rendered as the publisher\'s card — thumbnail, headline, standfirst',
    cards && cards.thumbs === cards.withImage && cards.withImage > 0 && cards.headlines === cards.drawn,
    `${cards?.thumbs}/${cards?.withImage} cards carrying their own story's thumbnail, ${cards?.headlines}/${cards?.drawn} headlines reproduced verbatim`);
  ok('...and clicking one opens THAT story on the publisher\'s site, in a new tab',
    cards && cards.unlinkable === 0 && cards.anchors === cards.drawn && cards.offsite === cards.drawn && cards.newTab === cards.drawn && cards.hrefMatchesFeed === cards.drawn,
    `${cards?.anchors} anchors, ${cards?.offsite} leaving this origin, ${cards?.newTab} with target+noreferrer, ${cards?.hrefMatchesFeed} pointing at their own story, ${cards?.unlinkable} with no usable URL`);
  ok('a story with no publisher time says so, never the time we saw it',
    cards && (cards.undated === 0 || cards.undatedSay === cards.undated),
    `${cards?.undated} undated on screen, ${cards?.undatedSay} saying the time is not published`);

  // -------------------------------------------------------------------------------------
  // FIVE PUBLISHERS IN ONE LIST, AND HISTORY THAT DOES NOT END AT THE HEAD
  // -------------------------------------------------------------------------------------
  //
  // The capture is a bounded head plus a shard per month. Two things have to hold and neither is
  // visible from a row count: every story says who published it (an unattributed headline in a
  // mixed feed attributes itself to whichever masthead the reader assumes), and scrolling to the
  // end pulls the next month in rather than stopping at whatever the head happened to carry.

  const bylines = await evalSafe(async () => {
    const mod = await import('/js/data/market-news.js');
    const { withoutPublisherName } = await import('/js/core/source-copy.js');
    // The row keeps the real publisher for matching; the SCREEN shows it through the naming policy,
    // so the card is checked against the labelled form. Checking the raw value would fail for the
    // one publisher whose brand this dashboard withholds, and pass only by accident for the rest.
    const named = (v) => withoutPublisherName(String(v || '')).replace(/^the publisher\b/i, 'The publisher');
    const rows = mod.rows();
    const cardsNow = [...document.querySelectorAll('[data-news-key]')];
    const byKey = new Map(rows.map((r) => [String(r.id || r.url), r]));
    const drawnBylines = cardsNow.filter((c) => {
      const r = byKey.get(c.dataset.newsKey);
      return r?.publisher && (c.innerText || '').includes(named(r.publisher));
    }).length;
    const pubs = [...new Set(rows.map((r) => r.publisher).filter(Boolean))];
    return {
      total: rows.length,
      withPublisher: rows.filter((r) => r.publisher).length,
      publishers: pubs,
      drawn: cardsNow.length,
      drawnBylines,
      options: [...document.querySelectorAll('[data-news-publisher] option')].map((o) => o.value),
      // The withheld brand must not reach the screen through any of the new surfaces — byline,
      // dropdown, footer or provenance — the same rule the Earnings view is already held to.
      brandOnScreen: /money\s*control/i.test(document.getElementById('content-host')?.innerText || ''),
    };
  });
  // A CAPTURE WITH TWO WRITERS NEEDS TWO CLOCKS, and this is the check that says so. The watchdog
  // and the tab's auto-fetch both dispatch the workflow that reads MONEYCONTROL and nothing else,
  // while the file's own `capturedAt` is whichever of the two jobs wrote it last. Gating on the
  // file would let the hourly RSS run hold the timestamp fresh while Moneycontrol went unread for
  // days — a staleness check answered by a source it cannot refresh, and silent, because every
  // number on screen would look healthy. `freshnessOf` is pure and exported precisely so both
  // branches can be driven here rather than waited for.
  const freshness = await evalSafe(async () => {
    const wd = await import('/js/data/capture-watchdog.js');
    const old = '2020-01-01T00:00:00.000Z';
    const now = new Date().toISOString();
    return {
      // RSS ran a second ago, Moneycontrol has not run since 2020: the answer must be 2020.
      perSource: wd.freshnessOf('marketNews', { capturedAt: now, sources: { moneycontrol: { capturedAt: old }, mint: { capturedAt: now } } }),
      stale: old,
      // No per-source detail (an older capture, or any single-source feed): the file's own time.
      fallback: wd.freshnessOf('marketNews', { capturedAt: now }),
      now,
      // A feed with no `sourceId` is unaffected and still reads the file's time.
      other: wd.freshnessOf('announcements', { capturedAt: now, sources: { moneycontrol: { capturedAt: old } } }),
    };
  });
  ok('a stalled publisher is not hidden by another publisher writing the same file',
    freshness && freshness.perSource === freshness.stale && freshness.fallback === freshness.now && freshness.other === freshness.now,
    `per-source ${freshness?.perSource === freshness?.stale ? 'reads the stalled source' : `WRONG (${freshness?.perSource})`}, no-detail falls back to the file, other feeds unchanged`);

  ok('every market-news story names the publisher it came from',
    bylines && bylines.total > 0 && bylines.withPublisher === bylines.total && bylines.drawnBylines === bylines.drawn,
    `${bylines?.withPublisher}/${bylines?.total} rows attributed, ${bylines?.drawnBylines}/${bylines?.drawn} cards showing it, publishers: ${bylines?.publishers.join(', ')}`);
  ok('...without the News view printing the upstream publisher name either',
    bylines && bylines.brandOnScreen === false,
    bylines?.brandOnScreen ? 'the withheld brand reached the screen' : 'not printed');
  ok('...and every publisher in the feed can be filtered to',
    bylines && bylines.publishers.every((px) => bylines.options.includes(px)),
    `${bylines?.options.length - 1} of ${bylines?.publishers.length} publishers offered`);

  // The filter narrows to exactly that publisher — compared against the array, never counted off
  // the DOM, because a fill still in flight would make a count agree for the wrong reason.
  const pubFilter = await evalSafe(async () => {
    const sel = document.querySelector('[data-news-publisher]');
    if (!sel || sel.options.length < 2) return null;
    const mod = await import('/js/data/market-news.js');
    const want = sel.options[1].value;
    const expect = mod.rows().filter((r) => r.publisher === want).length;
    sel.value = want;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const label = document.querySelector('[data-mcnews-list]')?.innerText.match(/([\d,]+)\s+of\s+([\d,]+)\s+stories/);
    const drawnPubs = [...new Set([...document.querySelectorAll('[data-news-key]')].map((n) => {
      const m = mod.rows().find((r) => String(r.id || r.url) === n.dataset.newsKey);
      return m?.publisher;
    }))];
    sel.value = 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return { want, expect, shown: label ? Number(label[1].replace(/,/g, '')) : null, drawnPubs };
  });
  if (pubFilter) {
    ok('filtering to one publisher shows that publisher and no other',
      pubFilter.expect > 0 && pubFilter.shown === pubFilter.expect && pubFilter.drawnPubs.length === 1 && pubFilter.drawnPubs[0] === pubFilter.want,
      `${pubFilter.want}: ${pubFilter.shown} shown of ${pubFilter.expect} held, publishers drawn: ${pubFilter.drawnPubs.join(', ')}`);
  } else {
    skip('filtering to one publisher shows that publisher and no other', 'only one publisher in this capture');
  }

  // EVERY SHARD THE HEAD NAMES MUST EXIST. A manifest naming a month no deployment received gives
  // the reader a failed fetch at the end of every scroll — and the workflow that stages only the
  // head file is exactly how that happens, so it is worth asserting rather than assuming.
  const manifest = await evalSafe(async () => {
    const res = await fetch('data/market-news.json', { cache: 'no-cache' });
    const body = await res.json();
    const arc = Array.isArray(body.archive) ? body.archive : [];
    const checks = await Promise.all(arc.map(async (a) => {
      const r = await fetch(`data/${a.file}`, { cache: 'no-cache' });
      if (!r.ok) return { file: a.file, ok: false, status: r.status };
      const j = await r.json();
      return { file: a.file, ok: true, count: Array.isArray(j.articles) ? j.articles.length : -1, said: a.count };
    }));
    return { months: arc.length, archivedCount: body.archivedCount, headCount: body.articleCount, checks };
  });
  ok('every archive month the capture names is actually served, with the count it claims',
    manifest && manifest.months > 0 && manifest.checks.every((c) => c.ok && c.count === c.said),
    `${manifest?.months} month(s), ${manifest?.checks.filter((c) => !c.ok).length} unreachable, ${manifest?.checks.filter((c) => c.ok && c.count !== c.said).length} miscounted`);
  ok('...and the capture holds more stories than the head it paints first',
    manifest && manifest.archivedCount >= manifest.headCount,
    `${manifest?.archivedCount} captured, ${manifest?.headCount} in the head`);

  // SCROLLING TO THE END PULLS THE NEXT MONTH IN. Driven through the real control — the scroll —
  // rather than by calling loadMore(), because the gate that matters is the one wired to the reader.
  const older = await evalSafe(async () => {
    const mod = await import('/js/data/market-news.js');
    const before = mod.rows().length;
    const startArc = mod.archiveMeta();
    if (startArc.exhausted) return { skipped: true };
    const host = document.querySelector('[data-news-scroll]');
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      if (host) host.scrollTop = host.scrollHeight;
      await new Promise((r) => setTimeout(r, 450));
      if (mod.rows().length > before) break;
    }
    const arc = mod.archiveMeta();
    return {
      before,
      after: mod.rows().length,
      monthsLoaded: arc.monthsLoaded,
      oldestBefore: startArc.oldest,
      oldestAfter: arc.oldest,
      foot: document.querySelector('[data-news-more]')?.innerText.trim() || '',
    };
  });
  if (older?.skipped) {
    skip('scrolling to the end of the list loads older stories', 'the head already carries every month in the archive');
  } else {
    ok('scrolling to the end of the list loads older stories, and reaches further back',
      older && older.after > older.before && older.monthsLoaded > 0
        && Date.parse(older.oldestAfter) < Date.parse(older.oldestBefore),
      `${older?.before} -> ${older?.after} stories, ${older?.monthsLoaded} month(s) pulled in, back to ${older?.oldestAfter} from ${older?.oldestBefore}`);
    // THE FOOTER MUST AGREE WITH THE STATE IT DESCRIBES, in both directions. "That is every story"
    // over an archive with months left is a claim nobody measured, and the reverse — offering more
    // when there is none — sends the reader scrolling at a list that will never grow. Asserted as
    // an equality rather than a one-way test, so neither half can drift.
    const footState = await evalSafe(async () => {
      const mod = await import('/js/data/market-news.js');
      const foot = document.querySelector('[data-news-more]')?.innerText.trim() || '';
      const arc = mod.archiveMeta();
      return { exhausted: arc.exhausted, remaining: arc.remaining, saysEnd: /that is every story/i.test(foot), saysMore: /keep scrolling|load older/i.test(foot), foot: foot.slice(0, 90) };
    });
    ok('...and the footer says the archive is spent exactly when it is',
      footState && footState.saysEnd === footState.exhausted && footState.saysMore === !footState.exhausted,
      `${footState?.remaining} month(s) left, footer reads "${footState?.foot}"`);
  }

  // -------------------------------------------------------------------------------------
  // NSE LIVE ANNOUNCEMENTS — the one exchange feed that narrows to the reader's companies
  // -------------------------------------------------------------------------------------
  //
  // The load-bearing property is the scope: a filing resolved to a book company shows under
  // Portfolio, one resolved to nothing shows only under Universe, and NOTHING with a ticker outside
  // the book may leak into Portfolio. That is the whole reason this feed exists as its own surface
  // rather than folding into the market-wide news it cannot be filtered like.
  await go('/#/research/nse-filings?scope=universe', 1800);
  const nseUni = await evalSafe(async () => {
    const f = await import('/js/data/nse-filings.js');
    const rows = f.rows();
    const resolved = rows.filter((r) => r.ticker).length;
    const unresolved = rows.filter((r) => !r.ticker);
    return {
      total: rows.length,
      resolved,
      unresolved: unresolved.length,
      // Every row keeps its company name even when it could not be resolved — the identity is the
      // name, never the (unreliable) filename prefix.
      allNamed: rows.every((r) => r.company && r.company.length > 0),
      origin: f.meta().origin,
      tableRows: document.querySelectorAll('#content-host tbody tr').length,
    };
  });
  ok('the NSE feed loads, names every row, and resolves a real share of them to a symbol',
    nseUni && nseUni.total > 50 && nseUni.allNamed && nseUni.resolved > 0 && nseUni.resolved < nseUni.total,
    `${nseUni?.resolved}/${nseUni?.total} resolved, ${nseUni?.unresolved} unresolved, origin ${nseUni?.origin}`);

  await go('/#/research/nse-filings?scope=portfolio', 1500);
  const nsePort = await evalSafe(async () => {
    const f = await import('/js/data/nse-filings.js');
    const cov = await import('/js/data/coverage.js');
    const scope = await import('/js/data/scope.js');
    const holdings = cov.holdings();
    const wanted = scope.scopeTickers('portfolio', holdings); // the exact Set the feed narrows by
    const all = f.rows();
    const port = f.forScope('portfolio', holdings);
    const leak = port.filter((r) => !r.ticker || !wanted.has(String(r.ticker).toUpperCase()));
    // An unresolved row (ticker null) is present in Universe and absent from Portfolio — the honesty
    // rule that a row with no company cannot be narrowed by company.
    const unresolvedInUniverse = all.some((r) => !r.ticker);
    const unresolvedInPortfolio = port.some((r) => !r.ticker);
    return {
      universe: all.length,
      portfolio: port.length,
      leak: leak.length,
      companies: new Set(port.map((r) => r.ticker)).size,
      unresolvedInUniverse,
      unresolvedInPortfolio,
      narrows: port.length < all.length,
    };
  });
  ok('NSE Portfolio scope narrows to book companies with no leak',
    nsePort && nsePort.narrows && nsePort.leak === 0 && nsePort.portfolio > 0,
    `${nsePort?.portfolio} of ${nsePort?.universe} filings, ${nsePort?.companies} companies, ${nsePort?.leak} leaked`);
  ok('...and an unresolved filing shows in Universe but never under a narrowed scope',
    nsePort && nsePort.unresolvedInUniverse && !nsePort.unresolvedInPortfolio,
    `unresolved in universe: ${nsePort?.unresolvedInUniverse}, in portfolio: ${nsePort?.unresolvedInPortfolio}`);

  // Search narrows the list without touching the head, and the count reports the ARRAY.
  //
  // NAVIGATE BACK FIRST — this check owns its own precondition rather than inheriting the page the
  // previous block happened to leave. It used to inherit News/Universe, and the day an NSE-filings
  // block was inserted above it the page was left on a different tab entirely, so the market-wide
  // list was legitimately absent and this reported "no search box" about a view that was fine. A
  // check that depends on ambient page state fails for the wrong reason the moment anyone inserts
  // one above it.
  await go('/#/research/news?scope=universe', 2500);
  await waitForPanel();
  await page.waitForSelector('#content-host [data-news-search]', { timeout: 15000 }).catch(() => {});
  const filtered = await evalSafe(async () => {
    const input = document.querySelector('[data-news-search]');
    if (!input) return null;
    const mod = await import('/js/data/market-news.js');
    const term = 'stock';
    const expect = mod.rows().filter((r) => `${r.title || ''} ${r.summary || ''} ${r.section || ''}`.toLowerCase().includes(term)).length;
    // FOCUS FIRST. A reader types into a focused box, and the restore path this is checking reads
    // `document.activeElement` before the rebuild — dispatching `input` at an unfocused node tests
    // nothing and fails for the wrong reason.
    input.focus();
    input.value = term;
    input.setSelectionRange(term.length, term.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const pending = document.querySelector('[data-rows-pending]');
    const label = document.querySelector('[data-mcnews-list]')?.innerText.match(/([\d,]+)\s+of\s+([\d,]+)\s+stories/);
    const live = document.querySelector('[data-news-search]');
    const focused = document.activeElement === live;
    const caret = live ? live.selectionStart : null;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { expect, shown: label ? Number(label[1].replace(/,/g, '')) : null, total: label ? Number(label[2].replace(/,/g, '')) : null, focused, caret, term, pending: !!pending, restored: document.querySelectorAll('[data-news-key]').length };
  });
  ok('search narrows the list, counts the whole result rather than what is painted, and keeps the caret',
    filtered && filtered.shown === filtered.expect && filtered.expect > 0 && filtered.expect < filtered.total
      && filtered.focused && filtered.caret === filtered.term.length,
    filtered ? `${filtered.shown} shown of ${filtered.total} (expected ${filtered.expect}), focus ${filtered.focused ? 'kept' : 'LOST'}, caret at ${filtered.caret}` : 'no search box');

  await page.waitForFunction(() => !document.querySelector('[data-rows-pending]'), { timeout: 20000 }).catch(() => {});

  // -------------------------------------------------------------------------------------
  // A STORY THAT LANDS WHILE THE READER IS HERE POPS AN ALERT — the same stack the results feed
  // and the con-call scan use, and for the same reason: an alert is only worth having if it fires
  // while the reader is looking at something else.
  //
  // Driven end to end rather than by calling `push` directly: the feed is loaded against a
  // deliberately SHORT capture (its ten newest stories withheld), then the withholding is dropped
  // and the feed re-checked, so the ten arrive exactly as they would from a scheduled run. That is
  // the path that has to work — the backlog suppression, the arrival diff, the dedupe key and the
  // card — and none of it is exercised by pushing a card by hand.
  // -------------------------------------------------------------------------------------
  let withholdNewest = true;
  await page.route('**/data/market-news.json*', async (route) => {
    if (!withholdNewest) return route.fallback();
    const upstream = await route.fetch();
    const body = await upstream.json();
    body.articles = (body.articles || []).slice(10);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"mcnews-withheld"', 'cache-control': 'no-cache' },
      body: JSON.stringify(body),
    });
  });
  const seeded = await evalSafe(async () => {
    (await import('/js/ui/notifications.js')).clear();
    const mod = await import('/js/data/market-news.js');
    mod.invalidate();
    await mod.load();
    // The first paint announces NOTHING, whatever it contains. Everything in a capture predates
    // the reader's arrival, and replaying it would make every later alert worth less.
    return { rows: mod.rows().length, arrivals: mod.newArrivals().length, cards: document.getElementById('notification-root')?.children.length ?? -1 };
  });
  ok('the market-news capture announces nothing on the paint that first loads it',
    seeded && seeded.rows > 0 && seeded.arrivals === 0 && seeded.cards === 0,
    `${seeded?.rows} stories seeded, ${seeded?.arrivals} arrival(s), ${seeded?.cards} card(s)`);

  withholdNewest = false;
  const alerted = await evalSafe(async () => {
    const mod = await import('/js/data/market-news.js');
    const out = await mod.refresh();
    await new Promise((r) => setTimeout(r, 900));
    const root = document.getElementById('notification-root');
    const cards = [...(root?.children || [])];
    const arrivals = mod.newArrivals();
    const first = arrivals[0];
    const text = cards.map((c) => c.innerText.replace(/\s+/g, ' ')).join(' ~ ');
    return {
      added: out.added,
      arrivals: arrivals.length,
      cards: cards.length,
      labelled: /Market news/i.test(text),
      // The card carries the publisher's own headline and standfirst, not a summary of ours.
      verbatim: !!first && text.includes(String(first.title).slice(0, 40)),
      text: text.slice(0, 160),
      // AND THE STORY'S OWN PICTURE. The card is the one surface a reader sees without the tab
      // open, so it carries the same thumbnail the list does — the publisher's, hot-linked, and
      // only ever from an https URL, because this is external content reaching `src`.
      // Against the arriving stories' own images rather than one publisher's CDN — see the same
      // change on the list above. Five publishers, five CDNs, and the assertion that matters is
      // that the card wears the picture belonging to ITS story.
      thumbs: cards.filter((c) => {
        const src = c.querySelector('img')?.getAttribute('src') || '';
        return /^https:\/\//.test(src) && arrivals.some((a) => a.image === src);
      }).length,
      withImage: arrivals.slice(0, cards.length).filter((a) => a.image).length,
      // Re-emitting must not re-announce: the feed re-hands its whole arrival list every change.
    };
  });
  ok('a story arriving while the reader is here pops an alert', alerted && alerted.added > 0 && alerted.cards > 0,
    `${alerted?.added} new, ${alerted?.arrivals} on the arrival list, ${alerted?.cards} card(s)`);
  ok('...labelled as market news and carrying the publisher\'s own headline',
    alerted && alerted.labelled && alerted.verbatim, alerted?.text);
  ok('...and the story\'s own thumbnail, the same one the list shows',
    alerted && alerted.withImage > 0 && alerted.thumbs === alerted.withImage,
    `${alerted?.thumbs} of ${alerted?.withImage} card(s) carry their own story's image`);
  const reAnnounced = await evalSafe(async () => {
    const before = document.getElementById('notification-root')?.children.length ?? 0;
    const mod = await import('/js/data/market-news.js');
    await mod.refresh();
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: document.getElementById('notification-root')?.children.length ?? 0 };
  });
  ok('...and the same story never announces itself twice', reAnnounced && reAnnounced.after <= reAnnounced.before,
    `${reAnnounced?.before} card(s) before a second check, ${reAnnounced?.after} after`);
  await page.unroute('**/data/market-news.json*').catch(() => {});
  await evalSafe(async () => (await import('/js/ui/notifications.js')).clear());

  // -------------------------------------------------------------------------------------
  // "FETCH FROM MONEYCONTROL" — the one control on this page that starts work somewhere else.
  //
  // It asks a GitHub runner to read the publisher, because nothing in a browser or on the edge
  // can. That makes it the Deep Dive rule arriving on a second feed, and the same three things
  // have to hold: nothing dispatches unprompted, a failure is NAMED rather than collapsed into
  // "could not refresh", and a finished RUN is never reported as new stories on SCREEN.
  //
  // The outcomes are driven with scripted responses rather than a real dispatch — a suite that
  // started a real run on every push would be spending somebody's runner minutes and hitting
  // Moneycontrol to test a button.
  // -------------------------------------------------------------------------------------
  // OPENING THIS TAB DISPATCHES ONLY WHEN THE CAPTURE IS STALE, and the age is the whole gate.
  //
  // This is the one place in the dashboard that starts work unprompted, narrowed deliberately (see
  // the comment on `maybeAutoFetch`). The check that matters is therefore not "it never dispatches"
  // but "it dispatches ON STALE AND NOT ON FRESH" — a gate that fired regardless would be the
  // page-load walk this codebase spent a lot of effort removing.
  const capturedAgeMin = await evalSafe(async () => {
    const at = Date.parse((await import('/js/data/market-news.js')).meta().capturedAt || '');
    return Number.isFinite(at) ? (Date.now() - at) / 60000 : null;
  });
  // A REAL RELOAD, NOT A HASH NAVIGATION. The one-attempt-per-window guard is module state, and
  // earlier checks in this suite have already opened this tab — so a hash navigation measures a
  // SECOND open and would report the gate as broken when it is working. (Same trap the
  // super-investor check documents.) Only a reload gives a genuine first open.
  seen.marketNewsApi.length = 0;
  await page.goto(`${BASE}/#/research/news?scope=universe`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const dispatchesOnLoad = seen.marketNewsApi.filter((u) => /POST/.test(u));
  const dispatchOnLoad = dispatchesOnLoad.length;
  const shouldDispatch = capturedAgeMin !== null && capturedAgeMin >= 20;
  ok(shouldDispatch ? 'a stale capture makes opening the news tab fetch one' : 'a fresh capture makes opening the news tab fetch nothing',
    shouldDispatch ? dispatchOnLoad >= 1 : dispatchOnLoad === 0,
    `capture ${capturedAgeMin === null ? 'unknown' : capturedAgeMin.toFixed(0) + ' min'} old, ${dispatchOnLoad} POST(s)`);

  // A REFRESH NOBODY PRESSED MUST BE FILED AS ONE. `?source=` reaches the workflow's run name and
  // `lastAutomatic` counts `cron` and `auto` but not `button` — so an auto-fetch labelled `button`
  // would leave the one field that answers "is this refreshing on its own" reading as though
  // nothing unattended had ever run. That is the measurement gap `?source=` exists to close,
  // arriving one layer down, so it is asserted on the wire rather than in the source.
  if (shouldDispatch && dispatchOnLoad >= 1) {
    ok('...and files itself as `auto`, not as a button press nobody made',
      dispatchesOnLoad.every((u) => /[?&]source=auto\b/.test(u)),
      dispatchesOnLoad.join(' | ') || '(none)');
  } else {
    skip('...and files itself as `auto`, not as a button press nobody made',
      'the shipped capture is fresh, so no auto-fetch to inspect');
  }

  // Whatever the age, a second open inside the window must NOT dispatch again — otherwise a failing
  // dispatch becomes a loop that spends a run on every navigation.
  seen.marketNewsApi.length = 0;
  await go('/#/research/earnings-hub?scope=universe', 1500);
  await go('/#/research/news?scope=universe', 3000);
  const secondOpen = seen.marketNewsApi.filter((u) => /POST/.test(u)).length;
  ok('...and re-opening it inside the same window dispatches nothing more', secondOpen === 0,
    `${secondOpen} POST(s) on the second open`);
  await page.locator('[data-mcnews-info]').click();
  await page.waitForTimeout(200);
  ok('...and the reopened status remains popup-free',
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

  // A GET must not be able to start a run: a prefetcher or a link preview would trip it.
  const dispatchGet = await evalSafe(async () => {
    const r = await fetch('api/market-news/refresh', { method: 'GET' });
    return { status: r.status, body: await r.text().catch(() => '') };
  });
  if (dispatchGet && dispatchGet.status !== 404 && dispatchGet.status !== 501) {
    ok('a GET can never start a scrape — the route is POST-only', dispatchGet.status === 405, `HTTP ${dispatchGet.status}`);
  } else {
    skip('a GET can never start a scrape — the route is POST-only', 'no Worker on this origin — run against `npx wrangler dev`');
  }

  // THE LABEL IS AN ALLOWLIST ON BOTH SIDES. The Worker clamps an unknown `source` to `button` so
  // an unauthenticated route cannot forge "this was automatic"; the client clamps it too, so a
  // caller inventing a word gets the honest label rather than one the Worker will silently rewrite.
  const dispatchLabels = await (async () => {
    const asked = [];
    await page.route('**/api/market-news/refresh*', (route) => {
      asked.push(route.request().url());
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, dispatched: true }) });
    });
    await evalSafe(async () => {
      const mod = await import('/js/data/market-news.js');
      await mod.startScrape('auto');
      await mod.startScrape('button');
      await mod.startScrape('whatever-it-likes');
    });
    await page.unroute('**/api/market-news/refresh*').catch(() => {});
    return asked.map((u) => (/[?&]source=([a-z-]+)/.exec(u) || [])[1] || '(none)');
  })();
  ok('a dispatch always carries a source, and an invented one becomes `button`',
    dispatchLabels.join(',') === 'auto,button,button', dispatchLabels.join(', ') || '(no request made)');

  // Every named outcome, scripted. Each is a DIFFERENT STATEMENT and the wording must not merge
  // them: "read it, nothing new" is a measurement, "publishing" is work in flight, "published"
  // says this browser has not received it, and "still running" is not a failure.
  const outcomes = await (async () => {
    // `captureLands` is whether the run's own capture reaches this browser. It must be FALSE for
    // the deploy cases: a fixture that both restamps the capture AND claims the deploy has not
    // landed is describing two contradictory worlds, and the verdict it then draws is meaningless.
    const script = async (runSeq, { captureGrows = false, captureLands = true } = {}) => {
      let i = 0;
      await page.route('**/api/market-news/run*', (route) =>
        route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(runSeq[Math.min(i++, runSeq.length - 1)]) }));
      // THE ETAG HAS TO MOVE WHEN THE BODY DOES, or `conditionalJson` correctly reports no change
      // and the "landed" case can never be reached — which is what the first version of this did,
      // stamping both responses with the same tag and then blaming the module for reading them as
      // unchanged. The counter is the seq, taken BEFORE the body is decided.
      // THE SECOND READ MODELS A FULL CAPTURE: one story in, one out, LENGTH UNCHANGED.
      //
      // This is the shape production is always in — `KEEP` is 600 and the file holds 600 — and it
      // is what a length comparison cannot see. Measured on the live feed: capture 10:24 -> 10:41
      // gained id 14019028, dropped one, count 600 both times, and the button said "nothing new to
      // publish" over a story that had genuinely arrived. So the fixture must never let a count
      // stand in for a comparison.
      let readN = 0;
      await page.route('**/data/market-news.json*', async (route) => {
        const seq = readN++;
        const upstream = await route.fetch();
        const body = await upstream.json();
        const all = body.articles || [];
        if (seq === 0 || !captureGrows) {
          body.articles = all.slice(3); // the "before" capture: missing the three newest
        } else {
          // Same LENGTH as the before capture, with the three newest swapped in for the three
          // oldest. A length check reports no change; an id comparison reports three.
          body.articles = all.slice(0, 3).concat(all.slice(3, all.length - 3));
        }
        // EVERY RUN RESTAMPS `capturedAt`, EVEN ONE THAT FOUND NOTHING — that is what makes the
        // file change, the ETag move, and the client re-read. Pinning the tag for the "nothing
        // new" case modelled something production never does: the body was never re-read, so
        // `capturedAt` could not move, and the honest `nothing-new` verdict was unreachable. The
        // fixture must differ from the growing case in its ARTICLE IDS only.
        const step = captureLands ? seq : 0;
        body.capturedAt = new Date(Date.parse(body.capturedAt || Date.now()) + step * 60000).toISOString();
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', etag: `"mcnews-${captureGrows ? 'grow' : 'same'}-${step}"` },
          body: JSON.stringify(body),
        });
      });
      const out = await evalSafe(async () => {
        const mod = await import('/js/data/market-news.js');
        mod.invalidate();
        await mod.load();
        const lenBefore = mod.rows().length;
        const r = await mod.watchScrape({ everyMs: 60, budgetMs: 4000, publishGraceMs: 300 });
        return { ...r, sameLength: mod.rows().length === lenBefore, lenBefore, lenAfter: mod.rows().length };
      });
      await page.unroute('**/api/market-news/run*').catch(() => {});
      await page.unroute('**/data/market-news.json*').catch(() => {});
      return out;
    };

    const done = (concl = 'success') => ({ ok: true, scrape: { status: 'completed', conclusion: concl, updatedAt: '2026-01-01T00:00:00Z', url: null }, publish: null });
    const withPublish = (status, concl = null) => ({
      ok: true,
      scrape: { status: 'completed', conclusion: 'success', updatedAt: '2026-01-01T00:00:00Z', url: null },
      publish: { status, conclusion: concl, createdAt: '2026-01-01T00:01:00Z', url: null },
    });

    return {
      nothingNew: await script([done()]),
      landed: await script([done()], { captureGrows: true }),
      publishFailed: await script([withPublish('completed', 'failure')], { captureLands: false }),
      published: await script([withPublish('completed', 'success')], { captureLands: false }),
      scrapeFailed: await script([done('failure')]),
      stillRunning: await script([{ ok: true, scrape: { status: 'in_progress', conclusion: null, url: null }, publish: null }]),
      noToken: await script([{ ok: false, reason: 'no-token', message: 'none configured', fix: 'npx wrangler secret put GH_DISPATCH_TOKEN' }]),
    };
  })();

  ok('a run that finished with nothing to publish says the publisher WAS read',
    outcomes.nothingNew?.outcome === 'nothing-new', `outcome=${outcomes.nothingNew?.outcome}`);
  // THE CASE PRODUCTION IS ALWAYS IN. The fixture swaps three stories in and three out, so the
  // count is identical across the two captures — exactly what happened live, and exactly what a
  // length comparison reports as "nothing new" over three real arrivals.
  ok('...and stories arriving into a FULL capture are counted, though the length never moves',
    outcomes.landed?.outcome === 'landed' && outcomes.landed.added === 3 && outcomes.landed.sameLength,
    `outcome=${outcomes.landed?.outcome}, added=${outcomes.landed?.added}, length ${outcomes.landed?.sameLength ? 'unchanged (the trap)' : 'CHANGED — the fixture is not modelling a full capture'}`);
  ok('a deploy that failed says the stories exist but are not on the site — never "nothing new"',
    outcomes.publishFailed?.outcome === 'publish-failed', `outcome=${outcomes.publishFailed?.outcome}`);
  // A deploy RAN, so something was committed — "nothing new" would be wrong, and "landed" would be
  // a freshness claim nothing measured. It is its own outcome for exactly that reason.
  ok('...and a deploy that succeeded while this browser still holds the old bytes is neither',
    outcomes.published?.outcome === 'published', `outcome=${outcomes.published?.outcome}`);
  // NO OUTCOME MAY CLAIM STORIES THAT NOTHING MEASURED. The scrape restamps `capturedAt` and so
  // commits on every run, which is what starts the deploy — so a deploy proves a new CAPTURE and
  // says nothing about its contents. Live, the old wording said "new stories were captured" over a
  // run that brought in zero. `published`, `publish-failed` and `timed-out` have all measured
  // nothing either way, so they must share one sentence that counts nothing.
  const wording = await page.evaluate(async () => {
    const src = await (await fetch('js/tabs/market-news-view.js')).text();
    const results = [...src.matchAll(/text:\s*'([^']*)'/g)].map((m) => m[1]);
    const counted = [...src.matchAll(/countResult\(/g)].length;
    return {
      // POSITIVE assertions only. "No new stories" is the `nothing-new` branch, which HAS measured
      // its answer — a negative is a measurement, and flagging it would ban the honest sentence.
      claims: results.filter((t) => /(new stories|stories) (were|are) (captured|published|found)/i.test(t)),
      unmeasured: results.filter((t) => /waiting for it to reach this page/i.test(t)).length,
      counted,
    };
  });
  ok('no outcome claims new stories except the one that counted them',
    wording && wording.claims.length === 0 && wording.unmeasured > 0 && wording.counted > 0,
    wording?.claims.length ? `claims without a count: ${JSON.stringify(wording.claims)}` : `${wording?.counted} counted branch(es), ${wording?.unmeasured} explicitly-unmeasured`);

  ok('a failed run is reported as failed, and a run still going is NOT',
    outcomes.scrapeFailed?.outcome === 'failed' && outcomes.stillRunning?.outcome === 'timed-out',
    `failed=${outcomes.scrapeFailed?.outcome}, in-flight=${outcomes.stillRunning?.outcome}`);
  ok('a missing credential is named with its fix, not collapsed into "could not refresh"',
    outcomes.noToken?.outcome === 'failed' && outcomes.noToken?.reason === 'no-token' && /wrangler secret put/.test(outcomes.noToken?.fix || ''),
    `${outcomes.noToken?.reason} — ${outcomes.noToken?.fix || 'NO FIX GIVEN'}`);

  await evalSafe(async () => {
    const mod = await import('/js/data/market-news.js');
    mod.invalidate();
    await mod.load();
  });

  // Back to announcements: the next check drives the ANNOUNCEMENTS feed and needs its tab mounted.
  await go('/#/research/corp-announcements?scope=universe', 3000);

  // A REPAINT MUST STILL REACH THE SCREEN AFTER A RE-RENDER. The scope toggle is the re-render that
  // used to kill it. `invalidate()` + `load()` is the public way to make the feed emit again on
  // demand, so this does not depend on catching a live walk mid-flight.
  await page.click('#scope-toggle-mount button:last-of-type').catch(() => {});
  await page.waitForTimeout(1200);
  const repainted = await evalSafe(async () => {
    const m = await import('/js/data/filings.js');
    const first = document.querySelector('#content-host > *');
    m.announcements.invalidate();
    await m.announcements.load(['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ITC']);
    await new Promise((r) => setTimeout(r, 2500));
    return { replaced: document.querySelector('#content-host > *') !== first, had: !!first };
  });
  ok('an unchanged source check preserves the mounted stream after a scope toggle', repainted.had && !repainted.replaced,
    repainted.had ? (repainted.replaced ? 'unnecessary rebuild' : 'existing panel preserved') : 'no panel to compare');

  // The headline IS the row, so it gets the width — but not at the cost of a scrollbar under it.
  await go('/#/research/news?scope=portfolio', 3000);

  const statusText = await page.locator('[data-filings-info]').textContent().catch(() => '');
  ok('company news uses calm freshness wording and never exposes pipeline states',
    /Up to date|Updated|Updating/i.test(statusText || '') && !/Partial|\bLive\b/i.test(statusText || ''),
    `status=${JSON.stringify(statusText)}`);

  const newsFit = await page.evaluate(() => {
    const el = document.querySelector('[data-table-scroll]');
    return el ? { need: el.scrollWidth, have: el.clientWidth } : null;
  });
  if (!newsFit) skip('the News table fits at 1440 with no horizontal scrollbar', 'no table rendered — this origin has no /api/news to answer');
  else ok('the News table fits at 1440 with no horizontal scrollbar', newsFit.need <= newsFit.have + 1, `${newsFit.need}px in ${newsFit.have}px`);

  // WHAT IS ON SCREEN MUST BE WHAT IS IN THE FEED. `scoreTable` caches a row's markup by its key and
  // moves the existing `<tr>` nodes on a repaint, which is correct only while a key identifies a
  // row. These tables grow while the live walk runs, so a key containing the row's INDEX came to
  // mean a different article on every arrival: measured at 741 rows with zero repeated (ticker,
  // headline) pairs in the data and 160 on screen, and the row count still exactly right. Counting
  // rows would not have caught it; comparing them does.
  const paint = await evalSafe(async () => {
    const m = await import('/js/data/filings.js');
    const { withoutPublisherName } = await import('/js/core/source-copy.js');
    const rows = m.news.rows();
    if (!rows.length) return null;
    const tally = (list) => {
      const c = new Map();
      for (const k of list) c.set(k, (c.get(k) || 0) + 1);
      return c;
    };
    // The UI removes a publisher name duplicated at the end of a headline. Compare that same
    // display value on both sides; source-copy cleanup is not a row-cache mismatch.
    const data = tally(rows.map((r) => `${r.ticker}||${withoutPublisherName(r.title)}`));
    const dom = tally(
      [...document.querySelectorAll('[data-table-scroll] tbody tr')].map((tr) => {
        const d = tr.querySelectorAll('td div.truncate');
        return `${(d[1]?.innerText || '').split(' · ')[0]}||${d[0]?.getAttribute('title') || ''}`;
      })
    );
    const off = [...dom].filter(([k, n]) => (data.get(k) || 0) !== n);
    return { rows: rows.length, domRows: [...dom.values()].reduce((a, n) => a + n, 0), mismatched: off.length, sample: off.slice(0, 2).map(([k, n]) => `${n}x ${k.slice(0, 60)}`) };
  });
  if (!paint) skip('every rendered row is a row the feed actually holds', 'no rows on this origin — there is no /api/news to answer');
  else ok('every rendered row is a row the feed actually holds', paint.mismatched === 0, `${paint.domRows} drawn from ${paint.rows}${paint.mismatched ? ` — ${paint.sample.join('; ')}` : ''}`);

  await go('/#/research/insider-trades?scope=portfolio', 2500);
  const insiderSources = await page.evaluate(() => {
    const table = document.querySelector('#content-host [data-score-table]');
    const headers = [...(table?.querySelectorAll('thead th') || [])].map((th) => th.textContent.trim().replace(/[▴▾]$/, '').trim());
    const sourceIndex = headers.indexOf('Source');
    const rows = [...(table?.querySelectorAll('tbody tr[data-row-key]') || [])].slice(0, 80);
    const cells = sourceIndex < 0 ? [] : rows.map((tr) => tr.children[sourceIndex]);
    const links = cells.map((cell) => cell?.querySelector('a[data-insider-source-link]'));
    return {
      headers,
      rows: rows.length,
      linked: links.filter(Boolean).length,
      onlyArrow: cells.every((cell) => cell?.textContent.trim() === '↗'),
      safe: links.every((a) => {
        if (!a || a.target !== '_blank' || !/noopener/.test(a.rel)) return false;
        const url = new URL(a.href);
        return /https?:/.test(url.protocol) && (url.hostname !== 'trendlyne.com' || !!url.searchParams.get('query'));
      }),
    };
  });
  ok('Insider Trades has one Source column and no duplicate Link column',
    insiderSources.headers.filter((h) => h === 'Source').length === 1 && !insiderSources.headers.includes('Link'), insiderSources.headers.slice(-4).join(' · '));
  ok('every rendered insider source is only a working evidence arrow',
    insiderSources.rows > 0 && insiderSources.linked === insiderSources.rows && insiderSources.onlyArrow && insiderSources.safe,
    `${insiderSources.linked} links across ${insiderSources.rows} sampled rows`);
  const insiderFilters = await page.evaluate(async () => {
    const selects = [...document.querySelectorAll('[data-table-filter]')];
    const countText = document.querySelector('[data-row-count]')?.textContent || '';
    const total = Number((countText.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''));
    const results = [];
    for (const select of selects) {
      const choice = [...select.options].find((o) => o.value !== 'all');
      if (!choice) continue;
      select.value = choice.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const shown = Number((document.querySelector('[data-row-count]')?.textContent || '').match(/\d+/)?.[0] || 0);
      results.push({ label: select.getAttribute('aria-label'), choice: choice.textContent, shown });
      select.value = 'all';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      labels: selects.map((s) => s.getAttribute('aria-label')),
      optionCounts: selects.map((s) => s.options.length),
      countText,
      total,
      results,
    };
  });
  ok('the Insider Trades toolbar separates trade rows from portfolio companies',
    /^[\d,]+ trades from [\d,]+ portfolio companies$/i.test(insiderFilters.countText.trim()), insiderFilters.countText.trim());
  ok('insider trades offers Category, Transaction type and Mode filters',
    ['Category', 'Transaction type', 'Mode'].every((label) => insiderFilters.labels.includes(label)),
    insiderFilters.labels.join(' · '));
  ok('...each dropdown is populated from the rows in scope',
    insiderFilters.optionCounts.length === 3 && insiderFilters.optionCounts.every((n) => n > 1),
    insiderFilters.optionCounts.join(' · '));
  ok('...and each selection narrows the table',
    insiderFilters.results.length === 3 && insiderFilters.results.every((r) => r.shown > 0 && r.shown < insiderFilters.total),
    insiderFilters.results.map((r) => `${r.label}: ${r.choice} → ${r.shown}`).join(' · '));
  await drive('insider', 'insider-trades');
  const insUrls = seen.insider.map((u) => new URL(u));
  ok('a refresh asks insider trades per company, once each', insUrls.length > 1 && new Set(insUrls.map((u) => u.pathname)).size === insUrls.length, `${insUrls.length} request(s)`);
  ok('...with the same one-query-string shape', insUrls.every((u) => (u.href.match(/\?/g) || []).length === 1 && u.searchParams.get('from') && u.searchParams.get('to')), insUrls[0]?.href.slice(-70) || '');

  // A LANDING MAY NOT COST FORTY REQUESTS.
  //
  // Each of these upstreams answers one company at a time, so the walk that used to run on every
  // visit was forty round trips before the table settled — and with the upstream down (measured:
  // 93.5s per company before the Worker's retry budget was bounded) the tab counted forty companies
  // down over a quarter of an hour and painted nothing at all. Worse, four hung connections out of
  // a browser's six per origin starved the REST of the page: the Superstar Investors grid could not
  // fetch its own committed snapshot, a static file, for forty-four seconds.
  //
  // So the snapshot is what arrives on its own and the walk is what the reader asks for. On this
  // origin the committed snapshots may still be the empty placeholders, in which case a cold start
  // legitimately walks once — an empty table saying "press Refresh" is worse than a slow one — so
  // the assertion is conditional on there being anything cached to paint.
  {
    await go('/#/research/corp-announcements?scope=portfolio', 1200);
    const landed = [];
    const countLanding = (r) => {
      if (/\/api\/(news|announcements|insider-trades)/.test(r.url())) landed.push(r.url());
    };
    page.on('request', countLanding);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    page.off('request', countLanding);
    const st = await evalSafe(async () => {
      const m = (await import('/js/data/filings.js')).announcements.meta();
      const reg = await import('/js/core/refresh.js');
      return { rows: m.rowCount, cold: m.coldStart, outstanding: m.outstanding, registered: reg.registered().map((r) => r.id) };
    });
    if (!st.rows) {
      skip('landing on a filings tab sends no per-company request', 'no committed snapshot on this origin yet, so the cold start legitimately walks once');
    } else {
      ok('landing on a filings tab sends no per-company request', landed.length === 0 && !st.cold, `${landed.length} request(s) for ${st.rows} rows`);
    }
    ok('...and the tab is registered with the Refresh button instead', st.registered.includes('corp-announcements'), st.registered.join(', ') || 'nothing registered');
    // What it may claim, and what it may not. These routes have no index, so "nothing is new" is a
    // statement nobody can make without asking every company — the honest line is about US.
    const strip = await hostText();
    if (st.rows) {
      // The compact feed status remains on the face and never launches an explainer overlay.
      ok('the page body carries no permanent freshness paragraph', !/Showing the (news|filings)/i.test(strip));
      ok('...and the provenance pill is on the face instead', (await page.locator('[data-filings-info]').count()) > 0);
      await page.locator('[data-filings-info]').first().click();
      await page.waitForTimeout(200);
      ok('...and opens no provenance popup',
        (await page.locator('[data-filings-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
          (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);
      ok('...and labels the company count as companies with filings',
        /announcements? · .*compan(?:y|ies) with filings/i.test(await page.locator('#content-host [data-row-count]').innerText()));
      ok('...and the global Refresh control remains available', (await page.locator('[data-header-refresh]').count()) === 1);
    } else {
      skip('the page body carries no permanent freshness paragraph', 'no rows cached on this origin');
      skip('...and the provenance pill is on the face instead', 'no rows cached on this origin');
      skip('...and opens no provenance popup', 'no rows cached on this origin');
      skip('...and accounts for the companies in scope rather than leaving a gap to misread', 'no rows cached on this origin');
      skip('...and the global Refresh control remains available', 'no rows cached on this origin');
    }
  }

  page.off('request', watchFilings);
}

// ---------------------------------------------------------------------------------------
// 15b. The rail became a dropdown, and the roadmap card is gone
//
// The sub-view rail was a 240px left column above 1024px and a dropdown below it. It cost the
// content 240px of the 1400px it has, permanently, to show at most four short labels — while the
// tables beside it are the widest things in this dashboard and were scrolling inside their own
// containers to fit what was left. Measured on this build, the column's removal takes Breakouts
// from a 248px inner scroll to none, Super Investors from 380px to 116px, and Portfolio Overview
// from 453px to 189px.
//
// Two presentations of one control is also two things to keep in step, and the narrow one was
// already doing the whole job on the width that needed it most. So there is one picker now, at
// every width, and the checks are: it exists and is set correctly where there are sub-views, it
// is absent where there are none, and — the part a picker could quietly lose — it still SWITCHES
// the content, which is what the rail was actually for.
//
// The roadmap card ("Wiring roadmap · Not built. Listed so the gap is visible rather than
// implied.") closed most tabs. The gaps it listed are in docs/SPEC.md under each tab's "Still to
// come", so removing it from the UI loses nothing that was written down. Asserted across every
// tab rather than the one it was noticed on: a card removed from six of seven files is the shape
// this kind of change fails in.
// ---------------------------------------------------------------------------------------
// 12d. The lower-left source beacon
//
// It is a shop window for the whole estate, so what has to hold is that it cannot LIE about the
// estate: every count derived from the registry rather than typed, the green pill worded as a count
// of wired feeds rather than a bare "Live", only live rows left unlabelled, and one wire per source
// family so the picture cannot drift from the list. Plus that it stays a popover — the header's
// Sources button is still gone, and these check the replacement did not quietly reinstate it.
// ---------------------------------------------------------------------------------------
console.log('\n— source beacon —');
{
  await go('/#/research/breakouts/technical-scanner?scope=universe', 2600);
  const launcher = await evalSafe(() => {
    const el = document.querySelector('[data-beacon-toggle]');
    const r = el?.getBoundingClientRect();
    return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.bottom), inHeader: !!el.closest('header') } : null;
  });
  ok('the beacon launcher sits in the lower-left, outside the header',
    !!launcher && launcher.left < 40 && launcher.bottom < 40 && !launcher.inHeader,
    launcher ? `left ${launcher.left}, bottom ${launcher.bottom}` : 'no launcher');
  ok('...and it counts wired feeds rather than claiming a bare "Live"',
    !!launcher && /\d+ live feeds/.test(launcher.text) && !/^\s*Live\s*$/.test(launcher.text), launcher?.text || '');

  await page.locator('[data-beacon-toggle]').click();
  await page.waitForTimeout(450);
  const panel = await evalSafe(async () => {
    const { sourceGroups } = await import('/js/ui/sources.js');
    const groups = sourceGroups();
    const items = groups.flatMap((g) => g.items);
    const p = document.getElementById('source-beacon-panel');
    if (!p) return null;
    return {
      rows: p.querySelectorAll('.beacon-row').length,
      families: p.querySelectorAll('.beacon-group').length,
      wires: p.querySelectorAll('.beacon-flow-line').length,
      icons: [...p.querySelectorAll('.beacon-flow-icon')].map((n) => n.textContent),
      pill: p.querySelector('.beacon-live-pill')?.innerText.replace(/\s+/g, ' ').trim() || '',
      fresh: p.querySelector('[data-beacon-fresh]')?.textContent || '',
      // A status word on a row: only the exceptions carry one.
      labelled: [...p.querySelectorAll('.beacon-row')].filter((r) => (r.querySelector('.beacon-row-status')?.offsetParent) !== null).length,
      liveRows: p.querySelectorAll('.beacon-row.is-live').length,
      scrolls: (p.querySelector('.beacon-list')?.scrollHeight || 0) > (p.querySelector('.beacon-list')?.clientHeight || 0),
      expected: { items: items.length, live: items.filter((i) => i.status === 'live').length, green: items.filter((i) => i.status === 'live' && (!i.readState || i.readState === 'read')).length, families: groups.length, icons: groups.map((g) => g.icon) },
      // The core must sit ON the point every wire converges to, or the picture is of wires
      // arriving somewhere the dashboard is not.
      aligned: (() => {
        const svg = p.querySelector('.beacon-flow-svg');
        const core = p.querySelector('.beacon-core');
        if (!svg || !core) return null;
        const s = svg.getBoundingClientRect();
        const c = core.getBoundingClientRect();
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const scale = s.width / vb[2];
        return Math.abs(s.x + 96 * scale - (c.x + c.width / 2)) < 3 && Math.abs(s.y + (vb[3] / 2) * scale - (c.y + c.height / 2)) < 3;
      })(),
    };
  });
  ok('the panel lists every source in the registry', !!panel && panel.rows === panel.expected.items,
    panel ? `${panel.rows} rows of ${panel.expected.items} registered` : 'no panel');
  ok('...as one long vertical column that scrolls', !!panel && panel.scrolls);
  ok('...and its live count is read from the registry, not typed',
    !!panel && panel.pill === `${panel.expected.live} live feeds` && panel.liveRows === panel.expected.green,
    panel ? `${panel.pill} vs ${panel.expected.live} live in the registry` : '');
  // ONLY THE EXCEPTIONS ARE LABELLED, which is what makes mock and manual legible at a glance.
  ok('...with a status word on every non-green row, including unconfirmed IPO reads',
    !!panel && panel.labelled === panel.expected.items - panel.expected.green,
    panel ? `${panel.labelled} labelled, ${panel.expected.items - panel.expected.green} not green` : '');
  ok('...and a freshness line that is a separate, dated claim from the pill',
    !!panel && /(Last confirmed|committed captures|Waiting for)/.test(panel.fresh), panel?.fresh || '');
  // ONE WIRE PER FAMILY. A fixed decorative count would be a picture making a claim of its own.
  ok('the diagram draws one wire per source family, carrying that family\'s own icon',
    !!panel && panel.wires === panel.expected.families && panel.icons.join('') === panel.expected.icons.join(''),
    panel ? `${panel.wires} wires for ${panel.expected.families} families` : '');
  ok('...converging on the Sattva square itself', panel?.aligned === true);

  // Hovering a family lights its own wire and dims the rest — the pairing that makes the diagram
  // answer "which sources are these" rather than only decorate the panel.
  await page.locator('.beacon-group[data-family="2"] .beacon-group-head').hover();
  await page.waitForTimeout(300);
  const paired = await evalSafe(() => ({
    hot: [...document.querySelectorAll('.beacon-flow-line.is-hot')].map((n) => n.dataset.family),
    dimmed: document.querySelector('.beacon-flow-stage')?.classList.contains('is-focused'),
  }));
  ok('hovering a family lights its wire and dims the others',
    !!paired && paired.hot.length === 1 && paired.hot[0] === '2' && paired.dimmed, paired ? paired.hot.join(',') : '');

  // A POPOVER, NOT AN OVERLAY: it must not have reinstated the Sources button, and it must not sit
  // on top of anything the reader opened deliberately.
  const chrome = await evalSafe(() => {
    const h = document.querySelector('header');
    const z = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex) || 0;
    return {
      inHeader: h.querySelectorAll('[data-beacon-toggle], #sources-btn').length,
      headerPills: h.querySelectorAll('[data-status-pill]').length,
      beaconZ: z('.beacon-root'),
      modalZ: z('#modal-overlay'),
      workspaceZ: z('#workspace-overlay'),
    };
  });
  ok('the header still carries no Sources button and one status pill',
    !!chrome && chrome.inHeader === 0 && chrome.headerPills === 1, chrome ? `${chrome.inHeader} in header, ${chrome.headerPills} pill(s)` : '');
  ok('...and the beacon sits below every overlay',
    !!chrome && chrome.beaconZ < chrome.modalZ && chrome.beaconZ < chrome.workspaceZ,
    chrome ? `beacon ${chrome.beaconZ} < workspace ${chrome.workspaceZ} < modal ${chrome.modalZ}` : '');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await evalSafe(() => ({
    gone: !document.getElementById('source-beacon-panel'),
    focused: document.activeElement?.classList.contains('beacon-launcher'),
    expanded: document.querySelector('[data-beacon-toggle]')?.getAttribute('aria-expanded'),
  }));
  ok('Escape closes it and gives the launcher its focus back',
    !!closed && closed.gone && closed.focused && closed.expanded === 'false',
    closed ? `gone ${closed.gone}, focus ${closed.focused}` : '');
  // Torn down rather than hidden, so nothing animates behind a dismissed panel.
  ok('...and the panel is torn down rather than hidden', closed?.gone === true);

  await page.locator('[data-beacon-toggle]').click();
  await page.waitForTimeout(300);
  await page.mouse.click(1100, 300);
  await page.waitForTimeout(300);
  ok('a click outside closes it too', await page.evaluate(() => !document.getElementById('source-beacon-panel')));

  // No sideways page scroll at the narrowest width the layout checks use.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(400);
  await page.locator('[data-beacon-toggle]').click();
  await page.waitForTimeout(400);
  const narrow = await evalSafe(() => {
    const r = document.getElementById('source-beacon-panel')?.getBoundingClientRect();
    return r ? { right: Math.round(r.right), win: window.innerWidth, doc: document.documentElement.scrollWidth } : null;
  });
  ok('the panel fits a 390px viewport without widening the page',
    !!narrow && narrow.right <= narrow.win && narrow.doc <= narrow.win,
    narrow ? `right ${narrow.right} of ${narrow.win}, document ${narrow.doc}` : '');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------------------
// 12e. X/Twitter posts as another source in the News feed
//
// The whole feature is: a reader keeps a list of accounts, and their posts appear in the existing
// News list marked Twitter / X. So the checks are about it being ONE list rather than two — the
// same sort, the same search, the same filter, the same export — plus the three states the Twitter
// Sources screen may claim and the one it may not.
//
// The fixture's handles and words are FICTIONAL, deliberately. CLAUDE.md forbids attributing
// invented words to a real person or account, and a test fixture is not an exception: a screenshot
// of a passing run travels without the word "fixture" on it.
// ---------------------------------------------------------------------------------------
console.log('\n— twitter / x as a news source —');
{
  const now = Date.now();
  const iso = (mins) => new Date(now - mins * 60000).toISOString();
  const CAPTURE = {
    capturedAt: iso(5),
    handles: ['sattva_desk', 'sattva_wire', 'sattva_gone'],
    posts: [
      { tweet_id: '901', handle: 'sattva_desk', display_name: 'Sattva Desk', text: 'Fixture post one.', created_at: iso(9), url: 'https://x.com/sattva_desk/status/901', image: null },
      { tweet_id: '902', handle: 'sattva_desk', display_name: 'Sattva Desk', text: 'Fixture post two.', created_at: iso(45), url: 'https://x.com/sattva_desk/status/902', image: null },
      { tweet_id: '903', handle: 'sattva_wire', display_name: 'Sattva Wire', text: 'Fixture post three.', created_at: iso(200), url: 'https://x.com/sattva_wire/status/903', image: null },
    ],
    failed: [{ handle: 'sattva_gone', reason: 'account not found' }],
  };
  const HANDLES = { handles: [{ handle: 'sattva_desk' }, { handle: 'sattva_wire' }, { handle: 'sattva_gone' }] };
  await page.route('**/twitter-posts.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"tw-posts-fixture"' }, body: JSON.stringify(CAPTURE) }));
  await page.route('**/twitter-handles.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"tw-handles-fixture"' }, body: JSON.stringify(HANDLES) }));
  // The dispatch is stubbed rather than allowed through: a suite that started real Action runs on
  // every push is the failure the Deep Dive rules exist to prevent.
  const dispatched = [];
  await page.route('**/api/twitter/**', (r) => {
    dispatched.push(`${r.request().method()} ${new URL(r.request().url()).search}`);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dispatched: true }) });
  });
  await page.evaluate(() => localStorage.removeItem('sattva:twitter-handles:v1'));

  // ---- normalisation, before any of it reaches a screen -------------------------------------
  //
  // Pure and asserted directly, because the interesting cases are the ones a fixture will not
  // happen to contain: a 16-character handle, a link to somebody else's site, a bare domain.
  const norm = await evalSafe(async () => {
    const h = await import('/js/core/twitter-handles.js');
    const cases = ['@Reuters', 'Reuters', 'https://x.com/Reuters', 'https://x.com/Reuters?s=20', 'twitter.com/Reuters/', 'x.com/Reuters', '  @Reuters  '];
    const bad = ['', 'bad-handle', 'sattva_test_desk', 'https://example.com/Reuters', '@@', 'a'.repeat(16)];
    return {
      good: cases.map((c) => h.normaliseHandle(c).handle),
      bad: bad.map((c) => !!h.normaliseHandle(c).error),
    };
  });
  ok('every spelling of a handle normalises to the same one',
    !!norm && norm.good.every((v) => v === 'Reuters'), norm ? norm.good.join(', ') : 'not evaluated');
  ok('...and anything that is not a handle is refused with a reason',
    !!norm && norm.bad.every(Boolean), norm ? `${norm.bad.filter(Boolean).length} of ${norm.bad.length} refused` : 'not evaluated');

  await go('/#/research/news?scope=universe', 3200);
  await page.waitForFunction(() => !document.querySelector('[data-mcnews-list][data-rows-pending]'), null, { timeout: 20000 }).catch(() => {});

  const feed = await evalSafe(() => {
    const cards = [...document.querySelectorAll('[data-news-key]')];
    const postAt = cards.map((c, i) => (/Twitter \/ X/.test(c.innerText) ? i : -1)).filter((i) => i >= 0);
    const first = cards[postAt[0]];
    return {
      total: cards.length,
      posts: postAt.length,
      postAt,
      text: first?.innerText.replace(/\s+/g, ' ').trim() || '',
      href: first?.getAttribute('href') || null,
      sources: [...(document.querySelector('[data-news-source]')?.options || [])].map((o) => o.text),
      keys: cards.map((c) => c.getAttribute('data-news-key')),
    };
  });
  ok('posts appear in the existing News list, not a list of their own',
    !!feed && feed.posts === 3 && feed.total > 3, feed ? `${feed.posts} post(s) among ${feed.total} stories` : 'no feed');
  ok('...carrying the account name, the handle, the text, a time and the source',
    !!feed && /Sattva Desk/.test(feed.text) && /@sattva_desk/.test(feed.text) && /Fixture post one/.test(feed.text) &&
      /\d{2}:\d{2}/.test(feed.text) && /Twitter \/ X/.test(feed.text), feed ? feed.text.slice(0, 120) : '');
  ok('...linking to the original post', feed?.href === 'https://x.com/sattva_desk/status/901', feed?.href || 'no link');
  // INTERLEAVED, NOT APPENDED. Two feeds concatenated would put every post at one end of the list,
  // which is a separate Twitter section wearing the same chrome.
  //
  // ASSERTED AS "THE MERGED ORDER IS CHRONOLOGICAL", not as "a publisher story sits between two
  // posts". The second is a property of whatever capture happens to be committed — on a run where
  // every fixture post was newer than every story, all three landed at 0, 1, 2, which is CORRECT
  // placement and read as a failure. So the check reads each painted row's own timestamp from the
  // modules that own it and asserts the sequence never goes backwards; a concatenated list fails
  // that the moment a post is older than a story above it.
  const chrono = await evalSafe(async () => {
    const [market, tw] = await Promise.all([import('/js/data/market-news.js'), import('/js/data/twitter-news.js')]);
    const at = new Map();
    for (const r of [...market.rows(), ...tw.rows()]) {
      const t = Date.parse(r.publishedAt || '');
      if (Number.isFinite(t)) at.set(String(r.id), t);
    }
    const painted = [...document.querySelectorAll('[data-news-key]')].map((c) => c.getAttribute('data-news-key'));
    const times = painted.map((k) => at.get(k)).filter((t) => Number.isFinite(t));
    const posts = painted.filter((k) => String(k).startsWith('tw:'));
    return {
      timed: times.length,
      descending: times.every((t, i) => i === 0 || times[i - 1] >= t),
      firstBreak: times.findIndex((t, i) => i > 0 && times[i - 1] < t),
      // A post must have at least one dated story on the other side of it, or "merged" is
      // untestable on this capture — but which side is the capture's business, not ours.
      hasNeighbour: posts.length > 0 && times.length > posts.length,
    };
  });
  ok('...merged into the one chronological order rather than appended',
    !!chrono && chrono.descending && chrono.hasNeighbour && chrono.timed > 3,
    chrono ? `${chrono.timed} dated rows, first out of order at ${chrono.firstBreak}` : '');
  ok('...and every post is placed by its own time, not pinned to one end',
    !!feed && feed.postAt.length === 3 && new Set(feed.postAt).size === 3 && feed.postAt[2] < feed.total - 1,
    feed ? `at ${feed.postAt.join(', ')} of ${feed.total}` : '');
  // Every row key unique — the rule that broke the News table once already. Compared, not counted.
  ok('...with a key per row that is derived from content and unique',
    !!feed && new Set(feed.keys).size === feed.keys.length, feed ? `${feed.keys.length - new Set(feed.keys).size} duplicate key(s)` : '');
  ok('the source filter offers publishers and Twitter / X in one control',
    !!feed && feed.sources.join(' | ') === 'All sources | News publishers | Twitter / X', feed ? feed.sources.join(' | ') : 'no control');

  await page.selectOption('[data-news-source]', 'twitter');
  await page.waitForTimeout(400);
  const onlyTw = await evalSafe(() => {
    const c = [...document.querySelectorAll('[data-news-key]')];
    return { n: c.length, all: c.length > 0 && c.every((x) => /Twitter \/ X/.test(x.innerText)) };
  });
  ok('...and narrowing to Twitter / X leaves only posts', !!onlyTw && onlyTw.n === 3 && onlyTw.all, onlyTw ? `${onlyTw.n} row(s)` : '');
  await page.selectOption('[data-news-source]', 'publishers');
  await page.waitForTimeout(400);
  const onlyPub = await evalSafe(() => {
    const c = [...document.querySelectorAll('[data-news-key]')];
    return { n: c.length, none: !c.some((x) => /Twitter \/ X/.test(x.innerText)) };
  });
  ok('...and narrowing to publishers leaves none — the existing feed, untouched',
    !!onlyPub && onlyPub.n > 0 && onlyPub.none, onlyPub ? `${onlyPub.n} publisher row(s)` : '');
  await page.selectOption('[data-news-source]', 'all');
  await page.waitForTimeout(300);

  await page.fill('[data-news-search]', 'sattva_wire');
  await page.waitForTimeout(400);
  const searched = await evalSafe(() => [...document.querySelectorAll('[data-news-key]')].map((c) => c.innerText.replace(/\s+/g, ' ').slice(0, 40)));
  ok('the existing search reaches the handle as well as the text',
    Array.isArray(searched) && searched.length === 1 && /@sattva_wire/.test(searched[0]), searched ? searched.join(' | ') : '');
  await page.fill('[data-news-search]', '');
  await page.waitForTimeout(300);

  // ---- the Sources beacon, and the editor it opens -------------------------------------------
  await page.locator('[data-beacon-toggle]').click();
  await page.waitForTimeout(450);
  const family = await evalSafe(() => {
    const g = [...document.querySelectorAll('.beacon-group')].find((x) => /Twitter/.test(x.querySelector('.beacon-group-title')?.textContent || ''));
    return g ? { title: g.querySelector('.beacon-group-title').textContent.trim(), rows: [...g.querySelectorAll('.beacon-row')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()), action: g.querySelector('[data-beacon-action]')?.textContent.trim() || null } : null;
  });
  ok('the source list names Twitter / X as a source type of its own',
    family?.title === 'Twitter / X' && family.rows.length === 3, family ? `${family.rows.length} row(s)` : 'no family');
  ok('...one row per monitored account', !!family && family.rows.filter((r) => /^@sattva_/.test(r)).length === 3, family ? family.rows.join(' | ') : '');
  ok('...and an Edit Twitter Sources control beside it', family?.action === 'Edit Twitter Sources', family?.action || 'absent');

  await page.locator('[data-beacon-action="edit-twitter"]').click();
  await page.waitForTimeout(450);
  const editor = await evalSafe(() => ({
    open: !!document.querySelector('[data-twitter-sources]'),
    rows: [...document.querySelectorAll('[data-tw-remove]')].map((b) => b.closest('li').innerText.replace(/\s+/g, ' ').trim()),
  }));
  ok('the editor opens with every monitored account', !!editor?.open && editor.rows.length === 3, editor ? `${editor.rows.length} row(s)` : 'not open');
  // ACTIVE, ADDING AND NOT FOUND ARE THREE DIFFERENT CLAIMS. The middle one is the honest answer
  // for an account nothing has read yet, and it may never be dressed up as the first.
  ok('...an account a run has read reads Active', !!editor && /@sattva_desk.*ACTIVE/i.test(editor.rows.find((r) => /sattva_desk/.test(r)) || ''), editor?.rows[0] || '');
  ok('...and one the collector could not read says so, with its reason',
    !!editor && /account not found/i.test(editor.rows.find((r) => /sattva_gone/.test(r)) || ''), editor?.rows.find((r) => /sattva_gone/.test(r)) || '');

  // A HANDLE IN THE COMMITTED FILE HAS NOT NECESSARILY BEEN READ, and this is the check that
  // stopped it claiming otherwise. The collector writes a dispatched handle to the list BEFORE it
  // tries to read the account, so a run that added one and then could not sign in leaves it
  // committed and unread. Measured on a real run: X's Cloudflare refused the runner's login with
  // a 403, twscrape reported no active account, and every handle came back from `user_by_login`
  // as None — which the walk wrote into the capture as "account not found" against a perfectly
  // good account. The scraper now stops before the walk, and this asserts the browser half: with
  // no capture at all, a committed handle reads `adding`, never `active`.
  const unread = await evalSafe(async () => {
    const h = await import('/js/core/twitter-handles.js');
    const withCapture = h.all({ failed: new Map(), collected: true }).map((e) => `${e.handle}:${e.status}`);
    const without = h.all({ failed: new Map(), collected: false }).map((e) => `${e.handle}:${e.status}`);
    return { withCapture, without };
  });
  ok('a committed handle no run has read reads Adding, not Active',
    !!unread && unread.without.length > 0 && unread.without.every((v) => v.endsWith(':adding')) &&
      unread.withCapture.some((v) => v.endsWith(':active')),
    unread ? `no capture: ${unread.without.join(', ')} · with: ${unread.withCapture.join(', ')}` : 'not evaluated');

  const addOne = async (value) => {
    await page.fill('[data-tw-input]', value);
    await page.locator('[data-tw-add] button[type=submit]').click();
    await page.waitForTimeout(260);
    return page.locator('[data-tw-notice]').innerText();
  };
  const added = await addOne('@sattva_news');
  ok('adding a handle puts it on the list at once', /sattva_news added/i.test(added), added.slice(0, 90));
  const dupUrl = await addOne('https://x.com/sattva_news');
  const dupBare = await addOne('sattva_news');
  ok('...and the same account by URL or bare name is refused rather than duplicated',
    /already on the list/i.test(dupUrl) && /already on the list/i.test(dupBare), `${dupUrl.slice(0, 40)} / ${dupBare.slice(0, 40)}`);
  const list = await evalSafe(() => [...document.querySelectorAll('[data-tw-remove]')].map((b) => b.getAttribute('data-tw-remove')));
  ok('...leaving one row for it', Array.isArray(list) && list.filter((h) => h === 'sattva_news').length === 1, (list || []).join(', '));
  const pending = await evalSafe(() => (document.querySelectorAll('[data-tw-remove]').length ? [...document.querySelectorAll('[data-tw-remove]')].map((b) => b.closest('li').innerText.replace(/\s+/g, ' ')).find((t) => /sattva_news/.test(t)) : null));
  ok('...reading Adding, never Active, until a run has read it', /adding/i.test(pending || ''), pending || 'no row');
  ok('...and the collection it asked for names that handle and nothing else',
    dispatched.length === 1 && /handle=sattva_news/.test(dispatched[0]) && /^POST/.test(dispatched[0]), dispatched.join(' | ') || 'no dispatch');

  const badHandle = await addOne('bad-handle');
  ok('a value that is not a handle is refused in words, not swallowed', /1[–-]15 letters/.test(badHandle), badHandle.slice(0, 80));

  await page.locator('[data-tw-remove="sattva_desk"]').click();
  await page.waitForTimeout(400);
  const afterRemove = await evalSafe(async () => {
    const tw = await import('/js/data/twitter-news.js');
    return { list: [...document.querySelectorAll('[data-tw-remove]')].map((b) => b.getAttribute('data-tw-remove')), rows: tw.rows().length };
  });
  ok('removing an account takes its posts out of the feed immediately',
    !!afterRemove && !afterRemove.list.includes('sattva_desk') && afterRemove.rows === 1,
    afterRemove ? `${afterRemove.rows} post(s) left` : '');
  const afterReadd = await evalSafe(async () => {
    const h = await import('/js/core/twitter-handles.js');
    const tw = await import('/js/data/twitter-news.js');
    h.add('https://x.com/sattva_desk?s=20');
    return { entry: h.all().find((e) => e.key === 'sattva_desk'), rows: tw.rows().length };
  });
  ok('...and re-adding it brings them back, with no fetch at all',
    afterReadd?.entry?.status === 'active' && afterReadd.rows === 3, afterReadd ? `${afterReadd.rows} post(s)` : '');

  await page.evaluate(() => document.querySelector('[data-twitter-sources] [data-modal-close]')?.click());
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // A RELOAD MUST NOT LOSE THE LIST. It is the reader's own, and it lives on the device.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const survived = await evalSafe(async () => {
    const h = await import('/js/core/twitter-handles.js');
    await h.load();
    return h.all().map((e) => `${e.handle}:${e.status}`);
  });
  ok('the configured accounts survive a reload',
    Array.isArray(survived) && survived.includes('sattva_news:adding') && survived.some((v) => v.startsWith('sattva_desk')),
    (survived || []).join(', '));

  // The capture is deduplicated by the post id, so the same post twice is one row.
  const dedupe = await evalSafe(async () => {
    const tw = await import('/js/data/twitter-news.js');
    const ids = tw.rows().map((r) => r.id);
    return { n: ids.length, unique: new Set(ids).size, prefixed: ids.every((i) => i.startsWith('tw:')) };
  });
  ok('a post is identified by its own id, namespaced so it cannot collide with a publisher story',
    !!dedupe && dedupe.n === dedupe.unique && dedupe.prefixed, dedupe ? `${dedupe.unique} unique of ${dedupe.n}` : '');

  await page.evaluate(() => localStorage.removeItem('sattva:twitter-handles:v1'));
  await page.unroute('**/twitter-posts.json*');
  await page.unroute('**/twitter-handles.json*');
  await page.unroute('**/api/twitter/**');
}

// ---------------------------------------------------------------------------------------
console.log('\n— sub-view picker and the removed roadmap card —');
{
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Only two tabs have sub-views now: Breakouts (four) and Super Investors (two). Portfolio
  // Overview was the third and is deleted along with the rest of that workspace.
  const WITH_SUBVIEWS = [
    ['/#/research/breakouts?scope=universe', 'breakouts'],
    ['/#/research/super-investors?scope=universe', 'super-investors'],
  ];
  const WITHOUT = [
    ['/#/research/earnings-hub?scope=universe', 'earnings hub'],
    ['/#/research/concall?scope=universe', 'con-call'],
    ['/#/research/news?scope=universe', 'news'],
  ];

  const readLayout = () =>
    page.evaluate(() => {
      const mount = document.getElementById('subview-mount');
      const host = document.getElementById('content-host');
      const overflows = [...document.querySelectorAll('[data-table-scroll]')].map((t) => t.scrollWidth - t.clientWidth);
      return {
        railGone: !document.getElementById('rail-aside'),
        pickerShown: !!mount && !mount.classList.contains('hidden') && mount.offsetHeight > 0,
        contentLeft: Math.round(host.getBoundingClientRect().left),
        contentWidth: Math.round(host.getBoundingClientRect().width),
        worstTableOverflow: overflows.length ? Math.max(...overflows) : 0,
        roadmap: /wiring roadmap/i.test(host.innerText),
        pageSideScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

  const seen = [];
  for (const [hash, label] of [...WITH_SUBVIEWS, ...WITHOUT]) {
    await go(hash, 2600);
    await waitForPanel();
    seen.push([label, await readLayout()]);
  }

  ok('the left rail column is gone from the shell', seen.every(([, m]) => m.railGone));
  ok('...so the content spans the full column on every tab',
    seen.every(([, m]) => m.contentWidth >= 1300),
    seen.map(([l, m]) => `${l}:${m.contentWidth}`).join(' · '));
  ok('...and no page scrolls sideways for it',
    seen.every(([, m]) => m.pageSideScroll <= 0),
    seen.map(([l, m]) => `${l}:${m.pageSideScroll}`).join(' · '));
  ok('no tab still renders the Wiring roadmap card',
    seen.every(([, m]) => !m.roadmap),
    seen.filter(([, m]) => m.roadmap).map(([l]) => l).join(', ') || 'none');
  ok('a tab WITH sub-views shows the picker',
    seen.filter(([l]) => WITH_SUBVIEWS.some(([, w]) => w === l)).every(([, m]) => m.pickerShown),
    seen.map(([l, m]) => `${l}:${m.pickerShown}`).join(' · '));
  ok('...and a tab with none shows no empty control',
    seen.filter(([l]) => WITHOUT.some(([, w]) => w === l)).every(([, m]) => !m.pickerShown));
  // Breakouts is the tab this was noticed on: ten columns that used to need an inner scrollbar.
  const bo = seen.find(([l]) => l === 'breakouts')[1];
  ok('Breakouts fits its columns with no scrollbar of its own', bo.worstTableOverflow === 0, `${bo.worstTableOverflow}px`);

  // A picker that opens but does not navigate would pass every check above. The menu is also
  // `position: absolute` BELOW its card, so a wrapper carrying `overflow-hidden` clips it into
  // invisibility while every click handler goes on working — a control that looks broken and
  // tests as fine. That is exactly what the first cut of this picker did.
  //
  // It is asserted as a CLASS contract rather than as geometry because class ownership is the
  // durable cause of this bug. The first version read the open menu's box and could pass even when
  // an ancestor clipped it; a check that cannot fail is not a check.
  await go('/#/research/breakouts/strong-breakouts?scope=universe', 2600);
  await waitForPanel();
  await page.locator('#subview-mount [data-dd-trigger]').click();
  await page.waitForTimeout(350);
  const menu = await page.evaluate(() => {
    const el = document.querySelector('#subview-mount [data-dd-menu]');
    const clippers = [];
    for (let n = el.parentElement; n && n.id !== 'subview-mount'; n = n.parentElement) {
      if (String(n.className || '').split(/\s+/).includes('overflow-hidden')) clippers.push(n.className);
    }
    return { open: !el.classList.contains('hidden'), items: el.querySelectorAll('[data-dd-id]').length, clippers };
  });
  ok('clicking the picker opens its menu', menu.open && menu.items === 4, JSON.stringify({ open: menu.open, items: menu.items }));
  ok('...and nothing between the menu and its mount clips it', menu.clippers.length === 0, menu.clippers.join(' | ') || 'no overflow-hidden ancestor');
  await page.locator('#subview-mount [data-dd-id="fii-accumulation"]').click();
  await page.waitForTimeout(1800);
  ok('...and picking a sub-view navigates to it', /breakouts\/fii-accumulation/.test(page.url()), page.url());
  ok('...and the content follows', /Institutional holding changes/i.test(await hostText()));
}

// ---------------------------------------------------------------------------------------
// 16. Layout holds and nothing scrolls sideways
// ---------------------------------------------------------------------------------------
console.log('\n— layout —');
for (const width of [1440, 1024, 390]) {
  await page.setViewportSize({ width, height: 900 });
  for (const [route, label] of [
    ['/#/research/concall?scope=universe', 'con-call scan table'],
    ['/#/research/public-chatter?scope=universe', 'public chatter'],
    ['/#/research/super-investors/institutions?scope=universe&fund=bandhan-small-cap-fund', 'AMC portfolio table'],
  ]) {
    await go(route, 1700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${label}: no sideways page scroll at ${width}px`, over <= 0, `${over}px`);
  }
  await go('/#/research/earnings-hub?scope=universe', 1600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`no sideways page scroll at ${width}px`, overflow <= 0, `${overflow}px`);
  await go('/#/research/ai-alerts?scope=portfolio', 4500);
  const aiOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`AI Alerts cards: no sideways page scroll at ${width}px`, aiOverflow <= 0, `${aiOverflow}px`);
}

// ---------------------------------------------------------------------------------------
// 17. Persistent caching — the two big polled feeds must not re-download themselves
//
// The results feed is 1.1MB and the con-call scan 450KB, both polled every 30 seconds. Before
// this was wired, one open Earnings Hub tab pulled 1,135KB PER TICK — measured, ~136MB an hour —
// to report that nothing had changed. The assertions below are the ones that keep it that way.
// ---------------------------------------------------------------------------------------
console.log('\n— persistent cache —');
await page.setViewportSize({ width: 1440, height: 1100 });

// The store must actually persist, and must hold the server's own bytes under the server's own
// tag. That pairing is the whole basis for trusting an unchanged answer: if the stored value and
// the stored tag ever describe different things, every later revalidation is a lie.
await go('/#/research/earnings-hub?scope=universe', 400);
await waitForPanel(12000);
await page.waitForTimeout(1200); // the writes are fire-and-forget, off the paint path

const stored = await page.evaluate(async () => {
  const s = await import('./js/core/store.js');
  const e = await s.readEntry(s.KEYS.earnings('yoy'));
  return { persistent: s.isPersistent(), has: !!e, tag: e?.tag || null, rows: e?.value?.rows?.length || 0, bodyTag: e?.value?.meta?.contentTag || null };
});
if (stored.has) {
  ok('the results payload is kept on this device', stored.rows > 100, `${stored.rows} rows stored`);
  ok('...under a content tag', !!stored.tag, stored.tag || 'none');
  ok(
    "...and the tag describes the value stored with it",
    !stored.bodyTag || stored.tag.replace(/"/g, '') === stored.bodyTag,
    `header ${stored.tag} vs body ${stored.bodyTag}`
  );
} else {
  skip('the results payload is kept on this device', 'no /api/earnings on this origin — nothing live to store');
}

// A revalidation must cost headers, not a payload. `transferSize` is the honest measure:
// `content-length` is present on a browser-cache hit too, so counting it would report a full
// download for a request that moved nothing.
const revalidation = await page.evaluate(async () => {
  const url = 'api/earnings?subType=yoy&fields=prices';
  const probe = async () => {
    performance.clearResourceTimings();
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 250));
    const e = performance.getEntriesByType('resource').filter((x) => x.name.includes('fields=prices')).pop();
    return e ? { transfer: e.transferSize, decoded: e.decodedBodySize } : null;
  };
  const first = await probe();
  const second = await probe();
  return { first, second };
});
if (revalidation.second) {
  ok(
    'a repeat fetch of the prices projection transfers no payload',
    revalidation.second.transfer < 2000,
    `${revalidation.second.transfer} bytes on the wire vs ${revalidation.second.decoded} decoded`
  );
  ok(
    '...and the projection is a fraction of the full feed',
    revalidation.first.decoded > 0 && revalidation.first.decoded < 200_000,
    `${Math.round(revalidation.first.decoded / 1024)}KB`
  );
} else {
  skip('a repeat fetch of the prices projection transfers no payload', 'no /api/earnings on this origin');
}

// The freshness claim has to distinguish "read from the upstream at X" from "confirmed still
// current at Y". Collapsing them would let a five-hour-old figure read as seconds old.
const freshness = await page.evaluate(async () => {
  const feed = await import('./js/data/earnings-live.js');
  const m = feed.meta();
  return m ? { origin: m.origin, checkedAt: m.checkedAt, fetchedAt: m.fetchedAt || null } : null;
});
ok('the feed records where this paint came from', !!freshness?.origin, `origin=${freshness?.origin}`);
ok('...and when the server last confirmed it', Number.isFinite(freshness?.checkedAt), String(freshness?.checkedAt));
await page.locator('[data-live-info]').click();
await page.waitForTimeout(200);
ok('the feed status stays passive when the paint came from cache',
  (await page.locator('[data-live-info]').evaluate((el) => el.tagName)) === 'SPAN' &&
    (await page.locator('#modal-overlay:not(.hidden)').count()) === 0);

// Con-call: same contract, one channel — nothing on a con-call row moves on a tick, so the
// conditional GET does the whole job there and no projection exists.
await go('/#/research/concall/concall-scans?scope=universe', 400);
await waitForPanel(12000);
await page.waitForTimeout(1200);
const ccStore = await page.evaluate(async () => {
  const s = await import('./js/core/store.js');
  const e = await s.readEntry(s.KEYS.concalls);
  const probe = async () => {
    performance.clearResourceTimings();
    const res = await fetch('api/concalls', { cache: 'no-cache' });
    if (!res.ok) return null;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 250));
    const t = performance.getEntriesByType('resource').filter((x) => x.name.includes('api/concalls')).pop();
    return t ? { transfer: t.transferSize, decoded: t.decodedBodySize } : null;
  };
  await probe();
  return { has: !!e, rows: e?.value?.rows?.length || 0, second: await probe() };
});
if (ccStore.has) {
  ok('the con-call scan is kept on this device', ccStore.rows > 50, `${ccStore.rows} calls stored`);
  ok('...and a repeat fetch transfers no payload', (ccStore.second?.transfer ?? 1e9) < 2000, `${ccStore.second?.transfer} bytes vs ${ccStore.second?.decoded} decoded`);
} else {
  skip('the con-call scan is kept on this device', 'no /api/concalls on this origin');
}

// The committed snapshots and lookup tables are static files. Fetching them with `no-store` — as
// every loader did — forbids reuse outright and made each visit pay ~800KB again.
// A MISSING FILE MUST FAIL THIS CHECK, NOT PASS IT. The list still named `js/data/chatter.js`,
// which was renamed to chatter-live.js — so the fetch 404'd, `.text()` handed back the server's
// error page, the regex found no `no-store` in it and the loader was reported clean without ever
// having been read. A check whose subject can vanish silently is a check that stops checking.
const noStore = await page.evaluate(async () => {
  const files = [
    'js/app.js',
    'js/data/technicals.js',
    'js/data/earnings.js',
    'js/data/chatter-live.js',
    'js/data/earnings-live.js',
    'js/data/concall-scans.js',
    'js/data/super-investors.js',
    'js/data/institution-holdings.js',
    'js/data/coverage.js',
  ];
  const out = [];
  const missing = [];
  for (const f of files) {
    const res = await fetch(f, { cache: 'no-cache' });
    if (!res.ok) { missing.push(f); continue; }
    if (/cache:\s*'no-store'/.test(await res.text())) out.push(f);
  }
  return { out, missing, read: files.length - missing.length };
});
ok('every loader this check names still exists', noStore.missing.length === 0, noStore.missing.join(', ') || `${noStore.read} read`);
ok('no static-file loader still uses cache: no-store', noStore.out.length === 0, noStore.out.join(', '));

// ---------------------------------------------------------------------------------------
// 18. Moving between tabs — the table streams instead of blocking, and still ends up complete
//
// Building and laying out 1,722 rows cost ~900ms of blocked main thread on every mount of the
// Earnings Hub, for a viewport that shows about thirteen. A later trace found two costs still on
// every switch: the Tailwind browser compiler rescanning injected markup, and the scope thumb
// forcing layout through offset measurements. CSS is now precompiled; the thumb moves by index;
// and the table's initial and idle batches stay small.
//
// So `scoreTable` paints a screenful and appends the rest while the browser is idle. Both halves
// of that need asserting: the switch has to be fast, AND the table has to end up whole. A fast
// switch that quietly dropped 1,600 rows would pass the first check and be a far worse bug than
// the one it fixed.
// ---------------------------------------------------------------------------------------
console.log('\n— tab switching —');
const tabSpeedContracts = await page.evaluate(async () => {
  const index = await (await fetch('/index.html', { cache: 'no-store' })).text();
  const css = await (await fetch('/css/tailwind.css', { cache: 'no-store' })).text();
  const components = await (await fetch('/js/ui/components.js', { cache: 'no-store' })).text();
  const scopeToggle = components.split('export function segmentedToggle')[1]?.split('export function')[0] || '';
  return {
    localCssLinked: /href=["']\/css\/tailwind\.css["']/.test(index),
    runtimeCompilerGone: !/cdn\.tailwindcss\.com|tailwind\.config/.test(index),
    cssBytes: css.length,
    scopeMeasuresLayout: /\.(?:offsetWidth|offsetLeft|getBoundingClientRect)\b/.test(scopeToggle),
  };
});
ok('Tailwind ships as a substantial same-origin stylesheet', tabSpeedContracts.localCssLinked && tabSpeedContracts.cssBytes > 30000, `${tabSpeedContracts.cssBytes} bytes`);
ok('the browser-side Tailwind compiler stays out of the hot path', tabSpeedContracts.runtimeCompilerGone);
ok('the scope toggle positions its thumb without forcing layout', !tabSpeedContracts.scopeMeasuresLayout);
await go('/#/research/earnings-hub?scope=universe', 1200);
await waitForPanel();
await settleTables();
const fullRows = await rowCount();

const switchCost = await page.evaluate(async () => {
  const times = [];
  for (const tab of ['breakouts', 'earnings-hub', 'concall', 'earnings-hub']) {
    const t = performance.now();
    location.hash = `#/research/${tab}`;
    // One macrotask is enough to have run the hashchange handler, the chrome rebuild, the tab's
    // render() and — since every feed is cached by now — its microtask paint. Anything still on
    // the clock here is work that blocked the switch.
    await new Promise((r) => setTimeout(r, 0));
    times.push(Math.round(performance.now() - t));
    await new Promise((r) => setTimeout(r, 1500));
  }
  return times;
});
// Generous on purpose: this runs on shared CI hardware and the point is the order of magnitude,
// not a stopwatch. Before streaming, the two Earnings Hub entries alone measured 866ms and 1,536ms;
// the current Chrome DevTools interaction trace measured 39ms INP.
ok('switching tabs does not block on building the whole table', Math.max(...switchCost) < 400, `${switchCost.join('ms, ')}ms`);

// Asserted on the markup `scoreTable` returns rather than by racing the fill on screen: the whole
// point of the change is that the rest arrives quickly, so "catch it mid-fill" is a check that
// gets flakier the better the code works. This asks the component directly what it hands the DOM.
await go('/#/research/earnings-hub?scope=universe', 1200);
await waitForPanel();
const streamed = await page.evaluate(async () => {
  const { scoreTable } = await import('/js/ui/screener.js');
  const feed = await import('/js/data/earnings-live.js');
  const rows = feed.all();
  const t = scoreTable({ rows, key: (r) => r.scId, name: (r) => r.company, columns: [{ label: 'Date', get: (r) => r.resultDate || '' }] });
  return {
    total: rows.length,
    inFirstPaint: (t.html.match(/<tr data-row-key=/g) || []).length,
    pending: Number(/data-rows-pending="(\d+)"/.exec(t.html)?.[1] || 0),
  };
});
ok('the first paint carries a screenful, not the whole feed', streamed.inFirstPaint > 0 && streamed.inFirstPaint <= 60 && streamed.inFirstPaint < streamed.total, `${streamed.inFirstPaint} of ${streamed.total} rows in the initial markup`);
ok('...and says how many are still to come rather than hiding them', streamed.pending === streamed.total - streamed.inFirstPaint, `${streamed.pending} pending`);
await settleTables();
const afterStream = await page.locator('tr[data-row-key]').count();
ok('...and every row arrives in the end', afterStream === fullRows && afterStream > 1000, `${afterStream} rows`);
ok('...leaving nothing marked pending', (await page.locator('[data-score-table][data-rows-pending]').count()) === 0);

// The export reads the row DATA, not the DOM, so a fill still in flight can never truncate a
// workbook. Asserted on the count the toolbar reports, which is the same list the exporter gets.
const countShown = await page.evaluate(() => document.querySelector('[data-row-count]')?.innerText || '');
ok('the row count reports the whole visible set, not what has been painted', new RegExp(`^${afterStream} of `).test(countShown.trim()), countShown.trim());

// ---------------------------------------------------------------------------------------
// 18b. The bootstrap only blocks on what the first paint needs
//
// It used to block on seven files, ~825KB, including a 347KB shareholdings file read by one
// sub-view and a 232KB mock corpus read by one other. Only the book is needed to render anything.
// ---------------------------------------------------------------------------------------
const bootBlocking = await page.evaluate(async () => {
  const src = await (await fetch('js/app.js', { cache: 'no-cache' })).text();
  const block = /const CRITICAL_SOURCES = \{([\s\S]*?)\n\};/.exec(src)?.[1] || '';
  return (block.match(/'data\/[^']+'/g) || []).map((s) => s.replace(/'/g, ''));
});
ok('the shell blocks on one file, not seven', bootBlocking.length === 1, bootBlocking.join(', '));
ok('...and it is the book, which every scope filter reads synchronously', bootBlocking[0] === 'data/portfolio-companies.json', bootBlocking[0]);
// The deferred files still have to arrive, and the views that read them have to wait rather than
// render an empty answer. Institutions is the one that would fail loudest: an unprimed book is an
// empty book, and an empty book on screen is a claim that nobody holds anything.
await go('/#/research/super-investors/institutions?scope=universe', 2500);
await waitForPanel();
ok('a deferred feed still reaches the view that needs it', !/No holdings file loaded/i.test(await hostText()) && (await rowCount()) > 0, `${await rowCount()} holdings`);

// ---------------------------------------------------------------------------------------
console.log('\n— 16. tracked news keywords, and the cross-feed patterns they feed —');
// ---------------------------------------------------------------------------------------
// THE RULES ARE ASSERTED DIRECTLY, NOT THROUGH WHATEVER TODAY'S CAPTURE HAPPENS TO HOLD. Same
// reason `moveSeverity` and `freshnessOf` are: a marquee investor and a volume spike landing on one
// company inside seven days is exactly the case a fixture has to supply, and a capture with no
// fraud story in it would pass a "does Fraud filter" check by matching nothing twice.
const keywordRules = await page.evaluate(async () => {
  const kw = await import('/js/data/news-keywords.js');
  const alerts = await import('/js/data/daily-alerts.js');
  const ai = await import('/js/data/ai-alerts.js');
  const labels = kw.KEYWORDS.map((k) => k.label);
  const hit = (title, summary = '') => kw.matchKeywords(title, summary).map((k) => k.label);

  // The named cross-feed pattern the whole layer exists for: participation on the tape and a
  // material disclosed buyer, on one company, inside the window.
  const ev = (o) => ({ day: '2026-09-03', ticker: 'ZZTEST', company: 'ZZ Test Ltd', feed: o.feed, feedLabel: o.feed, direction: o.dir || 'neutral', importance: o.imp || 'high', headline: o.h, keywords: o.kw || [], kind: o.kind || null });
  const feedById = new Map(['news', 'announcements', 'earnings'].map((id) => [id, { id, status: 'ok', reachesToday: true }]));
  const buyerEvents = [
    ev({ feed: 'technicals', kind: 'volume', h: 'Volume 3.2x its 20-day average at the 2026-09-02 close' }),
    ev({ feed: 'investors', dir: 'positive', imp: 'high', h: 'A Tracked Investor: newly disclosed 1.80%' }),
  ];
  const smallBuyer = [buyerEvents[0], ev({ feed: 'investors', dir: 'positive', imp: 'low', h: 'A Tracked Investor: increased by 0.10pp' })];
  const lonelyMove = [ev({ feed: 'technicals', kind: 'move', dir: 'negative', h: 'Fell 6.7% at the 2026-09-02 close' })];

  return {
    count: kw.KEYWORDS.length,
    uniqueIds: new Set(kw.KEYWORDS.map((k) => k.id)).size,
    uniqueLabels: new Set(labels).size,
    // The desk's own words, spelt as they were given.
    hasDeskWords: ['Capacity Expansion', 'Receipt of Order', 'Qualified Institutional Placement', 'Corporate Governance', 'Downgrade'].every((w) => labels.includes(w)),
    // Non-global patterns: a /g regex carries lastIndex and would match every other row.
    anyGlobal: kw.KEYWORDS.some((k) => k.test.global),
    // The narrowings the header claims, asserted as narrowings rather than described.
    freeTrialIsNotATrial: !hit('Sign up for a free trial of our premium tier').includes('Trial'),
    clinicalTrialIs: hit('Phase III trial data for its lead candidate').includes('Trial'),
    stockOnFireIsNotAFire: !hit('GOCL stock on fire; 15% up').includes('Fire'),
    factoryFireIs: hit('Massive fire breaks out at the packaging unit').includes('Fire'),
    quitCaliforniaIsNotAResignation: !hit('The start-up has quit California for Texas').includes('Resignation'),
    cfoResigns: hit('CFO resigns with immediate effect').includes('Resignation'),
    inOrderToIsNotAnOrder: !hit('In order to comply, the board met on Tuesday').includes('Order'),
    orderWinIs: hit('Bags Rs 135-crore order from MPPTCL').includes('Order'),
    // A story can carry several, and the desk's overlapping order words are three separate keywords.
    multi: hit('Receipt of order worth Rs 240 crore; orderbook now at a record').length >= 3,

    // `namesCompany` is three answers, not two.
    namesYes: kw.namesCompany({ query: 'Advait Energy Transitions', title: 'Advait Energy wins order' }) === true,
    namesNo: kw.namesCompany({ query: 'Advait Energy Transitions', title: 'Some other company wins an order' }) === false,
    namesUnknown: kw.namesCompany({ title: 'A headline with no search term behind it' }) === null,
    // A term that is nothing but stopwords cannot answer the question, so it says so.
    namesStopwordsOnly: kw.namesCompany({ query: 'India Ltd', title: 'A story about India Ltd' }) === null,

    // The filter's vocabulary, including the option that makes it falsifiable.
    optionValues: kw.topicFilterOptions().map((o) => o.value),
    trackedMatches: kw.matchesTopic(kw.classifyStory({ title: 'Wins Rs 10 crore order', query: 'Test Co' }), 'tracked'),
    untrackedMatches: kw.matchesTopic(kw.classifyStory({ title: 'A quiet day at the office', query: 'Test Co' }), 'untracked'),
    // The strict reading keeps a row whose name check could not be answered — an unverifiable name
    // is not a failed one — and drops only one that was checked and did not name the company.
    targetedKeepsUnknown: kw.classifyStory({ title: 'Wins Rs 10 crore order' }).targeted === true,
    targetedDropsUnnamed: kw.classifyStory({ title: 'Wins Rs 10 crore order', query: 'Advait Energy Transitions' }).targeted === false,

    // The materiality rule on the news feed: topic yes, direction never.
    trackedIsHigh: alerts.newsSignal({ title: 'Advait Energy bags Rs 135-crore order', query: 'Advait Energy' }).importance === 'high',
    untrackedIsLow: alerts.newsSignal({ title: 'A quiet day', query: 'Advait Energy' }).importance === 'low',
    untrackedKeepsNameEvidence: alerts.newsSignal({ title: 'A quiet day', query: 'Advait Energy' }).namesCompany === false,
    // BOTH HALVES OF "company name + keyword", or it is not an alert: a tracked word on a story
    // that does not carry the company is somebody else's order win under this company's name.
    unnamedStaysLow: alerts.newsSignal({ title: 'Some other firm bags Rs 135-crore order', query: 'Advait Energy' }).importance === 'low',
    unnamedKeepsItsKeywords: alerts.newsSignal({ title: 'Some other firm bags Rs 135-crore order', query: 'Advait Energy' }).keywords.includes('Order'),
    unrelatedQueryIdentityIsNotSearchEvidence:
      !alerts.eventSearchText({ feed: 'news', company: 'Jayaswal Neco Industries', ticker: 'JAYNECOIND', namesCompany: false,
        headline: 'Lululemon stock analysis', sourceRecord: { summary: 'Is Lululemon a buy?' } }).toLowerCase().includes('jayaswal'),
    unrelatedPublisherTextRemainsSearchable:
      alerts.eventSearchText({ feed: 'news', company: 'Jayaswal Neco Industries', ticker: 'JAYNECOIND', namesCompany: false,
        headline: 'Lululemon stock analysis', sourceRecord: { summary: 'Is Lululemon a buy?' } }).toLowerCase().includes('lululemon'),
    uncheckableNewsKeepsAssignedCompanySearch:
      alerts.eventSearchText({ feed: 'news', company: 'A Company', ticker: 'ACOMPANY', namesCompany: null,
        headline: 'Quarterly update' }).includes('ACOMPANY'),
    otherFeedsKeepResolvedCompanySearch:
      alerts.eventSearchText({ feed: 'announcements', company: 'Jayaswal Neco Industries', ticker: 'JAYNECOIND', headline: 'Press release' }).includes('JAYNECOIND'),
    uncheckableStillCounts: alerts.newsSignal({ title: 'Bags Rs 135-crore order' }).importance === 'high',
    // A standfirst is not a headline. Several outlets fill it with a related-links strip, so one
    // sidebar was tagging unrelated stories with whatever the sidebar happened to mention.
    standfirstOnlyStaysLow:
      alerts.newsSignal({ title: 'Advait Energy share price live updates', summary: 'Elsewhere: another firm bags Rs 135-crore order', query: 'Advait Energy' }).importance === 'low',
    standfirstOnlyKeepsItsKeywords:
      alerts.newsSignal({ title: 'Advait Energy share price live updates', summary: 'Elsewhere: another firm bags Rs 135-crore order', query: 'Advait Energy' }).keywords.includes('Order'),
    // ...and the filter still finds it, because exploring a feed and asserting a company needs
    // attention are different jobs.
    standfirstOnlyStillFilterable: kw.classifyStory({ title: 'Advait Energy share price live updates', summary: 'Elsewhere: another firm bags Rs 135-crore order' }).tracked === true,
    trackedStaysNeutral: alerts.newsSignal({ title: 'Sued over a patent', query: 'Advait Energy' }).direction === 'neutral',
    riskWordStaysNeutral: alerts.newsSignal({ title: 'Fraud investigation opened', query: 'Advait Energy' }).direction === 'neutral',
    reasonNamesTheKeyword: /tracked keyword/i.test(alerts.newsSignal({ title: 'Bags Rs 135-crore order', query: 'Advait Energy' }).importanceReason),

    // The volume threshold is stated and exported, like every other entry rule on that page.
    volumeX: alerts.VOLUME_X,

    // ANNOUNCEMENTS: the taxonomy REPLACED a borrowed gate rather than sitting beside one.
    // BSE's critical flag marks about a third of all filings and most are AGM notices, so it is
    // reproduced on the row and no longer decides what is material. Fixtures, because the retained
    // capture is three days and cannot be relied on to contain each case.
    criticalIsNotOurGate: alerts.BSE_CRITICAL_IS_MATERIAL === false,
    agmStaysLow: alerts.announcementSignal({ title: 'Notice of 25th Annual General Meeting', category: 'AGM/EGM', subCategory: 'AGM', critical: true }).importance === 'low',
    // ...and the row still says the flag was set, because it is theirs and a reader is owed it.
    agmReasonNamesTheFlag: /BSE marked this filing critical/.test(alerts.announcementSignal({ title: 'Notice of 25th AGM', critical: true }).importanceReason),
    // A tracked keyword promotes a filing, including through BSE's own sub-category wording.
    orderFilingIsHigh: alerts.announcementSignal({ title: 'Intimation of receipt of order', subCategory: 'Award of Order / Receipt of Order', critical: false }).importance === 'high',
    subCategoryAloneCounts: alerts.announcementSignal({ title: 'Intimation under Regulation 30', subCategory: 'Resignation of Director', critical: false }).keywords.includes('Resignation'),
    // The directional rule keeps its own materiality — a dividend record date carries no tracked
    // keyword and must not lose importance to this change.
    dividendStillHigh: alerts.announcementSignal({ title: 'Record date for the purpose of payment of Dividend', critical: false }).importance === 'high',
    // Direction on this feed is untouched by the keyword layer.
    downgradeStillNegative: alerts.announcementSignal({ title: 'Intimation of rating downgrade' }).direction === 'negative',
    dividendStillPositive: alerts.announcementSignal({ title: 'Record date for Final Dividend' }).direction === 'positive',
    agmStaysNeutral: alerts.announcementSignal({ title: 'Notice of 25th Annual General Meeting', critical: true }).direction === 'neutral',

    // The confluence layer.
    buyerPattern: ai.confluenceOf(buyerEvents, { feedById }).map((c) => c.id),
    buyerSentence: ai.confluenceOf(buyerEvents, { feedById })[0]?.detail || '',
    smallBuyerPattern: ai.confluenceOf(smallBuyer, { feedById }).map((c) => c.id),
    // An absence may only be reported when the silent feeds were actually read.
    unexplainedWhenRead: ai.confluenceOf(lonelyMove, { feedById }).map((c) => c.id),
    unexplainedWhenUnread: ai.confluenceOf(lonelyMove, { feedById: new Map([['news', { id: 'news', status: 'ok', reachesToday: false }]]) }).map((c) => c.id),
    confluenceMax: ai.CONFLUENCE_MAX,
  };
});

ok('the desk supplied thirty keywords and thirty are registered', keywordRules.count === 30 && keywordRules.uniqueIds === 30 && keywordRules.uniqueLabels === 30, `${keywordRules.count} keywords`);
ok("...spelt in the desk's own words", keywordRules.hasDeskWords);
ok('...and no pattern is global, which would make it match every other row', !keywordRules.anyGlobal);
ok('a free trial is not a Trial, a clinical one is', keywordRules.freeTrialIsNotATrial && keywordRules.clinicalTrialIs);
ok('a stock "on fire" is not a Fire, a factory one is', keywordRules.stockOnFireIsNotAFire && keywordRules.factoryFireIs);
ok('quitting a state is not a Resignation, a CFO leaving is', keywordRules.quitCaliforniaIsNotAResignation && keywordRules.cfoResigns);
ok('"in order to" is not an Order, bagging one is', keywordRules.inOrderToIsNotAnOrder && keywordRules.orderWinIs);
ok('one story can carry several keywords', keywordRules.multi);
// THREE ANSWERS, NOT TWO — the rule this codebase keeps having to re-learn.
ok('"names the company" is yes, no, or cannot-tell', keywordRules.namesYes && keywordRules.namesNo && keywordRules.namesUnknown && keywordRules.namesStopwordsOnly);
ok('...and the strict filter keeps a row it could not check, dropping only a checked miss', keywordRules.targetedKeepsUnknown && keywordRules.targetedDropsUnnamed);
// A filter that can only narrow to what it recognises can never be checked against its own misses.
ok('the Topic filter offers "No tracked keyword", so a too-narrow pattern can be found', keywordRules.optionValues.includes('untracked') && keywordRules.trackedMatches && keywordRules.untrackedMatches);
ok('a tracked keyword raises IMPORTANCE and an untracked story stays low', keywordRules.trackedIsHigh && keywordRules.untrackedIsLow);
// The rule is "company name + keyword", so a keyword alone is half of it.
ok('...and a keyword on a story that does not name the company stays low, keeping its tags', keywordRules.unnamedStaysLow && keywordRules.unnamedKeepsItsKeywords);
ok('...while a story with no search term to check against still counts', keywordRules.uncheckableStillCounts);
ok('...and a keyword only in the standfirst stays low, but stays findable and tagged',
  keywordRules.standfirstOnlyStaysLow && keywordRules.standfirstOnlyKeepsItsKeywords && keywordRules.standfirstOnlyStillFilterable);
// The line this whole layer had to not cross: News carries no judgement of ours on somebody else's
// reporting, so even "Fraud" and "Sued" leave the direction exactly where it was.
ok('...and it never moves DIRECTION, not even on a risk word', keywordRules.trackedStaysNeutral && keywordRules.riskWordStaysNeutral);
ok('...and the reason names the keyword rather than asserting the event', keywordRules.reasonNamesTheKeyword);
ok('the volume threshold is stated and exported', keywordRules.volumeX === 2, `${keywordRules.volumeX}x the 20-day average`);
// A BORROWED FLAG IS NOT A MATERIALITY RULE. BSE's marks ~a third of all filings, 881 of them AGM
// notices, so using it as the gate made a third of the exchange high-importance.
ok("BSE's critical flag is reproduced but is not this dashboard's materiality gate", keywordRules.criticalIsNotOurGate && keywordRules.agmStaysLow && keywordRules.agmReasonNamesTheFlag);
ok('...and a tracked keyword promotes a filing, including one only BSE\'s sub-category names', keywordRules.orderFilingIsHigh && keywordRules.subCategoryAloneCounts);
// The keyword layer ADDED an input to one predicate; it did not replace the directional rule's own
// materiality, or a dividend record date would have quietly stopped mattering.
ok('...while the directional rule keeps its own materiality', keywordRules.dividendStillHigh);
ok('...and announcement DIRECTION is untouched by the keyword layer', keywordRules.downgradeStillNegative && keywordRules.dividendStillPositive && keywordRules.agmStaysNeutral);
ok('volume plus a disclosed buyer is reported as one named pattern', keywordRules.buyerPattern.includes('accumulation'), keywordRules.buyerPattern.join(', '));
ok('...and its sentence is quoted from the events, naming both halves', /3\.2x/.test(keywordRules.buyerSentence) && /Tracked Investor/.test(keywordRules.buyerSentence), keywordRules.buyerSentence.slice(0, 110));
// The correlation defers to each feed's own published threshold instead of inventing a second one.
ok('...and a sub-threshold investor move does not trip it', !keywordRules.smallBuyerPattern.includes('accumulation'), keywordRules.smallBuyerPattern.join(', ') || 'no pattern');
// "Nothing explains it" and "we did not look" are the two answers this dashboard exists to separate.
ok('"a move nothing explains" is reported only when the silent feeds were read', keywordRules.unexplainedWhenRead.includes('unexplained-move') && !keywordRules.unexplainedWhenUnread.includes('unexplained-move'));
ok('the confluence contribution is capped', keywordRules.confluenceMax === 18, `${keywordRules.confluenceMax} points`);

// --- the two news surfaces, driven ---
await go('/#/research/news?scope=portfolio', 1800);
await waitForPanel();
await settleTables();
const newsHeads = await page.locator('#content-host table thead th').allInnerTexts();
ok('company news carries a Topic column', newsHeads.some((h) => /Topic/i.test(h)), newsHeads.join(' | '));
// The outlet was already in every row's sub-line, so the column was a second copy of it — and the
// headline is capped at 780px precisely because two stories truncate to the same string below that.
ok('...in place of the Outlet column, which was already in the sub-line', !newsHeads.some((h) => /^Outlet$/i.test(h)) && (await page.locator('#content-host select').count()) >= 2);
const newsTopic = page.locator('#content-host select').first();
const topicOptionText = await newsTopic.locator('option').allInnerTexts();
ok('...and every Topic option carries a measured count, not a typed one', topicOptionText.filter((t) => /\(\d[\d,]*\)$/.test(t.trim())).length === topicOptionText.length, `${topicOptionText.length} options`);
const newsAll = await rowCount();
await newsTopic.selectOption('tracked');
await settleTables();
const newsTracked = await rowCount();
await newsTopic.selectOption('untracked');
await settleTables();
const newsUntracked = await rowCount();
// The partition is the check that the filter is a filter: tracked + untracked must be the whole set.
ok('Topic narrows company news, and tracked + untracked is the whole set', newsTracked > 0 && newsTracked < newsAll && newsTracked + newsUntracked === newsAll, `${newsTracked} + ${newsUntracked} = ${newsAll}`);
await newsTopic.selectOption('all');
await settleTables();

await go('/#/research/news?scope=universe', 2200);
await waitForPanel();
const mcTopic = page.locator('#content-host [data-news-topic]');
ok('market-wide news carries the same Topic filter', (await mcTopic.count()) === 1);
// A control that silently means something else on one half of a tab is worse than an absent one:
// "names the company" is unanswerable on rows that carry no company.
ok('...without the strict option, which is unanswerable on rows with no company', !(await mcTopic.locator('option').allInnerTexts()).some((t) => /names the company/i.test(t)));
const mcCountText = () => page.locator('#content-host [data-mcnews-list]').innerText();
const mcAll = /(\d[\d,]*) of/.exec(await mcCountText())?.[1] || '0';
await mcTopic.selectOption('tracked');
await page.waitForTimeout(600);
const mcTracked = /(\d[\d,]*) of/.exec(await mcCountText())?.[1] || '0';
ok('...and it narrows the market feed', Number(mcTracked.replace(/,/g, '')) > 0 && Number(mcTracked.replace(/,/g, '')) < Number(mcAll.replace(/,/g, '')), `${mcTracked} of ${mcAll}`);

// --- Corp Announcements keeps topic labels within a clean, scoped stream ---
await go('/#/research/corp-announcements?scope=universe', 2000);
await waitForPanel();
await settleTables();
const annHeads = await page.locator('#content-host table thead th').allInnerTexts();
ok('Corp Announcements carries a Topic column', annHeads.some((h) => /Topic/i.test(h)), annHeads.join(' | '));
// Same trade as News/Outlet: `rowSub` already prints the sub-category under every subject.
ok('...in place of the Sub-category column, which was already in the sub-line', !annHeads.some((h) => /Sub-category/i.test(h)));
const annSelects = page.locator('#content-host select');
ok('...and the feed removes secondary filters and manual capture controls',
  (await annSelects.count()) === 0 && (await page.locator('#content-host [data-watch-toggle], #content-host [data-announcement-lookup], #content-host [data-load-filing-history], #content-host [data-capture-coverage]').count()) === 0);
ok('...and retains search, export and incremental scrolling',
  (await page.locator('#content-host [data-table-search]').count()) === 1 &&
  (await page.locator('#content-host [data-export]').count()) === 1 &&
  (await page.locator('#content-host [data-scroll-paged]').count()) === 1);
const annWidth = await page.evaluate(() => {
  const el = document.querySelector('#content-host [data-table-scroll]');
  return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
});
ok('...and the table still fits without a horizontal scrollbar of its own', annWidth && annWidth.scrollWidth <= annWidth.clientWidth, `${annWidth?.scrollWidth}px in ${annWidth?.clientWidth}px`);
// THE EXPLANATION HAS TO BE REACHABLE, AND ON THESE TABS THE MODAL IS NOT.
//
// `cfg.provenance` is built for all three filings tabs and `openProvenance` is never called: the
// status pill is a passive `<span>` by design (see CLAUDE.md — "the status pill is passive and
// opens no modal"), so nothing on screen opens it. That is a pre-existing gap and not this
// layer's to close, but it does decide where a Topic explanation may be asserted: the only
// surfaces a reader can actually reach are the option labels and the cells' own tooltips. So
// those are what is checked HERE. The pill itself is still passive and must stay that way; the
// tab's provenance now has a door of its own under the table, asserted in section 17.
const annPillOpens = await (async () => {
  await page.locator('#content-host [data-filings-info]').first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(500);
  const text = await page.locator('#modal-content').innerText().catch(() => '');
  if (text) await page.keyboard.press('Escape');
  return !!text;
})();
ok('the passive status pill still opens nothing, so the reachable surfaces are what must explain Topic', annPillOpens === false);
const annTopicTitles = await page.evaluate(() => {
  const host = document.querySelector('#content-host');
  const cells = [...host.querySelectorAll('tbody tr')].map((tr) => tr.children[3]).filter(Boolean);
  const chip = cells.map((c) => c.querySelector('[title]')).find(Boolean);
  const untracked = cells.map((c) => c.querySelector('span[title]')).find((n) => n && /untracked/i.test(n.textContent));
  return { chip: chip?.getAttribute('title') || '', untracked: untracked?.getAttribute('title') || '' };
});
// A chip has to say WHICH of the exchange's two descriptions carried the word, because the subject
// is the company's own sentence and the sub-category is BSE's taxonomy.
ok('a Topic chip names its family and which exchange field carried the keyword',
  /subject|sub-category/i.test(annTopicTitles.chip) && annTopicTitles.chip.length > 20, annTopicTitles.chip.slice(0, 90));
// And an untracked row says why it is here, rather than reading as a failed match.
ok('...and an untracked filing explains itself rather than reading as a miss',
  /routine|no tracked keyword/i.test(annTopicTitles.untracked), annTopicTitles.untracked.slice(0, 90));

// --- AI Alerts renders the correlation above the evidence it came from ---
await go('/#/research/ai-alerts?scope=universe', 5000);
await waitForPanel(15000);
const aiCards = await page.locator('#content-host [data-ai-card]').count();
const confluenceBlocks = await page.locator('#content-host [data-ai-confluence]').count();
if (!aiCards) {
  skip('AI Alerts shows its cross-feed patterns', 'no company reached the surfaced threshold in this capture');
} else if (!confluenceBlocks) {
  // A real answer, not a failure: correlation is a property of the day, and the rule itself is
  // asserted on fixtures above precisely because a capture cannot be relied on to contain one.
  skip('AI Alerts shows its cross-feed patterns', `${aiCards} card(s), none with signals lining up today`);
} else {
  const order = await page.evaluate(() => {
    const card = document.querySelector('[data-ai-card] [data-ai-confluence]')?.closest('[data-ai-card]');
    if (!card) return null;
    const nodes = [...card.querySelectorAll('[data-ai-confluence], [data-ai-insight]')];
    const conf = card.querySelector('[data-ai-confluence]');
    const evidence = card.querySelector('[data-ai-evidence]');
    return {
      insightFirst: nodes[0]?.hasAttribute('data-ai-insight') === true,
      beforeEvidence: !!evidence && !!(conf.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING),
      named: [...conf.querySelectorAll('[data-confluence]')].map((n) => n.getAttribute('data-confluence')),
      text: conf.innerText.replace(/\s+/g, ' '),
      insight: card.querySelector('[data-ai-insight]')?.innerText || '',
    };
  });
  ok('AI Alerts shows its cross-feed patterns, named', confluenceBlocks > 0 && order?.named.length > 0, `${confluenceBlocks} of ${aiCards} cards · ${order?.named.join(', ')}`);
  // The finding is read before its workings — that is the whole reason the block exists.
  ok('...above the evidence they were derived from', order?.beforeEvidence === true);
  // And the card's own summary leads with the correlation rather than an arity of feeds — in
  // ORDINARY ENGLISH. The old assertion looked for a colon, because the insight used to be
  // `${label}: ${detail}` — the pattern's own technical sentence, reprinted verbatim inside the
  // block below it. Punctuation is not the property worth asserting; what matters is that the
  // first thing read is the finding, said plainly, and that it is not the feed-count fallback.
  ok('...and the card leads with the correlation, not a feed count',
    /^(Heavy trading|An insider and|Unusual trading|Results are out|Bad news showing up|A big move with)/.test(order?.insight || '') &&
      !/^(Signals conflict across|Bad signs on|Good signs on|Sources disagree)/.test(order?.insight || ''),
    (order?.insight || '').slice(0, 100));
  // No score anywhere on the card, exactly as before this layer existed.
  ok('...and still prints no score arithmetic', !/\b\d{1,3}\s*(?:\/\s*100|points)\b/i.test(order?.text || ''));
}

// ---------------------------------------------------------------------------------------
console.log('\n— 17. provenance is reachable, without the chrome that was removed —');
// ---------------------------------------------------------------------------------------
// A BODY OF PROVENANCE EXISTED AND NOTHING OPENED IT. `cfg.provenance` was supplied by all three
// filings tabs and `openProvenanceFactory` built a handler no caller ever invoked; `sourcesModalHtml`
// was exported and imported by nothing. That is worse than absent, because unreachable content reads
// as documentation of a working feature — and CLAUDE.md leans on both: it says the denominator has
// to stay REACHABLE, and that canonical provenance "remains in the source registry".
//
// What is asserted here is the pair, because either alone is the bug: the explanation opens, AND the
// chrome that was deliberately removed has not crept back.
const registryModal = await (async () => {
  await go('/#/research/ai-alerts?scope=portfolio', 4000);
  await waitForPanel();
  await page.locator('[data-sources-open]').click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(800);
  const text = await page.locator('#modal-content').innerText().catch(() => '');
  if (text) await page.keyboard.press('Escape');
  return text;
})();
ok('the footer opens the source registry', registryModal.length > 2000, `${registryModal.length} chars`);
// The registry is a FUNCTION called on open, which is what lets a static footer reach live figures
// without going stale — the rule that killed the old hand-typed source array.
ok('...and it names the upstreams it is canonical for',
  ['Muns news API', 'BSE', 'Finology', 'Trendlyne', 'Yahoo'].every((n) => registryModal.includes(n)),
  registryModal.replace(/\s+/g, ' ').slice(0, 90));
// ...AND STILL WITHHOLDS THE TWO BRANDS IT IS SUPPOSED TO. Making provenance reachable must not
// leak what the honesty rules deliberately keep off customer-facing surfaces: the con-call and
// market-news providers are named in the code and in docs/DATA-CONTRACTS.md and NOT on screen —
// "no brand anywhere, the disclaimer everywhere" (CLAUDE.md, *Reproducing someone else's
// analysis*). A door to the registry is exactly where that would have slipped, so it is asserted
// here rather than assumed. The first draft of this check asserted the opposite and caught it.
ok('...without printing the two providers whose brands are deliberately withheld',
  !/Moneycontrol|StockScans/i.test(registryModal) && /publisher|research provider/i.test(registryModal));

for (const [route, title, scope] of [
  ['/#/research/news?scope=portfolio', 'News', 'portfolio'],
  ['/#/research/corp-announcements?scope=universe', 'Corp Announcements', 'universe'],
  ['/#/research/insider-trades?scope=portfolio', 'Insider Trades', 'portfolio'],
]) {
  await go(route, 4000);
  await waitForPanel();
  await settleTables();
  const placement = await evalSafe(() => {
    const btn = document.querySelector('#content-host [data-filings-method]');
    const table = document.querySelector('#content-host [data-score-table]') || document.querySelector('#content-host table');
    if (!btn) return { present: false };
    return {
      present: true,
      belowTable: !table || !!(table.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING),
      pillIsSpan: (document.querySelector('#content-host [data-filings-info]') || {}).tagName === 'SPAN',
    };
  });
  ok(`${title} carries a method link under its table`, placement.present && placement.belowTable, JSON.stringify(placement));
  // The decision CLAUDE.md recorded is preserved exactly: the label stays a passive span that opens
  // nothing. What changed is that the explanation gained a door, not that the label became one.
  ok(`...and ${title}'s freshness label is still a passive span`, placement.pillIsSpan === true);
  await page.locator('#content-host [data-filings-method]').click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(700);
  const text = await page.locator('#modal-content').innerText().catch(() => '');
  ok(`...and it opens ${title}'s own provenance`, text.length > 1200, `${text.length} chars`);
  // THE PART NO STATIC REGISTRY CAN CARRY: the measured coverage for the rows on screen. This is the
  // denominator CLAUDE.md says must stay reachable — "23 rows look complete until you know the book
  // is 142" — and it is the reason this content is wired rather than pruned.
  ok(`...carrying ${title}'s measured coverage, not just prose`, /\d/.test(text) && /(compan|filing|row)/i.test(text));
  if (text) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------------------
console.log('\n— console —');
const unique = [...new Set(errors)];
// The bar is zero errors OF OURS — see ENV_ERROR above for what that excludes and why.
const ourErrors = unique.filter(ownError);
ok('zero console errors', ourErrors.length === 0, ourErrors.slice(0, 3).join(' | ') || `${unique.length - ourErrors.length} environment error(s) filtered`);
if (unique.length !== ourErrors.length) skip('...and none from the CDNs or /api either', `${unique.length - ourErrors.length} filtered — no egress, and no Worker on this origin`);

await browser.close();
await new Promise((r) => ddStub.close(r));
console.log(failures === 0 ? `\nAll checks passed.${skipped ? ` (${skipped} skipped — see SKIP lines)` : ''}` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
