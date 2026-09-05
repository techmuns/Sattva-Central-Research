#!/usr/bin/env node

// Authenticated, market-wide capture of Screener.in's Bulk, Block, SAST and Insider lists.
// Credentials exist only long enough to submit the login form; logs never contain page content,
// cookies, form values or exception text.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveFilings } from './lib/filing-archive.mjs';
import {
  buildScreenerTradesSnapshot,
  hasScreenerTradeOverlap,
  indexPriorScreenerTradeIdentities,
  normaliseScreenerTrade,
  SCREENER_TRADE_SOURCES,
} from './lib/screener-trades.mjs';
import { mergeInsiderTrades } from '../public/js/data/insider-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../public/data/insider-trades.json');
const archive = resolve(here, '../public/data/insider-archive');
const origin = 'https://www.screener.in';
const capturedAt = new Date().toISOString();
const BOOTSTRAP_DAYS = Math.max(1, Number(process.env.SCREENER_BOOTSTRAP_DAYS || 30));
const MAX_PAGES = Math.max(2, Number(process.env.SCREENER_MAX_PAGES || 600));
const OVERLAP_PAGES = Math.max(1, Number(process.env.SCREENER_OVERLAP_PAGES || 2));
const NAVIGATION_ATTEMPTS = 3;
const PAGE_PACE_MS = 1_500;

const iso = (value) => new Date(value).toISOString().slice(0, 10);
const bootstrapFrom = iso(Date.now() - BOOTSTRAP_DAYS * 86400000);

const readPrior = () => {
  try {
    return JSON.parse(readFileSync(output, 'utf8'));
  } catch {
    return null;
  }
};

const flatten = (capture) => Object.entries(capture?.byTicker || {}).flatMap(([ticker, rows]) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, ticker: row?.ticker || ticker }))
);

const pageUrl = (source, pageNumber) => {
  const url = new URL(source.path, origin);
  url.searchParams.set('o', '-2');
  if (pageNumber > 1) url.searchParams.set('p', String(pageNumber));
  return url.href;
};

async function navigate(page, url, expectedPath) {
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'commit' });
      if (response?.ok() && new URL(page.url()).pathname === expectedPath) return response;
    } catch {
      // Retry only the fixed URL already selected by the capture. Exception text can contain page
      // state and never enters shared logs.
    }
    if (attempt < NAVIGATION_ATTEMPTS) await page.waitForTimeout(attempt * 5_000);
  }
  throw new Error('navigation unavailable');
}

