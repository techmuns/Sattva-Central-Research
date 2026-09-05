// Demand-driven safety net for committed dashboard captures.
//
// GitHub's `schedule` trigger is best-effort and has been hours late on this repository. The
// dashboard therefore asks one small Worker endpoint for capture timestamps after first paint and
// starts the existing refresh workflow only when a source is outside its real operating window.
// The Worker declines duplicate/in-flight runs and holds a cooldown across readers.

import { authHeaders } from '../core/host-context.js';

const STATUS_ROUTE = 'api/capture-status';
const REQUEST_TIMEOUT_MS = 12_000;
const WATCH_EVERY_MS = 30_000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const ATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;
const attempts = new Map();
const watchers = new Map();
const dispatches = new Map();
const landedListeners = new Set();
export const onCaptureLanded = (fn) => { landedListeners.add(fn); return () => landedListeners.delete(fn); };
let checkTimer = null;

const CONFIG = {
  companyFilings: {
    route: 'api/insider-snapshot/refresh?source=auto',
    run: 'api/insider-snapshot/run',
    maxAgeMs: 3 * 60 * 60 * 1000,
    active: () => true,
    budgetMs: 70 * 60 * 1000,
  },
  companyNews: {
    route: 'api/company-news/refresh?source=auto',
    run: 'api/company-news/run',
    maxAgeMs: 3 * 60 * 60 * 1000,
    // Portfolio capture runs around the clock. Weekend and overnight stories are still stories;
    // an overdue schedule should recover without waiting for the next market session.
    active: () => true,
    budgetMs: 35 * 60 * 1000,
  },
  marketNews: {
    // The workflow this dispatches reads MONEYCONTROL only, so Moneycontrol's own last-read time is
    // what decides whether it is overdue — not the shared file's, which the RSS job also moves.
    sourceId: 'moneycontrol',
    route: 'api/market-news/refresh?source=auto',
    run: 'api/market-news/run',
    maxAgeMs: 45 * 60 * 1000,
    // The publisher was measured answering automated reads only in this window.
    active: ({ hour, minute }) => (hour > 8 || (hour === 8 && minute >= 30)) && hour < 22,
    budgetMs: 12 * 60 * 1000,
  },
  announcements: {
    route: 'api/announcements-snapshot/refresh?source=auto',
    run: 'api/announcements-snapshot/run',
    maxAgeMs: 75 * 60 * 1000,
    active: () => true,
    budgetMs: 20 * 60 * 1000,
  },
  corporateActions: {
    sourceId: 'screener',
    route: 'api/corporate-actions-snapshot/refresh?source=auto',
    run: 'api/corporate-actions-snapshot/run',
    maxAgeMs: 35 * 60 * 1000,
    active: () => true,
    budgetMs: 30 * 60 * 1000,
  },
  insider: {
    route: 'api/insider-snapshot/refresh?source=auto',
    run: 'api/insider-snapshot/run',
    // Screener's four market-wide lists are cheap incremental page reads after bootstrap. A reader
    // therefore recovers a missed scheduled run by age, rather than waiting for an end-of-day cut.
    active: () => true,
    maxAgeMs: 75 * 60 * 1000,
    budgetMs: 55 * 60 * 1000,
  },
  technicals: {
    route: 'api/data-snapshot/refresh?source=auto',
    run: 'api/data-snapshot/run',
    // The file is previous-session EOD data captured before market. After 07:15 a weekday file
    // should carry today's capture date; weekends correctly retain Friday.
    due: (capture, clock) => clock.weekday && (clock.hour > 7 || (clock.hour === 7 && clock.minute >= 15)) && istDay(capture?.capturedAt) !== clock.day,
    budgetMs: 70 * 60 * 1000,
  },
};

export function istDay(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return get('year') && get('month') && get('day') ? `${get('year')}-${get('month')}-${get('day')}` : null;
}

