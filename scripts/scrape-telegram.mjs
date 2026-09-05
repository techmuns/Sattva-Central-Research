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
// EXIT CODES ARE THE INTERFACE
//     0  read the channel and wrote a capture
//     2  nothing new, or nothing could be read and a good capture exists — file untouched, and on
//        this feed that is the ordinary quiet-hours outcome rather than a fault
//     4  nothing readable across a whole window with a capture already held: the shape of a
//        refused runner rather than a quiet channel. A suspicion, not a diagnosis; file untouched
//     1  a real fault: the markup moved, the channel name is invalid, or this code is wrong
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
// THE HEAD SEEK GETS A SLICE OF THE BUDGET, NEVER ALL OF IT. Measured on a cold start: the seek
// ran for the full thirteen minutes, found the head, and the run then had nothing left to collect
// with — it exited having written no capture at all. A search that consumes the run it exists to
// serve is worse than a coarse answer, because the coarse answer still gets posts on the page and
// the next run starts from a known head.
const SEEK_SHARE = Number(process.env.TELEGRAM_SEEK_SHARE || 0.35);
// An operator lever, and the one thing that makes a cold start cheap: the highest message id known
// to exist. The seek is skipped and the walk starts there. It only has to be BELOW the true head —
// the forward walk finds the rest — so a stale hint costs nothing but a few extra ids.
const HEAD_HINT = Number(process.env.TELEGRAM_HEAD_HINT || 0);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const outOfTime = () => Date.now() - started > BUDGET_MS;
const outOfSeekTime = () => Date.now() - started > BUDGET_MS * SEEK_SHARE;

// ---------------------------------------------------------------------------------------
// Reading one page
// ---------------------------------------------------------------------------------------

const META_RE = (prop) => new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'i');

/**
 * The channel's OWN landing-page description, read once per run.
 *
 * THE BLANK TEST CANNOT REST ON THIS CHANNEL HAPPENING TO HAVE NO BIO. An id with nothing readable
 * answers 200 with the channel's landing page, and `og:description` there is the channel's
 * DESCRIPTION. Today @researchreportss has none, so t.me falls back to the channel title and
 * `desc === title` catches it — but that equality is an accident of this channel's settings, not a
 * property of Telegram. The day somebody writes a bio, every unreadable id would look like a post
 * whose text is that bio: hundreds of identical fabricated posts, and a forward walk that never
 * sees MISS_RUN misses and so never terminates.
 *
 * So the landing page is fetched once and its own description is recorded as the signature of
 * "nothing here". Positive evidence, and it survives the owner editing their channel.
 */
