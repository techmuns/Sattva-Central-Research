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
  const phase = env.TELEGRAM_PHASE || 'full';
  if (!['full', 'recent', 'history'].includes(phase)) throw new Error('Invalid Telegram collection phase');
  const jumpShare = Number(env.TELEGRAM_JUMP_SHARE ?? 0.4);
  if (!Number.isFinite(jumpShare) || jumpShare < 0 || jumpShare > 0.8) throw new Error('TELEGRAM_JUMP_SHARE must be between 0 and 0.8');
  return { channel, out: resolve(env.TELEGRAM_OUT || resolve(ROOT, 'public/data/telegram-posts.json')),
    phase,
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
    jumpShare };
}

// A bounded set of inclusive unread intervals, separate from older archive progress.
// Coalescing excess intervals may re-read some IDs; it never drops an unread gap.
function mergeRanges(ranges) {
  const result = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    if (!positiveId(range.from) || !positiveId(range.to) || range.from > range.to) throw new Error('Invalid Telegram catch-up interval');
    const last = result.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else result.push({ from: Number(range.from), to: Number(range.to) });
  }
  while (result.length > 128) result.splice(0, 2, { from: result[0].from, to: result[1].to });
  return result.reverse();
}

class CollectionBudgetReached extends Error {
  constructor() { super('Collection time budget reached'); }
}

