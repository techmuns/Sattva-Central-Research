#!/usr/bin/env node
// scripts/scrape-filings.mjs — news and insider trades for the universe.
//
//   node scripts/scrape-filings.mjs                              news and insider, the whole universe
//   node scripts/scrape-filings.mjs news                          just one feed
//
//   Corporate announcements are NOT here — see scripts/scrape-bse-announcements.mjs.
//   FILINGS_LIMIT=20 node scripts/scrape-filings.mjs             a smoke run
//   FILINGS_SCOPE=book node scripts/scrape-filings.mjs           the 123 book tickers only
//   FILINGS_BASE=http://127.0.0.1:8787 node scripts/…            against wrangler dev
//   MUNS_TOKEN=… node scripts/scrape-filings.mjs                 straight at the upstream instead
//
// Writes public/data/news.json and insider-trades.json.
//
// WHY THIS EXISTS AT ALL, WHEN THERE ARE PERFECTLY GOOD LIVE ROUTES
//   Two of these three upstreams are per-ticker and all three are rate limited to about sixty
//   requests a minute. The universe is 603 companies, so "show me everything" live is 603 requests
//   and ten minutes — on every visit, against somebody else's service. That is not a page load.
//
//   So the schedule pays that cost once and commits the result, and the browser reads one file. The
//   live routes stay, for the companies a snapshot does not cover yet and for refreshing one
//   company on demand. Same division as the technicals feed.
//
// BY DEFAULT IT READS THIS DASHBOARD'S OWN WORKER, NOT THE UPSTREAM DIRECTLY.
//   All three upstreams want `Authorization: Bearer …`, and that token lives on the Worker and
//   nowhere else — a script that held it would put it in a shell history and a CI log, which is the
//   one thing the whole proxy arrangement exists to prevent. The Worker's `/api/news`,
//   `/api/announcements/{t}` and `/api/insider-trades/{t}` routes are open, already normalise the
//   payload, and hold each answer in an edge cache, so a run costs the upstream less than the same
//   walk made directly. It also means THIS JOB NEEDS NO SECRET, which is why it can live in the
//   scheduled workflow beside the others.
//
//   `MUNS_TOKEN` still switches it back to calling the upstream directly, for a run from a machine
//   that has one and no deployed Worker to lean on.
//
// THE TOKEN, WHERE ONE IS USED, IS READ FROM THE ENVIRONMENT AND NEVER WRITTEN ANYWHERE. It is a
// session JWT and it expires, so a run that starts working and then 401s halfway is expected rather
// than a bug — the output records how far it got instead of pretending the rest had nothing.
//
// A COMPANY THAT COULD NOT BE READ IS NOT A COMPANY WITH NOTHING. Failures are written into the
// snapshot under `failed`, with the reason, so the tab can say "40 could not be read" rather than
// silently showing 563 of 603 as if that were the whole picture.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNews, fetchInsiderTrades, MunsError } from '../worker/muns.mjs';
import { mergeLastGoodFilings } from './lib/filings-snapshot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => resolve(__dirname, '../public/data', f);

// ANNOUNCEMENTS ARE NO LONGER HERE, AND MUST NOT COME BACK TO THIS SCRIPT.
//
// They are read by DATE from BSE instead — `scripts/scrape-bse-announcements.mjs` — which covers
// every listed company in about twenty requests rather than reaching 118 of them in six hundred.
// Leaving the feed defined here would be worse than useless: a routine run of this script would
// silently overwrite `corp-announcements.json` with the truncated per-company version, and the file
// would look fine because it would still be a valid snapshot. It is deleted rather than commented
// out for exactly that reason.
const FEEDS = {
  news: { file: 'news.json', rowsKey: 'articles', windowDays: 30 },
  insider: { file: 'insider-trades.json', rowsKey: 'trades', windowDays: 365 },
};

// Sixty requests a minute is the documented ceiling. One request per second with four in flight
// sits under it with room for the retries muns.mjs does on a timeout — and being comfortably under
// somebody else's limit is cheaper than discovering where it is.
const CONCURRENCY = 4;
const GAP_MS = 250;

const env = { MUNS_TOKEN: process.env.MUNS_TOKEN, MUNS_NEWS_TOKEN: process.env.MUNS_NEWS_TOKEN, MUNS_BASE: process.env.MUNS_BASE, MUNS_NEWS_BASE: process.env.MUNS_NEWS_BASE };

