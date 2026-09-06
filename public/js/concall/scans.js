// concall/scans.js — the Con-call library: Screener documents plus live StockScans analysis.
//
//   renderScans(ctx)         the quarter's calls: result score, sentiment, highlights, links
//   openScheduleModal(rows)  "Upcoming Concalls" — the schedule, as an overlay off that table
//
// This is the WHOLE tab now. Screener supplies the retained market-wide document index; StockScans
// supplies current-quarter analysis. The two are joined by ticker/date before rendering, and each
// scored field remains explicitly attributed to StockScans rather than to Screener or this app.
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
//     - Nothing that costs a run fires on render or from a poller. The Deep Dive button is the
//       explicit run command: its click dispatches once and opens directly on progress.
//     - Reading their index IS free, and the column uses that. `GET /api/summary` lists the
//       reports they already hold; it is fetched once per page load, and the rows it names get a
//       "Ready" button that opens the finished report at no cost to anyone. The reader should not
//       have to pay to discover the answer already exists.
//     - The report is theirs. js/concall/deep-dive.js lays it out and computes nothing on top;
//       primary filing links remain in its provenance strip. Same rule as the StockScans scores
//       above and the Trendlyne holding values on Institutions. Its compact
//       result/view/headline may fill a blank row only after the exact-call checks below pass.

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

const ATTRIBUTION =
  'Scores and current-quarter sentiment are the research provider’s own analysis. Where an exact, transcript-backed Deep Dive report is already available for one unambiguous call, its result, view and headline fill otherwise blank cells unchanged; no score or sentiment tier is inferred.';

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

const documentsOnlyPill = () =>
  '<span class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200" title="This historical call comes from Screener’s document index and is outside the analysis provider’s current-quarter scan.">documents</span>';

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

const quarterKey = (value) => String(value || '').toUpperCase().replace(/[^QFY0-9]/g, '');

/** The Indian reporting quarter normally discussed by a call on this calendar date. */
export function reportingQuarter(date) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(date || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month <= 3) return `Q3FY${String(year).slice(-2)}`;
  if (month <= 6) return `Q4FY${String(year).slice(-2)}`;
  if (month <= 9) return `Q1FY${String(year + 1).slice(-2)}`;
  return `Q2FY${String(year + 1).slice(-2)}`;
}

/**
 * A company-level Deep Dive summary may only fill a call row when its confirmed quarter has one
 * distinct call date for that ticker in the complete library. Two dates means two possible calls,
 * so neither is guessed. Transcript availability is required for call sentiment/highlights.
 */
export function matchingDeepDive(row, allRows, map = readyReports) {
  const ticker = String(row.ticker || '').toUpperCase();
  const quarter = reportingQuarter(row.date || row.publishedDate);
  const hits = ticker ? (Array.isArray(map[ticker]) ? map[ticker] : map[ticker] ? [map[ticker]] : []) : [];
  const hit = hits.find(
    (candidate) =>
      !!candidate?.slug &&
      String(candidate?.ticker || '').toUpperCase() === ticker &&
      candidate?.quarter_confirmed === true &&
      candidate?.transcript_available === true &&
      quarterKey(candidate.quarter) === quarterKey(quarter),
  );
  if (!hit) return null;
  const dates = callDates(allRows).get(`${ticker}|${quarterKey(quarter)}`) || new Set();
  return dates.size === 1 ? hit : null;
}

const callDateCache = new WeakMap();
function callDates(allRows) {
  let index = callDateCache.get(allRows);
  if (index) return index;
  index = new Map();
  for (const row of allRows) {
    const ticker = String(row.ticker || '').toUpperCase();
    const date = row.date || row.publishedDate;
    const quarter = reportingQuarter(date);
    if (!ticker || !date || !quarter) continue;
    const key = `${ticker}|${quarterKey(quarter)}`;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(date);
  }
  callDateCache.set(allRows, index);
  return index;
}

function matchingSaved(row, allRows, savedByRecord, savedByTicker) {
  const ticker = String(row.ticker || '').toUpperCase();
  const exact = savedByRecord[rowKey(row)] || null;
  if (exact && String(exact.ticker || '').toUpperCase() === ticker) return exact;
  const quarter = reportingQuarter(row.date || row.publishedDate);
  const dates = callDates(allRows).get(`${ticker}|${quarterKey(quarter)}`) || new Set();
  if (!ticker || !quarter || dates.size !== 1) return null;
  return (savedByTicker[ticker] || []).find((entry) => quarterKey(entry.quarter) === quarterKey(quarter)) || null;
}

