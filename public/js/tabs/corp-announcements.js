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
// THERE IS NO SOURCE COLUMN ANY MORE. Every row is BSE, so a column of identical badges was noise
// dressed as provenance. Which exchange said it now belongs in the pill and the modal, said once.
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

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// Existing committed captures may predate the upstream normaliser fix. Clean on read as well so a
// deploy repairs visible `<BR><BR>` immediately, without waiting for the next scheduled capture.
export const cleanFilingText = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
    'Every corporate filing made with BSE in the window, for the whole exchange — read by date rather than one company at a time. Subjects and categories are the filings’ own; the document is linked, not reproduced.',
  feed,
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
      label: 'Sub-category',
      get: (r) => (r.subCategory ? `<span class="text-slate-600">${escapeHtml(r.subCategory)}</span>` : dash('BSE did not carry a sub-category for this filing')),
      html: true,
      sortValue: (r) => r.subCategory || '',
    },
  ],
  filters: (rows) => {
    const out = [];
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
    return out.length ? out : null;
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real filings, read from BSE's own date index.</strong> Indian listed companies file announcements with the
           exchanges continuously — board meetings, results, corporate actions, clarifications. These come from BSE's
           <code class="rounded bg-slate-100 px-1">AnnSubCategoryGetData</code> feed, which answers
           <em>what was filed on these dates</em> rather than <em>what did this company file</em>.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why that difference matters to what you see</h3>
        <p class="mt-1 text-xs">Asking company by company costs one request each against an upstream capped near sixty a
           minute, so the universe took ten minutes and a run cut short by the limit covered whatever it reached. Asking by
           date covers <strong>every listed company</strong> in about two dozen requests. So
           <strong>a company with no rows here filed nothing in the window</strong> — it was not skipped for want of
           request budget. Those are different statements and only the second one is honest about the old feed.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is ours</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Nothing in the subject, the category or the sub-category</strong> — all are BSE's own strings, and the
              category list is what their API accepts rather than a taxonomy of ours.</li>
          <li><strong>No materiality judgement.</strong> Nothing here marks an announcement important or routine. BSE's own
              critical-filing flag is reproduced where they set it and is theirs.</li>
          <li><strong>The ticker.</strong> BSE identify a filer by scrip code. Where this dashboard already holds that code
              in <code class="rounded bg-slate-100 px-1">mc-ticker-map.json</code> the row carries the confirmed NSE symbol;
              otherwise it carries BSE's own symbol, and a filer we cannot name at all keeps its row under its scrip code
              rather than being dropped.${m.unnamedRows ? ` <strong>${escapeHtml(formatNumber(m.unnamedRows))}</strong> rows are in that last state.` : ''}</li>
          <li><strong>The date normalisation only.</strong> A date that cannot be read stays blank and the row sorts last,
              rather than being given today's.</li>
        </ul>

        ${coverageBlock(m)}

        <p class="mt-4 text-xs text-slate-500">A dash means <em>the filing did not carry it</em> — never zero.</p>
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
              ? `REAL FILINGS, NOT OURS. Corporate announcements as filed with BSE, read from their date-indexed feed ` +
                `(AnnSubCategoryGetData), covering ${m.windowDays} day(s) to ${new Date().toISOString().slice(0, 10)}, exported ${new Date().toISOString()}. ` +
                `SUBJECTS, CATEGORIES AND SUB-CATEGORIES ARE BSE'S OWN WORDS — nothing here judges an announcement material or routine, and no document is summarised. ` +
                `READ BY DATE, NOT BY COMPANY: every listed company is covered, so a company absent from this file filed nothing in the window rather than having been skipped. ` +
                `${m.covered} companies filed something${m.unnamedRows ? `; ${m.unnamedRows} rows are filed under a BSE scrip code because this dashboard has no symbol for the filer` : ''}. ` +
                `A blank date means the filing's date could not be read, never that it is undated today.`
              : r.date || '',
        },
        { header: 'Time', key: 'tm', width: 10, get: (r) => (r.__banner ? '' : r.time || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'BSE scrip code', key: 'sc', width: 14, get: (r) => (r.__banner ? '' : r.scripCode || '') },
        { header: 'Company (as filed)', key: 'co', width: 38, get: (r) => (r.__banner ? '' : r.company || '') },
        { header: 'Subject (as filed)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : cleanFilingText(r.title || r.headline)) },
        { header: 'Category (as filed)', key: 'c', width: 22, get: (r) => (r.__banner ? '' : r.category || '') },
        { header: 'Sub-category (as filed)', key: 'sb', width: 30, get: (r) => (r.__banner ? '' : r.subCategory || '') },
        { header: 'Document URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;
export const render = tab.render;
export const destroy = tab.destroy;
