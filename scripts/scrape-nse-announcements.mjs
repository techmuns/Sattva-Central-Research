#!/usr/bin/env node
// scripts/scrape-nse-announcements.mjs — commit a snapshot of NSE's live announcements feed.
//
//   node scripts/scrape-nse-announcements.mjs
//
// Writes public/data/nse-announcements.json, resolved to tickers, for the NSE Filings tab to paint
// from on a static origin (where the browser cannot reach our Worker) and as the Worker's own
// fallback when NSE refuses a fetch. The live experience is the Worker route /api/nse-announcements;
// this is the floor beneath it, the same arrangement every other feed here uses.
//
// It reads NSE directly with node's fetch (a full desktop user-agent — a weak one is Akamai-blocked)
// because, unlike Moneycontrol, NSE does not TLS-fingerprint the reader. The parser and resolver are
// the SAME pure module the Worker uses (worker/nse-ann.mjs), so the snapshot and the live route can
// never disagree about shape or about how a name becomes a ticker.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_URL, HEADERS, parseAnnouncements, assertShape, buildResolver, resolveAll } from '../worker/nse-ann.mjs';
import { archiveNseFilings } from './lib/nse-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => resolve(__dirname, '../public/data', f);
const num = (n) => Number(n).toLocaleString('en-IN');

async function main() {
  const previous = existsSync(DATA('nse-announcements.json'))
    ? JSON.parse(readFileSync(DATA('nse-announcements.json'), 'utf8')) : null;
  if (process.argv.includes('--archive-only')) {
    if (!previous?.rows?.length) throw new Error('No saved NSE capture to archive.');
    const archive = archiveNseFilings(DATA(''), [previous]);
    console.log(`Archived ${archive.count} captured filings across ${archive.days.length} day(s); no network requests.`);
    return;
  }
  console.log('NSE announcements — reading the live feed');
  let xml = null;
  for (let attempt = 1; attempt <= 3 && !xml; attempt += 1) {
    try {
      const res = await fetch(FEED_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      assertShape(body, { status: res.status });
      xml = body;
    } catch (err) {
      console.error(`  attempt ${attempt} failed: ${err.reason ? `[${err.reason}] ` : ''}${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  if (!xml) {
    console.error('\nNSE could not be read. The committed snapshot is unchanged and still correct.');
    process.exit(2); // a refusal is not a broken scraper — same convention as the news jobs
  }

  const rows = parseAnnouncements(xml);
  const mc = JSON.parse(readFileSync(DATA('mc-ticker-map.json'), 'utf8'));
  const tech = JSON.parse(readFileSync(DATA('technicals.json'), 'utf8'));
  const book = JSON.parse(readFileSync(DATA('portfolio-companies.json'), 'utf8'));
  const resolver = buildResolver({ book: book.holdings || [], mcMap: mc.map || {}, tech: tech.rows || tech.companies || [] });
  const resolved = resolveAll(rows, resolver);
  const withTicker = resolved.filter((r) => r.ticker).length;

  if (!rows.length) {
    console.error('Parsed zero announcements. Refusing to overwrite a good snapshot.');
    process.exit(1);
  }

  const payload = {
    _provenance:
      'NSE\'s live "latest announcements" feed (nsearchives.nseindia.com/content/RSS/Online_announcements.xml), captured to a committed snapshot. ' +
      'Company names, subjects and the filing PDF are NSE\'s own, reproduced unchanged; the document stays on their server and every row links to it where NSE gave a link. ' +
      'The ticker on each row is this dashboard\'s resolution of the filing company\'s name to an NSE symbol, so the feed can be narrowed to a reader\'s holdings; a name we cannot place keeps ticker null and shows only in Universe. Nothing here is scored, ranked or judged.',
    source: 'NSE — https://www.nseindia.com/companies-listing/corporate-filings-announcements',
    generator: 'scripts/scrape-nse-announcements.mjs',
    capturedAt: new Date().toISOString(),
    count: rows.length,
    resolved: withTicker,
    unresolved: rows.length - withTicker,
    rows: resolved,
  };
  // Preserve the old window BEFORE replacing the live fallback, including the first migration.
  const archive = archiveNseFilings(DATA(''), [previous, payload]);
  writeFileSync(DATA('nse-announcements.json'), `${JSON.stringify(payload)}\n`);
  console.log(`  retained ${num(archive.count)} captured filings in ${archive.days.length} daily history files`);
  console.log(`  ${num(rows.length)} announcements · ${num(withTicker)} resolved to a ticker · ${num(rows.length - withTicker)} unresolved`);
  console.log(`  wrote ${DATA('nse-announcements.json')}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err?.message || err}`);
  process.exit(1);
});
