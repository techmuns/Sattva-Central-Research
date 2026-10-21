// Read retained public captures, including content-addressed transport parts. A manifest's
// empty array is transport metadata, never evidence that the source returned no news.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { NEWS_QUERY_INDEX_VERSION, validNewsQueryIndex } from '../public/js/data/news-query-index.js';
import { shardSpec, shardPath, decodeShard } from '../public/js/core/json-shards.js';

export async function newsletterJson(env, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, 'https://newsletter.invalid')));
  if (!response.ok) { await response.body?.cancel(); throw Error('capture-unavailable'); }
  return boundedJson(response, 32 * 1024 * 1024);
}

/** A listed direct holding does not stop being held because its NSE ticker is absent.
 * Resolve by exact ISIN; retain the actual ISIN as the identifier when mapping is unresolved. */
export async function newsletterHoldings(book, env) {
  let directory = null, nse = null;
  try { directory = await newsletterJson(env, '/data/announcement-identities.json'); } catch { /* Identity remains explicit. */ }
  try { nse = await newsletterJson(env, '/data/filing-capture/nse-identities.json'); } catch { /* No inferred NSE membership. */ }
  const nseEntries = Object.values(nse?.directories || {}).flatMap(d => d?.entries || []);
  return book.holdings.filter(h => h?.name && (h.ticker || h.listed === true && h.isin)).map(h => {
    const bse = h.isin ? (directory?.entries || []).find(e => e.isin === h.isin) : null;
    if (h.ticker) return { ...h, bseCode: bse?.bseCode || h.bseCode || null };
    const matches = nseEntries.filter(e => e.isin === h.isin && e.ticker);
    const tickers = [...new Set(matches.map(e => e.ticker))];
    const ticker = tickers.length === 1 ? tickers[0] : bse?.bseCode || h.isin;
    return { ...h, ticker: String(ticker).toUpperCase(), bseCode: bse?.bseCode || h.bseCode || null, newsletterIdentity: tickers.length === 1 ? 'NSE' : bse?.bseCode ? 'BSE' : 'ISIN; exchange mapping unresolved' };
  });
}

/** Each verified part is filtered and released before reading the next. Keep usable rows on
 * a failed part, with an explicit incomplete result; no failure can masquerade as empty success. */
export async function newsletterRows(env, path, accept = () => true, descriptor = null, range = accept.range || null) {
  const rows = [], failedParts = [], ordered = [];
  // Monthly archive calculation belongs only to the standard GitHub Node runner.
  if (/\/data\/(?:company-news|market-news|tradingview-news|announcements-archive)\/\d{4}-\d{2}\.json$/.test(path) && env.NEWSLETTER_GITHUB_ARCHIVES !== true) return { rows, ok: false, failedParts: [path + ':github-only'] };
  let value;
  try { value = await newsletterJson(env, path); } catch { return { rows, ok: false, failedParts: [path] }; }
  let position = 0, count = 0;
  const append = (item, order = position++) => { count++; if (accept(item)) ordered.push({ order, item }); };
  try {
    const spec = shardSpec(value);
    if (!spec) {
      if (Array.isArray(value.articles)) value.articles.forEach(item => append(item));
      else if (Array.isArray(value.rows)) value.rows.forEach(item => append(item));
      else if (value.byTicker && typeof value.byTicker === 'object') {
        for (const [key, list] of Object.entries(value.byTicker)) for (const row of list || []) append({ ...row, captureKey: key });
      } else throw Error('capture-shape');
    } else {
      for (const part of spec.parts) {
        const file = shardPath(path, part.file);
        try {
          const index = part.queryIndex;
          if (range && index?.version === NEWS_QUERY_INDEX_VERSION && index.sourceSha256 === part.sha256 && index.rows === part.rows) {
            try {
              const indexRows = await newsletterPart(env, shardPath(path, index.file), index);
              if (validNewsQueryIndex(indexRows, part.rows)) {
                const first = new Date(range.from - 86400000).toISOString().slice(0,10), last = new Date(range.to + 86400000).toISOString().slice(0,10);
                if (!indexRows.some(row => row.slice(0,2).some(day => day && day >= first && day <= last))) { count += part.rows; position += part.rows; continue; }
              }
            } catch { /* A failed accelerator falls back to verified source bytes. */ }
          }
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
          const items = await decodeShard(bytes, part);
          for (const [i, item] of items.entries()) {
            const order = spec.version === 2 ? part.order[i] : position++;
            if (spec.field === 'byTicker') {
              if (!Array.isArray(item) || item.length !== 2 || !Object.hasOwn(value.byTicker, item[0])) throw Error('part-bucket');
              append({ ...item[1], captureKey: item[0] }, order);
            } else append(item, order);
          }
        } catch { failedParts.push(file); }
      }
    }
  } catch { failedParts.push(path); }
  rows.push(...ordered.sort((a,b) => a.order-b.order).map(entry => entry.item));
  if (descriptor && (count !== descriptor.count || ['from','to'].some(key => descriptor[key] != null && descriptor[key] !== value[key]))) failedParts.push(path + ':descriptor-mismatch');
  return { rows, count, archive: value.archive, ok: failedParts.length === 0, failedParts, capturedAt: value.newsUpdatedAt || value.capturedAt || value.updatedAt || null,
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

// File completeness is separate from the upstream provider's freshness/history limitations.
export const newsletterNewsReadComplete = news => !!(news?.source?.ok && news?.tradingview?.ok && news?.company?.ok && news.source.archiveComplete && news.tradingview.archiveComplete);

async function newsletterPart(env,path,part) {
  if(!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>4*1024*1024||!/^[a-f0-9]{64}$/.test(part.sha256))throw Error('Invalid part size');
  const response=await env.ASSETS.fetch(new Request(new URL(path,'https://newsletter.invalid')));
  if(!response.ok){await response.body?.cancel();throw Error('part-unavailable');}
  const reader=response.body.getReader(),bytes=new Uint8Array(part.bytes);let offset=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;if(offset+value.byteLength>bytes.length){await reader.cancel();throw Error('part-size');}bytes.set(value,offset);offset+=value.byteLength;}}finally{reader.releaseLock();}
  if(offset!==part.bytes)throw Error('part-size');return decodeShard(bytes,part);
}
