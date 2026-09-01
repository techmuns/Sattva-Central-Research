// tabs/breakouts.js — Breakouts / Technical. The dashboard's one genuinely live tab.
//
// Everything here is scored by the ported LKP model (scoring/tech-scoring.js): 16 rules,
// 24 points, five categories. This is the first tab where scoreTable's Score and Signals
// columns are switched ON, because these are real modelled points rather than direct
// readings.
//
// The feed is fetched and scored ONCE by data/technicals.js and cached for the life of the
// page. Sub-view switches, scope changes, chip filters and sorts all operate on that cached
// list — nothing below refetches or rescores.

import { statStrip, topCards, scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatPct, formatRelativeTime, formatRupee } from '../core/format.js';
import { exportRows, todayStamp } from '../ui/export.js';
import * as technicals from '../data/technicals.js';
import { ACTIVE_RULES } from '../scoring/tech-scoring.js';
import { openTechnicalsDrill, fmtPoints } from './breakouts-drill.js';
import * as coverage from '../data/coverage.js';
import { whenDeferredData } from '../core/state.js';

export const meta = {
  id: 'breakouts',
  title: 'Breakouts / Technical',
  subtitle: 'Live technical scoring across the NSE 500 and every listed holding — 16 rules, 24 points.',
  subviews: [
    { id: 'strong-breakouts', label: 'Strong Breakouts' },
    { id: 'technical-scanner', label: 'Technical Scanner' },
    { id: 'fii-accumulation', label: 'FII Accumulation' },
    { id: 'earnings-surprise', label: 'Earnings Surprise' },
  ],
};

// Bumped on every render so a slow load that resolves after the user navigated away is
// discarded instead of painting over whatever is now on screen.
let renderToken = 0;

export function render(ctx) {
  const token = ++renderToken;
  ctx.root.innerHTML = loadingHtml();

  technicals
    .load()
    .then(() => {
      if (token !== renderToken) return; // stale — user moved on
      paint(ctx);
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[breakouts] technicals load failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The technicals feed could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load data/technicals.json</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  const rows = technicals.forScope(ctx.scope, coverage.holdings());
  const view = {
    'strong-breakouts': renderStrongBreakouts,
    'technical-scanner': renderScanner,
    'fii-accumulation': renderFiiAccumulation,
    'earnings-surprise': renderEarningsSurprise,
  }[ctx.subview] || renderStrongBreakouts;

  // Earnings Surprise is the one sub-view here whose left-hand columns come off `ctx.data`, and
  // that corpus is no longer in front of the shell's first paint (see js/app.js). Waiting for it
  // costs this sub-view alone and only on a cold visit — the other three render at once, as they
  // did. Rendering it early instead would show "0 results joined", which is a claim, not a wait.
  if (view === renderEarningsSurprise && !ctx.data?.earnings) {
    const token = renderToken;
    whenDeferredData().then(() => {
      if (token === renderToken) renderEarningsSurprise(ctx, rows);
    });
    return;
  }
  view(ctx, rows);
}

// ---- shared cell formatters ---------------------------------------------------------------

const num = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d));

function toneSpan(text, tone) {
  const cls = tone === 'pos' ? 'text-emerald-600' : tone === 'neg' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-600';
  return `<span class="font-semibold ${cls}">${text}</span>`;
}
function rsiCell(v) {
  if (v == null) return '—';
  return toneSpan(num(v, 1), v >= 55 && v <= 75 ? 'pos' : v > 75 ? 'warn' : v < 40 ? 'neg' : null);
}
function adxCell(v) {
  if (v == null) return '—';
  return toneSpan(num(v, 1), v > 25 ? 'pos' : v >= 20 ? 'warn' : 'neg');
}
function rsCell(v) {
  if (v == null) return '—';
  return toneSpan(`${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`, v > 0 ? 'pos' : 'neg');
}
function betaCell(v) {
  if (v == null) return '—';
  return toneSpan(num(v, 2), v >= 0.7 && v <= 1.3 ? 'pos' : v > 1.5 || v < 0.5 ? 'neg' : null);
}
function atrCell(v) {
  if (v == null) return '—';
  return toneSpan(`${num(v, 2)}%`, v < 2.5 ? 'pos' : v < 4 ? 'warn' : 'neg');
}
// CMP is the one cell a live quote may replace, and it is marked when it has been.
//
// The live print is kept in `company.liveQuote` and the EOD `cmp` is left ALONE. Every one of the
// 16 rules is computed from the daily OHLCV series — a 50 EMA, an RSI, a 52-week position — so
// overwriting the close that those rules were scored against would put a 14:32 price underneath a
// score that never saw it, and the drill panel would explain a rule using a number that is not the
// one the rule read. The score stays EOD, says so, and only the price moves.
function cmpCell(c) {
  const live = c.liveQuote || null;
  const price = live ? live.current : c.cmp;
  if (price == null) return '—';
  const chg = live ? live.changePct : c.pct_change_today;
  const dot = live
    ? ` <span class="inline-block h-1.5 w-1.5 rounded-full bg-indigo-500 align-middle" title="Live quote ${escapeHtml(live.atLabel)} — the 16-rule score is still EOD, from the close of ${escapeHtml(live.eodLabel)}"></span>`
    : '';
  return `<span class="font-semibold text-slate-800">₹${Number(price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>${
    chg == null ? '' : ` <span class="text-[11px] ${chg > 0 ? 'text-emerald-600' : chg < 0 ? 'text-rose-600' : 'text-slate-400'}">${chg > 0 ? '+' : ''}${Number(chg).toFixed(2)}%</span>`
  }${dot}`;
}

// Every scored row feeds the same score + signals shape into scoreTable.
const scoreOf = (s) => ({
  points: fmtPoints(s.totalPoints),
  max: s.totalMax,
  pct: s.scorePct,
  redFlag: s.hardFails.length ? s.hardFails.join(', ') : null,
});
const signalsOf = (s) => s.breakdown.map((b) => ({ label: `${b.label} (${fmtPoints(b.points)}/${b.max})`, status: b.status }));

// scoreTable accessors are shared across all four sub-views.
const tableBase = (rows, ctx) => ({
  rows,
  key: (s) => s.company.ticker,
  name: (s) => s.company.name || s.company.ticker,
  sub: (s) => [s.company.ticker, s.company.sector].filter(Boolean).join(' · '),
  link: (s) => s.company.screenerUrl,
  searchable: (s) => `${s.company.name} ${s.company.ticker} ${s.company.sector || ''} ${s.company.industry || ''}`,
  onRowClick: openTechnicalsDrill,
  emptyMessage: 'No companies match your filters.',
});

