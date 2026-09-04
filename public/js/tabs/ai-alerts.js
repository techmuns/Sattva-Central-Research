// tabs/ai-alerts.js — THE SMALL, EXPLAINABLE READING LIST ABOVE ALL ALERTS.
//
// All Alerts is the complete chronological record. This tab deliberately is not: it groups
// the last seven days by company, ranks the material company-specific evidence, and suppresses
// names that do not cross the published threshold. The ranking lives in data/ai-alerts.js so the
// product rules are pure, testable and available to exports or notifications later.

import { sectionHead } from '../ui/screener.js';
import { scopeSummary, pill } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import * as refresh from '../core/refresh.js';
import * as alerts from '../data/ai-alerts.js';
import * as coverage from '../data/coverage.js';
import * as mute from '../core/ai-mute.js';
import { currentDay, relativeAge, formatDay as fmtDay, latestSignal, matchesSearch } from '../ui/ai-alert-utils.js';
import { privatePortfolioContext, readPositionSizes, onPortfolioInvalidation, onPortfolioReady, onPortfolioConnection, portfolioConnectionState, unlockPortfolio } from '../research/portfolio-bridge.js';
export { relativeAge } from '../ui/ai-alert-utils.js';

export const meta = {
  id: 'ai-alerts',
  title: 'AI Alerts',
  subtitle: 'Important portfolio events from the last seven days.',
  subviews: [],
};

const REFRESH_ID = 'ai-alerts';
const PAGE_SIZE = 8;

let ctxRef = null;
let report = null;
let loadToken = 0;
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

// Keep a completed view in memory across tab visits. This lifetime listener also
// revokes that cached private view if access expires while another tab is open.
onPortfolioInvalidation((version) => {
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
    if (ctxRef.scope !== 'portfolio') { void recollect(ctxRef); return; }
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
  if (report) report = alerts.rankReport({ scope: report.scope, day: report.day,
    feeds: report.feeds, events: report.allCards.flatMap(card => card.events) }, { holdings: coverage.holdings() });
  paint(ctxRef);
}

export function render(ctx) {
  ctxRef = ctx;

  if (!unsubs.length) {
    unsubs.push(watchCalendar());
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
          const before = new Set((report?.cards || []).map((card) => `${card.ticker}:${card.topEvent?.id || ''}`));
          await recollect(ctxRef, { refresh: true });
          if (sizeError || loadError) throw new Error(sizeError || loadError);
          const added = (report?.cards || []).filter((card) => !before.has(`${card.ticker}:${card.topEvent?.id || ''}`)).length;
          return { added, checked: (report?.feeds || []).filter((feed) => feed.status === 'ok').length,
            failed: (report?.feeds || []).filter((feed) => feed.status === 'failed').length };
        },
      })
    );
  }

  if (report && report.scope !== ctx.scope) {
    report = null;
    visibleLimit = PAGE_SIZE;
  }

  paint(ctx);
  recollect(ctx);
}

