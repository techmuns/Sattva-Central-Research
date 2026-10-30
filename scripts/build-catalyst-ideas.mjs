#!/usr/bin/env node
// Build public/data/ai-catalysts.json — the prepared input of AI Recommendations.
//
// Reads ONLY files this repository already captures (public/data/…), resolves every company to one
// identity, hands each company's evidence to the catalyst engine (public/js/data/catalyst-engine.js)
// and writes the ranked ideas. No network, no model call, no credential. Run it after any capture;
// .github/workflows/catalyst-ideas-refresh.yml does that on a schedule and commits the result.
//
//   node scripts/build-catalyst-ideas.mjs            # writes public/data/ai-catalysts.json
//   CATALYST_OUT=/tmp/x.json node scripts/…          # writes elsewhere (tests, a dry run)
//
// See docs/CATALYST-ENGINE.md for the contract.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { ENGINE_VERSION, WINDOW_DAYS, prepareFiling, scoreCompany, CATALYSTS, THEMES } from '../public/js/data/catalyst-engine.js';
import { PLAYBOOK_VERSION, inferGroup } from '../public/js/data/catalyst-playbooks.js';
import { deriveMoves, periodEnd } from '../public/js/data/finology-shared.js';
import { announcementSignal } from '../public/js/data/filing-signals.js';
import { indexOntology, kpiImpactOf } from '../public/js/data/kpi-impact.js';
import { docUrl } from '../public/js/data/stockscans-shared.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'public/data');
const OUT = process.env.CATALYST_OUT || path.join(DATA, 'ai-catalysts.json');
const NOW = process.env.CATALYST_NOW ? Date.parse(process.env.CATALYST_NOW) : Date.now();
const IST = 5.5 * 3600_000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const TODAY = istDay(NOW);
const FROM = istDay(NOW - WINDOW_DAYS * 86_400_000);
const MIN_UNIVERSE_MCAP_CR = Number(process.env.CATALYST_MIN_MCAP_CR || 500);
const LIMITS = { opportunity: 260, mixed: 90, risk: 140 };

const started = Date.now();
const inputs = {};
function read(file, { optional = false } = {}) {
  const full = path.join(DATA, file);
  try {
    const raw = fs.readFileSync(full);
    return JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
  } catch (err) {
    if (optional) { inputs[file] = { ok: false, error: String(err.message).slice(0, 160) }; return null; }
    throw err;
  }
}
const note = (file, capturedAt, extra = {}) => { inputs[file] = { ok: true, capturedAt: capturedAt || null, ...extra }; };
const up = (v) => String(v || '').trim().toUpperCase();

// ---------------------------------------------------------------------------------------------
// IDENTITY — one canonical key per company: the NSE symbol, else the BSE code
// ---------------------------------------------------------------------------------------------
const companies = new Map();
const alias = new Map();
function company(key) {
  const k = alias.get(up(key)) || up(key);
  if (!k) return null;
  let c = companies.get(k);
  if (!c) { c = { ticker: k, names: [], filings: [], trades: [], investorMoves: [], brokerReports: [] }; companies.set(k, c); alias.set(k, k); }
  return c;
}
const link = (key, canonical) => { if (key && canonical && !alias.has(up(key))) alias.set(up(key), up(canonical)); };
// Names arrive from several captures; the first good one by source priority is the one printed.
const nameOf = (c, name, priority = 5) => {
  const n = String(name || '').replace(/-\$$|\$$/, '').replace(/\s+/g, ' ').trim();
  if (!n || /^\d+$/.test(n)) return;
  if (!c.names.some((x) => x.n === n)) c.names.push({ n, priority });
};
const displayName = (c) => [...c.names].sort((a, b) => a.priority - b.priority || b.n.length - a.n.length)[0]?.n || c.ticker;

