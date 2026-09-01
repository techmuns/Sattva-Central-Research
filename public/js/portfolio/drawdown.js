// portfolio/drawdown.js — the equity curve and the drawdown, built from REAL closing prices.
//
// This is the one view where faking the input would have been worst. A max drawdown of −24%
// computed from an invented price series looks exactly like a real one and nobody can check it
// against anything, unlike a mock revenue figure that a filing would contradict. So the curve is
// built from 741 trading days of actual Yahoo closes (scripts/scrape-portfolio-history.mjs) and
// the file records what it could not fetch.
//
// THREE THINGS THIS VIEW REFUSES TO DO
//   1. Quietly shorten the curve. TATAMOTORS is not on Yahoo, so it is carried at running cost,
//      named in the provenance modal and in the coverage line, and the headline says what fraction of the
//      book is actually priced.
//   2. Report one drawdown as if it were the drawdown. Retained cash dampens the portfolio
//      figure — correctly, the cash is really there — but "how far did the stocks fall" is the
//      other question a risk view is asked. Both are computed, both are labelled.
//   3. Call the curve's start-to-end move a return. It rises from ~₹92k to ~₹42.6L, and most of
//      that is money paid in. Time-weighted return is the figure shown against the index.

import { statStrip, sectionHead, scoreTable } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatRupee, formatPct, formatNumber, formatDate } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as portfolio from '../data/portfolio.js';
import { headMeta, wireProvenancePill, createLoader, moneyCell, pctCell, freshnessCard, exportBanner, RETURN_HELP } from './chrome.js';