async function channelSignature() {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt) await sleep(DELAY_MS * (attempt + 1) * 2);
    try {
      const res = await fetch(`https://t.me/${CHANNEL}`, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(20000),
      });
      const html = await res.text();
      const title = metaOf(html, 'og:title');
      const desc = metaOf(html, 'og:description');
      if (title !== null) return { title, desc };
    } catch { /* fall through to the next attempt */ }
  }
  return null;
}

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
async function readId(id, { confirmBlanks = true, signature = null } = {}) {
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
    // Blank when the page carries no description, or carries the CHANNEL'S own — either its title
    // (the no-bio fallback) or the bio itself, both read from the landing page at the start of the
    // run rather than assumed.
    const isChannelOwn =
      !desc || desc === title || (signature && (desc === signature.desc || desc === signature.title));
    if (isChannelOwn) {
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
      // The lowest id ever WALKED, which is not the lowest id KEPT. Backfill has to resume from
      // the former; resuming from the latter re-walks ground already covered — see walkBack().
      walkedFrom: Number(raw.walkedFrom) || 0,
      channel: raw.channel || null,
    };
  } catch {
    return { posts: [], headId: 0, lowestId: 0, walkedFrom: 0, channel: null };
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

  // Read the channel's own landing page FIRST. It is both the blank signature every id is compared
  // against and a reachability check: if this cannot be read, nothing else in the run can be
  // trusted, and a capture written from it would be a guess.
  const signature = await channelSignature();
  if (!signature) {
    console.error(`Could not read https://t.me/${CHANNEL} at all. Not touching the capture.`);
    return 2;
  }

  const existing = await loadExisting();
  // A capture for a DIFFERENT channel is not history for this one. Starting from its head would
  // walk the wrong ids and merging its posts would file another channel's words under ours.
  const sameChannel = !existing.channel || existing.channel === CHANNEL;
  const prior = sameChannel ? existing : { posts: [], headId: 0, lowestId: 0, walkedFrom: 0 };
  if (!sameChannel) console.warn(`Existing capture is for @${existing.channel}; starting fresh for @${CHANNEL}.`);

  const byId = new Map(prior.posts.map((p) => [Number(p.id), p]));
  const beforeIds = new Set(byId.keys());

  let scanned = 0;
  let walkedFrom = prior.walkedFrom || 0;
  let readable = 0;
  let blank = 0;
  let errors = 0;
  let shapeFaults = 0;
  const seenAt = new Date().toISOString();

  const visit = async (id) => {
    scanned++;
    const r = await readId(id, { signature });
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
    for (let id = from; id < from + MISS_RUN && !outOfSeekTime(); id++) {
      const r = await readId(id, { confirmBlanks: false, signature });
      await sleep(DELAY_MS);
      if (r.state === 'post') return id;
      if (r.state === 'shape') shapeFaults++;
    }
    return 0;
  };

  let head = prior.headId || (HEAD_HINT > 0 ? HEAD_HINT : 0);
  if (!prior.headId && HEAD_HINT > 0) console.log(`Starting from the supplied head hint ${HEAD_HINT}; skipping the seek.`);

  if (!head) {
    // Double until a window comes back empty, then bisect on the same window test. ~60 requests
    // against a channel thousands of messages deep, rather than walking every id from one.
    // THE PROBE NEEDS A FLOOR AS WELL AS A CEILING, and 512 is asked about exactly once.
    // Doubling from 512 alone has no branch for a channel SHORTER than 512 messages: the probe
    // fails, `lo` stays 0, the bisect is skipped, and the forward walk — gated on a non-zero head —
    // never runs, reporting a perfectly readable channel as an ordinary quiet run. So the first
    // probe decides the direction: found means climb, not found means halve down. Finding nothing
    // even at id 1 is not an abort — a channel whose earliest messages were all deleted is
    // ordinary, and it simply leaves the head unfound for this run.
    let lo = 0;
    let hi = 0;
    if (await postNear(512)) {
      lo = 512;
      for (let step = 1024; step <= 262144 && !outOfSeekTime(); step *= 2) {
        if (await postNear(step)) lo = step; else { hi = step; break; }
      }
    } else {
      hi = 512;
      for (let step = 256; step >= 1 && !outOfSeekTime(); step = Math.floor(step / 2)) {
        if (await postNear(step)) { lo = step; break; }
        hi = step;
      }
    }
    if (lo && hi) {
      while (hi - lo > MISS_RUN && !outOfSeekTime()) {
        const mid = Math.floor((lo + hi) / 2);
        if (await postNear(mid)) lo = mid; else hi = mid;
      }
    }
    head = lo;
    console.log(`No prior capture. Head seek landed near id ${head || '(none)'}.`);
  }

  // ON A COLD START, COLLECT BEFORE PINNING THE HEAD. The forward walk runs off the end of the
  // channel by design — it stops only after MISS_RUN misses — so on a first run it spends the
  // remaining budget confirming absences while the capture is still empty. Walking DOWN from the
  // head reads real posts immediately. On every later run the order does not matter, because the
  // head is known and the forward walk is short.
  const coldStart = !prior.posts.length;

  const walkBack = async () => {
    if (!head) return;
    const span = BACKFILL > 0 ? BACKFILL : coldStart ? KEEP : 0;
    if (span <= 0) return;
    // A FULL CAPTURE CANNOT BE EXTENDED DOWNWARDS, so walking further back is time spent reading
    // posts that the KEEP cap will discard on the way out. It used to resume from `lowestId`, which
    // is computed AFTER the cap — so every backfill run re-read ids below the 600th-newest post,
    // found real posts, and then sliced every one of them away, reporting them as arrivals each
    // time. Widening history is a change to KEEP, not a longer walk.
    if (byId.size >= KEEP && BACKFILL > 0) {
      console.log(`Capture already holds ${byId.size} posts (KEEP=${KEEP}); skipping backfill. Raise TELEGRAM_KEEP to hold more history.`);
      return;
    }
    const from = prior.walkedFrom ? prior.walkedFrom - 1 : head;
    const to = Math.max(1, from - span + 1);
    for (let id = from; id >= to && !outOfTime(); id--) {
      await visit(id);
      walkedFrom = Math.min(walkedFrom || Infinity, id);
    }
  };

  const walkForward = async () => {
    let cursor = head ? head + 1 : 1;
    let miss = 0;
    while (head && miss < MISS_RUN && !outOfTime()) {
      const found = await visit(cursor);
      if (found) { head = cursor; miss = 0; } else miss++;
      cursor++;
    }
  };

  if (coldStart) { await walkBack(); await walkForward(); }
  else { await walkForward(); await walkBack(); }

  // --- decide whether to write ----------------------------------------------------------

  // Nothing read AND nothing understood: the markup moved under us. Loud, exit 1 — this is the
  // case a human has to look at, and it must never quietly commit an empty file over a good one.
  // It used to also require `blank === 0`, which disarmed it completely: roughly two thirds of this
  // channel's ids are blank, so any real walk has dozens and the branch could never be reached. The
  // question it asks is whether ANY page was understood, and a blank page WAS understood — it is
  // the landing page, correctly identified. So the test is simply: nothing read, and pages that
  // could not be parsed at all.
  if (readable === 0 && shapeFaults > 0) {
    console.error(`${shapeFaults} of ${scanned} pages carried no og:title and nothing was read. The markup has changed.`);
    return 1;
  }

  // Nothing readable and a good capture already exists: the run found no new posts, or t.me
  // refused this runner. Either way the committed file is untouched and this is NOT a red build —
  // the same "the upstream refused this runner" exit the market-news scraper uses.
  const ids = new Set(byId.keys());
  const arrived = [...ids].filter((id) => !beforeIds.has(id));
  if (!arrived.length && prior.posts.length) {
    // A REFUSED RUNNER AND A QUIET CHANNEL LEAVE THE SAME FOOTPRINT, so they are separated here
    // rather than left to look identical for ever. Both exit without touching the capture, and on
    // a channel that posts most weekdays a walk that reads NOTHING at all across a full window is
    // the shape of a refusal, not of a quiet day — t.me answers a throttled request with the same
    // landing page an absent id gives. Exit 4 says "this looks like us, not them" so the job can
    // raise a warning instead of another routine notice, and an operator sees a run of them.
    // It is deliberately NOT a failure: the committed capture is still correct.
    if (readable === 0 && blank >= MISS_RUN) {
      console.error(
        `Read ${blank} ids and not one carried a post. On a channel that posts most weekdays that is ` +
        `the shape of t.me refusing this runner rather than a quiet day — the two are indistinguishable ` +
        `from one request, so this is a suspicion and not a diagnosis. The capture is unchanged.`,
      );
      return 4;
    }
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
    // How far down the channel this capture has actually been walked. Distinct from `lowestId`,
    // which is capped by KEEP, and it is what the next backfill resumes from.
    walkedFrom: walkedFrom || (posts.length ? Math.min(...posts.map((p) => Number(p.id))) : 0),
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
