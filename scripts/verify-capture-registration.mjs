import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleCaptureRegistration } from '../worker/capture-registration.mjs';
import { captureRegistryShard } from '../public/js/data/capture-registration-shared.js';
import { createWatchlistCapture } from '../public/js/data/watchlist-capture.js';
import { loadCaptureRegistrations } from './lib/capture-registrations.mjs';
import { captureCompanies, captureCompanySources, readJson, writeJson } from './lib/company-capture.mjs';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';
import { isSymbolShaped } from '../public/js/core/watchlist.js';

assert(isSymbolShaped('20MICRONS'), 'NSE symbols beginning with digits can be watched');
assert(isSymbolShaped('500001'), 'an explicit BSE code can be watched');
assert(!isSymbolShaped('123') && !isSymbolShaped('RELIANCE|2026-09-04'), 'old row keys are not company symbols');

const companies = [{ isin: 'INE000000001', ticker: 'NEWCO', name: 'New Company' }, { isin: 'INE000000002', ticker: 'SECOND', name: 'Second Company' }];
const stored = new Map(); let writes = 0, limited = false, failedShard = null;
const env = { CAPTURE_REGISTRATION_LIMITER: { limit: async () => ({ success: !limited }) },
  CAPTURE_REGISTRY: { getByName: key => ({
    list: async () => [...stored.values()].filter(c => key.endsWith(`:${captureRegistryShard(c.isin)}`)),
    register: async entries => { if (key.endsWith(`:${failedShard}`)) throw new Error('Storage unavailable'); writes++;
      for (const c of entries) stored.set(c.isin, c); return { accepted: entries.map(c => c.isin), full: [] }; },
  }) },
  ASSETS: { fetch: async request => Response.json(new URL(request.url).pathname.endsWith('/announcement-identities.json') ?
    { entries: [{ ...companies[0], bseCode: '500001' }] } : { directories: { sme: { entries: [{ ...companies[0], aliases: ['NEWCO-SM'] }, companies[1]] } } }) },
};
const post = (body, headers = {}) => new Request('https://test.example/api/capture-registration', { method: 'POST',
  headers: { origin: 'https://test.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const request = body => handleCaptureRegistration(post(body), env);
let result = await (await request({ tickers: ['NEWCO-SM', '500001', 'SECOND', 'UNKNOWN'], privateAccount: 'must-not-be-saved' })).json();
assert.deepEqual(result.registered, ['NEWCO-SM', '500001', 'SECOND']);
assert.deepEqual(result.unresolved, ['UNKNOWN']);
assert.equal(stored.size, 2, 'symbols and BSE aliases enroll one issuer');
assert.doesNotMatch(JSON.stringify([...stored.values()]), /privateAccount|must-not-be-saved|NEWCO-SM/);
const beforeInvalid = writes;
for (const body of [{}, { tickers: [] }, { tickers: ['BAD/TICKER'] }, { tickers: Array(51).fill('NEWCO') }]) assert.equal((await request(body)).status, 400);
assert.equal((await handleCaptureRegistration(post({ tickers: ['NEWCO'] }, { origin: 'https://evil.example' }), env)).status, 403);
assert.equal((await handleCaptureRegistration(post({ tickers: ['NEWCO'] }, { 'content-type': 'text/plain' }), env)).status, 415);
assert.equal((await handleCaptureRegistration(post({ tickers: ['NEWCO'], extra: 'x'.repeat(9000) }), env)).status, 400);
limited = true; assert.equal((await request({ tickers: ['NEWCO'] })).status, 429); limited = false;
assert.equal(writes, beforeInvalid, 'invalid/cross-origin/rate-limited requests never mutate storage');
failedShard = captureRegistryShard(companies[1].isin);
result = await (await request({ tickers: ['NEWCO', 'SECOND'] })).json();
assert.deepEqual(result.registered, ['NEWCO']); assert.deepEqual(result.pending, ['SECOND']);
failedShard = null;
assert.equal((await handleCaptureRegistration(new Request('https://test.example/api/capture-registration'), {})).status, 503);

let clock = Date.now(), watch = [{ ticker: 'NEWCO', name: 'Private watchlist name' }], saved = {}, calls = 0, outage = false;
const collector = createWatchlistCapture({ companies: () => watch, now: () => clock, read: () => saved, write: value => { saved = value; },
  fetcher: async (path, init) => { calls++; assert.equal(path, 'api/capture-registration');
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['tickers']); if (outage) return new Response('', { status: 503 });
    return request(JSON.parse(init.body)); } });
await Promise.all([collector.sync(), collector.sync()]);
assert.equal(calls, 1, 'concurrent browser syncs coalesce');
assert.equal(collector.status().remaining.length, 0);
await collector.sync(); assert.equal(calls, 1, 'durable acknowledgements prevent repeated registration');
watch.push({ ticker: 'SECOND' }); outage = true; await collector.sync();
assert.deepEqual(collector.status().remaining, ['SECOND']);
await collector.sync(); assert.equal(calls, 2, 'outages back off instead of looping');
outage = false; clock += 60001; await collector.sync();
assert.equal(collector.status().remaining.length, 0);
const afterReload = createWatchlistCapture({ companies: () => watch, now: () => clock, read: () => saved, fetcher: async () => { throw new Error('No redundant request'); } });
await afterReload.sync(); assert.equal(afterReload.status().remaining.length, 0, 'acknowledgements survive reload');
watch = []; assert.equal(collector.status().remaining.length, 0, 'unwatch removes the local pending state without retracting shared history');

const dir = mkdtempSync(join(tmpdir(), 'sattva-enrollment-'));
try {
  writeJson(join(dir, 'portfolio-companies.json'), { holdings: [] });
  const fetcher = () => handleCaptureRegistration(new Request('https://test.example/api/capture-registration'), env);
  let enrolled = await loadCaptureRegistrations(dir, { live: true, fetcher });
  assert.equal(enrolled.companies.length, 2);
  let scope = captureCompanies(dir, { announcements: true, registrations: enrolled.companies });
  assert.equal(scope.companies.length, 2, 'a company absent from the portfolio/universe reaches scheduled capture');
  let capture = await captureCompanySources({ dir: join(dir, 'filing-capture'), ...scope, registration: enrolled.registration,
    maxRequests: 1, spacingMs: 0, request: async () => ({ ok: true, announcements: [] }) });
  assert(capture.sources.announcements.NEWCO.lastSuccessAt);
  assert(capture.sources.announcements.SECOND.registeredAt, 'unvisited registration is checkpointed for the next run');
  enrolled = await loadCaptureRegistrations(dir, { live: true, fetcher: async () => { throw new Error('Offline'); } });
  assert.equal(enrolled.companies.length, 2, 'a registry outage does not erase enrolled capture companies');
  assert(enrolled.registration.error);
  assert.equal(readJson(join(dir, 'filing-capture/registrations.json')).companies.length, 2);
  capture.registration = enrolled.registration;
  assert(assessFilingsHealth({ company: capture }, { sources: ['company'] }).findings.some(f => f.code === 'company-registration-unavailable'));
  enrolled = await loadCaptureRegistrations(dir, { live: true, fetcher: async () => Response.json({ ok: true, version: 1, checkedAt: new Date().toISOString(), count: 0, companies: [] }) });
  assert.equal(enrolled.companies.length, 2, 'an unexpectedly empty registry cannot retract previous enrollments');
  assert(enrolled.registration.error);
  writeJson(join(dir, 'filing-capture/registrations.json'), { companies: null });
  enrolled = await loadCaptureRegistrations(dir, { live: false });
  assert(enrolled.registration.error, 'invalid cache data is reported without aborting portfolio capture');
  enrolled = await loadCaptureRegistrations(dir, { live: true, fetcher });
  assert.equal(enrolled.companies.length, 2, 'a live registry read repairs invalid cached data');
  assert.equal(enrolled.registration.error, null);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS issuer-only registration, alias deduplication, origin/rate/size limits, partial storage failure, browser retry/reload and durable capture onboarding');
