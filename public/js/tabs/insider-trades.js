// tabs/insider-trades.js — insider dealing in the companies in scope.
//
// THIS FEED ARRIVES AS A MARKDOWN TABLE, not JSON — the only upstream in this dashboard that does.
// So the columns are not ours and are not fixed: whatever the source heads its table with is what
// appears here, in its order. `columnsFor()` builds the table from `meta.headers` at render time.
//
// THE HEADINGS ARE REPRODUCED, NOT TRANSLATED. If the source writes "Acq/Disp" this says
// "Acq/Disp", not "Action" — mapping their vocabulary onto ours would put our word on their data,
// and it would break silently the day they add a column. The one thing read out of the row is the
// date, and only so the table can sort; every other cell is passed through as text.
//
// NOTHING IS SUMMED. A quantity column may hold "1,20,000" or "1,20,000 (pledged)" and a value
// column may be blank; totalling those would either crash or, worse, quietly produce a number.
// Insider dealing is a list of events, and this shows the list.

import { escapeHtml } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { insider as feed } from '../data/filings.js';
import { insiderTradeSourceUrl, pickField } from '../data/filings-shared.js';

export { insiderTradeSourceUrl };

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

/** Columns a header is likely to be, if the source names one at all. */
const looksLikeDate = (h) => /date|when/i.test(h);
const looksLikeInsiderName = (h) => /person|insider|holder|acquirer/i.test(h);
const looksLikeName = (h) => /name/i.test(h) || looksLikeInsiderName(h);
const looksLikeSource = (h) => /^\s*(source|exchange)\s*$/i.test(h);
const looksLikeLink = (h) => /^\s*(link|url|source[\s_-]*url|filing[\s_-]*(link|url)|document[\s_-]*(link|url))\s*$/i.test(h);

const nameKeyFor = (row) => {
  const keys = Object.keys(row?.cells || {});
  return keys.find(looksLikeInsiderName) || keys.find(looksLikeName) || null;
};

const insiderNameFor = (row) => {
  const key = nameKeyFor(row);
  const value = key ? row?.cells?.[key] : null;
  return value == null ? null : String(value).trim() || null;
};

