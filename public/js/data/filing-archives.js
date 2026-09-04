import { capturedJson } from './company-captures.js';
import { mergeAnnouncements } from './announcements-shared.js';
import { mergeInsiderTrades, mergeInsiderHeaders } from './insider-history.js';

export function withFilingArchive(base, kind) {
  let rows = [], error = null, pending = false, loaded = false;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  const merge = kind === 'insider' ? mergeInsiderTrades : mergeAnnouncements;
  const combined = () => merge(base.rows(), rows);
  return {
    ...base, rows: combined,
    forTicker: (ticker) => combined().filter((row) => row.ticker === String(ticker).toUpperCase()),
    meta() {
      const meta = base.meta();
      return { ...meta, baseRowCount: meta.baseRowCount ?? meta.rowCount, rowCount: combined().length,
        headers: kind === 'insider' ? mergeInsiderHeaders(meta.headers || [], rows.flatMap((r) => Object.keys(r.cells || {}))) : meta.headers,
        archive: { loaded, pending, error, rows: rows.length } };
    },
    async loadArchive() {
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
            try {
              const part = await capturedJson(`data/${kind}-archive/${month}.json`);
              if (!Array.isArray(part.value?.rows)) throw new Error('Unrecognized archive');
              rows = merge(rows, part.value.rows); stale ||= part.stale;
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
    invalidate() { base.invalidate(); rows = []; error = null; loaded = false; },
  };
}
