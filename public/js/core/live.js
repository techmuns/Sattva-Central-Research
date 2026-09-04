// core/live.js — small pub/sub polling engine so tabs can "just subscribe" to live data.
//
//   live.register('earnings-feed', { intervalMs: 15000, fetcher: live.mockFetcher('data/mock/earnings.json') });
//   const unsubscribe = live.subscribe('earnings-feed', (rows) => { ...render... });
//   live.start('earnings-feed');   // call from a tab's render()
//   live.stop('earnings-feed');    // call from that tab's destroy()
//
// Pollers only tick while both `start()` has been called (their tab is mounted) AND the
// document is visible. They pause while hidden and resume the remaining cadence when visible;
// only an overdue source refetches immediately. A failed fetch never throws into the UI: it
// logs, backs off, and keeps the last good data on screen.

import { authHeaders } from './host-context.js';

const pollers = new Map(); // id -> poller record
let lastGlobalTick = null;
// The last tick of a poller that actually ASKED A SERVER SOMETHING. The heartbeat exists only to
// keep the header pill ticking and its "fetcher" returns Date.now() without a request, so counting
// it here would let the pill say "updated just now" on the strength of nothing at all. Freshness
// has to be a claim about data.
let lastDataTick = null;
const globalTickListeners = new Set();

function makeRecord(id, { intervalMs, fetcher, synthetic }) {
  return {
    id,
    intervalMs,
    fetcher,
    synthetic: !!synthetic,
    timer: null,
    running: false, // start() called (tab mounted)
    inFlight: false,
    errorCount: 0,
    lastData: null,
    lastTick: null,
    lastAttemptAt: null,
    lastError: null,
    listeners: new Set(),
  };
}

// Register (or update) a poller. Safe to call again with the same id — e.g. on tab re-render —
// it just refreshes the config without dropping existing subscribers or restarting a live timer.
export function register(id, { intervalMs, fetcher, synthetic = false }) {
  const existing = pollers.get(id);
  if (existing) {
    existing.intervalMs = intervalMs;
    existing.fetcher = fetcher;
    existing.synthetic = !!synthetic;
    return;
  }
  pollers.set(id, makeRecord(id, { intervalMs, fetcher, synthetic }));
}

export function subscribe(id, cb) {
  const poller = pollers.get(id);
  if (!poller) {
    console.warn(`[live] subscribe() before register() for "${id}"`);
    return () => {};
  }
  poller.listeners.add(cb);
  if (poller.lastData !== null) cb(poller.lastData, { error: null });
  return () => unsubscribe(id, cb);
}

export function unsubscribe(id, cb) {
  pollers.get(id)?.listeners.delete(cb);
}

// Begin polling when the owning tab mounts. A source with no known freshness ticks
// immediately; a retained source resumes the rest of its existing cadence.
export function start(id, { fresh = false } = {}) {
  const poller = pollers.get(id);
  if (!poller || poller.running) return;
  poller.running = true;
  // Feed modules call this after their own initial `load()` has completed. Let
  // them seed the cadence without fabricating a global "checked" timestamp or
  // immediately repeating the exact request that just returned.
  if (fresh && poller.lastTick == null && poller.lastAttemptAt == null) poller.lastTick = Date.now();
  // A tab switch is not a freshness event. If this poller completed moments ago,
  // keep that result and resume the remainder of its cadence instead of issuing
  // another request merely because its owner was mounted again.
  if (!document.hidden) scheduleWhenDue(poller);
}

// Stop polling (called when the owning tab unmounts). Leaves subscribers intact.
export function stop(id) {
  const poller = pollers.get(id);
  if (!poller) return;
  poller.running = false;
  clearTimer(poller);
}

export function getLastTick(id) {
  return id ? pollers.get(id)?.lastTick ?? null : lastGlobalTick;
}

/** When a poller last confirmed something with a server. Null until one has. */
export function getLastDataTick() {
  return lastDataTick;
}

// Header "Live" pill hook — fires whenever ANY poller completes a successful fetch.
export function onGlobalTick(cb) {
  globalTickListeners.add(cb);
  return () => globalTickListeners.delete(cb);
}

/**
 * Tick every running poller NOW, and resolve when they have all settled. Behind the header's
 * refresh button.
 *
 * It deliberately does not touch stopped pollers: a poller is stopped because its tab is not
 * mounted, and starting one here would begin polling a feed nothing is showing. The app-wide
 * watchers (`core/watch.js`) keep the feeds that drive notifications running on their own.
 *
 * `tick()` reschedules in its own `finally`, so a poller that was mid-interval when this ran comes
 * back on its normal cadence rather than drifting or stopping.
 */
export function refreshAll() {
  const due = [...pollers.values()].filter((p) => p.running && !p.synthetic);
  return Promise.all(due.map((p) => tick(p).catch(() => {})));
}

