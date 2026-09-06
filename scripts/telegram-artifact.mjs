#!/usr/bin/env node
// Only explicit, validated public fields reach an artifact; no Telegram sessions/account objects.
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { validateTelegramCapture, TELEGRAM_COMPRESSED_LIMIT, TELEGRAM_LIMIT } from '../public/js/data/telegram-shared.js';
import { readTelegramCollector } from '../worker/telegram-collector.mjs';
const [mode, file, output] = process.argv.slice(2);
if (mode === 'restore') {
  const previous = process.env.GITHUB_ACTIONS === 'true' ? await readTelegramCollector({ token: process.env.GH_TOKEN,
    ref: process.env.GITHUB_REF_NAME || 'main', allowMissing: true, signal: AbortSignal.timeout(45000) }) : null;
  const committed = JSON.parse(await readFile(file, 'utf8'));
  // Keep every captured ID even when a newer committed backfill landed independently.
  const latest = previous?.capture;
  const newer = latest && Date.parse(latest.lastRun.at) > Date.parse(committed.lastRun?.at || 0) ? latest : committed;
  const rows = new Map([...(latest?.posts || []), ...committed.posts, ...newer.posts].map(p => [p.id, p]));
  await writeFile(output, JSON.stringify(validateTelegramCapture({ ...newer, posts: [...rows.values()] })) + '\n');
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
} else throw Error('Use restore <committed.json> <local.json> or pack <local.json> <artifact.json.gz>');
