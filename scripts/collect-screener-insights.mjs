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
import { buildInsightInventory, insightInventoryDiagnostic, splitInsightReadTargets } from './lib/screener-insights-inventory.mjs';
import { collectInsightBatch, orderInsightTargets } from './lib/screener-insights-batch.mjs';
import {
  mergeScreenerInsightsCapture,
  SCREENER_INSIGHTS_COMPRESSED_LIMIT,
  SCREENER_INSIGHTS_ID,
  SCREENER_INSIGHTS_LIMIT,
  screenerInsightKey,
  screenerInsightIdentity,
  validateScreenerInsightCompanies,
} from '../public/js/data/screener-insights-shared.js';
import { readScreenerInsightsCollector } from '../worker/screener-insights-collector.mjs';
import {
  SCREENER_PORTFOLIO_WATCHLIST_ID,
  SCREENER_PORTFOLIO_WATCHLIST_NAME,
} from './lib/screener-upcoming.mjs';

const output = process.argv[2];
const ORIGIN = 'https://www.screener.in';
const WATCHLIST = `${ORIGIN}/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 3;
const COLLECTION_BUDGET_MS = 10 * 60_000;
let stage = 'configuration';
let browser;
let inventoryInputs;

const readData = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

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

export async function exportPortfolioTargets(page) {
  stage = 'watchlist identity verification';
  const response = await page.goto(WATCHLIST, { waitUntil: 'domcontentloaded' });
  if (!response?.ok() || new URL(page.url()).pathname !== `/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/` ||
      !(await page.getByText(SCREENER_PORTFOLIO_WATCHLIST_NAME, { exact: true }).count())) throw Error('S Screen watchlist identity could not be verified');
  const form = page.locator('form[action^="/api/export/screen/"]').first();
  stage = 'watchlist export discovery';
  const action = await form.getAttribute('action');
  const exportUrl = new URL(action || '', ORIGIN);
  if (exportUrl.searchParams.get('sublist_id') !== SCREENER_PORTFOLIO_WATCHLIST_ID) throw Error('Unexpected watchlist export target');
  stage = 'watchlist export download';
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    form.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  if (await download.failure()) throw Error('Watchlist export download failed');
  const chunks = [];
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_PAGE_BYTES) throw Error('Watchlist export exceeds its limit');
    chunks.push(chunk);
  }
  await download.delete().catch(() => {});
  stage = 'watchlist export parsing';
  const records = parseWatchlistExport(Buffer.concat(chunks));
  // The full export determines membership. The verified management page supplies URLs for
  // delisted/internal-ID companies whose export legitimately has no exchange code.
  stage = 'watchlist company URL inventory';
  const managePath = `/user/stocks/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`;
  const manage = await page.goto(`${ORIGIN}${managePath}`, { waitUntil: 'domcontentloaded' });
  if (!manage?.ok() || page.url() !== `${ORIGIN}${managePath}` ||
      (await page.locator('h1').first().textContent())?.trim() !== `Add companies to ${SCREENER_PORTFOLIO_WATCHLIST_NAME}`) throw Error('Watchlist URL inventory identity failed');
  const manageRows = await page.locator('button[onclick*="Watchlist.removeCompany"]').evaluateAll((buttons) => buttons.map((button) => {
    const container = button.closest('li, tr') || button.parentElement;
    const link = container?.querySelector('a[href^="/company/"]');
    // Current Screener markup uses a span, not a company link. Read the public ID from
    // the control's attribute only; never evaluate its handler or click the control.
    const companyId = /removeCompany\(['"](\d+)['"]\)/.exec(button.getAttribute('onclick') || '')?.[1] || '';
    const name = (link?.textContent || container?.querySelector('.shrink-text')?.textContent || '').trim();
    return { companyId, href: link?.getAttribute('href') || '', name };
  }));
  if (manageRows.length !== records.length) throw Error('Watchlist URL inventory count mismatch');
  return { records, manageRows };
}

export async function readInsightCompany(page, item, checkedAt, { tabTimeout = 12_000, previousCompany = null } = {}) {
  if (item.unresolved) throw Error('Company page identity is unresolved');
  const response = await page.goto(item.companyUrl, { waitUntil: 'domcontentloaded' });
  const final = new URL(page.url());
  if ([401, 403, 429].includes(response?.status())) throw Error('source-blocked');
  if (final.origin === ORIGIN && final.pathname.startsWith('/login/')) throw Error('session');
  if (!response?.ok() || final.origin !== ORIGIN || screenerInsightIdentity(final.href)?.companyKey !== item.companyKey) throw Error('response');
  if (!(await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw Error('session');
  const section = page.locator('#insights');
  if (await section.count()) {
    const quarterly = section.locator('[data-tab-id="quarterly-insights"]');
    if (await quarterly.count()) {
      if (await quarterly.getAttribute('data-loaded') !== 'true') await quarterly.click();
      // A lazy-tab timeout is a failed company read, never an empty quarterly series.
      await section.locator('#quarterly-insights table').waitFor({ state: 'attached', timeout: tabTimeout });
    }
  }
  const html = await page.content();
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw Error('oversized');
  const parsed = parseScreenerInsightsPage(html);
  const rows = parsed.rows.map((row) => ({ ...row, id: screenerInsightKey({ companyKey: item.companyKey, ...row }) }));
  if (!rows.length && previousCompany?.rows?.length) throw Error('Previously captured Insights disappeared');
  const company = { ...item, checkedAt, readStatus: 'ok', rows };
  validateScreenerInsightCompanies([company]);
  return company;
}

export async function readInsightCompanyAttempt(context, item, checkedAt, { signal, previousCompany = null } = {}) {
  signal.throwIfAborted();
  const page = await context.newPage();
  const close = () => { void page.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(12_000);
    return await readInsightCompany(page, item, checkedAt, { previousCompany, tabTimeout: 8_000 });
  } finally {
    signal.removeEventListener('abort', close);
    await page.close().catch(() => {});
  }
}

async function main() {
  const startedAt = Date.now();
  if (!output) throw Error('Provide a staging artifact output path');
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
  // Use Screener's own full export instead of links rendered on the dashboard page: the latter can
  // be paginated and would silently turn "portfolio coverage" into "first page coverage".
  const { records, manageRows } = await exportPortfolioTargets(loginPage);
  stage = 'target identity reconciliation';
  const universe = readData('universe');
  inventoryInputs = { universe, records, manageRows };
  const targets = buildInsightInventory(universe, records, manageRows, { previousCompanies: previous?.companies || [] });
  inventoryInputs = undefined;

  const checkedAt = new Date().toISOString();
  const previousAge = Date.now() - Date.parse(previous?.checkedAt || '');
  const full = forceFull || !previous || !previous.fullCoverage || !Number.isFinite(previousAge) || previousAge > 8 * 86_400_000;
  const bucket = Math.floor(Date.now() / 86_400_000) % 7;
  const selected = orderInsightTargets([...targets.values()].filter((item) => full || item.inPortfolio || hashBucket(item.companyKey) === bucket), previous);
  const { readable, unresolvedKeys } = splitInsightReadTargets(selected);
  const previousByKey = new Map((previous?.companies || []).map((company) => [company.companyKey, company]));

  stage = full ? 'full Insights crawl' : 'incremental Insights crawl';
  const batch = await collectInsightBatch(readable, (item, { signal }) => readInsightCompanyAttempt(context, item, checkedAt,
    { signal, previousCompany: previousByKey.get(item.companyKey) }), {
    concurrency: CONCURRENCY,
    maxDurationMs: Math.max(1, COLLECTION_BUDGET_MS - (Date.now() - startedAt)),
    onProgress: progress => console.log(JSON.stringify({ stage: 'crawl-progress', unresolved: unresolvedKeys.length, ...progress })),
  });
  const { succeeded, deferredKeys } = batch;
  const failedKeys = [...unresolvedKeys, ...batch.failedKeys];
  const failedCount = failedKeys.length;

  stage = 'capture validation';
  if (!succeeded.length) throw Error('No company could be checked');
  const targetKeys = [...targets.keys()].sort();
  const current = {
    version: 1,
    sourceId: SCREENER_INSIGHTS_ID,
    checkedAt,
    targetCount: targetKeys.length,
    checkedCount: batch.attemptedCount + unresolvedKeys.length,
    failedCount,
    failedKeys,
    deferredCount: deferredKeys.length,
    deferredKeys,
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
  console.log(JSON.stringify({ checkedAt, targets: targetKeys.length, checked: current.checkedCount, succeeded: succeeded.length, failed: failedCount, deferred: deferredKeys.length, deadlineReached: batch.deadlineReached, sourceBlocked: batch.sourceBlocked, unresolved: unresolvedKeys.length, companies: capture.companies.length, metrics: capture.companies.reduce((sum, company) => sum + company.rows.length, 0), fullCoverage: capture.fullCoverage, bytes: bytes.length }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    if (stage === 'target identity reconciliation') console.error(JSON.stringify(insightInventoryDiagnostic(error, inventoryInputs)));
    console.error(`Screener Insights collection failed during ${stage}. No credentials, company names, URLs or page content were logged.`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}
