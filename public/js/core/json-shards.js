// Lossless transport for large public news captures. A manifest is not an empty feed.
// No caller may adopt it until every referenced part has passed its integrity checks.
import { createMemoryCache } from './memory-cache.js';
import { parseJsonBytes } from './json-reader.js';
export const JSON_SHARD_BYTES = 4 * 1024 * 1024;
export const JSON_ASSET_LIMIT = 25 * 1024 * 1024;
const encoder = new TextEncoder();
const cachesByFetcher = new WeakMap();
function readerCache(fetcher) {
  let cache = cachesByFetcher.get(fetcher);
  if (!cache) {
    cache = { values: createMemoryCache(24 * 1024 * 1024), pending: new Map(), decodes: 0, hits: 0 };
    cachesByFetcher.set(fetcher, cache);
  }
  return cache;
}
export function jsonShardCacheState(fetcher = fetch) {
  const cache = readerCache(fetcher);
  return { ...cache.values.stats(), pending: cache.pending.size, decodes: cache.decodes, hits: cache.hits };
}
function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) immutable(item);
  return Object.freeze(value);
}

// Every consumer has its own cancellation. One abandoned manifest must not abort another
// reader of the same immutable part. No failed decode enters the verified cache.
export function readVerifiedShard(path, part, { fetcher = fetch, signal } = {}) {
  signal?.throwIfAborted();
  const cache = readerCache(fetcher), key = `${part.sha256}:${part.bytes}:${part.rows}`;
  const saved = cache.values.get(key);
  if (saved) { cache.hits++; return Promise.resolve(saved); }
  let job = cache.pending.get(key);
  if (!job) {
    job = { controller: new AbortController(), readers: 0, settled: false };
    cache.pending.set(key, job);
    job.promise = readPart(path, part, fetcher, job.controller.signal).then(async bytes => {
      const items = immutable(await decodeShard(bytes, part));
      cache.decodes++;
      // Budget decoded object overhead as well as strings; oversized parts are returned without
      // an extra strong cache owner. Live consumers can continue using their own references.
      cache.values.set(key, items, part.bytes * 4);
      return items;
    }).finally(() => {
      job.settled = true;
      if (cache.pending.get(key) === job) cache.pending.delete(key);
    });
  } else cache.hits++;
  job.readers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort); job.readers--;
      if (!job.readers && !job.settled) {
        cache.pending.delete(key); job.controller.abort();
      }
      fn(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) abort();
  });
}

export function shardSpec(value) {
  if (!value || !Object.hasOwn(value, '_jsonShards')) return null;
  const spec = value._jsonShards;
  if (![1, 2].includes(spec?.version) || !['byTicker', 'articles', 'rows'].includes(spec.field) ||
      !Number.isSafeInteger(spec.rows) || spec.rows < 0 || !Array.isArray(spec.parts) ||
      !spec.parts.length || spec.parts.length > 4096) throw Error('Invalid news shard manifest');
  let rows = 0;
  const positions = spec.version === 2 ? new Set() : null;
  for (const part of spec.parts) {
    if (!/^[A-Za-z0-9_-]+\.parts\/[a-f0-9]{64}\.json$/.test(part.file || '') ||
        !/^[a-f0-9]{64}$/.test(part.sha256 || '') || !part.file.endsWith(`/${part.sha256}.json`) ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > JSON_SHARD_BYTES ||
        !Number.isSafeInteger(part.rows) || part.rows < 1) throw Error('Invalid news shard reference');
    rows += part.rows;
    if (positions) {
      if (!Array.isArray(part.order) || part.order.length !== part.rows) throw Error('Invalid news part order');
      for (const position of part.order) {
        if (!Number.isSafeInteger(position) || position < 0 || position >= spec.rows || positions.has(position)) throw Error('Invalid news part order');
        positions.add(position);
      }
    }
  }
  if (rows !== spec.rows) throw Error('News shard count mismatch');
  const empty = value[spec.field];
  if (spec.field !== 'byTicker' ? !Array.isArray(empty) || empty.length :
    !empty || typeof empty !== 'object' || Array.isArray(empty) || Object.values(empty).some(x => !Array.isArray(x) || x.length))
    throw Error('News manifest contains unaccounted records');
  if (spec.bucketRows != null) {
    const counts = spec.bucketRows;
    if (spec.field !== 'byTicker' || !counts || typeof counts !== 'object' || Array.isArray(counts) ||
        Object.keys(counts).length !== Object.keys(empty).length ||
        Object.entries(counts).some(([key, count]) => !Object.hasOwn(empty, key) || !Number.isSafeInteger(count) || count < 0) ||
        Object.values(counts).reduce((sum, count) => sum + count, 0) !== spec.rows)
      throw Error('Invalid news bucket counts');
  }
  return spec;
}

