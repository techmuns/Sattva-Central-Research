// tabs/daily-alerts.js — ALL ALERTS, THE COMPLETE CHRONOLOGICAL STREAM.
//
// Every other tab here is organised by SOURCE: this is what the results feed holds, this is what
// BSE filed, this is what the technicals scrape measured. That is the right shape for research and
// the wrong shape for prioritisation, when the question is not "what does Moneycontrol have" but
// "what happened, and does any of it need me". AI Alerts answers that narrower question. This tab
// remains the complete TIME view: one stream, with retained history and forward schedules kept in
// separate, explicit horizons.
//
// See js/data/daily-alerts.js, where the readings are taken and each source's scope rule is written
// down. The authenticated S Screen calendar is portfolio-only by construction.
//
// ---------------------------------------------------------------------------------------
// DIRECTION AND IMPORTANCE ARE SEPARATE. Green/red/grey reproduce an explicit source band,
// transaction direction, or the conservative rule printed beside the row. High/Low is a second
// badge driven by the stated thresholds in data/daily-alerts.js. Neither is left unexplained.
//
// ---------------------------------------------------------------------------------------
// THE COVERAGE PANEL IS NOT DECORATION — IT IS THE HALF THAT MAKES AN EMPTY DAY READABLE
//
// Most of these feeds are committed captures on a best-effort schedule. So a bucket with nothing in
// it has two completely different meanings — nobody filed, or nothing has looked at today yet — and
// a consolidated page that showed only the events would present the second as the first on every
// weekend, every holiday and every morning before the scrapes run. `Feeds read for this day` states,
// per feed, when it last looked and whether that reaches today. It is the same rule as the filings
// tabs' "63 companies have not been checked since": never claim nothing is new.

import { scoreTable, sectionHead } from '../ui/screener.js';
import { scopeSummary, pill } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as refresh from '../core/refresh.js';
import * as alerts from '../data/daily-alerts.js';
import * as coverage from '../data/coverage.js';
import { scopeLabel } from '../data/scope.js';
import * as records from '../data/alert-records.js';

export const meta = {
  id: 'daily-alerts',
  title: 'All Alerts',
  subtitle: 'Every retained alert and loaded portfolio schedule in one time view.',
  // No rail. This is one stream and splitting it by feed would rebuild the tabs it exists to
  // collapse — the feed filter in the toolbar does that job without costing a navigation.
  subviews: [],
};

const REFRESH_ID = 'daily-alerts';

// ---------------------------------------------------------------------------------------
// Module state
//
// `ctxRef` IS THE LIFECYCLE GUARD, and it is the thing the shell actually owns: `render()` runs
// again on every scope change, so a subscription guarded by a token captured inside one render is
// alive until the reader touches the scope toggle and dead afterwards (CLAUDE.md, the module
// interface contract). Every handler below re-reads `ctxRef` instead of closing over a ctx.
// ---------------------------------------------------------------------------------------
let ctxRef = null;
let report = null; // the last collected report
let loadToken = 0;
let unsubs = [];
const HORIZON = { THROUGH: 'through', UPCOMING: 'upcoming' };
let horizon = HORIZON.THROUGH;
let renderedHorizon = HORIZON.THROUGH;
let tableViews = { [HORIZON.THROUGH]: null, [HORIZON.UPCOMING]: null }; // one view per time horizon
let routeCompany = null; // a company deep-link supplied by an AI Alert card
// WHICH FEEDS ARE TICKED. `null` means All — deliberately not "a Set holding every id", because
// those are different claims the moment a feed appears or disappears: All keeps meaning all, while
// a full Set silently becomes a partial filter when a sixth feed is added. The same distinction
// `scopeTickers` draws between `null` and an empty Set, for the same reason.
let picked = null;
let collecting = 0;
let sourceTimer = null;
let sourceDirty = false;
function sourceChanged() {
  sourceDirty = true;
  if (!ctxRef || sourceTimer || collecting) return;
  sourceTimer = setTimeout(() => {
    sourceTimer = null; sourceDirty = false;
    if (ctxRef) void recollect(ctxRef, { load: false });
  }, 250);
}

export function render(ctx) {
  ctxRef = ctx;

  // AI ALERTS LINKS TO THE COMPLETE EVIDENCE FOR ONE COMPANY. Seed the existing table search
  // rather than inventing a second company filter. Entering through that link resets an earlier
  // All Alerts filter state: "See all" cannot quietly retain e.g. Today-only or one feed and
  // then show an empty subset. Subsequent feed repaints retain the new table's own state as usual.
  const requestedCompany = String(ctx.params?.company || '').trim();
  if (requestedCompany && requestedCompany !== routeCompany) {
    horizon = HORIZON.THROUGH;
    tableViews = { [HORIZON.THROUGH]: { q: requestedCompany }, [HORIZON.UPCOMING]: { q: requestedCompany } };
  } else if (!requestedCompany && routeCompany) {
    tableViews = {
      [HORIZON.THROUGH]: { ...(tableViews[HORIZON.THROUGH] || {}), q: '' },
      [HORIZON.UPCOMING]: { ...(tableViews[HORIZON.UPCOMING] || {}), q: '' },
    };
  }
  routeCompany = requestedCompany || null;

  if (!unsubs.length) {
    unsubs.push(alerts.onChange(sourceChanged));
    unsubs.push(records.onChange(() => {
      // Remove private rows synchronously, even while another public source is still loading.
      if (report) { report = { ...report, events: report.events.filter((r) => !r.private) }; if (ctxRef) paint(ctxRef); }
      sourceChanged();
    }));
    const timer = setInterval(() => {
      if (ctxRef && !collecting && !document.hidden) void recollect(ctxRef, { refresh: true });
    }, 90000);
    unsubs.push(() => clearInterval(timer));
    unsubs.push(
      refresh.register(REFRESH_ID, {
        label: 'All Alerts',
        // A REFRESH HERE COSTS NOTHING PER COMPANY. Earnings, con-calls and chatter each expose a
        // bounded one-shot revalidation; investors revalidate the one bulk snapshot. The owning
        // Super Investors tab keeps the deliberate ninety-one-book walk behind its own control.
        refresh: async () => {
          const before = new Set((report?.events || []).map((e) => e.id));
          await recollect(ctxRef, { refresh: true });
          const now = report?.events || [];
          // IDENTITIES, NEVER SIZES. A count cannot answer "did anything change" for a collection
          // that can gain and lose rows in the same read — the day rolls over, a capture lands, a
          // story drops off the end. Same rule, and same failure, as the news Fetch button.
          const added = now.filter((e) => !before.has(e.id)).length;
          return { added, checked: (report?.feeds || []).filter((f) => f.status === 'ok').length,
            failed: (report?.feeds || []).filter((f) => f.status === 'failed').length };
        },
      })
    );
  }

  // A REPORT FOR ANOTHER SCOPE IS NOT A HEAD START, IT IS THE WRONG ANSWER. `render()` runs again
  // on every scope change and the module keeps its last report so a return visit paints instantly
  // — but that report was collected FOR a scope, and painting Universe's rows under a Portfolio
  // pill for the second before the new collect lands is the page stating something untrue.
  if (report && report.scope !== ctx.scope) report = null;

  // Paint immediately with whatever is already collected, then collect. A tab that renders nothing
  // until every feed has answered is a blank timeline.
  paint(ctx);
  // Opening or returning to a tab is navigation, not an explicit refresh.
  // Loaders reuse their retained snapshots; the 90-second cadence and header
  // Refresh remain the two places that deliberately revalidate everything.
  recollect(ctx);
}

