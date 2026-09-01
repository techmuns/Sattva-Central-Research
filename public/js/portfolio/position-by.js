// portfolio/position-by.js — the same positions, re-cut by sector, conviction, holding period
// and P&L band.
//
// One grouping engine, four keys. Every group carries the aggregate that grouping is actually
// about — a sector cut wants its weight, a holding-period cut wants the average age — rather
// than the same four columns relabelled.
//
// HOLDING PERIOD IS PER LOT, NOT PER POSITION. A position built over three years has lots in
// three different age bands, and calling the whole thing "long term" because the first buy was
// old would be wrong in exactly the way that matters for tax. So the holding-period cut groups
// LOTS, and its counts are lot counts — the panel says so.

import { statStrip, scoreTable, openDrill, sectionHead } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatRupee, formatPct, formatNumber, formatDate } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as portfolio from '../data/portfolio.js';
import { headMeta, wireProvenancePill, createLoader, moneyCell, pctCell, convictionPill, unpricedTag, freshnessCard, exportBanner, PNL_HELP } from './chrome.js';

export const meta = {
  id: 'position-by',
  title: 'Position By',
  subtitle: 'The same book re-cut by sector, conviction, holding period and P&L band.',
  subviews: [
    { id: 'sector', label: 'By Sector' },
    { id: 'conviction', label: 'By Conviction' },
    { id: 'holding-period', label: 'By Holding Period' },
    { id: 'pnl-band', label: 'By P&L Band' },
  ],
};

const LONG_TERM_DAYS = 365;

const run = createLoader(meta.title, meta.subtitle);
let disposers = [];

export function render(ctx) {
  run(ctx, paint, portfolio);
}

export function destroy() {
  disposers.forEach((d) => d && d());
  disposers = [];
}

// ---------------------------------------------------------------------------------------
// The four cuts. `unit: 'lot'` switches the engine from grouping positions to grouping the
// open lots inside them.
// ---------------------------------------------------------------------------------------
const CUTS = {
  sector: {
    label: 'Sector',
    title: 'By sector',
    unit: 'position',
    of: (r) => r.sector || 'Unclassified',
    blurb: 'Sector comes from the holdings config, falling back to the technicals feed.',
  },
  conviction: {
    label: 'Conviction tier',
    title: 'By conviction tier',
    unit: 'position',
    of: (r) => r.convictionTier || 'Tracking',
    order: ['Core', 'High Conviction', 'Tracking', 'Exited'],
    blurb: 'Conviction is a user-set label in portfolio.json — it is an input, not a derived score.',
  },
  'holding-period': {
    label: 'Holding period',
    title: 'By holding period',
    unit: 'lot',
    of: (lot) => {
      const days = lot.ageDays;
      if (days > 3 * LONG_TERM_DAYS) return 'Over 3 years';
      if (days > 2 * LONG_TERM_DAYS) return '2–3 years';
      if (days > LONG_TERM_DAYS) return '1–2 years (long term)';
      if (days > 180) return '6–12 months';
      return 'Under 6 months';
    },
    order: ['Over 3 years', '2–3 years', '1–2 years (long term)', '6–12 months', 'Under 6 months'],
    blurb:
      'Grouped by LOT, not by position. A holding built over three years sits in several bands at once, and the tax term follows the lot consumed — not the first purchase.',
  },
  'pnl-band': {
    label: 'P&L band',
    title: 'By P&L band',
    unit: 'position',
    of: (r) => {
      if (!r.priced) return 'Not marked';
      const p = r.unrealisedPct;
      if (p >= 50) return 'Up over 50%';
      if (p >= 20) return 'Up 20–50%';
      if (p >= 0) return 'Up 0–20%';
      if (p >= -20) return 'Down 0–20%';
      return 'Down over 20%';
    },
    order: ['Up over 50%', 'Up 20–50%', 'Up 0–20%', 'Down 0–20%', 'Down over 20%', 'Not marked'],
    blurb: 'Bands are on unrealised return. A position with no live price gets its own band rather than being counted as flat.',
  },
};