function deepDiveInsight(row, allRows, savedByRecord, savedByTicker) {
  if (row.analysisTracked !== false) return null;
  const saved = matchingSaved(row, allRows, savedByRecord, savedByTicker)?.summary || null;
  return saved?.transcript_available === true ? saved : matchingDeepDive(row, allRows);
}

const deepDivePill = (value, kind) =>
  `<span class="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200" title="Concall Deep Dive ${escapeHtml(kind)}, reproduced unchanged. This is not a StockScans tier.">DD · ${escapeHtml(value)}</span>`;

function deepDiveHighlights(hit) {
  if (!hit) return '<span class="text-slate-300">—</span>';
  const headline = String(hit.headline || '').trim();
  const tags = Array.isArray(hit.tags) ? hit.tags.filter(Boolean).slice(0, 3) : [];
  if (!headline && !tags.length) return '<span class="text-slate-300">—</span>';
  return `<div class="flex max-w-[380px] flex-col gap-1 whitespace-normal text-[11px] leading-snug">
    <span class="font-semibold text-violet-700">Deep Dive</span>
    ${headline ? `<span class="line-clamp-3 text-slate-600" title="${escapeHtml(headline)}">${escapeHtml(headline)}</span>` : ''}
    ${tags.length ? `<span class="text-slate-400">${tags.map((tag) => escapeHtml(tag)).join(' · ')}</span>` : ''}
  </div>`;
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

function dateCell(row) {
  if (row.analysisTracked !== false) return whenCell(row.when);
  const date = row.publishedDate || row.date;
  if (!date) return '<span class="text-slate-300">—</span>';
  const d = new Date(`${date}T06:00:00Z`);
  return Number.isNaN(d.getTime())
    ? '<span class="text-slate-300">—</span>'
    : `<span class="whitespace-nowrap" title="Published in Screener’s concall index; exact call time is not supplied.">${escapeHtml(IST_DATE.format(d))}<span class="ml-1 text-[10px] text-slate-400">published</span></span>`;
}

function documentLinks(row) {
  const documents = row.documents || [];
  if (!documents.length) return '<span class="text-slate-300">—</span>';
  return `<div class="flex max-w-[300px] flex-wrap justify-end gap-1">${documents
    .map(
      (document) =>
        `<a data-norow href="${escapeHtml(document.url)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(document.type)} at its original source" class="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100">${escapeHtml(document.type)}</a>`,
    )
    .join('')}</div>`;
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
    const pending = feed.all().filter((r) => r.analysisTracked !== false && r.resultScore == null).length;
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
export function renderScans(ctx, { disposers, tableView, onView, onInsights = null }) {
  const m = feed.meta();
  const rows = feed.forScope(ctx.scope, coverage.holdings());
  const allRows = feed.all();
  const screener = m?.screener || null;
  // Both read once for the whole paint rather than per row — see rememberedByRecord() in
  // data/deep-dive.js. `saved` is the stronger fact of the two: a report already on this device
  // opens with no run AND no request, so those rows are marked before their index has even landed.
  const dived = deepDive.rememberedByRecord();
  const saved = deepDive.savedByRecord();
  const savedByTicker = deepDive.savedReportsByTicker();
  const paintedReadyVersion = readyVersion;

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
      { label: 'Call / Published', get: (r) => dateCell(r), html: true, align: 'left', sortValue: (r) => r.when || '' },
      { label: 'Filings', get: (r) => r.ticker ? `<a data-norow class="font-semibold text-indigo-600" href="${escapeHtml(domesticFilingsHref(r.ticker, { form: 'concalls', scope: ctx.scope }))}">Transcripts</a>` : '—', html: true, sortable: false },
      { label: 'Documents', get: (r) => documentLinks(r), html: true, align: 'right', sortable: false },
      {
        // Their index, on their scale. `max: 100` and no tier colouring of our own — the badge
        // beside it is their label for that band.
        label: 'Result Score',
        get: (r) =>
          r.analysisTracked === false
            ? documentsOnlyPill()
            : r.resultScore == null
            ? pendingPill('a result score')
            : `<span class="font-semibold tabular-nums text-slate-900">${escapeHtml(r.resultScore.toFixed(1))}</span><span class="ml-1 text-[10px] text-slate-400">/100</span>`,
        html: true,
        align: 'right',
        sortValue: (r) => r.resultScore ?? -1,
      },
      {
        label: 'Result',
        get: (r) => {
          if (r.analysisTracked !== false) return tierPill(r.resultTier, 'a result score');
          const insight = deepDiveInsight(r, allRows, saved, savedByTicker);
          return insight?.result ? deepDivePill(insight.result, 'reported-result label') : '<span class="text-slate-300">—</span>';
        },
        html: true,
        align: 'right',
        sortValue: (r) => r.resultScore ?? -1,
      },
      {
        label: 'Sentiment / View',
        get: (r) => {
          if (r.analysisTracked !== false) return tierPill(r.sentiment, 'a sentiment reading');
          const insight = deepDiveInsight(r, allRows, saved, savedByTicker);
          return insight?.verdict ? deepDivePill(insight.verdict, 'investment view') : '<span class="text-slate-300">—</span>';
        },
        html: true,
        align: 'right',
        sortValue: (r) => r.sentimentTier ?? -1,
      },
      {
        label: 'Highlights',
        get: (r) =>
          r.tags.length
            ? `<div class="flex max-w-[380px] flex-col gap-0.5 whitespace-normal text-[11px] leading-snug">${r.tags.slice(0, 3).map(highlight).join('')}</div>`
            : deepDiveHighlights(deepDiveInsight(r, allRows, saved, savedByTicker)),
        html: true,
        sortable: false,
      },
      {
        // An action, not a reading — so it does not sort, and it is not in the export either: a
        // workbook of "click here" cells would be a column of nothing.
        label: 'Deep Dive',
        get: (r) => (r.ticker ? deepDiveButton(r, dived, saved, savedByTicker, allRows) : '<span class="text-slate-300">—</span>'),
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
          if (v === 'pending') return r.analysisTracked !== false && r.resultScore == null;
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
      {
        label: 'Document',
        options: [
          { value: 'all', label: 'All documents' },
          { value: 'Transcript', label: 'Transcript' },
          { value: 'Recording', label: 'Recording' },
          { value: 'Presentation', label: 'Presentation' },
          { value: 'Summary', label: 'Summary' },
        ],
        match: (r, v) => (r.documents || []).some((document) => document.type === v),
      },
    ],
    searchable: (r) => {
      const insight = deepDiveInsight(r, allRows, saved, savedByTicker);
      return `${r.name} ${r.ticker || ''} ${r.industry || ''} ${r.tags.join(' ')} ${insight?.result || ''} ${insight?.verdict || ''} ${insight?.headline || ''} ${(insight?.tags || []).join(' ')} ${(r.documents || []).map((document) => document.type).join(' ')}`;
    },
    // The way out to the provider's reader, which is the one thing the removed drill panel carried
    // that was not already on the row. Their reader is where the summary and the transcript live;
    // this tab is their index and links to it rather than reproducing it. `docUrl` builds their
    // DOCUMENT route — the company route needs a period this payload does not carry, and building
    // it short is what made every one of these links 404.
    link: (r) => r.transcriptUrl || r.documents?.[0]?.url || r.screenerCompanyUrl || null,
    initialSort: { key: 'Call / Published', dir: 'desc' },
    exportName: 'sattva-concall-scans',
    onExport: (visible) => exportScans(visible, m),
    emptyMessage: scopePossessive(ctx.scope) ? `No concall document or current-quarter scan matches ${scopePossessive(ctx.scope)}.` : 'No calls match your filters.',
    initialView: tableView,
  });
  onView?.(table.view);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Concall Library',
      description: screener?.status === 'ok'
        ? `Screener’s complete retained concall document index (${escapeHtml(formatNumber(screener.records || 0))} unique source records), newest first, joined without duplicate company/date rows to current-quarter analysis. Times are IST; “published” dates are labelled separately. ${ATTRIBUTION}`
        : `Current-quarter analysis is available. Screener’s scheduled complete document index is temporarily unavailable on this origin, so historical Transcript / Recording / Presentation links will fill in after its next successful collection. ${ATTRIBUTION}`,
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
    // Only an unambiguous same-quarter report opens directly. Otherwise this click itself starts
    // the analysis and the panel goes straight to progress.
    const ready = matchingDeepDive(row, allRows);
    const kept = matchingSaved(row, allRows, saved, savedByTicker);
    openDeepDive(row, {
      ready,
      saved: kept,
      onRecorded: () => markDived(btn),
      // The moment a report is durably on this device, the row says so: the next click on it is
      // free and instant, and the reader should not have to click to discover that.
      onSaved: ({ slug, report }) => {
        const summary = deepDive.reportSummary({ slug, report });
        if (summary?.ticker) {
          const ticker = String(summary.ticker).toUpperCase();
          readyReports[ticker] = [summary, ...(readyReports[ticker] || []).filter((entry) => entry.slug !== summary.slug)];
        }
        readyVersion++;
        markReady(btn, null, deepDive.savedForRecord(rowKey(row)));
        onInsights?.();
      },
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
    if (readyVersion !== paintedReadyVersion) {
      onInsights?.();
      return;
    }
    for (const btn of ctx.root.querySelectorAll('[data-deep-dive]')) {
      const row = rows.find((r) => rowKey(r) === btn.dataset.deepDive);
      const hit = row ? matchingDeepDive(row, allRows, ready) : null;
      if (hit) markReady(btn, hit);
    }
  });
}

