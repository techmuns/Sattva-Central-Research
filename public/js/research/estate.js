// research/estate.js — the bounded, runtime dashboard catalog behind Ask Research.
//
// Every source below is read through the same module the owning page uses. Adding a compatible
// page means adding one registry row and one evidence adapter, never teaching the assistant a
// question-specific answer. The packet always carries every catalog entry and source status; row
// samples are then selected for the current question so the model never receives a raw estate dump.
//
// THREE PHASES, IN ORDER. Every source LOADS first — in parallel, each under its own deadline. The
// question is then RESOLVED against the loaded estate, so a company name or symbol in it maps to a
// ticker the same way for every source and on every question in the session. Only then does every
// source READ its rows. Loading and reading in one step per source meant the name index depended on
// which tabs the reader happened to have visited, and "anything about IIFL Finance?" could answer
// differently on the first ask and the second.
//
// THE BUDGET IS SPENT ON ROWS, AND THAT IS ASSERTED. The rowless skeleton — fourteen statuses,
// coverages, definitions and summaries — used to be measured on the wire packet, chrome included,
// and on real data it alone exceeded the budget. So every row was pushed and immediately popped, and
// the model was told, correctly, that `includedRows` was 0 everywhere: it answered that the dashboard
// held no company data while All Alerts showed four rows for the company asked about. Nothing
// threw and the packet was under bound. The skeleton is now compact, measured on the provider's
// shape (`evidence-shared.js`), and may take at most `1 - ROW_RESERVE_SHARE` of the budget: past
// that, summaries and then coverages are dropped from the largest sources — recorded on the source
// as `trimmed` — before a single row is refused. `verify-ui.mjs` asserts against the real data that
// every ready source with rows in scope lands at least one of them.

import { whenDeferredData } from '../core/state.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import * as coverage from '../data/coverage.js';
import { filterByScope, scopeAllowsTicker } from '../data/scope.js';
import * as alerts from '../data/daily-alerts.js';
import * as aiAlerts from '../data/ai-alerts.js';
import * as earningsLive from '../data/earnings-live.js';
import { domesticFilingsEvidence } from '../data/domestic-filings.js';
import * as earningsCalendar from '../data/earnings-calendar.js';
import * as concalls from '../data/concall-scans.js';
import * as chatter from '../data/chatter-live.js';
import * as technicals from '../data/technicals.js';
import * as investors from '../data/super-investors.js';
import * as institutions from '../data/institution-holdings.js';
import { news, announcements, insider } from '../data/filings.js';
import * as marketNews from '../data/market-news.js';
import { providerEvidenceChars } from './evidence-shared.js';
import { withoutPublisherName } from '../core/source-copy.js';

export const DASHBOARD_RESEARCH_SOURCES = [
  { id: 'ai-alerts', tab: 'AI Alerts', route: '#/research/ai-alerts', description: 'The dashboard\'s deterministic seven-day company priority over All Alerts: which companies carry the most material, corroborated recent evidence.' },
  { id: 'daily-alerts', tab: 'All Alerts', route: '#/research/daily-alerts', description: 'Derived timeline across earnings, con-calls, chatter, technicals, investor activity, news, announcements and insider disclosures.' },
  { id: 'earnings-hub', tab: 'Earnings Hub', route: '#/research/earnings-hub', description: 'Reported quarterly figures, comparison periods, prices and result-date returns.' },
  { id: 'company-filings', tab: 'Earnings Hub', route: '#/research/earnings-hub?view=filings', description: 'Company document titles, periods and source links already read in Company Filings. PDF contents are not extracted.' },
  { id: 'earnings-calendar', tab: 'Earnings Hub', route: '#/research/earnings-hub', description: 'Currently loaded all-exchange scheduled-results dates and company lists.' },
  { id: 'concall', tab: 'Con-call', route: '#/research/concall', description: 'Held and scheduled earnings calls with StockScans scores, sentiment tiers and source tags.' },
  { id: 'public-chatter', tab: 'Public Chatter', route: '#/research/public-chatter', description: 'Retail mention counts and sentiment across ValuePickr, TradingQnA and Google News.' },
  { id: 'technicals', tab: 'Breakouts / Technical', route: '#/research/breakouts/technical-scanner', description: 'The dashboard\'s 16-rule technical score and its underlying market readings.' },
  { id: 'earnings-surprise', tab: 'Breakouts / Technical', route: '#/research/breakouts/earnings-surprise', description: 'Analyst consensus and earnings surprise are unavailable until a real estimates feed is connected.' },
  { id: 'super-investors', tab: 'Super Investors', route: '#/research/super-investors/superstar-investors', description: 'Filed superstar-investor holdings and quarter-on-quarter disclosed changes.' },
  { id: 'institutions', tab: 'Super Investors', route: '#/research/super-investors/institutions', description: 'Institutional shareholding patterns and AMC portfolio disclosures.' },
  { id: 'company-news', tab: 'News', route: '#/research/news', description: 'Company-specific retained news for covered symbols.' },
  { id: 'market-news', tab: 'News', route: '#/research/news', description: 'Market-wide Moneycontrol stories; intentionally not company-scopeable.' },
  { id: 'announcements', tab: 'Corp Announcements', route: '#/research/corp-announcements', description: 'BSE exchange-wide capture plus retained company/date lookups from BSE, NSE and DRHP.' },
  { id: 'insider-trades', tab: 'Insider Trades', route: '#/research/insider-trades', description: 'Insider and promoter disclosures in the upstream\'s own vocabulary.' },
];

const SOURCE_BY_ID = new Map(DASHBOARD_RESEARCH_SOURCES.map((source) => [source.id, source]));
const tabOf = (id) => SOURCE_BY_ID.get(id)?.tab || id;
const LOADER_TIMEOUT_MS = 14_000;
const DEFAULT_ROW_LIMIT = 8;
const MATCH_ROW_LIMIT = 14;

// Characters of the PROVIDER-FACING packet — see evidence-shared.js for why it is not the wire
// packet. The low-latency Muns model has an 8K-token context and JSON tokenises at roughly 3.3
// characters a token, so 13,000 characters is about 3,900 tokens of evidence; with the ~470-token
// instruction, up to 3,000 characters of history and a 768-token answer the request stays near
// 6K tokens. Measured on the shipped data, the fifteen-source skeleton is ~7,100 characters, so
// this leaves ~5,900 for rows — about twenty. Raising it buys rows at the cost of first-token
// latency. Lowering it towards the skeleton starves the rows — which is the failure
// `ROW_RESERVE_SHARE` and the suite exist to catch, and the one this file shipped with for a day.
export const RESEARCH_EVIDENCE_CHAR_BUDGET = 13_000;
// The share of the budget that rows are guaranteed. The skeleton is trimmed before a row is refused.
export const ROW_RESERVE_SHARE = 0.4;
// The score a row earns when the question named its company. Above any number of token hits, so a
// company question lists that company's rows from every source before anything else.
const COMPANY_SCORE = 8;

