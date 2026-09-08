import { conditionalJson } from '../core/store.js';
import { dedupeArticles } from './filings-shared.js';
import { attributeNewsRow } from './company-news-attribution.js';

// Retained monthly records stay available after they leave the recent head. Scope, search and
// attribution still run in their existing consumers; storage partitioning is never a filter.
export function withNewsHistory(base, { read = conditionalJson } = {}) {
  let held = new Map(), identities = new Map(), revision = 0, combined = null;
  let pending = null, error = null, loaded = false, initialized = false, epoch = 0;
  const indexes = new Map(), listeners = new Set();
  const emit = () => listeners.forEach(fn => fn());
  function rows() {
    const source = base.rows();
    if (combined?.source === source && combined.revision === revision) return combined.rows;
    const buckets = new Map();
    const add = row => {
      const key = row.ticker || row.entityId || row.company;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    };
    source.forEach(add);
    for (const list of held.values()) for (const row of list)
      add(attributeNewsRow(row, identities.get(row.entityId) || identities.get(row.ticker) || row));
    // Archive concatenation order (including corrected publication dates crossing months) must
    // not let an older observation win a publisher URL forever. Prefer the actual last capture
    // observation; stable ties and an unstamped current head retain existing head precedence.
    // Publication dates are not observation times. Raw versions stay in the archive.
    const currentRows = new Set(source);
    const observedAt = row => {
      const time = Date.parse(row.lastSeenAt || row.firstSeenAt || '');
      return Number.isFinite(time) ? time : currentRows.has(row) ? Infinity : -Infinity;
    };
    const value = [...buckets.values()].flatMap(list => dedupeArticles(list.sort((a, b) => observedAt(b) - observedAt(a))))
      .sort((a, b) => String(b.publishedAt || b.date || '').localeCompare(String(a.publishedAt || a.date || '')));
    combined = { source, revision, rows: value };
    return value;
  }
  function loadArchive() {
    if (pending) return pending;
    const generation = epoch;
    pending = (async () => {
      const meta = base.meta();
      const paths = [...new Set([meta.archive?.index, meta.tradingViewArchive?.index].filter(Boolean))];
      let failed = false;
      for (const indexPath of paths) {
        try {
          if (!/^(company-news|tradingview-news)\/index\.json$/.test(indexPath)) throw Error('Invalid news archive index');
          const { value, tag } = await read(`data/${indexPath}`, { key: `news-history:${indexPath}` });
          if (generation !== epoch) return false;
          if (!Array.isArray(value?.archive)) throw Error('News archive index unavailable');
          const stamp = tag || value.updatedAt;
          const previous = indexes.get(indexPath);
          if (previous?.updatedAt && Date.parse(value.updatedAt) < Date.parse(previous.updatedAt)) throw Error('News archive index regressed');
          if (stamp && previous?.stamp === stamp) continue;
          const family = indexPath.split('/')[0];
          const next = new Map(), nextIdentities = new Map();
          for (const entity of value.entities || []) {
            if (entity.entityId) nextIdentities.set(entity.entityId, entity);
            if (entity.ticker) nextIdentities.set(entity.ticker, entity);
          }
          // A family revision is adopted only after all its parts are verified. A missing month
          // leaves the previous complete family visible and retryable on the next refresh.
          for (const shard of value.archive) {
            if (!new RegExp(`^${family}/(\\d{4}-\\d{2}|undated)\\.json$`).test(shard.file || '')) throw Error('Invalid news archive month');
            const part = await read(`data/${shard.file}`, { key: `news-history:${shard.file}` });
            if (generation !== epoch) return false;
            if (!Array.isArray(part.value?.articles) || part.value.articles.length !== shard.count) throw Error('News archive month incomplete');
            next.set(shard.file, part.value.articles);
          }
          for (const [path, records] of next) held.set(path, records);
          for (const [key, identity] of nextIdentities) identities.set(key, identity);
          if (stamp) indexes.set(indexPath, { stamp, updatedAt: value.updatedAt });
          revision++;
        } catch { failed = true; }
      }
      if (generation !== epoch) return false;
      loaded = !failed;
      error = failed ? 'Some retained news history could not be verified. Previously loaded records remain visible.' : null;
      return !failed;
    })().finally(() => { if (generation === epoch) { pending = null; emit(); } });
    return pending;
  }
  return { ...base, rows, loadArchive,
    async seed(...args) { await base.seed(...args); initialized = true; await loadArchive(); },
    async load(...args) { await base.load(...args); initialized = true; await loadArchive(); },
    async refreshSnapshot(...args) {
      const result = await base.refreshSnapshot(...args), history = await loadArchive();
      return { ...result, partial: !!result.partial || !history };
    },
    async refresh(...args) {
      const result = await base.refresh(...args), history = await loadArchive();
      return { ...result, partial: !!result.partial || !history };
    },
    forTicker: ticker => rows().filter(row => String(row.ticker || row.entityId || '').toUpperCase() === String(ticker).toUpperCase()),
    wasAskedEmpty: ticker => !rows().some(row => String(row.ticker || row.entityId || '').toUpperCase() === String(ticker).toUpperCase()) && base.wasAskedEmpty(ticker),
    meta() { const meta = base.meta(); return { ...meta, ok: meta.ok && !error,
      rowCount: rows().length, newsHistory: { loaded, pending: !!pending, error } }; },
    onChange(fn) {
      listeners.add(fn);
      const off = base.onChange(() => {
        fn();
        // The inner shared poller also runs without an explicit refresh from this wrapper.
        // Follow those automatic checks so retained history stays live in an open News tab.
        if (initialized && !pending) void loadArchive();
      });
      return () => { listeners.delete(fn); off(); };
    },
    invalidate() { epoch++; base.invalidate(); held = new Map(); identities = new Map(); indexes.clear();
      revision++; combined = null; pending = null; error = null; loaded = false; initialized = false; },
  };
}
