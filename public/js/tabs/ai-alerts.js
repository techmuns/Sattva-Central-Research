// tabs/ai-alerts.js — THE SMALL, EXPLAINABLE READING LIST ABOVE ALL ALERTS.
//
// All Alerts is the complete chronological record. This tab deliberately is not: it groups
// the last 14 days by company, ranks the material company-specific evidence, and suppresses
// names that do not cross the published threshold. The ranking lives in data/ai-alerts.js so the
// product rules are pure, testable and available to exports or notifications later.

import { sectionHead } from '../ui/screener.js';
import { scopeSummary, pill } from '../ui/components.js';
import { canonicalPublisherName } from '../core/news-publishers.js';
import { escapeHtml } from '../core/dom.js';
import { normalizeBookmark, snapshotForRow } from '../core/bookmark-record.js';
import * as alertPool from '../data/alert-pool.js';
import { bookmarkButton, wireBookmarks } from '../ui/bookmark-button.js';
import { reconcileMarkup } from '../ui/reconcile-markup.js';
import { getHostContext } from '../core/host-context.js';
import { formatNumber } from '../core/format.js';
import * as refresh from '../core/refresh.js';
import * as alerts from '../data/ai-alerts.js';
import { chatterTopic } from '../data/chatter-sentiment.js';
import { driversFromEvent, QUESTIONS } from '../data/alert-drivers.js';
import { alertWindowCache } from '../data/alert-window-cache.js';
import * as screenerInsights from '../data/screener-insights.js';
import { onCaptureLanded } from '../data/capture-watchdog.js';
import * as coverage from '../data/coverage.js';
import * as mute from '../core/ai-mute.js';
import { currentDay, relativeAge, formatDay as fmtDay, latestAlertSignal, latestAlertEvent, sortAlertCards, matchesSearch } from '../ui/ai-alert-utils.js';
import { privatePortfolioContext, readPositionSizes, cachedPositionSizes, onPortfolioInvalidation, onPortfolioReady, onPortfolioConnection, portfolioConnectionState, unlockPortfolio } from '../research/portfolio-bridge.js';
export { relativeAge } from '../ui/ai-alert-utils.js';

export const meta = {
  id: 'ai-alerts',
  title: 'AI Alerts',
  subtitle: `Important portfolio events from the last ${alerts.WINDOW_DAYS} days.`,
  subviews: [],
};

const REFRESH_ID = 'ai-alerts';
const PAGE_SIZE = 8;
const EVIDENCE_ROWS = 4;
const RECHECK_MS = 90_000;
const SORT_KEY = 'sattva:ai-alerts:sort:v1';
const SORTS = { newest: 'Newest first', holdings: 'Largest holdings', priority: 'Highest priority' };
let sortOrder = 'newest';
try { const saved = localStorage.getItem(SORT_KEY); if (Object.hasOwn(SORTS, saved)) sortOrder = saved; } catch { /* Session preference still works. */ }

let ctxRef = null;
let offBookmarks = null;
let bookmarkRoot = null;
let actionGeneration = 0;
let report = null;
let loadToken = 0;
let cacheToken = 0;
let unsubs = [];
let filter = 'all';
let visibleLimit = PAGE_SIZE;
let query = '';
let sizeController = null;
let sizesLoading = false;
let sizeError = '';
let awaitingBook = null;
let collecting = false;
let loadError = '';
let captureDirty = false;
let sourceTimer = null;
let lastSourceCheck = 0;
function sourceChanged() {
  if (!ctxRef) return;
  captureDirty = true;
  if (collecting || sourceTimer !== null) return;
  sourceTimer = setTimeout(() => {
    sourceTimer = null;
    if (!ctxRef || collecting) return;
    captureDirty = false;
    void recollect(ctxRef, { load: false });
  }, 100);
}

// Keep a completed view in memory across tab visits. This lifetime listener also
// revokes that cached private view if access expires while another tab is open.
onPortfolioInvalidation((version) => {
  actionGeneration++;
  alerts.clearRankingCache();
  cacheToken += 1;
  if (version < 0) {
    // Universe/Watchlist cards also carry membership badges from the private
    // book, so revoke those cached annotations as well as Portfolio results.
    report = null;
    if (!ctxRef) return;
    loadToken++;
    sizeController?.abort();
    sizeController = null;
    sizesLoading = collecting = false;
    awaitingBook = null;
    sizeError = 'Unlock your portfolio to refresh your alerts.';
    void recollect(ctxRef);
    return;
  } else {
    if (ctxRef?.scope !== 'portfolio') return;
    // A positions read already in flight will return the checked book. Otherwise
    // wait for Family to adopt it before asking for a new reading.
    if (!sizesLoading) { loadToken++; collecting = false; awaitingBook = version; sizeError = loadError = ''; }
  }
  paint(ctxRef);
});

function portfolioUnavailable() {
  if (ctxRef?.scope !== 'portfolio' || sizesLoading || (sizeError && awaitingBook === null)) return;
  // Background checks can fail without positions-ready, including repeated
  // failures while the connection is already unavailable.
  loadToken++;
  collecting = false;
  awaitingBook = null;
  sizeError = 'Family Office is temporarily unavailable.';
  if (report) {
    report = alerts.rankReport({ scope: report.scope, day: report.day,
      feeds: report.feeds, events: report.allCards.flatMap(card => card.sourceEvents || card.events) }, { holdings: coverage.holdings() });
    paint(ctxRef);
  } else {
    void recollect(ctxRef);
  }
}

