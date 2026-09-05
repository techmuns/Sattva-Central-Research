#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';

export function twitterSearchPlan(entities) {
  return { version: 1, queries: entities.flatMap(entity => {
    const terms = [...new Set(entity.queries.map(q => q.replace(/(?:\s+(?:limited|ltd|private|pvt))+$/gi, '').trim()))];
    // Ticker is an independent discovery term, not evidence of a match. Short symbols need a
    // company qualifier and are omitted here; exact reviewed names still cover tickerless firms.
    if (entity.ticker && /^[A-Z][A-Z0-9&.-]{3,}$/.test(entity.ticker)) terms.push(entity.ticker);
    return [...new Set(terms)].map(term => ({ entityId: entity.entityId,
      key: `${entity.entityId}|${term}`, query: `"${term.replace(/["\\]/g, '')}"` }));
  }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = fileURLToPath(new URL('../public/data/', import.meta.url));
  const portfolio = await loadActivePortfolio(resolve(data, 'portfolio-companies.json'));
  const overrides = readJson(fileURLToPath(new URL('./company-news-identity-overrides.json', import.meta.url)), {}).entities || [];
  const plan = twitterSearchPlan(portfolioNewsEntities(portfolio.holdings, overrides));
  writeJson(resolve(data, 'twitter-search-plan.json'), plan);
  console.log(`Prepared ${plan.queries.length} company/related-entity X searches, including tickerless holdings.`);
}
