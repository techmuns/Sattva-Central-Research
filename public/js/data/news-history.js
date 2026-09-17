import { conditionalJson } from '../core/store.js';
import { dedupeArticles } from './filings-shared.js';
import { attributeNewsRow } from './company-news-attribution.js';
import { inNewsWindow, newsShardInWindow, newsHeadCoversArchive } from './news-window.js';
import { holdsTicker } from './row-ticker-index.js';
import { runSteps, runStepsInSlices } from '../core/slices.js';

// Equal-shape ISO stamps compare by code point — the same order `localeCompare` gives them, at a
// fraction of the cost; stamps of different shapes keep the locale compare.
const newestFirst = (a, b) => a === b ? 0 : a.length === b.length ? (b > a ? 1 : -1) : b.localeCompare(a);

// Retained monthly records stay available after they leave the recent head. Scope, search and
// attribution still run in their existing consumers; storage partitioning is never a filter.
// The observation instant is parsed once per row object: the sort above asked `Date.parse` on
// every comparison of every rebuild (profiled at 482ms on one rebuild of the combined reader).
// Rows are replaced, never edited; the two stamps are checked on every read regardless.
const yieldToInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));
const observationTimes = new WeakMap();
function observationTime(row) {
  const hit = observationTimes.get(row);
  if (hit && hit.last === row.lastSeenAt && hit.first === row.firstSeenAt) return hit.time;
  const parsed = Date.parse(row.lastSeenAt || row.firstSeenAt || '');
  const time = Number.isFinite(parsed) ? parsed : null;
  observationTimes.set(row, { last: row.lastSeenAt, first: row.firstSeenAt, time });
  return time;
}
export function withNewsHistory(base, { read = conditionalJson, window: readingWindow = () => null } = {}) {
  let held = new Map(), identities = new Map(), revision = 0, combined = null;
  let pending = null, error = null, loaded = false, initialized = false, epoch = 0, aborter = null;
  const indexes = new Map(), listeners = new Set();
  const emit = () => listeners.forEach(fn => fn());
  // THE REBUILD IS ONE GENERATOR, DRIVEN NOW OR IN SLICES. `rows()` must answer synchronously,
  // and a cold rebuild — attributing, bucketing, deduplicating and ordering ninety thousand
  // retained rows — was a 1.3-second task on the first All Alerts open of a session (profiled).
  // The archive loader and `warm()` drive the same generator in ~12ms slices and install the
  // result BEFORE announcing the records, so the synchronous read that follows finds it ready; a
  // read that arrives first still rebuilds in place. Same buckets, same dedupe, same order.
  function* buildRows(source, window) {
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
      const time = observationTime(row);
      return time !== null ? time : currentRows.has(row) ? Infinity : -Infinity;
    };
    const value = [];
    for (const list of buckets.values()) {
      // Each row's observation instant is read once, before the sort, rather than per compare.
      const ordered = list.map(row => [observedAt(row), row]).sort((a, b) => b[0] - a[0]).map(pair => pair[1]);
      for (const row of dedupeArticles(ordered)) if (inNewsWindow(row, window)) value.push(row);
      yield;
    }
    const stamp = row => String(row.publishedAt || row.date || '');
    value.sort((a, b) => newestFirst(stamp(a), stamp(b)));
    return value;
  }
  function rows() {
    const source = base.rows();
    const window = readingWindow(), windowKey = JSON.stringify(window);
    if (combined?.source === source && combined.revision === revision && combined.windowKey === windowKey) return combined.rows;
    const value = runSteps(buildRows(source, window));
    combined = { source, revision, windowKey, rows: value };
    return value;
  }
  // One preparation in flight: a second caller shares it rather than driving a second rebuild.
  let preparing = null;
  function prepareRows(yieldForInput = yieldToInput) {
    if (!preparing) preparing = prepareOnce(yieldForInput).finally(() => { preparing = null; });
    return preparing;
  }
  // A build the source churn abandoned is tried again against the newer state, a few times: a
  // preparation that gives up during a cold load leaves the next synchronous read to rebuild
  // the history in one task, which is exactly what it exists to prevent.
  async function prepareOnce(yieldForInput) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await base.prepareRows?.(yieldForInput);
      const source = base.rows();
      const window = readingWindow(), windowKey = JSON.stringify(window), at = revision, generation = epoch;
      const ready = () => combined?.source === source && combined.revision === at && combined.windowKey === windowKey;
      if (ready()) return;
      // Between slices only this reader's own invariants are checked — asking the reader beneath for
      // its rows can itself be a cold rebuild. The base is compared once, at install.
      const current = () => revision === at && epoch === generation && JSON.stringify(readingWindow()) === windowKey;
      const value = await runStepsInSlices(buildRows(source, window), { yieldForInput, keepGoing: current });
      if (value && current() && base.rows() === source && !ready()) combined = { source, revision: at, windowKey, rows: value };
      if (value || epoch !== generation) return;
    }
  }
  function loadArchive() {
    if (pending) return pending;
    const generation = epoch;
    // A GENERATION CHECK CAN ONLY REFUSE THE NEXT READ; IT CANNOT RECALL THE ONE IN FLIGHT.
    // These are whole month files — the retained TradingView months are 80KB to 790KB each and
    // none of them is sharded — so an archive load running when the reader is torn down goes on
    // to finish a request nobody will read. Worse, `read` awaits the device store before it
    // reaches the network, so a release landing in that gap still lets the request go out.
    // The signal reaches fetch itself, which is the only thing that can stop it.
    const controller = new AbortController();
    aborter = controller;
    pending = (async () => {
      // `meta()` beneath reads the readers' rows; prepare them in slices first so a cold seed does
      // not rebuild every union in one task here.
      try { await base.prepareRows?.(yieldToInput); } catch { /* The synchronous read still answers. */ }
      if (generation !== epoch) return false;
      const meta = base.meta();
      const window = readingWindow(), windowKey = JSON.stringify(window);
      const paths = [...new Set([meta.archive?.index, meta.tradingViewArchive?.index].filter(Boolean))];
      let failed = false;
      for (const indexPath of paths) {
        try {
          if (!/^(company-news|tradingview-news)\/index\.json$/.test(indexPath)) throw Error('Invalid news archive index');
          const { value, tag, queryRevision = null } = await read(`data/${indexPath}`, { key: `news-history:${indexPath}`, signal: controller.signal });
          if (generation !== epoch) return false;
          if (!Array.isArray(value?.archive)) throw Error('News archive index unavailable');
          const stamp = tag || value.updatedAt;
          const previous = indexes.get(indexPath);
          if (previous?.updatedAt && Date.parse(value.updatedAt) < Date.parse(previous.updatedAt)) throw Error('News archive index regressed');
          const coveredByHead = indexPath === 'company-news/index.json' && newsHeadCoversArchive(meta, value, window);
          if (stamp && previous?.stamp === stamp && previous.windowKey === windowKey && previous.coveredByHead === coveredByHead && previous.queryRevision === queryRevision) continue;
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
            if (coveredByHead || !newsShardInWindow(shard, window)) continue;
            const part = await read(`data/${shard.file}`, { key: `news-history:${shard.file}`, signal: controller.signal });
            if (generation !== epoch) return false;
            if (!Array.isArray(part.value?.articles) || (part.value.querySourceCount ?? part.value.articles.length) !== shard.count) throw Error('News archive month incomplete');
            next.set(shard.file, part.value.articles);
          }
          // Warm before install: once these records are in `held`, the first `rows()` is whoever
          // asks first — the source beacon's poller as easily as the tab — and a cold rebuild
          // attributed ninety thousand rows in one task. Under the identities the rebuild will
          // use; every held month too when the index moved an identity object.
          const merged = new Map(identities);
          for (const [key, identity] of nextIdentities) merged.set(key, identity);
          const identityMoved = [...nextIdentities].some(([key, identity]) => identities.get(key) !== identity);
          const lists = [...next.values(), ...(identityMoved ? [...held].filter(([path]) => !next.has(path)).map(([, records]) => records) : [])];
          let started = performance.now();
          for (const list of lists) for (const row of list) {
            attributeNewsRow(row, merged.get(row.entityId) || merged.get(row.ticker) || row);
            if (performance.now() - started >= 12) { await yieldToInput(); started = performance.now(); if (generation !== epoch) return false; }
          }
          for (const [path, records] of next) held.set(path, records);
          for (const [key, identity] of nextIdentities) identities.set(key, identity);
          if (stamp) indexes.set(indexPath, { stamp, updatedAt: value.updatedAt, windowKey, coveredByHead, queryRevision });
          revision++;
        } catch { failed = true; }
      }
      // The rebuilt reading is installed before the announcement below; see `buildRows`.
      try { await prepareRows(yieldToInput); } catch { /* The synchronous read still answers. */ }
      if (generation !== epoch) return false;
      loaded = !failed;
      error = failed ? 'Some retained news history could not be verified. Previously loaded records remain visible.' : null;
      return !failed;
    })().finally(() => { if (generation === epoch) { pending = null; emit(); } });
    return pending;
  }
  return { ...base, rows, loadArchive, prepareRows,
    // Warm the readings `rows()` will hit — the readers beneath, then every retained archive row
    // under its index identity — in ~12ms slices. The synchronous rebuild then pays for the
    // dedupe and the sort, not for attributing ninety thousand rows in one task.
    async warm(yieldForInput = () => Promise.resolve()) {
      await base.warm?.(yieldForInput);
      let started = performance.now();
      for (const list of held.values()) for (const row of list) {
        attributeNewsRow(row, identities.get(row.entityId) || identities.get(row.ticker) || row);
        if (performance.now() - started >= 12) { await yieldForInput(); started = performance.now(); }
      }
      await prepareRows(yieldForInput);
    },
    // Another view may have loaded the shared company head without initializing this reader's
    // publisher/TradingView sources. A head alone cannot make this reader skip its own load.
    isLoaded: () => initialized && base.isLoaded(),
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
    // Set membership, not a scan: see js/data/row-ticker-index.js. `base.wasAskedEmpty` still
    // decides whether the company was actually checked — this only answers whether we hold a row.
    wasAskedEmpty: ticker => !holdsTicker(rows(), ticker) && base.wasAskedEmpty(ticker),
    meta() { const meta = base.meta(); return { ...meta, ok: meta.ok && !error,
      rowCount: rows().length, newsHistory: { loaded, pending: !!pending, error, window: readingWindow() } }; },
    onChange(fn) {
      listeners.add(fn);
      const off = base.onChange(() => {
        // Relayed after this reader's rows are prepared in slices, so the subscriber's first
        // synchronous read finds them ready; the rows themselves are current whenever read.
        prepareRows().catch(() => {}).then(fn);
        // The inner shared poller also runs without an explicit refresh from this wrapper.
        // Follow those automatic checks so retained history stays live in an open News tab.
        if (initialized && !pending) void loadArchive();
      });
      return () => { listeners.delete(fn); off(); };
    },
    invalidate() { epoch++; aborter?.abort(); aborter = null; base.invalidate(); held = new Map(); identities = new Map(); indexes.clear();
      revision++; combined = null; pending = null; error = null; loaded = false; initialized = false; },
    dispose() { epoch++; aborter?.abort(); aborter = null; initialized = false; pending = null;
      base.dispose?.(); held.clear(); identities.clear(); indexes.clear(); listeners.clear(); combined = null; },
  };
}