export function render(ctx) {
  actionGeneration++;
  ctxRef = ctx;

  if (!unsubs.length) {
    unsubs.push(watchCalendar());
    unsubs.push(watchFreshness());
    unsubs.push(alertWindowCache.onChange(() => { if (ctxRef) paint(ctxRef); }));
    unsubs.push(onCaptureLanded(sourceChanged));
    unsubs.push(alerts.onChange(sourceChanged));
    unsubs.push(onPortfolioConnection((connected) => {
      if (connected && ctxRef?.scope === 'portfolio' && !sizesLoading) void recollect(ctxRef);
      else if (!connected && portfolioConnectionState() === 'unavailable') portfolioUnavailable();
    }));
    unsubs.push(coverage.onChange(() => {
      if (coverage.meta().syncStatus === 'family-unavailable') portfolioUnavailable();
    }));
    unsubs.push(onPortfolioReady((version) => {
      if (ctxRef?.scope === 'portfolio' && awaitingBook !== null && version >= awaitingBook && !sizesLoading) {
        awaitingBook = null;
        void recollect(ctxRef);
      }
    }));
    unsubs.push(
      refresh.register(REFRESH_ID, {
        label: 'AI Alerts',
        refresh: async () => {
          const before = new Set((report?.cards || []).map((card) => `${card.ticker}:${card.evidenceKey || card.topEvent?.id || ''}`));
          await recollect(ctxRef, { refresh: true });
          if (sizeError || loadError) throw new Error(sizeError || loadError);
          const added = (report?.cards || []).filter((card) => !before.has(`${card.ticker}:${card.evidenceKey || card.topEvent?.id || ''}`)).length;
          return { added, checked: (report?.feeds || []).filter((feed) => feed.status === 'ok').length,
            failed: (report?.feeds || []).filter((feed) => feed.status === 'failed').length,
            partial: !screenerInsights.isLoaded() || !!screenerInsights.meta()?.latestReadFailed };
        },
      })
    );
  }

  if (report && report.scope !== ctx.scope) {
    report = null;
    visibleLimit = PAGE_SIZE;
  }

  paint(ctx);
  if (!report) {
    const token = ++cacheToken;
    const restoring = () => token === cacheToken && ctxRef === ctx;
    void alerts.cached({
      scope: ctx.scope,
      holdings: coverage.holdings(),
      positionSizes: cachedPositionSizes(),
      isCurrent: restoring,
    }).then(async (cached) => {
      if (!restoring() || !cached || report?.pending === 0) return;
      // An empty partial is still an unfinished source read. Merge the retained window beneath
      // any newer live evidence instead of letting that partial suppress a slow cache restore.
      // The merge ranks in slices; a live report that completed meanwhile is never overwritten.
      const merged = report ? await alerts.mergePartialReportAsync(cached, report, { isCurrent: restoring }) : cached;
      if (!restoring() || !merged || report?.pending === 0) return;
      report = alerts.withPositionSnapshot(merged, cachedPositionSizes());
      paint(ctxRef);
    });
  }
  recollect(ctx);
}

export function destroy() {
  alerts.clearRankingCache();
  offBookmarks?.(); offBookmarks = null;
  bookmarkRoot = null;
  actionGeneration++;
  clearTimeout(sourceTimer);
  sourceTimer = null;
  captureDirty = false;
  sizeController?.abort();
  sizeController = null;
  sizesLoading = false;
  sizeError = '';
  awaitingBook = null;
  collecting = false;
  loadError = '';
  ctxRef = null;
  cacheToken += 1;
  loadToken += 1;
  for (const off of unsubs) {
    try {
      off?.();
    } catch (err) {
      console.error('[ai-alerts] cleanup failed', err);
    }
  }
  unsubs = [];
}

async function recollect(ctx, { refresh: forceRefresh = false, load = true, reusePositions = false } = {}) {
  if (!ctx) return;
  const token = ++loadToken;
  if (load) lastSourceCheck = Date.now();
  sizeController?.abort();
  sizeController = null;
  sizesLoading = false;
  collecting = true;
  sizeError = loadError = '';
  awaitingBook = null;
  const current = () => token === loadToken && !!ctxRef;
  const book = coverage.holdings();
  const bookSignature = JSON.stringify(book);

  // Public evidence can load while the private connector checks holding sizes.
  // A slow or unavailable size reader must not hold the first alert hostage.
  // An explicit Refresh must really check Family again. Navigation, calendar
  // ageing and a quick tab return are the paths allowed to reuse the snapshot.
  const previousSnapshot = cachedPositionSizes();
  const heldSizes = forceRefresh && !reusePositions ? null : previousSnapshot;
  // Keep the still-valid, dated snapshot on partial cards while an explicit
  // refresh checks it again. Failure handling removes unverified sizes below.
  let checkedSnapshot = previousSnapshot;
  let positions = Promise.resolve(heldSizes);
  if (ctx.scope === 'portfolio' && privatePortfolioContext()) {
    if (!heldSizes) {
      const controller = new AbortController();
      sizeController = controller;
      sizesLoading = true;
      positions = readPositionSizes(controller.signal, { force: forceRefresh }).catch((err) => {
        if (current()) sizeError = err?.message || 'Your active portfolio could not be read. Please refresh.';
        return null;
      }).finally(() => {
        if (current()) { sizesLoading = false; sizeController = null; }
      });
    }
  }
  positions = positions.then(snapshot => {
    if (current() && snapshot) {
      checkedSnapshot = snapshot;
      report = alerts.withPositionSnapshot(report, snapshot);
      paint(ctxRef);
    }
    return snapshot;
  });
  paint(ctx);
  // PARTIALS MERGE IN SLICES, ONE AT A TIME, NEWEST WAITING ONE FIRST. Merging a partial can rank
  // the union of old and new evidence, which on the whole Universe is a second of CPU; done
  // synchronously inside the callback it froze the page once per publication. The queue holds at
  // most one waiting partial because each carries everything before it, and the completed report
  // below waits for an in-flight merge so the two can never paint out of order.
  let queuedPartial = null, mergingPartials = null;
  const mergePartials = async () => {
    while (queuedPartial && current()) {
      const partial = queuedPartial;
      queuedPartial = null;
      const merged = await alerts.mergePartialReportAsync(report, partial, { isCurrent: current });
      if (!merged || !current()) return;
      report = alerts.withPositionSnapshot(merged, checkedSnapshot);
      paint(ctxRef);
    }
  };
  try {
    const [next, positionSizes] = await Promise.all([
      alerts.collect({
        scope: ctx.scope,
        holdings: book,
        refresh: forceRefresh,
        load,
        isCurrent: current,
        onPartial: (partial) => {
          if (!current()) return;
          queuedPartial = partial;
          if (!mergingPartials) mergingPartials = mergePartials().finally(() => { mergingPartials = null; });
        },
      }),
      positions,
    ]);
    if (!current()) return;
    queuedPartial = null;
    if (mergingPartials) await mergingPartials;
    if (!current() || !next) return;
    // The checked book can contain additions/exits since collection began. Read
    // the now-loaded feeds against that book without another network refresh.
    const completed = positionSizes && JSON.stringify(coverage.holdings()) !== bookSignature
      ? await alerts.collect({ scope: ctx.scope, holdings: coverage.holdings(), positionSizes, load: false, isCurrent: current })
      : alerts.withPositionSnapshot(next, positionSizes);
    if (!current() || !completed) return;
    const settled = completed.pending || completed.feeds.some(feed => feed.status === 'failed')
      ? await alerts.mergePartialReportAsync(report, completed, { isCurrent: current }) : completed;
    if (!current() || !settled) return;
    report = settled;
  } catch (err) {
    if (!current()) return;
    loadError = err?.message || 'The alert feeds could not be refreshed.';
  } finally {
    if (current()) {
      collecting = false; paint(ctxRef);
      if (captureDirty) { captureDirty = false; void recollect(ctxRef, { load: false }); }
    }
  }
}

