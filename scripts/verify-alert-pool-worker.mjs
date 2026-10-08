// Run under npx --package=wrangler@4.119.0, or set WRANGLER_PACKAGE to its package.json.
// The alert pool route in workerd: artifact discovery, byte-range reads of a stored-member ZIP,
// gzip members passed through unchanged, immutable member caching, the index's short cache and
// every refusal a storage or archive can earn. No credential ever reaches storage.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { ALERT_POOL_CONTRACT } from '../public/js/data/alert-pool-shared.js';
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
  for (const [name, data, { extraLength = 4, localName = name } = {}] of members) {
    const nameBytes = Buffer.from(name);
    const localNameBytes = Buffer.from(localName);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(localNameBytes.length, 26); local.writeUInt16LE(extraLength, 28);
    const extra = Buffer.alloc(extraLength);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, localNameBytes, extra, data);
    centrals.push(central, nameBytes);
    offset += 30 + localNameBytes.length + extra.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const day = '2026-09-18';
const index = { version: 1, contract: ALERT_POOL_CONTRACT, day, builtAt: `${day}T06:00:00Z`, captures: {}, feeds: {}, days: [{ day, member: `days/${day}.json.gz` }], ai: [{ span: day, member: `ai/${day}.json.gz` }] };
const shard = { version: 1, contract: ALERT_POOL_CONTRACT, day, feeds: { technicals: { events: [{ id: 'tech:X', feed: 'technicals', headline: 'x', day }], order: [0], companions: { events: [], order: [] } } } };
const padding = Buffer.alloc(1024 * 1024, 'p'); // the tail must not read the complete archive
const archive = zip([['index.json', Buffer.from(JSON.stringify(index))], ['padding.bin', padding], [`days/${day}.json.gz`, gzipSync(JSON.stringify(shard))],
  [`days/${day}.technicals.json.gz`, gzipSync(JSON.stringify(shard))],
  [`days/${day}.news.json.gz`, gzipSync(JSON.stringify(shard)), { extraLength: 1024 }],
  [`days/${day}.announcements.json.gz`, gzipSync(JSON.stringify(shard)), { localName: `oops/${day}.announcements.json.gz` }],
  ['ai/oops.txt', Buffer.from('not json')], [`ai/${day}.json.gz`, Buffer.from('plain, not gzip')]]);

// Model the hosted fetch cache: it can fill the complete archive, then return a
// perfectly valid 206 slice. Counting origin reads catches that hidden download.
const bundle = await build({ stdin: { contents: `import {handleAlertPool} from './worker/alert-pool.mjs';
  const fetchImpl = async (address, options) => {
    const headers = new Headers(options?.headers);
    if (new URL(address).hostname === 'storage.example' && headers.has('range') && options.cache !== 'no-store') {
      const [start, end] = headers.get('range').slice(6).split('-').map(Number);
      headers.delete('range');
      const full = await fetch(address, { ...options, headers });
      const bytes = new Uint8Array(await full.arrayBuffer());
      const last = Math.min(end, bytes.length - 1);
      return new Response(bytes.slice(start, last + 1), { status: 206,
        headers: { 'content-range': 'bytes ' + start + '-' + last + '/' + bytes.length } });
    }
    return fetch(address, options);
  };
  export default { fetch: (request, env, ctx) => handleAlertPool(request, env, ctx, { fetchImpl }) };`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' });
let calls = 0, ranges = [], fullReads = 0, rangeSupport = true, wrongRange = false;
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
    if (/\/(99|98|97)\/zip$/.test(url)) return new Response(null, { status: 302, headers: { location: 'https://storage.example/alert-pool.zip' } });
    if (url.endsWith('/404/zip')) return new Response('gone', { status: 404 });
    if (url.startsWith('https://storage.example/')) {
      assert.equal(request.headers.get('authorization'), null, 'no credential reaches storage');
      const range = request.headers.get('range');
      // Match the real Azure artifact host: suffix ranges are ignored and return 200.
      if (!rangeSupport || !range || /^bytes=-/.test(range)) { fullReads++; return new Response(archive); }
      ranges.push(range);
      const span = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert(span, 'storage reads always specify absolute offsets');
      const start = Number(span[1]), end = Math.min(archive.length - 1, Number(span[2]));
      return new Response(archive.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${wrongRange ? start + 1 : start}-${end}/${archive.length}` } });
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
  assert.equal(fullReads, 0, 'the fetch cache must not download the archive whole behind a valid 206 response');
  assert(ranges.includes(`bytes=${archive.length - (65557 + 256 * 1024)}-${archive.length - 1}`), 'the directory is read from an absolute archive-tail range');
  assert(ranges.includes('bytes=0-0'), 'a single-byte probe obtains the actual storage length');

  const beforeMember = ranges.length;
  const member = await fetch(new URL(`/api/alert-pool/99/days/${day}.json.gz`, base));
  assert.equal(member.status, 200);
  assert.match(member.headers.get('cache-control'), /immutable/);
  assert.deepEqual(await member.json(), shard, 'the stored gzip member decodes once, in the client');
  assert.equal(ranges.length - beforeMember, 1, 'one bounded storage read includes both the local header and complete member');
  const directoryReads = ranges.filter((r) => r === 'bytes=0-0').length;
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
  const separate = await fetch(new URL(`/api/alert-pool/99/days/${day}.technicals.json.gz`, base));
  assert.equal(separate.status, 200);
  assert.deepEqual(await separate.json(), shard, 'a per-feed member uses the same bounded range and gzip delivery');
  const beforeExtra = ranges.length;
  const extended = await fetch(new URL(`/api/alert-pool/99/days/${day}.news.json.gz`, base));
  assert.deepEqual(await extended.json(), shard, 'a large ZIP extra field still returns the exact complete payload');
  assert.equal(ranges.length - beforeExtra, 2, 'unusual extra fields use the bounded exact-range fallback');
  assert.equal((await fetch(new URL(`/api/alert-pool/99/days/${day}.announcements.json.gz`, base))).status, 503,
    'a mismatched local filename cannot return another member as the requested feed');
  assert.equal((await fetch(new URL(`/api/alert-pool/99/days/${day}.private.json.gz`, base))).status, 404,
    'only explicitly public pool feeds can be addressed');

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
  rangeSupport = true; wrongRange = true;
  assert.equal((await fetch(new URL(`/api/alert-pool/97/days/${day}.json.gz`, base))).status, 503,
    'an incorrect Content-Range cannot be accepted as a valid size probe');
  console.log('PASS workerd: alert pool index and members by byte range, gzip pass-through, immutable caching, 304s and every refusal');
} finally { await mf.dispose(); }
