import { attributeNewsRow, normalizeNewsText } from './company-news-attribution.js';
import { reviewedNewsIdentity } from './company-news-reviewed.js';

const prepared = new WeakMap();

// THE ROW SIDE OF THIS MATCH WAS THE ONLY HALF NOT MEMOISED, AND IT IS THE EXPENSIVE HALF.
//
// `candidates()` below has cached the portfolio side against the identity array since it was
// written. The row side re-ran `normalizeNewsText` — an NFKD normalize plus four Unicode regexes
// over the headline AND the full publisher article body — for every row, on every call. That is a
// pure function of text that never changes once captured, and it was being recomputed on every
// render: measured at 4x CPU throttle, 1,458ms inside `normalizeNewsText` and 2,054ms inside this
// module on ONE warm tab switch, with no network involved at all.
//
// A WeakMap keyed on the row OBJECT is the correct cache here, and safety comes from the key
// rather than from any invalidation rule: capture rows are replaced, never edited in place, so a
// row whose text changed is a different object and misses. Nothing has to remember to clear this,
// which is what makes it safe to add to a hot path — and the entry dies with the row it describes,
// so a feed that drops rows cannot leak them.
const rowText = new WeakMap();
function matchText(row) {
  const hit = rowText.get(row);
  if (hit !== undefined) return hit;
  const body = row.articleBody?.provenance === 'publisher-article-body' ? row.articleBody.text : '';
  const value = ` ${normalizeNewsText(`${row.title || ''} ${body}`)} `;
  rowText.set(row, value);
  return value;
}
function candidates(identities) {
  if (prepared.has(identities)) return prepared.get(identities);
  const value = identities.map(identity => {
    const full = reviewedNewsIdentity(identity);
    const names = [full.name, full.legalName, full.ticker, ...(full.formerNames || []), ...(full.brands || []),
      ...(full.aliases || []), ...(full.subsidiaries || []), ...(full.relatedEntities || []).flatMap(r => [r.name, ...(r.aliases || [])])];
    return { identity, keys: [...new Set(names.filter(Boolean).map(name => normalizeNewsText(name)
      .replace(/(?:\s+(?:limited|ltd|private|pvt|plc))+$/, '')))].filter(key => key.length >= 4).map(key => ` ${key} `) };
  });
  prepared.set(identities, value);
  return value;
}

/** Exact reviewed identities only. Query matches and social buzz do not prove an event. */
export function matchPortfolioNews(row, identities) {
  const text = matchText(row);
  // Cheap candidate generation is not attribution. The exact guard still decides each match,
  // including ambiguous symbols and the reviewed mismatch. This avoids O(rows × portfolio)
  // expensive article parsing every time a parallel feed settles.
  return candidates(identities).filter(item => item.keys.some(key => text.includes(key)))
    .map(({ identity }) => attributeNewsRow(row, identity))
    .filter(row => ['confirmed', 'related'].includes(row.attribution.status));
}

/** Shared by exploratory Topic filters and the stricter headline/body alert classifier. */
export function isBrokerageResearch(text = '') {
  // Brokerage research is a reported opinion, not an issuer fact or an inferred buy/sell signal.
  // Require securities-research wording: bare "coverage", "upgrade" and "target" also describe
  // insurance, software releases and operating plans. Search snippets never qualify these rules.
  const researchContext = /\b(brokerage|broker|analyst|analysts|research|securities|price target|target price|(?:buy|sell|hold|neutral|outperform|underperform|overweight|underweight) (?:call|rating))\b/i.test(text);
  const coverageChange = /\b(?:initiat(?:es?|ed|ing)|starts?|started|begins?|began|resum(?:es?|ed|ing))\b[^.!?]{0,50}\bcoverage\b|\bcoverage initiation\b/i.test(text);
  const ratingChange = /\b(?:upgrad(?:es?|ed|ing)|downgrad(?:es?|ed|ing))\b[^.!?]{0,90}\bto\s+["'“‘]?(?:buy|sell|hold|neutral|outperform|underperform|overweight|underweight|equal[ -]weight)\b/i.test(text);
  const targetChange = /\b(?:rais(?:es?|ed|ing)|cuts?|cutting|lower(?:s|ed|ing)?|revis(?:es?|ed|ing)|hik(?:es?|ed|ing)|increas(?:es?|ed|ing)|reduc(?:es?|ed|ing))\b[^.!?]{0,65}\b(?:price targets?|target prices?)\b|\b(?:price targets?|target prices?)\b[^.!?]{0,50}\b(?:rais(?:ed|es)|cut|lowered|revised|hiked|increased|reduced)\b/i.test(text);
  return researchContext && coverageChange || ratingChange || targetChange;
}

// Event vocabulary is additive to the desk's topic filters. It classifies only the headline or
// an explicitly bounded publisher body, never a search snippet or related-links strip.
export function newsEventTopics(row = {}) {
  const text = `${row.title || ''} ${row.articleBody?.provenance === 'publisher-article-body' ? row.articleBody.text : ''}`;
  return [
    ['Legal dispute / allegations', /\b(arbitrat\w*|lawsuit|litigation|legal dispute|court case|criminal complaint|allegations?|faulty shells?|fake (?:shells?|munitions?)|defective ammunition)\b/i],
    ['Company clarification', /\b(clarification|clarifies|denies|denied|rejects allegations|media reports?)\b/i],
    ['Analyst / investor day', /\b(analysts?[’']? day|investors?[’']? day|analyst (?:meet|presentation)|investor (?:meet|presentation)|lakshya 29)\b/i],
    ['Brokerage research / rating change', { test: isBrokerageResearch }],
    ['IPO / offer filing', /\b(IPO|DRHP|RHP|draft red herring prospectus|initial public offering)\b/i],
    ['Business outlook / expansion', /\b(guidance|capacity expansion|capex plan|capital expenditure|profit warning|earnings outlook)\b/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
