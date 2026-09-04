import { readEntry, writeEntry, KEYS } from '../core/store.js';
import { authHeaders } from '../core/host-context.js';
import { capturedJson, capturedCompany, loadCompanyCaptureIndex, companyCaptureStatus } from './company-captures.js';
import { announcementRange, announcementUrl, mergeAnnouncements } from './announcements-shared.js';

/** Additional company lookups share the table, never the exchange-wide snapshot's coverage claim. */
export function withAnnouncementLookups(base) {
  let restored = null;
  let history = [];
  const queries = new Map(), pending = new Map(), subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  let lastQuery = null;
  let shared = [], sharedError = null, sharedPending = false, sharedLoaded = false;
  async function loadShared() {
    await loadCompanyCaptureIndex();
    try {
      const result = await capturedJson('data/filing-capture/announcements-recent.json');
      if (!Array.isArray(result.value?.rows)) throw new Error('Additional shared announcements have an unfamiliar format.');
      shared = mergeAnnouncements(shared, result.value.rows);
      sharedError = result.stale ? 'Showing saved additional announcements; shared capture could not be checked.' : null;
    } catch (error) { sharedError = error.message; }
  }
  const save = () => writeEntry(KEYS.announcementLookups, { value: { rows: history, queries: [...queries], lastQuery } });
  function restore() {
    if (!restored) restored = (async () => {
      const saved = (await readEntry(KEYS.announcementLookups))?.value;
      if (!saved) return;
      history = (Array.isArray(saved.rows) ? saved.rows : []).map((r) => ({ ...r, url: announcementUrl(r.url) }));
      for (const [key, query] of saved.queries || []) queries.set(key, query);
      lastQuery = saved.lastQuery || null;
    })();
    return restored;
  }
  const rows = () => mergeAnnouncements(base.rows().map((r) => ({ ...r, source: r.source || 'BSE', sources: r.sources || [r.source || 'BSE'], providers: ['BSE date index'] })), shared, history);
  function lookupMeta() {
    return { lookups: queries.size, companies: new Set([...queries.values()].map((q) => q.ticker)).size,
      rows: history.length, pending: pending.size, failed: [...queries.values()].filter((q) => q.error).length,
      last: lastQuery ? queries.get(lastQuery) || null : null, queries: [...queries.values()] };
  }
  async function lookup({ ticker, fromDate, toDate, name = null }) {
    const t = String(ticker || '').trim().toUpperCase();
    if (!/^[A-Z0-9&._-]{1,80}$/.test(t)) throw new Error('Choose a valid company ticker.');
    const range = announcementRange(fromDate, toDate);
    await restore();
    const key = `${t}|${range.from}|${range.to}`;
    if (pending.has(key)) return pending.get(key);
    lastQuery = key;
    const task = Promise.resolve().then(async () => {
      const previous = queries.get(key);
      const query = { ...previous, ticker: t, name, from: range.from, to: range.to, error: null };
      queries.set(key, query);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const path = `api/announcements/${encodeURIComponent(t)}?from=${range.from}&to=${range.to}`;
        const response = await fetch(path, { headers: { accept: 'application/json', ...authHeaders(path) }, cache: 'no-cache', signal: controller.signal });
        let body;
        try { body = await response.json(); } catch { throw new Error('This origin could not return the announcements feed.'); }
        if (!response.ok || body?.ok !== true) throw new Error(body?.message || 'The announcements service could not be read.');
        if (!Array.isArray(body.announcements)) throw new Error('The announcements service returned an unfamiliar response.');
        const incoming = body.announcements.map(({ raw, ...r }) => ({ ...r, ticker: t, company: r.company || name || null, url: announcementUrl(r.url), providers: ['Muns corporate announcements'] }));
        const before = history.length;
        history = mergeAnnouncements(history, incoming);
        Object.assign(query, { fetchedAt: body.fetchedAt || null, count: incoming.length, added: history.length - before, skipped: body.skipped || 0, groups: body.groups || [] });
      } catch (error) {
        query.error = error.name === 'AbortError' ? 'The announcements request timed out.' : error.message;
      } finally {
        clearTimeout(timer);
        pending.delete(key);
        await save();
        emit();
      }
      return query;
    });
    pending.set(key, task);
    emit();
    return task;
  }
  return {
    ...base, rows,
    forTicker: (ticker) => rows().filter((row) => row.ticker === String(ticker).toUpperCase()),
    meta() {
      const m = base.meta(), combined = rows();
      return { ...m, baseRowCount: m.baseRowCount ?? m.rowCount, baseCovered: m.covered,
        covered: new Set(combined.map((r) => r.ticker)).size, rowCount: combined.length, supplement: lookupMeta(), sharedError,
        archive: { ...m.archive, pending: m.archive?.pending || sharedPending, loaded: m.archive?.loaded && sharedLoaded,
          error: m.archive?.error || sharedError } };
    },
    async seed() { await Promise.all([base.seed(), restore(), loadShared()]); emit(); },
    async load(...args) { await Promise.all([base.load(...args), restore(), loadShared()]); emit(); },
    async refreshSnapshot() { await Promise.all([base.refreshSnapshot(), loadShared()]); emit(); },
    async loadArchive() {
      if (sharedPending) return;
      sharedPending = true; sharedError = null; emit();
      await loadCompanyCaptureIndex();
      const queue = Object.keys(companyCaptureStatus('announcements').entries);
      const failed = [];
      await Promise.all([base.loadArchive?.(), ...Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const ticker = queue.shift();
          const entry = companyCaptureStatus('announcements').entries[ticker];
          if (!entry.rowCount) continue;
          try {
            const result = await capturedCompany('announcements', ticker);
            shared = mergeAnnouncements(shared, result.value.rows);
            if (result.stale) failed.push(ticker);
          } catch { failed.push(ticker); }
        }
      })]);
      sharedLoaded = companyCaptureStatus('announcements').available && !failed.length;
      sharedError = failed.length ? `Additional company history could not be checked for: ${failed.join(', ')}.` : !sharedLoaded ? 'Additional company history has not been published yet.' : null;
      sharedPending = false; emit();
    },
    lookup, lookupMeta,
    // The normal Refresh remains the inexpensive BSE refresh. The company form repeats additional
    // requests explicitly, so a page visit/refresh never turns into a hidden universe walk.
    onChange(fn) {
      subscribers.add(fn);
      const off = base.onChange(fn);
      return () => { subscribers.delete(fn); off(); };
    },
    invalidate() { base.invalidate(); restored = null; history = []; shared = []; sharedLoaded = false; queries.clear(); lastQuery = null; },
  };
}
