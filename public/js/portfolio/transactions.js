// portfolio/transactions.js — the ledger, the FIFO working behind every sell, and CSV import.
//
// Three sub-views over one ledger: the full trade blotter, the dividend and corporate-action
// register, and the CSV import/export round trip.
//
// A SELL ROW EXPANDS TO SHOW WHICH LOTS IT ATE. That expansion is the whole reason this view
// exists rather than being a static table: "sold 40 PERSISTENT for a ₹63,000 gain" is a summary
// of three separate matches with three different buy dates and two different tax terms, and the
// summary is the part you cannot check.
//
// IMPORT IS PREVIEW-THEN-APPLY, AND APPLY IS SESSION-ONLY. Parsing a CSV in the browser cannot
// write to public/data/mock/transactions.json — there is no server to write it. Pretending
// otherwise would be the worst kind of dishonest UI: the user imports, sees the numbers move,
// reloads, and the work is gone with no warning. So the panel says plainly that an applied
// import lives until reload, shows exactly what it parsed and what it rejected, and offers the
// merged CSV back so the change can be committed to the repo.

import { statStrip, scoreTable, openDrill, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatRupee, formatNumber, formatDate, formatPct } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as portfolio from '../data/portfolio.js';
import { replay } from './lots.js';
import { headMeta, wireProvenancePill, createLoader, moneyCell, pctCell, termPill, freshnessCard, exportBanner } from './chrome.js';

export const meta = {
  id: 'transactions',
  title: 'Transaction History',
  subtitle: 'The ledger, with the FIFO lot matching behind every sell.',
  subviews: [
    { id: 'trades', label: 'Trades' },
    { id: 'income', label: 'Dividends & Actions' },
    { id: 'import', label: 'Import / Export' },
  ],
};

const TYPE_TONE = {
  buy: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  sell: 'bg-pink-50 text-pink-700 ring-pink-200',
  dividend: 'bg-sky-50 text-sky-700 ring-sky-200',
  bonus: 'bg-violet-50 text-violet-700 ring-violet-200',
  split: 'bg-violet-50 text-violet-700 ring-violet-200',
};

const run = createLoader(meta.title, meta.subtitle);
let disposers = [];

// An applied import lives here for the life of the page. Deliberately module-level and
// deliberately not persisted: see the header.
let sessionRows = null;

export function render(ctx) {
  run(ctx, paint, portfolio);
}

export function destroy() {
  disposers.forEach((d) => d && d());
  disposers = [];
}

function ledger() {
  return sessionRows || portfolio.transactions();
}

function currentBook() {
  return sessionRows ? replay(sessionRows) : portfolio.book();
}

function paint(ctx) {
  destroy();
  const view = ctx.subview || 'trades';
  if (view === 'income') return renderIncome(ctx);
  if (view === 'import') return renderImport(ctx);
  return renderTrades(ctx);
}

function scopedRows(ctx, rows) {
  if (ctx.scope !== 'portfolio') return rows;
  // Portfolio scope = tickers currently held. The wider scope keeps the trades of positions
  // already exited, which is where a closed position's history belongs.
  const held = new Set(portfolio.positions().filter((p) => p.qty > 0).map((p) => p.ticker));
  return rows.filter((r) => held.has(String(r.ticker).toUpperCase()));
}

function typePill(type) {
  const t = String(type).toLowerCase();
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${TYPE_TONE[t] || 'bg-slate-100 text-slate-600 ring-slate-200'}">${escapeHtml(type)}</span>`;
}

function statsFor(rows, m) {
  const buys = rows.filter((r) => String(r.type).toLowerCase() === 'buy');
  const sells = rows.filter((r) => String(r.type).toLowerCase() === 'sell');
  const charges = rows.reduce((s, r) => s + (Number(r.charges) || 0), 0);
  return statStrip([
    { label: 'Transactions', value: String(rows.length), note: `${buys.length} buys · ${sells.length} sells · ${rows.length - buys.length - sells.length} other` },
    { label: 'Bought', value: formatRupee(buys.reduce((s, r) => s + r.value, 0), { decimals: 0 }), note: `across ${new Set(buys.map((r) => r.ticker)).size} tickers` },
    {
      label: 'Charges paid',
      value: formatRupee(charges, { decimals: 0 }),
      note: 'STT, exchange, GST, SEBI, stamp, DP',
      help: {
        title: 'What the charges column contains',
        body: `<p>The real Indian delivery-equity rate card, computed per trade: <strong>STT</strong> 0.1% both sides,
                 <strong>exchange transaction</strong> 0.00297%, <strong>SEBI</strong> 0.0001%, <strong>stamp duty</strong> 0.015%
                 on buys only, <strong>DP charge</strong> ₹15.93 on sells, and <strong>GST</strong> at 18% on the transaction,
                 SEBI and DP components.</p>
               <p class="mt-2">Brokerage is zero — this assumes a discount broker's free delivery. Add it to the generator if the
                 real broker charges it.</p>
               <p class="mt-2">Buy-side charges are <strong>folded into the cost basis</strong> rather than shown as a separate loss,
                 because that is what the shares actually cost. Sell-side charges reduce proceeds and are apportioned across the lots
                 the sell consumed.</p>`,
      },
    },
    freshnessCard(m),
  ]);
}