function istClock(value = Date.now()) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: !['Sat', 'Sun'].includes(get('weekday')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

async function ask(path, { method = 'GET' } = {}) {
  try {
    const response = await fetch(path, {
      method,
      headers: { accept: 'application/json', ...authHeaders(path) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const type = response.headers.get('content-type') || '';
    if ([404, 405, 501].includes(response.status) || !/json/i.test(type)) return { ok: false, reason: 'no-worker' };
    if (!response.ok) return { ok: false, reason: 'upstream', status: response.status };
    return await response.json();
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

export function refreshDue(name, capture, now = Date.now()) {
  const config = CONFIG[name];
  if (!config) return false;
  const clock = istClock(now);
  if (config.due) return config.due(capture, clock);
  if (config.active && !config.active(clock)) return false;
  const at = Date.parse(freshnessOf(name, capture) || '');
  return !Number.isFinite(at) || now - at > config.maxAgeMs;
}

/**
 * WHICH TIMESTAMP DECIDES WHETHER A SOURCE IS OVERDUE.
 *
 * Normally the capture's own. But the market-news file is written by two jobs — the Moneycontrol
 * listing walk and the hourly RSS reader — and its top-level `capturedAt` is whichever ran last.
 * Reading that would mean an RSS run keeps the timestamp fresh while Moneycontrol goes unread for
 * days, and the watchdog that exists to catch exactly that never fires: the measurement would be
 * answered by a different source than the one it dispatches for. So where the status reports a
 * per-source time, the one belonging to the workflow this config dispatches is what counts.
 *
 * A capture with no per-source detail falls back to the whole file's time, which is what every
 * single-source feed here has always used and is still right for them.
 */
export function freshnessOf(name, capture) {
  const owner = CONFIG[name]?.sourceId;
  const mine = owner ? capture?.sources?.[owner]?.capturedAt : null;
  if (owner && capture?.sources && Object.hasOwn(capture.sources, owner)) return mine || null;
  return capture?.capturedAt || null;
}

async function applyLandedCapture(name, expected) {
  const matches = (actual) => Number.isFinite(Date.parse(actual || '')) && Date.parse(actual) >= Date.parse(expected);
  if (name === 'technicals') {
    const feed = await import('./technicals.js');
    if (!feed.isLoaded()) return true;
    await feed.refresh();
    return matches(feed.meta()?.generated_at);
  }
  if (name === 'corporateActions') {
    const feed = await import('./corporate-actions.js');
    if (!feed.isLoaded()) return true;
    const out = await feed.refresh();
    return !out.failed && matches(feed.meta().sources?.screener?.capturedAt || feed.meta().capturedAt);
  }
  if (name === 'companyFilings') {
    const capture = await import('./company-captures.js');
    await capture.loadCompanyCaptureIndex({ force: true });
    const { announcements } = await import('./filings.js');
    if (announcements.isLoaded()) await announcements.refreshSnapshot();
    return true;
  }
  if (name === 'marketNews') {
    const feed = await import('./market-news.js');
    const out = await feed.refresh();
    const own = feed.meta().sources?.find((source) => source.id === 'moneycontrol');
    return !out.failed && matches(own?.capturedAt || out.capturedAt);
  }
  if (['companyNews', 'announcements', 'insider'].includes(name)) {
    const feeds = await import('./filings.js');
    const feed = name === 'companyNews' ? feeds.news : feeds[name];
    if (!feed?.isLoaded()) return true;
    const out = await feed.refreshSnapshot();
    return out.available && matches(out.capturedAt);
  }
}

async function watch(name, before, { now = Date.now } = {}) {
  const config = CONFIG[name];
  const startedAt = now();
  while (now() - startedAt < config.budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_EVERY_MS));
    const status = await ask(STATUS_ROUTE);
    const next = freshnessOf(name, status?.captures?.[name]);
    if (next && (!before || Date.parse(next) > Date.parse(before))) {
      if (!await applyLandedCapture(name, next)) continue;
      const capture = status.captures[name];
      return { ok: true, outcome: 'landed', capturedAt: next, partial: !!(capture.failed || capture.fallback || (config.sourceId && capture.sources?.[config.sourceId]?.ok === false)) };
    }

    const run = await ask(config.run);
    if (run.ok === false && ['no-worker', 'no-token', 'no-repo', 'unauthorised', 'forbidden'].includes(run.reason)) {
      return { ok: false, outcome: 'not-started', reason: run.reason };
    }
    if (run.scrape?.status === 'completed' && run.scrape?.conclusion && run.scrape.conclusion !== 'success') {
      return { ok: false, outcome: 'failed', reason: run.scrape.conclusion };
    }
  }
  return { ok: false, outcome: 'timed-out' };
}

function dispatchCapture(route, source) {
  if (dispatches.has(route)) return dispatches.get(route);
  const task = ask(route.replace('source=auto', `source=${source}`), { method: 'POST' })
    .finally(() => dispatches.delete(route));
  dispatches.set(route, task);
  return task;
}

/** One bounded check. It never blocks the dashboard and never dispatches a current feed. */
export async function runCaptureWatchdog({ now = Date.now, watchRuns = true, names = null, source = 'auto' } = {}) {
  const status = await ask(STATUS_ROUTE);
  if (status.ok === false || !status.captures) return { ok: false, reason: status.reason || 'unavailable', started: [] };

  const started = [];
  const dispatchedRoutes = new Map();
  for (const [name, config] of Object.entries(CONFIG)) {
    if (names && !names.includes(name)) continue;
    const capture = status.captures[name];
    const checkedAt = now();
    const lastAttempt = attempts.get(name) || 0;
    // A deliberate click can request a more recent capture, subject to the
    // Worker's existing cooldown. EOD technicals keep their session-based rule.
    const manualDue = source === 'button' && name !== 'technicals' &&
      (!freshnessOf(name, capture) || checkedAt - Date.parse(freshnessOf(name, capture)) > 5 * 60 * 1000);
    if (!(manualDue || refreshDue(name, capture, checkedAt)) || watchers.has(name) ||
        (source !== 'button' && checkedAt - lastAttempt < ATTEMPT_COOLDOWN_MS)) continue;
    attempts.set(name, checkedAt);

    const alreadyDispatched = dispatchedRoutes.has(config.route);
    const dispatch = alreadyDispatched ? dispatchedRoutes.get(config.route) : await dispatchCapture(config.route, source);
    dispatchedRoutes.set(config.route, dispatch);
    if (!alreadyDispatched) started.push({ name, ...dispatch });
    // A cooldown can refer to a run whose output is already on screen. There
    // is no new capture to wait for in that case.
    const alreadyLanded = dispatch.reason === 'cooling-down' && dispatch.requestedAt &&
      Date.parse(freshnessOf(name, capture) || '') >= Date.parse(dispatch.requestedAt);
    if (watchRuns && dispatch.ok !== false && !alreadyLanded && !watchers.has(name)) {
      const task = watch(name, freshnessOf(name, capture), { now })
        .catch(() => ({ ok: false, outcome: 'failed', reason: 'unreachable' }))
        .then((result) => {
          // A landed capture may legitimately become due later in a long session. Failed attempts
          // keep the cooldown so a broken credential cannot create a busy loop.
          if (result?.outcome === 'landed') {
            attempts.delete(name);
            for (const fn of landedListeners) { try { fn(name); } catch (err) { console.warn('[capture-watchdog] view update failed', err); } }
          }
          return result;
        })
        .finally(() => watchers.delete(name));
      watchers.set(name, task);
    }
  }
  const pending = [...watchers].filter(([name]) => !names || names.includes(name));
  return { ok: true, started, completion: Promise.all(pending.map(async ([name, task]) => ({ name, ...await task }))) };
}

/** Check immediately and then throughout a long-lived SPA session. */
export function startCaptureWatchdog({ now = Date.now, watchRuns = true } = {}) {
  const check = () => runCaptureWatchdog({ now, watchRuns })
    .catch((error) => console.warn('[capture-watchdog] freshness check failed', error));
  check();
  if (!checkTimer) checkTimer = setInterval(check, CHECK_EVERY_MS);
  return () => {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
  };
}

/** Test seam: a full reload has this effect in production. */
export function resetForTest() {
  attempts.clear();
  watchers.clear();
  dispatches.clear();
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}


/** Only the sources used by the current view; no new job on navigation. */
export function captureNamesForView({ tab, scope, subview, params = {} }) {
  if (params.view === 'filings') return [];
  switch (tab) {
    case 'news': return scope === 'universe' ? ['marketNews'] : ['companyNews'];
    case 'corp-announcements': return ['announcements'];
    case 'corporate-actions': return ['corporateActions'];
    case 'insider-trades': return ['insider'];
    case 'breakouts': return subview === 'earnings-surprise' ? [] : ['technicals'];
    case 'ai-alerts': case 'daily-alerts': case 'ask-research':
      return ['companyNews', 'marketNews', 'announcements', 'insider', 'corporateActions', 'technicals'];
    default: return [];
  }
}
