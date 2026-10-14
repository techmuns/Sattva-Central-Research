import { researchTabs, bookmarks } from '../tabs/registry.js';
import { TAB_GROUPS } from '../tabs/catalog.js';
// ui/shell.js — the generic app chrome: header, workspace dropdown, top tabs, left rail,
// and the content host that every tab/portfolio module mounts into. This file owns the
// workspace/tab registry; individual tab modules stay ignorant of navigation entirely.

import { $, escapeHtml } from '../core/dom.js';
import { state, subscribe, setScope, setRoute, saveLastRoute } from '../core/state.js';
import * as router from '../core/router.js';
import * as live from '../core/live.js';
import * as watch from '../core/watch.js';
import * as refreshRegistry from '../core/refresh.js';
import { tabBar, segmentedToggle, statusControl, emptyState } from './components.js';
import { coverTableResults } from './loading.js';
import { closeDrill, closeModal, closeWorkspace, openModal, watchlistEmptyPanel } from './screener.js';
import { SCOPES, scopeLabel } from '../data/scope.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import * as coverage from '../data/coverage.js';
import { startFamilySession } from '../data/family-session.js';
import { bindFamilySyncLifecycle } from '../data/family-sync-lifecycle.js';
import { openScopeEditor } from './scope-editor.js';
import { mountHostTicker } from './host-ticker.js';
import { mountThemeToggle } from './theme-toggle.js';
import { BOOKMARK_ICON } from './bookmark-button.js';
import * as sourceBeacon from './source-beacon.js';
import * as notifications from './notifications.js';
import * as newsletter from './newsletter.js';
import * as workspace from '../core/workspace.js';
import { enterView } from '../core/view-reading.js';
import { VIEW_ID, VIEW_SOURCES } from '../data/workspace-shared.js';

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
// AI ALERTS IS FIRST, AND FIRST IS LOAD-BEARING. `handleRoute` falls back to `ws.tabs[0]` for
// an unknown or absent tab, so the order of this array IS the default landing page — there is no
// second place recording it that could disagree.
const WORKSPACES = [
  { id: 'research', label: 'Research Central', tabs: researchTabs },
];

let contentHost = null;
let currentTabModule = null;
let chromeDisposers = [];
let headerDisposer = null;
let topTabs = null;
let subviewTabs = null;
let shellRenderRequest = 0;
let releaseRouteLoading = null;
const customModules = new Map();
let workspaceDisposer = null;
let workspaceFrame = 0;
const savedTabsUI = () => import('./saved-tabs.js');

function workspaceTabs(ws) {
  return [...ws.tabs, ...workspace.snapshot().tabs.map(view => {
    const cached = customModules.get(view.id);
    if (cached?.revision === view.revision && cached.definition === JSON.stringify(view)) return cached.module;
    const readingSignature = JSON.stringify([view.source, view.scope, view.subview, view.params, view.reading]);
    if (cached?.readingSignature === readingSignature) {
      cached.module.meta.title = view.title; cached.module.meta.navigationTitle = view.title; cached.module.meta.savedView = view;
      cached.revision = view.revision; cached.definition = JSON.stringify(view);
      return cached.module;
    }
    const source = ws.tabs.find(tab => tab.meta.id === view.source);
    let ui, reader, applied = false;
    const module = {
      meta: { ...(source?.meta || {}), id: view.id, title: view.title, navigationTitle: view.title, navigationGroup: null, hideFromNavigation: false, subviews: source?.meta.subviews || [], allowEmptyScope: source?.meta.allowEmptyScope || !source, savedView: view,
        readingKey: `${view.id}:${(cached?.generation || 0) + 1}` },
      async load() { ui = await savedTabsUI(); if (source) reader = await source.load(); },
      render(ctx) {
        if (source) {
          if (!applied) { reader.applySavedView?.(view.reading.extras, view.reading); applied = true; }
          const readerCtx = { ...ctx, savedView: module.meta.savedView, savedViewKey: module.meta.readingKey, get isCancelled() { return ctx.isCancelled; } };
          readerCtx.setParamsQuiet = next => { ctx.setParamsQuiet(next); readerCtx.params = next; };
          source.render(readerCtx);
        }
        else {
          ctx.root.innerHTML = ui.blankTabHtml(view);
          ctx.root.querySelector('[data-saved-choose]').addEventListener('click', () => editSavedTab(module.meta.savedView));
        }
      },
      destroy() { source?.destroy?.(); applied = false; },
      getSavedView() { return reader?.getSavedView?.() || {}; },
    };
    customModules.set(view.id, { revision: view.revision, definition: JSON.stringify(view), readingSignature, generation: (cached?.generation || 0) + 1, module });
    return module;
  })];
}

