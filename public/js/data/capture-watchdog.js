// Demand-driven safety net for committed dashboard captures.
//
// GitHub's `schedule` trigger is best-effort and has been hours late on this repository. The
// dashboard therefore asks one small Worker endpoint for capture timestamps after first paint and
// starts the existing refresh workflow only when a source is outside its real operating window.
// The Worker declines duplicate/in-flight runs and holds a cooldown across readers.

const STATUS_ROUTE = 'api/capture-status';
const REQUEST_TIMEOUT_MS = 12_000;
const WATCH_EVERY_MS = 30_000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const ATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;
const attempts = new Map();
const watchers = new Map();
let checkTimer = null;

const CONFIG = {
  companyNews: {
    route: 'api/company-news/refresh?source=auto',
    run: 'api/company-news/run',
    maxAgeMs: 3 * 60 * 60 * 1000,
    active: ({ hour }) => hour >= 8 && hour < 24,
    budgetMs: 35 * 60 * 1000,
  },
  marketNews: {
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
    active: ({ weekday, hour }) => weekday && hour >= 9 && hour < 23,
    budgetMs: 20 * 60 * 1000,
  },
  insider: {
    route: 'api/insider-snapshot/refresh?source=auto',
    run: 'api/insider-snapshot/run',
    // One complete universe walk after disclosures settle, with on-demand recovery if the cron
    // missed. Before 19:00 yesterday evening's snapshot is the newest complete daily cut.
    due: (capture, clock) => clock.weekday && clock.hour >= 19 && istDay(capture?.capturedAt) !== clock.day,
    budgetMs: 35 * 60 * 1000,
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
      headers: { accept: 'application/json' },
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
  const at = Date.parse(capture?.capturedAt || '');
  return !Number.isFinite(at) || now - at > config.maxAgeMs;
}

async function applyLandedCapture(name) {
  if (name === 'marketNews') {
    const feed = await import('./market-news.js');
    await feed.refresh();
    return;
  }
  if (['companyNews', 'announcements', 'insider'].includes(name)) {
    const feeds = await import('./filings.js');
    const feed = name === 'companyNews' ? feeds.news : feeds[name];
    if (feed?.isLoaded()) await feed.refreshSnapshot();
  }
}

async function watch(name, before, { now = Date.now } = {}) {
  const config = CONFIG[name];
  const startedAt = now();
  while (now() - startedAt < config.budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_EVERY_MS));
    const status = await ask(STATUS_ROUTE);
    const next = status?.captures?.[name]?.capturedAt || null;
    if (next && next !== before) {
      await applyLandedCapture(name);
      return { ok: true, outcome: 'landed', capturedAt: next };
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

/** One bounded check. It never blocks the dashboard and never dispatches a current feed. */
export async function runCaptureWatchdog({ now = Date.now, watchRuns = true } = {}) {
  const status = await ask(STATUS_ROUTE);
  if (status.ok === false || !status.captures) return { ok: false, reason: status.reason || 'unavailable', started: [] };

  const started = [];
  for (const [name, config] of Object.entries(CONFIG)) {
    const capture = status.captures[name];
    const checkedAt = now();
    const lastAttempt = attempts.get(name) || 0;
    if (!refreshDue(name, capture, checkedAt) || checkedAt - lastAttempt < ATTEMPT_COOLDOWN_MS) continue;
    attempts.set(name, checkedAt);

    const dispatch = await ask(config.route, { method: 'POST' });
    started.push({ name, ...dispatch });
    if (watchRuns && dispatch.ok !== false && !watchers.has(name)) {
      const task = watch(name, capture?.capturedAt || null, { now })
        .catch(() => ({ ok: false, outcome: 'failed', reason: 'unreachable' }))
        .then((result) => {
          // A landed capture may legitimately become due later in a long session. Failed attempts
          // keep the cooldown so a broken credential cannot create a busy loop.
          if (result?.outcome === 'landed') attempts.delete(name);
          return result;
        })
        .finally(() => watchers.delete(name));
      watchers.set(name, task);
    }
  }
  return { ok: true, started };
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
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}