function paint(ctx) {
  if (!ctx || ctx !== ctxRef) return;
  const anchor = [...ctx.root.querySelectorAll('[data-ai-card]')].find(node => {
    const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight;
  });
  const anchorTop = anchor?.getBoundingClientRect().top;
  const matches = (query.trim() ? report?.allCards || [] : report?.cards || []).filter((card) => matchesSearch(card, query));
  const cards = sortAlertCards(filteredCards(matches), ctx.scope === 'portfolio' ? sortOrder : sortOrder === 'holdings' ? 'newest' : sortOrder);
  const shown = cards.slice(0, visibleLimit);
  // Keep the input node mounted while typing and while independent feeds deliver partials.
  // Replacing the whole root loses the caret, keyboard focus and IME composition.
  if (!ctx.root.querySelector('[data-ai-layout]')) {
    ctx.root.innerHTML = `<div data-ai-layout><div data-ai-heading></div>${searchMarkup()}<div data-ai-position-status></div><div data-ai-toolbar></div><div data-ai-results></div></div>`;
    const input = ctx.root.querySelector('[data-ai-search]');
    input.value = query;
    input.addEventListener('input', () => {
      query = input.value;
      visibleLimit = PAGE_SIZE;
      paint(ctxRef);
    });
    ctx.root.querySelector('[data-ai-clear]')?.addEventListener('click', clearSearch);
  }
  reconcileMarkup(ctx.root.querySelector('[data-ai-heading]'), head(ctx));
  const cache = alertWindowCache.status();
  reconcileMarkup(ctx.root.querySelector('[data-ai-position-status]'), positionStatus(ctx) + (cache.message
    ? `<p data-ai-cache-status role="status" class="mb-4 text-xs text-slate-500">${escapeHtml(cache.message)}</p>` : ''));
  ctx.root.querySelector('[data-ai-clear]').hidden = !query.length;
  // Identical results keep their DOM, expanded evidence and keyboard focus.
  for (const [selector, markup] of [
    ['[data-ai-toolbar]', report ? controls(matches, cards.length) : ''],
    ['[data-ai-results]', report ? cardsPanel(ctx, shown, cards.length) : loadError ? quietFallbackPanel() : loadingPanel()],
  ]) {
    const node = ctx.root.querySelector(selector);
    reconcileMarkup(node, markup);
  }
  wire(ctx, cards.length);
  if (anchor?.isConnected && anchorTop != null) {
    const delta = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
}

function positionStatus(ctx) {
  if (ctx.scope !== 'portfolio') return '';
  const sizes = report?.meta?.positionSizes;
  if ((sizesLoading || awaitingBook !== null) && !sizes) return sortOrder === 'holdings'
    ? `<p class="mb-4 text-xs text-slate-500" role="status">Loading portfolio sizes · Newest alerts shown meanwhile.</p>` : '';
  if (sizes) {
    return `<p data-ai-size-note class="mb-4 text-xs text-slate-500" title="${escapeHtml(`Portfolio checked ${sizes.checkedAt}. ${sizes.valuation === 'workbook' ? 'Weights use the latest uploaded workbook marks.' : 'Weights use available prices; quote freshness varies.'} Percentages include held equities, ETFs and liquid positions in the listed book.`)}">
      Workbook period · ${fmtDay(sizes.bookAsOf)}${sizes.valuation === 'workbook' ? ' · Snapshot weights' : ''}
    </p>`;
  }
  return portfolioConnectionState() === 'locked' ? `<p class="mb-4 text-xs text-slate-500"><button type="button" data-ai-unlock class="font-semibold text-indigo-700 hover:underline">Unlock portfolio to include holding sizes</button></p>`
    : sortOrder === 'holdings' ? `<p class="mb-4 text-xs text-slate-500">Portfolio sizes unavailable · Newest alerts shown.</p>` : '';
}

function searchMarkup() {
  return `<div role="search" aria-label="Search AI Alerts" class="mb-4">
    <label for="ai-alert-search" class="sr-only">Search AI Alerts</label>
    <div class="flex items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-indigo-500">
      <svg class="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
      <input id="ai-alert-search" data-ai-search type="search" autocomplete="off" aria-describedby="ai-search-help" placeholder="Search company, symbol or alert…" class="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-slate-900 outline-none placeholder:text-slate-400">
      <button type="button" data-ai-clear class="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-indigo-500">Clear</button>
    </div>
    <p id="ai-search-help" class="mt-2 text-xs text-slate-500">Search all events behind these alerts · Last ${alerts.WINDOW_DAYS} days · Dates in IST</p>
  </div>`;
}

function clearSearch() {
  query = '';
  visibleLimit = PAGE_SIZE;
  const input = ctxRef?.root.querySelector('[data-ai-search]');
  if (input) input.value = '';
  if (ctxRef) paint(ctxRef);
  input?.focus({ preventScroll: true });
}

/** Re-age immediately at IST midnight and after a sleeping/background tab becomes visible. */
function watchCalendar() {
  let day = currentDay();
  let timer;
  const check = () => {
    if (!ctxRef || (document.hidden || innerWidth === 0) || currentDay() === day) return;
    day = currentDay();
    for (const el of ctxRef.root.querySelectorAll('[data-ai-age]')) {
      el.textContent = relativeAge(el.dataset.day, day);
    }
    // Re-rank and drop evidence that has left the 14-day window as well as updating labels.
    void recollect(ctxRef);
  };
  const schedule = () => {
    const nextMidnight = Date.parse(`${currentDay()}T00:00:00+05:30`) + 86_400_000;
    timer = setTimeout(() => { check(); schedule(); }, Math.max(1, nextMidnight - Date.now() + 50));
  };
  schedule();
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}

/** Revalidate bounded source snapshots while visible and after returning from inactivity.
 * This checks published captures only; it does not dispatch production collection jobs. */
function watchFreshness() {
  const check = () => {
    if (!ctxRef || (document.hidden || innerWidth === 0) || collecting || Date.now() - lastSourceCheck < RECHECK_MS) return;
    void recollect(ctxRef, { refresh: true, reusePositions: true });
  };
  const timer = setInterval(check, RECHECK_MS);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check); window.removeEventListener('online', check); };
}

