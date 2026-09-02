#!/usr/bin/env node
// scripts/scrape-super-investors.mjs — one committed snapshot of every super-investor's book.
//
//   node scripts/scrape-super-investors.mjs
//   SI_BASE=http://127.0.0.1:8787 node scripts/scrape-super-investors.mjs     # against wrangler dev
//   SI_LIMIT=5 node scripts/scrape-super-investors.mjs                        # a smoke run
//
// WHY THIS EXISTS: NINETY-ONE ROUND TRIPS ARE NINETY-ONE ROUND TRIPS.
//   Superstar Investors is the list plus one page per investor, because each book is a separate
//   scrape upstream. Conditional fetching already made a return visit nearly free in BYTES — every
//   unchanged book is a bodyless 304 — and it can do nothing about the fact that ninety-one
//   confirmations four at a time is twenty-three sequential waits. A first visit on a cold device
//   therefore watched the grid fill for the better part of a minute.
//
//   Every other bulk feed here is served from a committed snapshot for exactly this reason. This is
//   that, for the one feed that had not got it: one fetch of ~460KB and the whole grid is on screen
//   with no request per investor at all.
//
// IT READS OUR OWN WORKER, NOT FINOLOGY.
//   The upstream needs `Authorization: Bearer …` and that token lives on the Worker and nowhere
//   else — putting it in a script would mean putting it in a shell history and a CI log. The
//   Worker's own `/api/super-investors` routes are open, already normalise the payload, and hold
//   each book in an edge cache, so a run here is mostly cache reads and costs their service far
//   less than ninety readers doing it themselves.
//
// A SNAPSHOT THAT IS MOSTLY MISSING IS WORSE THAN NO SNAPSHOT, because the tab would paint it and
// report the gap as the whole book. So this refuses to write below MIN_COVERAGE unless SI_FORCE=1,
// and a book that failed is recorded under `failed` rather than written as an empty one.

import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/super-investors.json');

const BASE = (process.env.SI_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.SI_CONCURRENCY || 4);
const LIMIT = Number(process.env.SI_LIMIT || 0);
const MIN_COVERAGE = 0.8;
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const url = `${BASE}${path}`;
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        last = new Error(`${url} answered HTTP ${res.status}`);
        if (res.status < 500) throw last;
      } else {
        return await res.json();
      }
    } catch (err) {
      clearTimeout(timer);
      last = err;
    }
    if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }
  throw last || new Error(`${url} could not be read`);
}

const list = await getJson('/api/super-investors');
if (!list || list.ok === false || !Array.isArray(list.investors) || !list.investors.length) {
  console.error(`The investor list could not be read: ${list?.reason || 'no investors'} — ${list?.message || ''}`);
  process.exit(1);
}

const investors = LIMIT ? list.investors.slice(0, LIMIT) : list.investors;
console.log(`${investors.length} investors from ${BASE}`);

const books = {};
const failed = {};
let done = 0;

const queue = investors.map((i) => i.slug).filter(Boolean);
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      try {
        const body = await getJson(`/api/super-investors/${encodeURIComponent(slug)}`);
        if (!body || body.ok === false) {
          failed[slug] = { reason: body?.reason || 'upstream', message: body?.message || 'The book could not be read.' };
        } else if (body.stale === true) {
          // A last-good copy the Worker served during an outage. Real filed data of a known age —
          // but capturing it would freeze somebody else's outage into a committed file for a week.
          failed[slug] = { reason: 'stale', message: 'The Worker served its last-good copy; not captured.' };
        } else {
          books[slug] = body;
        }
      } catch (err) {
        failed[slug] = { reason: 'unreachable', message: String(err?.message || err) };
      }
      done++;
      if (done % 10 === 0) process.stdout.write(`\r  ${done}/${investors.length} …`);
    }
  })
);

// A SECOND PASS OVER THE FAILURES, because the first touch of a book is the expensive one.
// The Worker holds each book in an edge cache for six hours; a cold entry means a live scrape
// upstream, which is what times out. By the time the walk has finished, the entry it timed out
// filling is usually warm — measured, all four of one run's failures answered in ~1.4s on the
// retry. Retrying once here is the difference between a snapshot of 86 books and one of 90.
const retryable = Object.entries(failed).filter(([, f]) => f.reason !== 'stale').map(([slug]) => slug);
if (retryable.length) {
  process.stdout.write(`  retrying ${retryable.length} …`);
  let recovered = 0;
  for (const slug of retryable) {
    try {
      const body = await getJson(`/api/super-investors/${encodeURIComponent(slug)}`);
      if (body && body.ok !== false && body.stale !== true) {
        books[slug] = body;
        delete failed[slug];
        recovered++;
      }
    } catch {
      /* keep the original failure */
    }
  }
  process.stdout.write(` ${recovered} recovered\n`);
}

const covered = Object.keys(books).length;
const positions = Object.values(books).reduce((a, b) => a + (Array.isArray(b.holdings) ? b.holdings.length : 0), 0);
process.stdout.write(`\r  ${done}/${investors.length} — ${covered} books, ${positions} positions, ${Object.keys(failed).length} failed\n`);

if (covered < investors.length * MIN_COVERAGE && !process.env.SI_FORCE) {
  console.error(`\nRefusing to write: only ${covered} of ${investors.length} books landed. Re-run, or set SI_FORCE=1 to write it anyway.`);
  process.exit(1);
}

const snapshot = {
  capturedAt: new Date().toISOString(),
  source: 'Ticker Finology, captured through this dashboard’s Worker and refreshed on demand',
  count: investors.length,
  dropped: list.dropped || 0,
  covered,
  positions,
  failedCount: Object.keys(failed).length,
  investors,
  // The Worker's OWN bodies, unedited. The browser re-normalises them exactly as it does a live
  // response, which is the same rule the device store follows: never a locally patched copy.
  books,
  failed,
};

await writeFile(OUT, `${JSON.stringify(snapshot, null, 0)}\n`);
console.log(`\nwrote ${OUT} — ${covered}/${investors.length} books, ${positions} positions`);
