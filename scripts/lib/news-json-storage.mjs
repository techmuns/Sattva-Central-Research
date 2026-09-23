import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JSON_SHARD_BYTES, shardSpec, shardPath, parseShard, assembleShards } from '../../public/js/core/json-shards.js';
import { newsQueryIndexRow, NEWS_QUERY_INDEX_VERSION } from '../../public/js/data/news-query-index.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const atomic = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

function pruneGeneratedParts(path, keep = new Set()) {
  const directory = join(dirname(path), `${basename(path, '.json')}.parts`);
  let stat;
  try { stat = lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // A .parts directory is generated storage, never a link to another location. Keep anything
  // outside the content-addressed filename contract, including operator notes or subdirectories.
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid generated news parts directory');
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) || keep.has(name)) continue;
    const file = join(directory, name);
    if (lstatSync(file).isFile()) unlinkSync(file);
  }
}

function verifyQueryIndex(path, part, field, items) {
  const index = part.queryIndex;
  // An index of another version is never read: the browser requires the current one and rebuilds
  // from the verified part otherwise, exactly as for a missing index. So it cannot misreport a
  // record, and it is not a failure. A capture written by the previous code between a version
  // bump and its merge would otherwise fail every asset check until that capture ran again.
  if (!index || index.version !== NEWS_QUERY_INDEX_VERSION) return;
  if (index.sourceSha256 !== part.sha256 || index.rows !== part.rows)
    throw Error('News query index source mismatch');
  const body = readFileSync(shardPath(path, index.file), 'utf8');
  if (Buffer.byteLength(body) !== index.bytes || hash(body) !== index.sha256) throw Error('News query index integrity mismatch');
  const expected = items.map(item => newsQueryIndexRow(field === 'byTicker' ? item[1] : item));
  if (!isDeepStrictEqual(parseShard(body, index), expected)) throw Error('News query index changed source dates or identities');
}

export function readNewsJson(path, fallback = null, { verifyIndexes = false } = {}) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  const spec = shardSpec(value);
  if (!spec) return value;
  // A missing part must throw, NOT turn an existing archive into the missing-file fallback.
  const chunks = spec.parts.map(part => {
    const text = readFileSync(shardPath(path, part.file), 'utf8');
    if (Buffer.byteLength(text) !== part.bytes || hash(text) !== part.sha256) throw Error('News part integrity mismatch');
    const items = parseShard(text, part);
    if (verifyIndexes) verifyQueryIndex(path, part, spec.field, items);
    return items;
  });
  return assembleShards(value, chunks);
}

