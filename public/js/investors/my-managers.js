import * as managers from '../data/managers.js';
import * as watchlist from '../core/watchlist.js';
import { escapeHtml as esc } from '../core/dom.js';
import { formatNumber, formatDate, formatCroreCompact } from '../core/format.js';
import { scoreTable, openWorkspace, closeWorkspace } from '../ui/screener.js';
import { exportRows } from '../ui/export.js';
import { unlockPortfolio, portfolioConnectionState, FAMILY_ORIGIN } from '../research/portfolio-bridge.js';
import { publicDisclosuresHtml, wirePublicDisclosures } from './public-disclosures.js';
import { periodRange, inPeriod, PERIODS } from '../data/investor-changes.js';

const money = v => v === null || v === undefined ? '—' : Math.abs(v) >= 1e7 ? formatCroreCompact(v / 1e7) : `₹${formatNumber(v, { decimals: 2 })}`;
const num = v => v === null || v === undefined ? '—' : formatNumber(v, { decimals: 2 });
const date = v => v ? formatDate(v) : '—';
const label = m => m.kind === 'fund' ? 'Private fund' : m.kind === 'listed-fund' ? 'Held fund units' : m.name === 'Direct / In-house' ? 'Direct holdings' : 'Custodian';
const entries = () => [...managers.all(), ...managers.listedFunds()];
const sourcePeriod = m => {
  if (m.kind === 'fund') return privatePeriod();
  const meta = managers.meta(), basis = meta?.listedValuationBasis;
  const mark = basis === 'stated' ? `marks ${date(meta.listedValuationAt)}` : basis === 'traded' ? `last trade ${date(meta.listedValuationAt)}; valuation date unverified` : 'valuation date unstated';
  return `Workbook period ${date(m.asOf)} · ${mark}`;
};
function privatePeriod() {
  const w = managers.meta()?.privateWorkbook;
  return `Workbook ${w?.received ? `received ${date(w.received)}` : w?.saved ? `saved ${date(w.saved)}` : 'date unavailable'} · valuation date unstated`;
}
export function managerUnavailable() {
  const locked = portfolioConnectionState() === 'locked';
  return `<div class="rounded-2xl bg-white p-6 ring-1 ring-slate-100" data-manager-unavailable><p class="text-sm text-slate-600">${esc(managers.failureInfo() || (locked ? 'Unlock Sattva Family to see your managers.' : 'Checking your Sattva Family manager book…'))}</p>${locked ? '<button data-manager-unlock class="mt-3 text-sm font-semibold text-indigo-600">Unlock Sattva Family</button>' : ''}</div>`;
}
export function wireManagerUnlock(root) { root.querySelector('[data-manager-unlock]')?.addEventListener('click', unlockPortfolio); }
export const sectionsFor = base => [{ id: 'quarterly-changes', label: 'Changes' }, { id: 'my-managers', label: 'My Managers' }, ...base.filter(s => s.id !== 'quarterly-changes')];
export function renderManagers(ctx) {
  let host, stopped = false, query = '';
  function paint() {
    if (stopped || !host?.isConnected) return;
    const focused = host.querySelector('[data-manager-search]') === document.activeElement;
    if (!managers.meta()) { host.innerHTML = managerUnavailable(); wireManagerUnlock(host); return; }
    const filtered = entries().filter(m => m.name.toLowerCase().includes(query.toLowerCase()));
    const groups = [['custodian', 'Custodians & direct holdings'], ['fund', 'Private funds'], ['listed-fund', 'Fund units & ETFs']];
    host.innerHTML = `<div class="mb-4 flex flex-wrap items-center justify-between gap-3"><p class="text-sm text-slate-600">Your holdings and fund investments from Sattva Family.</p><label class="text-xs text-slate-500">Find a manager <input data-manager-search aria-label="Search managers" value="${esc(query)}" class="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-2"></label></div>
      ${groups.map(([kind, title]) => `<section class="mb-6"><h2 class="mb-3 font-display text-lg font-bold text-slate-900">${title}</h2><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${filtered.filter(m => m.kind === kind).map(m => `<button data-open-manager="${esc(m.id)}" class="rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-colors hover:bg-slate-50"><p class="text-xs text-slate-500">${label(m)}</p><h3 class="mt-1 font-display font-bold text-slate-900">${esc(m.name)}</h3><p class="mt-3 text-lg font-semibold tabular-nums text-slate-800">${money(m.values.marketValue)}</p><p class="mt-1 text-xs text-slate-500">${m.kind === 'fund' ? `Drawn ${money(m.capital.drawn)} · distributed ${money(m.capital.distributed)}` : `${m.values.positionCount} securities · cost ${money(m.values.costBasis)}`}</p><p class="mt-2 text-xs text-slate-500">${esc(sourcePeriod(m))}</p></button>`).join('') || '<p class="text-sm text-slate-500">No matching entries in the connected workbook.</p>'}</div></section>`).join('')}
      <details class="text-xs text-slate-500"><summary class="cursor-pointer font-semibold">Sources &amp; coverage</summary><p class="mt-2 leading-relaxed">${esc(managers.meta().coverage.note)} Source checked ${esc(managers.meta().checkedAt)}. ${ctx.scope === 'watchlist' ? 'Cards show the complete book; workspace holdings and trades follow your Watchlist.' : 'Manager cards cover the whole Family book.'}</p></details>`;
    host.querySelector('[data-manager-search]').addEventListener('input', e => { query = e.target.value; paint(); });
    host.querySelectorAll('[data-open-manager]').forEach(b => b.addEventListener('click', () => openManager(b.dataset.openManager, ctx)));
    if (focused) { const input = host.querySelector('[data-manager-search]'); input.focus(); input.setSelectionRange(query.length, query.length); }
  }
  return { html: '<div data-my-managers></div>', wire(root, disposers) {
    host = root.querySelector('[data-my-managers]');
    const off = managers.onChange(paint), stop = managers.watchFreshness();
    disposers.push(() => { stopped = true; off(); stop(); }); paint();
  } };
}

