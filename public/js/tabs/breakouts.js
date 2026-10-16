import { TAB_META } from './catalog.js';
import * as live from '../data/breakout-live.js';
import { filterByScope, scopeTickers } from '../data/scope.js';
import { scoreTable, sectionHead, openModal, statStrip } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatPct, formatRelativeTime, formatRupee } from '../core/format.js';
import { exportRows, todayStamp } from '../ui/export.js';
import * as technicals from '../data/technicals.js';
import * as refreshRegistry from '../core/refresh.js';
import { ACTIVE_RULES } from '../scoring/tech-scoring.js';
import { openTechnicalsDrill, fmtPoints } from './breakouts-drill.js';
import * as coverage from '../data/coverage.js';
import * as scopeLists from '../core/scope-lists.js';
import { TECHNICAL_FILTERS, TECHNICAL_DEFAULTS, chipCounts } from './technical-filters.js';
import * as momentum from '../scoring/momentum-live.js';

export const meta = TAB_META['breakouts'];

// Bumped on every render so a slow load that resolves after the user navigated away is
// discarded instead of painting over whatever is now on screen.
let renderToken = 0;
let ctxRef = null;
let refreshOff = null;
let dataOff = null;
let liveOff = null;
let dailyTimer = null;
let dailyCheckedAt = 0;
function checkDaily() {
  if (document.visibilityState === 'hidden' || Date.now()-dailyCheckedAt < 15*60000) return;
  dailyCheckedAt = Date.now();
  void technicals.refresh().catch(() => {});
}
let tableOff = null;
const tableViews = new Map();
let momentumFocusOnRender = null;

