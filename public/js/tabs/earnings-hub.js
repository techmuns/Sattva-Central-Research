// tabs/earnings-hub.js — LIVE quarterly results for the whole listed universe.
//
// This tab is genuinely live. It paints from a committed snapshot instantly, then polls
// /api/earnings every 30s; a company that files at 14:32 is on this table by about 14:33. The
// header pill shows which of the two you are looking at, and the "just reported" strip names
// anything that arrived while the tab was open.
//
// THE TABLE IS THE POINT. No score, no signal dots, no hero cards on the main view — this is a
// dense sortable table because that is what a results screen is for. The screener kit's
// scoreTable does all of it (search, sort, filter, watchlist, export, sticky head, 1,300 rows at
// ~120ms) with Score and Signals switched off.
//
// WHY THERE IS NO 21-POINT SCORE HERE ANY MORE
//   The old Earnings Hub scored synthetic financials against a 15-rule model. Moneycontrol
//   publishes three figures per company — revenue, gross profit, net profit — which is nowhere
//   near enough to feed that model. Rather than run a real model on fake numbers next to a live
//   table of real ones, the scoring sub-views are gone. `js/scoring/earnings-scoring.js` and the
//   mock set remain in the repo for the Breakouts → Earnings Surprise join, which still labels
//   itself mock.
//
// THE PERCENTAGE THAT ISN'T ONE
//   13% of companies have a sign flip between the two periods. "+199%" on a loss-to-profit
//   turnaround is not a growth rate, and a green +43% on a company that lost ₹3,754 Cr reads as
//   profit growth when it means the loss narrowed. Every such cell is a labelled pill instead of
//   a number — see `changeCell`.
//
//   That is also why the table carries BOTH periods for all three metrics rather than the growth
//   percentage alone. A percentage is a ratio with its numerator and denominator thrown away:
//   "+43%" is the same cell whether the company earned ₹4 Cr or ₹4,000 Cr, and Vodafone Idea's
//   PAT "+43%" is -6,608 → -3,754. The reported figures sit next to the percentage so the reader
//   can see what it was computed from, on the row itself.
//
// WHY THERE IS NO DRILL PANEL
//   There was one, and the six reported figures were the bulk of what it said — so once those
//   became columns it was mostly restating the row you clicked. Rows are not clickable now.
//   Nothing accountable was lost with it: the return-since-result figure it explained is no
//   longer a column at all, and the passive Live label reports status without opening a dialog.
//   Detailed source metadata remains in the canonical registry.
//
//   Do not re-add a drill to hold a number that could be a column. Add the column.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { withoutPublisherName } from '../core/source-copy.js';
import { formatCroreCompact, formatPct, formatNumber, formatRupee, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/earnings-live.js';
import * as calendar from '../data/earnings-calendar.js';
import * as coverage from '../data/coverage.js';
import { filterByScope, scopePossessive } from '../data/scope.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
  // No sub-views: this tab is one table. The shell hides the rail entirely when this is empty.
  subviews: [],
};

// The two halves of this tab: what has been reported, and what is scheduled. Same source, same
// quarter, opposite direction in time.
const VIEWS = [
  { value: 'reported', label: 'Earnings Reported', help: 'Companies that have already filed this quarter' },
  { value: 'calendar', label: 'Earnings Calendar', help: 'Companies scheduled to report, by date' },
];

let disposers = [];
let renderToken = 0;
let calendarDate = null; // the selected date in the calendar view
let calendarBusy = false;
// The date strip's horizontal scroll offset, carried across the panel rebuilds that a date click,
// a schedule arriving or a scope change all cause. Without it every rebuild put the strip back at
// its oldest date with the selection off-screen — see `keepActiveVisible`.
let stripScrollLeft = null;
// The calendar table's own view state, carried across repaints for the same reason `tableView` is:
// a filing landing on the date being read must not throw away the reader's search and sort. Keyed
// by mode, because the two modes have different columns — restoring a sort on "Net Profit Growth"
// into a schedule table that has no such column would leave a sort arrow pointing at nothing.
let calendarTableView = null;
let calendarViewMode = null;
// The table is rebuilt whenever a company files. Carrying its view forward means the reader's
// search, filters, watchlist toggle and sort survive that rebuild instead of resetting under them.
let tableView = null;
// Set when a QoQ/YoY switch was asked for and could not be made. Rendered as an amber note rather
// than swallowed, because the alternative is one comparison shown under the other's label.
let periodError = null;