function head(ctx) {
  const m = report?.meta || {};
  const stories = alerts.storyStatus(report);
  // Connector and refresh failures stay available to the refresh controller for diagnostics, but
  // this customer-facing queue falls back quietly instead of turning infrastructure into an alert.
  const status = (loadError || sizeError) ? { label: report ? 'Latest available' : 'AI Alerts', tone: 'neutral', state: 'complete' }
    : report && (collecting || awaitingBook !== null) ? { label: 'Ready · checking quietly', tone: 'neutral', state: 'pending' } : feedStatus(report);
  return sectionHead({
    title: 'AI Alerts',
    description: `Important company signals from the last ${alerts.WINDOW_DAYS} days.`,
    meta: `<div class="flex flex-wrap items-center justify-end gap-2">
      ${stories.total ? `<span data-ai-story-status class="text-xs text-slate-500" title="Grouping uses captured headlines and descriptions. Uncertain reports remain separate. Earlier story context is retained for up to 180 days; All Alerts holds the source history.">${stories.checking ? 'Checking repeated coverage…' : stories.partial ? 'Some reports remain ungrouped' : 'Repeated coverage grouped'}</span>` : ''}
      <span data-ai-feed-status data-state="${status.state}">${pill({ label: status.label, tone: status.tone })}</span>
      ${report ? scopeSummary({
        scope: ctx.scope,
        count: m.activeCompanies || 0,
        noun: 'companies with recent events',
        book: coverage.meta(),
      }) : pill({ label: { portfolio: 'Portfolio', watchlist: 'Watchlist', universe: 'Universe' }[ctx.scope], tone: 'neutral' })}
      ${pill({ label: `${alerts.WINDOW_DAYS}-day window`, tone: 'brand', title: `${fmtDay(m.firstDay)} through ${fmtDay(report?.day)}` })}
    </div>`,
  });
}

/** Keep collection state compact, explicit and independently testable. */
export function feedStatus(rep) {
  const pending = rep ? Number(rep.pending || 0) : null;
  if (pending === null) return { label: 'Reading feeds…', tone: 'neutral', state: 'pending' };
  if (pending > 0) {
    return {
      label: `Reading ${pending} more ${pending === 1 ? 'feed' : 'feeds'}…`,
      tone: 'neutral',
      state: 'pending',
    };
  }
  if (rep.feeds?.some(feed => feed.status === 'failed')) {
    return { label: 'Partial coverage · retained evidence shown', tone: 'neutral', state: 'partial' };
  }
  const staleFeeds = Number(rep.meta?.staleFeeds || 0);
  if (staleFeeds > 0) {
    return {
      label: 'Sources updating',
      tone: 'neutral',
      state: 'complete',
    };
  }
  return { label: 'Updated', tone: 'positive', state: 'complete' };
}

