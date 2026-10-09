#!/usr/bin/env node
// Exercise the real scheduled collector in a disposable repository copy. Every response comes
// from localhost; no credential or production endpoint is used.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { incrementalNewsRange } from './lib/company-news-archive.mjs';

const runFile = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'sattva-company-news-'));
const dataDir = join(scratch, 'public/data');
const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const priorCapturedAt = new Date(now - 24 * 3600000).toISOString();
let mode = 'articles';
const calls = [];

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  calls.push({ mode, query: url.searchParams.get('q'), from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  response.setHeader('content-type', 'application/json');
  const query = url.searchParams.get('q');
  if (mode === 'failure' || (mode === 'partial' && query === 'BetaPay') || (mode === 'universe-failure' && query === 'Universe B Limited')) {
    response.writeHead(503);
    response.end('{"ok":false}');
    return;
  }
  const articles = ['empty', 'partial'].includes(mode) ? [] : query === 'Alpha Solar Limited'
    ? [{ date: today, title: 'Alpha opens another line', source: 'Publisher A', url: 'https://publisher-a.example/alpha-line' }]
    : query === 'Private Beta Limited'
      ? [{ date: today, title: 'Beta routine update', source: 'Publisher B', url: 'https://m.publisher-b.example/beta/amp' }]
      : [{ date: today, title: 'Beta routine update', source: 'Publisher B', url: 'https://publisher-b.example/beta' }];
  response.end(JSON.stringify({ ok: true, articles }));
});

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const runCapture = async ({ scope = 'book', maxQueries = '' } = {}) => runFile(process.execPath, ['scripts/scrape-filings.mjs', 'news'], {
  cwd: scratch,
  env: {
    ...process.env,
    FAMILY_HOLDINGS_LIVE: 'false',
    FILINGS_BASE: `http://127.0.0.1:${server.address().port}`,
    FILINGS_SCOPE: scope,
    NEWS_MAX_QUERIES: maxQueries,
    FILINGS_BUDGET_MS: '60000',
    FILINGS_TIMEOUT_MS: '5000',
    NEWS_OVERLAP_HOURS: '48',
  },
  timeout: 60000,
});