// Words that describe the dashboard, the scope or the shape of a question rather than anything in
// a row. "portfolio" used to be a token, and every AMC row with `disclosure: "portfolio"` was an
// exact hit for a question that merely said "my portfolio" — thirty-one matched rows about nothing.
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'agree', 'agrees', 'all', 'also', 'am', 'among', 'an', 'and', 'any',
  'anything', 'are', 'around', 'as', 'at', 'attention', 'be', 'been', 'being', 'below', 'best', 'between', 'both', 'but', 'by', 'can',
  'companies', 'company', 'compare', 'compared', 'conflict', 'conflicts', 'could', 'current', 'currently', 'dashboard', 'data', 'day',
  'days', 'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'else', 'evidence', 'every', 'few', 'find', 'for', 'from',
  'further', 'get', 'give', 'given', 'go', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'holding',
  'holdings', 'how', 'i', 'if', 'im', 'important', 'importance', 'in', 'inside', 'into', 'is', 'it', 'its', 'itself', 'ive', 'just',
  'know', 'last', 'latest', 'least', 'less', 'like', 'list', 'look', 'looking', 'make', 'many', 'me', 'might', 'month', 'months', 'more',
  'most', 'much', 'multiple', 'must', 'my', 'need', 'needs', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or',
  'other', 'our', 'ours', 'out', 'over', 'own', 'page', 'pages', 'per', 'please', 'portfolio', 'position', 'positions', 'quarter',
  'recent', 'recently', 'report', 'reports', 'research', 'same', 'see', 'share', 'shares', 'should', 'show', 'showing', 'signal',
  'signals', 'so', 'some', 'something', 'still', 'stock', 'stocks', 'strong', 'stronger', 'strongest', 'such', 'summarise', 'summarize',
  'summary', 'tab', 'tabs', 'tell', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'today', 'too', 'top', 'under', 'universe', 'until', 'up', 'us', 'very', 'versus', 'view', 'vs', 'want', 'was',
  'watchlist', 'we', 'weak', 'weaker', 'weakest', 'week', 'weeks', 'well', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'within', 'would', 'year', 'years', 'yes', 'you', 'your', 'yours',
]);

// Legal-form words a company name carries and a question does not.
const NAME_NOISE = new Set(['ltd', 'limited', 'co', 'company', 'corp', 'corporation', 'inc', 'plc', 'pvt', 'private', 'the']);
// A leading word too generic to identify a company on its own, even when only one name starts with it.
const GENERIC_LEAD = new Set(['india', 'indian', 'bharat', 'national', 'global', 'general', 'united', 'international', 'new', 'first', 'great', 'central', 'state', 'city', 'standard']);
// Symbols that are also English words. A lower-case token merely spelling one is not a company
// mention — "any idea about…" is not Vodafone Idea — unless the question also names the company or
// types the symbol in capitals.
const WORD_TICKERS = new Set(['IDEA', 'SAIL', 'GAIL', 'PAGE', 'TRENT', 'BATA', 'RAIN', 'STAR', 'PEARL', 'ZEN', 'CERA', 'BLISS', 'FINE', 'JUST', 'NEXT', 'ONE', 'MAN', 'CAN', 'VIP', 'MAX', 'RISE', 'JET', 'CLEAN', 'PRIME', 'FOCUS', 'UNITED', 'SUN', 'GEM', 'FOOD', 'LIFE', 'NEST', 'KEY', 'FIT', 'SAFE', 'SHARP', 'POLO', 'HOME', 'GLOBAL', 'INDIA', 'BANK', 'POWER', 'STEEL', 'MOTOR', 'AUTO']);

const round = (value, places = 2) => {
  if (!Number.isFinite(value)) return value ?? null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clipped = (value, max = 420) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const cleanText = (value) => String(value || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
const cleanName = (name) => cleanText(name).split(' ').filter((word) => word && !NAME_NOISE.has(word)).join(' ');

/** Epoch numbers arrive from two feeds; the model cannot read `1788357504830` as a time. */
const isoTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? new Date(value).toISOString() : null) : String(value).trim();
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  return m ? `${m[1]}${m[2] || ''}` : clipped(text, 40);
};

function queryTokens(question) {
  return [...new Set(String(question || '').toLowerCase().match(/[a-z0-9&.-]{2,}/g) || [])].filter((token) => !STOP_WORDS.has(token));
}

/**
 * Every company the loaded estate can name, one entry per ticker with every spelling seen.
 *
 * The book and the watchlist are always here; the universe file arrives with the deferred bootstrap;
 * the live feeds contribute whatever they have loaded — which, because loads run before this is
 * built, is everything that answered.
 */
function companyIndex(deferred) {
  const byTicker = new Map();
  const add = (ticker, name) => {
    const t = String(ticker || '').trim().toUpperCase();
    if (!t) return;
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    if (!byTicker.has(t)) byTicker.set(t, { ticker: t, name: n || t, aliases: new Set() });
    const entry = byTicker.get(t);
    if (!n) return;
    entry.aliases.add(n);
    if (entry.name === t || n.length > entry.name.length) entry.name = n;
  };
  for (const h of coverage.holdings()) add(h.ticker, h.name);
  for (const w of watchlist.all()) add(w.ticker, w.name);
  for (const row of Array.isArray(deferred?.universe) ? deferred.universe : []) {
    add(String(row?.['Screener URL'] || '').match(/\/company\/([^/]+)/)?.[1], row?.Company);
  }
  if (earningsLive.isLoaded()) for (const r of earningsLive.all()) add(r.ticker, r.company || r.fullName || r.name);
  if (technicals.isLoaded()) for (const s of technicals.all()) add(s.company?.ticker, s.company?.name);
  if (concalls.isLoaded()) for (const r of concalls.all()) add(r.ticker, r.name);
  if (institutions.isLoaded()) for (const fund of institutions.all()) for (const h of fund.holdings || []) add(h.ticker, h.name);
  return [...byTicker.values()].map((entry) => ({ ...entry, aliases: [...entry.aliases] }));
}