async function editSavedTab(tab = null, seed = null) {
  const ui = await savedTabsUI();
  ui.openTabEditor({ tab, seed, onSaved: view => router.navigate({ workspace: 'research', tab: view.id, subview: view.subview, scope: view.scope }) });
}

async function addSavedTab() {
  const ui = await savedTabsUI(), tab = currentTabModule;
  const saved = tab?.meta.savedView, source = saved?.source || tab?.meta.id;
  const readingContext = { scope: state.scope, subview: state.subview, params: router.parseHash().params };
  ui.openTabEditor({ onSaved: view => router.navigate({ workspace: 'research', tab: view.id, subview: view.subview, scope: view.scope }),
    captureCurrent: VIEW_SOURCES.includes(source) ? async () => ui.captureSavedTab({ root: contentHost, source, ...readingContext, module: saved ? tab : await tab.load() }) : null });
}

async function saveReaderFilters(tabModule, resolved, current) {
  const ui = await savedTabsUI();
  const seed = await ui.captureSavedTab({ root: contentHost, source: current.source, scope: resolved.scope, subview: resolved.subview, params: router.parseHash().params, module: tabModule });
  const result = await workspace.edit({ op: 'put', tab: { ...current, ...seed }, expected: current.revision });
  const status = document.querySelector('[data-workspace-status]');
  if (status) status.textContent = result.confirmed ? 'View saved for everyone.' : result.error || 'View changes are waiting to be shared.';
}

function renderSavedControls(root, tabModule, resolved) {
  const mount = root.querySelector('#saved-view-mount'), saved = tabModule.meta.savedView;
  mount.hidden = !saved;
  contentHost.toggleAttribute('data-saved-view', !!saved);
  if (mount.hidden) { mount.innerHTML = ''; return; }
  mount.innerHTML = `<div class="saved-view-head"><div><h2>${escapeHtml(saved.title)}</h2>${saved.source ? `<p>From ${escapeHtml(WORKSPACES[0].tabs.find(tab => tab.meta.id === saved.source)?.meta.navigationTitle || WORKSPACES[0].tabs.find(tab => tab.meta.id === saved.source)?.meta.title || saved.source)}</p>` : ''}</div><div class="saved-tab-actions">${saved.source ? '<button type="button" data-save-reading>Save filters</button>' : ''}<button type="button" data-edit-saved>Edit tab</button><button type="button" data-remove-saved>Remove tab</button></div></div>`;
  mount.querySelector('[data-save-reading]')?.addEventListener('click', () => void saveReaderFilters(tabModule, resolved, tabModule.meta.savedView));
  mount.querySelector('[data-edit-saved]')?.addEventListener('click', () => void editSavedTab(tabModule.meta.savedView));
  mount.querySelector('[data-remove-saved]')?.addEventListener('click', () => {
    const saved = tabModule.meta.savedView;
    openModal(`<div class="saved-tab-editor"><h2>Remove ${escapeHtml(saved.title)}?</h2><p>This removes the shared tab for everyone. Source records remain available in their original table.</p><div class="saved-tab-actions"><button type="button" data-remove-cancel>Keep tab</button><button type="button" data-remove-confirm>Remove shared tab</button></div><p data-remove-error role="status"></p></div>`);
    document.querySelector('[data-remove-cancel]').addEventListener('click', closeModal);
    document.querySelector('[data-remove-confirm]').addEventListener('click', async () => {
      const result = await workspace.edit({ op: 'remove', tabId: saved.id, expected: saved.revision });
      if (result.confirmed || result.pending) { closeModal(); goTab('alerts'); }
      else document.querySelector('[data-remove-error]').textContent = result.error;
    });
  });
}