// ---- freshness + stat strip ---------------------------------------------------------------

function freshnessCard() {
  const m = technicals.meta();
  const ts = m?.generated_at ? new Date(m.generated_at) : null;
  return {
    hero: true,
    label: 'Last Refresh',
    value: ts ? formatRelativeTime(ts) : '—',
    note: `${m?.source || 'Yahoo Finance'} EOD · ${technicals.coverage().label}`,
  };
}

function scoringHelpModalBody() {
  const byCat = new Map();
  for (const r of ACTIVE_RULES) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const total = ACTIVE_RULES.reduce((s, r) => s + (r.fn({}).max || 0), 0);
  const sections = [...byCat.entries()]
    .map(([cat, rules]) => {
      const catMax = rules.reduce((s, r) => s + (r.fn({}).max || 0), 0);
      return `
        <div class="mb-4">
          <div class="mb-1.5 flex items-baseline justify-between">
            <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(cat)}</h3>
            <span class="text-xs font-semibold tabular-nums text-slate-500">${catMax} pts</span>
          </div>
          <div class="divide-y divide-slate-100 overflow-hidden rounded-xl ring-1 ring-slate-200/70">
            ${rules
              .map(
                (r) => `
              <div class="flex items-center justify-between gap-3 bg-white px-3 py-2">
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-slate-900">${escapeHtml(r.label)}</div>
                  <div class="text-[11px] text-slate-500">Criteria: ${escapeHtml(r.criteria)}</div>
                </div>
                <span class="flex-shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-600">${r.fn({}).max} pt${r.fn({}).max === 1 ? '' : 's'}</span>
              </div>`
              )
              .join('')}
          </div>
        </div>`;
    })
    .join('');

  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">How the Technicals score works</h2>
          <p class="mt-1 text-sm text-slate-500">
            ${ACTIVE_RULES.length} rules across five categories, ${total} points in total. Every rule is scored from the
            daily OHLCV feed — nothing is estimated or hand-weighted.
          </p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      </div>
      ${sections}
      <div class="rounded-xl bg-rose-50 p-3 text-[12px] leading-relaxed text-rose-800 ring-1 ring-rose-100">
        <strong>Hard fail:</strong> a close below the 200 DMA fails the primary trend filter outright. Per the client
        framework — “Price &lt; 200 DMA = immediate fail — stock exits pipeline.” Those rows are tinted rose and carry a
        ⚠ Red Flag chip; they still show their score so you can see what else is working.
      </div>
      <div class="mt-3 text-[11px] leading-relaxed text-slate-400">
        Tier bands: Excellent ≥ 80% · Good 60–80% · Average 40–60% · Weak &lt; 40%. Companies whose price history could not
        be fetched score 0 of 0 and rank last rather than being silently dropped.
      </div>
    </div>`;
}

// ---- (a) Technical Scanner ----------------------------------------------------------------

function renderScanner(ctx, rows) {
  const m = technicals.meta();
  const scored = rows.filter((s) => !s.tickerError);
  const maxPoints = scored[0]?.totalMax ?? 24;

  const stats = statStrip([
    { label: 'Universe', value: formatNumber(rows.length), note: `${m?.source || 'Yahoo Finance'} EOD · ${technicals.coverage().label}` },
    {
      label: 'Scoring Method',
      value: `${ACTIVE_RULES.length} / ${ACTIVE_RULES.length}`,
      note: 'Active rules',
      help: { title: 'Technicals scoring', body: '' }, // body unused — we open the full modal below
    },
    { label: 'Max Score', value: `${maxPoints} pts`, note: 'All rules active' },
    freshnessCard(),
  ]);

  const cards = topCards({
    title: 'Top 10 by Technicals Score',
    items: scored.slice(0, 10).map((s) => ({
      name: s.company.name || s.company.ticker,
      sub: s.company.sector || s.company.ticker,
      value: fmtPoints(s.totalPoints),
      max: s.totalMax,
      warn: s.hardFails.length ? s.hardFails.join(', ') : null,
      payload: s,
    })),
    valueFormat: 'score',
    onSelect: (item) => openTechnicalsDrill(item.payload),
  });

  const table = scoreTable({
    ...tableBase(rows, ctx),
    showScore: true,
    score: scoreOf,
    showSignals: true,
    signals: signalsOf,
    columns: [
      // Sort on what the cell SHOWS. Once a live quote is on screen, sorting by the EOD close
      // would order the column by numbers the reader can no longer see.
      { label: 'CMP', get: (s) => cmpCell(s.company), html: true, align: 'right', sortValue: (s) => s.company.liveQuote?.current ?? s.company.cmp ?? -1 },
      { label: 'RSI', get: (s) => rsiCell(s.company.rsi14), html: true, align: 'right', sortValue: (s) => s.company.rsi14 ?? -1 },
      { label: 'ADX', get: (s) => adxCell(s.company.adx14), html: true, align: 'right', sortValue: (s) => s.company.adx14 ?? -1 },
      { label: '6M RS', get: (s) => rsCell(s.company.relative_strength_6m), html: true, align: 'right', sortValue: (s) => s.company.relative_strength_6m ?? -99 },
      { label: 'Beta', get: (s) => betaCell(s.company.beta_1y), html: true, align: 'right', sortValue: (s) => s.company.beta_1y ?? -1 },
      { label: 'ATR%', get: (s) => atrCell(s.company.atr14_pct), html: true, align: 'right', sortValue: (s) => s.company.atr14_pct ?? 999 },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All scores' },
        { value: 'excellent', label: 'Excellent (80%+)' },
        { value: 'good', label: 'Good (60–80%)' },
        { value: 'average', label: 'Average (40–60%)' },
        { value: 'weak', label: 'Weak (<40%)' },
        { value: 'below200', label: '⚠ Below 200 DMA' },
      ],
      match: (s, v) => {
        if (v === 'below200') return s.hardFails.length > 0;
        if (s.tickerError) return false;
        const p = s.scorePct;
        if (v === 'excellent') return p >= 80;
        if (v === 'good') return p >= 60 && p < 80;
        if (v === 'average') return p >= 40 && p < 60;
        if (v === 'weak') return p < 40;
        return true;
      },
    },
    initialSort: { key: 'Score', dir: 'desc' },
    exportName: `sattva-technicals-${todayStamp()}`,
    onExport: (visible, filename) => runExport(visible, filename),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Every company scored against the 16-rule technicals framework, ranked best first.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies', book: coverage.meta() }),
    })}
    ${refreshBar()}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: `Scored from ${m?.source || 'Yahoo Finance'} daily OHLCV plus NSE delivery data. ${m?.failures || 0} of ${m?.company_count || 0} companies have no usable price history and score 0 of 0.` })}
  `;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
  wireRefreshBar(ctx, table);

  // Replace the generic help handler with the full 16-rule modal.
  const helpBtn = ctx.root.querySelector('[data-stat-help]');
  if (helpBtn) {
    const fresh = helpBtn.cloneNode(true);
    helpBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => openModal(scoringHelpModalBody(), { size: 'wide' }));
  }
}