export function render(ctx) {
  const token = ++renderToken;
  ctx.root.innerHTML = loadingHtml();

  feed
    .load()
    .then(async () => {
      if (token !== renderToken) return;
      // Restore the comparison basis from the URL, so ?period=qoq is a shareable link and survives
      // a reload. A failure here is reported, never silently downgraded to the other basis.
      const wanted = ctx.params?.period;
      if (wanted && wanted !== feed.currentSubType()) {
        try {
          await feed.setSubType(wanted);
          periodError = null;
        } catch (err) {
          periodError = withoutPublisherName(err.message || err);
        }
        if (token !== renderToken) return;
      }
      paint(ctx);
      // One subscription for the life of the tab: the poller repaints in place on real change.
      disposers.push(
        feed.onChange(() => {
          if (token !== renderToken) return;
          // A results tick used to be barred from the calendar half entirely — different upstream,
          // different cadence. It is not, now: for a date that has already happened the calendar's
          // table IS this feed, so a company filing on the date being looked at has to appear
          // there too. Both halves carry their table view across the repaint, so a repaint costs
          // the reader nothing; a SCHEDULED date is still left alone, because nothing on it moved.
          if (viewOf(ctx) === 'reported') paint(ctx);
          else if (modeFor(calendarDate || isoToday()) === 'reported') renderCalendar(ctx);
        })
      );
      disposers.push(feed.startLive(ctx.live));
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[earnings-hub] load failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The results feed could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load the earnings feed</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(withoutPublisherName(err.message || err))}</div>
        </div>`;
    });
}

export function destroy() {
  renderToken++;
  disposers.forEach((d) => d && d());
  disposers = [];
  // Leaving the tab is a deliberate exit; coming back should be a clean table, not last visit's
  // half-applied filter. Only a live repaint carries the view forward.
  tableView = null;
  periodError = null;
  calendarDate = null;
  stripScrollLeft = null;
  calendarTableView = null;
  calendarViewMode = null;
  calendar.reset();
}

/** Which half of the tab the URL is asking for. Anything unrecognised falls back to reported. */
const viewOf = (ctx) => (ctx.params?.view === 'calendar' ? 'calendar' : 'reported');

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  if (viewOf(ctx) === 'calendar') renderCalendar(ctx);
  else renderLatest(ctx);
}

/**
 * Reported / Calendar. Not a filter — two different upstreams answering opposite questions about
 * the same quarter, so each half owns its own toolbar, its own freshness and its own caveats.
 */
function viewToggle(active) {
  return `
    <div class="inline-flex items-center gap-1 rounded-full bg-slate-100 p-0.5 ring-1 ring-slate-200" data-view-toggle>
      ${VIEWS.map(
        (v) => `<button type="button" data-view="${v.value}" title="${escapeHtml(v.help)}" aria-pressed="${v.value === active}"
             class="rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
               v.value === active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
             }">${escapeHtml(v.label)}</button>`
      ).join('')}
    </div>`;
}

function wireViewToggle(root, ctx) {
  for (const btn of root.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view;
      if (next === viewOf(ctx)) return;
      // setParams, not setParamsQuiet: this swaps the whole panel, so a re-mount is exactly right
      // and it gives the calendar half a clean load rather than a half-torn-down results table.
      ctx.setParams({ ...ctx.params, view: next });
    });
  }
}

const rowsFor = (ctx) => feed.forScope(ctx.scope, coverage.holdings());

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/**
 * Moneycontrol publishes whole-number percentages, so `formatPct`'s fixed decimal renders an
 * invented ".0" on 99% of cells and widens three columns for nothing. Keep the decimal only where
 * the value genuinely has one.
 */
function pctText(v) {
  if (v == null) return '—';
  return Number.isInteger(v) ? `${v > 0 ? '+' : ''}${v}%` : formatPct(v);
}

/**
 * A period-on-period change, rendered honestly.
 *
 * `normal` gets a signed percentage. Everything else gets a pill naming what actually happened,
 * because a percentage across a sign change is not a growth rate and colouring it green or red
 * would assert something the arithmetic does not support.
 */
function changeCell(m) {
  if (!m || m.kind === 'na') return '<span class="text-slate-300">—</span>';

  if (m.kind === 'normal') {
    const cls = m.pct > 0 ? 'text-emerald-600' : m.pct < 0 ? 'text-rose-600' : 'text-slate-500';
    return `<span class="font-semibold ${cls}">${escapeHtml(pctText(m.pct))}</span>`;
  }
  if (m.kind === 'loss-flat') {
    return `<span class="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200"
       title="Loss in both periods and unchanged: ${escapeHtml(formatNumber(m.prior))} Cr → ${escapeHtml(formatNumber(m.current))} Cr.">Loss flat</span>`;
  }
  if (m.kind === 'loss-narrowed' || m.kind === 'loss-widened') {
    const narrowed = m.kind === 'loss-narrowed';
    const cls = narrowed ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200';
    return `<span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${cls}"
       title="Loss in both periods: ${escapeHtml(formatNumber(m.prior))} Cr → ${escapeHtml(formatNumber(m.current))} Cr. A percentage here describes the size of the loss, not profit growth.">Loss&nbsp;${narrowed ? '↓' : '↑'}${m.pct != null ? escapeHtml(Math.abs(m.pct).toFixed(0)) + '%' : ''}</span>`;
  }
  if (m.kind === 'turnaround') {
    return `<span class="inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
       title="Loss of ${escapeHtml(formatNumber(m.prior))} Cr became a profit of ${escapeHtml(formatNumber(m.current))} Cr. A percentage change across zero is not a growth rate.">To profit</span>`;
  }
  if (m.kind === 'slipped-to-loss') {
    return `<span class="inline-flex items-center rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"
       title="Profit of ${escapeHtml(formatNumber(m.prior))} Cr became a loss of ${escapeHtml(formatNumber(m.current))} Cr.">To loss</span>`;
  }
  if (m.kind === 'flat') return '<span class="text-slate-400">0%</span>';
  return `<span class="text-slate-300" title="Prior period was zero, so there is no percentage to compute.">—</span>`;
}

/**
 * One reported ₹ crore figure.
 *
 * A loss is tinted rose. Next to a five-figure revenue line a bare "-433" is genuinely easy to
 * read past, and the whole reason these columns exist is that the growth percentage alone hides
 * the sign. `muted` dims the prior-period column so the current period stays the primary read
 * without having to make the comparison column smaller or move it away.
 */
function figureCell(v, { muted = false } = {}) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  const cls = v < 0 ? (muted ? 'text-rose-400' : 'font-medium text-rose-600') : muted ? 'text-slate-400' : 'text-slate-700';
  return `<span class="${cls}">${escapeHtml(formatNumber(v))}</span>`;
}

// Sort value that keeps the pills in a sensible order rather than dumping them all at one end.
function changeSortValue(m) {
  if (!m) return -Infinity;
  if (m.kind === 'normal') return m.pct ?? -Infinity;
  if (m.kind === 'turnaround') return 1e6; // best possible outcome, sorts above any percentage
  if (m.kind === 'slipped-to-loss') return -1e6;
  if (m.kind === 'loss-flat') return -5e5;
  if (m.kind === 'loss-narrowed') return (m.pct ?? 0) - 5e5; // improving, but still loss-making
  if (m.kind === 'loss-widened') return -5e5 - Math.abs(m.pct ?? 0);
  return -Infinity;
}

// "2026-08-10" -> "10 Aug". The screenshot's compact form; the full date is in the drill.
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

function basisPill(basis) {
  const con = basis === 'Consolidated';
  // Spelled out, like the header. "CON" and "STD" saved 45px and cost every reader who has not
  // met the abbreviations a guess about whether they are looking at the group or the parent.
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${con ? 'bg-slate-100 text-slate-500' : 'bg-violet-50 text-violet-600'}"
     title="${escapeHtml(basis || 'unknown')} results — ${con ? 'the whole group' : 'the parent company alone'}">${con ? 'Consolidated' : 'Standalone'}</span>`;
}

// ---------------------------------------------------------------------------------------
// Chrome — one small passive live status label.
//
// This page used to open with a green ribbon, a "just reported" strip and a 4-card stat row
// before you reached a single result. That is a lot of furniture in front of the thing people
// came for. It is now a pill in the section head.
//
// The compact label reports whether the feed is live or a snapshot without opening an explainer
// dialog. Task-oriented dialogs, such as the schedule, remain separate controls.
// ---------------------------------------------------------------------------------------
function liveButton(m, rows) {
  if (!m) return '';
  const degraded = !!m.degraded;
  const cls = degraded
    ? 'bg-amber-50 text-amber-800 ring-amber-300'
    : 'bg-emerald-50 text-emerald-800 ring-emerald-300';
  const dot = degraded
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';

  const arrivals = feed.newArrivals().length;
  return `
    <span data-live-info title="Current results-feed status"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${cls}">
      ${dot}
      <span>${degraded ? 'Snapshot' : 'Live'}</span>
      <span class="font-normal opacity-70">${escapeHtml(m.quarter || '')} · ${escapeHtml(formatNumber(rows.length))} reported</span>
      ${arrivals ? `<span class="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">+${arrivals} new</span>` : ''}
    </span>`;
}

/**
 * YoY / QoQ. The current-period figures are identical between the two — only the comparison
 * changes — so this switches what the "prior" columns and every percentage MEAN, not what quarter
 * you are looking at. That is exactly why the column headers carry the period names.
 */
function periodToggle(m) {
  const active = m?.subType || feed.currentSubType();
  const help = { yoy: 'Compare against the same quarter last year', qoq: 'Compare against the previous quarter' };
  return `
    <div class="inline-flex items-center gap-1 rounded-full bg-slate-100 p-0.5 ring-1 ring-slate-200" data-period-toggle>
      ${feed.SUB_TYPES.map(
        (s) => `<button type="button" data-period="${s.value}" title="${escapeHtml(help[s.value] || '')}"
             aria-pressed="${s.value === active}"
             class="rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
               s.value === active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
             }">${escapeHtml(s.label)}</button>`
      ).join('')}
    </div>`;
}

function wirePeriodToggle(root, ctx) {
  const btns = [...root.querySelectorAll('[data-period]')];
  for (const btn of btns) {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.period;
      if (next === feed.currentSubType()) return;
      btns.forEach((b) => (b.disabled = true));
      try {
        await feed.setSubType(next); // notifies -> paint()
        periodError = null;
        // Quiet, not setParams: setParams re-mounts the tab, which would refetch what we just
        // fetched and throw away the table's view. The URL still updates, so the link is shareable.
        ctx.setParamsQuiet({ ...ctx.params, period: next });
      } catch (err) {
        btns.forEach((b) => (b.disabled = false));
        periodError = withoutPublisherName(err.message || err);
        paint(ctx);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------
// Latest Results — the table
// ---------------------------------------------------------------------------------------
function renderLatest(ctx) {
  const rows = rowsFor(ctx);
  const m = feed.meta();

  // Column headers name the actual periods being compared — "REV JUN 26" / "REV JUN 25" — rather
  // than "current" and "prior". A screenshot of this table should say which quarters it is,
  // because a growth percentage is meaningless without knowing what it is measured against.
  const cur = m?.currentPeriod || 'Current';
  const pri = m?.priorPeriod || 'Prior';

  // Ticker and industry are not columns any more: they live on the second line of the identity
  // cell, where they stay searchable and visible without costing two columns of width. The width
  // freed up goes to the reported figures, which is what the growth percentages are derived from.
  const table = scoreTable({
    rows,
    key: (r) => r.scId,
    // THE STAR MARKS THE COMPANY, NOT THE ROW. `key` above identifies the row and is not a ticker
    // here, so without this the watchlist would fill with row ids and the Watchlist scope — which
    // narrows every feed on this dashboard by symbol — would have nothing it could match.
    watchKey: (r) => r.ticker || null,
    watchName: (r) => r.company || r.name || r.ticker,
    name: (r) => r.company,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || r.sectorSlug || '—'}`,
    // No rank counter: a results table is sorted by date, and "#7" against a date-ordered list is
    // a position, not a ranking, so it invites a reading the data does not support. The watchlist
    // star moves into the company cell. `nameAfter: 1` puts Date ahead of the company name.
    showRank: false,
    nameAfter: 1,
    dense: true,
    // On this table the HEADINGS are what overflow, not the figures: "Net Profit Growth" needs
    // 161px on one line where the numbers under it need about 90. Left unwrapped the ten columns
    // come to 1,397px inside a 1,352px container at 1440 — a horizontal scrollbar on the flagship
    // table. Stacking the headings takes it to 1,352px exactly. Measured both ways against the
    // full 1,722-row snapshot; the live feed is shorter, which is what hid this.
    wrapHeads: true,
    // Ten columns leave room the thirteen did not, so the identity column gets it back: fewer
    // industries truncate and the ticker never does.
    nameMaxPx: 260,
    // The head has to stay put on a 1,300-row table. This turns the table body into its own
    // scroller, which is what makes `sticky` engage — see `stickyHead` in screener.js. The
    // subtraction is the header, tab bar, section head and toolbar above it.
    stickyHead: 'max(320px, calc(100vh - 300px))',
    columns: [
      // Newest first, and within a day Moneycontrol's own order — see `dateSortValue`.
      { label: 'Date', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: feed.dateSortValue },

      // Revenue then net profit, each as reported for both periods followed by the change, so a
      // row reads across the way the filing does. Headers spell the metric out: "PAT" and "REV"
      // are trade shorthand, and this table is read by people who did not write it.
      { label: `Revenue ${cur}`, get: (r) => figureCell(r.revenue?.current), html: true, align: 'right', sortValue: (r) => r.revenue?.current ?? -Infinity },
      { label: `Revenue ${pri}`, get: (r) => figureCell(r.revenue?.prior, { muted: true }), html: true, align: 'right', sortValue: (r) => r.revenue?.prior ?? -Infinity },
      { label: 'Revenue Growth', get: (r) => changeCell(r.revenue), html: true, align: 'right', sortValue: (r) => changeSortValue(r.revenue) },

      // Gross profit is not shown. The feed still carries it and the export still includes it —
      // it is only the on-screen columns that were cut, to keep the table readable.
      { label: `Net Profit ${cur}`, get: (r) => figureCell(r.netProfit?.current), html: true, align: 'right', sortValue: (r) => r.netProfit?.current ?? -Infinity },
      { label: `Net Profit ${pri}`, get: (r) => figureCell(r.netProfit?.prior, { muted: true }), html: true, align: 'right', sortValue: (r) => r.netProfit?.prior ?? -Infinity },
      { label: 'Net Profit Growth', get: (r) => changeCell(r.netProfit), html: true, align: 'right', sortValue: (r) => changeSortValue(r.netProfit) },

      { label: 'Market Cap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
      { label: 'Basis', get: (r) => basisPill(r.basis), html: true, align: 'right', sortValue: (r) => r.basis || '' },
    ],
    // Two dropdowns, not one: "PAT grew" and "Consolidated only" are different questions and a
    // reader should be able to ask both at once.
    filters: [
      {
        label: 'Result shape',
        options: [
          { value: 'all', label: 'All results' },
          { value: 'pat-up', label: 'PAT grew' },
          { value: 'pat-down', label: 'PAT fell' },
          { value: 'turnaround', label: 'Loss → profit' },
          { value: 'to-loss', label: 'Profit → loss' },
          { value: 'rev-up-20', label: 'Revenue +20% or more' },
          { value: 'in-universe', label: 'NSE 500 only' },
          { value: 'today', label: 'Reported on the latest date' },
        ],
        match: (r, v) => {
          if (v === 'pat-up') return r.netProfit?.kind === 'normal' && r.netProfit.pct > 0;
          if (v === 'pat-down') return r.netProfit?.kind === 'normal' && r.netProfit.pct < 0;
          if (v === 'turnaround') return r.netProfit?.kind === 'turnaround';
          if (v === 'to-loss') return r.netProfit?.kind === 'slipped-to-loss';
          if (v === 'rev-up-20') return r.revenue?.kind === 'normal' && r.revenue.pct >= 20;
          if (v === 'in-universe') return r.inUniverse;
          if (v === 'today') return r.resultDate === m?.latestResultDate;
          return true;
        },
      },
      {
        // Reporting basis. A group's consolidated numbers and the parent's standalone numbers are
        // not comparable, so screening across a mix of both is a real trap — Moneycontrol offers
        // the same three-way choice for the same reason. The Basis column shows which each row is.
        label: 'Reporting basis',
        options: [
          { value: 'all', label: 'All' },
          { value: 'con', label: 'Consolidated' },
          { value: 'std', label: 'Standalone' },
        ],
        match: (r, v) => (v === 'con' ? r.basis === 'Consolidated' : v === 'std' ? r.basis === 'Standalone' : true),
      },
    ],
    searchable: (r) => `${r.company} ${r.shortName} ${r.ticker || ''} ${r.industry || ''} ${r.sectorSlug || ''}`,
    // Newest first. The view is called Latest Results and Moneycontrol's own page defaults the
    // same way, so anything else is a surprise. It used to default to Return Since Result, which
    // had a nastier consequence than mere preference: a company that reported TODAY has no cached
    // result-day close yet, so its return is null and it sorted to the very bottom — the four
    // newest filings landed at positions 1313-1316 of 1326. Return is still one header click away.
    initialSort: { key: 'Date', dir: 'desc' },
    // No onRowClick, deliberately — see "WHY THERE IS NO DRILL PANEL" at the top of this file.
    exportName: 'sattva-earnings',
    onExport: (visible) => exportResults(visible, m),
    emptyMessage: scopePossessive(ctx.scope) ? `None of ${scopePossessive(ctx.scope)} has reported in this quarter yet.` : 'No results match your filters.',
    initialView: tableView,
  });
  tableView = table.view;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Latest Results',
      description: `Every company that has reported this quarter, newest first. Reported figures in ₹ crore${m?.currentPeriod ? `, ${m.currentPeriod} against ${m.priorPeriod}` : ''}.`,
      controls: `${viewToggle('reported')}${periodToggle(m)}${liveButton(m, rows)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'reported', book: coverage.meta() })}`,
    })}
    ${
      periodError
        ? `<div class="mb-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
             <strong>Comparison not switched.</strong> ${escapeHtml(periodError)}
             You are still looking at ${escapeHtml((m?.subType || 'yoy').toUpperCase())} — ${escapeHtml(m?.currentPeriod || '')} against ${escapeHtml(m?.priorPeriod || '')}, as the column headers say.
           </div>`
        : ''
    }
    ${table.html}
  `;
  wireViewToggle(ctx.root, ctx);
  wirePeriodToggle(ctx.root, ctx);
  disposers.push(table.wire(ctx.root));
}

// ---------------------------------------------------------------------------------------
// Earnings Calendar — what happens, or happened, on one date.
//
// TWO NUMBERS THAT MUST NEVER BE CONFLATED
//   `scheduledCount` is complete: Moneycontrol's calendar API gives the true number reporting on
//   each date. The company LIST is the twenty largest by market cap — the page cannot be paged
//   past and the route its own "load more" uses is blocked to non-browser clients (see the header
//   of worker/mc.mjs). So on a busy day this table shows 20 of 206, and it says exactly that.
//   Rendering twenty rows under a plain heading would assert that twenty is all there are.
//
// A PAST DATE IS A DIFFERENT QUESTION, AND WE HAVE A BETTER ANSWER TO IT
//   For a date that has already happened, "who was due to report" is the weaker question — and it
//   was the only one this view asked, which is why walking back through the strip used to show
//   twenty names on a good day and an amber "counts only for this date" note on every date outside
//   the committed capture's window. Meanwhile the results feed sitting in memory two functions up
//   knows exactly who FILED on every one of those dates, complete, with the figures attached.
//
//   So the view picks its source from the date:
//     · date ≤ today, inside the results feed's window  ->  REPORTED. Every company that filed,
//       from `feed.reportedOn()`. No network, no cap, no capture age.
//     · anything else                                    ->  SCHEDULED. Moneycontrol's calendar,
//       exactly as before, top-20 and all.
//
//   The two are never mixed in one table and never summed. A filing is a measurement; a schedule
//   is a claim about the future, and they are labelled as such on the heading, the pill, the pill's
//   modal and row 1 of the export. `MODES` below is the single definition of that vocabulary — if
//   you add a surface, read it from there rather than writing "scheduled" into a template again.
// ---------------------------------------------------------------------------------------

const MODES = {
  reported: {
    noun: 'reported',
    heading: 'Reported on this date',
    description: 'Companies that filed their results on this date. Pick a date from the strip.',
    // What the count beside the table means in this mode.
    countLabel: 'filed',
  },
  scheduled: {
    noun: 'listed',
    heading: 'Scheduled to report',
    description: 'Companies scheduled to report, by date. Pick a date from the strip.',
    countLabel: 'scheduled',
  },
};

// TODAY IN IST, NOT IN UTC. Every date on this tab is an Indian trading date — a company files at
// 14:32 IST and the exchange calendar is IST — so `toISOString()` on its own is wrong for the five
// and a half hours between 18:30 IST and midnight, during which it names YESTERDAY. That window is
// exactly the evening, when the day's filings are being read.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const isoToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const shiftIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Which half of the calendar answers for this date.
 *
 * `reported` needs BOTH that the date has happened and that the results feed reaches it. Before
 * the feed's first date we genuinely do not know who filed, and an empty table there would say
 * "nobody" — see `dateRange()` in js/data/earnings-live.js.
 */
function modeFor(iso, today = isoToday()) {
  if (iso > today) return 'scheduled';
  const { first } = feed.dateRange();
  return first && iso >= first ? 'reported' : 'scheduled';
}

// THE STRIP'S WINDOW IS ANCHORED ON TODAY, NOT ON THE SELECTED DATE.
//
// It used to be the latter, and that is what made the strip lurch on every click: each date asked
// the Worker for its own ±window, the answers were merged, and so clicking a date both added chips
// and moved every existing one along — after which the panel was rebuilt from scratch and the
// scroll container went back to zero, leaving the date you had just chosen off the right edge.
//
// One window for the whole visit fixes the cause; `keepActiveVisible` below fixes the symptom that
// remains (a rebuild still resets scrollLeft). The window only ever grows, and only to reach a date
// the reader has actually asked for.
const STRIP_BACK = 35;
const STRIP_AHEAD = 21;

function stripWindowFor(iso, today = isoToday()) {
  const from = shiftIso(today, -STRIP_BACK);
  const to = shiftIso(today, STRIP_AHEAD);
  return {
    from: iso < from ? shiftIso(iso, -7) : from,
    to: iso > to ? shiftIso(iso, 7) : to,
  };
}

// "2026-08-13" -> "Thu 13 Aug". The strip needs the weekday: results cluster on weekdays and a
// gap that turns out to be a Sunday is not the same information as a quiet Wednesday.
function stripLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${d.getUTCDate()} ${mo}`;
}

