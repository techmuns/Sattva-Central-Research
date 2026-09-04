// ui/shell.js — the generic app chrome: header, workspace dropdown, top tabs, left rail,
// and the content host that every tab/portfolio module mounts into. This file owns the
// workspace/tab registry; individual tab modules stay ignorant of navigation entirely.

import { $, escapeHtml } from '../core/dom.js';
import { state, subscribe, setScope, setRoute, saveLastRoute } from '../core/state.js';
import * as router from '../core/router.js';
import * as live from '../core/live.js';
import * as watch from '../core/watch.js';
import { tabBar, segmentedToggle, statusControl, emptyState } from './components.js';
import { closeDrill, closeModal, closeWorkspace, openModal, watchlistEmptyPanel } from './screener.js';
import { SCOPES, scopeLabel } from '../data/scope.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import * as coverage from '../data/coverage.js';
import { startFamilySession } from '../data/family-session.js';
import { bindFamilySyncLifecycle } from '../data/family-sync-lifecycle.js';
import { openScopeEditor } from './scope-editor.js';
import { sourcesModalHtml } from './sources.js';
import { mountHostTicker } from './host-ticker.js';
import * as sourceBeacon from './source-beacon.js';

import * as aiAlerts from '../tabs/ai-alerts.js';
import * as askResearch from '../tabs/ask-research.js';
import * as dailyAlerts from '../tabs/daily-alerts.js';
import * as earningsHub from '../tabs/earnings-hub.js';
import * as concall from '../tabs/concall.js';
import * as publicChatter from '../tabs/public-chatter.js';
import * as breakouts from '../tabs/breakouts.js';
import * as superInvestors from '../tabs/super-investors.js';
import * as news from '../tabs/news.js';
import * as corpAnnouncements from '../tabs/corp-announcements.js';
import * as nseFilings from '../tabs/nse-filings.js';
import * as insiderTrades from '../tabs/insider-trades.js';
import * as ipos from '../tabs/ipos.js';

// The nav model in one place: each workspace an ordered list of tab modules. Every module's
// `meta.subviews` supplies the rail/rail-dropdown items — nothing here is duplicated per module.
//
// PORTFOLIO ANALYTICS IS GONE, AND HIDING IT WAS THE MISTAKE THAT PRECEDED DELETING IT.
//
// It was four modules over an ILLUSTRATIVE ledger — invented quantities, invented costs, real
// prices — and it was kept `hidden: true` so that a saved `#/portfolio/...` link would still
// resolve to the page it named rather than falling through to Research Central. That reasoning
// protected a bookmark and created a trap: with no workspace switcher in the chrome there was
// nothing on the page that led back, and inside the Munshot host there is no address bar to edit,
// so a reader who arrived — from an Ask Research citation, which listed the workspace as an
// evidence source and linked straight into it — was stuck on a screen of made-up money.
//
// The only portfolio fact this dashboard carries now is the BOOK: the 142 company names synced
// from the family repository, which is what the Portfolio scope filters by. See js/data/coverage.js.
// An unknown workspace falls through to Research Central below, so an old `#/portfolio/...` link
// lands on a working page and the URL is corrected — that is the intended behaviour, not a
// regression to guard against. The four modules, the FIFO engine and the mock ledger are in git
// history at d3bba30 if a REAL ledger is ever wired.
//
// ASK RESEARCH IS FIRST, AND FIRST IS LOAD-BEARING. `handleRoute` falls back to `ws.tabs[0]` for
// an unknown or absent tab, so the order of this array IS the default landing page — there is no
// second place recording it that could disagree.
const WORKSPACES = [
  { id: 'research', label: 'Research Central', tabs: [askResearch, aiAlerts, dailyAlerts, earningsHub, concall, publicChatter, breakouts, superInvestors, news, ipos, corpAnnouncements, nseFilings, insiderTrades] },
];

let contentHost = null;
let currentTabModule = null;
let chromeDisposers = [];
let headerDisposer = null;
let topTabs = null;