const mcaps = read('market-caps.json');
note('market-caps.json', mcaps.generated_at, { companies: mcaps.entries.length });
for (const e of mcaps.entries) {
  if (!e.ticker) continue;
  const c = company(e.ticker);
  link(e.bseCode, c.ticker); link(e.isin, c.ticker);
  c.isin ||= e.isin || null; c.bseCode ||= e.bseCode || null;
  // A price older than 45 days is a suspended or illiquid line; its market cap is not current.
  const priceDay = e.cmpPriceAsOf || e.priceAsOf || null;
  const stale = priceDay && priceDay < istDay(NOW - 45 * 86_400_000);
  if (e.checkState === 'verified' && e.cr > 0 && !stale) {
    c.mcapCr = e.cr;
    if (e.cmp > 0) c.price = { cmp: e.cmp, asOf: priceDay || String(e.cmpCheckedAt || e.checkedAt || '').slice(0, 10) || null, source: 'Screener' };
  }
}
const deals = read('exchange-deals.json', { optional: true });
if (deals) {
  note('exchange-deals.json', deals.updatedAt);
  for (const [code, s] of Object.entries(deals.securityMap || {})) {
    const c = company(alias.get(up(s.ticker)) || alias.get(up(code)) || s.ticker || code);
    link(code, c.ticker); link(s.isin, c.ticker); nameOf(c, s.name, 1);
  }
}
const mcMap = read('mc-ticker-map.json').map;
const scIdToTicker = new Map();
for (const [scId, m] of Object.entries(mcMap)) {
  if (!m.ticker) continue;
  const c = company(alias.get(up(m.ticker)) || alias.get(up(m.bseId)) || m.ticker);
  link(m.bseId, c.ticker); nameOf(c, m.fullName, 3); c.mcIndustry ||= m.industry || null;
  scIdToTicker.set(scId, c.ticker);
}

const book = read('portfolio-companies.json');
note('portfolio-companies.json', book.syncedAt, { holdings: book.holdings.length });
for (const h of book.holdings) {
  if (!h.ticker) continue;
  const c = company(alias.get(up(h.ticker)) || alias.get(up(h.isin)) || h.ticker);
  link(h.isin, c.ticker); c.inBook = true; nameOf(c, h.bookName || h.name, 0); c.isin ||= h.isin || null;
}

// ---------------------------------------------------------------------------------------------
// SECTOR
// ---------------------------------------------------------------------------------------------
const ontologyPayload = read('sector-kpis.json');
note('sector-kpis.json', ontologyPayload.source?.classificationCapturedAt, { companies: Object.keys(ontologyPayload.companies).length });
const onto = indexOntology(ontologyPayload);
for (const [key, entry] of Object.entries(ontologyPayload.companies)) {
  const c = company(alias.get(up(key)) || key);
  c.group = entry.group; c.sector = entry.sector || null; c.industry = entry.industry || null; c.sectorKey = up(key);
}

// ---------------------------------------------------------------------------------------------
// PRICES AND TECHNICALS
// ---------------------------------------------------------------------------------------------
const tech = read('technicals.json');
note('technicals.json', tech.generated_at, { companies: tech.companies.length, priceDate: tech.price_date });
for (const t of tech.companies) {
  const c = company(alias.get(up(t.ticker)) || t.ticker);
  nameOf(c, t.name, 4);
  c.industry ||= t.industry || null; c.sector ||= t.sector || null;
  if (!t.error && t.cmp > 0) {
    c.technicals = t;
    c.price = { cmp: t.cmp, asOf: t.bar_date || tech.price_date, changePct: Number.isFinite(t.pct_change_today) ? t.pct_change_today : null, source: 'Exchange close' };
    const fii = Number(t.chg_fii_hold), dii = Number(t.chg_dii_hold);
    if (Number.isFinite(fii) || Number.isFinite(dii)) c.fiiDii = { change: (Number.isFinite(fii) ? fii : 0) + (Number.isFinite(dii) ? dii : 0), fii, dii, date: t.bar_date || tech.price_date };
  }
}
const quotes = read('company-quotes.json', { optional: true });
if (quotes) {
  note('company-quotes.json', quotes.generated_at);
  for (const q of quotes.rows) {
    const c = companies.get(alias.get(up(q.ticker)) || up(q.ticker));
    if (c && !c.technicals && q.cmp > 0) c.price = { cmp: q.cmp, asOf: q.price_date, changePct: q.pct_change_today ?? null, source: 'Exchange close' };
  }
}