/**
 * Are the per-date counts believable?
 *
 * Moneycontrol serves the counts and the company lists from two different endpoints, and the count
 * endpoint can go flat — every date in the window returning 0 while the calendar page still names
 * twenty companies for today. Taken literally that says "nobody reports, here are the twenty who
 * are reporting", and it greys out every date in the strip so no date can be opened at all.
 *
 * Zero everywhere is not a schedule; it is a feed that did not answer. Treat it as unknown.
 */
function countsAreReadable(days = calendar.strip()) {
  return days.some((d) => d.count > 0);
}

/**
 * A date the strip does not carry is still a date the reader asked for.
 *
 * The strip is Moneycontrol's window and the results feed's is its own; they overlap but neither
 * contains the other, and a date only the feed knows about (or one restored from a shared URL)
 * must still appear, selected, rather than vanishing because the other upstream never mentioned
 * it. It joins with a null count — which renders as a dash, meaning "not known", never zero.
 */
function stripDays(active) {
  const days = calendar.strip();
  const seen = new Set(days.map((d) => d.date));
  const extra = [];
  const { first, last } = feed.dateRange();
  // Dates the results feed covers: they have a table behind them, so they are worth walking to.
  if (first && last) {
    for (const r of feed.all()) {
      if (r.resultDate && !seen.has(r.resultDate)) {
        seen.add(r.resultDate);
        extra.push({ date: r.resultDate, count: null });
      }
    }
  }
  if (active && !seen.has(active)) extra.push({ date: active, count: null });
  return [...days, ...extra].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * The number on a chip, and what it is a number OF.
 *
 * THE TWO ARE DIFFERENT MEASUREMENTS AND THE CHIP HAS TO SAY WHICH. A filing is a fact and a
 * schedule is a claim about the future; a row of chips reading 76 · 24 · 2 · 65 with some of them
 * one thing and some the other, distinguishable only by hovering, is the Institutions trap in
 * miniature — two disclosures that render identically. So each chip carries a one-word kicker.
 *
 * Which one it shows follows `modeFor()`, so **the chip previews what clicking it will produce**:
 * a past date shows what was filed, because that is what its table will list, and a future date
 * shows what is due, because that is all anyone can know about it.
 */
function chipCount(iso, today) {
  const co = (n) => (n === 1 ? 'company' : 'companies');
  const scheduled = calendar.scheduledCountFor(iso);
  if (modeFor(iso, today) === 'reported') {
    const filed = feed.reportedCount(iso);
    if (filed) return { n: filed, kicker: 'filed', noun: `${co(filed)} filed` };
    // Nothing filed, but the schedule may still know something about the date — a Sunday with
    // nothing due reads differently from a weekday where nobody reported.
    if (scheduled != null) return { n: scheduled, kicker: 'due', noun: `${co(scheduled)} ${scheduled === 1 ? 'was' : 'were'} due` };
    return { n: null, kicker: '', noun: null };
  }
  if (scheduled != null) return { n: scheduled, kicker: 'due', noun: `${co(scheduled)} due` };
  return { n: null, kicker: '', noun: null };
}

function dateStrip(active, today) {
  const ordered = stripDays(active);
  if (!ordered.length) return '';
  const readable = countsAreReadable(calendar.strip());
  return `
    <div class="scrollbar-thin mb-4 flex gap-2 overflow-x-auto pb-2" data-date-strip>
      ${ordered
        .map((d) => {
          const on = d.date === active;
          // With no readable counts, no date can be called empty — so none is disabled, and each
          // shows a dash. A dash means "not known", which is what it is.
          //
          // A date the results feed covers is never disabled whatever the schedule says: companies
          // demonstrably filed on it, so "nothing scheduled" would be contradicted by the table
          // one click away. That was the state every past date used to be in.
          const { n, kicker, noun } = chipCount(d.date, today);
          const empty = readable && !d.count && !feed.reportedCount(d.date);
          const isToday = d.date === today;
          return `<button type="button" data-date="${escapeHtml(d.date)}" ${empty ? 'disabled' : ''} ${on ? 'aria-current="date"' : ''}
            title="${escapeHtml(stripLabel(d.date))}${empty ? ' — nothing scheduled' : n != null ? ` — ${formatNumber(n)} ${noun}` : ' — not known'}"
            class="flex min-w-[92px] flex-shrink-0 flex-col items-center rounded-xl px-3 py-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
              on
                ? 'bg-indigo-600 text-white shadow-sm'
                : empty
                  ? 'cursor-default bg-slate-50 text-slate-300 ring-1 ring-slate-100'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-indigo-50 hover:text-indigo-700'
            }">
            <span class="font-semibold ${on ? '' : isToday ? 'text-indigo-600' : ''}">${escapeHtml(stripLabel(d.date))}${isToday ? ' ·' : ''}</span>
            <span class="mt-0.5 font-bold tabular-nums ${on ? 'text-white' : empty ? '' : 'text-slate-900'}">${n != null ? formatNumber(n) : '—'}</span>
            <span class="text-[9px] font-semibold uppercase tracking-wide ${on ? 'text-indigo-100' : 'text-slate-400'}">${escapeHtml(kicker || ' ')}</span>
          </button>`;
        })
        .join('')}
    </div>`;
}