export function render(ctx) {
  const criteriaFocus = momentumControlFocus(ctx.root) || momentumFocusOnRender;
  momentumFocusOnRender = null;
  tableOff?.(); tableOff = null;
  ctxRef = ctx;

  if (!refreshOff) refreshOff = refreshRegistry.register('technicals-view', {
    label: 'Technicals', refresh: async () => {
      await technicals.refresh();
      const prices = await live.refresh();
      return {...prices,partial:prices.partial || technicals.meta()?.deliveryFailed === true};
    },
  });
  if (!dataOff) dataOff = technicals.onChange(() => { if (ctxRef) paint(ctxRef); });
  if (!liveOff) liveOff = live.watch(() => { if (ctxRef && technicals.isLoaded()) paint(ctxRef); });
  if (!dailyTimer) { dailyTimer = setInterval(checkDaily, 60000); document.addEventListener('visibilitychange', checkDaily); window.addEventListener('focus', checkDaily); window.addEventListener('online', checkDaily); if (technicals.isLoaded()) checkDaily(); }
  const token = ++renderToken;
  ctx.root.innerHTML = loadingHtml(ctx.subview);

  technicals
    .load()
    .then(() => {
      if (token !== renderToken) return; // stale — user moved on
      if (!dailyCheckedAt) dailyCheckedAt = Date.now();
      paint(ctx);
      if (criteriaFocus && document.activeElement === document.body) ctx.root.querySelector(criteriaFocus)?.focus({ preventScroll: true });
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

function loadingHtml(subview) {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    ${subview === 'momentum-scanner' || subview === 'technical-scanner' ? '' : `<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>`}
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function extraScopeTickers(scope, ctx) {
  return scopeTickers(scope, coverage.holdings()) ||
    new Set(scopeLists.apply('universe', ctx?.data?.universe || []).map(row => row.ticker));
}

function paint(ctx) {
  tableOff?.(); tableOff = null;
  const scrollTop = ctx.root.closest('main')?.scrollTop;
  const pageY = window.scrollY;
  const active = ctx.root.contains(document.activeElement) ? document.activeElement : null;
  const selection = active?.selectionStart;
  const selectionEnd = active?.selectionEnd, selectionDirection = active?.selectionDirection;
  const selector = active?.matches('input[type="search"]') ? 'input[type="search"]'
    : active?.matches('[data-row-open]') ? `[data-row-open="${CSS.escape(active.dataset.rowOpen)}"]`
    : active?.getAttribute('placeholder') ? `input[placeholder="${CSS.escape(active.getAttribute('placeholder'))}"]` : null;
  const view = {
    'strong-breakouts': renderStrongBreakouts,
    'technical-scanner': renderScanner,
    'momentum-scanner': renderMomentumScanner,
    'fii-accumulation': renderFiiAccumulation,
  }[ctx.subview] || renderMomentumScanner;
  // The Momentum Scanner is a universe-wide discovery tool: it ALWAYS scans the full
  // Nifty 500 + book universe, regardless of the global Portfolio / Watchlist scope, so the
  // reader never has to switch scope to screen the whole market. The other sub-views stay scoped.
  const scope = view === renderMomentumScanner ? 'universe' : ctx.scope;
  const rows = filterByScope(live.decorate(technicals.all(), extraScopeTickers(scope, ctx)), scope, coverage.holdings(), s => s.company.ticker);

  view(ctx, rows);
  if (scrollTop != null) ctx.root.closest('main').scrollTop = scrollTop;
  window.scrollTo(0, pageY);
  if (selector) { const control = ctx.root.querySelector(selector); control?.focus({preventScroll:true}); if (selection != null) control?.setSelectionRange(selection, selectionEnd ?? selection, selectionDirection || 'none'); }
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
function cmpCell(c) {
  const info = live.priceInfo(c);
  return `<span class="font-semibold text-slate-800" data-cmp="${escapeHtml(c.ticker)}">${info.price == null ? '—' : formatRupee(info.price, {decimals:2})}</span> ${info.change == null ? '' : toneSpan(`${info.change > 0 ? '+' : ''}${Number(info.change).toFixed(2)}%`, info.change >= 0 ? 'pos' : 'neg')}
    <div class="text-[10px] ${info.stale ? 'text-amber-700' : 'text-slate-500'}">${escapeHtml(info.label)}</div>`;
}

// Every scored row feeds the same score + signals shape into scoreTable.
const scoreOf = (s) => ({
  points: fmtPoints(s.totalPoints),
  max: s.totalMax,
  pct: s.scorePct,
  redFlag: s.hardFails.length ? s.hardFails.join(', ') : null,
});
const signalsOf = (s) => s.breakdown.map((b) => ({ label: `${b.label} (${fmtPoints(b.points)}/${b.max})`, status: b.status }));

// scoreTable accessors are shared across all three sub-views.
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

// Kept for consumers of the old age helper; no completeness claim is made from it.
export function freshnessOf(generatedAt, now = Date.now()) {
  const ts = generatedAt ? new Date(generatedAt) : null;
  return !ts || Number.isNaN(ts.getTime()) ? {state:'unknown',ts:null} : {state:now-ts <= 72*3600000 ? 'live':'stale',ts};
}
function livePill() {
  const expected = scopeTickers(ctxRef?.scope, coverage.holdings());
  const tickers = expected ? [...expected] : filterByScope(live.decorate(technicals.all(), extraScopeTickers(ctxRef?.scope, ctxRef)), 'universe', null, s => s.company.ticker).map(s => s.company.ticker);
  const health = live.coverageFor(tickers);
  const label = !live.snapshot() ? 'Current prices unavailable' : `${health.partial ? 'Partial update' : 'Prices checked'} · ${health.checked}/${health.total}`;
  return {html:`<span data-live-info class="rounded-full px-3 py-1 text-xs ${health.partial ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-700'}" title="Last completed check: ${escapeHtml(live.stamp(health.checkedAt))}">${escapeHtml(label)}</span>`,wire() {}};
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
  const state = readChipState(ctx.params || {}, TECHNICAL_DEFAULTS, TECHNICAL_FILTERS);
  const counts = chipCounts(rows, TECHNICAL_FILTERS, state);
  const filtered = rows.filter(row => Object.values(TECHNICAL_FILTERS).every(group => group.test(row, state[group.param])));
  const scored = filtered.filter((s) => !s.tickerError);
  const maxPoints = scored[0]?.totalMax ?? 24;

  const pill = livePill({
    facts: [
      { label: 'Universe', value: formatNumber(rows.length), note: 'companies scored' },
      { label: 'Scoring method', value: `${ACTIVE_RULES.length} / ${ACTIVE_RULES.length}`, note: 'active rules' },
      { label: 'Max score', value: `${maxPoints} pts`, note: 'all rules active' },
    ],
    more: { label: 'How the 16-rule score works', open: () => openModal(scoringHelpModalBody(), { size: 'wide' }) },
  });

  const table = scoreTable({
    ...tableBase(filtered, ctx),
    rowActionLabel: (s) => `Open technical details for ${s.company.name || s.company.ticker}`,
    // `?company=` from a citation or an AI Alerts card opens the scanner searched for it.
    initialView: tableViews.get(ctx.subview) || (ctx.params?.company ? { q: String(ctx.params.company).trim().toUpperCase() } : null),
    showScore: true,
    score: scoreOf,
    showSignals: true,
    signals: signalsOf,
    columns: [
      // Sort on what the cell SHOWS. Once a live quote is on screen, sorting by the EOD close
      // would order the column by numbers the reader can no longer see.
      { label: 'CMP', get: (s) => cmpCell(s.company), html: true, align: 'right', sortValue: (s) => live.priceInfo(s.company).price ?? -1 },
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
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${pill.html}${scopeSummary({ scope: ctx.scope, count: filtered.length, noun: 'companies', book: coverage.meta() })}</div>`,
    })}
    ${chipBar(TECHNICAL_FILTERS, state, counts)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${filtered.length} of ${rows.length}</span> companies match these filters.</div>
    ${table.html}
    ${legendStrip({ note: `Scored from Muns API daily OHLCV plus NSE delivery data. ${m?.failures || 0} of ${m?.company_count || 0} companies have no usable price history and score 0 of 0.` })}
  `;

  pill.wire(ctx.root);
  tableViews.set(ctx.subview, table.view);
  tableOff = table.wire(ctx.root);

  wireChipBar(ctx.root, TECHNICAL_FILTERS, state, (param, next) => {
    ctx.setParams({ ...(ctx.params || {}), [param]: next.join(',') });
  });
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
  ...TECHNICAL_FILTERS,
};

// Defaults: all of everything. Nothing on this sub-view is narrowed until the reader narrows it.
const BREAKOUT_DEFAULTS = { bo: 'all', ...TECHNICAL_DEFAULTS };

// AN ID NO GROUP OFFERS FALLS BACK TO THAT GROUP'S DEFAULT, because the alternative is a table
// that empties with no chip to explain it. An unknown id used to travel straight through to the
// predicates, where `Number('invalid')` is NaN and every `>=` against it is false — so `?near=
// invalid` drew ZERO rows while the chip bar, which marks a chip active by matching its own option
// ids, highlighted nothing at all. A control that disagrees with what is drawn is the failure this
// file's own `trend` group already guards against in its predicate ("an id this group no longer
// knows widens the view rather than silently emptying it"); doing it once here covers every group,
// including any added later. A retired id that `aliases` still maps keeps its meaning.
function readChipState(params, defaults, groups = null) {
  const groupFor = (param) => Object.values(groups || {}).find((g) => g.param === param) || null;
  const state = {};
  for (const [key, def] of Object.entries(defaults)) {
    const raw = params[key];
    const group = groupFor(key);
    const ids = (raw == null || raw === '' ? def : String(raw)).split(',')
      .map((id) => group?.aliases?.[id] || id);
    const known = group ? ids.filter((id) => group.options.some((option) => option.id === id)) : ids;
    state[key] = known.length ? known : def.split(',');
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
          <span class="w-32 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400"${g.description ? ` title="${escapeHtml(g.description)}"` : ''}>${escapeHtml(g.label)}</span>
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

// Which measurement a row's grade came from — see `gradeFor` in data/breakout-live.js. A grade
// with no `grade_source` is the daily file's own, reached by a row with no usable quote at all.
const gradeSourceOf = (s) => (s.company.consolidation_breakout?.grade_source === 'capture' ? 'capture' : 'daily');
const gradedOn = (s) => s.company.consolidation_breakout?.graded_on || s.company.price_date || null;
// "the 2026-09-08 close" for one date; "their last completed daily close (2026-09-04 to 2026-09-08)"
// for several — the daily file's rows are not all on one session, because Yahoo publishes late.
function gradeDatesPhrase(rows) {
  const dates = [...new Set(rows.map(gradedOn).filter(Boolean))].sort();
  if (!dates.length) return 'their last completed daily close';
  if (dates.length === 1) return `the ${dates[0]} close`;
  return `their last completed daily close (${dates[0]} to ${dates.at(-1)})`;
}
function gradeNote(s) {
  if (!s.company.consolidation_breakout || gradeSourceOf(s) === 'capture') return '';
  const on = gradedOn(s);
  return `<div class="text-[10px] text-amber-700" data-grade-source="daily" title="Today's price capture carries no 30-session base for this company, so the grade is the completed daily close${on ? ` of ${escapeHtml(on)}` : ''}.">Graded at ${on ? escapeHtml(on) : 'last daily'} close</div>`;
}

function renderStrongBreakouts(ctx, rows) {
  const state = readChipState(ctx.params || {}, BREAKOUT_DEFAULTS, BREAKOUT_FILTERS);
  const withBreakout = rows.filter((s) => s.company.consolidation_breakout);
  // Rows graded at a daily close rather than on today's capture, and rows with no base at all.
  // Both are stated under the chips: a company that leaves this view has to leave a trace.
  const dailyGraded = withBreakout.filter((s) => gradeSourceOf(s) === 'daily');
  const ungraded = rows.length - withBreakout.length;
  const narrowed = Object.entries(state).some(([k, v]) => v.join(',') !== BREAKOUT_DEFAULTS[k]);

  // Live counts per chip: how many rows would remain if that chip alone were toggled on,
  // holding the other groups at their current setting.
  const counts = chipCounts(withBreakout, BREAKOUT_FILTERS, state);

  const filtered = withBreakout
    .filter((s) => Object.values(BREAKOUT_FILTERS).every((g) => g.test(s, state[g.param])))
    // RANKED ON THE SCORE ALONE. It used to lead on breakout quality and break ties on the score,
    // which put a "Weak base" above a stronger-scoring row and made the ranking unreadable from the
    // columns left on screen once the Quality column came off. The quality is still what the chip
    // filters select on — it decides WHICH rows are here, and the score decides their order.
    .sort((a, b) => b.totalPoints - a.totalPoints);

  const strongCount = filtered.filter((s) => s.company.consolidation_breakout?.quality === 'strong').length;
  const basingCount = withBreakout.filter((s) => s.company.consolidation_breakout?.quality === 'no_breakout').length;

  const pill = livePill({
    facts: [
      { label: 'Breakout candidates', value: formatNumber(filtered.length), note: `of ${withBreakout.length} with a base` },
      { label: 'Strong breakouts', value: formatNumber(strongCount), note: 'tight base + volume' },
      {
        label: 'Filters active',
        value: Object.entries(state).filter(([k, v]) => v.join(',') !== BREAKOUT_DEFAULTS[k]).length || '—',
        note: 'chips reflected in the URL',
      },
    ],
    bodyHtml: `<h3 class="mb-1 text-xs font-bold uppercase tracking-wider text-indigo-700">How breakout quality is graded</h3><p>The base is the prior 30 trading days (≈ 6 weeks), excluding today.</p>
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
  });

  const table = scoreTable({
    initialView: tableViews.get(ctx.subview) || null,
    ...tableBase(filtered, ctx),
    // An empty table under chips the reader never touched is not "your filters": it is the answer.
    emptyMessage: narrowed
      ? 'No companies match your filters.'
      : withBreakout.length
        ? `No breakouts: none of the ${formatNumber(withBreakout.length)} ${withBreakout.length === 1 ? 'company' : 'companies'} with a base is above its 30-session base high.`
        : 'No company in this scope has a 30-session base to grade against.',
    showScore: true,
    score: scoreOf,
    columns: [
      { label: 'Base range %', get: (s) => `${num(s.company.consolidation_breakout?.base_range_pct, 1)}%`, align: 'right', sortValue: (s) => s.company.consolidation_breakout?.base_range_pct ?? 999 },
      { label: 'Base high', get: (s) => `<span class="text-slate-700">${escapeHtml(formatRupee(s.company.consolidation_breakout?.base_max, { decimals: 0 }))}</span>${gradeNote(s)}`, html: true, align: 'right', sortValue: (s) => s.company.consolidation_breakout?.base_max ?? 0 },
      { label: 'CMP', get: (s) => cmpCell(s.company), html: true, align: 'right', sortValue: (s) => live.priceInfo(s.company).price ?? 0 },
      { label: 'Volume ratio', get: (s) => volRatioCell(s.company.consolidation_breakout?.today_volume_ratio), html: true, align: 'right', sortValue: (s) => s.company.consolidation_breakout?.today_volume_ratio ?? 0 },
      { label: '52W distance', get: (s) => distanceCell(s.company.high_proximity_pct), html: true, align: 'right', sortValue: (s) => (s.company.high_proximity_pct == null ? 999 : (1 - s.company.high_proximity_pct) * 100) },
    ],
    initialSort: null, // pre-sorted by score
    exportName: `sattva-breakouts-${todayStamp()}`,
    onExport: (visible, filename) => runExport(visible, filename),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Companies breaking out of a 6-week base, ranked by daily technical score.',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${pill.html}${scopeSummary({ scope: ctx.scope, count: filtered.length, noun: 'candidates', book: coverage.meta() })}</div>`,
    })}
    ${chipBar(BREAKOUT_FILTERS, state, counts)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${filtered.length} of ${withBreakout.length}</span> companies with a detectable base match these filters.${
      dailyGraded.length
        ? ` <span data-daily-graded="${dailyGraded.length}">${formatNumber(dailyGraded.length)} of them ${dailyGraded.length === 1 ? 'is' : 'are'} graded at ${escapeHtml(gradeDatesPhrase(dailyGraded))} because today's price capture carries no 30-session base for ${dailyGraded.length === 1 ? 'it' : 'them'}.</span>`
        : ''
    }${
      ungraded
        ? ` <span data-ungraded="${ungraded}">${formatNumber(ungraded)} ${ungraded === 1 ? 'has' : 'have'} no base from either source and cannot be graded.</span>`
        : ''
    }</div>
    ${table.html}
    ${legendStrip()}
  `;

  pill.wire(ctx.root);
  tableViews.set(ctx.subview, table.view);
  tableOff = table.wire(ctx.root);
  wireChipBar(ctx.root, BREAKOUT_FILTERS, state, (param, next) => {
    ctx.setParams({ ...(ctx.params || {}), [param]: next.join(',') });
  });
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
  ...TECHNICAL_FILTERS,
};
const FII_DEFAULTS = { side: 'fii', mag: '0', ...TECHNICAL_DEFAULTS };

function renderFiiAccumulation(ctx, rows) {
  const state = readChipState(ctx.params || {}, FII_DEFAULTS, FII_FILTERS);
  const withHold = rows.filter((s) => !s.tickerError && (s.company.chg_fii_hold != null || s.company.chg_dii_hold != null));

  const counts = chipCounts(withHold, FII_FILTERS, state);

  const filtered = withHold
    .filter((s) => Object.values(FII_FILTERS).every((g) => g.test(s, state[g.param])))
    .sort((a, b) => (b.company.chg_fii_hold ?? -99) - (a.company.chg_fii_hold ?? -99));

  const exiting = withHold.filter((s) => (s.company.chg_fii_hold ?? 0) < -2).length;
  const avgFii = withHold.length ? withHold.reduce((s, r) => s + (r.company.chg_fii_hold ?? 0), 0) / withHold.length : 0;

  const pill = livePill({
    facts: [
      { label: 'Matching names', value: formatNumber(filtered.length), note: `of ${withHold.length} with shareholding data` },
      { label: 'Avg FII change', value: formatPct(avgFii, { decimals: 2 }), note: 'percentage points, latest period' },
      { label: 'FII exiting sharply', value: formatNumber(exiting), note: 'below −2% — flagged rose' },
    ],
    bodyHtml: `<h3 class="mb-1 text-xs font-bold uppercase tracking-wider text-indigo-700">Institutional Activity and the −2% caution</h3><p>The Institutional Activity rule scores the sum of the FII and DII holding change: net positive earns the point, net negative earns zero.</p>
               <p class="mt-2">There is one caution branch: if the combined figure is positive but <strong>FII alone is falling by more than 2%</strong>, the rule is marked mixed rather than a clean pass — domestic buying is masking a foreign exit.</p>
               <p class="mt-3 text-slate-500">Those companies are flagged in rose on this tab so the divergence is visible before you open the drill. Holding changes come from the Screener shareholding export, refreshed with the universe file.</p>`,
  });

  const table = scoreTable({
    initialView: tableViews.get(ctx.subview) || null,
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
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${pill.html}${scopeSummary({ scope: ctx.scope, count: filtered.length, noun: 'names', book: coverage.meta() })}</div>`,
    })}
    ${chipBar(FII_FILTERS, state, counts)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${filtered.length} of ${withHold.length}</span> names with shareholding data match these filters.</div>
    ${table.html}
    ${legendStrip()}
  `;

  pill.wire(ctx.root);
  tableViews.set(ctx.subview, table.view);
  tableOff = table.wire(ctx.root);
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

// ---- (d) Momentum Scanner ------------------------------------------------------------------
//
// A UNIVERSE-WIDE live technical screener. Everything a filter needs is recomputed on the
// in-progress candle from the current price by `js/scoring/momentum-live.js` — the SAME Wilder /
// EMA steps the data pipeline uses — so this view is driven entirely by the live quote feed that
// `render()` already subscribes to (`liveOff = live.watch(...) -> paint`). Nothing here re-fetches:
// a threshold or gate change rewrites the URL and re-paints from the cached daily data, exactly as
// the chip bar does.
//
// The two filters, their conditions and the client's default thresholds all live in momentum-live.js
// as DATA, built to grow toward ~40. This renderer only draws them and wires the controls.

// URL params, namespaced so they cannot collide with the other sub-views' chip params.
const MGATE_PARAM = 'mgate';
const MTHRESH_PARAM = { rsiD1: 'mrd1', rsiW: 'mrw', rsiM: 'mrm', rsiD2: 'mrd2', volMult: 'mvm', rsiD3: 'mrd3' };

function readMomentumGate(params) {
  return momentum.GATES.includes(params[MGATE_PARAM]) ? params[MGATE_PARAM] : 'strong-momentum';
}
function readMomentumThresholds(params) {
  const raw = {};
  for (const f of momentum.THRESHOLD_FIELDS) {
    const p = MTHRESH_PARAM[f.key];
    if (params[p] != null && params[p] !== '') raw[f.key] = params[p];
  }
  return momentum.clampThresholds(raw);
}

// One live recompute per company per paint, with both filters pre-evaluated so the columns, the
// gate and the sort all read the same object rather than recomputing it.
function momentumLiveFor(s, thresholds) {
  const c = s.company;
  const q = live.quote(c.ticker);
  const v = momentum.scannerIndicators(c, q, {unavailable:live.unavailable() ||
    !!live.snapshot()?.failures.some(row => row.ticker === c.ticker)});
  v.f1 = momentum.evaluateFilter('strong-momentum', v, thresholds);
  v.f2 = momentum.evaluateFilter('volume-momentum', v, thresholds);
  v.f3 = momentum.evaluateFilter('macd-crossover', v, thresholds);
  return v;
}

const mPillBase = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1';
const M_PASS = 'bg-emerald-50 text-emerald-700 ring-emerald-200';
const M_FAIL = 'bg-rose-50 text-rose-700 ring-rose-200';
const M_NA = 'bg-slate-100 text-slate-500 ring-slate-200';

function conditionTitle(result) {
  return result.conditions.map((c) => `${c.ok ? '✓' : '✕'} ${c.label}${c.live && c.live !== '—' ? ` (${c.live})` : ''}`).join(' · ');
}
function filterPill(result) {
  if (!result.evaluable) return `<span class="${mPillBase} ${M_NA}" title="${escapeHtml(result.reason)}">Exception</span>`;
  const cls = result.pass ? M_PASS : M_FAIL;
  const text = result.pass ? '✓ Pass' : '✕ Fail';
  return `<span class="${mPillBase} ${cls}" title="${escapeHtml(conditionTitle(result))}">${text}</span>`;
}
// In-progress periods use the live price; saved completed readings retain their source basis.
const provNote = v => v.historyAligned ? 'Current source observation; in-progress periods remain provisional.'
  : `Saved daily reading · ${v.indicatorDate || 'date unavailable'}.`;
function rsiLiveCell(v, tf) {
  const val = v[tf];
  if (val == null) return '<span class="text-slate-300">—</span>';
  const tone = val >= 55 && val <= 75 ? 'pos' : val > 75 ? 'warn' : val < 40 ? 'neg' : null;
  return `<span title="${escapeHtml(provNote(v))}">${toneSpan(num(val, 1), tone)}${v.historyAligned ? '' : ' · Saved'}</span>`;
}
function momentumVolCell(v, volMult) {
  if (v.volRatio10d == null) return `<span class="text-slate-300" title="No live volume yet, or no 10-day average in the daily file.">—</span>`;
  const r = v.volRatio10d;
  const title = `Today's cumulative volume so far vs the 10-day average. Threshold ≥ ${Number(volMult).toFixed(1)}×. ${provNote(v)}`;
  return `<span title="${escapeHtml(title)}">${toneSpan(`${num(r, 2)}×`, r >= volMult ? 'pos' : r >= 1 ? 'warn' : 'neg')}</span>`;
}
function macdPill(v) {
  if (v.macdBullish == null) return `<span class="${mPillBase} ${M_NA}">—</span>`;
  const title = `MACD line ${num(v.macdLine, 2)} vs signal ${num(v.macdSignal, 2)} · ${v.macdAboveZero ? 'above' : 'below'} zero. ${provNote(v)}`;
  const saved=v.historyAligned ? '' : 'Saved · ';
  if (v.freshCross) return `<span class="${mPillBase} ${M_PASS}" title="${v.historyAligned ? 'Fresh bullish crossover on the live candle.' : 'Bullish crossover in the saved daily reading.'} ${escapeHtml(title)}">${saved}⚡ Bullish</span>`;
  if (v.macdBullish) return `<span class="${mPillBase} ${M_PASS}" title="${escapeHtml(title)}">${saved}Bullish</span>`;
  return `<span class="${mPillBase} ${M_FAIL}" title="${escapeHtml(title)}">${saved}Bearish</span>`;
}
function dma20Pill(v) {
  if (v.above20dma == null) return `<span class="${mPillBase} ${M_NA}">—</span>`;
  const title = `${v.historyAligned ? 'Live price' : 'Saved daily close'} ${v.indicatorPrice == null ? '—' : v.indicatorPrice.toFixed(2)} vs 20 DMA ${v.sma20 == null ? '—' : v.sma20.toFixed(2)}. ${provNote(v)}`;
  const saved=v.historyAligned ? '' : 'Saved · ';
  if (v.above20dma) {
    const crossed = v.historyAligned && v.priorAbove20dma === false;
    return `<span class="${mPillBase} ${M_PASS}" title="${escapeHtml(title)}${crossed ? ' Crossed above today.' : ''}">${saved}${crossed ? 'Crossed ↑' : 'Above'}</span>`;
  }
  return `<span class="${mPillBase} ${M_FAIL}" title="${escapeHtml(title)}">${saved}Below</span>`;
}

function momentumControls(gate, thresholds) {
  const gates = [
    { id: 'strong-momentum', label: momentum.MOMENTUM_FILTERS['strong-momentum'].label },
    { id: 'volume-momentum', label: momentum.MOMENTUM_FILTERS['volume-momentum'].label },
    { id: 'macd-crossover', label: momentum.MOMENTUM_FILTERS['macd-crossover'].label },
    { id: 'both', label: 'Strong + Volume' },
  ];
  const gateBtns = gates
    .map((g) => `<button type="button" data-mgate="${g.id}" aria-pressed="${gate === g.id}" class="momentum-mode">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      ${escapeHtml(g.label)}</button>`)
    .join('');
  const fields = {
    rsiD1: { label: 'Daily RSI', operator: '>', condition: 'rsiD' },
    rsiW: { label: 'Weekly RSI', operator: '>', condition: 'rsiW' },
    rsiM: { label: 'Monthly RSI', operator: '>', condition: 'rsiM' },
    rsiD2: { label: 'Daily RSI', operator: '>', condition: 'rsiD' },
    volMult: { label: 'Volume / 10D avg', operator: '≥', suffix: '×', condition: 'vol' },
    rsiD3: { label: 'Daily RSI', operator: '>', condition: 'rsiD' },
  };
  // 'both' means Strong Momentum ∩ Volume + Momentum (its two groups), not every filter.
  const appliedGates = gate === 'both' ? ['strong-momentum', 'volume-momentum'] : [gate];
  const groups = gates.filter((g) => g.id !== 'both').map((g) => {
    const applied = appliedGates.includes(g.id);
    const adjustable = momentum.THRESHOLD_FIELDS.filter((f) => f.filter === g.id);
    const fixedRules = momentum.MOMENTUM_FILTERS[g.id].conditions
      .filter((c) => !adjustable.some((f) => fields[f.key].condition === c.key))
      .map((c) => escapeHtml(c.label(thresholds))).join(' · ');
    const inputs = adjustable.map((f) => {
      const display = fields[f.key];
      return `<label class="momentum-field">
        <span class="momentum-field-label">${escapeHtml(display.label)}</span>
        <span class="momentum-field-value"><span aria-hidden="true">${display.operator}</span>
          <input type="number" data-mthreshold="${f.key}" value="${thresholds[f.key]}" min="${f.min}" max="${f.max}" step="${f.step}" inputmode="decimal"
            aria-label="${escapeHtml(`${g.label} · ${f.label}`)}" />
          ${display.suffix ? `<span aria-hidden="true">${display.suffix}</span>` : ''}
        </span>
      </label>`;
    }).join('');
    return `<fieldset class="momentum-rule-group" data-momentum-group="${g.id}" data-applied="${applied}">
      <legend class="sr-only">${escapeHtml(g.label)} conditions</legend>
      <div class="momentum-group-heading"><span>${escapeHtml(g.label)}</span><span class="momentum-applied">${applied ? 'Applied' : 'Not applied'}</span></div>
      <div class="momentum-fields">${inputs}</div>
      <p class="momentum-fixed-rules"><span>Also required</span> ${fixedRules}</p>
    </fieldset>`;
  }).join('');
  return `
    <section class="momentum-controls" data-momentum-controls aria-label="Momentum scan criteria">
      <div class="momentum-controls-toolbar">
        <div class="momentum-mode-picker"><span class="momentum-controls-label" id="momentum-mode-label">Screen for</span>
          <div class="momentum-modes" data-mgate-bar role="group" aria-labelledby="momentum-mode-label">${gateBtns}</div>
        </div>
        <button type="button" data-mreset class="momentum-reset">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 6a6 6 0 1 1 .5 5M2 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Reset defaults</button>
      </div>
      <div class="momentum-rule-groups">${groups}</div>
      <p class="momentum-controls-note">${gate === 'both' ? 'Stocks must meet every condition in both groups.' : 'Stocks must meet every condition in the applied group.'}</p>
    </section>`;
}

function momentumControlFocus(root) {
  const focused = document.activeElement;
  if (!root.querySelector('[data-momentum-controls]')?.contains(focused)) return null;
  return focused.hasAttribute('data-mthreshold') ? `[data-mthreshold="${focused.dataset.mthreshold}"]`
    : focused.hasAttribute('data-mgate') ? `[data-mgate="${focused.dataset.mgate}"]`
    : focused.hasAttribute('data-mreset') ? '[data-mreset]' : null;
}

function wireMomentumControls(root, ctx) {
  let pendingThresholdChanges = {};
  const setParams = (next) => {
    if (ctx.isCancelled) return;
    // A click on a mode can follow an input blur in the same frame. Commit that edit together
    // with the mode rather than dropping it when the old context becomes obsolete.
    for (const [key, value] of Object.entries(pendingThresholdChanges)) {
      if (value == null) delete next[key];
      else next[key] = value;
    }
    pendingThresholdChanges = {};
    // The shell's temporary loading cover makes the old controls inert before render runs.
    momentumFocusOnRender = momentumControlFocus(root);
    ctx.setParams(next);
  };
  root.querySelector('[data-mgate-bar]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mgate]');
    if (!btn) return;
    setParams({ ...(ctx.params || {}), [MGATE_PARAM]: btn.dataset.mgate });
  });
  root.querySelectorAll('[data-mthreshold]').forEach((input) => {
    // Commit on change (blur / Enter), not per keystroke: a mid-type re-mount would take the caret.
    input.addEventListener('change', () => {
      const p = MTHRESH_PARAM[input.dataset.mthreshold];
      pendingThresholdChanges[p] = input.value === '' ? null : String(input.value);
      // Let blur/Tab finish moving focus before the results remount; a captured next-field
      // focus can then survive that remount. An obsolete panel must never restore its route.
      requestAnimationFrame(() => setParams({ ...(ctx.params || {}) }));
    });
  });
  root.querySelector('[data-mreset]')?.addEventListener('click', () => {
    pendingThresholdChanges = {};
    const next = { ...(ctx.params || {}) };
    delete next[MGATE_PARAM];
    for (const f of momentum.THRESHOLD_FIELDS) delete next[MTHRESH_PARAM[f.key]];
    setParams(next);
  });
}

// Excluded-stock reasons remain available in the coverage panel below the table.
function momentumExceptionReason(company, values) {
  if (company.error === 'ticker not found') return values.isLiveQuote ? 'Price history unavailable' : 'Stock code not found';
  if (/^only \d+ bars$/.test(company.error || '') ||
      (Number.isFinite(company.bars_count) && company.bars_count < 200 && !Number.isFinite(company.sma200))) return 'Not enough price history';
  if (company.error) return 'Price history unavailable';
  if (!Number.isFinite(values.price)) return 'Price unavailable';
  if (values.unavailableReason) return /different exchanges/.test(values.unavailableReason) ? 'Different price exchanges'
    : /Daily price history/.test(values.unavailableReason) ? 'Price history outdated' : 'Current price unavailable';
  if (!values.f2.evaluable && values.f1.evaluable) return values.prevClose == null ? 'Previous close unavailable' : 'Volume history incomplete';
  return 'Price history incomplete';
}

function momentumExceptionList(exceptions, vf) {
  const ordered = [...exceptions].sort((a, b) => (a.company.name || a.company.ticker).localeCompare(b.company.name || b.company.ticker));
  return `<div class="max-h-96 overflow-y-auto" data-momentum-exception-list>
    <table class="w-full text-left text-sm">
      <thead class="bg-slate-50"><tr><th class="p-3" scope="col">Stock</th><th class="p-3" scope="col">Reason</th><th class="p-3" scope="col">Price</th></tr></thead>
      <tbody>${ordered.map(s => `<tr class="border-b border-slate-100"><td class="p-3 font-semibold text-slate-900">${escapeHtml(s.company.name || s.company.ticker)}</td><td class="p-3">${escapeHtml(momentumExceptionReason(s.company, vf(s)))}</td><td class="p-3">${momentumPriceCell(s, vf(s))}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function momentumPriceCell(s, values) {
  if (values.isLiveQuote) return cmpCell(s.company);
  const c = s.company;
  return `<span class="font-semibold text-slate-800">${c.cmp == null ? '—' : formatRupee(c.cmp, {decimals:2})}</span>
    <div class="text-[10px] text-amber-700">Saved daily close · ${escapeHtml(c.price_date || c.bar_date || 'date unavailable')}</div>`;
}

function renderMomentumScanner(ctx, rows) {
  // A criteria change rebuilds the results. Keep the next field (after Tab), selected mode or
  // reset button focused so keyboard users can continue without starting at the page's top.
  const focusSelector = momentumControlFocus(ctx.root);
  const gate = readMomentumGate(ctx.params || {});
  const thresholds = readMomentumThresholds(ctx.params || {});
  const gateLabel = { 'strong-momentum': 'Strong Momentum', 'volume-momentum': 'Volume + Momentum', 'macd-crossover': 'MACD Crossover', both: 'Strong + Volume' }[gate];

  // One recompute per row, shared by every cell, the gate and the sort.
  const liveMap = new Map(rows.map((s) => [s.company.ticker, momentumLiveFor(s, thresholds)]));
  const vf = (s) => liveMap.get(s.company.ticker);

  const evaluable = rows.filter((s) => gate === 'both' ? vf(s).f1.evaluable && vf(s).f2.evaluable
    : gate === 'volume-momentum' ? vf(s).f2.evaluable
    : gate === 'macd-crossover' ? vf(s).f3.evaluable : vf(s).f1.evaluable);
  const exceptions = rows.filter((s) => !evaluable.includes(s));
  const passers = rows.filter((s) => momentum.passesGate(gate, vf(s), thresholds));
  // A source gap is not an empty company universe. Keep saved, dated readings searchable in
  // the existing table when no row can be evaluated; Exception pills never certify a live pass.
  const unscannable = !evaluable.length && rows.length > 0;
  const allQuotesUnavailable = rows.every(s => /Current market data/.test(vf(s).unavailableReason || ''));
  const allHistoryOutdated = rows.every(s => /Daily price history/.test(vf(s).unavailableReason || ''));
  const allQuotesCurrent = rows.every(s => vf(s).isLiveQuote);
  const exceptionNote = allQuotesUnavailable
    ? 'Saved readings are shown as exceptions while current data is unavailable.'
    : allHistoryOutdated ? 'Saved readings are shown as exceptions while daily price history is outdated.'
      : allQuotesCurrent ? 'Current prices are available, but the history required for this filter is incomplete.'
        : `${rows.every(s => !vf(s).isLiveQuote) ? 'Saved' : 'Available'} readings are shown as exceptions; see scan coverage for the missing data.`;
  const priceCell = s => momentumPriceCell(s, vf(s));

  const col = (label, build, sortValue, align = 'left') => ({ label, get: (s) => build(vf(s)), html: true, align, sortValue: (s) => sortValue(vf(s)) });

  const table = scoreTable({
    ...tableBase(unscannable ? rows : passers, ctx),
    initialView: tableViews.get(ctx.subview) || (ctx.params?.company ? { q: String(ctx.params.company).trim().toUpperCase() } : null),
    nameLabel: 'Stock',
    emptyMessage:
      exceptions.length === rows.length && rows.length
        ? 'No stocks can be scanned. See scan coverage below.'
        : 'No stocks currently meet these conditions — try relaxing a threshold above.',
    columns: [
      { label: 'Price', get: priceCell, html: true, align: 'right', sortValue: (s) => vf(s).price ?? -1 },
      col('Strong Momentum', (v) => filterPill(v.f1), (v) => (v.f1.pass ? 1 : 0)),
      col('Volume + Momentum', (v) => filterPill(v.f2), (v) => (v.f2.pass ? 1 : 0)),
      col('MACD Crossover', (v) => filterPill(v.f3), (v) => (v.f3.pass ? 1 : 0)),
      col('Volume vs 10D Avg', (v) => momentumVolCell(v, thresholds.volMult), (v) => v.volRatio10d ?? -1, 'right'),
      col('RSI Daily', (v) => rsiLiveCell(v, 'rsiDaily'), (v) => v.rsiDaily ?? -1, 'right'),
      col('RSI Weekly', (v) => rsiLiveCell(v, 'rsiWeekly'), (v) => v.rsiWeekly ?? -1, 'right'),
      col('RSI Monthly', (v) => rsiLiveCell(v, 'rsiMonthly'), (v) => v.rsiMonthly ?? -1, 'right'),
      col('MACD', (v) => macdPill(v), (v) => (v.freshCross ? 2 : v.macdBullish ? 1 : 0)),
      col('20-DMA Status', (v) => dma20Pill(v), (v) => (v.above20dma ? 1 : 0)),
    ],
    // The three filter columns carry their full names now, so let headings wrap to two lines
    // instead of forcing those columns as wide as "Volume + Momentum", and run dense padding so
    // the extra filter column still fits without the page scrolling sideways.
    wrapHeads: true,
    dense: true,
    initialSort: { key: 'RSI Daily', dir: 'desc' },
    exportName: `sattva-momentum-${todayStamp()}`,
    onExport: (visible, filename) => runMomentumExport(visible, filename, thresholds),
  });

  // The scanner is universe-wide by design (see paint), so there is no "switch to Universe"
  // hint; the count line states the full-market coverage and how many names are pending instead.
  const pendingNote = exceptions.length
    ? ` <span class="text-amber-700" title="These stocks can't be evaluated yet — the daily momentum data hasn't refreshed, or no live quote is available. See scan coverage below.">· ${formatNumber(exceptions.length)} pending</span>`
    : '';
  const universeNote = ` <span class="text-slate-400">Scanning all ${formatNumber(rows.length)} companies (Nifty 500 + the book), independent of the selected scope.</span>`;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description:
        'A live, universe-wide momentum screener — every Nifty 500 company plus the book, recomputed on the live price. Adjust the thresholds and the list re-filters instantly.',
    })}
    ${momentumControls(gate, thresholds)}
    <div class="mb-3 text-xs text-slate-500"><span class="font-semibold text-slate-700">${formatNumber(passers.length)} of ${formatNumber(evaluable.length)}</span> ${evaluable.length === 1 ? 'stock passes' : 'stocks pass'} ${escapeHtml(gateLabel)}.${pendingNote}${unscannable ? ` ${escapeHtml(exceptionNote)}` : ''}${universeNote}</div>
    ${table.html}
    <div class="mt-6 border-t border-slate-100 pt-4 text-center">
      <button type="button" data-momentum-coverage
        class="text-xs font-semibold text-slate-400 underline decoration-slate-200 underline-offset-4 transition-colors hover:text-indigo-600 hover:decoration-indigo-300">Scan coverage and excluded stocks</button>
    </div>
  `;

  ctx.root.querySelector('[data-momentum-coverage]').addEventListener('click', () => openModal(`
    <div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Scan coverage</h2>
        <button data-modal-close class="text-2xl text-slate-400" aria-label="Close">&times;</button>
      </div>
      <p class="mb-3 text-sm text-slate-600">${formatNumber(evaluable.length)} of ${formatNumber(rows.length)} stocks in this scope can be scanned for ${escapeHtml(gateLabel)}.
        ${formatNumber(exceptions.length)} ${exceptions.length === 1 ? 'stock is excluded' : 'stocks are excluded'} because the required data is unavailable.</p>
      ${exceptions.length ? momentumExceptionList(exceptions, vf) : ''}
    </div>`));
  tableViews.set(ctx.subview, table.view);
  tableOff = table.wire(ctx.root);
  wireMomentumControls(ctx.root, ctx);
  if (focusSelector) ctx.root.querySelector(focusSelector)?.focus({ preventScroll: true });
}

function runMomentumExport(visibleRows, filename, thresholds) {
  const rows = visibleRows.filter((s) => s.company);
  const vmap = new Map(rows.map((s) => [s.company.ticker, momentumLiveFor(s, thresholds)]));
  const vf = (s) => vmap.get(s.company.ticker);
  const yn = (b) => (b == null ? '' : b ? 'Yes' : 'No');
  const columns = [
    { header: 'Company', key: 'name', width: 30, get: (s) => s.company.name || '' },
    { header: 'Ticker', key: 'ticker', width: 14, get: (s) => s.company.ticker || '' },
    { header: 'Sector', key: 'sector', width: 22, get: (s) => s.company.sector || '' },
    { header: 'Price', key: 'price', width: 12, get: (s) => vf(s).price ?? null },
    { header: 'Quote source and time', key: 'quote_time', width: 40, get: (s) => vf(s).isLiveQuote ? live.priceInfo(s.company).label : `Saved daily close · ${s.company.price_date || s.company.bar_date || 'date unavailable'}` },
    { header: 'Indicator basis and date', key: 'indicator_basis', width: 45, get:s=>vf(s).historyAligned ? `Current price with history through ${vf(s).indicatorDate}` : `Saved daily reading · ${vf(s).indicatorDate || 'date unavailable'}` },
    { header: 'Filter 1 (Strong Momentum)', key: 'f1', width: 24, get: (s) => vf(s).f1.evaluable ? yn(vf(s).f1.pass) : 'Exception' },
    { header: 'Filter 2 (Volume + Momentum)', key: 'f2', width: 26, get: (s) => vf(s).f2.evaluable ? yn(vf(s).f2.pass) : 'Exception' },
    { header: 'Filter 3 (MACD Crossover)', key: 'f3', width: 24, get: (s) => vf(s).f3.evaluable ? yn(vf(s).f3.pass) : 'Exception' },
    { header: 'Volume / 10-day average', key: 'vol', width: 30, get: (s) => (vf(s).volRatio10d == null ? null : Number(vf(s).volRatio10d.toFixed(2))) },
    { header: 'RSI Daily', key: 'rsid', width: 16, get: (s) => (vf(s).rsiDaily == null ? null : Number(vf(s).rsiDaily.toFixed(2))) },
    { header: 'RSI Weekly', key: 'rsiw', width: 16, get: (s) => (vf(s).rsiWeekly == null ? null : Number(vf(s).rsiWeekly.toFixed(2))) },
    { header: 'RSI Monthly', key: 'rsim', width: 16, get: (s) => (vf(s).rsiMonthly == null ? null : Number(vf(s).rsiMonthly.toFixed(2))) },
    { header: 'MACD bullish', key: 'macd', width: 16, get: (s) => yn(vf(s).macdBullish) },
    { header: 'MACD fresh cross', key: 'xcross', width: 16, get: (s) => yn(vf(s).freshCross) },
    { header: 'Above 20 DMA', key: 'd20', width: 16, get: (s) => yn(vf(s).above20dma) },
    { header: 'Above 50 DMA', key: 'd50', width: 16, get: (s) => yn(vf(s).above50dma) },
    { header: 'Above 100 DMA', key: 'd100', width: 17, get: (s) => yn(vf(s).above100dma) },
    { header: 'Above 200 DMA', key: 'd200', width: 17, get: (s) => yn(vf(s).above200dma) },
    { header: 'Thresholds', key: 'thr', width: 60, get: () => `RSI D1>${thresholds.rsiD1}, W>${thresholds.rsiW}, M>${thresholds.rsiM}; F2 RSI D>${thresholds.rsiD2}, Vol≥${thresholds.volMult}×; F3 RSI D>${thresholds.rsiD3}, fresh MACD cross + >20 DMA` },
  ];
  exportRows({ filename, sheetName: 'Momentum Scanner', columns, rows }).then((ok) => {
    if (!ok) console.warn('[breakouts] momentum export did not complete — exceljs unavailable.');
  });
}

// ---- Excel export ----------------------------------------------------------------------------

// One row per company: identity, score, every rule's points, then the headline indicators.
function runExport(visibleRows, filename) {
  const scoredRows = visibleRows.filter((s) => s.company);
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
    { header: 'CMP', key: 'cmp', width: 12, get: (s) => live.priceInfo(s.company).price ?? null },
    { header: 'Quote source and time', key: 'quote_time', width: 40, get: s => live.priceInfo(s.company).label },
    { header: 'Daily score date', key: 'score_date', width: 16, get: s => s.company.price_date || technicals.meta()?.price_date || '' },
    { header: 'RSI 14', key: 'rsi', width: 10, get: (s) => s.company.rsi14 ?? null },
    { header: 'ADX 14', key: 'adx', width: 10, get: (s) => s.company.adx14 ?? null },
    { header: 'ATR %', key: 'atr', width: 10, get: (s) => s.company.atr14_pct ?? null },
    { header: 'Beta 1Y', key: 'beta', width: 10, get: (s) => s.company.beta_1y ?? null },
    { header: '6M return', key: 'r6m', width: 12, get: (s) => s.company.return_6m ?? null },
    { header: '6M RS vs Nifty500', key: 'rs', width: 18, get: (s) => s.company.relative_strength_6m ?? null },
    { header: '52W high', key: 'h52', width: 12, get: (s) => s.company.high_52w ?? null },
    { header: '% below 52W high', key: 'd52', width: 18, get: (s) => (s.company.high_proximity_pct == null ? null : Number(((1 - s.company.high_proximity_pct) * 100).toFixed(2))) },
    { header: 'Volume ratio', key: 'volr', width: 14, get: (s) => s.company.consolidation_breakout?.today_volume_ratio ?? null },
    // The grade leaves the page with the measurement it came from — a workbook has no amber note.
    { header: 'Breakout grade', key: 'grade', width: 14, get: (s) => s.company.consolidation_breakout?.quality ?? '' },
    { header: 'Breakout graded on', key: 'graded_on', width: 26, get: (s) => (s.company.consolidation_breakout ? `${gradeSourceOf(s) === 'capture' ? 'Capture' : 'Daily close'} · ${gradedOn(s) || 'date unavailable'}` : '') },
    { header: 'Delivery Δ (pp)', key: 'dlv', width: 16, get: (s) => s.company.delivery_trend_diff ?? null },
    { header: 'Chg FII %', key: 'fii', width: 12, get: (s) => s.company.chg_fii_hold ?? null },
    { header: 'Chg DII %', key: 'dii', width: 12, get: (s) => s.company.chg_dii_hold ?? null },
    { header: 'Above 200 DMA', key: 'dma', width: 15, get: (s) => (s.company.above_200dma == null ? '' : s.company.above_200dma ? 'Yes' : 'No') },
  ];

  exportRows({ filename, sheetName: 'Technicals', columns, rows: scoredRows }).then((ok) => {
    if (!ok) console.warn('[breakouts] export did not complete — exceljs unavailable.');
  });
}

export function destroy() {
  momentumFocusOnRender = null;
  tableOff?.(); tableOff = null;
  ctxRef = null;
  refreshOff?.(); refreshOff = null;
  dataOff?.(); dataOff = null;
  liveOff?.(); liveOff = null;
  clearInterval(dailyTimer); dailyTimer = null;
  document.removeEventListener('visibilitychange', checkDaily); window.removeEventListener('focus', checkDaily); window.removeEventListener('online', checkDaily);
  tableViews.clear();
  renderToken++;
}
