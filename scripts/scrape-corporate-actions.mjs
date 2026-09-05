#!/usr/bin/env node

// NSE is the official base. An authenticated Screener crawl adds structured terms and actions NSE
// does not carry. Each upstream has an independent last-good path, and the visible file is written
// atomically only after the combined contract is valid.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSafeCorporateActionReplacement,
  extractScreenerActionRows,
  mergeCorporateActionRows,
  mergeScreenerActionRows,
  normaliseNseCorporateActions,
  screenerActionKey,
  validateScreenerActionRows,
} from '../public/js/data/corporate-actions-shared.js';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';
import { parseScreenerActionPage, SCREENER_ACTION_ORIGIN, SCREENER_ACTION_KINDS } from './lib/screener-actions.mjs';

const OUTPUT = path.resolve('public/data/corporate-actions.json');
const NSE_ENDPOINT = 'https://www.nseindia.com/api/corporates-corporateActions';
const DAY = 86_400_000;
const now = new Date();
const from = new Date(now.getTime() - 3 * 365 * DAY);
const to = new Date(now.getTime() + 365 * DAY);
const queryDate = (date) => `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
const isoDate = (date) => date.toISOString().slice(0, 10);
const requestedFrom = isoDate(from);
const requestedTo = isoDate(to);
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
let browser;
let screenerStage = 'configuration';
let failureCatalogue = null;
let failurePage = null;
let failureCode = null;

function collectionError(code) {
  const error = new Error('Screener corporate-action page rejected.');
  error.collectionCode = code;
  return error;
}

async function readPrevious() {
  try { return JSON.parse(await fs.readFile(OUTPUT, 'utf8')); } catch { return null; }
}

async function fetchNse(previous) {
  const url = new URL(NSE_ENDPOINT);
  url.searchParams.set('index', 'equities');
  url.searchParams.set('from_date', queryDate(from));
  url.searchParams.set('to_date', queryDate(to));
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      referer: 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36 SattvaResearch/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`NSE corporate actions answered HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('NSE corporate actions response exceeded 8 MiB.');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('NSE corporate actions response was not JSON.'); }
  const parsed = normaliseNseCorporateActions(raw);
  if (!parsed.rows.length) throw new Error('NSE corporate actions response contained no usable rows; previous capture retained.');
  const priorNse = previous?.rows?.filter((row) => (row.sources || [row.source]).includes('NSE')) || [];
  assertSafeCorporateActionReplacement(parsed, priorNse.length ? { version: 1, rows: priorNse } : null);
  return parsed;
}