export function destroy() {
  ctxRef = null;
  loadToken++;
  clearTimeout(sourceTimer); sourceTimer = null; sourceDirty = false;
  cancelThrottledPaint();
  for (const off of unsubs) {
    try {
      off && off();
    } catch (err) {
      console.error('[daily-alerts] cleanup failed', err);
    }
  }
  unsubs = [];
}

/**
 * Re-read every feed and repaint.
 *
 * `loadToken` closes the obvious race: a scope change while a collect is in flight would otherwise
 * paint the previous scope's rows over the new one. The token is compared against the module's
 * counter, not against a captured ctx, for the same reason the subscriptions are.
 */
async function recollect(ctx, { refresh: forceRefresh = false, load = true } = {}) {
  // NO "already collecting" EARLY RETURN. `render()` runs again on every scope change, so bailing
  // out because a collect was in flight would leave the new scope showing the old scope's rows for
  // ever — the guard has to be about which result is allowed to PAINT, not about which reads are
  // allowed to start. Every read below is a conditional GET against a file or a cached route, so
  // an overlapping one costs a revalidation, not a download.
  const token = ++loadToken;
  collecting++;
  try {
    const next = await alerts.collect({
      scope: ctx.scope,
      holdings: coverage.holdings(),
      // The source snapshots already retain history. The old tab threw those rows away with
      // `date === today`; the timeline keeps them and lets the table reveal older days as its
      // internal scroller advances. No request per company and no new route are introduced.
      includeHistory: true,
      refresh: forceRefresh,
      load,
      // Feeds land one at a time and the page follows them. Coalesced, because eight arrivals is
      // eight full rebuilds of a table the reader may be typing into — a TRAILING THROTTLE rather
      // than a debounce, since a debounce would keep deferring while feeds kept landing and the
      // page would sit still until the slowest of them finished, which is the thing this exists to
      // stop. The final report below paints immediately, so the settled state never waits on a timer.
      onPartial: (partial) => {
        if (token !== loadToken || !ctxRef) return;
        report = partial;
        throttledPaint();
      },
    });
    if (token !== loadToken || !ctxRef) return;
    cancelThrottledPaint();
    report = next;
    paint(ctxRef);
  } catch (err) {
    console.error('[daily-alerts] collect failed', err);
  } finally {
    collecting--;
    if (sourceDirty) sourceChanged();
  }
}

// ---- the trailing throttle ------------------------------------------------------------
const PAINT_COALESCE_MS = 250;
let paintTimer = null;
let paintedAt = 0;

function throttledPaint() {
  const wait = Math.max(0, PAINT_COALESCE_MS - (Date.now() - paintedAt));
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paintedAt = Date.now();
    if (ctxRef) paint(ctxRef);
  }, wait);
}

function cancelThrottledPaint() {
  if (paintTimer) clearTimeout(paintTimer);
  paintTimer = null;
  paintedAt = Date.now();
}


// ---------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------

