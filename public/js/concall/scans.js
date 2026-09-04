// concall/scans.js — the Con-call tab, live off StockScans.
//
//   renderScans(ctx)         the quarter's calls: result score, sentiment, highlights, links
//   openScheduleModal(rows)  "Upcoming Concalls" — the schedule, as an overlay off that table
//
// This is the WHOLE tab now. It used to be two of six sub-views behind a left rail; the other
// four ran on a synthetic transcript corpus with fictional speakers, and they are gone. One
// screen, one provenance, no ribbon to explain which half you are looking at.
//
// EVERYTHING SCORED HERE IS STOCKSCANS' OWN ANALYSIS.
//   `resultScore` (0-100), `sentimentTier` (0-4) and the highlight bullets are theirs, rendered
//   unchanged. The tier LABELS come from their published bands (see data/stockscans-shared.js),
//   so "Strong" here means what "Strong" means there. We deliberately compute nothing of our own
//   on top — a number under our chrome that they did not produce would be the dishonest case, and
//   a band of our own invention under their score would be worse.
//
//   That is why this view uses `scoreTable`'s Score column with `max: 100` rather than the
//   dashboard's usual points-out-of-max: it is a published index, not a model of ours.
//
// PENDING IS NOT ZERO.
//   A call appears on the feed when it is HELD and acquires its analysis some minutes later.
//   Until then `resultScore` is null and StockScans' own UI says "pending". A zero would claim
//   they had assessed it and found it worthless.
//
// THE DEEP DIVE COLUMN TALKS TO A THIRD DASHBOARD, AND STARTING A RUN THERE COSTS MONEY.
//   The last column hands a row to Concall Deep Dive, a separate Cloudflare Worker that runs its
//   own LLM pipeline over the call and publishes a report. Three rules hold here:
//     - Nothing that costs a run ever fires on its own. `POST /api/analyze` is unauthenticated
//       and every accepted call is a real compute run, so no poller registers it, no row triggers
//       it on render, the cell is a button, and the panel confirms before dispatching.
//     - Reading their index IS free, and the column uses that. `GET /api/summary` lists the
//       reports they already hold; it is fetched once per page load, and the rows it names get a
//       "Ready" button that opens the finished report at no cost to anyone. The reader should not
//       have to pay to discover the answer already exists.
//     - The report is theirs. js/concall/deep-dive.js lays it out and computes nothing on top,
//       and every finished report links to their own rendering of it — same rule as the
//       StockScans scores above and the Trendlyne holding values on Institutions.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { deliveryNote } from '../ui/sources.js';
import { escapeHtml } from '../core/dom.js';
import { domesticFilingsHref } from '../data/domestic-filings-shared.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/concall-scans.js';
import * as deepDive from '../data/deep-dive.js';
import { openDeepDive } from './deep-dive.js';
import * as coverage from '../data/coverage.js';
import { scopePossessive } from '../data/scope.js';

const ATTRIBUTION = 'Scores, sentiment and highlights are the research provider’s own analysis, shown unchanged.';

// StockScans' tone vocabulary -> our semantic palette. Emerald/amber/rose are pass/partial/fail
// here, which is exactly what these tiers mean, so the mapping is honest rather than decorative.
const TONE = {
  excellent: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  grey: 'bg-slate-100 text-slate-600 ring-slate-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const pendingPill = (what) =>
  `<span class="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-400 ring-1 ring-slate-200" title="The research provider has not published ${escapeHtml(what)} for this call yet. Not zero — not yet analysed.">pending</span>`;

function tierPill(tier, title) {
  if (!tier) return pendingPill(title || 'an assessment');
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TONE[tier.tone] || TONE.grey}">${escapeHtml(tier.label)}</span>`;
}