// ticker -> their summary rows, newest first, for every company they have already analysed. Module-level so a
// live repaint paints the marks immediately instead of waiting on the promise again.
let readyReports = {};
let readyPromise = null;
let readyVersion = 0;
function loadReady() {
  if (!readyPromise) {
    readyPromise = deepDive
      .readyReportsByTicker()
      .then((map) => {
        readyReports = map || {};
        readyVersion++;
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
 * A button and nothing more — the click itself is the reader's explicit instruction to run. Three
 * different facts, three different marks, and the distinction is the most useful thing this
 * column can carry:
 *
 *   dot on an outlined button   this browser has dispatched a run for that exact row
 *   filled button               a finished report opens for free — no run
 *
 * The filled state is reached two ways: their index says they hold a report, or this device does.
 * The second is stronger — it needs no network at all — and it is known synchronously, so those
 * rows are already filled on first paint rather than upgraded when `/api/summary` lands.
 */
function deepDiveButton(r, dived, saved, savedByTicker, allRows) {
  // Once their index has resolved, later paints render the Ready state directly instead of
  // painting the plain button and upgrading it a frame later.
  const hit = matchingDeepDive(r, allRows);
  const kept = matchingSaved(r, allRows, saved, savedByTicker);
  if (hit || kept) return readyButtonHtml(r, hit, kept);
  const seen = dived[rowKey(r)] || null;
  return `
    <button type="button" data-norow data-deep-dive="${escapeHtml(rowKey(r))}"
      title="${seen ? 'Open the Deep Dive — a run for this call is already on record' : 'Run a Deep Dive for this company now'}"
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
  btn.title = 'Open the Deep Dive — a run for this call is already on record';
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
  const allRows = feed.all();
  const saved = deepDive.savedByRecord();
  const savedByTicker = deepDive.savedReportsByTicker();
  const insight = (row) => (row.__banner ? null : deepDiveInsight(row, allRows, saved, savedByTicker));
  const banner = {
    __banner:
      `REAL DATA. Screener concall documents plus third-party current-quarter analysis — quarter ${m?.quarter || ''}, ` +
      `captured ${new Date().toISOString()}. The result score (0-100), the sentiment tier (0-4) and the highlight bullets are ` +
      `that provider's own analysis, reproduced unchanged; this dashboard adds no scoring of its own. Tier labels use their ` +
      `published bands. "pending" means the call is listed but not yet analysed — it is not a zero. Transcript-backed Deep Dive ` +
      `result/view/headline fields are copied only onto an exact, unambiguous call and are separately labelled; no score is inferred.`,
  };
  await exportRows({
    filename: 'sattva-concall-scans',
    sheetName: 'Concall Scans',
    columns: [
      { header: 'Call / Published Date', key: 'd', width: 24, get: (r) => (r.__banner ? r.__banner : r.analysisTracked === false ? r.publishedDate : r.when) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Industry', key: 'i', width: 28, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Result Score (third-party)', key: 's', width: 24, get: (r) => (r.__banner ? '' : r.analysisTracked === false ? '' : (r.resultScore ?? 'pending')) },
      { header: 'Result Tier (third-party)', key: 'rt', width: 22, get: (r) => (r.__banner ? '' : r.analysisTracked === false ? '' : r.resultTier?.label || 'pending') },
      { header: 'Sentiment (third-party)', key: 'st', width: 22, get: (r) => (r.__banner ? '' : r.analysisTracked === false ? '' : r.sentiment?.label || 'pending') },
      { header: 'Highlights (third-party)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.tags.join(' | ')) },
      { header: 'Deep Dive Result', key: 'ddr', width: 22, get: (r) => insight(r)?.result || '' },
      { header: 'Deep Dive View', key: 'ddv', width: 22, get: (r) => insight(r)?.verdict || '' },
      { header: 'Deep Dive Headline', key: 'ddh', width: 70, get: (r) => insight(r)?.headline || '' },
      { header: 'Summary Link', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.transcriptUrl || '') },
      { header: 'Documents', key: 'docs', width: 80, get: (r) => (r.__banner ? '' : (r.documents || []).map((document) => `${document.type}: ${document.url}`).join(' | ')) },
    ],
    rows: [banner, ...rows],
  });
}