export function writeNewsJson(path, value, { maxBytes = JSON_SHARD_BYTES, dateIndexed = true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > JSON_SHARD_BYTES) throw Error('Invalid news part size');
  if (Object.hasOwn(value, '_jsonShards')) throw Error('Hydrate the news capture before writing');
  let text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) <= maxBytes) {
    atomic(path, text);
    if (!isDeepStrictEqual(readNewsJson(path), JSON.parse(text))) throw Error('News inline write changed records');
    // Compaction may shrink a previously partitioned capture below the part threshold. Reclaim
    // only obsolete generated fragments, after verifying the complete inline replacement.
    pruneGeneratedParts(path);
    return;
  }
  text = null; // The partition writer must not retain a second serialized full capture.
  const field = value.byTicker && !Array.isArray(value.byTicker) ? 'byTicker' : Array.isArray(value.articles) ? 'articles' : null;
  if (!field) throw Error('Large news JSON has no supported record collection');
  const stem = `${basename(path, '.json')}.parts`;
  const parts = [];
  let items = [], order = [], bytes = Buffer.byteLength('{"items":[]}\n');
  const flush = () => {
    if (!items.length) return;
    const body = `{"items":[${items.join(',')}]}\n`, sha256 = hash(body);
    const part = { file: `${stem}/${sha256}.json`, sha256, bytes: Buffer.byteLength(body), rows: items.length };
    if (dateIndexed) part.order = order;
    atomic(shardPath(path, part.file), body);
    const indexBody = `${JSON.stringify({ items: items.map(text => {
      const row = JSON.parse(text); return newsQueryIndexRow(field === 'byTicker' ? row[1] : row);
    }) })}\n`;
    // Optional accelerators, tied to this exact immutable source revision. Old readers ignore
    // them; new readers fall back to the original part if any index cannot be verified.
    if (Buffer.byteLength(indexBody) <= JSON_SHARD_BYTES) {
      const indexHash = hash(indexBody);
      part.queryIndex = { version: NEWS_QUERY_INDEX_VERSION, sourceSha256: sha256,
        file: `${stem}/${indexHash}.json`, sha256: indexHash, bytes: Buffer.byteLength(indexBody), rows: items.length };
      atomic(shardPath(path, part.queryIndex.file), indexBody);
    }
    parts.push(part); items = []; order = []; bytes = Buffer.byteLength('{"items":[]}\n');
  };
  const add = (item, position) => {
    const serialized = JSON.stringify(item), size = Buffer.byteLength(serialized);
    if (size + Buffer.byteLength('{"items":[]}\n') > maxBytes) throw Error('A news record exceeds the part size; previous manifest is retained');
    if (bytes + size + (items.length ? 1 : 0) > maxBytes) flush();
    bytes += size + (items.length ? 1 : 0); items.push(serialized);
    order.push(position);
  };
  const records = field === 'articles' ? value.articles : Object.entries(value.byTicker).flatMap(([key, rows]) => {
    if (!Array.isArray(rows)) throw Error('Invalid news bucket');
    return rows.map(row => [key, row]);
  });
  const layout = records.map((item, position) => ({ item, position,
    day: dateIndexed ? newsQueryIndexRow(field === 'byTicker' ? item[1] : item)[0] || '' : '' }));
  // The source order is explicit, so grouping transport by date cannot change duplicate
  // precedence, raw exports, or reconstruction for any existing full-history consumer.
  if (dateIndexed) layout.sort((a,b) => b.day.localeCompare(a.day) || a.position-b.position);
  for (const { item, position } of layout) add(item, position);
  flush();
  const manifest = { ...value, [field]: field === 'articles' ? [] : Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []])),
    _jsonShards: { version: dateIndexed ? 2 : 1, field, ...(field === 'byTicker' ? { bucketRows: Object.fromEntries(Object.entries(value.byTicker).map(([key, rows]) => [key, rows.length])) } : {}), rows: parts.reduce((n, p) => n + p.rows, 0), parts } };
  let manifestText = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(manifestText) > maxBytes) {
    // Tiny fixture/transport budgets may have room for the source manifest only. Accelerators
    // are optional; they cannot make a previously valid lossless capture fail publication.
    for (const part of parts) delete part.queryIndex;
    delete manifest._jsonShards.bucketRows;
    manifestText = `${JSON.stringify(manifest)}\n`;
  }
  if (Buffer.byteLength(manifestText) > maxBytes) {
    if (dateIndexed) return writeNewsJson(path, value, { maxBytes, dateIndexed: false });
    throw Error('News manifest metadata exceeds the part size');
  }
  shardSpec(manifest);
  // Verify actual disk bytes before atomically switching the manifest. Never certify a subset.
  const chunks = parts.map(part => {
    const body = readFileSync(shardPath(path, part.file), 'utf8');
    if (hash(body) !== part.sha256) throw Error('News part write verification failed');
    const items = parseShard(body, part);
    verifyQueryIndex(path, part, field, items);
    return items;
  });
  if (!isDeepStrictEqual(assembleShards(manifest, chunks), value)) throw Error('News partition changed records');
  atomic(path, manifestText);
  // Only obsolete generated fragments are removed, after their records have been verified in the
  // new representation. Logical archives are never deleted; Git also retains prior generations.
  const keep = new Set(parts.flatMap(p => [basename(p.file), ...(p.queryIndex ? [basename(p.queryIndex.file)] : [])]));
  pruneGeneratedParts(path, keep);
}
