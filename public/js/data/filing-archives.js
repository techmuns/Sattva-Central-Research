import * as exchangeDeals from './exchange-deals.js';
import { capturedJson } from './company-captures.js';
import { mergeAnnouncements } from './announcements-shared.js';
import { mergeInsiderTrades, mergeInsiderHeaders } from './insider-history.js';

export function withFilingArchive(base, kind) {
  let rows = [], error = null, pending = false, loaded = false;
  const revisions = new Map();
  const listeners = new Set();
  const emit = () => [...listeners].forEach((fn) => fn());
  const merge = kind === 'insider' ? mergeInsiderTrades : mergeAnnouncements;
  let memo = null;
  const combined = () => {
    const live = base.rows();
    if (memo?.live === live && memo.archive === rows) return memo.value;
    const joined = rows.length ? merge(live, rows) : live;
    const value = kind === 'insider' && rows.length ? exchangeDeals.combined(joined.filter(r => !/^(nse|bse)-(bulk|block)$/.test(r.sourceId || ''))) : joined;
    memo = { live, archive: rows, value };
    return value;
  };
  return {
    ...base, rows: combined,
    forTicker: (ticker) => combined().filter((row) => row.ticker === String(ticker).toUpperCase()),
    meta() {
      const meta = base.meta();
      return { ...meta, baseRowCount: meta.baseRowCount ?? meta.rowCount, rowCount: combined().length,
        headers: kind === 'insider' ? mergeInsiderHeaders(meta.headers || [], rows.flatMap((r) => Object.keys(r.cells || {}))) : meta.headers,
        archive: { loaded, pending, error, rows: rows.length } };
    },
    async loadArchive({ onlyChanged = false } = {}) {
      if (pending) return;
      pending = true; error = null; emit();
      try {
        const result = await capturedJson(`data/${kind}-archive/index.json`);
        if (!result.value?.months || typeof result.value.months !== 'object') throw new Error('Archive index is unavailable.');
        let stale = result.stale;
        const queue = Object.keys(result.value.months).sort().reverse();
        const failures = [];
        await Promise.all(Array.from({ length: 3 }, async () => {
          while (queue.length) {
            const month = queue.shift();
            if (!/^(\d{4}-(0[1-9]|1[0-2])|undated)$/.test(month)) { failures.push(month); continue; }
            const revision = `${result.value.updatedAt || ''}:${result.value.months[month]}`;
            if (onlyChanged && !result.stale && revisions.get(month) === revision) continue;
            try {
              const part = await capturedJson(`data/${kind}-archive/${month}.json`);
              if (!Array.isArray(part.value?.rows)) throw new Error('Unrecognized archive');
              rows = merge(rows, part.value.rows); stale ||= part.stale;
              if (!part.stale) revisions.set(month, revision);
            } catch { failures.push(month); }
          }
        }));
        loaded = !failures.length && !stale;
        if (failures.length) error = `History is incomplete: ${failures.join(', ')} could not be loaded. Existing rows remain.`;
        else if (stale) error = 'Showing saved history; archive freshness could not be checked.';
      } catch (err) { error = err.message; }
      finally { pending = false; emit(); }
    },
    onChange(fn) { listeners.add(fn); const off = base.onChange(fn); return () => { listeners.delete(fn); off(); }; },
    invalidate() { base.invalidate(); rows = []; error = null; loaded = false; revisions.clear(); },
  };
}