export function shardPath(parent, file) {
  // Keep all reads beside the manifest, with no URLs, credentials, traversal or query input.
  const path = String(parent).split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  if (!file.startsWith(`${name}.parts/`)) throw Error('News part belongs to a different manifest');
  return path.slice(0, path.lastIndexOf('/') + 1) + file;
}

export async function decodeShard(input, part) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  if (bytes.byteLength !== part.bytes) throw Error('News part byte count mismatch');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== part.sha256) throw Error('News part integrity mismatch');
  const data = await parseJsonBytes(bytes);
  if (!Array.isArray(data.items) || data.items.length !== part.rows) throw Error('News part record count mismatch');
  return data.items;
}

export function parseShard(text, part) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.items) || data.items.length !== part.rows) throw Error('News part record count mismatch');
  return data.items;
}

export function assembleShards(value, chunks) {
  const spec = shardSpec(value);
  if (!spec) return value;
  if (chunks.length !== spec.parts.length) throw Error('News parts incomplete');
  const { _jsonShards, ...out } = value;
  if (spec.field !== 'byTicker') out[spec.field] = [];
  else out.byTicker = Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []]));
  const ordered = spec.version === 2 ? new Array(spec.rows) : null;
  const append = item => {
    if (spec.field !== 'byTicker') out[spec.field].push(item);
    else {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' ||
          !Object.hasOwn(out.byTicker, item[0])) throw Error('Unknown news bucket');
      out.byTicker[item[0]].push(item[1]);
    }
  };
  chunks.forEach((items, i) => {
    if (!Array.isArray(items) || items.length !== spec.parts[i].rows) throw Error('News parts incomplete');
    if (ordered) items.forEach((item, j) => { ordered[spec.parts[i].order[j]] = item; });
    else items.forEach(append);
  });
  ordered?.forEach(append);
  if (spec.bucketRows && Object.entries(spec.bucketRows).some(([key, count]) => out.byTicker[key].length !== count))
    throw Error('News bucket count mismatch');
  return out;
}

export async function hydrateJsonShards(value, path, { fetcher = fetch, signal } = {}) {
  const spec = shardSpec(value);
  if (!spec) return value;
  const chunks = new Array(spec.parts.length);
  const group = new AbortController();
  const combined = signal ? AbortSignal.any([signal, group.signal]) : group.signal;
  let next = 0;
  try { await Promise.all(Array.from({ length: Math.min(3, spec.parts.length) }, async () => {
    while (next < spec.parts.length) {
      const i = next++, part = spec.parts[i];
      // Immutable GETs get one bounded recovery attempt. Integrity failures and access denials
      // never retry. No partial result reaches the store; one fatal part stops sibling downloads.
      chunks[i] = await readVerifiedShard(shardPath(path, part.file), part, { fetcher, signal: combined });
    }
  })); } catch (error) { group.abort(); throw error; }
  return assembleShards(value, chunks);
}

async function readPart(path, part, fetcher, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let retryable = true;
    try {
      const response = await fetcher(path, { cache: 'no-cache',
        signal: AbortSignal.any([signal, controller.signal]), headers: { accept: 'application/json' } });
      if (!response.ok) {
        retryable = [502, 503, 504].includes(response.status);
        await response.body?.cancel();
        throw Error('News part unavailable');
      }
      // Allocate only the declared bounded size. Stop a wrong or endlessly streaming body
      // before it can allocate an arbitrary arrayBuffer in a long-lived tab.
      const bytes = new Uint8Array(part.bytes), reader = response.body?.getReader();
      let offset = 0;
      try {
        if (reader) while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > part.bytes) {
            retryable = false; await reader.cancel(); throw Error('News part byte count mismatch');
          }
          bytes.set(value, offset); offset += value.byteLength;
        }
      } finally { reader?.releaseLock(); }
      if (offset !== part.bytes) { retryable = false; throw Error('News part byte count mismatch'); }
      retryable = false;
      return bytes;
    } catch (error) {
      if (!retryable || attempt || signal.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally { clearTimeout(timer); }
  }
}