export const meta = {
  id: 'drawdown',
  title: 'Drawdown',
  subtitle: 'Equity curve and drawdown from three years of real closing prices.',
  subviews: [
    { id: 'curve', label: 'Equity Curve' },
    { id: 'underwater', label: 'Underwater Plot' },
    { id: 'episodes', label: 'Drawdown Episodes' },
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
  const curve = portfolio.equityCurve();
  const m = portfolio.meta();
  if (!curve) return renderNoHistory(ctx, m);
  const view = ctx.subview || 'curve';
  if (view === 'underwater') return renderUnderwater(ctx, curve, m);
  if (view === 'episodes') return renderEpisodes(ctx, curve, m);
  return renderCurve(ctx, curve, m);
}

/**
 * The honest empty state. Without the price history there is no curve, and a "drawdown: —" card
 * on a page of otherwise-populated furniture reads as zero. So the whole view collapses to an
 * explanation of what is missing and how to produce it.
 */
function renderNoHistory(ctx, m) {
  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: meta.subtitle, controls: headMeta(m) })}
    <div class="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-100">
      <div class="text-3xl">📉</div>
      <h3 class="font-display mt-2 text-base font-bold text-slate-900">No price history, so no drawdown</h3>
      <p class="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-500">
        <code class="rounded bg-slate-100 px-1">data/portfolio-history.json</code> could not be loaded${m?.historyError ? ` (${escapeHtml(m.historyError)})` : ''}.
        A drawdown is a risk metric, and estimating one without the underlying prices would produce a number that looks exactly
        like a measured one. So this view shows nothing rather than something.
      </p>
      <p class="mx-auto mt-3 max-w-lg text-xs text-slate-400">
        Run <code class="rounded bg-slate-100 px-1">node scripts/scrape-portfolio-history.mjs</code> to fetch three years of daily
        closes for every ticker the ledger touches, plus the Nifty 500.
      </p>
    </div>`;
  wireProvenancePill(ctx.root, m);
}

// ---------------------------------------------------------------------------------------
function statsFor(curve, m) {
  const s = portfolio.summary();
  return statStrip([
    {
      label: 'Max drawdown',
      value: formatPct(curve.maxDrawdown, { decimals: 1 }),
      note: `${formatDate(curve.maxDrawdownPeak)} → ${formatDate(curve.maxDrawdownTrough)}${curve.recoveryDate ? ` · recovered ${formatDate(curve.recoveryDate)}` : ' · not yet recovered'}`,
      help: {
        title: 'Which drawdown this is, and why there are two',
        body: `<p>Drawdown is the fall from the running peak of portfolio value: <code class="rounded bg-slate-100 px-1">(value − peak) / peak</code>,
                 evaluated on every one of the ${curve.tradingDays} trading days in the series.</p>
               <p class="mt-2">This headline is the <strong>total portfolio</strong>, holdings plus retained cash. Sale proceeds and
                 dividends are never reinvested, so cash accumulates and dampens the fall — correctly, because that cash really is
                 there and really did not fall.</p>
               <p class="mt-2">The <strong>holdings-only</strong> figure of ${escapeHtml(formatPct(curve.maxHoldingsDrawdown, { decimals: 1 }))} answers the
                 other question: how far the equity exposure itself fell. Reporting only one of these would invite the wrong read.</p>
               <p class="mt-3 text-slate-500">Prices are real closes from ${escapeHtml(curve.source)}, ${escapeHtml(formatDate(curve.from))} → ${escapeHtml(formatDate(curve.to))}.
                 ${curve.excluded.length ? `${escapeHtml(curve.excluded.join(', '))} could not be fetched and is carried at running cost — ${escapeHtml(curve.coverage.toFixed(1))}% of the book is priced.` : 'Every position is priced.'}</p>`,
      },
    },
    {
      label: 'Time-weighted return',
      value: formatPct(s.twr.total, { decimals: 1 }),
      note: `${formatPct(s.twr.annualised, { decimals: 1 })} annualised · Nifty 500 ${formatPct(s.benchmarkReturn, { decimals: 1 })}`,
      help: RETURN_HELP,
    },
    {
      label: 'Curve coverage',
      value: `${curve.coverage.toFixed(1)}%`,
      note: curve.excluded.length ? `excludes ${curve.excluded.join(', ')} — carried at cost` : 'every position priced',
    },
    freshnessCard(m),
  ]);
}

// ---------------------------------------------------------------------------------------
// Equity curve
// ---------------------------------------------------------------------------------------
function renderCurve(ctx, curve, m) {
  const stats = statsFor(curve, m);
  const s = portfolio.summary();

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Equity curve',
      description: `Portfolio value on every one of ${formatNumber(curve.tradingDays)} trading days, valued at real closing prices.`,
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: curve.tradingDays, noun: 'trading days' })),
    })}
    ${stats.html}
    ${curveChart(curve)}
    <div class="mb-6 grid gap-4 lg:grid-cols-3">
      ${infoCard('Money-weighted (XIRR)', s.xirr == null ? '—' : formatPct(s.xirr, { decimals: 2 }), 'What this investor earned, contribution timing included.')}
      ${infoCard('Time-weighted (TWR)', formatPct(s.twr.total, { decimals: 2 }), `${formatPct(s.twr.annualised, { decimals: 2 })} annualised over ${s.twr.years.toFixed(1)} years — comparable to an index.`)}
      ${infoCard('Nifty 500 over the same window', formatPct(s.benchmarkReturn, { decimals: 2 }), `${escapeHtml(curve.benchmark?.symbol || '—')} · same trading calendar, same start date.`)}
    </div>
    ${indexedChart(curve)}
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  wireChartHover(ctx.root, curve);
}

function infoCard(label, value, note) {
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="text-xs font-medium uppercase tracking-wider text-slate-500">${escapeHtml(label)}</div>
      <div class="mt-1 text-2xl font-bold tabular-nums text-slate-900">${escapeHtml(value)}</div>
      <div class="mt-0.5 text-xs leading-relaxed text-slate-500">${note}</div>
    </div>`;
}

const W = 1000;
const H = 260;
const PAD = { l: 8, r: 8, t: 12, b: 22 };

function scaleX(i, n) {
  return PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
}

