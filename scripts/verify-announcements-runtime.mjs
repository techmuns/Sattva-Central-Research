// Run under npx --package=wrangler@4.119.0, or set WRANGLER_PACKAGE to its package.json.
//
// THE ANNOUNCEMENT ROUTES IN workerd — the index object reading a real stored-member ZIP by byte
// range, the feedback object, AI Read, and every answer crossing real Durable Object RPC.
//
// Node checks never cross the RPC boundary, and an answer workerd cannot serialise fails only there
// (the alert notes once returned `Object.create(null)` and every live call failed with a 503). So the
// index here is a real-data fixture built by the runner's own code, zipped exactly as
// upload-artifact stores it, and served by an outbound stand-in for GitHub and blob storage; the
// exchange document and the model are stand-ins too. Nothing else may be asked.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter } from 'node:path';

const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map((dir) => join(dir, 'wrangler')).find(existsSync);
if (!location) throw new Error('Run with npx --package=wrangler@4.119.0 or set WRANGLER_PACKAGE');
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const repo = fileURLToPath(new URL('../', import.meta.url));
const publicDir = resolve(repo, 'public');
const { buildFixtureIndex } = await import('./lib/announcement-index-fixture.mjs');

// A stored-member ZIP exactly as upload-artifact writes one at compression-level 0.
function zip(members) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of members) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(4, 28);
    const extra = Buffer.from([1, 2, 0, 0]);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, extra, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + extra.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));

const tmp = mkdtempSync(join(tmpdir(), 'announcement-runtime-'));
const { index } = buildFixtureIndex(tmp, { root: publicDir });
const archive = zip(walk(tmp).map((file) => [relative(tmp, file), readFileSync(file)]));

const bundle = await build({
  stdin: { contents: `
    import { handleAnnouncementIndex } from './worker/announcement-index.mjs';
    import { handleAnnouncementRead } from './worker/announcement-read.mjs';
    import { handleRelevanceFeedback } from './worker/relevance-feedback.mjs';
    export { CaptureRegistry } from './worker/capture-registry-object.mjs';
    export default { fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/announcement-index/')) return handleAnnouncementIndex(request, env);
      if (path.startsWith('/api/announcement-read')) return handleAnnouncementRead(request, env);
      if (path.startsWith('/api/relevance/')) return handleRelevanceFeedback(request, env);
      return new Response('not found', { status: 404 });
    } };`, resolveDir: repo },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
});

const pdf = Buffer.from('%PDF-1.7\n%%EOF');
const READING = { readable: true, issuerMatches: true, documentType: 'Exchange filing', whatHappened: 'The company filed the update its subject describes, read from the document.',
  keyDetails: [{ label: 'Filing', value: 'As stated', quote: 'EOF', location: 'page 1' }], whyItMatters: 'It changes what is known about the company this period.',
  impact: { direction: 'unclear', horizon: 'unclear', text: 'Could matter if it changes earnings.' } };
