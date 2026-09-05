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
    headHint: integer(env, 'TELEGRAM_HEAD_HINT', 0, 0, 2147483647) };
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
  console.log(JSON.stringify({ posts: archive.posts.length, head: archive.headId, historyNextId: archive.historyNextId, retry: archive.retryIds.length, ...archive.lastRun }));
  if (archive.lastRun.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
