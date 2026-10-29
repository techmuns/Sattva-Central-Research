import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareCaptureStatus, prepareHealthPlan } from './prepare-capture-status.mjs';
import { CAPTURE_FILES, CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE, captureStatus } from '../worker/capture-status-contract.mjs';
import { handleCaptureStatus, handleFilingsHealth, healthFromPlan } from '../worker/capture-status.mjs';
import { assessFilingsHealth, FILINGS_HEALTH_FILES, FILINGS_HEALTH_LIMITS } from '../public/js/data/filings-health-shared.js';
import { exchangeCaptureStatus } from '../worker/exchange-deals.mjs';

const now = Date.parse('2026-10-29T04:00:00Z'), stamp = offset => new Date(now + offset).toISOString();
// Removing the large response cache must not multiply GitHub metadata requests.
const edgeEntries = new Map();
const edgeCache = { match: async key => edgeEntries.get(key.url)?.clone(), put: async (key, value) => {
  assert.equal(value.headers.get('cache-control'), 'max-age=30'); edgeEntries.set(key.url, value.clone());
} };
let metadataCalls = 0, artifactId = 123, unavailable = false;
const exchangeEnv = { GH_REPO: 'org/repo', GH_DISPATCH_TOKEN: 'fixture' };
const metadataFetch = async url => {
  metadataCalls++;
  if (unavailable) return new Response('', { status: 503 });
  return String(url).includes('/workflows/')
    ? Response.json({ workflow_runs: [{ id: 1, event: 'push', head_branch: 'main', head_repository: { full_name: exchangeEnv.GH_REPO } }] })
    : Response.json({ artifacts: [{ id: artifactId, name: 'exchange-deals', expired: false, size_in_bytes: 100 }] });
};
const exchangeRequest = new Request('https://family.example/api/capture-status');
const exchangeAt = (at, request = exchangeRequest) => exchangeCaptureStatus(request, exchangeEnv, { cache: edgeCache, fetchImpl: metadataFetch, now: at });
assert.equal((await exchangeAt(now)).artifactId, 123); assert.equal(metadataCalls, 2);
artifactId = 456;
assert.equal((await exchangeAt(now + 29999)).artifactId, 123); assert.equal(metadataCalls, 2);
assert.equal((await exchangeAt(now + 30000)).artifactId, 456); assert.equal(metadataCalls, 4, 'artifact publications are detected after the original 30-second budget');
assert.equal((await exchangeAt(now + 30001, new Request('https://another-family.example/api/capture-status'))).artifactId, 456);
assert.equal(metadataCalls, 6, 'families and origins never share an exchange identity cache');
exchangeEnv.GH_REPO = 'org/another-repo';
assert.equal((await exchangeAt(now + 30002)).artifactId, 456); assert.equal(metadataCalls, 8, 'repository identity is part of the cache key');
unavailable = true;
assert.equal((await exchangeAt(now + 60002)).reason, 'unverified'); assert.equal(metadataCalls, 9);
assert.equal((await exchangeAt(now + 60003)).reason, 'unverified'); assert.equal(metadataCalls, 9, 'failed checks retain the same bounded request budget');
edgeEntries.set(new URL('/api/bulk-block-deals', exchangeRequest.url).href, new Response('retained bytes', { headers: { etag: '"exchange-999"' } }));
assert.equal((await exchangeAt(now + 60004)).artifactId, 999); assert.equal(metadataCalls, 9, 'the actual served archive overrides cached metadata, including failures');
edgeEntries.delete(new URL('/api/bulk-block-deals', exchangeRequest.url).href);
edgeEntries.set(new URL(`/api/_exchange-status-v1/${encodeURIComponent(exchangeEnv.GH_REPO)}`, exchangeRequest.url).href, new Response('corrupt'));
unavailable = false;
assert.equal((await exchangeAt(now + 60005)).artifactId, 456); assert.equal(metadataCalls, 11, 'corrupt metadata cache cannot suppress the live check');
const health = {
  company: { version: 1, createdAt: stamp(-60000), lastRunFinishedAt: stamp(-60000), requestedFrom: '2025-01-01', requestedTo: '2026-10-29',
    companies: [{ ticker: 'CHECKED' }, { ticker: 'NEW' }], sources: {
      announcements: { CHECKED: { lastSuccessAt: stamp(-60000), recentCheckedAt: stamp(-60000), ranges: [{ from: '2025-01-01', to: '2026-10-29' }] }, NEW: { registeredAt: stamp(-60000) } },
      domestic: { CHECKED: { lastSuccessAt: stamp(-60000) }, NEW: { registeredAt: stamp(-60000) } },
    } },
  news: { version: 1, updatedAt: stamp(-60000), entities: [{ entityId: 'a', queries: ['Alpha', 'Alias'] }], queries: { a: { Alpha: { lastSuccessAt: stamp(-60000), lastAttemptAt: stamp(-60000) }, Alias: { lastSuccessAt: stamp(11 * 60000), lastAttemptAt: stamp(11 * 60000) } } } },
  announcements: { byTicker: { CHECKED: [] }, rowCount: 0, failed: [], capturedAt: stamp(-60000), coversUniverse: true, categoryInventoryVerified: true },
  insider: { byTicker: { CHECKED: [] }, rowCount: 0, failed: {}, capturedAt: stamp(-60000), asked: 1, covered: 1, fallback: {} },
  announcementRecovery: { version: 1, rows: [{ documentUnavailable: true }], rowCount: 1, pending: [], ranges: [{ from: stamp(-86400000), to: stamp(-60000) }], captureStart: stamp(-86400000), enqueuedThrough: stamp(-60000), lastAttemptAt: stamp(-60000), lastPageAt: stamp(-60000), lastSuccessAt: stamp(-60000) },
  twitter: { posts: [{ text: 'retained history' }], failed: [], capturedAt: stamp(-60000), collection: { status: 'ok' } },
};
const untouched = structuredClone(health);
for (const value of [health, { ...health, company: null }, { ...health, twitter: { ...health.twitter, collection: { status: 'disabled' } } }]) {
  const plan = prepareHealthPlan(value, { now });
  const times = new Set([now, now + 365 * 86400000]);
  for (const steps of Object.values(plan.sources)) for (const { at } of steps) for (const delta of [-1, 0, 1]) if (at + delta >= now) times.add(at + delta);
  for (let hour = 0; hour <= 72; hour++) times.add(now + hour * 3600000);
  // Also test every advertised threshold even if two deadlines coalesce.
  for (const h of Object.values(FILINGS_HEALTH_LIMITS)) for (const d of [-1, 0, 1]) times.add(now - 60000 + h * 3600000 + d);
  for (const at of times) assert.deepEqual(healthFromPlan(plan, { now: at }), assessFilingsHealth(value, { now: at }), `Exact assessment at ${new Date(at).toISOString()}`);
}
assert.deepEqual(health, untouched, 'Compilation never mutates source evidence');

