#!/usr/bin/env node
// scripts/scrape-concalls.mjs — commit the StockScans con-call scan to public/data/concall-scans.json
//
//   node scripts/scrape-concalls.mjs
//
// This file has the same two jobs the earnings snapshot has: FIRST PAINT (so the tab is populated
// before any network round-trip, and works on a plain `python3 -m http.server`) and the Worker's
// FALLBACK when StockScans is unreachable. It is not what makes the tab fresh — the tab is live
// off /api/concalls, which re-reads the newest page every 30 seconds. Refreshing this file more
// often would only shorten how stale the fallback can be.
//
// Unlike the calendar capture, there is no bot wall here: StockScans answers a Cloudflare Worker
// the same way it answers this script. So this really is a fallback, not the primary path.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchConcallHistory, fetchUpcoming, fetchToday, mergeScans, resultTierOf, sentimentTierOf } from '../worker/stockscans.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/concall-scans.json');

async function main() {
  console.log('Fetching the con-call scan from StockScans…');
  const { rows: captured, meta } = await fetchConcallHistory({ gapMs: 4000 });
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* A first capture has no history. */ }
  const keys = new Set(captured.map(row => `${row.companyKey}|${row.when}|${row.ssUrl || row.pptSsUrl || ''}`));
  const retained = (previous?.rows || []).filter(row => !keys.has(`${row.companyKey}|${row.when}|${row.ssUrl || row.pptSsUrl || ''}`))
    .map(row => ({ ...row, analysisRetained: true, analysisCheckedAt: row.analysisCheckedAt || previous?.meta?.fetchedAt || null }));
  const rows = mergeScans(captured, retained);
  if (!rows.length) throw new Error('StockScans returned no rows — refusing to write an empty snapshot');
  if (meta.truncated) console.warn(`  WARNING: stopped at our own page bound with ${rows.length} of ${meta.total} rows.`);

  const parts = await Promise.allSettled([fetchUpcoming(), fetchToday()]);
  const upcoming = parts[0].status === 'fulfilled' ? parts[0].value : previous?.upcoming || [];
  const today = parts[1].status === 'fulfilled' ? parts[1].value : previous?.today || { day: null, rows: [] };
  const scheduleErrors = parts.flatMap((part, i) => part.status === 'rejected' ? [`${i ? 'Today' : 'Upcoming'} schedule unavailable`] : []);

  const payload = { ok: true, degraded: scheduleErrors.join('; ') || (meta.truncated ? 'Analysis history partially checked' : null),
    rows, upcoming, today, meta: { ...meta, analysisRetained: retained.length, scheduleErrors } };
  await writeFile(`${OUT}.tmp`, `${JSON.stringify(payload)}\n`);
  await rename(`${OUT}.tmp`, OUT);

  const scored = rows.filter((r) => r.resultScore != null);
  const pending = rows.length - scored.length;
  const byTier = {};
  for (const r of scored) {
    const t = resultTierOf(r.resultScore)?.label || '?';
    byTier[t] = (byTier[t] || 0) + 1;
  }
  const bySent = {};
  for (const r of rows) {
    const t = sentimentTierOf(r.sentimentTier)?.label || 'pending';
    bySent[t] = (bySent[t] || 0) + 1;
  }

  console.log(`Wrote ${OUT}`);
  console.log(`  ${rows.length} calls · quarter ${meta.quarter} · ${meta.pagesFetched} pages`);
  console.log(`  ${rows[rows.length - 1]?.date} .. ${rows[0]?.date}`);
  console.log(`  result tier: ${Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  sentiment:   ${Object.entries(bySent).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  ${pending} awaiting analysis · ${upcoming.length} upcoming · ${today.rows.length} today (${today.day})`);
}

main().catch((err) => {
  console.error('scrape-concalls failed:', err.message);
  process.exit(1);
});