export async function collect(prior, cfg, { fetcher = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkpoint = async () => {}, timeoutSignal = (ms) => AbortSignal.timeout(ms) } = {}) {
  if (prior.channel && prior.channel.toLowerCase() !== cfg.channel) throw new Error('Existing archive belongs to another channel; use a separate TELEGRAM_OUT');
  const started = now(), deadline = started + cfg.budget;
  const stamp = () => new Date(now()).toISOString();
  if (Date.parse(prior.publicSafety?.nextAttemptAt) > started) return { ...prior, latestVerifiedAt: null,
    lastRun: { at: stamp(), status: 'partial', error: 'Waiting for the public source retry deadline.' } };
  let publicSafety = null;
  const outOfTime = () => publicSafety || now() + Math.max(1000, cfg.delay) >= deadline;
  const byId = new Map((prior.posts || []).map((p) => [positiveId(p.id), p]));
  byId.delete(0);
  const retry = new Set((prior.retryIds || []).filter(positiveId).map(Number));
  let head = [...byId.keys()].reduce((max, id) => Math.max(max, id), positiveId(prior.headId));
  let next = prior.schemaVersion === 2 ? Number(prior.historyNextId ?? head) : head;
  let catchupRanges = mergeRanges((prior.catchupRanges || []).map((range) => ({ ...range })));
  let discoveryNext = positiveId(prior.discoveryNextId) || head + cfg.forward + 1;
  const stats = { scanned: 0, posts: 0, unavailable: 0, missing: 0, errors: 0 };
  // The workflow publishes a recent pass before starting history from this same file.
  // Successful optional backfill cannot erase an unfinished required recent check.
  const recentIncomplete = cfg.phase === 'history' && prior.lastRun?.phase === 'recent' && prior.lastRun.status !== 'ok';
  let checked = false, checkedAt = null, signature, failure = null, searchFailed = false, control = false;
  const observed = new Map();

  function snapshot(final = false) {
    const posts = [...byId.values()].sort((a, b) => b.id - a.id);
    const changed = JSON.stringify(posts) !== JSON.stringify(prior.posts || []);
    const status = failure || publicSafety ? 'failed' : final && control && (checked || cfg.phase === 'history') && !recentIncomplete && !searchFailed && stats.errors === 0 ? 'ok' : 'partial';
    return { schemaVersion: 2, source: 'Telegram public embeds and message pages', channel: cfg.channel,
      channelUrl: `https://t.me/${cfg.channel}`, route: 'embed+permalink', publishesTime: true,
      capturedAt: changed ? stamp() : prior.capturedAt || null,
      lastCheckedAt: checked && !publicSafety && !searchFailed ? checkedAt : prior.lastCheckedAt || null,
      latestVerifiedAt: null, publicSafety, apiSafety: prior.apiSafety || null,
      headId: head, lowestId: posts.at(-1)?.id || 0, spanFrom: posts.at(-1)?.id || 0, spanTo: posts[0]?.id || 0,
      historyNextId: next, historyComplete: next === 0 && catchupRanges.length === 0 && retry.size === 0 && !failure && !publicSafety,
      catchupRanges: catchupRanges.map((range) => ({ ...range })),
      discoveryNextId: discoveryNext, retryIds: [...retry].sort((a, b) => b - a),
      lastRun: { at: stamp(), status, phase: cfg.phase, ...stats, error: publicSafety ? 'Public source requests paused' : failure }, posts };
  }
  const save = () => checkpoint(snapshot());

  async function page(path) {
    if (publicSafety) throw new Error('Public source requests paused');
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - now();
      // A previous real failure remains a failure even when there is no time to retry it.
      if (remaining < 1000) throw error || new CollectionBudgetReached();
      const limitedByBudget = remaining <= 15000;
      const signal = timeoutSignal(Math.min(15000, remaining));
      try {
        const response = await fetcher(`https://t.me/${path}`, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal });
        if (!response.ok) {
          if (response.status === 429 || response.status === 403) {
            const retryAfter = response.headers.get('retry-after');
            const retryAt = /^\d+$/.test(retryAfter || '') ? now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
            publicSafety = { reason: response.status === 429 ? 'rate-limit' : 'source-refused',
              nextAttemptAt: new Date(Math.max(now() + (response.status === 429 ? 1800000 : 3600000), Number.isFinite(new Date(retryAt + 60000).getTime()) ? retryAt + 60000 : 0)).toISOString() };
            await save();
            throw new Error('Public source requests paused');
          }
          throw new Error(`Telegram HTTP ${response.status}`);
        }
        const html = await response.text();
        await sleep(Math.min(cfg.delay, Math.max(0, deadline - now())));
        return html;
      } catch (err) {
        if (publicSafety) throw err;
        if (limitedByBudget && signal.aborted && (err === signal.reason || ['AbortError', 'TimeoutError'].includes(err?.name))) {
          throw error || new CollectionBudgetReached();
        }
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
      if (result.state === 'post') {
        control = true;
        const old = byId.get(id);
        const p = result.post;
        let textFailed = false, budgetStop = null;
        // Re-read visible text for edits, including old rows. The embed on this channel hides
        // text that Telegram still publishes in the permalink's OG description.
        if (!p.text) {
          try { p.text = permalinkText(await page(`${cfg.channel}/${id}`), signature); }
          catch (err) {
            if (err instanceof CollectionBudgetReached) budgetStop = err;
            else { retry.add(id); stats.errors++; textFailed = true; }
          }
        }
        p.text = p.text || old?.text || null;
        if (p.text) p.contentStatus = 'available';
        byId.set(id, { ...p, firstSeenAt: old?.firstSeenAt || stamp() });
        if (head && id > head + 1) catchupRanges = mergeRanges([...catchupRanges, { from: head + 1, to: id }]);
        head = Math.max(head, id);
        stats.posts++;
        if (p.contentStatus === 'telegram-only') stats.unavailable++;
        result.textFailed = textFailed;
        if (budgetStop) {
          // The embed is real, but its text is unfinished. A newly advanced head would
          // otherwise move the next recent pass beyond it. Preserve an unread interval
          // unless the unchanged history cursor or an existing retry already covers it.
          if (id > next && !retry.has(id)) catchupRanges = mergeRanges([...catchupRanges, { from: id, to: id }]);
          throw budgetStop;
        }
        if (!textFailed) retry.delete(id);
      } else {
        retry.delete(id);
        stats.missing++;
        // A post already archived is retained. A later missing response is not proof of deletion.
      }
    } catch (err) {
      // The surrounding loop owns its cursor. Propagate before incrementing it so the
      // next run resumes this exact unfinished ID without a fabricated source error.
      if (err instanceof CollectionBudgetReached) throw err;
      retry.add(id); stats.errors++;
      result = { state: 'error', reason: String(err.message || err) };
    }
    observed.set(id, result);
    if (stats.scanned % 25 === 0) await save();
    if (stats.scanned % 50 === 0) console.log(`Checked ${stats.scanned} IDs; ${byId.size} posts retained; ${retry.size} lookups pending.`);
    return result;
  }
  try {
    if (byId.size) await save();
    const landing = await page(cfg.channel);
    signature = { title: metaOf(landing, 'og:title'), desc: metaOf(landing, 'og:description') };
    if (!signature.title) throw new Error('Telegram landing page not recognised');
    if (cfg.headHint > head) {
      const cold = !head;
      if (cold) next = cfg.headHint;
      if ((await visit(cfg.headHint)).state !== 'post') throw new Error('Supplied head hint is not a readable Telegram message');
    }
    if (!head) throw new Error('A first capture needs TELEGRAM_HEAD_HINT from a real message link');
    // Old messages may disappear together. Try bounded, diverse controls; a matching new
    // message from the recent scan below can also confirm the public source still works.
    const retained = [...byId.values()].sort((a, b) => b.id - a.id);
    const controls = [...new Set([
      ...retained.slice(0, 3),
      retained.find((post) => post.text),
      ...[0.1, 0.5, 0.9, 1].map((fraction) => retained[Math.floor((retained.length - 1) * fraction)]),
    ].filter(Boolean).map((post) => post.id))];
    if (!controls.length) controls.push(head);
    const controlDeadline = started + Math.min(30000, Math.floor(cfg.budget / 5));
    for (const id of controls) {
      if (outOfTime() || now() >= controlDeadline) break;
      if ((await visit(id)).state === 'post') { control = true; break; }
    }

    // Publish nearby arrivals before spending any time on sparse discovery or old history.
    // History-only work skips this pass unless it is needed to recover missing controls.
    if (cfg.phase !== 'history' || !control) {
      const from = head + 1, end = from + cfg.forward - 1;
      let scanOk = true, scannedTo = from - 1;
      for (let id = from; id <= end && !outOfTime(); id++) {
        const result = await visit(id);
        if (result.state === 'post') control = true;
        if (result.state === 'error' || result.textFailed) scanOk = false;
        scannedTo = id;
      }
      checked = cfg.phase !== 'history' && control && scanOk && scannedTo === end;
      if (checked) checkedAt = stamp();
      // Do not skip unvisited recent IDs when a run hits its time budget.
      if (scannedTo === end && control) discoveryNext = Math.max(discoveryNext, end + 1);
    }
    if (!control) {
      if (outOfTime() && !publicSafety) throw new CollectionBudgetReached();
      throw new Error('No archived or recent public message could be confirmed; archive retained');
    }
    await save();
    if (cfg.phase === 'recent') return snapshot(true);

    // Search beyond deleted-ID gaps only after fresh rows have been checkpointed. Every
    // matching sample is retained immediately, and transport/parser failures stay errors.
    const searchDeadline = Math.min(deadline, now() + Math.floor(cfg.budget * cfg.jumpShare));
    const searchSpent = () => now() >= searchDeadline;
    const highestIn = async (lowest, highest, samples = cfg.jumpSamples) => {
      const step = Math.max(1, Math.floor((highest - lowest) / samples));
      let best = 0;
      for (let id = lowest; id <= highest && !outOfTime() && !searchSpent(); id += step) {
        const result = await visit(id);
        if (result.state === 'post') best = id;
        if (result.state === 'error' || result.textFailed) searchFailed = true;
      }
      return best;
    };
    let peak = head;
    while (!outOfTime() && !searchSpent()) {
      let hit = await highestIn(peak + 1, peak + cfg.jumpSpan);
      // A sparse miss cannot prove an entire span is empty. Recheck with finer spacing.
      if (!hit) hit = await highestIn(peak + 1, peak + cfg.jumpSpan, cfg.jumpSamples * 4);
      if (!hit) break;
      peak = hit;
    }
    await save();

    // The independent forward sweep eventually crosses a sparse search's blind spots.
    // It advances only after a visit, and failures also remain in the retry queue.
    discoveryNext = Math.max(discoveryNext, head + 1);
    for (let i = 0; i < cfg.discovery && !outOfTime(); i++, discoveryNext++) await visit(discoveryNext);
    if (discoveryNext > head + 10000) discoveryNext = head + cfg.forward + 1;
    for (const id of [...retry].sort((a, b) => b - a).slice(0, 40)) {
      if (outOfTime()) break;
      await visit(id);
    }
    // Head jumps keep their own newest-first intervals. Alternate with old backfill so
    // daily arrivals can never reset or permanently starve the older history cursor.
    if (!next && prior.schemaVersion !== 2) next = head;
    for (let i = 0; i < cfg.history && !outOfTime() && (next > 0 || catchupRanges.length); i++) {
      if (catchupRanges.length && (i % 2 === 0 || next <= 0)) {
        const range = catchupRanges[0];
        await visit(range.to);
        if (--range.to < range.from) catchupRanges.shift();
      } else {
        await visit(next);
        next--;
      }
    }
  } catch (err) {
    if (!(err instanceof CollectionBudgetReached)) failure = String(err.message || err);
  }
  return snapshot(true);
}

async function main() {
  const cfg = config();
  let prior = {};
  try {
    prior = JSON.parse(await readFile(cfg.out, 'utf8'));
    if (!Array.isArray(prior.posts) || prior.posts.some((p) => !positiveId(p.id))) throw new Error('Invalid existing Telegram archive');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  await mkdir(dirname(cfg.out), { recursive: true });
  const persist = async (archive) => {
    await writeFile(`${cfg.out}.tmp`, `${JSON.stringify(archive, null, 2)}\n`);
    await rename(`${cfg.out}.tmp`, cfg.out);
  };
  const archive = await collect(prior, cfg, { checkpoint: persist });
  await persist(archive);
  console.log(JSON.stringify({ retainedPosts: archive.posts.length, head: archive.headId, historyNextId: archive.historyNextId, retry: archive.retryIds.length, ...archive.lastRun }));
  if (archive.lastRun.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
