#!/usr/bin/env node
// Authenticated Screener read -> immutable Actions artifact. No cookies, credentials, HTML or
// account details are logged or written; the only output is the validated public concall index.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';
import { addResolvedTickers, parseScreenerConcallPage, SCREENER_CONCALL_URL } from './lib/screener-concalls.mjs';
import {
  parseScreenerUpcomingPage,
  SCREENER_PORTFOLIO_DASHBOARD,
  SCREENER_PORTFOLIO_WATCHLIST_ID,
  SCREENER_PORTFOLIO_WATCHLIST_NAME,
} from './lib/screener-upcoming.mjs';
import {
  mergeScreenerConcallCapture,
  mergeScreenerConcallRows,
  SCREENER_CONCALL_COMPRESSED_LIMIT,
  SCREENER_CONCALL_ID,
  SCREENER_CONCALL_LIMIT,
  screenerConcallKey,
} from '../public/js/data/screener-concalls-shared.js';
import { readScreenerConcallCollector } from '../worker/screener-concalls-collector.mjs';

const output = process.argv[2];
if (!output) throw Error('Provide a staging artifact output path');
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
let stage = 'configuration';
let browser;
let failurePage = null;
let failureCode = null;

function collectionError(code) {
  const error = new Error('Screener concall page rejected');
  error.collectionCode = code;
  return error;
}

const readData = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

async function readPrevious() {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'main';
  return (
    await readScreenerConcallCollector({
      token: process.env.GH_TOKEN,
      ref,
      allowMissing: true,
      signal: AbortSignal.timeout(45000),
    })
  )?.capture || null;
}