function curveChart(curve) {
  const pts = curve.points;
  const max = Math.max(...pts.map((p) => p.value));
  const min = 0; // a portfolio-value chart with a truncated baseline exaggerates every wiggle
  const y = (v) => PAD.t + (1 - (v - min) / (max - min || 1)) * (H - PAD.t - PAD.b);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${scaleX(i, pts.length).toFixed(2)},${y(p.value).toFixed(2)}`).join('');
  const holdingsLine = pts.map((p, i) => `${i ? 'L' : 'M'}${scaleX(i, pts.length).toFixed(2)},${y(p.holdings + p.excludedCost).toFixed(2)}`).join('');
  const area = `${line}L${scaleX(pts.length - 1, pts.length).toFixed(2)},${y(min).toFixed(2)}L${scaleX(0, pts.length).toFixed(2)},${y(min).toFixed(2)}Z`;

  // Shade the worst drawdown so the headline number has a visible referent on the chart.
  const pi = pts.findIndex((p) => p.d === curve.maxDrawdownPeak);
  const ti = pts.findIndex((p) => p.d === curve.maxDrawdownTrough);
  const shade =
    pi >= 0 && ti > pi
      ? `<rect x="${scaleX(pi, pts.length).toFixed(2)}" y="${PAD.t}" width="${(scaleX(ti, pts.length) - scaleX(pi, pts.length)).toFixed(2)}" height="${H - PAD.t - PAD.b}" fill="#e11d48" opacity="0.07"></rect>`
      : '';

  return `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h3 class="font-display text-sm font-bold text-slate-900">Portfolio value</h3>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded bg-indigo-500"></span>Total (holdings + cash)</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded bg-purple-300"></span>Holdings only</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2 w-3 rounded-sm bg-rose-200"></span>Worst drawdown</span>
        </div>
      </div>
      <div class="relative mt-3">
        <svg id="equity-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="h-56 w-full" role="img"
          aria-label="Portfolio value from ${escapeHtml(formatDate(curve.from))} to ${escapeHtml(formatDate(curve.to))}, ending at ${escapeHtml(formatRupee(pts.at(-1).value, { decimals: 0 }))}, with a maximum drawdown of ${escapeHtml(formatPct(curve.maxDrawdown, { decimals: 1 }))}">
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22"></stop>
              <stop offset="100%" stop-color="#ec4899" stop-opacity="0.02"></stop>
            </linearGradient>
          </defs>
          ${shade}
          <path d="${area}" fill="url(#equityFill)"></path>
          <path d="${holdingsLine}" fill="none" stroke="#c4b5fd" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
          <path d="${line}" fill="none" stroke="#4f46e5" stroke-width="2" vector-effect="non-scaling-stroke"></path>
          <line id="equity-cursor" x1="0" y1="${PAD.t}" x2="0" y2="${H - PAD.b}" stroke="#4f46e5" stroke-width="1" stroke-dasharray="3 3" opacity="0" vector-effect="non-scaling-stroke"></line>
        </svg>
        <div id="equity-tip" class="pointer-events-none absolute hidden rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg"></div>
      </div>
      <div class="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>${escapeHtml(formatDate(curve.from))}</span>
        <span>${escapeHtml(formatRupee(pts.at(-1).value, { decimals: 0 }))} on ${escapeHtml(formatDate(curve.to))}</span>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-slate-500">
        The gap between the two lines is retained cash: ${escapeHtml(formatRupee(pts.at(-1).cash, { decimals: 0 }))} of sale proceeds and
        dividends, never reinvested. The y-axis starts at zero — a truncated baseline would exaggerate every move on a value chart.
        ${curve.excluded.length ? `${escapeHtml(curve.excluded.join(', '))} has no price series and is carried at running cost inside the holdings line.` : ''}
      </p>
    </section>`;
}

function indexedChart(curve) {
  if (!curve.benchmark) return '';
  const pts = curve.points;
  const bench = curve.benchmark.points;
  // Index both to 100 at the first day so the comparison is of shape, not of scale. The
  // portfolio line here is the TWR chain, not raw value — raw value would "beat" any index
  // simply by having money added to it.
  const twrSeries = twrChain(pts);
  const all = [...twrSeries, ...bench.map((b) => b.indexed)];
  const max = Math.max(...all);
  const min = Math.min(...all);
  const y = (v) => PAD.t + (1 - (v - min) / (max - min || 1)) * (H - PAD.t - PAD.b);

  const pf = twrSeries.map((v, i) => `${i ? 'L' : 'M'}${scaleX(i, twrSeries.length).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const bm = bench.map((b, i) => `${i ? 'L' : 'M'}${scaleX(i, bench.length).toFixed(2)},${y(b.indexed).toFixed(2)}`).join('');

  return `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h3 class="font-display text-sm font-bold text-slate-900">Growth of ₹100 — portfolio vs Nifty 500</h3>
        <div class="flex gap-4 text-[11px] text-slate-500">
          <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded bg-indigo-500"></span>Portfolio (time-weighted)</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded bg-slate-400"></span>Nifty 500</span>
        </div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mt-3 h-56 w-full" role="img"
        aria-label="Growth of 100 rupees: portfolio ends at ${twrSeries.at(-1).toFixed(1)}, Nifty 500 ends at ${bench.at(-1).indexed.toFixed(1)}">
        <line x1="${PAD.l}" y1="${y(100).toFixed(2)}" x2="${W - PAD.r}" y2="${y(100).toFixed(2)}" stroke="#e2e8f0" stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <path d="${bm}" fill="none" stroke="#94a3b8" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
        <path d="${pf}" fill="none" stroke="#4f46e5" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      </svg>
      <div class="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>₹100 on ${escapeHtml(formatDate(curve.from))}</span>
        <span>Portfolio <strong class="text-slate-600">₹${twrSeries.at(-1).toFixed(0)}</strong> · Nifty 500 <strong class="text-slate-600">₹${bench.at(-1).indexed.toFixed(0)}</strong></span>
      </div>
    </section>`;
}

/**
 * The TWR chain as a series, for the indexed chart. Same maths as data/portfolio.js's
 * `timeWeightedReturn`, kept as a series rather than a single number.
 */
function twrChain(points) {
  const inflow = new Map();
  for (const t of portfolio.transactions()) {
    if (String(t.type || '').toLowerCase() !== 'buy') continue;
    inflow.set(t.date, (inflow.get(t.date) || 0) + (Number(t.value) || 0) + (Number(t.charges) || 0));
  }
  const out = [100];
  let factor = 1;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    const r = prev > 0 ? (points[i].value - (inflow.get(points[i].d) || 0)) / prev : 1;
    if (Number.isFinite(r) && r > 0) factor *= r;
    out.push(factor * 100);
  }
  return out;
}

