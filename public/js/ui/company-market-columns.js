import * as market from '../data/company-market.js';
import { escapeHtml } from '../core/dom.js';
import { formatRupee } from '../core/format.js';
import { formatMarketCap } from '../data/company-profile.js';

// Explicit opt-in: fund NAVs, deal prices, investor values and document tables are not CMP.
export const companyOf = row => row?.__banner ? {} : typeof row?.company === 'object' ? row.company : row;
export function marketCell(company, field) {
  const reading = market.read(company), price = field === 'cmp';
  const value = price ? reading.cmp : reading.mcapCr, label = price ? reading.quoteLabel : reading.mcapLabel;
  const text = value == null ? '—' : price ? formatRupee(value) : formatMarketCap(value);
  return `<span class="whitespace-nowrap tabular-nums" title="${escapeHtml(label)}">${escapeHtml(text)}</span>${price && value != null ? `<div class="text-[10px] text-slate-500" style="max-width:180px;white-space:normal">${escapeHtml(label)}</div>` : ''}`;
}
export function marketColumns(columns, option, exported = false) {
  if (!option) return columns;
  const resolve = typeof option === 'function' ? option : option.company || companyOf;
  const labelKey = exported ? 'header' : 'label';
  const cmp = columns.find(col => /^CMP\b/i.test(col[labelKey]) || option.cmpLabel && col[labelKey] === option.cmpLabel);
  const cap = columns.find(col => /^(?:Market\s*cap|MCap)(?:\b|\s*\()/i.test(col[labelKey]));
  const marketCompany = row => {
    const company = resolve(row);
    if (!cap && cmp) {
      const value = exported ? cmp.get(row) : cmp.sortValue?.(row);
      return { ...company, marketQuote: { price: Number.isFinite(value) && value > 0 ? value : null, label: 'CMP displayed in this row' } };
    }
    return company;
  };
  const reading = row => market.read(marketCompany(row));
  const make = (field, label) => exported
    ? { header: label, key: `company_market_${field}`, width: 20, get: row => row.__banner ? '' : reading(row)[field] ?? '' }
    : { label, marketField: field, html: true, align: 'right', get: row => marketCell(marketCompany(row), field), sortValue: row => reading(row)[field] ?? -Infinity };
  const preserve = column => {
    const conflict = row => market.read(resolve(row)).identityConflict;
    const next = { ...column, get: row => conflict(row)
      ? exported ? '' : column.html ? '<span title="Company identifiers disagree; value withheld">—</span>' : '—'
      : column.get(row) };
    if (column.sortValue) next.sortValue = row => conflict(row) ? -Infinity : column.sortValue(row);
    return next;
  };
  const priceColumn = cmp ? preserve(cmp) : make('cmp', exported ? 'CMP (₹)' : 'CMP');
  const capColumn = cap ? preserve(cap) : make('mcapCr', exported ? 'Market cap (₹ Cr)' : 'Market cap');
  if (!exported && !cmp && cap) priceColumn.columnBefore = cap.label;
  if (!exported && !cap && cmp) capColumn.columnAfter = cmp.label;
  // Keep existing source-specific renderers and sort keys; add only what is missing.
  const rest = columns.filter(col => col !== cmp && col !== cap);
  const anchor = cap || cmp;
  const index = anchor ? columns.slice(0, columns.indexOf(anchor)).filter(col => col !== cmp && col !== cap).length : rest.length;
  rest.splice(index, 0, priceColumn, capColumn);
  if (!exported) return rest;
  return [...rest,
    ...(!cmp ? [{ header: 'CMP source / time', key: 'company_market_quote_source', width: 65, get: row => row.__banner ? '' : market.read(resolve(row)).quoteLabel }] : []),
    ...(!cap ? [{ header: 'Market cap source / time', key: 'company_market_cap_source', width: 80, get: row => row.__banner ? '' : reading(row).mcapLabel }] : [])];
}

export const marketHeads = '<th scope="col" class="p-3 text-right">CMP</th><th scope="col" class="p-3 text-right">Market cap</th>';
const wired = new WeakMap();
export function marketCells(company) {
  const identity = { ticker: company.ticker || company.symbol || null, isin: company.isin || null,
    scripCode: company.scripCode || company.bseCode || null };
  return ['cmp', 'mcapCr'].map(field => `<td class="p-3 text-right" data-market-field="${field}" data-company-market="${escapeHtml(JSON.stringify(identity))}">${marketCell(identity, field)}</td>`).join('');
}
// Handwritten company comparison tables share the same source and stop when their panel closes.
export function wireMarketCells(host) {
  if (wired.has(host)) return wired.get(host);
  if (!host.querySelector('[data-company-market]')) return () => {};
  const update = () => {
    for (const cell of host.querySelectorAll('[data-company-market]')) {
      const html = marketCell(JSON.parse(cell.dataset.companyMarket), cell.dataset.marketField);
      if (cell.innerHTML !== html) cell.innerHTML = html;
    }
  };
  const stop = market.watch(update);
  const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
  let disposed = false;
  function dispose() { if (disposed) return; disposed = true; stop(); observer.disconnect(); if (wired.get(host) === dispose) wired.delete(host); }
  observer.observe(document.body, { childList: true, subtree: true });
  wired.set(host, dispose);
  return dispose;
}