/**
 * Put the selected date back where the reader can see it after a rebuild.
 *
 * `innerHTML` on the panel destroys the strip and its scroll offset with it, so the container came
 * back at scrollLeft 0 — the far past — with the date just clicked somewhere off the right edge.
 * Anchoring the window on today (see `stripWindowFor`) stops the chips MOVING; this stops them
 * being scrolled away.
 *
 * Remembered offsets win where they still show the selection, so a reader who has scrolled the
 * strip to compare two weeks does not get snapped back on every repaint. Otherwise the active chip
 * is centred, which is what a fresh selection wants.
 */
function keepActiveVisible(root) {
  const strip = root.querySelector('[data-date-strip]');
  const active = strip?.querySelector('[data-date][aria-current="date"]');
  if (!strip || !active) return;

  const centre = () => {
    const wanted = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    strip.scrollLeft = Math.max(0, wanted);
  };

  if (stripScrollLeft != null) {
    strip.scrollLeft = stripScrollLeft;
    // Fully visible at the remembered offset? Keep it. Otherwise centre the selection.
    const left = active.offsetLeft - strip.scrollLeft;
    if (left < 0 || left + active.offsetWidth > strip.clientWidth) centre();
  } else {
    centre();
  }
  stripScrollLeft = strip.scrollLeft;
  strip.addEventListener('scroll', () => {
    stripScrollLeft = strip.scrollLeft;
  });
}