// "▲ Revenue guidance raised" — the marker is StockScans'; it carries the direction, so it drives
// the colour rather than any reading of ours.
function highlight(tag) {
  const s = String(tag || '');
  const mark = s.charAt(0);
  const text = s.slice(1).trim() || s;
  const cls = mark === '▲' ? 'text-emerald-700' : mark === '▼' ? 'text-rose-700' : 'text-slate-600';
  const dot = mark === '▲' ? '▲' : mark === '▼' ? '▼' : '●';
  return `<span class="flex items-start gap-1 ${cls}"><span class="mt-px flex-shrink-0 text-[9px] leading-4">${dot}</span><span>${escapeHtml(text)}</span></span>`;
}

// EVERY TIME ON THIS TAB IS IST, EXPLICITLY — NOT THE VIEWER'S ZONE.
//
// An Indian earnings call at 18:00 IST is an 18:00 IST event. Rendering it in the browser's local
// zone turned it into "12:30" on a UTC machine: the same instant, but not the time anyone involved
// would ever call it, and off by a day either side of midnight. Company schedules are published in
// IST and read in IST, so that is what we show, with the zone named so it cannot be misread.
const IST = 'Asia/Kolkata';
const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });
const IST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
const IST_FULL = new Intl.DateTimeFormat('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' });

function whenCell(iso) {
  if (!iso) return '<span class="text-slate-300">—</span>';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '<span class="text-slate-300">—</span>';
  return `<span class="whitespace-nowrap" title="${escapeHtml(IST_FULL.format(d))} IST">${escapeHtml(IST_DATE.format(d))}<span class="ml-1 text-slate-400">${escapeHtml(IST_TIME.format(d))}</span></span>`;
}

// ---------------------------------------------------------------------------------------
// The passive Live/Snapshot status pill
// ---------------------------------------------------------------------------------------
export function livePill(m) {
  if (!m) return '';
  const degraded = !!m.degraded;
  const cls = degraded
    ? 'bg-amber-50 text-amber-800 ring-amber-300'
    : 'bg-emerald-50 text-emerald-800 ring-emerald-300';
  const dot = degraded
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';
  const fresh = feed.newArrivals().length;
  return `
    <span data-cs-info title="Current con-call feed status"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${cls}">
      ${dot}<span>${degraded ? 'Snapshot' : 'Live'}</span>
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.count || 0))} calls</span>
      ${fresh ? `<span class="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">+${fresh} new</span>` : ''}
    </span>`;
}

