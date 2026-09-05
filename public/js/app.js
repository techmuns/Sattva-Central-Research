// app.js — bootstrap: load the JSON data set once, then mount the shell (which starts the
// router and renders the first tab). Every tab reads its slice off `state.data` via ctx.data,
// so there is exactly one fetch pass at startup and pollers handle everything after that.

import { $ } from './core/dom.js';
import { setData, setDataError, setDeferredData } from './core/state.js';
import { revalidatedJson } from './core/store.js';
import { mount } from './ui/shell.js';
import { adaptUniverse } from './data/universe.js';
import { prime as primeFiled } from './data/institution-holdings.js';
import { prime as primeCoverage, restoreLastGood } from './data/coverage.js';
import { loadCompanyCaptureIndex } from './data/company-captures.js';
import { startCaptureWatchdog } from './data/capture-watchdog.js';
import { startWatchlistCapture } from './data/watchlist-capture.js';
// Imported for its side effect as much as for `startHostCapture`: js/core/sdk.js builds the one
// SDK client at import time, so pulling it in from the bootstrap is what guarantees the client
// exists — and its window listener is attached — before the host can post `host:init`.
import { startHostCapture } from './core/host-capture.js';

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
  // The family's direct-equity book — 142 company lines, names resolved to NSE symbols, synced
  // from techmuns/Sattva-Family. This is what the scope toggle filters the research tabs by, and
  // it is the ONLY portfolio information this dashboard holds: names and sectors, no quantities,
  // no costs, no valuations. See js/data/coverage.js.
  portfolioCompanies: 'data/portfolio-companies.json',
};

const DEFERRED_SOURCES = {
  universe: 'data/universe.json',
  // REAL: filed shareholdings scraped from Trendlyne, plus the AMC monthly portfolios. 347KB, and
  // read by exactly one sub-view.
  filedHoldings: 'data/institution-holdings.json',
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
  await restoreLastGood();
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

      // Institutions: filed shareholdings and AMC portfolios. The Superstar half of that tab loads
      // nothing from here — it is live off /api/super-investors, cached by js/core/store.js.
      primeFiled(data.filedHoldings);

      // NOTHING HERE LOADS A LEDGER. The mock transactions file, portfolio.json and the 290KB
      // equity-curve history were fetched on every visit for the Portfolio Analytics workspace,
      // which no reader could reach by clicking. Both the workspace and those files are gone; the
      // only portfolio input left is the BOOK above, and it is the one thing the shell blocks on.
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

  // The host can ask this dashboard for a picture of itself and for its current state. Registered
  // AFTER mount so `#dashboard-main` exists by the time a capture can arrive, and exactly once.
  // It does NOT call `sdk.ready()` — the SDK sends `dashboard:ready` itself from inside its
  // `host:init` handler, and a manual one races that and breaks the handshake permanently.
  startHostCapture();

  // GitHub schedules are best-effort. One small timestamp request checks every committed capture
  // after first paint and dispatches only the ones outside their real operating window. The Worker
  // declines duplicate runs across readers; landed files repaint any feed already on screen.
  void loadCompanyCaptureIndex();
  startCaptureWatchdog();
  startWatchlistCapture();

  // Install the public app/data cache only after the dashboard is interactive.
  // It warms the complete module graph for future tab switches and repeat visits,
  // while the service worker explicitly excludes authenticated and no-store reads.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('[app] repeat-visit cache unavailable', err));
    if (typeof requestIdleCallback === 'function') requestIdleCallback(register, { timeout: 2000 });
    else setTimeout(register, 0);
  }
}

boot();
