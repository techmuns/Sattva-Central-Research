#!/usr/bin/env node
// Immutable staging/Actions output only; no repo commits, production writes or dispatches.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectPlatform } from './lib/ipo-platform.mjs';
import { mergePlatformCapture, PLATFORM_LIMIT, PLATFORM_COMPRESSED_LIMIT } from '../public/js/data/ipo-platform-shared.js';
import { readPlatformCollector } from '../worker/ipo-platform-collector.mjs';

const output = process.argv[2]; if (!output) throw Error('Provide a staging artifact output path');
let previous = process.argv[3] ? JSON.parse(gunzipSync(readFileSync(process.argv[3]), { maxOutputLength: PLATFORM_LIMIT })) : null;
if (process.env.GITHUB_ACTIONS === 'true') {
  // A failed restore must never silently reset collected history. Verified first-ever run only.
  previous = (await readPlatformCollector({ token: process.env.GH_TOKEN, ref: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME, allowMissing: true, signal: AbortSignal.timeout(45000) }))?.capture || null;
}
const capture = mergePlatformCapture(await collectPlatform(), previous);
const json = JSON.stringify(capture), bytes = gzipSync(json);
if (Buffer.byteLength(json) > PLATFORM_LIMIT || bytes.length > PLATFORM_COMPRESSED_LIMIT) throw Error('IPOPlatform history exceeds limits; blocked, never truncated');
writeFileSync(output, bytes);
console.log(JSON.stringify({ checkedAt: capture.checkedAt, ...capture.counts, uniqueIssuers: capture.companies.length, documents: capture.rows.length, retainedIssuers: capture.companies.filter((c) => c.retained).length, bytes: bytes.length }));
