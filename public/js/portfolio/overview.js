// portfolio/overview.js — holdings marked to market, allocation, and the realised/unrealised split.
//
// The mark is LIVE: every last price is `cmp` from the technicals feed. The ledger behind the
// cost basis is synthetic; the split ribbon says which is which on every sub-view.
//
// `enrichHoldings` is gone. The cost-basis maths moved into js/data/portfolio.js, which replays
// the ledger through the FIFO engine once per page load — position-by.js and drawdown.js read
// the same cached positions rather than each recomputing from a holdings array.

import { statStrip, topCards, scoreTable, openDrill, sectionHead } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatRupee, formatPct, formatNumber, formatDate } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as portfolio from '../data/portfolio.js';
import {
  headMeta,
  wireProvenancePill,
  createLoader,
  moneyCell,
  pctCell,
  convictionPill,
  unpricedTag,
  termPill,
  freshnessCard,
  exportBanner,
  PNL_HELP,
} from './chrome.js';

export const meta = {
  id: 'overview',
  title: 'Overview',
  subtitle: 'Holdings marked to market, allocation, and the realised/unrealised split.',
  subviews: [
    { id: 'positions', label: 'Positions' },
    { id: 'allocation', label: 'Allocation' },
    { id: 'realised', label: 'Realised P&L' },
  ],
};

const run = createLoader(meta.title, meta.subtitle);
let disposers = [];

export function render(ctx) {
  run(ctx, paint, portfolio);
}

export function destroy() {
  disposers.forEach((d) => d && d());
  disposers = [];
}

function paint(ctx) {
  destroy();
  const view = ctx.subview || 'positions';
  if (view === 'allocation') return renderAllocation(ctx);
  if (view === 'realised') return renderRealised(ctx);
  return renderPositions(ctx);
}

// ---------------------------------------------------------------------------------------
// Signals — direct readings of the position, no model applied. A position with no live price
// reports `na` rather than a fail: "we could not check" and "it failed" are different claims.
// ---------------------------------------------------------------------------------------
const HOLDING_SIGNALS = (r) => [
  { label: 'Position in profit', status: !r.priced ? 'na' : r.unrealised > 0 ? 'pass' : 'fail' },
  { label: 'Up more than 10%', status: !r.priced ? 'na' : r.unrealisedPct >= 10 ? 'pass' : r.unrealisedPct >= 0 ? 'partial' : 'fail' },
  { label: 'Trading above cost', status: !r.priced ? 'na' : r.lastPrice >= r.avgPrice ? 'pass' : 'fail' },
  {
    label: 'Within 10% of 52w high',
    status: !r.priced || !r.high52w ? 'na' : r.lastPrice >= r.high52w * 0.9 ? 'pass' : r.lastPrice >= r.high52w * 0.8 ? 'partial' : 'fail',
  },
  { label: 'Has realised gains', status: r.realised > 0 ? 'pass' : r.realised < 0 ? 'fail' : 'na' },
  { label: 'Core conviction', status: r.convictionTier === 'Core' ? 'pass' : r.convictionTier === 'High Conviction' ? 'partial' : 'na' },
];

function statsFor(ctx, rows) {
  const s = portfolio.summary();
  const m = portfolio.meta();
  const priced = rows.filter((r) => r.priced).length;
  return statStrip([
    {
      label: 'Market value',
      value: formatRupee(s.marketValue, { decimals: 0 }),
      note: `${rows.filter((r) => r.qty > 0).length} positions · ${priced} marked live`,
    },
    { label: 'Invested', value: formatRupee(s.invested, { decimals: 0 }), note: `FIFO cost, charges included · ${s.lotCount} open lots` },
    {
      label: 'Total P&L',
      value: `${s.totalPnl > 0 ? '+' : ''}${formatRupee(s.totalPnl, { decimals: 0 })}`,
      note: `${formatPct(s.totalPnlPct)} · unrealised ${formatRupee(s.unrealised, { decimals: 0 })} + realised ${formatRupee(s.realised, { decimals: 0 })} + dividends ${formatRupee(s.dividends, { decimals: 0 })}`,
      help: PNL_HELP,
    },
    freshnessCard(m),
  ]);
}

