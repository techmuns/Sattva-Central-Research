// Run under npx --package=wrangler@4.119.0, or set WRANGLER_PACKAGE to its package.json.
// Uses workerd locally: catches edge-only fetch and Content-Encoding behaviour Node cannot model.
import assert from 'node:assert/strict';
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
const payload = { version: 1, checkedAt: '2026-09-09T12:13:00Z', records: [['nse-bulk', '2026-09-08', 'TEST', 'Test', 'Example Fund', 'Buy', 10, 50, '']], sources: [] };
const name = Buffer.from('exchange-deals.json.gz'), file = gzipSync(JSON.stringify(payload));
const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(file.length, 20); central.writeUInt32LE(file.length, 24); central.writeUInt16LE(name.length, 28);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(30 + name.length + file.length, 16);
const archive = Buffer.concat([local, name, file, central, name, end]);
const bundle = await build({ stdin: { contents: `import {handleExchangeDeals} from './worker/exchange-deals.mjs'; export default { fetch: handleExchangeDeals };`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' });
let calls = 0;
const mf = new Miniflare({ workers: [{ name: 'exchange-delivery-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  bindings: { GH_REPO: 'org/repo', GH_DISPATCH_TOKEN: 'test-token' },
  serviceBindings: { ASSETS: () => Response.json({ error: 'unexpected fallback' }) },
  outboundService: (request) => {
    calls++;
    const url = request.url;
    if (url.includes('/workflows/')) return Response.json({ workflow_runs: [{ id: 42, event: 'push', head_branch: 'main', head_repository: { full_name: 'org/repo' } }] });
    if (url.includes('/runs/42/')) return Response.json({ artifacts: [{ id: 99, name: 'exchange-deals', size_in_bytes: archive.length, expired: false }] });
    if (url.endsWith('/99/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/capture.zip' } });
    assert.equal(request.headers.get('authorization'), null, 'no credential reaches storage');
    return new Response(archive);
  },
}] });
try {
  const url = new URL('/api/bulk-block-deals', await mf.ready);
  const response = await fetch(url);
  assert.equal(response.headers.get('x-sattva-exchange-fallback'), null);
  assert.deepEqual(await response.json(), payload, 'gzip must be decoded exactly once by HTTP clients');
  let next, cached = false;
  for (let i = 0; i < 10 && !cached; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    next = await fetch(url);
    assert.deepEqual(await next.json(), payload, 'cached gzip must still decode exactly once');
    cached = next.headers.get('x-sattva-cache') === 'hit';
  }
  assert(cached, 'waitUntil must save the response in the edge cache');
  const beforeConditional = calls;
  const unchanged = await fetch(url, { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(calls, beforeConditional, 'conditional reads do not download the archive again');
  console.log('PASS workerd: native fetch redirects, artifact download, single gzip encoding, cache reuse and 304');
} finally { await mf.dispose(); }
