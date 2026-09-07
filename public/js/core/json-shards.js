// Lossless transport for large public news captures. A manifest is not an empty feed.
// No caller may adopt it until every referenced part has passed its integrity checks.
export const JSON_SHARD_BYTES = 4 * 1024 * 1024;
export const JSON_ASSET_LIMIT = 25 * 1024 * 1024;
const encoder = new TextEncoder();

export function shardSpec(value) {
  if (!value || !Object.hasOwn(value, '_jsonShards')) return null;
  const spec = value._jsonShards;
  if (spec?.version !== 1 || !['byTicker', 'articles'].includes(spec.field) ||
      !Number.isSafeInteger(spec.rows) || spec.rows < 0 || !Array.isArray(spec.parts) ||
      !spec.parts.length || spec.parts.length > 4096) throw Error('Invalid news shard manifest');
  let rows = 0;
  for (const part of spec.parts) {
    if (!/^[A-Za-z0-9_-]+\.parts\/[a-f0-9]{64}\.json$/.test(part.file || '') ||
        !/^[a-f0-9]{64}$/.test(part.sha256 || '') || !part.file.endsWith(`/${part.sha256}.json`) ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > JSON_SHARD_BYTES ||
        !Number.isSafeInteger(part.rows) || part.rows < 1) throw Error('Invalid news shard reference');
    rows += part.rows;
  }
  if (rows !== spec.rows) throw Error('News shard count mismatch');
  const empty = value[spec.field];
  if (spec.field === 'articles' ? !Array.isArray(empty) || empty.length :
    !empty || typeof empty !== 'object' || Array.isArray(empty) || Object.values(empty).some(x => !Array.isArray(x) || x.length))
    throw Error('News manifest contains unaccounted records');
  return spec;
}

export function shardPath(parent, file) {
  // Keep all reads beside the manifest, with no URLs, credentials, traversal or query input.
  const path = String(parent).split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  if (!file.startsWith(`${name}.parts/`)) throw Error('News part belongs to a different manifest');
  return path.slice(0, path.lastIndexOf('/') + 1) + file;
}

export async function decodeShard(text, part) {
  const bytes = encoder.encode(text);
  if (bytes.byteLength !== part.bytes) throw Error('News part byte count mismatch');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== part.sha256) throw Error('News part integrity mismatch');
  return parseShard(text, part);
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
  if (spec.field === 'articles') out.articles = [];
  else out.byTicker = Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []]));
  chunks.forEach((items, i) => {
    if (!Array.isArray(items) || items.length !== spec.parts[i].rows) throw Error('News parts incomplete');
    for (const item of items) {
      if (spec.field === 'articles') out.articles.push(item);
      else {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' ||
            !Object.hasOwn(out.byTicker, item[0])) throw Error('Unknown news bucket');
        out.byTicker[item[0]].push(item[1]);
      }
    }
  });
  return out;
}

export async function hydrateJsonShards(value, path, { fetcher = fetch, signal } = {}) {
  const spec = shardSpec(value);
  if (!spec) return value;
  const chunks = new Array(spec.parts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, spec.parts.length) }, async () => {
    while (next < spec.parts.length) {
      const i = next++, part = spec.parts[i];
      const response = await fetcher(shardPath(path, part.file), {
        cache: 'no-cache', signal: signal || AbortSignal.timeout(20000), headers: { accept: 'application/json' },
      });
      if (!response.ok) throw Error('News part unavailable');
      chunks[i] = await decodeShard(await response.text(), part);
    }
  }));
  return assembleShards(value, chunks);
}
