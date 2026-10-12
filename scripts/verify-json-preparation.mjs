// Exact JSON/cache representation and adversarial codec boundaries; no external requests.
import assert from 'node:assert/strict';
import { packJson, unpackJson, packJsonAsync, unpackJsonAsync, jsonBuffers } from '../public/js/core/json-codec.js';
import { dedupeArticles, dedupeArticlesAsync } from '../public/js/data/filings-shared.js';

const hostile = JSON.parse('{"__proto__":{"safe":"own field"},"constructor":"source field"}');
const value = { records: Array.from({ length: 5000 }, (_, i) => ({ id: `record-${i}`, day: '2026-10-12',
  title: 'शेयर · earnings \"quoted\"', detail: 'Repeated source explanation. '.repeat(30),
  amount: i / 100, nullable: null, flags: [true, false], hostile })), numbers: [-0, 1e100, 0.000001],
  escapedText: ['\ud800', '\udc00', 'valid 😀 and lone \ud800'] };
value.optional = undefined;
value.sparse = [undefined, , 3];
const packed = packJson(value);
assert.deepEqual(unpackJson(packed), value, 'every field, Unicode value, number and own property survives');
assert.equal(Object.getPrototypeOf(unpackJson(packed).records[0].hostile), Object.prototype);
assert.equal({}.safe, undefined, 'a source property never mutates prototypes');
const binaryBytes = jsonBuffers(packed).reduce((sum, buffer) => sum + buffer.byteLength, 0);
assert(binaryBytes < Buffer.byteLength(JSON.stringify(value)) / 3, 'repeated text has one binary copy');
assert.deepEqual(await unpackJsonAsync(await packJsonAsync(value)), value, 'cooperative and synchronous drivers are identical');
const moved = structuredClone(packed, { transfer: jsonBuffers(packed) });
assert.equal(packed.words.byteLength, 0, 'transport transfers rather than cloning the complete graph');
assert.deepEqual(unpackJson(moved), value);
assert.throws(() => unpackJson({ ...moved, words: new Int32Array([6, 999999]) }), /Invalid packed JSON/);
assert.throws(() => unpackJson({ ...moved, words: new Int32Array([99]) }), /Invalid packed JSON/);
const cyclic = {}; cyclic.self = cyclic;
assert.throws(() => packJson(cyclic), /Cyclic/);
const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, title: `News ${i % 2500}`, source: 'Publisher',
  date: '2026-10-12', url: `https://example.test/news/${i % 2500}?utm_source=fixture` }));
assert.deepEqual(await dedupeArticlesAsync(rows), dedupeArticles(rows), 'cooperative dedupe preserves winners, order and original objects');
console.log(`PASS: exact JSON/cache roundtrip, transferable buffers, malformed input, prototype safety, dedupe parity; ${Buffer.byteLength(JSON.stringify(value))} → ${binaryBytes} working bytes.`);
