import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Local workerd only: exercise the actual Durable Object, SQL, RPC and restart persistence.
const scratch = mkdtempSync(join(tmpdir(), 'sattva-telegram-runtime-'));
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
      return Response.json({workflow_runs:[]});
    };
  }
  async inspect() {
    return { ...await this.status(), alarm:await this.ctx.storage.getAlarm(), posts:await this.ctx.storage.get('test-posts') || 0 };
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
  assert.deepEqual(await read(), {enabled:false,intervalSeconds:600,nextAttemptAt:null,lastAttemptAt:null,lastResult:'not-started',reason:null,failures:0,alarm:null,posts:0});
  const results=await Promise.all(Array.from({length:12},async()=> (await post('/start')).json()));
  assert.equal(results.filter(result=>result.dispatched).length,1);
  const first=await read();
  assert.equal(first.posts,1); assert(first.alarm>Date.now());
  const company=await (await fetch(`${origin}/company`)).json();
  assert.equal(company.companies.length,1);
  assert.equal(company.alarm,null,'company registry objects never arm collection');
  assert.equal(company.enabled,false); assert.equal(company.posts,0,'distinct objects isolate registry data from the channel timer');
  await stop(); await start();
  assert.deepEqual(await read(),first,'actual SQL storage, alarm and claim survive full runtime restart');
  await post('/soon');
  // No requests keep the object active while the real workerd alarm fires.
  await new Promise(done=>setTimeout(done,5000));
  const after=await read();
  assert.equal(after.posts,2,'the alarm dispatches again without a browser request');
  assert.equal(after.lastResult,'dispatched');
  assert(after.alarm>Date.now()+500000,'the alarm has scheduled its next recurrence');
  assert.equal((await (await post('/start')).json()).reason,'cooling-down');
  assert.equal((await read()).posts,2);
  console.log('PASS local workerd Telegram timer: real RPC/storage, concurrent deduplication, full restart persistence and autonomous recurring alarm');
} finally { await stop(); rmSync(scratch,{recursive:true,force:true}); }
