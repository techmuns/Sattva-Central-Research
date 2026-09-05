#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { attributeNewsRow, newsCanSupportAI } from '../public/js/data/company-news-attribution.js';
import { matchPortfolioNews, newsEventTopics } from '../public/js/data/portfolio-news-matching.js';
import { mapPortfolioDiscoveryEvents, newsSignal, materializePublicAlertWindow } from '../public/js/data/daily-alerts.js';
import { rankReport } from '../public/js/data/ai-alerts.js';
import { twitterSearchPlan } from './prepare-twitter-search.mjs';
import { discoveryRange, discoverNewsRange, officialDocumentLinks, officialDocumentDate } from './lib/news-discovery.mjs';
import { enrichCompanyNews } from './enrich-company-news.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { commitCompanyNewsArchive, companyNewsArchiveRows } from './lib/company-news-archive.mjs';

const day = '2026-09-05', now = Date.parse(`${day}T07:00:00Z`);
const holdings = [
  { ticker: 'JAYNECOIND', name: 'Jayaswal Neco Industries', isin: 'INE854B01010' },
  { ticker: 'STLTECH', name: 'Sterlite Technologies', isin: 'INE089C01029' },
  { ticker: 'EDELWEISS', name: 'Edelweiss Financial Services', isin: 'INE532F01054' },
  { ticker: null, name: 'Private Acme Robotics', isin: 'INE000000001' },
];
const identities = portfolioNewsEntities(holdings);
const neco = identities.find(e => e.ticker === 'JAYNECOIND');
assert(neco.queries.includes('Datasel'));
assert(!neco.subsidiaries.includes('Datasel'));
assert(neco.relatedEntities.every(r => r.evidenceUrl.startsWith('https://www.necoindia.com/')));
assert(twitterSearchPlan(identities).queries.some(q => q.query === '"Datasel"'));
assert(twitterSearchPlan(identities).queries.some(q => q.entityId === 'isin:INE000000001'));
assert.equal(matchPortfolioNews({ title: 'Kissht launches service' }, portfolioNewsEntities([
  { isin: 'INE12F801023', name: 'OnEMI Technology Solutions', ticker: null },
]))[0].attribution.status, 'confirmed', 'existing ISIN brands work in browser broad-feed mapping too');
assert.equal(matchPortfolioNews({ title: 'Sterlite Power expansion and STL software library' }, identities).length, 0);
assert.equal(matchPortfolioNews({ title: 'Jayaswal Neco Group promoters face allegations' }, identities).length, 0, 'query-only group abbreviation cannot assert a direct listed-company event');
assert.equal(matchPortfolioNews({ title: 'Estonia dispute', summary: 'Datasel arbitration' }, identities).length, 0, 'snippet is not confirmed related coverage');
const related = attributeNewsRow({ title: 'Datasel arbitration over faulty shells', url: 'https://publisher.example/datasel' }, neco);
assert.equal(related.attribution.status, 'related');
assert.match(related.attribution.reason, /not a direct event|not JNIL/);
assert.equal(related.attribution.companyTicker, null);
assert.equal(newsCanSupportAI({ feed: 'news', ...newsSignal(related) }), false);
const event = (row, feed = 'news') => ({ id: row.url || row.title, feed, day, ticker: row.ticker, entityId: row.entityId,
  company: row.company, headline: row.title, url: row.url, ...newsSignal(row) });
