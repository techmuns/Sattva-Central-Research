#!/usr/bin/env node
// Authenticated Screener company Insights -> immutable Actions artifact. A full first pass covers
// the NSE-500 universe plus the exact S Screen portfolio; daily passes refresh every portfolio
// company and one seventh of the remaining universe so the source is treated gently.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScreenerInsightsPage } from './lib/screener-insights.mjs';
import { parseWatchlistExport } from './lib/screener-watchlist.mjs';
import {
  mergeScreenerInsightsCapture,
  safeInsightUrl,
  SCREENER_INSIGHTS_COMPRESSED_LIMIT,
  SCREENER_INSIGHTS_ID,
  SCREENER_INSIGHTS_LIMIT,
  screenerInsightKey,
} from '../public/js/data/screener-insights-shared.js';
import { readScreenerInsightsCollector } from '../worker/screener-insights-collector.mjs';
import {
  SCREENER_PORTFOLIO_WATCHLIST_ID,
  SCREENER_PORTFOLIO_WATCHLIST_NAME,
} from './lib/screener-upcoming.mjs';

const output = process.argv[2];
if (!output) throw Error('Provide a staging artifact output path');
const ORIGIN = 'https://www.screener.in';
const WATCHLIST = `${ORIGIN}/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 3;
let stage = 'configuration';
let browser;

const readData = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

function identity(url) {
  const safe = safeInsightUrl(url, { screener: true });
  if (!safe) return null;
  const parsed = new URL(safe);
  const match = /^\/company\/([^/]+)\/(?:consolidated\/)?$/.exec(parsed.pathname);
  if (!match) return null;
  const companyKey = decodeURIComponent(match[1]).toUpperCase();
  return {
    companyKey,
    ticker: /^\d+$/.test(companyKey) || !/^[A-Z0-9&-]{1,30}$/.test(companyKey) ? null : companyKey,
    companyUrl: `${ORIGIN}/company/${encodeURIComponent(companyKey)}/`,
  };
}

function hashBucket(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 7;
}

async function readPrevious() {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'main';
  return (await readScreenerInsightsCollector({
    token: process.env.GH_TOKEN,
    ref,
    allowMissing: true,
    signal: AbortSignal.timeout(45_000),
  }))?.capture || null;
}

async function exportPortfolioTargets(page, portfolioByIsin) {
  const response = await page.goto(WATCHLIST, { waitUntil: 'domcontentloaded' });
  if (!response?.ok() || new URL(page.url()).pathname !== `/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/` ||
      !(await page.getByText(SCREENER_PORTFOLIO_WATCHLIST_NAME, { exact: true }).count())) throw Error('S Screen watchlist identity could not be verified');
  const form = page.locator('form[action^="/api/export/screen/"]').first();
  const action = await form.getAttribute('action');
  const exportUrl = new URL(action || '', ORIGIN);
  if (exportUrl.searchParams.get('sublist_id') !== SCREENER_PORTFOLIO_WATCHLIST_ID) throw Error('Unexpected watchlist export target');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    form.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  if (await download.failure()) throw Error('Watchlist export download failed');
  const chunks = [];
  const stream = await download.createReadStream();
  for await (const chunk of stream) chunks.push(chunk);
  await download.delete().catch(() => {});
  const records = parseWatchlistExport(Buffer.concat(chunks));
  const targets = records.map((record) => {
    const known = portfolioByIsin.get(record.isin);
    const companyKey = record.nseCode || known?.ticker || record.bseCode;
    const name = record.name || known?.bookName || known?.name;
    return companyKey ? { ...identity(`${ORIGIN}/company/${encodeURIComponent(companyKey)}/`), name, inUniverse: false, inPortfolio: true } : null;
  }).filter((row) => row?.companyKey && row.name);
  if (!records.length || targets.length !== records.length || new Set(targets.map((row) => row.companyKey)).size !== targets.length) {
    throw Error('S Screen export could not be mapped completely');
  }
  return targets;
}

async function main() {
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw Error('Missing collector configuration');

  stage = 'previous capture restore';
  const previous = await readPrevious();
  const forceFull = process.env.SCREENER_FULL_REFRESH === 'true';

  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.GH_TOKEN;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  stage = 'browser startup';
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const loginPage = await context.newPage();
  loginPage.setDefaultTimeout(30_000);
  loginPage.setDefaultNavigationTimeout(45_000);

  stage = 'Screener login';
  const login = await loginPage.goto(`${ORIGIN}/login/?next=${encodeURIComponent(`/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`)}`, { waitUntil: 'domcontentloaded' });
  if (!login?.ok()) throw Error('Login page unavailable');
  const form = loginPage.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    loginPage.waitForURL((url) => url.origin === ORIGIN && url.pathname === `/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`, { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  const hasSession = (await context.cookies(ORIGIN)).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  if (!hasSession || !(await loginPage.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw Error('Authentication not verified');

  stage = 'target inventory';
  const universeTargets = readData('universe').map((row) => ({ ...identity(row['Screener URL']), name: row.Company, inUniverse: true, inPortfolio: false })).filter((row) => row.companyKey);
  const portfolioByIsin = new Map((readData('portfolio-companies').holdings || []).map((holding) => [holding.isin, holding]));
  // Use Screener's own full export instead of links rendered on the dashboard page: the latter can
  // be paginated and would silently turn "portfolio coverage" into "first page coverage".
  const watchlistTargets = await exportPortfolioTargets(loginPage, portfolioByIsin);
  const targets = new Map();
  for (const item of [...universeTargets, ...watchlistTargets]) {
    const old = targets.get(item.companyKey);
    targets.set(item.companyKey, { ...old, ...item, name: old?.name || item.name, inUniverse: !!(old?.inUniverse || item.inUniverse), inPortfolio: !!(old?.inPortfolio || item.inPortfolio) });
  }
  if (targets.size < universeTargets.length || watchlistTargets.length < 1) throw Error('Screener Insights target inventory is incomplete');

  const checkedAt = new Date().toISOString();
  const previousAge = Date.now() - Date.parse(previous?.checkedAt || '');
  const full = forceFull || !previous || !previous.fullCoverage || !Number.isFinite(previousAge) || previousAge > 8 * 86_400_000;
  const bucket = Math.floor(Date.now() / 86_400_000) % 7;
  const selected = [...targets.values()].filter((item) => full || item.inPortfolio || hashBucket(item.companyKey) === bucket);
  const succeeded = [];
  let failedCount = 0;
  let cursor = 0;

  stage = full ? 'full Insights crawl' : 'incremental Insights crawl';
  const worker = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);
    try {
      while (cursor < selected.length) {
        const item = selected[cursor++];
        let success = false;
        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          try {
            const response = await page.goto(item.companyUrl, { waitUntil: 'domcontentloaded' });
            const final = new URL(page.url());
            if (!response?.ok() || final.origin !== ORIGIN || final.pathname !== new URL(item.companyUrl).pathname) throw Error('response');
            const section = page.locator('#insights');
            if (await section.count()) {
              const quarterly = section.locator('[data-tab-id="quarterly-insights"]');
              if (await quarterly.count()) {
                if (await quarterly.getAttribute('data-loaded') !== 'true') await quarterly.click();
                await section.locator('#quarterly-insights table').waitFor({ state: 'attached', timeout: 12_000 }).catch(() => {});
              }
            }
            const html = await page.content();
            if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw Error('oversized');
            const parsed = parseScreenerInsightsPage(html);
            const rows = parsed.rows.map((row) => ({ ...row, id: screenerInsightKey({ companyKey: item.companyKey, ...row }) }));
            succeeded.push({ ...item, checkedAt, rows });
            success = true;
          } catch {
            if (attempt === 2) failedCount += 1;
            else await page.waitForTimeout(600);
          }
        }
        await page.waitForTimeout(140);
      }
    } finally {
      await page.close();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

  stage = 'capture validation';
  const targetKeys = [...targets.keys()].sort();
  const current = {
    version: 1,
    sourceId: SCREENER_INSIGHTS_ID,
    checkedAt,
    targetCount: targetKeys.length,
    checkedCount: selected.length,
    failedCount,
    fullCoverage: full && failedCount === 0 && succeeded.length === targetKeys.length,
    targetKeys,
    companies: succeeded,
  };
  const capture = mergeScreenerInsightsCapture(current, previous);
  const json = JSON.stringify(capture);
  const bytes = gzipSync(json);
  if (Buffer.byteLength(json) > SCREENER_INSIGHTS_LIMIT || bytes.length > SCREENER_INSIGHTS_COMPRESSED_LIMIT) throw Error('Screener Insights capture exceeds artifact limits');

  stage = 'artifact write';
  writeFileSync(output, bytes);
  console.log(JSON.stringify({ checkedAt, targets: targetKeys.length, checked: selected.length, succeeded: succeeded.length, failed: failedCount, companies: capture.companies.length, metrics: capture.companies.reduce((sum, company) => sum + company.rows.length, 0), fullCoverage: capture.fullCoverage, bytes: bytes.length }));
}

try {
  await main();
} catch {
  console.error(`Screener Insights collection failed during ${stage}. No credentials, company names, URLs or page content were logged.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
