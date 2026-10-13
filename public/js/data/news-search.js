// Search expands an exact company name/symbol to verified names, never article attribution.
// The exchange directory is read only after a search, independently of news collection.
import { normalizeNewsText } from './company-news-attribution.js';
import { reviewedNewsIdentity } from './company-news-reviewed.js';
import * as listed from './listed-companies.js';
import * as coverage from './coverage.js';
import { runStepsInSlices } from '../core/slices.js';

let index = new Map(), pending = null, preparedAt = 0, preparedInputs = null;
const shortName = name => normalizeNewsText(name).replace(/(?:\s+(?:limited|ltd|private|pvt|plc))+$/, '');

function* companyIndex(companies) {
  const next = new Map();
  const verifiedTickers = new Map(companies.filter(c => Array.isArray(c.matchTickers)).map(c => [c.ticker, c.isin]));
  for (const raw of companies) {
    const company = reviewedNewsIdentity(raw);
    const reviewed = reviewedNewsIdentity({ ticker: raw.ticker, isin: raw.isin });
    const names = [company.name, company.legalName, ...(company.formerNames || []),
      ...(company.brands || []), ...(reviewed.aliases || []),
      ...(company.aliases || []).filter(a => /\s/.test(a))].map(shortName).filter(Boolean);
    const symbols = (raw.matchTickers || [raw.ticker, raw.bseCode]).map(normalizeNewsText).filter(Boolean);
    const terms = [...new Set([...names, ...symbols])];
    const owner = raw.isin || verifiedTickers.get(raw.ticker) || raw.entityId || raw.ticker || shortName(raw.name);
    for (const key of terms) {
      const old = next.get(key);
      if (!old) next.set(key, { owner, terms });
      else if (old.owner !== owner) next.set(key, { owner: null, terms: [] });
      else old.terms = [...new Set([...old.terms, ...terms])];
    }
    yield;
  }
  return next;
}

export function prepareNewsSearch() {
  if (pending) return pending;
  if (preparedAt && Date.now() - preparedAt < 5 * 60 * 1000) return Promise.resolve(false);
  pending = (async () => {
    try { await listed.load(); } catch { /* Saved identities and ordinary text search remain usable. */ }
    const inputs = [listed.all(), coverage.holdings()];
    if (preparedInputs?.every((input, i) => input === inputs[i])) { preparedAt = Date.now(); return false; }
    index = await runStepsInSlices(companyIndex(inputs.flat()));
    preparedInputs = inputs;
    preparedAt = Date.now();
    return true;
  })().finally(() => { pending = null; });
  return pending;
}

// One normalized reading per retained row/accessor; updates supply new immutable row objects.
export function createNewsMatcher(text) {
  const readings = new WeakMap();
  let previous, needle = '', words = [];
  return (row, query) => {
    if (query !== previous) {
      previous = query; needle = normalizeNewsText(query); words = needle.split(' ').filter(Boolean);
    }
    if (!needle) return true;
    if (!readings.has(row)) readings.set(row, normalizeNewsText(text(row)));
    const value = readings.get(row);
    if (words.every(word => value.includes(word))) return true;
    const company = index.get(needle);
    const mentions = company => !!company?.terms.some(term => ` ${value} `.includes(` ${term} `));
    return mentions(company) || words.every(word => value.includes(word) || mentions(index.get(word)));
  };
}