function controls(cards, visibleCount) {
  const active = cards.filter((card) => !mute.isHidden(card.key || card.ticker, card.evidenceKey || card.topEvent?.id || ''));
  const mustSee = active.filter((card) => card.priority === 'must-see').length;
  const important = active.filter(card => card.priority === 'important').length;
  // Counted over what is ACTUALLY archived out of this view, not over the whole store: an entry
  // whose evidence has been overtaken is no longer hiding anything, and reporting it as archived
  // would send the reader looking for a card that is already back on the page.
  const archived = cards.length - active.length;
  const options = [
    { id: 'all', label: `All priorities · ${active.length}` },
    { id: 'must-see', label: `Must see · ${mustSee}` },
    { id: 'important', label: `Important · ${important}` },
    // ARCHIVING IS NOT DELETING, so the archive is a place and not just a smaller list. A control
    // that makes a card disappear with nothing on screen saying where it went is indistinguishable
    // from having lost it — and this page's whole promise is that it tells you what happened.
    { id: 'archived', label: `Archived · ${archived}` },
  ];
  return `
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3" data-ai-controls>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Filter AI Alerts by priority">
        ${options.map((option) => `<button type="button" data-ai-filter="${option.id}" aria-pressed="${filter === option.id}"
          class="rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${filter === option.id ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-600 ring-slate-200 hover:text-indigo-700 hover:ring-indigo-200'}">${escapeHtml(option.label)}</button>`).join('')}
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <label class="flex items-center gap-2">Sort
          <select data-ai-sort aria-label="Sort AI Alerts" class="rounded-xl bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
            ${Object.entries(SORTS).filter(([value]) => value !== 'holdings' || ctxRef?.scope === 'portfolio').map(([value, label]) => `<option value="${value}" ${value === (ctxRef?.scope !== 'portfolio' && sortOrder === 'holdings' ? 'newest' : sortOrder) ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        ${filter === 'archived' && archived ? `<button type="button" data-ai-unmute-all class="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:text-indigo-700 hover:ring-indigo-200">Restore all</button>` : ''}
        <span role="status" aria-live="polite" aria-atomic="true"><strong class="font-semibold text-slate-700">${escapeHtml(formatNumber(visibleCount))}</strong> ${visibleCount === 1 ? 'company' : 'companies'} ${query.trim() ? 'matching in this view' : 'in this view'}</span>
      </div>
    </div>`;
}

function cardsPanel(ctx, cards, total) {
  if (!cards.length) return emptyPanel(ctx, total);
  return `
    <section class="grid gap-4 lg:grid-cols-2" data-ai-cards>
      ${cards.map((card) => cardMarkup(card, ctx.scope, currentDay(), filter === 'archived')).join('')}
    </section>
    ${total > cards.length ? `<div class="mt-5 text-center"><button type="button" data-ai-more class="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300">Show ${escapeHtml(formatNumber(Math.min(PAGE_SIZE, total - cards.length)))} more</button></div>` : ''}`;
}

/**
 * The named patterns as chips — a summary line, never the sentences again.
 *
 * THIS BLOCK USED TO BE THE CARD'S BIGGEST PROBLEM. It printed each pattern's full sentence, and
 * the card's insight directly above it printed the FIRST of those sentences again, verbatim, in
 * the feeds' own technical wording. One finding, said twice, in six lines. The insight now states
 * the leading pattern in ordinary English with its figures, so all this row has to do is name the
 * others — which is what makes it worth a line instead of a panel.
 *
 * IT STILL SITS ABOVE THE EVIDENCE. The finding is read before its workings; that was always the
 * reason for the block and it is unchanged. NO SCORE IS PRINTED, exactly as nowhere else on this
 * card prints one: the patterns carry points, the points are retained in `scoreBreakdown` for
 * verification, and a reader is owed the correlation and the evidence, not the arithmetic.
 */
function confluenceMarkup(card) {
  const found = card.confluence || [];
  if (!found.length) return '';
  return `
    <div data-ai-confluence class="mt-2.5 flex flex-wrap items-center gap-1.5">
      ${found
        .map(
          (pattern) => `<span data-confluence="${escapeHtml(pattern.id)}" title="${escapeHtml(`${pattern.label} — ${pattern.detail}`)}"
            class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-100">${escapeHtml(pattern.short || pattern.label)}</span>`
        )
        .join('')}
    </div>`;
}

// One sentence, only when the complete top-of-funnel pool has genuinely related context. This is
// deliberately not another panel: the card stays the same shape and the source remains one click
// away. Context contributes no alert score (see intelligence-graph.js).
function contextMarkup(card, scope) {
  if (!card.contextSummary) return '';
  const event = card.contextEvents?.[0] || card.upcomingEvents?.[0];
  if (!event) return '';
  const destination = evidenceDestination(event, scope);
  return `<a data-ai-context href="${escapeHtml(destination.href)}" ${destination.external ? 'target="_blank" rel="noopener noreferrer"' : ''}
    aria-label="${escapeHtml(destination.ariaLabel)}" title="Context only; it does not add alert priority."
    class="mt-2 block text-xs leading-relaxed text-slate-500 transition hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">${escapeHtml(card.contextSummary)}</a>`;
}

/**
 * A labelled block on the card — a marker, a kicker and its content.
 *
 * The card grew two readings that answer different questions ("what happened" and "what does it
 * bear on"), and two unlabelled paragraphs of similar weight read as one long paragraph. The kicker
 * is what lets the eye jump to the second without reading the first again.
 */
function cardSection(kicker, bodyHtml, attrs = '') {
  return `
    <div ${attrs} class="mt-3 flex gap-2.5">
      <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(kicker)}</div>
        ${bodyHtml}
      </div>
    </div>`;
}

/**
 * WHAT A ROW COULD CHANGE — the reading, on the row that holds its record.
 *
 * This was a paragraph of its own under an "Earnings assumption, valuation or thesis?" kicker: up
 * to three linked readings per question, the questions with nothing behind them stated, and a
 * counted overflow. Every word of it was true and the desk reads the same three questions on every
 * card, so restating them cost a block of prose above the evidence to tell a reader something they
 * already know. The READING is what they did not know, so it rides the row it came off as a chip.
 *
 * Three things the paragraph was carrying that the chip has to keep:
 *
 * 1. **The record stays one click away.** The classification is ours, so a reader must be able to
 *    check it — and now the row the chip sits on IS the link to that record, rather than a second
 *    anchor to the same place. `driversFromEvent` is asked per event for exactly that reason: it
 *    is the uncapped primitive, so a chip can never be missing from a row that earned one.
 * 2. **It is a TOPIC reading, never a direction.** `news-keywords.js` rule 1 holds: "Order" means
 *    a source carried the word, not that an order was won. So the chip is indigo — never the
 *    emerald or rose the direction dot beside it uses — and its title says "Could change …",
 *    with each rule's own non-verification sentence after it.
 * 3. **A truncation is counted.** Two readings on one row for one question print as "+1" rather
 *    than one of them vanishing. The chips are one per question and there are only three
 *    questions, so nothing else needs capping.
 *
 * What the chip deliberately does NOT carry is the card-level total per question, or the "nothing
 * tracked here bears on the valuation" statement. Both are the desk's own vocabulary rather than
 * evidence, and the complete per-event accounting is in All Alerts, one click down in the footer.
 */
function driverReadings(event) {
  const byQuestion = new Map();
  for (const driver of driversFromEvent(event)) {
    const found = byQuestion.get(driver.question);
    if (found) found.push(driver);
    else byQuestion.set(driver.question, [driver]);
  }
  // In the vocabulary's own order, so two rows never name the same pair of questions differently.
  return QUESTIONS.filter((question) => byQuestion.has(question.id))
    .map((question) => ({ question, drivers: byQuestion.get(question.id) }));
}

function driverChipsMarkup(readings) {
  if (!readings.length) return '';
  const chips = readings.map(({ question, drivers }) => {
    const extra = drivers.length - 1;
    const title = `Could change ${question.label}. ${drivers.map((driver) => driver.why).join(' ')}`;
    return `<span data-ai-driver data-driver-question="${escapeHtml(question.id)}" title="${escapeHtml(title)}"
      class="inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700">${escapeHtml(`${question.short} · ${drivers[0].label}`)}${extra > 0 ? `&nbsp;+${escapeHtml(formatNumber(extra))}` : ''}</span>`;
  });
  return `<span class="mt-1.5 flex flex-wrap items-center gap-1">${chips.join('')}</span>`;
}

/**
 * The list's own header, and the home of two figures the strip used to carry.
 *
 * "5 sources" is a property of the card's evidence rather than of any row, so it belongs to the
 * list rather than to a cell of its own — and "newest first" is a claim about the order, which is
 * why `byNewestFirst` sorts what `topEvidence` selected instead of trusting score order to read
 * as recency. The window is named because an age of 9d means nothing without it.
 */
function listHeadMarkup(card) {
  const sources = card.feedCount || 0;
  return `
    <div data-ai-list-head class="mt-4 flex items-baseline justify-between gap-3 border-t border-slate-100 pt-3">
      <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Newest first</span>
      <span class="text-[10px] font-bold uppercase tracking-wider tabular-nums text-slate-500"
        title="${escapeHtml(`How many independent feeds carry something on this company in the last ${alerts.WINDOW_DAYS} days. Every event behind this card is in All Alerts.`)}"><span data-ai-sources>${escapeHtml(formatNumber(sources))}</span> ${sources === 1 ? 'feed' : 'feeds'} · ${alerts.WINDOW_DAYS} days</span>
    </div>`;
}

/**
 * Newest first, by the day and by the time where the feed published one.
 *
 * `topEvidence` chooses WHICH rows (one per source in rounds, capped per source, so a card never
 * spends every row on one of them), and this decides the order they are read in. Keeping them in
 * score order under a header that says "newest first" would be the header describing a different
 * list.
 */
function byNewestFirst(events) {
  return [...events].sort((a, b) =>
    String(b.day || '').localeCompare(String(a.day || '')) || String(b.time || '').localeCompare(String(a.time || '')));
}

const cardSnapshots = new WeakMap();
function cardSnapshot(card) {
  if (cardSnapshots.has(card)) return cardSnapshots.get(card);
  const snapshot = normalizeBookmark({ title: card.insight, company: card.company, ticker: card.ticker, entityId: card.entityId,
    kind: 'AI Alerts', source: 'Dashboard analysis', sourceId: `${card.key || card.ticker}:${card.evidenceKey || card.insight}`,
    eventDate: latestAlertEvent(card)?.day,
    body: card.events.map(event => [event.headline, event.detail, event.reason].filter(Boolean).join('\n')).join('\n\n'),
    details: card.events.map(event => ({ label: `${event.feedLabel || event.feed} · ${event.day || 'Date not supplied'}`, value: event.headline })),
    links: card.events.filter(event => event.url).map(event => ({ label: event.headline, url: event.url })),
  });
  cardSnapshots.set(card, snapshot);
  return snapshot;
}
function cardMarkup(card, scope, day, archived = false) {
  const badge = card.badge || { id: 'important', label: 'Important', tone: 'neutral' };
  const tone = {
    negative: { edge: 'border-l-rose-500', badge: 'bg-rose-600 text-white ring-rose-600' },
    caution: { edge: 'border-l-amber-500', badge: 'bg-white text-amber-700 ring-amber-300' },
    neutral: { edge: 'border-l-slate-300', badge: 'bg-white text-slate-600 ring-slate-200' },
  }[badge.tone] || { edge: 'border-l-slate-300', badge: 'bg-white text-slate-600 ring-slate-200' };
  const newest = latestAlertEvent(card);
  const events = byNewestFirst(alerts.topEvidence(newest ? { ...card, events: [newest, ...card.events.filter(event => event !== newest)] } : card, EVIDENCE_ROWS));
  const shownStories = new Set(events.map(e => e.storyId).filter(Boolean));
  const rest = card.events.filter(e => !events.includes(e) && (!e.storyId || !shownStories.has(e.storyId))).length;
  const signal = latestAlertSignal(card);
  // The sentence is one source's own claim, sometimes chosen from the exchange's description and
  // sometimes clipped on a word boundary — so the untouched wording, and which feed it came from,
  // stay one hover away. See `plainHeadline` / `filingClaim`.
  const lead = alerts.leadEvent(card);
  return `
    <article data-ai-card data-ai-key="${escapeHtml(card.key || card.ticker || card.entityId)}" data-ticker="${escapeHtml(card.ticker || '')}" data-entity-id="${escapeHtml(card.entityId || '')}" data-priority="${escapeHtml(card.priority)}" data-score="${card.score}"${archived ? ' data-ai-archived' : ''}
      class="flex h-full flex-col overflow-hidden rounded-2xl border-l-4 ${archived ? 'border-l-slate-200' : tone.edge} bg-white shadow-sm ring-1 ring-slate-100"
      style="content-visibility: auto; contain-intrinsic-size: auto none auto 320px;">
      <div class="flex-1 p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="font-display truncate text-lg font-extrabold leading-tight text-slate-900">${escapeHtml(card.company)}</h3>
            <div class="mt-0.5 truncate text-[11px] font-bold uppercase tracking-wider text-slate-400">
              ${escapeHtml(card.ticker || 'No exchange ticker')}${card.sector ? ` · ${escapeHtml(card.sector)}` : ''}${card.holding ? ' · In portfolio' : ''}
            </div>
          </div>
          <span class="shrink-0 rounded-md px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${tone.badge}">${escapeHtml(badge.label)}</span>
        </div>

        <p data-ai-date class="mt-2 text-xs leading-relaxed text-slate-500" title="Date of the newest noteworthy source event behind this alert. Source dates and times use IST; refreshing the page does not make an old event new.">
          ${signal ? `Latest signal · <time datetime="${escapeHtml(signal.datetime)}"><span data-ai-age data-day="${signal.day}" class="font-semibold capitalize text-slate-600">${relativeAge(signal.day, day)}</span> · ${fmtDay(signal.day)}${signal.time ? ` · ${signal.time} IST` : ''}</time>` : 'Signal date unavailable'}
        </p>
        ${Number.isFinite(card.holdingWeightPct) ? `<p data-ai-holding-size class="mt-1 text-xs font-semibold text-indigo-700">${card.holdingWeightPct > 0 && card.holdingWeightPct < 0.01 ? '&lt;0.01' : card.holdingWeightPct.toLocaleString('en-IN', { maximumFractionDigits: 2 })}% of listed portfolio</p>` : ''}

        ${cardSection(lead?.storyId && lead.storyChange !== 'new' ? 'Updated · What changed' : 'What happened', `<p data-ai-insight class="font-display mt-0.5 text-[17px] font-bold leading-snug text-slate-900"${lead ? ` title="${escapeHtml(`${lead.feedLabel || lead.feed} · ${lead.headline || ''}`)}"` : ''}>${escapeHtml(card.insight)}</p>${confluenceMarkup(card)}`)}

        ${listHeadMarkup(card)}
        <ul data-ai-evidence class="mt-1 space-y-0.5">
          ${events.map((event) => eventMarkup(event, scope, day)).join('')}
        </ul>
        ${contextMarkup(card, scope)}
      </div>
      <footer class="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
        ${rest > 0
          ? `<button type="button" data-open-general data-ticker="${escapeHtml(card.ticker || card.company)}" class="text-xs font-bold text-indigo-700 hover:text-indigo-900">${escapeHtml(formatNumber(rest))} more ${rest === 1 ? 'event' : 'events'} →</button>`
          : `<span class="text-xs text-slate-400">Everything on this company is above</span>`}
        <div class="flex shrink-0 items-center gap-2">
          <span data-ai-notebook-card="${escapeHtml(card.key || card.ticker)}">${bookmarkButton(cardSnapshot(card), { compact: false })}</span>
          ${archived
            ? `<button type="button" data-ai-unmute data-ticker="${escapeHtml(card.key || card.ticker)}"
                class="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition hover:ring-indigo-300">Restore</button>`
            : `<button type="button" data-ai-mute data-ticker="${escapeHtml(card.key || card.ticker)}"
                class="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:text-slate-900 hover:ring-slate-300">Archive</button>`}
          <button type="button" data-open-general data-ticker="${escapeHtml(card.ticker || card.company)}"
            class="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-slate-700">Open</button>
        </div>
      </footer>
    </article>`;
}

const DOT_TONE = {
  positive: 'bg-emerald-500',
  negative: 'bg-rose-500',
  neutral: 'bg-slate-300',
};

/**
 * One line of evidence: what it says, where it came from, how old it is.
 *
 * The direction pill, the importance pill, the full timestamp and the rule's own reason sentence
 * all came off this row. None of them was wrong — they are simply the workings, and every one of
 * them is still one click away in All Alerts, which is the tab that exists to show them. What
 * a card owes is the claim and its provenance.
 *
 * THE AGE IS PRINTED AT THE RESOLUTION THE FEED PUBLISHES. Most of these feeds date a row to a day
 * and no finer, so the row says `2d` and its tooltip carries the date and, where the feed actually
 * published a clock, the IST time. A relative age invented down to the hour for a day-only feed
 * would be this dashboard being precise about something nobody measured.
 */
function eventMarkup(event, scope, day) {
  const destination = evidenceDestination(event, scope);
  const tag = alerts.FEED_TAG[event.feed] || String(event.feedLabel || event.feed || '').toUpperCase();
  const age = relativeAge(event.day, day);
  const when = `${fmtDay(event.day)}${event.time ? ` · ${event.time} IST` : ' · day only'}`;
  // Plain where this dashboard wrote the sentence, verbatim where somebody else did — see
  // `plainHeadline`. The tooltip always carries the feed's own wording so nothing is lost.
  const claim = alerts.plainHeadline(event);
  const readings = driverReadings(event);
  // THE CHIP MUST REACH A SCREEN READER TOO. The link carries an aria-label, which replaces its
  // own contents for assistive technology — so a chip rendered inside it would be silently dropped
  // unless the questions are named in that label as well.
  const ariaLabel = readings.length
    ? `${destination.ariaLabel} — could change ${readings.map(({ question }) => question.label).join(', ')}`
    : destination.ariaLabel;
  // Today and yesterday darken. An age is the reason a reader looks at a card this morning, so the
  // newest rows read at full strength and a nine-day-old book change recedes without being hidden.
  const recent = age === 'today' || age === '1d' || age.startsWith('in ');
  return `
    <li data-ai-development="${escapeHtml(event.developmentId || event.id)}" data-ai-notebook-event="${escapeHtml(event.id)}">
      <div class="flex items-start gap-2">
      <a data-ai-event data-ai-evidence-link href="${escapeHtml(destination.href)}"
        ${destination.external ? 'target="_blank" rel="noopener noreferrer"' : ''}
        aria-label="${escapeHtml(ariaLabel)}"
        class="group flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-2 -mx-2 transition-colors hover:bg-indigo-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[event.direction] || DOT_TONE.neutral}" aria-hidden="true"></span>
        <span class="min-w-0 flex-1">
          ${event.storyId && event.storyChange !== 'new' ? '<span data-ai-updated class="block text-xs font-bold text-indigo-700">Updated · What changed</span>' : ''}
          <span class="line-clamp-2 block text-sm font-medium leading-snug text-slate-800 group-hover:text-slate-900" title="${escapeHtml(event.headline || '')}">${escapeHtml(claim)}</span>
          ${driverChipsMarkup(readings)}
        </span>
        <span data-ai-event-source class="mt-0.5 shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider ${recent ? 'text-slate-600' : 'text-slate-400'}" title="${escapeHtml(`${event.feedLabel || event.feed} · ${when}`)}">${escapeHtml(tag)} · <time data-ai-age data-day="${escapeHtml(event.day)}" datetime="${escapeHtml(event.time ? `${event.day}T${event.time}+05:30` : event.day)}">${escapeHtml(age)}</time></span>
      </a>
      ${bookmarkButton(snapshotForRow(event, { section: 'daily-alerts' }))}
      </div>
      ${storySourcesMarkup(event.storyReports || [])}
      ${storyHistoryMarkup(event)}
    </li>`;
}

function storySourcesMarkup(reports) {
  const links = new Map();
  for (const report of reports) {
    const records = [{ url: report.url, publisher: report.publisher || report.sourceRecord?.publisher || report.sourceRecord?.source,
      feed: report.feed, headline: report.headline }, ...(report.newsProvenance || [])];
    for (const record of records) {
      const url = safeSourceUrl(record.url);
      if (!url || links.has(url)) continue;
      const label = record.publisher || (record.feed === 'nse-filings' ? 'NSE' : record.feed === 'announcements' ? 'BSE / company filing' : new URL(url).hostname.replace(/^www\./, ''));
      links.set(url, `<a data-ai-story-source href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-indigo-700 hover:underline" title="${escapeHtml(record.headline || report.headline || '')}">${escapeHtml(canonicalPublisherName(label))}</a>`);
    }
  }
  if (!links.size) return '';
  const all = [...links.values()];
  return `<div class="mb-2 break-words text-xs text-slate-500" data-ai-story-sources>Sources: ${all.slice(0, 3).join(' · ')}${all.length > 3
    ? `<details class="mt-1"><summary class="cursor-pointer text-indigo-700">${all.length - 3} more sources</summary><div class="mt-1">${all.slice(3).join(' · ')}</div></details>` : ''}</div>`;
}
function storyHistoryMarkup(event) {
  if (!event.storyHistory?.length) return '';
  const history = [...event.storyHistory].sort((a, b) => b.reports[0].day.localeCompare(a.reports[0].day));
  return `<details data-ai-story-history class="mb-2 break-words text-xs text-slate-500"><summary class="cursor-pointer text-indigo-700">Story history · ${history.length} other ${history.length === 1 ? 'development' : 'developments'}</summary>
    ${history.map(item => `<div class="mt-2"><p>${escapeHtml(fmtDay(item.reports[0].day))} · ${escapeHtml(item.reports[0].headline)}</p>${storySourcesMarkup(item.reports)}</div>`).join('')}
    <p>Earlier source records remain in All Alerts.</p></details>`;
}

