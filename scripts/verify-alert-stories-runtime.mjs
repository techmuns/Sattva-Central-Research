// Real Durable Object RPC and SQLite under workerd. All model traffic is fixture-only.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map(dir => join(dir, 'wrangler')).find(existsSync);
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const bundle = await build({ stdin: { contents: `import {handleAlertStories} from './worker/alert-stories.mjs'; export {CaptureRegistry} from './worker/capture-registry-object.mjs'; export default {fetch:(r,e)=>handleAlertStories(r,e)};`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
let calls = 0, malformed = false;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  durableObjects: { CAPTURE_REGISTRY: { className: 'CaptureRegistry', useSQLite: true } },
  bindings: { CLAUDE_KEY: 'ABSKfixture-key-for-local-tests' },
  outboundService: async request => {
    calls++; assert.equal(new URL(request.url).hostname, 'bedrock-runtime.ap-south-1.amazonaws.com');
    const body = await request.json(), input = JSON.parse(body.messages[0].content);
    assert.equal(request.headers.get('x-api-key'), 'ABSKfixture-key-for-local-tests');
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify([
      { developments: [{ reports: input.reports.slice(0, malformed ? 1 : undefined).map(r => r.id), change: 'new' }] }
    ]) }] });
  },
});
try {
  const base = await mf.ready;
  const record = { company: 'ALPHA', name: 'Alpha Bank', relation: 'direct', feed: 'news', day: '2026-09-23', time: '',
    headline: 'Alpha Bank proposes merger with Beta Bank', text: '', direction: 'neutral', importance: 'high' };
  const body = { version: 1, reports: [0, 1].map(i => ({ ...record, id: `r${i}`, url: `https://outlet${i}.example/news` })) };
  const send = (payload = body, origin = base.origin) => fetch(new URL('/api/alert-stories', base), { method: 'POST', headers: {origin,'content-type':'application/json'}, body: JSON.stringify(payload) });
  assert.equal((await send(body, 'https://other.example')).status, 403);
  const replies = await Promise.all([send(), send()]);
  assert(replies.every(r => [200, 429].includes(r.status)));
  assert.equal(calls, 1, 'concurrent readers reserve only one paid request');
  assert((await (await send()).json()).ok);assert.equal(calls, 1, 'durable cached partition is reused');
  malformed = true;
  const changed = { ...body, reports: body.reports.map(r => ({ ...r, headline: r.headline + ' today' })) };
  const failed = await send(changed);assert.equal(failed.status, 503);assert.equal((await failed.json()).ok, false);
  assert.equal((await send(changed)).status, 200, 'cached failed reading is a JSON status, never an empty source');
  assert.equal(calls, 2, 'failure cooldown prevents repeated model requests');
  assert.equal((await send({version:1,reports:[]})).status,400);
  console.log('PASS: story grouping route and durable SQLite cache in the native Worker runtime; concurrent dedupe, origin guard and incomplete-model failure.');
} finally {await mf.dispose();}