/**
 * The date to open on.
 *
 * The newest date anything actually filed, because that is a date with a full table behind it and
 * no network at all. `today` is the fallback for a first paint before the feed has landed — the
 * strip's own `defaultDate()` cannot help until the schedule has been fetched, and waiting for it
 * is what made this view open on a shimmer.
 */
/**
 * Which date the calendar opens on: TODAY.
 *
 * It used to be the results feed's most recent filing date, which lands on a date with rows on it
 * and is wrong for the same reason a clock showing the last time anyone looked is wrong. Four days
 * into a quiet stretch the tab opened on Friday the 14th with today's chip four places to the
 * right, and nothing on screen said the selection was not the current date — it reads as a
 * dashboard whose data stopped.
 *
 * A date the reader picked wins over this, and so does `?date=` in the URL, so a shared link and a
 * session's own navigation both survive. This is only the answer to "no date chosen yet".
 */
function defaultCalendarDate(today) {
  return today;
}

function renderCalendar(ctx) {
  const today = isoToday();
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params?.date || '') ? ctx.params.date : calendarDate || defaultCalendarDate(today);
  calendarDate = wanted;
  const mode = modeFor(wanted, today);
  const spec = MODES[mode];
  // `list: 'none'` for a date already answered by the results feed — all that is wanted from the
  // route then is the strip, and asking for the company list costs the Worker a bot-walled page
  // fetch plus up to 25 identity look-ups for rows nothing will render.
  const listWanted = mode === 'reported' ? 'none' : 'full';
  const payload = calendar.forDate(wanted, listWanted);

  // Not loaded yet: fetch, then repaint. Guarded four ways — `calendarBusy` stops a rapid walk
  // along the strip stacking paints, `errorFor` stops the retry loop that a failure would
  // otherwise create (the repaint after a failed load asks for the same date again), and in
  // `reported` mode a date the strip ALREADY covers needs no request at all: the table comes from
  // memory and the count is in the strip. So walking back through a reporting season is free.
  //
  // The consequence that matters: in `reported` mode nothing on screen waits on this. A slow or
  // failed schedule no longer blanks a past date — which is what it used to do, first as a shimmer
  // and then as an amber note saying the capture did not reach that far.
  const needsFetch = !payload && (mode === 'scheduled' || !calendar.stripHas(wanted));
  if (needsFetch && !calendarBusy && !calendar.errorFor(wanted)) {
    calendarBusy = true;
    const token = renderToken;
    calendar
      .loadDate(wanted, { ...stripWindowFor(wanted, today), list: listWanted })
      .catch(() => {})
      .finally(() => {
        calendarBusy = false;
        if (token === renderToken) renderCalendar(ctx);
      });
  }

  const rows = mode === 'reported' ? feed.reportedOn(wanted) : payload?.rows || [];
  const scoped = filterByScope(rows, ctx.scope, coverage.holdings());
  const err = calendar.errorFor(wanted);
  // A schedule failure is only fatal to the SCHEDULE half. With filings on screen it is a missing
  // strip, not a missing answer, so it must not take the table down with it.
  const fatal = err && mode === 'scheduled';
  const m = feed.meta();

  const table = scoped.length
    ? scoreTable({
        rows: scoped,
        key: (r) => r.scId,
        name: (r) => (mode === 'reported' ? r.company : r.name),
        nameLabel: 'Company',
        sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || r.sectorSlug || '—'}`,
        showRank: false,
        dense: true,
        wrapHeads: mode === 'reported',
        nameMaxPx: 300,
        stickyHead: 'max(280px, calc(100vh - 420px))',
        columns: mode === 'reported' ? reportedColumns(m) : scheduledColumns(),
        // In `reported` mode the date column is gone — every row on the page is that one date — so
        // the identity column leads, which is why `nameAfter` is only set for the schedule.
        nameAfter: mode === 'reported' ? 0 : 1,
        searchable: (r) => `${mode === 'reported' ? r.company : r.name} ${r.ticker || ''} ${r.industry || ''}`,
        initialSort: { key: 'Market Cap', dir: 'desc' },
        exportName: mode === 'reported' ? 'sattva-earnings-reported' : 'sattva-earnings-calendar',
        onExport: (visible) => exportCalendar(visible, payload, { mode, date: wanted, meta: m, due: calendar.scheduledCountFor(wanted) }),
        emptyMessage: 'No companies match your filters.',
        initialView: calendarViewMode === mode ? calendarTableView : null,
      })
    : null;
  if (table) {
    calendarTableView = table.view;
    calendarViewMode = mode;
  }

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Earnings Calendar',
      description: spec.description,
      controls: `${viewToggle('calendar')}${calendarPill(payload, err, { mode, filed: rows.length })}${scopeSummary({ scope: ctx.scope, count: scoped.length, noun: spec.noun, book: coverage.meta() })}`,
    })}
    ${dateStrip(wanted, today)}
    ${
      fatal
        ? `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
             <div class="text-3xl">📅</div>
             <div class="mt-2 text-sm font-semibold text-slate-700">The results calendar could not be loaded</div>
             <div class="mt-1 text-xs text-slate-500">${escapeHtml(withoutPublisherName(err))}</div>
             <div class="mx-auto mt-3 max-w-lg text-xs text-slate-400">This date is in the future, so only the schedule can answer for it — and the schedule needs the live route. Dates that have already happened are read from the results feed instead and do not depend on it.</div>
           </div>`
        : table
          ? `${mode === 'reported' ? reportedNote(wanted, rows.length) : ''}${table.html}`
          : mode === 'reported'
            ? `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
                 <div class="text-3xl">🗓️</div>
                 <div class="mt-2 text-sm font-semibold text-slate-700">${emptyReportedTitle(wanted, today, rows.length, ctx.scope)}</div>
                 <div class="mt-1 text-xs text-slate-500">${escapeHtml(stripLabel(wanted))}${emptyReportedDetail(wanted, today, rows.length)}</div>
               </div>`
            : !payload
              ? '<div class="skeleton-shimmer h-80 rounded-2xl bg-slate-100"></div>'
              : payload.degraded
                ? `<div class="rounded-2xl bg-amber-50 p-5 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
                     <strong>Counts only for this date.</strong> ${escapeHtml(withoutPublisherName(payload.degraded))}
                   </div>`
                : `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
                     <div class="text-3xl">🗓️</div>
                     <div class="mt-2 text-sm font-semibold text-slate-700">${scopePossessive(ctx.scope) ? `None of ${scopePossessive(ctx.scope)} is scheduled on this date` : 'Nothing scheduled on this date'}</div>
                     <div class="mt-1 text-xs text-slate-500">${escapeHtml(stripLabel(wanted))}${payload.scheduledCount ? ` · ${formatNumber(payload.scheduledCount)} companies report, none in this scope` : ''}</div>
                   </div>`
    }
  `;
  wireViewToggle(ctx.root, ctx);
  for (const btn of ctx.root.querySelectorAll('[data-date]')) {
    btn.addEventListener('click', () => {
      calendarDate = btn.dataset.date;
      ctx.setParamsQuiet({ ...ctx.params, view: 'calendar', date: calendarDate });
      renderCalendar(ctx);
    });
  }
  keepActiveVisible(ctx.root);
  if (table) disposers.push(table.wire(ctx.root));
}