export function mount(root) {
  topTabs?.dispose();
  topTabs = null;
  root.innerHTML = shellTemplate();
  contentHost = $('#content-host', root);

  scopeLists.migratePortfolioToWatchlist();
  wireStaticHeader(root);
  coverage.onChange(({ changed }) => {
    if (changed && state.scope === 'portfolio' && !['ask-research', 'ai-alerts'].includes(state.tab) && !document.querySelector('[data-scope-editor]')) {
      setTimeout(() => handleRoute(root, router.parseHash()), 0);
    }
  });
  // Read-only, one names-only request per minute while visible. The existing
  // Refresh button also ticks this poller; no production jobs are dispatched.
  live.register('family-portfolio', { intervalMs: 60000, fetcher: async () => {
    const result = await coverage.refresh();
    if (result.error) throw new Error(result.error);
    return result;
  } });
  live.start('family-portfolio');
  bindFamilySyncLifecycle();
  startFamilySession();

  // "Data flowing in", lower-left. Page-level chrome with the same lifetime as the alert stack:
  // mounted once, outside `#app`, so a route change never tears it down. It reads the source
  // registry only when it is opened — nothing here loads a feed. See ui/source-beacon.js for why
  // it is here rather than back in the header the Sources button was removed from.
  sourceBeacon.mount();

  // Always-on poller so the header pill re-renders on a cadence even when nothing else is
  // polling. `synthetic: true` keeps it out of `getLastDataTick()` — it asks no server anything,
  // so counting it as a data confirmation would let the pill claim freshness it has not got.
  live.register('heartbeat', { intervalMs: 20000, fetcher: async () => Date.now(), synthetic: true });
  live.start('heartbeat');

  // App-wide feed watchers. These keep the results and con-call pollers alive whatever tab is
  // open, which is the only way an alert can fire while the reader is looking elsewhere.
  watch.start(live);

  // WHILE THE WATCHLIST SCOPE IS OPEN, THE WATCHLIST IS THE ROW SET.
  //
  // Every other control that changes what a scoped tab shows goes through the router, so the tab
  // re-renders. The star does not — it writes to `localStorage` from inside a table's own click
  // handler — and under Watchlist scope the only thing you can do with it is UNSTAR, which takes a
  // company out of the scope. Without this the row stayed on screen, hollow-starred, belonging to a
  // scope it had just left: the state was right and only the screen disagreed, which is the shape
  // of bug this codebase keeps finding.
  //
  // Deferred by a tick because the change arrives mid-`repaint()`, and remounting the tab out from
  // under the handler that is painting it is a different bug for the same money.
  watchlist.onChange(() => {
    if (state.scope !== 'watchlist') return;
    // The editor deliberately batches its repaint until it closes, so several additions can be
    // made without the route remount closing the modal after the first click.
    if (document.querySelector('[data-scope-editor]')) return;
    setTimeout(() => {
      if (state.scope === 'watchlist') handleRoute(root, router.parseHash());
    }, 0);
  });

  scopeLists.onChange((scope) => {
    if (state.scope !== scope || document.querySelector('[data-scope-editor]')) return;
    setTimeout(() => {
      if (state.scope === scope) handleRoute(root, router.parseHash());
    }, 0);
  });

  router.start((rawRoute) => handleRoute(root, rawRoute));
}

