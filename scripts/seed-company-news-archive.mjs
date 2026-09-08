#!/usr/bin/env node
// One idempotent migration/repair pass: preserve every portfolio article already present in the
// legacy 30-day head before incremental capture takes over. No network request is made.

import { readNewsJson as read, writeNewsJson } from './lib/news-json-storage.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import {
  articlesFromNewsSnapshot,
  commitCompanyNewsArchive,
  DEFAULT_OVERLAP_HOURS,
} from './lib/company-news-archive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const data = (name) => resolve(here, '../public/data', name);

const book = read(data('portfolio-companies.json'));
const snapshot = read(data('news.json'));
const overrides = read(resolve(here, 'company-news-identity-overrides.json')).entities || [];
const entities = portfolioNewsEntities(book.holdings || [], overrides);
const capturedAt = snapshot.capturedAt || new Date().toISOString();
const articles = articlesFromNewsSnapshot(snapshot, entities, capturedAt);
const archive = commitCompanyNewsArchive({
  dir: data('company-news'),
  articles,
  entities,
  capturedAt,
  overlapHours: DEFAULT_OVERLAP_HOURS,
});

const next = {
  ...snapshot,
  retention: 'permanent-archive',
  overlapHours: DEFAULT_OVERLAP_HOURS,
  entities,
  portfolioLines: (book.holdings || []).length,
  portfolioEntities: entities.length,
  tickerlessPortfolioLines: (book.holdings || []).filter((holding) => !holding.ticker).length,
  tickerlessPortfolioEntities: entities.filter((entity) => !entity.ticker).length,
  archive: {
    index: 'company-news/index.json',
    articleCount: archive.articleCount,
    months: archive.archive.length,
  },
};
writeNewsJson(data('news.json'), next);
console.log(`Seeded ${archive.articleCount} existing portfolio-company articles across ${archive.archive.length} permanent archive shard(s); ${book.holdings.length} book lines resolve to ${entities.length} companies.`);
