#!/usr/bin/env node
// BUILD THE SERVER-SIDE CORPORATE ANNOUNCEMENTS INDEX — the merge the Corporate Announcements tab used
// to perform in every reader's browser, performed once here over the committed captures, tagged,
// scored and stitched, and written as the members of one Actions artifact
// (.github/workflows/announcement-index-refresh.yml). The Worker's index object reads it by byte range.
//
//   node --max-old-space-size=6144 scripts/build-announcement-index.mjs <out-dir>
//   ANNOUNCEMENT_INDEX_VERIFY=1     also decode every segment and assert it round-trips
//
// Nothing here reads an upstream: every route the feed asks for is answered from the committed files.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const outDir = resolve(process.argv[2] || 'tmp/announcement-index');
const started = performance.now();

// The browser's data modules expect a window-less environment plus these globals.
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
// One instant for the whole build, so every period reading agrees.
const now = Date.now();
Date.now = () => now;

const lib = await import('./lib/announcement-index-build.mjs');
globalThis.fetch = lib.offlineFetch(root);
const coverage = await import('../public/js/data/coverage.js');
coverage.prime(JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'), 'utf8')));

const { feed, rows, meta } = await lib.loadStream();
console.log(`[announcement-index] loaded ${rows.length} filings in ${Math.round((performance.now() - started) / 1000)}s`);
const profiles = lib.profilesFrom(root);
const built = lib.buildIndex({ rows, feed, profiles });
console.log(`[announcement-index] ${built.counts.rows} rows, ${built.counts.companies} companies, ${built.counts.multiEvents} multi-filing events (${Math.round((performance.now() - started) / 1000)}s)`);
const sourceMeta = {
  capturedAt: meta.capturedAt || null, windowDays: meta.windowDays ?? null, coversUniverse: meta.coversUniverse ?? null,
  archive: meta.archive ? { loaded: !!meta.archive.loaded, error: meta.archive.error || null, rows: meta.archive.rows ?? null } : null,
  recovery: meta.recovery || null, sharedError: meta.sharedError || null,
  identity: meta.identity ? { capturedAt: meta.identity.capturedAt || null, error: meta.identity.error || null } : null,
  nse: meta.nse ? { capturedAt: meta.nse.capturedAt || null, error: meta.nse.error || meta.nse.degraded || null } : null,
  profiles: profiles.meta,
};
const index = lib.writeIndexMembers({ outDir, built, now, meta: sourceMeta, captures: lib.captureIdentities(root) });
const bytes = index.packs.reduce((n, p) => n + p.bytes, 0) + index.companies.bytes;
console.log(`[announcement-index] wrote ${index.days.length} day segments in ${index.packs.length} packs, ${Math.round(bytes / 1024)} KB gzipped, in ${Math.round((performance.now() - started) / 1000)}s`);
for (const d of index.days.slice(0, 3)) console.log(`  ${d.day}: ${d.rows} filings, ${Math.round(d.length / 1024)} KB gz`);
if (process.env.ANNOUNCEMENT_INDEX_VERIFY === '1') {
  lib.verifyIndexMembers({ outDir, index, built });
  console.log(`[announcement-index] verified every segment round-trips (${Math.round((performance.now() - started) / 1000)}s)`);
}
