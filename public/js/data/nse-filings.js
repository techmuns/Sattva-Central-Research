// NSE's latest window + retained captures. Search never loses yesterday on a successful poll.
import { conditionalJson, revalidatedJson, readEntry, writeEntry, KEYS } from '../core/store.js';
import { filterByScope } from './scope.js';
import { HISTORY_DAYS, capturedRows, filingKey, firstHistoryDay, inHistoryRange, mergeFilings } from './nse-history-shared.js';

export const LIVE_ID = 'nse-filings';
export const POLL_MS = 90000;
export { HISTORY_DAYS };

// Injected readers let tests exercise reloads, rollovers and failures without production I/O.
export function createNseFeed({
  now = Date.now,
  readLive = () => conditionalJson('api/nse-announcements', { key: KEYS.nseFilings, optional: true }),
  readSnapshot = () => revalidatedJson('data/nse-announcements.json', { optional: true }),
  readIndex = () => revalidatedJson('data/nse-filings/index.json', { optional: true }),
  readDay = (day) => revalidatedJson(`data/nse-filings/${day}.json`, { optional: true }),
  // Migrate the old raw-response cache before the next HTTP 200 replaces its rolling window.
  readSaved = async () => (await readEntry(KEYS.nseFilingsHistory)) || readEntry(KEYS.nseFilings),
  save = (value) => writeEntry(KEYS.nseFilingsHistory, { value }),
} = {}) {
  let held = [];
  let retained = [];
  let source = {};
  let index = null;
  let windowDays = 7;
  let loaded = false;
  let loading = null;
  let refreshing = null;
  let generation = 0;
  let indexFailed = false;
  const loadedDays = new Map();
  const failedDays = new Set();
  const pendingDays = new Map();
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  const safe = async (read) => { try { return await read(); } catch { return null; } };
  const valid = (payload) => payload?.ok !== false && Array.isArray(payload?.rows);
  const from = () => firstHistoryDay(windowDays, now());

  function ingest(payload, origin, checkedAt) {
    if (!valid(payload)) return false;
    const cutoff = firstHistoryDay(90, now());
    retained = mergeFilings(retained, capturedRows(payload)).filter((row) => inHistoryRange(row, cutoff));
    held = mergeFilings(held, capturedRows(payload)).filter((row) => inHistoryRange(row, cutoff));
    const capturedAt = payload.capturedAt || null;
    if (!source.capturedAt || Date.parse(capturedAt || '') >= Date.parse(source.capturedAt)) {
      source = { capturedAt, checkedAt, origin, degraded: payload.degraded || null };
    }
    return true;
  }

  async function readSources(gen) {
    // The snapshot is a history input even when the live route succeeds, not just a fallback.
    const [snapshot, live, archive] = await Promise.all([safe(readSnapshot), safe(readLive), safe(readIndex)]);
    if (gen !== generation) return;
    const snapshotOk = ingest(snapshot, 'snapshot', now());
    const liveOk = live && [200, 304].includes(live.status) && ingest(live.value, 'live', live.checkedAt || now());
    if (!liveOk) source = { ...source, degraded: 'Live NSE feed unavailable; showing retained captures.' };
    indexFailed = !Array.isArray(archive?.days);
    if (!indexFailed) index = archive;
    if (!liveOk && !snapshotOk && !held.length && !index) throw new Error('No NSE filings or captured history could be loaded.');
    await save({ rows: retained, capturedAt: source.capturedAt, degraded: source.degraded });
  }

  async function loadHistory(days = windowDays) {
    windowDays = HISTORY_DAYS.includes(Number(days)) ? Number(days) : 7;
    const gen = generation;
    const needed = (index?.days || []).filter((entry) =>
      /^(\d{4}-\d{2}-\d{2}|undated)$/.test(entry.day) && (entry.day === 'undated' || entry.day >= from()));
    const queue = needed.filter((entry) => !loadedDays.has(entry.day) || loadedDays.get(entry.day) !== entry.revision || failedDays.has(entry.day));
    // At most four archive requests in flight; 90 days must not fan out ninety requests.
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        const requestKey = `${entry.day}:${entry.revision || ''}`;
        let pending = pendingDays.get(requestKey);
        if (!pending) {
          pending = safe(() => readDay(entry.day));
          pendingDays.set(requestKey, pending);
        }
        const payload = await pending;
        if (gen !== generation) return;
        pendingDays.delete(requestKey);
        if (!valid(payload) || (Number.isInteger(entry.count) && payload.rows.length !== entry.count)) {
          failedDays.add(entry.day); continue;
        }
        // Observation timestamps let newer archive corrections win without reverting live ones.
        held = mergeFilings(capturedRows(payload), held);
        loadedDays.set(entry.day, entry.revision);
        failedDays.delete(entry.day);
      }
    }));
    if (gen === generation) emit();
    return rows();
  }

  async function build() {
    const gen = generation;
    const saved = await safe(readSaved);
    if (gen !== generation) return;
    if (saved?.value) ingest(saved.value, 'store', saved.savedAt);
    await readSources(gen);
    if (gen !== generation) return;
    await loadHistory();
    if (gen !== generation) return;
    loaded = true;
    return { rows: rows(), meta: meta() };
  }

  function load() {
    if (loading) return loading;
    if (loaded) return Promise.resolve({ rows: rows(), meta: meta() });
    const pending = build();
    loading = pending;
    void pending.finally(() => { if (loading === pending) loading = null; }).catch(() => {});
    return pending;
  }

  function refresh() {
    if (refreshing) return refreshing;
    const pending = (async () => {
      const gen = generation;
      const before = new Set(held.map(filingKey));
      await readSources(gen);
      if (gen !== generation) return { added: 0, total: 0 };
      await loadHistory();
      if (gen !== generation) return { added: 0, total: 0 };
      return { added: held.filter((row) => !before.has(filingKey(row))).length, total: rows().length };
    })();
    refreshing = pending;
    void pending.finally(() => { if (refreshing === pending) refreshing = null; }).catch(() => {});
    return pending;
  }

  const rows = () => held.filter((row) => inHistoryRange(row, from()));
  function meta() {
    const list = rows();
    const resolved = list.filter((row) => row.ticker).length;
    return {
      ...source, count: list.length, resolved, unresolved: list.length - resolved,
      windowDays, from: from(), archiveDays: index?.days?.length || 0,
      historyUnavailable: indexFailed,
      missingDays: [...failedDays].filter((day) => day === 'undated' || day >= from()),
    };
  }

  return {
    load, refresh, loadHistory, rows, all: rows, meta,
    isLoaded: () => loaded,
    rowKey: filingKey,
    idsHeld: () => new Set(held.map(filingKey)),
    forScope: (scope, holdings = [], list = rows()) => filterByScope(list, scope, holdings),
    onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    startLive: (live) => {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: async () => { await refresh(); return null; } });
      live.start(LIVE_ID);
    },
    stopLive: (live) => live.stop(LIVE_ID),
    invalidate: () => {
      generation++;
      held = []; retained = []; source = {}; index = null; loaded = false; loading = null; refreshing = null;
      loadedDays.clear(); failedDays.clear(); pendingDays.clear(); indexFailed = false;
    },
  };
}

export const { load, refresh, loadHistory, rows, all, meta, isLoaded, rowKey, idsHeld,
  forScope, onChange, startLive, stopLive, invalidate } = createNseFeed();
