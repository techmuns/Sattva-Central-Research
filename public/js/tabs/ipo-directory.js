// Same screener kit as the filing view. Publisher lifecycle is not an exchange confirmation.
import { scoreTable } from '../ui/screener.js';
import { escapeHtml as e } from '../core/dom.js';
import { exportSheets, todayStamp } from '../ui/export.js';

const date = (s) => s || 'Not supplied';
export function directoryTable(rows, view) {
  const options = (key, label) => ({ label, options: [{ value: 'all', label: `All ${label.toLowerCase()}` }, ...[...new Set(rows.map((r) => r[key] || 'Not supplied'))].sort().map((v) => ({ value: v, label: v }))], match: (r, v) => (r[key] || 'Not supplied') === v });
  return scoreTable({ rows, key: (r) => r.id, watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
    name: (r) => r.company, sub: (r) => `${r.board} · ${r.retained ? 'Retained; not in latest list' : 'IPOPlatform'}`,
    showRank: false, dense: true, nameMaxPx: 260, stickyHead: 'max(320px, calc(100vh - 310px))', fillMode: 'scroll',
    columns: [
      { label: 'Publisher status', get: (r) => r.status || 'Not supplied' },
      { label: 'Open / close', get: (r) => r.openingDate && r.closingDate ? `${r.openingDate} – ${r.closingDate}` : r.openingWindow || 'Not supplied' },
      { label: 'Listing date', get: (r) => date(r.listingDate), sortValue: (r) => r.listingDate || '' },
      { label: 'DRHP date', get: (r) => date(r.draftDate), sortValue: (r) => r.draftDate || '' },
      { label: 'Observed (IST)', get: (r) => new Date(r.observedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) },
      { label: 'Details', get: (r) => `<a href="${e(r.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-indigo-600">Publisher ↗</a>`, html: true, sortable: false },
    ],
    filters: [options('status', 'Statuses'), options('board', 'Boards')],
    searchable: (r) => `${r.company} ${r.ticker || ''} ${r.isin || ''} ${r.sector || ''}`,
    initialSort: { key: 'Listing date', dir: 'desc' }, initialView: view, link: (r) => r.url,
    countNoun: 'issuers', exportName: 'sattva-ipo-directory',
    emptyMessage: 'No captured issuers match. The first scheduled collection may not be available yet; check Source details.',
    onExport: (visible, filename) => exportSheets({ filename: `${filename}-${todayStamp()}`, banner: 'Secondary IPOPlatform catalogue, not an exchange confirmation or complete IPO universe. Status and dates are publisher-reported as of each observation.', sheets: [{ name: 'IPO directory', rows: visible, columns: [
      { header: 'Company', key: 'company', get: (r) => r.company, width: 40 },
      ...[['board', 'Board'], ['status', 'Publisher status'], ['drhpStatus', 'Publisher DRHP status'], ['openingDate', 'Opening date'], ['closingDate', 'Closing date'], ['openingWindow', 'Published opening window'], ['listingDate', 'Listing date'], ['draftDate', 'Document DRHP date'], ['refiledDate', 'Publisher refiling date'], ['publisherUpdatedAt', 'Publisher row updated'], ['observedAt', 'Collected at'], ['url', 'Source URL']].map(([key, header]) => ({ key, header, get: (r) => r[key] || 'Not supplied', width: key === 'url' ? 60 : 26 })),
      { key: 'retained', header: 'Retained, not re-confirmed', get: (r) => r.retained ? 'Yes' : 'No' },
    ] }] }),
  });
}