function paint(ctx) {
  destroy();
  const cutId = CUTS[ctx.subview] ? ctx.subview : 'sector';
  const cut = CUTS[cutId];
  const positions = portfolio.forScope(ctx.scope).filter((r) => r.qty > 0);
  const m = portfolio.meta();
  const s = portfolio.summary();

  const items = cut.unit === 'lot' ? lotRowsFor(positions, m) : positions;
  const groups = buildGroups(items, cut);
  const total = groups.reduce((acc, g) => acc + g.value, 0);

  // `groups` is in DECLARED order for the band cuts (so "up over 50%" sits above "down over
  // 20%"), which means groups[0] is the first band, not the biggest one. Pick the largest by
  // value explicitly — reading it off position 0 reported the wrong group on two of four cuts.
  const largest = groups.reduce((a, g) => (!a || g.value > a.value ? g : a), null);

  const stats = statStrip([
    { label: `Groups by ${cut.label.toLowerCase()}`, value: String(groups.length), note: `${items.length} ${cut.unit === 'lot' ? 'open lots' : 'positions'} grouped` },
    {
      label: 'Largest group',
      value: largest ? largest.key : '—',
      note: largest ? `${formatRupee(largest.value, { decimals: 0 })} · ${largest.weight.toFixed(1)}% of book` : '',
    },
    {
      label: 'Total P&L',
      value: `${s.totalPnl > 0 ? '+' : ''}${formatRupee(s.totalPnl, { decimals: 0 })}`,
      note: `${formatPct(s.totalPnlPct)} across the whole book`,
      help: PNL_HELP,
    },
    freshnessCard(m),
  ]);

  const table = scoreTable({
    rows: groups,
    key: (g) => g.key,
    name: (g) => g.key,
    nameLabel: cut.label,
    sub: (g) => `${g.count} ${cut.unit === 'lot' ? (g.count === 1 ? 'lot' : 'lots') : g.count === 1 ? 'position' : 'positions'} · ${g.tickers.join(' · ')}`,
    columns: [
      { label: 'Market Value', get: (g) => formatRupee(g.value, { decimals: 0 }), align: 'right', sortValue: (g) => g.value },
      { label: 'Weight', get: (g) => weightBar(g.weight), html: true, align: 'right', sortValue: (g) => g.weight },
      { label: 'Invested', get: (g) => formatRupee(g.invested, { decimals: 0 }), align: 'right', sortValue: (g) => g.invested },
      { label: 'Unrealised', get: (g) => moneyCell(g.unrealised), html: true, align: 'right', sortValue: (g) => g.unrealised },
      { label: 'Unreal %', get: (g) => pctCell(g.pnlPct), html: true, align: 'right', sortValue: (g) => g.pnlPct },
      ...(cut.unit === 'lot'
        ? [{ label: 'Avg age', get: (g) => `${formatNumber(g.avgAge)}d`, align: 'right', sortValue: (g) => g.avgAge }]
        : [
            { label: 'Realised', get: (g) => (g.realised ? moneyCell(g.realised) : '<span class="text-slate-400">—</span>'), html: true, align: 'right', sortValue: (g) => g.realised },
            { label: 'Dividends', get: (g) => (g.dividends ? formatRupee(g.dividends, { decimals: 0 }) : '—'), align: 'right', sortValue: (g) => g.dividends },
          ]),
    ],
    searchable: (g) => `${g.key} ${g.tickers.join(' ')}`,
    initialSort: { key: 'Market Value', dir: 'desc' },
    onRowClick: (g) => drillGroup(g, cut, total),
    exportName: `sattva-by-${cutId}`,
    onExport: (visible) => exportGroups(visible, cut, cutId, m),
    emptyMessage: 'No groups match your filters.',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: cut.title,
      description: cut.blurb,
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: groups.length, noun: 'groups' })),
    })}
    ${stats.html}
    ${stackedBar(groups, total)}
    ${table.html}
    ${detailTable(items, cut, ctx)}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  disposers.push(table.wire(ctx.root));
  wireDetail(ctx.root);
}

/**
 * Explode positions into their open lots, each carrying its own age. This is the only place the
 * lot's acquisition date reaches the UI as a first-class row.
 */
