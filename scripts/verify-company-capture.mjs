import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCompanySources, captureCompanies, readJson, writeJson, mergeRanges, missingRanges, nextRange } from './lib/company-capture.mjs';
import { archiveFilings } from './lib/filing-archive.mjs';
import { companyCaptureStatus, loadCompanyCaptureIndex } from '../public/js/data/company-captures.js';
import { withFilingArchive } from '../public/js/data/filing-archives.js';
import { clearAll } from '../public/js/core/store.js';

const scratch = mkdtempSync(join(tmpdir(), 'sattva-capture-'));
const originalFetch = globalThis.fetch;
try {
  let clock = Date.parse('2026-09-04T12:00:00Z');
  const calls = [];
  const companies = [{ ticker: 'A', name: 'Company A' }, { ticker: 'B', name: 'Company B' }];
  const doc = { ticker: 'A', form: 'annual_report', title: 'Annual report', url: 'https://example.com/report.pdf' };
  const ann = { ticker: 'A', date: '2026-09-04', title: 'Board meeting', url: 'https://example.com/meeting.pdf', source: 'NSE' };
  const request = async (kind, ticker, range) => {
    calls.push({ kind, ticker, range, at: clock });
    return { ok: true, documents: [{ ...doc, ticker }], announcements: [{ ...ann, ticker }], skipped: 0 };
  };
  const options = { dir: join(scratch, 'capture'), companies, request, now: () => clock,
    sleep: async (ms) => { clock += ms; }, concurrency: 3, spacingMs: 2500 };
  let index = await captureCompanySources({ ...options, maxRequests: 1 });
  const createdAt = index.createdAt;
  assert.equal(calls.length, 1);
  assert(index.sources.announcements.A.lastSuccessAt);
  assert(!index.sources.announcements.B.lastSuccessAt, 'unreached companies remain explicit');
  assert(!index.sources.domestic.A.lastSuccessAt);
  clock += 3600000;
  index = await captureCompanySources({ ...options, maxRequests: 3 });
  assert.equal(index.createdAt, createdAt, 'a new run cannot reset the initial coverage grace period');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((c) => `${c.kind}/${c.ticker}`), ['announcements/B', 'domestic/A', 'domestic/B'], 'restart reaches the remaining companies before repeating work');
  assert(calls[2].at - calls[1].at >= 2500 && calls[3].at - calls[2].at >= 2500, 'one rate gate across concurrent workers');
  assert(index.sources.domestic.B.lastSuccessAt);

  clock += 86400000;
  const prior = readJson(join(options.dir, 'announcements/A.json'));
  index = await captureCompanySources({ ...options, maxRequests: 1, request: async () => ({ ok: true, announcements: [], skipped: 0 }) });
  assert.deepEqual(readJson(join(options.dir, 'announcements/A.json')).rows, prior.rows, 'empty answers cannot retract captured events');
  const rowsBeforeFailure = readJson(join(options.dir, 'announcements/B.json')).rows;
  const rangesBefore = index.sources.announcements.B.ranges;
  index = await captureCompanySources({ ...options, maxRequests: 1, request: async () => ({ ok: false, reason: 'unauthorised', message: 'Session expired' }) });
  assert.equal(index.stoppedForAuth, true);
  assert.deepEqual(index.sources.announcements.B.ranges, rangesBefore, 'failure does not advance date coverage');
  assert.deepEqual(readJson(join(options.dir, 'announcements/B.json')).rows, rowsBeforeFailure);
  assert.equal(index.sources.announcements.B.error.reason, 'unauthorised');
  const floor = index.requestedFrom;
  clock += 86400000;
  index = await captureCompanySources({ ...options, maxRequests: 0 });
  assert.equal(index.requestedFrom, floor, 'unread backfill dates never fall out of a moving window');

  const partialDir = join(scratch, 'partial');
  const partial = await captureCompanySources({ ...options, dir: partialDir, maxRequests: 1,
    request: async () => ({ ok: true, announcements: [ann], skipped: 1 }) });
  assert.equal(readJson(join(partialDir, 'announcements/A.json')).rows.length, 1, 'good rows in a partial response are saved');
  assert(partial.sources.announcements.A.error);
  assert.equal(partial.sources.announcements.A.ranges.length, 0, 'partial response stays incomplete');
  const budgetCalls = [];
  await captureCompanySources({ ...options, dir: join(scratch, 'budget'), budgetMs: 1000,
    request: async (...args) => { budgetCalls.push(args); return request(...args); } });
  assert.equal(budgetCalls.length, 1, 'time budget exits with enough margin to publish checkpoints');

  assert.deepEqual(mergeRanges([{ from: '2026-01-01', to: '2026-01-03' }], { from: '2026-01-04', to: '2026-01-09' }), [{ from: '2026-01-01', to: '2026-01-09' }]);
  assert.deepEqual(missingRanges([{ from: '2026-01-03', to: '2026-01-04' }], '2026-01-01', '2026-01-06'), [{ from: '2026-01-01', to: '2026-01-02' }, { from: '2026-01-05', to: '2026-01-06' }]);
  const recent = new Date(clock).toISOString();
  assert.deepEqual(nextRange({ recentCheckedAt: recent, ranges: [{ from: '2026-08-01', to: '2026-09-04' }] }, '2025-09-05', '2026-09-04', clock), { from: '2026-07-01', to: '2026-07-31' });

  writeJson(join(scratch, 'universe.json'), [{ Company: 'Only in raw universe', 'Screener URL': 'https://www.screener.in/company/RAW/' }]);
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ ticker: 'BOOK' }, { name: 'Unresolved' }] });
  writeJson(join(scratch, 'technicals.json'), { companies: [{ ticker: 'TECH' }, { ticker: 'BOOK' }] });
  assert.deepEqual(captureCompanies(scratch).companies.map((c) => c.ticker), ['BOOK', 'RAW', 'TECH']);
  assert.deepEqual(captureCompanies(scratch).unresolved, ['Unresolved']);
  writeJson(join(scratch, 'announcement-identities.json'), { entries: [{ isin: 'INE000000001', ticker: 'BSEONLY', bseSymbol: 'BSEONLY', bseCode: '500001' }] });
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ isin: 'INE000000001', name: 'BSE-only holding' }] });
  const mappedBook = captureCompanies(scratch, { announcements: true }).companies.find(c => c.ticker === 'BSEONLY');
  assert.equal(mappedBook.announcementTicker, 'BSEONLY');
  assert.equal(mappedBook.priority, true);
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ ticker: 'ALPEXSOLAR-SM', name: 'Alpex Solar' }] });
  assert.equal(captureCompanies(scratch, { announcements: true }).companies[0].announcementTicker, 'ALPEXSOLAR');

  const priorityDir = join(scratch, 'priority');
  const recentEntry = { lastAttemptAt: recent, lastSuccessAt: recent, recentCheckedAt: recent,
    ranges: [{ from: '2026-08-29', to: dayForTest(clock) }], rowCount: 0 };
  function dayForTest(t) { return new Date(t).toISOString().slice(0, 10); }
  const background = Array.from({ length: 8 }, (_, i) => ({ ticker: `U${i}` }));
  const prioritised = [{ ticker: 'BOOK', priority: true }, ...background];
  const savedEntries = Object.fromEntries(prioritised.map(c => [c.ticker, { ...recentEntry, lastAttemptAt: c.priority ? recent : '2026-01-01T00:00:00Z' }]));
  writeJson(join(priorityDir, 'index.json'), { version: 1, sources: { announcements: savedEntries,
    domestic: Object.fromEntries(prioritised.map(c => [c.ticker, { rowCount: 0, ranges: [], lastAttemptAt: '2026-01-01T00:00:00Z' }])) } });
  const priorityCalls = [];
  await captureCompanySources({ ...options, dir: priorityDir, companies: prioritised, maxRequests: 3,
    request: async (kind, ticker, range, company) => { priorityCalls.push({ kind, ticker, range, company }); return { ok: true, announcements: [], documents: [] }; } });
  assert.equal(priorityCalls[0].ticker, 'BOOK', 'portfolio history precedes repeatedly visited universe companies');
  assert(priorityCalls[0].range.to < dayForTest(clock), 'fresh portfolio companies progress through older history');
  assert.equal(priorityCalls[2].kind, 'domestic', 'announcement priority cannot starve the other source');

  const archiveDir = join(scratch, 'archive');
  const oldTrade = { ticker: 'A', date: '2020-01-01', cells: { Insider: 'Person', Shares: '10' } };
  const distinctTrade = { ticker: 'A', date: '2020-01-01', cells: { Insider: 'Other Person', Shares: '10' } };
  archiveFilings(archiveDir, 'insider', [oldTrade, oldTrade, distinctTrade]);
  archiveFilings(archiveDir, 'insider', [oldTrade]);
  assert.equal(readJson(join(archiveDir, '2020-01.json')).rows.length, 2, 'archive removes repeated events while retaining distinct trades');
  archiveFilings(archiveDir, 'insider', []);
  assert.equal(readJson(join(archiveDir, 'index.json')).rowCount, 2, 'empty capture never truncates the archive');

  await clearAll();
  globalThis.fetch = async (path) => {
    if (path === 'data/filing-capture/index.json') return Response.json(index);
    const name = String(path).split('/').at(-1);
    const value = readJson(join(archiveDir, name));
    return value ? Response.json(value) : new Response('', { status: 404 });
  };
  await loadCompanyCaptureIndex({ force: true });
  const health = companyCaptureStatus('announcements', ['A', 'B', 'LOCAL'], clock);
  assert.equal(health.unregistered, 1);
  assert.equal(health.failed, 1);
  assert(health.backfill > 0);
  const base = { rows: () => [], meta: () => ({ headers: [] }), onChange: () => () => {}, invalidate() {} };
  const feed = withFilingArchive(base, 'insider');
  await feed.loadArchive();
  assert.equal(feed.rows().length, 2);
  assert(feed.meta().headers.includes('Shares'));
  assert(feed.meta().archive.loaded);
  globalThis.fetch = async () => new Response('', { status: 503 });
  await feed.loadArchive();
  assert.equal(feed.rows().length, 2, 'failed archive refresh retains visible rows');
  assert(!feed.meta().archive.loaded, 'offline saved history does not claim a fresh complete read');
  assert(feed.meta().archive.error);
} finally {
  globalThis.fetch = originalFetch;
  await clearAll();
  rmSync(scratch, { recursive: true, force: true });
}
console.log('PASS automatic capture resume, rate budget, scope union, partial/auth failures, date backfill, durable archives and visible gaps');
