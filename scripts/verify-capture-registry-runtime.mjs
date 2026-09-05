import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Local workerd only: exercise the actual Durable Object, SQL, RPC and restart persistence.
const scratch = mkdtempSync(join(tmpdir(), 'sattva-registry-runtime-'));
const portFinder = createServer(); await new Promise(done => portFinder.listen(0, '127.0.0.1', done));
const port = portFinder.address().port; await new Promise(done => portFinder.close(done));
const origin = `http://127.0.0.1:${port}`;
const config = join(scratch, 'wrangler.json');
writeFileSync(config, JSON.stringify({ name: 'capture-registry-local-test', main: resolve('worker/entry.js'), compatibility_date: '2026-05-23',
  assets: { directory: resolve('public'), binding: 'ASSETS' },
  durable_objects: { bindings: [{ name: 'CAPTURE_REGISTRY', class_name: 'CaptureRegistry' }] },
  migrations: [{ tag: 'capture-registry-v1', new_sqlite_classes: ['CaptureRegistry'] }],
  ratelimits: [{ name: 'CAPTURE_REGISTRATION_LIMITER', namespace_id: '1702', simple: { limit: 6, period: 60 } }] }));
let child, logs = '';
async function start() {
  child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(scratch, 'state')],
    { cwd: scratch, detached: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local Worker exited: ${logs}`);
    try { const response = await fetch(`${origin}/api/capture-registration`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Wait for the local listener. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Local Worker did not start: ${logs}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }, 5000);
  try { process.kill(-child.pid, 'SIGTERM'); await done; } finally { clearTimeout(timer); }
}
const read = async () => (await fetch(`${origin}/api/capture-registration`)).json();
async function register(tickers) {
  const response = await fetch(`${origin}/api/capture-registration`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tickers }) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
try {
  await start(); assert.equal((await read()).count, 0);
  const result = await register(['RELIANCE', 'TCS']);
  assert.deepEqual(result.registered, ['RELIANCE', 'TCS']);
  await Promise.all([register(['RELIANCE', 'INFY']), register(['TCS', 'HDFCBANK'])]);
  const before = await read();
  assert.equal(before.count, 4, 'concurrent writes preserve distinct issuers and deduplicate repeats');
  assert(before.companies.every(c => Object.keys(c).sort().join(',') === 'isin,name,ticker'));
  await stop(); await start();
  assert.deepEqual((await read()).companies, before.companies, 'registrations survive complete local Worker restart');
  const denied = await fetch(`${origin}/api/capture-registration`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ tickers: ['ITC'] }) });
  assert.equal(denied.status, 403); assert.equal((await read()).count, 4);
  console.log('PASS local workerd: real SQL/RPC registration, concurrent deduplication, privacy projection and persistence across restart');
} finally { await stop(); rmSync(scratch, { recursive: true, force: true }); }