/**
 * "Nothing filed on this date" and "nothing filed YET" are different claims.
 *
 * The calendar now opens on today, so the commonest empty table is the one that will not be empty
 * by this evening — companies file through the day. Saying "no results were filed on this date"
 * about a day still in progress is a statement about the future dressed as a measurement, and the
 * same error class as reading a missing value as a zero.
 */
function emptyReportedTitle(iso, today, filed, scope) {
  if (filed) return scopePossessive(scope) ? `None of ${scopePossessive(scope)} filed on this date` : 'No results were filed on this date';
  return iso === today ? 'Nothing filed yet today' : 'No results were filed on this date';
}

function emptyReportedDetail(iso, today, filed) {
  if (filed) return ` · ${formatNumber(filed)} companies filed, none in this scope`;
  const due = calendar.scheduledCountFor(iso);
  if (iso !== today) return '';
  // The schedule is a claim about the future and is labelled as one — it is never differenced
  // against the filings, only printed beside them.
  return due ? ` · ${formatNumber(due)} ${due === 1 ? 'company is' : 'companies are'} due, by the published schedule` : ' · companies file through the day';
}

/**
 * Columns for a date that has happened: what the companies actually reported.
 *
 * The same cells the Latest Results table uses, so a figure means the same thing on both — and
 * `changeCell` in particular, because 13% of these rows have a sign change between periods and a
 * plain percentage across zero is not a growth rate.
 */
function reportedColumns(m) {
  const cur = m?.currentPeriod || 'Current';
  return [
    { label: `Revenue ${cur}`, get: (r) => figureCell(r.revenue?.current), html: true, align: 'right', sortValue: (r) => r.revenue?.current ?? -Infinity },
    { label: 'Revenue Growth', get: (r) => changeCell(r.revenue), html: true, align: 'right', sortValue: (r) => changeSortValue(r.revenue) },
    { label: `Net Profit ${cur}`, get: (r) => figureCell(r.netProfit?.current), html: true, align: 'right', sortValue: (r) => r.netProfit?.current ?? -Infinity },
    { label: 'Net Profit Growth', get: (r) => changeCell(r.netProfit), html: true, align: 'right', sortValue: (r) => changeSortValue(r.netProfit) },
    { label: 'Price', get: (r) => (r.ltp == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatRupee(r.ltp))), html: true, align: 'right', sortValue: (r) => r.ltp ?? -Infinity },
    { label: 'Change', get: (r) => priceChangeCell(r.changePct), html: true, align: 'right', sortValue: (r) => r.changePct ?? -Infinity },
    { label: 'Market Cap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
    { label: 'Basis', get: (r) => basisPill(r.basis), html: true, align: 'right', sortValue: (r) => r.basis || '' },
  ];
}

/** Columns for a date still to come: Moneycontrol's schedule, which carries no figures yet. */
function scheduledColumns() {
  return [
    { label: 'Date', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: (r) => r.resultDate || '' },
    { label: 'Quarter', get: (r) => escapeHtml(r.quarter || '—'), html: true, sortValue: (r) => r.quarter || '' },
    // Moneycontrol says "Time Not Available" for almost every row; the normaliser turns that into
    // null so this reads as a dash rather than a sentence where a clock belongs.
    { label: 'Time', get: (r) => (r.time ? escapeHtml(r.time) : '<span class="text-slate-300">—</span>'), html: true, sortValue: (r) => r.time || 'zzz' },
    { label: 'Price', get: (r) => (r.ltp == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatRupee(r.ltp))), html: true, align: 'right', sortValue: (r) => r.ltp ?? -Infinity },
    { label: 'Change', get: (r) => priceChangeCell(r.changePct), html: true, align: 'right', sortValue: (r) => r.changePct ?? -Infinity },
    { label: 'Market Cap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
  ];
}