// Our own Worker, unless a token says to go straight to the source. See the header.
const BASE = (process.env.FILINGS_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const VIA_WORKER = !process.env.MUNS_TOKEN;
const REQ_TIMEOUT_MS = Number(process.env.FILINGS_TIMEOUT_MS || 120_000);
const REQ_ATTEMPTS = 2;

/**
 * One read through our own Worker, in the same shape `worker/muns.mjs` returns.
 *
 * The routes answer a failure as HTTP 200 carrying `ok: false` and a NAMED reason — see the header
 * of `handleMuns` — so the reason is lifted back into a MunsError here and the caller's existing
 * handling (record it against the ticker; stop the whole feed on an expired token) works unchanged
 * whichever path the run took.
 */
async function viaWorker(path, label) {
  let last = null;
  for (let attempt = 1; attempt <= REQ_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      if (!res.ok) {
        last = new MunsError('upstream', `${label} answered HTTP ${res.status}.`, { status: res.status, url: `${BASE}${path}` });
      } else {
        const body = await res.json();
        if (body && body.ok === false) throw new MunsError(body.reason || 'upstream', body.message || `${label} could not be read.`, { url: body.requestedUrl || `${BASE}${path}` });
        return body;
      }
    } catch (err) {
      if (err instanceof MunsError) throw err;
      last = new MunsError('unreachable', `${label} could not be reached: ${String(err?.message || err)}`, { url: `${BASE}${path}` });
    }
  }
  throw last;
}

const range = (from, to) => `from=${from}&to=${to}`;
// EACH ROUTE APPENDS ITS OWN RANGE, because only the route knows whether it already has a query
// string — the same rule, and the same bug, as ROUTE in js/data/filings.js.
const readNews = (query, from, to) => viaWorker(`/api/news?q=${encodeURIComponent(query)}&${range(from, to)}`, 'The news API');
const readInsider = (t, from, to) => viaWorker(`/api/insider-trades/${encodeURIComponent(t)}?${range(from, to)}`, 'The insider-trades API');
const LIMIT = Number(process.env.FILINGS_LIMIT || 0);
const SCOPE = process.env.FILINGS_SCOPE || 'universe';
const only = process.argv.slice(2).filter((a) => FEEDS[a]);
const wanted = only.length ? only : Object.keys(FEEDS);

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The companies to walk: the book first, then the rest of the universe.
 *
 * BOOK FIRST IS DELIBERATE. A run that is cut short — by the rate limit, by an expiring token, by
 * the Action's time budget — should have covered the holdings before the index. The alphabetical
 * order that fell out of the file would have covered whatever happened to start with A.
 */
function companies() {
  const book = JSON.parse(readFileSync(DATA('portfolio-companies.json'), 'utf8'));
  const held = (book.holdings || []).filter((h) => h.ticker).map((h) => ({ ticker: h.ticker.toUpperCase(), name: h.name, held: true }));
  if (SCOPE === 'book') return dedupe(held);

  const tech = JSON.parse(readFileSync(DATA('technicals.json'), 'utf8'));
  const rest = (tech.companies || []).filter((c) => c.ticker).map((c) => ({ ticker: String(c.ticker).toUpperCase(), name: c.name, held: false }));
  return dedupe([...held, ...rest]);
}

/** The committed snapshot as it stands, or null. Used to refuse to replace a better one. */
function readIfPresent(file) {
  try {
    return JSON.parse(readFileSync(DATA(file), 'utf8'));
  } catch {
    return null;
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c.ticker)) continue;
    seen.add(c.ticker);
    out.push(c);
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

