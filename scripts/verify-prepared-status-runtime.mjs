// Run under npx --package=wrangler@4.119.0, or with WRANGLER_PACKAGE.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCaptureStatus } from './prepare-capture-status.mjs';
import { CAPTURE_FILES, CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE } from '../worker/capture-status-contract.mjs';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map(dir => join(dir, 'wrangler')).find(existsSync);
if (!location) throw Error('Run under npx --package=wrangler@4.119.0');
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare'), { build } = require('esbuild');
await fs.mkdir('.cache', { recursive: true });
const root = await fs.mkdtemp(resolve('.cache/status-runtime-')), publicRoot = join(root, 'public');
const now = Date.now() - 10000, stamp = new Date(now).toISOString();
for (const file of Object.values(CAPTURE_FILES)) {
  const target = join(publicRoot, file.slice(1)); await fs.mkdir(join(target, '..'), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ capturedAt: stamp, rows: [{ id: 'old', date: '2024-01-01' }], sources: [] }));
}
await prepareCaptureStatus({ publicRoot, now, sourceRevision: 'a'.repeat(40) });
const bundle = await build({ stdin: { contents: `import {handleCaptureStatus,handleFilingsHealth} from './worker/capture-status.mjs';
export default {fetch(request,env,ctx){const url=new URL(request.url), options={now:Number(url.searchParams.get('at'))||Date.now(),exchange:async()=>({ok:true,capturedAt:null,artifactId:123})};
return url.pathname==='/api/capture-status'?handleCaptureStatus(request,env,ctx,options):handleFilingsHealth(request,env,ctx,options);}};`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' });
let reads = [], unavailable = false;
const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  outboundService: () => { throw Error('Prepared health must not call an external service'); },
  serviceBindings: { ASSETS: async request => {
    assert.equal(request.headers.has('authorization'), false);
    const pathname = new URL(request.url).pathname; reads.push(pathname);
    assert([CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE].includes(pathname));
    return unavailable ? new Response(null, { status: 404 }) : new Response(await fs.readFile(join(publicRoot, pathname.slice(1))));
  } } };
let mf = new Miniflare(options);
try {
  let base = await mf.ready;
  let response = await fetch(new URL('/api/capture-status', base), { headers: { authorization: 'private-reader' } });
  assert.equal(response.status, 200); let status = await response.json();
  assert.equal(status.captures.marketNews.capturedAt, stamp); assert.equal(status.captures.exchangeDeals.artifactId, 123);
  assert.equal(status.sourceRevision, 'a'.repeat(40));
  response = await fetch(new URL(`/api/filings-health?at=${now + 49 * 3600000}`, base));
  assert.equal(response.status, 503); assert.equal((await response.json()).status, 'critical');
  assert.equal(reads.length, 2, 'Only compact files cross the workerd service binding');
  unavailable = true; assert.equal((await fetch(new URL('/api/capture-status', base))).status, 503);
  unavailable = false;
  const file = join(publicRoot, 'data/market-news.json');
  await fs.writeFile(file, JSON.stringify({ capturedAt: new Date(now + 1000).toISOString(), rows: [{ id: 'old' }, { id: 'new' }], sources: [] }));
  await prepareCaptureStatus({ publicRoot, now: now + 1000, sourceRevision: 'b'.repeat(40) });
  await mf.dispose(); mf = new Miniflare(options); base = await mf.ready;
  status = await (await fetch(new URL('/api/capture-status', base))).json();
  assert.equal(status.sourceRevision, 'b'.repeat(40)); assert.equal(status.captures.marketNews.capturedAt, new Date(now + 1000).toISOString());
  assert.equal(JSON.parse(await fs.readFile(file)).rows.length, 2, 'Restart and publication preserve old and new evidence');
  console.log(`PASS native workerd status delivery, failure handling, time ageing and restart/publication adoption. Evidence: ${root}`);
} finally { await mf.dispose(); }
