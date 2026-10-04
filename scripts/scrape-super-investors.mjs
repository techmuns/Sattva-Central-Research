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

import { writeFile, readFile, rename, appendFile } from 'node:fs/promises';
import { assembleSnapshot, validateBook } from './lib/investor-snapshot.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SI_OUT || resolve(__dirname, '../public/data/super-investors.json');
const previous = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));

const BASE = (process.env.SI_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.SI_CONCURRENCY || 4);
const LIMIT = Number(process.env.SI_LIMIT || 0);
if (LIMIT && !process.env.SI_OUT) throw new Error('A limited smoke run requires SI_OUT; it must not overwrite the complete snapshot');
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
// The Worker keeps a stale answer for INVESTOR_STALE_TTL_S (30s); a retry sooner than this would
// be handed the same stale copy instead of reaching a live read. Settable so a test need not wait.
const STALE_RETRY_AFTER_MS = Number(process.env.SI_STALE_RETRY_AFTER_MS || 35_000);
// Failures in a row on the retry pass that mean the relay is down rather than slow for one book.
const OUTAGE_STREAK = 5;
// What `validateBook` throws for a response that answered but is not a book.
const SHAPE_ERROR = /portfolio shape|Invalid holding|Unexpected empty|older than|regressed/;

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

// THE LIST ROUTE FAILING IS NOT A REASON TO ASK ABOUT NOTHING. On 15–16 September 2026 the
// Finology relay answered `/super-investors` with HTTP 502 for five scheduled runs in a row, and
// this script exited before touching a single book — while the Worker still held every book in its
// six-hour edge cache. The retained snapshot carries the same ninety names, so the walk runs off
// that list instead and records WHY the live list could not be read; whatever the books answer is
// then written per book, exactly as a run with a healthy list would write it. What it never does
// is pretend: `lastAttempt` names the failure, nothing refreshed keeps its old `fetchedAt`, and the
// run still exits non-zero.
const attemptedAt = new Date().toISOString();
let list = null;
let listError = null;
try {
  list = await getJson('/api/super-investors');
  if (!list || list.ok === false || !Array.isArray(list.investors) || !list.investors.length) {
    listError = `${list?.reason || 'no investors'} — ${list?.message || 'the list route answered without investors'}`;
    list = null;
  }
} catch (err) {
  listError = `unreachable — ${String(err?.message || err)}`;
}
if (!list) {
  if (!Array.isArray(previous.investors) || !previous.investors.length) {
    console.error(`The investor list could not be read and no retained list exists: ${listError}`);
    process.exit(1);
  }
  console.error(`The investor list could not be read: ${listError}. Walking the ${previous.investors.length} retained names instead.`);
  list = { investors: previous.investors, dropped: previous.dropped || 0 };
}

const investors = LIMIT ? list.investors.slice(0, LIMIT) : list.investors;
console.log(`${investors.length} investors from ${listError ? 'the retained snapshot' : BASE}`);

const books = {};
const failed = {};
const staleAt = {};
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
          staleAt[slug] = Date.now();
        } else {
          books[slug] = validateBook(body, slug, previous.books?.[slug]);
        }
      } catch (err) {
        // `validateBook` refuses a response that answered but is not a book — a wrong slug, no
        // quarters, regressed periods. That is a SHAPE failure and used to be filed as
        // `unreachable`, which sent the reader after a network that had answered perfectly well.
        failed[slug] = { reason: SHAPE_ERROR.test(String(err?.message)) ? 'shape' : 'unreachable', message: String(err?.message || err) };
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
//
// A STALE ANSWER IS RETRIED TOO, because it is the same timeout seen from the Worker's side: its own
// live read of the book failed during the walk, so it served the last-good copy. Excluding them left
// those books unrefreshed run after run — measured on 2 October 2026, 2 to 42 stale books in every
// one of nine runs, and all eight re-read minutes later answered live. A retry waits until the
// Worker's stale entry has expired, and a retry that is stale again is still refused: only a live
// answer is ever captured. Failures in a row mean the relay is down, not slow for one book, so the
// pass stops there rather than spending a full deadline on every remaining book; the run stays red.
// The retry asks the Worker to be PATIENT (`?patient=1`): one long attempt rather than a reader's
// thirteen seconds, because a book that misses that budget on every run can never be read inside it.
const retryable = Object.keys(failed);
if (retryable.length) {
  process.stdout.write(`  retrying ${retryable.length} …`);
  let recovered = 0;
  let streak = 0;
  for (const slug of retryable) {
    if (streak >= OUTAGE_STREAK) break;
    const wait = (staleAt[slug] ?? -Infinity) + STALE_RETRY_AFTER_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let outcome = 'failed';
    try {
      const body = await getJson(`/api/super-investors/${encodeURIComponent(slug)}?patient=1`);
      if (body && body.ok !== false && body.stale !== true) {
        books[slug] = validateBook(body, slug, previous.books?.[slug]);
        delete failed[slug];
        recovered++;
        outcome = 'recovered';
      }
    } catch (err) {
      // A book that answered but is not a book says nothing about whether the relay is up.
      if (SHAPE_ERROR.test(String(err?.message))) outcome = 'shape';
    }
    streak = outcome === 'failed' ? streak + 1 : 0;
  }
  process.stdout.write(` ${recovered} recovered${streak >= OUTAGE_STREAK ? ` (stopped after ${OUTAGE_STREAK} failures in a row)` : ''}\n`);
}

const covered = Object.keys(books).length;
const positions = Object.values(books).reduce((a, b) => a + (Array.isArray(b.holdings) ? b.holdings.length : 0), 0);
process.stdout.write(`\r  ${done}/${investors.length} — ${covered} books, ${positions} positions, ${Object.keys(failed).length} failed\n`);

const snapshot = assembleSnapshot({ list: { ...list, investors }, books, failed, previous, capturedAt: new Date().toISOString(),
  attempt: { at: attemptedAt, listError, refreshed: covered, failed: Object.keys(failed).length, base: BASE } });
await writeFile(`${OUT}.tmp`, `${JSON.stringify(snapshot)}\n`);
await rename(`${OUT}.tmp`, OUT);
console.log(`wrote ${OUT}: ${covered} refreshed, ${snapshot.retained.length} retained, ${snapshot.failedCount} failed`);
// THE RUN SUMMARY NAMES THE CAUSE, because "Holdings ingestion needs attention" sent an operator
// to read working code while the upstream was down. One line per thing that failed, in words.
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [`## Finology capture (${attemptedAt})`,
    listError ? `- **The live investor list could not be read** from \`${BASE}/api/super-investors\`: ${listError}. The walk used the ${investors.length} retained names.` : `- Investor list read: ${investors.length} investors.`,
    `- ${covered} books refreshed · ${snapshot.retained.length} retained from the previous capture · ${snapshot.failedCount} failed.`,
    ...Object.entries(failed).slice(0, 12).map(([slug, f]) => `- ${slug}: ${f.reason} — ${f.message}`),
    Object.keys(failed).length > 12 ? `- …and ${Object.keys(failed).length - 12} more; see the log.` : null].filter(Boolean);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
}
if (listError) console.error(`::error title=Finology relay unreachable::${BASE}/api/super-investors — ${listError}. The relay at devde.muns.io answers this route; nothing in this repository can bring it back. Retained books keep their last read time.`);
// Publish the last-good books and failure metadata, but surface an operational failure to CI.
if (snapshot.failedCount || listError) process.exitCode = 1;
