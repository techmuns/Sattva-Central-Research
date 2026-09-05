#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterCompanyNewsByScope,
  portfolioNewsEntities,
} from '../public/js/data/company-news-identity.js';
import { namesCompany } from '../public/js/data/news-keywords.js';
import {
  commitCompanyNewsArchive,
  incrementalNewsRange,
  mergeCompanyNewsArticles,
  observedCompanyArticles,
  readCompanyNewsShard,
} from './lib/company-news-archive.mjs';

const root = mkdtempSync(join(tmpdir(), 'company-news-'));
try {
  const holdings = [
    { isin: 'INE000000001', ticker: 'ALPHA', name: 'Alpha Solar', bookName: 'Alpha Solar Ltd' },
    { isin: 'INE000000002', ticker: null, name: 'Alpha Solar — warrants', bookName: 'Alpha Solar Ltd_Warrants' },
    { isin: 'INE000000003', ticker: null, name: 'Private Beta', bookName: 'Private Beta Limited' },
  ];
  const overrides = [{
    match: { isin: 'INE000000003' },
    formerNames: ['Old Beta Ltd'],
    brands: ['BetaPay'],
    subsidiaries: ['Beta Services'],
    officialDomains: ['https://beta.example/'],
  }];
  const entities = portfolioNewsEntities(holdings, overrides);
  assert.equal(entities.length, 2, 'a warrant line maps to its underlying company identity');
  assert.deepEqual(entities.find((entity) => entity.ticker === 'ALPHA').portfolioIsins, ['INE000000001', 'INE000000002']);
  const beta = entities.find((entity) => !entity.ticker);
  assert.equal(beta.entityId, 'isin:INE000000003');
  assert.deepEqual(beta.queries, ['Private Beta Limited', 'Old Beta Ltd', 'BetaPay', 'Beta Services']);
  assert.deepEqual(beta.officialDomains, ['beta.example']);

  const first = observedCompanyArticles([{
    date: '2026-08-31', title: 'Beta wins order', source: 'Publisher A',
    url: 'https://www.publisher.example/story/amp', summary: 'No tracked keyword is required.',
  }], beta, 'Private Beta Limited', '2026-09-01T00:00:00.000Z');
  const overlap = observedCompanyArticles([{
    date: '2026-08-31', title: 'Beta wins order', source: 'Publisher A',
    url: 'https://m.publisher.example/story', summary: 'Updated standfirst.',
  }], beta, 'BetaPay', '2026-09-03T00:00:00.000Z');
  const independentPublisher = observedCompanyArticles([{
    date: '2026-08-31', title: 'Beta wins order', source: 'Publisher B',
    url: 'https://publisher-b.example/beta-order', summary: null,
  }], beta, 'BetaPay', '2026-09-03T00:00:00.000Z');
  const recurringHeadline = observedCompanyArticles([{
    date: '2026-08-30', title: 'Beta wins order', source: 'Publisher A',
    url: 'https://publisher.example/a-different-order', summary: null,
  }], beta, 'BetaPay', '2026-09-03T00:00:00.000Z');
  const merged = mergeCompanyNewsArticles(first, [...overlap, ...independentPublisher, ...recurringHeadline]);
  assert.equal(merged.length, 3, 'mobile/AMP copies dedupe while independent publishers and same-headline stories on other dates remain');
  assert.deepEqual(merged.find((row) => row.source === 'Publisher A').matchedQueries, ['Private Beta Limited', 'BetaPay']);
  assert.equal(merged.find((row) => row.source === 'Publisher A').firstSeenAt, '2026-09-01T00:00:00.000Z');
  assert.equal(merged.find((row) => row.source === 'Publisher A').lastSeenAt, '2026-09-03T00:00:00.000Z');
  assert.equal(namesCompany({ title: 'Kissht launches a new product', query: 'OnEMI Technology Solutions Ltd', matchedQueries: ['OnEMI Technology Solutions Ltd', 'Kissht'] }), true,
    'post-capture attribution recognises any reviewed identity query which found the story');

  const index = commitCompanyNewsArchive({
    dir: root,
    articles: merged,
    entities,
    capturedAt: '2026-09-03T00:00:00.000Z',
    queries: { [beta.entityId]: { BetaPay: { lastSuccessAt: '2026-09-03T00:00:00.000Z' } } },
  });
  assert.equal(index.articleCount, 3);
  assert.equal(readCompanyNewsShard(root, '2026-08').articles.length, 3);

  const afterEmptyPoll = commitCompanyNewsArchive({
    dir: root,
    articles: [],
    entities,
    capturedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.equal(afterEmptyPoll.articleCount, 3, 'an empty incremental response cannot retract history');
  assert.equal(JSON.parse(readFileSync(join(root, '2026-08.json'), 'utf8')).articleCount, 3);

  assert.deepEqual(
    incrementalNewsRange({ lastSuccessAt: '2026-09-05T12:00:00.000Z' }, Date.parse('2026-09-06T12:00:00.000Z')),
    { from: '2026-09-03', to: '2026-09-06', incremental: true },
    'each poll overlaps the previous successful observation by 48 hours',
  );
  assert.deepEqual(
    filterCompanyNewsByScope([{ ...merged[0], ticker: null }], 'portfolio', holdings),
    [{ ...merged[0], ticker: null }],
    'a tickerless company is still portfolio-scopable by entity id',
  );

  const realBook = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
  const realOverrides = JSON.parse(readFileSync(new URL('./company-news-identity-overrides.json', import.meta.url), 'utf8'));
  const realEntities = portfolioNewsEntities(realBook.holdings, realOverrides.entities);
  const resolvedIsins = new Set(realEntities.flatMap((entity) => entity.portfolioIsins));
  assert(realBook.holdings.filter((holding) => !holding.ticker).every((holding) => resolvedIsins.has(holding.isin)),
    'every current portfolio line without a ticker remains an explicit input to identity resolution');
  assert.equal(realEntities.reduce((sum, entity) => sum + entity.portfolioIsins.length, 0), realBook.holdings.length,
    'every current portfolio line resolves to exactly one news identity');
  assert(realEntities.some((entity) => !entity.ticker), 'the identity registry includes companies without NSE tickers');
  assert(realEntities.every((entity) => entity.legalName && Array.isArray(entity.formerNames)
    && Array.isArray(entity.brands) && Array.isArray(entity.subsidiaries) && Array.isArray(entity.officialDomains)),
  'every identity carries the complete reviewed enrichment schema even when an optional field is empty');

  console.log(`PASS company-news archive: ${realBook.holdings.length} portfolio lines (${realBook.holdings.filter((holding) => !holding.ticker).length} without tickers) -> ${realEntities.length} durable company identities; permanent additive shards, 48-hour overlap, reviewed aliases and tickerless scope verified`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
