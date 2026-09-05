// Exchange-wide corporate actions from NSE and Screener, scoped at paint time to the current portfolio,
// watchlist or full captured universe.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { corporateActions as feed } from '../data/corporate-actions.js';
import { screenerActionDetails } from '../data/corporate-actions-shared.js';

const LABELS = {
  bonus: 'Bonus', rights: 'Rights', split: 'Split', buyback: 'Buyback', dividend: 'Dividend',
  distribution: 'Distribution', demerger: 'Demerger', interest: 'Interest', redemption: 'Redemption',
  'capital-reduction': 'Capital reduction', other: 'Other',
};
const STYLE = {
  bonus: 'bg-purple-50 text-purple-700 ring-purple-200',
  rights: 'bg-amber-50 text-amber-700 ring-amber-200',
  split: 'bg-sky-50 text-sky-700 ring-sky-200',
  buyback: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  dividend: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  distribution: 'bg-teal-50 text-teal-700 ring-teal-200',
  demerger: 'bg-pink-50 text-pink-700 ring-pink-200',
  interest: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  redemption: 'bg-orange-50 text-orange-700 ring-orange-200',
  'capital-reduction': 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
  other: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const dash = (reason) => `<span class="text-slate-300" title="${escapeHtml(reason)}">—</span>`;
const badge = (type) => `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${STYLE[type] || STYLE.other}">${escapeHtml(LABELS[type] || LABELS.other)}</span>`;
const dateCell = (value, reason) => value
  ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(value))}</span>`
  : dash(reason);
const detailsCell = (row) => {
  const details = screenerActionDetails(row.screener);
  return details ? `<span class="text-slate-600">${escapeHtml(details)}</span>` : dash('No extra structured terms were supplied for this action');
};
const sourceCell = (row) => {
  const links = [];
  if ((row.sources || [row.source]).includes('NSE')) links.push(`<a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener noreferrer" data-stop aria-label="Open NSE corporate action for ${escapeHtml(row.company)}" title="Open the official NSE record" class="inline-flex h-7 items-center justify-center rounded-md px-2 text-[10px] font-bold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">NSE ↗</a>`);
  if ((row.sources || [row.source]).includes('Screener')) links.push(`<a href="${escapeHtml(row.screenerUrl || row.sourceUrl)}" target="_blank" rel="noopener noreferrer" data-stop aria-label="Open Screener corporate action for ${escapeHtml(row.company)}" title="Open the Screener action catalogue" class="inline-flex h-7 items-center justify-center rounded-md px-2 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50">SCR ↗</a>`);
  return `<span class="flex gap-1">${links.join('')}</span>`;
};

function filters(rows) {
  const present = new Set(rows.map((row) => row.actionType));
  const types = Object.keys(LABELS).filter((type) => present.has(type));
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return [
    {
      label: 'Action type', maxWidthPx: 210,
      options: [{ value: 'all', label: 'All action types' }, ...types.map((value) => ({ value, label: LABELS[value] }))],
      match: (row, value) => row.actionType === value,
    },
    {
      label: 'Timing', maxWidthPx: 190,
      options: [
        { value: 'all', label: 'All dates' },
        { value: 'upcoming', label: 'Upcoming' },
        { value: 'recent', label: 'Past 30 days' },
        { value: 'older', label: 'Earlier history' },
      ],
      match: (row, value) => {
        const date = row.exDate || row.recordDate;
        if (!date) return value === 'older';
        if (value === 'upcoming') return date >= today;
        if (value === 'recent') return date < today && date >= monthAgo;
        return date < monthAgo;
      },
    },
  ];
}

