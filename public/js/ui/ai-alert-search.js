// ui/ai-alert-search.js — AI ALERTS SEARCH: THE COMPANY FIRST, THEN THE WORDS, NEVER SCATTERED.
//
// The search used to ask one question of a card: does every typed word appear anywhere in it? A card
// is a company plus dozens of evidence lines, so "icici bank" matched PVR INOX ("ICICI Securities"
// in one broker report, "bank" in another line), Karur Vysya Bank, Punjab National Bank and four
// more — seven companies for a search that named one (reported by the desk, 29 October 2026).
//
// So a query is read the way a reader means it:
//
//   1. COMPANY. When the words name a company — its name (suffixes like "Ltd" ignored, common
//      abbreviations like "Natl" and "Insu" understood), its ticker, or the start of either — the
//      results are the companies named, best match first. Other alerts that merely mention the
//      words are counted and one click away ("mentions"), not mixed in.
//   2. COMPANY + TOPIC. "icici results", "bank results": the words that name the company narrow it,
//      the rest must be found together in one line of that company's evidence.
//   3. TOPIC. Otherwise the words must be found together in ONE field — one headline, one note, the
//      card's reading, its sector or KPI line — so a phrase is a phrase and not two words from two
//      different reports. A word matches at the start of a word ("bank" finds "banking", "ank" does
//      not find "bank").
//
// Nothing here changes what a card says or which cards exist; it decides which ones a query shows
// and in what order. Every per-card reading is prepared once per card object and kept weakly, so a
// keystroke across a Universe list is a few comparisons per card, not a rebuild of its text.
import { escapeHtml } from '../core/dom.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (day) => { const ms = Date.parse(`${day}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(String(day)) && Number.isFinite(ms) ? DATE.format(ms) : ''; };

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Words a listed company's name carries that say nothing about which company it is.
const NAME_NOISE = new Set(['ltd', 'limited', 'the', 'pvt', 'plc', 'inc']);
// Abbreviations exchange names use, read both ways ("Punjab Natl.Bank" is "punjab national bank").
const EXPAND = {
  natl: 'national', ntl: 'national', intl: 'international', inds: 'industries', indus: 'industries', corp: 'corporation',
  finl: 'financial', fin: 'finance', svcs: 'services', svc: 'services', mfg: 'manufacturing', tech: 'technologies',
  techn: 'technologies', pharma: 'pharmaceuticals', chem: 'chemicals', engg: 'engineering', insu: 'insurance',
  ins: 'insurance', hsg: 'housing', infra: 'infrastructure', elec: 'electricals', bk: 'bank', co: 'company',
  dev: 'development', mgmt: 'management', ent: 'enterprises', hldg: 'holding', hldgs: 'holdings', inv: 'investments',
};
const expand = (word) => EXPAND[word] || word;
// A typed word names a word of the name when it is the start of it (two letters or more, or the
// whole word), read with both sides' abbreviations expanded.
function wordMatches(token, word) {
  if (token === word || singular(token) === word) return true;
  if (token.length < 2) return false;
  const full = expand(word), typed = expand(token);
  return word.startsWith(token) || full.startsWith(token) || full.startsWith(typed) || word.startsWith(typed);
}
// A plural typed finds its singular ("results" → "Result filed", "banks" → "Bank").
const singular = (token) => token.length > 4 && token.endsWith('ies') ? `${token.slice(0, -3)}y`
  : token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
// A word found at the start of a word somewhere in a field.
const inField = (field, token) => {
  const padded = ` ${field}`;
  if (padded.includes(` ${token}`)) return true;
  const one = singular(token);
  if (one !== token && padded.includes(` ${one}`)) return true;
  return token !== expand(token) && padded.includes(` ${expand(token)}`);
};

function prepareQuery(query) {
  const phrase = normalizeText(query);
  const tokens = phrase.split(' ').filter(Boolean);
  const named = tokens.filter((token) => !NAME_NOISE.has(token));
  return { phrase, tokens, named: named.length ? named : tokens, compact: tokens.join('') };
}

const prepared = new WeakMap();
function indexOf(card) {
  const hit = prepared.get(card);
  if (hit) return hit;
  const name = normalizeText(card.company).split(' ').filter((word) => word && !NAME_NOISE.has(word));
  const ticker = normalizeText(card.ticker);
  const event = (e) => normalizeText([e.headline, e.detail, e.feedLabel, e.feed, e.metric, e.storyText, e.filingDescription,
    e.brokerReport?.broker, e.brokerReport?.points, e.brokerReport?.reportTitle, e.day, dayLabel(e.day), e.time].filter(Boolean).join(' '));
  const lead = normalizeText([card.insight, card.topEvent?.headline].filter(Boolean).join(' '));
  const fields = [lead,
    ...[card.contextSummary, card.badge?.label, card.sector, card.kpis?.groupLabel].map(normalizeText),
    ...(card.kpis?.items || []).map((item) => normalizeText(`${item.name || ''} ${item.triggerLabel || ''}`)),
    ...(card.feedLabels || []).map(normalizeText),
    ...(card.confluence || []).map((pattern) => normalizeText(`${pattern.label || ''} ${pattern.short || ''} ${pattern.detail || ''}`)),
    ...(card.sourceEvents || card.events || []).map(event),
    ...(card.contextEvents || []).map(event), ...(card.upcomingEvents || []).map(event),
  ].filter(Boolean);
  const value = { name, nameText: name.join(' '), compactName: name.join(''), ticker, compactTicker: ticker.replace(/ /g, ''), lead, fields };
  prepared.set(card, value);
  return value;
}