// ---------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------
function renderPositions(ctx) {
  const rows = portfolio.forScope(ctx.scope);
  const m = portfolio.meta();
  const stats = statsFor(ctx, rows);
  const open = rows.filter((r) => r.qty > 0);

  const ranked = open.filter((r) => r.priced).slice().sort((a, b) => b.unrealisedPct - a.unrealisedPct);
  const cards = topCards({
    title: 'Top 10 by unrealised return',
    items: ranked.map((h) => ({
      name: h.name,
      sub: `${h.ticker} · ${h.sector}`,
      value: formatPct(h.unrealisedPct),
      tone: h.unrealisedPct > 0 ? 'positive' : h.unrealisedPct < 0 ? 'negative' : 'neutral',
      caption: `${h.unrealised > 0 ? '+' : ''}${formatRupee(h.unrealised, { decimals: 0 })} on ${formatNumber(h.qty)} shares`,
      payload: h,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillPosition(item.payload),
  });

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    showSignals: true,
    signals: HOLDING_SIGNALS,
    columns: [
      { label: 'Conviction', get: (r) => convictionPill(r.convictionTier), html: true, sortValue: (r) => r.convictionTier },
      { label: 'Qty', get: (r) => (r.qty ? formatNumber(r.qty) : '—'), align: 'right', sortValue: (r) => r.qty },
      { label: 'Avg Cost', get: (r) => (r.qty ? formatRupee(r.avgPrice) : '—'), align: 'right', sortValue: (r) => r.avgPrice || 0 },
      {
        label: 'Last',
        get: (r) => (r.qty ? `${escapeHtml(formatRupee(r.lastPrice))}${r.priced ? '' : unpricedTag()}` : '—'),
        html: true,
        align: 'right',
        sortValue: (r) => r.lastPrice || 0,
      },
      { label: 'Market Value', get: (r) => (r.qty ? formatRupee(r.marketValue, { decimals: 0 }) : '—'), align: 'right', sortValue: (r) => r.marketValue },
      { label: 'Unrealised', get: (r) => (r.priced ? moneyCell(r.unrealised) : '<span class="text-slate-400">—</span>'), html: true, align: 'right', sortValue: (r) => r.unrealised },
      { label: 'Unreal %', get: (r) => pctCell(r.unrealisedPct), html: true, align: 'right', sortValue: (r) => r.unrealisedPct ?? -Infinity },
      { label: 'Realised', get: (r) => (r.realised ? moneyCell(r.realised) : '<span class="text-slate-400">—</span>'), html: true, align: 'right', sortValue: (r) => r.realised },
      { label: 'Weight', get: (r) => weightBar(r.weight), html: true, align: 'right', sortValue: (r) => r.weight },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All positions' },
        { value: 'winners', label: 'In profit' },
        { value: 'losers', label: 'In loss' },
        { value: 'unpriced', label: 'No live price' },
        { value: 'closed', label: 'Fully exited' },
        { value: 'Core', label: 'Core only' },
        { value: 'High Conviction', label: 'High conviction' },
      ],
      match: (r, v) =>
        v === 'winners'
          ? r.priced && r.unrealised > 0
          : v === 'losers'
            ? r.priced && r.unrealised < 0
            : v === 'unpriced'
              ? r.qty > 0 && !r.priced
              : v === 'closed'
                ? r.isClosed
                : r.convictionTier === v,
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector} ${r.convictionTier}`,
    initialSort: { key: 'Market Value', dir: 'desc' },
    onRowClick: drillPosition,
    exportName: 'sattva-positions',
    onExport: (visible) => exportPositions(visible, m),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Every open position marked to market from the live technicals feed, with cost basis from a FIFO replay of the ledger.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: ctx.scope === 'portfolio' ? 'open positions' : 'positions incl. exited' })),
    })}
    ${stats.html}
    ${reconciliationStrip()}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals are direct readings of the position — no scoring model is applied to holdings.' })}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  cards.wire(ctx.root);
  const off = table.wire(ctx.root);
  disposers.push(off);
}

function weightBar(pct) {
  return `
    <span class="inline-flex items-center justify-end gap-2">
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}

/**
 * The reconciliation strip. Two identities the whole workspace rests on, shown as measured
 * residuals rather than claimed in prose — a dashboard that asserts its own correctness without
 * showing the working is asking to be believed.
 */
function reconciliationStrip() {
  const s = portfolio.summary();
  const r = s.reconciliation;
  const ok = r.lotsBalance && Math.abs(r.residual) < 0.01;
  // Literal class strings, not `text-${tone}-700`. Tailwind's CDN build scans source for whole
  // class names, so an interpolated one is simply absent at runtime and the element renders
  // unstyled — silently, which is the worst way for a status indicator to fail.
  const labelCls = ok ? 'text-emerald-700' : 'text-rose-700';
  const dotCls = ok ? 'bg-emerald-500' : 'bg-rose-500';
  const figCls = ok ? 'text-emerald-700' : 'text-rose-700';
  return `
    <div class="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-white px-4 py-3 text-xs shadow-sm ring-1 ring-slate-100">
      <span class="inline-flex items-center gap-1.5 font-semibold ${labelCls}">
        <span class="h-1.5 w-1.5 rounded-full ${dotCls}"></span> ${ok ? 'Reconciled' : 'RECONCILIATION FAILED'}
      </span>
      <span class="text-slate-500">Open lots sum to position quantity on all
        <strong class="text-slate-700">${s.positionCount + s.closedCount}</strong> tickers</span>
      <span class="text-slate-500">Realised
        <strong class="text-slate-700">${escapeHtml(formatRupee(s.realised, { decimals: 0 }))}</strong> + unrealised
        <strong class="text-slate-700">${escapeHtml(formatRupee(s.unrealised, { decimals: 0 }))}</strong> + dividends
        <strong class="text-slate-700">${escapeHtml(formatRupee(s.dividends, { decimals: 0 }))}</strong> = total
        <strong class="text-slate-700">${escapeHtml(formatRupee(s.totalPnl, { decimals: 0 }))}</strong>,
        residual <strong class="${figCls}">${escapeHtml(formatRupee(r.residual, { decimals: 2 }))}</strong></span>
      ${r.unpricedCount ? `<span class="text-amber-700">${r.unpricedCount} position${r.unpricedCount === 1 ? '' : 's'} marked at cost: ${escapeHtml(r.unpricedTickers.join(', '))}</span>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------------------
function renderAllocation(ctx) {
  const rows = portfolio.forScope(ctx.scope).filter((r) => r.qty > 0);
  const m = portfolio.meta();
  const stats = statsFor(ctx, rows);
  const total = rows.reduce((s, r) => s + r.marketValue, 0);

  const bySector = groupBy(rows, (r) => r.sector, total);
  const byTier = groupBy(rows, (r) => r.convictionTier, total);
  const top5 = rows.slice().sort((a, b) => b.marketValue - a.marketValue).slice(0, 5);
  const top5Pct = total ? (top5.reduce((s, r) => s + r.marketValue, 0) / total) * 100 : 0;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Allocation',
      description: 'Where the money actually sits, by sector and by conviction tier.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'open positions' })),
    })}
    ${stats.html}
    <div class="mb-6 grid gap-4 lg:grid-cols-2">
      ${allocationPanel('By sector', bySector, total)}
      ${allocationPanel('By conviction tier', byTier, total)}
    </div>
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-sm font-bold text-slate-900">Concentration</h3>
      <p class="mt-1 text-xs text-slate-500">The top five positions carry
        <strong class="text-slate-700">${top5Pct.toFixed(1)}%</strong> of market value.</p>
      <div class="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        ${top5
          .map((r, i) => {
            const pct = total ? (r.marketValue / total) * 100 : 0;
            const shades = ['bg-indigo-500', 'bg-indigo-400', 'bg-purple-400', 'bg-fuchsia-400', 'bg-pink-400'];
            return `<span class="${shades[i]}" style="width:${pct.toFixed(2)}%" title="${escapeHtml(r.name)} ${pct.toFixed(1)}%"></span>`;
          })
          .join('')}
      </div>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        ${top5.map((r) => `<span><strong class="text-slate-700">${escapeHtml(r.ticker)}</strong> ${((r.marketValue / total) * 100).toFixed(1)}%</span>`).join('')}
      </div>
    </section>
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
}