export function openManager(id, ctx = { scope: 'portfolio' }) {
  const manager = entries().find(m => m.id === id), snapshot = managers.meta();
  if (!manager || !snapshot) return;
  const include = r => ctx.scope !== 'watchlist' || r.ticker && watchlist.has(r.ticker);
  const positions = manager.positions.filter(include), transactions = manager.transactions.filter(include);
  let panelStop = null, off = null, observer = null, period = 'quarter';
  const views = {};
  const dispose = () => { panelStop?.(); panelStop = null; off?.(); off = null; observer?.disconnect(); };
  const note = () => `<p class="mb-4 text-xs leading-relaxed text-slate-500">${esc(sourcePeriod(manager))}. ${ctx.scope === 'watchlist' ? 'Watchlist securities only; weights use the complete custodian book.' : 'Whole Family book, combined across its accounts.'}</p>`;
  const tableTab = (id, title, rows, columns, sub) => ({ id, label: title,
    render() { panelStop?.(); panelStop = null; const table = scoreTable({ rows, key: r => r.id || r.isin, name: r => r.security,
      sub: sub || (r => r.isin), watchKey: r => r.ticker || null, watchName: r => r.security,
      showAvatar: false, showBookmarks: false, dense: true, stickyHead: '480px', fillMode: 'scroll',
      initialView: views[id], searchable: r => `${r.security} ${r.isin} ${r.ticker || ''} ${r.date || ''}`, columns,
      searchPlaceholder: 'Search security...', emptyMessage: 'No matching records in the connected workbook.',
      onExport: selected => exportManager(selected, manager, snapshot, title, ctx.scope, id === 'period' ? periodRange(period) : null) });
      views[id] = table.view; this.table = table; return note() + `<div data-manager-table>${table.html}</div>`; },
    wire(root) { panelStop = this.table.wire(root.querySelector('[data-manager-table]')); } });
  const tabs = manager.kind !== 'fund' ? [tableTab('holdings', manager.kind === 'listed-fund' ? 'Units' : 'Holdings', positions, [
    { label: 'Quantity', get: r => num(r.quantity) }, { label: 'Value (INR)', get: r => money(r.marketValue) },
    { label: 'Cost (INR)', get: r => money(r.costBasis) }, { label: 'Weight', get: r => r.weightPct === null ? '—' : `${r.weightPct.toFixed(2)}%` },
    { label: 'Asset class', get: r => r.assetClass },
  ])] : [];
  if (manager.kind !== 'fund') {
    const tradeColumns = [{ label: 'Action', get: r => r.side === 'buy' ? 'Bought' : 'Sold' }, { label: 'Ledger date', get: r => date(r.date), sortValue: r => r.date },
      { label: 'Shares / units', get: r => num(r.quantity) }, { label: 'Amount (INR)', get: r => money(r.amount) },
      { label: 'Date / transfer note', get: r => r.dateSheet ? `Earliest ledger sighting; sheet ${date(r.dateSheet)}` : r.transfer ? 'Family transfer' : 'Reported ledger date' }];
    const tradesTab = tableTab('trades', 'Trades', transactions, tradeColumns);
    const periodTab = tableTab('period', 'This period', [], tradeColumns);
    periodTab.render = function() { const range = periodRange(period); this.tableRows = transactions.filter(r => inPeriod(r, range));
      const table = tableTab('period', 'This period', this.tableRows, tradeColumns); this.current = table;
      return `<label class="mb-4 block text-xs text-slate-500">Period <select data-manager-period aria-label="Manager period" class="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-2">${PERIODS.map(p => `<option value="${p.id}" ${p.id === period ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>` + table.render(); };
    periodTab.wire = function(root) { this.current.wire(root); root.querySelector('[data-manager-period]').addEventListener('change', e => { period = e.target.value; root.innerHTML = this.render(); this.wire(root); root.querySelector('[data-manager-period]')?.focus(); }); };
    tabs.push(periodTab, tradesTab);
  }
  if (manager.kind === 'fund') tabs.push({ id: 'capital', label: 'Commitments & distributions', render: () => {
    panelStop?.(); panelStop = null;
    const c = manager.capital;
    return note() + `<dl class="grid gap-4 sm:grid-cols-2">${[['Committed', c.committed], ['Drawn', c.drawn], ['Distributed', c.distributed], ['Residual value', c.currentValue]].map(([name, v]) => `<div><dt class="text-sm text-slate-500">${name}</dt><dd class="mt-1 text-lg font-semibold">${money(v)}</dd></div>`).join('')}</dl><p class="mt-4 text-xs text-slate-500">Cumulative workbook amounts since first investment ${esc(date(c.firstInvest))}. Dated capital-call/distribution transactions and fund units are not supplied by this workbook.</p><button data-manager-capital-export class="mt-4 text-sm font-semibold text-indigo-600">Export capital amounts</button>`;
  }, wire(root) {
    root.querySelector('[data-manager-capital-export]').addEventListener('click', () => {
      if (managers.meta()?.sourceRevision !== snapshot.sourceRevision) return;
      const keys = ['committed', 'drawn', 'distributed', 'currentValue', 'tvpi', 'dpi', 'firstInvest'];
      exportRows({ filename: `sattva-${id}-capital`, sheetName: 'Capital amounts', rows: [manager.capital], canExport: () => managers.meta()?.sourceRevision === snapshot.sourceRevision, columns: [...keys.map(key => ({ key, header: key, get: r => r[key] })),
        { key: 'source', header: 'Source and scope', width: 80, get: () => `${manager.name}; whole Family fund investment; ${sourcePeriod(manager)}; checked ${snapshot.checkedAt}; capital amounts are cumulative, multiples are not returns` }] });
    });
  } });
  tabs.push({ id: 'performance', label: 'Performance', render: () => {
    panelStop?.(); panelStop = null;
    return note() + (manager.kind === 'fund'
      ? `<p class="text-sm">TVPI ${manager.capital.tvpi === null ? '—' : `${num(manager.capital.tvpi)}×`} · DPI ${manager.capital.dpi === null ? '—' : `${num(manager.capital.dpi)}×`}</p><p class="mt-3 text-xs text-slate-500">TVPI = (residual value + distributions) ÷ drawn capital; DPI = distributions ÷ drawn capital. These are capital multiples. Dated cash flows and a manager return series are unavailable.</p>`
      : `<p class="text-sm">Unrealised gain on current holdings: <strong>${money(manager.values.unrealised)}</strong></p><p class="mt-3 text-xs text-slate-500">${manager.kind === 'listed-fund' ? 'Held fund units across custodians' : 'Whole custodian book'} at workbook marks, current value less held cost. This excludes realised proceeds and is not a manager return. A verified NAV/flow series is unavailable.</p>`);
  } }, { id: 'exchange', label: 'Exchange disclosures', render: () => { panelStop?.(); panelStop = null; return publicDisclosuresHtml(id, 'manager'); }, wire: root => { panelStop = wirePublicDisclosures(root, id, 'manager'); } },
  { id: 'profile', label: 'Profile', render: () => { panelStop?.(); panelStop = null; return `<p class="mb-3 text-sm text-slate-700">${esc(label(manager))} · ${esc(manager.name)}</p>${note()}${manager.kind === 'listed-fund' ? '<p class="mb-3 text-xs text-slate-500">These units also appear in custodian holdings. AMC scheme portfolios, fund-house mandate details and independently reported NAVs are not linked to this workbook.</p>' : ''}<p class="text-xs leading-relaxed text-slate-500">${esc(snapshot.coverage.note)} Source checked ${esc(snapshot.checkedAt)}.</p><a class="mt-4 inline-block text-sm font-semibold text-indigo-600" href="${FAMILY_ORIGIN}${manager.kind === 'fund' ? '/private' : '/returns'}" target="_blank" rel="noopener noreferrer">Open Sattva Family ↗</a>`; } });
  openWorkspace({ title: manager.name, subtitle: sourcePeriod(manager), tabs,
    actionsHtml: `<span data-manager-workspace="${esc(id)}"></span>`, onClose: dispose });
  const owned = () => document.querySelector('[data-manager-workspace]')?.dataset.managerWorkspace === id;
  off = managers.onChange(() => { if (!owned()) { dispose(); return; } if (!managers.meta() || managers.meta().sourceRevision !== snapshot.sourceRevision) closeWorkspace(); });
  observer = new MutationObserver(() => { if (!owned()) dispose(); });
  observer.observe(document.getElementById('workspace-content'), { childList: true });
}
function exportManager(rows, manager, snapshot, title, scope, range) {
  if (managers.meta()?.sourceRevision !== snapshot.sourceRevision) return;
  const keys = manager.kind !== 'fund' && !['Holdings', 'Units'].includes(title) ? ['date', 'dateSheet', 'security', 'isin', 'side', 'quantity', 'amount', 'unitPrice', 'transfer'] : ['security', 'isin', 'quantity', 'marketValue', 'costBasis', 'weightPct', 'assetClass'];
  return exportRows({ filename: `sattva-${manager.id}-${title.toLowerCase().replaceAll(' ', '-')}`, sheetName: title,
    rows, canExport: () => managers.meta()?.sourceRevision === snapshot.sourceRevision, columns: [...keys.map(key => ({ key, header: key, get: r => r[key] ?? null })),
      { key: 'basis', header: 'Source and scope', width: 80, get: () => `${manager.name}; ${scope}${range ? `; ${range.from || 'All retained history'} to ${range.to}` : ''}; ${sourcePeriod(manager)}; checked ${snapshot.checkedAt}; ${snapshot.coverage.note}` }] });
}