// ---------------------------------------------------------------------------------------------
// RESULTS
// ---------------------------------------------------------------------------------------------
const earnings = read('earnings-live.json');
const quarter = String(earnings.meta?.quarter || '').replace(/FY\d{2}-(\d{2})/, 'FY$1') || null;
note('earnings-live.json', earnings.meta?.fetchedAt, { results: earnings.rows.length, quarter });
for (const r of earnings.rows) {
  if (!r.ticker) continue;
  const c = company(alias.get(up(r.ticker)) || r.ticker);
  nameOf(c, r.fullName || r.name, 3);
  c.result = { ...r, url: r.mcUrl || null };
  c.quarter = quarter;
  c.mcIndustry ||= r.sectorSlug ? r.sectorSlug.replace(/-/g, ' ') : null;
  if (!c.price && r.ltp > 0) c.price = { cmp: r.ltp, asOf: r.resultDate, changePct: r.changePct ?? null, source: 'Moneycontrol' };
}
const calendar = read('earnings-calendar.json', { optional: true });
if (calendar) {
  note('earnings-calendar.json', calendar.capturedAt);
  for (const [day, entry] of Object.entries(calendar.byDate || {})) {
    if (day < TODAY) continue;
    for (const row of entry.rows || []) {
      const t = scIdToTicker.get(row.scId);
      const c = t && companies.get(t);
      if (c && (!c.nextResult || day < c.nextResult)) c.nextResult = day;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// FILINGS — the per-company history, then the newest captures on top; one copy per document
// ---------------------------------------------------------------------------------------------
const seenDocs = new Set();
const docKey = (url, ticker, date, statement) => {
  const u = String(url || '');
  const guid = u.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf/i);
  if (guid) return guid[1].toLowerCase();
  if (u) return u.replace(/^https?:\/\//, '').toLowerCase();
  return `${ticker}|${date}|${String(statement).slice(0, 60)}`;
};
const filingCounts = { read: 0, inWindow: 0, catalysts: 0 };
function addFiling(ticker, row, source) {
  filingCounts.read++;
  const date = String(row.date || (row.publishedAt ? istDay(Date.parse(row.publishedAt)) : '')).slice(0, 10);
  if (!date || date < FROM || date > TODAY) return;
  filingCounts.inWindow++;
  const key = docKey(row.url, ticker, date, row.summary || row.headline || row.title || row.subject);
  if (seenDocs.has(key)) return;
  seenDocs.add(key);
  const prepared = prepareFiling({ ...row, date, source: row.source || source });
  if (!prepared) return;
  const c = company(alias.get(up(ticker)) || ticker);
  if (row.company) nameOf(c, row.company, 2);
  c.filings.push(prepared);
  filingCounts.catalysts++;
}

const captureDir = path.join(DATA, 'filing-capture/announcements');
let captureFiles = 0;
if (fs.existsSync(captureDir)) {
  for (const file of fs.readdirSync(captureDir)) {
    if (!file.endsWith('.json')) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(captureDir, file), 'utf8')); } catch { continue; }
    captureFiles++;
    for (const row of doc.rows || []) addFiling(doc.ticker || file.replace(/\.json$/, ''), row, row.source);
  }
}
note('filing-capture/announcements', null, { companies: captureFiles });
const bse = read('corp-announcements.json', { optional: true });
if (bse) {
  note('corp-announcements.json', bse.capturedAt, { rows: bse.rowCount });
  for (const [t, rows] of Object.entries(bse.byTicker || {})) for (const row of rows) addFiling(t, row, 'BSE');
}
const nseDir = path.join(DATA, 'nse-filings');
if (fs.existsSync(nseDir)) {
  let nseRows = 0;
  for (const file of fs.readdirSync(nseDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= FROM)) {
    const doc = JSON.parse(fs.readFileSync(path.join(nseDir, file), 'utf8'));
    for (const row of doc.rows || []) {
      if (!row.ticker) continue;
      nseRows++;
      addFiling(row.ticker, { ...row, title: row.subject, date: file.slice(0, 10) }, 'NSE');
    }
  }
  note('nse-filings', null, { rows: nseRows });
}
const screener = read('screener-announcements.json', { optional: true });
if (screener) {
  note('screener-announcements.json', screener.updatedAt, { rows: screener.rows?.length || 0 });
  for (const row of screener.rows || []) if (row.ticker) addFiling(row.ticker, { ...row, headline: row.title }, row.source || 'BSE');
}

