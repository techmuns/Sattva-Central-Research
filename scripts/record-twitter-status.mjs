#!/usr/bin/env node
// Collection status is separate from post publication/capture times. No network or credentials.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function withTwitterCollectionStatus(body, { enabled, code = null, now = new Date().toISOString() }) {
  const previous = body.collection || {};
  const status = !enabled ? 'disabled' : code === 0 ? (body.failed?.length ? 'partial' : 'ok') : 'unavailable';
  const reason = !enabled ? 'not-enabled' : code === 3 ? 'sign-in-unavailable' : code === 2 ? 'source-read-failed' : code === 0 ? (body.failed?.length ? 'partial-read' : null) : 'collector-failed';
  return {
    ...body,
    posts: body.posts || [], failed: body.failed || [], capturedAt: body.capturedAt || null,
    collection: {
      version: 1, optional: true, status, reason,
      // A disabled schedule is not an attempt and must not generate a new data commit each time.
      lastAttemptAt: enabled ? now : previous.lastAttemptAt || null,
      lastSuccessAt: status === 'ok' ? body.capturedAt || previous.lastSuccessAt || null : previous.lastSuccessAt || null,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../public/data/twitter-posts.json', import.meta.url));
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const enabled = process.env.X_CAPTURE_ENABLED === 'true';
  const code = /^\d+$/.test(process.env.TWITTER_EXIT_CODE || '') ? Number(process.env.TWITTER_EXIT_CODE) : null;
  const next = withTwitterCollectionStatus(body, { enabled, code });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Optional X collection: ${next.collection.status}. Retained posts: ${next.posts.length}.`);
  if (enabled && next.collection.status !== 'ok') console.log('::warning::Optional X collection is unavailable or partial; retained posts and their capture time are preserved.');
}
