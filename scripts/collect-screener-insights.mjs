#!/usr/bin/env node
// Authenticated Insights -> resumable immutable checkpoints, one due company at a time.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScreenerInsightsPage } from './lib/screener-insights.mjs';
import { parseWatchlistExport } from './lib/screener-watchlist.mjs';
import { buildInsightInventory, insightInventoryDiagnostic } from './lib/screener-insights-inventory.mjs';
import { runInsightCollection } from './lib/screener-insights-run.mjs';
import { insightError, insightResponseError, insightFailureCode } from './lib/screener-insights-control.mjs';
import { INSIGHTS_STATE_LIMIT, validateInsightState } from '../public/js/data/screener-insights-state.js';
import {
  SCREENER_INSIGHTS_COMPRESSED_LIMIT,
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
const stateOutput = process.argv[3];
const ORIGIN = 'https://www.screener.in';
const WATCHLIST = `${ORIGIN}/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const COLLECTION_BUDGET_MS = 10 * 60_000;
let stage = 'configuration';
let browser;
let inventoryInputs;

const readData = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

async function readPrevious() {
  if (process.env.GITHUB_ACTIONS !== 'true') return { capture: null, state: null };
  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'main';
  return readScreenerInsightsCollector({
    token: process.env.GH_TOKEN,
    ref,
    allowMissing: true,
    signal: AbortSignal.timeout(45_000),
  });
}

function checkResponse(response) {
  if (!response) throw insightError('navigation');
  const error = insightResponseError(response.status(), response.headers()['retry-after']);
  if (error) throw error;
  if (new URL(response.url()).pathname.startsWith('/login/')) throw insightError('session-expired');
}

function writeCheckpoint(path, value, rawLimit, compressedLimit) {
  const json = JSON.stringify(value);
  const bytes = gzipSync(json);
  if (Buffer.byteLength(json) > rawLimit || bytes.length > compressedLimit) throw insightError('oversized');
  writeFileSync(`${path}.pending`, bytes);
  renameSync(`${path}.pending`, path);
}

export async function exportPortfolioTargets(page) {
  stage = 'watchlist identity verification';
  const response = await page.goto(WATCHLIST, { waitUntil: 'domcontentloaded' });
  checkResponse(response);
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
    (async () => {
      const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === exportUrl.href);
      const [response] = await Promise.all([responsePromise, form.locator('button[type="submit"], input[type="submit"]').first().click()]);
      checkResponse(response);
    })(),
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
  checkResponse(manage);
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

export async function readInsightCompany(page, item, checkedAt, { tabTimeout = 12_000, previousCompany = null, quarterPauseMs = 1_000 } = {}) {
  if (item.unresolved) throw Error('Company page identity is unresolved');
  const response = await page.goto(item.companyUrl, { waitUntil: 'domcontentloaded' }).catch(() => { throw insightError('navigation'); });
  const final = new URL(page.url());
  checkResponse(response);
  if (final.origin !== ORIGIN || screenerInsightIdentity(final.href)?.companyKey !== item.companyKey) throw insightError('identity');
  if (!(await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw insightError('session-expired');
  const section = page.locator('#insights');
  if (await section.count()) {
    const quarterly = section.locator('[data-tab-id="quarterly-insights"]');
    if (await quarterly.count()) {
      if (await quarterly.getAttribute('data-loaded') !== 'true') {
        const target = await quarterly.getAttribute('data-url');
        if (!target || new URL(target, ORIGIN).origin !== ORIGIN) throw insightError('structure-changed');
        const quarterUrl = new URL(target, ORIGIN).href;
        await page.waitForTimeout(quarterPauseMs);
        const responsePromise = page.waitForResponse(response => (response.url() === quarterUrl || response.request().redirectedFrom()?.url() === quarterUrl) && !(response.status() >= 300 && response.status() < 400),
          { timeout: tabTimeout });
        // Observe the lazy request itself: a 429/403 must not be mislabeled a table timeout.
        const [quarterResponse] = await Promise.all([responsePromise, quarterly.click()]);
        checkResponse(quarterResponse);
      }
      // A lazy-tab timeout is a failed company read, never an empty quarterly series.
      await section.locator('#quarterly-insights table').waitFor({ state: 'attached', timeout: tabTimeout }).catch(() => { throw insightError('structure-changed'); });
    }
  }
  const html = await page.content();
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw insightError('oversized');
  let parsed;
  try { parsed = parseScreenerInsightsPage(html); } catch { throw insightError('structure-changed'); }
  const rows = parsed.rows.map((row) => ({ ...row, id: screenerInsightKey({ companyKey: item.companyKey, ...row }) }));
  if (!rows.length && previousCompany?.rows?.length) throw insightError('structure-changed');
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

async function openSession(username, password) {
  if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw insightError('configuration');
  stage = 'browser startup';
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const loginPage = await context.newPage();
  loginPage.setDefaultTimeout(30_000);
  loginPage.setDefaultNavigationTimeout(45_000);

  stage = 'Screener login';
  const login = await loginPage.goto(`${ORIGIN}/login/?next=${encodeURIComponent(`/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`)}`, { waitUntil: 'domcontentloaded' });
  const loginError = insightResponseError(login?.status() || 0, login?.headers()['retry-after']);
  if (loginError) throw loginError;
  const form = loginPage.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  const [posted] = await Promise.all([
    loginPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/login/'),
    form.locator('button[type="submit"]').click(),
  ]);
  const postedError = insightResponseError(posted.status(), posted.headers()['retry-after']);
  if (postedError) throw postedError;
  await loginPage.waitForURL(url => url.origin === ORIGIN && url.pathname === `/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`,
    { waitUntil: 'domcontentloaded' }).catch(() => { throw insightError('session-expired'); });
  const hasSession = (await context.cookies(ORIGIN)).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  if (!hasSession || !(await loginPage.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw insightError('session-expired');
  return { context, loginPage };
}

async function main() {
  if (!output || !stateOutput) throw insightError('configuration');
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  let previous;
  const result = await runInsightCollection({
    restore: async () => {
      stage = 'previous capture and cooldown restore';
      try { const restored = await readPrevious(); previous = restored.capture; return restored; }
      finally { delete process.env.GH_TOKEN; }
    },
    openSession: () => openSession(username, password),
    inventory: async ({ loginPage }) => {
      stage = 'target inventory';
      try {
        const { records, manageRows } = await exportPortfolioTargets(loginPage);
        stage = 'target identity reconciliation';
        const universe = readData('universe');
        inventoryInputs = { universe, records, manageRows };
        const targets = buildInsightInventory(universe, records, manageRows, { previousCompanies: previous?.companies || [] });
        inventoryInputs = undefined;
        return [...targets.values()];
      } catch (error) {
        if (stage === 'target identity reconciliation') console.error(JSON.stringify(insightInventoryDiagnostic(error, inventoryInputs)));
        throw error?.insightCode ? error : insightError('inventory');
      }
    },
    readCompany: ({ context }, item, checkedAt, options) => readInsightCompanyAttempt(context, item, checkedAt, options),
    publishCapture: capture => writeCheckpoint(output, capture, SCREENER_INSIGHTS_LIMIT, SCREENER_INSIGHTS_COMPRESSED_LIMIT),
    publishState: state => writeCheckpoint(stateOutput, validateInsightState(state), INSIGHTS_STATE_LIMIT, INSIGHTS_STATE_LIMIT),
    batchOptions: { maxDurationMs: COLLECTION_BUDGET_MS },
    onProgress: progress => console.log(JSON.stringify({ stage: 'crawl-progress', ...progress })),
  });
  console.log(JSON.stringify({ stage: 'collection-result', skipped: result.skipped, outcome: result.state.outcome,
    reason: result.state.reason, cooldownUntil: result.state.cooldownUntil, ...result.state.counts,
    companies: result.capture?.companies.length || 0, fullCoverage: result.capture?.fullCoverage || false }));
  if (!result.skipped && ['blocked', 'failed'].includes(result.state.outcome)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    if (stage === 'target identity reconciliation') console.error(JSON.stringify(insightInventoryDiagnostic(error, inventoryInputs)));
    console.error(JSON.stringify({ stage, reason: insightFailureCode(error), outcome: 'failed' }));
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}
