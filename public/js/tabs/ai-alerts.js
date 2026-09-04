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
  // Counted over what is ACTUALLY archived out of this view, not over the whole store: an entry
  // whose evidence has been overtaken is no longer hiding anything, and reporting it as archived
  // would send the reader looking for a card that is already back on the page.
  const archived = rep.cards.filter((card) => mute.isHidden(card.ticker, card.topEvent?.id || '')).length;
  const options = [
    { id: 'all', label: `All priorities · ${all - archived}` },
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
        <span><strong class="font-semibold text-slate-700">${escapeHtml(formatNumber(visibleCount))}</strong> ${visibleCount === 1 ? 'company' : 'companies'} in this view</span>
      </div>
    </div>`;
}

function cardsPanel(ctx, cards, total) {
  if (!cards.length) return emptyPanel(ctx, total);
  return `
    <section class="grid gap-4 lg:grid-cols-2" data-ai-cards>
      ${cards.map((card) => cardMarkup(card, ctx.scope, report?.day, filter === 'archived')).join('')}
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
        <span class="mt-0.5 shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-400" title="${escapeHtml(`${event.feedLabel || event.feed} · ${when}`)}">${escapeHtml(tag)} · ${escapeHtml(age)}</span>
      </a>
    </li>`;
}

/** Day-resolution age. Never finer than the feed publishes — see `eventMarkup`. */
export function relativeAge(eventDay, throughDay) {
  const from = Date.parse(`${eventDay}T00:00:00Z`);
  const to = Date.parse(`${throughDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
  const days = Math.max(0, Math.round((to - from) / 86_400_000));
  return days === 0 ? 'today' : `${days}d`;
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

  ctx.root.querySelector('[data-ai-unmute-all]')?.addEventListener('click', () => {
    mute.clear();
    paint(ctxRef);
  });

  ctx.root.querySelector('[data-ai-empty] [data-ai-unmute-all]')?.addEventListener('click', () => {
    mute.clear();
    paint(ctxRef);
  });

  ctx.root.querySelector('[data-ai-empty-general]')?.addEventListener('click', () => {
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(ctx.scope)}`;
  });
}

function emptyPanel(ctx) {
  const m = report?.meta || {};
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

function errorPanel(err) {
  return `<div class="rounded-2xl bg-rose-50 p-5 text-sm text-rose-800 ring-1 ring-rose-200" data-ai-error>AI Alerts could not rank the feeds: ${escapeHtml(err?.message || String(err))}</div>`;
}

function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day || '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
