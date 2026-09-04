#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readBseCollector, boundedArtifactBytes } from '../worker/bse-ipo-collector.mjs';
import { IPO_SOURCES, parseBseOffers, captureIpoFilings } from '../worker/ipo-sources.mjs';
import { BSE_ARTIFACT_NAME, BSE_COLLECTOR_REPO, validateBseCapture } from '../public/js/data/bse-ipo-shared.js';
import { ipoSourceIsStale } from '../public/js/data/ipo-filings-shared.js';
import { createIpoFilingsFeed } from '../public/js/data/ipo-filings.js';
import { ipoSourceGroup } from '../public/js/ui/ipo-sources.js';

const at = '2026-09-04T13:00:00.000Z', now = () => Date.parse(at) + 20 * 60000;
const bse = IPO_SOURCES.find((s) => s.id === 'bse-sme');
const parsed = parseBseOffers('<table id="ContentPlaceHolder1_gvData"><tr><td>Example Limited</td><td><a id="x_hyDRHP_0" href="/draft.pdf">03/09/2026</a></td><td><a id="x_hyRHP_0" href="/rhp.pdf">Download</a></td></tr></table>', bse, at);
const capture = { version: 1, sourceId: 'bse-sme', checkedAt: at, ...parsed };
const run = { id: 100, status: 'completed', conclusion: 'success', head_branch: 'main', head_repository: { full_name: BSE_COLLECTOR_REPO }, event: 'schedule' };
const blob = 'https://productionresultssa1.blob.core.windows.net/results/bse?sig=fixture';
let count = 0;
const test = async (name, fn) => { await fn(); console.log('PASS', name); count++; };
async function fixture({ data = capture, runs = [run], location = blob, digestWrong = false, expired = false, bytesOverride } = {}) {
  const bytes = bytesOverride || gzipSync(JSON.stringify(data));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    if (url.startsWith('https://api.github.com/')) {
      assert(url.startsWith(`https://api.github.com/repos/${BSE_COLLECTOR_REPO}/actions/`));
      assert.equal(init.headers.authorization, 'Bearer fixture-token'); assert.equal(init.headers.cookie, undefined);
      if (url.includes('/workflows/')) return Response.json({ workflow_runs: runs });
      if (url.includes('/runs/')) return Response.json({ artifacts: [{ id: 200, name: BSE_ARTIFACT_NAME, expired, size_in_bytes: bytes.length, digest: `sha256:${digestWrong ? '0'.repeat(64) : digest}`, workflow_run: { id: 100 } }] });
      return new Response(null, { status: 302, headers: { location } });
    }
    assert.equal(url, blob); assert.equal(init.headers, undefined, 'signed download must not receive the GitHub token');
    return new Response(bytes);
  };
  return { fetcher, calls };
}
await test('reads the signed artifact without credential forwarding and preserves collection time', async () => {
  const f = await fixture(); const out = await readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now });
  assert.equal(f.calls.length, 4); assert.equal(out.rows.length, 2); assert.equal(out.source.checkedAt, at);
  assert.equal(out.rows[1].filingDate, null); assert.equal(out.source.delivery, 'scheduled'); assert(!ipoSourceIsStale(out.source, now()));
  assert(ipoSourceIsStale(out.source, Date.parse(at) + 31 * 60000));
});
await test('production cannot select fork or pull-request artifacts', async () => {
  for (const bad of [{ ...run, head_branch: 'other' }, { ...run, event: 'pull_request' }, { ...run, head_repository: { full_name: 'attacker/repository' } }]) {
    const f = await fixture({ runs: [bad] });
    await assert.rejects(readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now }), /No successful/);
    assert.equal(f.calls.length, 1);
  }
});
await test('a failed newer collection cannot make the previous capture look fresh', async () => {
  const f = await fixture({ runs: [{ ...run, id: 101, conclusion: 'failure' }, run] });
  const out = await readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now });
  assert.equal(out.source.collectorRunId, 100); assert(out.source.collectorLatestFailed); assert(ipoSourceIsStale(out.source, now()));
});
await test('rejects altered bytes, unsafe redirects, expired artifacts and oversized bodies', async () => {
  for (const opts of [{ digestWrong: true }, { location: 'https://evil.test/file' }, { location: 'http://productionresultssa1.blob.core.windows.net/file' }, { expired: true }, { bytesOverride: new Uint8Array([0x50, 0x4b]) }]) {
    const f = await fixture(opts); await assert.rejects(readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now }));
  }
  await assert.rejects(boundedArtifactBytes(new Response('12345'), new AbortController().signal, 4));
  let cancelled = false; const controller = new AbortController();
  const pending = boundedArtifactBytes(new Response(new ReadableStream({ cancel() { cancelled = true; } })), controller.signal);
  controller.abort(); await assert.rejects(pending); assert(cancelled);
  const f = await fixture({ bytesOverride: gzipSync('x'.repeat(4 * 1024 * 1024 + 1)) });
  await assert.rejects(readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now }), /size limit/);
});
await test('rejects empty, mixed-source, future, stale and malformed captures', () => {
  validateBseCapture(capture, now());
  for (const patch of [{ rows: [] }, { unmapped: 1 }, { checkedAt: '2026-09-05T13:00:00Z' }, { checkedAt: '2026-09-01T13:00:00Z' }, { rows: [{ ...capture.rows[0], sourceId: 'nse-sme' }] }, { rows: [{ ...capture.rows[0], url: 'https://evil.test/a.pdf' }] }]) assert.throws(() => validateBseCapture({ ...capture, ...patch }, now()));
});
await test('missing credentials do not send any request', async () => {
  let calls = 0; await assert.rejects(readBseCollector({ fetcher: () => { calls++; }, now }), /credential/); assert.equal(calls, 0);
});
await test('seven-source capture uses the collector without a direct BSE connection', async () => {
  const f = await fixture(); const readBse = () => readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now });
  const p = await captureIpoFilings({ now, readBse, fetcher: async (url) => { assert(!url.includes('bsesme.com')); return new Response('', { status: 503 }); } });
  assert.equal(p.sources.find((s) => s.id === 'bse-sme').checkedAt, at); assert.equal(p.rows.length, 2); assert(p.ok);
  const failed = await captureIpoFilings({ now, readBse: async () => { throw Error('Collector unavailable'); }, fetcher: async () => new Response('', { status: 503 }) });
  assert(!failed.ok); assert.equal(failed.sources.find((s) => s.id === 'bse-sme').status, 'failed');
});
await test('fresh envelope cannot disguise an old BSE capture in tab or source panel', async () => {
  const f = await fixture(); const out = await readBseCollector({ token: 'fixture-token', fetcher: f.fetcher, now });
  const sources = IPO_SOURCES.map((s) => s.id === 'bse-sme' ? out.source : { id: s.id, label: s.label, status: 'ok', checkedAt: new Date(now()).toISOString(), note: '', count: 1 });
  let clock = now();
  const p = () => ({ version: 1, ok: true, checkedAt: new Date(clock).toISOString(), rows: out.rows, sources: sources.map((s) => s.id === 'bse-sme' ? s : { ...s, checkedAt: new Date(clock).toISOString() }) });
  const feed = createIpoFilingsFeed({ now: () => clock, readLive: async () => p(), readSnapshot: async () => p(), readSaved: async () => null, save: async () => {} });
  await feed.load(); assert(!feed.meta().stale);
  let item = ipoSourceGroup(feed.meta(), clock).items.find((s) => s.id === 'bse-sme'); assert.equal(item.readLabel, 'Collected'); assert(item.details[0].startsWith('BSE collected:'));
  clock += 11 * 60000; await feed.refresh(); assert(feed.meta().stale); assert(feed.meta().degraded);
  item = ipoSourceGroup(feed.meta(), clock).items.find((s) => s.id === 'bse-sme'); assert.equal(item.readLabel, 'Dated');
});
await test('workflow stores bounded artifacts, not direct-to-main commits or deployments', () => {
  const workflow = readFileSync(new URL('../.github/workflows/bse-ipo-refresh.yml', import.meta.url), 'utf8');
  assert(workflow.includes('contents: read')); assert(workflow.includes('archive: false')); assert(workflow.includes('retention-days: 2'));
  assert(!/git push|contents: write|wrangler|workflow_dispatch.*POST/.test(workflow));
});
console.log(`${count} BSE collector checks passed`);