function lotRowsFor(positions, m) {
  const asOf = m?.asOf ? new Date(`${m.asOf}T00:00:00Z`) : new Date();
  const out = [];
  for (const p of positions) {
    for (const lot of p.lots) {
      const ageDays = Math.round((asOf - new Date(`${lot.date}T00:00:00Z`)) / 86400000);
      const invested = lot.openQty * lot.costPerShare;
      const value = p.priced ? lot.openQty * p.lastPrice : invested;
      out.push({
        ticker: p.ticker,
        name: p.name,
        sector: p.sector,
        convictionTier: p.convictionTier,
        priced: p.priced,
        lastPrice: p.lastPrice,
        acquired: lot.date,
        ageDays,
        qty: lot.openQty,
        costPerShare: lot.costPerShare,
        invested,
        marketValue: value,
        unrealised: p.priced ? value - invested : 0,
        unrealisedPct: p.priced && invested ? ((value - invested) / invested) * 100 : null,
        term: ageDays > LONG_TERM_DAYS ? 'long' : 'short',
        realised: 0,
        dividends: 0,
      });
    }
  }
  return out;
}

function buildGroups(items, cut) {
  const map = new Map();
  for (const item of items) {
    const k = cut.of(item);
    const g = map.get(k) || { key: k, value: 0, invested: 0, unrealised: 0, realised: 0, dividends: 0, count: 0, tickers: [], ageSum: 0, items: [] };
    g.value += item.marketValue;
    g.invested += item.invested;
    g.unrealised += item.unrealised;
    g.realised += item.realised || 0;
    g.dividends += item.dividends || 0;
    g.ageSum += item.ageDays || 0;
    g.count += 1;
    if (!g.tickers.includes(item.ticker)) g.tickers.push(item.ticker);
    g.items.push(item);
    map.set(k, g);
  }
  const total = [...map.values()].reduce((s, g) => s + g.value, 0);
  const groups = [...map.values()].map((g) => ({
    ...g,
    weight: total ? (g.value / total) * 100 : 0,
    pnlPct: g.invested ? (g.unrealised / g.invested) * 100 : 0,
    avgAge: g.count ? Math.round(g.ageSum / g.count) : 0,
  }));
  // A declared order keeps a band cut reading top-to-bottom in its natural sequence rather than
  // by size — "up over 50%" above "down over 20%" is the ordering the reader expects.
  if (cut.order) {
    const rank = new Map(cut.order.map((k, i) => [k, i]));
    groups.sort((a, b) => (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99) || b.value - a.value);
  } else {
    groups.sort((a, b) => b.value - a.value);
  }
  return groups;
}

