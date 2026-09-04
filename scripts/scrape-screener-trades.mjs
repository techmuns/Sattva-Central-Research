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
const MAX_PAGES = Math.max(2, Number(process.env.SCREENER_MAX_PAGES || 200));
const OVERLAP_PAGES = Math.max(1, Number(process.env.SCREENER_OVERLAP_PAGES || 2));

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

async function scrapeSource(context, source, previousMeta) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);
  const rows = [];
  let latestDate = null;
  let oldestDate = null;
  let pagesRead = 0;
  let complete = false;
  const stopAt = previousMeta?.latestDate || bootstrapFrom;

  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const url = pageUrl(source, pageNumber);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (!response?.ok() || new URL(page.url()).pathname !== source.path) throw new Error('source unavailable');
      if (!(await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw new Error('session unavailable');
      const table = page.locator('#result_list');
      await table.waitFor({ state: 'visible' });
      const headers = await table.locator('thead th').allTextContents();
      if (headers.length !== 5) throw new Error('unexpected table shape');

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

      const hasNext = await page.locator(`.paginator a[href*="p=${pageNumber + 1}"]`).count() > 0;
      const reachedKnownData = pagesRead >= OVERLAP_PAGES && pageOldest && pageOldest <= stopAt;
      if (!hasNext || reachedKnownData) {
        complete = true;
        break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (!complete) throw new Error('pagination limit reached');
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
  const login = await context.newPage();
  login.setDefaultTimeout(30_000);
  login.setDefaultNavigationTimeout(45_000);

  stage = 'Screener login';
  const destination = SCREENER_TRADE_SOURCES[0].path;
  const response = await login.goto(`${origin}/login/?next=${encodeURIComponent(destination)}`, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error('login unavailable');
  const form = login.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  username = '';
  password = '';
  await Promise.all([
    login.waitForURL(`${origin}${destination}`, { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  const hasSession = (await context.cookies(origin)).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  if (!hasSession || !(await login.locator('a[href^="/logout/"], form[action^="/logout/"]').count())) throw new Error('login not verified');
  await login.close();

  stage = 'four-category capture';
  const previous = readPrior();
  const previousSources = new Map((previous?.sources || []).map((source) => [source.id, source]));
  const captures = await Promise.all(SCREENER_TRADE_SOURCES.map((source) => scrapeSource(context, source, previousSources.get(source.id))));

  stage = 'snapshot validation';
  const snapshot = buildScreenerTradesSnapshot(previous, captures, { capturedAt });
  const allRows = mergeInsiderTrades(flatten(previous), captures.flatMap((capture) => capture.rows));
  archiveFilings(archive, 'insider', allRows);
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Captured ${snapshot.rowCount} unique trades across ${snapshot.withRows} companies and all four categories.`);
} catch {
  console.error(`Screener trade capture stopped during ${stage}. The existing snapshot was not replaced.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