export function destroy() {
  sizeController?.abort();
  sizeController = null;
  sizesLoading = false;
  sizeError = '';
  awaitingBook = null;
  collecting = false;
  loadError = '';
  ctxRef = null;
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

async function recollect(ctx, { refresh: forceRefresh = false } = {}) {
  if (!ctx) return;
  const token = ++loadToken;
  const keepResults = !!report;
  sizeController?.abort();
  sizeController = null;
  sizesLoading = false;
  collecting = true;
  sizeError = loadError = '';
  awaitingBook = null;
  const current = () => token === loadToken && !!ctxRef;

  // Public evidence can load while the private connector checks holding sizes.
  // A slow or unavailable size reader must not hold the first alert hostage.
  let positions = Promise.resolve(null);
  if (ctx.scope === 'portfolio' && privatePortfolioContext()) {
    const controller = new AbortController();
    sizeController = controller;
    sizesLoading = true;
    positions = readPositionSizes(controller.signal).catch((err) => {
      if (current()) sizeError = err?.message || 'Your active portfolio could not be read. Please refresh.';
      return null;
    }).finally(() => {
      if (current()) { sizesLoading = false; sizeController = null; }
    });
  }
  paint(ctx);
  try {
    const [next, positionSizes] = await Promise.all([
      alerts.collect({
        scope: ctx.scope,
        holdings: coverage.holdings(),
        refresh: forceRefresh,
        onPartial: (partial) => {
          // Refresh a populated view atomically; partial feeds otherwise remove
          // companies and reorder cards underneath the reader on every arrival.
          if (!current() || keepResults) return;
          report = partial;
          paint(ctxRef);
        },
      }),
      positions,
    ]);
    if (!current()) return;
    // The checked book can contain additions/exits since collection began. Read
    // the now-loaded feeds against that book without another network refresh.
    const completed = positionSizes ? await alerts.collect({ scope: ctx.scope,
      holdings: coverage.holdings(), positionSizes, load: false }) : next;
    if (!current()) return;
    report = completed;
  } catch (err) {
    if (!current()) return;
    loadError = err?.message || 'The alert feeds could not be refreshed.';
  } finally {
    if (current()) { collecting = false; paint(ctxRef); }
  }
}

function paint(ctx) {
  const matches = (report?.cards || []).filter((card) => matchesSearch(card, query));
  const cards = filteredCards(matches);
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
  ctx.root.querySelector('[data-ai-heading]').innerHTML = head(ctx);
  ctx.root.querySelector('[data-ai-position-status]').innerHTML = positionStatus(ctx);
  ctx.root.querySelector('[data-ai-clear]').hidden = !query.length;
  // Identical results keep their DOM, expanded evidence and keyboard focus.
  for (const [selector, markup] of [
    ['[data-ai-toolbar]', report ? controls(matches, cards.length) : ''],
    ['[data-ai-results]', report ? cardsPanel(ctx, shown, cards.length) : loadError ? quietFallbackPanel() : loadingPanel()],
  ]) {
    const node = ctx.root.querySelector(selector);
    if (node._markup !== markup) { node.innerHTML = markup; node._markup = markup; }
  }
  wire(ctx, cards.length);
}

function positionStatus(ctx) {
  if (ctx.scope !== 'portfolio') return '';
  if (sizesLoading || awaitingBook !== null) return `<p class="mb-4 text-xs text-slate-500" role="status">${report ? 'Updating holdings in the background — current alerts remain available.' : 'Checking holding sizes…'}</p>`;
  const sizes = report?.meta?.positionSizes;
  if (sizes) {
    const prices = sizes.quotes?.notLive > 0 || sizes.quotes?.status !== 'live' ? 'Some prices use workbook marks' : 'Quote freshness varies by stock';
    return `<p data-ai-size-note class="mb-4 text-xs text-slate-500" title="${escapeHtml(`Portfolio checked ${sizes.checkedAt}. Quote batch ${sizes.quotes?.asOf || 'unavailable'}. Percentages include all held equities, ETFs and liquid positions in the listed book.`)}">
      <strong class="font-semibold text-slate-700">${report.meta.sortedByHolding ? 'Largest holdings first' : 'Ordered by alert priority'}</strong> · % of listed portfolio · Book ${fmtDay(sizes.bookAsOf)} · ${prices}
    </p>`;
  }
  return `<p class="mb-4 text-xs text-slate-500">Ordered by alert priority${portfolioConnectionState() === 'locked' ? ' · <button type="button" data-ai-unlock class="font-semibold text-indigo-700 hover:underline">Unlock portfolio to include holding sizes</button>' : ''}</p>`;
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
    if (!ctxRef || document.hidden || currentDay() === day) return;
    day = currentDay();
    for (const el of ctxRef.root.querySelectorAll('[data-ai-age]')) {
      el.textContent = relativeAge(el.dataset.day, day);
    }
    // Re-rank and drop evidence that has left the seven-day window as well as updating labels.
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

function head(ctx) {
  const m = report?.meta || {};
  // Connector and refresh failures stay available to the refresh controller for diagnostics, but
  // this customer-facing queue falls back quietly instead of turning infrastructure into an alert.
  const status = (loadError || sizeError) ? { label: report ? 'Latest available' : 'AI Alerts', tone: 'neutral', state: 'complete' }
    : report && (collecting || awaitingBook !== null) ? { label: 'Updating…', tone: 'neutral', state: 'pending' } : feedStatus(report);
  return sectionHead({
    title: 'AI Alerts',
    description: 'Important company signals from the last seven days.',
    meta: `<div class="flex flex-wrap items-center justify-end gap-2">
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
  const active = cards.filter((card) => !mute.isHidden(card.ticker, card.topEvent?.id || ''));
  const mustSee = active.filter((card) => card.priority === 'must-see').length;
  const important = active.length - mustSee;
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
      <div class="flex items-center gap-3 text-xs text-slate-500">
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
    <div data-ai-confluence class="mt-3 flex flex-wrap items-center gap-1.5">
      ${found
        .map(
          (pattern) => `<span data-confluence="${escapeHtml(pattern.id)}" title="${escapeHtml(`${pattern.label} — ${pattern.detail}`)}"
            class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-100">${escapeHtml(pattern.short || pattern.label)}</span>`
        )
        .join('')}
    </div>`;
}

const METRIC_TONE = {
  positive: 'text-emerald-600',
  negative: 'text-rose-600',
  neutral: 'text-slate-900',
};

/** The four figures behind the sentence, as figures. See `cardMetrics` for why volume has no tone. */
function metricsMarkup(card) {
  const cells = card.metrics || [];
  if (!cells.length) return '';
  return `
    <div data-ai-metrics class="mt-4 grid grid-cols-4 divide-x divide-slate-100 rounded-xl bg-slate-50/70 ring-1 ring-slate-100">
      ${cells
        .map(
          (cell) => `<div data-metric="${escapeHtml(cell.id)}" title="${escapeHtml(cell.title || '')}" class="min-w-0 px-3 py-2.5">
            <div class="truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(cell.label)}</div>
            <div class="truncate text-base font-extrabold tabular-nums ${METRIC_TONE[cell.tone] || METRIC_TONE.neutral}">${escapeHtml(cell.value)}</div>
          </div>`
        )
        .join('')}
    </div>`;
}

function cardMarkup(card, scope, day, archived = false) {
  const badge = card.badge || { id: 'important', label: 'Important', tone: 'neutral' };
  const tone = {
    negative: { edge: 'border-l-rose-500', badge: 'bg-rose-600 text-white ring-rose-600' },
    caution: { edge: 'border-l-amber-500', badge: 'bg-white text-amber-700 ring-amber-300' },
    neutral: { edge: 'border-l-slate-300', badge: 'bg-white text-slate-600 ring-slate-200' },
  }[badge.tone] || { edge: 'border-l-slate-300', badge: 'bg-white text-slate-600 ring-slate-200' };
  const events = alerts.topEvidence(card, 3);
  const rest = card.events.length - events.length;
  const signal = latestSignal(card.events);
  return `
    <article data-ai-card data-ticker="${escapeHtml(card.ticker)}" data-priority="${escapeHtml(card.priority)}" data-score="${card.score}"${archived ? ' data-ai-archived' : ''}
      class="flex h-full flex-col overflow-hidden rounded-2xl border-l-4 ${archived ? 'border-l-slate-200' : tone.edge} bg-white shadow-sm ring-1 ring-slate-100">
      <div class="flex-1 p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="font-display truncate text-lg font-extrabold leading-tight text-slate-900">${escapeHtml(card.company)}</h3>
            <div class="mt-0.5 truncate text-[11px] font-bold uppercase tracking-wider text-slate-400">
              ${escapeHtml(card.ticker)}${card.sector ? ` · ${escapeHtml(card.sector)}` : ''}${card.holding ? ' · In portfolio' : ''}
            </div>
          </div>
          <span class="shrink-0 rounded-md px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${tone.badge}">${escapeHtml(badge.label)}</span>
        </div>

        <p data-ai-date class="mt-2 text-xs leading-relaxed text-slate-500" title="Date of the newest source event behind this alert. Times are shown only when every event on that date has a source time; all dates use IST.">
          ${signal ? `Latest signal · <time datetime="${escapeHtml(signal.datetime)}"><span data-ai-age data-day="${signal.day}" class="font-semibold capitalize text-slate-600">${relativeAge(signal.day, day)}</span> · ${fmtDay(signal.day)}${signal.time ? ` · ${signal.time} IST` : ''}</time>` : 'Signal date unavailable'}
        </p>
        ${Number.isFinite(card.holdingWeightPct) ? `<p data-ai-holding-size class="mt-1 text-xs font-semibold text-indigo-700">${card.holdingWeightPct > 0 && card.holdingWeightPct < 0.01 ? '&lt;0.01' : card.holdingWeightPct.toLocaleString('en-IN', { maximumFractionDigits: 2 })}% of listed portfolio</p>` : ''}

        <p data-ai-insight class="font-display mt-3 text-[17px] font-bold leading-snug text-slate-900">${escapeHtml(card.insight)}</p>

        ${confluenceMarkup(card)}
        ${metricsMarkup(card)}

        <ul data-ai-evidence class="mt-4 space-y-2">
          ${events.map((event) => eventMarkup(event, scope, day)).join('')}
        </ul>
      </div>
      <footer class="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
        ${rest > 0
          ? `<button type="button" data-open-general data-ticker="${escapeHtml(card.ticker)}" class="text-xs font-bold text-indigo-700 hover:text-indigo-900">${escapeHtml(formatNumber(rest))} more ${rest === 1 ? 'event' : 'events'} →</button>`
          : `<span class="text-xs text-slate-400">Everything on this company is above</span>`}
        <div class="flex shrink-0 items-center gap-2">
          ${archived
            ? `<button type="button" data-ai-unmute data-ticker="${escapeHtml(card.ticker)}"
                class="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition hover:ring-indigo-300">Restore</button>`
            : `<button type="button" data-ai-mute data-ticker="${escapeHtml(card.ticker)}" data-seen="${escapeHtml(card.topEvent?.id || '')}"
                class="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:text-slate-900 hover:ring-slate-300">Archive</button>`}
          <button type="button" data-open-general data-ticker="${escapeHtml(card.ticker)}"
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
  return `
    <li>
      <a data-ai-event data-ai-evidence-link href="${escapeHtml(destination.href)}"
        ${destination.external ? 'target="_blank" rel="noopener noreferrer"' : ''}
        aria-label="${escapeHtml(destination.ariaLabel)}"
        class="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-indigo-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[event.direction] || DOT_TONE.neutral}" aria-hidden="true"></span>
        <span class="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-slate-700 group-hover:text-slate-900" title="${escapeHtml(event.headline || '')}">${escapeHtml(claim)}</span>
        <span class="mt-0.5 shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-400" title="${escapeHtml(`${event.feedLabel || event.feed} · ${when}`)}">${escapeHtml(tag)} · <time data-ai-age data-day="${escapeHtml(event.day)}" datetime="${escapeHtml(event.day)}">${escapeHtml(age)}</time></span>
      </a>
    </li>`;
}

/**
 * One evidence click, one traceable destination.
 *
 * Upstream http(s) links win because they are the closest available public record. If a source did
 * not carry a link, route to the dashboard tab that owns the feed instead of making the card look
 * clickable while taking the reader only to another AI summary.
 */
export function evidenceDestination(event = {}, scope = 'portfolio') {
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
 * `ai-mute.js` explains why. A company whose strongest event has been overtaken by something newer
 * comes back on its own, so muting can hide what has been read and can never hide what has not.
 */
function filteredCards(cards) {
  const archived = (card) => mute.isHidden(card.ticker, card.topEvent?.id || '');
  if (filter === 'archived') return cards.filter(archived);
  const byPriority = filter === 'all' ? cards : cards.filter((card) => card.priority === filter);
  return byPriority.filter((card) => !archived(card));
}

function wire(ctx, total) {
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
      mute.hide(muteButton.dataset.ticker, muteButton.dataset.seen || null);
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
  const archivedHere = (report?.cards || []).filter((card) => mute.isHidden(card.ticker, card.topEvent?.id || '')).length;
  if (filter === 'archived') {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl text-slate-500 ring-1 ring-slate-200">✓</div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">Nothing is archived</h3>
        <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Archive a card once you have read it and it moves here. It comes back on its own if stronger evidence arrives.</p>
      </div>`;
  }
  if (archivedHere > 0) {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl text-slate-500 ring-1 ring-slate-200">✓</div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">You have archived everything in this view</h3>
        <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
          ${escapeHtml(formatNumber(archivedHere))} ${archivedHere === 1 ? 'company is' : 'companies are'} in the archive because you have read ${archivedHere === 1 ? 'it' : 'them'}. Each one comes back on its own if stronger evidence arrives.
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
