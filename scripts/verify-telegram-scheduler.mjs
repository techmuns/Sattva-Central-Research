import assert from 'node:assert/strict';
import { TelegramSchedule, TELEGRAM_INTERVAL_MS, TELEGRAM_SCHEDULER_NAME, TELEGRAM_PRODUCTION_HOST } from '../worker/telegram-scheduler.mjs';
import worker from '../worker/index.js';

class Store {
  data = new Map(); alarm = null; tail = Promise.resolve();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  transaction(fn) {
    const result = this.tail.then(() => fn(this));
    this.tail = result.catch(() => {});
    return result;
  }
}
const env = { GH_DISPATCH_TOKEN: 'local-test-secret', GH_REPO: 'techmuns/Sattva-Central-Research', GH_REF: 'main' };
let time = Date.parse('2026-09-06T09:00:00Z'), posts = 0, calls = 0, scenario = 'ok', recentAt = null;
const fetcher = async (input, init) => {
  calls++;
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.github.com');
  assert(url.pathname.startsWith('/repos/techmuns/Sattva-Central-Research/actions/workflows/telegram-refresh.yml/'));
  assert.equal(init.headers.Authorization || init.headers.authorization, 'Bearer local-test-secret');
  if (scenario === 'read-error') return new Response('private upstream response', { status: 401 });
  if (init.method === 'POST') {
    posts++;
    assert.deepEqual(JSON.parse(init.body), { ref: 'main', inputs: { source: 'auto' } });
    if (scenario === 'lost-response') throw Error('private upstream response');
    return new Response(null, { status: 204 });
  }
  let runs = [];
  if (scenario === 'running' && url.searchParams.get('status') === 'queued') runs = [{ id: 1, status: 'queued' }];
  if (recentAt && !url.searchParams.has('status')) runs = [{ id: 2, status: 'completed', created_at: recentAt }];
  return Response.json({ workflow_runs: runs });
};
const storage = new Store();
const create = (overrides = {}) => new TelegramSchedule(storage, { ...env, ...overrides }, { fetcher, now: () => time });
let schedule = create();
assert.equal((await schedule.status()).enabled, false);
assert.equal(await storage.getAlarm(), null, 'reading status must not create an alarm or collect');
const simultaneous = await Promise.all(Array.from({ length: 15 }, () => schedule.request('auto')));
assert.equal(posts, 1, 'concurrent requests share one durable claim');
assert.equal(simultaneous.filter(r => r.dispatched).length, 1);
const firstAlarm = await storage.getAlarm();
schedule = create(); // Simulate eviction: nothing important lives only in memory.
assert.equal((await schedule.request('auto')).reason, 'cooling-down');
assert.equal(await storage.getAlarm(), firstAlarm, 'visits do not push the timer into the future');
storage.alarm = null;
await schedule.request('auto');
assert.equal(await storage.getAlarm(), firstAlarm, 'recover the timer without bypassing its claim');
time += TELEGRAM_INTERVAL_MS;
scenario = 'running';
assert.equal((await schedule.request('auto')).reason, 'already-running');
assert.equal(posts, 1, 'an older active run blocks collection');
time += TELEGRAM_INTERVAL_MS;
scenario = 'ok'; recentAt = new Date(time - 60000).toISOString();
assert.equal((await schedule.request('auto')).reason, 'cooling-down');
assert.equal(posts, 1, 'a recent GitHub scheduled run prevents an extra timer run');
time = await storage.getAlarm(); recentAt = null; scenario = 'lost-response';
assert.equal((await schedule.request('auto')).ok, false);
assert.equal(posts, 2);
assert.equal((await create().request('auto')).reason, 'cooling-down');
assert.equal(posts, 2, 'ambiguous POST is not retried on replay or restart');
time = await storage.getAlarm(); scenario = 'read-error';
await schedule.request('auto');
const failed = await schedule.status();
assert.equal(failed.reason, 'unauthorised');
assert.equal(Date.parse(failed.nextAttemptAt) - time, TELEGRAM_INTERVAL_MS * 2);
assert(!JSON.stringify(failed).includes('private'));
assert(!JSON.stringify([...storage.data.values()]).includes('secret'), 'credentials never enter durable storage');
time = await storage.getAlarm(); scenario = 'ok';
assert.equal((await schedule.request('auto')).dispatched, true);
assert.equal((await schedule.status()).failures, 0, 'recover automatically after upstream service recovers');
const beforeInvalid = calls;
time = await storage.getAlarm();
assert.equal((await create({ GH_REF: 'preview' }).request()).reason, 'configuration');
assert.equal(calls, beforeInvalid, 'a misconfigured scheduler must never contact GitHub');
await create({ TELEGRAM_SCHEDULER_DISABLED: 'true' }).request();
assert.equal((await schedule.status()).enabled, false);
assert.equal(await storage.getAlarm(), null);

let starts = 0, reads = 0;
const routeEnv = { TELEGRAM_SCHEDULER: { getByName(name) {
  assert.equal(name, TELEGRAM_SCHEDULER_NAME);
  return { async status() { reads++; return { enabled: true }; }, async request(source) { starts++; assert.equal(source, 'auto'); return { ok: true }; } };
} } };
const request = (path, method = 'GET', host = TELEGRAM_PRODUCTION_HOST) => new Request(`https://${host}${path}`, { method });
assert.equal((await worker.fetch(request('/api/telegram/schedule'), routeEnv, {})).status, 200);
assert.equal(reads, 1); assert.equal(starts, 0);
assert.equal((await worker.fetch(request('/api/telegram/refresh'), routeEnv, {})).status, 405);
assert.equal((await worker.fetch(request('/api/telegram/refresh?source=auto', 'POST', 'preview.example'), routeEnv, {})).status, 403);
assert.equal(starts, 0);
assert.equal((await worker.fetch(request('/api/telegram/refresh?source=auto', 'POST'), routeEnv, {})).status, 200);
assert.equal(starts, 1);
console.log('PASS Telegram timer: durable single claim, restart/replay protection, recent/active runs, recovery/backoff, secret isolation, read-only status and preview boundaries');
