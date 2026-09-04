// tabs/corp-announcements.js — what every listed company has filed with BSE, indexed by date.
//
// THIS TAB IS INDEXED BY DATE, NOT BY COMPANY, AND THAT IS THE WHOLE POINT.
//   It used to ask the Muns filings API once per company. That endpoint is capped at about sixty
//   requests a minute, so the 603-company universe was ten minutes of somebody else's service and a
//   run cut short by the limit — or by an expiring session JWT — is why the committed snapshot
//   reached 118 companies. Narrowing the date window would not have helped: the range is a
//   PARAMETER on a per-company request, so one day for 603 companies is still 603 requests.
//
//   BSE publish the same filings the other way round: every company's announcements for a date.
//   Measured on 19 Aug 2026, 886 announcements across the WHOLE exchange in about two dozen
//   requests. So the coverage question changed shape — a company with no rows here filed nothing in
//   the window, rather than being one we had no budget to ask about.
//
// Company/date lookups now add BSE, NSE and DRHP records. Source labels and lookup coverage stay
// separate from the scheduled BSE capture, which remains the inexpensive exchange-wide floor.
//
// THE SUBJECT LINE IS THE FILING'S OWN. Nothing here classifies an announcement as material or
// routine, or summarises a PDF — the row carries what the exchange published and links to the
// document. BSE's own `CRITICALNEWS` flag is reproduced as a marker and is theirs, not a judgement
// of ours. See the header of tabs/filings-tab.js for the shared machinery.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { announcements as feed } from '../data/filings.js';
import { announcementSources } from '../data/announcements-shared.js';
import { announcementLookupControls } from './announcement-lookup.js';
import { classifyStory, topicFilterOptions, matchesTopic, groupLabel, FILTER_TARGETED } from '../data/news-keywords.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// Existing committed captures may predate the upstream normaliser fix. Clean on read as well so a
// deploy repairs visible `<BR><BR>` immediately, without waiting for the next scheduled capture.
export const cleanFilingText = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ---------------------------------------------------------------------------------------
// THE SAME THIRTY TRACKED KEYWORDS THE NEWS SURFACES FILTER BY.
//
// This is the widest feed in the dashboard — the whole exchange, ~900 filings a weekday — and until
// now the only ways to narrow it were BSE's own category (eight values, of which "Company Update"
// is a fifth of everything) and sub-category (67 values, mostly filing taxonomy). Neither answers
// "which of these is an order win, a QIP, a resignation".
//
// WHAT IS CLASSIFIED IS THE FILING'S SUBJECT AND BSE'S SUB-CATEGORY, both of which are the
// exchange's own description of this filing. There is no standfirst here to be unreliable, so the
// headline-only gate the news feed needs does not apply — see `announcementSignal` in
// js/data/daily-alerts.js. And there is no "does it name the company" question at all: a BSE filing
// IS the company's own statement, which is why the strict filter option is dropped below.
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

const lookup = announcementLookupControls(feed);
const tab = makeFilingsTab({
  id: 'corp-announcements',
  title: 'Corp Announcements',
  subtitle:
    'BSE’s exchange-wide capture, plus additional BSE, NSE and DRHP records fetched by company. Subjects and categories are the sources’ own; each available document is linked.',
  feed,
  aboveTable: lookup.html,
  wireAboveTable: lookup.wire,
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
      // own filter and its place in the export; what it gives up is a column that said nothing new.
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
  filters: (rows) => {
    // TOPIC LEADS, because it is the only one of the three that answers what a reader came for.
    // Counts are MEASURED off the rows in scope, and "No tracked keyword" is always offered — a
    // filter that can only narrow to what it recognises can never be checked against its own
    // misses. The strict "names the company" option is dropped: a BSE filing is the company's own
    // statement, so the question does not arise, and a control that silently means something else
    // on one tab is worse than an absent one.
    const cache = rows.map(readingFor);
    const out = [
      {
        label: 'Topic',
        options: topicFilterOptions((value) => cache.filter((reading) => matchesTopic(reading, value)).length).filter((o) => o.value !== FILTER_TARGETED),
        match: (r, v) => matchesTopic(readingFor(r), v),
      },
      { label: 'Source', options: [{ value: 'all', label: 'All sources' }, ...[...new Set(rows.flatMap(announcementSources))].sort().map((value) => ({ value, label: value }))], match: (r, value) => announcementSources(r).includes(value) },
    ];
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    if (cats.length > 1) {
      out.push({
        label: 'Category',
        options: [{ value: 'all', label: 'All categories' }, ...cats.map((c) => ({ value: c, label: c }))],
        match: (r, v) => r.category === v,
      });
    }
    const subs = [...new Set(rows.map((r) => r.subCategory).filter(Boolean))].sort();
    if (subs.length > 1) {
      out.push({
        label: 'Sub-category',
        options: [{ value: 'all', label: 'All sub-categories' }, ...subs.slice(0, 60).map((c) => ({ value: c, label: c }))],
        match: (r, v) => r.subCategory === v,
      });
    }
    return out;
  },
  provenance: (m) => `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
      <button data-modal-close class="text-2xl text-slate-400">&times;</button>
    </div>
    <div class="space-y-3 text-sm leading-relaxed text-slate-600">
      <p><strong>BSE date capture:</strong> the scheduled exchange-wide feed covers its retained ${m.windowDays}-day window.
        Its freshness label applies to that capture. Subjects, categories and sub-categories are supplied by the exchange.</p>
      <p><strong>Additional company lookups:</strong> Muns reads BSE, NSE fallback and DRHP documents for the ticker and dates
        you enter. These rows are added to this table and retained on this device. They are not a complete NSE or DRHP universe capture.
        Repeating a lookup adds new records; a failed or empty response does not remove earlier disclosures.</p>
      <p>The Source column and filter preserve exchange labels. Matching document, company and date overlap is shown once;
        separate exchange documents remain separate rows. Original document links are included in the export.</p>
      <p><strong>Topic</strong> is the desk’s keyword reading of the filing subject and sub-category, not a source-provided sentiment.
        No PDF is summarized or scored. Missing fields remain blank.</p>
      <p>${m.supplement?.lookups || 0} additional lookups across ${m.supplement?.companies || 0} companies;
        ${m.supplement?.failed || 0} latest attempts failed. The form reports its latest response and any partial result.</p>
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
                `Additional Muns company/date lookups are retained on this device and may cover older dates. Their coverage is limited to the companies and ranges requested. ` +
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
export const render = tab.render;
export const destroy = tab.destroy;