const tab = makeFilingsTab({
  id: 'corporate-actions',
  title: 'Corporate Actions',
  subtitle: 'One deduplicated feed of NSE actions, enriched with Screener ratios, terms, prices and additional records.',
  feed,
  filterByScope: feed.filterByScope,
  noun: 'actions',
  nameLabel: 'Purpose',
  nameMaxPx: 560,
  rowName: (row) => row.purpose,
  rowSub: (row) => [row.company, row.ticker, row.series].filter(Boolean).join(' · '),
  searchable: (row) => `${row.purpose} ${row.company} ${row.ticker || ''} ${row.isin || ''} ${LABELS[row.actionType] || ''} ${screenerActionDetails(row.screener)}`,
  keyFor: (row) => row.id,
  filters,
  link: false,
  showWatchFilter: false,
  fillMode: 'scroll',
  preserveReadingPosition: true,
  initialSort: { key: 'Ex date', dir: 'desc' },
  stickyHead: 'max(320px, calc(100vh - 260px))',
  countLabel: (rows) => {
    const companies = new Set(rows.map((row) => row.ticker || row.screener?.companyKey || row.company)).size;
    return `${formatNumber(rows.length)} ${rows.length === 1 ? 'action' : 'actions'} · ${formatNumber(companies)} ${companies === 1 ? 'company' : 'companies'}`;
  },
  status: (meta) => {
    const at = Date.parse(meta.capturedAt || '');
    const screenerAt = Date.parse(meta.sources?.screener?.capturedAt || '');
    const screenerLive = meta.sources?.screener?.state === 'live' && Number.isFinite(screenerAt);
    const fresh = Number.isFinite(at) && Date.now() - at <= 35 * 60 * 1000;
    const label = !Number.isFinite(at)
      ? 'NSE + Screener · Updating'
      : screenerLive && fresh
        ? 'NSE + Screener · Up to date'
        : meta.sources?.screener?.state === 'retained' && Number.isFinite(screenerAt)
          ? `NSE current · Screener retained ${formatRelativeTime(screenerAt)}`
          : fresh ? 'NSE current · Screener updating' : `Actions updated ${formatRelativeTime(at)}`;
    return `<span class="text-xs font-semibold ${fresh ? 'text-emerald-700' : 'text-slate-500'}">${escapeHtml(label)}</span>`;
  },
  emptyMessage: 'No corporate actions match this scope and filter.',
  columns: () => [
    { label: 'Type', get: (row) => badge(row.actionType), html: true, sortValue: (row) => LABELS[row.actionType] || 'Other' },
    { label: 'Ex date', get: (row) => dateCell(row.exDate, 'NSE supplied no ex date'), html: true, sortValue: (row) => row.exDate || '' },
    { label: 'Record / end date', get: (row) => dateCell(row.recordDate || row.screener?.endDate, 'Neither source supplied a record or end date'), html: true, sortValue: (row) => row.recordDate || row.screener?.endDate || '' },
    { label: 'Terms', get: detailsCell, html: true, sortValue: (row) => screenerActionDetails(row.screener) },
    {
      label: 'Source', sortable: false, html: true,
      get: sourceCell,
    },
  ],
  provenance: (meta) => `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Corporate actions</h2>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
    </div>
    <div class="space-y-3 text-sm leading-relaxed text-slate-600">
      <p><strong>Summative source feed.</strong> NSE supplies the official market-wide company, symbol, ISIN, purpose, face value, ex date, record date and book-closure dates. Screener adds bonus and rights ratios, rights premium, split face values, buyback terms and dividend type and percentage. An NSE purpose stays exactly as filed.</p>
      <p>A Screener action joins an NSE row only when ticker, action type and ex date form one unambiguous one-to-one match. The terms enrich that row and both source links remain. Ambiguous matches and actions found by only one source remain separate, so the merge neither guesses nor drops source records. Screener-only purpose text is visibly derived from its structured fields.</p>
      <p>Action type is a navigation label so dividends, distributions, bonuses, rights, splits, buybacks, demergers, interest, redemptions and capital reductions can be filtered. Meeting-only AGM/EGM diary entries from NSE are excluded; a meeting row that also declares an action remains.</p>
      <p>The retained snapshot covers <strong>${escapeHtml(meta.requestedFrom || 'an unknown start')}</strong> through <strong>${escapeHtml(meta.requestedTo || 'an unknown end')}</strong>. Incremental source checks run every 15 minutes and a full Screener reconciliation runs daily. The dashboard checks the committed file every 90 seconds while visible. Either upstream can fail without erasing its last valid layer.</p>
      <p>Because the capture is exchange-wide, adding a stock to the portfolio or watchlist needs no new company scrape: the same file is filtered on the next paint. Portfolio matching uses ISIN as well as NSE symbol so a rename does not detach earlier actions. Company changes in the family book refresh independently every minute.</p>
      ${meta.degraded ? `<p class="text-amber-700">${escapeHtml(meta.degraded)}</p>` : ''}
      ${coverageBlock(meta)}
    </div>
  </div>`,
  onExport: async (visible, meta) => exportRows({
    filename: 'sattva-corporate-actions', sheetName: 'Corporate Actions',
    columns: [
      { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
      { header: 'Company', key: 'company', width: 38, get: (r) => r.company },
      { header: 'Type (derived)', key: 'type', width: 16, get: (r) => LABELS[r.actionType] || 'Other' },
      { header: 'Purpose (as filed)', key: 'purpose', width: 70, get: (r) => r.purpose },
      { header: 'Ex date', key: 'ex', width: 14, get: (r) => r.exDate || '' },
      { header: 'Record date', key: 'record', width: 14, get: (r) => r.recordDate || '' },
      { header: 'Book closure start', key: 'bcs', width: 18, get: (r) => r.bookClosureStart || '' },
      { header: 'Book closure end', key: 'bce', width: 18, get: (r) => r.bookClosureEnd || '' },
      { header: 'Face value', key: 'fv', width: 12, get: (r) => r.faceValue || '' },
      { header: 'Sources', key: 'sources', width: 18, get: (r) => (r.sources || [r.source]).join(', ') },
      { header: 'Screener terms', key: 'terms', width: 40, get: (r) => screenerActionDetails(r.screener) },
      { header: 'Ratio', key: 'ratio', width: 12, get: (r) => r.screener?.ratio || '' },
      { header: 'Premium', key: 'premium', width: 12, get: (r) => r.screener?.premium || '' },
      { header: 'Old face value', key: 'old_fv', width: 14, get: (r) => r.screener?.oldFaceValue || '' },
      { header: 'New face value', key: 'new_fv', width: 14, get: (r) => r.screener?.newFaceValue || '' },
      { header: 'Buyback end date', key: 'end', width: 16, get: (r) => r.screener?.endDate || '' },
      { header: 'Offer type', key: 'offer', width: 18, get: (r) => r.screener?.offerType || '' },
      { header: 'Maximum price', key: 'max_price', width: 15, get: (r) => r.screener?.maxPrice || '' },
      { header: 'Amount (Cr)', key: 'amount', width: 14, get: (r) => r.screener?.amountCrore || '' },
      { header: 'Dividend type', key: 'div_type', width: 16, get: (r) => r.screener?.dividendType || '' },
      { header: 'Dividend percent', key: 'percent', width: 17, get: (r) => r.screener?.percent || '' },
      { header: 'ISIN', key: 'isin', width: 18, get: (r) => r.isin || '' },
      { header: 'Series', key: 'series', width: 10, get: (r) => r.series || '' },
      { header: 'Official NSE URL', key: 'url', width: 60, get: (r) => (r.sources || [r.source]).includes('NSE') ? r.sourceUrl : '' },
      { header: 'Screener URL', key: 'screener_url', width: 50, get: (r) => r.screenerUrl || '' },
    ], rows: visible,
  }),
});

export const meta = tab.meta;
let liveRef = null;
export function render(ctx) {
  tab.render(ctx);
  liveRef = ctx.live;
  if (liveRef) feed.startLive(liveRef);
}
export function destroy() {
  if (liveRef) feed.stopLive(liveRef);
  liveRef = null;
  tab.destroy();
}