// ---------------------------------------------------------------------------------------------
// INSIDER, PROMOTER AND DEAL DISCLOSURES
// ---------------------------------------------------------------------------------------------
const INSTITUTION = /\b(?:mutual fund|life insurance|general insurance|insurance (?:company|corporation)|pension|provident fund|sovereign|government of singapore|monetary authority|abu dhabi investment|norges|kuwait investment|qatar investment|temasek|gic\b|fidelity|vanguard|blackrock|capital group|nalanda|smallcap world|amansa|ward ferry|malabar|aif\b|alternative investment|opportunities fund|pi opportunities|infrastructure fund|growth fund|emerging markets? fund|equity fund|investment trust|morgan stanley asia|goldman sachs (?:investments|india)|nomura (?:india|singapore)|societe generale\b(?! financial)|bnp paribas arbitrage)\b/i;
const PROP = /\b(?:securities|broking|brokers?|stock(?:s)? (?:and|&)|commodit\w*|trading|tradefin|quant\w*|research|algo\w*|finsol|hitech|financial markets|marketedge|capital markets? limited|share (?:and|&) stock|wealth management|enterprises?\b)\b/i;
const superNames = [];
const si = read('super-investors.json', { optional: true });
if (si) {
  for (const inv of si.investors || []) {
    const person = String(inv.name || '').split(/\s+-\s+/).pop().trim();
    if (person.split(/\s+/).length >= 2) superNames.push({ re: new RegExp(`\\b${person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i'), name: inv.name });
  }
}
// Screener prints "3.01 crore", "8.50 lacs", or a bare rupee figure ("51,780").
const parseCr = (v) => {
  const m = String(v || '').replace(/,/g, '').match(/([\d.]+)\s*(crores?|cr|lakhs?|lacs?)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /^c/i.test(m[2] || '') ? n : /^la/i.test(m[2] || '') ? n / 100 : n / 1e7;
};
const insider = read('insider-trades.json');
note('insider-trades.json', insider.capturedAt, { rows: insider.rowCount });
const tradeAgg = new Map();
function aggregate(c, type, row, valueCr, who, source, weight = 1) {
  const key = `${c.ticker}|${type}|${type.startsWith('investor') ? who : ''}`;
  let a = tradeAgg.get(key);
  if (!a) { a = { c, type, valueCr: 0, count: 0, date: row.date, who: new Map(), url: row.url, source, weight }; tradeAgg.set(key, a); }
  a.valueCr += valueCr > 0 ? valueCr : 0; a.count++;
  if (row.date > a.date) { a.date = row.date; a.url = row.url; }
  a.who.set(who, (a.who.get(who) || 0) + (valueCr || 0));
  a.weight = Math.max(a.weight, weight);
}
const tradeFrom = istDay(NOW - 120 * 86_400_000);
for (const [t, rows] of Object.entries(insider.byTicker || {})) {
  for (const row of rows) {
    if (!row.date || row.date < tradeFrom) continue;
    const cell = row.cells || {};
    const cat = cell['Trade Category'];
    const c = company(alias.get(up(t)) || t);
    if (cell.Company) nameOf(c, cell.Company, 6);
    const tx = String(cell.Transaction || ''), mode = String(cell.Mode || ''), role = String(cell.Category || '');
    const value = parseCr(cell['Trade Value']);
    const who = String(cell.Insider || '').replace(/\s+/g, ' ').trim();
    if (cat === 'Insider trade') {
      // Promoters are the signal. Directors and KMP buying in the market is a weaker one; their
      // selling is mostly vested stock and is not read at all.
      const promoter = /promoter/i.test(role);
      if (!promoter && !/director|kmp|chairman|managing/i.test(role)) continue;
      if (/designated|employee|immediate relative/i.test(role)) continue;
      if (/pledge creation|^pledge$|invok|invocation/i.test(tx) || /creation of pledge/i.test(mode)) { aggregate(c, 'pledge', row, value, who, 'Insider disclosure'); continue; }
      if (/esop|esos|gift|inter-?se|inheritance|transmission|conversion|revoke|release/i.test(tx + ' ' + mode)) continue;
      if (/preferential|allotment/i.test(tx + ' ' + mode)) { aggregate(c, 'promoter-infusion', row, value, who, 'Insider disclosure', 0.8); continue; }
      if (/off market/i.test(mode)) continue;
      if (/^(?:acquisition|bought|buy|purchase)/i.test(tx)) aggregate(c, 'promoter-buy', row, value, who, promoter ? 'Insider disclosure' : 'Director disclosure', promoter ? 1 : 0.6);
      else if (promoter && /^(?:disposal|sold|sell|sale)/i.test(tx)) aggregate(c, 'promoter-sell', row, value, who, 'Insider disclosure');
    } else if (cat === 'Bulk deal' || cat === 'Block deal') {
      const star = superNames.find((s) => s.re.test(who));
      const inst = INSTITUTION.test(who) && !(PROP.test(who) && !/mutual fund|insurance/i.test(who));
      if (!star && !inst) continue;
      const buy = /^buy/i.test(tx);
      aggregate(c, buy ? 'investor-buy' : 'investor-exit', row, value, who, cat, star ? 1.2 : cat === 'Block deal' ? 1 : 0.8);
    }
  }
}
const fmtCr = (v) => (v >= 100 ? `₹${Math.round(v).toLocaleString('en-IN')} Cr` : v >= 1 ? `₹${v.toFixed(1)} Cr` : `₹${(v * 100).toFixed(0)} lakh`);
// PROMOTER ENTITIES TRADING WITH EACH OTHER THROUGH THE MARKET are one transfer, not a vote of
// confidence and a vote against. Where both sides exist within ~20% of each other they cancel;
// otherwise only the net side is kept, at its net value.
for (const [key, buy] of tradeAgg) {
  if (buy.type !== 'promoter-buy') continue;
  const sellKey = key.replace('|promoter-buy|', '|promoter-sell|');
  const sell = tradeAgg.get(sellKey);
  if (!sell) continue;
  const hi = Math.max(buy.valueCr, sell.valueCr), lo = Math.min(buy.valueCr, sell.valueCr);
  if (hi > 0 && lo / hi >= 0.8) { tradeAgg.delete(key); tradeAgg.delete(sellKey); continue; }
  if (buy.valueCr >= sell.valueCr) { buy.valueCr -= sell.valueCr; tradeAgg.delete(sellKey); } else { sell.valueCr -= buy.valueCr; tradeAgg.delete(key); }
}
for (const a of tradeAgg.values()) {
  const names = [...a.who.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n);
  const value = a.valueCr > 0 ? fmtCr(a.valueCr) : null;
  const trades = a.count > 1 ? ` across ${a.count} trades` : '';
  const title = a.type === 'promoter-buy' ? `${a.source === 'Director disclosure' && a.weight < 1 ? 'Directors' : 'Promoters'} bought ${value || 'shares'} in the open market${trades} (latest ${a.date})`
    : a.type === 'promoter-sell' ? `Promoters sold ${value || 'shares'} in the open market${trades} (latest ${a.date})`
      : a.type === 'pledge' ? `Promoter pledge created${trades} (latest ${a.date})`
        : a.type === 'promoter-infusion' ? `Promoter allotment${value ? ` worth ${value}` : ''}${trades} (latest ${a.date})`
          : a.type === 'investor-buy' ? `${names[0]} bought ${value || 'shares'} in a ${a.source.toLowerCase()}${trades} (latest ${a.date})`
            : `${names[0]} sold ${value || 'shares'} in a ${a.source.toLowerCase()}${trades} (latest ${a.date})`;
  a.c.trades.push({ type: a.type, date: a.date, title, url: a.url, source: a.source, valueCr: a.valueCr || null, who: names.slice(0, 2).join(', '), weight: a.weight });
}

// ---------------------------------------------------------------------------------------------
// TRACKED INVESTORS' FILED BOOKS
// ---------------------------------------------------------------------------------------------
if (si) {
  note('super-investors.json', si.capturedAt, { books: Object.keys(si.books || {}).length });
  const display = new Map((si.investors || []).map((i) => [i.slug, i.name]));
  for (const [slug, b] of Object.entries(si.books || {})) {
    if (!b?.ok || !Array.isArray(b.holdings)) continue;
    const moves = deriveMoves(b, TODAY);
    if (!moves.comparable) continue;
    const date = periodEnd(moves.latest);
    const who = display.get(slug) || b.name;
    for (const m of moves.moves) {
      if (!['new', 'added', 'trimmed', 'exited'].includes(m.action) || !m.companySlug) continue;
      const c = companies.get(alias.get(up(m.companySlug)) || up(m.companySlug));
      if (!c) continue;
      const pct = (v) => `${Number(v).toFixed(2)}%`;
      const title = m.action === 'new' ? `${who} disclosed a new ${pct(m.now)} stake (${moves.latest})`
        : m.action === 'added' ? `${who} raised stake to ${pct(m.now)} from ${pct(m.before)} (${moves.latest})`
          : m.action === 'trimmed' ? `${who} cut stake to ${pct(m.now)} from ${pct(m.before)} (${moves.latest})`
            : `${who} no longer disclosed (was ${pct(m.before)}, ${moves.latest})`;
      c.investorMoves.push({ type: ['new', 'added'].includes(m.action) ? 'investor-buy' : 'investor-exit', action: m.action, deltaPp: m.deltaPp, date, who, title });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// BROKER CALLS AND CON-CALLS
// ---------------------------------------------------------------------------------------------
const broker = read('broker-reports.json', { optional: true });
if (broker) {
  note('broker-reports.json', broker.generatedAt, { reports: broker.reports.length });
  for (const r of broker.reports) {
    if (!r.ticker || !r.rating) continue;
    const rating = up(r.rating);
    const type = /^(?:BUY|ADD|ACCUMULATE|OUTPERFORM|OVERWEIGHT|STRONG BUY)$/.test(rating) ? 'broker-buy' : /^(?:SELL|REDUCE|UNDERPERFORM|UNDERWEIGHT)$/.test(rating) ? 'broker-sell' : null;
    if (!type) continue;
    const c = companies.get(alias.get(up(r.ticker)) || up(r.ticker));
    if (!c) continue;
    const prev = up(r.previous?.rating);
    const upgrade = type === 'broker-buy' && /^(?:HOLD|NEUTRAL|REDUCE|SELL)$/.test(prev);
    const upside = Number.isFinite(Number(r.upsidePct)) ? ` · ${r.upsidePct}% upside as printed` : '';
    c.brokerReports.push({ type, broker: r.broker, date: istDay(Date.parse(r.publishedAt)), url: r.url, upsidePct: r.upsidePct ?? null, upgrade,
      title: `${r.kind === 'initiation' ? 'Initiated ' : upgrade ? `Upgraded from ${prev} to ` : ''}${rating}${upside}${r.points ? ` — ${r.points}` : ''}` });
  }
}
const concalls = read('concall-scans.json', { optional: true });
if (concalls) {
  note('concall-scans.json', concalls.meta?.fetchedAt, { calls: concalls.rows.length });
  for (const row of concalls.rows) {
    if (!row.ticker || !Array.isArray(row.tags) || !row.tags.length) continue;
    const c = companies.get(alias.get(up(row.ticker)) || up(row.ticker));
    if (!c || (c.concall && c.concall.date >= row.date)) continue;
    let url = null;
    try { url = row.ssUrl ? docUrl(row) : null; } catch {}
    c.concall = { date: row.date, tags: row.tags, url };
  }
}

// ---------------------------------------------------------------------------------------------
// SCORE
// ---------------------------------------------------------------------------------------------
const ideas = [];
let screened = 0;
const typeCounts = {};
for (const c of companies.values()) {
  if (!c.filings.length && !c.result && !c.trades.length && !c.investorMoves.length && !c.brokerReports.length) continue;
  if (!c.inBook && !(c.mcapCr >= MIN_UNIVERSE_MCAP_CR)) continue;
  screened++;
  let group = c.group || null, inferred = false;
  if (!group) { group = inferGroup(c.industry || c.mcIndustry); inferred = !!group; }
  const groupLabel = group ? onto.groups[group]?.label || group : null;
  const idea = scoreCompany({ ...c, name: displayName(c), group, groupLabel, sectorInferred: inferred, industry: c.industry || c.mcIndustry || null }, { now: NOW });
  if (!idea) continue;
  if (!c.inBook && !['opportunity', 'mixed', 'risk'].includes(idea.stance)) continue;
  if (c.inBook && idea.stance === 'watch' && idea.conviction < 8 && idea.risk < 8) continue;
  // KPIs in play: the desk's own ontology, read off the same evidence.
  const events = idea.evidence.filter((e) => e.source === 'BSE' || e.source === 'NSE' || e.source === 'BSE / NSE').map((e, i) => {
    const sig = announcementSignal({ title: e.title });
    return { id: `${idea.ticker}-${i}`, feed: 'announcements', headline: e.title, detail: '', filingRule: sig.filingRule, keywordIds: sig.keywordIds, keywords: sig.keywords, importance: sig.importance, day: e.date };
  });
  if (c.result) events.push({ id: `${idea.ticker}-result`, feed: 'earnings', metrics: { revenue: c.result.revenue, netProfit: c.result.netProfit }, resultBasis: c.result.basis, day: c.result.resultDate });
  const kpi = kpiImpactOf({ ticker: c.sectorKey || c.ticker, events }, onto);
  idea.kpis = kpi ? kpi.items.slice(0, 6).map((k) => ({ name: k.name, trigger: k.triggerLabel, value: k.value || null })) : [];
  for (const e of idea.evidence) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  ideas.push(idea);
}

const order = { opportunity: 0, mixed: 1, risk: 2, watch: 3 };
ideas.sort((a, b) => order[a.stance] - order[b.stance] || (a.stance === 'risk' ? b.risk - a.risk : b.net - a.net));
const kept = [];
const counts = { opportunity: 0, mixed: 0, risk: 0, watch: 0 };
for (const idea of ideas) {
  counts[idea.stance]++;
  if (idea.inBook || counts[idea.stance] <= (LIMITS[idea.stance] ?? Infinity)) kept.push(idea);
}
kept.forEach((idea, i) => { idea.rank = i + 1; idea.id = `${idea.ticker}:${ENGINE_VERSION}`; });

const content = { engine: ENGINE_VERSION, playbooks: PLAYBOOK_VERSION, ideas: kept };
const contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
const payload = {
  version: 2,
  stage: 'catalyst-ideas',
  engine: ENGINE_VERSION,
  playbooks: PLAYBOOK_VERSION,
  generatedAt: new Date(NOW).toISOString(),
  asOfDay: TODAY,
  windowDays: WINDOW_DAYS,
  contentHash,
  rowCount: kept.length,
  counts: { ...Object.fromEntries(Object.keys(order).map((s) => [s, kept.filter((i) => i.stance === s).length])), screened, companiesSeen: companies.size },
  coverage: {
    filingsRead: filingCounts.read, filingsInWindow: filingCounts.inWindow, filingsWithCatalysts: filingCounts.catalysts,
    minUniverseMcapCr: MIN_UNIVERSE_MCAP_CR, resultsQuarter: quarter, catalystTypes: typeCounts,
  },
  inputs,
  vocabulary: { catalysts: Object.fromEntries(Object.entries(CATALYSTS).map(([id, d]) => [id, { label: d.label, theme: d.theme, tone: d.tone, pillar: d.pillar }])), themes: THEMES },
  method: [
    'Deterministic evidence scoring over this dashboard\'s own captures; no model call, no paid source.',
    'Every catalyst quotes its filing, result, disclosed trade or printed broker call, with date and link.',
    'Ratios (order or demand against latest quarterly revenue or market cap) are derived from two source figures.',
    'Scores are evidence points, not probabilities, expected returns or price targets.',
  ],
  ideas: kept,
};

// Only write when the ideas changed, or the published copy is older than six hours (a heartbeat,
// so a quiet day still shows a recent preparation time).
let previous = null;
try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
const unchanged = previous?.contentHash === contentHash && NOW - Date.parse(previous.generatedAt) < 6 * 3600_000;
if (!unchanged) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(payload));
  fs.renameSync(`${OUT}.tmp`, OUT);
}
const summary = { written: !unchanged, out: path.relative(ROOT, OUT), ideas: kept.length, counts: payload.counts, filings: filingCounts, ms: Date.now() - started, bytes: JSON.stringify(payload).length };
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Catalyst ideas\n\n${kept.length} ideas (${payload.counts.opportunity} opportunities, ${payload.counts.mixed} mixed, ${payload.counts.risk} risks) from ${payload.counts.screened} companies screened and ${filingCounts.inWindow} filings in the ${WINDOW_DAYS}-day window. ${unchanged ? 'Unchanged — nothing written.' : 'Written.'}\n`);
}
