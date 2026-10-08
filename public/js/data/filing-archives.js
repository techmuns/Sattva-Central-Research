import * as exchangeDeals from './exchange-deals.js';
import { capturedJson } from './company-captures.js';
import { mergeAnnouncements, mergeAnnouncementsAsync } from './announcements-shared.js';
import { mergeInsiderTrades, mergeInsiderHeaders } from './insider-history.js';

export function withFilingArchive(base, kind) {
  let rows = [], error = null, pending = false, loaded = false, generation = 0;
  const revisions = new Map();
  const listeners = new Set();
  const emit = () => [...listeners].forEach((fn) => fn());
  const merge = kind === 'insider' ? mergeInsiderTrades : mergeAnnouncements;

  // THE ARCHIVE MERGE IS MEMOISED ON ITS TWO INPUTS, AND THAT IS THE WHOLE OF THIS BLOCK.
  //
  // `combined()` is this feed's `rows`, so EVERY consumer that reads the feed ran a full merge of
  // the entire retained archive — and `meta()` ran one too, just to report `rowCount`, as did
  // `forTicker`. Merging is not cheap per row: it derives an identity key per row, parses every
  // source URL, and JSON.stringifies eight fields to detect exact duplicates.
  //
  // Measured on the shipped capture at 4x CPU throttle, instrumented in the browser: ONE switch to
  // Corp Announcements called `mergeAnnouncements` 24 times over 227,813 rows in total — to put 42
  // rows on screen. Settling the page called it 148 times over 1,087,952 rows. Every layer above
  // this one (`announcements-extra`, `corporate-announcements`) already memoised on input
  // identity and every one of them missed, because this layer handed each of them a brand-new
  // array on every call. The bottom of the chain decided the cost of the whole chain.
  //
  // Identity comparison is exactly right rather than merely convenient: `rows` is only ever
  // REPLACED (`rows = merge(rows, part.value.rows)` on load, `rows = []` on invalidate), never
  // mutated in place, and `mergeAnnouncements`/`mergeInsiderTrades` only ever mutate rows they
  // themselves created for their own output, never their inputs. So unchanged inputs cannot
  // represent changed data, and a real change always produces a new array and misses the cache.
  // Nothing here retains, hides or drops a row: the same merge of the same inputs is reused.
  let memo = null;
  const combined = () => {
    const base_ = base.rows();
    if (memo && memo.base === base_ && memo.rows === rows) return memo.value;
    const joined = rows.length ? merge(base_, rows) : base_;
    const value = kind === 'insider' && rows.length ? exchangeDeals.combined(joined.filter(r => !/^(nse|bse)-(bulk|block)$/.test(r.sourceId || ''))) : joined;
    memo = { base: base_, rows, value };
    return value;
  };
  let preparing = null;
  function prepareRows() {
    if (preparing) return preparing;
    preparing = (async () => {
      for (;;) {
        await base.warm?.();
        await base.prepareRows?.();
        const source = base.rows(), archive = rows;
        if (memo?.base === source && memo.rows === archive) return;
        const joined = !archive.length ? source : kind === 'announcements'
          ? await mergeAnnouncementsAsync([source, archive]) : merge(source, archive);
        if (source !== base.rows() || archive !== rows) continue;
        const value = kind === 'insider' && archive.length
          ? exchangeDeals.combined(joined.filter(r => !/^(nse|bse)-(bulk|block)$/.test(r.sourceId || ''))) : joined;
        memo = { base: source, rows: archive, value };
        return;
      }
    })().finally(() => { preparing = null; });
    return preparing;
  }
  return {
    ...base, rows: combined, ...(kind === 'announcements' ? { prepareRows } : {}),
    forTicker: (ticker) => combined().filter((row) => row.ticker === String(ticker).toUpperCase()),
    meta() {
      const meta = base.meta();
      return { ...meta, baseRowCount: meta.baseRowCount ?? meta.rowCount, rowCount: combined().length,
        headers: kind === 'insider' ? mergeInsiderHeaders(meta.headers || [], rows.flatMap((r) => Object.keys(r.cells || {}))) : meta.headers,
        archive: { loaded, pending, error, rows: rows.length } };
    },
    async loadArchive({ onlyChanged = false } = {}) {
      if (pending) return;
      const currentGeneration = generation;
      pending = true; error = null; emit();
      try {
        const result = await capturedJson(`data/${kind}-archive/index.json`);
        if (currentGeneration !== generation) return;
        if (!result.value?.months || typeof result.value.months !== 'object') throw new Error('Archive index is unavailable.');
        let stale = result.stale;
        const queue = Object.keys(result.value.months).sort().reverse();
        const failures = [];
        let additions = Promise.resolve();
        await Promise.all(Array.from({ length: 3 }, async () => {
          while (queue.length) {
            const month = queue.shift();
            if (!/^(\d{4}-(0[1-9]|1[0-2])|undated)$/.test(month)) { failures.push(month); continue; }
            const revision = `${result.value.updatedAt || ''}:${result.value.months[month]}`;
            if (onlyChanged && !result.stale && revisions.get(month) === revision) continue;
            try {
              const part = await capturedJson(`data/${kind}-archive/${month}.json`);
              if (currentGeneration !== generation) return;
              if (!Array.isArray(part.value?.rows)) throw new Error('Unrecognized archive');
              // Keep arrival order and serialize publication while allowing input
              // between announcement merge batches. Concurrent downloads cannot
              // overwrite one another's retained rows.
              const addition = additions.then(async () => {
                if (currentGeneration !== generation) return;
                const next = kind === 'announcements' ? await mergeAnnouncementsAsync([rows, part.value.rows]) : merge(rows, part.value.rows);
                if (currentGeneration === generation) rows = next;
              });
              additions = addition.catch(() => {});
              await addition;
              if (currentGeneration !== generation) return;
              stale ||= part.stale;
              if (!part.stale) revisions.set(month, revision);
            } catch { failures.push(month); }
          }
        }));
        if (currentGeneration !== generation) return;
        loaded = !failures.length && !stale;
        if (failures.length) error = `History is incomplete: ${failures.join(', ')} could not be loaded. Existing rows remain.`;
        else if (stale) error = 'Showing saved history; archive freshness could not be checked.';
      } catch (err) { error = err.message; }
      finally { pending = false; emit(); }
    },
    onChange(fn, options) { listeners.add(fn); const off = base.onChange(fn, options); return () => { listeners.delete(fn); off(); }; },
    invalidate() { base.invalidate(); generation++; rows = []; error = null; loaded = false; revisions.clear(); },
  };
}
