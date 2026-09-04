#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parsePlatformPage, parsePlatformDashboard, parsePlatformDrafts, collectPlatform } from './lib/ipo-platform.mjs';
import { mergePlatformCapture, validatePlatformCapture, PLATFORM_ARTIFACT, PLATFORM_REPO, PLATFORM_COMPRESSED_LIMIT } from '../public/js/data/ipo-platform-shared.js';
import { readPlatformCollector, boundedArtifactBytes } from '../worker/ipo-platform-collector.mjs';
import { ipoSourceIsStale, mergeIpoFilings } from '../public/js/data/ipo-filings-shared.js';
import { createIpoFilingsFeed } from '../public/js/data/ipo-filings.js';
import { handleIpoFilings } from '../worker/ipo-filings.mjs';
import { IPO_SOURCES } from '../worker/ipo-sources.mjs';

const at = '2026-09-01T16:00:00.000Z', now = () => Date.parse(at);
const link = (id) => `https://www.ipoplatform.com/ipo/example-${id}/${id}`;
const page = (id) => ({ recordsTotal: 1, recordsFiltered: 1, data: [{ id, company_name: `Example ${id} & Co`, company_link: `<a href="${link(id)}">Example ${id}</a>`, date_of_drhp: '2026-09-02', drhp_link: `https://www.bsesme.com/${id}.pdf`, rhp_link: `https://issuer.test/${id}.pdf`, updated_at: at }] });
const dashboard = `<table id="pe-based"><tr><th>Name</th></tr>${[1,2,3].map((id) => `<tr><td><a href="${link(id)}">Example ${id}</a></td><td>${id === 2 ? 'Mainboard' : 'SME'}</td><td>${id === 3 ? 'Upcoming' : 'Listed'}</td><td>10 Sep - 15 Sep</td><td>18 Sep 2026</td><td>10</td><td>20</td><td>NSE</td><td>Banker</td></tr>`).join('')}</table>`;
const drafts = (id) => `<div class="col itemdiv" data-company="example" data-date_of_drhp="2026-09-02" data-exchange="bse"><a href="${link(id)}" title="Example ${id}"><h4>Example ${id}</h4></a><a href="https://www.bsesme.com/${id}.pdf">Read DRHP</a><a class="btn-primary" href="${link(id)}">DRHP Under Process</a></div>`;
const fetcher = async (url, init) => {
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert(!init.headers.authorization);
  const u = new URL(url); assert.equal(u.hostname, 'www.ipoplatform.com');
  if (u.pathname === '/main-board/index') return Response.json(page(u.searchParams.get('ipo_type') === 'SME' ? 1 : 2));
  return new Response(u.pathname === '/ipo' ? dashboard : drafts(u.pathname.includes('mainboard') ? 5 : 4));
};
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log('PASS', name); };
const capture = await collectPlatform({ fetcher, now });
await test('all five catalogue families combine by stable issuer id without importing financial estimates', () => {
  assert.equal(capture.companies.length, 5); assert.equal(capture.rows.length, 6);
  assert.equal(capture.companies.find((c) => c.id === '1').status, 'Listed');
  assert.equal(capture.companies.find((c) => c.id === '4').status, 'DRHP Under Process');
  assert(capture.rows.every((r) => r.filingDate === null && r.sourceId === 'ipo-platform' && !('score' in r)));
  assert.equal(capture.companies.find((c) => c.id === '3').openingDate, undefined, 'year not invented from adjacent listing date');
});
await test('publisher draft dates never become exchange dates or RHP dates', () => {
  const p = page(1); p.data[0].refiled_date = '2026-09-04';
  const rows = parsePlatformPage(p, 'SME', at).rows;
  assert(rows.every((r) => r.filingDate === null && r.documentDate === null));
  assert.equal(parsePlatformDrafts(drafts(4), 'SME', at).rows[0].documentDate, '2026-09-02');
  assert.equal(parsePlatformDrafts(drafts(4).replace('DRHP Under Process', 'DRHP Withdrawn / Returned'), 'SME', at).companies[0].status, 'DRHP Withdrawn / Returned');
});
await test('unsafe historical document links retain the issuer with no actionable unsafe URL', () => {
  const p = page(1); p.data[0].drhp_link = 'javascript:alert(1)';
  const result = parsePlatformPage(p, 'SME', at); assert.equal(result.companies.length, 1); assert.equal(result.rows[0].url, null);
});
await test('changed markup, duplicate ids and malformed companies fail closed', () => {
  assert.throws(() => parsePlatformDashboard('<html>Access denied</html>', at));
  assert.throws(() => parsePlatformDrafts('<html>Access denied</html>', 'SME', at));
  assert.throws(() => parsePlatformDashboard(dashboard.replace('</table>', dashboard.replace('<table id="pe-based">', '')), at));
  const p = page(1); p.data[0].id = 99; assert.throws(() => parsePlatformPage(p, 'SME', at));
});
await test('complete pagination is mandatory; neither short nor repeated pages can publish', async () => {
  for (const bad of ['short', 'repeated', 'drift']) {
    await assert.rejects(collectPlatform({ now, pageSize: 1, fetcher: async (url, init) => {
      if (!url.includes('main-board/index')) return fetcher(url, init);
      const p = page(1); p.recordsTotal = p.recordsFiltered = bad === 'drift' && new URL(url).searchParams.get('start') === '1' ? 3 : 2;
      if (bad === 'short') p.data = [];
      return Response.json(p);
    } }));
  }
});
await test('100 repeat merges are idempotent and disappeared issuers/documents retain original observation time', () => {
  let merged = capture;
  for (let i = 0; i < 100; i++) merged = mergePlatformCapture(capture, merged);
  assert.equal(merged.rows.length, capture.rows.length); assert.equal(merged.companies.length, capture.companies.length);
  const next = { ...capture, checkedAt: '2026-09-01T17:00:00Z', rows: [], companies: capture.companies.slice(1).map((c) => ({ ...c, observedAt: '2026-09-01T17:00:00Z' })) };
  merged = mergePlatformCapture(next, capture);
  assert.equal(merged.companies.length, capture.companies.length); assert(merged.companies.find((c) => c.id === capture.companies[0].id).retained);
  assert.equal(merged.rows[0].observedAt, at);
  assert.throws(() => mergePlatformCapture({ ...capture, counts: { ...capture.counts, dashboard: 1 } }, capture));
});
await test('exact official document overlap deduplicates without replacing official dates; distinct versions survive', () => {
  const secondary = capture.rows[0], official = { ...secondary, sourceId: 'bse-sme', source: 'BSE SME', origin: 'official', filingDate: '2026-09-03', documentDate: null, observedAt: '2026-09-03T00:00:00Z' };
  const merged = mergeIpoFilings([secondary, official]); assert.equal(merged.length, 1); assert.equal(merged[0].filingDate, '2026-09-03');
  assert.equal(mergeIpoFilings([secondary, { ...official, url: 'https://www.bsesme.com/revised.pdf' }]).length, 2);
});
const run = { id: 10, head_branch: 'main', head_repository: { full_name: PLATFORM_REPO }, event: 'schedule', status: 'completed', conclusion: 'success' };
function artifactFetch({ badDigest = false, host = 'https://example.blob.core.windows.net/capture', failLatest = false, expired = false, fakeRun = run, noRuns = false } = {}) {
  const bytes = gzipSync(JSON.stringify(capture));
  return async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    if (!url.startsWith('https://api.github.com/')) { assert(!init.headers, 'no credentials sent to artifact host'); return new Response(bytes); }
    assert.equal(init.headers.authorization, 'Bearer test');
    if (url.includes('/runs?')) return Response.json({ total_count: noRuns ? 0 : 1, workflow_runs: noRuns ? [] : url.includes('status=success') ? [fakeRun] : failLatest ? [{ ...fakeRun, id: 11, conclusion: 'failure' }] : [fakeRun] });
    if (url.includes('/runs/10/artifacts')) return Response.json({ artifacts: [{ id: 20, name: PLATFORM_ARTIFACT, expired, workflow_run: { id: 10 }, size_in_bytes: bytes.length, digest: `sha256:${badDigest ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}` }] });
    if (url.endsWith('/artifacts/20/zip')) return new Response(null, { status: 302, headers: { location: host } });
    throw Error('Unexpected API path');
  };
}
await test('artifact integrity and signed download isolate credentials; capture timestamp stays original', async () => {
  const p = await readPlatformCollector({ token: 'test', now, fetcher: artifactFetch() });
  assert.equal(p.source.checkedAt, at); assert.equal(p.companies.length, 5); assert(!p.source.collectorLatestFailed);
  for (const opts of [{ badDigest: true }, { host: 'https://evil.test/file' }, { expired: true }, { fakeRun: { ...run, event: 'pull_request' } }, { fakeRun: { ...run, head_repository: { full_name: 'attacker/repo' } } }]) await assert.rejects(readPlatformCollector({ token: 'test', now, fetcher: artifactFetch(opts) }));
});
await test('failure streak preserves previous success but not a fresh label; first-ever bootstrap differs from API failure', async () => {
  const p = await readPlatformCollector({ token: 'test', now, fetcher: artifactFetch({ failLatest: true }) });
  assert(ipoSourceIsStale(p.source, now()));
  assert(ipoSourceIsStale({ ...p.source, collectorLatestFailed: false }, now() + 7200001));
  assert.equal(await readPlatformCollector({ token: 'test', now, allowMissing: true, fetcher: artifactFetch({ noRuns: true }) }), null);
  await assert.rejects(readPlatformCollector({ token: 'test', now, allowMissing: true, fetcher: async () => new Response('', { status: 403 }) }));
});
await test('oversize/cancelled artifacts and future or duplicate capture records are rejected', async () => {
  await assert.rejects(boundedArtifactBytes(new Response('x', { headers: { 'content-length': String(PLATFORM_COMPRESSED_LIMIT + 1) } }), new AbortController().signal));
  const controller = new AbortController(), pending = boundedArtifactBytes(new Response(new ReadableStream()), controller.signal); controller.abort(); await assert.rejects(pending);
  assert.throws(() => validatePlatformCapture({ ...capture, companies: [...capture.companies, capture.companies[0]] }, now()));
  assert.throws(() => validatePlatformCapture({ ...capture, checkedAt: '2099-01-01T00:00:00Z' }, now()));
});
await test('directory persists across outage/reload and old bundled snapshots cannot overwrite newer issuer statuses', async () => {
  const source = (await readPlatformCollector({ token: 'test', now, fetcher: artifactFetch() })).source;
  const empty = { version: 1, ok: false, checkedAt: at, rows: [], sources: IPO_SOURCES.map((s) => ({ ...s, status: 'failed', checkedAt: at, note: 'unavailable' })) };
  const live = { ...empty, ok: true, companies: capture.companies, rows: capture.rows, sources: [...empty.sources, source] };
  let saved, failure = false;
  const build = () => createIpoFilingsFeed({ now, readSnapshot: async () => empty, readLive: async () => { if (failure) throw Error(); return live; }, readSaved: async () => saved, save: async (value) => { saved = { value }; } });
  let feed = build(); await feed.load(); assert.equal(feed.companies().length, 5);
  failure = true; await feed.refresh(); assert.equal(feed.companies().length, 5); assert(feed.meta().degraded);
  feed = build(); await feed.load(); assert.equal(feed.companies().length, 5); assert(feed.meta().liveFailed);
});
await test('combined endpoint can serve the scheduled capture during official-source failure without changing source dates', async () => {
  const r = await handleIpoFilings(new Request('https://app.test/api/ipo-filings'), { now, cache: null, fetcher: async () => new Response('', { status: 503 }), readPlatform: () => readPlatformCollector({ token: 'test', now, fetcher: artifactFetch() }) });
  const p = await r.json(); assert.equal(r.status, 200); assert.equal(p.sources.length, 8); assert.equal(p.companies.length, 5); assert.equal(p.sources[7].checkedAt, at); assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
});
console.log(`${checks} IPOPlatform checks passed`);
