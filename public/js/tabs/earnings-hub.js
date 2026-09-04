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
//   legacy scoring code remain available, but the synthetic set is no longer loaded. Analyst
//   estimates are unavailable; Company Filings provides original documents, not estimated metrics.
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

import { scoreTable, sectionHead, companySeededView } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { withoutPublisherName } from '../core/source-copy.js';
import { formatCroreCompact, formatPct, formatNumber, formatRupee } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/earnings-live.js';
import * as calendar from '../data/earnings-calendar.js';
import * as coverage from '../data/coverage.js';
import { filterByScope, scopePossessive } from '../data/scope.js';
import { renderCompanyFilings } from './company-filings.js';
import { domesticFilingsHref } from '../data/domestic-filings-shared.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
  // No sub-views: this tab is one table. The shell hides the rail entirely when this is empty.
  subviews: [],
};

// Filed results, scheduled results, and original company documents.
const VIEWS = [
  { value: 'reported', label: 'Earnings Reported', help: 'Companies that have already filed this quarter' },
  { value: 'calendar', label: 'Earnings Calendar', help: 'Companies scheduled to report, by date' },
  { value: 'filings', label: 'Company Filings', help: 'Annual reports, earnings reports and concall transcripts' },
];

let disposers = [];
let renderToken = 0;
let calendarDate = null; // the selected date in the calendar view
let calendarBusy = false;
// The date strip's horizontal scroll offset, carried across the panel rebuilds that a date click,
// a schedule arriving or a scope change all cause. Without it every rebuild put the strip back at
// its oldest date with the selection off-screen — see `keepActiveVisible`.
let stripScrollLeft = null;
// The calendar table's own view state, carried across schedule repaints for the same reason
// `tableView` is: refreshing a date must not throw away the reader's search and sort.
let calendarTableView = null;
// The table is rebuilt whenever a company files. Carrying its view forward means the reader's
// search, filters, watchlist toggle and sort survive that rebuild instead of resetting under them.
let tableView = null;
// The `?company=` a citation or an AI Alerts card arrived with — seeded into the search once.
let routeCompany = null;
// Set when a QoQ/YoY switch was asked for and could not be made. Rendered as an amber note rather
// than swallowed, because the alternative is one comparison shown under the other's label.
let periodError = null;

export function render(ctx) {
  const token = ++renderToken;
  if (viewOf(ctx) === 'filings') {
    disposers.push(renderCompanyFilings(ctx, { controls: viewToggle('filings'), wireControls: wireViewToggle }));
    return;
  }
  ctx.root.innerHTML = loadingHtml();
  const seeded = companySeededView(ctx, routeCompany, tableView);
  routeCompany = seeded.company;
  tableView = seeded.view;

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
          if (viewOf(ctx) === 'reported') paint(ctx);
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
  routeCompany = null;
  periodError = null;
  calendarDate = null;
  stripScrollLeft = null;
  calendarTableView = null;
  calendar.reset();
}

/** Which half of the tab the URL is asking for. Anything unrecognised falls back to reported. */
const viewOf = (ctx) => (['calendar', 'filings'].includes(ctx.params?.view) ? ctx.params.view : 'reported');

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
      { label: 'Filings', get: (r) => r.ticker ? `<a data-norow class="font-semibold text-indigo-600" href="${escapeHtml(domesticFilingsHref(r.ticker, { form: 'earnings_report', scope: ctx.scope }))}">Reports</a>` : '—', html: true, sortable: false },
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
// Earnings Calendar — Moneycontrol's all-exchange scheduled-results calendar.
//
// This view answers one question on every date: who was scheduled to report? It deliberately does
// not turn into a filings table for today or past dates. The adjacent Earnings Reported view
// answers that second question from the published-results feed. Keeping the two views separate
// makes the label, count and rows agree with the linked source.
// ---------------------------------------------------------------------------------------

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
 * A restored/shared date can sit outside the current Moneycontrol window. Keep that requested
 * date visible with an unknown count until its own request returns.
 */