function paint(ctx) {
  const day = report?.day || alerts.today();
  const events = report?.events || [];
  const feeds = report?.feeds || [];
  const m = report?.meta || {};

  // THE FEEDS ON OFFER, AND THEN THE ONES TICKED. Market-wide news carries no company, so under a
  // narrowed scope it contributes nothing and is not shown as a filter — the reason it is absent
  // stays in the source registry. Dropping the chip is not dropping the claim.
  const scopedFeeds = feeds.filter((f) => f.portfolioOnly ? ctx.scope === 'portfolio' : ctx.scope === 'universe' || f.scopable !== false);
  // Upcoming is a purpose-built calendar, so its source picker contains only sources that can
  // actually schedule something. A historical news or insider checkbox with no possible row is
  // clutter, not transparency; the complete source account returns under Till Today.
  const shown = horizon === HORIZON.UPCOMING
    ? scopedFeeds.filter((f) => ['earnings-calendar', 'scheduled-concalls', 'screener-portfolio-upcoming'].includes(f.id) || f.events.some((event) => isUpcomingEvent(event, day)))
    : scopedFeeds;
  const available = shown.map((f) => f.id);
  // A SELECTION THAT SURVIVES A REPAINT BUT NOT A VANISHED FEED. Rows land while feeds settle and
  // every arrival repaints, so the ticks live in the module; but a scope change can take a feed
  // off the page entirely, and a tick on a feed that is no longer offered would filter the stream
  // to nothing with no visible control explaining why.
  if (picked) {
    picked = new Set([...picked].filter((id) => available.includes(id)));
    if (!picked.size || picked.size === available.length) picked = null;
  }
  const feedVisible = picked ? events.filter((e) => picked.has(e.feed)) : events;
  const periodEvents = feedVisible.filter((event) => horizon === HORIZON.UPCOMING ? isUpcomingEvent(event, day) : !isUpcomingEvent(event, day));
  const visible = horizon === HORIZON.UPCOMING ? collapseUpcoming(periodEvents) : periodEvents;
  const allUpcoming = collapseUpcoming(events.filter((event) => isUpcomingEvent(event, day)));
  const allThrough = events.filter((event) => !isUpcomingEvent(event, day));
  const displayFeeds = shown.map((feed) => ({
    ...feed,
    count: feed.events.filter((event) => horizon === HORIZON.UPCOMING ? isUpcomingEvent(event, day) : !isUpcomingEvent(event, day)).length,
    todayCount: feed.events.filter((event) => event.day === day && (horizon === HORIZON.UPCOMING ? isUpcomingEvent(event, day) : !isUpcomingEvent(event, day))).length,
  }));

  const focus = captureFocus(ctx.root);
  // Preserve the visible row across live repaints inside one horizon, but never carry a deep
  // history scroll offset into the much shorter forward calendar (or vice versa).
  const tablePosition = renderedHorizon === horizon ? captureTablePosition(ctx.root) : null;
  const table = eventsTable(ctx, visible, day, horizon, tableViews[horizon], tablePosition);
  tableViews[horizon] = table.view;

  // NO DESCRIPTION AND NO STAT STRIP. The four cards were the loudest version of
  // the problem: three of them counted rows the table beneath them already lists, and the fourth
  // printed a date the pill now carries. The pill is deliberately passive; full provenance stays
  // in the source registry and export — see the stat-strip opt-out rule in CLAUDE.md.
  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'All Alerts',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(report, day)}${pendingPill(report)}${scopeSummary({
        scope: ctx.scope,
        count: m.companies || 0,
        noun: 'companies in loaded history',
        book: coverage.meta(),
      })}${horizon === HORIZON.UPCOMING ? calendarPill(allUpcoming) : historyPill(m)}</div>`,
    })}
    ${horizonToggle(allThrough.length, allUpcoming.length, day)}
    ${coveragePanel(displayFeeds, horizon === HORIZON.UPCOMING ? allUpcoming.length : allThrough.length)}
    ${table.html}`;

  table.wire(ctx.root);
  wireHorizon(ctx);
  wireFeedFilter(ctx, available);
  fitStreamToViewport(ctx.root);
  restoreTablePosition(ctx.root, tablePosition);
  renderedHorizon = horizon;
  restoreFocus(ctx.root, focus);
}

/**
 * Preserve the row the reader is looking at while live feeds repaint the stream.
 *
 * Saving scrollTop alone is wrong when a newly arrived alert is inserted above the viewport: the
 * same pixel offset would now point at a different event. Keep the first visible row plus its
 * offset beneath the sticky header, and ask scoreTable to include that row in its first slice.
 */
function captureTablePosition(root) {
  const scroller = root.querySelector('[data-table-scroll]');
  if (!scroller) return null;
  const rows = [...scroller.querySelectorAll('tbody tr[data-row-key]')];
  const boundary = scroller.getBoundingClientRect().top + (scroller.querySelector('thead')?.offsetHeight || 0);
  const anchor = rows.find((row) => row.getBoundingClientRect().bottom > boundary) || rows.at(-1) || null;
  return {
    top: scroller.scrollTop,
    left: scroller.scrollLeft,
    rendered: rows.length,
    key: anchor?.dataset.rowKey || null,
    offset: anchor ? anchor.getBoundingClientRect().top - boundary : 0,
  };
}

function restoreTablePosition(root, position) {
  if (!position) return;
  const scroller = root.querySelector('[data-table-scroll]');
  if (!scroller) return;
  // A caller or browser theme may opt into smooth programmatic movement. Restoration is different:
  // animating from the new element's zero position would visibly lose the row before finding it
  // again. Make this bookkeeping jump atomic, then restore the surface.
  const inlineBehavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';
  try {
    scroller.scrollLeft = position.left;
    if (position.top <= 1) {
      scroller.scrollTop = 0;
      return;
    }
    const anchor = [...scroller.querySelectorAll('tbody tr[data-row-key]')].find((row) => row.dataset.rowKey === position.key);
    if (!anchor) {
      scroller.scrollTop = position.top;
      return;
    }
    const boundary = scroller.getBoundingClientRect().top + (scroller.querySelector('thead')?.offsetHeight || 0);
    scroller.scrollTop += anchor.getBoundingClientRect().top - boundary - position.offset;
  } finally {
    scroller.style.scrollBehavior = inlineBehavior;
  }
}

/**
 * KEEP THE READER'S CARET WHERE THEY LEFT IT.
 *
 * This panel repaints as each feed lands — eight times on a cold visit, over about three seconds —
 * and a repaint replaces `ctx.root.innerHTML`, which takes the focus and the caret out of the
 * search box somebody may be typing into. `initialView` already carries the TEXT across; this
 * carries the cursor. Same class of thing the News tab handles by rebuilding only its list.
 *
 * Only the search input, and only while it is genuinely focused inside this panel: restoring focus
 * to a control the reader was not using would be its own kind of rude.
 */
function captureFocus(root) {
  const el = document.activeElement;
  // Matched on the kit's own hook rather than on `type`, which is `text` — the screener's search
  // box is not an `<input type="search">`, and testing for one would silently never fire.
  if (!el || !root.contains(el)) return null;
  if (el.matches?.('[data-table-search]')) return { kind: 'search', start: el.selectionStart, end: el.selectionEnd };
  if (el.matches?.('[data-feed-toggle]')) return { kind: 'feed', value: el.dataset.feedToggle };
  if (el.matches?.('[data-horizon-toggle]')) return { kind: 'horizon', value: el.dataset.horizonToggle };
  return null;
}

function restoreFocus(root, focus) {
  if (!focus) return;
  const el = focus.kind === 'search'
    ? root.querySelector('[data-table-search]')
    : [...root.querySelectorAll(focus.kind === 'feed' ? '[data-feed-toggle]' : '[data-horizon-toggle]')]
        .find((node) => node.dataset[focus.kind === 'feed' ? 'feedToggle' : 'horizonToggle'] === focus.value);
  if (!el) return;
  el.focus();
  if (focus.kind !== 'search') return;
  try {
    el.setSelectionRange(focus.start, focus.end);
  } catch {
    // Some browsers refuse setSelectionRange on certain input types — the focus is the useful half.
  }
}