/**
 * One evidence click, one traceable destination.
 *
 * Upstream http(s) links win because they are the closest available public record. If a source did
 * not carry a link, route to the dashboard tab that owns the feed instead of making the card look
 * clickable while taking the reader only to another AI summary.
 */
export function evidenceDestination(event = {}, scope = 'portfolio') {
  if (event.feed === 'chatter' || event.feed === 'chatter-posts') {
    const params = new URLSearchParams({ scope: String(scope || 'portfolio'), open: 'mentions' });
    if (event.ticker) params.set('company', String(event.ticker));
    const topic = chatterTopic(event);
    if (topic) params.set('topic', topic);
    return { href: `#/research/public-chatter?${params}`, external: false,
      label: 'Read mentions →', ariaLabel: `Open public mentions for ${event.company || event.ticker || 'this company'}` };
  }
  const external = safeSourceUrl(event.url);
  if (external) {
    return {
      href: external,
      external: true,
      label: 'Source ↗',
      ariaLabel: `Open original source for ${event.headline || 'this evidence'}`,
    };
  }

  const tab = /^[a-z0-9-]+$/.test(String(event.tab || '')) ? String(event.tab) : 'daily-alerts';
  const params = new URLSearchParams({ scope: String(scope || 'portfolio') });
  if (event.ticker) params.set('company', String(event.ticker));
  return {
    href: `#/research/${tab}?${params}`,
    external: false,
    label: 'Dashboard →',
    ariaLabel: `Open ${event.feedLabel || event.feed || 'evidence'} in the dashboard`,
  };
}