function clearTimer(poller) {
  if (poller.timer) {
    clearTimeout(poller.timer);
    poller.timer = null;
  }
}

function scheduleTick(poller, delay) {
  clearTimer(poller);
  poller.timer = setTimeout(() => tick(poller), delay);
}

/** Time left in the current success cadence or error backoff. */
function dueIn(poller) {
  const interval = poller.errorCount > 0
    ? Math.min(poller.intervalMs * 2 ** poller.errorCount, 60000)
    : poller.intervalMs;
  const since = poller.errorCount > 0 ? poller.lastAttemptAt : poller.lastTick;
  if (since == null) return 0;
  return Math.max(0, interval - (Date.now() - since));
}

function scheduleWhenDue(poller) {
  scheduleTick(poller, dueIn(poller));
}

async function tick(poller) {
  if (!poller.running || document.hidden || poller.inFlight) return;
  poller.inFlight = true;
  poller.lastAttemptAt = Date.now();
  try {
    const data = await poller.fetcher();
    poller.inFlight = false;
    poller.errorCount = 0;
    poller.lastError = null;
    poller.lastData = data;
    poller.lastTick = Date.now();
    lastGlobalTick = poller.lastTick;
    if (!poller.synthetic) lastDataTick = poller.lastTick;
    for (const cb of poller.listeners) safeNotify(cb, data, null);
    for (const cb of globalTickListeners) safeNotify(cb, lastGlobalTick);
  } catch (err) {
    poller.inFlight = false;
    poller.errorCount += 1;
    poller.lastError = err;
    console.error(`[live] poller "${poller.id}" failed (attempt ${poller.errorCount})`, err);
    // Never throw into the UI — subscribers just keep showing the last good data.
  } finally {
    if (poller.running) {
      const backoff = Math.min(poller.intervalMs * 2 ** poller.errorCount, 60000);
      scheduleTick(poller, poller.errorCount > 0 ? backoff : poller.intervalMs);
    }
  }
}

function safeNotify(cb, ...args) {
  try {
    cb(...args);
  } catch (err) {
    console.error('[live] subscriber threw', err);
  }
}

// Pause every running poller while hidden and resume each source at its actual due time.
document.addEventListener('visibilitychange', () => {
  for (const poller of pollers.values()) {
    if (!poller.running) continue;
    if (document.hidden) clearTimer(poller);
    // Returning from a brief app switch must not make every live source fire at
    // once. A source that is genuinely overdue still gets a zero-delay tick.
    else scheduleWhenDue(poller);
  }
});

// ---- Fetchers -------------------------------------------------------------------------------

const JITTER_SKIP_KEYS = new Set(['id', 'ticker', 'qty', 'quantity', 'year', 'code', 'isin', 'reportDate', 'date', 'timestamp', 'postedAt', 'asOf', 'quarter']);

function jitterDeep(node, amount) {
  if (Array.isArray(node)) return node.map((item) => jitterDeep(item, amount));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = JITTER_SKIP_KEYS.has(key) ? value : jitterDeep(value, amount);
    }
    return out;
  }
  if (typeof node === 'number' && Number.isFinite(node)) {
    const factor = 1 + (Math.random() * 2 - 1) * amount;
    return Math.round(node * factor * 100) / 100;
  }
  return node;
}

// Development fetcher: reads a static mock JSON file and jitters its numbers slightly on every
// poll so the UI visibly "breathes" even though the underlying file never changes on disk.
//
// `no-cache`, not `no-store`. The file on disk never changes, so re-downloading it every tick —
// 232KB for the earnings mock — bought nothing at all: the jitter is applied to the PARSED object
// afterwards, so a revalidated 304 breathes exactly as much as a full download did.
export function mockFetcher(path, { jitter = 0.02 } = {}) {
  return async function fetchMock() {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`mockFetcher: ${path} -> ${res.status}`);
    const data = await res.json();
    return jitterDeep(data, jitter);
  };
}

// Real fetcher path: same signature as mockFetcher, so swapping a
// tab from mock to live data is a one-line change at the call site —
//   live.register('technicals', { intervalMs: 30000, fetcher: live.realFetcher('/api/technicals') })
export function realFetcher(url, options = {}) {
  return async function fetchLive() {
    // The reader's session token is read PER TICK rather than captured when the fetcher was built.
    // A poller registered before the host finished its handshake would otherwise send an
    // unauthenticated request for the life of the page, and a token refreshed on login would never
    // reach the wire. `authHeaders` returns {} off-host and for any non-Munshot address, so this is
    // a no-op on a static origin.
    const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), ...authHeaders(url) } });
    if (!res.ok) throw new Error(`realFetcher: ${url} -> ${res.status}`);
    return res.json();
  };
}
