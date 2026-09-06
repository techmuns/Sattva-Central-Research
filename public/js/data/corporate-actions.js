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
  read = null,
  readSaved = () => readEntry(KEYS.corporateActions),
} = {}) {
  let held = [];
  let source = {};
  let loaded = false;
  let loading = null;
  let refreshing = null;
  let restoring = null;
  let generation = 0;
  let lastPayload = null;
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  function validate(payload) {
    if (payload?.version !== 1 || !Array.isArray(payload.rows) || !payload.rows.length ||
      payload.rows.some((row) => !row?.company || !row?.purpose || !row?.id) ||
      (payload.rowCount != null && payload.rowCount !== payload.rows.length)) throw new Error('Invalid corporate actions capture');
    const previousAt = Date.parse(source.capturedAt || '');
    const nextAt = Date.parse(payload.capturedAt || '');
    if (Number.isFinite(previousAt) && (!Number.isFinite(nextAt) || nextAt < previousAt)) throw new Error('Older corporate actions capture');
  }
  const readLatest = read || (() => conditionalJson('data/corporate-actions.json', {
    key: KEYS.corporateActions, optional: true, validate,
  }));

  function absorb(payload, origin, checkedAt) {
    try { validate(payload); } catch { return false; }
    // A 304 (or identical 200) confirms freshness, not a new table. Keep references
    // so the renderer can update its status without replacing focused controls.
    if (payload !== lastPayload) {
      const identical = held.length === payload.rows.length && held.every((row, index) =>
        row === payload.rows[index] || JSON.stringify(row) === JSON.stringify(payload.rows[index]));
      if (!identical) held = payload.rows;
      lastPayload = payload;
    }
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

  function restore() {
    if (!restoring) {
      const mine = generation;
      restoring = safe(readSaved).then((saved) => {
        if (mine !== generation) return;
        if (saved?.value && absorb(saved.value, 'store', saved.savedAt)) {
          loaded = true;
          emit();
        }
      });
    }
    return restoring;
  }

  function load() {
    if (loaded) return Promise.resolve({ rows: held, meta: meta() });
    if (!loading) {
      const check = refresh();
      const pending = (async () => {
        await restore();
        // A usable retained capture is ready now. Only a true cache miss waits
        // for the network; background revalidation still publishes new records.
        if (!loaded) await check;
        return { rows: held, meta: meta() };
      })();
      loading = pending;
      void pending.finally(() => { if (loading === pending) loading = null; }).catch(() => {});
    }
    return loading;
  }

  function refresh() {
    if (refreshing) return refreshing;
    const mine = generation;
    const pending = (async () => {
      await restore();
      if (mine !== generation) return { skipped: true };
      if (loaded) emit();
      const before = new Set(held.map((row) => row.id));
      const result = await safe(readLatest);
      if (mine !== generation) return { skipped: true };
      const confirmed = !!(result && [200, 304].includes(result.status) && absorb(result.value, 'live', result.checkedAt || now()));
      if (!confirmed) source = { ...source, attemptedAt: now(), degraded: 'The latest capture could not be confirmed; showing the retained copy.' };
      loaded = true;
      if (!held.length) source = { ...source, reason: 'unreachable' };
      return { added: held.filter((row) => !before.has(row.id)).length, total: held.length, checked: confirmed ? 1 : 0, failed: confirmed ? 0 : 1 };
    })();
    refreshing = pending;
    void pending.finally(() => {
      if (refreshing !== pending) return;
      refreshing = null;
      emit();
    }).catch(() => {});
    return refreshing;
  }

  const meta = () => ({ ...source, checking: !!refreshing, kind: 'corporate-actions', count: held.length, coversUniverse: true, windowDays: null });
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
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: refresh });
      live.start(LIVE_ID);
    },
    stopLive: (live) => live.stop(LIVE_ID),
    invalidate: () => {
      generation += 1;
      held = []; source = {}; loaded = false; loading = null; refreshing = null; restoring = null; lastPayload = null;
    },
  };
}

export const corporateActions = createCorporateActionsFeed();
export const { load, refresh, rows, all, meta, isLoaded, rowKey, filterByScope, onChange, startLive, stopLive, invalidate } = corporateActions;