/** Source URLs originate upstream. Render only ordinary web links, never an executable scheme. */
export function safeSourceUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value), location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * The cards this reader should see now: the chosen priority band, minus what they have muted.
 *
 * A MUTE IS CHECKED AGAINST THE EVIDENCE ON THE CARD RIGHT NOW, not against the ticker alone —
 * `ai-mute.js` explains why. A company with new material evidence
 * comes back on its own, so muting can hide what has been read and can never hide what has not.
 */
function filteredCards(cards) {
  const archived = (card) => mute.isHidden(card.key || card.ticker, card.evidenceKey || card.topEvent?.id || '');
  if (filter === 'archived') return cards.filter(archived);
  const byPriority = filter === 'all' ? cards : cards.filter((card) => card.priority === filter);
  return byPriority.filter((card) => !archived(card));
}

function wire(ctx, total) {
  if (bookmarkRoot !== ctx.root) {
    offBookmarks?.();
    bookmarkRoot = ctx.root;
    offBookmarks = wireBookmarks(ctx.root, button => {
      if (ctxRef?.root !== ctx.root || !ctx.root.contains(button)) return null;
      const model = report?.allCards || report?.cards || [];
      const owner = button.closest('[data-ai-key]')?.dataset.aiKey;
      const card = model.find(card => String(card.key || card.ticker || card.entityId) === owner);
      if (!card) return null;
      const cardKey = button.closest('[data-ai-notebook-card]')?.dataset.aiNotebookCard;
      if (cardKey) return cardSnapshot(card);
      const id = button.closest('[data-ai-notebook-event]')?.dataset.aiNotebookEvent;
      const event = card.events.find(event => String(event.id) === id);
      if (!event) return null;
      // Evidence read from the precomputed pool travels without its full source record; the
      // notebook snapshot is taken from that record, fetched from the pool's own day shard.
      if (!alertPool.needsFullRecord(event)) return snapshotForRow(event, { section: 'daily-alerts' });
      return alertPool.fullRecord(event).then(record => snapshotForRow(record ? { ...event, sourceRecord: record } : event, { section: 'daily-alerts' }));
    }, { captureGuard: () => {
      const view = ctxRef, generation = actionGeneration, session = getHostContext().session;
      return () => {
        const current = getHostContext().session;
        return ctxRef === view && actionGeneration === generation &&
          current.token === session.token && current.email === session.email && current.orgId === session.orgId;
      };
    } });
  }
  const sort = ctx.root.querySelector('[data-ai-sort]');
  if (sort) sort.onchange = () => {
    if (!Object.hasOwn(SORTS, sort.value)) return;
    sortOrder = sort.value;
    try { localStorage.setItem(SORT_KEY, sortOrder); } catch { /* Keep the session preference. */ }
    visibleLimit = PAGE_SIZE;
    paint(ctxRef);
    ctxRef?.root.querySelector('[data-ai-sort]')?.focus({ preventScroll: true });
  };
  const click = (selector, handler) => { const node = ctx.root.querySelector(selector); if (node) node.onclick = handler; };
  click('[data-ai-unlock]', unlockPortfolio);
  click('[data-ai-empty-clear]', clearSearch);
  click('[data-ai-controls]', (event) => {
    const button = event.target.closest('[data-ai-filter]');
    if (!button) return;
    filter = button.dataset.aiFilter;
    visibleLimit = PAGE_SIZE;
    paint(ctxRef);
  });

  click('[data-ai-more]', () => {
    visibleLimit = Math.min(total, visibleLimit + PAGE_SIZE);
    paint(ctxRef);
  });

  click('[data-ai-cards]', (event) => {
    const muteButton = event.target.closest('[data-ai-mute]');
    if (muteButton) {
      const current = report?.allCards.find(card => String(card.key || card.ticker) === muteButton.dataset.ticker);
      if (!current) return;
      mute.hide(muteButton.dataset.ticker, current.evidenceKey || current.topEvent?.id || null);
      paint(ctxRef);
      return;
    }
    const restoreButton = event.target.closest('[data-ai-unmute]');
    if (restoreButton) {
      mute.show(restoreButton.dataset.ticker);
      paint(ctxRef);
      return;
    }
    const button = event.target.closest('[data-open-general]');
    if (!button) return;
    const ticker = button.dataset.ticker;
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(ctx.scope)}&company=${encodeURIComponent(ticker)}`;
  });

  click('[data-ai-unmute-all]', () => {
    mute.clear();
    paint(ctxRef);
  });

  click('[data-ai-empty] [data-ai-unmute-all]', () => {
    mute.clear();
    paint(ctxRef);
  });

  click('[data-ai-empty-general]', () => {
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(ctx.scope)}`;
  });
}