// ---- (b) Strong Breakouts ------------------------------------------------------------------

// Every group leads with `all` and every group defaults to it, so the sub-view opens on the
// widest answer it can give and the reader narrows from there rather than discovering, after the
// fact, that a chip they never touched had been hiding rows. The trend filter is the one that used
// to do that: it shipped on "Above 200 DMA only", and a breakout below the primary trend line was
// simply absent from a table that gave no sign it was withholding anything.
//
// `all` means this group applies NO constraint. In `strength` that is every breakout grade the feed
// can report — the group grades a breakout, and `no_breakout` is the absence of one rather than a
// fourth grade, so it stays out of this view exactly as it always has. The line under the chips
// prints the matched count over every company with a detectable base, which is what keeps that
// difference visible rather than implied.
//
// `aliases` retires the old `any` ids without breaking a saved link — see readChipState.
const BREAKOUT_FILTERS = {
  strength: {
    param: 'bo',
    label: 'Breakout strength',
    multi: true,
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: 'strong', label: 'Strong' },
      { id: 'weak_base', label: 'Weak base' },
      { id: 'low_volume', label: 'Low volume' },
    ],
    test: (s, ids) => {
      const q = s.company.consolidation_breakout?.quality;
      if (!q) return false;
      if (ids.includes('all')) return q !== 'no_breakout';
      return ids.includes(q);
    },
  },
  volume: {
    param: 'vol',
    label: 'Volume confirm',
    multi: false,
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: '1.5', label: '≥ 1.5×' },
      { id: '1.0', label: '≥ 1.0×' },
    ],
    test: (s, ids) => {
      const id = ids[0];
      if (!id || id === 'all') return true;
      const r = s.company.consolidation_breakout?.today_volume_ratio;
      return r != null && r >= Number(id);
    },
  },
  proximity: {
    param: 'near',
    label: '52W proximity',
    multi: false,
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: '5', label: 'Within 5%' },
      { id: '10', label: 'Within 10%' },
      { id: '20', label: 'Within 20%' },
    ],
    test: (s, ids) => {
      const id = ids[0];
      if (!id || id === 'all') return true;
      const p = s.company.high_proximity_pct;
      if (p == null) return false;
      return (1 - p) * 100 <= Number(id);
    },
  },
  trend: {
    param: 'dma',
    label: 'Trend filter',
    multi: false,
    // 'any' was this group's include-everything id, so it aliases onto 'all' rather than being
    // dropped: a bookmarked `?dma=any` still means what its author meant.
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: 'above', label: 'Above 200 DMA only' },
    ],
    // Only 'above' constrains. Written this way round so an id this group no longer knows widens
    // the view rather than silently emptying it.
    test: (s, ids) => (ids[0] === 'above' ? s.company.above_200dma === true : true),
  },
};

// Defaults: all of everything. Nothing on this sub-view is narrowed until the reader narrows it.
const BREAKOUT_DEFAULTS = { bo: 'all', vol: 'all', near: 'all', dma: 'all' };

function readChipState(params, defaults, groups = null) {
  const aliasFor = (param) => Object.values(groups || {}).find((g) => g.param === param)?.aliases || null;
  const state = {};
  for (const [key, def] of Object.entries(defaults)) {
    const raw = params[key];
    const ids = raw == null || raw === '' ? def.split(',') : String(raw).split(',');
    const alias = aliasFor(key);
    state[key] = alias ? ids.map((id) => alias[id] || id) : ids;
  }
  return state;
}

function chipBar(groups, state, counts) {
  return `
    <div class="mb-5 space-y-2.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-chip-bar>
      ${Object.entries(groups)
        .map(
          ([groupKey, g]) => `
        <div class="flex flex-wrap items-center gap-2">
          <span class="w-32 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(g.label)}</span>
          ${g.options
            .map((o) => {
              const active = state[g.param].includes(o.id);
              const n = counts?.[g.param]?.[o.id];
              return `<button type="button" data-chip-group="${escapeHtml(groupKey)}" data-chip-id="${escapeHtml(o.id)}"
                class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }">
                <span>${escapeHtml(o.label)}</span>
                ${n == null ? '' : `<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>`}
              </button>`;
            })
            .join('')}
        </div>`
        )
        .join('')}
    </div>`;
}

function wireChipBar(root, groups, state, onChange) {
  const bar = root.querySelector('[data-chip-bar]');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chip-id]');
    if (!btn) return;
    const g = groups[btn.dataset.chipGroup];
    const id = btn.dataset.chipId;
    const cur = state[g.param];
    let next;
    if (!g.multi) {
      next = [id];
    } else if (id === 'all') {
      next = ['all'];
    } else {
      const without = cur.filter((x) => x !== 'all');
      next = without.includes(id) ? without.filter((x) => x !== id) : [...without, id];
      if (!next.length) next = ['all'];
    }
    onChange(g.param, next);
  });
}

// Breakout quality ranks strong > weak_base > low_volume > none; ties break on score.
const QUALITY_RANK = { strong: 3, weak_base: 2, low_volume: 1, no_breakout: 0 };
function breakoutRank(s) {
  return QUALITY_RANK[s.company.consolidation_breakout?.quality] ?? 0;
}