try {
  await Promise.all([
    cp(join(sourceRoot, 'scripts'), join(scratch, 'scripts'), { recursive: true }),
    cp(join(sourceRoot, 'worker'), join(scratch, 'worker'), { recursive: true }),
    cp(join(sourceRoot, 'public/js'), join(scratch, 'public/js'), { recursive: true }),
  ]);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'portfolio-companies.json'), JSON.stringify({ holdings: [
    { isin: 'INE000000001', ticker: 'ALPHA', name: 'Alpha Solar', bookName: 'Alpha Solar Limited' },
    { isin: 'INE000000002', ticker: null, name: 'Private Beta', bookName: 'Private Beta Limited' },
  ] }));
  await writeFile(join(scratch, 'scripts/company-news-identity-overrides.json'), JSON.stringify({ entities: [
    { match: { isin: 'INE000000002' }, brands: ['BetaPay'] },
  ] }));
  await writeFile(join(dataDir, 'news.json'), JSON.stringify({
    kind: 'news', capturedAt: priorCapturedAt,
    byTicker: { ALPHA: [{ date: today, title: 'Alpha legacy story', source: 'Publisher C', url: 'https://publisher-c.example/alpha' }] },
    empty: ['ISIN:INE000000002'], failed: {},
  }));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  await runCapture();
  const firstCalls = calls.splice(0);
  assert.deepEqual(new Set(firstCalls.map((call) => call.query)), new Set(['Alpha Solar Limited', 'Private Beta Limited', 'BetaPay']));
  const overlapFrom = incrementalNewsRange({ lastSuccessAt: priorCapturedAt }, now).from;
  assert.equal(firstCalls.find((call) => call.query === 'Alpha Solar Limited').from, overlapFrom);
  assert.equal(firstCalls.find((call) => call.query === 'Private Beta Limited').from, overlapFrom);
  assert(firstCalls.find((call) => call.query === 'BetaPay').from < overlapFrom, 'a newly reviewed alias receives the longer initial backfill');

  const firstHead = await readJson(join(dataDir, 'news.json'));
  const firstIndex = await readJson(join(dataDir, 'company-news/index.json'));
  assert.equal(firstIndex.articleCount, 3, 'the prior head and new observations enter the permanent archive');
  assert.equal(firstHead.portfolioLines, 2);
  assert.equal(firstHead.tickerlessPortfolioLines, 1);
  assert.equal(firstHead.byTicker.ALPHA.length, 2);
  assert.equal(firstHead.byTicker['ISIN:INE000000002'].length, 1);
  const beta = firstHead.byTicker['ISIN:INE000000002'][0];
  assert.equal(beta.ticker, null);
  assert.equal(beta.entityId, 'isin:INE000000002');
  assert.deepEqual(beta.matchedQueries.sort(), ['BetaPay', 'Private Beta Limited']);

  mode = 'empty';
  await runCapture();
  const emptyCalls = calls.splice(0);
  assert(emptyCalls.every((call) => call.from >= incrementalNewsRange({ lastSuccessAt: new Date(now - 3600000).toISOString() }, now).from),
    'after success every identity term uses only the overlapping incremental interval');
  const afterEmpty = await readJson(join(dataDir, 'news.json'));
  assert.equal(afterEmpty.archive.articleCount, 3);
  assert.equal(afterEmpty.rowCount, 3, 'successful empty polls cannot retract recent captured articles');

  mode = 'partial';
  await runCapture();
  calls.splice(0);
  const afterPartial = await readJson(join(dataDir, 'news.json'));
  assert.equal(afterPartial.rowCount, 3);
  assert.equal(afterPartial.fallbackCount, 1, 'one successful empty alias cannot hide another alias failure');
  assert.equal(afterPartial.failedCount, 0, 'a partial refresh retains the company rather than declaring it absent');
  assert.equal(afterPartial.queryCoverage.failed, 1);

  mode = 'failure';
  await runCapture();
  const afterFailure = await readJson(join(dataDir, 'news.json'));
  assert.equal(afterFailure.rowCount, 3);
  assert.equal(afterFailure.fallbackCount, 2, 'failed company refreshes retain their last-good answer per identity');
  assert.equal(afterFailure.failedCount, 0, 'retained companies are not mislabeled as absent');
  assert.equal(afterFailure.queryCoverage.failed, 3);

  await writeFile(join(dataDir, 'universe.json'), JSON.stringify(['A', 'B', 'C'].map(ticker => ({
    ticker: `UNIVERSE${ticker}`, name: `Universe ${ticker} Limited`, isin: `INE000${ticker}01011`,
  }))));
  mode = 'articles'; calls.splice(0);
  await runCapture({ scope: 'universe', maxQueries: '4' });
  const firstUniverse = calls.splice(0).filter(call => call.query.startsWith('Universe'));
  assert.deepEqual(firstUniverse.map(call => call.query), ['Universe A Limited']);
  const capped = await readJson(join(dataDir, 'news.json'));
  assert.equal(capped.queryCoverage.planned, 6, 'the ceiling cannot hide unattempted queries from coverage');
  assert.equal(capped.queryCoverage.attempted, 4);
  const universeRows = capped.byTicker.UNIVERSEA;
  assert(universeRows.length);
  assert((await readJson(join(dataDir, 'company-news/index.json'))).queries['isin:INE000A01011']['Universe A Limited'].lastSuccessAt);
  const universeIndex = await readJson(join(dataDir, 'company-news/index.json'));
  assert.equal(universeIndex.entities.length, 2, 'portfolio health/enrichment retains the exact active book');
  assert.equal(universeIndex.universeEntities.length, 3);
  mode = 'empty';
  await runCapture(); calls.splice(0);
  assert((await readJson(join(dataDir, 'company-news/index.json'))).queries['isin:INE000A01011'], 'portfolio top-ups retain universe progress');
  assert.equal((await readJson(join(dataDir, 'company-news/index.json'))).universeEntities.length, 3);
  mode = 'universe-failure';
  await runCapture({ scope: 'universe', maxQueries: '4' });
  assert.deepEqual([...new Set(calls.splice(0).filter(call => call.query.startsWith('Universe')).map(call => call.query))], ['Universe B Limited'], 'the next bounded walk resumes unreached companies');
  mode = 'empty';
  await runCapture({ scope: 'universe' });
  assert.equal(calls.splice(0).filter(call => call.query.startsWith('Universe'))[0].query, 'Universe C Limited',
    'a failed never-successful company cannot repeatedly displace the unreached tail');
  const emptyUniverse = await readJson(join(dataDir, 'news.json'));
  assert.deepEqual(emptyUniverse.byTicker.UNIVERSEA.map(row => row.url), universeRows.map(row => row.url), 'an empty universe response retains observed news');
  assert((await readJson(join(dataDir, 'company-news/index.json'))).articleCount >= 4, 'universe news is retained permanently');

  console.log('PASS company-news capture: real scheduled script, primary/alias watermarks, tickerless ISIN rows, permanent empty-safe archive and last-good failure retention verified');
} finally {
  await new Promise((resolve) => server.listening ? server.close(resolve) : resolve());
  await rm(scratch, { recursive: true, force: true });
}
