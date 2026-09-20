// Exercise the real route with local edge-cache/upstream fixtures. No external requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/index.js';
import { summaryIdsForRow } from '../public/js/data/concall-summaries-shared.js';

const scan = { companyKey: 'STLTECH', ticker: 'STLTECH', name: 'Sterlite Technologies Ltd',
  date: '2026-09-03', when: '2026-09-03T16:00:00+05:30', ssUrl: 'analysis.pdf',
  resultScore: 95.3, sentimentTier: 4, tags: ['Published analysis'] };
const snapshot = { rows: [scan], upcoming: [], today: { day: null, rows: [] },
  meta: { total: 1, fetchedAt: '2026-09-14T14:31:03.133Z' } };
const document = (ticker, date, id, kind = 'Transcript') => ({ companyKey: ticker, ticker,
  name: `${ticker} Limited`, companyUrl: `https://www.screener.in/company/${ticker}/`,
  publishedDate: date, observedAt: '2026-09-20T11:00:00Z', kind,
  url: `https://documents.example/${id}.pdf`, summaryUrl: `https://www.screener.in/concalls/summary/${id}/` });
const sourceRows = [document('STLTECH', '2026-09-03', '101'),
  document('STLTECH', '2026-09-03', '102', 'Recording'), document('HISTORY', '2026-01-02', '103')];
const calendar = [{ ticker: 'STLTECH', date: '2026-09-22', eventType: 'AGM' }];

async function fixture({ fail = 'schedule', hasSnapshot = true, hasDocuments = true } = {}, verify) {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const entries = new Map();
  const jobs = [];
  const upstream = [];
  const put = (key, value) => entries.set(`https://cache.invalid/concalls/${key}`, value);
  put('head', { rows: [scan], meta: { fetchedAt: '2026-09-20T11:00:00Z' } });
  put('tail', { rows: [], meta: { truncated: false } });
  put('schedule', { upcoming: [], today: { day: null, rows: [] } });
  if (fail) entries.delete(`https://cache.invalid/concalls/${fail}`);
  put('screener-documents-v1', { capture: hasDocuments ? { rows: sourceRows, portfolioUpcoming: calendar } : null,
    source: { status: hasDocuments ? 'ok' : 'failed', checkedAt: new Date().toISOString(), records: hasDocuments ? 3 : 0 } });
  globalThis.caches = { default: {
    match: async request => entries.has(request.url) ? Response.json(entries.get(request.url)) : undefined,
    put: async (request, response) => entries.set(request.url, await response.json()),
  } };
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    upstream.push(url);
    assert.equal(new URL(url).hostname, 'www.stockscans.in', 'never visit a summary or dispatch a collector');
    return new Response('Fixture upstream unavailable', { status: 404 });
  };
  const env = { ASSETS: { fetch: async request => {
    assert.equal(new URL(request.url).pathname, '/data/concall-scans.json');
    return hasSnapshot ? Response.json(snapshot) : new Response('', { status: 404 });
  } } };
  const read = headers => worker.fetch(new Request('https://dashboard.example/api/concalls', { headers }), env,
    { waitUntil: promise => jobs.push(promise) });
  try { await verify({ read, entries, put, upstream }); }
  finally { await Promise.allSettled(jobs); globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
}

for (const fail of ['head', 'tail', 'schedule']) test(`${fail} outage retains exact summary identities and historical documents`, async () => {
  await fixture({ fail }, async ({ read }) => {
    const response = await read();
    assert.equal(response.status, 200);
    const payload = await response.json();
    const stl = payload.rows.filter(row => row.ticker === 'STLTECH');
    assert.equal(stl.length, 1, 'two source versions stay on one call');
    assert.deepEqual(summaryIdsForRow(stl[0]), ['101', '102']);
    assert.equal(stl[0].resultScore, 95.3);
    assert.equal(payload.rows.find(row => row.ticker === 'HISTORY')?.analysisTracked, false);
    assert.equal(payload.meta.total, 2);
    assert.equal(payload.meta.stockscansTotal, 1);
    assert.equal(payload.meta.fetchedAt, snapshot.meta.fetchedAt, 'do not redate saved analysis');
    assert.deepEqual(payload.portfolioUpcoming, calendar);
    assert.match(payload.degraded, /unavailable/);
    assert.equal((await read({ 'if-none-match': response.headers.get('etag') })).status, 304);
  });
});

test('documents and private summary identities remain reachable without an analysis snapshot', async () => {
  await fixture({ hasSnapshot: false }, async ({ read }) => {
    const response = await read();
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.rows.length, 2);
    assert.ok(payload.rows.every(row => row.analysisTracked === false && row.resultScore === null));
    assert.deepEqual(summaryIdsForRow(payload.rows.find(row => row.ticker === 'STLTECH')), ['101', '102']);
    assert.equal(payload.meta.stockscansTotal, 0);
    assert.equal(payload.meta.fetchedAt, undefined);
    assert.match(payload.degraded, /analysis snapshot is available/);
    assert.deepEqual(payload.portfolioUpcoming, calendar);
  });
});

test('an unavailable catalogue is not invented from its metadata', async () => {
  await fixture({ hasDocuments: false }, async ({ read }) => {
    const payload = await (await read()).json();
    assert.deepEqual(payload.rows, snapshot.rows);
    assert.equal(payload.meta.screener.status, 'failed');
    assert.equal(payload.portfolioUpcoming, null);
  });
  await fixture({ hasDocuments: false, hasSnapshot: false }, async ({ read }) => {
    const response = await read();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
  });
});

test('normal recovery changes the validator and preserves the same summary links', async () => {
  await fixture({}, async ({ read, put }) => {
    const fallback = await read();
    put('schedule', { upcoming: [], today: { day: null, rows: [] } });
    const recovered = await read({ 'if-none-match': fallback.headers.get('etag') });
    assert.equal(recovered.status, 200);
    const payload = await recovered.json();
    assert.equal(payload.degraded, null);
    assert.deepEqual(summaryIdsForRow(payload.rows.find(row => row.ticker === 'STLTECH')), ['101', '102']);
    assert.equal(payload.rows.length, 2);
  });
});