export function wireLivePill(root, m) {
  const btn = root.querySelector('[data-cs-info]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const arrivals = feed.newArrivals();
    const pending = feed.all().filter((r) => r.resultScore == null).length;
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">${m.degraded ? 'Showing the last snapshot' : 'Live con-call scan'}</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          ${
            m.degraded
              ? `<p class="rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">${escapeHtml(m.degraded)}
                   The rows below were correct when captured, but they are not live right now.</p>`
              : `<p><strong>Real, live</strong> from an independent con-call research provider, polled every
                   ${feed.POLL_MS / 1000} seconds.</p>`
          }
          <p class="mt-2"><strong>${escapeHtml(formatNumber(m.count || 0))}</strong> calls this quarter ·
             <strong>${escapeHtml(formatNumber(m.analysed || 0))}</strong> analysed ·
             last update ${escapeHtml(m.receivedAt ? formatRelativeTime(m.receivedAt) : '—')}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Whose numbers these are</h3>
          <p class="mt-1 text-xs"><strong>Not ours.</strong> The result score, the sentiment tier and the highlight bullets are
             a third-party research provider's analysis of each call, reproduced unchanged. Even the tier labels — Excellent /
             Strong / Average / Weak / Poor, and Bullish through Bearish — use their published cut-points, so a label here
             means what it means there. This dashboard adds no scoring of its own to this view, deliberately: a band of our invention under
             their score would read as their judgement and be ours.</p>
          <p class="mt-2 text-xs">Their bands, quoted rather than restated: <strong>80+ Excellent, 60+ Strong, 40+ Average,
             20+ Weak, below that Poor</strong>. <strong>This dashboard does not re-band or recompute</strong> any of it, and
             it is <strong>not this dashboard's assessment</strong> of the company.</p>
          <p class="mt-2 text-xs">Rows are not clickable, on purpose. The summary and the transcript live on their reader, so
             each row links out to it rather than opening a page of ours restating their analysis under our chrome.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How fresh it is</h3>
          <p class="mt-1 text-xs">A call joins the feed when it is <em>held</em> and gains its score some minutes later, once
             the provider has processed it. The poller watches for both, so a row can arrive twice over: once listed, once
             analysed. ${pending ? `<strong>${escapeHtml(formatNumber(pending))}</strong> calls are listed but not yet analysed — they read <em>pending</em>, never zero.` : ''}</p>

          ${deliveryNote(m, { poll: feed.POLL_MS / 1000 })}

          ${
            arrivals.length
              ? `<h3 class="font-display mt-4 text-sm font-bold text-slate-900">Arrived while this tab was open</h3>
                 <div class="mt-1 flex flex-wrap gap-1.5">
                   ${arrivals
                     .slice(0, 20)
                     .map(
                       (r) =>
                         `<span class="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200" title="${r.reason === 'analysed' ? 'analysis published' : 'newly listed'}">${escapeHtml(r.ticker || r.name)}${r.reason === 'analysed' ? ' ✓' : ''}</span>`
                     )
                     .join('')}
                 </div>
                 <p class="mt-1 text-[11px] text-slate-500">A tick means the call was already listed and has just been analysed.</p>`
              : ''
          }
          <p class="mt-4 text-xs text-slate-500">Full summaries and transcripts live with the provider; each row links straight to theirs.</p>
        </div>
      </div>`,
      { size: 'default' }
    );
  });
}

// ---------------------------------------------------------------------------------------
// Sub-view 1 — the scan table
// ---------------------------------------------------------------------------------------
export function renderScans(ctx, { disposers, tableView, onView }) {
  const m = feed.meta();
  const rows = feed.forScope(ctx.scope, coverage.holdings());
  // Both read once for the whole paint rather than per row — see rememberedMap() in
  // data/deep-dive.js. `saved` is the stronger fact of the two: a report already on this device
  // opens with no run AND no request, so those rows are marked before their index has even landed.
  const dived = deepDive.rememberedMap();
  const saved = deepDive.savedByTicker();

  const table = scoreTable({
    rows,
    key: rowKey,
    // THE STAR MARKS THE COMPANY, NOT THE ROW. `key` above identifies the row and is not a ticker
    // here, so without this the watchlist would fill with row ids and the Watchlist scope — which
    // narrows every feed on this dashboard by symbol — would have nothing it could match.
    watchKey: (r) => r.ticker || null,
    watchName: (r) => r.name || r.ticker,
    name: (r) => r.name,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || '—'}`,
    showRank: false,
    nameAfter: 1,
    dense: true,
    nameMaxPx: 250,
    stickyHead: 'max(320px, calc(100vh - 330px))',
    columns: [
      { label: 'Call', get: (r) => whenCell(r.when), html: true, align: 'left', sortValue: (r) => r.when || '' },
      { label: 'Filings', get: (r) => r.ticker ? `<a data-norow class="font-semibold text-indigo-600" href="${escapeHtml(domesticFilingsHref(r.ticker, { form: 'concalls', scope: ctx.scope }))}">Transcripts</a>` : '—', html: true, sortable: false },
      {
        // Their index, on their scale. `max: 100` and no tier colouring of our own — the badge
        // beside it is their label for that band.
        label: 'Result Score',
        get: (r) =>
          r.resultScore == null
            ? pendingPill('a result score')
            : `<span class="font-semibold tabular-nums text-slate-900">${escapeHtml(r.resultScore.toFixed(1))}</span><span class="ml-1 text-[10px] text-slate-400">/100</span>`,
        html: true,
        align: 'right',
        sortValue: (r) => r.resultScore ?? -1,
      },
      { label: 'Result', get: (r) => tierPill(r.resultTier, 'a result score'), html: true, align: 'right', sortValue: (r) => r.resultScore ?? -1 },
      { label: 'Sentiment', get: (r) => tierPill(r.sentiment, 'a sentiment reading'), html: true, align: 'right', sortValue: (r) => r.sentimentTier ?? -1 },
      {
        label: 'Highlights',
        get: (r) =>
          r.tags.length
            ? `<div class="flex max-w-[380px] flex-col gap-0.5 whitespace-normal text-[11px] leading-snug">${r.tags.slice(0, 3).map(highlight).join('')}</div>`
            : `<span class="text-slate-300">—</span>`,
        html: true,
        sortable: false,
      },
      {
        // An action, not a reading — so it does not sort, and it is not in the export either: a
        // workbook of "click here" cells would be a column of nothing.
        label: 'Deep Dive',
        get: (r) => deepDiveButton(r, dived, saved),
        html: true,
        align: 'right',
        sortable: false,
      },
    ],
    filters: [
      {
        label: 'Result tier',
        options: [
          { value: 'all', label: 'All results' },
          { value: 'excellent', label: 'Excellent (80+)' },
          { value: 'strong', label: 'Strong (60+)' },
          { value: 'weak', label: 'Weak or Poor (<40)' },
          { value: 'pending', label: 'Awaiting analysis' },
        ],
        match: (r, v) => {
          if (v === 'pending') return r.resultScore == null;
          if (r.resultScore == null) return false;
          if (v === 'excellent') return r.resultScore >= 80;
          if (v === 'strong') return r.resultScore >= 60;
          if (v === 'weak') return r.resultScore < 40;
          return true;
        },
      },
      {
        label: 'Sentiment',
        options: [
          { value: 'all', label: 'All sentiment' },
          { value: '4', label: 'Bullish' },
          { value: '3', label: 'Optimistic' },
          { value: '2', label: 'Neutral' },
          { value: '1', label: 'Cautious' },
          { value: '0', label: 'Bearish' },
        ],
        match: (r, v) => String(r.sentimentTier) === v,
      },
    ],
    searchable: (r) => `${r.name} ${r.ticker || ''} ${r.industry || ''} ${r.tags.join(' ')}`,
    // The way out to the provider's reader, which is the one thing the removed drill panel carried
    // that was not already on the row. Their reader is where the summary and the transcript live;
    // this tab is their index and links to it rather than reproducing it. `docUrl` builds their
    // DOCUMENT route — the company route needs a period this payload does not carry, and building
    // it short is what made every one of these links 404.
    link: (r) => r.transcriptUrl,
    initialSort: { key: 'Call', dir: 'desc' },
    exportName: 'sattva-concall-scans',
    onExport: (visible) => exportScans(visible, m),
    emptyMessage: scopePossessive(ctx.scope) ? `None of ${scopePossessive(ctx.scope)} has held a call this quarter.` : 'No calls match your filters.',
    initialView: tableView,
  });
  onView?.(table.view);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Concall Scans',
      description: `Every earnings call held this quarter, newest first. Times are IST. ${ATTRIBUTION}`,
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'calls', book: coverage.meta() }),
    })}
    ${table.html}
  `;
  disposers.push(table.wire(ctx.root));

  // Delegated on the host rather than per button: the table body is rebuilt on every sort, filter
  // and live tick, and 500 listeners would be rebuilt with it. The button carries `data-norow`, so
  // scoreTable's own handler leaves the drill closed and lets this one through.
  const onDeepDive = (e) => {
    const btn = e.target.closest('[data-deep-dive]');
    if (!btn) return;
    const row = rows.find((r) => rowKey(r) === btn.dataset.deepDive);
    if (!row) return;
    // A report they already hold — or one this device has kept — opens directly; anything else
    // goes through the confirm step.
    const ready = row.ticker ? readyReports[String(row.ticker).toUpperCase()] : null;
    openDeepDive(row, {
      ready,
      onRecorded: () => markDived(btn),
      // The moment a report is durably on this device, the row says so: the next click on it is
      // free and instant, and the reader should not have to click to discover that.
      onSaved: () => markReady(btn, null, deepDive.savedFor(row.ticker)),
    });
  };
  ctx.root.addEventListener('click', onDeepDive);
  disposers.push(() => ctx.root.removeEventListener('click', onDeepDive));

  // Their index of finished reports. A GET, no pipeline behind it, so unlike a dispatch it is
  // fine to ask for unprompted — and it is the difference between a reader paying to find out a
  // report exists and simply being shown that it does. Resolved once per page load; when it
  // lands, the rows it names are marked in place rather than by rebuilding the table.
  loadReady().then((ready) => {
    if (!ready || !ctx.root.isConnected) return;
    for (const btn of ctx.root.querySelectorAll('[data-deep-dive]')) {
      const row = rows.find((r) => rowKey(r) === btn.dataset.deepDive);
      const hit = row?.ticker ? ready[String(row.ticker).toUpperCase()] : null;
      if (hit) markReady(btn, hit);
    }
  });
}

// ticker -> their summary row, for every company they have already analysed. Module-level so a
// live repaint paints the marks immediately instead of waiting on the promise again.
let readyReports = {};
let readyPromise = null;
function loadReady() {
  if (!readyPromise) {
    readyPromise = deepDive
      .readyByTicker()
      .then((map) => {
        readyReports = map || {};
        return readyReports;
      })
      .catch(() => ({}));
  }
  return readyPromise;
}

/** The row key, in one place, because the Deep Dive button carries it back. */
// The feed's own id, not a key of this tab's making — the provider can hold two analyses of one
// call, so (company, time) is not unique. See `rowIdOf` in js/data/concall-scans.js.
const rowKey = (r) => feed.rowUid(r);

/**
 * The Deep Dive cell.
 *
 * A button and nothing more — no run is dispatched until the reader confirms one inside the panel,
 * because that is a real LLM run on an unauthenticated endpoint. Three different facts, three
 * different marks, and the distinction is the most useful thing this column can carry:
 *
 *   dot on an outlined button   this browser has dispatched a run for that ticker
 *   filled button               a finished report opens for free — no run
 *
 * The filled state is reached two ways: their index says they hold a report, or this device does.
 * The second is stronger — it needs no network at all — and it is known synchronously, so those
 * rows are already filled on first paint rather than upgraded when `/api/summary` lands.
 */
function deepDiveButton(r, dived, saved) {
  const t = r.ticker ? String(r.ticker).toUpperCase() : '';
  // Once their index has resolved, later paints render the Ready state directly instead of
  // painting the plain button and upgrading it a frame later.
  const hit = t ? readyReports[t] : null;
  const kept = t ? saved[t] : null;
  if (hit || kept) return readyButtonHtml(r, hit, kept);
  const seen = t ? dived[t] : null;
  return `
    <button type="button" data-norow data-deep-dive="${escapeHtml(rowKey(r))}"
      title="${seen ? 'Open the Deep Dive — a run for this company is already on record' : 'Analyse this call on the Concall Deep Dive dashboard (asks first — a run costs compute)'}"
      class="inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] font-bold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>
      <span>Deep Dive</span>
      ${seen ? '<span data-dived class="ml-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true"></span>' : ''}
    </button>`;
}

/** Stamp the "run on record" dot on one button, the moment the run gets its id. */
function markDived(btn) {
  if (btn.querySelector('[data-dived]')) return;
  const dot = document.createElement('span');
  dot.dataset.dived = '';
  dot.className = 'ml-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500';
  dot.setAttribute('aria-hidden', 'true');
  btn.appendChild(dot);
  btn.title = 'Open the Deep Dive — a run for this company is already on record';
}

/**
 * Upgrade a button to "Ready": a finished report opens for free, either because Concall Deep Dive
 * holds one or because this device does. Filled rather than outlined, because the difference
 * between "opens a report" and "starts a metered run" is the most important thing this column can
 * tell a reader.
 *
 * The title is refreshed even on a button already marked ready — a row that was free because THEY
 * hold the report becomes free-and-instant once we do, and that is worth saying.
 */
function markReady(btn, hit, kept = null) {
  if (btn.dataset.ddReady && !kept) return;
  btn.dataset.ddReady = '1';
  if (kept) btn.dataset.ddSaved = '1';
  btn.className = READY_CLASS;
  btn.innerHTML = READY_INNER;
  btn.title = readyTitle(hit, kept);
}

const READY_CLASS =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-bold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';
const READY_INNER =
  '<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span>Deep Dive</span>';
const readyTitle = (hit, kept = null) => {
  if (kept)
    return `Report saved on this device${kept.quarter ? ` for ${kept.quarter}` : ''}${kept.savedAt ? ` ${formatRelativeTime(kept.savedAt)}` : ''}. Opens straight away — no run, and nothing to download.`;
  return `Report ready${hit.quarter ? ` for ${hit.quarter}` : ''}${hit.generated_at ? ` — Concall Deep Dive generated it ${formatRelativeTime(hit.generated_at)}` : ''}. Opens without starting a run.`;
};

const readyButtonHtml = (r, hit, kept = null) =>
  `<button type="button" data-norow data-dd-ready="1"${kept ? ' data-dd-saved="1"' : ''} data-deep-dive="${escapeHtml(rowKey(r))}" title="${escapeHtml(readyTitle(hit, kept))}" class="${READY_CLASS}">${READY_INNER}</button>`;

/** The one way into the schedule now that it is not a sub-view. Carries its own count. */
function scheduleButton(count) {
  return `
    <button type="button" data-open-schedule title="Calls scheduled but not yet held"
      class="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <span>Upcoming Concalls</span>
      ${count ? `<span class="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">${escapeHtml(formatNumber(count))}</span>` : ''}
    </button>`;
}

// ---------------------------------------------------------------------------------------
// The schedule, as an overlay — "Upcoming Concalls"
//
// This used to be a second sub-view with its own page. It is a modal off the scan table now,
// which is how StockScans present it, and it is the right shape for the content: a schedule is
// something you glance at and dismiss, not somewhere you navigate to and lose your place in the
// table for.
//
// BUILT FROM `upcoming` ALONE, NOT FROM `upcoming` + `today`.
//   The two overlap. `today` is the subset of today's calls that have not started yet (43 of the
//   64 listed for today, at the time of writing), so merging them would double-count and then
//   need de-duplicating for no gain. `upcoming` already contains the whole day, which is exactly
//   what a calendar should show: the 09:00 call belongs on today's page at 15:00, it has simply
//   already happened.
// ---------------------------------------------------------------------------------------

// StockScans print schedule times as "9:00 AM". Everything else on this tab is 24-hour, but this
// panel is theirs and reads as theirs. Still explicitly IST — see the note above IST_DATE.
const IST_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
const IST_WEEKDAY = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short' });
const IST_DAYMONTH = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });

// How many companies a day shows before it collapses behind "+N more". Seven plus the "+N more"
// cell fills two rows of the four-column grid exactly, which is why it is seven and not eight.
const PER_DAY = 7;

// Which days the reader has expanded, and what they have typed. Module state rather than a
// closure because the modal re-renders its own body in place on every interaction.
let calExpanded = new Set();
let calQuery = '';

/**
 * The schedule overlay. `rows` is the upcoming list already narrowed to the active scope, so the
 * Portfolio/Universe toggle reaches in here too rather than the panel quietly ignoring it.
 */
export function openScheduleModal(rows, { scope = 'universe' } = {}) {
  calExpanded = new Set();
  calQuery = '';
  openModal(scheduleModalHtml(rows, scope), { size: 'wide' });
  wireScheduleModal(rows, scope);
}

function scheduleModalHtml(rows, scope) {
  return `
    <div class="flex max-h-[85vh] flex-col">
      <div class="flex flex-shrink-0 items-center gap-3 border-b border-slate-100 px-6 py-4">
        <span class="text-lg" aria-hidden="true">🗓️</span>
        <h2 class="font-display text-lg font-bold text-slate-900">Upcoming Concalls</h2>
        <div class="relative ml-auto">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </span>
          <input type="search" data-cal-search aria-label="Search companies"
            class="w-56 rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm text-slate-700 placeholder-slate-400 focus:border-indigo-400 focus:outline-none sm:w-64"
            placeholder="Search companies" value="${escapeHtml(calQuery)}" />
        </div>
        <button data-modal-close aria-label="Close" class="ml-1 rounded-lg p-1 text-2xl leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">&times;</button>
      </div>
      <div data-cal-body class="scrollbar-thin flex-1 overflow-y-auto">${scheduleBodyHtml(rows, scope)}</div>
    </div>`;
}

function scheduleBodyHtml(rows, scope) {
  const q = calQuery.trim().toLowerCase();
  const matched = q ? rows.filter((r) => `${r.name} ${r.ticker || ''}`.toLowerCase().includes(q)) : rows;

  if (!matched.length) {
    return `<div class="px-6 py-14 text-center">
      <p class="text-sm font-semibold text-slate-700">${q ? 'No company matches that search' : scopePossessive(scope) ? `None of ${scopePossessive(scope)} has a call scheduled` : 'Nothing is scheduled yet'}</p>
      <p class="mt-1 text-xs text-slate-500">${
        q
          ? 'Only companies with a call already on the schedule appear here.'
          : 'A call joins this list when the provider lists it, and moves to the scan table once it has been held and analysed.'
      }</p>
    </div>`;
  }

  // Group by date, preserving the feed's own chronological order within each day.
  const byDate = new Map();
  for (const r of matched) {
    const key = r.date || (r.when || '').slice(0, 10);
    if (!key) continue;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date());
  const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return days
    .map(([date, list], i) => {
      const isToday = date === today;
      // A search is a request to see everything that matched, so it overrides the collapse.
      const showAll = !!q || calExpanded.has(date);
      const shown = showAll ? list : list.slice(0, PER_DAY);
      const hidden = list.length - shown.length;
      return `
        <section class="${isToday ? 'bg-slate-50/70' : ''} ${i ? 'border-t border-slate-100' : ''} px-6 py-5">
          <div class="mb-3 flex items-center gap-2">
            <span class="text-sm text-slate-400">${escapeHtml(weekdayOf(date))}</span>
            <span class="font-display text-sm font-bold text-slate-900">${escapeHtml(dayMonthOf(date))}</span>
            ${isToday ? '<span class="rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700">Today</span>' : ''}
            <span class="ml-auto text-xs tabular-nums text-slate-400">${escapeHtml(formatNumber(list.length))} ${list.length === 1 ? 'call' : 'calls'}</span>
          </div>
          <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            ${shown.map(companyTile).join('')}
            ${
              hidden > 0
                ? `<button type="button" data-cal-more="${escapeHtml(date)}"
                     class="flex items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-indigo-600 transition-colors hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
                     +${escapeHtml(formatNumber(hidden))} more</button>`
                : ''
            }
          </div>
        </section>`;
    })
    .join('');
}

/**
 * One company on the schedule.
 *
 * StockScans put a company logo here. We do not have logo rights or logo files, and hotlinking
 * theirs would be leeching their CDN to reproduce their asset — so this uses the dashboard's own
 * deterministic gradient avatar, which is the same mark this company gets everywhere else in the
 * app. Same layout, our vocabulary.
 */
function companyTile(r) {
  const { color, initials } = avatarFor(r.name || r.ticker || '?');
  return `
    <div class="flex items-center gap-3">
      <span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-xs font-bold text-white">${escapeHtml(initials)}</span>
      <span class="min-w-0">
        <span class="block truncate text-sm font-semibold text-slate-900" title="${escapeHtml(r.name || '')}">${escapeHtml(r.ticker || r.name || '—')}</span>
        <span class="block text-xs text-slate-500">${escapeHtml(clockOf(r.when))}</span>
      </span>
    </div>`;
}

function wireScheduleModal(rows, scope) {
  const body = document.querySelector('[data-cal-body]');
  const search = document.querySelector('[data-cal-search]');
  if (!body) return;
  const repaint = () => {
    body.innerHTML = scheduleBodyHtml(rows, scope);
  };
  // Delegated, because the body is replaced on every keystroke and every expand.
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cal-more]');
    if (!btn) return;
    calExpanded.add(btn.dataset.calMore);
    repaint();
  });
  search?.addEventListener('input', () => {
    calQuery = search.value;
    repaint();
  });
}

const clockOf = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? IST_CLOCK.format(d) : '—';
};
const weekdayOf = (date) => {
  const d = new Date(`${date}T06:00:00Z`); // midday IST, so the label cannot slip a day
  return Number.isNaN(d.getTime()) ? '' : IST_WEEKDAY.format(d);
};
const dayMonthOf = (date) => {
  const d = new Date(`${date}T06:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : IST_DAYMONTH.format(d);
};

