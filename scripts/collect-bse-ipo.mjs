#!/usr/bin/env node
// Public BSE data only. Writes one staging/Actions artifact, never repository files or commits.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { IPO_SOURCES, readIpoSource, parseBseOffers } from '../worker/ipo-sources.mjs';

const output = process.argv[2];
if (!output) throw Error('Provide an artifact output path outside the repository.');
const source = IPO_SOURCES.find((s) => s.id === 'bse-sme');
const checkedAt = new Date().toISOString();
const { body, attempts } = await readIpoSource(source);
const parsed = parseBseOffers(body, source, checkedAt);
if (parsed.unmapped) throw Error(`BSE table has ${parsed.unmapped} unmapped issuer rows; capture not published.`);
const capture = { version: 1, sourceId: source.id, checkedAt, ...parsed, attempts };
writeFileSync(output, gzipSync(JSON.stringify(capture)));
console.log(JSON.stringify({ checkedAt, records: parsed.records, documents: parsed.rows.length, attempts }));