function renderStrongBreakouts(ctx, rows) {
  const state = readChipState(ctx.params || {}, BREAKOUT_DEFAULTS, BREAKOUT_FILTERS);
  const withBreakout = rows.filter((s) => !s.tickerError && s.company.consolidation_breakout);

  // Live counts per chip: how many rows would remain if that chip alone were toggled on,
  // holding the other groups at their current setting.
  const counts = {};
  for (const [groupKey, g] of Object.entries(BREAKOUT_FILTERS)) {
    counts[g.param] = {};
    for (const o of g.options) {
      const trial = { ...state, [g.param]: [o.id] };
      counts[g.param][o.id] = withBreakout.filter((s) =>
        Object.entries(BREAKOUT_FILTERS).every(([k2, g2]) => g2.test(s, trial[g2.param]))
      ).length;
    }
  }

  const filtered = withBreakout
    .filter((s) => Object.values(BREAKOUT_FILTERS).every((g) => g.test(s, state[g.param])))
    .sort((a, b) => breakoutRank(b) - breakoutRank(a) || b.totalPoints - a.totalPoints);

  const strongCount = filtered.filter((s) => s.company.consolidation_breakout?.quality === 'strong').length;
  const basingCount = withBreakout.filter((s) => s.company.consolidation_breakout?.quality === 'no_breakout').length;

  const stats = statStrip([
    { label: 'Breakout candidates', value: formatNumber(filtered.length), note: `of ${withBreakout.length} with a base` },
    { label: 'Strong breakouts', value: formatNumber(strongCount), note: 'tight base + volume' },
    {
      label: 'Filters active',
      value: Object.entries(state).filter(([k, v]) => v.join(',') !== BREAKOUT_DEFAULTS[k]).length || '—',
      note: 'chips reflected in the URL',
      help: {
        title: 'How breakout quality is graded',
        body: `<p>The base is the prior 30 trading days (≈ 6 weeks), excluding today.</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Strong</strong> — tight base (range &lt; 12% of average price) <em>and</em> today's close above the base high <em>and</em> volume &gt; 1.5× the base average.</li>
                 <li><strong>Weak base</strong> — broke out on volume, but the base wasn't tight.</li>
                 <li><strong>Low volume</strong> — closed above the base high without volume confirmation. Suspect.</li>
               </ul>
               <p class="mt-3 text-slate-500">Every filter opens on <strong>All</strong>, so nothing is held back until you hold it back. The trend filter is the one worth reaching for first — a breakout below the primary trend line is a hard fail in the client framework, and <em>Above 200 DMA only</em> drops those.</p>
               <p class="mt-2 text-slate-500"><strong>All</strong> under Breakout strength means every grade above, not every company${
                 basingCount
                   ? `: the ${formatNumber(basingCount)} names whose base has not broken out are counted in the line beneath the chips, and are not this sub-view's subject`
                   : ''
               }.</p>`,
      },
    },
    freshnessCard(),
  ]);

  const table = scoreTable({
    ...tableBase(filtered, ctx),
    showScore: true,
    score: scoreOf,
    columns: [
      { label: 'Quality', get: (s) => qualityPill(s.company.consolidation_breakout?.quality), html: true, sortValue: (s) => breakoutRank(s) },
      { label: 'Base range %', get: (s) => `${num(s.company.consolidation_breakout?.base_range_pct, 1)}%`, align: 'right', sortValue: (s) => s.company.consolidation_breakout?.base_range_pct ?? 999 },
      { label: 'Base high', get: (s) => formatRupee(s.company.consolidation_breakout?.base_max, { decimals: 0 }), align: 'right', sortValue: (s) => s.company.consolidation_breakout?.base_max ?? 0 },
      { label: 'Today close', get: (s) => formatRupee(s.company.consolidation_breakout?.today_close, { decimals: 0 }), align: 'right', sortValue: (s) => s.company.consolidation_breakout?.today_close ?? 0 },
      { label: 'Volume ratio', get: (s) => volRatioCell(s.company.consolidation_breakout?.today_volume_ratio), html: true, align: 'right', sortValue: (s) => s.company.consolidation_breakout?.today_volume_ratio ?? 0 },
      { label: '52W distance', get: (s) => distanceCell(s.company.high_proximity_pct), html: true, align: 'right', sortValue: (s) => (s.company.high_proximity_pct == null ? 999 : (1 - s.company.high_proximity_pct) * 100) },
    ],
    initialSort: null, // pre-sorted by breakout quality then score
    exportName: `sattva-breakouts-${todayStamp()}`,
    onExport: (visible, filename) => runExport(visible, filename),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Companies breaking out of a 6-week base, ranked by breakout quality then technical score.',
      meta: scopeSummary({ scope: ctx.scope, count: filtered.length, noun: 'candidates', book: coverage.meta() }),
    })}
    ${stats.html}
    ${chipBar(BREAKOUT_FILTERS, state, counts)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${filtered.length} of ${withBreakout.length}</span> companies with a detectable base match these filters.</div>
    ${table.html}
    ${legendStrip()}
  `;

  stats.wire(ctx.root);
  table.wire(ctx.root);
  wireChipBar(ctx.root, BREAKOUT_FILTERS, state, (param, next) => {
    ctx.setParams({ ...(ctx.params || {}), [param]: next.join(',') });
  });
}

function qualityPill(q) {
  const map = {
    strong: ['Strong', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
    weak_base: ['Weak base', 'bg-amber-50 text-amber-700 ring-amber-200'],
    low_volume: ['Low volume', 'bg-amber-50 text-amber-700 ring-amber-200'],
    no_breakout: ['No breakout', 'bg-slate-100 text-slate-600 ring-slate-200'],
  };
  const [label, cls] = map[q] || ['—', 'bg-slate-100 text-slate-500 ring-slate-200'];
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${label}</span>`;
}
function volRatioCell(r) {
  if (r == null) return '—';
  return toneSpan(`${num(r, 2)}×`, r >= 1.5 ? 'pos' : r >= 1 ? 'warn' : 'neg');
}
function distanceCell(p) {
  if (p == null) return '—';
  const d = (1 - p) * 100;
  return toneSpan(`${num(d, 1)}%`, d <= 10 ? 'pos' : d <= 20 ? 'warn' : 'neg');
}

// ---- (c) FII Accumulation -------------------------------------------------------------------

const FII_FILTERS = {
  side: {
    param: 'side',
    label: 'Institutional side',
    multi: false,
    options: [
      { id: 'fii', label: 'FII buying' },
      { id: 'dii', label: 'DII buying' },
      { id: 'both', label: 'Both buying' },
      { id: 'divergent', label: 'FII buy / DII sell' },
      { id: 'any', label: 'Any' },
    ],
    test: (s, ids) => {
      const f = s.company.chg_fii_hold;
      const d = s.company.chg_dii_hold;
      switch (ids[0]) {
        case 'fii': return f != null && f > 0;
        case 'dii': return d != null && d > 0;
        case 'both': return f != null && d != null && f > 0 && d > 0;
        case 'divergent': return f != null && d != null && f > 0 && d < 0;
        default: return true;
      }
    },
  },
  magnitude: {
    param: 'mag',
    label: 'FII change over',
    multi: false,
    options: [
      { id: '0', label: '> 0' },
      { id: '0.5', label: '> 0.5%' },
      { id: '1', label: '> 1%' },
      { id: '2', label: '> 2%' },
    ],
    test: (s, ids) => {
      const f = s.company.chg_fii_hold;
      return f != null && f > Number(ids[0] ?? 0);
    },
  },
};
const FII_DEFAULTS = { side: 'fii', mag: '0' };

function renderFiiAccumulation(ctx, rows) {
  const state = readChipState(ctx.params || {}, FII_DEFAULTS, FII_FILTERS);
  const withHold = rows.filter((s) => !s.tickerError && (s.company.chg_fii_hold != null || s.company.chg_dii_hold != null));

  const counts = {};
  for (const g of Object.values(FII_FILTERS)) {
    counts[g.param] = {};
    for (const o of g.options) {
      const trial = { ...state, [g.param]: [o.id] };
      counts[g.param][o.id] = withHold.filter((s) => Object.values(FII_FILTERS).every((g2) => g2.test(s, trial[g2.param]))).length;
    }
  }

  const filtered = withHold
    .filter((s) => Object.values(FII_FILTERS).every((g) => g.test(s, state[g.param])))
    .sort((a, b) => (b.company.chg_fii_hold ?? -99) - (a.company.chg_fii_hold ?? -99));

  const exiting = withHold.filter((s) => (s.company.chg_fii_hold ?? 0) < -2).length;
  const avgFii = withHold.length ? withHold.reduce((s, r) => s + (r.company.chg_fii_hold ?? 0), 0) / withHold.length : 0;

  const stats = statStrip([
    { label: 'Matching names', value: formatNumber(filtered.length), note: `of ${withHold.length} with shareholding data` },
    { label: 'Avg FII change', value: formatPct(avgFii, { decimals: 2 }), note: 'percentage points, latest period' },
    {
      label: 'FII exiting sharply',
      value: formatNumber(exiting),
      note: 'below −2% — flagged rose',
      help: {
        title: 'Institutional Activity and the −2% caution',
        body: `<p>The Institutional Activity rule scores the sum of the FII and DII holding change: net positive earns the point, net negative earns zero.</p>
               <p class="mt-2">There is one caution branch: if the combined figure is positive but <strong>FII alone is falling by more than 2%</strong>, the rule downgrades to partial rather than a clean pass — domestic buying is masking a foreign exit.</p>
               <p class="mt-3 text-slate-500">Those companies are flagged in rose on this tab so the divergence is visible before you open the drill. Holding changes come from the Screener shareholding export, refreshed with the universe file.</p>`,
      },
    },
    freshnessCard(),
  ]);

  const table = scoreTable({
    ...tableBase(filtered, ctx),
    showScore: true,
    score: (s) => {
      const base = scoreOf(s);
      const f = s.company.chg_fii_hold;
      // Surface the sharp-exit caution as a row flag, alongside any real hard fail.
      if (f != null && f < -2) return { ...base, redFlag: base.redFlag ? `${base.redFlag}; FII exiting sharply` : 'FII exiting sharply (< −2%)' };
      return base;
    },
    columns: [
      { label: 'Chg FII', get: (s) => holdCell(s.company.chg_fii_hold), html: true, align: 'right', sortValue: (s) => s.company.chg_fii_hold ?? -99 },
      { label: 'Chg DII', get: (s) => holdCell(s.company.chg_dii_hold), html: true, align: 'right', sortValue: (s) => s.company.chg_dii_hold ?? -99 },
      { label: 'Combined', get: (s) => holdCell((s.company.chg_fii_hold ?? 0) + (s.company.chg_dii_hold ?? 0)), html: true, align: 'right', sortValue: (s) => (s.company.chg_fii_hold ?? 0) + (s.company.chg_dii_hold ?? 0) },
      { label: 'Delivery trend Δ', get: (s) => deliveryCell(s.company.delivery_trend_diff), html: true, align: 'right', sortValue: (s) => s.company.delivery_trend_diff ?? -99 },
    ],
    initialSort: null,
    exportName: `sattva-fii-accumulation-${todayStamp()}`,
    onExport: (visible, filename) => runExport(visible, filename),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Institutional holding changes from the latest Screener shareholding export, joined to the live technical score.',
      meta: scopeSummary({ scope: ctx.scope, count: filtered.length, noun: 'names', book: coverage.meta() }),
    })}
    ${stats.html}
    ${chipBar(FII_FILTERS, state, counts)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${filtered.length} of ${withHold.length}</span> names with shareholding data match these filters.</div>
    ${table.html}
    ${legendStrip()}
  `;

  stats.wire(ctx.root);
  table.wire(ctx.root);
  wireChipBar(ctx.root, FII_FILTERS, state, (param, next) => {
    ctx.setParams({ ...(ctx.params || {}), [param]: next.join(',') });
  });
}

function holdCell(v) {
  if (v == null) return '—';
  return toneSpan(`${v > 0 ? '+' : ''}${num(v, 2)}%`, v > 0 ? 'pos' : v < -2 ? 'neg' : v < 0 ? 'warn' : null);
}
function deliveryCell(v) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  return toneSpan(`${v > 0 ? '+' : ''}${num(v, 1)} pp`, v > 1 ? 'pos' : v > 0 ? 'warn' : 'neg');
}

// ---- (d) Earnings Surprise -------------------------------------------------------------------

function renderEarningsSurprise(ctx, rows) {
  // The honest join: mock earnings on the left, the REAL technical score on the right.
  // Deliberately NOT blended into a composite — the two sides have different provenance.
  const byTicker = new Map(rows.map((s) => [s.company.ticker, s]));
  // `rows` arrived already narrowed to the scope, so under Portfolio or Watchlist an earnings row
  // with no technical row is a company outside the scope — not a company with no technicals.
  const narrowed = ctx.scope !== 'universe';
  const earnings = (ctx.data?.earnings || []).filter((e) => byTicker.has(e.ticker) || !narrowed);

  const joined = earnings
    .map((e) => ({ earnings: e, tech: byTicker.get(e.ticker) || null }))
    .filter((j) => (narrowed ? !!j.tech : true))
    .sort((a, b) => b.earnings.surprisePct - a.earnings.surprisePct);

  const withTech = joined.filter((j) => j.tech && !j.tech.tickerError).length;
  const beats = joined.filter((j) => j.earnings.resultTag === 'Beat').length;

  const stats = statStrip([
    { label: 'Results joined', value: formatNumber(joined.length), note: `${withTech} with a live technical score` },
    { label: 'Beats', value: formatNumber(beats), note: `${joined.length - beats} in-line or miss` },
    {
      label: 'Provenance',
      value: 'Mixed',
      note: 'mock earnings · live technicals',
      help: {
        title: 'Two different sources on one screen',
        body: `<p>This view deliberately keeps two provenances side by side rather than blending them:</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Earnings columns</strong> (surprise %, beat/miss, revenue and PAT growth) are <em>mock data</em> from <code class="rounded bg-slate-100 px-1">mock/earnings.json</code>. Swapping in a real filings feed is documented in docs/DATA-CONTRACTS.md under “Wiring the real feed”.</li>
                 <li><strong>Technical score</strong> is <em>live</em> — computed today from Yahoo Finance daily OHLCV by the same 16-rule model as the rest of this tab.</li>
               </ul>
               <p class="mt-3 text-slate-500">No composite is computed across the two. Combining a mock number with a live one into a single score would make the mock half invisible, and the result would look more trustworthy than it is.</p>`,
      },
    },
    freshnessCard(),
  ]);

  const table = scoreTable({
    rows: joined,
    key: (j) => j.earnings.ticker,
    name: (j) => j.earnings.name,
    sub: (j) => `${j.earnings.ticker} · ${j.earnings.sector}`,
    link: (j) => j.tech?.company?.screenerUrl || null,
    searchable: (j) => `${j.earnings.name} ${j.earnings.ticker} ${j.earnings.sector}`,
    onRowClick: (j) => j.tech && openTechnicalsDrill(j.tech),
    emptyMessage: 'No results to join for this scope.',
    showScore: true,
    score: (j) => (j.tech && !j.tech.tickerError ? scoreOf(j.tech) : { points: '—', max: '—', pct: 0, redFlag: null }),
    columns: [
      { label: 'Quarter', get: (j) => j.earnings.quarter },
      { label: 'Surprise', get: (j) => toneSpan(formatPct(j.earnings.surprisePct), j.earnings.surprisePct > 0 ? 'pos' : 'neg'), html: true, align: 'right', sortValue: (j) => j.earnings.surprisePct },
      { label: 'Tag', get: (j) => tagPill(j.earnings.resultTag), html: true, sortValue: (j) => j.earnings.resultTag },
      { label: 'Rev YoY', get: (j) => toneSpan(formatPct(j.earnings.revenueYoyPct), j.earnings.revenueYoyPct > 0 ? 'pos' : 'neg'), html: true, align: 'right', sortValue: (j) => j.earnings.revenueYoyPct },
      { label: 'PAT YoY', get: (j) => toneSpan(formatPct(j.earnings.netProfitYoyPct), j.earnings.netProfitYoyPct > 0 ? 'pos' : 'neg'), html: true, align: 'right', sortValue: (j) => j.earnings.netProfitYoyPct },
      { label: 'RSI', get: (j) => rsiCell(j.tech?.company?.rsi14), html: true, align: 'right', sortValue: (j) => j.tech?.company?.rsi14 ?? -1 },
      { label: 'Above 200 DMA', get: (j) => dmaPill(j.tech?.company?.above_200dma), html: true, sortValue: (j) => (j.tech?.company?.above_200dma ? 1 : 0) },
    ],
    initialSort: null,
    exportName: `sattva-earnings-surprise-${todayStamp()}`,
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Earnings surprise against the live technical score for the same company.',
      meta: scopeSummary({ scope: ctx.scope, count: joined.length, noun: 'results', book: coverage.meta() }),
    })}
    <div class="mb-5 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-100">
      <span class="font-bold uppercase tracking-wider">Mixed provenance</span>
      <span>Earnings figures are <strong>mock</strong>. Technical scores are <strong>live</strong>, computed today from Yahoo Finance EOD. The two are shown side by side and deliberately not blended into a composite.</span>
    </div>
    ${stats.html}
    ${table.html}
    ${legendStrip()}
  `;

  stats.wire(ctx.root);
  table.wire(ctx.root);
}

function tagPill(tag) {
  const cls = tag === 'Beat' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tag === 'Miss' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${tag}</span>`;
}
function dmaPill(v) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  return v
    ? '<span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Above</span>'
    : '<span class="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">Below</span>';
}

// ---- Excel export ----------------------------------------------------------------------------

// One row per company: identity, score, every rule's points, then the headline indicators.
function runExport(visibleRows, filename) {
  const scoredRows = visibleRows.filter((s) => s.company && !s.tickerError);
  const columns = [
    { header: 'Company', key: 'name', width: 30, get: (s) => s.company.name || '' },
    { header: 'Ticker', key: 'ticker', width: 14, get: (s) => s.company.ticker || '' },
    { header: 'Sector', key: 'sector', width: 22, get: (s) => s.company.sector || '' },
    { header: 'Industry', key: 'industry', width: 24, get: (s) => s.company.industry || '' },
    { header: 'Score', key: 'score', width: 9, get: (s) => s.totalPoints },
    { header: 'Max', key: 'max', width: 7, get: (s) => s.totalMax },
    { header: 'Score %', key: 'pct', width: 9, get: (s) => s.scorePct },
    { header: 'Tier', key: 'tier', width: 12, get: (s) => (s.hardFails.length ? 'Hard Fail' : s.scorePct >= 80 ? 'Excellent' : s.scorePct >= 60 ? 'Good' : s.scorePct >= 40 ? 'Average' : 'Weak') },
    { header: 'Red flag', key: 'redflag', width: 22, get: (s) => s.hardFails.join('; ') },
    // All 16 rules, in model order.
    ...ACTIVE_RULES.map((r) => ({
      header: `${r.label} (/${r.fn({}).max})`,
      key: `rule_${r.key}`,
      width: 18,
      get: (s) => s.breakdown.find((b) => b.key === r.key)?.points ?? null,
    })),
    // Headline indicators.
    { header: 'CMP', key: 'cmp', width: 12, get: (s) => s.company.cmp ?? null },
    { header: 'RSI 14', key: 'rsi', width: 10, get: (s) => s.company.rsi14 ?? null },
    { header: 'ADX 14', key: 'adx', width: 10, get: (s) => s.company.adx14 ?? null },
    { header: 'ATR %', key: 'atr', width: 10, get: (s) => s.company.atr14_pct ?? null },
    { header: 'Beta 1Y', key: 'beta', width: 10, get: (s) => s.company.beta_1y ?? null },
    { header: '6M return', key: 'r6m', width: 12, get: (s) => s.company.return_6m ?? null },
    { header: '6M RS vs Nifty500', key: 'rs', width: 18, get: (s) => s.company.relative_strength_6m ?? null },
    { header: '52W high', key: 'h52', width: 12, get: (s) => s.company.high_52w ?? null },
    { header: '% below 52W high', key: 'd52', width: 18, get: (s) => (s.company.high_proximity_pct == null ? null : Number(((1 - s.company.high_proximity_pct) * 100).toFixed(2))) },
    { header: 'Volume ratio', key: 'volr', width: 14, get: (s) => s.company.volume_ratio_today ?? null },
    { header: 'Delivery Δ (pp)', key: 'dlv', width: 16, get: (s) => s.company.delivery_trend_diff ?? null },
    { header: 'Chg FII %', key: 'fii', width: 12, get: (s) => s.company.chg_fii_hold ?? null },
    { header: 'Chg DII %', key: 'dii', width: 12, get: (s) => s.company.chg_dii_hold ?? null },
    { header: 'Above 200 DMA', key: 'dma', width: 15, get: (s) => (s.company.above_200dma == null ? '' : s.company.above_200dma ? 'Yes' : 'No') },
  ];

  exportRows({ filename, sheetName: 'Technicals', columns, rows: scoredRows }).then((ok) => {
    if (!ok) console.warn('[breakouts] export did not complete — exceljs unavailable.');
  });
}

// ---- live-quote refresh bar --------------------------------------------------------------------

function refreshBar() {
  return `
    <div class="mb-5 flex flex-wrap items-center gap-3" data-refresh-bar>
      <button type="button" data-refresh-btn disabled
        class="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-60">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
        <span data-refresh-label>Refresh prices</span>
      </button>
      <span data-refresh-note class="text-xs text-slate-400">Checking for the live-quote endpoint…</span>
    </div>`;
}

const LIVE_PRICES_ENDPOINT = '/api/live-prices';
// The route is absent from a plain static preview, and that is a different thing from a broken one.
const NO_ENDPOINT_STATUSES = new Set([404, 405, 501]);
// Above the Worker's own 25s budget (QUOTE_BUDGET_MS), so a slow-but-working refresh is never cut
// off from this end. The Worker returns a partial rather than hanging, so this only catches a
// request that never lands at all — and if that budget is ever raised, raise this with it.
const CLIENT_TIMEOUT_MS = 32000;

// In flight, so a second click cannot race the first, and so navigating away cancels the request
// instead of leaving it to resolve against a table that no longer exists.
let inFlight = null;

// The /api/live-prices route only exists when the site is served by the Cloudflare Worker.
// We do NOT probe for it on mount — an unsolicited request that 404s in a static preview is
// just console noise. The button starts enabled; if the first click finds no endpoint we
// disable it and explain, so the failure is stated once and never repeated.
function wireRefreshBar(ctx, table) {
  const btn = ctx.root.querySelector('[data-refresh-btn]');
  const note = ctx.root.querySelector('[data-refresh-note]');
  const label = ctx.root.querySelector('[data-refresh-label]');
  if (!btn) return;

  const rows = technicals.forScope(ctx.scope, coverage.holdings());
  const scored = rows.filter((s) => !s.tickerError);
  const byTicker = new Map(scored.map((s) => [s.company.ticker, s.company]));
  const tickers = scored.slice(0, 60).map((s) => s.company.ticker);

  btn.disabled = false;
  btn.classList.add('hover:bg-indigo-50', 'hover:text-indigo-700', 'hover:ring-indigo-200');
  btn.title = `Fetch live quotes for the top ${tickers.length} names on screen`;
  note.textContent = `EOD data below. Live quotes for the top ${tickers.length} names on demand.`;
  btn.addEventListener('click', () => doRefresh({ btn, note, label, tickers, byTicker, table }));
}

/**
 * Fetch live quotes and PUT THEM ON THE TABLE.
 *
 * The previous version fetched them and dropped them on the floor — it rewrote the note and
 * nothing else, so a button labelled "Refresh prices" left every price exactly where it was.
 * A control that reports success without changing what it names is worse than one that fails.
 */
async function doRefresh({ btn, note, label, tickers, byTicker, table }) {
  if (inFlight) return; // a second click during a slow refresh is not a second request
  const ctl = new AbortController();
  inFlight = ctl;
  const timer = setTimeout(() => ctl.abort(new Error('client timeout')), CLIENT_TIMEOUT_MS);
  btn.disabled = true;
  label.textContent = 'Refreshing…';

  try {
    const res = await fetch(LIVE_PRICES_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tickers }),
      signal: ctl.signal,
    });

    if (NO_ENDPOINT_STATUSES.has(res.status)) {
      // Static preview — no Worker. Say so once and stop offering the button.
      btn.title = 'Live quotes need the Cloudflare Worker (npx wrangler dev). Not available in a static preview.';
      note.textContent = 'Live quotes need the Worker — run `npx wrangler dev`. The EOD data below is unaffected.';
      return; // stays disabled
    }

    // Read the body BEFORE deciding this is a failure. The Worker puts the diagnosis in there —
    // which upstream it asked and what each missing name did — and a bare status code throws all
    // of it away. A failure state that cannot be diagnosed from its own artefact is half a
    // failure state; that lesson has already been paid for once on the chatter feed.
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status, payload);

    const applied = applyQuotes(payload?.prices, byTicker, payload?.generated_at, table);
    note.textContent = resultNote(payload, applied);
    note.className = 'text-xs text-slate-500';
    // The names, on the control itself. The summary line has to stay short, and "8 still warming"
    // is not something a reader can check against the table without being told which eight.
    btn.title = missingTitle(payload) || `Fetch live quotes for the top ${tickers.length} names on screen`;
    btn.disabled = false;
  } catch (err) {
    if (ctl.signal.aborted && !isTimeout(err)) return; // we navigated away; the tab is gone
    console.warn('[breakouts] live price refresh failed', err);
    note.textContent = failureNote(err);
    note.className = 'text-xs text-amber-700';
    btn.disabled = false;
  } finally {
    clearTimeout(timer);
    if (inFlight === ctl) inFlight = null;
    label.textContent = 'Refresh prices';
  }
}