function stripDays(active) {
  const days = calendar.strip();
  const seen = new Set(days.map((d) => d.date));
  const extra = [];
  if (active && !seen.has(active)) extra.push({ date: active, count: null });
  return [...days, ...extra].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * The number on a chip, and what it is a number OF.
 *
 * Every chip is a scheduled count from the same all-exchange population as the rows beneath it.
 */
function chipCount(iso) {
  const co = (n) => (n === 1 ? 'company' : 'companies');
  const scheduled = calendar.scheduledCountFor(iso);
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
          const { n, kicker, noun } = chipCount(d.date);
          const empty = readable && !d.count;
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
  const payload = calendar.forDate(wanted);

  // Every selected date asks for the complete scheduled-company list. The Worker follows the
  // publisher's pagination and keeps a dated capture as the fallback when the live edge is blocked.
  if (!payload && !calendarBusy && !calendar.errorFor(wanted)) {
    calendarBusy = true;
    const token = renderToken;
    calendar
      .loadDate(wanted, { ...stripWindowFor(wanted, today), list: 'full' })
      .catch(() => {})
      .finally(() => {
        calendarBusy = false;
        if (token === renderToken) renderCalendar(ctx);
      });
  }

  const rows = payload?.rows || [];
  const scoped = filterByScope(rows, ctx.scope, coverage.holdings());
  const err = calendar.errorFor(wanted);
  const fatal = err && !payload;

  const table = scoped.length
    ? scoreTable({
        rows: scoped,
        key: (r) => r.scId,
        name: (r) => r.name,
        nameLabel: 'Company',
        sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || r.sectorSlug || '—'}`,
        showRank: false,
        dense: true,
        nameMaxPx: 300,
        stickyHead: 'max(280px, calc(100vh - 420px))',
        columns: scheduledColumns(),
        nameAfter: 1,
        searchable: (r) => `${r.name} ${r.ticker || ''} ${r.industry || ''} ${r.exchange || ''}`,
        initialSort: { key: 'Market Cap', dir: 'desc' },
        exportName: 'sattva-earnings-calendar',
        onExport: (visible) => exportCalendar(visible, payload, wanted),
        emptyMessage: 'No companies match your filters.',
        initialView: calendarTableView,
      })
    : null;
  if (table) calendarTableView = table.view;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Earnings Calendar',
      description: 'Companies scheduled to report, by date. Pick a date from the strip.',
      controls: `${viewToggle('calendar')}${calendarPill(payload, err)}${scopeSummary({ scope: ctx.scope, count: scoped.length, noun: 'scheduled', book: coverage.meta() })}`,
    })}
    ${dateStrip(wanted, today)}
    ${
      fatal
        ? `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
             <div class="text-3xl">📅</div>
             <div class="mt-2 text-sm font-semibold text-slate-700">The results calendar could not be loaded</div>
             <div class="mt-1 text-xs text-slate-500">${escapeHtml(withoutPublisherName(err))}</div>
             <div class="mx-auto mt-3 max-w-lg text-xs text-slate-400">The Earnings Calendar is the scheduled-results view. Earnings Reported remains available separately for filed results.</div>
           </div>`
        : table
          ? table.html
          : !payload
            ? '<div class="skeleton-shimmer h-80 rounded-2xl bg-slate-100"></div>'
            : payload.degraded
              ? `<div class="rounded-2xl bg-amber-50 p-5 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
                   <strong>Calendar list unavailable for this date.</strong> ${escapeHtml(withoutPublisherName(payload.degraded))}
                 </div>`
              : `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
                   <div class="text-3xl">🗓️</div>
                   <div class="mt-2 text-sm font-semibold text-slate-700">${scopePossessive(ctx.scope) ? `None of ${scopePossessive(ctx.scope)} is scheduled on this date` : 'Nothing scheduled on this date'}</div>
                   <div class="mt-1 text-xs text-slate-500">${escapeHtml(stripLabel(wanted))}${payload.scheduledCount ? ` · ${formatNumber(payload.scheduledCount)} companies scheduled, none in this scope` : ''}</div>
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

/** Moneycontrol's scheduled-result columns; filed financials live in Earnings Reported. */
function scheduledColumns() {
  return [
    { label: 'Date', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: (r) => r.resultDate || '' },
    { label: 'Quarter', get: (r) => escapeHtml(r.quarter || '—'), html: true, sortValue: (r) => r.quarter || '' },
    { label: 'Exchange', get: (r) => escapeHtml(r.exchange === 'N' ? 'NSE' : r.exchange === 'B' ? 'BSE' : r.exchange || '—'), html: true, sortValue: (r) => r.exchange || '' },
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
 * Three states, not two. The count and list are live when the Worker can reach
 * Moneycontrol's calendar page and comes from the committed capture when it cannot. "Live" and
 * "Captured" are both fine — what would not be fine is showing captured rows under a Live badge.
 */
function calendarPill(payload, err) {
  if (!payload && !err) {
    return `
      <span data-cal-info title="Loading the current calendar feed"
        class="inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400"></span><span>Loading calendar</span>
      </span>`;
  }
  const bad = !!err || !!payload?.degraded || payload?.complete !== true || !payload?.countSource || !payload?.listSource;
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

/**
 * The count Moneycontrol give for this date, or null when we cannot stand behind it as a total.
 *
 * Both halves now use `indexId=All`, so a complete response should match its row count exactly.
 * A mismatch can still occur when a live count and captured list were observed at different
 * times; omit the number rather than presenting that mixed observation as a total.
 */
function believableCount(payload, shown = payload?.rows?.length || 0) {
  const raw = payload?.scheduledCount;
  if (raw == null) return null;
  if (payload?.complete && shown && raw !== shown) return null;
  return raw >= shown ? raw : null;
}

async function exportCalendar(rows, payload, date = '') {
  const count = believableCount(payload);
  const completeness = payload?.complete && count === (payload?.rows?.length || 0)
    ? `Every published row was included across ${payload.pagesFetched || 1} page${payload.pagesFetched === 1 ? '' : 's'}. `
    : 'The count and list could not be verified as one complete observation; treat the visible rows as the available schedule. ';
  const banner = {
    __banner:
      `REAL DATA. Published results calendar — companies SCHEDULED to report on ${payload?.date || date || ''}` +
      `${payload?.asOnDate ? ` (schedule as on ${payload.asOnDate})` : ''}, exported ${new Date().toISOString()}. ` +
      `This is a schedule, not a set of filed results. ` +
      `${count != null ? `${count} ${count === 1 ? 'company is' : 'companies are'} scheduled on this date. ` : ''}` +
      completeness +
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
      { header: 'Exchange', key: 'ex', width: 12, get: (r) => (r.__banner ? '' : r.exchange === 'N' ? 'NSE' : r.exchange === 'B' ? 'BSE' : r.exchange || '') },
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