function shellTemplate() {
  return `
    <header class="mx-auto max-w-[1400px] px-6 pb-4 pt-8">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-shrink-0 items-center gap-3">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-lg font-extrabold text-white shadow-lg">SC</div>
          <div class="min-w-0">
            <h1 class="font-display truncate text-2xl font-extrabold leading-tight text-slate-900">Sattva Central Research</h1>
            <p id="brand-subtitle" class="truncate text-sm text-slate-500">Research Central · Indian equities</p>
          </div>
        </div>

        <div class="flex flex-shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500">
          <div class="flex items-center gap-1.5"
               title="Data scope: which companies the tab you are on reports. Portfolio is the family's book, Watchlist is the companies you have starred, Universe is every listed company the feed carries.">
            <span class="hidden text-[10px] font-bold uppercase tracking-wider text-slate-400 sm:inline">Scope</span>
            <div id="scope-toggle-mount"></div>
            <div id="scope-edit-mount"></div>
          </div>
          <!-- The company the Munshot host has selected, when it has selected one. Hidden and
               zero-cost otherwise, including on a static origin with no host at all. The hidden
               attribute is set as a PROPERTY by mountHostTicker rather than as a utility class,
               so an empty mount cannot leave the header's gap-2 showing a gap with nothing in
               it. (No backticks in here: this comment lives inside a template literal.) -->
          <div id="host-ticker-mount" hidden></div>
          <div id="status-mount"></div>
        </div>
      </div>
    </header>

    <nav class="mx-auto max-w-[1400px] px-6" aria-label="Research navigation">
      <div id="tabbar-mount" class="min-w-0"></div>
    </nav>

    <div class="mx-auto max-w-[1400px] px-6 py-6">
      <div id="subview-mount" class="mb-5"></div>
      <!-- #dashboard-main is the capture root the host asks for on dashboard.capture.visual
           (js/core/host-capture.js). It is the CONTENT region deliberately: the header's scope
           toggle and status pill are this app's own chrome, and a picture of the tab is what the
           host is asking for. (No backticks in here: this comment is inside a template literal.) -->
      <main id="dashboard-main" class="fade-in min-w-0">
        <div id="content-host"></div>
      </main>
      <!-- THE DOOR TO THE SOURCE REGISTRY, AND THE ONLY ONE.
           CLAUDE.md removed the header's Sources button and made every status pill passive, for a
           good reason: those chips were competing with the tables they qualified. It also says, in
           the same breath, that "canonical provenance remains in the source registry" — and the
           registry had NO CALLER AT ALL, so that sentence was a promise the app did not keep.
           sourcesModalHtml() was exported and unreachable, and sourceGroups() was named only in
           a comment. (No backticks in here: this comment is inside a template literal — which is
           exactly how this footer broke the page the first time it was written.)
           A footer is what closes that without reopening what was closed. It sits AFTER the
           content, so by construction it cannot compete with anything for the top of the page;
           it adds nothing to the header; and it leaves every pill exactly as passive as before.
           One muted line is also what a reader looking for provenance already expects to find at
           the bottom of a page. -->
      <footer class="border-t border-slate-100 pb-8 pt-5 text-center">
        <button type="button" data-sources-open
          class="text-xs font-semibold text-slate-400 underline decoration-slate-200 underline-offset-4 transition-colors hover:text-indigo-600 hover:decoration-indigo-300">
          Data sources and how each feed is collected
        </button>
      </footer>
    </div>`;
}

// ---- Header: parts that never change across route changes ----------------------------------

/**
 * One status control where there used to be a search box, a Sources button, a Live chip and an
 * Updated chip. It now says Connected because the timestamp belongs to the newest active feed,
 * not to every data set in the dashboard.
 *
 * The two chips said different things about the same subject and neither was quite true: the green
 * one tracked the 20-second heartbeat, which asks nothing of any server, and the white one tracked
 * page load and never moved again. They are now one pill on `live.getLastDataTick()` — the last
 * time a poller actually confirmed something — with the page-load time as the fallback for before
 * any poller has ticked.
 *
 * The pill is deliberately passive. Source/freshness explainer popups were removed from the
 * dashboard; Refresh remains the only action in this compact header cluster.
 */
