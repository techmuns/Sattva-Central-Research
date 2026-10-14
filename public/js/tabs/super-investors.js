// One audience choice, shared tasks, distinct books and dates. Legacy routes remain readable.
import { TAB_META } from './catalog.js';
import { renderLive } from '../investors/live.js';
import { renderFiled } from '../investors/filed.js';
import { renderManagerHoldings } from '../investors/manager-holdings.js';
import { investorNavigation, navigationPreferences, contextKey, VIEWS } from '../investors/navigation.js';
import * as investors from '../data/super-investors.js';
import * as filed from '../data/institution-holdings.js';
import * as managers from '../data/managers.js';
import * as refreshRegistry from '../core/refresh.js';
import { PERIODS } from '../data/investor-changes.js';
import { escapeHtml as esc } from '../core/dom.js';

export const meta = TAB_META['super-investors'];
const PREFERENCE_KEY = 'sattva:investor-navigation:v1';
let stored;
try { stored = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || 'null'); } catch {}
const state = navigationPreferences(stored || {});
let ctxRef = null, navigation = null, panelDisposers = [], unsubs = [], stopRefresh = null;
let routeKey = null, savedApplied = false, legacyInstitutionSection = null, generation = 0, institutionPending = null, institutionError = '';
let institutionTimer = null, institutionLastCheck = 0;
const active = () => state.contexts[contextKey(state)];
function remember() {
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(navigationPreferences(state))); } catch {}
}
function changeReading(key, value, reading = active()) { reading[key] = value; remember(); navigation?.update(); }
function navigate(focus) {
  remember(); navigation?.update();
  if (ctxRef?.setParams) {
    const params = { ...ctxRef.params, type: state.audience, category: state.group, view: state.view, ...(active().fund && state.group === 'institutions' ? { fund: active().fund } : {}) };
    delete params.company;
    ctxRef.setParams(params);
  } else paint();
  const selector = focus === 'audience' ? '[data-investor-audience] [aria-selected="true"]' : focus === 'view' ? '[data-investor-view-tabs] [aria-selected="true"]' : '[data-investor-group]';
  ctxRef?.root.querySelector(selector)?.focus({ preventScroll: true });
}

export function getSavedView() {
  const reading = active();
  return { investorAudience: state.audience, investorGroup: state.group, investorView: state.view,
    investorPeriod: reading.changes.period, investorHoldingsOpen: reading.changes.holdingsOpen === true,
    investorSourcesOpen: reading.changes.sourcesOpen === true, investorQuery: reading.overview.query,
    managerQuery: state.contexts['my-managers'].overview.query, institutionFund: state.contexts.institutions.fund };
}
export function applySavedView(extras = {}) {
  // Saved screens from before consolidation still open the same audience and task.
  const legacy = extras.investorSection;
  state.audience = extras.investorAudience === 'investors' || ['investors', 'data-table'].includes(legacy) ? 'investors' : 'my-managers';
  if (legacy === 'my-managers') state.audience = 'my-managers';
  state.group = extras.investorGroup === 'institutions' ? 'institutions' : 'tracked';
  state.view = VIEWS.some(v => v.id === extras.investorView) ? extras.investorView : legacy === 'data-table' ? 'holdings' : ['investors', 'my-managers'].includes(legacy) ? 'overview' : 'changes';
  const reading = active();
  reading.changes.period = PERIODS.some(p => p.id === extras.investorPeriod) ? extras.investorPeriod : 'quarter';
  reading.changes.holdingsOpen = extras.investorHoldingsOpen === true;
  reading.changes.sourcesOpen = extras.investorSourcesOpen === true;
  reading.overview.query = typeof extras.investorQuery === 'string' ? extras.investorQuery : '';
  state.contexts['my-managers'].overview.query = typeof extras.managerQuery === 'string' ? extras.managerQuery : '';
  state.contexts.institutions.fund = typeof extras.institutionFund === 'string' ? extras.institutionFund : '';
  legacyInstitutionSection = !extras.investorView ? extras.institutionSection : null;
  savedApplied = true;
}

function applyRoute(ctx) {
  const params = ctx.params || {};
  const nextKey = JSON.stringify([ctx.subview, params.type, params.category, params.view, params.company, params.fund]);
  if (nextKey === routeKey) return;
  routeKey = nextKey;
  if (savedApplied && ctx.subview === 'institutions' && legacyInstitutionSection) {
    state.audience = 'investors'; state.group = 'institutions'; state.view = legacyInstitutionSection === 'quarterly-changes' ? 'changes' : 'holdings';
  }
  if (!savedApplied) {
    if (['my-managers', 'investors'].includes(params.type)) state.audience = params.type;
    else if (ctx.subview === 'institutions') { state.audience = 'investors'; state.group = 'institutions'; state.view = 'holdings'; }
    if (['tracked', 'institutions'].includes(params.category)) state.group = params.category;
    if (VIEWS.some(v => v.id === params.view)) state.view = params.view;
    if (params.company) {
      state.audience = 'investors'; state.view = 'holdings';
      active().holdings = { ...active().holdings, q: String(params.company).trim().toUpperCase() };
      for (const reading of Object.values(active().fundTables)) reading.q = String(params.company).trim().toUpperCase();
    }
    if (params.fund) state.contexts.institutions.fund = String(params.fund);
  }
  savedApplied = false;
}