const readData = async (name) => JSON.parse(await fs.readFile(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

function catalogueUrl(catalogue, pageNumber = 1) {
  const url = new URL(`/actions/${catalogue.kind}/`, SCREENER_ACTION_ORIGIN);
  if (catalogue.year) url.searchParams.set('ex_date__year', catalogue.year);
  if (pageNumber > 1) url.searchParams.set('p', pageNumber);
  return url;
}

async function collectScreener(previousRows, previousMeta) {
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw new Error('Missing Screener collector configuration.');
  const forceFull = process.env.SCREENER_FULL_REFRESH === 'true';
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  screenerStage = 'browser startup';
  const { chromium } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  screenerStage = 'login';
  const firstPath = '/actions/bonus/';
  const login = await page.goto(`${SCREENER_ACTION_ORIGIN}/login/?next=${encodeURIComponent(firstPath)}`, { waitUntil: 'domcontentloaded' });
  if (!login?.ok()) throw new Error('Screener login page unavailable.');
  const form = page.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.origin === SCREENER_ACTION_ORIGIN && url.pathname === firstPath, { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  const hasSession = (await context.cookies(SCREENER_ACTION_ORIGIN)).some((cookie) => cookie.name === 'sessionid' && cookie.value);
  const hasLogout = await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count() > 0;
  if (!hasSession || !hasLogout) throw new Error('Screener authentication was not verified.');

  const years = [];
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year++) years.push(year);
  const catalogues = [
    ...SCREENER_ACTION_KINDS.filter((kind) => kind !== 'dividend').map((kind) => ({ kind, key: kind })),
    ...years.map((year) => ({ kind: 'dividend', year, key: `dividend:${year}` })),
  ];
  const oldIds = new Set(previousRows.map(screenerActionKey));
  const checkedAt = new Date().toISOString();

  const readPage = async (catalogue, number, expected = null) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Keep every read in the authenticated browser fingerprint. API-style parallel requests
        // can be refused even when they share the browser's session cookie.
        const response = await page.goto(catalogueUrl(catalogue, number).href, { waitUntil: 'domcontentloaded' }).catch(() => {
          throw collectionError('navigation');
        });
        const final = new URL(page.url());
        if (!response?.ok()) throw collectionError('response');
        if (final.origin !== SCREENER_ACTION_ORIGIN || final.pathname !== `/actions/${catalogue.kind}/`) throw collectionError('session');
        const html = await page.content();
        if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw collectionError('oversized');
        let parsed;
        try {
          parsed = parseScreenerActionPage(html, { kind: catalogue.kind, observedAt: checkedAt, catalogueKey: catalogue.key });
        } catch {
          throw collectionError('shape');
        }
        if (expected && (parsed.publishedTotal !== expected.publishedTotal || parsed.lastPage !== expected.lastPage)) throw collectionError('pagination');
        if (parsed.rows.some((row, index) => index && row.exDate > parsed.rows[index - 1].exDate)) throw collectionError('ordering');
        await page.waitForTimeout(120);
        return parsed;
      } catch (error) {
        if (attempt === 3) {
          failureCatalogue = catalogue.key;
          failurePage = number;
          failureCode = ['navigation', 'response', 'session', 'oversized', 'shape', 'pagination', 'ordering'].includes(error?.collectionCode)
            ? error.collectionCode
            : 'browser';
          throw error;
        }
        await page.waitForTimeout(500 * attempt);
      }
    }
    throw new Error('Authenticated Screener action page unavailable.');
  };

  const results = [];
  for (const catalogue of catalogues) {
    screenerStage = 'catalogue crawl';
    const first = await readPage(catalogue, 1);
    const previousTotal = previousMeta?.catalogues?.[catalogue.key]?.publishedTotal;
    const firstKnown = first.rows.every((row) => oldIds.has(screenerActionKey(row)));
    const full = forceFull || !previousMeta?.fullHistory || !Number.isSafeInteger(previousTotal) || first.publishedTotal < previousTotal || (first.publishedTotal !== previousTotal && firstKnown);
    const rows = [...first.rows];
    let pagesFetched = 1;
    if (full) {
      let windowComplete = first.publishedTotal === 0 || (first.rows.length > 0 && first.rows.every((row) => row.exDate < requestedFrom));
      let previousLastDate = first.rows.at(-1)?.exDate || null;
      for (let number = 2; number <= first.lastPage && !windowComplete; number++) {
        const parsed = await readPage(catalogue, number, first);
        if (previousLastDate && parsed.rows[0]?.exDate > previousLastDate) throw collectionError('ordering');
        rows.push(...parsed.rows);
        pagesFetched++;
        previousLastDate = parsed.rows.at(-1)?.exDate || previousLastDate;
        windowComplete = number === first.lastPage || (parsed.rows.length > 0 && parsed.rows.every((row) => row.exDate < requestedFrom));
      }
      if (!windowComplete) throw new Error('Screener rolling-window boundary was not reached.');
    } else if (!firstKnown) {
      for (let number = 2; number <= first.lastPage; number++) {
        const parsed = await readPage(catalogue, number, first);
        rows.push(...parsed.rows);
        pagesFetched++;
        if (parsed.rows.every((row) => oldIds.has(screenerActionKey(row)))) break;
      }
    }
    results.push({ catalogue, rows, full, pagesFetched, publishedTotal: first.publishedTotal, lastPage: first.lastPage });
  }

  const replaced = new Set(results.filter((result) => result.full).map((result) => result.catalogue.key));
  const retained = previousRows.filter((row) => !replaced.has(row.catalogueKey));
  const current = results.flatMap((result) => result.rows);
  let rows = mergeScreenerActionRows(retained, current).filter((row) => row.exDate >= requestedFrom && row.exDate <= requestedTo);

  const [mc, tech, book] = await Promise.all([readData('mc-ticker-map'), readData('technicals'), readData('portfolio-companies')]);
  const index = buildIndex({ mc, tech, book });
  rows = rows.map((row) => {
    if (row.ticker) return row;
    const ticker = resolveTicker(index, row.company).ticker;
    return ticker ? { ...row, ticker } : row;
  });
  rows = mergeScreenerActionRows(rows);
  validateScreenerActionRows(rows);
  const cataloguesMeta = Object.fromEntries(results.map((result) => [result.catalogue.key, {
    publishedTotal: result.publishedTotal,
    lastPage: result.lastPage,
    pagesFetched: result.pagesFetched,
    full: result.full,
  }]));
  return {
    rows,
    meta: {
      state: 'live',
      capturedAt: checkedAt,
      checkedAt,
      fullHistory: results.every((result) => result.full) || previousMeta?.fullHistory === true,
      rowCount: rows.length,
      catalogues: cataloguesMeta,
    },
  };
}