function wireStaticHeader(root) {
  const status = statusControl({
    getTimestamp: () => live.getLastDataTick() ?? state.dataLoadedAt,
    subscribeTick: live.onGlobalTick,
    onRefresh: () => watch.refreshNow(),
  });
  $('#status-mount', root).innerHTML = status.html;
  // NOT `chromeDisposers` — that list is flushed on every route change, and this control is part
  // of the static header. Putting it there would stop its clock the first time the reader changed
  // tab, leaving a pill frozen on whatever it last said.
  const offStatus = status.wire(root);

  // The host's selected company, for the same reason and with the same lifetime: the host can
  // change its selection while the reader is on any tab, so this subscription belongs to the
  // header rather than to whichever tab happens to be mounted.
  const offHostTicker = mountHostTicker($('#host-ticker-mount', root));

  // The footer's registry link. Wired here rather than per route for the reason above: the footer
  // is static, and a listener flushed on every route change would leave a link that silently stops
  // working the first time the reader switches tab — the same failure the status pill's clock had.
  //
  // `sourcesModalHtml()` is a FUNCTION, called on open, so every figure in the modal is read from
  // the module that owns it at the moment it is shown. That is deliberate and is why the registry
  // may be reached from a static control without going stale — see *Data sources* in CLAUDE.md.
  const sourcesBtn = root.querySelector('[data-sources-open]');
  const onSources = () => openModal(sourcesModalHtml(), { size: 'wide' });
  sourcesBtn?.addEventListener('click', onSources);

  headerDisposer = () => {
    offStatus?.();
    offHostTicker?.();
    sourcesBtn?.removeEventListener('click', onSources);
  };
}

// ---- Route-dependent chrome: workspace dropdown, rail, top tabs, scope toggle ---------------

function handleRoute(root, rawRoute) {
  const ws = WORKSPACES.find((w) => w.id === rawRoute.workspace) || WORKSPACES[0];
  const tabModule = ws.tabs.find((t) => t.meta.id === rawRoute.tab) || ws.tabs[0];
  const subviews = tabModule.meta.subviews || [];
  const subviewValid = subviews.some((s) => s.id === rawRoute.subview);
  const subview = subviewValid ? rawRoute.subview : subviews[0]?.id || null;
  const scope = rawRoute.scope || state.scope;

  // Tab-owned filter params ride along in the query string so a filtered view is shareable.
  // The shell doesn't interpret them — it just preserves them across route changes.
  const resolved = { workspace: ws.id, tab: tabModule.meta.id, subview, scope, params: rawRoute.params || {} };

  if (state.scope !== scope) setScope(scope);
  setRoute(resolved);
  router.replaceRoute(resolved);
  saveLastRoute(router.buildHash(resolved));

  renderRouteChrome(root, ws, tabModule, resolved);
  mountTab(root, tabModule, resolved);
}

function editScope(root, scope) {
  openScopeEditor({
    scope,
    // Closing the editor commits one route repaint. A zero-delay deferral lets the generic modal
    // finish clearing its own focus trap before the tab starts creating new controls.
    onChanged: () => setTimeout(() => handleRoute(root, router.parseHash()), 0),
  });
}

