#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPANY_CAPTURE_INTERVAL_MS = 2 * 3600000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Trigger type is not a freshness signal. A watchdog dispatch must be able to recover the same
// company queue as cron, without running the slower collector on every ordinary trade refresh.
export function companyCaptureDue(index, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error('Invalid check time.');
  if (index?.version !== 1 || !object(index.sources) ||
      !['announcements', 'domestic'].every(kind => object(index.sources[kind])) ||
      !Array.isArray(index.companies) || !index.companies.length) {
    return { due: true, reason: 'missing-checkpoint' };
  }
  const started = Date.parse(index.lastRunAt || '');
  const finished = Date.parse(index.lastRunFinishedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || started > now || finished > now) {
    return { due: true, reason: 'invalid-checkpoint-time' };
  }
  if (finished < started) return { due: true, reason: 'interrupted-capture' };
  return now - started >= COMPANY_CAPTURE_INTERVAL_MS
    ? { due: true, reason: 'capture-due' }
    : { due: false, reason: 'within-capture-interval' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2] || fileURLToPath(new URL('../public/data/filing-capture/index.json', import.meta.url));
  let index = null;
  try { index = JSON.parse(readFileSync(path, 'utf8')); }
  catch { /* Missing or unreadable state needs collection, never a fresh-looking skip. */ }
  const result = companyCaptureDue(index);
  console.log(`Company filings: ${result.due ? 'due' : 'not due'} (${result.reason}).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `due=${result.due}\nreason=${result.reason}\n`);
}