function sourceCell(row) {
  const url = insiderTradeSourceUrl(row);
  if (!url) return dash('the source supplied no linkable filing or identifying name');
  const who = String(insiderNameFor(row) || row?.ticker || 'this disclosure');
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-stop data-insider-source-link
             aria-label="Open source for ${escapeHtml(who)}" title="Open the matching public disclosure"
             class="inline-flex h-7 w-7 items-center justify-center rounded-md text-base font-semibold text-indigo-600 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50 hover:text-indigo-800">↗</a>`;
}

/**
 * Tint a buy green and a sell rose — but only where the cell says so in words.
 *
 * This is a reading of their text, not a classification of ours: the tint fires on the literal
 * words the source used and on nothing else, so a value it does not recognise stays plain rather
 * than being guessed into a direction.
 */
function directionTint(v) {
  const s = String(v || '').toLowerCase();
  if (/\b(buy|bought|acquisition|acquire[d]?|purchase[d]?|allot)/.test(s)) return 'text-emerald-700 font-medium';
  if (/\b(sell|sold|disposal|dispose[d]?|sale|pledge)/.test(s)) return 'text-rose-700 font-medium';
  return 'text-slate-600';
}

// The upstream owns both the headings and the values, so these filters only locate likely heading
// variants and reproduce the cell text as-is. In particular, "Transaction" is presented as
// "Transaction type" on the control because that is the question the reader is asking; its option
// values remain the source's own words (Acquisition, Disposal, Pledge, and so on).
const FILTER_FIELDS = [
  { label: 'Category', allLabel: 'All categories', keys: ['category'], maxWidthPx: 220 },
  {
    label: 'Transaction type',
    allLabel: 'All transaction types',
    keys: ['transaction', 'transaction type', 'acq/disp', 'acquisition/disposal'],
    maxWidthPx: 200,
  },
  { label: 'Mode', allLabel: 'All modes', keys: ['mode', 'transaction mode', 'method'], maxWidthPx: 240 },
];

const filterCell = (row, keys) => {
  const value = pickField(row?.cells, keys);
  return value == null ? null : String(value).trim() || null;
};

function tradeFilters(rows) {
  return FILTER_FIELDS.map((field) => {
    // A numeric/date-only value under Transaction or Mode is a ragged upstream markdown row, not
    // a transaction choice. It remains visible under "All" but is not promoted into a misleading
    // dropdown option. Every genuine value in this feed contains a word.
    const values = [...new Set(rows.map((r) => filterCell(r, field.keys)).filter((v) => v && /[A-Za-z]/.test(v)))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
    );
    return {
      label: field.label,
      maxWidthPx: field.maxWidthPx,
      options: [{ value: 'all', label: field.allLabel }, ...values.map((value) => ({ value, label: value }))],
      match: (row, value) => filterCell(row, field.keys) === value,
    };
  });
}

const tab = makeFilingsTab({
  id: 'insider-trades',
  title: 'Insider Trades',
  subtitle: 'Insider dealing disclosed for the companies in scope. Each row preserves the disclosure’s fields and links to its matching public record.',
  feed,
  noun: 'trades',
  nameLabel: 'Insider',
  nameMaxPx: 260,
  rowName: (r) => {
    return insiderNameFor(r) || r.ticker || '(not named)';
  },
  rowSub: (r) => r.ticker || '',
  searchable: (r) => `${r.ticker || ''} ${Object.values(r.cells || {}).join(' ')}`,
  // The whole row, because these rows have no id of their own: no URL, no headline, and two filings
  // on one day by two people are a legitimate pair. NEVER the row's index — see the note beside the
  // key builder in filings-tab.js for what that cost the News tab.
  keyFor: (r) => `${r.ticker || ''}|${r.date || ''}|${Object.values(r.cells || {}).join('|')}`,
  filters: tradeFilters,
  // The shared renderer's separate Link column is disabled. Insider Trades owns one Source column:
  // an arrow to the row's evidence, never a repeated provider label plus a second arrow.
  link: false,
  // THE COLUMN SET IS THE SOURCE'S. Built from the headers the markdown table declared, minus the
  // identity/date fields and the source/link fields consolidated into the one Source arrow below.
  // A source that adds any other column still gets a column.
  columns: (m) => {
    const headers = (m.headers || []).filter((h) => !looksLikeName(h) && !looksLikeSource(h) && !looksLikeLink(h));
    const cols = [
      {
        label: 'Date',
        get: (r) => (r.date ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}</span>` : dash('the row carried no readable date')),
        html: true,
        sortValue: (r) => r.date || '',
      },
    ];
    for (const h of headers) {
      if (looksLikeDate(h)) continue; // already the Date column
      cols.push({
        label: h,
        get: (r) => {
          const v = r.cells?.[h];
          if (v == null || v === '') return dash('the source left this cell empty');
          return `<span class="${directionTint(v)}">${escapeHtml(String(v))}</span>`;
        },
        html: true,
        // Sorted as text, because these cells are text. A quantity written "1,20,000 (pledged)" is
        // not a number and coercing it would sort 1.2 lakh below 9.
        sortValue: (r) => String(r.cells?.[h] ?? ''),
      });
    }
    cols.push({
      label: 'Source',
      get: sourceCell,
      html: true,
      sortable: false,
    });
    return cols;
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Insider trades</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real disclosures.</strong> Indian promoters, directors and designated persons must disclose their dealing
           to the exchanges. These come through the Muns filings API
           (<code class="rounded bg-slate-100 px-1">POST /filings/data/insider_trades</code>) with
           <code class="rounded bg-slate-100 px-1">country: india</code>, which routes to NSE, BSE and Trendlyne.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The table is theirs, columns and all</h3>
        <p class="mt-1 text-xs">This endpoint answers with a <strong>markdown table</strong> rather than JSON — the only
           upstream here that does. So the columns on screen are whatever their table declared, in their order, under
           <strong>their headings</strong>. Nothing is renamed: if they write <em>Acq/Disp</em> that is what this says.
           Translating their vocabulary into ours would put our word on their data and would hide a column the day they
           add one.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What this dashboard does to it</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Adds disclosures to retained history.</strong> A later empty or partial response does not erase
              trades already captured in the rolling 365-day window. Repeat responses do not multiply rows;
              different insiders, transactions and sources remain separate. Undated disclosures are retained.</li>
          <li><strong>Reads the date</strong>, so the table can sort. That is the only cell interpreted.</li>
          <li><strong>Tints a direction</strong> where the cell says so in words — <em>bought</em>, <em>sold</em>,
              <em>disposal</em>. A value it does not recognise stays plain rather than being guessed into a direction.</li>
          <li><strong>Sums nothing.</strong> There is no total quantity or total value anywhere on this tab. A quantity
              written "1,20,000 (pledged)" is not a number, and adding those up would either fail or quietly produce one.</li>
        </ul>

        ${m.headers?.length ? `<p class="mt-2 text-xs">Their columns on this pull: ${m.headers.map((h) => `<code class="rounded bg-slate-100 px-1">${escapeHtml(h)}</code>`).join(' ')}</p>` : ''}

        ${coverageBlock(m)}

        <p class="mt-4 text-xs text-slate-500">A dash means <em>the source left that cell empty</em> — never zero.</p>
      </div>
    </div>`,
  onExport: async (visible, m) => {
    const headers = (m.headers || []).filter((h) => !looksLikeSource(h) && !looksLikeLink(h));
    await exportRows({
      filename: 'sattva-insider-trades',
      sheetName: 'Insider trades',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `REAL DISCLOSURES, NOT OURS. Insider trades via the Muns filings API, reaching back ${m.windowDays} days, exported ${new Date().toISOString()}. ` +
                `THE COLUMNS AND THEIR HEADINGS ARE THE SOURCE'S OWN and are reproduced unrenamed — this endpoint returns a markdown table, and its shape is theirs to change. ` +
                `NOTHING IS SUMMED OR CLASSIFIED: no total quantity, no total value, and no judgement about what a trade means. ` +
                `${m.covered} companies covered${m.failed ? `; ${m.failed} could not be read and are ABSENT rather than shown as having no insider dealing` : ''}. ` +
                `A blank cell is one the source left empty, never a zero.`
              : r.date || '',
        },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        ...headers.map((h, i) => ({ header: h, key: `c${i}`, width: 24, get: (r) => (r.__banner ? '' : r.cells?.[h] ?? '') })),
        { header: 'Source', key: 'source', width: 48, get: (r) => (r.__banner ? '' : insiderTradeSourceUrl(r) || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;
export const render = tab.render;
export const destroy = tab.destroy;
