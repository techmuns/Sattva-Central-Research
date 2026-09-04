#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../worker/index.js';
import { fetchDomesticFilings } from '../worker/muns.mjs';
import { normaliseDomesticFilings, documentUrl, domesticFilingsHref } from '../public/js/data/domestic-filings-shared.js';
import { loadDomesticFilings } from '../public/js/data/domestic-filings.js';
import { clearAll } from '../public/js/core/store.js';
import * as legacyEarnings from '../public/js/data/earnings.js';

const fixture = { data: {
  concalls: [{ title: 'Q1 call transcript', date: '2026-08-20', url: 'https://www.bseindia.com/transcript.pdf' }],
  annual_report: [{ title: 'Annual report 2026', year: '2026', link: 'https://www.bseindia.com/annual.pdf' }],
  earnings_report: [{ name: 'Quarterly results', date: '2026-08-01', pdf_url: 'https://www.nseindia.com/results.pdf' }],
} };
const parsed = normaliseDomesticFilings(fixture, 'RELIANCE');
assert.equal(parsed.documents.length, 3);
assert.deepEqual(parsed.documents.map((r) => r.form), ['concalls', 'annual_report', 'earnings_report']);
assert.equal(parsed.documents[1].date, '2026');
assert.equal(normaliseDomesticFilings({ data: [] }, 'TEST').documents.length, 0);
assert.equal(normaliseDomesticFilings([fixture.data.concalls[0], fixture.data.concalls[0]], 'TEST', 'concalls').documents.length, 1);
assert.throws(() => normaliseDomesticFilings({ message: 'Server failed' }, 'TEST'), /unfamiliar/);
assert.throws(() => normaliseDomesticFilings({ data: { unknown: true } }, 'TEST'), /unfamiliar/);
assert.throws(() => normaliseDomesticFilings({ data: null }, 'TEST'), /unfamiliar/);
const missingTranscript = normaliseDomesticFilings({ concalls: [{ date: 'Jan 2020', transcript: null }, { date: 'Jul 2026', transcript: 'https://example.com/call.pdf' }] }, 'RELIANCE');
assert.equal(missingTranscript.documents.length, 1);
assert.equal(missingTranscript.unavailableLinks, 1, 'null source slots are distinct from parser failures');
assert.equal(missingTranscript.skipped, 0);
assert.throws(() => normaliseDomesticFilings({ concalls: null }, 'TEST'), /unfamiliar/);
assert.throws(() => normaliseDomesticFilings({ success: false, data: [] }, 'TEST'), /error response/);
const partial = normaliseDomesticFilings([...fixture.data.concalls, { link: 'javascript:alert(1)' }, { unknown: true }], 'TEST', 'concalls');
assert.equal(partial.documents.length, 1);
assert.equal(partial.skipped, 2);
assert.equal(documentUrl('javascript:alert(1)'), null);
assert.equal(documentUrl('https://user:password@example.com/report.pdf'), null);
assert(domesticFilingsHref('M&M', { scope: 'portfolio', form: 'concalls' }).includes('company=M%26M'));

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
const cache = new Map();
const jobs = [];
let calls = [];
globalThis.caches = { default: {
  match: async (key) => cache.get(key.url)?.clone(),
  put: async (key, value) => { cache.set(key.url, value.clone()); },
} };
try {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return Response.json(fixture);
  };
  const route = async (path, options = {}, env = { MUNS_TOKEN: 'fixture-token' }) => {
    const result = await worker.fetch(new Request(`http://localhost${path}`, options), env, { waitUntil: (job) => jobs.push(job) });
    await Promise.all(jobs.splice(0));
    return result;
  };
  const body = await (await route('/api/domestic-filings/reliance?form=all')).json();
  assert.equal(body.ok, true);
  assert.equal(body.documents.length, 3);
  assert.equal(calls[0].url, 'https://devde.muns.io/filings/domestic');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-token');
  assert.deepEqual(JSON.parse(calls[0].body), { ticker: 'RELIANCE', form: 'all' });
  assert(!JSON.stringify(body).includes('fixture-token'), 'credentials never appear in response');
  await route('/api/domestic-filings/RELIANCE?form=all');
  assert.equal(calls.length, 1, 'same ticker/form reuses the edge response');
  for (const form of ['concalls', 'annual_report', 'earnings_report']) await route(`/api/domestic-filings/RELIANCE?form=${form}`);
  assert.equal(calls.length, 4, 'document type has its own cache identity');
  assert.equal((await route('/api/domestic-filings/RELIANCE?form=toString')).status, 400);
  assert.equal((await route('/api/domestic-filings/%E0%A4')).status, 400);
  assert.equal((await route('/api/domestic-filings/RELIANCE', { method: 'POST' })).status, 405);
  assert.equal(calls.length, 4);
  const caller = await route('/api/domestic-filings/INFY', { headers: { authorization: 'Bearer fixture-caller-session-token' } }, {});
  assert.equal((await caller.json()).ok, true);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer fixture-caller-session-token');
  const missing = await (await route('/api/domestic-filings/NOAUTH', {}, {})).json();
  assert.equal(missing.reason, 'no-token');
  globalThis.fetch = async () => new Response('', { status: 401 });
  const refused = await (await route('/api/domestic-filings/EXPIRED')).json();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unauthorised');
  globalThis.fetch = async () => new Response('x'.repeat(4_000_001));
  await assert.rejects(fetchDomesticFilings({ ticker: 'TEST' }, { MUNS_TOKEN: 'fixture' }), /too much/);

  await clearAll();
  let answer = { ok: true, documents: parsed.documents, fetchedAt: '2026-09-04T00:00:00Z' };
  globalThis.fetch = async (path) => {
    assert.equal(path, 'api/domestic-filings/RELIANCE?form=all');
    return Response.json(answer);
  };
  assert.equal((await loadDomesticFilings('reliance')).documents.length, 3);
  answer = { ok: true, documents: [] };
  assert.equal((await loadDomesticFilings('RELIANCE')).documents.length, 3, 'empty responses preserve document links');
  answer = { ok: false, message: 'Expired session' };
  const fallback = await loadDomesticFilings('RELIANCE');
  assert.equal(fallback.documents.length, 3);
  assert.equal(fallback.stale, true);
  assert.match(fallback.error, /Expired/);

  const mock = JSON.parse(await readFile(new URL('./fixtures/mock-earnings.json', import.meta.url)));
  legacyEarnings.prime(mock);
  assert.equal(legacyEarnings.all().length, 0, 'legacy consumers cannot surface generated financials');
  assert.equal(legacyEarnings.meta().available, false);
  const bootstrap = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert(!bootstrap.includes('data/mock/'), 'the app never downloads the synthetic corpus');
} finally {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
  await clearAll();
}
console.log('PASS domestic filings contract, document parser, cache isolation, authentication and removal of synthetic financials');