await fs.mkdir('.cache', { recursive: true });
const root = await fs.mkdtemp(path.resolve('.cache/prepared-status-'));
const publicRoot = path.join(root, 'public'), dataRoot = path.join(publicRoot, 'data');
const sources = new Map(Object.values(CAPTURE_FILES).map(file => [file, {
  capturedAt: stamp(-60000), covered: 5, failedCount: 1, fallbackCount: 1,
  sources: [{ id: 'moneycontrol', capturedAt: stamp(-120000), ok: false }, { id: 'rss', capturedAt: stamp(-60000), ok: true }],
  rows: [{ id: 'old-2024', value: 'retained' }, { id: 'correction', value: 'corrected' }],
}]));
for (const [source, file] of Object.entries(FILINGS_HEALTH_FILES)) sources.set(`/data/${file}`, health[source]);
const hashes = new Map();
for (const [file, value] of sources) {
  const bytes = JSON.stringify(value), destination = path.join(publicRoot, file.slice(1));
  await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
  hashes.set(destination, createHash('sha256').update(bytes).digest('hex'));
}
await prepareCaptureStatus({ publicRoot, now, sourceRevision: 'a'.repeat(40) });
for (const [file, hash] of hashes) assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), hash, 'No capture, correction or retained history is rewritten');
const status = JSON.parse(await fs.readFile(path.join(publicRoot, CAPTURE_STATUS_FILE.slice(1))));
for (const [name, file] of Object.entries(CAPTURE_FILES)) assert.deepEqual(status.captures[name], captureStatus(sources.get(file)), 'Same source clocks, revisions, coverage and failures');
assert.equal(status.captures.marketNews.sources.moneycontrol.ok, false, 'A successful RSS check cannot conceal a failed Moneycontrol check');