function isTimeout(err) {
  return /timeout/i.test(String(err?.message || ''));
}

function httpError(status, payload) {
  const err = new Error(payload?.error || `HTTP ${status}`);
  err.status = status;
  err.reasons = payload?.reasons || null;
  err.upstream = payload?.upstream || null;
  return err;
}

/**
 * Fold the quotes into the rows and repaint just those cells.
 *
 * `company.cmp` is NOT touched — see cmpCell. The day change is recomputed from the quote's own
 * previous close rather than carried over from the EOD row: pairing a 14:32 price with this
 * morning's percentage would be two different measurements rendered as one.
 */
function applyQuotes(prices, byTicker, generatedAt, table) {
  if (!prices || typeof prices !== 'object') return [];
  const at = generatedAt ? new Date(generatedAt) : new Date();
  const atLabel = Number.isNaN(at.getTime()) ? 'just now' : at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const eodLabel = eodDateLabel();
  const touched = [];

  for (const [ticker, quote] of Object.entries(prices)) {
    const company = byTicker.get(ticker);
    if (!company || !quote || typeof quote.current !== 'number') continue;
    const prev = typeof quote.prevClose === 'number' && quote.prevClose > 0 ? quote.prevClose : null;
    company.liveQuote = {
      current: quote.current,
      // Null, not a stale carry-over, when there is no previous close to measure against. An
      // em dash beside a live price is honest; this morning's percentage beside it is not.
      changePct: prev == null ? null : ((quote.current - prev) / prev) * 100,
      atLabel,
      eodLabel,
    };
    touched.push(ticker);
  }

  if (touched.length && table?.updateRows) table.updateRows(touched);
  return touched;
}