export function mount(root) {
  workspaceDisposer?.();
  releaseRouteLoading?.(); releaseRouteLoading = null;
  topTabs?.dispose();
  topTabs = null;
  subviewTabs?.dispose();
  subviewTabs = null;
  root.innerHTML = shellTemplate();
  contentHost = $('#content-host', root);

  scopeLists.migratePortfolioToWatchlist();
  wireStaticHeader(root);
  coverage.onChange(({ changed }) => {
    if (changed && state.scope === 'portfolio' && !currentTabModule?.meta.scopeIndependent && !['ask-research', 'ai-alerts'].includes(state.tab) && !document.querySelector('[data-scope-editor]')) {
      setTimeout(() => { if (!currentTabModule?.meta.scopeIndependent) handleRoute(root, router.parseHash()); }, 0);
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
    if (currentTabModule?.meta.scopeIndependent) return;
    if (state.scope !== 'watchlist') return;
    // The editor deliberately batches its repaint until it closes, so several additions can be
    // made without the route remount closing the modal after the first click.
    if (document.querySelector('[data-scope-editor]')) return;
    setTimeout(() => {
      if (state.scope === 'watchlist' && !currentTabModule?.meta.scopeIndependent) handleRoute(root, router.parseHash());
    }, 0);
  });

  scopeLists.onChange((scope) => {
    if (currentTabModule?.meta.scopeIndependent) return;
    if (state.scope !== scope || document.querySelector('[data-scope-editor]')) return;
    setTimeout(() => {
      if (state.scope === scope && !currentTabModule?.meta.scopeIndependent) handleRoute(root, router.parseHash());
    }, 0);
  });

  router.start((rawRoute) => handleRoute(root, rawRoute));
  workspaceDisposer = workspace.onChange(() => {
    cancelAnimationFrame(workspaceFrame);
    workspaceFrame = requestAnimationFrame(() => {
      const route = router.parseHash(), ws = WORKSPACES[0];
      const tab = workspaceTabs(ws).find(tab => tab.meta.id === route.tab);
      const status = workspace.status(), message = root.querySelector('[data-workspace-status]');
      if (message) message.textContent = status.pending ? (status.error || 'Changes are waiting to be shared…') : status.error ? 'Shared tab sync unavailable. Checking again…' : '';
      if (message && status.rejected.length) {
        message.textContent = status.error || 'A shared edit could not be saved.';
        const draft = status.rejected.at(-1), review = document.createElement('button');
        review.type = 'button'; review.className = 'workspace-review'; review.textContent = draft.intent.op === 'put' ? 'Review unsaved tab' : 'Dismiss';
        review.addEventListener('click', () => {
          if (draft.intent.op === 'put') {
            const latest = workspace.snapshot().tabs.find(tab => tab.id === draft.intent.tab.id);
            void savedTabsUI().then(ui => ui.openTabEditor({ tab: latest ? { ...draft.intent.tab, revision: latest.revision } : null, seed: draft.intent.tab,
              onSaved: view => { workspace.dismissRejected(draft.intent.id); router.navigate({ workspace: 'research', tab: view.id, subview: view.subview, scope: view.scope }); } }));
          } else workspace.dismissRejected(draft.intent.id);
        });
        message.append(' ', review);
      }
      if (tab) {
        renderTopNavigation(root, ws, TAB_GROUPS[tab.meta.navigationGroup]?.id || tab.meta.id);
        if (VIEW_ID.test(route.tab) && currentTabModule !== tab) handleRoute(root, { ...route, scope: tab.meta.savedView.scope, subview: tab.meta.savedView.subview, params: tab.meta.savedView.params });
        else if (VIEW_ID.test(route.tab) && root.querySelector('.saved-view-head h2')?.textContent !== tab.meta.title) {
          renderSavedControls(root, tab, route); document.title = `${tab.meta.title} · Sattva Central Research`;
        }
      } else if (VIEW_ID.test(route.tab) && status.confirmed) {
        if (currentTabModule?.meta.id === route.tab) goTab('alerts'); else handleRoute(root, route);
      }
    });
  });
  workspace.start();
}

function shellTemplate() {
  return `
    <header data-app-header data-app-frame class="mx-auto max-w-[1400px] px-6 pb-4 pt-8">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div data-brand-mark class="sattva-product-brand">
          <img class="sattva-wordmark" src="/assets/brand/sattva-ventures-wordmark.png" width="2704" height="302" alt="Sattva Ventures" fetchpriority="high" />
          <h1 class="sattva-product-caption" aria-label="Sattva Central Research"><span id="brand-subtitle">Research Central · Indian equities</span></h1>
        </div>

        <div class="flex flex-shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500">
          <div data-scope-controls class="flex items-center gap-1.5"
               title="Data scope: which companies the tab you are on reports. Portfolio is the family's book, Watchlist is the companies you have starred, Universe is every listed company the feed carries.">
            <span data-scope-label class="hidden text-[10px] font-bold uppercase tracking-wider text-slate-400 sm:inline">Scope</span>
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
          <div class="header-personal-controls">
            <button type="button" data-theme-toggle class="theme-toggle" aria-label="Dark mode" aria-pressed="false"></button>
            <a data-header-bookmarks class="header-bookmarks" href="#/research/bookmarks">${BOOKMARK_ICON}<span>Bookmarks</span></a>
            ${newsletter.buttonHtml}
            ${notifications.bellHtml}
          </div>
        </div>
      </div>
    </header>

    <nav data-app-nav data-app-frame class="mx-auto max-w-[1400px] px-6" aria-label="Research navigation">
      <div class="workspace-navigation"><div id="tabbar-mount" class="min-w-0"></div><button type="button" class="saved-tab-add" data-add-saved-tab aria-label="+ Add tab" title="Add tab">+ <span>Add tab</span></button></div>
      <div class="workspace-status" data-workspace-status role="status"></div>
    </nav>

    <div data-app-content data-app-frame class="mx-auto max-w-[1400px] px-6 py-6">
      <div id="subview-mount" class="mb-5"></div>
      <!-- #dashboard-main is the capture root the host asks for on dashboard.capture.visual
           (js/core/host-capture.js). It is the CONTENT region deliberately: the header's scope
           toggle and status pill are this app's own chrome, and a picture of the tab is what the
           host is asking for. (No backticks in here: this comment is inside a template literal.) -->
      <main id="dashboard-main" class="fade-in min-w-0">
        <div id="saved-view-mount" hidden></div>
        <div id="content-host"></div>
      </main>
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
 * dashboard; Refresh and the appearance toggle share this compact header cluster.
 */
function wireStaticHeader(root) {
  const addTab = root.querySelector('[data-add-saved-tab]');
  addTab?.addEventListener('click', () => void addSavedTab());
  headerDisposer?.();
  const offTheme = mountThemeToggle(root.querySelector('[data-theme-toggle]'));
  const offNotifications = notifications.mountBell(root.querySelector('[data-notification-bell]'));
  const offNewsletter = newsletter.mountButton(root.querySelector('[data-brief-button]'));
  const status = statusControl({
    getTimestamp: () => live.getLastDataTick(),
    subscribeTick: live.onGlobalTick,
    onRefresh: () => watch.refreshNow({ tab: currentTabModule?.meta.savedView?.source || state.tab, scope: state.scope, subview: state.subview, params: router.parseHash().params }),
    getRefreshKey: () => JSON.stringify([state.tab, state.scope, state.subview, router.parseHash().params, refreshRegistry.registered().map((r) => r.id)]),
    subscribeContext: (fn) => { const off = subscribe(fn); const offRegistry = refreshRegistry.onChange(fn); return () => { off(); offRegistry(); }; },
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


  headerDisposer = () => {
    offTheme();
    offNotifications();
    offNewsletter();
    offStatus?.();
    offHostTicker?.();
  };
}

// ---- Route-dependent chrome: workspace dropdown, rail, top tabs, scope toggle ---------------

function handleRoute(root, rawRoute) {
  const ws = WORKSPACES.find((w) => w.id === rawRoute.workspace) || WORKSPACES[0];
  const tabModule = workspaceTabs(ws).find((t) => t.meta.id === rawRoute.tab) || (VIEW_ID.test(rawRoute.tab) ? null : ws.tabs[0]);
  if (!tabModule) {
    ++shellRenderRequest;
    currentTabModule?.destroy?.(); currentTabModule = null;
    releaseRouteLoading?.(); releaseRouteLoading = null;
    enterView(null); contentHost.removeAttribute('data-active-tab'); contentHost.removeAttribute('data-saved-view');
    root.querySelector('#saved-view-mount').hidden = true;
    renderTopNavigation(root, ws, null);
    setRoute({ workspace: ws.id, tab: rawRoute.tab, subview: null, scope: rawRoute.scope || state.scope, params: rawRoute.params || {} });
    contentHost.innerHTML = emptyState({ title: workspace.status().confirmed ? 'This shared tab is unavailable' : 'Loading shared tab…', message: workspace.status().error || 'The workspace will check its saved tabs automatically.' });
    if (!workspace.status().confirmed) void workspace.sync();
    return;
  }
  const subviews = tabModule.meta.subviews || [];
  const requestedSubview = rawRoute.subview || tabModule.meta.savedView?.subview;
  const subviewValid = subviews.some((s) => s.id === requestedSubview);
  const subview = subviewValid ? requestedSubview : subviews[0]?.id || null;
  const scope = rawRoute.scope || tabModule.meta.savedView?.scope || state.scope;

  // Tab-owned filter params ride along in the query string so a filtered view is shareable.
  // The shell doesn't interpret them — it just preserves them across route changes.
  const resolved = { workspace: ws.id, tab: tabModule.meta.id, subview, scope, params: { ...(tabModule.meta.savedView?.params || {}), ...(rawRoute.params || {}) } };

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
  renderSavedControls(root, tabModule, resolved);
  const bookmarksLink = root.querySelector('[data-header-bookmarks]');
  bookmarksLink.href = router.buildHash({ workspace: ws.id, tab: bookmarks.meta.id, scope: resolved.scope });
  if (tabModule === bookmarks) bookmarksLink.setAttribute('aria-current', 'page');
  else bookmarksLink.removeAttribute('aria-current');
  // Grouped readers share framing from the first navigation paint, including while
  // their renderer loads or the selected scope is empty.
  const group = TAB_GROUPS[tabModule.meta.navigationGroup];
  root.dataset.navigationGroup = group?.id || '';
  root.dataset.readingLayout = (group?.layout || tabModule.meta.layout) === 'table' ? 'table' : 'standard';

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
  // Personal saved records keep their original company membership after a portfolio exit.
  root.querySelector('[data-scope-controls]').hidden = tabModule.meta.scopeIndependent === true;
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

  // Grouped readers use their existing tab routes as subtabs. Keep the strip mounted across
  // reader, subview and scope changes so keyboard focus and horizontal scroll survive.
  const navigationId = group?.id || resolved.tab;
  const subviewItems = group
    ? ws.tabs.filter((t) => t.meta.navigationGroup === group.id && !t.meta.hideFromNavigation)
      .map((t) => ({ id: t.meta.id, label: t.meta.navigationTitle || t.meta.title }))
    : (tabModule.meta.subviews || []).map((s) => ({ id: s.id, label: s.label, badge: s.badge }));
  const activeSubview = group ? resolved.tab : resolved.subview;
  // These views keep their route metadata while owning a compact selector in their toolbar.
  const hasSubviews = subviewItems.length > 0 && tabModule.meta.subviewNavigation !== 'toolbar';
  const useSubviewTabs = hasSubviews && (group || tabModule.meta.subviewNavigation === 'tabs');
  const subviewMount = $('#subview-mount', root);
  subviewMount.dataset.navigation = group ? 'group' : useSubviewTabs ? 'tabs' : 'views';
  if (!useSubviewTabs || subviewTabs?.tab !== navigationId) {
    subviewTabs?.dispose();
    subviewTabs = null;
  }
  subviewMount.classList.toggle('hidden', !hasSubviews);
  if (!hasSubviews) {
    subviewMount.innerHTML = '';
  } else if (useSubviewTabs) {
    if (subviewTabs) {
      subviewTabs.bar.update(activeSubview);
    } else {
      const bar = tabBar({ tabs: subviewItems, activeId: activeSubview,
        onSelect: group ? goTab : goSubview, label: `${group?.title || tabModule.meta.title} views` });
      subviewMount.innerHTML = bar.html;
      subviewTabs = { tab: navigationId, bar, dispose: bar.wire(subviewMount) };
    }
  } else {
    const subviewPicker = dropdownMenu({
      key: 'subview',
      kicker: 'View',
      valueLabel: subviewItems.find((s) => s.id === resolved.subview)?.label || '',
      items: subviewItems,
      activeId: resolved.subview,
      onSelect: goSubview,
      title: `Switch between ${tabModule.meta.title} views`,
    });
    subviewMount.innerHTML = `
      <div class="w-full max-w-[15rem] rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
        ${subviewPicker.html}
      </div>`;
    chromeDisposers.push(subviewPicker.wire(subviewMount));
  }

  // Keep the strip mounted across routes: replacing it resets horizontal scroll and drops
  // keyboard focus on every selection, including changes to the scope or subview.
  renderTopNavigation(root, ws, navigationId);

  document.title = `${tabModule.meta.title} · Sattva Central Research`;

  watch.ensureRunning();
}

function renderTopNavigation(root, ws, navigationId) {
  const shared = workspace.snapshot();
  const sharedOrder = shared.revision > 0 ? shared.order : null;
  const tabItems = [...new Map(workspaceTabs(ws).filter((t) => t !== bookmarks && !t.meta.hideFromNavigation)
    .map(t => {
      const parent = TAB_GROUPS[t.meta.navigationGroup], id = parent?.id || t.meta.id;
      return [id, { id, label: parent?.title || t.meta.navigationTitle || t.meta.title }];
    })).values()];
  const signature = JSON.stringify(tabItems);
  if (topTabs?.workspace === ws.id && topTabs.signature === signature) {
    topTabs.bar.update(navigationId, sharedOrder);
  } else {
    const focusedId = document.activeElement?.closest('#tabbar-mount [data-tab-id]')?.dataset.tabId;
    const scroll = root.querySelector('#tabbar-mount [data-tab-list]')?.scrollLeft || 0;
    topTabs?.dispose();
    // Saved events are reached from the header beside the appearance control.
    const bar = tabBar({ tabs: tabItems, activeId: navigationId, onSelect: goTab, label: 'Research sections', orderKey: ws.id,
      sharedOrder, onOrderChange: intent => workspace.edit(intent) });
    const tabBarMount = $('#tabbar-mount', root);
    tabBarMount.innerHTML = bar.html;
    topTabs = { workspace: ws.id, signature, bar, dispose: bar.wire(tabBarMount) };
    tabBarMount.querySelector('[data-tab-list]').scrollLeft = scroll;
    if (focusedId) tabBarMount.querySelector(`[data-tab-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
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
  shellRenderRequest++;
  const reqId = shellRenderRequest;
  releaseRouteLoading?.(); releaseRouteLoading = null;
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
    get isCancelled() { return shellRenderRequest !== reqId; },
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

  // The route chrome (including the newly active tab's visual state) is now in the DOM.
  // Yield to the browser so the reader gets instant visual feedback of their click, then run the
  // heavy data parsing and DOM rendering of the tab content itself.
  // Keep old controls out of reach during that yield: otherwise a fast follow-up search can
  // edit a table that the queued render is about to replace. The current tab still owns its DOM
  // and view state; only the temporary cover is removed before the latest render runs.
  if (contentHost.children.length) releaseRouteLoading = coverTableResults(contentHost.parentElement, contentHost);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(runRender, 0));
  } else {
    setTimeout(runRender, 16);
  }

  async function runRender() {
    if (shellRenderRequest !== reqId) return; // Reader clicked away before this frame
    try {
      // Load only the requested interface. The cover remains until it is ready;
      // shared collectors and retained data continue independently of navigation.
      if (tabModule.load) await tabModule.load();
      if (ctx.isCancelled) return;
      releaseRouteLoading?.(); releaseRouteLoading = null;
      contentHost.setAttribute('data-active-tab', tabModule.meta.id);
      enterView({ key: tabModule.meta.readingKey || null, source: tabModule.meta.savedView?.source || tabModule.meta.id, preset: tabModule.meta.savedView || null });
      tabModule.render(ctx);
    } catch (err) {
      if (ctx.isCancelled) return;
      releaseRouteLoading?.(); releaseRouteLoading = null;
      console.error(`[shell] render() failed for "${tabModule.meta?.id}"`, err);
      contentHost.innerHTML = emptyState({ title: 'This panel hit a snag', message: String(err?.message || err), icon: '⚠️' });
    }
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
  // Clicking the active parent retains its selected reader and filters. Entering from another
  // section opens the group's first reader; explicit subtab selections still change readers.
  const activeModule = workspaceTabs(ws).find((t) => t.meta.id === state.tab);
  if (TAB_GROUPS[tabId] && activeModule?.meta.navigationGroup === tabId) return;
  const tabModule = workspaceTabs(ws).find((t) => t.meta.id === tabId || t.meta.navigationGroup === tabId) || ws.tabs[0];
  router.navigate({ workspace: ws.id, tab: tabModule.meta.id, subview: tabModule.meta.savedView?.subview || tabModule.meta.subviews?.[0]?.id || null, scope: tabModule.meta.savedView?.scope || state.scope });
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
