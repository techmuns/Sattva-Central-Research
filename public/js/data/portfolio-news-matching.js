import { attributeNewsRow, normalizeNewsText } from './company-news-attribution.js';
import { reviewedNewsIdentity } from './company-news-reviewed.js';

const prepared = new WeakMap();
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
  const text = ` ${normalizeNewsText(`${row.title || ''} ${row.articleBody?.provenance === 'publisher-article-body' ? row.articleBody.text : ''}`)} `;
  // Cheap candidate generation is not attribution. The exact guard still decides each match,
  // including ambiguous symbols and the reviewed mismatch. This avoids O(rows × portfolio)
  // expensive article parsing every time a parallel feed settles.
  return candidates(identities).filter(item => item.keys.some(key => text.includes(key)))
    .map(({ identity }) => attributeNewsRow(row, identity))
    .filter(row => ['confirmed', 'related'].includes(row.attribution.status));
}

// Event vocabulary is additive to the desk's topic filters. It classifies only the headline or
// an explicitly bounded publisher body, never a search snippet or related-links strip.
export function newsEventTopics(row = {}) {
  const text = `${row.title || ''} ${row.articleBody?.provenance === 'publisher-article-body' ? row.articleBody.text : ''}`;
  return [
    ['Legal dispute / allegations', /\b(arbitrat\w*|lawsuit|litigation|legal dispute|court case|criminal complaint|allegations?|faulty shells?|fake (?:shells?|munitions?)|defective ammunition)\b/i],
    ['Company clarification', /\b(clarification|clarifies|denies|denied|rejects allegations|media reports?)\b/i],
    ['Analyst / investor day', /\b(analysts?[’']? day|investors?[’']? day|analyst (?:meet|presentation)|investor (?:meet|presentation)|lakshya 29)\b/i],
    ['IPO / offer filing', /\b(IPO|DRHP|RHP|draft red herring prospectus|initial public offering)\b/i],
    ['Business outlook / expansion', /\b(guidance|capacity expansion|capex plan|capital expenditure|profit warning|earnings outlook)\b/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
