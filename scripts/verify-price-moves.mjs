#!/usr/bin/env node
// scripts/verify-price-moves.mjs — the follow-up that keeps asking until every flagged move is answered.
//
//   node scripts/verify-price-moves.mjs            # ask about every flagged move still unverified
//   MUNS_TOKEN=… node scripts/verify-price-moves.mjs
//   MUNS_VERIFY_BUDGET_MS=600000 node scripts/verify-price-moves.mjs
//
// WHY THIS IS A SEPARATE SCRIPT. The daily scrape re-derives every ±4% move from the Muns
// market-data endpoint before it writes technicals.json, and that endpoint's anonymous quota is a
// few requests an hour: measured, eighteen calls at one every three seconds were all refused, and
// the refusal outlasted the run by more than forty minutes. A run that has already paid for 603
// Yahoo fetches must not sit for an hour waiting on a dozen more — so the scrape asks what it can,
// records what it could not (`move_check: unavailable`), commits, and THIS script comes back later
// and asks only about those. It runs on its own small schedule through the day
// (.github/workflows/price-move-verify.yml), reads the committed checks file first so nothing is
// asked twice, and commits technicals.json only if a row actually changed.
//
// It rewrites rows in place — `pct_change_today` and the `move_*` fields — and recomputes the two
// header figures a corrected move can change (`market_breadth`, `price_date`) through the same
// helpers the scrape uses. Everything else in the file is left byte-for-byte.

import { readFileSync, writeFileSync } from 'node:fs';
import { writeCompanyQuotes } from './lib/company-quotes.mjs';
import { verifyMoves, loadChecks, saveChecks, CHECKS_PATH, SOURCE_LABEL } from './lib/muns-market-data.mjs';
import { marketBreadth, priceDateOf } from './lib/technicals-file.mjs';

const TECHNICALS_PATH = new URL('../public/data/technicals.json', import.meta.url).pathname;

const payload = JSON.parse(readFileSync(TECHNICALS_PATH, 'utf8'));
const rows = Array.isArray(payload.companies) ? payload.companies : [];
const before = JSON.stringify(rows.map((r) => [r.ticker, r.pct_change_today, r.move_check]));

console.log(`technicals.json: ${rows.length} rows, session ${payload.price_date || 'unknown'}, written ${payload.generated_at}`);
const checks = loadChecks(CHECKS_PATH);
const summary = await verifyMoves(rows, {
  checks,
  log: (line) => console.log(line),
  budgetMs: Number(process.env.MUNS_VERIFY_BUDGET_MS) || 20 * 60_000,
});
saveChecks(CHECKS_PATH, checks);
console.log(`flagged ${summary.flagged} · from cache ${summary.cached} · asked ${summary.requests} · confirmed ${summary.confirmed} · corrected ${summary.corrected} · still unavailable ${summary.unavailable} · refusals ${summary.refusals} in ${Math.round(summary.elapsed_ms / 1000)}s${summary.budget_exhausted ? ' (budget exhausted)' : ''}`);

const after = JSON.stringify(rows.map((r) => [r.ticker, r.pct_change_today, r.move_check]));
if (after === before) {
  console.log('No row changed; technicals.json left untouched.');
  process.exit(0);
}

// The previous verification summary is folded, not replaced: the scrape's counts plus this pass.
const previous = payload.move_verification && !payload.move_verification.skipped ? payload.move_verification : null;
payload.move_verification = {
  source: SOURCE_LABEL,
  threshold_pct: summary.threshold_pct,
  alert_pct: summary.alert_pct,
  flagged: summary.flagged,
  checked: rows.filter((r) => r.move_source === SOURCE_LABEL).length,
  confirmed: rows.filter((r) => r.move_check === 'confirmed').length,
  corrected: rows.filter((r) => r.move_check === 'corrected').length,
  unavailable: rows.filter((r) => r.move_check === 'unavailable').length,
  refusals: (previous?.refusals || 0) + summary.refusals,
  passes: (previous?.passes || 1) + 1,
  last_pass_at: new Date().toISOString(),
};
payload.market_breadth = marketBreadth(rows);
payload.price_date = priceDateOf(rows);
payload.price_date_rows = rows.filter((r) => r.bar_date === payload.price_date).length;
writeFileSync(TECHNICALS_PATH, JSON.stringify(payload) + '\n');
writeCompanyQuotes(payload, new URL('../public/data/company-quotes.json', import.meta.url));
console.log(`Wrote ${TECHNICALS_PATH}: ${payload.move_verification.checked} of ${summary.flagged} flagged moves now carry the endpoint's figure.`);