function groupBy(rows, keyFn, total) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) || 'Unclassified';
    const g = map.get(k) || { key: k, value: 0, invested: 0, unrealised: 0, count: 0, tickers: [] };
    g.value += r.marketValue;
    g.invested += r.invested;
    g.unrealised += r.unrealised;
    g.count += 1;
    g.tickers.push(r.ticker);
    map.set(k, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, weight: total ? (g.value / total) * 100 : 0, pnlPct: g.invested ? (g.unrealised / g.invested) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

function allocationPanel(title, groups, total) {
  return `
    <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-sm font-bold text-slate-900">${escapeHtml(title)}</h3>
      <div class="mt-3 space-y-3">
        ${groups
          .map(
            (g) => `
          <div>
            <div class="flex items-baseline justify-between gap-3 text-xs">
              <span class="font-semibold text-slate-700">${escapeHtml(g.key)}</span>
              <span class="text-slate-500 tabular-nums">${escapeHtml(formatRupee(g.value, { decimals: 0 }))} · ${g.weight.toFixed(1)}% · ${g.count} ${g.count === 1 ? 'name' : 'names'}</span>
            </div>
            <div class="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" style="width:${Math.min(g.weight, 100).toFixed(2)}%"></div>
            </div>
            <div class="mt-1 text-[11px] text-slate-400">${escapeHtml(g.tickers.join(' · '))} · unrealised ${escapeHtml(formatPct(g.pnlPct))}</div>
          </div>`
          )
          .join('')}
      </div>
      <p class="mt-4 text-[11px] text-slate-400">Weights are of market value (${escapeHtml(formatRupee(total, { decimals: 0 }))}), not of cost.</p>
    </section>`;
}

// ---------------------------------------------------------------------------------------
// Realised P&L — every FIFO lot match, with its holding period and tax term.
// ---------------------------------------------------------------------------------------
function renderRealised(ctx) {
  const positions = portfolio.forScope(ctx.scope);
  const m = portfolio.meta();
  const s = portfolio.summary();
  const rows = positions.flatMap((p) => p.realisedRows);

  const stats = statStrip([
    { label: 'Realised P&L', value: `${s.realised > 0 ? '+' : ''}${formatRupee(s.realised, { decimals: 0 })}`, note: `${rows.length} lot matches across ${new Set(rows.map((r) => r.ticker)).size} tickers` },
    {
      label: 'Long term',
      value: formatRupee(s.realisedLong, { decimals: 0 }),
      note: `${rows.filter((r) => r.term === 'long').length} matches held over 365 days`,
      help: {
        title: 'Short vs long term',
        body: `<p>Listed Indian equity held for <strong>more than 12 months</strong> is long-term. The holding clock runs from the
                 <em>acquisition date of the specific lot consumed</em>, which is why FIFO matters: selling 20 shares when you hold
                 three lots is three different holding periods, not one.</p>
               <p class="mt-2">Bonus and split shares inherit the original lot's acquisition date, which is what adjusting lots in
                 place preserves. Creating a zero-price "buy" for bonus shares would reset that clock and misclassify the gain.</p>
               <p class="mt-3 text-slate-500">This is a holding-period classification, not a tax computation — no exemption,
                 indexation or set-off is applied.</p>`,
      },
    },
    { label: 'Short term', value: formatRupee(s.realisedShort, { decimals: 0 }), note: `${rows.filter((r) => r.term === 'short').length} matches held 365 days or less` },
    freshnessCard(m),
  ]);

  const table = scoreTable({
    rows,
    key: (r) => `${r.sellId}-${r.buyLotId}`,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · bought ${formatDate(r.buyDate)} · sold ${formatDate(r.sellDate)}`,
    columns: [
      { label: 'Qty', get: (r) => formatNumber(r.qty), align: 'right', sortValue: (r) => r.qty },
      { label: 'Buy', get: (r) => formatRupee(r.buyPrice), align: 'right', sortValue: (r) => r.buyPrice },
      { label: 'Sell', get: (r) => formatRupee(r.sellPrice), align: 'right', sortValue: (r) => r.sellPrice },
      { label: 'Cost', get: (r) => formatRupee(r.cost, { decimals: 0 }), align: 'right', sortValue: (r) => r.cost },
      { label: 'Proceeds', get: (r) => formatRupee(r.proceeds, { decimals: 0 }), align: 'right', sortValue: (r) => r.proceeds },
      { label: 'P&L', get: (r) => moneyCell(r.pnl), html: true, align: 'right', sortValue: (r) => r.pnl },
      { label: 'P&L %', get: (r) => pctCell(r.pnlPct), html: true, align: 'right', sortValue: (r) => r.pnlPct },
      { label: 'Held', get: (r) => `${formatNumber(r.heldDays)}d`, align: 'right', sortValue: (r) => r.heldDays },
      { label: 'Term', get: (r) => termPill(r.term), html: true, sortValue: (r) => r.term },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All matches' },
        { value: 'long', label: 'Long term only' },
        { value: 'short', label: 'Short term only' },
        { value: 'gains', label: 'Gains' },
        { value: 'losses', label: 'Losses' },
      ],
      match: (r, v) => (v === 'gains' ? r.pnl > 0 : v === 'losses' ? r.pnl < 0 : r.term === v),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.term}`,
    initialSort: { key: 'P&L', dir: 'desc' },
    exportName: 'sattva-realised',
    onExport: (visible) => exportRealised(visible, m),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Realised P&L',
      description: 'One row per FIFO lot match. A single sell that consumed three lots appears three times — that is the working, not a duplicate.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'lot matches' })),
    })}
    ${stats.html}
    ${rows.length ? table.html : '<div class="rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No sells in the ledger yet — nothing has been realised.</div>'}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  if (rows.length) disposers.push(table.wire(ctx.root));
}

