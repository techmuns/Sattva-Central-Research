// Real bridge/reader queue and invalidation lifecycle; no credentials or network.
import assert from 'node:assert/strict';
const listeners = new Map(), posts = [];
let responder;
const peer = { postMessage(m) { posts.push(m); queueMicrotask(() => responder?.(m)); } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
};
globalThis.document = { hidden: false, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {},
  createElement: tag => ({ contentWindow: tag === 'iframe' ? peer : null, append() {}, setAttribute() {}, close() {}, showModal() {} }) };
globalThis.location = { origin: 'https://central.test' };
const bridge = await import('../public/js/research/portfolio-bridge.js');
const managers = await import('../public/js/data/managers.js');
const emit = data => { for (const fn of [...(listeners.get('message') || [])]) fn({ origin: bridge.FAMILY_ORIGIN, source: peer, data: { channel: bridge.PORTFOLIO_CHANNEL, ...data } }); };
const tick = () => new Promise(done => setImmediate(done));
let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const revision = JSON.stringify(Array.from({ length: 60 }, (_, i) => [`workbook-${i}`, `revision-${i}`, '2026-10-01T00:00:00Z', null]));
const fixture = (checked = clock, sourceRevision = revision) => ({ version: 1, valuation: 'workbook', checkedAt: new Date(checked).toISOString(),
  bookAsOf: '2026-08-31', listedValuationAt: null, listedValuationBasis: null, archiveVersion: 1, sourceRevision,
  coverage: { note: 'Fixture coverage', transactionAsOf: '2026-08-31', sourceCount: 6, privateCount: 0 },
  managers: [{ id: 'custodian-example', name: 'Example', kind: 'custodian', asOf: '2026-08-31', positions: [], transactions: [],
    values: { marketValue: 0, costBasis: 0, unrealised: 0, cashValue: 0, positionCount: 0 } }] });
let reads = [];
responder = m => {
  if (m.type === 'hello') emit({ id: m.id, type: 'ready', capabilities: ['position-sizes', 'manager-workbook'] });
  else if (m.type !== 'cancel') reads.push(m);
};
const reply = (m, value) => emit({ id: m.id, type: 'result', ...value });
const off = managers.onChange(() => {});
try {
  const first = managers.load(); await tick();
  reply(reads.shift(), { managers: fixture() }); await first;
  assert.equal(managers.meta().sourceRevision, revision);
  assert.equal(managers.all().length, 1);

  const failed = managers.load({ force: true }); await tick();
  const broken = fixture(); broken.managers[0].values.positionCount = 1;
  reply(reads.shift(), { managers: broken }); await failed;
  assert.equal(managers.meta(), null, 'failed checks withhold private figures');
  assert.match(managers.failureInfo(), /manager records/);
  assert.doesNotMatch(managers.failureInfo(), /Example|workbook-0|revision-0/, 'diagnostics contain contract sections, never private source values');

  // The manager load waits behind a different private read. A reply newer than
  // load() but older than the actual source request must still be rejected.
  const sizes = bridge.readPositionSizes(undefined, { force: true }); await tick();
  const positionRequest = reads.shift(), beforeQueue = clock;
  const queued = managers.load({ force: true }); clock += 10_000;
  reply(positionRequest, { sizes: { basis: 'listed-market-value', complete: false, bookAsOf: '2026-08-31', checkedAt: new Date(clock).toISOString(), archiveVersion: 1 }, holdings: [] });
  await sizes; await tick();
  reply(reads.shift(), { managers: fixture(beforeQueue + 2000) }); await queued;
  assert.match(managers.failureInfo(), /check time/, 'freshness is measured at the queued request, not load entry');

  const old = managers.load({ force: true }); await tick(); const oldRequest = reads.shift();
  emit({ type: 'invalidated', version: 2 });
  emit({ type: 'positions-ready', version: 2 }); // Reader automatically schedules the replacement.
  const replacement = managers.load();
  assert.notEqual(replacement, old, 'new generation cannot join the revoked read');
  reply(oldRequest, { managers: fixture(clock, 'revoked-revision') }); await old; await tick();
  assert.equal(managers.meta(), null, 'the revoked result cannot repopulate private data');
  assert.equal(managers.load(), replacement, 'old finally cannot clear the new pending operation');
  assert.equal(reads.length, 1, 'ready and manual consumers share one replacement');
  reply(reads.shift(), { managers: fixture(clock, revision + '-new') }); await replacement;
  assert.equal(managers.meta().sourceRevision, revision + '-new');

  let check, timerCancelled = false;
  const realInterval = globalThis.setInterval, realClear = globalThis.clearInterval;
  try {
    globalThis.setInterval = (fn, ms) => { assert.equal(ms, 60_000); check = fn; return 'manager-timer'; };
    globalThis.clearInterval = id => { if (id === 'manager-timer') timerCancelled = true; else realClear(id); };
    const stop = managers.watchFreshness(); await tick(); assert.equal(reads.length, 0);
    clock += 60_000; check();
    for (const fn of listeners.get('focus') || []) fn();
    for (const fn of listeners.get('online') || []) fn();
    await tick(); assert.equal(reads.length, 1, 'timer/focus/reconnection coalesce');
    reply(reads.shift(), { managers: broken }); await managers.load();
    assert.equal(managers.meta(), null);
    clock += 60_000; check(); await tick();
    const recovery = managers.load(); reply(reads.shift(), { managers: fixture() }); await recovery;
    assert.equal(managers.failureInfo(), null, 'next visible check recovers without a Refresh click');
    stop(); assert(timerCancelled); assert.equal(listeners.get('focus').size, 0);
  } finally { globalThis.setInterval = realInterval; globalThis.clearInterval = realClear; }

  const revoked = managers.load({ force: true }); await tick();
  emit({ type: 'auth-required' }); await revoked;
  assert.equal(managers.meta(), null, 'expired access immediately clears private memory');
  assert.equal(bridge.portfolioConnectionState(), 'locked');
  assert.equal(posts.filter(p => p.type === 'read').length, 0, 'manager loading never calls a model question');
  console.log('PASS manager reader: complete catalogue, private failures, queued freshness, invalidation races, single flight, automatic recovery and auth revocation');
} finally { off(); Date.now = realNow; }