function renderRouteChrome(root, ws, tabModule, resolved) {
  disposeChrome();

  const subtitleEl = $('#brand-subtitle', root);
  if (subtitleEl) subtitleEl.textContent = `${ws.label} · Indian equities`;

  // Portfolio → Watchlist → Universe, widest last. That is the reader's own priority order and it
  // reads left to right as "mine, watched, everything"; reversing it would put the least specific
  // answer first, which is what the old two-option toggle did.
  const toggle = segmentedToggle({
    options: SCOPES.map((value) => ({ value, label: scopeLabel(value) })),
    activeValue: resolved.scope,
    onChange: goScope,
  });
  const toggleMount = $('#scope-toggle-mount', root);
  toggleMount.innerHTML = toggle.html;
  chromeDisposers.push(toggle.wire(toggleMount));

  const editMount = $('#scope-edit-mount', root);
  editMount.innerHTML = `
    <button type="button" data-scope-edit aria-label="${resolved.scope === 'portfolio' ? 'View Portfolio' : `Edit ${escapeHtml(scopeLabel(resolved.scope))} companies`}"
      title="${resolved.scope === 'portfolio' ? 'View holdings from Family Office' : `Add or remove companies from ${escapeHtml(scopeLabel(resolved.scope))}`}"
      class="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-slate-500 shadow-sm ring-1 ring-slate-200 transition hover:bg-white hover:text-indigo-600 hover:ring-indigo-200">
      <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        ${resolved.scope === 'portfolio' ? '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"></path><circle cx="10" cy="10" r="2"></circle>' : '<path d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13v3Z" stroke-linecap="round" stroke-linejoin="round"></path><path d="m11.5 5.5 3 3" stroke-linecap="round"></path>'}
      </svg>
    </button>`;
  const editButton = editMount.querySelector('[data-scope-edit]');
  const onEdit = () => editScope(root, resolved.scope);
  editButton.addEventListener('click', onEdit);
  chromeDisposers.push(() => editButton.removeEventListener('click', onEdit));

  // THE WORKSPACE SWITCHER IS GONE FROM THE CHROME.
  //
  // It picked which set of tabs existed — Research Central's five, or Portfolio Analytics' four —
  // and sat next to a scope toggle whose second option is also called "Portfolio". Two controls,
  // one word, and a genuine double-take every time. With only one workspace offered there is
  // nothing left to pick, so the control goes and the tab bar takes the full width.
  //
  // Portfolio Analytics itself is untouched and still routes; see WORKSPACES above.

  // THE SUB-VIEW RAIL IS A DROPDOWN NOW, AT EVERY WIDTH.
  //
  // It used to be a 240px left column above 1024px and a dropdown below it. The column cost the
  // content 240px of the 1400px it has, permanently, to show at most four short labels — and the
  // tables it sat beside are the widest things here: Institutions carries thirteen numeric
  // columns and the Earnings Hub ten, both tuned column by column (`dense`, `wrapHeads`,
  // `nameMaxPx`) to fit inside what was left. Giving the content the full width is worth more
  // than a permanently-visible list of four.
  //
  // The kicker reads "View" rather than the tab's own title: the section head immediately below
  // prints that title as the page's heading, and the rail card's header was repeating it.
  const subviewItems = (tabModule.meta.subviews || []).map((s) => ({ id: s.id, label: s.label, badge: s.badge }));
  const activeSubviewLabel = subviewItems.find((s) => s.id === resolved.subview)?.label || '';
  const subviewPicker = dropdownMenu({
    key: 'subview',
    kicker: 'View',
    valueLabel: activeSubviewLabel,
    items: subviewItems,
    activeId: resolved.subview,
    onSelect: goSubview,
    title: `Switch between ${tabModule.meta.title} views`,
  });

  const hasSubviews = subviewItems.length > 0;
  const subviewMount = $('#subview-mount', root);
  // A tab with `subviews: []` has nothing to pick, so the row goes entirely rather than
  // rendering an empty control — same rule the rail followed.
  subviewMount.classList.toggle('hidden', !hasSubviews);
  if (!hasSubviews) {
    subviewMount.innerHTML = '';
  } else {
    subviewMount.innerHTML = `
      <div class="w-full max-w-[15rem] rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
        ${subviewPicker.html}
      </div>`;
    chromeDisposers.push(subviewPicker.wire(subviewMount));
  }

  // Keep the strip mounted across routes: replacing it resets horizontal scroll and drops
  // keyboard focus on every selection, including changes to the scope or subview.
  if (topTabs?.workspace === ws.id) {
    topTabs.bar.update(resolved.tab);
  } else {
    topTabs?.dispose();
    const tabItems = ws.tabs.map((t) => ({ id: t.meta.id, label: t.meta.title }));
    const bar = tabBar({ tabs: tabItems, activeId: resolved.tab, onSelect: goTab, label: 'Research sections' });
    const tabBarMount = $('#tabbar-mount', root);
    tabBarMount.innerHTML = bar.html;
    topTabs = { workspace: ws.id, bar, dispose: bar.wire(tabBarMount) };
  }

  document.title = `${tabModule.meta.title} · Sattva Central Research`;

  // The tab we just left called `live.stop()` on the pollers it owns, and two of those are the
  // ones the alert watchers depend on. Re-assert the claim: `start()` is a no-op on a poller that
  // is already running, so this only matters on the navigation that would otherwise silence them.
  watch.ensureRunning();
}

function disposeChrome() {
  for (const dispose of chromeDisposers) {
    try {
      dispose && dispose();
    } catch (err) {
      console.error('[shell] chrome cleanup failed', err);
    }
  }
  chromeDisposers = [];
}