// How strongly the query names the company itself; 0 when it does not.
function identityScore(index, q) {
  if (!q.named.length) return 0;
  const typed = q.named.join(' '), compact = q.named.join('');
  if (compact && (compact === index.compactTicker || compact === index.compactName || q.compact === index.compactTicker)) return 100;
  if (index.nameText && index.nameText.startsWith(typed)) return index.nameText.length === typed.length ? 100 : 90;
  const used = new Set();
  const allNamed = q.named.every((token) => {
    const at = index.name.findIndex((word, i) => !used.has(i) && wordMatches(token, word));
    if (at < 0) return false;
    used.add(at); return true;
  });
  if (allNamed) return 80;
  if (q.compact.length >= 2 && index.compactTicker.startsWith(q.compact)) return 75;
  return 0;
}

/** How well a query matches one card: 100–75 the company itself, 60 company + topic, 55–30 a topic; 0 none. */
export function searchScore(card, query) {
  const q = typeof query === 'string' ? prepareQuery(query) : query;
  if (!q.tokens.length) return 1;
  if (!card) return 0;
  const index = indexOf(card);
  const identity = identityScore(index, q);
  if (identity) return identity;
  // A single letter is a word of a name ("J & K") but not a topic: on its own it matches nearly
  // every line, so topic matching reads only the words of two letters or more.
  const together = (tokens) => {
    const words = tokens.filter((token) => token.length >= 2);
    return words.length > 0 && index.fields.some((field) => words.every((token) => inField(field, token)));
  };
  // Company + topic: the words that name this company, and the rest found together in one line.
  const naming = q.tokens.filter((token) => index.name.some((word) => wordMatches(token, word)) || (token.length >= 2 && index.compactTicker.startsWith(token)));
  const rest = q.tokens.filter((token) => !naming.includes(token));
  if (naming.length && rest.length && together(rest)) return 60;
  if (q.phrase.length >= 3 && (` ${index.lead}`).includes(` ${q.phrase}`)) return 55;
  if (q.phrase.length >= 3 && index.fields.some((field) => (` ${field}`).includes(` ${q.phrase}`))) return 50;
  return together(q.tokens) ? 30 : 0;
}

/**
 * The cards a query shows, best first. When the query names companies, only those companies are
 * results; the alerts that merely mention it are returned apart as `mentions`, shown on request.
 * Within one strength the caller's order is kept, so the chosen sort still decides ties.
 */
export function rankSearch(cards, query, { includeMentions = false } = {}) {
  const q = prepareQuery(query);
  if (!q.tokens.length) return { cards, named: false, mentions: [], score: () => 1 };
  const scored = [];
  for (const card of cards) { const score = searchScore(card, q); if (score > 0) scored.push({ card, score }); }
  // The strongest reading present decides what a result is: companies named outright (75+), else
  // a named company with the topic found in its evidence (60); either way the weaker matches —
  // alerts that only mention the words — are counted apart. A plain topic shows every match.
  const floor = scored.some((entry) => entry.score >= 75) ? 75 : scored.some((entry) => entry.score >= 60) ? 60 : 0;
  const named = floor > 0;
  const best = named ? scored.filter((entry) => entry.score >= floor) : scored;
  const mentions = named ? scored.filter((entry) => entry.score < floor) : [];
  const order = (list) => list.map((entry, i) => ({ ...entry, i })).sort((a, b) => b.score - a.score || a.i - b.i).map((entry) => entry.card);
  const scores = new Map(scored.map((entry) => [entry.card, entry.score]));
  return { cards: [...order(best), ...(includeMentions ? order(mentions) : [])], named, mentions: order(mentions),
    score: (card) => scores.get(card) || 0 };
}

/** Companies the query names, for the typeahead: strongest first, at most `limit`. */
export function suggestCompanies(cards, query, limit = 6) {
  const q = prepareQuery(query);
  if (!q.tokens.length) return [];
  const seen = new Set(), out = [];
  for (const card of cards) {
    const key = String(card.key || card.ticker || card.entityId);
    if (seen.has(key)) continue;
    const score = identityScore(indexOf(card), q);
    if (score >= 75) { seen.add(key); out.push({ card, key, score }); }
  }
  return out.sort((a, b) => b.score - a.score || String(a.card.company).localeCompare(String(b.card.company))).slice(0, limit);
}

/** The text, escaped, with each typed word marked where it starts a word. */
export function highlightHtml(text, query) {
  const source = String(text ?? '');
  const tokens = prepareQuery(query).tokens.filter((token) => token.length >= 1);
  if (!tokens.length || !source) return escapeHtml(source);
  const lower = source.toLowerCase();
  const marks = [];
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at >= 0; at = lower.indexOf(token, at + 1)) {
      if (at > 0 && /[a-z0-9]/.test(lower[at - 1])) continue;
      marks.push([at, at + token.length]);
    }
  }
  if (!marks.length) return escapeHtml(source);
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of marks) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  let html = '', cursor = 0;
  for (const [start, end] of merged) {
    html += `${escapeHtml(source.slice(cursor, start))}<mark class="ai-search-mark">${escapeHtml(source.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(source.slice(cursor));
}