let exchangeId = 123, reads = [], missing = false, corrupt = false;
const env = { ASSETS: { fetch: async request => {
  assert.equal(request.headers.has('authorization'), false);
  const file = new URL(request.url).pathname; reads.push(file);
  assert([CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE].includes(file), 'Runtime never reads a full capture');
  if (missing) return new Response('', { status: 404 });
  if (corrupt) return Response.json({ version: 999 });
  return new Response(await fs.readFile(path.join(publicRoot, file.slice(1))));
} } };
const request = route => new Request(`https://fixture.example/api/${route}`, { headers: { authorization: 'private-reader' } });
const options = { now, exchange: async () => ({ ok: true, capturedAt: null, artifactId: exchangeId }) };
let response = await handleCaptureStatus(request('capture-status'), env, {}, options);
assert.equal(response.status, 200); let value = await response.json();
assert.equal(value.captures.exchangeDeals.artifactId, 123); assert.equal(value.servedAt, stamp(0)); assert.equal(value.preparedAt, stamp(0));
exchangeId = 456;
value = await (await handleCaptureStatus(request('capture-status'), env, {}, { ...options, now: now + 1000 })).json();
assert.equal(value.captures.exchangeDeals.artifactId, 456, 'Independently published exchange history is checked live');
assert.equal(value.captures.marketNews.capturedAt, stamp(-60000), 'Request time cannot advance source freshness');
response = await handleFilingsHealth(request('filings-health'), env, {}, { now: now + 49 * 3600000 });
assert.equal(response.status, 503); assert.deepEqual(await response.json(), assessFilingsHealth(health, { now: now + 49 * 3600000 }), 'A stopped deployment ages into the exact stale states');
assert.equal(reads.length, 3);
for (const failure of ['missing', 'corrupt']) {
  missing = failure === 'missing'; corrupt = failure === 'corrupt';
  assert.equal((await handleCaptureStatus(request('capture-status'), env, {}, options)).status, 503);
  const failedHealth = await handleFilingsHealth(request('filings-health'), env, {}, { now });
  assert.equal(failedHealth.status, 503);
  const report = await failedHealth.json();
  assert.equal(report.critical, 1); assert.equal(report.warnings, 0);
  assert.equal(report.findings[0].severity, 'critical');
  assert.deepEqual(report.sources, Object.keys(FILINGS_HEALTH_FILES));
}
missing = corrupt = false;
// Same endpoint after a new publication or Worker restart immediately sees its new manifest.
sources.get('/data/market-news.json').capturedAt = stamp(60000);
sources.get('/data/market-news.json').rows.push({ id: 'late-arrival', value: 'new' });
await fs.writeFile(path.join(dataRoot, 'market-news.json'), JSON.stringify(sources.get('/data/market-news.json')));
await prepareCaptureStatus({ publicRoot, now: now + 60000, sourceRevision: 'b'.repeat(40) });
value = await (await handleCaptureStatus(request('capture-status'), env, {}, { ...options, now: now + 60000 })).json();
assert.equal(value.sourceRevision, 'b'.repeat(40)); assert.equal(value.captures.marketNews.capturedAt, stamp(60000));
await fs.unlink(path.join(dataRoot, 'market-news.json'));
await prepareCaptureStatus({ publicRoot, now: now + 120000 });
value = await (await handleCaptureStatus(request('capture-status'), env, {}, { ...options, now: now + 120000 })).json();
assert.equal(value.captures.marketNews.ok, false, 'A missing source is disclosed independently, never silently made current');
for (const handler of [handleCaptureStatus, handleFilingsHealth]) assert.equal((await handler(new Request('https://fixture.example/api/status', { method: 'POST' }), env, {}, options)).status, 405);

const workflow = await fs.readFile('.github/workflows/deploy.yml', 'utf8');
assert(workflow.indexOf('node scripts/prepare-capture-status.mjs') > workflow.indexOf('node scripts/github-deploy-state.mjs prepare'));
assert(workflow.indexOf('node scripts/prepare-capture-status.mjs') < workflow.indexOf('npx --yes wrangler@4 deploy --dry-run'));
assert(workflow.includes('- "scripts/prepare-capture-status.mjs"'), 'Generator edits trigger publication');
console.log(`PASS prepared status: exact health at every time boundary, independent source failures, live exchange revisions, restart/new-publication adoption, missing/corrupt fail-closed delivery and unchanged retained files. Evidence: ${root}`);