/** The day's price move. A share price cannot flip sign, so this one really is a percentage. */
function priceChangeCell(pct) {
  if (pct == null) return '<span class="text-slate-300">—</span>';
  const cls = pct > 0 ? 'text-emerald-600' : pct < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${escapeHtml(pctText(pct))}</span>`;
}

/**
 * The one line a reported date needs above its table: how many filed, and — where the schedule
 * also answered — how that sits against how many were expected.
 *
 * The two numbers are from different upstreams measuring different things, so they are printed
 * side by side and never subtracted. A company can file a day late or a day early, so "234 due,
 * 210 filed" is not "24 missing" and must not be phrased as if it were.
 */
function reportedNote(iso, filed) {
  const due = calendar.scheduledCountFor(iso);
  const sched = due != null && due > 0 ? ` The calendar feed listed <strong>${escapeHtml(formatNumber(due))}</strong> as due on this date — a separate feed, and companies do file a day either side, so the two are shown side by side rather than differenced.` : '';
  return `
    <div class="mb-3 rounded-xl bg-slate-50 px-4 py-2.5 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-100">
      <strong class="text-slate-800">${escapeHtml(formatNumber(filed))} ${filed === 1 ? 'company' : 'companies'} filed on ${escapeHtml(stripLabel(iso))}.</strong>
      Read from the live results feed, so this is every one of them, not a top-20.${sched}
    </div>`;
}

/**
 * Three states, not two. The counts are always live; the LIST is live when the Worker can reach
 * Moneycontrol's calendar page and comes from the committed capture when it cannot. "Live" and
 * "Captured" are both fine — what would not be fine is showing captured rows under a Live badge.
 *
 * A fourth, for a date already reported: the table is then the results feed, which is live per
 * request and has no cap and no capture — so the pill says *Reported*, and it says so whatever the
 * schedule half is doing. Wearing "Captured" over a table of filings would attribute the wrong
 * provenance to every number under it.
 */
function calendarPill(payload, err, { mode = 'scheduled', filed = 0 } = {}) {
  if (mode === 'reported') {
    return `
      <span data-cal-info title="Reported results for this date"
        class="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-300">
        <span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>
        <span>Reported</span>
        <span class="font-normal opacity-70">${escapeHtml(formatNumber(filed))} filed</span>
      </span>`;
  }
  const bad = !!err || !!payload?.degraded;
  // Either half can be a capture and either makes the pill say so. The list and the counts fail
  // independently — the calendar page is bot-walled while the count API is not, and on 14 Aug 2026
  // the count API went flat while the list capture was fine — so "Live" may only be claimed when
  // BOTH were read live.
  const captured = payload?.listSource === 'snapshot' || payload?.countSource === 'snapshot';
  const cls = bad
    ? 'bg-slate-50 text-slate-600 ring-slate-200'
    : captured
      ? 'bg-sky-50 text-sky-800 ring-sky-300'
      : 'bg-emerald-50 text-emerald-800 ring-emerald-300';
  const dot = bad
    ? ''
    : captured
      ? '<span class="h-1.5 w-1.5 rounded-full bg-sky-500"></span>'
      : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';
  // A count of zero on a date that has named companies is the count endpoint failing, not a quiet
  // day. Say "schedule" rather than assert a number we do not believe.
  const count = believableCount(payload);
  return `
    <span data-cal-info title="Current calendar-feed status"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${cls}">
      ${dot}<span>${bad ? 'Updating' : captured ? 'Schedule updated' : 'Up to date'}</span>
      <span class="font-normal opacity-70">${count != null ? `${escapeHtml(formatNumber(count))} scheduled` : 'schedule'}</span>
    </span>`;
}

// THE PARAGRAPH THAT USED TO SIT UNDER THIS TABLE IS GONE, AND ITS CONTENT IS NOT.
//
// It carried four caveats at once — the count, the 20-row cap, whether the names were captured, and
// what a dash means — in amber, under every date, whether or not any of them applied. That is a lot
// of prose to read past on a day when nothing is wrong.
//
// Each caveat now surfaces where it is actually about something: the count and its provenance are
// in the pill and its modal, the cap and the captured-list age are in the modal, and a dash still
// carries its own title attribute. Row 1 of the exported sheet is unchanged and still spells out
// all of it, because a workbook leaves the page without any of this chrome. Decluttering is fine;
// deleting the accountability is not — see the honesty rules in CLAUDE.md.

/**
 * The count Moneycontrol give for this date, or null when we cannot stand behind it as a total.
 *
 * A count BELOW the number of companies named beneath it may not be printed as "how many report".
 * There are two quite different reasons it can happen and the same rule covers both:
 *
 *   · the count endpoint goes flat and answers 0 for every date — printing that would put
 *     "0 companies report" directly above twenty of them (see worker/index.js);
 *   · the two halves cover different exchanges. The count is `indexId=N` (NSE) and the list is
 *     `indexId=All`, so on 17 Aug 2026 the count said 1 above three named companies — one NSE and
 *     two BSE-only. Both numbers are correct answers to different questions.
 *
 * The second is not an error and must not be reported as one; it is simply not a total for what is
 * on screen. `calendarPill` prints the word "schedule" instead, and the modal says why.
 */
function believableCount(payload, shown = payload?.rows?.length || 0) {
  const raw = payload?.scheduledCount;
  return raw != null && raw >= shown ? raw : null;
}

function wireCalendarPill(root, payload, date, mode = 'scheduled') {
  const btn = root.querySelector('[data-cal-info]');
  if (!btn) return;
  if (mode === 'reported') {
    btn.addEventListener('click', () => openModal(reportedModalHtml(payload, date), { size: 'default' }));
    return;
  }
  btn.addEventListener('click', () => {
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">Results calendar</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          <p><strong>Real, live schedule</strong> — the same source as the reported results, asked the other
             way round: who is <em>due</em> to report rather than who has.</p>
          <p class="mt-2">Showing <strong>${escapeHtml(stripLabel(date))}</strong>${payload?.asOnDate ? ` · schedule as on ${escapeHtml(payload.asOnDate)}` : ''}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Two numbers, two sources</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
            <li><strong>The count on each date</strong> — from the calendar feed. Complete and unpaginated.
                ${
                  payload?.countSource === 'snapshot'
                    ? `<strong class="text-amber-700">These counts are a capture</strong>, taken ${payload.countsCapturedAt ? escapeHtml(formatRelativeTime(Date.parse(payload.countsCapturedAt))) : 'at an unknown time'}: the API is currently answering <strong>zero for every date</strong> in this window, which is its failure mode rather than a quiet fortnight — the capture holds real counts for the same dates, and names companies on them. A live zero the capture contradicts is a broken read, so the capture is shown instead of turning the strip into dashes.`
                    : 'Fetched live.'
                }</li>
            <li><strong>The company list</strong> — from the calendar page itself, which publishes the
                <strong>${escapeHtml(formatNumber(payload?.listCap ?? 20))} largest by market cap</strong> for a date and
                offers no way to page past that. So on a busy day this table names a fraction of the count beside it,
                and says so under the table rather than letting twenty rows imply twenty companies.</li>
            <li><strong>They do not cover the same exchanges.</strong> The count is NSE; the list is every exchange. So
                on a quiet date the count can be <em>smaller</em> than the number of companies named — one NSE company
                and two BSE-only ones is a count of 1 above three rows. Both numbers are right; neither is a total for
                the other. Where that happens ${believableCount(payload) == null ? '<strong>— as it does on this date —</strong> ' : ''}the
                pill says <em>schedule</em> and prints no number, because a total that contradicts the rows under it is
                worse than none.</li>
            <li><strong>Ticker and industry</strong> — resolved from the publisher's company code, live, because a
                company that has not reported yet is not in a map built from companies that have.</li>
          </ul>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Live list, or captured list</h3>
          <p class="mt-1 text-xs">The company list is read live where possible. Where it is not — the publisher's
             calendar page is behind a bot wall that answers this server with a page carrying no data, while answering
             an ordinary client normally — it comes from a capture taken by the scheduled job, which runs somewhere the
             page does answer. ${
               payload?.listSource === 'snapshot'
                 ? `<strong>This date is a capture</strong>, taken ${payload.listCapturedAt ? escapeHtml(formatRelativeTime(Date.parse(payload.listCapturedAt))) : 'at an unknown time'}.`
                 : '<strong>This date was read live.</strong>'
             }</p>
          <p class="mt-2 text-xs">A schedule is a claim about the future, so a capture that did not say how old it was
             would be worse than none — it would look exactly like a live read. That is why the pill says
             <em>Captured</em> rather than <em>Live</em>, the age is printed under the table, and the count beside it
             stays live: if the schedule has moved since the capture, the two disagree in front of you.</p>
          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What this table is not</h3>
          <p class="mt-1 text-xs">It is <strong>not the full list</strong> on a busy date.
             ${escapeHtml(formatNumber(payload?.rows?.length || 0))} ${(payload?.rows?.length || 0) === 1 ? 'company is' : 'companies are'} named here
             ${believableCount(payload) != null ? `against <strong>${escapeHtml(formatNumber(believableCount(payload)))}</strong> reporting` : ''} — the publisher caps
             the page at the ${escapeHtml(formatNumber(payload?.listCap ?? 20))} largest by market cap and offer no way to page past it,
             so treat the rows as a floor and the count as the total.</p>
          <p class="mt-4 text-xs text-slate-500">A dash in any column means <em>not known</em> — never zero.</p>
        </div>
      </div>`,
      { size: 'default' }
    );
  });
}

/**
 * The provenance behind a date that has already reported.
 *
 * Deliberately a different modal from the schedule's: every caveat there is about a top-20 capture
 * of a claim about the future, and none of them applies to a list of filings. Reusing it would
 * warn the reader about a cap this table does not have.
 */
function reportedModalHtml(payload, date) {
  const m = feed.meta();
  const filed = feed.reportedCount(date);
  const due = calendar.scheduledCountFor(date);
  return `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Reported on ${escapeHtml(stripLabel(date))}</h2>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
    </div>
    <div class="text-sm leading-relaxed text-slate-600">
      <p><strong>These companies have filed.</strong> This is not the schedule — it is the live results feed,
         the same source as the Earnings Reported table, narrowed to the one date.
         A row here is a published result, not an expectation.</p>
      <p class="mt-2">${escapeHtml(formatNumber(filed))} ${filed === 1 ? 'company' : 'companies'} on this date${m?.quarter ? `, ${escapeHtml(m.quarter)}` : ''}${m?.currentPeriod ? ` — ${escapeHtml(m.currentPeriod)} against ${escapeHtml(m.priorPeriod || '')}` : ''}.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this is not a top-20</h3>
      <p class="mt-1 text-xs">The schedule half of this view can only name the twenty largest companies for a date —
         the calendar page caps it there and offers no way to page past. The results feed has no such cap,
         so for a date that has happened every filing is here.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The count beside it</h3>
      <p class="mt-1 text-xs">${
        due != null && due > 0
          ? `The calendar feed listed <strong>${escapeHtml(formatNumber(due))}</strong> companies as due on this date. That is a different feed answering a different question, and companies file a day either side of their announced date, so the two figures are shown side by side and never subtracted. The gap between them is not a list of companies that failed to report.`
          : 'The schedule feed has no count for this date, so only the number of filings is shown. A missing count is not a zero.'
      }</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The figures</h3>
      <p class="mt-1 text-xs">Revenue and net profit are as filed, in ₹ crore. Where the sign flips between periods the
         growth column reads <em>To profit</em> / <em>To loss</em> / <em>Loss narrowed</em> instead of a percentage,
         because a percentage change across zero is not a growth rate. Market cap is the share count times the price on
         this tick. Price and the day's change are live.</p>
      <p class="mt-4 text-xs text-slate-500">A dash in any column means <em>not known</em> — never zero.</p>
    </div>
  </div>`;
}