/**
 * What the question is about: its ranking tokens and the companies it names.
 *
 * Pure — the index is passed in so the suite can drive it with a fixture. A company is recognised
 * by its symbol as a token (capitals as typed, or lower-case for a symbol that is not also an
 * English word), by its cleaned name appearing as a phrase, or by a distinctive lead word that only
 * one company in the index starts with. The words a company match consumed are removed from the
 * ranking tokens, so "finance" does not go on to score every Financial Services row as a hit.
 */
export function queryPlan(question, index = [], { scope = 'universe', holdings = null } = {}) {
  const text = ` ${cleanText(question)} `;
  const tokens = queryTokens(question);
  const tokenSet = new Set(tokens);
  const capitals = new Set(String(question || '').match(/\b[A-Z][A-Z0-9&.-]+\b/g) || []);
  const leadOwners = new Map();
  const entries = index.map((entry) => {
    const ticker = String(entry?.ticker || '').toUpperCase();
    const aliases = [...new Set([entry?.name, ...(entry?.aliases || [])].map(cleanName).filter((alias) => alias.length >= 3))];
    const leads = [...new Set(aliases.map((alias) => alias.split(' ')[0]).filter((word) => word.length >= 5 && !GENERIC_LEAD.has(word)))];
    for (const lead of leads) leadOwners.set(lead, (leadOwners.get(lead) || new Set()).add(ticker));
    return { ticker, name: entry?.name || ticker, aliases, leads };
  });

  const companies = [];
  const consumed = new Set();
  for (const entry of entries) {
    if (!entry.ticker) continue;
    const lower = entry.ticker.toLowerCase();
    const bySymbol = capitals.has(entry.ticker) || (tokenSet.has(lower) && !WORD_TICKERS.has(entry.ticker));
    const phrase = entry.aliases.find((alias) => text.includes(` ${alias} `));
    const lead = !bySymbol && !phrase ? entry.leads.find((word) => tokenSet.has(word) && leadOwners.get(word)?.size === 1) : null;
    if (!bySymbol && !phrase && !lead) continue;
    if (bySymbol) consumed.add(lower);
    for (const word of (phrase || lead || '').split(' ')) if (word) consumed.add(word);
    companies.push({ ticker: entry.ticker, name: entry.name, inScope: scopeAllowsTicker(scope, entry.ticker, holdings), aliases: entry.aliases });
    if (companies.length >= 6) break;
  }

  return {
    tokens: tokens.filter((token) => !consumed.has(token)),
    companies: companies.map(({ ticker, name, inScope }) => ({ ticker, name, inScope })),
    tickers: new Set(companies.map((company) => company.ticker)),
    names: [...new Set(companies.flatMap((company) => company.aliases))],
  };
}

/** Every leaf value of a row, lower-cased — VALUES only. Keys are ours and match nothing honestly. */
function rowValues(row) {
  const out = [];
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
    else out.push(String(value).toLowerCase());
  };
  walk(row);
  return out;
}

function rowScore(row, plan) {
  let score = 0;
  const ticker = String(row?.ticker || '').toUpperCase();
  if (ticker && plan.tickers.has(ticker)) score += COMPANY_SCORE;
  if (!plan.names.length && !plan.tokens.length) return score;
  const values = rowValues(row);
  if (!score && plan.names.length) {
    const text = ` ${values.map(cleanText).join(' | ')} `;
    if (plan.names.some((name) => text.includes(` ${name} `))) score += COMPANY_SCORE;
  }
  for (const token of plan.tokens) {
    if (values.some((value) => value === token)) score += 3;
    else if (values.some((value) => value.includes(token))) score += 1;
  }
  return score;
}

/** Drop what carries nothing — null, undefined, empty strings, empty arrays and objects. `false` and `0` stay. */
function compactRow(value) {
  if (Array.isArray(value)) {
    const items = value.map(compactRow).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, compactRow(item)]).filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === undefined || value === '') return undefined;
  return value;
}

/**
 * Three tiers, in order: rows for the companies the question named (in the source's own order),
 * then token hits (best first), then the source's default ordering. `rowTiers` travels beside the
 * rows so the budget allocator can fill tier by tier across every source — a company's fourth
 * alert lands before another company's first result.
 */
function chooseRows(rows, plan, mapRow, compare = null) {
  const mapped = (rows || []).map(mapRow).filter(Boolean);
  const scored = mapped.map((row, index) => ({ row, index, score: rowScore(row, plan) }));
  const tierOf = (item) => (item.score >= COMPANY_SCORE ? 0 : item.score > 0 ? 1 : 2);
  const byDefault = (a, b) => (compare ? compare(a.row, b.row) : 0) || a.index - b.index;
  scored.sort((a, b) => tierOf(a) - tierOf(b) || (tierOf(a) === 1 ? b.score - a.score : 0) || byDefault(a, b));
  const matchedRows = scored.filter((item) => item.score > 0).length;
  const picked = scored.slice(0, matchedRows ? MATCH_ROW_LIMIT : DEFAULT_ROW_LIMIT);
  return {
    rows: picked.map((item) => compactRow(item.row) || {}),
    rowTiers: picked.map(tierOf),
    matchedRows,
    companyRows: scored.filter((item) => tierOf(item) === 0).length,
  };
}

function boundedMetadata(value, depth = 0) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return clipped(value, depth ? 200 : 240);
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedMetadata(item, depth + 1));
  if (typeof value !== 'object' || depth > 5) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedMetadata(item, depth + 1)]));
}

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** A source with its rows removed — the fixed part of the packet, before rows are allocated. */
function skeletonOf(packet = {}) {
  const rowless = (sample) => {
    const base = compactRow({
      id: sample?.id,
      tab: sample?.tab,
      route: sample?.route,
      status: sample?.status,
      error: sample?.error,
      source: clipped(sample?.source, 90),
      asOf: isoTime(sample?.asOf),
      rowCount: sample?.rowCount,
      coverage: boundedMetadata(sample?.coverage),
      definition: clipped(sample?.definition, 260),
      dataQuality: sample?.dataQuality,
      summary: boundedMetadata(sample?.summary),
      note: clipped(sample?.note, 200),
      matchedRows: sample?.matchedRows || undefined,
      companyRows: sample?.companyRows || undefined,
    }) || {};
    base.rows = [];
    base.includedRows = 0;
    return base;
  };
  const base = rowless(packet);
  if (packet?.unresolvedTopics) base.unresolvedTopics = rowless(packet.unresolvedTopics);
  return base;
}