export function render(ctx) {
  ctxRef = ctx; applyRoute(ctx);
  if (!navigation || navigation.content.parentElement !== ctx.root || !navigation.content.isConnected) {
    navigation?.destroy();
    navigation = investorNavigation(ctx.root, state, {
      onAudience: audience => { state.audience = audience; navigate('audience'); },
      onView: view => { state.view = view; navigate('view'); },
      onGroup: group => { state.group = group; navigate('group'); },
      onPeriod: period => { active().changes.period = period; remember(); paint(); ctxRef.root.querySelector('[data-changes-period]')?.focus({ preventScroll: true }); },
      onReadingChange: remember,
    });
  }
  if (!unsubs.length) {
    unsubs.push(investors.onChange(() => { if (ctxRef && state.audience === 'investors' && state.group === 'tracked') paint(); }),
      filed.onChange(() => { if (ctxRef && state.audience === 'investors' && state.group === 'institutions') paint(); }));
    const resume = () => { if (!document.hidden && ctxRef && state.audience === 'investors' && state.group === 'institutions') void checkInstitutions(); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume);
    institutionTimer = setInterval(resume, 60000);
    unsubs.push(() => { clearInterval(institutionTimer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); });
  }
  if (!stopRefresh) stopRefresh = refreshRegistry.register('superstar-investors', { label: 'Investors', refresh: async () => {
    if (state.audience === 'my-managers') {
      const snapshot = await managers.load({ force: true });
      if (!snapshot) throw Error(managers.failureInfo() || 'Manager coverage could not be checked.');
      return { checked: snapshot.managers.length };
    }
    if (state.group === 'institutions') { await checkInstitutions(true); if (institutionError) throw Error(institutionError); return { checked: filed.all().length }; }
    return investors.refresh();
  } });
  paint();
}

async function checkInstitutions(force = false) {
  if (institutionPending) return institutionPending;
  if (!force && Date.now() - institutionLastCheck < 55000) return;
  institutionLastCheck = Date.now();
  institutionPending = filed.refresh().then(() => { institutionError = ''; }).catch(() => { institutionError = 'Institutional source could not be re-checked; retained disclosures are shown.'; })
    .finally(() => { institutionPending = null; if (ctxRef && state.audience === 'investors' && state.group === 'institutions') paint(); });
  return institutionPending;
}

function paint() {
  if (!ctxRef || !navigation?.content.isConnected) return;
  const token = ++generation, root = navigation.content;
  const searches = [...root.querySelectorAll('input[type="search"], [data-table-search], [data-manager-search]')];
  const index = searches.indexOf(document.activeElement), search = searches[index];
  const selection = search ? [search.selectionStart, search.selectionEnd, search.selectionDirection] : null;
  const scrolls = [...root.querySelectorAll('[data-table-scroll]')].map(el => [el.scrollLeft, el.scrollTop]);
  navigation.reclaimGroup(); panelDisposers.forEach(fn => fn?.()); panelDisposers = [];
  navigation.update();
  const ctx = { ...ctxRef, root }, reading = active();
  if (state.audience === 'investors' && state.group === 'institutions') {
    if (!filed.isLoaded()) {
      root.innerHTML = '<div class="investor-loading" aria-busy="true">Loading institutional disclosures…</div>';
      filed.load().then(() => {
        if (token !== generation || !ctxRef) return;
        if (filed.isLoaded()) { paint(); void checkInstitutions(); }
        else root.innerHTML = '<p class="text-sm text-slate-500">Institutional holdings could not be read. Please check back.</p>';
      });
      return;
    }
    const panel = renderFiled(ctx, { disposers: panelDisposers, embedded: true, section: state.view === 'changes' ? 'quarterly-changes' : state.view === 'overview' ? 'overview' : 'institutions',
      toolbarControls: navigation.toolbarControls, view: state.view === 'overview' ? reading.overview : reading,
      onView: () => remember(), onFund: fund => { reading.fund = fund; state.view = 'holdings'; navigate('view'); } });
    root.innerHTML = panel.html; panel.wire(root);
    if (institutionError) root.insertAdjacentHTML('beforeend', `<p class="mt-3 text-xs text-slate-500" data-institution-delivery-error>${esc(institutionError)}</p>`);
    void checkInstitutions();
  } else if (state.audience === 'my-managers' && state.view === 'holdings') {
    const panel = renderManagerHoldings(ctx, { view: reading.holdings, onView: view => changeReading('holdings', view, reading), toolbarControls: navigation.toolbarControls });
    root.innerHTML = panel.html; panel.wire(root, panelDisposers);
  } else {
    const section = state.view === 'changes' ? 'quarterly-changes' : state.view === 'holdings' ? 'data-table' : state.audience === 'my-managers' ? 'my-managers' : 'investors';
    renderLive(ctx, { disposers: panelDisposers, embedded: true, section, toolbarControls: navigation.toolbarControls,
      tableView: reading.holdings, onView: view => changeReading('holdings', view, reading),
      changesView: { ...reading.changes, audience: state.audience }, onChangesView: view => changeReading('changes', view, reading),
      managersView: reading.overview, onManagersView: view => changeReading('overview', view, reading),
      overviewView: reading.overview, onOverviewView: view => changeReading('overview', view, reading) });
    if (!investors.isLoaded()) investors.load().catch(() => {});
  }
  root.querySelectorAll('[data-table-scroll]').forEach((el, i) => { if (scrolls[i]) [el.scrollLeft, el.scrollTop] = scrolls[i]; });
  if (selection) { const input = root.querySelectorAll('input[type="search"], [data-table-search], [data-manager-search]')[index]; input?.focus({ preventScroll: true }); input?.setSelectionRange(...selection); }
  navigation.update(); remember();
}

export function destroy() {
  generation++; remember(); navigation?.reclaimGroup(); panelDisposers.forEach(fn => fn?.()); panelDisposers = [];
  navigation?.destroy(); navigation = null; unsubs.forEach(fn => fn()); unsubs = [];
  stopRefresh?.(); stopRefresh = null; ctxRef = null; routeKey = null;
}
export const _funds = () => filed.all();
