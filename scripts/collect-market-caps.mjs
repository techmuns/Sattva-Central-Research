#!/usr/bin/env node
// Daily public market-cap coverage, independent of the technicals/earnings subsets.
// Reuses the existing Data refresh schedule. No authenticated data or paid search.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExchangeUniverse } from '../public/js/data/exchange-universe.js';
import { SCREEN_URL, sourceKeys, parseMarketCapScreen, parseMarketCapCompany } from './lib/market-caps.mjs';

const root = process.env.MARKET_CAP_DATA_DIR || fileURLToPath(new URL('../public/data/', import.meta.url));
const read = (name, fallback = null) => { try { return JSON.parse(readFileSync(resolve(root, name))); } catch { return fallback; } };
const path = resolve(root, 'market-caps.json');
const prior = read('market-caps.json', { entries: [] });
if (Date.parse(prior.coverage?.retryAt) > Date.now()) throw Error(`Market cap: source cooldown until ${prior.coverage.retryAt}; saved figures retained.`);
const bse = read('announcement-identities.json'), nse = read('filing-capture/nse-identities.json');
if (!bse?.entries?.length || !nse?.directories?.equity?.entries?.length || !nse?.directories?.sme?.entries?.length)
  throw Error('Market cap: both verified exchange directories are required; saved figures were retained.');
const universe = buildExchangeUniverse(bse, nse).companies;
const bySource = new Map();
for (const c of universe) for (const key of sourceKeys(c)) {
  if (!bySource.has(key)) bySource.set(key, c);
  else if (bySource.get(key)?.isin !== c.isin) bySource.set(key, null);
}
const entries = new Map(prior.entries.map(e => [e.isin, e])); // Keep previously captured/delisted identities.
const seen = new Set(), keys = new Set();
const startedAt = new Date().toISOString();
const deadline = Date.now() + Number(process.env.MARKET_CAP_MAX_MS || 30 * 60_000);
const errors = [];
let nextRequest = 0;
let refused = false;
let retryAt = null;
async function get(url) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() >= deadline) throw Error('collection time budget reached');
    await new Promise(r => setTimeout(r, Math.max(0, nextRequest - Date.now())));
    nextRequest = Date.now() + 2000;
    response = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'SattvaCentralResearch/1.0' }, signal: AbortSignal.timeout(20000) });
    if (response.status !== 429 || attempt > 0) break;
    refused = true;
    const header = response.headers.get('retry-after');
    const delay = Math.max(60_000, /^\d+$/.test(header || '') ? +header * 1000 : Date.parse(header) - Date.now() || 0);
    retryAt = new Date(Date.now() + delay).toISOString();
    checkpoint();
    await response.body?.cancel();
    if (Date.now() + delay >= deadline) throw Error('HTTP 429; retry deferred beyond collection budget');
    console.log(`Market cap: source rate limit; waiting until ${retryAt} before one retry.`);
    await new Promise(r => setTimeout(r, delay));
  }
  if ([403, 429].includes(response.status)) {
    refused = true;
    const header = response.headers.get('retry-after');
    const delay = Math.max(response.status === 403 ? 60 * 60_000 : 60_000,
      /^\d+$/.test(header || '') ? +header * 1000 : Date.parse(header) - Date.now() || 0);
    retryAt = new Date(Date.now() + delay).toISOString(); checkpoint();
  }
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  refused = false; retryAt = null;
  // Public pages are ~120 KB; bound bytes before parsing.
  const chunks = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 2_000_000) throw Error('response too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function save(company, figure) {
  entries.set(company.isin, { isin: company.isin, ticker: company.ticker, bseCode: company.bseCode || null,
    exchanges: company.exchanges, ...figure });
  seen.add(company.isin);
}
let sourceTotal = null, pagesRead = 0, screenComplete = false, directRead = 0, directTotal = null;
function checkpoint() {
  const current = universe.map(c => entries.get(c.isin));
  const known = current.filter(e => Number.isFinite(e?.cr) && e.cr > 0).length;
  const body = { version: 1, source: 'Screener public company market capitalisation, ₹ crore',
    generated_at: new Date().toISOString(), startedAt,
    directoryAsOf: { bse: bse.capturedAt, nse: nse.attemptedAt },
    coverage: { companies: universe.length, known, checked: seen.size, unavailable: universe.length - known,
      screenComplete, sourceTotal, pagesRead, directRead, directTotal, refused, retryAt, errors },
    entries: [...entries.values()].sort((a, b) => a.isin.localeCompare(b.isin)) };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(body)}\n`); renameSync(`${path}.tmp`, path);
  return body;
}
try {
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const url = new URL(SCREEN_URL); url.searchParams.set('order', 'asc'); url.searchParams.set('page', page);
    const capture = parseMarketCapScreen(await get(url));
    if (capture.page !== page || (sourceTotal !== null && capture.total !== sourceTotal)) throw Error('screen changed during pagination');
    sourceTotal = capture.total; pages = capture.pages; pagesRead++;
    const checkedAt = new Date().toISOString();
    for (const row of capture.rows) {
      if (keys.has(row.key)) throw Error('duplicate issuer across screen pages');
      keys.add(row.key);
      const company = bySource.get(row.key);
      if (company) save(company, { cr: row.cr, checkedAt, priceDateLabel: null, source: 'Screener', sourceUrl: row.sourceUrl });
    }
    if (page % 25 === 0 || page === pages) { checkpoint(); console.log(`Market cap screen: ${page}/${pages} pages, ${seen.size} exact exchange matches.`); }
  }
  screenComplete = keys.size === sourceTotal;
} catch (error) { errors.push({ source: SCREEN_URL, reason: error.message }); }

// Screen excludes ≤₹1 Cr and some suspended/unpriced companies. Ask the exact company page,
// never assume its exclusion means zero. Stalest attempts first makes interruptions resumable.
const direct = universe.filter(c => !seen.has(c.isin)).sort((a, b) =>
  String(entries.get(a.isin)?.attemptedAt || '').localeCompare(String(entries.get(b.isin)?.attemptedAt || '')) || a.isin.localeCompare(b.isin));
directTotal = direct.length;
for (const company of direct) {
  if (refused || Date.now() >= deadline) break;
  const key = company.exchanges.includes('NSE') ? company.ticker : company.bseCode;
  const url = `https://www.screener.in/company/${encodeURIComponent(key)}/`;
  const attemptedAt = new Date().toISOString();
  try {
    const figure = parseMarketCapCompany(await get(url), company, new Date().toISOString());
    save(company, { ...figure, attemptedAt, error: null });
  } catch (error) {
    entries.set(company.isin, { ...entries.get(company.isin), isin: company.isin, ticker: company.ticker,
      bseCode: company.bseCode || null, exchanges: company.exchanges, attemptedAt, error: error.message });
  }
  directRead++;
  if (directRead % 50 === 0 || directRead === direct.length) { checkpoint(); console.log(`Market cap company pages: ${directRead}/${direct.length}; ${seen.size}/${universe.length} figures checked.`); }
}
// generated_at is the capture attempt, never a replacement for a figure's checkedAt/price label.
console.log(JSON.stringify(checkpoint().coverage));