/**
 * Keep the skeleton under its ceiling by dropping the heaviest optional metadata first — summaries,
 * then coverages, largest source first — and saying so on the source. Status, source, as-of,
 * definition and data quality are never trimmed: they are the honesty of the packet.
 */
function trimSkeleton(sources, measure, ceiling) {
  for (const field of ['summary', 'coverage']) {
    while (measure() > ceiling) {
      const victim = sources
        .filter((source) => source[field] !== undefined)
        .sort((a, b) => JSON.stringify(b[field]).length - JSON.stringify(a[field]).length)[0];
      if (!victim) break;
      delete victim[field];
      victim.trimmed = [...(victim.trimmed || []), field];
    }
  }
}

/**
 * Fit the assembled evidence to the provider budget.
 *
 * Every source keeps its status, provenance, coverage and definition first. Rows are then admitted
 * tier by tier — every source's company rows, then every source's token hits, then defaults — one
 * row per source per pass, until the next row would break the budget. Every source says how many
 * rows it has in scope and how many are present, so a row that is not shown can never be read as
 * an absent fact.
 */
export function fitEvidenceToBudget(evidence, charBudget = RESEARCH_EVIDENCE_CHAR_BUDGET) {
  const sourceInputs = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const packet = {
    generatedAt: evidence?.generatedAt || new Date().toISOString(),
    scope: evidence?.scope || 'portfolio',
    scopeDefinition: clipped(evidence?.scopeDefinition, 360),
    selection: {
      ...boundedMetadata(evidence?.selection || {}),
      evidenceCharBudget: charBudget,
      evidenceChars: 0,
      budgetMethod: 'Provider-facing characters. Every source keeps status, coverage and provenance; rows are admitted tier by tier across sources until the budget is spent.',
    },
    catalog: (evidence?.catalog || []).map((source) => ({ id: source.id, status: source.status, error: source.error || null })),
    sources: sourceInputs.map(skeletonOf),
  };
  const measure = () => providerEvidenceChars(packet);
  trimSkeleton(packet.sources, measure, Math.floor(charBudget * (1 - ROW_RESERVE_SHARE)));

  const candidates = [];
  sourceInputs.forEach((source, sourceIndex) => {
    const add = (rows, tiers, matchedRows, target) => {
      (rows || []).forEach((row, rowIndex) => {
        const tier = Array.isArray(tiers) && tiers[rowIndex] != null ? tiers[rowIndex] : rowIndex < count(matchedRows) ? 1 : 2;
        candidates.push({ sourceIndex, rowIndex, priority: tier * 1000 + rowIndex, row: boundedMetadata(row), target });
      });
    };
    add(source?.rows, source?.rowTiers, source?.matchedRows, 'rows');
    add(source?.unresolvedTopics?.rows, source?.unresolvedTopics?.rowTiers, source?.unresolvedTopics?.matchedRows, 'unresolvedTopics');
  });
  candidates.sort((a, b) => a.priority - b.priority || a.sourceIndex - b.sourceIndex || a.rowIndex - b.rowIndex);

  for (const candidate of candidates) {
    const source = packet.sources[candidate.sourceIndex];
    const sample = candidate.target === 'rows' ? source : source?.unresolvedTopics;
    if (!sample) continue;
    sample.rows.push(candidate.row);
    if (measure() > charBudget) {
      sample.rows.pop();
      continue;
    }
    sample.includedRows += 1;
  }

  packet.selection.evidenceChars = measure();
  return packet;
}

function sourcePacket(id, details) {
  const source = SOURCE_BY_ID.get(id);
  return { id, tab: source.tab, route: source.route, status: 'ready', ...details };
}

function failedPacket(id, error) {
  const source = SOURCE_BY_ID.get(id);
  return {
    id,
    tab: source.tab,
    route: source.route,
    status: 'unavailable',
    error: clipped(error?.message || error || 'This source could not be read.', 220),
    rowCount: null,
    rows: [],
  };
}