/** One feed, walked CONCURRENCY at a time, writing what it got even if it did not get all of it. */
async function run(kind, list) {
  const { file, rowsKey, windowDays } = FEEDS[kind];
  const from = daysAgo(windowDays);
  const to = iso(Date.now());

  const byTicker = {};
  // AN ANSWER OF "NOTHING" IS STILL AN ANSWER, and it has to be recorded as one. The news route
  // answers a company it found nothing for with a single all-null row carrying only the query; the
  // insider route answers with an empty list. Neither was written to `byTicker`, so the company
  // vanished from the file — indistinguishable from one the run never reached, and the browser
  // counted it outstanding for ever: measured, the tab said "51 companies have not been checked
  // since" about 51 companies that HAD been checked and genuinely have no trades.
  const empty = [];
  const failed = {};
  const headers = new Set();
  let done = 0;

  const queue = [...list];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      try {
        let res;
        // THE COMPANY NAME, AND NOTHING APPENDED TO IT. The query used to end "share price results",
        // which reads like a helpful narrowing and is not: measured against one company it swapped a
        // Moneycontrol quarterly-results story for an unrelated IPO story, because the extra words
        // are themselves terms the engine ranks on. The browser's live walk sends the same query —
        // see ROUTE.news in js/data/filings.js — so the snapshot and the walk cannot disagree about
        // what a company's news is.
        // Announcements are deliberately absent — see the FEEDS note above. They come from BSE's
        // date index now, so there is no per-company branch here to keep.
        if (kind === 'news') res = VIA_WORKER ? await readNews(c.name || c.ticker, from, to) : await fetchNews({ query: c.name || c.ticker, country: 'IN', fromDate: from, toDate: to }, env);
        else res = VIA_WORKER ? await readInsider(c.ticker, from, to) : await fetchInsiderTrades({ ticker: c.ticker, country: 'india', fromDate: from, toDate: to }, env);

        const rows = res[rowsKey] || [];
        // `raw` is for the browser's drill, not for a committed file — it is the whole upstream
        // record again and would multiply the snapshot several times over for nothing.
        // STRIP `raw` FIRST, THEN ASK WHETHER THE ROW CARRIES ANYTHING. `raw` is the whole upstream
        // record again — it is never committed, and it is never null, so testing before stripping it
        // says every row carries something and the test passes for the wrong reason. Measured: 46
        // all-null placeholders went straight back into the file under a predicate written to catch
        // exactly them. `query` is the term we sent rather than anything the upstream published, so
        // a row left carrying only that is the news API saying it found nothing — not an article.
        const published = rows.map(({ raw, ...rest }) => rest);
        const carries = (r) => r && Object.entries(r).some(([k, v]) => k !== 'query' && v !== null && v !== undefined && v !== '');
        const usable = published.filter(carries);
        if (usable.length) byTicker[c.ticker] = usable;
        else empty.push(c.ticker);
        for (const h of res.headers || []) headers.add(h);
      } catch (err) {
        const e = err instanceof MunsError ? err : new MunsError('upstream', String(err?.message || err));
        failed[c.ticker] = { reason: e.reason, message: e.message };
        // An expired token will not fix itself, and walking six hundred more companies to collect
        // six hundred identical 401s wastes half an hour and the whole rate-limit budget.
        if (e.reason === 'no-token' || e.reason === 'unauthorised') {
          queue.length = 0;
          console.error(`\n  ${kind}: stopping — ${e.message}`);
          return;
        }
      }
      done++;
      if (done % 25 === 0) process.stdout.write(`\r  ${kind}: ${done}/${list.length} …`);
      await sleep(GAP_MS);
    }
  });
  await Promise.all(workers);

  const rowCount = Object.values(byTicker).reduce((a, r) => a + r.length, 0);
  let payload = {
    _provenance:
      `REAL DATA, NOT OURS. ${kind} for Indian listed companies via the Muns API, reaching back ${windowDays} days. ` +
      'Headlines, subjects, column headings and wording are the source\'s own, reproduced unchanged and never summarised. ' +
      (kind === 'insider' ? 'Insider disclosures accumulate within the date window; an empty or partial response does not retract retained events. ' : '') +
      'A company in `byTicker` had something; one in `empty` was asked and answered nothing; one in `failed` could not be read; ' +
      'one in none of the three was never reached. Those are four different answers and must not be conflated.',
    kind,
    source: VIA_WORKER ? 'Muns filings/news API, read through this dashboard’s Worker' : 'Muns filings/news API',
    generator: 'scripts/scrape-filings.mjs',
    capturedAt: new Date().toISOString(),
    from,
    to,
    windowDays,
    scope: SCOPE,
    asked: list.length,
    // COMPANIES THAT ANSWERED, not companies that had something to say — different numbers, and
    // only the first one measures the run. `withRows` is the second, kept beside it so neither has
    // to be derived by subtraction.
    covered: Object.keys(byTicker).length + empty.length,
    withRows: Object.keys(byTicker).length,
    emptyCount: empty.length,
    rowCount,
    failedCount: Object.keys(failed).length,
    headers: [...headers],
    byTicker,
    empty,
    failed,
  };
  // A BAD RUN MUST NOT REPLACE A GOOD SNAPSHOT. The insider-trades upstream was measured returning
  // a timeout for every single ticker; writing that run would have swapped a complete file for one
  // covering nobody, and the tab would have painted the result as "these companies have nothing".
  // An outage is not an absence of events — the same rule the `failed` map exists for, applied to
  // the file as a whole.
  // Nothing at all came back. Measured on 19 Aug 2026: fastapi.muns.io answered 502 to every news
  // query and devde.muns.io did not answer at all, so a run wrote a snapshot covering nobody — and
  // a snapshot covering nobody is a file that says "these 123 companies have no news", which is a
  // measurement nobody made. An outage is not an absence of events.
  if (!payload.covered && list.length && !process.env.FILINGS_FORCE) {
    console.log(`\r  ${kind}: nothing came back for any of ${list.length} companies — the upstream is down. Nothing written.`);
    return;
  }

  const previous = readIfPresent(file);
  // AND A COLLAPSE IN COMPANIES THAT HAD SOMETHING, which `covered` cannot see any more. Once
  // `covered` counted answers rather than rows, an upstream timing out stopped looking like a bad
  // run at all: every company answers "nothing", `empty` absorbs them, `covered` stays at the full
  // list, and the guard waves through a snapshot with a third of the articles. Measured on the
  // 06:30 scheduled run against a healthy 07:0x one: 77 companies with news -> 23, 1,536 rows ->
  // 450, and `covered` was 123 both times.
  //
  // Proportional rather than absolute, because this number legitimately drifts — a company has news
  // this week and none next — and a strict "never fewer" would block almost every honest run. Half
  // is far outside that drift and squarely inside an outage.
  const prevWithRows = previous ? (previous.withRows ?? Object.keys(previous.byTicker || {}).length) : 0;
  if (kind !== 'insider' && previous && prevWithRows >= 8 && payload.withRows < prevWithRows / 2 && !process.env.FILINGS_FORCE) {
    console.log(
      `\r  ${kind}: only ${payload.withRows} companies had anything, against ${prevWithRows} in the committed ` +
        'snapshot — that is an upstream problem, not a quiet week. Keeping it; set FILINGS_FORCE=1 to override.'
    );
    return;
  }

  // A UNIVERSE WALK IS HUNDREDS OF INDEPENDENT ANSWERS, NOT ONE ALL-OR-NOTHING FILE.
  //
  // The old coverage guard discarded an entirely newer run when it reached even one fewer company
  // than yesterday. On 2 Sep it read 584 companies, yesterday held 585, and all 584 fresh answers
  // were thrown away. Merge at the company boundary instead: fresh rows or a fresh empty answer
  // win, and a failed/not-reached company retains its last-known-good answer. The unresolved map is
  // what remains after that recovery, so the UI can retry real gaps without freezing everybody.
  // Insider events are additive even after an empty/partial response or a forced capture. Their
  // rolling date window bounds retention, so the news collapse guard must not discard new trades.
  if (kind === 'insider' || (previous && !process.env.FILINGS_FORCE)) {
    payload = mergeLastGoodFilings(payload, previous, list);
  }

  writeFileSync(DATA(file), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `\r  ${kind}: ${payload.rowCount} rows across ${payload.withRows} companies (${list.length} requested)` +
      `${payload.emptyCount ? `, ${payload.emptyCount} asked and had nothing` : ''}` +
      `${payload.fallbackCount ? `, ${payload.fallbackCount} retained from last-good data` : ''}` +
      `${payload.failedCount ? `, ${payload.failedCount} could not be read` : ''} -> public/data/${file}`
  );
}

const list = companies();
console.log(`Walking ${list.length} companies (${SCOPE}) for: ${wanted.join(', ')}`);
console.log(VIA_WORKER ? `  through ${BASE} — no token needed here; the Worker holds it\n` : '  straight at the upstream, with MUNS_TOKEN\n');
for (const kind of wanted) await run(kind, list);
