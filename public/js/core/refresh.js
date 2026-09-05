// core/refresh.js — the registry behind the header's Refresh button, for feeds that are NOT polled.
//
//   const off = refresh.register('news', { label: 'News', refresh: () => feed.refresh() });
//   const { announced, results } = await refresh.refreshAll();
//   refresh.onChange(fn)          fires when a registration is added, removed or finishes
//
// WHY THIS EXISTS SEPARATELY FROM `core/live.js`
//   `live.js` is a poller: it owns an interval, a backoff and a visibility rule, and `refreshAll()`
//   there ticks whatever is currently running. That is exactly right for the two feeds that SHOULD
//   poll — the results feed and the con-call scan are conditional GETs whose unchanged tick is a
//   bodyless 304, and both drive the alert stack, which is only worth having if it fires while the
//   reader is on another tab.
//
//   It is exactly wrong for News, Corporate Announcements, Insider Trades and Superstar Investors.
//   Those are **one request per company**, and there is no cheap tick: a walk of forty companies is
//   forty round trips against somebody else's rate-limited service, and ninety-one for the investor
//   books. A feed like that must not run on a page load at all — it is work the reader has to ask
//   for, which is what this registry models.
//
// THE CONTRACT
//   `refresh()` returns `{ added, checked }` — how many rows arrived and how many companies were
//   asked about — or throws. It is called ONLY from the header button (or a control the reader
//   clicks), never on a timer, never on a route change, never on a repaint.
//
// AND WHAT REPLACES THE AUTOMATIC WALK: the committed snapshot, revalidated with one conditional
// GET on load. That is what "new data arrives on its own" means for these feeds — a scheduled job
// captures it and the browser picks the file up for free. Anything newer than the last capture is
// what the button is for, and the tab says so rather than leaving the reader to guess.

const entries = new Map();
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => { try { fn(); } catch (err) { console.warn('[refresh] subscriber failed', err); } });

export function register(id, { label, refresh }) {
  if (typeof refresh !== 'function') throw new TypeError(`refresh.register("${id}") needs a refresh function`);
  const entry = { id, label: label || id, refresh, lastResult: null, lastAt: null, running: false, pending: null };
  entries.set(id, entry);
  emit();
  return () => {
    // Disposing an old mount must not unregister its replacement.
    if (entries.get(id) === entry) { entries.delete(id); emit(); }
  };
}

export const registered = () => [...entries.values()].map(({ id, label, lastResult, lastAt, running }) => ({ id, label, lastResult, lastAt, running }));
export function onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
/** Last wholly successful check; a failed attempt cannot advance it. */
export const lastRefreshAt = (id) => entries.get(id)?.lastAt ?? null;
export const isRunning = (id) => entries.get(id)?.running === true;

function run(entry) {
  if (entry.pending) return entry.pending;
  entry.running = true;
  entry.pending = Promise.resolve().then(() => entry.refresh()).then((out) => {
    const result = { id: entry.id, label: entry.label, added: 0, checked: 0, failed: 0, ...(!out ? { skipped: true } : out) };
    entry.lastResult = result;
    if (!result.error && !result.failed && !result.partial && !result.pending && !result.skipped) entry.lastAt = Date.now();
    return result;
  }, (err) => {
    const result = { id: entry.id, label: entry.label, added: 0, checked: 0, failed: 1, error: String(err?.message || err) };
    entry.lastResult = result;
    return result;
  }).finally(() => { entry.running = false; entry.pending = null; emit(); });
  emit();
  return entry.pending;
}

/** Join existing work, including work started by a tab-local control. */
export function refreshOne(id) {
  const entry = entries.get(id);
  return entry ? run(entry) : Promise.resolve({ id, skipped: true });
}

/** Capture the mounted callbacks now; late results cannot select another tab's work. */
export function refreshAll() {
  const due = [...entries.values()];
  return Promise.all(due.map(run)).then((results) => ({
    announced: results.reduce((sum, result) => sum + (result.added || 0), 0), results, skipped: 0,
  }));
}

/** Result vocabulary shared by the header and tab controls. Captures are dated,
 * so a successful read never promises that every publisher has been checked live. */
export function summarize(results = []) {
  const failed = results.filter((r) => r.error || r.failed).length;
  const partial = !results.length || results.some((r) => r.partial || r.truncated || r.skipped);
  const pending = results.some((r) => r.pending);
  const announced = results.reduce((sum, r) => sum + (r.added || 0), 0);
  const checked = results.reduce((sum, r) => sum + (r.checked || 0), 0);
  return { results, failed, partial, pending, announced, checked };
}

export function resultLabel({ failed = 0, partial = false, pending = false, announced = 0, checked = 0 } = {}) {
  if (pending) return 'Still updating…';
  if (failed) return checked || announced ? 'Partly refreshed' : 'Couldn’t refresh';
  if (partial) return 'Partly refreshed';
  return announced ? `${announced} new` : 'Latest available';
}
