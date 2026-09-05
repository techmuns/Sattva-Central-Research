// Retained NSE + Screener corporate actions. One conditional static read serves every scope;
// adding a portfolio company needs no new upstream request because filtering happens at paint time.

import { conditionalJson, readEntry, KEYS } from '../core/store.js';
import { filterByScope as filterRowsByScope } from './scope.js';
import { corporateActionKey } from './corporate-actions-shared.js';

export const LIVE_ID = 'corporate-actions';
export const POLL_MS = 90_000;

export function filterCorporateActionsByScope(rows, scope, holdings = []) {
  if (scope !== 'portfolio') return filterRowsByScope(rows, scope, holdings);
  const tickers = new Set(holdings.map((holding) => String(holding?.ticker || '').toUpperCase()).filter(Boolean));
  const isins = new Set(holdings.map((holding) => String(holding?.isin || '').toUpperCase()).filter(Boolean));
  return rows.filter((row) => tickers.has(String(row?.ticker || '').toUpperCase()) || isins.has(String(row?.isin || '').toUpperCase()));
}

export function createCorporateActionsFeed({
  now = Date.now,
  read = () => conditionalJson('data/corporate-actions.json', { key: KEYS.corporateActions, optional: true }),
  readSaved = () => readEntry(KEYS.corporateActions),
} = {}) {
  let held = [];
  let source = {};
  let loaded = false;
  let loading = null;
  let refreshing = null;
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  function absorb(payload, origin, checkedAt) {
    if (payload?.version !== 1 || !Array.isArray(payload.rows) || !payload.rows.length) return false;
    held = payload.rows.filter((row) => row?.company && row?.purpose && row?.id);
    if (!held.length) return false;
    source = {
      capturedAt: payload.capturedAt || null,
      checkedAt: checkedAt || null,
      origin,
      requestedFrom: payload.requestedFrom || null,
      requestedTo: payload.requestedTo || null,
      typeCounts: payload.typeCounts || {},
      companyCount: payload.companyCount || new Set(held.map((row) => row.ticker || row.company)).size,
      sources: payload.sources || {},
      sourceCounts: payload.sourceCounts || { nse: held.length, screener: 0, enriched: 0, screenerOnly: 0 },
      crossSourceDuplicates: payload.crossSourceDuplicates || 0,
      reason: null,
      degraded: null,
    };
    return true;
  }

  async function fetchLatest() {
    const result = await safe(read);
    if (result && [200, 304].includes(result.status) && absorb(result.value, 'live', result.checkedAt || now())) return true;
    source = { ...source, checkedAt: now(), degraded: 'The latest capture could not be confirmed; showing the retained copy.' };
    return false;
  }

  async function build() {
    const saved = await safe(readSaved);
    if (saved?.value) absorb(saved.value, 'store', saved.savedAt);
    await fetchLatest();
    loaded = true;
    if (!held.length) source = { ...source, reason: 'unreachable' };
    emit();
    return { rows: held, meta: meta() };
  }

  function load() {
    if (loaded) return Promise.resolve({ rows: held, meta: meta() });
    if (!loading) {
      loading = build();
      void loading.finally(() => { loading = null; }).catch(() => {});
    }
    return loading;
  }

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const before = new Set(held.map(corporateActionKey));
      await fetchLatest();
      loaded = true;
      emit();
      return { added: held.filter((row) => !before.has(corporateActionKey(row))).length, total: held.length };
    })();
    void refreshing.finally(() => { refreshing = null; }).catch(() => {});
    return refreshing;
  }

  const meta = () => ({ ...source, kind: 'corporate-actions', count: held.length, coversUniverse: true, windowDays: null });
  return {
    load, refresh, rows: () => held, all: () => held, meta,
    isLoaded: () => loaded,
    setWanted: () => {},
    wasAskedEmpty: () => false,
    failureFor: () => false,
    rowKey: corporateActionKey,
    filterByScope: filterCorporateActionsByScope,
    onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    startLive: (live) => {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: async () => { await refresh(); return null; } });
      live.start(LIVE_ID);
    },
    stopLive: (live) => live.stop(LIVE_ID),
    invalidate: () => { held = []; source = {}; loaded = false; loading = null; refreshing = null; },
  };
}

export const corporateActions = createCorporateActionsFeed();
export const { load, refresh, rows, all, meta, isLoaded, rowKey, filterByScope, onChange, startLive, stopLive, invalidate } = corporateActions;
