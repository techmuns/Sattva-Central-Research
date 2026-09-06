// A continuous, scoped stream of source announcements. BSE date captures, live NSE
// filings and retained Muns company documents share one table and keep their source labels.
// Captured history loads automatically; publication and capture gaps remain in provenance.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { corporateAnnouncements as feed } from '../data/corporate-announcements.js';
import { announcementSources } from '../data/announcements-shared.js';
import { captureCoverageHtml } from '../ui/capture-coverage.js';
import { classifyStory, groupLabel } from '../data/news-keywords.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// Existing committed captures may predate the upstream normaliser fix. Clean on read as well so a
// deploy repairs visible `<BR><BR>` immediately, without waiting for the next scheduled capture.
export const cleanFilingText = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Topic labels use the same subject/sub-category keyword reading as the other news views.
// They do not summarize or score the underlying documents.
const readings = new WeakMap();
function readingFor(row) {
  let reading = readings.get(row);
  if (!reading) {
    reading = classifyStory({ title: cleanFilingText(row.title || row.headline), summary: row.subCategory || '' });
    readings.set(row, reading);
  }
  return reading;
}

// Category is identity, not judgement, so the palette is the brand ramp rather than anything
// semantic — an AGM notice is not "worse" than a result. `Result` and `Board Meeting` get the two
// strongest tints only because they are what a reader scans for.
const CATEGORY_STYLE = {
  Result: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  'Board Meeting': 'bg-purple-50 text-purple-700 ring-purple-200',
  'Corp. Action': 'bg-pink-50 text-pink-700 ring-pink-200',
  'Company Update': 'bg-slate-100 text-slate-600 ring-slate-200',
  'AGM/EGM': 'bg-slate-100 text-slate-600 ring-slate-200',
  'New Listing': 'bg-slate-100 text-slate-600 ring-slate-200',
};
const categoryBadge = (c) => {
  if (!c) return dash('the filing was not categorised');
  const cls = CATEGORY_STYLE[c] || 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(String(c))}</span>`;
};

const tab = makeFilingsTab({
  id: 'corp-announcements',
  title: 'Corp Announcements',
  subtitle:
    'The latest company announcements from BSE, NSE and captured filings, newest first.',
  feed,
  filterByScope: feed.filterByScope,
  countLabel: (rows) => {
    const companies = new Set(rows.map(r => r.isin || r.ticker || r.company).filter(Boolean)).size;
    return `${formatNumber(rows.length)} ${rows.length === 1 ? 'announcement' : 'announcements'} · ${formatNumber(companies)} ${companies === 1 ? 'company' : 'companies'} with filings`;
  },
  showWatchFilter: false,
  fillMode: 'auto',
  preserveReadingPosition: true,
  status: () => '<span data-filings-info class="text-xs font-semibold text-slate-500">Updates automatically</span>',
  emptyMessage: 'No captured announcements for this scope or search yet.',
  stickyHead: 'max(320px, calc(100vh - 260px))',
  noun: 'announcements',
  nameLabel: 'Subject',
  nameMaxPx: 520,
  rowName: (r) => cleanFilingText(r.title || r.headline) || '(no subject)',
  // The company name leads, because a date-indexed feed covers companies this dashboard has no
  // ticker for and a bare scrip code identifies nothing to a reader.
  rowSub: (r) => [r.company, r.ticker, r.subCategory].filter(Boolean).join(' · '),
  searchable: (r) =>
    `${cleanFilingText(r.title)} ${cleanFilingText(r.headline)} ${cleanFilingText(r.subject)} ${r.company || ''} ${r.ticker || ''} ${r.scripCode || ''} ${r.category || ''} ${r.subCategory || ''}`,
  columns: () => [
    { label: 'Source', get: (r) => announcementSources(r).join(' / ') || 'Not specified' },
    {
      label: 'Date',
      get: (r) =>
        r.date
          ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}${r.time ? `<span class="ml-1 text-[10px] text-slate-400">${escapeHtml(r.time.slice(0, 5))}</span>` : ''}</span>`
          : dash('the filing carried no readable date'),
      html: true,
      // A filing with no readable date sorts last rather than first. It is never today's.
      sortValue: (r) => `${r.date || ''}${r.time || ''}`,
    },
    {
      label: 'Category',
      get: (r) => categoryBadge(r.category),
      html: true,
      sortValue: (r) => r.category || '',
    },
    {
      // THE TOPIC COLUMN TOOK THE SUB-CATEGORY COLUMN'S PLACE, for the reason the News tab's took
      // the Outlet column's: `rowSub` already prints the sub-category under every subject, so the
      // column was a second copy of it — and this table's subject line is capped at 520px, which is
      // where two different filings start truncating to the same string. The sub-category keeps its
      // place in the export; what it gives up is a column that said nothing new.
      label: 'Topic',
      get: (r) => {
        const reading = readingFor(r);
        if (!reading.tracked) {
          return `<span class="text-slate-300" title="No tracked keyword matched this filing's subject or BSE's sub-category for it. Most filings are routine — the whole exchange files roughly 900 a weekday.">untracked</span>`;
        }
        const CHIPS = 2;
        const shown = reading.keywords.slice(0, CHIPS);
        const rest = reading.keywords.length - shown.length;
        const chip = (k) =>
          `<span class="mr-1 inline-block whitespace-nowrap rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 ring-1 ring-indigo-100" title="${escapeHtml(
            `${groupLabel(k.group)} · matched in the ${k.where === 'title' ? "filing's subject" : "exchange's sub-category"}${k.note ? `. ${k.note}` : ''}`
          )}">${escapeHtml(k.label)}</span>`;
        const more = rest
          ? `<span class="text-[10px] font-semibold text-slate-400" title="${escapeHtml(`Also: ${reading.labels.slice(CHIPS).join(', ')}`)}">+${rest}</span>`
          : '';
        return shown.map(chip).join('') + more;
      },
      html: true,
      sortValue: (r) => {
        const reading = readingFor(r);
        return reading.tracked ? `1${reading.labels[0]}` : '0';
      },
    },
  ],
  provenance: (m) => `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
      <button data-modal-close class="text-2xl text-slate-400">&times;</button>
    </div>
    <div class="space-y-3 text-sm leading-relaxed text-slate-600">
      <p><strong>BSE:</strong> exchange-wide announcements are captured every two hours, with retained monthly history.
        Latest capture: ${escapeHtml(m.capturedAt || 'unavailable')}.</p>
      <p><strong>NSE:</strong> the live exchange feed and up to 90 days of retained captures join this table.
        Latest source capture: ${escapeHtml(m.nse?.capturedAt || 'unavailable')}.
        ${escapeHtml(m.nse?.error || m.nse?.degraded || '')}</p>
      <p><strong>Additional BSE / NSE / DRHP filings:</strong> scheduled Muns company captures and earlier saved lookups
        join the same stream. Their coverage is limited to the companies and dates successfully read.</p>
      <p>The feed checks for updates every 90 seconds while visible, pauses when hidden and checks again on return.
        Retained history loads automatically. Source publication and scheduled captures can lag; this is not a complete exchange archive.</p>
      <p>The Source column preserves exchange labels. Matching document, company and date overlap appears once;
        separate exchange documents remain separate rows. Original document links are included in the export.</p>
      <p>Portfolio matching uses exchange ISINs and BSE scrip codes as well as ticker aliases, including renamed and newly listed holdings.
        The table count describes companies with loaded filings, not the number checked or complete portfolio coverage.
        Exchange identities checked: ${escapeHtml(m.identity?.capturedAt || 'unavailable')}.
        ${escapeHtml(m.identity?.error || '')}</p>
      <p><strong>Topic</strong> is the desk’s keyword reading of the filing subject and sub-category.
        No PDF is summarized or scored. Missing fields remain blank.</p>
      ${m.archive?.error ? `<p>${escapeHtml(m.archive.error)}</p>` : ''}
      ${m.nse?.historyUnavailable || m.nse?.allMissingDays?.length ? '<p>Some retained NSE history could not be loaded; existing records remain visible.</p>' : ''}
      ${captureCoverageHtml('announcements')}
      ${coverageBlock(m)}
    </div>
  </div>`,
  onExport: async (visible, m) => {
    await exportRows({
      filename: 'sattva-corp-announcements',
      sheetName: 'Announcements',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `SOURCE DISCLOSURES. BSE exchange-wide capture: ${m.windowDays} day(s), captured ${m.capturedAt || 'at an unknown time'}. ` +
                `Live NSE announcements, retained NSE history, and scheduled Muns BSE/NSE/DRHP company captures are merged with older saved lookups. Coverage is limited to successful source reads. ` +
                `Subjects and categories are the sources' own words; Topic is the dashboard's keyword reading. No document contents are summarized. Exported ${new Date().toISOString()}.`
              : r.date || '',
        },
        { header: 'Time', key: 'tm', width: 10, get: (r) => (r.__banner ? '' : r.time || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'BSE scrip code', key: 'sc', width: 14, get: (r) => (r.__banner ? '' : r.scripCode || '') },
        { header: 'Company (as filed)', key: 'co', width: 38, get: (r) => (r.__banner ? '' : r.company || '') },
        { header: 'Subject (as filed)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : cleanFilingText(r.title || r.headline)) },
        { header: 'Category (as filed)', key: 'c', width: 22, get: (r) => (r.__banner ? '' : r.category || '') },
        { header: 'Sub-category (as filed)', key: 'sb', width: 30, get: (r) => (r.__banner ? '' : r.subCategory || '') },
        { header: 'Source', key: 'src', width: 20, get: (r) => r.__banner ? '' : announcementSources(r).join(' / ') },
        { header: 'Retrieved through', key: 'via', width: 35, get: (r) => r.__banner ? '' : (r.providers || []).join(' / ') },
        { header: 'Document URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
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
