#!/usr/bin/env node
// Deterministic operational-probe fixtures. Real browser/modules; temporary public JSON only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkNewsCustomerDelivery } from './check-news-customer-delivery.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';

const publicDir = mkdtempSync(join(tmpdir(), 'sattva-customer-delivery-'));
const now = Date.parse('2026-09-07T09:00:00Z'), capturedAt = new Date(now).toISOString();
const put = (path, value) => { const file = join(publicDir, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
symlinkSync(fileURLToPath(new URL('../public/js', import.meta.url)), join(publicDir, 'js'), 'dir');
const holdings = [
  { ticker: 'KISSHT', isin: 'INE12F801023', name: 'OnEMI Technology Solutions' },
  { ticker: null, isin: 'INE000000001', name: 'Private Acme Robotics' },
];
const entities = portfolioNewsEntities(holdings).map(entity => entity.ticker ? entity : { ...entity, ticker: 'BSEOLD', key: 'BSEOLD' });
const onemi = entities.find(entity => entity.ticker === 'KISSHT'), privateEntity = entities.find(entity => entity.ticker === 'BSEOLD');
const et = { entityId: onemi.entityId, ticker: onemi.ticker, company: onemi.name,
  title: 'JM Financial initiates coverage on OnEMI Technology with Buy call, sees 28% upside', source: 'The Economic Times',
  url: 'https://economictimes.indiatimes.com/markets/stocks/news/jm-financial-initiates-coverage-on-onemi-technology-with-buy-call-sees-28-upside/articleshow/133755070.cms',
  date: '2026-09-04', publishedAt: '2026-09-04T07:18:00Z' };
const privateStory = { entityId: privateEntity.entityId, ticker: privateEntity.ticker, company: privateEntity.name,
  title: 'Private Acme Robotics company update', source: 'Economic Times', url: 'https://example.test/private', date: '2026-09-06' };
const enrichmentCoverage = { capturedAt, staleOrIncompleteQueries: 0, pagesFailed: 0 };
function captures(rows = [et, privateStory]) {
  put('data/portfolio-companies.json', { holdings });
  put('data/news.json', { capturedAt, entities, queryCoverage: { planned: 2, succeeded: 2, failed: 0 }, enrichmentCoverage,
    byTicker: Object.fromEntries(entities.map(entity => [entity.key, rows.filter(row => row.entityId === entity.entityId)])),
    archive: { index: 'company-news/index.json' } });
  put('data/company-news/index.json', { updatedAt: capturedAt, entities, archive: [{ file: 'company-news/2026-09.json', count: rows.length }] });
  put('data/company-news/2026-09.json', { articles: rows });
  put('data/tradingview-news/latest.json', { capturedAt, entities, byTicker: {}, tradingViewCoverage: {
    checkedAt: capturedAt, oldestSuccessAt: capturedAt, activeCompanies: 2, plannedSymbols: 1,
    staleOrFailedSymbols: 0, mappedCompanies: 1, unresolvedCompanies: 1,
  } });
  put('data/market-news.json', { capturedAt, articles: [], archive: [], sources:
    ['moneycontrol', 'business-standard', 'mint', 'economic-times', 'investing'].map(id => ({ id,
      publisher: id, ok: true, feeds: id === 'moneycontrol' ? 1 : 3, feedsOk: id === 'moneycontrol' ? 1 : 3, capturedAt })) });
}
try {
  captures();
  const healthy = await checkNewsCustomerDelivery({ publicDir, now });
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  assert.equal(healthy.retainedPortfolioNews, 2);
  assert.equal(healthy.missingPortfolioNews, 0, 'stable held ISIN keeps old source-ticker news in All Alerts too');
  assert.deepEqual(healthy.onemi, { held: true, news: true, allAlerts: true, aiEligibleByAge: true, aiCandidate: true });
  assert.deepEqual(healthy.blockedRequests, { api: 0, external: 0, writes: 0 }, 'public news checks need no API, model or capture job');

  captures([privateStory]);
  const missingStory = await checkNewsCustomerDelivery({ publicDir, now });
  assert.equal(missingStory.ok, false);
  assert(missingStory.findings.some(finding => finding.code === 'onemi-et-not-searchable-in-news'));
  assert(missingStory.findings.some(finding => finding.code === 'onemi-et-not-searchable-in-all-alerts'));

  captures(); put('data/news.json', { unavailable: true });
  const missingCore = await checkNewsCustomerDelivery({ publicDir, now });
  assert.equal(missingCore.ok, false, 'missing core cannot pass because TradingView is healthy');
  assert(missingCore.findings.some(finding => finding.source === 'core' && finding.code === 'source-incomplete'));

  const invalid = await checkNewsCustomerDelivery({ base: 'https://example.test/path?credential=not-a-real-token', publicDir, now });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.findings[0].code, 'invalid-delivery-origin', 'no credential-bearing or path-based production target');
  const wrongProtocol = await checkNewsCustomerDelivery({ base: 'ftp://localhost', publicDir, now });
  assert.equal(wrongProtocol.findings[0].code, 'invalid-delivery-origin', 'loopback does not permit non-HTTP protocols');
  console.log('PASS customer-delivery browser probe: all scoped records survive, exact ET story searchable/AI-eligible, missing story/core fail, source health separate and no APIs or writes.');
} finally { rmSync(publicDir, { recursive: true, force: true }); }