async function extractRows(page, url) {
  const raw = await page.locator('#result_list tbody tr').evaluateAll((elements, sourceUrl) => elements.map((row) => ({
    pageUrl: sourceUrl,
    cells: [...row.children]
      .filter((cell) => cell.matches('th, td'))
      .map((cell) => ({
        text: (cell.innerText || '').trim(),
        lines: (cell.innerText || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean),
        title: cell.getAttribute('title'),
        links: [...cell.querySelectorAll('a[href]')].map((link) => ({
          href: link.href,
          text: (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim(),
        })),
        dates: [...cell.querySelectorAll('time, [datetime]')].flatMap((item) => [
          item.getAttribute('datetime'), item.getAttribute('title'), item.getAttribute('data-value'),
        ]).filter(Boolean),
      })),
  })), url);
  return raw;
}

async function scrapeSource(page, source, previousMeta, previousIdentities = new Set()) {
  const rows = [];
  let latestDate = null;
  let oldestDate = null;
  let pagesRead = 0;
  let complete = false;
  let sourceStage = 'page setup';
  let currentPage = 0;
  const fallbackBoundary = previousMeta?.coverageFrom || bootstrapFrom;

  try {
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      currentPage = pageNumber;
      const url = pageUrl(source, pageNumber);
      sourceStage = 'page navigation';
      // The table is server-rendered. Waiting for the whole DOMContentLoaded lifecycle makes the
      // capture depend on unrelated slow page assets on hosted runners; wait for the response and
      // the actual table row instead.
      await navigate(page, url, source.path);
      sourceStage = 'session validation';
      if (!(await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw new Error('session unavailable');
      sourceStage = 'table validation';
      const table = page.locator('#result_list');
      await table.waitFor({ state: 'attached' });
      await table.locator('tbody tr').first().waitFor({ state: 'attached' });
      const headers = await table.locator('thead th').allTextContents();
      if (headers.length !== 5) throw new Error('unexpected table shape');

      sourceStage = 'row parsing';
      const raw = await extractRows(page, url);
      const parsed = raw.map((item) => normaliseScreenerTrade(source, item, { capturedAt })).filter(Boolean);
      if (!raw.length || parsed.length !== raw.length) throw new Error('unreadable rows');
      rows.push(...parsed);
      pagesRead++;

      const dates = parsed.map((row) => row.date).filter(Boolean).sort();
      const pageOldest = dates[0] || null;
      const pageLatest = dates.at(-1) || null;
      latestDate = latestDate || pageLatest;
      oldestDate = pageOldest || oldestDate;

      sourceStage = 'pagination validation';
      const hasNext = await page.locator('.paginator a[href]').evaluateAll((links, nextPage) => links.some((link) => {
        try { return Number(new URL(link.href).searchParams.get('p')) === nextPage; }
        catch { return false; }
      }), pageNumber + 1);
      // A date alone is not overlap: hundreds of new Bulk rows can share one date and push older
      // same-day rows beyond page two. Once bootstrapped, stop only after an exact prior event is
      // seen. The date boundary is reserved for a first run or recovery from legacy metadata that
      // did not retain source ids.
      const reachedPriorEvent = hasScreenerTradeOverlap(previousIdentities, parsed);
      const reachedFallbackBoundary = previousIdentities.size === 0 && pageOldest && pageOldest <= fallbackBoundary;
      const reachedKnownData = pagesRead >= OVERLAP_PAGES && (reachedPriorEvent || reachedFallbackBoundary);
      if (!hasNext || reachedKnownData) {
        complete = true;
        break;
      }
      await page.waitForTimeout(PAGE_PACE_MS);
    }
  } catch {
    // A fixed source id and stage are operationally useful without exposing page text, form values,
    // cookies or browser exceptions in a shared Action log.
    console.error(`${source.id}: capture stopped during ${sourceStage} on page ${currentPage || 1}.`);
    throw new Error('Screener source capture failed.');
  }

  if (!complete) {
    console.error(`${source.id}: capture reached the ${MAX_PAGES}-page safety limit before its date boundary.`);
    throw new Error('pagination limit reached');
  }
  console.log(`${source.id}: ${rows.length} rows across ${pagesRead} page(s), ${latestDate || 'undated'} to ${oldestDate || 'undated'}.`);
  return {
    id: source.id,
    label: source.label,
    url: pageUrl(source, 1),
    rows,
    pagesRead,
    latestDate,
    oldestDate,
    bootstrapDays: previousMeta ? null : BOOTSTRAP_DAYS,
  };
}

let browser;
let stage = 'credential configuration';
try {
  stage = 'prior snapshot read';
  const previous = readPrior();
  stage = 'prior source indexing';
  const previousSources = new Map((previous?.sources || []).map((source) => [source.id, source]));
  stage = 'prior row flattening';
  const previousRows = flatten(previous);
  stage = 'prior identity indexing';
  const previousIdentities = indexPriorScreenerTradeIdentities(previousRows);
  console.log(`Indexed ${previousRows.length} prior rows for incremental capture.`);

  stage = 'credential configuration';
  let username = process.env.SCREENER_USERNAME;
  let password = process.env.SCREENER_PASSWORD;
  if (!username || !password) throw new Error('missing credentials');
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  stage = 'browser startup';
  if (!process.env.PLAYWRIGHT_ROOT) throw new Error('missing browser runtime');
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SCREENER_CHROME_PATH ? { executablePath: process.env.SCREENER_CHROME_PATH } : {}),
  });
  const context = await browser.newContext({ acceptDownloads: false });
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    return ['image', 'font', 'media'].includes(type) ? route.abort() : route.continue();
  });
  const login = await context.newPage();
  login.setDefaultTimeout(30_000);
  login.setDefaultNavigationTimeout(45_000);

  stage = 'Screener login';
  const destination = SCREENER_TRADE_SOURCES[0].path;
  await navigate(login, `${origin}/login/?next=${encodeURIComponent(destination)}`, '/login/');
  const form = login.locator('form[action="/login/"]');
  await form.waitFor({ state: 'attached' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  username = '';
  password = '';
  await Promise.all([
    login.waitForURL(`${origin}${destination}`, { waitUntil: 'commit' }),
    form.locator('button[type="submit"]').click({ noWaitAfter: true }),
  ]);
  const hasSession = (await context.cookies(origin)).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  const logout = login.locator('a[href^="/logout/"], form[action^="/logout/"]').first();
  await logout.waitFor({ state: 'attached' });
  if (!hasSession) throw new Error('login not verified');
  await login.waitForTimeout(2_000);
  // Do not reuse the form-navigation page for the long crawl. A fresh page shares the verified
  // session cookies but has no pending login lifecycle or form listeners to interfere with the
  // first incremental navigation.
  stage = 'capture page startup';
  const capturePage = await context.newPage();
  await login.close();

  stage = 'four-category capture';
  console.log('Authenticated session handed to the four-category capture.');
  // Keep one authenticated listing request in flight at a time. Screener is the source of truth,
  // not a high-throughput API, and concurrent page walks can trip its protective throttling.
  const captures = [];
  for (const source of SCREENER_TRADE_SOURCES) {
    const identities = previousIdentities.get(source.id);
    console.log(`Starting ${source.id} capture with ${identities.size} prior event identities.`);
    captures.push(await scrapeSource(capturePage, source, previousSources.get(source.id), identities));
  }
  await capturePage.close();

  stage = 'snapshot validation';
  const snapshot = buildScreenerTradesSnapshot(previous, captures, { capturedAt });
  const allRows = mergeInsiderTrades(flatten(previous), captures.flatMap((capture) => capture.rows));
  archiveFilings(archive, 'insider', allRows);
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Captured ${snapshot.rowCount} unique trades across ${snapshot.withRows} companies and all four categories.`);
} catch (error) {
  const errorType = ['Error', 'TypeError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
  if (stage.startsWith('prior ')) {
    // This phase runs before credentials are read and operates only on the checked-in snapshot, so
    // its exception text is safe and necessary to diagnose data/runtime compatibility failures.
    console.error(`Prior snapshot diagnostic: ${errorType}: ${String(error?.message || 'unknown failure').slice(0, 240)}`);
  }
  console.error(`Screener trade capture stopped during ${stage} (${errorType}). The existing snapshot was not replaced.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
