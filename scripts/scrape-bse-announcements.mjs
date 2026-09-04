#!/usr/bin/env node
// scripts/scrape-bse-announcements.mjs — corporate announcements for the WHOLE exchange, by date.
//
//   node scripts/scrape-bse-announcements.mjs               the last ANN_DAYS days (default 1, with a two-day overlap)
//   ANN_DAYS=30 node scripts/scrape-bse-announcements.mjs   backfill a month
//   ANN_FROM=2026-08-01 ANN_TO=2026-08-19 node …            an explicit window
//   ANN_MERGE=0 node …                                      replace rather than merge
//
// Writes public/data/corp-announcements.json.
//
// WHY THIS REPLACED THE PER-COMPANY WALK
//   The old scrape asked `GET /filings/corp/announcements/{ticker}` once per company against an
//   upstream capped at ~60 requests a minute. 603 companies is ten minutes of somebody else's
//   service, and a run cut short by that limit or by the session JWT expiring is why the committed
//   snapshot covered 118 companies. Narrowing the date window would not have helped: the range is a
//   PARAMETER on a per-company request, so one day for 603 companies is still 603 requests.
//
//   BSE index the same filings by DATE. Measured on 19 Aug 2026: 886 announcements across every
//   listed company in about two dozen requests. Whole universe, no credential, no expiry.
//
// MERGING IS THE DEFAULT, AND IT IS WHY THE WINDOW DOES NOT SHRINK.
//   A daily run fetches one day and merges it into what is already committed, so the file keeps its
//   history while each run stays cheap. Rows are keyed on BSE's own NEWSID, which is a real unique
//   identifier — never on a position, and never on a (ticker, date) pair that two filings can share.
//
// A RUN THAT COLLECTS NOTHING WRITES NOTHING. `strCat=-1` answers HTTP 200 with the string
// "No Record Found!", and an empty `strCat` answers 200 with zero rows — see worker/bse-ann.mjs.
// Both are the request being wrong rather than the day being quiet, so a zero-row run exits
// non-zero rather than committing an empty file over a good one.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAnnouncements, CATEGORIES, HEADERS } from '../worker/bse-ann.mjs';
import { archiveFilings } from './lib/filing-archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => resolve(__dirname, '../public/data', f);
const OUT = DATA('corp-announcements.json');

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);

const DAYS = Number(process.env.ANN_DAYS || 1);
// How many days the merged file keeps. THIS IS A SIZE LIMIT, NOT AN EDITORIAL ONE, and it is why
// the daily job stays cheap while the file stays servable: a weekday carries ~900 announcements
// across the exchange, so a month would be ~22,000 rows and roughly 16 MB of committed JSON that
// every visitor downloads. Older filings stay in monthly archive files and load through the history control.
// Three days, not one, so that a Monday morning is not an empty page: the primary view is still
// today's filings, and Saturday and Sunday cost almost nothing because the exchange is shut.
const KEEP_DAYS = Number(process.env.ANN_KEEP_DAYS || 3);
const previousCapture = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const lastCompleteTo = previousCapture?.lastCompleteTo || (!previousCapture?.shortfall?.length ? previousCapture?.to : null);
// Overlap late filings and recover dates missed while a scheduled job did not run.
const defaultFrom = daysAgo(Math.max(2, DAYS - 1));
const recoveryFrom = lastCompleteTo ? iso(Date.parse(lastCompleteTo) - 2 * 86400000) : defaultFrom;
const FROM = process.env.ANN_FROM || (recoveryFrom < defaultFrom ? recoveryFrom : defaultFrom);
const TO = process.env.ANN_TO || iso(Date.now());
const MERGE = process.env.ANN_MERGE !== '0';

const num = (n) => Number(n).toLocaleString('en-IN');

/**
 * BSE scrip code -> this dashboard's ticker.
 *
 * TWO SOURCES, AND THEY ARE NOT EQUALLY GOOD, so the row records which one answered.
 *   • `mc-ticker-map.json` already carries `bseId -> ticker` for 2,224 companies. That mapping was
 *     resolved against Moneycontrol's own NSEID and is the join every other feed here uses, so it
 *     wins wherever it exists and the row is marked `confirmed`.
 *   • BSE's own `scrip_id` covers everything else. It usually equals the NSE symbol and sometimes
 *     does not, so it is marked `bse` — the row is still shown, under BSE's own label, rather than
 *     dropped or quietly presented as an NSE symbol it may not be.
 *
 * A scrip we cannot name at all keeps its row with `ticker: null` and its company name. An
 * announcement that happened is not less true for our not having a symbol for the filer.
 */