function mountTab(root, tabModule, resolved) {
  // A drill panel, modal or workspace opened on the previous view must never survive a route
  // change — it would be showing a row that is no longer on screen. `silent` because the URL
  // is already being rewritten by the navigation that triggered this; letting the overlay run
  // its own onClose would have it fight that write.
  closeDrill();
  closeModal();
  closeWorkspace({ silent: true });

  // A SCOPE NARROWED TO NOTHING IS ANSWERED HERE, ONCE, FOR EVERY TAB.
  //
  // An empty watchlist is a fact about the SCOPE, not about any tab — nine tabs would otherwise
  // each need their own version of the same sentence, and nine copies is nine chances for one of
  // them to say something slightly different (or to render "no results match your filters" over a
  // list the reader has simply never added to, which sends them hunting for a filter to clear).
  //
  // The shell stays generic: it is not interpreting the tab, it is answering a question the header
  // control it owns has just been used to ask.
  const mountable = tabModule.meta.allowEmptyScope === true || !(resolved.scope === 'watchlist' && watchlist.size() === 0);
  const nextModule = mountable ? tabModule : null;

  // THE TEARDOWN IS DECIDED AGAINST WHAT WILL ACTUALLY BE MOUNTED, not against the tab the route
  // names — and the first version of this got that wrong in a way that was invisible until two
  // navigations later.
  //
  // Landing on an alerts tab with an empty watchlist takes the branch below, so the module was
  // already `currentTabModule` and `currentTabModule !== tabModule` was false: nothing was
  // destroyed. Its subscriptions stayed live, its in-flight collect finished, and it painted its
  // own table into `contentHost` — which by then belonged to Breakouts. The reader saw Breakouts'
  // chrome over General Alerts' rows, on a page where nothing had thrown and no state was wrong.
  // Exactly the lifecycle failure the module contract in CLAUDE.md is written about, arrived at
  // from the one direction the contract does not cover: a tab the shell decided not to mount.
  if (currentTabModule && currentTabModule !== nextModule) {
    try {
      currentTabModule.destroy?.();
    } catch (err) {
      console.error(`[shell] destroy() failed for "${currentTabModule.meta?.id}"`, err);
    }
  }
  currentTabModule = nextModule;

  if (!nextModule) {
    contentHost.innerHTML = watchlistEmptyPanel({
      tabTitle: tabModule.meta.title,
    });
    // This is the same editor as the pencil in the header, opened explicitly for Watchlist. The
    // empty state stays on the page the reader chose, and closing after an addition remounts that
    // page with the newly populated scope.
    contentHost.querySelector('[data-watchlist-add]')?.addEventListener('click', () => editScope(root, 'watchlist'));
    return;
  }

  const ctx = {
    scope: resolved.scope,
    subview: resolved.subview,
    root: contentHost,
    live,
    data: state.data,
    params: resolved.params || {},
    // Tabs call this to push their own filter state into the URL without touching routing.
    // history.replaceState does NOT fire hashchange, so the router would never see the new
    // params — we re-mount the tab body explicitly. Chrome doesn't depend on params, so only
    // the panel is rebuilt, and a chip click leaves no history entry to back out of.
    setParams(next) {
      const route = { workspace: state.workspace, tab: state.tab, subview: state.subview, scope: state.scope, params: next };
      router.replaceRoute(route);
      saveLastRoute(router.buildHash(route));
      mountTab(root, tabModule, route);
    },
    // Same URL write, but WITHOUT re-mounting the panel. For state that lives in an overlay
    // rather than in the page body: the Deep Dive mirrors its open company and internal tab
    // into the URL so the view is shareable and survives a reload, and re-mounting on every
    // internal tab click would tear down the very overlay doing the writing.
    setParamsQuiet(next) {
      const route = { workspace: state.workspace, tab: state.tab, subview: state.subview, scope: state.scope, params: next };
      router.replaceRoute(route);
      saveLastRoute(router.buildHash(route));
      ctx.params = next;
    },
  };
  try {
    tabModule.render(ctx);
  } catch (err) {
    console.error(`[shell] render() failed for "${tabModule.meta?.id}"`, err);
    contentHost.innerHTML = emptyState({ title: 'This panel hit a snag', message: String(err?.message || err), icon: '⚠️' });
  }
}

