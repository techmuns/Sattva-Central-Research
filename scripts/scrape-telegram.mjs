#!/usr/bin/env node
// scrape-telegram.mjs — posts from a public Telegram channel, as a committed capture.
//
//     node scripts/scrape-telegram.mjs                    incremental: walk forward from the head
//     TELEGRAM_BACKFILL=400 node scripts/scrape-telegram.mjs   also walk back from the head
//     TELEGRAM_CHANNEL=someother node scripts/scrape-telegram.mjs
//
// WHAT IT WRITES
//     public/data/telegram-posts.json   posts, deduplicated by message id
//
// WHY THIS READS HTML PAGES AND NOT AN API, WHICH IS A MEASUREMENT AND NOT A PREFERENCE.
//     Telegram publishes three ways in and only one of them is open to us for THIS channel:
//
//       1. `t.me/s/<channel>` — the server-rendered preview. Ids, ISO timestamps, `data-before`
//          pagination, no credential. Measured against `@telegram`: 200, 127KB, 20 message blocks.
//          Measured against `@researchreportss`: **302 to the plain page, zero messages** — the
//          owner has the web preview switched off. So the good route is shut for this channel,
//          and every third-party bridge built on it (RSSHub and friends) is shut with it.
//       2. The Bot API. There is NO history method — verified against core.telegram.org/bots/api,
//          which has no `getChatHistory`/`getMessages` at all. A bot receives `channel_post`
//          updates only for a channel it has been made an ADMIN of, going forward. We do not own
//          this channel, so this is not a route we can take.
//       3. The message permalink, `t.me/<channel>/<id>`. This one is open: the page carries the
//          post's FULL text in `og:description`. That is what this script reads.
//
// WHAT THE PERMALINK ROUTE DOES NOT CARRY, AND WHY THAT IS SAID OUT LOUD RATHER THAN PAPERED OVER.
//     **No timestamp.** Verified: no `<time>`, no `datetime`, no widget markup — the page has og
//     tags and nothing else. So `publishedAt` is null on every post and the tab says *time not
//     published* in those words, exactly as the market-news cards do for a story whose date budget
//     was not reached. `firstSeenAt` is kept in its own field because it is a fact about THIS
//     SCRAPER, never about the post, and the two may not be confused.
//     Ordering is therefore by MESSAGE ID, which is monotonic with publication — the same reason
//     scrape-mc-news.mjs merges on Moneycontrol's own article id.
//
// THREE TRAPS MEASURED ON THIS CHANNEL, EACH OF WHICH PRODUCED A CONFIDENT WRONG ANSWER FIRST:
//
//   1. A 200 THAT IS NOT THE PAGE YOU ASKED FOR. An id with no readable post answers **200** with
//      the channel's own landing page (~11,175 bytes) rather than a 404. Its `og:description` is
//      the CHANNEL's description. So absence is read as `og:description === og:title`, and never
//      from the status code. Same class as BSE's `strCat=-1` and Moneycontrol's interstitial.
//   2. RATE LIMITING WEARS THAT SAME COSTUME. A fast unpaced walk gets the landing page for ids
//      that genuinely have text — measured: a burst reported "no text" for id 7260 while a single
//      paced request returned *"Sharekhan sees 32% UPSIDE in Mahindra Logistics"*. An unpaced walk
//      does not fail, it QUIETLY UNDER-REPORTS, so every miss is re-asked after a backoff before
//      it is believed.
//   3. A RUN OF MISSES DOES NOT MEAN THE END OF THE CHANNEL. Measured: 7530–7539 are ten
//      consecutive misses and **7540 is a real post**. Those ten are document posts with no
//      caption — this channel's stock in trade is broker report PDFs, and a PDF with no caption
//      has nothing on its page to read. So the head walk needs `MISS_RUN` well above any
//      plausible run of documents, and a bare "K misses, we must be done" would have silently
//      truncated the feed ten ids early.
//
// AND SO COVERAGE IS PART OF THE CAPTURE, NOT AN AFTERTHOUGHT. `scanned`, `readable` and
// `unreadable` are written to the file so the tab can say how much of the channel this route can
// see. A caption-less document is *a post we cannot read*, which is a different claim from *no
// post* and from *we never asked* — the three-state rule the filings snapshots already keep.
//
// NOTHING HERE IS SCORED, RANKED, SUMMARISED OR MAPPED TO A COMPANY. A channel post is somebody's
// own words, reproduced. See the scope limits in docs/DATA-CONTRACTS.md.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/telegram-posts.json');

const CHANNEL = String(process.env.TELEGRAM_CHANNEL || 'researchreportss').replace(/^@/, '');

