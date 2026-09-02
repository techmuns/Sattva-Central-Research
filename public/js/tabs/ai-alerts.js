// tabs/ai-alerts.js — THE SMALL, EXPLAINABLE READING LIST ABOVE GENERAL ALERTS.
//
// General Alerts is the complete chronological record. This tab deliberately is not: it groups
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

export function render(ctx) {
  ctxRef = ctx;

  if (!unsubs.length) {
    unsubs.push(
      refresh.register(REFRESH_ID, {
        label: 'AI Alerts',
        refresh: async () => {
          const before = new Set((report?.cards || []).map((card) => `${card.ticker}:${card.topEvent?.id || ''}`));
          await recollect(ctxRef, { refresh: true });
          const added = (report?.cards || []).filter((card) => !before.has(`${card.ticker}:${card.topEvent?.id || ''}`)).length;
          return { added, checked: (report?.feeds || []).filter((feed) => feed.status === 'ok').length };
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
  const token = ++loadToken;
  try {
    const next = await alerts.collect({
      scope: ctx.scope,
      holdings: coverage.holdings(),
      refresh: forceRefresh,
      onPartial: (partial) => {
        if (token !== loadToken || !ctxRef) return;
        report = partial;
        paint(ctxRef);
      },
    });
    if (token !== loadToken || !ctxRef) return;
    report = next;
    paint(ctxRef);
  } catch (err) {
    console.error('[ai-alerts] collect failed', err);
    if (token !== loadToken || !ctxRef) return;
    ctx.root.innerHTML = `${head(ctx)}${errorPanel(err)}`;
  }
}

function paint(ctx) {
  const cards = filteredCards(report?.cards || []);
  const shown = cards.slice(0, visibleLimit);
  ctx.root.innerHTML = `
    ${head(ctx)}
    ${report ? '' : loadingPanel()}
    ${report ? controls(report, cards.length) : ''}
    ${report ? cardsPanel(ctx, shown, cards.length) : ''}`;
  if (!report) return;
  wire(ctx, cards.length);
}

function head(ctx) {
  const m = report?.meta || {};
  const status = feedStatus(report);
  return sectionHead({
    title: 'AI Alerts',
    description: 'Important company signals from the last seven days.',
    meta: `<div class="flex flex-wrap items-center justify-end gap-2">
      <span data-ai-feed-status data-state="${status.state}">${pill({ label: status.label, tone: status.tone })}</span>
      ${scopeSummary({
        scope: ctx.scope,
        count: m.activeCompanies || 0,
        noun: 'companies with recent events',
        book: coverage.meta(),
      })}
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

function controls(rep, visibleCount) {
  const all = rep.cards.length;
  const mustSee = rep.cards.filter((card) => card.priority === 'must-see').length;
  const important = all - mustSee;
  const options = [
    { id: 'all', label: `All priorities · ${all}` },
    { id: 'must-see', label: `Must see · ${mustSee}` },
    { id: 'important', label: `Important · ${important}` },
  ];
  return `
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3" data-ai-controls>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Filter AI Alerts by priority">
        ${options.map((option) => `<button type="button" data-ai-filter="${option.id}" aria-pressed="${filter === option.id}"
          class="rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${filter === option.id ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-600 ring-slate-200 hover:text-indigo-700 hover:ring-indigo-200'}">${escapeHtml(option.label)}</button>`).join('')}
      </div>
      <div class="text-xs text-slate-500"><strong class="font-semibold text-slate-700">${escapeHtml(formatNumber(visibleCount))}</strong> ${visibleCount === 1 ? 'company' : 'companies'} in this view</div>
    </div>`;
}

function cardsPanel(ctx, cards, total) {
  if (!cards.length) return emptyPanel(ctx, total);
  return `
    <section class="grid gap-4 lg:grid-cols-2" data-ai-cards>
      ${cards.map((card) => cardMarkup(card, ctx.scope)).join('')}
    </section>
    ${total > cards.length ? `<div class="mt-5 text-center"><button type="button" data-ai-more class="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300">Show ${escapeHtml(formatNumber(Math.min(PAGE_SIZE, total - cards.length)))} more</button></div>` : ''}`;
}

function cardMarkup(card, scope) {
  const mustSee = card.priority === 'must-see';
  const tone = mustSee
    ? { edge: 'border-l-rose-500', badge: 'bg-rose-50 text-rose-700 ring-rose-200', label: 'Must see' }
    : { edge: 'border-l-amber-500', badge: 'bg-amber-50 text-amber-700 ring-amber-200', label: 'Important' };
  const events = card.events.slice(0, 3);
  const topSourceUrl = safeSourceUrl(card.topEvent?.url);
  return `
    <article data-ai-card data-ticker="${escapeHtml(card.ticker)}" data-priority="${escapeHtml(card.priority)}" data-score="${card.score}"
      class="flex h-full flex-col overflow-hidden rounded-2xl border-l-4 ${tone.edge} bg-white shadow-sm ring-1 ring-slate-100">
      <div class="flex-1 p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="font-display text-lg font-extrabold text-slate-900">${escapeHtml(card.company)}</h3>
              <span class="text-xs font-bold text-indigo-600">${escapeHtml(card.ticker)}</span>
              ${card.sector ? `<span class="text-xs text-slate-400">${escapeHtml(card.sector)}</span>` : ''}
              ${card.holding ? pill({ label: 'In portfolio', tone: 'accent' }) : ''}
            </div>
            <p data-ai-insight class="mt-2 max-w-5xl text-sm font-medium leading-relaxed text-slate-700">${escapeHtml(card.insight)}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ${tone.badge}">${tone.label}</span>
          </div>
        </div>

        <div class="mt-4">
          <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Evidence</div>
          <div class="mt-2 divide-y divide-slate-100 rounded-xl bg-slate-50/70 ring-1 ring-slate-100">
            ${events.map((event) => eventMarkup(event, scope)).join('')}
          </div>
          ${card.events.length > events.length ? `<p class="mt-2 text-xs text-slate-400">+ ${escapeHtml(formatNumber(card.events.length - events.length))} more recent ${card.events.length - events.length === 1 ? 'event' : 'events'} in General Alerts</p>` : ''}
        </div>
      </div>
      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
        <span class="text-xs text-slate-500">${escapeHtml(formatNumber(card.feedCount))} ${card.feedCount === 1 ? 'feed' : 'feeds'} · ${escapeHtml(formatNumber(card.events.length))} recent ${card.events.length === 1 ? 'event' : 'events'}${card.mixed ? ' · conflicting direction' : ''}</span>
        <div class="flex flex-wrap items-center gap-3">
          ${topSourceUrl ? `<a href="${escapeHtml(topSourceUrl)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-slate-600 hover:text-indigo-700">Open top source ↗</a>` : ''}
          <button type="button" data-open-general data-ticker="${escapeHtml(card.ticker)}" class="text-xs font-bold text-indigo-700 hover:text-indigo-900">See all for ${escapeHtml(card.ticker)} in General Alerts →</button>
        </div>
      </footer>
    </article>`;
}

function eventMarkup(event, scope) {
  const direction = {
    positive: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    negative: 'bg-rose-50 text-rose-700 ring-rose-200',
    neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  }[event.direction] || 'bg-slate-100 text-slate-600 ring-slate-200';
  const destination = evidenceDestination(event, scope);
  return `
    <a data-ai-event data-ai-evidence-link href="${escapeHtml(destination.href)}"
      ${destination.external ? 'target="_blank" rel="noopener noreferrer"' : ''}
      aria-label="${escapeHtml(destination.ariaLabel)}"
      class="group block p-3 transition-colors hover:bg-indigo-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">
      <div class="flex flex-wrap items-center gap-2 text-[11px]">
        <time class="font-semibold tabular-nums text-slate-500" datetime="${escapeHtml(event.day || '')}">${escapeHtml(fmtDay(event.day))}${event.time ? ` · ${escapeHtml(event.time)} IST` : ''}</time>
        <span class="font-semibold text-slate-500">${escapeHtml(event.feedLabel || event.feed)}</span>
        <span class="rounded-full px-1.5 py-0.5 font-bold uppercase ring-1 ${direction}">${escapeHtml(event.direction || 'neutral')}</span>
        ${event.importance === 'high' ? '<span class="rounded-full bg-violet-50 px-1.5 py-0.5 font-bold uppercase text-violet-700 ring-1 ring-violet-200">High</span>' : ''}
        <span class="ml-auto whitespace-nowrap font-bold text-indigo-600 group-hover:text-indigo-800">${escapeHtml(destination.label)}</span>
      </div>
      <div class="mt-1 truncate text-sm font-semibold text-slate-800" title="${escapeHtml(event.headline || '')}">${escapeHtml(event.headline || '')}</div>
      ${event.signalReason ? `<div class="mt-0.5 truncate text-xs text-slate-500" title="${escapeHtml(event.signalReason)}">${escapeHtml(event.signalReason)}</div>` : ''}
    </a>`;
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

function filteredCards(cards) {
  if (filter === 'all') return cards;
  return cards.filter((card) => card.priority === filter);
}

function wire(ctx, total) {
  ctx.root.querySelector('[data-ai-controls]')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ai-filter]');
    if (!button) return;
    filter = button.dataset.aiFilter;
    visibleLimit = PAGE_SIZE;
    paint(ctxRef);
  });

  ctx.root.querySelector('[data-ai-more]')?.addEventListener('click', () => {
    visibleLimit = Math.min(total, visibleLimit + PAGE_SIZE);
    paint(ctxRef);
  });

  ctx.root.querySelector('[data-ai-cards]')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-general]');
    if (!button) return;
    const ticker = button.dataset.ticker;
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(ctx.scope)}&company=${encodeURIComponent(ticker)}`;
  });

  ctx.root.querySelector('[data-ai-empty-general]')?.addEventListener('click', () => {
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(ctx.scope)}`;
  });
}

function emptyPanel(ctx) {
  const m = report?.meta || {};
  return `
    <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-ai-empty>
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl text-indigo-600 ring-1 ring-indigo-100">✦</div>
      <h3 class="font-display mt-4 text-lg font-bold text-slate-900">${filter === 'all' ? 'No company crossed the priority threshold' : `No ${filter === 'must-see' ? 'must-see' : 'important'} alerts right now`}</h3>
      <p class="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
        ${filter === 'all'
          ? `The latest ${alerts.WINDOW_DAYS}-day read found ${escapeHtml(formatNumber(m.activeCompanies || 0))} companies with events, but none reached ${alerts.MIN_SCORE} points. That is a ranked result, not a claim that nothing happened.`
          : 'The other priority level may still contain companies. Change the filter above or open the complete stream.'}
      </p>
      <button type="button" data-ai-empty-general class="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Open General Alerts</button>
    </div>`;
}

function loadingPanel() {
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100" data-ai-loading>
      <div class="flex items-center gap-3 text-sm font-semibold text-slate-600"><span class="h-2.5 w-2.5 animate-pulse rounded-full bg-indigo-500"></span>Reading and ranking the alert feeds…</div>
      <p class="mt-2 text-xs text-slate-400">Cards arrive as independent feeds finish; a slow source does not hold back the rest.</p>
    </div>`;
}

function errorPanel(err) {
  return `<div class="rounded-2xl bg-rose-50 p-5 text-sm text-rose-800 ring-1 ring-rose-200" data-ai-error>AI Alerts could not rank the feeds: ${escapeHtml(err?.message || String(err))}</div>`;
}

function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day || '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
