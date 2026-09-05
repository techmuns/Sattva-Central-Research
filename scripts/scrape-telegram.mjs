#!/usr/bin/env node
// Retained public Telegram archive: real embed identities/dates + permalink text.
// History resumes every run; no KEEP cap. See docs/TELEGRAM-INGESTION.md.
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_RE, positiveId, metaOf, parseEmbed, permalinkText } from './lib/telegram.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function integer(env, key, fallback, min, max) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  return n;
}
export function config(env = process.env) {
  const channel = String(env.TELEGRAM_CHANNEL || 'researchreportss').replace(/^@/, '').toLowerCase();
  if (!CHANNEL_RE.test(channel)) throw new Error('Invalid Telegram channel username');
  return { channel, out: resolve(env.TELEGRAM_OUT || resolve(ROOT, 'public/data/telegram-posts.json')),
    history: integer(env, 'TELEGRAM_BACKFILL', 180, 0, 100000),
    forward: integer(env, 'TELEGRAM_FORWARD', 60, 1, 10000),
    discovery: integer(env, 'TELEGRAM_DISCOVERY', 20, 0, 1000),
    delay: integer(env, 'TELEGRAM_DELAY_MS', 420, 0, 60000),
    budget: integer(env, 'TELEGRAM_BUDGET_MS', 540000, 1000, 3600000),
    headHint: integer(env, 'TELEGRAM_HEAD_HINT', 0, 0, 2147483647),
    // How far one hop of the head search reaches, and how finely it samples. Sized from this
    // channel rather than guessed: its deleted runs are HUNDREDS of ids wide (93385..93799 is one
    // unbroken run of "Post not found"), so a test that samples more coarsely than that can land
    // wholly inside a gap and conclude the channel has ended.
    jumpSpan: integer(env, 'TELEGRAM_JUMP_SPAN', 2000, 100, 100000),
    jumpSamples: integer(env, 'TELEGRAM_JUMP_SAMPLES', 40, 4, 400),
    // The share of the run the head search may spend. It must never take the whole budget:
    // finding the head and then having no requests left to READ it writes the capture unchanged.
    jumpShare: Number(env.TELEGRAM_JUMP_SHARE ?? 0.4) };
}

