// app.js — bootstrap: load the JSON data set once, then mount the shell (which starts the
// router and renders the first tab). Every tab reads its slice off `state.data` via ctx.data,
// so there is exactly one fetch pass at startup and pollers handle everything after that.

import { $ } from './core/dom.js';
import { setData, setDataError, setDeferredData } from './core/state.js';
import { revalidatedJson } from './core/store.js';
import { mount } from './ui/shell.js';
import { adaptUniverse } from './data/universe.js';
import { prime as primeEarnings, adaptLegacySummary } from './data/earnings.js';
import { prime as primeFiled } from './data/institution-holdings.js';
import { prime as primePortfolio } from './data/portfolio.js';
import { prime as primeCoverage } from './data/coverage.js';
import { startCaptureWatchdog } from './data/capture-watchdog.js';

// Add a file here and every tab can read it off `ctx.data.<key>` — no other wiring needed.
//
// Heavy or tab-specific feeds are NOT loaded here. js/data/technicals.js (~800KB),
// js/data/chatter.js (~160KB) fetches and caches lazily the first time its tab mounts, so the
// other tabs don't pay for data they never read. The Con-call tab loads nothing from here at all:
// it is live off /api/concalls, cached on the device by js/core/store.js.
//
// WHAT BLOCKS THE SHELL, AND WHY IT IS ALMOST NOTHING
//   This list used to be one `Promise.all` of seven files, ~825KB, every byte of it in front of
//   the first pixel — including a 347KB shareholdings file that only the Institutions sub-view
//   reads and a 232KB mock corpus that only one Breakouts sub-view reads. On a home connection
//   that is seconds of blank page to load data for tabs the reader has not opened.
//
//   So the split below is by ONE question: does the shell need it to render the first tab? Only
//   the book does — `coverage` backs the Portfolio/Universe toggle and every research tab reads it
//   synchronously. Everything else starts fetching at the same moment but nothing waits for it,
//   and each consumer awaits the module that owns it. Every one of those modules already had its
//   own idempotent `load()`; priming them from here is an optimisation, not the mechanism.
const CRITICAL_SOURCES = {
  // The family's direct-equity book — 142 company lines, names resolved to NSE symbols. This is
  // what the Portfolio/Universe toggle filters the research tabs by. It is NOT the ledger:
  // portfolio.json is, and the two are different questions. See js/data/coverage.js.
  portfolioCompanies: 'data/portfolio-companies.json',
};

const DEFERRED_SOURCES = {
  portfolio: 'data/portfolio.json',
  universe: 'data/universe.json',
  earnings: 'data/mock/earnings.json',
  earningsCalendar: 'data/mock/earnings-calendar.json',
  // REAL: filed shareholdings scraped from Trendlyne, plus the AMC monthly portfolios. 347KB, and
  // read by exactly one sub-view.
  filedHoldings: 'data/institution-holdings.json',
  transactions: 'data/mock/transactions.json',
};

async function fetchAll(sources) {
  const results = await Promise.all(
    // `revalidatedJson`, not a bare fetch: same `no-cache` semantics — revalidate every load, reuse
    // what is already on disk when the server answers 304 — plus in-flight sharing. That last part
    // matters here because the deferred pass and the Earnings Hub both want universe.json at the
    // same moment on a cold visit, and two concurrent requests cannot revalidate against each
    // other. It was 163KB twice.
    Object.entries(sources).map(async ([key, path]) => [key, await revalidatedJson(path)])
  );
  return Object.fromEntries(results);
}

async function loadCritical() {
  const data = await fetchAll(CRITICAL_SOURCES);
  primeCoverage(data.portfolioCompanies);
  return data;
}

/**
 * The rest, in the background. Resolves when every deferred module has been primed.
 *
 * `data` is MUTATED IN PLACE rather than replaced: `ctx.data` is the same object reference every
 * tab was handed at mount, so a tab that is already on screen when this lands sees the new keys.
 * Replacing the object would leave every mounted tab holding the empty one.
 *
 * A failure here is not fatal and must not blank the app — the four modules below each fall back
 * to fetching their own file, and the two tabs that read `ctx.data` directly wait on this promise
 * and then check what actually arrived.
 */
function loadDeferred(data) {
  return fetchAll(DEFERRED_SOURCES)
    .then((rest) => {
      Object.assign(data, rest);

      // universe.json is now the raw NSE-500 screener export. Keep the raw rows for the
      // technicals join, and hand every existing tab the adapted legacy shape it was built
      // against — see js/data/universe.js.
      data.universeRaw = data.universe;
      data.universe = adaptUniverse(data.universeRaw);

      // Same pattern for earnings. The rich payload primes js/data/earnings.js (so it never
      // refetches), and `ctx.data.earnings` keeps the flat one-row-per-company summary that
      // Breakouts → Earnings Surprise was written against.
      data.earningsRaw = data.earnings;
      primeEarnings(data.earningsRaw, data.earningsCalendar);
      data.earnings = adaptLegacySummary(data.earningsRaw);

      // Institutions: filed shareholdings and AMC portfolios. The Superstar half of that tab loads
      // nothing from here — it is live off /api/super-investors, cached by js/core/store.js.
      primeFiled(data.filedHoldings);

      // Portfolio Analytics: the holdings config and the ledger are both small and already fetched
      // here, so the module is seeded rather than refetching. It pulls the two heavy inputs itself
      // when the workspace mounts — the live technicals feed (the mark) and portfolio-history.json
      // (the equity curve) — because eight of the nine tabs never need them.
      primePortfolio(data.portfolio, data.transactions);
      return data;
    })
    .catch((err) => {
      // Deliberately swallowed: each module below re-fetches its own file on demand, and the tab
      // that needs it reports the failure in context rather than the whole app refusing to start
      // because one sub-view's corpus is missing.
      console.warn('[app] deferred data load failed — modules will fetch their own', err);
      return data;
    });
}

async function boot() {
  const root = $('#app');
  try {
    const data = await loadCritical();
    // Started here, awaited by nothing: the shell mounts on the line below while these are still
    // in flight. `setDeferredData` lets a tab that needs one of them wait for the same promise
    // instead of racing it or firing a second fetch.
    setDeferredData(loadDeferred(data));
    setData(data);
  } catch (err) {
    console.error('[app] data load failed', err);
    setDataError(err);
    root.innerHTML = `
      <div class="mx-auto max-w-lg px-6 py-24 text-center">
        <div class="text-3xl">⚠️</div>
        <h1 class="font-display mt-2 text-lg font-bold text-slate-900">Could not load dashboard data</h1>
        <p class="mt-1 text-sm text-slate-500">${err.message}</p>
        <p class="mt-3 text-xs text-slate-400">Serve this site over HTTP (e.g. <code class="rounded bg-slate-100 px-1 py-0.5">python3 -m http.server 8080 -d public</code>) — opening index.html from the filesystem blocks fetch().</p>
      </div>`;
    return;
  }
  mount(root);

  // GitHub schedules are best-effort. One small timestamp request checks every committed capture
  // after first paint and dispatches only the ones outside their real operating window. The Worker
  // declines duplicate runs across readers; landed files repaint any feed already on screen.
  startCaptureWatchdog();
}

boot();
