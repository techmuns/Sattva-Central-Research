// Run under npx --package=wrangler@4.119.0, or set WRANGLER_PACKAGE to its package.json.
// The alert pool route in workerd: artifact discovery, byte-range reads of a stored-member ZIP,
// gzip members passed through unchanged, immutable member caching, the index's short cache and
// every refusal a storage or archive can earn. No credential ever reaches storage.
import assert from 'node:assert/strict';
import { ALERT_POOL_CONTRACT } from '../public/js/data/alert-pool-shared.js';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map((dir) => join(dir, 'wrangler')).find(existsSync);
if (!location) throw new Error('Run with npx --package=wrangler@4.119.0 or set WRANGLER_PACKAGE');
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');

// A stored-member ZIP exactly as upload-artifact writes one at compression-level 0, with data
// descriptors on the local headers as its streaming writer leaves them.
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
const day = '2026-09-18';
const index = { version: 1, contract: ALERT_POOL_CONTRACT, day, builtAt: `${day}T06:00:00Z`, captures: {}, feeds: {}, days: [{ day, member: `days/${day}.json.gz` }], ai: [{ span: day, member: `ai/${day}.json.gz` }] };
const shard = { version: 1, contract: ALERT_POOL_CONTRACT, day, feeds: { technicals: { events: [{ id: 'tech:X', feed: 'technicals', headline: 'x', day }], order: [0], companions: { events: [], order: [] } } } };
const padding = Buffer.alloc(300 * 1024, 'p'); // pushes the directory past the tail read of a small archive
const archive = zip([['index.json', Buffer.from(JSON.stringify(index))], ['padding.bin', padding], [`days/${day}.json.gz`, gzipSync(JSON.stringify(shard))], ['ai/oops.txt', Buffer.from('not json')], [`ai/${day}.json.gz`, Buffer.from('plain, not gzip')]]);

const bundle = await build({ stdin: { contents: `import {handleAlertPool} from './worker/alert-pool.mjs'; export default { fetch: (request, env, ctx) => handleAlertPool(request, env, ctx) };`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' });
let calls = 0, ranges = [], fullReads = 0, rangeSupport = true;
const mf = new Miniflare({ workers: [{ name: 'alert-pool-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  bindings: { GH_REPO: 'org/repo', GH_DISPATCH_TOKEN: 'test-token' },
  serviceBindings: { ASSETS: () => Response.json({ error: 'unexpected fallback' }) },
  outboundService: (request) => {
    calls++;
    const url = request.url;
    if (url.includes('/workflows/alert-pool-refresh.yml/runs')) {
      assert.equal(request.headers.get('authorization'), 'Bearer test-token');
      return Response.json({ workflow_runs: [{ id: 7, event: 'workflow_run', head_branch: 'main', head_repository: { full_name: 'org/repo' } }] });
    }
    if (url.includes('/runs/7/artifacts')) return Response.json({ artifacts: [{ id: 99, name: 'alert-pool', size_in_bytes: archive.length, expired: false, created_at: '2026-09-18T06:01:00Z' }] });
    if (url.endsWith('/99/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/alert-pool.zip' } });
    if (url.endsWith('/404/zip')) return new Response('gone', { status: 404 });
    if (url.startsWith('https://storage.example/')) {
      assert.equal(request.headers.get('authorization'), null, 'no credential reaches storage');
      const range = request.headers.get('range');
      if (!rangeSupport || !range) { fullReads++; return new Response(archive); }
      ranges.push(range);
      const suffix = /^bytes=-(\d+)$/.exec(range), span = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = suffix ? Math.max(0, archive.length - Number(suffix[1])) : Number(span[1]);
      const end = suffix ? archive.length - 1 : Math.min(archive.length - 1, Number(span[2]));
      return new Response(archive.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${archive.length}` } });
    }
    return new Response('unexpected', { status: 500 });
  },
}] });
try {
  const base = await mf.ready;
  const indexResponse = await fetch(new URL('/api/alert-pool/index', base));
  assert.equal(indexResponse.status, 200);
  const served = await indexResponse.json();
  assert.equal(served.artifact, 99, 'the index carries the artifact id the browser addresses members by');
  assert.equal(served.day, day);
  assert.match(indexResponse.headers.get('cache-control'), /max-age=60/);
  assert(ranges.some((r) => /^bytes=-\d+$/.test(r)), 'the directory is read from the archive tail');
  assert.equal(fullReads, 0, 'the archive is never downloaded whole');

  const member = await fetch(new URL(`/api/alert-pool/99/days/${day}.json.gz`, base));
  assert.equal(member.status, 200);
  assert.match(member.headers.get('cache-control'), /immutable/);
  assert.deepEqual(await member.json(), shard, 'the stored gzip member decodes once, in the client');
  const directoryReads = ranges.filter((r) => /^bytes=-\d+$/.test(r)).length;
  assert.equal(directoryReads, 1, 'the directory is read once per artifact and kept at the edge');
  const before = calls;
  let cached = false;
  for (let i = 0; i < 20 && !cached; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await fetch(new URL(`/api/alert-pool/99/days/${day}.json.gz`, base));
    assert.deepEqual(await again.json(), shard);
    cached = again.headers.get('x-sattva-cache') === 'hit';
  }
  assert(cached, 'a member is served from the edge cache after its first read');
  assert.equal(calls, before, 'a cached member costs no upstream request');
  const conditional = await fetch(new URL(`/api/alert-pool/99/days/${day}.json.gz`, base), { headers: { 'if-none-match': member.headers.get('etag') } });
  assert.equal(conditional.status, 304);

  assert.equal((await fetch(new URL('/api/alert-pool/99/ai/oops.txt', base))).status, 404, 'a name outside the contract is refused');
  assert.equal((await fetch(new URL('/api/alert-pool/99/days/2026-01-01.json.gz', base))).status, 404, 'a member the archive lacks is missing, not empty');
  assert.equal((await fetch(new URL(`/api/alert-pool/99/ai/${day}.json.gz`, base))).status, 503, 'a member that is not gzip is refused');
  assert.equal((await fetch(new URL(`/api/alert-pool/404/days/${day}.json.gz`, base))).status, 404, 'an expired artifact is gone');
  assert.equal((await fetch(new URL('/api/alert-pool/index', base), { method: 'POST' })).status, 405);

  rangeSupport = false;
  const refused = await fetch(new URL('/api/alert-pool/404/index', base));
  assert.equal(refused.status, 404);
  const noRange = await fetch(new URL(`/api/alert-pool/98/days/${day}.json.gz`, base));
  assert.equal(noRange.status, 503, 'a storage answering a range with the whole archive is refused rather than read into memory');
  console.log('PASS workerd: alert pool index and members by byte range, gzip pass-through, immutable caching, 304s and every refusal');
} finally { await mf.dispose(); }