// ---------------------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------------------
function renderTrades(ctx) {
  const m = portfolio.meta();
  const book = currentBook();
  const rows = scopedRows(
    ctx,
    ledger().filter((r) => ['buy', 'sell'].includes(String(r.type).toLowerCase()))
  ).slice().reverse();
  const stats = statsFor(rows, m);

  const table = scoreTable({
    rows,
    key: (r) => r.id,
    name: (r) => r.name,
    nameLabel: 'Trade',
    sub: (r) => `${r.ticker} · ${formatDate(r.date)} · ${r.id}`,
    columns: [
      { label: 'Date', get: (r) => formatDate(r.date), sortValue: (r) => r.date },
      { label: 'Type', get: (r) => typePill(r.type), html: true, sortValue: (r) => r.type },
      { label: 'Qty', get: (r) => formatNumber(r.qty), align: 'right', sortValue: (r) => r.qty },
      { label: 'Price', get: (r) => formatRupee(r.price), align: 'right', sortValue: (r) => r.price },
      { label: 'Value', get: (r) => formatRupee(r.value, { decimals: 0 }), align: 'right', sortValue: (r) => r.value },
      { label: 'Charges', get: (r) => formatRupee(r.charges || 0), align: 'right', sortValue: (r) => r.charges || 0 },
      {
        label: 'Realised',
        get: (r) => {
          const matches = book.realised.filter((x) => x.sellId === r.id);
          if (!matches.length) return '<span class="text-slate-400">—</span>';
          const pnl = matches.reduce((s, x) => s + x.pnl, 0);
          return `${moneyCell(pnl)}<span class="ml-1 text-[11px] text-slate-400">${matches.length} lot${matches.length === 1 ? '' : 's'}</span>`;
        },
        html: true,
        align: 'right',
        sortValue: (r) => book.realised.filter((x) => x.sellId === r.id).reduce((s, x) => s + x.pnl, 0),
      },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All trades' },
        { value: 'Buy', label: 'Buys only' },
        { value: 'Sell', label: 'Sells only' },
        ...financialYearOptions(rows),
      ],
      match: (r, v) => (v.startsWith('fy') ? financialYear(r.date) === v : String(r.type) === v),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.type} ${r.date} ${r.id}`,
    initialSort: { key: 'Date', dir: 'desc' },
    onRowClick: (r) => drillTrade(r, book),
    exportName: 'sattva-transactions',
    onExport: (visible) => exportTrades(visible, book, m),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Trades',
      description: 'Every buy and sell. Click a sell to see exactly which lots it consumed — that is the FIFO working, not a summary of it.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'trades' })),
    })}
    ${sessionBanner()}
    ${stats.html}
    ${table.html}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  disposers.push(table.wire(ctx.root));
}

/**
 * The financial years actually present in the ledger, newest first.
 *
 * This list used to be typed out — FY27, FY26, FY25, FY24, with FY24 labelled "(–Mar 2024)" as
 * though it were the beginning of time. Both halves of that go stale: a trade in FY28 would have
 * had no filter to find it, and the open-ended label would still be claiming FY24 was the
 * earliest year on file long after it was not. A filter whose options are a snapshot of the data
 * at the moment somebody wrote it silently stops offering the data added since.
 */
function financialYearOptions(rows) {
  const years = [...new Set(rows.map((r) => financialYear(r.date)).filter((v) => /^fy\d\d$/.test(v)))];
  years.sort().reverse();
  return years.map((value) => {
    const end = 2000 + Number(value.slice(2));
    return { value, label: `FY${value.slice(2)} (Apr ${end - 1}–Mar ${end})` };
  });
}

function financialYear(date) {
  const [y, mth] = String(date).split('-').map(Number);
  const fy = mth >= 4 ? y + 1 : y;
  return `fy${String(fy).slice(2)}`;
}

function sessionBanner() {
  if (!sessionRows) return '';
  return `
    <div class="mb-5 rounded-2xl bg-sky-50 p-4 text-xs leading-relaxed text-sky-900 ring-1 ring-sky-200">
      <strong>Showing an imported ledger (${sessionRows.length} rows).</strong> This lives in memory only —
      there is no server to write <code class="rounded bg-sky-100 px-1">public/data/mock/transactions.json</code>, so a reload
      restores the committed ledger. Download the merged CSV from Import / Export to keep it.
    </div>`;
}

function drillTrade(row, book) {
  const isSell = String(row.type).toLowerCase() === 'sell';
  const matches = book.realised.filter((r) => r.sellId === row.id);
  const pnl = matches.reduce((s, r) => s + r.pnl, 0);

  const working = matches.length
    ? `<div class="mb-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
         <div class="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">Lots consumed — oldest first</div>
         <table class="w-full text-xs">
           <thead><tr class="text-left text-[11px] uppercase tracking-wide text-slate-400">
             <th scope="col" class="pb-1 pr-3 font-semibold">Acquired</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">Qty</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">Cost</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">P&amp;L</th>
             <th scope="col" class="pb-1 pr-3 text-right font-semibold">Held</th>
             <th scope="col" class="pb-1 font-semibold">Term</th>
           </tr></thead>
           <tbody>
             ${matches
               .map(
                 (r) => `<tr class="border-t border-slate-100">
                   <td class="py-1.5 pr-3 text-slate-600">${escapeHtml(formatDate(r.buyDate))}</td>
                   <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${formatNumber(r.qty)}</td>
                   <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(r.buyPrice))}</td>
                   <td class="py-1.5 pr-3 text-right tabular-nums">${moneyCell(r.pnl)}</td>
                   <td class="py-1.5 pr-3 text-right tabular-nums text-slate-600">${formatNumber(r.heldDays)}d</td>
                   <td class="py-1.5">${termPill(r.term)}</td>
                 </tr>`
               )
               .join('')}
           </tbody>
           <tfoot><tr class="border-t-2 border-slate-200 font-semibold text-slate-800">
             <td class="pt-1.5 pr-3">${matches.length} match${matches.length === 1 ? '' : 'es'}</td>
             <td class="pt-1.5 pr-3 text-right tabular-nums">${formatNumber(matches.reduce((s, r) => s + r.qty, 0))}</td>
             <td class="pt-1.5 pr-3"></td>
             <td class="pt-1.5 pr-3 text-right tabular-nums">${moneyCell(pnl)}</td>
             <td class="pt-1.5 pr-3"></td><td class="pt-1.5"></td>
           </tr></tfoot>
         </table>
         <p class="mt-2 text-[11px] leading-relaxed text-slate-500">
           Sell charges of ${escapeHtml(formatRupee(row.charges || 0))} were apportioned across these lots by quantity, so each
           match's proceeds are net.
         </p>
       </div>`
    : isSell
      ? '<div class="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">No lot matches recorded for this sell — the replay rejected it. Check <code class="rounded bg-amber-100 px-1">book.errors</code>.</div>'
      : '';

  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.type} · ${formatDate(row.date)} · ${row.id}`,
    headerStats: [
      { label: 'Trade value', value: formatRupee(row.value, { decimals: 0 }), caption: `${formatNumber(row.qty)} × ${formatRupee(row.price)}` },
      isSell
        ? { label: 'Realised P&L', value: `${pnl > 0 ? '+' : ''}${formatRupee(pnl, { decimals: 0 })}`, caption: `${matches.length} lot match${matches.length === 1 ? '' : 'es'}`, tone: pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral' }
        : { label: 'Charges', value: formatRupee(row.charges || 0), caption: 'folded into cost basis' },
    ],
    beforeGroupsHtml: working,
    groups: [
      {
        category: 'Trade',
        items: [
          { label: 'Date', status: null, value: formatDate(row.date), note: `Financial year ${financialYear(row.date).toUpperCase().replace('FY', 'FY ')}.` },
          { label: 'Quantity', status: null, value: formatNumber(row.qty), note: '' },
          { label: 'Price', status: null, value: formatRupee(row.price), note: 'A real Yahoo close for this ticker on this trading day, plus a few basis points of slippage.' },
          { label: 'Value', criteria: 'Quantity × price', status: null, value: formatRupee(row.value, { decimals: 0 }), note: 'Excludes charges — those are the next line.' },
          { label: 'Charges', status: null, value: formatRupee(row.charges || 0), note: isSell ? 'Reduces proceeds, apportioned across the lots consumed.' : 'Added to the cost basis, so the average cost is what the shares really cost.' },
        ],
      },
      {
        category: 'Provenance',
        items: [
          { label: 'Which trade this is', status: 'na', value: 'illustrative', note: 'The decision to buy or sell here is synthetic — see scripts/gen-mock-transactions.mjs.' },
          { label: 'The price on it', status: 'pass', value: 'real', note: 'An actual Yahoo closing price for this ticker on this date, from portfolio-history.json.' },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// Dividends & corporate actions
// ---------------------------------------------------------------------------------------
function renderIncome(ctx) {
  const m = portfolio.meta();
  const rows = scopedRows(
    ctx,
    ledger().filter((r) => ['dividend', 'bonus', 'split'].includes(String(r.type).toLowerCase()))
  ).slice().reverse();
  const dividends = rows.filter((r) => String(r.type).toLowerCase() === 'dividend');
  const actions = rows.filter((r) => String(r.type).toLowerCase() !== 'dividend');
  const total = dividends.reduce((s, r) => s + r.value, 0);
  const s = portfolio.summary();

  const stats = statStrip([
    { label: 'Dividends received', value: formatRupee(total, { decimals: 0 }), note: `${dividends.length} payouts across ${new Set(dividends.map((r) => r.ticker)).size} tickers` },
    {
      label: 'Yield on cost',
      value: s.invested ? formatPct((total / s.invested) * 100, { signed: false }) : '—',
      note: 'cumulative income ÷ current cost basis',
      help: {
        title: 'Why dividends are not netted off the cost',
        body: `<p>A ₹19 dividend on a ₹1,681 purchase is <strong>income</strong>, not a retroactive discount on the purchase price.
                 Folding it into the basis would quietly improve the average cost and make the position look like a better entry
                 than it was.</p>
               <p class="mt-2">So dividends are tracked on their own line, and total P&amp;L adds them back explicitly:
                 <code class="rounded bg-slate-100 px-1">unrealised + realised + dividends</code>.</p>
               <p class="mt-3 text-slate-500">This figure is cumulative income over the <em>current</em> cost basis, not an annual
                 yield — the denominator has changed as the position was built.</p>`,
      },
    },
    { label: 'Corporate actions', value: String(actions.length), note: actions.length ? actions.map((a) => `${a.ticker} ${a.type.toLowerCase()}`).join(' · ') : 'none in this ledger' },
    freshnessCard(m),
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.id,
    name: (r) => r.name,
    nameLabel: 'Event',
    sub: (r) => `${r.ticker} · ${formatDate(r.date)}`,
    columns: [
      { label: 'Date', get: (r) => formatDate(r.date), sortValue: (r) => r.date },
      { label: 'Type', get: (r) => typePill(r.type), html: true, sortValue: (r) => r.type },
      { label: 'Shares', get: (r) => formatNumber(r.qty), align: 'right', sortValue: (r) => r.qty },
      {
        label: 'Per share',
        get: (r) => (String(r.type).toLowerCase() === 'dividend' ? formatRupee(r.price) : `${r.ratio}× ratio`),
        align: 'right',
        sortValue: (r) => r.price,
      },
      { label: 'Amount', get: (r) => (r.value ? formatRupee(r.value, { decimals: 0 }) : '<span class="text-slate-400">—</span>'), html: true, align: 'right', sortValue: (r) => r.value },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All events' },
        { value: 'Dividend', label: 'Dividends only' },
        { value: 'actions', label: 'Corporate actions only' },
      ],
      match: (r, v) => (v === 'actions' ? String(r.type).toLowerCase() !== 'dividend' : String(r.type) === v),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.type}`,
    initialSort: { key: 'Date', dir: 'desc' },
    exportName: 'sattva-income',
    onExport: (visible) => exportIncome(visible, m),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Dividends & corporate actions',
      description: 'Income and share-count changes. Neither touches the cost basis the way a trade does, and the reasons differ.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'events' })),
    })}
    ${sessionBanner()}
    ${stats.html}
    ${actionsPanel(actions)}
    ${rows.length ? table.html : '<div class="rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No dividends or corporate actions in scope.</div>'}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  if (rows.length) disposers.push(table.wire(ctx.root));
}

function actionsPanel(actions) {
  if (!actions.length) return '';
  const book = currentBook();
  return `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-sm font-bold text-slate-900">How corporate actions were applied</h3>
      <p class="mt-1 text-xs leading-relaxed text-slate-500">
        A bonus or split <strong>adjusts the open lots in place</strong> — quantity multiplied, cost per share divided, total cost
        unchanged. It does <em>not</em> create a zero-price buy, which would reset the holding-period clock and misclassify a later
        sale as short term when the shares are legally long term.
      </p>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        ${actions
          .map((a) => {
            const ev = book.events.find((e) => e.id === a.id);
            return `
            <div class="rounded-xl bg-violet-50 p-3 ring-1 ring-violet-200">
              <div class="text-sm font-bold text-violet-900">${escapeHtml(a.ticker)} · ${escapeHtml(a.type)} ${a.ratio}×</div>
              <div class="mt-0.5 text-xs text-violet-800">${escapeHtml(formatDate(a.date))}</div>
              <div class="mt-1.5 text-xs text-violet-900/80">
                ${ev ? `${formatNumber(ev.qtyBefore)} → ${formatNumber(ev.qtyAfter)} shares across ${ev.lotsAdjusted} lot${ev.lotsAdjusted === 1 ? '' : 's'}.` : 'No open lots at the time.'}
                Acquisition dates preserved.
              </div>
            </div>`;
          })
          .join('')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------------------
const CSV_COLUMNS = ['id', 'date', 'ticker', 'name', 'type', 'qty', 'price', 'value', 'charges', 'ratio'];

function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
}

/**
 * Parse a CSV back into ledger rows. Returns `{ rows, errors, skipped }` — a row that cannot be
 * parsed is reported with its line number and its reason, never dropped quietly. An import that
 * silently ignores a fifth of a file is worse than one that fails.
 */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: [{ line: 0, reason: 'file is empty' }], header: [] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const required = ['date', 'ticker', 'type', 'qty', 'price'];
  const missing = required.filter((r) => !header.includes(r));
  if (missing.length) return { rows: [], errors: [{ line: 1, reason: `missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` }], header };

  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rec = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').trim()]));
    const type = rec.type;
    const qty = Number(rec.qty);
    const price = Number(rec.price);

    if (!isRealDate(rec.date)) {
      errors.push({ line: i + 1, reason: `date "${rec.date}" is not a valid YYYY-MM-DD date`, raw: lines[i] });
      continue;
    }
    if (!rec.ticker) {
      errors.push({ line: i + 1, reason: 'no ticker', raw: lines[i] });
      continue;
    }
    if (!['buy', 'sell', 'dividend', 'bonus', 'split'].includes(String(type).toLowerCase())) {
      errors.push({ line: i + 1, reason: `unknown type "${type}"`, raw: lines[i] });
      continue;
    }
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push({ line: i + 1, reason: `quantity "${rec.qty}" is not a non-negative number`, raw: lines[i] });
      continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ line: i + 1, reason: `price "${rec.price}" is not a non-negative number`, raw: lines[i] });
      continue;
    }

    const value = rec.value !== '' && Number.isFinite(Number(rec.value)) ? Number(rec.value) : Math.round(qty * price * 100) / 100;
    rows.push({
      id: rec.id || `imp-${String(i).padStart(3, '0')}`,
      date: rec.date,
      ticker: rec.ticker.toUpperCase(),
      name: rec.name || rec.ticker.toUpperCase(),
      type: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase(),
      qty,
      price,
      value,
      charges: Number(rec.charges) || 0,
      ...(rec.ratio ? { ratio: Number(rec.ratio) } : {}),
    });
  }
  return { rows, errors, header };
}

/**
 * A real calendar date, not merely a date-shaped string. `2024-13-45` matches the shape and is
 * not a date; `2024-02-31` matches the shape, is not a date, and JavaScript will happily roll it
 * forward to 2 March without complaint. Round-tripping through ISO catches both, and catching
 * them here is what stops a typo becoming a silently mis-dated lot.
 */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

let pending = null; // parsed-but-not-applied import

function renderImport(ctx) {
  const m = portfolio.meta();
  const rows = ledger();
  const book = currentBook();

  const stats = statStrip([
    { label: 'Ledger rows', value: formatNumber(rows.length), note: `${new Set(rows.map((r) => r.ticker)).size} tickers · ${formatDate(rows[0]?.date)} → ${formatDate(rows.at(-1)?.date)}` },
    {
      label: 'Replays cleanly',
      value: book.errors.length ? `${book.errors.length} error${book.errors.length === 1 ? '' : 's'}` : 'yes',
      note: book.errors.length ? 'rows the FIFO engine rejected' : `${book.realised.length} lot matches, ${book.byTicker.size} tickers`,
      help: {
        title: 'What "replays cleanly" checks',
        body: `<p>The ledger is fed through the same FIFO engine the rest of the workspace uses
                 (<code class="rounded bg-slate-100 px-1">js/portfolio/lots.js</code>) and any row that cannot be applied is
                 collected rather than skipped.</p>
               <p class="mt-2">The two failure modes worth catching: a <strong>sell larger than the holding</strong> on that date, and an
                 <strong>unrecognised type</strong>. Both mean the ledger and the position table would otherwise tell different
                 stories about the same shares.</p>
               <p class="mt-3 text-slate-500">An imported CSV is trial-replayed before you are offered the button to apply it, so a
                 file that would not reconcile says so first.</p>`,
      },
    },
    { label: 'Session state', value: sessionRows ? 'imported' : 'committed file', note: sessionRows ? 'in memory — lost on reload' : 'data/mock/transactions.json' },
    freshnessCard(m),
  ]);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Import / Export',
      description: 'Round-trip the ledger as CSV. Import previews first and names every row it rejects.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'ledger rows' })),
    })}
    ${sessionBanner()}
    ${stats.html}

    <div class="mb-6 grid gap-4 lg:grid-cols-2">
      <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-sm font-bold text-slate-900">Export</h3>
        <p class="mt-1 text-xs leading-relaxed text-slate-500">
          The whole ledger — ${rows.length} rows, ${CSV_COLUMNS.length} columns — in the exact shape the import expects, so a
          download-edit-upload round trip is lossless.
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" id="csv-download"
            class="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            Download CSV
          </button>
          <button type="button" id="xlsx-download"
            class="rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            Export Excel
          </button>
          <button type="button" id="csv-preview-btn"
            class="rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            Preview format
          </button>
        </div>
      </section>

      <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-sm font-bold text-slate-900">Import</h3>
        <p class="mt-1 text-xs leading-relaxed text-slate-500">
          Requires <code class="rounded bg-slate-100 px-1">date</code>, <code class="rounded bg-slate-100 px-1">ticker</code>,
          <code class="rounded bg-slate-100 px-1">type</code>, <code class="rounded bg-slate-100 px-1">qty</code>,
          <code class="rounded bg-slate-100 px-1">price</code>. Everything else is optional.
        </p>
        <div class="mt-3">
          <label for="csv-file" class="block text-xs font-semibold text-slate-600">CSV file</label>
          <input type="file" id="csv-file" accept=".csv,text/csv" aria-describedby="csv-hint"
            class="mt-1 block w-full cursor-pointer rounded-lg text-xs text-slate-600 ring-1 ring-slate-200 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600" />
          <p id="csv-hint" class="mt-1.5 text-[11px] text-slate-400">Nothing is uploaded — the file is parsed in the browser.</p>
        </div>
        <div class="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <strong>An applied import lasts until you reload.</strong> This is a static site with no server, so nothing can write
          <code class="rounded bg-amber-100 px-1">public/data/mock/transactions.json</code>. Download the merged CSV and commit it
          to make a change stick.
        </div>
      </section>
    </div>

    <div id="import-result"></div>

    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-sm font-bold text-slate-900">Current ledger</h3>
      <dl class="mt-3 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        ${[
          ['Rows', formatNumber(rows.length)],
          ['Tickers', formatNumber(new Set(rows.map((r) => r.ticker)).size)],
          ['Date range', `${formatDate(rows[0]?.date)} → ${formatDate(rows.at(-1)?.date)}`],
          ['Replay errors', String(book.errors.length)],
        ]
          .map(([k, v]) => `<div><dt class="text-slate-400">${escapeHtml(k)}</dt><dd class="mt-0.5 font-semibold text-slate-800">${escapeHtml(v)}</dd></div>`)
          .join('')}
      </dl>
      ${
        book.errors.length
          ? `<div class="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-900 ring-1 ring-rose-200">
               <strong>${book.errors.length} row${book.errors.length === 1 ? '' : 's'} could not be applied:</strong>
               ${book.errors.map((e) => `${escapeHtml(e.row?.id || '?')} — ${escapeHtml(e.reason)}`).join(' · ')}
             </div>`
          : ''
      }
      ${sessionRows ? '<button type="button" id="revert-import" class="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200 transition-colors hover:bg-rose-50">Revert to the committed ledger</button>' : ''}
    </section>
  `;

  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  wireImport(ctx);
}

function wireImport(ctx) {
  const root = ctx.root;

  root.querySelector('#csv-download')?.addEventListener('click', () => {
    downloadText(toCsv(ledger()), `sattva-transactions-${new Date().toISOString().slice(0, 10)}.csv`);
  });

  root.querySelector('#xlsx-download')?.addEventListener('click', () => exportTrades(ledger(), currentBook(), portfolio.meta()));

  root.querySelector('#csv-preview-btn')?.addEventListener('click', () => {
    const sample = toCsv(ledger().slice(0, 6));
    openModal(
      `<div class="p-6">
         <h3 class="font-display text-base font-bold text-slate-900">CSV format</h3>
         <p class="mt-1 text-xs text-slate-500">First six rows of the current ledger. Import accepts this exact shape.</p>
         <pre class="scrollbar-thin mt-3 overflow-x-auto rounded-xl bg-slate-900 p-4 text-[11px] leading-relaxed text-slate-100">${escapeHtml(sample)}</pre>
       </div>`,
      { size: 'wide' }
    );
  });

  root.querySelector('#revert-import')?.addEventListener('click', () => {
    sessionRows = null;
    pending = null;
    paint(ctx);
  });

  root.querySelector('#csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pending = parseCsv(String(reader.result));
      paintImportResult(ctx);
    };
    reader.onerror = () => {
      pending = { rows: [], errors: [{ line: 0, reason: 'could not read the file' }] };
      paintImportResult(ctx);
    };
    reader.readAsText(file);
  });

  if (pending) paintImportResult(ctx);
}

function paintImportResult(ctx) {
  const host = ctx.root.querySelector('#import-result');
  if (!host || !pending) return;
  const { rows, errors } = pending;

  const preview = rows
    .slice(0, 8)
    .map(
      (r) => `<tr class="border-t border-slate-100">
        <td class="py-1.5 pr-3 text-slate-600">${escapeHtml(r.date)}</td>
        <td class="py-1.5 pr-3 font-semibold text-slate-700">${escapeHtml(r.ticker)}</td>
        <td class="py-1.5 pr-3">${typePill(r.type)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${formatNumber(r.qty)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(r.price))}</td>
        <td class="py-1.5 text-right tabular-nums text-slate-700">${escapeHtml(formatRupee(r.value, { decimals: 0 }))}</td>
      </tr>`
    )
    .join('');

  // Replay the parsed rows before offering to apply them: an import that reconciles is worth
  // applying, and one that does not should say so BEFORE it replaces what is on screen.
  const trial = rows.length ? replay(rows) : null;

  host.innerHTML = `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100 fade-in">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="font-display text-sm font-bold text-slate-900">Import preview</h3>
        <div class="flex flex-wrap gap-2 text-xs">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-200">${rows.length} row${rows.length === 1 ? '' : 's'} parsed</span>
          ${errors.length ? `<span class="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 font-semibold text-rose-700 ring-1 ring-rose-200">${errors.length} rejected</span>` : ''}
          ${trial?.errors.length ? `<span class="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-200">${trial.errors.length} would not replay</span>` : ''}
        </div>
      </div>

      ${
        errors.length
          ? `<div class="mt-3 rounded-xl bg-rose-50 p-3 ring-1 ring-rose-200">
               <div class="text-xs font-bold text-rose-900">Rejected rows — nothing here was silently dropped</div>
               <ul class="scrollbar-thin mt-1.5 max-h-40 space-y-1 overflow-y-auto text-[11px] text-rose-800">
                 ${errors.map((e) => `<li><strong>Line ${e.line}:</strong> ${escapeHtml(e.reason)}</li>`).join('')}
               </ul>
             </div>`
          : ''
      }

      ${
        rows.length
          ? `<div class="scrollbar-thin mt-3 overflow-x-auto">
               <table class="w-full min-w-[520px] text-xs">
                 <thead><tr class="text-left text-[11px] uppercase tracking-wide text-slate-400">
                   <th scope="col" class="pb-1 pr-3 font-semibold">Date</th>
                   <th scope="col" class="pb-1 pr-3 font-semibold">Ticker</th>
                   <th scope="col" class="pb-1 pr-3 font-semibold">Type</th>
                   <th scope="col" class="pb-1 pr-3 text-right font-semibold">Qty</th>
                   <th scope="col" class="pb-1 pr-3 text-right font-semibold">Price</th>
                   <th scope="col" class="pb-1 text-right font-semibold">Value</th>
                 </tr></thead>
                 <tbody>${preview}</tbody>
               </table>
               ${rows.length > 8 ? `<p class="mt-2 text-[11px] text-slate-400">Showing 8 of ${rows.length} parsed rows.</p>` : ''}
             </div>
             <div class="mt-4 flex flex-wrap items-center gap-2">
               <button type="button" id="apply-import"
                 class="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
                 Apply ${rows.length} row${rows.length === 1 ? '' : 's'} for this session
               </button>
               <button type="button" id="discard-import"
                 class="rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 transition-colors hover:bg-slate-50">Discard</button>
               <span class="text-[11px] text-slate-400">Replaces the ledger in memory. A reload restores the committed file.</span>
             </div>`
          : '<p class="mt-3 text-xs text-slate-500">Nothing usable was parsed, so there is nothing to apply.</p>'
      }
    </section>`;

  host.querySelector('#apply-import')?.addEventListener('click', () => {
    sessionRows = pending.rows;
    pending = null;
    paint(ctx);
  });
  host.querySelector('#discard-import')?.addEventListener('click', () => {
    pending = null;
    paintImportResult(ctx);
    host.innerHTML = '';
  });
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------------
async function exportTrades(rows, book, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: 'sattva-transactions',
    sheetName: 'Transactions',
    columns: [
      { header: 'ID', key: 'id', width: 12, get: (r) => (r.__banner ? r.__banner : r.id) },
      { header: 'Date', key: 'date', width: 14, get: (r) => (r.__banner ? '' : r.date) },
      { header: 'Ticker', key: 'ticker', width: 14, get: (r) => (r.__banner ? '' : r.ticker) },
      { header: 'Name', key: 'name', width: 30, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Type', key: 'type', width: 12, get: (r) => (r.__banner ? '' : r.type) },
      { header: 'Qty', key: 'qty', width: 10, get: (r) => (r.__banner ? '' : r.qty) },
      { header: 'Price', key: 'price', width: 14, get: (r) => (r.__banner ? '' : r.price) },
      { header: 'Value', key: 'value', width: 16, get: (r) => (r.__banner ? '' : r.value) },
      { header: 'Charges', key: 'charges', width: 12, get: (r) => (r.__banner ? '' : r.charges || 0) },
      {
        header: 'Realised P&L (FIFO)',
        key: 'pnl',
        width: 20,
        get: (r) => (r.__banner ? '' : book.realised.filter((x) => x.sellId === r.id).reduce((s, x) => s + x.pnl, 0) || ''),
      },
    ],
    rows: [banner, ...rows],
  });
}

async function exportIncome(rows, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: 'sattva-income',
    sheetName: 'Dividends & Actions',
    columns: [
      { header: 'Date', key: 'date', width: 14, get: (r) => (r.__banner ? r.__banner : r.date) },
      { header: 'Ticker', key: 'ticker', width: 14, get: (r) => (r.__banner ? '' : r.ticker) },
      { header: 'Name', key: 'name', width: 30, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Type', key: 'type', width: 12, get: (r) => (r.__banner ? '' : r.type) },
      { header: 'Shares', key: 'qty', width: 12, get: (r) => (r.__banner ? '' : r.qty) },
      { header: 'Per share / ratio', key: 'ps', width: 18, get: (r) => (r.__banner ? '' : String(r.type).toLowerCase() === 'dividend' ? r.price : `${r.ratio}x`) },
      { header: 'Amount', key: 'value', width: 16, get: (r) => (r.__banner ? '' : r.value) },
    ],
    rows: [banner, ...rows],
  });
}

export { toCsv };
