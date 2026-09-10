#!/usr/bin/env node
// Only explicit, validated public fields reach an artifact; no Telegram sessions/account objects.
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTelegramCapture, TELEGRAM_COMPRESSED_LIMIT, TELEGRAM_LIMIT } from '../public/js/data/telegram-shared.js';
import { readTelegramCollector } from '../worker/telegram-collector.mjs';
export function mergeTelegramRestore(committedInput, latestInput, now = Date.now()) {
  const committed = validateTelegramCapture(committedInput, now);
  const latest = latestInput ? validateTelegramCapture(latestInput, now) : null;
  const newer = latest && Date.parse(latest.lastRun.at) > Date.parse(committed.lastRun.at) ? latest : committed;
  const older = newer === committed ? latest : committed;
  const rows = new Map();
  for (const p of older?.posts || []) rows.set(p.id, p);
  const fallback = (prior, incoming) => {
    if (!prior) return incoming;
    const merged = { ...prior, ...incoming };
    if ((incoming?.text == null || incoming.text === '') && prior.text) merged.text = prior.text;
    if (!incoming?.firstSeenAt && prior.firstSeenAt) merged.firstSeenAt = prior.firstSeenAt;
    return merged;
  };
  for (const p of newer.posts) rows.set(p.id, fallback(rows.get(p.id), p));
  // A later repository backup timestamp is not authorization to clear a known active pause
  // from the source checkpoint. A genuinely newer final checkpoint remains authoritative.
  const publicSafety = newer === committed && Date.parse(latest?.publicSafety?.nextAttemptAt) > now &&
    !(Date.parse(committed.publicSafety?.nextAttemptAt) >= Date.parse(latest.publicSafety.nextAttemptAt)) ? latest.publicSafety : newer.publicSafety;
  const keepApiPause = newer === committed && latest?.apiSafety && !committed.apiSafety?.paused &&
    (latest.apiSafety.paused || (Date.parse(latest.apiSafety.nextAttemptAt) > now &&
      !(Date.parse(committed.apiSafety?.nextAttemptAt) >= Date.parse(latest.apiSafety.nextAttemptAt))));
  const apiSafety = keepApiPause ? latest.apiSafety : newer.apiSafety;
  return validateTelegramCapture({ ...newer, publicSafety, apiSafety, posts: [...rows.values()] }, now);
}
async function main() {
const [mode, file, output] = process.argv.slice(2);
if (mode === 'restore' || mode === 'backup') {
  const previous = process.env.GITHUB_ACTIONS === 'true' ? await readTelegramCollector({ token: process.env.GH_TOKEN,
    ref: process.env.GITHUB_REF_NAME || 'main', allowMissing: true, purpose: mode === 'backup' ? 'delivery' : 'restore',
    excludeRunId: Number(process.env.GITHUB_RUN_ID) || 0,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1), signal: AbortSignal.timeout(mode === 'restore' ? 120000 : 45000) }) : null;
  const committed = JSON.parse(await readFile(file, 'utf8'));
  const merged = mergeTelegramRestore(committed, previous?.capture);
  // A backup never contacts Telegram. It can preserve an early/older verified archive, but
  // an unavailable newer delivery cannot be converted into a successful source check.
  if (mode === 'backup' && previous?.source.degraded) {
    merged.latestVerifiedAt = null;
    if (merged.lastRun.status === 'ok') merged.lastRun.status = 'partial';
  }
  await writeFile(output, JSON.stringify(merged) + '\n');
} else if (mode === 'failed') {
  const prior = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...prior, latestVerifiedAt: null, lastRun: { at: new Date().toISOString(), status: 'failed' } }));
} else if (mode === 'pack') {
  const capture = validateTelegramCapture(JSON.parse(await readFile(file, 'utf8')));
  const bytes = Buffer.from(JSON.stringify(capture));
  const compressed = gzipSync(bytes);
  if (bytes.length > TELEGRAM_LIMIT || compressed.length > TELEGRAM_COMPRESSED_LIMIT) throw Error('Telegram archive exceeds artifact limit');
  await writeFile(output, compressed);
  console.log(`Validated ${capture.posts.length} public posts; ${capture.lastRun.status}.`);
} else throw Error('Use restore/backup <committed.json> <local.json> or pack <local.json> <artifact.json.gz>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