function withTimeout(promise, title) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${title} did not answer within ${Math.round(LOADER_TIMEOUT_MS / 1000)} seconds.`)), LOADER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scopeHoldings(scope) {
  if (scope === 'watchlist') return watchlist.all();
  return coverage.holdings();
}

function scopeDefinition(scope) {
  if (scope === 'portfolio') {
    const book = coverage.holdings();
    const listed = book.filter((h) => h.ticker).length;
    return `Portfolio scope: the configured book of ${book.length} companies, ${listed} with an NSE symbol; the other ${book.length - listed} lines cannot appear in any symbol-keyed feed.`;
  }
  if (scope === 'watchlist') return `Watchlist scope: the ${watchlist.size()} companies starred on this device.`;
  return 'Universe scope: the broadest company set each source currently carries.';
}

// Superstar Investors exposes company names rather than exchange symbols, so this intentionally
// mirrors that page's name-based scope predicate. Using the same twelve-character comparison keeps
// the assistant's evidence set aligned with what the reader sees in the tab.
function investorScopeFilter(scope) {
  if (scope === 'universe') {
    const removed = scopeLists.removed('universe').map((entry) => String(entry.name || '').toLowerCase()).filter(Boolean);
    if (!removed.length) return null;
    return (company) => !removed.some((name) => String(company || '').toLowerCase().includes(name.slice(0, 12)));
  }
  const names = (scope === 'watchlist' ? watchlist.all() : coverage.holdings())
    .map((entry) => String(entry.name || '').toLowerCase())
    .filter(Boolean);
  return (company) => names.some((name) => String(company || '').toLowerCase().includes(name.slice(0, 12)));
}

/** A reported metric with its sign-change class, so a null growth figure explains itself. */
function metric(m) {
  if (!m) return null;
  return { current: m.current ?? null, prior: m.prior ?? null, growthPct: m.pct ?? null, change: m.kind && m.kind !== 'normal' ? m.kind : null };
}

function earningsRow(row) {
  return {
    ticker: row.ticker || null,
    company: clipped(row.company || row.fullName || row.name, 60),
    resultDate: row.resultDate || null,
    basis: row.basis || null,
    revenueCr: metric(row.revenue),
    grossProfitCr: metric(row.grossProfit),
    netProfitCr: metric(row.netProfit),
    ltpRupees: row.ltp ?? null,
    priceChangePct: row.changePct ?? null,
    returnSinceResultPct: round(row.returnSinceResult),
    marketCapCr: round(row.marketCap),
  };
}

function technicalRow(scored) {
  const row = scored.company || {};
  return {
    ticker: row.ticker || null,
    company: clipped(row.name || row.ticker, 60),
    sector: row.sector || row.broadSector || null,
    score: { points: scored.totalPoints ?? null, max: scored.totalMax ?? null, pct: round(scored.scorePct) },
    hardFails: (scored.hardFails || []).map((item) => clipped(item.label || item.key || item, 80)).slice(0, 6),
    closeRupees: row.cmp ?? null,
    oneDayMovePct: row.pct_change_today ?? null,
    sixMonthReturnPct: Number.isFinite(row.return_6m) ? round(row.return_6m * 100) : null,
    relativeStrengthSixMonthPct: Number.isFinite(row.relative_strength_6m) ? round(row.relative_strength_6m * 100) : null,
    rsi14: row.rsi14 ?? null,
    adx14: row.adx14 ?? null,
    volumeRatio: row.volume_ratio_today ?? null,
    deliveryTrendPp: row.delivery_trend_diff ?? null,
    fiiHoldingChangePp: row.chg_fii_hold ?? null,
    above200DayAverage: row.above_200dma ?? null,
    breakout: row.consolidation_breakout?.breaks_out ?? null,
  };
}

function alertRow(row) {
  return {
    date: row.day || String(row.at || '').slice(0, 10) || null,
    time: row.time || null,
    ticker: row.ticker || null,
    company: clipped(row.company, 60),
    feed: row.feedLabel || row.feed || null,
    direction: row.direction || null,
    importance: row.importance || null,
    headline: clipped(row.headline, 160),
    detail: clipped(row.detail, 160),
    directionReason: clipped(row.signalReason || row.reason, 100),
    importanceReason: clipped(row.importanceReason, 100),
  };
}

function chatterRow(row) {
  return {
    ticker: row.ticker || null,
    topic: clipped(row.name || row.slug, 80),
    mentions: row.mentions ?? null,
    mentionCountChangePct: row.mentionsChangePct ?? null,
    sentiment: row.sentiment ?? row.sentimentLabel ?? null,
    sentimentScore: row.sentimentScore ?? null,
    sources: row.sources || row.sourceTotals || null,
  };
}

function announcementRow(row) {
  return {
    date: row.date || null,
    time: row.time || null,
    ticker: row.ticker || null,
    company: clipped(row.company || row.ticker, 60),
    title: clipped(row.title || row.headline, 160),
    category: clipped(row.category, 60),
    subCategory: clipped(row.subCategory, 60),
    source: row.source || null,
    sources: row.sources || null,
    url: row.url || null,
  };
}

function insiderRow(row) {
  const cells = row.cells || {};
  return {
    date: row.date || null,
    ticker: row.ticker || null,
    company: clipped(row.company || cells.Company || row.ticker, 60),
    insider: clipped(cells.Insider, 80),
    category: clipped(cells.Category, 60),
    transaction: clipped(cells.Transaction || cells['Acq/Disp'] || cells.Mode, 60),
    tradeShares: cells['Trade Shares'] ?? null,
    tradePct: cells['Trade %'] ?? null,
    postHoldingPct: cells['Post Holding %'] ?? null,
    source: row.source || cells.Source || null,
  };
}

function moveRow(row) {
  return {
    investor: clipped(row.investor, 60),
    company: clipped(row.company, 60),
    action: row.action || null,
    latestPeriod: row.latest || null,
    priorPeriod: row.prior || null,
    latestHoldingPct: row.now ?? null,
    priorHoldingPct: row.priorValue ?? row.before ?? null,
    changePp: row.deltaPp ?? null,
    latestValueCr: row.valueCr ?? null,
  };
}

function institutionRow(fund, holding) {
  return {
    institution: clipped(fund.name, 60),
    disclosure: fund.disclosure,
    period: fund.latestPeriodLabel || fund.latestPeriod || null,
    ticker: holding.ticker || null,
    company: clipped(holding.name || holding.ticker, 60),
    holdingPct: holding.pct ?? holding.holdingPct ?? holding.weightPct ?? null,
    valueCr: holding.valueCr ?? null,
    changePp: holding.changePp ?? holding.pctDelta ?? null,
    filingStatus: holding.changeNote || null,
  };
}

const byDateDesc = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));
const byDateTimeDesc = (a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`);