// ---------------------------------------------------------------------------------------
// THERE IS NO DRILL PANEL ON THIS TAB, AND THE ROWS ARE INERT.
//
// A row used to open a 480px panel restating the score, the sentiment tier and the highlight
// bullets already in the columns beside it, plus a link out. Everything in it was StockScans' and
// everything in it was already on the row, so the panel's only unique content was the link — which
// the identity cell now carries directly.
//
// That also removes a per-company surface for an analysis that is not ours to re-present. The rule
// in CLAUDE.md is link, do not reproduce: full summaries and transcripts stay on StockScans, and
// this tab surfaces their index. A panel that looked like our page about their company was the one
// place that line blurred.
//
// The Earnings Hub is the precedent — its rows are inert too, and the suite asserts it. This tab
// keeps the Deep Dive button, which is a different thing entirely: it dispatches a run on a
// separate dashboard rather than re-rendering what is already on screen.
// ---------------------------------------------------------------------------------------

async function exportScans(rows, m) {
  const banner = {
    __banner:
      `REAL DATA, NOT OURS. Con-call scans from a third-party research provider — quarter ${m?.quarter || ''}, ` +
      `captured ${new Date().toISOString()}. The result score (0-100), the sentiment tier (0-4) and the highlight bullets are ` +
      `that provider's own analysis, reproduced unchanged; this dashboard adds no scoring of its own. Tier labels use their ` +
      `published bands. "pending" means the call is listed but not yet analysed — it is not a zero.`,
  };
  await exportRows({
    filename: 'sattva-concall-scans',
    sheetName: 'Concall Scans',
    columns: [
      { header: 'Call Date', key: 'd', width: 20, get: (r) => (r.__banner ? r.__banner : r.when) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Industry', key: 'i', width: 28, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Result Score (third-party)', key: 's', width: 24, get: (r) => (r.__banner ? '' : (r.resultScore ?? 'pending')) },
      { header: 'Result Tier (third-party)', key: 'rt', width: 22, get: (r) => (r.__banner ? '' : r.resultTier?.label || 'pending') },
      { header: 'Sentiment (third-party)', key: 'st', width: 22, get: (r) => (r.__banner ? '' : r.sentiment?.label || 'pending') },
      { header: 'Highlights (third-party)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.tags.join(' | ')) },
      { header: 'Summary Link', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.transcriptUrl || '') },
    ],
    rows: [banner, ...rows],
  });
}