/**
 * The one always-visible statement of what this page is and where it came from.
 *
 * IT CARRIES THE DATE ON ITS FACE, and that is not decoration: this is the one tab defined by a
 * DAY, the date is in IST rather than UTC (a UTC date names yesterday for five and a half hours
 * every evening), and a screenshot travels without the source registry. Detailed provenance stays
 * in that registry and the export.
 *
 * IT IS GREEN ONLY WHEN THE DATA EARNS IT. Every feed reaching today is the claim; one behind is
 * amber and says so, because a chip that reads Live over a feed that has not looked at today is
 * the same false freshness claim as the header chip that tracked a heartbeat and asked no server
 * anything.
 */
function livePill(rep, day) {
  const feeds = rep?.feeds || [];
  const behind = feeds.filter((f) => f.status !== 'ok' || f.reachesToday !== true).length;
  const reading = rep?.pending ?? 0;
  const label = `${fmtDay(day)}`;
  if (behind || reading) {
    return `<span data-alerts-info
       class="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-300"
       title="${escapeHtml(behind ? `${behind} feed${behind === 1 ? ' has' : 's have'} not looked at today yet.` : 'Still reading.')}">
       <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span> ${escapeHtml(label)}
     </span>`;
  }
  return `<span data-alerts-info
     class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
     title="Every feed on this page has looked at today. Indian trading date, not UTC.">
     <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Live · ${escapeHtml(label)}
   </span>`;
}

/** `2026-09-01` -> `01 Sept 2026`, so the chip reads as a date rather than as an id. */
function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/**
 * How many feeds have not answered yet — a statement about US, not about the day.
 *
 * It names the count rather than saying "loading", because a partial page that looks finished is
 * the failure this whole tab is built to avoid: a reader who sees four rows and no pill has no way
 * to know that four more feeds are still being read.
 */
function pendingPill(rep) {
  const n = rep?.pending ?? 0;
  if (!n) return '';
  return pill({ label: `Reading ${n} more ${n === 1 ? 'feed' : 'feeds'}…`, tone: 'neutral' });
}

/** The retained range currently represented in the scrollable stream. */
function historyPill(historyMeta) {
  if (!historyMeta?.oldestEventDay || !historyMeta?.newestEventDay) return '';
  const dates = historyMeta.days || 1;
  return pill({
    label: `History · ${dates} ${dates === 1 ? 'date' : 'dates'}`,
    tone: 'neutral',
    title: `${fmtDay(historyMeta.oldestEventDay)} through ${fmtDay(historyMeta.newestEventDay)}, newest first.`,
  });
}

function calendarPill(events) {
  const days = [...new Set(events.map((event) => event.day).filter(Boolean))].sort();
  if (!days.length) return pill({ label: 'Calendar · no loaded dates', tone: 'neutral' });
  return pill({
    label: `Calendar · ${days.length} ${days.length === 1 ? 'date' : 'dates'}`,
    tone: 'neutral',
    title: `${fmtDay(days[0])} through ${fmtDay(days.at(-1))}, nearest first.`,
  });
}

function horizonToggle(throughCount, upcomingCount, day) {
  const tab = (value, label, count) => {
    const active = horizon === value;
    return `<button type="button" role="tab" data-horizon-toggle="${value}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}"
      class="inline-flex min-h-10 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
        active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
      }">
      ${escapeHtml(label)}
      <span class="rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${active ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-200/70 text-slate-500'}">${escapeHtml(formatNumber(count))}</span>
    </button>`;
  };
  return `<div class="mb-4 flex flex-wrap items-center gap-3">
    <div role="tablist" aria-label="Alert time horizon" class="inline-flex rounded-2xl bg-slate-100 p-1 ring-1 ring-slate-200/80" data-alerts-horizon>
      ${tab(HORIZON.THROUGH, 'Till Today', throughCount)}
      ${tab(HORIZON.UPCOMING, 'Upcoming', upcomingCount)}
    </div>
    <p class="text-xs text-slate-500">${horizon === HORIZON.UPCOMING
      ? `Scheduled events from ${fmtDay(day)} onward, nearest first.`
      : `Retained events through ${fmtDay(day)}, newest first.`}</p>
  </div>`;
}

// ---------------------------------------------------------------------------------------
// The coverage panel — one row per feed
// ---------------------------------------------------------------------------------------

function coveragePanel(feeds, visibleCount) {
  if (!feeds.length) {
    return `<div class="mb-5 text-xs text-slate-400" data-alerts-coverage>Reading the feeds…</div>`;
  }

  const box = (on) => `
    <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border transition-all ${
      on ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm' : 'border-slate-300 bg-white text-transparent group-hover:border-indigo-300'
    }">
      <svg aria-hidden="true" viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5 4.7 9 10 3.5"/></svg>
    </span>`;

  const allOn = !picked;
  const chips = [
    `<button type="button" data-feed-toggle="__all" role="checkbox" aria-checked="${allOn}"
       title="Show every feed on this page. This is the default."
       class="group inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${allOn ? 'border-indigo-200 bg-indigo-50 text-indigo-800 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/60'}">
       ${box(allOn)}
       <span class="font-semibold">All sources</span>
       <span class="rounded-full bg-white/80 px-1.5 py-0.5 font-bold tabular-nums text-slate-500 ring-1 ring-slate-200">${escapeHtml(formatNumber(visibleCount))}</span>
     </button>`,
  ];

  for (const f of feeds) {
    const st = feedState(f);
    const detail = st.short(f);
    const on = !!picked && picked.has(f.id);
    // Feed health remains operational metadata. The customer-facing control stays focused on its
    // one job: selecting a source. Only a confirmed, current count is shown beside the source name.
    const title = `Filter alerts to ${f.label}.`;
    chips.push(`
      <button type="button" data-feed-toggle="${escapeHtml(f.id)}" data-feed="${escapeHtml(f.id)}"
        role="checkbox" aria-checked="${on}" title="${escapeHtml(title)}"
        class="group inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${on ? 'border-indigo-200 bg-indigo-50 text-indigo-800 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/60'}">
        ${box(on)}
        <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full ${st.dot}"></span>
        <span class="font-semibold ${on || allOn ? 'text-slate-700' : 'text-slate-500'}">${escapeHtml(f.label)}</span>
        ${detail ? `<span class="font-semibold ${st.text}">${escapeHtml(detail)}</span>` : ''}
      </button>`);
  }

  return `
    <section class="mb-5 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-slate-100" data-alerts-coverage aria-label="Alert source filters">
      <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-600">Sources</h2>
          <p class="mt-0.5 text-xs text-slate-400">Select one or more feeds to focus the list.</p>
        </div>
        ${picked ? '<span class="text-[11px] font-semibold text-indigo-600">Custom selection</span>' : ''}
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">${chips.join('')}</div>
    </section>`;
}