const outbound = { ranges: 0, full: 0, documents: 0, model: 0 };
const TYPES = { '.json': 'application/json' };
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  durableObjects: { CAPTURE_REGISTRY: { className: 'CaptureRegistry', useSQLite: true } },
  ratelimits: {
    RELEVANCE_FEEDBACK_LIMITER: { namespace_id: '1706', simple: { limit: 30, period: 60 } },
    ANNOUNCEMENT_READ_LIMITER: { namespace_id: '1707', simple: { limit: 12, period: 60 } },
    ANNOUNCEMENT_INDEX_LIMITER: { namespace_id: '1708', simple: { limit: 240, period: 60 } },
  },
  bindings: { GH_REPO: 'org/repo', GH_DISPATCH_TOKEN: 'test-token', NSE_LIVE: 'off', CLAUDE_KEY: 'ABSKtest-key-not-real', BEDROCK_REGION: 'ap-south-1' },
  serviceBindings: {
    ASSETS: (request) => {
      const path = new URL(request.url).pathname;
      try { return new Response(readFileSync(join(publicDir, path)), { headers: { 'content-type': TYPES[extname(path)] || 'application/octet-stream' } }); }
      catch { return new Response('missing', { status: 404 }); }
    },
  },
  outboundService: async (request) => {
    const url = request.url;
    if (url.includes('/actions/workflows/announcement-index-refresh.yml/runs')) {
      assert.equal(request.headers.get('authorization'), 'Bearer test-token');
      return Response.json({ workflow_runs: [{ id: 7, event: 'workflow_run', head_branch: 'main', head_repository: { full_name: 'org/repo' } }] });
    }
    if (url.includes('/runs/7/artifacts')) return Response.json({ artifacts: [{ id: 41, name: 'announcement-index', size_in_bytes: archive.length, expired: false, created_at: '2026-10-01T12:00:00Z' }] });
    if (url.endsWith('/artifacts/41/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/announcement-index.zip' } });
    if (url.startsWith('https://storage.example/')) {
      assert.equal(request.headers.get('authorization'), null, 'no credential reaches storage');
      const range = request.headers.get('range');
      if (!range) { outbound.full++; return new Response(archive); }
      outbound.ranges++;
      const suffix = /^bytes=-(\d+)$/.exec(range), span = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = suffix ? Math.max(0, archive.length - Number(suffix[1])) : Number(span[1]);
      const end = suffix ? archive.length - 1 : Math.min(archive.length - 1, Number(span[2]));
      return new Response(archive.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${archive.length}` } });
    }
    if (/^https:\/\/(?:www\.)?bseindia\.com\/|^https:\/\/(?:nsearchives|archives)\.nseindia\.com\//.test(url)) {
      assert.equal(request.headers.get('x-api-key'), null, 'no model credential reaches the exchange');
      outbound.documents++;
      return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    }
    if (url === 'https://bedrock-runtime.ap-south-1.amazonaws.com/anthropic/v1/messages') {
      assert.equal(request.headers.get('x-api-key'), 'ABSKtest-key-not-real');
      outbound.model++;
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(READING) }] });
    }
    return new Response(`unexpected ${url}`, { status: 500 });
  },
});

try {
  const base = await mf.ready;
  const post = (path, body) => fetch(new URL(path, base), { method: 'POST', headers: { origin: base.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 1. A ranked page, across RPC, from the archive by byte range.
  const first = await post('/api/announcement-index/query', { period: 'all', limit: 50 });
  assert.equal(first.status, 200, await first.clone().text());
  const page = await first.json();
  assert.equal(page.total, index.counts.rows);
  assert.equal(page.rows.length, 50);
  assert(page.rows.every((r) => typeof r.id === 'string' && Array.isArray(r.categories) && Array.isArray(r.keys)));
  assert(outbound.ranges > 0 && outbound.full === 0, 'the archive is read by byte range, never whole');
  console.log('PASS workerd: a ranked page from the artifact by byte range, across Durable Object RPC');

  // 2. Filters, facets, a scoped query and a later page.
  const filtered = await (await post('/api/announcement-index/query', { period: 'all', categories: ['results', 'order-win'], mcap: '1000-', limit: 20 })).json();
  assert(filtered.rows.every((r) => (r.categories.includes('results') || r.categories.includes('order-win')) && r.mcapCr >= 1000));
  assert(Object.keys(filtered.facets.categories).length > 20 && Object.keys(filtered.facets.bands).length === 6);
  const scoped = await (await post('/api/announcement-index/query', { period: 'all', scope: 'portfolio', companies: [{ ticker: page.rows.find((r) => r.ticker)?.ticker }] })).json();
  assert(scoped.rows.length >= 1 && scoped.rows.every((r) => r.ticker === scoped.rows[0].ticker));
  const second = await (await post('/api/announcement-index/query', { period: 'all', offset: 50, limit: 50 })).json();
  assert(!second.rows.some((r) => page.rows.some((p) => p.id === r.id)), 'the next page continues the order');
  console.log('PASS workerd: categories + custom market cap, facets, a portfolio scope and paging');

  // 3. Events, profiles, status — conditional reads.
  const all = await (await post('/api/announcement-index/query', { period: 'all', limit: 500 })).json();
  const linked = all.rows.find((r) => r.event?.size > 1);
  const eventUrl = new URL(`/api/announcement-index/event?id=${linked.event.id}&first=${linked.event.first}&last=${linked.event.last}`, base);
  const event = await fetch(eventUrl);
  assert.equal(event.status, 200);
  assert.equal((await event.json()).members.length, linked.event.size);
  assert.equal((await fetch(eventUrl, { headers: { 'if-none-match': event.headers.get('etag') } })).status, 304);
  const profiles = await (await fetch(new URL('/api/announcement-index/profiles', base))).json();
  assert(profiles.ok && profiles.rows.length > 100);
  const status = await (await fetch(new URL('/api/announcement-index/status', base))).json();
  assert(status.ok && status.index.artifact === 41);
  const cross = await fetch(new URL('/api/announcement-index/query', base), { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403, 'a cross-site query is refused');
  console.log('PASS workerd: stitched events (with 304), company profiles, status, same-origin queries');

  // 4. Shared feedback: a vote crosses RPC, the model publishes it, and the index re-ranks on it.
  const top = all.rows[0];
  const voted = await post('/api/relevance/feedback', { surface: 'announcements', vote: 'not-important', itemKey: top.id, eventKey: top.event?.id || null,
    device: 'device-runtime-1', features: top.keys, why: 'routine', label: top.title, company: top.company, categories: top.categories });
  assert.equal(voted.status, 200, await voted.clone().text());
  const model = await (await fetch(new URL('/api/relevance/model', base))).json();
  assert.equal(model.model.votes, 1);
  const mine = await (await fetch(new URL('/api/relevance/mine?device=device-runtime-1', base))).json();
  assert.equal(mine.votes[top.id].vote, 'not-important');
  const reranked = await (await post('/api/announcement-index/query', { period: 'all', limit: 500, modelRevision: model.model.revision })).json();
  const day = reranked.rows.filter((r) => r.date === top.date);
  assert(day.findIndex((r) => r.id === top.id) > 0, 'the vote moves the filing down its day at once');
  assert.equal(reranked.total, all.total, 'and hides nothing');
  console.log('PASS workerd: a vote crosses RPC, publishes in the shared model and re-ranks the index immediately');

  // 5. AI Read across RPC: one model read, then the stored reading.
  const target = all.rows.find((r) => /bseindia|nseindia/.test(r.url || ''));
  const ask = () => post('/api/announcement-read', { id: target.id, url: target.url, title: target.title, company: target.company, ticker: target.ticker, date: target.date });
  const read = await (await ask()).json();
  assert.equal(read.state, 'ready', JSON.stringify(read));
  assert.equal(read.reading.whatHappened, READING.whatHappened);
  const again = await (await ask()).json();
  assert.equal(again.stored, true);
  assert.equal(outbound.model, 1, 'read once, kept');
  const refused = await (await post('/api/announcement-read', { id: 'x', url: 'https://evil.example/doc.pdf' })).json();
  assert.equal(refused.reason, 'unsupported-source');
  console.log('PASS workerd: AI Read crosses RPC, is stored, and fetches exchange documents only');
} finally {
  await mf.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