// ---- Navigation intents (all funnel through router.navigate so the URL stays canonical) -----

/**
 * Jump to a workspace's first tab.
 *
 * Nothing in the chrome calls this now that the switcher is gone, and it stays because it is the
 * one place that knows how to enter a workspace correctly — first tab, first sub-view, scope
 * preserved. Whatever brings Portfolio Analytics back calls this rather than reinventing it.
 */
// eslint-disable-next-line no-unused-vars
function goTab(tabId) {
  const ws = WORKSPACES.find((w) => w.id === state.workspace) || WORKSPACES[0];
  const tabModule = ws.tabs.find((t) => t.meta.id === tabId) || ws.tabs[0];
  router.navigate({ workspace: ws.id, tab: tabModule.meta.id, subview: tabModule.meta.subviews?.[0]?.id ?? null, scope: state.scope });
}

// Filter params belong to a specific sub-view, so switching sub-view (or tab, or workspace)
// clears them. Only a scope change keeps them — the same filters still make sense.
function goSubview(subviewId) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: subviewId, scope: state.scope });
}

function goScope(scope) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: state.subview, scope, params: router.parseHash().params });
}

// ---- Small local dropdown, used by the sub-view picker -------------------------------------
// (Not in ui/components.js because it's specifically about app navigation chrome, not a
// general-purpose primitive other tabs would reuse.)

function dropdownMenu({ key, kicker, valueLabel, items, activeId, onSelect, title = '' }) {
  const html = `
    <div class="relative" data-dd="${escapeHtml(key)}">
      <button type="button" data-dd-trigger ${title ? `title="${escapeHtml(title)}"` : ''} class="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-slate-50">
        <span class="min-w-0">
          <span class="block truncate text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(kicker)}</span>
          <span class="block truncate text-sm font-bold text-slate-900">${escapeHtml(valueLabel)}</span>
        </span>
        <svg data-dd-chevron class="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="m5 8 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div data-dd-menu class="scrollbar-thin absolute left-0 right-0 z-30 mt-1 hidden max-h-80 overflow-y-auto rounded-2xl bg-white p-1.5 shadow-lg ring-1 ring-slate-200">
        ${items
          .map(
            (item) => `
          <button type="button" data-dd-id="${escapeHtml(item.id)}" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors ${
              item.id === activeId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'
            }">
            <span class="truncate">${escapeHtml(item.label)}</span>
            ${item.id === activeId ? '<span class="ml-auto shrink-0 text-indigo-600">✓</span>' : ''}
          </button>`
          )
          .join('')}
      </div>
    </div>`;

  function wire(root) {
    const wrap = root.querySelector(`[data-dd="${key}"]`);
    if (!wrap) return () => {};
    const trigger = wrap.querySelector('[data-dd-trigger]');
    const menu = wrap.querySelector('[data-dd-menu]');
    const chevron = wrap.querySelector('[data-dd-chevron]');

    function toggle(open) {
      menu.classList.toggle('hidden', !open);
      chevron.style.transform = open ? 'rotate(180deg)' : '';
    }
    function onTriggerClick(e) {
      e.stopPropagation();
      toggle(menu.classList.contains('hidden'));
    }
    function onMenuClick(e) {
      const btn = e.target.closest('[data-dd-id]');
      if (!btn) return;
      toggle(false);
      onSelect(btn.dataset.ddId);
    }
    function onDocClick(e) {
      if (!wrap.contains(e.target)) toggle(false);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') toggle(false);
    }

    trigger.addEventListener('click', onTriggerClick);
    menu.addEventListener('click', onMenuClick);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeydown);

    return () => {
      trigger.removeEventListener('click', onTriggerClick);
      menu.removeEventListener('click', onMenuClick);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    };
  }

  return { html, wire };
}
