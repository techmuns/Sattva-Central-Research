// AI Recommendations — the catalyst engine's ideas, read the way a portfolio manager reads them.
//
// The page answers three questions in order: what is the opportunity (the headline, in the source's
// own figures), how strong is the evidence (a conviction ring and four pillar bars, with risk scored
// separately), and what proves it (every catalyst links to its filing, result or disclosure).
// Ideas are prepared on the runner (scripts/build-catalyst-ideas.mjs); this module only reads them.
// Styles are the self-contained `.rx-*` block in css/theme.css, on the shared theme tokens.
import { TAB_META } from './catalog.js';
import * as feed from '../data/ai-recommendations.js';
import { openWorkspace, openModal, scoreTable } from '../ui/screener.js';
import { escapeHtml as esc } from '../core/dom.js';
import * as refreshRegistry from '../core/refresh.js';
import { scopePossessive, scopeLabel } from '../data/scope.js';
import { readableFilingUrl } from '../data/nse-xbrl-shared.js';
import { exportSheets, todayStamp } from '../ui/export.js';

export const meta = TAB_META['ai-recommendations'];

const PAGE = 24;
const PREFS_KEY = 'sattva:ai-recommendations:view:v2';
const STANCE_TABS = [
  { id: 'opportunity', label: 'Opportunities' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'risk', label: 'Risk alerts' },
  { id: 'all', label: 'All' },
];
const SORTS = [
  { id: 'conviction', label: 'Strongest evidence' },
  { id: 'recent', label: 'Newest catalyst' },
  { id: 'orders', label: 'Order inflow vs revenue' },
  { id: 'profit', label: 'Profit growth' },
  { id: 'risk', label: 'Highest risk' },
  { id: 'mcap', label: 'Largest company' },
];
const CAPS = ['Large', 'Mid', 'Small', 'Micro'];
const THEME_HUE = { earnings: 'amber', orders: 'emerald', capacity: 'teal', approvals: 'sky', deals: 'violet', 'smart-money': 'indigo', capital: 'cyan', legal: 'rose', price: 'fuchsia' };
const PILLARS = [
  { id: 'earnings', label: 'Earnings', max: 30 },
  { id: 'growth', label: 'Catalysts', max: 40 },
  { id: 'smart', label: 'Smart money', max: 20 },
  { id: 'technical', label: 'Price', max: 10 },
];

let ctxRef = null, view = null, disposers = [], listObserver = null, tableHandle = null, paintedSignature = null;

// ---------------------------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------------------------
const time = (v) => (v && Number.isFinite(Date.parse(v)) ? `${new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST` : 'not yet confirmed');
const day = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const rupee = (v) => (Number(v) > 0 ? `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: Number(v) >= 1000 ? 0 : 2 })}` : '—');
const crore = (v) => (Number(v) > 0 ? `₹${Math.round(Number(v)).toLocaleString('en-IN')} Cr` : '—');
const signed = (v, d = 1) => (Number.isFinite(Number(v)) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Number(v)).toFixed(d)}%` : '—');
const toneOf = (v) => (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat');
const vocab = () => feed.meta().vocabulary || { catalysts: {}, themes: [] };
const labelOf = (type) => vocab().catalysts?.[type]?.label || type;
const themeOf = (type) => vocab().catalysts?.[type]?.theme || 'earnings';
const toneOfType = (type) => vocab().catalysts?.[type]?.tone ?? 0;
const themeLabel = (id) => vocab().themes?.find((t) => t.id === id)?.label || id;

function safeLink(url, label = 'Source ↗', cls = 'rx-link') {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    const href = /nseindia\.com$/.test(u.hostname) ? readableFilingUrl(u.href) : u.href;
    return `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  } catch { return ''; }
}

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ stance: view.stance, sort: view.sort, layout: view.layout })); } catch {}
}
function freshView(params = {}) {
  const prefs = readPrefs();
  return {
    stance: STANCE_TABS.some((s) => s.id === prefs.stance) ? prefs.stance : 'opportunity',
    sort: SORTS.some((s) => s.id === prefs.sort) ? prefs.sort : 'conviction',
    layout: prefs.layout === 'table' ? 'table' : 'cards',
    q: String(params.company || '').trim(), sector: '', cap: '', themes: new Set(), bookOnly: false, limit: PAGE,
  };
}

// ---------------------------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------------------------
function scoped() { return feed.forScope(ctxRef.scope); }