// ---------------------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------------------
function drillPosition(row) {
  const s = portfolio.summary();
  const m = portfolio.meta();
  const lotRows = row.lots
    .map(
      (l) => `
      <tr class="border-t border-slate-100">
        <td class="py-1.5 pr-3 text-slate-600">${escapeHtml(formatDate(l.date))}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${formatNumber(l.openQty)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(l.costPerShare))}</td>
        <td class="py-1.5 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(l.openQty * l.costPerShare, { decimals: 0 }))}</td>
      </tr>`
    )
    .join('');

  const lotsPanel = row.lots.length
    ? `<div class="mb-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
         <div class="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">Open lots — FIFO, oldest first</div>
         <table class="w-full text-xs">
           <thead><tr class="text-left text-[11px] uppercase tracking-wide text-slate-400">
             <th scope="col" class="pb-1 pr-3 font-semibold">Acquired</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">Qty</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">Cost/share</th>
             <th scope="col" class="pb-1 text-right font-semibold">Cost</th>
           </tr></thead>
           <tbody>${lotRows}</tbody>
           <tfoot><tr class="border-t-2 border-slate-200 font-semibold text-slate-800">
             <td class="pt-1.5 pr-3">${row.lots.length} lot${row.lots.length === 1 ? '' : 's'}</td>
             <td class="pt-1.5 pr-3 text-right tabular-nums">${formatNumber(row.qty)}</td>
             <td class="pt-1.5 pr-3 text-right tabular-nums">${escapeHtml(formatRupee(row.avgPrice))}</td>
             <td class="pt-1.5 text-right tabular-nums">${escapeHtml(formatRupee(row.invested, { decimals: 0 }))}</td>
           </tr></tfoot>
         </table>
       </div>`
    : '';

  const unpricedNote = !row.priced && row.qty > 0
    ? `<div class="mb-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
         <strong>No live price for ${escapeHtml(row.ticker)}.</strong> It is absent from the technicals feed, so this position is
         marked <em>at cost</em> and its unrealised P&amp;L reads exactly zero — that zero means "not measured", not "flat".
         It is also excluded from the equity curve, where it is carried at running cost.
       </div>`
    : '';

  const actions = row.events.length
    ? `<div class="mb-4 rounded-xl bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-900 ring-1 ring-indigo-200">
         <strong>Corporate actions applied to the lots:</strong>
         ${row.events.map((e) => `${escapeHtml(String(e.kind))} ${e.ratio}× on ${escapeHtml(formatDate(e.date))} (${e.qtyBefore} → ${e.qtyAfter} shares)`).join(' · ')}.
         Quantities were multiplied and cost per share divided, so total cost and the acquisition date are unchanged.
       </div>`
    : '';

  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.convictionTier}${row.isClosed ? ' · fully exited' : ''}`,
    headerStats: [
      {
        label: 'Unrealised P&L',
        value: row.priced ? `${row.unrealised > 0 ? '+' : ''}${formatRupee(row.unrealised, { decimals: 0 })}` : '—',
        caption: row.priced ? formatPct(row.unrealisedPct) : 'no live price',
        tone: row.priced ? (row.unrealised > 0 ? 'positive' : row.unrealised < 0 ? 'negative' : 'neutral') : 'neutral',
      },
      { label: 'Market value', value: row.qty ? formatRupee(row.marketValue, { decimals: 0 }) : '—', caption: `${formatNumber(row.qty)} shares` },
    ],
    beforeGroupsHtml: `${unpricedNote}${actions}${lotsPanel}`,
    groups: [
      {
        category: 'Position',
        items: [
          { label: 'Quantity', status: null, value: formatNumber(row.qty), note: `Sum of ${row.lots.length} open FIFO lot${row.lots.length === 1 ? '' : 's'} — asserted equal in the verification suite.` },
          { label: 'Average cost', criteria: 'FIFO cost of open lots ÷ quantity', status: null, value: formatRupee(row.avgPrice), note: 'Buy-side charges are folded in, so this is what the shares actually cost.' },
          { label: 'Cost basis', status: null, value: formatRupee(row.invested, { decimals: 0 }), note: `Charges paid on this ticker: ${formatRupee(row.charges)}.` },
          {
            label: 'Last price',
            status: row.priced ? 'pass' : 'na',
            value: row.priced ? formatRupee(row.lastPrice) : 'unavailable',
            note: row.priced ? `Live \`cmp\` from technicals.json${m.pricedAt ? `, scraped ${formatDate(m.pricedAt)}` : ''}.` : 'Not in the technicals feed — marked at cost.',
          },
          {
            label: '52-week high',
            status: row.high52w ? null : 'na',
            value: row.high52w ? formatRupee(row.high52w) : '—',
            note: row.high52w && row.priced ? `Currently ${formatPct(((row.lastPrice - row.high52w) / row.high52w) * 100)} from peak.` : 'Not available for this ticker.',
          },
          { label: 'Weight', criteria: 'Market value ÷ portfolio market value', status: null, value: `${row.weight.toFixed(1)}%`, note: `Of ${formatRupee(s.marketValue, { decimals: 0 })} across ${s.positionCount} positions.` },
        ],
      },
      {
        category: 'Realised and income',
        items: [
          { label: 'Realised P&L', status: row.realised > 0 ? 'pass' : row.realised < 0 ? 'fail' : 'na', value: row.realised ? formatRupee(row.realised, { decimals: 0 }) : 'none', note: `${row.realisedRows.length} FIFO lot match${row.realisedRows.length === 1 ? '' : 'es'} · long ${formatRupee(row.realisedLong, { decimals: 0 })} / short ${formatRupee(row.realisedShort, { decimals: 0 })}.` },
          { label: 'Dividends', status: row.dividends > 0 ? 'pass' : 'na', value: row.dividends ? formatRupee(row.dividends, { decimals: 0 }) : 'none', note: 'Tracked as income; never folded into the cost basis, which would disguise it as a cheaper purchase.' },
          { label: 'Total P&L', criteria: 'Unrealised + realised + dividends', status: null, value: formatRupee(row.totalPnl, { decimals: 0 }), note: 'The identity the Overview reconciles against.' },
        ],
      },
      { category: 'Signal readings', items: HOLDING_SIGNALS(row).map((sg) => ({ label: sg.label, status: sg.status, value: '', note: 'Direct reading of the position — no model applied.' })) },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// Exports — the banner is row 1, because a workbook is the one artefact nobody sees a ribbon on.