function eodDateLabel() {
  const m = technicals.meta();
  const d = m?.generated_at ? new Date(m.generated_at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'the last EOD run';
}

// A name that timed out is warm upstream a moment later, so clicking again really does fetch it.
// A name the quote API does not carry will 404 forever, and no number of clicks changes that.
// Telling the reader to retry something that cannot succeed is the same failure as rendering a
// missing value as a zero: two different states, one indistinguishable message.
const TRANSIENT_MISS = /^(timeout|deadline|unreachable|http-5\d\d)$/;

/**
 * What the refresh actually achieved, including what it did not — and, for what it did not,
 * whether that is worth waiting for.
 */
function resultNote(payload, applied) {
  const requested = payload?.requested ?? applied.length;
  const missing = Array.isArray(payload?.missing) ? payload.missing : [];
  const when = payload?.generated_at ? formatRelativeTime(payload.generated_at) : 'just now';

  if (!missing.length) return `${applied.length} live quotes · ${when} · CMP only; the 16-rule score stays EOD.`;

  // Three outcomes, not two: a name that was never asked for is a third thing again, and saying
  // it is "not carried by the quote API" would blame the upstream for our own cap.
  const overCap = missing.filter((m) => m.reason === 'over-cap').length;
  const asked = missing.filter((m) => m.reason !== 'over-cap');
  const retryable = asked.filter((m) => TRANSIENT_MISS.test(m.reason)).length;
  const permanent = asked.length - retryable;
  const tail = [
    retryable ? `${retryable} still warming upstream — click again to fill them in` : '',
    permanent ? `${permanent} not carried by the quote API` : '',
    overCap ? `${overCap} beyond the 60-name request cap` : '',
  ].filter(Boolean);

  return `${applied.length} of ${requested} live quotes · ${tail.join(' · ')} · CMP only; the 16-rule score stays EOD.`;
}

/** Which names did not land, and why, grouped by reason. Empty string when everything did. */
function missingTitle(payload) {
  const missing = Array.isArray(payload?.missing) ? payload.missing : [];
  if (!missing.length) return '';
  const byReason = new Map();
  for (const m of missing) {
    if (!byReason.has(m.reason)) byReason.set(m.reason, []);
    byReason.get(m.reason).push(m.ticker);
  }
  return [...byReason.entries()].map(([reason, names]) => `${reason}: ${names.join(', ')}`).join('\n');
}

/** Name the endpoint, the status and the upstream's own reasons. "Failed" on its own is unusable. */
function failureNote(err) {
  if (isTimeout(err)) {
    return `Live quotes timed out after ${CLIENT_TIMEOUT_MS / 1000}s (${LIVE_PRICES_ENDPOINT}) — the EOD data below is unchanged.`;
  }
  const bits = [];
  if (err?.status) bits.push(`HTTP ${err.status}`);
  if (err?.message && !/^HTTP /.test(err.message)) bits.push(err.message);
  if (err?.upstream) bits.push(`upstream ${err.upstream}`);
  if (err?.reasons && Object.keys(err.reasons).length) {
    bits.push(
      Object.entries(err.reasons)
        .map(([reason, n]) => `${n}× ${reason}`)
        .join(', ')
    );
  }
  const detail = bits.length ? ` (${bits.join(' · ')})` : '';
  return `Live quote refresh failed at ${LIVE_PRICES_ENDPOINT}${detail} — the EOD data below is unchanged.`;
}

export function destroy() {
  // Invalidate any in-flight load so it can't paint after we're gone. The parsed+scored
  // technicals cache is intentionally kept — that's what makes tab re-entry instant.
  renderToken++;
  // A quote refresh can take twenty seconds. Abandoning one mid-flight would otherwise leave it
  // to resolve against a table that has been torn down, and to write its note into detached DOM.
  inFlight?.abort();
  inFlight = null;
}