function matches(idea, { ignoreStance = false, ignoreThemes = false, ignoreSector = false } = {}) {
  if (!ignoreStance && view.stance !== 'all' && idea.stance !== view.stance) return false;
  if (view.stance === 'all' && !ignoreStance && idea.stance === 'watch' && ctxRef.scope === 'universe') return false;
  if (!ignoreSector && view.sector && (idea.groupLabel || 'Not classified') !== view.sector) return false;
  if (view.cap && idea.capBand !== view.cap) return false;
  if (view.bookOnly && !idea.inBook) return false;
  if (!ignoreThemes && view.themes.size && !idea.themes?.some((t) => view.themes.has(t))) return false;
  if (view.q) {
    const hay = `${idea.company} ${idea.ticker} ${idea.groupLabel || ''} ${idea.industry || ''} ${idea.headline} ${(idea.evidence || []).map((e) => e.title).join(' ')}`.toLowerCase();
    if (!view.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

const SORTERS = {
  conviction: (a, b) => (a.stance === 'risk' && b.stance === 'risk' ? b.risk - a.risk : 0) || b.net - a.net,
  recent: (a, b) => String(b.latestCatalystAt || '').localeCompare(String(a.latestCatalystAt || '')) || b.net - a.net,
  orders: (a, b) => (b.orderSummary?.toQuarterRevenue ?? (b.orderSummary?.toMcapPct ?? -1) / 100) - (a.orderSummary?.toQuarterRevenue ?? (a.orderSummary?.toMcapPct ?? -1) / 100) || b.net - a.net,
  profit: (a, b) => (b.result?.profitPct ?? -1e9) - (a.result?.profitPct ?? -1e9),
  risk: (a, b) => b.risk - a.risk,
  mcap: (a, b) => (b.mcapCr || 0) - (a.mcapCr || 0),
};
function selected() {
  return scoped().filter((i) => matches(i)).sort(SORTERS[view.sort] || SORTERS.conviction);
}

// ---------------------------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------------------------
function ring(idea) {
  const risk = idea.stance === 'risk';
  const value = Math.max(0, Math.min(100, risk ? idea.risk : Math.max(idea.net, 0)));
  const c = 2 * Math.PI * 26;
  const tone = risk ? 'risk' : idea.stance === 'mixed' ? 'mixed' : value >= 62 ? 'high' : value >= 45 ? 'strong' : 'building';
  return `<div class="rx-ring" data-tone="${tone}" title="${esc(risk ? `Risk score ${idea.risk} of 100` : `Net evidence ${idea.net}: conviction ${idea.conviction} less a share of risk ${idea.risk}`)}">
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="rx-ring-track" cx="32" cy="32" r="26"/><circle class="rx-ring-value" cx="32" cy="32" r="26" stroke-dasharray="${((value / 100) * c).toFixed(1)} ${c.toFixed(1)}"/></svg>
    <span class="rx-ring-num">${value}</span><span class="rx-ring-cap">${risk ? 'risk' : 'score'}</span></div>`;
}

function pillarBars(idea, { full = false } = {}) {
  const bars = PILLARS.map((p) => {
    const v = idea.pillars?.[p.id] ?? 0;
    return `<div class="rx-pillar"><span class="rx-pillar-label">${p.label}</span><span class="rx-bar" data-pillar="${p.id}"><i style="width:${Math.round((v / p.max) * 100)}%"></i></span><span class="rx-pillar-val">${v}<small>/${p.max}</small></span></div>`;
  });
  bars.push(`<div class="rx-pillar"><span class="rx-pillar-label">Risk</span><span class="rx-bar" data-pillar="risk"><i style="width:${idea.risk}%"></i></span><span class="rx-pillar-val">${idea.risk}<small>/100</small></span></div>`);
  return `<div class="rx-pillars${full ? ' is-full' : ''}">${bars.join('')}</div>`;
}

function themeChip(theme, { count = null, active = false, button = false } = {}) {
  const inner = `<span class="rx-dot"></span>${esc(themeLabel(theme))}${count != null ? `<b>${count}</b>` : ''}`;
  return button
    ? `<button type="button" class="rx-chip" data-hue="${THEME_HUE[theme] || 'slate'}" data-rx-theme="${esc(theme)}" aria-pressed="${active}">${inner}</button>`
    : `<span class="rx-chip" data-hue="${THEME_HUE[theme] || 'slate'}">${inner}</span>`;
}
function typeChip(type) {
  const tone = toneOfType(type);
  return `<span class="rx-type" data-hue="${tone < 0 ? 'rose' : THEME_HUE[themeOf(type)] || 'slate'}" data-tone="${tone > 0 ? 'up' : tone < 0 ? 'down' : 'flat'}">${esc(labelOf(type))}</span>`;
}
function stanceBadge(idea) {
  const text = { opportunity: 'Opportunity', mixed: 'Mixed', risk: 'Risk alert', watch: 'Watch' }[idea.stance];
  return `<span class="rx-stance" data-stance="${idea.stance}">${text}</span>`;
}

function metrics(idea) {
  const out = [];
  if (idea.price?.cmp) out.push(`<div class="rx-metric"><span>CMP</span><b>${rupee(idea.price.cmp)}</b>${Number.isFinite(idea.price.changePct) ? `<em data-tone="${toneOf(idea.price.changePct)}">${signed(idea.price.changePct, 2)}</em>` : ''}</div>`);
  if (idea.mcapCr) out.push(`<div class="rx-metric"><span>Market cap</span><b>${crore(idea.mcapCr)}</b>${idea.capBand ? `<em>${esc(idea.capBand)}</em>` : ''}</div>`);
  if (idea.result && (idea.result.profitPct != null || idea.result.profitKind)) {
    const v = idea.result.profitPct != null ? signed(idea.result.profitPct, 0) : String(idea.result.profitKind || '').replace(/-/g, ' ');
    out.push(`<div class="rx-metric"><span>${esc(idea.result.quarter || 'Latest')} profit</span><b data-tone="${toneOf(idea.result.profitPct ?? (/turnaround|narrow/.test(idea.result.profitKind) ? 1 : -1))}">${esc(v)}</b>${idea.result.revenuePct != null ? `<em>Rev ${signed(idea.result.revenuePct, 0)}</em>` : ''}</div>`);
  }
  const o = idea.orderSummary;
  if (o) {
    const ratio = o.toQuarterRevenue != null ? `${o.toQuarterRevenue.toFixed(o.toQuarterRevenue >= 10 ? 0 : 1)}× qtr rev` : o.toMcapPct != null ? `${o.toMcapPct.toFixed(1)}% of mcap` : `${o.count} filing${o.count > 1 ? 's' : ''}`;
    out.push(`<div class="rx-metric" title="Derived: total order value stated in the filings since ${esc(o.since)}, against the latest quarter's revenue (or market cap)."><span>Order inflow</span><b>${o.totalCr ? `${o.banded ? '≥' : ''}${crore(o.totalCr)}` : `${o.count} new`}</b><em>${esc(ratio)}</em></div>`);
  }
  if (idea.pricedIn) out.push(`<div class="rx-metric" title="Derived from captured closes: move from the lead catalyst's date (${esc(idea.pricedIn.from)}) to the latest close."><span>Since catalyst</span><b data-tone="${toneOf(idea.pricedIn.pct)}">${signed(idea.pricedIn.pct, 1)}</b>${idea.pricedIn.penalty > 0 ? '<em data-tone="warn">may be priced in</em>' : ''}</div>`);
  return out.length ? `<div class="rx-metrics">${out.slice(0, 5).join('')}</div>` : '';
}

function evidenceLine(e, { full = false } = {}) {
  const amount = e.amountCr ? `<span class="rx-amount">${e.amountBand ? '≥' : ''}${crore(e.amountCr)}${e.ratio != null ? ` · ${e.ratioBasis === 'revenue' ? `${Number(e.ratio).toFixed(e.ratio >= 10 ? 0 : 2)}× qtr revenue` : `${(e.ratio * 100).toFixed(e.ratio >= 0.1 ? 0 : 2)}% of mcap`}` : ''}</span>` : '';
  const link = e.url ? safeLink(e.url, '↗', 'rx-ev-link') : '';
  return `<li class="rx-ev" data-tone="${toneOfType(e.type) > 0 ? 'up' : toneOfType(e.type) < 0 ? 'down' : 'flat'}">
    <time>${day(e.date)}</time>
    <div class="rx-ev-body">${full ? typeChip(e.type) : ''}<span class="rx-ev-title"${full ? '' : ` title="${esc(e.title)}"`}>${esc(e.title)}</span>${amount}${full && e.source ? `<span class="rx-ev-src">${esc(e.source)}</span>` : ''}</div>${link}</li>`;
}

function card(idea, n) {
  // The preview adds what the headline does not already say.
  // On a risk alert the risks lead the preview; on an opportunity the supporting evidence does.
  const lean = idea.stance === 'risk' ? -1 : 1;
  const ev = (idea.evidence || []).filter((e) => e.points > 0.3 && !e.generic && !idea.headline.includes(e.title))
    .map((e, i) => ({ e, i, w: Math.sign(toneOfType(e.type)) === lean ? 0 : 1 })).sort((a, b) => a.w - b.w || a.i - b.i).slice(0, 3).map((x) => x.e);
  const chips = [...new Set([...(idea.evidence || []).filter((e) => e.points > 0.5).map((e) => e.type)])].slice(0, 5).map(typeChip).join('');
  return `<article class="rx-card" data-stance="${idea.stance}" data-rx-ticker="${esc(idea.ticker)}">
    <header class="rx-card-head">
      <span class="rx-rank">${n}</span>
      <div class="rx-id">
        <h3><button type="button" data-rx-open="${esc(idea.ticker)}">${esc(idea.company)}</button></h3>
        <div class="rx-sub"><span class="rx-ticker">${esc(idea.ticker)}</span>${idea.groupLabel ? `<span>${esc(idea.groupLabel)}${idea.sectorInferred ? ' (inferred)' : ''}</span>` : ''}${idea.inBook ? '<span class="rx-book">In portfolio</span>' : ''}${idea.verified ? '<span class="rx-verified" title="The verified-filing earnings model also selected this company">Verified filing</span>' : ''}</div>
      </div>
      ${ring(idea)}
    </header>
    <div class="rx-card-tags">${stanceBadge(idea)}<span class="rx-tier">${esc(idea.tier)}</span>${chips}</div>
    <p class="rx-headline">${esc(idea.headline)}</p>
    ${metrics(idea)}
    ${pillarBars(idea)}
    ${ev.length ? `<ul class="rx-evs">${ev.map((e) => evidenceLine(e)).join('')}</ul>` : ''}
    ${idea.risks?.length && idea.stance !== 'risk' ? `<p class="rx-risk-line"><b>Watch-out:</b> ${esc(idea.risks[0])}</p>` : ''}
    <footer class="rx-card-foot"><span>${idea.nextResult ? `Results due ${day(idea.nextResult)} · ` : ''}Latest catalyst ${day(idea.latestCatalystAt)}</span><button type="button" class="rx-open" data-rx-open="${esc(idea.ticker)}">Full thesis →</button></footer>
  </article>`;
}

// ---------------------------------------------------------------------------------------------
// the detail workspace
// ---------------------------------------------------------------------------------------------
function openIdea(ticker) {
  const idea = feed.rows().find((i) => i.ticker === ticker);
  if (!idea) return;
  const pillarNotes = {
    earnings: 'Latest filed quarter: revenue and profit growth against the year-ago quarter, operating leverage, turnarounds.',
    growth: 'Orders sized against revenue and market cap, capacity commissioned or approved, approvals, launches, deals, legal wins — weighted for this sector and decayed with age.',
    smart: 'Promoters buying in the market, tracked investors adding, institutions in bulk/block deals, credit upgrades, buybacks and broker BUY calls as printed.',
    technical: 'Trend, six-month strength against the index, base breakouts and proximity to the 52-week high.',
  };
  const thesis = () => `
    <div class="rx-ws">
      <div class="rx-ws-lead" data-stance="${idea.stance}">${stanceBadge(idea)}<span class="rx-tier">${esc(idea.tier)}</span><p>${esc(idea.headline)}</p></div>
      <div class="rx-ws-grid">
        <section class="rx-panel"><h4>Why now</h4>${idea.why?.length ? `<ul class="rx-list is-up">${idea.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="rx-muted">No supporting catalyst in the window.</p>'}</section>
        <section class="rx-panel"><h4>Risks to the thesis</h4>${idea.risks?.length ? `<ul class="rx-list is-down">${idea.risks.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="rx-muted">No legal, governance, credit, inspection or earnings risk was found in the captured filings. That is not a clean governance opinion.</p>'}</section>
        <section class="rx-panel"><h4>Sector lens · ${esc(idea.groupLabel || 'Not classified')}</h4><p>${esc(idea.lens)}</p>${idea.kpis?.length ? `<div class="rx-kpis"><span>KPIs in play</span>${idea.kpis.map((k) => `<span class="rx-kpi" title="${esc(k.trigger || '')}">${esc(k.name)}${k.value ? ` <b>${esc(k.value)}</b>` : ''}</span>`).join('')}</div>` : ''}</section>
        <section class="rx-panel"><h4>What to watch</h4><ul class="rx-list is-watch">${(idea.watch || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>
      </div>
      ${metrics(idea)}
      ${idea.verified ? `<p class="rx-note"><b>Verified filing:</b> ${esc(idea.verified.catalyst)} ${idea.verified.url ? safeLink(idea.verified.url, 'Original filing ↗') : ''}</p>` : ''}
      <p class="rx-disclaimer">Research evidence, not investment advice. No target price, probability or return forecast is made; broker targets appear only as printed. Ratios are derived from two source figures and say so.</p>
    </div>`;
  const evidence = () => `<div class="rx-ws"><ul class="rx-evs is-full">${(idea.evidence || []).map((e) => evidenceLine(e, { full: true })).join('')}</ul>
    <p class="rx-muted">Strongest evidence first. Each line is the source's own statement; an exchange twin of the same document is kept once.</p></div>`;
  const scorecard = () => `<div class="rx-ws">
      <div class="rx-score-top">${ring(idea)}<div><b>Conviction ${idea.conviction}</b> · Risk ${idea.risk} · Net ${idea.net}<p class="rx-muted">Net = conviction − 0.55 × risk${idea.pricedIn?.penalty ? ` − ${idea.pricedIn.penalty} for a ${signed(idea.pricedIn.pct, 0)} move since the lead catalyst` : ''}.</p></div></div>
      ${pillarBars(idea, { full: true })}
      <dl class="rx-defs">${PILLARS.map((p) => `<div><dt>${p.label} · ${idea.pillars?.[p.id] ?? 0}/${p.max}</dt><dd>${pillarNotes[p.id]}</dd></div>`).join('')}
        <div><dt>Risk · ${idea.risk}/100</dt><dd>Tax demands and penalties sized against market cap, auditor or CFO exits, defaults, adverse inspections, downgrades, promoter selling and pledges, and earnings declines.</dd></div></dl>
      <p class="rx-muted">Scores are evidence points, not probabilities. Every catalyst type, its weight per sector and its half-life are in public/js/data/catalyst-engine.js and catalyst-playbooks.js.</p></div>`;
  openWorkspace({
    title: idea.company,
    subtitle: [idea.ticker, idea.groupLabel, idea.industry, idea.capBand ? `${idea.capBand} cap` : null, idea.inBook ? 'In portfolio' : null].filter(Boolean).join(' · '),
    avatarName: idea.company,
    badges: [stanceBadge(idea)],
    tabs: [
      { id: 'thesis', label: 'Thesis', render: thesis },
      { id: 'evidence', label: 'Evidence', badge: idea.evidence?.length || null, render: evidence },
      { id: 'score', label: 'Scorecard', render: scorecard },
    ],
    activeTab: 'thesis',
    onTabChange: (id) => ctxRef?.setParamsQuiet?.({ ...(ctxRef.params || {}), idea: idea.ticker, view: id }),
    onClose: () => { const { idea: _i, view: _v, ...rest } = ctxRef?.params || {}; ctxRef?.setParamsQuiet?.(rest); },
  });
}

function howItWorks() {
  const m = feed.meta(), c = m.coverage || {};
  openModal(`<div class="rx-modal">
    <h2>How AI Recommendations are built</h2>
    <p>A deterministic catalyst engine reads every capture this dashboard holds — ${Number(c.filingsInWindow || 0).toLocaleString('en-IN')} exchange filings in the last ${m.windowDays || 180} days, the ${esc(c.resultsQuarter || 'latest')} results, promoter and insider disclosures, bulk and block deals, tracked investors' filed books, broker calls as printed, con-call highlights and price trends — and scores ${Number(m.counts?.screened || 0).toLocaleString('en-IN')} companies with a market cap of at least ₹${Number(c.minUniverseMcapCr || 500).toLocaleString('en-IN')} Cr (every holding is screened regardless of size).</p>
    <div class="rx-modal-grid">
      <section><h3>Four pillars</h3><ul><li><b>Earnings (30)</b> — revenue and profit growth, operating leverage, turnarounds.</li><li><b>Catalysts (40)</b> — orders sized against revenue and market cap, capacity, approvals, launches, deals, legal wins.</li><li><b>Smart money (20)</b> — promoter buying, tracked investors, institutions, credit upgrades, buybacks, broker calls.</li><li><b>Price (10)</b> — trend, relative strength, breakouts.</li></ul></section>
      <section><h3>Risk, scored separately</h3><p>Legal and tax actions (sized against market cap), auditor and CFO exits, defaults, adverse inspections, downgrades, promoter selling and pledges, and earnings declines. A strong idea with a material risk is shown as <b>Mixed</b>, not hidden.</p></section>
      <section><h3>Sector lenses</h3><p>Each of the desk's 41 sector groups has a playbook: an order is the thesis at a capital-goods company and nothing at a bank; a USFDA inspection decides a pharma plant. Weights move evidence, never create it.</p></section>
      <section><h3>What it will not do</h3><p>No target price, probability or return forecast; no model call; no paid source. Ratios are derived from two source figures. A filing the engine cannot read is not evidence of its absence.</p></section>
    </div>
    <p class="rx-muted">Prepared ${esc(time(m.generatedAt))} · browser check ${esc(time(m.browserCheckedAt))} · engine ${esc(m.engine || '')} · playbooks ${esc(m.playbooks || '')}${m.verifiedCount ? ` · ${m.verifiedCount} verified-filing ideas on this deployment` : ''}${m.error ? ` · ${esc(m.error)}` : ''}</p>
  </div>`, { size: 'wide' });
}

async function exportIdeas() {
  const rows = selected();
  const m = feed.meta();
  await exportSheets({
    filename: `ai-recommendations-${todayStamp()}`,
    banner: `AI Recommendations — deterministic catalyst evidence prepared ${time(m.generatedAt)} from exchange filings, filed results, disclosures and printed broker calls. Research evidence, not investment advice: no target price or probability is implied. Ratios are derived from two source figures.`,
    sheets: [{
      name: 'Ideas',
      columns: [
        { header: 'Rank', width: 7, get: (r) => rows.indexOf(r) + 1 },
        { header: 'Company', width: 32, get: (r) => r.company },
        { header: 'Ticker', width: 14, get: (r) => r.ticker },
        { header: 'Stance', width: 12, get: (r) => r.stance },
        { header: 'Tier', width: 16, get: (r) => r.tier },
        { header: 'Conviction', width: 11, get: (r) => r.conviction },
        { header: 'Risk', width: 8, get: (r) => r.risk },
        { header: 'Net', width: 8, get: (r) => r.net },
        { header: 'Sector', width: 20, get: (r) => r.groupLabel || '' },
        { header: 'Cap band', width: 10, get: (r) => r.capBand || '' },
        { header: 'In portfolio', width: 11, get: (r) => (r.inBook ? 'Yes' : '') },
        { header: 'CMP (₹)', width: 11, get: (r) => r.price?.cmp ?? '' },
        { header: 'Price date', width: 12, get: (r) => r.price?.asOf || '' },
        { header: 'Market cap (₹ Cr)', width: 16, get: (r) => (r.mcapCr ? Math.round(r.mcapCr) : '') },
        { header: 'Headline', width: 80, get: (r) => r.headline },
        { header: 'Why now', width: 90, get: (r) => (r.why || []).join(' | ') },
        { header: 'Risks', width: 70, get: (r) => (r.risks || []).join(' | ') },
        { header: 'Order inflow (₹ Cr, stated)', width: 16, get: (r) => r.orderSummary?.totalCr ?? '' },
        { header: 'Orders ÷ latest qtr revenue (derived)', width: 18, get: (r) => r.orderSummary?.toQuarterRevenue ?? '' },
        { header: 'Profit YoY %', width: 12, get: (r) => r.result?.profitPct ?? r.result?.profitKind ?? '' },
        { header: 'Revenue YoY %', width: 12, get: (r) => r.result?.revenuePct ?? '' },
        { header: 'Latest catalyst', width: 14, get: (r) => r.latestCatalystAt || '' },
        { header: 'Sector lens', width: 70, get: (r) => r.lens || '' },
        { header: 'What to watch', width: 70, get: (r) => (r.watch || []).join(' | ') },
        { header: 'Evidence links', width: 80, get: (r) => (r.evidence || []).filter((e) => e.url).slice(0, 6).map((e) => `${e.date} ${labelOf(e.type)}: ${e.url}`).join(' | ') },
      ],
      rows,
    }],
  });
}

// ---------------------------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------------------------
function heroHtml(all) {
  const m = feed.meta();
  const count = (s) => all.filter((i) => i.stance === s).length;
  const status = m.error ? `Latest publication could not be confirmed${m.generatedAt ? ' — retained ideas remain visible' : ''}`
    : !m.generatedAt ? 'Checking prepared ideas…' : `${m.stale ? 'Preparation overdue · ' : ''}Prepared ${time(m.generatedAt)}`;
  const stat = (n, label, tone) => `<div class="rx-hero-stat" data-tone="${tone}"><b>${Number(n || 0).toLocaleString('en-IN')}</b><span>${label}</span></div>`;
  return `<section class="rx-hero">
    <div class="rx-hero-copy">
      <p class="rx-eyebrow">Catalyst engine · ${esc(scopeLabel(ctxRef.scope))}</p>
      <h2>AI Recommendations</h2>
      <p>Companies where the filings, results and money flows point the same way — read in each sector's own terms, sized against the company, with every claim linked to its source.</p>
      <p class="rx-hero-status" data-recommendation-status>${esc(status)}</p>
    </div>
    <div class="rx-hero-stats">
      ${stat(count('opportunity'), 'Opportunities', 'up')}${stat(count('mixed'), 'Mixed', 'mixed')}${stat(count('risk'), 'Risk alerts', 'down')}
      ${stat(m.counts?.screened, 'Companies screened', 'flat')}${stat(m.coverage?.filingsInWindow, `Filings read (${m.windowDays || 180}d)`, 'flat')}
      <button type="button" class="rx-hero-how" data-recommendation-coverage>How it works</button>
    </div>
  </section>`;
}

function insightsHtml() {
  const pool = scoped().filter((i) => matches(i, { ignoreThemes: true }));
  const themeCounts = new Map();
  for (const i of pool) for (const t of i.themes || []) themeCounts.set(t, (themeCounts.get(t) || 0) + 1);
  const themes = (vocab().themes || []).filter((t) => themeCounts.get(t.id)).map((t) => themeChip(t.id, { count: themeCounts.get(t.id), active: view.themes.has(t.id), button: true })).join('');
  const sectors = new Map();
  for (const i of scoped().filter((x) => matches(x, { ignoreSector: true }))) {
    const k = i.groupLabel || 'Not classified';
    const s = sectors.get(k) || { n: 0, sum: 0 };
    s.n++; s.sum += i.stance === 'risk' ? i.risk : i.net; sectors.set(k, s);
  }
  const top = [...sectors.entries()].filter(([k]) => k !== 'Not classified').sort((a, b) => b[1].n - a[1].n || b[1].sum - a[1].sum).slice(0, 8);
  const max = Math.max(1, ...top.map(([, s]) => s.n));
  const bars = top.map(([k, s]) => `<button type="button" class="rx-sector" data-rx-sector="${esc(k)}" aria-pressed="${view.sector === k}"><span>${esc(k)}</span><i style="width:${Math.round((s.n / max) * 100)}%"></i><b>${s.n}</b></button>`).join('');
  const leaders = pool.filter((i) => i.stance !== 'watch').sort(SORTERS[view.stance === 'risk' ? 'risk' : 'conviction']).slice(0, 5)
    .map((i) => `<button type="button" class="rx-leader" data-rx-open="${esc(i.ticker)}" data-stance="${i.stance}"><span>${esc(i.company)}</span><b>${i.stance === 'risk' ? i.risk : i.net}</b></button>`).join('');
  return `<section class="rx-insights">
    <div class="rx-insight"><h3>Catalyst themes</h3><div class="rx-chips">${themes || '<span class="rx-muted">No themes in this view.</span>'}</div>
      ${leaders ? `<h3 class="rx-leaders-head">${view.stance === 'risk' ? 'Highest risk now' : 'Top conviction now'}</h3><div class="rx-leaders">${leaders}</div>` : ''}</div>
    <div class="rx-insight"><h3>Where the ${view.stance === 'risk' ? 'risks' : 'ideas'} are</h3><div class="rx-sectors">${bars || '<span class="rx-muted">No classified sectors in this view.</span>'}</div></div>
  </section>`;
}

function controlsHtml(all) {
  const sectors = [...new Set(all.map((i) => i.groupLabel || 'Not classified'))].sort();
  const counts = Object.fromEntries(STANCE_TABS.map((s) => [s.id, s.id === 'all' ? all.filter((i) => ctxRef.scope !== 'universe' || i.stance !== 'watch').length : all.filter((i) => i.stance === s.id).length]));
  return `<div class="rx-controls" data-rx-controls>
    <div class="rx-tabs" role="tablist" aria-label="Recommendation stance">${STANCE_TABS.map((s) => `<button type="button" role="tab" data-rx-stance="${s.id}" aria-selected="${view.stance === s.id}">${s.label}<b>${counts[s.id]}</b></button>`).join('')}</div>
    <div class="rx-tools">
      <label class="rx-search"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.7 1.1-1.1-3.7-3.6A5.5 5.5 0 0 0 8.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" fill="currentColor"/></svg><input type="search" data-rx-search data-table-search placeholder="Search company, sector or catalyst…" value="${esc(view.q)}" aria-label="Search recommendations"></label>
      <select data-rx-filter="sector" aria-label="Sector"><option value="">All sectors</option>${sectors.map((s) => `<option${view.sector === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select data-rx-filter="cap" aria-label="Market-cap band"><option value="">All sizes</option>${CAPS.map((c) => `<option${view.cap === c ? ' selected' : ''}>${c}</option>`).join('')}</select>
      <select data-rx-filter="sort" aria-label="Sort">${SORTS.map((s) => `<option value="${s.id}"${view.sort === s.id ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
      ${ctxRef.scope === 'universe' ? `<label class="rx-toggle"><input type="checkbox" data-rx-book${view.bookOnly ? ' checked' : ''}> Holdings only</label>` : ''}
      <div class="rx-layout" role="group" aria-label="Layout"><button type="button" data-rx-layout="cards" aria-pressed="${view.layout === 'cards'}">Cards</button><button type="button" data-rx-layout="table" aria-pressed="${view.layout === 'table'}">Table</button></div>
      <button type="button" class="rx-export" data-rx-export>Export Excel</button>
    </div>
  </div>`;
}

function emptyHtml() {
  const m = feed.meta();
  const possessive = scopePossessive(ctxRef.scope);
  const text = !m.generatedAt ? 'Ideas will appear once the catalyst engine has prepared its first publication.'
    : feed.rows().length ? `No ideas match ${possessive || 'these filters'}${view.q || view.sector || view.cap || view.themes.size ? ' with these filters' : ''}.`
      : 'No company passes the evidence checks right now.';
  return `<div class="rx-empty"><b>${esc(text)}</b><span>Try another stance tab, clear a filter, or switch the scope.</span></div>`;
}

function paintList() {
  const host = ctxRef?.root.querySelector('[data-rx-list]');
  if (!host) return;
  listObserver?.disconnect(); listObserver = null;
  tableHandle?.(); tableHandle = null;
  const rows = selected();
  ctxRef.root.querySelector('[data-rx-count]').textContent = `${rows.length.toLocaleString('en-IN')} ${rows.length === 1 ? 'idea' : 'ideas'}`;
  if (!rows.length) { host.innerHTML = emptyHtml(); return; }
  if (view.layout === 'table') {
    const table = scoreTable({
      rows, key: (r) => r.ticker, name: (r) => r.company, sub: (r) => `${r.ticker}${r.groupLabel ? ` · ${r.groupLabel}` : ''}`,
      showRank: true, showAvatar: false, showBookmarks: false, showWatchFilter: false, searchable: false, nameMaxPx: 240,
      columns: [
        { label: 'Stance', html: true, get: (r) => stanceBadge(r), sortValue: (r) => ({ opportunity: 0, mixed: 1, risk: 2, watch: 3 })[r.stance] },
        { label: 'Score', align: 'right', get: (r) => (r.stance === 'risk' ? `R ${r.risk}` : r.net), sortValue: (r) => (r.stance === 'risk' ? -r.risk : r.net) },
        { label: 'Thesis', html: true, sortable: false, get: (r) => `<div class="rx-table-thesis">${esc(r.headline)}</div>` },
        { label: 'CMP', align: 'right', get: (r) => rupee(r.price?.cmp), sortValue: (r) => r.price?.cmp || 0 },
        { label: 'Mcap', align: 'right', get: (r) => crore(r.mcapCr), sortValue: (r) => r.mcapCr || 0 },
        { label: 'Profit YoY', align: 'right', get: (r) => (r.result?.profitPct != null ? signed(r.result.profitPct, 0) : '—'), sortValue: (r) => r.result?.profitPct ?? -1e9 },
      ],
      onRowClick: (r) => openIdea(r.ticker), rowActionLabel: (r) => `Open the thesis for ${r.company}`,
    });
    host.innerHTML = table.html;
    tableHandle = table.wire(host);
    return;
  }
  const shown = rows.slice(0, view.limit);
  host.innerHTML = `<div class="rx-grid">${shown.map((r, i) => card(r, i + 1)).join('')}</div>${rows.length > shown.length ? `<div class="rx-more" data-rx-more><button type="button" data-rx-more-btn>Show ${Math.min(PAGE, rows.length - shown.length)} more of ${rows.length - shown.length}</button></div>` : ''}`;
  const sentinel = host.querySelector('[data-rx-more]');
  if (sentinel && 'IntersectionObserver' in window) {
    listObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { view.limit += PAGE; const y = window.scrollY; paintList(); window.scrollTo({ top: y }); }
    }, { rootMargin: '600px 0px' });
    listObserver.observe(sentinel);
  }
}

function paintInsights() {
  const box = ctxRef?.root.querySelector('[data-rx-insights]');
  if (box) box.innerHTML = insightsHtml();
}

function paint() {
  if (!ctxRef) return;
  const root = ctxRef.root, m = feed.meta(), all = scoped();
  const signature = `${m.generatedAt}|${m.error}|${ctxRef.scope}|${all.length}|${m.verifiedCount}`;
  const focused = root.contains(document.activeElement) && document.activeElement?.matches('[data-rx-search]')
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  if (paintedSignature === signature && root.querySelector('[data-rx-list]')) return;
  paintedSignature = signature;
  if (!m.generatedAt && !m.error && !all.length) {
    root.innerHTML = `${heroHtml(all)}<div class="rx-grid">${Array.from({ length: 6 }, () => '<div class="rx-card is-skeleton"><i></i><i></i><i></i><i></i></div>').join('')}</div>`;
    root.querySelector('[data-recommendation-coverage]')?.addEventListener('click', howItWorks);
    return;
  }
  root.innerHTML = `<div class="rx-page">${heroHtml(all)}<div data-rx-insights>${insightsHtml()}</div>${controlsHtml(all)}
    <div class="rx-list-head"><span data-rx-count></span><span class="rx-muted">${esc(ctxRef.scope === 'universe' ? `Companies with a market cap of ₹${Number(m.coverage?.minUniverseMcapCr || 500).toLocaleString('en-IN')} Cr or more, plus every holding` : `${scopeLabel(ctxRef.scope)} companies the engine found evidence for`)}</span></div>
    <div data-rx-list></div></div>`;
  wire(root);
  paintList();
  if (focused) { const input = root.querySelector('[data-rx-search]'); input?.focus({ preventScroll: true }); input?.setSelectionRange(focused.start, focused.end); }
  const wanted = ctxRef.params?.idea;
  if (wanted && !document.getElementById('workspace-overlay')?.classList.contains('is-open')) openIdea(String(wanted).toUpperCase());
}

function wire(root) {
  // The page node is replaced on every full paint, so its listeners die with it.
  const page = root.querySelector('.rx-page');
  page.querySelector('[data-recommendation-coverage]')?.addEventListener('click', howItWorks);
  page.addEventListener('click', (event) => {
    const t = event.target.closest('button');
    if (!t || !page.contains(t)) return;
    if (t.dataset.rxOpen) { openIdea(t.dataset.rxOpen); return; }
    if (t.dataset.rxStance) { view.stance = t.dataset.rxStance; view.limit = PAGE; savePrefs(); root.querySelectorAll('[data-rx-stance]').forEach((b) => b.setAttribute('aria-selected', String(b === t))); paintInsights(); paintList(); return; }
    if (t.dataset.rxTheme) { const id = t.dataset.rxTheme; view.themes.has(id) ? view.themes.delete(id) : view.themes.add(id); view.limit = PAGE; paintInsights(); paintList(); return; }
    if (t.dataset.rxSector) { view.sector = view.sector === t.dataset.rxSector ? '' : t.dataset.rxSector; const sel = root.querySelector('[data-rx-filter="sector"]'); if (sel) sel.value = view.sector; view.limit = PAGE; paintInsights(); paintList(); return; }
    if (t.dataset.rxLayout) { view.layout = t.dataset.rxLayout; savePrefs(); root.querySelectorAll('[data-rx-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); paintList(); return; }
    if (t.hasAttribute('data-rx-more-btn')) { view.limit += PAGE; paintList(); return; }
    if (t.hasAttribute('data-rx-export')) { void exportIdeas(); }
  });
  root.querySelector('[data-rx-search]')?.addEventListener('input', (e) => { view.q = e.target.value; view.limit = PAGE; paintInsights(); paintList(); });
  root.querySelectorAll('[data-rx-filter]').forEach((sel) => sel.addEventListener('change', () => {
    view[sel.dataset.rxFilter] = sel.value; view.limit = PAGE; if (sel.dataset.rxFilter === 'sort') savePrefs(); paintInsights(); paintList();
  }));
  root.querySelector('[data-rx-book]')?.addEventListener('change', (e) => { view.bookOnly = e.target.checked; view.limit = PAGE; paintInsights(); paintList(); });
}

export function render(ctx) {
  const scopeChanged = ctxRef && ctxRef.scope !== ctx.scope;
  ctxRef = ctx;
  if (!view) view = freshView(ctx.params);
  else if (ctx.params?.company && ctx.params.company !== view.q) view.q = String(ctx.params.company);
  if (scopeChanged) { view.limit = PAGE; view.sector = ''; }
  paintedSignature = null;
  if (!disposers.length) {
    disposers.push(feed.onChange(() => { paintedSignature = null; paint(); }), refreshRegistry.register('ai-recommendations', { label: 'AI Recommendations', refresh: feed.refresh }));
    const resume = () => { if (ctxRef && document.visibilityState !== 'hidden') void feed.refresh(); };
    const timer = setInterval(resume, feed.POLL_MS);
    document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume);
    disposers.push(() => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); });
  }
  paint();
  void feed.refresh();
}

export function destroy() {
  ctxRef = null; paintedSignature = null;
  listObserver?.disconnect(); listObserver = null;
  tableHandle?.(); tableHandle = null;
  for (const off of disposers.splice(0)) off();
}
