import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCapturePortfolio } from './lib/capture-portfolio.mjs';
import { captureCompanies, captureCompanySources, readJson, writeJson } from './lib/company-capture.mjs';
import { parseNseIdentities, refreshNseIdentities } from './lib/nse-identities.mjs';
import { createAnnouncementIdentity, mergeExchangeIdentities } from '../public/js/data/announcement-identity.js';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';

const dir = mkdtempSync(join(tmpdir(), 'sattva-onboarding-'));
let clock = Date.now();
const timestamp = () => new Date(clock).toISOString();
const isin = i => `INE${String(i).padStart(9, '0')}`;
const holdings = Array.from({ length: 6 }, (_, i) => ({ isin: isin(i), name: `Company ${i}`, ticker: `C${i}` }));
const book = (list, patch = {}) => ({ ok: true, syncStatus: 'live', storage: 'shared', sourceRevision: 'a'.repeat(64),
  asOf: '2026-08-31', syncedAt: timestamp(), count: list.length, resolved: list.filter(h => h.ticker).length,
  sourceWorkbook: { fileKey: 'up-aug', label: 'August workbook', uploadedAt: '2026-09-01T00:00:00Z' }, holdings: list, ...patch });
const unavailable = async () => { throw new Error('Private server diagnostic'); };
const header = 'SYMBOL,NAME_OF_COMPANY,SERIES,ISIN_NUMBER\r\n';
const csv = (count, offset, kind) => header + Array.from({ length: count }, (_, i) => `C${i + offset},"Company ${i + offset}, Limited",${kind === 'sme' ? 'SM' : 'EQ'},${isin(i + offset)}`).join('\r\n');
try {
  const snapshot = book(holdings, { asOf: '2026-06-30' });
  writeJson(join(dir, 'portfolio-companies.json'), snapshot);
  const future = { isin: isin(1001), name: 'Future SME', ticker: null, reason: 'Quote symbol is not available' };
  const incoming = book([...holdings, { ...future, quantity: 123, account: 'private-field' }], { marketValue: 12345 });
  let active = await loadCapturePortfolio(dir, { live: true, fetcher: async () => Response.json(incoming) });
  assert.equal(active.portfolio.status, 'live');
  assert.equal(active.holdings.length, 7, 'a new shared holding is onboarded without a snapshot PR');
  assert.doesNotMatch(readFileSync(join(dir, 'filing-capture/portfolio.json'), 'utf8'), /quantity|account|marketValue|private-field/);
  assert.deepEqual(readJson(join(dir, 'portfolio-companies.json')), snapshot, 'reviewed fallback is not rewritten');
  const independentCache = join(dir, 'tradingview-news/portfolio.json');
  const borrowed = await loadCapturePortfolio(dir, { live: true, fetcher: unavailable, cachePath: independentCache });
  assert.equal(borrowed.holdings.length, 7, 'a new isolated lane borrows the latest verified core book during an outage');
  const independent = await loadCapturePortfolio(dir, { live: true, fetcher: async () => Response.json(incoming), cachePath: independentCache });
  assert.equal(independent.portfolio.status, 'live');
  assert.equal(readJson(independentCache).holdings.length, 7);
  assert.doesNotMatch(readFileSync(independentCache, 'utf8'), /quantity|account|marketValue|private-field/);
  active = await loadCapturePortfolio(dir, { live: true, fetcher: unavailable });
  assert.equal(active.portfolio.status, 'last-verified');
  assert.equal(active.holdings.length, 7, 'outage cannot roll back newly registered holdings');
  assert.match(active.portfolio.error, /New additions may be missing/);
  assert.doesNotMatch(JSON.stringify(active), /Private server/);
  // A recently checked but older workbook must not displace the newer cached upload.
  writeJson(join(dir, 'portfolio-companies.json'), { ...snapshot, syncedAt: new Date(clock + 1000).toISOString() });
  for (const invalid of [snapshot, { ...incoming, syncedAt: '2020-01-01T00:00:00Z' },
    { ...incoming, count: 1 }, book(holdings.slice(0, 2)), { ...incoming, holdings: [] }]) {
    active = await loadCapturePortfolio(dir, { live: true, fetcher: async () => Response.json(invalid) });
    assert.equal(active.portfolio.status, 'last-verified');
    assert.equal(active.holdings.length, 7, 'stale, older, incomplete and suspiciously shrunken responses retain the last verified book');
  }
  const removed = book([...holdings.slice(1), future], { sourceRevision: 'b'.repeat(64) });
  active = await loadCapturePortfolio(dir, { live: true, fetcher: async () => Response.json(removed) });
  assert.equal(active.holdings.length, 6);
  assert(!active.holdings.some(h => h.ticker === 'C0'), 'a validated removal leaves the active portfolio');

  const fetcher = async url => new Response(csv(String(url).includes('SME') ? 100 : 1000, String(url).includes('SME') ? 1000 : 0, String(url).includes('SME') ? 'sme' : 'equity'));
  let directories = await refreshNseIdentities(dir, { fetcher, now: () => clock });
  assert.equal(directories.directories.equity.entries.length, 1000);
  assert.equal(directories.directories.sme.entries.length, 100);
  assert.equal(directories.directories.sme.entries[1].name, 'Company 1001, Limited');
  const scope = captureCompanies(dir, { announcements: true, holdings: active.holdings });
  assert.equal(scope.unresolved.length, 0);
  assert.equal(scope.companies.find(c => c.ticker === 'C1001').announcementTicker, 'C1001', 'new SME is resolved from its exchange ISIN');
  assert(scope.companies.every(c => c.priority));
  const identity = createAnnouncementIdentity(mergeExchangeIdentities([{ isin: isin(1001), ticker: 'OLDBSE', bseCode: '500001' }], directories.directories.sme.entries));
  assert.equal(identity.find({ ticker: 'C1001-SM' }).ticker, 'C1001');
  assert.equal(identity.find({ ticker: 'OLDBSE' }).ticker, 'C1001');
  assert.equal(identity.find({ scripCode: '500001' }).ticker, 'C1001');
  assert.equal(identity.find({ ticker: 'UNVERIFIED-SM' }), null, 'unverified suffixes never become invented identities');
  writeJson(join(dir, 'universe.json'), [{ ticker: 'C1001-SM' }, { ticker: 'C0' }]);
  assert.equal(captureCompanies(dir, { announcements: true, holdings: active.holdings }).companies.filter(c => ['C1001', 'C1001-SM'].includes(c.ticker)).length, 1);
  assert.equal(captureCompanies(dir, { announcements: true, holdings: active.holdings }).companies.find(c => c.ticker === 'C0').priority, false);
  for (const bad of ['<html>Source unavailable</html>', header + 'X,Name,SM,NOTANISIN', header + `X,Name,SM,${isin(1)}\nX,Name,SM,${isin(2)}`, header + 'X,"unfinished,SM,ISIN']) assert.throws(() => parseNseIdentities(bad, 'sme'));
  clock += 3600000;
  directories = await refreshNseIdentities(dir, { now: () => clock, fetcher: async url => String(url).includes('SME') ? new Response(csv(2, 1000, 'sme')) : fetcher(url) });
  assert.equal(directories.directories.sme.entries.length, 100, 'a truncated directory cannot erase verified mappings');
  assert(directories.directories.sme.error);
  assert.equal(directories.directories.equity.error, null, 'one directory failure does not block the other');
  directories = await refreshNseIdentities(dir, { fetcher: unavailable });
  assert.equal(directories.directories.equity.entries.length, 1000);
  assert(directories.directories.equity.error);
  const renamedCsv = csv(1000, 0, 'equity').replace('C1,', 'RENAMED,');
  directories = await refreshNseIdentities(dir, { fetcher: async url => String(url).includes('SME') ? fetcher(url) : new Response(renamedCsv) });
  assert.equal(directories.directories.equity.entries[1].ticker, 'RENAMED');
  assert(directories.directories.equity.entries[1].aliases.includes('C1'), 'renamed companies retain their previously verified symbols');
  const migratedCsv = renamedCsv + `\nC1001,Future SME,EQ,${isin(1001)}`;
  directories = await refreshNseIdentities(dir, { fetcher: async url => String(url).includes('SME') ? fetcher(url) : new Response(migratedCsv) });
  assert(directories.directories.equity.entries.at(-1).aliases.includes('C1001-SM'), 'a main-board migration keeps prior SME symbols');

  const captureDir = join(dir, 'runs');
  const request = async () => ({ ok: true, announcements: [], documents: [] });
  const options = { dir: captureDir, now: () => clock, request, spacingMs: 0, concurrency: 1 };
  let index = await captureCompanySources({ ...options, companies: [{ ticker: 'C0', priority: true }], maxRequests: 2 });
  index = await captureCompanySources({ ...options, companies: scope.companies, portfolio: active.portfolio, maxRequests: 0 });
  assert(index.sources.announcements.C1001.registeredAt, 'new company is durably registered even if this run has no request budget left');
  assert.equal(index.sources.announcements.C0.priority, false, 'departed holdings lose priority without losing stored history');
  assert(!index.companies.some(c => c.ticker === 'C0'));
  const calls = [];
  await captureCompanySources({ ...options, companies: scope.companies, maxRequests: 1,
    request: async (kind, ticker) => { calls.push(ticker); return request(); } });
  assert(!calls.includes('C0'), 'a company outside the current capture scope is not requested');

  const retryOptions = { ...options, dir: join(dir, 'retry'), companies: [{ ticker: 'FAIL', priority: true }], maxRequests: 1,
    request: async () => { throw Object.assign(new Error('Rate limit'), { retryAfterMs: 3 * 3600000 }); } };
  index = await captureCompanySources(retryOptions);
  assert.equal(index.sources.announcements.FAIL.ranges.length, 0);
  assert.equal(Date.parse(index.sources.announcements.FAIL.nextRetryAt), clock + 3 * 3600000);
  index = await captureCompanySources({ ...retryOptions, maxRequests: 2, companies: [...retryOptions.companies, { ticker: 'NEW', priority: true }], request });
  assert(index.sources.announcements.NEW.lastSuccessAt, 'new holding is reached while an older failure is cooling down');
  assert.equal(index.sources.announcements.FAIL.failureCount, 1);
  // A corrected source identity retries immediately rather than waiting for an old bad-symbol backoff.
  index = await captureCompanySources({ ...retryOptions, companies: [{ ticker: 'FAIL', announcementTicker: 'FIXED' }], request });
  assert.equal(index.sources.announcements.FAIL.queryTicker, 'FIXED');
  assert.equal(index.sources.announcements.FAIL.error, null);
  assert.equal(index.sources.announcements.FAIL.nextRetryAt, null);
  for (let i = 0; i < 7; i++) {
    index = await captureCompanySources(retryOptions);
    const entry = index.sources.announcements.FAIL;
    if (entry.nextRetryAt) {
      assert(Date.parse(entry.nextRetryAt) - clock <= 24 * 3600000, 'backoff cannot defer retry beyond a day');
      clock = Date.parse(entry.nextRetryAt);
    } else clock += 86400000;
  }
  const health = assessFilingsHealth({ company: { ...index, portfolio: { liveRequested: true, status: 'last-verified', error: 'offline', checkedAt: timestamp() },
    identitySources: { sme: { error: 'offline', checkedAt: timestamp() } } } }, { now: clock, sources: ['company'] });
  assert(health.findings.some(f => f.code === 'portfolio-sync-unavailable'));
  assert(health.findings.some(f => f.code === 'identity-directory-unavailable'));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS live portfolio additions/removals, no rollback on outages, private-field projection, dynamic NSE/SME identities, resumable registration and bounded retry backoff');
