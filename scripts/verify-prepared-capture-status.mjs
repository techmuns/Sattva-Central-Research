import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareCaptureStatus, prepareHealthPlan } from './prepare-capture-status.mjs';
import { CAPTURE_FILES, CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE, captureStatus } from '../worker/capture-status-contract.mjs';
import { handleCaptureStatus, handleFilingsHealth, healthFromPlan } from '../worker/capture-status.mjs';
import { assessFilingsHealth, FILINGS_HEALTH_FILES, FILINGS_HEALTH_LIMITS } from '../public/js/data/filings-health-shared.js';

const now = Date.parse('2026-10-29T04:00:00Z'), stamp = offset => new Date(now + offset).toISOString();
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
