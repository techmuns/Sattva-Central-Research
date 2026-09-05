// One additional first-party snapshot, never a TradingView request from the reader's browser.
// Capture and publication are independent of the slow company-name search snapshot.
import { conditionalJson } from '../core/store.js';
import { dedupeArticles } from './filings-shared.js';
import { attributeNewsRow } from './company-news-attribution.js';
import { assessTradingViewCoverage } from './tradingview-news-health.js';

export const NEWS_SNAPSHOT_POLL_MS = 120000;

export function withTradingViewNews(base, { read = conditionalJson, doc = globalThis.document,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let snapshot = null, pending = null, loaded = false, readError = null;
  let timer = null, listening = false, lastAttempt = null, failures = 0, generation = 0;
  const subscribers = new Set();
  const emit = () => subscribers.forEach(fn => fn());
  base.onChange(emit);

  function readSnapshot() {
    if (pending) return pending;
    const epoch = generation;
    pending = (async () => {
      try {
        const { value } = await read('data/tradingview-news/latest.json', { key: 'snapshot:tradingview-news', optional: true });
        if (epoch !== generation) return { available: false };
        const stamp = Date.parse(value?.capturedAt || '');
        if (!Number.isFinite(stamp) || stamp > now() + 600000 || !value?.byTicker || !Array.isArray(value.entities) || !value.tradingViewCoverage)
          throw Error('TradingView published snapshot unavailable or invalid');
        if (snapshot && stamp < Date.parse(snapshot.capturedAt)) throw Error('TradingView published snapshot is older than retained news');
        const changed = !snapshot || stamp > Date.parse(snapshot.capturedAt);
        if (changed) snapshot = value;
        readError = null;
        return { available: true, changed };
      } catch (error) {
        if (epoch === generation) readError = String(error.message || error);
        return { available: false };
      } finally {
        if (epoch === generation) { pending = null; emit(); }
      }
    })();
    return pending;
  }

  function combinedRows() {
    const identities = new Map();
    for (const entity of snapshot?.entities || []) for (const key of [entity.entityId, entity.key, entity.ticker].filter(Boolean))
      identities.set(String(key).toUpperCase(), entity);
    const buckets = new Map();
    const from = new Date(now() - 30 * 86400000).toISOString().slice(0, 10);
    const extras = Object.entries(snapshot?.byTicker || {}).flatMap(([key, list]) => (Array.isArray(list) ? list : [])
      .filter(row => row?.tradingViewId && (!row.date || row.date >= from))
      .map(row => attributeNewsRow(row, identities.get(key.toUpperCase()) || row)));
    const candidates = [...base.rows(), ...extras].sort((a, b) =>
      String(b.lastSeenAt || b.firstSeenAt || '').localeCompare(String(a.lastSeenAt || a.firstSeenAt || '')));
    for (const row of candidates) {
      if (row.tradingViewId && row.date && row.date < from) continue;
      const identity = identities.get(String(row.entityId || row.ticker || '').toUpperCase());
      const key = identity?.entityId || row.entityId || row.ticker || row.company;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    return [...buckets.values()].flatMap(list => {
      const seenIds = new Set();
      return dedupeArticles(list.filter(row => {
        if (!row.tradingViewId) return true;
        if (seenIds.has(row.tradingViewId)) return false;
        seenIds.add(row.tradingViewId); return true;
      }));
    }).sort((a, b) => String(b.publishedAt || b.date || '').localeCompare(String(a.publishedAt || a.date || '')));
  }

  function meta() {
    const m = base.meta(), rows = combinedRows();
    const coverage = snapshot?.tradingViewCoverage || m.tradingViewCoverage;
    return { ...m, rowCount: rows.length, covered: new Set(rows.map(r => r.entityId || r.ticker || r.company)).size,
      origin: rows.some(r => r.tradingViewId) && m.origin === 'live' ? 'mixed' : m.origin,
      tradingViewCoverage: coverage, tradingViewReadError: readError,
      tradingViewHealth: assessTradingViewCoverage(coverage, { now: now() }),
      tradingViewArchive: snapshot?.archive || null };
  }

  async function refreshSnapshot() {
    const [core, extra] = await Promise.all([base.refreshSnapshot(), readSnapshot()]);
    return { ...core, available: core.available || extra.available, changed: core.changed || extra.changed,
      partial: !core.available || !extra.available };
  }

  // A single visibility-aware bulk poller shared by News, All Alerts and AI Alerts. No dispatch,
  // no per-company live walk, and no timer is kept alive once every consumer unsubscribes.
  function pause() { if (timer !== null) cancel(timer); timer = null; }
  function arm() {
    pause();
    if (!doc || doc.hidden || !loaded || !subscribers.size) return;
    const delay = Math.min(NEWS_SNAPSHOT_POLL_MS * 2 ** failures, 600000);
    timer = schedule(async () => {
      timer = null;
      lastAttempt = now();
      try { const result = await refreshSnapshot(); failures = result.partial ? failures + 1 : 0; }
      catch { failures++; }
      finally { emit(); arm(); }
    }, Math.max(0, delay - (lastAttempt == null ? 0 : now() - lastAttempt)));
  }
  const visibility = () => doc.hidden ? pause() : arm();
  function watch() {
    if (!doc || listening || !loaded || !subscribers.size) return;
    listening = true;
    doc.addEventListener('visibilitychange', visibility);
    arm();
  }
  function unwatch() {
    pause();
    if (listening) doc.removeEventListener('visibilitychange', visibility);
    listening = false;
  }
  async function initialize(method, args) {
    await Promise.all([base[method](...args), loaded ? null : readSnapshot()]);
    if (!loaded) { loaded = true; lastAttempt = now(); }
    watch();
  }
  return { ...base, rows: combinedRows, meta, refreshSnapshot,
    seed: (...args) => initialize('seed', args), load: (...args) => initialize('load', args),
    async refresh(...args) {
      const [result] = await Promise.all([base.refresh(...args), readSnapshot()]);
      return { ...result, partial: !!result.partial || !!readError };
    },
    forTicker: ticker => combinedRows().filter(r => String(r.ticker || r.entityId || '').toUpperCase() === String(ticker).toUpperCase()),
    wasAskedEmpty: ticker => !combinedRows().some(r => String(r.ticker || r.entityId || '').toUpperCase() === String(ticker).toUpperCase()) && base.wasAskedEmpty(ticker),
    invalidate() {
      generation++; unwatch(); snapshot = null; pending = null; loaded = false; readError = null;
      lastAttempt = null; failures = 0; base.invalidate();
    },
    onChange(fn) {
      subscribers.add(fn); watch();
      return () => { subscribers.delete(fn); if (!subscribers.size) unwatch(); };
    },
  };
}