// ---------------------------------------------------------------------------------------
async function exportPositions(rows, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: 'sattva-positions',
    sheetName: 'Positions',
    columns: [
      { header: 'Ticker', key: 'ticker', width: 14, get: (r) => (r.__banner ? r.__banner : r.ticker) },
      { header: 'Name', key: 'name', width: 30, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Sector', key: 'sector', width: 20, get: (r) => (r.__banner ? '' : r.sector) },
      { header: 'Conviction', key: 'tier', width: 16, get: (r) => (r.__banner ? '' : r.convictionTier) },
      { header: 'Qty', key: 'qty', width: 10, get: (r) => (r.__banner ? '' : r.qty) },
      { header: 'Avg Cost (FIFO, incl charges)', key: 'avg', width: 26, get: (r) => (r.__banner ? '' : r.avgPrice) },
      { header: 'Last Price', key: 'last', width: 14, get: (r) => (r.__banner ? '' : r.priced ? r.lastPrice : 'no live price — at cost') },
      { header: 'Market Value', key: 'mv', width: 16, get: (r) => (r.__banner ? '' : r.marketValue) },
      { header: 'Unrealised', key: 'unreal', width: 14, get: (r) => (r.__banner ? '' : r.priced ? r.unrealised : 'n/a') },
      { header: 'Unrealised %', key: 'unrealpct', width: 14, get: (r) => (r.__banner ? '' : r.unrealisedPct) },
      { header: 'Realised', key: 'real', width: 14, get: (r) => (r.__banner ? '' : r.realised) },
      { header: 'Dividends', key: 'div', width: 14, get: (r) => (r.__banner ? '' : r.dividends) },
      { header: 'Charges', key: 'chg', width: 12, get: (r) => (r.__banner ? '' : r.charges) },
      { header: 'Weight %', key: 'w', width: 12, get: (r) => (r.__banner ? '' : r.weight) },
    ],
    rows: [banner, ...rows],
  });
}

