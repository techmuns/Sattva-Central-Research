// Read retained public captures, including content-addressed transport parts. A manifest's
// empty array is transport metadata, never evidence that the source returned no news.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { shardSpec, shardPath, decodeShard } from '../public/js/core/json-shards.js';

export async function newsletterJson(env, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, 'https://newsletter.invalid')));
  if (!response.ok) { await response.body?.cancel(); throw Error('capture-unavailable'); }
  return boundedJson(response, 32 * 1024 * 1024);
}

/** Each verified part is filtered and released before reading the next. Keep usable rows on
 * a failed part, with an explicit incomplete result; no failure can masquerade as empty success. */
export async function newsletterRows(env, path, accept = () => true) {
  const rows = [], failedParts = [];
  let value;
  try { value = await newsletterJson(env, path); } catch { return { rows, ok: false, failedParts: [path] }; }
  const append = item => { if (accept(item)) rows.push(item); };
  try {
    const spec = shardSpec(value);
    if (!spec) {
      if (Array.isArray(value.articles)) value.articles.forEach(append);
      else if (value.byTicker && typeof value.byTicker === 'object') {
        for (const [key, list] of Object.entries(value.byTicker)) for (const row of list || []) append({ ...row, captureKey: key });
      } else throw Error('capture-shape');
    } else {
      for (const part of spec.parts) {
        const file = shardPath(path, part.file);
        try {
          const response = await env.ASSETS.fetch(new Request(new URL(file, 'https://newsletter.invalid')));
          if (!response.ok) { await response.body?.cancel(); throw Error('part-unavailable'); }
          // boundedJson checks the streaming byte limit; decodeShard verifies original bytes.
          const reader = response.body.getReader(), bytes = new Uint8Array(part.bytes);
          let offset = 0;
          try { for (;;) {
            const { value: chunk, done } = await reader.read(); if (done) break;
            if (offset + chunk.byteLength > bytes.length) { await reader.cancel(); throw Error('part-size'); }
            bytes.set(chunk, offset); offset += chunk.byteLength;
          } } finally { reader.releaseLock(); }
          if (offset !== part.bytes) throw Error('part-size');
          for (const item of await decodeShard(bytes, part)) {
            if (spec.field === 'byTicker') {
              if (!Array.isArray(item) || item.length !== 2 || !Object.hasOwn(value.byTicker, item[0])) throw Error('part-bucket');
              append({ ...item[1], captureKey: item[0] });
            } else append(item);
          }
        } catch { failedParts.push(file); }
      }
    }
  } catch { failedParts.push(path); }
  return { rows, ok: failedParts.length === 0, failedParts, capturedAt: value.capturedAt || value.updatedAt || value.newsUpdatedAt || null,
    sources: value.sources, entities: value.entities, coverage: value.tradingViewCoverage };
}

export function newsletterMonths(from, to) {
  const months = [];
  for (let date = new Date(from); date.getTime() < to;) {
    const month = date.toISOString().slice(0, 7); if (!months.includes(month)) months.push(month);
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  return months;
}
