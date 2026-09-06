// Company identity is not the search query and a missing name is not a negative fact.
// Pure, shared by snapshot/live readers, search, exports, research and AI ranking.
import { reviewedNewsIdentity } from './company-news-reviewed.js';
export const ATTRIBUTION_VERSION = 2;
export const normalizeNewsText = (value) => String(value || '').normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const phrase = (text, name) => !!name && ` ${text} `.includes(` ${name} `);
const withoutLegalSuffix = (name) => normalizeNewsText(name)
  .replace(/(?:\s+(?:limited|ltd|private|pvt|plc))+$/, '');
const genericNames = new Set(['india', 'indian', 'global', 'international', 'industries', 'industry', 'company', 'corporation', 'holdings', 'finance', 'financial', 'capital', 'energy', 'steel', 'power', 'technologies', 'services']);
// Common-word symbols need a qualified symbol or the full company name, never a prose hit.
const ambiguousSymbols = new Set([...genericNames, 'idea', 'force', 'time', 'fine', 'best', 'more', 'next', 'team', 'gold', 'silver', 'pilot', 'focus', 'quick', 'ready', 'total', 'happy', 'prime']);

// An explicit user-reviewed ARTICLE–COMPANY mismatch, not a publisher/topic blacklist.
// It applies only to these captured words. New/changed text must be assessed afresh.
const reviewedMismatch = {
  ticker: 'JAYNECOIND',
  url: 'https://in.investing.com/news/stock-market-news/lululemon-stock-analysis-is-it-a-buy-amid-cheap-valuation-93CH-5582818',
  title: 'Lululemon stock analysis: Is it a buy amid cheap valuation? By Investing.com',
  summary: 'Lululemon stock analysis: Is it a buy amid cheap valuation?',
};
const articleAddress = (value) => {
  try { const u = new URL(value); return `${u.origin}${u.pathname.replace(/\/$/, '')}`; }
  catch { return ''; }
};