const previous = await readPrevious();
const nse = await fetchNse(previous);
const previousScreener = extractScreenerActionRows(previous?.rows || []);
let screenerRows = previousScreener;
let screenerMeta;
try {
  const captured = await collectScreener(previousScreener, previous?.sources?.screener);
  screenerRows = captured.rows;
  screenerMeta = captured.meta;
} catch {
  const checkedAt = new Date().toISOString();
  screenerMeta = {
    ...(previous?.sources?.screener || {}),
    state: previousScreener.length ? 'retained' : 'unavailable',
    checkedAt,
    rowCount: previousScreener.length,
  };
  const location = failureCatalogue ? ` during ${screenerStage} (${failureCatalogue}, page ${failurePage}, ${failureCode})` : ` during ${screenerStage}`;
  console.warn(`Screener corporate actions unavailable${location}; ${previousScreener.length ? 'retained the last valid Screener layer' : 'publishing the NSE base only'}.`);
} finally {
  await browser?.close().catch(() => {});
}

const rows = mergeCorporateActionRows(nse.rows, screenerRows);
const typeCounts = Object.fromEntries([...new Set(rows.map((row) => row.actionType))].sort().map((type) => [type, rows.filter((row) => row.actionType === type).length]));
const nseCount = rows.filter((row) => row.sources.includes('NSE')).length;
const screenerCount = rows.filter((row) => row.sources.includes('Screener')).length;
const enrichedCount = rows.filter((row) => row.sources.length === 2).length;
const capturedAt = new Date().toISOString();
const body = {
  version: 1,
  capturedAt,
  source: screenerRows.length ? 'NSE + Screener corporate actions' : 'NSE corporate actions',
  requestedFrom,
  requestedTo,
  rowCount: rows.length,
  companyCount: new Set(rows.map((row) => row.ticker || `screener:${row.screener?.companyKey || row.company}`)).size,
  typeCounts,
  skipped: nse.skipped,
  excludedMeetings: nse.excludedMeetings,
  duplicates: nse.duplicates,
  crossSourceDuplicates: enrichedCount,
  sourceCounts: { nse: nseCount, screener: screenerCount, enriched: enrichedCount, screenerOnly: screenerCount - enrichedCount },
  sources: {
    nse: { state: 'live', capturedAt, rowCount: nse.rows.length },
    screener: screenerMeta,
  },
  rows,
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
const temporary = `${OUTPUT}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(body)}\n`);
await fs.rename(temporary, OUTPUT);
console.log(`Captured ${body.rowCount} corporate actions for ${body.companyCount} companies: ${nseCount} with NSE, ${screenerCount} with Screener, ${enrichedCount} merged without duplicate rows.`);
