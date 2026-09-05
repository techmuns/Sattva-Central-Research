#!/usr/bin/env node
// Authenticated Screener read -> immutable Actions artifact. No cookies, credentials, HTML or
// account details are logged or written; the only output is the validated public concall index.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';
import {
  addResolvedTickers,
  parseScreenerConcallPage,
  parseScreenerMarketUpcomingPage,
  SCREENER_CONCALL_URL,
  SCREENER_MARKET_UPCOMING_URL,
} from './lib/screener-concalls.mjs';
import {
  parseScreenerUpcomingPage as parseScreenerPortfolioUpcomingPage,
  SCREENER_PORTFOLIO_DASHBOARD,
  SCREENER_PORTFOLIO_WATCHLIST_ID,
  SCREENER_PORTFOLIO_WATCHLIST_NAME,
} from './lib/screener-upcoming.mjs';
import {
  mergeScreenerConcallCapture,
  mergeScreenerConcallRows,
  mergeScreenerMarketUpcomingRows,
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
let failureFeed = null;

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
          failureFeed = 'history';
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

  // The upcoming schedule is small and mutable, so every run reads every page. Unlike retained
  // documents, invitations can be rescheduled or withdrawn; merging an old tail would keep events
  // that the publisher no longer lists.
  stage = 'upcoming calendar crawl';
  // A full history audit has just made 168 polite sequential requests. Give the authenticated
  // session a quiet boundary before switching feeds, then apply the same bounded retry discipline
  // to page one as to every later page. A transient 429/5xx here must not discard a valid crawl.
  await page.waitForTimeout(full ? 5000 : 750);
  const readUpcomingPage = async (number, baseline = null) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const target = number === 1 ? SCREENER_MARKET_UPCOMING_URL : `${SCREENER_MARKET_UPCOMING_URL}?p=${number}`;
        const response = await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {
          throw collectionError('navigation');
        });
        const finalUrl = new URL(page.url());
        if (!response?.ok()) throw collectionError('response');
        if (finalUrl.origin !== 'https://www.screener.in' || finalUrl.pathname !== '/concalls/upcoming/') throw collectionError('session');
        const html = await page.content();
        if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw collectionError('oversized');
        let parsed;
        try {
          parsed = parseScreenerMarketUpcomingPage(html);
        } catch {
          throw collectionError('shape');
        }
        if (baseline && (parsed.publishedTotal !== baseline.publishedTotal || parsed.lastPage !== baseline.lastPage)) throw collectionError('pagination');
        await page.waitForTimeout(120);
        return parsed;
      } catch (error) {
        if (attempt === 3) {
          failurePage = number;
          failureFeed = 'upcoming';
          failureCode = ['navigation', 'response', 'session', 'oversized', 'shape', 'pagination'].includes(error?.collectionCode)
            ? error.collectionCode
            : 'browser';
          throw error;
        }
        await page.waitForTimeout(2000 * attempt);
      }
    }
    throw Error('Screener upcoming page unavailable');
  };

  const upcomingFirst = await readUpcomingPage(1);
  const upcomingCollected = [...upcomingFirst.rows];
  let upcomingPagesFetched = 1;

  for (let pageNumber = 2; pageNumber <= upcomingFirst.lastPage; pageNumber++) {
    upcomingCollected.push(...(await readUpcomingPage(pageNumber, upcomingFirst)).rows);
    upcomingPagesFetched++;
  }

  stage = 'ticker resolution';
  const index = buildIndex({ mc: readData('mc-ticker-map'), tech: readData('technicals'), book: readData('portfolio-companies') });
  const unique = mergeScreenerConcallRows(collected);
  const resolved = addResolvedTickers(unique, (name) => resolveTicker(index, name).ticker);
  const duplicatesRemoved = collected.length - unique.length;
  const upcomingUnique = mergeScreenerMarketUpcomingRows(upcomingCollected);
  const upcomingResolved = addResolvedTickers(upcomingUnique, (name) => resolveTicker(index, name).ticker);
  const upcomingDuplicatesRemoved = upcomingCollected.length - upcomingUnique.length;
  if (full && collected.length !== first.publishedTotal) throw Error('Screener full history count mismatch');
  if (upcomingCollected.length !== upcomingFirst.publishedTotal) throw Error('Screener upcoming count mismatch');

  stage = 'portfolio calendar capture';
  const checkedAt = new Date().toISOString();
  // This read follows seven market-calendar pages on a normal run (and the complete document
  // catalogue on a daily audit). Give the authenticated session a quiet boundary and retry only
  // this fixed dashboard: a transient refusal or partial render must not discard the two valid
  // captures already completed, while an identity or shape change must still fail closed.
  await page.waitForTimeout(2500);
  const readPortfolioUpcoming = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const dashboard = await page.goto(SCREENER_PORTFOLIO_DASHBOARD, { waitUntil: 'domcontentloaded' }).catch(() => {
          throw collectionError('navigation');
        });
        const dashboardUrl = new URL(page.url());
        if (!dashboard?.ok()) throw collectionError('response');
        if (dashboardUrl.origin !== 'https://www.screener.in' || dashboardUrl.pathname !== `/dash/${SCREENER_PORTFOLIO_WATCHLIST_ID}/`) {
          throw collectionError('session');
        }
        const watchlistLink = page.locator(`a[href^="/watchlist/${SCREENER_PORTFOLIO_WATCHLIST_ID}/"]`);
        const namedWatchlist = page.getByText(SCREENER_PORTFOLIO_WATCHLIST_NAME, { exact: true });
        // Screener renders the same fixed watchlist link in both responsive navigation variants.
        // Require its presence; cardinality is layout, not account identity.
        if ((await watchlistLink.count()) < 1 || (await namedWatchlist.count()) < 1) throw collectionError('identity');
        try {
          return parseScreenerPortfolioUpcomingPage(await page.content(), checkedAt);
        } catch {
          throw collectionError('shape');
        }
      } catch (error) {
        if (attempt === 3) {
          failurePage = 1;
          failureFeed = 'portfolio';
          failureCode = ['navigation', 'response', 'session', 'identity', 'shape'].includes(error?.collectionCode)
            ? error.collectionCode
            : 'browser';
          throw error;
        }
        await page.waitForTimeout(2500 * attempt);
      }
    }
    throw Error('S Screen dashboard unavailable');
  };
  const portfolioUpcoming = await readPortfolioUpcoming();

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
    upcomingPublishedTotal: upcomingFirst.publishedTotal,
    upcomingPagesFetched,
    upcomingDuplicatesRemoved,
    upcoming: upcomingResolved.map((row) => ({ ...row, observedAt: checkedAt })),
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
      upcomingPublishedTotal: capture.upcomingPublishedTotal,
      upcomingUniqueRecords: capture.upcoming.length,
      upcomingDuplicatesRemoved: capture.upcomingDuplicatesRemoved,
      upcomingPagesFetched: capture.upcomingPagesFetched,
      bytes: bytes.length,
    }),
  );
}

try {
  await main();
} catch {
  // Browser exceptions can include form values or page content. Public logs get only a fixed
  // stage name; credentials, HTML, account details and cookies never appear.
  const location = failurePage ? ` (${failureFeed || 'history'} page ${failurePage}, ${failureCode})` : '';
  console.error(`Screener concall collection failed during ${stage}${location}. No credentials or page content were logged.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
