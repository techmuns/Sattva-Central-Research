import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JSON_SHARD_BYTES, shardSpec, shardPath, parseShard, assembleShards } from '../../public/js/core/json-shards.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const atomic = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

export function readNewsJson(path, fallback = null) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  const spec = shardSpec(value);
  if (!spec) return value;
  // A missing part must throw, NOT turn an existing archive into the missing-file fallback.
  const chunks = spec.parts.map(part => {
    const text = readFileSync(shardPath(path, part.file), 'utf8');
    if (Buffer.byteLength(text) !== part.bytes || hash(text) !== part.sha256) throw Error('News part integrity mismatch');
    return parseShard(text, part);
  });
  return assembleShards(value, chunks);
}

export function writeNewsJson(path, value, { maxBytes = JSON_SHARD_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > JSON_SHARD_BYTES) throw Error('Invalid news part size');
  if (Object.hasOwn(value, '_jsonShards')) throw Error('Hydrate the news capture before writing');
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) <= maxBytes) { atomic(path, text); return; }
  const field = value.byTicker && !Array.isArray(value.byTicker) ? 'byTicker' : Array.isArray(value.articles) ? 'articles' : null;
  if (!field) throw Error('Large news JSON has no supported record collection');
  const stem = `${basename(path, '.json')}.parts`;
  const parts = [];
  let items = [], bytes = Buffer.byteLength('{"items":[]}\n');
  const flush = () => {
    if (!items.length) return;
    const body = `{"items":[${items.join(',')}]}\n`, sha256 = hash(body);
    const part = { file: `${stem}/${sha256}.json`, sha256, bytes: Buffer.byteLength(body), rows: items.length };
    atomic(shardPath(path, part.file), body);
    parts.push(part); items = []; bytes = Buffer.byteLength('{"items":[]}\n');
  };
  const add = item => {
    const serialized = JSON.stringify(item), size = Buffer.byteLength(serialized);
    if (size + Buffer.byteLength('{"items":[]}\n') > maxBytes) throw Error('A news record exceeds the part size; previous manifest is retained');
    if (bytes + size + (items.length ? 1 : 0) > maxBytes) flush();
    bytes += size + (items.length ? 1 : 0); items.push(serialized);
  };
  if (field === 'articles') value.articles.forEach(add);
  else for (const [key, rows] of Object.entries(value.byTicker)) {
    if (!Array.isArray(rows)) throw Error('Invalid news bucket');
    for (const row of rows) add([key, row]);
  }
  flush();
  const manifest = { ...value, [field]: field === 'articles' ? [] : Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []])),
    _jsonShards: { version: 1, field, rows: parts.reduce((n, p) => n + p.rows, 0), parts } };
  const manifestText = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(manifestText) > maxBytes) throw Error('News manifest metadata exceeds the part size');
  shardSpec(manifest);
  // Verify actual disk bytes before atomically switching the manifest. Never certify a subset.
  const chunks = parts.map(part => {
    const body = readFileSync(shardPath(path, part.file), 'utf8');
    if (hash(body) !== part.sha256) throw Error('News part write verification failed');
    return parseShard(body, part);
  });
  if (!isDeepStrictEqual(assembleShards(manifest, chunks), value)) throw Error('News partition changed records');
  atomic(path, manifestText);
  // Only obsolete generated fragments are removed, after their records have been verified in the
  // new representation. Logical archives are never deleted; Git also retains prior generations.
  const keep = new Set(parts.map(p => basename(p.file)));
  for (const name of readdirSync(join(dirname(path), stem))) {
    if (/^[a-f0-9]{64}\.json$/.test(name) && !keep.has(name)) unlinkSync(join(dirname(path), stem, name));
  }
}