// Telegram's own rule for a public username: 5–32 of [A-Za-z0-9_]. Validated here for the same
// reason the X handle is validated in three places — this value reaches a URL.
const CHANNEL_RE = /^[A-Za-z0-9_]{5,32}$/;

// The whole capture's ceiling, so the committed file cannot grow without bound. A bytes limit,
// not an editorial one — the same idea as MCNEWS's KEEP and the Twitter capture's.
const KEEP = Number(process.env.TELEGRAM_KEEP || 600);

// How many ids past the last real post before we accept we have reached the head. Measured runs of
// caption-less documents reach 10 on this channel; 60 is the margin over that. It costs one paced
// request each on an idle run and is the difference between a complete feed and one truncated at
// the first batch of PDFs.
const MISS_RUN = Number(process.env.TELEGRAM_MISS_RUN || 60);

// Ids to walk BACKWARDS from the head. Zero on a normal run — history does not change, so re-reading
// it every hour would be spending somebody else's service to confirm what we already hold.
const BACKFILL = Number(process.env.TELEGRAM_BACKFILL || 0);

// Pacing. Telegram serves the landing page instead of the post when pushed, so this is correctness
// rather than politeness — see trap 2 above.
const DELAY_MS = Number(process.env.TELEGRAM_DELAY_MS || 420);
const RETRIES = 3;
// How many times a BLANK is re-asked before it is recorded as unreadable. Two: one backed-off
// re-ask is what tells a caption-less document apart from a throttled request, and both answer
// with the identical 200. Roughly two thirds of this channel's ids are blank, so this is the
// dominant cost of a run and is deliberately not set higher.
const BLANK_RETRIES = 2;
const BLANK_PAUSE_MS = Number(process.env.TELEGRAM_BLANK_PAUSE_MS || 650);
const BUDGET_MS = Number(process.env.TELEGRAM_BUDGET_MS || 9 * 60 * 1000);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const outOfTime = () => Date.now() - started > BUDGET_MS;

// ---------------------------------------------------------------------------------------
// Reading one page
// ---------------------------------------------------------------------------------------

const META_RE = (prop) => new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'i');

/** Decode the entity set Telegram's og tags actually use. */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // last, so "&amp;#33;" cannot decode twice into a wrong glyph
}

const metaOf = (html, prop) => {
  const m = html.match(META_RE(prop));
  return m ? decodeEntities(m[1]) : null;
};

/**
 * One id -> `{ state, post }`.
 *
 *   state 'post'      a readable post
 *   state 'blank'     a 200 carrying the CHANNEL landing page: no readable post at this id
 *                     (a caption-less document, a deleted message, or past the head)
 *   state 'shape'     the page parsed but carries no og:title at all — the markup changed
 *   state 'error'     could not be fetched
 *
 * `blank` is deliberately not called "missing": this route cannot tell a caption-less PDF from a
 * deleted message, and claiming either would be inventing a fact about the channel.
 */
async function readId(id, { confirmBlanks = true } = {}) {
  let lastErr = null;
  let blanks = 0;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    // Two different waits, because two different things are being waited out. A transport error
    // wants a real backoff; a blank only needs enough of a gap that the re-ask is not part of the
    // same burst, and roughly two thirds of this channel's ids are blank — so charging them the
    // error backoff would triple the cost of every run to re-confirm mostly-genuine absences.
    if (attempt) await sleep(blanks ? BLANK_PAUSE_MS : DELAY_MS * (attempt + 1) * 2);
    let html;
    try {
      const res = await fetch(`https://t.me/${CHANNEL}/${id}`, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(20000),
      });
      html = await res.text();
    } catch (err) {
      lastErr = err;
      continue;
    }

    const title = metaOf(html, 'og:title');
    const desc = metaOf(html, 'og:description');

    // No og:title at all is not an empty channel and not a block — it is markup we no longer
    // understand, and it must fail loudly rather than commit an empty capture over a good one.
    if (title === null) { lastErr = new Error('no og:title'); continue; }

    // THE DISCRIMINATOR. A real message page carries the POST in og:description; an id with
    // nothing readable carries the CHANNEL's own description there, which equals og:title on this
    // channel. Positive evidence for a post, never an inference from a status code or a byte count.
    //
    // AND A BLANK IS RE-ASKED BEFORE IT IS BELIEVED, because rate limiting wears this exact
    // costume — a throttled request answers 200 with the same landing page an absent id does.
    // Believing the first one does not fail, it QUIETLY UNDER-REPORTS: the id is written down as
    // a message of this channel we could not read, when the truth is that we were refused. One
    // backed-off re-ask is what separates the two, and it is the only thing that can.
    if (!desc || desc === title) {
      // The re-ask is spent ONLY where a false blank would become a permanent lie — that is, on
      // the real walk, where the id is written into the capture's coverage. The head seek probes
      // speculatively far past the end of the channel, where a throttled answer and a genuine
      // absence lead to the same place: the search moves on. Paying for confirmation there would
      // roughly triple the cost of a cold run to re-confirm ids that are not messages at all.
      if (confirmBlanks && ++blanks < BLANK_RETRIES) { lastErr = null; continue; }
      return { state: 'blank' };
    }

    return {
      state: 'post',
      post: {
        id,
        text: desc,
        url: `https://t.me/${CHANNEL}/${id}`,
        // NO PER-POST IMAGE IS CAPTURED, AND THAT IS A MEASUREMENT RATHER THAN AN OMISSION.
        // `og:image` on a message page is the CHANNEL'S AVATAR, not the post's media — verified
        // against three text posts and the channel page, byte-identical URL every time. Storing it
        // as `image` would file a property of the channel as a property of the post, and the next
        // reader to render it would put the same logo on six hundred rows as though each post
        // carried a picture. This route gives no way to reach a post's own media, so it reports
        // none rather than something that merely looks like one.
        //
        // The page publishes no time either. Null is the honest value and the tab says so in
        // words; it is never backfilled from the clock, which would stamp our reading time onto
        // their post.
        publishedAt: null,
      },
    };
  }
  return { state: lastErr && String(lastErr.message) === 'no og:title' ? 'shape' : 'error' };
}