function weightBar(pct) {
  return `
    <span class="inline-flex items-center justify-end gap-2">
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}

const BAR_SHADES = ['bg-indigo-500', 'bg-indigo-400', 'bg-purple-500', 'bg-purple-400', 'bg-fuchsia-400', 'bg-pink-400', 'bg-pink-300', 'bg-slate-300'];

function stackedBar(groups, total) {
  if (!groups.length || !total) return '';
  return `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="flex h-4 w-full overflow-hidden rounded-full bg-slate-100">
        ${groups
          .map((g, i) => `<span class="${BAR_SHADES[i % BAR_SHADES.length]}" style="width:${g.weight.toFixed(2)}%" title="${escapeHtml(g.key)} — ${g.weight.toFixed(1)}%"></span>`)
          .join('')}
      </div>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        ${groups
          .map(
            (g, i) => `<span class="inline-flex items-center gap-1.5 text-slate-500">
              <span class="h-2 w-2 rounded-full ${BAR_SHADES[i % BAR_SHADES.length]}"></span>
              <strong class="text-slate-700">${escapeHtml(g.key)}</strong> ${g.weight.toFixed(1)}%</span>`
          )
          .join('')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------------------
// The per-item table under the groups — collapsed by default so the group cut stays the point.
// ---------------------------------------------------------------------------------------
function detailTable(items, cut, ctx) {
  const isLot = cut.unit === 'lot';
  const rows = items
    .slice()
    .sort((a, b) => b.marketValue - a.marketValue)
    .map(
      (i) => `
      <tr class="border-t border-slate-100 hover:bg-slate-50/60">
        <td class="py-2 pr-3">
          <div class="font-semibold text-slate-800">${escapeHtml(i.name)}</div>
          <div class="text-[11px] text-slate-400">${escapeHtml(i.ticker)} · ${escapeHtml(cut.of(i))}</div>
        </td>
        ${isLot ? `<td class="py-2 pr-3 text-slate-600">${escapeHtml(formatDate(i.acquired))}</td><td class="py-2 pr-3 text-right tabular-nums text-slate-600">${formatNumber(i.ageDays)}d</td>` : ''}
        <td class="py-2 pr-3 text-right tabular-nums text-slate-700">${formatNumber(i.qty)}</td>
        <td class="py-2 pr-3 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(isLot ? i.costPerShare : i.avgPrice))}</td>
        <td class="py-2 pr-3 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(i.marketValue, { decimals: 0 }))}${i.priced ? '' : unpricedTag()}</td>
        <td class="py-2 pr-3 text-right tabular-nums">${i.priced ? moneyCell(i.unrealised) : '<span class="text-slate-400">—</span>'}</td>
        <td class="py-2 text-right tabular-nums">${pctCell(i.unrealisedPct)}</td>
      </tr>`
    )
    .join('');

  return `
    <section class="mb-6 rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
      <button type="button" id="detail-toggle" aria-expanded="false" aria-controls="detail-body"
        class="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50/60">
        <span>
          <span class="font-display block text-sm font-bold text-slate-900">Every ${isLot ? 'open lot' : 'position'} in this cut</span>
          <span class="block text-xs text-slate-500">${items.length} row${items.length === 1 ? '' : 's'}, ungrouped — the working behind the totals above.</span>
        </span>
        <svg id="detail-chevron" class="h-4 w-4 flex-shrink-0 text-slate-400 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
      </button>
      <div id="detail-body" hidden class="scrollbar-thin overflow-x-auto border-t border-slate-100 px-5 pb-4">
        <table class="w-full min-w-[720px] text-xs">
          <thead><tr class="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th scope="col" class="py-2 pr-3 font-semibold">${isLot ? 'Lot' : 'Position'}</th>
            ${isLot ? '<th scope="col" class="py-2 pr-3 font-semibold">Acquired</th><th scope="col" class="py-2 pr-3 text-right font-semibold">Age</th>' : ''}
            <th scope="col" class="py-2 pr-3 text-right font-semibold">Qty</th>
            <th scope="col" class="py-2 pr-3 text-right font-semibold">${isLot ? 'Cost/share' : 'Avg cost'}</th>
            <th scope="col" class="py-2 pr-3 text-right font-semibold">Market value</th>
            <th scope="col" class="py-2 pr-3 text-right font-semibold">Unrealised</th>
            <th scope="col" class="py-2 text-right font-semibold">Unreal %</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function wireDetail(root) {
  const btn = root.querySelector('#detail-toggle');
  const body = root.querySelector('#detail-body');
  const chev = root.querySelector('#detail-chevron');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const open = !body.hidden;
    body.hidden = open;
    btn.setAttribute('aria-expanded', String(!open));
    chev?.classList.toggle('rotate-180', !open);
  });
}

// ---------------------------------------------------------------------------------------
function drillGroup(group, cut, total) {
  const isLot = cut.unit === 'lot';
  const rows = group.items
    .slice()
    .sort((a, b) => b.marketValue - a.marketValue)
    .map(
      (i) => `
      <tr class="border-t border-slate-100">
        <td class="py-1.5 pr-3">
          <span class="font-semibold text-slate-700">${escapeHtml(i.ticker)}</span>
          ${isLot ? `<span class="ml-1 text-[11px] text-slate-400">${escapeHtml(formatDate(i.acquired))}</span>` : ''}
        </td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-600">${formatNumber(i.qty)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-600">${escapeHtml(formatRupee(i.marketValue, { decimals: 0 }))}</td>
        <td class="py-1.5 text-right tabular-nums">${pctCell(i.unrealisedPct)}</td>
      </tr>`
    )
    .join('');

  openDrill({
    name: group.key,
    sub: `${cut.label} · ${group.count} ${isLot ? (group.count === 1 ? 'lot' : 'lots') : group.count === 1 ? 'position' : 'positions'}`,
    headerStats: [
      { label: 'Market value', value: formatRupee(group.value, { decimals: 0 }), caption: `${group.weight.toFixed(1)}% of ${formatRupee(total, { decimals: 0 })}` },
      {
        label: 'Unrealised P&L',
        value: `${group.unrealised > 0 ? '+' : ''}${formatRupee(group.unrealised, { decimals: 0 })}`,
        caption: formatPct(group.pnlPct),
        tone: group.unrealised > 0 ? 'positive' : group.unrealised < 0 ? 'negative' : 'neutral',
      },
    ],
    beforeGroupsHtml: `
      <div class="mb-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <div class="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">${isLot ? 'Lots' : 'Positions'} in this group</div>
        <table class="w-full text-xs">
          <thead><tr class="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th scope="col" class="pb-1 pr-3 font-semibold">${isLot ? 'Ticker · acquired' : 'Ticker'}</th>
            <th scope="col" class="pb-1 pr-3 text-right font-semibold">Qty</th>
            <th scope="col" class="pb-1 pr-3 text-right font-semibold">Value</th>
            <th scope="col" class="pb-1 text-right font-semibold">Unreal %</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
    groups: [
      {
        category: 'Group aggregates',
        items: [
          { label: 'Market value', status: null, value: formatRupee(group.value, { decimals: 0 }), note: `${group.weight.toFixed(1)}% of the grouped total.` },
          { label: 'Cost basis', status: null, value: formatRupee(group.invested, { decimals: 0 }), note: 'FIFO cost of the open lots in this group, charges included.' },
          { label: 'Unrealised P&L', status: group.unrealised > 0 ? 'pass' : group.unrealised < 0 ? 'fail' : 'na', value: formatRupee(group.unrealised, { decimals: 0 }), note: `${formatPct(group.pnlPct)} on cost.` },
          ...(isLot
            ? [{ label: 'Average age', status: null, value: `${formatNumber(group.avgAge)} days`, note: `Long term above ${LONG_TERM_DAYS} days. Age runs from each lot's own acquisition date.` }]
            : [
                { label: 'Realised P&L', status: group.realised > 0 ? 'pass' : group.realised < 0 ? 'fail' : 'na', value: group.realised ? formatRupee(group.realised, { decimals: 0 }) : 'none', note: 'From FIFO lot matches on these tickers.' },
                { label: 'Dividends', status: group.dividends > 0 ? 'pass' : 'na', value: group.dividends ? formatRupee(group.dividends, { decimals: 0 }) : 'none', note: 'Income, tracked outside the cost basis.' },
              ]),
        ],
      },
      {
        category: 'How this group was formed',
        items: [{ label: cut.label, criteria: cut.blurb, status: null, value: group.key, note: `${group.tickers.length} ticker${group.tickers.length === 1 ? '' : 's'}: ${group.tickers.join(', ')}.` }],
      },
    ],
  });
}

