// Query raw captures without materializing overlapping head/month archives at once. The original
// immutable parts remain authoritative. Compact, verified per-part indexes live on this device;
// they locate selected dates and EVERY companion URL before existing canonicalization runs.
import { conditionalJson, readEntry, writeEntry } from '../core/store.js';
import { shardSpec, shardPath, readVerifiedShard } from '../core/json-shards.js';
import { createMemoryCache, estimateMemoryBytes } from '../core/memory-cache.js';
import { newsQueryIdentities as identities, newsQueryIndexRow as summary, validNewsQueryIndex, NEWS_QUERY_INDEX_VERSION } from './news-query-index.js';

const encoder = new TextEncoder();
const fetchPart = (...args) => fetch(...args);
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const yieldInput = () => new Promise(resolve => setTimeout(resolve, 0));
function selected(item, window) {
  if (!window) return true;
  return item.slice(0, 2).some(day => day && day >= window.from && day <= window.to) ||
    !item[0] && !item[1] && !!window.includeUndated;
}
function unwrap(item, descriptor) {
  if (descriptor.spec?.field !== 'byTicker') return item;
  if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Object.hasOwn(descriptor.entry.value.byTicker, item[0]))
    throw Error('Unknown news bucket');
  return item[1];
}

export function createNewsWorkingSet({ window: readingWindow, extraRows = () => [], read = conditionalJson,
  diskRead = readEntry, diskWrite = writeEntry, fetcher = fetchPart } = {}) {
  const projectionBudget = 32 * 1024 * 1024, projections = createMemoryCache(projectionBudget);
  let pending = null, descriptors = new Map(), urls = new Set(), preparedWindow = null, lastPrepared = 0, epoch = 0, selectionRevision = 0;
  // THE GENERATION CHECKS BELOW CAN ONLY REFUSE THE NEXT READ. `read` awaits the device store
  // before it reaches the network, so a release landing in that gap still lets the request go
  // out — one month file, fetched for a reader nobody holds any more. Only a signal that
  // reaches fetch itself can stop that one, and `conditionalJson` accepts one.
  let aborter = null;
  const raw = (path, signal) => read(path, { key: `news-query:manifest:${path}`, rawManifest: true, signal });
  async function partIndex(descriptor, part) {
    const index = part.queryIndex;
    if (index?.version === NEWS_QUERY_INDEX_VERSION && index.sourceSha256 === part.sha256 && index.rows === part.rows &&
        /^[a-f0-9]{64}$/.test(index.sha256 || '') && index.file?.endsWith(`/${index.sha256}.json`) &&
        Number.isSafeInteger(index.bytes) && index.bytes > 0 && index.bytes <= 4 * 1024 * 1024) {
      try {
        const rows = await readVerifiedShard(shardPath(descriptor.path, index.file), index, { fetcher });
        if (validNewsQueryIndex(rows, part.rows)) return rows;
      } catch { /* A missing/corrupt optional index falls back to the verified original part. */ }
    }
    const key = `news-query:index:v${NEWS_QUERY_INDEX_VERSION}:${part.sha256}:${part.rows}:${descriptor.spec.field}`;
    const saved = (await diskRead(key))?.value;
    if (typeof saved?.json === 'string' && saved.digest === await hash(saved.json)) {
      try {
        const rows = JSON.parse(saved.json);
        if (validNewsQueryIndex(rows, part.rows)) return rows;
      } catch { /* Rebuild corrupt indexes from the original integrity-checked bytes. */ }
    }
    const items = await readVerifiedShard(shardPath(descriptor.path, part.file), part, { fetcher });
    const rows = items.map(item => summary(unwrap(item, descriptor))), json = JSON.stringify(rows);
    await diskWrite(key, { value: { json, digest: await hash(json) } });
    return rows;
  }
  async function prepare() {
    if (pending) return pending;
    const generation = epoch, window = readingWindow();
    const controller = new AbortController();
    aborter = controller;
    pending = (async () => {
      const next = new Map(), selectedUrls = new Set();
      // Union the compact identities once, then keep one selection byte per source row.
      // Previously projection read every index again after large source parts had evicted it,
      // repeating downloads/decodes for each head, archive and date-picker operation.
      // Groups 0/1 represent unselected/selected rows without an identity.
      const groups = new Map(), parents = [0, 1], ranks = [0, 0], picked = [false, true];
      const root = group => {
        while (parents[group] !== group) { parents[group] = parents[parents[group]]; group = parents[group]; }
        return group;
      };
      const groupFor = id => {
        if (!groups.has(id)) {
          const group = parents.length;
          groups.set(id, group); parents.push(group); ranks.push(0); picked.push(false);
        }
        return groups.get(id);
      };
      const indexRow = item => {
        // The same TradingView story can change URLs. Close over both identities, including
        // cross-route URL companions, before any of the existing deduplicators run.
        const inWindow = selected(item, window);
        if (!item[2].length) return inWindow ? 1 : 0;
        let group = root(groupFor(item[2][0]));
        for (const id of item[2].slice(1)) {
          let other = root(groupFor(id));
          if (group === other) continue;
          if (ranks[group] < ranks[other]) [group, other] = [other, group];
          parents[other] = group; picked[group] ||= picked[other];
          if (ranks[group] === ranks[other]) ranks[group]++;
        }
        picked[group] ||= inWindow;
        return group;
      };
      const load = async path => {
        if (next.has(path)) return next.get(path);
        // A RELEASED READER MAY NOT START ANOTHER READ. This walk is one sequential request per
        // archive month, so checking only after it finishes lets a disposed tab go on fetching
        // every remaining month: requests that start after destroy, are discarded on arrival, and
        // hold connections the next view needs. Nothing threw and no state was wrong — the reads
        // simply outlived their owner. The loops below break on the same condition so the walk
        // ends promptly; this is the funnel that makes it a guarantee rather than an optimisation.
        if (generation !== epoch) throw Error('Obsolete news view');
        const entry = await raw(path, controller.signal), spec = shardSpec(entry.value);
        if (!entry.value || typeof entry.value !== 'object') throw Error('News capture unavailable');
        const descriptor = { path, entry, spec };
        if (entry.value.byTicker) {
          let counts = spec?.bucketRows;
          if (spec && !counts) {
            // Older publications have no bucket summary. Verify their original parts one at a
            // time; an empty manifest bucket alone cannot establish that a company was checked.
            counts = Object.fromEntries(Object.keys(entry.value.byTicker).map(key => [key, 0]));
            for (const part of spec.parts) {
              const items = await readVerifiedShard(shardPath(path, part.file), part, { fetcher });
              for (const item of items) { unwrap(item, descriptor); counts[item[0]]++; }
            }
          }
          descriptor.sourceTickers = Object.keys(entry.value.byTicker)
            .filter(key => counts ? counts[key] > 0 : entry.value.byTicker[key].length > 0);
        }
        next.set(path, descriptor); return descriptor;
      };
      let head = null;
      try { head = await load('data/news.json'); } catch { /* Independent sources can still paint. */ }
      // The supplemental capture can fail independently. Keep that failure local to its reader.
      let trading = null;
      try { trading = await load('data/tradingview-news/latest.json'); } catch { /* Reader reports this below. */ }
      if (generation !== epoch) throw Error('Obsolete news view');
      for (const headValue of [head?.entry.value, trading?.entry.value].filter(Boolean)) {
        const indexPath = headValue.archive?.index;
        if (!indexPath) continue;
        if (!/^(company-news|tradingview-news)\/index\.json$/.test(indexPath)) continue; // Owning archive reader reports this family's failure.
        let index;
        try { index = await load(`data/${indexPath}`); } catch { continue; }
        const family = indexPath.split('/')[0];
        if (!Array.isArray(index.entry.value.archive)) continue;
        for (const part of index.entry.value.archive) {
          if (generation !== epoch) throw Error('Obsolete news view');
          if (!new RegExp(`^${family}/(\\d{4}-\\d{2}|undated)\\.json$`).test(part.file || '')) continue;
          let descriptor;
          try { descriptor = await load(`data/${part.file}`); } catch { continue; }
          const count = descriptor.spec?.rows ?? descriptor.entry.value.articles?.length;
          if (count !== part.count) { next.delete(descriptor.path); continue; }
        }
      }
      for (const row of extraRows()) indexRow(summary(row));
      // Index one bounded part at a time. Keep only its selected IDs / selected row positions;
      // the complete text and full index need no additional module-lifetime owner.
      for (const descriptor of next.values()) {
        if (descriptor.spec) {
          descriptor.selections = [];
          for (const part of descriptor.spec.parts) {
            if (generation !== epoch) throw Error('Obsolete news view');
            let index;
            try { index = await partIndex(descriptor, part); }
            catch { next.delete(descriptor.path); break; }
            descriptor.selections.push(Uint32Array.from(index, indexRow));
          }
        } else {
          const value = descriptor.entry.value;
          const rows = value.articles || Object.values(value.byTicker || {}).flat();
          const rowGroups = Uint32Array.from(rows, row => indexRow(summary(row)));
          if (Array.isArray(value.articles) || value.byTicker) {
            descriptor.inlineField = value.byTicker ? 'byTicker' : 'articles';
            descriptor.inlineDigest = await hash(JSON.stringify(value[descriptor.inlineField]));
            descriptor.inlineCount = rows.length;
            descriptor.inlineGroups = rowGroups;
            // The raw inline body stays on disk / HTTP cache, not in the working-set owner.
            const metadata = { ...value };
            if (value.byTicker) metadata.byTicker = Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []]));
            else metadata.articles = [];
            descriptor.entry = { ...descriptor.entry, value: metadata };
          }
        }
        await yieldInput();
      }
      for (const [id, group] of groups) if (picked[root(group)]) selectedUrls.add(id);
      // All families and date-correction companions have been considered before exposing a view.
      if (generation !== epoch) throw Error('Obsolete news view');
      for (const descriptor of next.values()) {
        if (descriptor.selections) descriptor.selections = descriptor.selections.map(rows =>
          Uint8Array.from(rows, group => Number(picked[root(group)])));
        if (descriptor.inlineGroups) {
          descriptor.inlineNeeded = descriptor.inlineGroups.some(group => picked[root(group)]);
          delete descriptor.inlineGroups;
        }
      }
      if (JSON.stringify(preparedWindow) !== JSON.stringify(window) || urls.size !== selectedUrls.size ||
          [...selectedUrls].some(url => !urls.has(url))) selectionRevision++;
      for (const descriptor of next.values()) {
        // A refresh still checks every manifest and recomputes companion membership. If both
        // are unchanged, reuse the complete verified projection; do not parse the same large
        // source parts again just to discover that the selected records have not changed.
        descriptor.dataKey = descriptor.spec ? await hash(JSON.stringify([
          descriptor.spec, Object.keys(descriptor.entry.value.byTicker || {}),
        ])) : descriptor.inlineDigest;
        descriptor.projectionKey = JSON.stringify([descriptor.path, descriptor.dataKey, selectionRevision]);
      }
      if (generation !== epoch) throw Error('Obsolete news view');
      const keep = new Set([...next.values()].map(descriptor => descriptor.projectionKey));
      for (const key of projections.keys()) if (!keep.has(key)) projections.delete(key);
      descriptors = next; urls = selectedUrls; preparedWindow = window; lastPrepared = Date.now();
    })().finally(() => { if (generation === epoch) pending = null; });
    return pending;
  }
  async function project(descriptor) {
    // A RELEASED READER MAY NOT START ANOTHER READ HERE EITHER. `prepare()` is guarded above, but
    // this is the other place that fetches: an unsharded month is read whole, and a sharded one
    // costs an index and a part per slice. Left unguarded, a projection in flight when the tab
    // goes away carries on fetching — one request that starts after destroy, which is what the
    // browser suite reports and what no amount of cancelling the walk alone could stop.
    const generation = epoch;
    const live = () => { if (generation !== epoch) throw Error('Obsolete news view'); };
    const window = preparedWindow, selectedUrls = urls, queryRevision = selectionRevision;
    const projectedRows = projections.get(descriptor.projectionKey);
    let value = descriptor.entry.value;
    if (!descriptor.spec && !value.byTicker && !Array.isArray(value.articles)) return { ...descriptor.entry, queryRevision };
    const field = descriptor.spec?.field || (value.byTicker ? 'byTicker' : 'articles');
    const { _jsonShards, ...out } = value;
    out.queryWindow = window; out.queryRevision = queryRevision;
    out[field] = field === 'byTicker' ? Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []])) : [];
    const matches = item => selected(item, window) || item[2].some(id => selectedUrls.has(id));
    if (!projectedRows && descriptor.inlineDigest && descriptor.inlineNeeded) {
      live();
      const entry = await raw(descriptor.path, aborter?.signal);
      if (await hash(JSON.stringify(entry.value?.[descriptor.inlineField])) !== descriptor.inlineDigest) throw Error('News capture changed during this query');
      value = entry.value;
    }
    const add = item => {
      const row = unwrap(item, { ...descriptor, spec: { field } });
      if (!matches(summary(row))) return;
      if (field === 'byTicker') out.byTicker[item[0]].push(row); else out.articles.push(row);
    };
    if (projectedRows) out[field] = projectedRows;
    else if (descriptor.spec) {
      const selectedItems = [];
      let offset = 0;
      for (const [partNumber, part] of descriptor.spec.parts.entries()) {
      live();
      const selection = descriptor.selections[partNumber];
      if (selection.some(Boolean)) {
        live();
        const items = await readVerifiedShard(shardPath(descriptor.path, part.file), part, { fetcher });
        items.forEach((item, i) => { if (selection[i]) selectedItems.push({ item, order: part.order?.[i] ?? offset+i }); });
      }
      offset += part.rows;
      await yieldInput();
      }
      selectedItems.sort((a,b)=>a.order-b.order).forEach(({item})=>add(item));
    } else if (field === 'articles') value.articles.forEach(add);
    else for (const [key, rows] of Object.entries(value.byTicker)) for (const row of rows) add([key, row]);
    live();
    if (!projectedRows) {
      const bytes = estimateMemoryBytes(out[field], projectionBudget);
      if (bytes <= projectionBudget) projections.set(descriptor.projectionKey, out[field], bytes);
    }
    if (field === 'byTicker') {
      // A checked company whose saved articles fall outside this period is not an unchecked
      // company. Keep source failures separate, and do not rewrite the source's own empty list.
      const failed = new Set(Object.keys(value.failed || {}).map(key => key.toUpperCase()));
      out.queryEmpty = descriptor.sourceTickers.filter(key => !out.byTicker[key].length && !failed.has(key.toUpperCase()));
    }
    // Count validation describes the complete source; query rows describe only this working set.
    if (field === 'articles') out.querySourceCount = descriptor.spec?.rows ?? descriptor.inlineCount ?? value.articles.length;
    return { ...descriptor.entry, value: out };
  }
  return {
    prepare,
    includes: row => selected(summary(row), readingWindow()) || identities(row).some(id => urls.has(id)),
    async read(path, options) {
      if (!path.startsWith('data/')) return read(path, options);
      // createQueryNews prepares every load/refresh, including its visible-page poller. Keep
      // that checked revision throughout one operation: a slow projection is not a new check.
      if (!lastPrepared || JSON.stringify(preparedWindow) !== JSON.stringify(readingWindow())) await prepare();
      // A period selected while an earlier preparation was in flight gets its own complete
      // projection. A pending old query cannot certify the new period.
      while (JSON.stringify(preparedWindow) !== JSON.stringify(readingWindow())) await prepare();
      const descriptor = descriptors.get(path);
      if (!descriptor) throw Error('News capture unavailable');
      return project(descriptor);
    },
    release() { epoch++; aborter?.abort(); aborter = null; pending = null; descriptors.clear(); projections.clear(); urls.clear(); lastPrepared = 0; preparedWindow = null; },
  };
}