function wireChartHover(root, curve) {
  const svg = root.querySelector('#equity-svg');
  const tip = root.querySelector('#equity-tip');
  const cursor = root.querySelector('#equity-cursor');
  if (!svg || !tip || !cursor) return;
  const pts = curve.points;

  const move = (e) => {
    const box = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const i = Math.round(frac * (pts.length - 1));
    const p = pts[i];
    if (!p) return;
    const dd = curve.drawdown[i];
    cursor.setAttribute('x1', String(scaleX(i, pts.length)));
    cursor.setAttribute('x2', String(scaleX(i, pts.length)));
    cursor.setAttribute('opacity', '1');
    tip.classList.remove('hidden');
    tip.innerHTML = `<strong>${escapeHtml(formatDate(p.d))}</strong><br>${escapeHtml(formatRupee(p.value, { decimals: 0 }))}<br><span class="opacity-70">holdings ${escapeHtml(formatRupee(p.holdings + p.excludedCost, { decimals: 0 }))} · cash ${escapeHtml(formatRupee(p.cash, { decimals: 0 }))}</span><br><span class="opacity-70">drawdown ${dd ? dd.dd.toFixed(1) : '0.0'}%</span>`;
    const left = Math.min(box.width - 150, Math.max(0, frac * box.width - 60));
    tip.style.left = `${left}px`;
    tip.style.top = '4px';
  };
  const leave = () => {
    tip.classList.add('hidden');
    cursor.setAttribute('opacity', '0');
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', leave);
  disposers.push(() => {
    svg.removeEventListener('mousemove', move);
    svg.removeEventListener('mouseleave', leave);
  });
}

// ---------------------------------------------------------------------------------------
// Underwater plot
// ---------------------------------------------------------------------------------------
function renderUnderwater(ctx, curve, m) {
  const stats = statsFor(curve, m);
  const under = curve.drawdown.filter((d) => d.dd < -0.01).length;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Underwater plot',
      description: 'Every day’s distance below the previous peak. The area is time spent in drawdown, which is the part investors actually experience.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: curve.tradingDays, noun: 'trading days' })),
    })}
    ${stats.html}
    ${underwaterChart(curve, 'drawdown', 'Total portfolio', '#e11d48')}
    ${underwaterChart(curve, 'holdingsDrawdown', 'Holdings only (excludes retained cash)', '#a855f7')}
    ${curve.benchmarkDrawdown ? underwaterChart({ ...curve, benchmarkSeries: curve.benchmarkDrawdown.series }, 'benchmarkSeries', 'Nifty 500, same window', '#64748b') : ''}
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-sm font-bold text-slate-900">Time under water</h3>
      <p class="mt-1 text-xs leading-relaxed text-slate-500">
        The portfolio was below a previous peak on <strong class="text-slate-700">${formatNumber(under)}</strong> of
        ${formatNumber(curve.tradingDays)} trading days — ${((under / curve.tradingDays) * 100).toFixed(0)}% of the time.
        The deepest point was ${escapeHtml(formatPct(curve.maxDrawdown, { decimals: 1 }))} on ${escapeHtml(formatDate(curve.maxDrawdownTrough))},
        ${curve.recoveryDate ? `recovered on ${escapeHtml(formatDate(curve.recoveryDate))}.` : 'not yet recovered.'}
      </p>
    </section>
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
}

