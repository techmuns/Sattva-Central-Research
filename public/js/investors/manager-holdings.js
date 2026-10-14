import * as managers from '../data/managers.js';
import * as watchlist from '../core/watchlist.js';
import { scoreTable } from '../ui/screener.js';
import { exportRows } from '../ui/export.js';
import { formatNumber, formatCroreCompact } from '../core/format.js';
import { escapeHtml as esc } from '../core/dom.js';
import { managerUnavailable, wireManagerUnlock, openManager, sourcePeriod } from './my-managers.js';

const number = value => value == null ? '—' : formatNumber(value, { decimals: 2 });
const money = value => value == null ? '—' : Math.abs(value) >= 1e7 ? formatCroreCompact(value / 1e7) : `₹${number(value)}`;

export function renderManagerHoldings(ctx, { view = {}, onView = () => {}, toolbarControls } = {}) {
  let host, table, offTable, stopped = false;
  function paint() {
    if (stopped) return;
    const search = host.querySelector('[data-table-search]'), scroll = host.querySelector('[data-table-scroll]');
    const reading = { focused: search === document.activeElement, start: search?.selectionStart, end: search?.selectionEnd, top: scroll?.scrollTop || 0, left: scroll?.scrollLeft || 0 };
    if (table) { view = table.view; view.sourcesOpen = host.querySelector('[data-manager-holdings-sources]')?.open === true; onView(view); }
    offTable?.(); table = null;
    const snapshot = managers.meta();
    if (!snapshot) { host.innerHTML = managerUnavailable(); wireManagerUnlock(host); return; }
    // Fund-unit cards are a projection of the same custodian positions. Read the original
    // custodian book once, so the combined holdings table never counts those units twice.
    const custodians = managers.all().filter(m => m.kind === 'custodian');
    const rows = custodians.flatMap(manager => manager.positions.map((position, i) => ({ ...position, id: `${manager.id}|${position.id || position.isin || i}`, manager })))
      .filter(row => ctx.scope !== 'watchlist' || row.ticker && watchlist.has(row.ticker));
    const columns = [
      { label: 'Quantity', get: row => number(row.quantity), sortValue: row => row.quantity },
      { label: 'Value (INR)', get: row => money(row.marketValue), sortValue: row => row.marketValue },
      { label: 'Cost (INR)', get: row => money(row.costBasis), sortValue: row => row.costBasis },
      { label: 'Weight in custodian', get: row => row.weightPct == null ? '—' : `${number(row.weightPct)}%` },
      { label: 'Asset class', get: row => row.assetClass },
      { label: 'Source period / marks', get: row => sourcePeriod(row.manager) },
    ];
    const eligible = () => managers.meta()?.sourceRevision === snapshot.sourceRevision;
    table = scoreTable({ rows, key: row => row.id, name: row => row.security, sub: row => `${row.manager.name} · ${row.isin || 'identifier unstated'}`,
      watchKey: row => row.ticker || null, watchName: row => row.security, showAvatar: false, showBookmarks: false, showWatchFilter: 'selected',
      dense: true, nameMaxPx: 260, stickyHead: 'max(320px, calc(100vh - 330px))', initialView: view, toolbarControls,
      searchable: row => `${row.security} ${row.manager.name} ${row.isin || ''} ${row.ticker || ''} ${row.assetClass || ''}`,
      searchPlaceholder: 'Search company, security or manager...', columns, exportName: 'sattva-manager-holdings',
      filters: [{ label: 'Manager', options: [{ value: 'all', label: 'All managers' }, ...custodians.map(m => ({ value: m.id, label: m.name }))], match: (row, value) => row.manager.id === value }],
      onFilterChange: () => onView(table.view), onRowClick: row => openManager(row.manager.id, ctx),
      emptyMessage: 'No matching security holdings in the connected workbook. Private fund capital is available in Overview.',
      onExport: selected => {
        if (!eligible()) return;
        exportRows({ filename: 'sattva-manager-holdings', sheetName: 'Holdings', rows: selected, canExport: eligible,
          columns: [{ key: 'security', header: 'Security', get: row => row.security }, { key: 'manager', header: 'Manager', get: row => row.manager.name },
            ...['isin', 'ticker', 'quantity', 'marketValue', 'costBasis', 'weightPct', 'assetClass'].map(key => ({ key, header: key, get: row => row[key] ?? null })),
            { key: 'source', header: 'Source and scope', width: 80, get: row => `${sourcePeriod(row.manager)}; ${ctx.scope}; checked ${snapshot.checkedAt}; ${snapshot.coverage.note}` }] });
      },
    });
    table.view.sourcesOpen = view.sourcesOpen === true; view = table.view; onView(view);
    host.innerHTML = `${table.html}<details class="mt-3 text-xs text-slate-500" data-manager-holdings-sources ${view.sourcesOpen ? 'open' : ''}><summary class="cursor-pointer font-semibold">Sources &amp; coverage</summary><p class="mt-2">${esc(snapshot.coverage.note)} Checked ${esc(snapshot.checkedAt)}. Fund units are included once in their custodian holdings. Private fund commitments and distributions are available in Overview; the workbook supplies no underlying security book for those investments. Weights refer to each complete custodian book.</p></details>`;
    offTable = table.wire(host);
    host.querySelector('[data-manager-holdings-sources]').addEventListener('toggle', e => { if (!stopped && e.target.isConnected) { view.sourcesOpen = e.target.open; onView(view); } });
    const nextScroll = host.querySelector('[data-table-scroll]');
    if (nextScroll) { nextScroll.scrollTop = reading.top; nextScroll.scrollLeft = reading.left; }
    if (reading.focused) { const next = host.querySelector('[data-table-search]'); next?.focus({ preventScroll: true }); next?.setSelectionRange(reading.start, reading.end); }
  }
  return { html: '<div role="tabpanel" aria-label="Holdings" data-manager-holdings></div>', wire(root, disposers) {
    host = root.querySelector('[data-manager-holdings]');
    const off = managers.onChange(paint), stop = managers.watchFreshness();
    disposers.push(() => { stopped = true; offTable?.(); off(); stop(); }); paint();
  } };
}