async function exportRealised(rows, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: 'sattva-realised',
    sheetName: 'Realised P&L',
    columns: [
      { header: 'Ticker', key: 'ticker', width: 14, get: (r) => (r.__banner ? r.__banner : r.ticker) },
      { header: 'Name', key: 'name', width: 30, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Buy Date', key: 'bd', width: 14, get: (r) => (r.__banner ? '' : r.buyDate) },
      { header: 'Sell Date', key: 'sd', width: 14, get: (r) => (r.__banner ? '' : r.sellDate) },
      { header: 'Qty', key: 'qty', width: 10, get: (r) => (r.__banner ? '' : r.qty) },
      { header: 'Buy Price', key: 'bp', width: 14, get: (r) => (r.__banner ? '' : r.buyPrice) },
      { header: 'Sell Price', key: 'sp', width: 14, get: (r) => (r.__banner ? '' : r.sellPrice) },
      { header: 'Cost', key: 'cost', width: 14, get: (r) => (r.__banner ? '' : r.cost) },
      { header: 'Proceeds', key: 'proc', width: 14, get: (r) => (r.__banner ? '' : r.proceeds) },
      { header: 'P&L', key: 'pnl', width: 14, get: (r) => (r.__banner ? '' : r.pnl) },
      { header: 'P&L %', key: 'pnlpct', width: 12, get: (r) => (r.__banner ? '' : r.pnlPct) },
      { header: 'Days Held', key: 'days', width: 12, get: (r) => (r.__banner ? '' : r.heldDays) },
      { header: 'Term', key: 'term', width: 12, get: (r) => (r.__banner ? '' : r.term) },
    ],
    rows: [banner, ...rows],
  });
}