function underwaterChart(curve, seriesKey, title, colour) {
  const series = curve[seriesKey];
  if (!series?.length) return '';
  const worst = Math.min(...series.map((d) => d.dd));
  const y = (v) => PAD.t + (v / (worst || -1)) * (H - PAD.t - PAD.b);
  const path = series.map((d, i) => `${i ? 'L' : 'M'}${scaleX(i, series.length).toFixed(2)},${y(d.dd).toFixed(2)}`).join('');
  const area = `${path}L${scaleX(series.length - 1, series.length).toFixed(2)},${PAD.t}L${scaleX(0, series.length).toFixed(2)},${PAD.t}Z`;

  return `
    <section class="mb-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h3 class="font-display text-sm font-bold text-slate-900">${escapeHtml(title)}</h3>
        <span class="text-xs font-semibold tabular-nums" style="color:${colour}">worst ${worst.toFixed(1)}%</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mt-3 h-40 w-full" role="img"
        aria-label="${escapeHtml(title)} underwater plot, worst drawdown ${worst.toFixed(1)} percent">
        <line x1="${PAD.l}" y1="${PAD.t}" x2="${W - PAD.r}" y2="${PAD.t}" stroke="#e2e8f0" stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <path d="${area}" fill="${colour}" opacity="0.14"></path>
        <path d="${path}" fill="none" stroke="${colour}" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
      </svg>
      <div class="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>0%</span><span>${worst.toFixed(1)}% at the bottom of the axis</span>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------------------
function renderEpisodes(ctx, curve, m) {
  const stats = statsFor(curve, m);
  const episodes = findEpisodes(curve);

  const table = scoreTable({
    rows: episodes,
    key: (e) => `${e.peakDate}-${e.troughDate}`,
    name: (e) => `${formatDate(e.peakDate)} → ${formatDate(e.troughDate)}`,
    nameLabel: 'Episode',
    sub: (e) => (e.recoveryDate ? `recovered ${formatDate(e.recoveryDate)}` : 'not yet recovered'),
    columns: [
      { label: 'Depth', get: (e) => pctCell(e.depth), html: true, align: 'right', sortValue: (e) => e.depth },
      { label: 'Peak value', get: (e) => formatRupee(e.peakValue, { decimals: 0 }), align: 'right', sortValue: (e) => e.peakValue },
      { label: 'Trough value', get: (e) => formatRupee(e.troughValue, { decimals: 0 }), align: 'right', sortValue: (e) => e.troughValue },
      { label: 'Fall', get: (e) => moneyCell(e.troughValue - e.peakValue), html: true, align: 'right', sortValue: (e) => e.troughValue - e.peakValue },
      { label: 'Decline (days)', get: (e) => formatNumber(e.declineDays), align: 'right', sortValue: (e) => e.declineDays },
      { label: 'Recovery (days)', get: (e) => (e.recoveryDays == null ? '<span class="text-amber-600 font-semibold">ongoing</span>' : formatNumber(e.recoveryDays)), html: true, align: 'right', sortValue: (e) => e.recoveryDays ?? Infinity },
      { label: 'Total (days)', get: (e) => (e.recoveryDays == null ? '—' : formatNumber(e.declineDays + e.recoveryDays)), align: 'right', sortValue: (e) => e.declineDays + (e.recoveryDays ?? 0) },
    ],
    searchable: (e) => `${e.peakDate} ${e.troughDate} ${e.recoveryDate || 'ongoing'}`,
    initialSort: { key: 'Depth', dir: 'asc' },
    exportName: 'sattva-drawdown-episodes',
    onExport: (visible) => exportEpisodes(visible, m),
    emptyMessage: 'No drawdown deeper than 2% in this window.',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Drawdown episodes',
      description: 'Every peak-to-trough fall deeper than 2%, with how long it took to go down and how long to come back.',
      controls: headMeta(m, scopeSummary({ scope: ctx.scope, count: episodes.length, noun: 'episodes' })),
    })}
    ${stats.html}
    ${table.html}
    <p class="mb-6 text-[11px] leading-relaxed text-slate-500">
      An episode runs from a peak to the lowest point before that peak is regained. A drawdown still open at
      ${escapeHtml(formatDate(curve.to))} reports its recovery as <strong>ongoing</strong> rather than being closed at the last
      day — the series simply has not reached its end yet, and closing it would understate the duration.
    </p>
  `;
  stats.wire(ctx.root);
  wireProvenancePill(ctx.root, m);
  disposers.push(table.wire(ctx.root));
}