// ---------------------------------------------------------------------------------------
// Existing capture
// ---------------------------------------------------------------------------------------

async function loadExisting() {
  try {
    const raw = JSON.parse(await readFile(OUT, 'utf8'));
    return {
      posts: Array.isArray(raw.posts) ? raw.posts : [],
      headId: Number(raw.headId) || 0,
      lowestId: Number(raw.lowestId) || 0,
      channel: raw.channel || null,
    };
  } catch {
    return { posts: [], headId: 0, lowestId: 0, channel: null };
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function main() {
  if (!CHANNEL_RE.test(CHANNEL)) {
    console.error(`Refusing to read "${CHANNEL}": not a Telegram public username (5-32 of [A-Za-z0-9_]).`);
    return 1;
  }

  const existing = await loadExisting();
  // A capture for a DIFFERENT channel is not history for this one. Starting from its head would
  // walk the wrong ids and merging its posts would file another channel's words under ours.
  const sameChannel = !existing.channel || existing.channel === CHANNEL;
  const prior = sameChannel ? existing : { posts: [], headId: 0, lowestId: 0 };
  if (!sameChannel) console.warn(`Existing capture is for @${existing.channel}; starting fresh for @${CHANNEL}.`);

  const byId = new Map(prior.posts.map((p) => [Number(p.id), p]));
  const beforeIds = new Set(byId.keys());

  let scanned = 0;
  let readable = 0;
  let blank = 0;
  let errors = 0;
  let shapeFaults = 0;
  const seenAt = new Date().toISOString();

  const visit = async (id) => {
    scanned++;
    const r = await readId(id);
    await sleep(DELAY_MS);
    if (r.state === 'post') {
      readable++;
      const prev = byId.get(id);
      // firstSeenAt belongs to the earliest capture that saw the post, so a re-read does not keep
      // restamping it. It is a fact about this scraper and lives in its own field.
      byId.set(id, { ...r.post, firstSeenAt: prev?.firstSeenAt || seenAt });
      return true;
    }
    if (r.state === 'blank') { blank++; return false; }
    if (r.state === 'shape') shapeFaults++; else errors++;
    return false;
  };

  // --- seek the head -------------------------------------------------------------------
  // A SINGLE MISS PROVES NOTHING on this channel, so every existence test is a WINDOW test:
  // "is there a readable post anywhere in [id, id + MISS_RUN)?". Measured, a run of ten
  // caption-less documents sits between two real posts, and a naive binary search on one id would
  // have declared the channel over inside it.
  // COVERAGE IS NOT COUNTED HERE, AND THAT IS THE WHOLE POINT OF THE SEPARATION. This walks
  // SPECULATIVELY, far past the end of the channel by design, so most of what it touches is not a
  // message at all. Counting it alongside the real walk is a measurement of OUR SEARCH reported as
  // a measurement of the channel: measured on the first run, it turned 876 probe misses into a
  // footnote claiming 876 of this channel's messages could not be read, when the true figure over
  // the walked range was two thirds of 219. Only `visit()` moves the coverage counters.
  const postNear = async (from) => {
    for (let id = from; id < from + MISS_RUN && !outOfTime(); id++) {
      const r = await readId(id, { confirmBlanks: false });
      await sleep(DELAY_MS);
      if (r.state === 'post') return id;
      if (r.state === 'shape') shapeFaults++;
    }
    return 0;
  };

  let head = prior.headId;

  if (!head) {
    // Double until a window comes back empty, then bisect on the same window test. ~60 requests
    // against a channel thousands of messages deep, rather than walking every id from one.
    let lo = 0;
    let hi = 0;
    for (let step = 512; step <= 262144; step *= 2) {
      if (outOfTime()) break;
      if (await postNear(step)) lo = step; else { hi = step; break; }
    }
    if (lo && hi) {
      while (hi - lo > MISS_RUN && !outOfTime()) {
        const mid = Math.floor((lo + hi) / 2);
        if (await postNear(mid)) lo = mid; else hi = mid;
      }
    }
    head = lo;
    console.log(`No prior capture. Head seek landed near id ${head || '(none)'}.`);
  }

  // --- forward: pin the head and collect anything new -----------------------------------
  let cursor = head ? head + 1 : 1;
  let miss = 0;
  while (head && miss < MISS_RUN && !outOfTime()) {
    const found = await visit(cursor);
    if (found) { head = cursor; miss = 0; } else miss++;
    cursor++;
  }

  // --- backward: optional backfill ------------------------------------------------------
  if (BACKFILL > 0 && head) {
    const from = prior.lowestId ? prior.lowestId - 1 : head - 1;
    const to = Math.max(1, from - BACKFILL + 1);
    for (let id = from; id >= to && !outOfTime(); id--) await visit(id);
  }

  // --- decide whether to write ----------------------------------------------------------

  // Nothing read AND nothing understood: the markup moved under us. Loud, exit 1 — this is the
  // case a human has to look at, and it must never quietly commit an empty file over a good one.
  if (readable === 0 && shapeFaults > 0 && blank === 0) {
    console.error(`Every page parsed without an og:title (${shapeFaults} of ${scanned}). The markup has changed.`);
    return 1;
  }

  // Nothing readable and a good capture already exists: the run found no new posts, or t.me
  // refused this runner. Either way the committed file is untouched and this is NOT a red build —
  // the same "the upstream refused this runner" exit the market-news scraper uses.
  const ids = new Set(byId.keys());
  const arrived = [...ids].filter((id) => !beforeIds.has(id));
  if (!arrived.length && prior.posts.length) {
    console.log(`No new posts (scanned ${scanned}, ${blank} unreadable ids, ${errors} errors). Capture unchanged.`);
    return 2;
  }
  if (!byId.size) {
    console.error(`Read nothing at all across ${scanned} ids (${errors} errors). Not writing an empty capture.`);
    return 2;
  }

  // Newest first, by id — the only ordering axis this route publishes, and monotonic with
  // publication. Capped by bytes, so the OLDEST fall off the end.
  const posts = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, KEEP);

  const payload = {
    source: 't.me public channel pages',
    channel: CHANNEL,
    channelUrl: `https://t.me/${CHANNEL}`,
    // The route is written down because it decides what the data CAN carry. `permalink` publishes
    // no time; a future `preview` route would. The tab reads this rather than assuming.
    route: 'permalink',
    publishesTime: false,
    capturedAt: new Date().toISOString(),
    headId: head || 0,
    lowestId: posts.length ? Math.min(...posts.map((p) => Number(p.id))) : 0,
    // COVERAGE IS DERIVED FROM THE CAPTURE'S OWN SPAN, NOT FROM A RUNNING TALLY.
    // The tab states how much of this channel the route can see, and a tally cannot answer that
    // honestly across runs: an hourly incremental walk touches ~60 ids, so writing its counts here
    // would overwrite a 700-id measurement with "2 of 60 readable" and the footnote would report
    // the last hour as though it described the channel. The span does not drift — it is
    // recomputable from the file at any time, and it is a statement about the ids this capture
    // actually covers.
    spanFrom: posts.length ? Math.min(...posts.map((p) => Number(p.id))) : 0,
    spanTo: posts.length ? Math.max(...posts.map((p) => Number(p.id))) : 0,
    // This run only, for whoever is reading the job log. Deliberately nested so it can never be
    // mistaken for the coverage figures above.
    lastRun: { scanned, readable, unreadable: blank, errors },
    posts,
  };

  // Atomic: a run killed by the workflow's `timeout-minutes` part-way through a write would
  // otherwise leave truncated JSON where a good capture was, which the browser reports as a feed
  // it cannot read. Pretty-printed on purpose — this file is committed, and a diff of one arriving
  // post should be one arriving post.
  await writeFile(`${OUT}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(`${OUT}.tmp`, OUT);
  console.log(
    `Wrote ${posts.length} posts (${arrived.length} new) from @${CHANNEL}. ` +
    `Scanned ${scanned} ids: ${readable} readable, ${blank} unreadable, ${errors} errors. Head ${head}.`
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); }
);