const feeds = ['news', 'market-news', 'ipos', 'earnings'].map(id => ({ id, status: 'ok', reachesToday: true }));
const rank = events => rankReport({ day, scope: 'portfolio', events, feeds }, { holdings, insightCompanies: [] });
const context = rank([event(related)]).cards[0];
assert.equal(context.ticker, 'JAYNECOIND');
assert.equal(context.badge.id, 'related');
assert.equal(context.confluence.length, 0);
assert(!context.scoreBreakdown.some(b => /independent feeds/.test(b.label)));
const privateRow = matchPortfolioNews({ title: 'Private Acme Robotics announces IPO', url: 'https://example.test/private' }, identities)[0];
const privateCard = rank([event(privateRow)]).cards[0];
assert.equal(privateCard.ticker, null);
assert.equal(privateCard.entityId, 'isin:INE000000001');
assert(privateCard.holding);
assert.equal(materializePublicAlertWindow({ day, events: [event(privateRow)], feeds }).events.length, 1);
const broad = [{ id: 'm1', headline: 'SterliteTech analyst day outlines Lakshya 29', day, url: 'https://example.test/stl' }];
const mapped = mapPortfolioDiscoveryEvents('market-news', broad, identities);
assert.equal(mapped[0].ticker, 'STLTECH');
assert.equal(mapped[0].importance, 'high');
assert.equal(mapPortfolioDiscoveryEvents('market-news', broad, identities), mapped, 'partial paints reuse mapping');
assert.equal(mapPortfolioDiscoveryEvents('market-news', broad, [neco])[0].ticker, undefined, 'scope membership change invalidates mapping');
const social = mapPortfolioDiscoveryEvents('twitter', [{ ...broad[0], headline: 'Datasel faulty shells controversy' }], identities)[0];
assert.equal(social.ticker, 'JAYNECOIND');
assert.equal(social.aiEligible, false);
const imagePost = mapPortfolioDiscoveryEvents('twitter', [{ ...broad[0], headline: 'Controversy — see the attached image',
  sourceRecord: { matchedQueries: [{ entityId: neco.entityId, query: 'Datasel' }] } }], identities)[0];
assert.equal(imagePost.ticker, 'JAYNECOIND');
assert.equal(imagePost.attribution.status, 'uncertain');
assert.equal(imagePost.aiEligible, false);
assert.equal(rank([{ ...social, feed: 'twitter' }]).cards.length, 0);
const ipo = mapPortfolioDiscoveryEvents('ipos', [{ id: 'i1', company: 'EAAA India Alternatives Limited', headline: 'DRHP filing', day, url: 'https://example.test/drhp' }], identities)[0];
assert.equal(ipo.ticker, 'EDELWEISS');
assert.equal(ipo.issuer, 'EAAA India Alternatives Limited');
assert.equal(ipo.attribution.status, 'related');
assert.equal(rank([{ ...ipo, feed: 'ipos' }]).cards.length, 1);
const direct = attributeNewsRow({ title: 'Sterlite Technologies investor day', url: 'https://example.test/stl' }, identities.find(e => e.ticker === 'STLTECH'));
assert.equal(rank([event(direct), event(direct, 'market-news')]).allCards[0].events.length, 1, 'same publisher link across feeds cannot corroborate itself');
assert(newsEventTopics({ title: 'Update', articleBody: { provenance: 'publisher-article-body', text: 'The company filed a criminal complaint.' } }).length);
assert.equal(newsEventTopics({ title: 'Update', summary: 'A criminal complaint in unrelated links' }).length, 0);
assert.equal(officialDocumentDate('Date: 04.09.2026\nStatement'), '2026-09-04');
assert.equal(officialDocumentDate('Folder /2025/02/ and unrelated 2024 date'), null);
assert.deepEqual(officialDocumentLinks('<a href="/a.pdf">Official &amp; filing</a><a href="javascript:evil.pdf">bad</a>', 'https://example.test/ir'), [{ url: 'https://example.test/a.pdf', title: 'Official & filing' }]);
assert.equal(discoveryRange({ lastSuccessAt: `${day}T00:00:00Z` }, now).from, '2026-08-06');
assert.equal(discoveryRange({ lastSuccessAt: `${day}T00:00:00Z`, lastReconciledAt: `${day}T00:00:00Z` }, now).from, '2026-09-03');
assert.equal(discoveryRange({ lastSuccessAt: `${day}T00:00:00Z`, coveredThrough: '2026-08-30', lastReconciledAt: `${day}T00:00:00Z` }, now).from, '2026-08-28', 'completing an old partition does not skip the outage interval');
const split = await discoverNewsRange({ from: '2026-09-01', to: '2026-09-03', limit: 2,
  read: async r => ({ articles: r.from === r.to ? [{ title: r.from }] : [{ title: r.from }, { title: r.to }] }) });