async function exportGroups(groups, cut, cutId, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: `sattva-by-${cutId}`,
    sheetName: cut.label,
    columns: [
      { header: cut.label, key: 'k', width: 26, get: (g) => (g.__banner ? g.__banner : g.key) },
      { header: cut.unit === 'lot' ? 'Lots' : 'Positions', key: 'n', width: 12, get: (g) => (g.__banner ? '' : g.count) },
      { header: 'Tickers', key: 't', width: 40, get: (g) => (g.__banner ? '' : g.tickers.join(', ')) },
      { header: 'Market Value', key: 'mv', width: 16, get: (g) => (g.__banner ? '' : g.value) },
      { header: 'Weight %', key: 'w', width: 12, get: (g) => (g.__banner ? '' : g.weight) },
      { header: 'Invested', key: 'inv', width: 16, get: (g) => (g.__banner ? '' : g.invested) },
      { header: 'Unrealised', key: 'un', width: 14, get: (g) => (g.__banner ? '' : g.unrealised) },
      { header: 'Unrealised %', key: 'unp', width: 14, get: (g) => (g.__banner ? '' : g.pnlPct) },
      { header: cut.unit === 'lot' ? 'Avg age (days)' : 'Realised', key: 'x', width: 16, get: (g) => (g.__banner ? '' : cut.unit === 'lot' ? g.avgAge : g.realised) },
    ],
    rows: [banner, ...groups],
  });
}