async function buildScripIndex() {
  const byCode = new Map();

  const mcPath = DATA('mc-ticker-map.json');
  if (existsSync(mcPath)) {
    const mc = JSON.parse(readFileSync(mcPath, 'utf8'));
    for (const entry of Object.values(mc.map || {})) {
      if (entry?.bseId && entry?.ticker) {
        byCode.set(String(entry.bseId), { ticker: String(entry.ticker).toUpperCase(), name: entry.fullName || null, source: 'confirmed' });
      }
    }
  }
  const confirmed = byCode.size;

  const url = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BSE scrip master answered HTTP ${res.status}`);
  const master = await res.json();
  if (!Array.isArray(master) || master.length < 1000) {
    throw new Error(`BSE scrip master returned ${Array.isArray(master) ? master.length : typeof master} rows — that is not the master.`);
  }
  for (const s of master) {
    const code = String(s?.SCRIP_CD || '').trim();
    if (!code || byCode.has(code)) continue;
    const id = String(s?.scrip_id || '').trim().toUpperCase();
    byCode.set(code, { ticker: id || null, name: s?.Scrip_Name || null, source: id ? 'bse' : null });
  }

  return { byCode, confirmed, masterRows: master.length };
}

function loadExisting() {
  if (!MERGE || !existsSync(OUT)) return { rows: [], from: null, to: null };
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    const rows = [];
    for (const [ticker, list] of Object.entries(prev.byTicker || {})) {
      for (const r of list) rows.push({ ...r, ticker: r.ticker || ticker });
    }
    return { rows, from: prev.from || null, to: prev.to || null };
  } catch {
    return { rows: [], from: null, to: null };
  }
}

async function main() {
  console.log(`BSE corporate announcements — ${FROM} to ${TO} (${MERGE ? 'merging into' : 'replacing'} the committed file)`);

  const { byCode, confirmed, masterRows } = await buildScripIndex();
  console.log(`  scrip index: ${num(byCode.size)} codes (${num(confirmed)} confirmed from mc-ticker-map, master ${num(masterRows)})`);

  const started = Date.now();
  const { rows, byCategory, unknownCategories, requests, shortfall } = await fetchAnnouncements(
    { from: FROM, to: TO },
    {
      onProgress: ({ category, page, got, declared }) => {
        process.stdout.write(`\r  ${category.padEnd(20)} page ${String(page).padStart(3)}  ${String(got).padStart(5)}/${declared ?? '?'}   `);
      },
    },
  );
  process.stdout.write('\n');

  for (const c of CATEGORIES) {
    const b = byCategory[c] || {};
    console.log(`  ${c.padEnd(20)} declared ${String(b.declared ?? '-').padStart(6)}  collected ${String(b.collected ?? 0).padStart(6)}`);
  }

  if (Object.keys(unknownCategories).length) {
    console.error('\n  !! BSE returned categories we did not ask for — the category list needs updating:');
    for (const [k, n] of Object.entries(unknownCategories)) console.error(`     ${k}: ${n} rows`);
  }
  if (shortfall.length) {
    console.error('\n  !! collected fewer rows than BSE declared:');
    for (const s of shortfall) console.error(`     ${s.category}: ${s.collected} of ${s.declared}`);
  }

  // A day with nothing is not a day we failed to read, but a RUN with nothing across every
  // category is the request being wrong. Refuse rather than commit an empty file over a good one.
  if (!rows.length) {
    console.error('\nCollected zero announcements across every category. Refusing to write.');
    process.exit(1);
  }

  // Resolve, then merge on NEWSID. BSE's own identifier, so a re-run of an overlapping window
  // updates rather than duplicates — and a row with no id falls back to its content, never to a
  // position in the list.
  const resolved = rows.map((r) => {
    const hit = r.scripCode ? byCode.get(r.scripCode) : null;
    // `subject` is DROPPED, not lost. BSE build it as "<company> - <scrip code> - <title-cased
    // headline>", so every part of it is already a field on this row, and at ~140 bytes it was the
    // single fattest thing in a file every visitor downloads. The filing itself is one click away.
    const { subject, ...rest } = r;
    return {
      ...rest,
      ticker: hit?.ticker || null,
      company: r.company || hit?.name || null,
      tickerSource: hit?.source || null,
      // `title` and `source` are what the tab and the export already speak. Aliased here rather
      // than in worker/bse-ann.mjs, which stays faithful to BSE's own field names.
      title: r.headline,
      source: 'BSE',
    };
  });

  const existing = loadExisting();
  const merged = new Map();
  for (const r of [...existing.rows, ...resolved]) {
    const key = r.newsId || `${r.scripCode || ''}|${r.date || ''}|${r.headline || ''}`;
    merged.set(key, r);
  }
  archiveFilings(DATA('announcements-archive'), 'announcements', [...merged.values()]);
  const cutoff = iso(Date.now() - (KEEP_DAYS - 1) * 86400000);
  const kept = [...merged.values()].filter((r) => !r.date || r.date >= cutoff);
  const pruned = merged.size - kept.length;
  const all = kept.sort((a, b) => `${b.date || ''}${b.time || ''}`.localeCompare(`${a.date || ''}${a.time || ''}`));

  // EVERY BYTE HERE IS DOWNLOADED BY EVERY VISITOR, so a field that carries no information is not
  // written: nulls, `false`, and the ticker that `byTicker`'s own key already states. `rows()` in
  // js/data/filings.js restores the ticker from the key, which is why dropping it is safe.
  const slim = (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'ticker' || v === null || v === undefined || v === false || v === '') continue;
      out[k] = v;
    }
    return out;
  };

  const byTicker = {};
  let unnamed = 0;
  for (const r of all) {
    // A filing whose company we cannot name is filed under its BSE scrip code rather than dropped.
    const key = r.ticker || (r.scripCode ? `BSE:${r.scripCode}` : 'UNKNOWN');
    if (!r.ticker) unnamed++;
    (byTicker[key] ||= []).push(slim(r));
  }

  const dates = all.map((r) => r.date).filter(Boolean).sort();
  const retainedFrom = existing.from && existing.from < FROM ? existing.from : FROM;
  const windowFrom = retainedFrom < cutoff ? cutoff : retainedFrom;
  const payload = {
    _provenance:
      'Corporate announcements as filed with BSE, read from their date-indexed feed (AnnSubCategoryGetData) rather than one request per company. ' +
      'Headlines, subjects and categories are BSE\'s; presentation-only HTML break tags are normalised to spaces. The filing PDF stays on their server and every row links to it. ' +
      'Nothing here is summarised, scored or ranked.',
    kind: 'announcements',
    source: 'BSE — api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData',
    generator: 'scripts/scrape-bse-announcements.mjs',
    capturedAt: new Date().toISOString(),
    from: windowFrom,
    to: TO,
    windowDays: Math.max(1, Math.round((Date.parse(TO) - Date.parse(windowFrom)) / 86400000) + 1),
    dateRangeInFile: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    scope: 'exchange',
    // THE POINT OF THIS FILE. Every company on the exchange was covered, because the question asked
    // was "what was filed on these dates" rather than "what did these companies file". A company
    // with no rows here filed nothing in the window — it was not skipped for want of budget.
    coversUniverse: shortfall.length === 0 && Object.keys(unknownCategories).length === 0,
    lastCompleteTo: shortfall.length || Object.keys(unknownCategories).length ? lastCompleteTo : TO,
    exchangeCompanies: masterRows,
    companies: Object.keys(byTicker).length,
    namedCompanies: Object.keys(byTicker).filter((k) => !k.startsWith('BSE:') && k !== 'UNKNOWN').length,
    unnamedRows: unnamed,
    asked: Object.keys(byTicker).length,
    covered: Object.keys(byTicker).length,
    rowCount: all.length,
    keepDays: KEEP_DAYS,
    prunedRows: pruned,
    requests,
    byCategory,
    unknownCategories,
    shortfall,
    failed: [],
    byTicker,
  };

  // Written compact deliberately: at ~900 rows a weekday, two-space indentation was roughly half
  // the bytes on the wire, and nobody reads this file by eye.
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${num(all.length)} announcements · ${num(payload.companies)} companies (${num(payload.namedCompanies)} named) · ${requests} requests · ${secs}s`);
  console.log(`  window in file: ${payload.dateRangeInFile?.first} .. ${payload.dateRangeInFile?.last} (keeping ${KEEP_DAYS} days${pruned ? `, archived ${num(pruned)} older rows` : ''})`);
  console.log(`  wrote ${OUT}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.reason ? `[${err.reason}] ` : ''}${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exit(1);
});
