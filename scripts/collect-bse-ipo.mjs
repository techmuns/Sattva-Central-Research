#!/usr/bin/env node
// Public BSE data only. Writes one staging/Actions artifact, never repository files or commits.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IPO_SOURCES, BSE_IPO_HEADERS, parseBseOffers } from '../worker/ipo-sources.mjs';
import { BSE_CAPTURE_LIMIT, BSE_COMPRESSED_LIMIT, mergeBseCapture } from '../public/js/data/bse-ipo-shared.js';
import { readBseCollector } from '../worker/bse-ipo-collector.mjs';

const output = process.argv[2];
if (!output) throw Error('Provide an artifact output path outside the repository.');
// A restore failure is fatal: publishing a fresh but incomplete archive would lose
// documents collected while nobody had the dashboard open. PR and main histories
// remain separate; only a verified first-ever run may start from the reviewed seed.
let previous = null;
if (process.env.GITHUB_ACTIONS === 'true') {
  if (!process.env.GH_TOKEN) throw Error('Actions read credential required to restore BSE history');
  previous = (await readBseCollector({ token: process.env.GH_TOKEN,
    ref: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME, allowMissing: true }))?.capture || null;
}
const baseline = JSON.parse(readFileSync(new URL('../public/data/ipo-filings.json', import.meta.url), 'utf8')).rows.filter((r) => r.sourceId === 'bse-sme');
const source = IPO_SOURCES.find((s) => s.id === 'bse-sme');
const checkedAt = new Date().toISOString();
// Collection is off the page-load path: allow a bounded, longer connection window here.
// Fixed argv, no shell, no credentials and no redirects. A failed/changed page publishes nothing.
const { stdout: body } = await promisify(execFile)('curl', [
  '--fail', '--silent', '--show-error', '--compressed', '--connect-timeout', '20', '--max-time', '45',
  '--retry', '1', '--retry-delay', '2', '--retry-connrefused', '--retry-max-time', '90', '--max-filesize', '4194304',
  ...Object.entries(BSE_IPO_HEADERS).flatMap(([key, value]) => ['--header', `${key}: ${value}`]), source.url,
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 100000 });
const parsed = parseBseOffers(body, source, checkedAt);
if (parsed.unmapped) throw Error(`BSE table has ${parsed.unmapped} unmapped issuer rows; capture not published.`);
const capture = mergeBseCapture({ parsed, checkedAt, previous, baseline });
const json = JSON.stringify(capture), bytes = gzipSync(json);
if (Buffer.byteLength(json) > BSE_CAPTURE_LIMIT || bytes.length > BSE_COMPRESSED_LIMIT) throw Error('BSE archive exceeds reader limits; publish blocked, not truncated');
writeFileSync(output, bytes);
console.log(JSON.stringify({ checkedAt, records: parsed.records, currentDocuments: capture.currentCount, retainedDocuments: capture.retainedCount, uniqueDocuments: capture.rows.length }));
