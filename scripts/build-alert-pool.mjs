#!/usr/bin/env node
// BUILD THE PRECOMPUTED ALERT POOL — the same collection the browser performs, run once on the
// runner over the committed captures, and written as the members one Actions artifact carries.
//
// Nothing here reads a live upstream. Every route the collectors ask for is answered from the
// committed files exactly as the offline verification suites answer it, with one exception the
// browser also has: the insider feed folds in the bulk/block artifact the Worker serves, so the
// builder reads the newest one (GH_TOKEN on the runner; ALERT_POOL_EXCHANGE_FILE for a local run)
// and records which one, so the browser can tell whether the pool matches what it would read.
//
//   node scripts/build-alert-pool.mjs <out-dir>          write index.json, days/*.json.gz, ai/*.json.gz
//   ALERT_POOL_VERIFY=1                                  also decode every written member and assert
//                                                        it carries exactly the collector's events
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const outDir = resolve(process.argv[2] || 'tmp/alert-pool');
const started = performance.now();

// The browser's data modules expect a window-less, DOM-free environment plus these two globals.
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
// One instant for the whole build: every reading that compares against the clock reads the same one.
const now = Date.now();
Date.now = () => now;

const { AI_POOL_LOOKBACK_DAYS } = await import('../public/js/data/alert-pool-shared.js');
const { CONTEXT_LOOKBACK_DAYS } = await import('../public/js/data/intelligence-graph.js');
assert.equal(AI_POOL_LOOKBACK_DAYS, CONTEXT_LOOKBACK_DAYS, 'the AI pool must reach as far back as the card context does');

// THE EXCHANGE ARTIFACT, IF IT CAN BE READ. Without it the insider feed still builds from the
// committed seed, and the index records that it did — the browser then keeps the live path for
// insider trades rather than adopting rows built from an older deal list than it would read.
let exchange = null;
if (process.env.ALERT_POOL_EXCHANGE_FILE) {
  const file = process.env.ALERT_POOL_EXCHANGE_FILE;
  const bytes = readFileSync(file);
  exchange = { text: file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'), id: Number(process.env.ALERT_POOL_EXCHANGE_ID) || null };
} else if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY) {
  const { latestExchangeArtifact } = await import('../worker/exchange-artifact.mjs');
  try {
    exchange = await latestExchangeArtifact({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
    if (exchange) console.log(`[alert-pool] insider feed folds in exchange artifact ${exchange.id}`);
  } catch (error) { console.warn(`[alert-pool] exchange artifact unavailable: ${error.message}`); }
}

const { offlineFetch, captureIdentities, writePoolMembers, verifyPoolMembers } = await import('./lib/alert-pool-build.mjs');
globalThis.fetch = offlineFetch({ root, exchange });
const coverage = await import('../public/js/data/coverage.js');
coverage.prime(JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'), 'utf8')));
const alerts = await import('../public/js/data/daily-alerts.js');
const { news } = await import('../public/js/data/filings.js');
const { publicAlertFeed } = await import('../public/js/data/all-alerts-cache.js');

const day = alerts.today();
console.log(`[alert-pool] collecting the full Universe history for ${day}`);
const report = await alerts.collect({ scope: 'universe', day, includeHistory: true });
const sourceFeeds = report.sourceFeeds.filter(publicAlertFeed);
const index = writePoolMembers({ outDir, sourceFeeds, day, now, book: coverage.holdings(), newsMeta: news.meta(),
  captures: captureIdentities({ root, exchange }) });
const allMembers = [...index.days, ...index.ai].flatMap(entry => [entry, ...Object.values(entry.feedMembers || {}).filter(Boolean)]);
const totalBytes = allMembers.reduce((n, entry) => n + entry.bytes, 0);
console.log(`[alert-pool] wrote ${index.days.length} day shards and ${index.ai.length} AI shards, ${Math.round(totalBytes / 1024)} KB gzipped, in ${Math.round((performance.now() - started) / 1000)}s`);
for (const entry of index.days.slice(-3)) console.log(`  ${entry.member}: ${entry.count} events, ${Math.round(entry.bytes / 1024)} KB gz`);
for (const entry of index.ai.slice(-3)) console.log(`  ${entry.member}: ${entry.count} events, ${Math.round(entry.bytes / 1024)} KB gz`);
for (const [feedId, feed] of Object.entries(index.feeds)) console.log(`  ${feedId}: ${feed.row.status}, as of ${feed.row.asOf}, ${index.sourceEvents[feedId]} events`);

if (process.env.ALERT_POOL_VERIFY === '1') {
  verifyPoolMembers({ outDir, sourceFeeds, index });
  console.log(`[alert-pool] verified: every member decodes and carries exactly the collector's events (${Math.round((performance.now() - started) / 1000)}s)`);
}
