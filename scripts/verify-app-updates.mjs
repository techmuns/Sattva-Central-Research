#!/usr/bin/env node
import assert from 'node:assert/strict';
import { watchAppUpdates, watchWorkerChanges } from '../public/js/core/app-updates.js';

for (const initiallyControlled of [false, true]) {
  const container = new EventTarget();
  container.controller = initiallyControlled ? {} : null;
  let upgrades = 0;
  const dispose = watchWorkerChanges(container, () => { upgrades++; });
  // Losing a controller is not an activation and must not reload.
  container.controller = null;
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(upgrades, 0);
  container.controller = {};
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(upgrades, initiallyControlled ? 1 : 0, 'first install does not reload fresh modules');
  container.controller = {};
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(upgrades, 1, 'later deployment upgrades even a document opened before its first claim');
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(upgrades, 1, 'only one guarded reload is scheduled');
  dispose();
}
const disposedContainer = new EventTarget();
disposedContainer.controller = {};
watchWorkerChanges(disposedContainer, () => assert.fail('disposed listener fired'))();
disposedContainer.dispatchEvent(new Event('controllerchange'));

const doc = new EventTarget(), win = new EventTarget();
doc.visibilityState = 'visible';
let clock = 0, callback, cancelled = 0, calls = 0, resolve;
const registration = { update: () => { calls++; return new Promise(done => { resolve = done; }); } };
const stop = watchAppUpdates(registration, { doc, win, now: () => clock, intervalMs: 300000,
  schedule: fn => { callback = fn; return 7; }, cancel: id => { assert.equal(id, 7); cancelled++; } });
win.dispatchEvent(new Event('focus')); assert.equal(calls, 0);
clock = 300000; doc.visibilityState = 'hidden'; await callback(); assert.equal(calls, 0);
doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
assert.equal(calls, 1);
clock = 600000; win.dispatchEvent(new Event('online')); assert.equal(calls, 1, 'in-flight check coalesces');
resolve(); await Promise.resolve();
await Promise.resolve();
registration.update = async () => { calls++; throw Error('offline'); };
await callback(); assert.equal(calls, 2, 'offline does not reject the lifecycle callback');
clock = 900000; await callback(); assert.equal(calls, 3, 'failed check can recover at next cadence');
stop(); clock = 1200000; await callback(); win.dispatchEvent(new Event('focus'));
assert.equal(calls, 3); assert.equal(cancelled, 1);
console.log('PASS first-visit/later worker upgrades, bounded visible/focus/online app-version checks, single flight, offline recovery and cleanup.');