export async function collect(prior, cfg, { fetcher = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (prior.channel && prior.channel.toLowerCase() !== cfg.channel) throw new Error('Existing archive belongs to another channel; use a separate TELEGRAM_OUT');
  const started = now(), deadline = started + cfg.budget;
  const stamp = () => new Date(now()).toISOString();
  const outOfTime = () => now() + Math.max(1000, cfg.delay) >= deadline;
  const byId = new Map((prior.posts || []).map((p) => [positiveId(p.id), p]));
  byId.delete(0);
  const retry = new Set((prior.retryIds || []).filter(positiveId).map(Number));
  let head = [...byId.keys()].reduce((max, id) => Math.max(max, id), positiveId(prior.headId));
  let next = prior.schemaVersion === 2 ? Number(prior.historyNextId ?? head) : head;
  let discoveryNext = positiveId(prior.discoveryNextId) || head + cfg.forward + 1;
  const stats = { scanned: 0, posts: 0, unavailable: 0, missing: 0, errors: 0 };
  let checked = false, signature, failure = null;
  const observed = new Map();

  async function page(path) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - now();
      if (remaining < 1000) throw new Error('Collection time budget reached');
      try {
        const response = await fetcher(`https://t.me/${path}`, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal: AbortSignal.timeout(Math.min(15000, remaining)) });
        if (!response.ok) {
          if (response.status === 429) throw new Error('Telegram rate limit');
          throw new Error(`Telegram HTTP ${response.status}`);
        }
        const html = await response.text();
        await sleep(Math.min(cfg.delay, Math.max(0, deadline - now())));
        return html;
      } catch (err) {
        error = err;
        if (attempt < 2) await sleep(Math.min(1000 * (attempt + 1), Math.max(0, deadline - now())));
      }
    }
    throw error;
  }
  async function visit(id) {
    if (observed.has(id)) return observed.get(id);
    stats.scanned++;
    let result;
    try {
      result = parseEmbed(await page(`${cfg.channel}/${id}?embed=1&mode=tme`), cfg.channel, id);
      // Confirm absence: a throttled web response must not permanently erase history.
      if (result.state === 'missing') result = parseEmbed(await page(`${cfg.channel}/${id}?embed=1&mode=tme`), cfg.channel, id);
      if (result.state === 'error') throw new Error(result.reason);
      retry.delete(id);
      if (result.state === 'post') {
        const old = byId.get(id);
        const p = result.post;
        let textFailed = false;
        // Re-read visible text for edits, including old rows. The embed on this channel hides
        // text that Telegram still publishes in the permalink's OG description.
        if (!p.text) {
          try { p.text = permalinkText(await page(`${cfg.channel}/${id}`), signature); }
          catch { retry.add(id); stats.errors++; textFailed = true; }
        }
        p.text = p.text || old?.text || null;
        if (p.text) p.contentStatus = 'available';
        byId.set(id, { ...p, firstSeenAt: old?.firstSeenAt || stamp() });
        head = Math.max(head, id);
        stats.posts++;
        if (p.contentStatus === 'telegram-only') stats.unavailable++;
        result.textFailed = textFailed;
      } else {
        stats.missing++;
        // A post already archived is retained. A later missing response is not proof of deletion.
      }
    } catch (err) {
      retry.add(id); stats.errors++;
      result = { state: 'error', reason: String(err.message || err) };
    }
    observed.set(id, result);
    if (stats.scanned % 50 === 0) console.log(`Checked ${stats.scanned} IDs; ${byId.size} posts retained; ${retry.size} lookups pending.`);
    return result;
  }
  try {
    const landing = await page(cfg.channel);
    signature = { title: metaOf(landing, 'og:title'), desc: metaOf(landing, 'og:description') };
    if (!signature.title) throw new Error('Telegram landing page not recognised');
    if (cfg.headHint > head) {
      if ((await visit(cfg.headHint)).state !== 'post') throw new Error('Supplied head hint is not a readable Telegram message');
      next = head; // Re-scan the gap down to the retained history, without dropping anything.
    }
    if (!head) throw new Error('A first capture needs TELEGRAM_HEAD_HINT from a real message link');
    // A successful known-message control is necessary before calling a quiet scan successful.
    const controls = [...byId.keys()].sort((a, b) => b - a).slice(0, 3);
    if (!controls.length) controls.push(head);
    let control = false;
    for (const id of controls) {
      if ((await visit(id)).state === 'post') { control = true; break; }
    }
    if (!control) throw new Error('Known messages could not be confirmed; archive retained');
    // A LINEAR SWEEP CANNOT CATCH UP WITH A CHANNEL IT HAS FALLEN BEHIND.
    //
    // The resumable discovery sweep below advances `cfg.discovery` ids per run, and GitHub
    // delivers 7-9 scheduled runs a DAY on this repository whatever the cron asks for (measured
    // across six workflows spanning a 4x range of requested density). This archive's head was
    // 93384, dated 2026-05-13, while the channel's was 102828, dated 2026-09-04 — 9,444 ids of
    // mostly-deleted space between them. At twenty ids a run that gap closes in about fifty days,
    // during which the tab keeps presenting May's posts as the newest and nothing says otherwise.
    //
    // So the head is SEARCHED for rather than walked to. Existence is decidable per id on the
    // embed route, which is what makes a search possible at all: `highestIn` samples a span and
    // the gallop climbs while whole spans keep answering. Nine thousand ids cost a couple of
    // hundred requests rather than nine thousand.
    //
    // IT DELIBERATELY DOES NOT PIN THE HEAD EXACTLY. A bisect after the gallop cost as much again
    // and bought a dozen ids: the gallop leaves `peak` within one span of the true head, the
    // ordinary forward scan covers what is immediately above it, and the next run's gallop closes
    // the rest. Spending the budget on precision here is what starved the run that found the head
    // of the requests it needed to record it — measured, a run that located 102816 and then had
    // nothing left to read it with, so the capture was written unchanged.
    const searchDeadline = started + Math.floor(cfg.budget * cfg.jumpShare);
    const searchSpent = () => now() >= searchDeadline;
    const exists = async (id) => {
      try { return (parseEmbed(await page(`${cfg.channel}/${id}?embed=1&mode=tme`), cfg.channel, id)).state === 'post'; }
      catch { return false; }
    };
    const highestIn = async (lowest, highest, samples = cfg.jumpSamples) => {
      const step = Math.max(1, Math.floor((highest - lowest) / samples));
      let best = 0;
      for (let id = lowest; id <= highest && !outOfTime() && !searchSpent(); id += step) if (await exists(id)) best = id;
      return best;
    };
    // A SPARSE MISS IS NOT A MISSING SPAN, AND BELIEVING ONE IS EXACTLY HOW THE OLD SEEK DIED.
    // Its window test read "not found" 17-44% of the time below the true head, and a search that
    // stops at the first lie stops for ever: one `postNear(98304) -> NOT FOUND` put the ceiling
    // under the real head and the bisect could never climb back. This gallop samples every
    // jumpSpan/jumpSamples ids — fifty by default — and existence in older stretches of this
    // channel runs at 17%, so a span CAN read empty while holding posts. So an empty span is
    // re-asked once at four times the resolution before it is allowed to end the climb. The cost
    // is paid only when the search is about to stop, which is the one place it is worth paying.
    let peak = head;
    while (!outOfTime() && !searchSpent()) {
      let hit = await highestIn(peak + 1, peak + cfg.jumpSpan);
      if (!hit) hit = await highestIn(peak + 1, peak + cfg.jumpSpan, cfg.jumpSamples * 4);
      if (!hit) break;
      peak = hit;
    }
    if (peak > head) {
      const wasHead = head;
      console.log(`Head search moved the channel head ${wasHead} -> ${peak}.`);
      await visit(peak);
      // The ids between the old head and the new one are unread history, not a hole to step over.
      // Pointing the resumable sweep at the top of the gap means the NEWEST of them are read
      // first, so one run puts the top of the channel on screen and later runs fill downwards.
      next = Math.max(head, wasHead);
    }

    const from = head + 1;
    let end = from + cfg.forward - 1;
    let scanOk = true, scannedTo = from - 1;
    for (let id = from; id <= end && !outOfTime(); id++) {
      const result = await visit(id);
      if (result.state === 'error' || result.textFailed) scanOk = false;
      scannedTo = id;
    }
    checked = scanOk && scannedTo === end;
    // A separate resumable forward sweep crosses long deleted/hidden gaps. A window of misses
    // never establishes the channel's true head. Every normal run also rechecks above the head.
    discoveryNext = Math.max(discoveryNext, end + 1);
    for (let i = 0; i < cfg.discovery && !outOfTime(); i++, discoveryNext++) await visit(discoveryNext);
    if (discoveryNext > head + 10000) discoveryNext = head + cfg.forward + 1;
    for (const id of [...retry].sort((a, b) => b - a).slice(0, 40)) {
      if (outOfTime()) break;
      await visit(id);
    }
    // Migrates the entire old text-only window before continuing through older history.
    if (!next && prior.schemaVersion !== 2) next = head;
    for (let i = 0; i < cfg.history && next > 0 && !outOfTime(); i++, next--) await visit(next);
  } catch (err) { failure = String(err.message || err); }
  const posts = [...byId.values()].sort((a, b) => b.id - a.id);
  const changed = JSON.stringify(posts) !== JSON.stringify(prior.posts || []);
  const status = failure ? 'failed' : checked && stats.errors === 0 ? 'ok' : 'partial';
  return { schemaVersion: 2, source: 'Telegram public embeds and message pages', channel: cfg.channel,
    channelUrl: `https://t.me/${cfg.channel}`, route: 'embed+permalink', publishesTime: true,
    capturedAt: changed ? stamp() : prior.capturedAt || null,
    lastCheckedAt: checked ? stamp() : prior.lastCheckedAt || null,
    headId: head, lowestId: posts.at(-1)?.id || 0, spanFrom: posts.at(-1)?.id || 0, spanTo: posts[0]?.id || 0,
    historyNextId: next, historyComplete: next === 0 && retry.size === 0 && !failure,
    discoveryNextId: discoveryNext, retryIds: [...retry].sort((a, b) => b - a),
    lastRun: { at: stamp(), status, ...stats, error: failure }, posts };
}

async function main() {
  const cfg = config();
  let prior = {};
  try {
    prior = JSON.parse(await readFile(cfg.out, 'utf8'));
    if (!Array.isArray(prior.posts) || prior.posts.some((p) => !positiveId(p.id))) throw new Error('Invalid existing Telegram archive');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const archive = await collect(prior, cfg);
  await mkdir(dirname(cfg.out), { recursive: true });
  await writeFile(`${cfg.out}.tmp`, `${JSON.stringify(archive, null, 2)}\n`);
  await rename(`${cfg.out}.tmp`, cfg.out);
  console.log(JSON.stringify({ retainedPosts: archive.posts.length, head: archive.headId, historyNextId: archive.historyNextId, retry: archive.retryIds.length, ...archive.lastRun }));
  if (archive.lastRun.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