async function exportCalendar(rows, payload, { mode = 'scheduled', date = '', meta: m = null, due = null } = {}) {
  if (mode === 'reported') {
    // A workbook leaves the page without any of the chrome above, so row 1 has to carry which of
    // the two questions this sheet answers. Getting that wrong would put filings under a heading
    // that says "scheduled", which is the one confusion this whole view exists to prevent.
    const banner = {
      __banner:
        `REAL DATA. Results AS FILED on ${date}, from the live results feed, not the schedule. ` +
        `${m?.quarter ? `${m.quarter}, ` : ''}${m?.currentPeriod ? `${m.currentPeriod} against ${m.priorPeriod}. ` : ''}` +
        `Every company that filed on this date is included; there is no cap. ` +
        `${due ? `The separate calendar feed listed ${due} companies as due on this date — a different measurement, do not subtract the two. ` : ''}` +
        `Exported ${new Date().toISOString()}. Figures in Rs. crore. Where the sign flips between periods the growth column reads ` +
        `"To profit" / "To loss" / "Loss narrowed" instead of a percentage, because a percentage change across zero is not a growth rate. ` +
        `Blank cells mean not known, not zero.`,
    };
    const pct = (mm) => (mm?.kind === 'normal' ? mm.pct : mm?.kind === 'turnaround' ? 'To profit' : mm?.kind === 'slipped-to-loss' ? 'To loss' : mm?.kind === 'loss-narrowed' ? `Loss narrowed ${mm.pct}%` : mm?.kind === 'loss-widened' ? `Loss widened ${mm.pct}%` : '');
    const cur = m?.currentPeriod || 'Current';
    const pri = m?.priorPeriod || 'Prior';
    await exportRows({
      filename: 'sattva-earnings-reported',
      sheetName: 'Reported',
      columns: [
        { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Company', key: 'c', width: 36, get: (r) => (r.__banner ? '' : r.company) },
        { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
        { header: `Revenue ${cur} (Cr)`, key: 'rv', width: 18, get: (r) => (r.__banner ? '' : (r.revenue?.current ?? '')) },
        { header: `Revenue ${pri} (Cr)`, key: 'rvp', width: 18, get: (r) => (r.__banner ? '' : (r.revenue?.prior ?? '')) },
        { header: 'Revenue Change', key: 'rg', width: 18, get: (r) => (r.__banner ? '' : pct(r.revenue)) },
        { header: `Net Profit ${cur} (Cr)`, key: 'np', width: 18, get: (r) => (r.__banner ? '' : (r.netProfit?.current ?? '')) },
        { header: `Net Profit ${pri} (Cr)`, key: 'npp', width: 18, get: (r) => (r.__banner ? '' : (r.netProfit?.prior ?? '')) },
        { header: 'Net Profit Change', key: 'pg', width: 18, get: (r) => (r.__banner ? '' : pct(r.netProfit)) },
        { header: 'Price', key: 'p', width: 14, get: (r) => (r.__banner ? '' : (r.ltp ?? '')) },
        { header: 'Change %', key: 'ch', width: 12, get: (r) => (r.__banner ? '' : (r.changePct ?? '')) },
        { header: 'MCap (Cr)', key: 'mc', width: 16, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
        { header: 'Basis', key: 'b', width: 14, get: (r) => (r.__banner ? '' : r.basis || '') },
      ],
      rows: [banner, ...rows],
    });
    return;
  }

  const banner = {
    __banner:
      `REAL DATA. Published results calendar — companies SCHEDULED to report on ${payload?.date || date || ''}` +
      `${payload?.asOnDate ? ` (schedule as on ${payload.asOnDate})` : ''}, captured ${new Date().toISOString()}. ` +
      `These companies have NOT reported yet — this is a schedule, not a set of filings. ` +
      // Same rule as the on-screen note, and it matters more here: a workbook leaves the page
      // without its chrome, so a count we do not believe must not travel with it as a fact.
      `${payload?.scheduledCount != null && payload.scheduledCount >= (payload?.rows?.length || 0) ? `${payload.scheduledCount} companies report on this date; ` : 'HOW MANY REPORT ON THIS DATE IS NOT KNOWN — the count endpoint was not answering when this was exported; '}` +
      `The publisher lists only the ${payload?.listCap ?? 20} largest by market cap per date, so THIS SHEET IS NOT THE FULL LIST. ` +
      `Market cap in Rs. crore. Blank cells mean not known, not zero.`,
  };
  await exportRows({
    filename: 'sattva-earnings-calendar',
    sheetName: 'Results Calendar',
    columns: [
      { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 36, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Quarter', key: 'q', width: 14, get: (r) => (r.__banner ? '' : r.quarter || '') },
      { header: 'Time', key: 'tm', width: 14, get: (r) => (r.__banner ? '' : r.time || '') },
      { header: 'Price', key: 'p', width: 14, get: (r) => (r.__banner ? '' : (r.ltp ?? '')) },
      { header: 'Change %', key: 'ch', width: 12, get: (r) => (r.__banner ? '' : (r.changePct ?? '')) },
      { header: 'MCap (Cr)', key: 'm', width: 16, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
    ],
    rows: [banner, ...rows],
  });
}

async function exportResults(rows, m) {
  const banner = {
    __banner:
      `REAL DATA. Quarterly results from the live published-results feed — ${m?.quarter || ''}, ` +
      `${(m?.subType || 'yoy').toUpperCase()}: ${m?.currentPeriod || ''} vs ${m?.priorPeriod || ''}, ` +
      `captured ${new Date().toISOString()}. Figures in Rs. crore. Where the sign flips between periods the "growth" column reads ` +
      `"To profit" / "To loss" / "Loss narrowed" instead of a percentage, because a percentage change across zero is not a growth rate. ` +
      `Return since result = live price vs the close on the result date. Blank cells mean not joined, not zero.`,
  };
  const pct = (mm) => (mm?.kind === 'normal' ? mm.pct : mm?.kind === 'turnaround' ? 'To profit' : mm?.kind === 'slipped-to-loss' ? 'To loss' : mm?.kind === 'loss-narrowed' ? `Loss narrowed ${mm.pct}%` : mm?.kind === 'loss-widened' ? `Loss widened ${mm.pct}%` : '');
  // The sheet carries the same three metrics × two periods the table does. Ticker and industry
  // stay as columns here even though they are no longer columns on screen: a spreadsheet has no
  // second line under the company name, and a workbook you cannot filter by ticker is less useful.
  const cur = m?.currentPeriod || 'Current';
  const pri = m?.priorPeriod || 'Prior';
  const val = (mm, field) => (mm?.[field] ?? '');
  await exportRows({
    filename: 'sattva-earnings',
    sheetName: 'Latest Results',
    columns: [
      { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.company) },
      { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: `Revenue ${cur} (Cr)`, key: 'rv', width: 18, get: (r) => (r.__banner ? '' : val(r.revenue, 'current')) },
      { header: `Revenue ${pri} (Cr)`, key: 'rvp', width: 18, get: (r) => (r.__banner ? '' : val(r.revenue, 'prior')) },
      { header: 'Revenue Change', key: 'rg', width: 18, get: (r) => (r.__banner ? '' : pct(r.revenue)) },
      { header: `Gross Profit ${cur} (Cr)`, key: 'gp', width: 20, get: (r) => (r.__banner ? '' : val(r.grossProfit, 'current')) },
      { header: `Gross Profit ${pri} (Cr)`, key: 'gpp', width: 20, get: (r) => (r.__banner ? '' : val(r.grossProfit, 'prior')) },
      { header: 'Gross Profit Change', key: 'gg', width: 20, get: (r) => (r.__banner ? '' : pct(r.grossProfit)) },
      { header: `Net Profit ${cur} (Cr)`, key: 'np', width: 18, get: (r) => (r.__banner ? '' : val(r.netProfit, 'current')) },
      { header: `Net Profit ${pri} (Cr)`, key: 'npp', width: 18, get: (r) => (r.__banner ? '' : val(r.netProfit, 'prior')) },
      { header: 'Net Profit Change', key: 'pg', width: 18, get: (r) => (r.__banner ? '' : pct(r.netProfit)) },
      { header: 'MCap (Cr)', key: 'm', width: 14, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
      { header: 'Return Since Result %', key: 'rs', width: 20, get: (r) => (r.__banner ? '' : (r.returnSinceResult ?? '')) },
      { header: 'Basis', key: 'b', width: 14, get: (r) => (r.__banner ? '' : r.basis) },
    ],
    rows: [banner, ...rows],
  });
}