/** Reviewed identity fields only. Never infer aliases or subsidiaries from a search result. */
export function companyNewsAttribution(row = {}, identity = {}) {
  identity = reviewedNewsIdentity(identity);
  const queryTicker = String(identity.ticker || row.queryTicker || row.ticker || '').toUpperCase() || null;
  const queryCompany = identity.name || identity.legalName || row.queryCompany || row.company || row.query || queryTicker;
  const queryEntityId = identity.entityId || row.queryEntityId || row.entityId || null;
  const names = identity.name || identity.legalName ? [identity.name, identity.legalName] : [row.company, row.query];
  const list = kind => Array.isArray(identity[kind]) ? identity[kind] : [];
  const candidates = [
    ...names.filter(Boolean).map(name => ({ name, kind: 'name' })),
    ...['formerNames', 'brands', 'aliases'].flatMap(kind => list(kind).map(name => ({ name, kind }))),
    // A subsidiary mention is related coverage, not proof that its parent experienced the event.
    ...list('subsidiaries').map(name => ({ name, kind: 'subsidiary' })),
    ...list('relatedEntities').filter(r => r.relationship && /^https:\/\//.test(r.evidenceUrl || ''))
      .flatMap(relation => [relation.name, ...(relation.aliases || [])].map(name => ({ name, kind: 'related', relation }))),
  ].map(candidate => ({ ...candidate, key: withoutLegalSuffix(candidate.name) }));
  const title = normalizeNewsText(row.title);
  const summary = normalizeNewsText(row.summary);
  // Only this explicitly bounded field is an article body. Never scan raw HTML, snippets posing
  // as content, navigation, related links or arbitrary upstream `raw` objects as body evidence.
  const body = row.articleBody?.provenance === 'publisher-article-body'
    ? normalizeNewsText(row.articleBody.text) : '';
  const evidence = [];
  for (const candidate of candidates) {
    if (candidate.key.length < 4 || genericNames.has(candidate.key)) continue;
    for (const [field, text] of [['title', title], ['summary', summary], ['articleBody', body]]) {
      if (phrase(text, candidate.key)) evidence.push({ field, match: candidate.name, kind: candidate.kind,
        ...(candidate.relation ? { relationship: candidate.relation } : {}) });
    }
  }
  if (queryTicker) {
    const key = normalizeNewsText(queryTicker);
    for (const [field, text] of [['title', title], ['summary', summary], ['articleBody', body]]) {
      const original = String(field === 'articleBody' ? row.articleBody?.text || '' : row[field] || '');
      const uppercaseSymbol = original.match(/\b[A-Z][A-Z0-9&.-]+\b/g)?.includes(queryTicker);
      // Short/common symbols need an exchange qualifier, e.g. NSE:ITC, to confirm identity.
      if ((uppercaseSymbol && key.replace(/ /g, '').length >= 4 && !/^\d+$/.test(key) && !ambiguousSymbols.has(key) && phrase(text, key)) ||
          phrase(text, `nse ${key}`) || phrase(text, `bse ${key}`)) {
        evidence.push({ field, match: queryTicker, kind: 'ticker' });
      }
    }
  }
  const direct = evidence.some(e => e.field !== 'summary' && !['subsidiary', 'related'].includes(e.kind));
  const related = evidence.filter(e => e.field !== 'summary' && e.kind === 'related');
  const reviewed = queryTicker === reviewedMismatch.ticker &&
    articleAddress(row.url) === reviewedMismatch.url &&
    title === normalizeNewsText(reviewedMismatch.title) && summary === normalizeNewsText(reviewedMismatch.summary) && !body;
  const status = direct ? 'confirmed' : reviewed ? 'unrelated' : related.length ? 'related' : 'uncertain';
  const reason = status === 'confirmed'
    ? 'Company identity matched in the article headline or bounded article body; this is not verification of the reported event.'
    : status === 'related' ? `Related-entity coverage, not a direct event of ${queryCompany}. ${related[0].relationship.note}`
    : status === 'unrelated'
      ? 'User-reviewed mismatch: this exact Lululemon article is unrelated to the searched company. Original record retained.'
      : evidence.length
        ? 'Possible company coverage: identity appears only in the search snippet or through a reviewed subsidiary. Kept visible; open the article to verify the relationship.'
        : 'Possible company coverage: the search returned this article, but its company relationship is unverified. Missing names do not prove irrelevance.';
  return { version: ATTRIBUTION_VERSION, status, reason, queryTicker, queryCompany, queryEntityId,
    companyTicker: status === 'confirmed' ? queryTicker : null,
    companyName: status === 'confirmed' ? queryCompany : null,
    relationships: [...new Map(related.map(e => [e.relationship.name, e.relationship])).values()],
    evidence: evidence.filter((e, i, all) => all.findIndex(x => x.field === e.field && x.match === e.match && x.kind === e.kind) === i) };
}

export const attributionFor = (row = {}) => row.attribution?.version === ATTRIBUTION_VERSION
  ? row.attribution : companyNewsAttribution(row);

const decorated = new WeakMap();
export function attributeNewsRow(row, identity = null) {
  const old = decorated.get(row);
  if (old && old.identity === identity) return old.value;
  const attribution = companyNewsAttribution(row, identity || {});
  const value = { ...row, ticker: attribution.queryTicker, company: attribution.queryCompany,
    entityId: attribution.queryEntityId, attribution, queryTicker: attribution.queryTicker,
    queryCompany: attribution.queryCompany, queryEntityId: attribution.queryEntityId };
  if (attribution.status === 'unrelated') {
    value.ticker = null; value.entityId = null; value.company = null;
  }
  decorated.set(row, { identity, value });
  return value;
}

export const attributionLabel = (row) => ({ confirmed: 'Company matched', related: 'Related entity — exposure not established', uncertain: 'Possible match — unverified', unrelated: 'Unrelated search result' })[attributionFor(row).status];

export function newsSearchText(row = {}) {
  const a = attributionFor(row);
  const identity = a.status === 'unrelated' ? '' : `${a.queryCompany || ''} ${a.queryTicker || ''} ${row.query || ''}`;
  const text = `${identity} ${row.title || ''} ${row.summary || ''} ${row.source || ''}`;
  return `${text} ${normalizeNewsText(text)}`;
}

/** Old cached events have no trustworthy attribution. They must not supply corroboration. */
export function newsCanSupportAI(event = {}) {
  if (event.attribution?.status === 'related') return false;
  return !['news', 'market-news', 'twitter'].includes(event.feed) || event.feed !== 'twitter' && event.attribution?.version === ATTRIBUTION_VERSION && event.attribution.status === 'confirmed';
}

/** Reviewed context can be surfaced for investigation, never spent as direct corroboration. */
export const isRelatedNewsContext = event => ['news', 'market-news', 'ipos'].includes(event.feed) &&
  event.attribution?.version === ATTRIBUTION_VERSION && event.attribution.status === 'related' &&
  event.attribution.relationships?.some(r => r.relationship && /^https:\/\//.test(r.evidenceUrl || ''));
