#!/usr/bin/env node
// scripts/classify-companies.mjs — every company this dashboard follows, filed under NSE's own
// four-level industry classification, so AI Alerts can say which of its SECTOR's KPIs an event
// moves (see public/js/data/kpi-impact.js).
//
// TWO SOURCES, ONE VOCABULARY. Both are Screener's copy of NSE's classification:
//   1. public/data/universe.json — the NSE-500 screener export already carries all four levels
//      (Broad Sector, Sector, Broad Industry, Industry). Read for free, every run.
//   2. The company's public Screener page, for every company in scope the export does not carry —
//      the book first, because a book's small and mid caps are often outside the NSE-500 and they
//      are the companies whose alerts matter most. One GET per company, paced, and a company is
//      re-read only once its classification is older than CLASSIFY_MAX_AGE_DAYS (it changes on a
//      corporate restructuring, not on a price move). An SME symbol is read without its "-SM"
//      series suffix, which Screener does not use; a company Screener files under another code is
//      found by an EXACT name match on Screener's own search, never by a nearest one.
//
// A RUN THAT CHANGES NOTHING WRITES NOTHING, except a weekly heartbeat: the scheduled job runs daily
// so a new holding is classified within a day, and rewriting an unchanged file would be a daily
// commit that says nothing. `capturedAt` therefore means "last checked", at most a week old while
// the job is healthy, and the source registry reads an older one as a refresh that is due.
//
// A FAILED READ IS NEVER AN EMPTY RESULT. A page that cannot be read keeps the company's previous
// classification and is listed under `failed` with the reason; a company never classified stays
// absent, which downstream means "no KPI line" — never a nearest sector's KPIs.
//
// Env:
//   CLASSIFY_SCOPE=book (default) | tracked   tracked adds data/tracked-universe.json (~1,900 names)
//   CLASSIFY_TICKERS=AAA,BBB                  classify exactly these (plus the export)
//   CLASSIFY_LIMIT=n                           read at most n pages this run
//   CLASSIFY_MAX_AGE_DAYS=90                   re-read a page classification older than this
//   CLASSIFY_PACE_MS=1500                      wait between page reads
//   CLASSIFY_BUDGET_MS=1800000                 stop reading pages after this long, keep what landed
//   CLASSIFY_HEARTBEAT_DAYS=7                  rewrite an unchanged file once it is this old
//
// Then run `node scripts/build-sector-kpis.mjs` to resolve the companies into KPI groups.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseScreenerClassification, tickerFromScreenerUrl } from './lib/screener-classification.mjs';

const execFileP = promisify(execFile);
const OUT = 'public/data/company-classification.json';
const SCOPE = process.env.CLASSIFY_SCOPE === 'tracked' ? 'tracked' : 'book';
const LIMIT = Number(process.env.CLASSIFY_LIMIT) > 0 ? Number(process.env.CLASSIFY_LIMIT) : Infinity;
const MAX_AGE_MS = (Number(process.env.CLASSIFY_MAX_AGE_DAYS) || 90) * 86_400_000;
const PACE_RAW = Number(process.env.CLASSIFY_PACE_MS);
const PACE_MS = process.env.CLASSIFY_PACE_MS && Number.isFinite(PACE_RAW) && PACE_RAW >= 0 ? PACE_RAW : 1500;
const BUDGET_MS = Number(process.env.CLASSIFY_BUDGET_MS) || 30 * 60_000;
const HEARTBEAT_MS = (Number(process.env.CLASSIFY_HEARTBEAT_DAYS) || 7) * 86_400_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TICKER = /^[A-Z0-9&-]{1,30}$/;