async function main() {
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw Error('Missing collector configuration');

  stage = 'previous capture restore';
  const previous = await readPrevious();
  const forceFull = process.env.SCREENER_FULL_REFRESH === 'true';

  // Chromium and publisher requests do not need GitHub or Screener secrets in their environment.
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.GH_TOKEN;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  stage = 'browser startup';
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);

  stage = 'Screener login';
  const login = await page.goto(`https://www.screener.in/login/?next=${encodeURIComponent('/concalls/')}`, { waitUntil: 'domcontentloaded' });
  if (!login?.ok()) throw Error('Login page unavailable');
  const form = page.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.origin === 'https://www.screener.in' && url.pathname === '/concalls/', { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  const hasSession = (await context.cookies('https://www.screener.in')).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  const hasLogout = (await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count()) > 0;
  if (!hasSession || !hasLogout) throw Error('Authentication not verified');

  stage = 'first page';
  const first = parseScreenerConcallPage(await page.content());
  const oldIds = new Set((previous?.rows || []).map(screenerConcallKey));
  const firstIsKnown = first.rows.every((row) => oldIds.has(screenerConcallKey(row)));
  const countMovedWithoutANewHead = !!previous && first.publishedTotal !== previous.publishedTotal && firstIsKnown;
  const full = forceFull || !previous?.fullHistory || first.publishedTotal < (previous?.publishedTotal || 0) || countMovedWithoutANewHead;
  const collected = [...first.rows];
  let pagesFetched = 1;

  const readPage = async (number) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Use the authenticated browser page itself. A separate API-style request changes the
        // browser fingerprint and can be refused even though it shares the same session cookie.
        // Sequential navigation is also deliberately gentle: this daily audit is not urgent.
        const response = await page.goto(`${SCREENER_CONCALL_URL}?p=${number}`, { waitUntil: 'domcontentloaded' }).catch(() => {
          throw collectionError('navigation');
        });
        const finalUrl = new URL(page.url());
        if (!response?.ok()) throw collectionError('response');
        if (finalUrl.origin !== 'https://www.screener.in' || finalUrl.pathname !== '/concalls/') throw collectionError('session');
        const html = await page.content();
        if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw collectionError('oversized');
        let parsed;
        try {
          parsed = parseScreenerConcallPage(html);
        } catch {
          throw collectionError('shape');
        }
        if (parsed.publishedTotal !== first.publishedTotal || parsed.lastPage !== first.lastPage) throw collectionError('pagination');
        await page.waitForTimeout(120);
        return parsed.rows;
      } catch (error) {
        if (attempt === 3) {
          failurePage = number;
          failureCode = ['navigation', 'response', 'session', 'oversized', 'shape', 'pagination'].includes(error?.collectionCode)
            ? error.collectionCode
            : 'browser';
          throw error;
        }
        await page.waitForTimeout(500 * attempt);
      }
    }
    throw Error('Screener concall page unavailable');
  };

  if (full) {
    stage = 'full history crawl';
    for (let pageNumber = 2; pageNumber <= first.lastPage; pageNumber++) {
      collected.push(...(await readPage(pageNumber)));
      pagesFetched++;
    }
  } else if (!firstIsKnown) {
    stage = 'incremental crawl';
    for (let pageNumber = 2; pageNumber <= first.lastPage; pageNumber++) {
      const rows = await readPage(pageNumber);
      collected.push(...rows);
      pagesFetched++;
      if (rows.every((row) => oldIds.has(screenerConcallKey(row)))) break;
    }
  }

  stage = 'ticker resolution';
  const index = buildIndex({ mc: readData('mc-ticker-map'), tech: readData('technicals'), book: readData('portfolio-companies') });
  const unique = mergeScreenerConcallRows(collected);
  const resolved = addResolvedTickers(unique, (name) => resolveTicker(index, name).ticker);
  const duplicatesRemoved = collected.length - unique.length;
  if (full && collected.length !== first.publishedTotal) throw Error('Screener full history count mismatch');

  stage = 'portfolio calendar capture';
  const checkedAt = new Date().toISOString();
  const dashboard = await page.goto(SCREENER_PORTFOLIO_DASHBOARD, { waitUntil: 'domcontentloaded' });
  const dashboardUrl = new URL(page.url());
  const watchlistLink = page.locator(`a[href^="/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/"]`);
  const namedWatchlist = page.getByText(SCREENER_PORTFOLIO_WATCHLIST_NAME, { exact: true });
  if (
    !dashboard?.ok() ||
    dashboardUrl.origin !== 'https://www.screener.in' ||
    dashboardUrl.pathname !== `/dash/${SCREENER_PORTFOLIO_WATCHLIST_ID}/` ||
    (await watchlistLink.count()) !== 1 ||
    (await namedWatchlist.count()) < 1
  ) {
    throw Error('S Screen dashboard identity could not be verified');
  }
  const portfolioUpcoming = parseScreenerUpcomingPage(await page.content(), checkedAt);

  stage = 'capture validation';
  const current = {
    version: 1,
    sourceId: SCREENER_CONCALL_ID,
    checkedAt,
    publishedTotal: first.publishedTotal,
    pagesFetched,
    fullHistory: full,
    duplicatesRemoved,
    portfolioUpcoming,
    rows: resolved.map((row) => ({ ...row, observedAt: checkedAt })),
  };
  const capture = mergeScreenerConcallCapture(current, previous);
  const json = JSON.stringify(capture);
  const bytes = gzipSync(json);
  if (Buffer.byteLength(json) > SCREENER_CONCALL_LIMIT || bytes.length > SCREENER_CONCALL_COMPRESSED_LIMIT) throw Error('Screener concall history exceeds artifact limits');

  stage = 'artifact write';
  writeFileSync(output, bytes);
  console.log(
    JSON.stringify({
      checkedAt: capture.checkedAt,
      publishedTotal: capture.publishedTotal,
      uniqueRecords: capture.rows.length,
      duplicatesRemoved: capture.duplicatesRemoved,
      pagesFetched,
      fullHistory: full,
      portfolioUpcoming: capture.portfolioUpcoming.length,
      bytes: bytes.length,
    }),
  );
}

try {
  await main();
} catch {
  // Browser exceptions can include form values or page content. Public logs get only a fixed
  // stage name; credentials, HTML, account details and cookies never appear.
  const location = failurePage ? ` (page ${failurePage}, ${failureCode})` : '';
  console.error(`Screener concall collection failed during ${stage}${location}. No credentials or page content were logged.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