// Each builder LOADS (phase one) and then READS (phase three) — see the header. `read` is a plain
// filter over the module's cache and must not fetch; All Alerts is the one exception, because
// `collect()` is the whole of that feed and it seeds rather than walks.
const BUILDERS = [
  {
    id: 'company-filings',
    load: async () => null,
    read({ scope, holdings, plan }) {
      const evidence = domesticFilingsEvidence();
      const rows = filterByScope(evidence.rows, scope, holdings);
      return sourcePacket(this.id, {
        source: 'Screener.in domestic filings via Muns', rowCount: rows.length,
        coverage: { lookups: evidence.lookups, staleLookups: evidence.stale },
        definition: 'Document metadata and links only, from company lookups already made in this session. PDF contents have not been read: never infer financial figures, consensus or transcript findings from titles.',
        ...chooseRows(rows, plan, (row) => ({ ticker: row.ticker, title: clipped(row.title, 160), form: row.form, period: row.date, url: row.url })),
      });
    },
  },
  {
    id: 'earnings-hub',
    load: () => earningsLive.load(),
    read({ scope, holdings, plan }) {
      const rows = earningsLive.forScope(scope, holdings);
      const meta = earningsLive.meta() || {};
      return sourcePacket(this.id, {
        source: 'Moneycontrol Rapid Results (live)',
        asOf: meta.fetchedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { allReportedRows: meta.count ?? earningsLive.all().length },
        definition: `${meta.quarter || 'Current quarter'} · ${meta.currentPeriod || 'current'} vs ${meta.priorPeriod || 'prior'} · ${String(meta.subType || 'yoy').toUpperCase()}. ₹ crore. growthPct is absent where the sign changed; change says how.`,
        ...chooseRows(rows, plan, earningsRow, byDateDesc('resultDate')),
      });
    },
  },
  {
    id: 'earnings-calendar',
    // NO LOAD PHASE, DECLARED RATHER THAN OMITTED — and the difference is not cosmetic. This was
    // simply absent, and the loop below called `builder.load()` unguarded, so this source threw
    // `builder.load is not a function` on EVERY question ever asked and was reported to the model
    // as unavailable. It had never once been read. The failure was invisible because a source that
    // cannot be read is a state this registry legitimately has, so the packet looked like an
    // upstream being down.
    //
    // It genuinely has nothing to load: the calendar is a PER-DATE fetch (see the on-demand rule in
    // CLAUDE.md), so a load phase here would walk somebody else's service on every question. It
    // reads whichever dates the Earnings Hub tab has already fetched, and says so in its coverage —
    // that is what `description` means by "currently loaded".
    load: null,
    read({ plan }) {
      const strip = earningsCalendar.strip();
      const loaded = strip.map((item) => earningsCalendar.forDate(item.date)).filter(Boolean);
      const scheduledRows = loaded.flatMap((payload) => payload.rows || []);
      const picked = chooseRows(scheduledRows, plan, (row) => ({
        date: row.resultDate || null,
        company: clipped(row.name, 130),
        ticker: row.ticker || null,
        industry: clipped(row.industry, 120),
        exchange: row.exchange === 'N' ? 'NSE' : row.exchange === 'B' ? 'BSE' : row.exchange || null,
        quarter: row.quarter || null,
        scheduledTime: row.time || null,
        price: round(row.ltp),
        marketCapCr: round(row.marketCap),
      }));
      const asOf = loaded
        .map((payload) => payload.meta?.fetchedAt || payload.listCapturedAt || payload.countsCapturedAt || null)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      return sourcePacket(this.id, {
        source: 'Moneycontrol Earnings Calendar — all-exchange count, widget and pagination feeds',
        asOf,
        rowCount: scheduledRows.length,
        coverage: {
          loadedDates: loaded.length,
          completeDates: loaded.filter((payload) => payload.complete).length,
          strip: strip.map((item) => ({ date: item.date, scheduledCount: item.count })).slice(0, 14),
          note: strip.length ? 'Only schedule dates loaded in this browser are included; filed results are a separate Earnings Reported source.' : 'No scheduled-results date has been opened in this browser yet.',
        },
        definition: 'Scheduled results, not filed results. Counts and rows use All exchanges; company rows follow every published pagination page.',
        ...picked,
      });
    },
  },
  {
    id: 'concall',
    load: () => concalls.load(),
    read({ scope, holdings, plan }) {
      const rows = concalls.forScope(scope, holdings);
      const meta = concalls.meta() || {};
      return sourcePacket(this.id, {
        source: 'Research provider con-call scans (live)',
        asOf: meta.fetchedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { total: meta.count, analysed: meta.analysed },
        definition: 'Score, tier, sentiment and tags are the research provider\'s analysis; the dashboard adds none. A missing score is analysis pending, not zero.',
        ...chooseRows(rows, plan, (row) => ({
          ticker: row.ticker || null,
          company: clipped(row.name, 60),
          industry: clipped(row.industry, 60),
          when: row.when || null,
          notesReady: row.notesReady ?? null,
          resultScore: row.resultScore ?? null,
          resultTier: row.resultTier?.label || row.resultTier || null,
          sentiment: row.sentiment?.label || row.sentiment || null,
          sourceTags: (row.tags || []).map((tag) => clipped(tag, 110)).slice(0, 4),
        }), byDateDesc('when')),
      });
    },
  },
  {
    id: 'public-chatter',
    load: () => chatter.load(),
    read({ scope, plan }) {
      const meta = chatter.meta() || {};
      if (meta.ok !== true) throw new Error(`Public Chatter could not be read (${meta.reason || 'unknown upstream state'}).`);
      const rows = chatter.forScope(scope);
      const unresolved = chatter.uncovered();
      const byMentions = (a, b) => (b.mentions ?? 0) - (a.mentions ?? 0);
      return sourcePacket(this.id, {
        source: 'SentimentDash — ValuePickr, TradingQnA, Google News',
        asOf: meta.generatedAt || meta.checkedAt || null,
        rowCount: rows.length + unresolved.length,
        coverage: { coveredRowsInScope: rows.length, coveredCompanies: meta.companies, unresolvedTopics: unresolved.length, totalTopics: meta.total, window: meta.window },
        definition: 'mentionCountChangePct is a change in mention count between scrapes, not a price return. Unresolved topics have no reliable ticker and are never assigned to a company.',
        unresolvedTopics: {
          status: 'unresolved-company-mapping',
          rowCount: unresolved.length,
          note: 'Shown in every scope because these topics cannot be narrowed by ticker.',
          ...chooseRows(unresolved, plan, chatterRow, byMentions),
        },
        ...chooseRows(rows, plan, chatterRow, byMentions),
      });
    },
  },
  {
    id: 'technicals',
    load: () => technicals.load(),
    read({ scope, holdings, plan }) {
      const rows = technicals.forScope(scope, holdings);
      const meta = technicals.meta() || {};
      const cov = technicals.coverage();
      return sourcePacket(this.id, {
        source: 'Yahoo Finance EOD + NSE delivery (scheduled capture)',
        asOf: meta.generated_at || null,
        rowCount: rows.length,
        coverage: { universe: cov.total, nse500: cov.nse500, book: cov.book, scored: meta.scored_count, failures: meta.failures },
        definition: '16 rules, 24 points, computed by this dashboard. Returns are percentages; Pp fields are percentage points.',
        ...chooseRows(rows, plan, technicalRow, (a, b) => (b.score?.points ?? -Infinity) - (a.score?.points ?? -Infinity)),
      });
    },
  },
  {
    id: 'earnings-surprise',
    load: async () => null,
    read() {
      return failedPacket(this.id, 'Analyst consensus estimates and structured earnings history are not connected. No synthetic financials are supplied.');
    },
  },
  {
    id: 'super-investors',
    load: () => investors.load(),
    read({ scope, plan }) {
      const include = investorScopeFilter(scope);
      const rows = include ? investors.allMoves().filter((row) => include(row.company)) : investors.allMoves();
      const meta = investors.meta() || {};
      const summary = investors.quarterSummary({ include, limit: 5 });
      return sourcePacket(this.id, {
        source: 'Ticker Finology filed portfolios',
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { trackedInvestors: investors.list().length, loadedBooks: investors.books().length, latestQuarter: investors.latestQuarter(), failedBooks: meta.failed },
        summary: {
          counts: summary.counts,
          comparableBooks: summary.comparableBooks,
          contributingBooks: summary.contributingBooks,
          periodPairs: summary.pairs.slice(0, 3).map((pair) => `${pair.latest} vs ${pair.prior}`),
          mostCommonHoldings: investors.overlaps().filter((item) => !include || include(item.company)).slice(0, 3).map((item) => ({ company: clipped(item.company, 60), holders: item.holders.length })),
        },
        definition: 'changePp is percentage points of the company\'s equity. Exited = no longer disclosed, not necessarily sold. latestValueCr is Finology\'s current value, not a trade value.',
        ...chooseRows(rows, plan, moveRow, (a, b) => Math.abs(b.changePp ?? 0) - Math.abs(a.changePp ?? 0)),
      });
    },
  },
  {
    id: 'institutions',
    load: () => institutions.load(),
    read({ scope, holdings, plan }) {
      const funds = institutions.all();
      const rows = [];
      for (const fund of funds) {
        for (const holding of institutions.holdingsForScope(scope, holdings, fund.holdings || [])) rows.push(institutionRow(fund, holding));
      }
      const meta = institutions.meta() || {};
      return sourcePacket(this.id, {
        source: 'Trendlyne filings + AMC portfolio disclosures',
        asOf: meta.generatedAt || null,
        rowCount: rows.length,
        coverage: { funds: funds.length },
        definition: 'shareholding: holdingPct is a stake in the company (valueCr is Trendlyne\'s derivation); portfolio: holdingPct is weight to fund NAV. Not comparable.',
        ...chooseRows(rows, plan, (row) => row, (a, b) => (b.valueCr ?? 0) - (a.valueCr ?? 0)),
      });
    },
  },
  {
    id: 'company-news',
    load: () => news.seed(),
    read({ scope, holdings, plan }) {
      const rows = filterByScope(news.rows(), scope, holdings);
      const meta = news.meta();
      return sourcePacket(this.id, {
        source: 'Retained company news snapshot',
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { coveredCompanies: meta.covered, failedCompanies: meta.failed, windowDays: meta.windowDays, outstanding: meta.outstanding },
        ...chooseRows(rows, plan, (row) => ({
          date: row.date || null,
          ticker: row.ticker || null,
          company: clipped(row.query || row.company || row.ticker, 60),
          title: clipped(row.title, 150),
          summary: clipped(row.summary, 200),
          publisher: row.source || null,
        }), byDateDesc('date')),
      });
    },
  },
  {
    id: 'market-news',
    load: () => marketNews.load(),
    read({ scope, plan }) {
      const allRows = marketNews.rows();
      const rows = scope === 'universe' ? allRows : [];
      const meta = marketNews.meta();
      // THE PUBLISHER TRAVELS WITH THE ROW, and the source name says there are several.
      //
      // This feed carries five publishers. A packet labelled with one masthead whose rows carry no
      // byline does not merely omit the attribution — it supplies a wrong one, because the model has
      // exactly one publisher name in front of it and headlines that need attributing. It would then
      // write that name into prose the reader is given as an answer, which is a fabricated
      // attribution of somebody's real reporting to somebody else.
      // Through the same naming policy the screen uses — the model's answer is customer-facing
      // prose, so it is the last place a brand the owner withholds should reappear.
      const named = (v) => withoutPublisherName(String(v || '')).replace(/^the publisher\b/i, 'The publisher');
      const publishers = [...new Set(allRows.map((r) => named(r.publisher)).filter(Boolean))];
      return sourcePacket(this.id, {
        source: `Market-wide news capture across ${publishers.length || 'several'} publishers${publishers.length ? ` (${publishers.join(', ')})` : ''}`,
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { totalStories: allRows.length, publishers: publishers.length || null, note: scope === 'universe' ? 'Market-wide stories included.' : 'Market-wide stories carry no ticker; excluded from narrowed scopes rather than assigned.' },
        definition: 'Every story names its own publisher; attribute a headline only to the publisher on its row.',
        ...chooseRows(rows, plan, (row) => ({ publishedAt: row.publishedAt || null, publisher: named(row.publisher) || null, title: clipped(row.title, 150), summary: clipped(row.summary, 200), premium: row.premium ?? null }), byDateDesc('publishedAt')),
      });
    },
  },
  {
    id: 'announcements',
    load: () => announcements.seed(),
    read({ scope, holdings, plan }) {
      const rows = filterByScope(announcements.rows(), scope, holdings);
      const meta = announcements.meta();
      return sourcePacket(this.id, {
        source: 'BSE date capture plus Muns BSE / NSE / DRHP company lookups',
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { bseCoversUniverse: meta.coversUniverse, exchangeCompanies: meta.exchangeCompanies, bseWindowDays: meta.windowDays, unnamedRows: meta.unnamedRows, additionalLookups: meta.supplement?.lookups || 0, lookupCompanies: meta.supplement?.companies || 0, failedLookups: meta.supplement?.failed || 0 },
        definition: 'Categories are source taxonomy, not a sentiment judgement. The capture timestamp and universe coverage apply only to BSE. Additional BSE/NSE/DRHP rows cover explicitly requested company/date ranges, not a full universe crawl. PDF contents have not been read.',
        ...chooseRows(rows, plan, announcementRow, byDateTimeDesc),
      });
    },
  },
  {
    id: 'insider-trades',
    load: () => insider.seed(),
    read({ scope, holdings, plan }) {
      const rows = filterByScope(insider.rows(), scope, holdings);
      const meta = insider.meta();
      return sourcePacket(this.id, {
        source: 'NSE, BSE and Trendlyne insider disclosures (retained)',
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { coveredCompanies: meta.covered, failedCompanies: meta.failed, windowDays: meta.windowDays },
        definition: 'Transaction wording is the upstream\'s; no dashboard sentiment or materiality score is attached.',
        ...chooseRows(rows, plan, insiderRow, byDateDesc('date')),
      });
    },
  },
  {
    id: 'daily-alerts',
    load: () => undefined,
    async read({ scope, plan }) {
      const report = await alerts.collect({ scope, holdings: scopeHoldings(scope), includeHistory: true });
      const m = report.meta || {};
      return sourcePacket(this.id, {
        source: 'Derived from the research tabs\' own feeds',
        asOf: m.newestRead || null,
        rowCount: report.events.length,
        coverage: {
          positive: m.positive,
          negative: m.negative,
          neutral: m.neutral,
          highImportance: m.highImportance,
          companies: m.companies,
          eventDays: m.days,
          oldestEventDay: m.oldestEventDay,
          newestEventDay: m.newestEventDay,
          stalestFeedRead: isoTime(m.oldestRead),
          // One line per feed: its status, how many events it contributed, and whether its capture
          // reaches today — "behind" is the state an empty bucket must never be mistaken for.
          feeds: report.feeds.map((feed) => `${feed.id}: ${feed.status}${feed.count ? ` · ${feed.count}` : ''}${feed.reachesToday === true ? ' · reaches today' : feed.reachesToday === false ? ' · behind' : ''}`),
        },
        definition: `direction and importance are the dashboard's stated readings, each with its reason. Price moves count only beyond ±${m.moveThreshold ?? alerts.MOVE_PCT}% at the retained close.`,
        ...chooseRows(report.events, plan, alertRow, byDateTimeDesc),
      });
    },
  },
  {
    // The dashboard's own cross-feed ranking, so "which companies have the strongest evidence across
    // tabs" is answered by the same deterministic model the AI Alerts tab shows — not by whichever
    // company happened to top each source's default ordering. The card's order is the reading; the
    // arithmetic behind it stays off every surface, this one included.
    id: 'ai-alerts',
    load: () => undefined,
    async read({ scope, plan }) {
      const report = await aiAlerts.collect({ scope, holdings: scopeHoldings(scope) });
      const m = report.meta || {};
      const cards = report.cards || [];
      return sourcePacket(this.id, {
        source: 'Derived ranking over All Alerts (this dashboard)',
        asOf: report.day || null,
        rowCount: cards.length,
        coverage: { windowDays: aiAlerts.WINDOW_DAYS, firstDay: m.firstDay, activeCompanies: m.activeCompanies, surfaced: m.surfacedCompanies, suppressed: m.suppressedCompanies },
        definition: 'Deterministic seven-day priority over All Alerts: importance, materiality, recency, book membership, multi-feed corroboration, repeats. rank is the reading; no score is published. Not a recommendation.',
        ...chooseRows(cards, plan, (card, index) => ({
          rank: index + 1,
          ticker: card.ticker || null,
          company: clipped(card.company, 60),
          priority: card.priority || null,
          feeds: (card.feedLabels || []).slice(0, 6),
          events: card.events?.length ?? null,
          positive: card.directions?.positive ?? null,
          negative: card.directions?.negative ?? null,
          highImportance: card.highCount ?? null,
          conflicting: card.mixed ? true : null,
          insight: clipped(card.insight, 170),
          latestEvent: card.topEvent ? { date: card.topEvent.day || null, feed: card.topEvent.feedLabel || card.topEvent.feed || null, headline: clipped(card.topEvent.headline, 140) } : null,
        })),
      });
    },
  },
];