function emptyPanel(ctx) {
  const m = report?.meta || {};
  if (query.trim()) {
    return `<div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
      <h3 class="font-display text-lg font-bold text-slate-900">No matching alerts in this view</h3>
      <p class="mt-2 break-words text-sm text-slate-500">No results for “${escapeHtml(query.trim())}”. Try a company, symbol or keyword, or choose another priority filter.</p>
      <button type="button" data-ai-empty-clear class="mt-4 rounded-lg bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">Clear search</button>
    </div>`;
  }
  // MUTING ITS OWN LIST EMPTY IS NOT THE SAME ANSWER AS NOTHING REACHING THE THRESHOLD, and the
  // panel must not print the second over the first — that would be a claim about the feeds made on
  // the strength of a control the reader set, the same error as All Alerts' chip filter
  // emptying its own stream. So it says which, and offers the way back.
  const archivedHere = (report?.cards || []).filter((card) => mute.isHidden(card.key || card.ticker, card.evidenceKey || card.topEvent?.id || '')).length;
  if (filter === 'archived') {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl text-slate-500 ring-1 ring-slate-200">✓</div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">Nothing is archived</h3>
        <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Archive a card once you have read it and it moves here. It comes back on its own if new material information arrives.</p>
      </div>`;
  }
  if (archivedHere > 0) {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl text-slate-500 ring-1 ring-slate-200">✓</div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">You have archived everything in this view</h3>
        <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
          ${escapeHtml(formatNumber(archivedHere))} ${archivedHere === 1 ? 'company is' : 'companies are'} in the archive because you have read ${archivedHere === 1 ? 'it' : 'them'}. Each one comes back on its own if new material information arrives.
        </p>
        <button type="button" data-ai-unmute-all class="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Restore them</button>
      </div>`;
  }
  return `
    <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl text-indigo-600 ring-1 ring-indigo-100">✦</div>
      <h3 class="font-display mt-4 text-lg font-bold text-slate-900">${filter === 'all' ? 'No company crossed the priority threshold' : `No ${filter === 'must-see' ? 'must-see' : 'important'} alerts right now`}</h3>
      <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
        ${filter === 'all'
          ? `The latest ${alerts.WINDOW_DAYS}-day read found ${escapeHtml(formatNumber(m.activeCompanies || 0))} companies with events, but none reached ${alerts.MIN_SCORE} points. That is a ranked result, not a claim that nothing happened.`
          : 'The other priority level may still contain companies. Change the filter above or open the complete stream.'}
      </p>
      <button type="button" data-ai-empty-general class="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Open All Alerts</button>
    </div>`;
}

function loadingPanel() {
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100" data-ai-loading>
      <div class="flex items-center gap-3 text-sm font-semibold text-slate-600"><span class="h-2.5 w-2.5 animate-pulse rounded-full bg-indigo-500"></span>Reading and ranking the alert feeds…</div>
      <p class="mt-2 text-xs text-slate-400">Cards arrive as independent feeds finish; a slow source does not hold back the rest.</p>
    </div>`;
}

function quietFallbackPanel() {
  return `
    <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl text-indigo-600 ring-1 ring-indigo-100">✦</div>
      <h3 class="font-display mt-4 text-lg font-bold text-slate-900">Your AI Alerts will appear here</h3>
      <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Open the complete alert stream to continue reviewing recent company events.</p>
      <button type="button" data-ai-empty-general class="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Open All Alerts</button>
    </div>`;
}