assert(split.complete);
assert(split.articles.some(r => r.title === '2026-09-02'));
const capped = await discoverNewsRange({ from: day, to: day, limit: 2, read: async () => ({ articles: [{ title: 'a' }, { title: 'b' }] }) });
assert(!capped.complete && capped.articles.length === 2);
assert.equal(capped.unresolved[0].reason, 'possible-single-day-cap');
const partial = await discoverNewsRange({ from: '2026-09-01', to: day, maxReads: 1, limit: 2,
  read: async () => ({ articles: [{ title: 'a' }, { title: 'b' }] }) });
assert.equal(partial.unresolved.length, 2);

// Real enrichment pipeline, disposable files, injected sources only; no production calls.
const scratch = mkdtempSync(join(tmpdir(), 'sattva-news-enrichment-test-'));
try {
  const dir = join(scratch, 'company-news');
  const entity = { ...neco, queries: ['Datasel'], officialPages: ['https://example.test/ir'], evidenceUrls: [] };
  commitCompanyNewsArchive({ dir, entities: [entity], articles: [{ entityId: entity.entityId, ticker: entity.ticker,
    title: 'Old archive', date: '2026-06-01', url: 'https://example.test/old' }] });
  writeJson(join(scratch, 'news.json'), { byTicker: {}, capturedAt: `${day}T00:00:00Z`, empty: [entity.key] });
  writeJson(join(scratch, 'market-news.json'), { articles: [{ title: 'Jayaswal Neco Industries clarification', publisher: 'Fixture publisher', url: 'https://example.test/publisher', publishedAt: `${day}T01:00:00Z` }] });
  let fail = false;
  const requestedRanges = [];
  const fetcher = async input => {
    const url = new URL(input);
    if (url.pathname === '/ir') return new Response('<a href="/statement.pdf">Clarification on media reports</a>');
    if (url.pathname.endsWith('.pdf')) return new Response('%PDF-fixture');
    assert.equal(url.hostname, 'fixture.test');
    assert.equal(url.searchParams.get('country'), 'ALL');
    requestedRanges.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
    return fail ? new Response('{}', { status: 503 }) : Response.json({ ok: true, country: 'ALL', articles: [
      { title: 'Datasel arbitration', date: day, url: 'https://example.test/global' },
      { title: 'An unverified search result is still retained', date: day, url: 'https://example.test/uncertain' },
    ] });
  };
  const options = { dataDir: scratch, baseUrl: 'https://fixture.test', fetcher, now, gapMs: 0,
    extractPdf: () => 'Date: 04.09.2026\nJayaswal Neco Industries clarifies media reports. Datasel is not its subsidiary. The company denies financial impact.' };
  const first = await enrichCompanyNews(options);
  assert.equal(first.completedQueries, 1);
  const rows = companyNewsArchiveRows(dir);
  assert.equal(rows.length, 5);
  assert(rows.some(r => r.url.endsWith('/old')));
  assert(rows.some(r => r.url.endsWith('/uncertain')));
  assert(rows.find(r => r.url.endsWith('/statement.pdf')).articleBody.provenance === 'publisher-article-body');
  assert.equal(readJson(join(scratch, 'news.json')).capturedAt, `${day}T00:00:00Z`, 'supplement never launders core capture health');
  const checkpoint = readJson(join(dir, 'discovery.json')).queries[`${entity.entityId}|ALL|Datasel`].lastSuccessAt;
  fail = true;
  const failed = await enrichCompanyNews({ ...options, now: now + 3600000 });
  assert.equal(failed.staleOrIncompleteQueries, 1, 'a recent prior success cannot hide a failed newest attempt');
  assert.equal(companyNewsArchiveRows(dir).length, 5, 'empty/error reads cannot retract retained articles');
  assert.equal(readJson(join(dir, 'discovery.json')).queries[`${entity.entityId}|ALL|Datasel`].lastSuccessAt, checkpoint);
  fail = false;
  const later = now + 5 * 86400000;
  requestedRanges.length = 0;
  await enrichCompanyNews({ ...options, now: later });
  assert.equal(requestedRanges[0].to, '2026-09-10', 'current discovery proceeds before an old incomplete partition');
  assert(requestedRanges[0].from <= '2026-09-06', 'resumption covers the outage gap, not only the latest two days');
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS portfolio discovery: customer regressions, tickerless cards, cautious relations, social exclusion, feed dedupe, global recovery, official IR and append-only failure retention.');