export async function buildResearchEvidence({ question, scope = 'portfolio', onProgress = null, charBudget = RESEARCH_EVIDENCE_CHAR_BUDGET } = {}) {
  const deferred = await whenDeferredData();
  const holdings = scopeHoldings(scope);
  let completed = 0;
  const progress = (id) => {
    completed += 1;
    try {
      onProgress?.({ completed, total: BUILDERS.length, source: tabOf(id) });
    } catch (error) {
      console.error('[research] progress callback failed', error);
    }
  };

  // Phase one: every load in parallel, each under its own deadline. A source that fails here is
  // reported as unavailable and never holds the others back.
  const loadErrors = new Map();
  await Promise.all(
    BUILDERS.map(async (builder) => {
      try {
        // `load: null` is a source that declares it has nothing to fetch — see earnings-calendar.
        // A builder that carries NEITHER a function nor that declaration is a registry bug, and it
        // is raised as one here rather than being quietly skipped: the whole reason this went
        // unnoticed is that "could not be read" is a legitimate state, so our own mistake wore the
        // upstream's clothes.
        if (builder.load === undefined) throw new Error(`Registry error: source "${builder.id}" declares neither a load() nor an explicit \`load: null\`.`);
        if (builder.load) await withTimeout(Promise.resolve().then(() => builder.load()), tabOf(builder.id));
      } catch (error) {
        loadErrors.set(builder.id, error);
      } finally {
        progress(builder.id);
      }
    })
  );

  // Phase two: the question, resolved once against everything that loaded.
  const plan = queryPlan(question, companyIndex(deferred), { scope, holdings });

  // Phase three: reads are filters over the caches.
  const packets = await Promise.all(
    BUILDERS.map(async (builder) => {
      if (loadErrors.has(builder.id)) return failedPacket(builder.id, loadErrors.get(builder.id));
      try {
        return await withTimeout(Promise.resolve().then(() => builder.read({ question, scope, holdings, plan })), tabOf(builder.id));
      } catch (error) {
        return failedPacket(builder.id, error);
      }
    })
  );

  // Registry order is priority order: when the budget runs out mid-pass, the sources listed first
  // — the dashboard's own cross-feed rankings — are the ones that got their next row.
  const order = new Map(DASHBOARD_RESEARCH_SOURCES.map((source, index) => [source.id, index]));
  packets.sort((a, b) => order.get(a.id) - order.get(b.id));
  const ready = packets.filter((packet) => packet.status === 'ready');
  const unavailable = packets.filter((packet) => packet.status !== 'ready');
  return fitEvidenceToBudget({
    generatedAt: new Date().toISOString(),
    scope,
    scopeDefinition: scopeDefinition(scope),
    selection: {
      method: 'Every registered source contributes status, coverage and provenance. Rows are ranked by the companies the question names, then by token hits, then by each source\'s own ordering.',
      tokens: plan.tokens,
      companies: plan.companies,
      sourcesRegistered: DASHBOARD_RESEARCH_SOURCES.length,
      sourcesReady: ready.length,
      sourcesUnavailable: unavailable.length,
    },
    catalog: DASHBOARD_RESEARCH_SOURCES.map((source) => {
      const packet = packets.find((item) => item.id === source.id);
      return { ...source, status: packet?.status || 'unavailable', rowCount: packet?.rowCount ?? null, error: packet?.error || null };
    }),
    sources: packets,
  }, charBudget);
}

/**
 * The companies a question names, resolved against the book, the watchlist, the universe and
 * whatever feeds are already loaded — for an answer saved before its companies were stored with
 * it, so its citations can still deep-link. Same resolver as a live question, same index.
 */
export async function resolveQuestionCompanies(question, scope = 'portfolio') {
  const deferred = await whenDeferredData();
  return queryPlan(question, companyIndex(deferred), { scope, holdings: scopeHoldings(scope) }).companies;
}

export function researchSuggestions(scope = 'portfolio') {
  const possessive = scope === 'universe' ? 'the listed universe' : scope === 'watchlist' ? 'my watchlist' : 'my portfolio';
  return [
    `What needs my attention across ${possessive} today?`,
    `Where do earnings, technicals and public chatter agree or conflict in ${possessive}?`,
    `Which companies in ${possessive} have the strongest recent evidence across multiple tabs?`,
    `Summarise the most important filings, calls and investor activity for ${possessive}.`,
  ];
}