/**
 * Size the stream so its bottom edge lands just above the fold, whatever is above it.
 *
 * THE HEIGHT OF THE HEAD IS NOT A CONSTANT, which is what a `calc(100vh - 558px)` assumes. It
 * changes with the window width (the chip row wraps), with how many feeds are on offer (four under
 * a narrowed scope, five under Universe), and with the reader's zoom. Measured against one window
 * the constant was exact and the table ended 24px above the fold; on a wider one it stopped about
 * 110px short, which is the dead band this exists to remove. So the number is read from the
 * element itself, after the paint, rather than written down.
 *
 * Re-applied on resize, and the listener is returned to `unsubs` so it dies with the tab — a
 * window listener re-registered on every repaint is a leak that grows with every feed that lands.
 */
let unfit = null;
function fitStreamToViewport(root) {
  if (unfit) {
    unfit();
    unfit = null;
  }
  const el = root.querySelector('[data-table-scroll]');
  if (!el) return;
  const set = (h) => {
    el.style.maxHeight = `${h}px`;
    el.style.height = `${h}px`;
  };
  const apply = () => {
    if (!el.isConnected) return;
    // Viewport-relative, and only meaningful at the top of the page — which is where the reader is
    // when this matters, because a table that fills the viewport leaves the page nothing to scroll.
    const top = el.getBoundingClientRect().top;
    let h = Math.max(MIN_STREAM_PX, Math.round(window.innerHeight - top - STREAM_BOTTOM_GAP_PX));
    set(h);
    // NO "CORRECT FOR THE RESIDUAL PAGE SCROLL" PASS HERE, and that is deliberate. There is a 16px
    // overflow in a sandbox with no Tailwind — `body` keeps the browser's default 8px margin
    // because preflight never loads, on top of a `min-height: 100vh` — and shrinking the table by
    // it changed the document height not at all, because the floor is the min-height rather than
    // the content. Compensating would have made the table 16px short for every real reader to fix
    // something only the sandbox has. Measure what the element needs; do not chase the page.

  };
  apply();
  const onResize = () => apply();
  window.addEventListener('resize', onResize);
  unfit = () => window.removeEventListener('resize', onResize);
  unsubs.push(unfit);
}

// Enough table to be worth having on a short window, and enough margin to keep the card's bottom
// edge and its shadow off the fold.
const MIN_STREAM_PX = 320;
const STREAM_BOTTOM_GAP_PX = 24;

function wireHorizon(ctx) {
  const root = ctx.root.querySelector('[data-alerts-horizon]');
  if (!root) return;
  const select = (value) => {
    if (!Object.values(HORIZON).includes(value) || value === horizon) return;
    horizon = value;
    // A source selection is meaningful inside the horizon where it was made. Carrying an
    // historical-only source into Upcoming would make the calendar look empty on arrival.
    picked = null;
    paint(ctx);
  };
  root.addEventListener('click', (event) => select(event.target.closest('[data-horizon-toggle]')?.dataset.horizonToggle));
  root.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    select(event.key === 'ArrowLeft' || event.key === 'Home' ? HORIZON.THROUGH : HORIZON.UPCOMING);
  });
}

/**
 * The tick boxes, which filter the stream by the feed a row came from.
 *
 * `All` IS `null`, NOT "every id ticked" — see the declaration of `picked`. Two behaviours follow
 * and both are deliberate: ticking every feed individually collapses back to All rather than
 * leaving a filter that only looks like one, and unticking the last feed returns to All rather
 * than emptying the stream. A reader who has just unticked their way to a blank page has no
 * control on screen saying why it is blank, and "no events today" is a claim this page may not
 * make on the strength of a filter the reader set.
 */
function wireFeedFilter(ctx, available) {
  const root = ctx.root.querySelector('[data-alerts-coverage]');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feed-toggle]');
    if (!btn) return;
    const id = btn.dataset.feedToggle;
    if (id === '__all') {
      picked = null;
    } else {
      const next = new Set(picked || available);
      // From All, the first tick means "only this one" — ticking one box out of an implicit
      // everything and getting everything-minus-nothing would be a control that does nothing.
      if (!picked) next.clear();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      picked = next.size && next.size < available.length ? next : null;
    }
    paint(ctx);
  });
}

/**
 * The feed states remain distinct for internal styling and monitoring.
 *
 * EXPORTED BECAUSE IT IS THE RULE, not because a tab needs it — the same reason `moveSeverity` is.
 * The branch that matters most here is the one that must never print a number, and it can only be
 * reached on a day a feed is actually behind, which most days it is not: asserting it through the
 * rendered panel passes vacuously and proves nothing. The suite calls this directly instead.
 *
 * Customer-facing chips intentionally omit health jargon. A factual count appears only after a
 * feed has confirmed the selected day; every other state keeps the source name uncluttered.
 */