const readJson = (path, fallback = null) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One page read through curl, which is what the other Screener and publisher scrapers use. */
async function getPage(url) {
  const args = ['-sSL', '--compressed', '--max-time', '25', '-A', UA, '-H', 'Accept: text/html', '-w', '\n%{http_code}', url];
  try {
    const { stdout } = await execFileP('curl', args, { maxBuffer: 16 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    return { status: Number(stdout.slice(cut + 1).trim()) || 0, body: stdout.slice(0, cut) };
  } catch (err) {
    const out = String(err.stdout || '');
    const cut = out.lastIndexOf('\n');
    return { status: Number(out.slice(cut + 1).trim()) || 0, body: '', error: String(err.message || err).slice(0, 200) };
  }
}

function exportClassifications() {
  const rows = readJson('public/data/universe.json', []);
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ticker = tickerFromScreenerUrl(row['Screener URL']);
    const entry = {
      broadSector: String(row['Broad Sector'] || '').trim(),
      sector: String(row.Sector || '').trim(),
      broadIndustry: String(row['Broad Industry'] || '').trim(),
      industry: String(row.Industry || '').trim(),
    };
    // A row whose four levels are not all present is not classified from the export — the page
    // read below is then its chance, exactly as for a company outside the NSE-500.
    if (!ticker || !Object.values(entry).every(Boolean)) continue;
    out.set(ticker, { ...entry, source: 'export' });
  }
  return out;
}

// NSE's SME board symbols carry a series suffix in the book ("ALPEXSOLAR-SM"); Screener files the
// company under the bare symbol.
const screenerSymbol = (ticker) => ticker.replace(/-(?:SM|ST)$/, '');

/** Company names by ticker, from the files that name the tickers — for the exact-name search below. */
function namesByTicker() {
  const names = new Map();
  for (const holding of readJson('public/data/portfolio-companies.json', { holdings: [] }).holdings || []) {
    const ticker = String(holding.ticker || '').toUpperCase();
    const name = holding.matchedName || holding.bookName || holding.name;
    if (TICKER.test(ticker) && name) names.set(ticker, name);
  }
  for (const company of readJson('public/data/tracked-universe.json', { companies: [] }).companies || []) {
    const ticker = String(company.ticker || '').toUpperCase();
    if (TICKER.test(ticker) && company.name && !names.has(ticker)) names.set(ticker, company.name);
  }
  return names;
}

const plainName = (name) => String(name || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(?:limited|ltd|the|pvt|private)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The Screener path for a company whose symbol page does not exist, from Screener's own search —
 * accepted only where exactly one result carries the company's name, word for word once "Ltd" and
 * punctuation are set aside. Anything looser could file one company under another's sector.
 */
async function searchPath(name) {
  if (!name) return null;
  const { status, body } = await getPage(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(name)}&v=3`);
  if (status !== 200) return null;
  let results;
  try { results = JSON.parse(body); } catch { return null; }
  const wanted = plainName(name);
  const matches = (Array.isArray(results) ? results : [])
    .filter((row) => typeof row?.url === 'string' && /^\/company\/[^/]+\//.test(row.url) && plainName(row.name) === wanted);
  if (matches.length !== 1) return null;
  const code = matches[0].url.match(/^\/company\/([^/]+)\//)[1];
  return `/company/${code}/`;
}

function targets(exported) {
  const wanted = new Set();
  const explicit = String(process.env.CLASSIFY_TICKERS || '').split(',').map((t) => t.trim().toUpperCase()).filter((t) => TICKER.test(t));
  for (const ticker of explicit) wanted.add(ticker);
  if (!explicit.length) {
    for (const holding of readJson('public/data/portfolio-companies.json', { holdings: [] }).holdings || []) {
      const ticker = String(holding.ticker || '').toUpperCase();
      if (TICKER.test(ticker)) wanted.add(ticker);
    }
    if (SCOPE === 'tracked') {
      for (const company of readJson('public/data/tracked-universe.json', { companies: [] }).companies || []) {
        const ticker = String(company.ticker || '').toUpperCase();
        if (TICKER.test(ticker)) wanted.add(ticker);
      }
    }
  }
  return [...wanted].filter((ticker) => !exported.has(ticker));
}

async function main() {
  const started = Date.now();
  const previous = readJson(OUT, { companies: {}, failed: {} });
  const companies = new Map(Object.entries(previous.companies || {}));
  const failed = new Map(Object.entries(previous.failed || {}));

  // The export wins wherever it has an answer: it is refreshed with the technicals capture and needs
  // no request. A company that has left the NSE-500 keeps the classification it had — leaving an index
  // does not change what a company does.
  const exported = exportClassifications();
  for (const [ticker, entry] of exported) {
    companies.set(ticker, entry);
    failed.delete(ticker);
  }

  const queue = targets(exported).filter((ticker) => {
    const held = companies.get(ticker);
    const age = Date.now() - Date.parse(held?.checkedAt || '');
    return !held || held.source !== 'page' || !Number.isFinite(age) || age > MAX_AGE_MS;
  });
  console.log(`classify: ${exported.size} from the NSE-500 export; ${queue.length} company pages to read (scope ${SCOPE}).`);

  const names = namesByTicker();
  let read = 0;
  let refusedInARow = 0;
  for (const ticker of queue) {
    if (read >= LIMIT) break;
    if (Date.now() - started > BUDGET_MS) { console.log('classify: page budget spent; keeping what landed.'); break; }
    if (read > 0 && PACE_MS) await sleep(PACE_MS);
    read += 1;
    let path = companies.get(ticker)?.screenerPath || `/company/${encodeURIComponent(screenerSymbol(ticker))}/`;
    const fetchPage = async () => {
      let page = await getPage(`https://www.screener.in${path}`);
      for (let attempt = 1; (page.status === 429 || page.status >= 500) && attempt <= 2; attempt += 1) {
        await sleep(20_000 * attempt);
        page = await getPage(`https://www.screener.in${path}`);
      }
      return page;
    };
    let page = await fetchPage();
    if (page.status === 404) {
      const found = await searchPath(names.get(ticker));
      if (found && found !== path) {
        path = found;
        if (PACE_MS) await sleep(PACE_MS);
        page = await fetchPage();
      }
    }
    const at = new Date().toISOString();
    if (page.status !== 200) {
      failed.set(ticker, { reason: page.status ? `HTTP ${page.status}` : `unreachable (${page.error || 'no response'})`, at });
      refusedInARow = page.status === 429 || page.status === 403 || !page.status ? refusedInARow + 1 : 0;
      process.stdout.write(`${ticker}:${page.status || 'x'} `);
      if (refusedInARow >= 5) { console.log('\nclassify: the source is refusing repeatedly; stopping early and keeping what landed.'); break; }
      continue;
    }
    refusedInARow = 0;
    const parsed = parseScreenerClassification(page.body);
    if (!parsed) {
      failed.set(ticker, { reason: 'page carried no four-level classification', at });
      process.stdout.write(`${ticker}:? `);
      continue;
    }
    companies.set(ticker, { ...parsed, source: 'page', checkedAt: at, ...(path !== `/company/${encodeURIComponent(ticker)}/` ? { screenerPath: path } : {}) });
    failed.delete(ticker);
    process.stdout.write('.');
  }
  if (read) process.stdout.write('\n');

  const sortedCompanies = Object.fromEntries([...companies].sort(([a], [b]) => a.localeCompare(b)));
  // A failure is kept beside a retained classification too: the company still has its older answer,
  // and the reader of this file is owed the fact that the latest re-read did not land.
  const sortedFailed = Object.fromEntries([...failed].sort(([a], [b]) => a.localeCompare(b)));
  const values = Object.values(sortedCompanies);
  const unchanged = JSON.stringify(sortedCompanies) === JSON.stringify(previous.companies || {}) &&
    JSON.stringify(Object.keys(sortedFailed)) === JSON.stringify(Object.keys(previous.failed || {}).sort()) &&
    Date.now() - Date.parse(previous.capturedAt || '') < HEARTBEAT_MS;
  if (unchanged) {
    console.log(`classify: nothing changed since ${previous.capturedAt}; ${OUT} left as it is (${values.length} companies, ${Object.keys(sortedFailed).length} unread).`);
    return;
  }
  const payload = {
    _provenance: 'NSE four-level industry classification as printed by Screener: the NSE-500 export for index members, each company\'s public page for the rest. Read by scripts/build-sector-kpis.mjs; see docs/DATA-CONTRACTS.md → Sector KPIs.',
    source: 'Screener (NSE industry classification)',
    generator: 'scripts/classify-companies.mjs',
    capturedAt: new Date().toISOString(),
    scope: SCOPE,
    counts: {
      companies: values.length,
      fromExport: values.filter((c) => c.source === 'export').length,
      fromPages: values.filter((c) => c.source === 'page').length,
      failed: Object.keys(sortedFailed).length,
      pagesReadThisRun: read,
    },
    companies: sortedCompanies,
    failed: sortedFailed,
  };
  writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`classify: wrote ${OUT} — ${payload.counts.companies} companies (${payload.counts.fromExport} export, ${payload.counts.fromPages} pages), ${payload.counts.failed} unread.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
