#!/usr/bin/env node
// Public BSE data only. Writes one staging/Actions artifact, never repository files or commits.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IPO_SOURCES, BSE_IPO_HEADERS, parseBseOffers } from '../worker/ipo-sources.mjs';
import { validateBseCapture } from '../public/js/data/bse-ipo-shared.js';

const output = process.argv[2];
if (!output) throw Error('Provide an artifact output path outside the repository.');
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
const capture = validateBseCapture({ version: 1, sourceId: source.id, checkedAt, ...parsed });
writeFileSync(output, gzipSync(JSON.stringify(capture)));
console.log(JSON.stringify({ checkedAt, records: parsed.records, documents: parsed.rows.length }));