/**
 * Split the series into peak-to-recovery episodes. Threshold at 2% so noise does not swamp the
 * table; the threshold is stated in the description rather than left implicit.
 */
function findEpisodes(curve, threshold = -2) {
  const pts = curve.points;
  const out = [];
  let peakValue = -Infinity;
  let peakDate = null;
  let peakIndex = 0;
  let troughValue = Infinity;
  let troughDate = null;
  let troughIndex = 0;
  let open = false;

  const close = (recoveryIndex) => {
    const depth = ((troughValue - peakValue) / peakValue) * 100;
    if (depth <= threshold) {
      out.push({
        peakDate,
        peakValue,
        troughDate,
        troughValue,
        depth,
        declineDays: days(peakDate, troughDate),
        recoveryDate: recoveryIndex == null ? null : pts[recoveryIndex].d,
        recoveryDays: recoveryIndex == null ? null : days(troughDate, pts[recoveryIndex].d),
      });
    }
    open = false;
  };

  for (let i = 0; i < pts.length; i++) {
    const v = pts[i].value;
    if (v >= peakValue) {
      if (open) close(i);
      peakValue = v;
      peakDate = pts[i].d;
      peakIndex = i;
      troughValue = v;
      troughDate = pts[i].d;
      troughIndex = i;
    } else {
      open = true;
      if (v < troughValue) {
        troughValue = v;
        troughDate = pts[i].d;
        troughIndex = i;
      }
    }
  }
  if (open) close(null);
  void peakIndex;
  void troughIndex;
  return out.sort((a, b) => a.depth - b.depth);
}

const days = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function exportEpisodes(rows, m) {
  const banner = { __banner: exportBanner(m) };
  await exportRows({
    filename: 'sattva-drawdown-episodes',
    sheetName: 'Drawdown Episodes',
    columns: [
      { header: 'Peak Date', key: 'pd', width: 14, get: (e) => (e.__banner ? e.__banner : e.peakDate) },
      { header: 'Peak Value', key: 'pv', width: 16, get: (e) => (e.__banner ? '' : e.peakValue) },
      { header: 'Trough Date', key: 'td', width: 14, get: (e) => (e.__banner ? '' : e.troughDate) },
      { header: 'Trough Value', key: 'tv', width: 16, get: (e) => (e.__banner ? '' : e.troughValue) },
      { header: 'Depth %', key: 'dp', width: 12, get: (e) => (e.__banner ? '' : e.depth) },
      { header: 'Decline Days', key: 'dd', width: 14, get: (e) => (e.__banner ? '' : e.declineDays) },
      { header: 'Recovery Date', key: 'rd', width: 16, get: (e) => (e.__banner ? '' : e.recoveryDate || 'ongoing') },
      { header: 'Recovery Days', key: 'rdd', width: 16, get: (e) => (e.__banner ? '' : (e.recoveryDays ?? 'ongoing')) },
    ],
    rows: [banner, ...rows],
  });
}

export { findEpisodes };
