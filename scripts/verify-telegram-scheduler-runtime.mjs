import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Local workerd only: exercise the actual Durable Object, SQL, RPC and restart persistence.
mkdirSync('.cache',{recursive:true});
const scratch = mkdtempSync(resolve('.cache/sattva-telegram-runtime-'));
const portFinder = createServer(); await new Promise(done => portFinder.listen(0, '127.0.0.1', done));
const port = portFinder.address().port; await new Promise(done => portFinder.close(done));
const origin = `http://127.0.0.1:${port}`;
const config = join(scratch, 'wrangler.json');
const fixture = join(scratch, 'entry.mjs');
writeFileSync(fixture, `
import { CaptureRegistry } from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
export class TestScheduler extends CaptureRegistry {
  constructor(ctx, env) {
    super(ctx, env);
    this.schedule.fetcher = async (url, init) => {
      if (!String(url).startsWith('https://api.github.com/repos/techmuns/Sattva-Central-Research/')) throw Error('Unexpected destination');
      if (init.method === 'POST') {
        await ctx.storage.put('test-posts', (await ctx.storage.get('test-posts') || 0) + 1);
        return new Response(null, {status:204});
      }
      return Response.json({total_count:0,workflow_runs:[]});
    };
  }
  async inspect() {
    return { ...await this.status(), alarm:await this.ctx.storage.getAlarm(), posts:await this.ctx.storage.get('test-posts') || 0, legacy:await this.ctx.storage.get('schedule') || null };
  }
  async soon() {
    const at=Date.now()+3000;
    await this.ctx.storage.transaction(async tx=> {
      await tx.put('schedule', {...await tx.get('schedule'),nextAttemptAt:at});
      await tx.setAlarm(at);
    });
  }
}
export default {async fetch(request,env) {
  const stub=env.TEST_TIMER.getByName('test-channel');
  const path=new URL(request.url).pathname;
  if(path==='/company') {
    const registry=env.TEST_TIMER.getByName('company-shard');
    await registry.register([{isin:'INE002A01018',ticker:'RELIANCE',name:'Reliance Industries'}]);
    return Response.json({...await registry.inspect(),companies:await registry.list()});
  }
  if(request.method==='POST' && path==='/start') return Response.json(await stub.request('auto'));
  if(request.method==='POST' && path==='/soon') {await stub.soon();return new Response('ok');}
  return Response.json(await stub.inspect());
}};
`);
writeFileSync(config, JSON.stringify({ name:'telegram-timer-local-test',main:fixture,compatibility_date:'2026-05-23',
  durable_objects:{bindings:[{name:'TEST_TIMER',class_name:'TestScheduler'}]},
  migrations:[{tag:'test-v1',new_sqlite_classes:['TestScheduler']}],
  vars:{GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main',GH_DISPATCH_TOKEN:'fake-local-token'} }));
let child, logs = '';
async function start() {
  child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(scratch, 'state')],
    { cwd: scratch, detached: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local Worker exited: ${logs}`);
    try { const response = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Wait for the local listener. */ }
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
const read = async () => (await fetch(`${origin}/status`)).json();
const post = path => fetch(`${origin}${path}`, {method:'POST'});
try {
  await start();
  const initial=await read();assert.equal(initial.runtime,'github-actions');assert.equal(initial.alarm,null);assert.equal(initial.posts,0);
  assert((await (await post('/start')).json()).dispatched);
  const first=await read();assert.equal(first.posts,1);assert.equal(first.alarm,null,'Explicit refresh cannot arm a Cloudflare timer');
  const company=await (await fetch(`${origin}/company`)).json();assert.equal(company.companies.length,1);assert.equal(company.alarm,null);assert.equal(company.posts,0);
  await post('/soon');const legacy=await read();assert(legacy.alarm>Date.now());
  await stop();await start();
  await new Promise(done=>setTimeout(done,5000));
  const retired=await read();assert.equal(retired.alarm,null,'An existing Telegram alarm retires after restart');
  assert.equal(retired.posts,1,'The old alarm cannot dispatch background work from Cloudflare');
  assert.deepEqual(retired.legacy,legacy.legacy,'Retiring the timer preserves its existing history');
  console.log('PASS local workerd Telegram migration: old alarm retires without dispatch, legacy state survives restart, explicit refresh stays stateless and company storage is isolated');
} finally { await stop(); rmSync(scratch,{recursive:true,force:true}); }