export function feedState(f) {
  // `label` remains available to operational callers. `short` is customer-facing: it is empty for
  // health states and numeric only when the count is a confirmed reading for the selected day.
  const n = (x) => formatNumber(x || 0);
  // PENDING IS ITS OWN STATE. A feed nobody has heard from yet must never be drawn as "nothing
  // today" — that is a finished answer, and this is the absence of one.
  if (f.status === 'pending') {
    return { label: 'reading…', short: () => '', dot: 'bg-slate-300 animate-pulse', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-400' };
  }
  if (f.status === 'failed') {
    return { label: 'read failed or incomplete; retained records shown', short: () => '', dot: 'bg-amber-500', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-500' };
  }
  if (f.status === 'on-demand') {
    return { label: 'on-demand coverage only; not a complete source scan', short: () => '', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-500' };
  }
  if (f.scopable === false) {
    return { label: 'not in this scope', short: () => '', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-slate-50/50', text: 'text-slate-400' };
  }
  if (f.reachesToday !== true) {
    return { label: 'latest available capture; not confirmed current', short: () => '', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-500' };
  }
  const todayCount = f.todayCount ?? f.count ?? 0;
  if (todayCount) {
    return { label: 'current', short: (x) => n(x.count), dot: 'bg-emerald-500', ring: 'ring-emerald-100', bg: 'bg-emerald-50/40', text: 'text-emerald-700' };
  }
  return { label: 'current · nothing today', short: (x) => n(x.count), dot: 'bg-emerald-500', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-emerald-700' };
}

// ---------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------

// Direction owns the hue; importance owns the visual weight. High rows get the stronger tint and
// 4px edge, while Low stays quiet with a 2px edge. NO `hover:` class here — `scoreTable` appends
// its own `hover:bg-slate-50`
// after whatever `rowClass` returns, and two hover rules on one element are decided by stylesheet
// order rather than by class order, which is a coin toss dressed up as a decision.
const DIR = {
  positive: {
    label: 'Positive', symbol: '↑', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', reason: 'text-emerald-700',
    highRow: 'bg-emerald-50/60 shadow-[inset_4px_0_0_#059669]', lowRow: 'bg-emerald-50/20 shadow-[inset_2px_0_0_#10b981]',
  },
  negative: {
    label: 'Negative', symbol: '↓', chip: 'bg-rose-50 text-rose-700 ring-rose-200', reason: 'text-rose-700',
    highRow: 'bg-rose-50/60 shadow-[inset_4px_0_0_#e11d48]', lowRow: 'bg-rose-50/20 shadow-[inset_2px_0_0_#fb7185]',
  },
  neutral: {
    label: 'Neutral', symbol: '•', chip: 'bg-slate-100 text-slate-600 ring-slate-200', reason: 'text-slate-500',
    highRow: 'bg-violet-50/40 shadow-[inset_4px_0_0_#64748b]', lowRow: 'shadow-[inset_2px_0_0_#cbd5e1]',
  },
};
const IMP = {
  high: { label: 'High priority', chip: 'bg-violet-600 text-white ring-violet-600 shadow-sm' },
  low: { label: 'Low priority', chip: 'bg-white/70 text-slate-500 ring-slate-200' },
};

function alertRowClass(event) {
  const direction = DIR[event.direction] || DIR.neutral;
  return event.importance === 'high' ? direction.highRow : direction.lowRow;
}

function signalCell(event) {
  const direction = DIR[event.direction] || DIR.neutral;
  const importance = IMP[event.importance] || IMP.low;
  const title = `${direction.label} direction — ${event.signalReason || 'No direction reason supplied'}. ${importance.label} — ${event.importanceReason || 'No importance reason supplied'}.`;
  return `<div data-alert-signal data-alert-direction="${escapeHtml(event.direction || 'neutral')}" data-alert-importance="${escapeHtml(event.importance || 'low')}"
      class="flex min-w-[108px] flex-col items-start gap-1.5" role="group" aria-label="${escapeHtml(`${direction.label} direction, ${importance.label}`)}" title="${escapeHtml(title)}">
    <span class="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${direction.chip}">
      <span aria-hidden="true" class="text-sm leading-none">${direction.symbol}</span>${direction.label}
    </span>
    <span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${importance.chip}">${importance.label}</span>
  </div>`;
}

/** Today belongs to Upcoming only while the source still explicitly calls the row scheduled. */
export function isUpcomingEvent(event, day) {
  if (!event?.day) return false;
  return event.day > day || (event.day === day && event.kind === 'scheduled');
}

function upcomingCategory(event) {
  const words = `${event.headline || ''} ${event.detail || ''}`.toLowerCase();
  if (/\b(?:con[ -]?call|conference call|earnings call)\b/.test(words)) return 'concall';
  if (/\b(?:earnings result|results?|financial results?)\b/.test(words)) return 'result';
  if (/\b(?:annual general meeting|agm)\b/.test(words)) return 'agm';
  if (/\bpostal ballot\b/.test(words)) return 'postal-ballot';
  if (/\bcourt-convened meeting\b/.test(words)) return 'court-meeting';
  return words.replace(/\bscheduled\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'event';
}

/** One calendar entry per company/date/type even when two feeds discovered the same filing. */
export function collapseUpcoming(events) {
  const merged = new Map();
  for (const event of events) {
    const company = String(event.ticker || event.company || '').toUpperCase().replace(/[^A-Z0-9&]/g, '');
    const key = `${company}|${event.day}|${upcomingCategory(event)}`;
    const previous = merged.get(key);
    // The portfolio calendar usually points at the exchange filing and is already guaranteed to
    // be in the book. Prefer it to a duplicate provider row; otherwise prefer a real source URL.
    const rank = (row) => (row.feed === 'screener-portfolio-upcoming' ? 2 : 0) + (row.url ? 1 : 0);
    if (!previous || rank(event) > rank(previous)) merged.set(key, event);
  }
  return [...merged.values()];
}

function eventsTable(ctx, events, day, mode, initialView, tablePosition = null) {
  const dateColumn = {
    label: 'Date / time',
    align: 'left',
    get: (e) => `<time datetime="${escapeHtml(e.day || '')}" data-event-day="${escapeHtml(e.day || '')}" class="block whitespace-nowrap tabular-nums text-slate-700">
      <span class="block font-medium">${escapeHtml(e.day ? fmtDay(e.day) : 'Date not supplied')}</span>
      <span class="block text-xs ${e.time ? 'text-slate-500' : 'text-slate-400'}">${e.kind === 'scheduled' ? 'Scheduled · ' : ''}${e.time ? `${escapeHtml(e.time)} IST` : e.day ? 'Day only' : 'Undated'}</span>
    </time>`,
    html: true,
    sortValue: (e) => `${e.day || '0000-00-00'}T${e.time || (mode === HORIZON.UPCOMING ? '99:99' : '')}`,
  };
  const eventColumn = {
    label: mode === HORIZON.UPCOMING ? 'What is scheduled' : 'What happened',
    get: (e) => `
      <div class="max-w-[560px]">
        <div class="truncate font-medium text-slate-800" title="${escapeHtml(e.headline)}">${escapeHtml(e.headline)}</div>
        <div class="truncate text-xs text-slate-500" title="${escapeHtml(e.detail || '')}">${escapeHtml(e.detail || '')}</div>
        ${mode === HORIZON.UPCOMING ? '' : `<div class="mt-0.5 truncate text-xs font-semibold ${(DIR[e.direction] || DIR.neutral).reason}" title="${escapeHtml(e.signalReason || '')}"><span class="text-slate-400">Signal ·</span> ${escapeHtml(e.signalReason || '')}</div>
        <div class="truncate text-[11px] ${e.importance === 'high' ? 'font-semibold text-violet-700' : 'text-slate-400'}" title="${escapeHtml(e.importanceReason || '')}"><span class="text-slate-400">Priority ·</span> ${escapeHtml(e.importanceReason || '')}</div>`}
      </div>`,
    html: true,
    sortValue: (e) => String(e.headline || '').toLowerCase(),
  };
  const columns = mode === HORIZON.UPCOMING
    ? [dateColumn, eventColumn, { label: 'Source', get: (e) => e.feedLabel }]
    : [
        dateColumn,
        {
          label: 'Signal / priority',
          get: signalCell,
          html: true,
          sortValue: (e) => (e.importance === 'high' ? 1 : 0),
        },
        eventColumn,
        { label: 'Feed', get: (e) => e.feedLabel },
      ];
  const filters = mode === HORIZON.UPCOMING
    ? [{ label: 'Date range', options: dateRangeOptions(events, day, mode), match: (e, v) => matchesDateRange(e.day, day, v) }]
    : [
        {
          label: 'Importance',
          options: [
            { value: 'all', label: 'All priorities' },
            { value: 'high', label: 'High priority only' },
            { value: 'low', label: 'Low priority only' },
          ],
          match: (e, v) => e.importance === v,
        },
        {
          label: 'Direction',
          options: [
            { value: 'all', label: 'Every direction' },
            { value: 'positive', label: 'Positive only' },
            { value: 'negative', label: 'Negative only' },
            { value: 'neutral', label: 'Neutral only' },
          ],
          match: (e, v) => e.direction === v,
        },
        { label: 'Date range', options: dateRangeOptions(events, day, mode), match: (e, v) => matchesDateRange(e.day, day, v) },
      ];
  return scoreTable({
    rows: events,
    key: (e) => e.id,
    watchKey: (e) => e.ticker || null,
    watchName: (e) => e.company,
    name: (e) => e.company,
    nameLabel: 'Company',
    nameMaxPx: 220,
    sub: (e) => [e.ticker, e.section, e.feedLabel].filter(Boolean).join(' · '),
    showRank: false,
    // Date and time lead every row. Some feeds resolve only to a day; saying "Day only" is more
    // informative than an em dash and keeps older rows intelligibly ordered as the reader scrolls.
    // History adds the combined signal/priority marker before company identity. Upcoming has no
    // inferred signal, so company follows the date directly.
    nameAfter: mode === HORIZON.UPCOMING ? 1 : 2,
    dense: true,
    wrapHeads: true,
    stickyHead: 'max(320px, calc(100vh - 560px))',
    fillMode: 'scroll',
    rowClass: mode === HORIZON.UPCOMING ? null : alertRowClass,
    initialRowCount: tablePosition?.rendered || 40,
    initialRowKey: tablePosition?.key || null,
    scrollLabel: mode === HORIZON.UPCOMING ? 'All Alerts upcoming events table' : 'All Alerts history table',
    columns,
    link: (e) => e.url || null,
    // THE ROW OPENS THE SOURCE. It used to navigate to the tab that owns the feed, which put two
    // clicks and a scan between the reader and the thing the row is about — they had already read
    // the headline here. A row with no URL falls back to its tab, because a click that silently
    // does nothing is worse than one that goes somewhere useful; nothing here reproduces the
    // article, which is the rule that actually matters (see the con-call link rule in CLAUDE.md).
    onRowClick: (e) => {
      if (e.url) {
        window.open(e.url, '_blank', 'noopener,noreferrer');
        return;
      }
      // FALL BACK TO THE TAB, ON THE COMPANY — not just the tab. A row with no source URL (public
      // chatter, price/volume moves) used to land on the owning tab's whole list, leaving the reader
      // to search for the company they had just clicked. `?company=` seeds that tab's own search
      // (every table tab honours it via companySeededView), and for chatter — whose real content is
      // the per-company mentions popup, not the row — `open=mentions` asks the tab to open it
      // straight away, which is the thing the row is actually about.
      if (e.tab) {
        const params = [`scope=${ctx.scope}`];
        if (e.ticker) params.push(`company=${encodeURIComponent(e.ticker)}`);
        if (e.feed === 'chatter' && e.ticker) params.push('open=mentions');
        location.hash = `#/research/${e.tab}?${params.join('&')}`;
      }
    },
    // Company-news identity is query metadata, not publisher evidence. The shared helper keeps an
    // unverified row retained but prevents that synthetic label from making an unrelated headline
    // satisfy a company search. Every other feed has a resolved/source-carried company identity.
    searchable: alerts.eventSearchText,
    filters,
    initialSort: { key: 'Date / time', dir: mode === HORIZON.UPCOMING ? 'asc' : 'desc' },
    initialView,
    emptyMessage: emptyMessageFor(ctx.scope, day, mode),
    exportName: `sattva-all-alerts-${mode === HORIZON.UPCOMING ? 'upcoming-from' : 'through'}-${day}`,
    onExport: (visible) => exportStream(visible, day, ctx.scope, mode),
  });
}

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function dateRangeOptions(events, day, mode) {
  if (mode === HORIZON.UPCOMING) {
    return [
      { value: 'all', label: 'All upcoming dates' },
      { value: 'next7', label: 'Next 7 days' },
      { value: 'next30', label: 'Next 30 days' },
    ];
  }
  const options = [
    { value: 'all', label: 'All dates through today' },
    { value: 'today', label: 'Today only' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
  ];
  if (events.some((event) => !event.day)) options.push({ value: 'undated', label: 'Date not supplied' });
  if (events.some((event) => event.day < shiftDay(day, -29))) options.push({ value: 'older', label: 'Older than 30 days' });
  return options;
}

function matchesDateRange(eventDay, throughDay, range) {
  if (range === 'all') return true;
  if (range === 'undated') return !eventDay;
  if (!eventDay) return false;
  if (range === 'next7') return eventDay >= throughDay && eventDay <= shiftDay(throughDay, 6);
  if (range === 'next30') return eventDay >= throughDay && eventDay <= shiftDay(throughDay, 29);
  if (range === 'today') return eventDay === throughDay;
  if (range === '7d') return eventDay >= shiftDay(throughDay, -6) && eventDay <= throughDay;
  if (range === '30d') return eventDay >= shiftDay(throughDay, -29) && eventDay <= throughDay;
  if (range === 'older') return eventDay < shiftDay(throughDay, -29);
  return true;
}

/**
 * The empty table's message, which must not overstate what an empty table means.
 *
 * "Nothing happened today" is a claim nobody measured — the coverage panel above says which feeds
 * have actually looked. So this says what IS true: nothing reached this page, and points at the
 * panel that explains why.
 */
function emptyMessageFor(scope, day, mode) {
  const where = scope === 'universe' ? 'across the market' : `for your ${scopeLabel(scope).toLowerCase()}`;
  if (mode === HORIZON.UPCOMING) return `No loaded upcoming event ${where} matches the current search, source and date filters from ${day}.`;
  return `No loaded event ${where} matches the current search, feed, direction, importance and date filters through ${day}. Use the source filters above to adjust the view.`;
}

// ---------------------------------------------------------------------------------------
// Export
//
// ROW 1 IS THE BANNER. A workbook leaves the page without any of the chrome above it — no legend,
// no coverage panel, no source registry — so everything a reader needs in order not to misread the
// colours has to travel inside the file.
// ---------------------------------------------------------------------------------------

function exportStream(visible, day, scope, mode = HORIZON.THROUGH) {
  const feeds = report?.feeds || [];
  const behind = feeds.filter((f) => f.reachesToday !== true || f.status !== 'ok').map((f) => f.label);
  const upcoming = mode === HORIZON.UPCOMING;
  const modeNote = upcoming
    ? 'Every row is scheduled evidence, not confirmation that an event occurred; no directional inference is shown in this view. '
    : `Includes captured records, explicitly labelled snapshots and undated records. Direction (positive/negative/neutral) and Importance (high/low) are independent; every row carries both reasons. High thresholds: price ±${alerts.MOVE_PCT}%; insider ${alerts.INSIDER_HIGH_PCT}% or ₹${alerts.INSIDER_HIGH_VALUE / 10_000_000} crore; investor presence change or ${alerts.INVESTOR_HIGH_PP}pp; chatter ${alerts.CHATTER_HIGH_MENTIONS} mentions or ${alerts.CHATTER_HIGH_CHANGE_PCT}% mention change. Announcement direction is rule-derived and unmatched filings stay neutral; news stays neutral. `;
  const banner = {
    __banner: true,
    line:
      `SATTVA CENTRAL RESEARCH — ${upcoming ? `UPCOMING EVENTS from ${day}` : `ALL ALERTS HISTORY through ${day}`} (Indian trading date), ${scopeLabel(scope)} scope. ` +
      `Registered feeds: ${alerts.FEEDS.map((f) => f.label).join(', ')}. ${modeNote}` +
      (behind.length
        ? `NOT EVERY FEED HAS LOOKED AT THIS DAY: ${behind.join(', ')} last read earlier, so an absence here is not evidence that nothing happened.`
        : `Every daily feed on this dashboard had read this day when the sheet was written.`),
  };

  const cell = (get) => (r) => (r.__banner ? '' : get(r));
  return exportRows({
    filename: `sattva-all-alerts-${mode === HORIZON.UPCOMING ? 'upcoming-from' : 'through'}-${day}`,
    sheetName: 'All Alerts',
    columns: [
      { header: 'Date (IST)', key: 'date', width: 14, get: (r) => (r.__banner ? r.line : r.day || '') },
      { header: 'Time (IST)', key: 'time', width: 12, get: cell((r) => r.time || '') },
      ...(!upcoming ? [
        { header: 'Direction', key: 'direction', width: 12, get: cell((r) => r.direction || 'neutral') },
        { header: 'Importance', key: 'importance', width: 12, get: cell((r) => r.importance || 'low') },
      ] : []),
      { header: 'Feed', key: 'feed', width: 18, get: cell((r) => r.feedLabel) },
      { header: 'Ticker', key: 'ticker', width: 14, get: cell((r) => r.ticker || '') },
      { header: 'Company', key: 'company', width: 32, get: cell((r) => r.company) },
      { header: upcoming ? 'What is scheduled' : 'What happened', key: 'headline', width: 60, get: cell((r) => r.headline) },
      { header: 'Detail', key: 'detail', width: 50, get: cell((r) => r.detail || '') },
      { header: 'Record type', key: 'kind', width: 16, get: cell((r) => r.kind || 'event') },
      { header: 'Source record (JSON)', key: 'sourceRecord', width: 60, get: cell((r) => JSON.stringify(r.sourceRecord || {})) },
      ...(!upcoming ? [
        { header: 'Direction reason', key: 'signalReason', width: 48, get: cell((r) => r.signalReason || '') },
        { header: 'Importance reason', key: 'importanceReason', width: 48, get: cell((r) => r.importanceReason || '') },
      ] : []),
      { header: 'Source link', key: 'url', width: 44, get: cell((r) => r.url || '') },
    ],
    rows: [banner, ...visible],
  });
}
