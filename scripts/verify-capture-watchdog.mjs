#!/usr/bin/env node

import assert from 'node:assert/strict';
import { refreshDue, resetForTest, runCaptureWatchdog } from '../public/js/data/capture-watchdog.js';

const hour = 60 * 60 * 1000;
const wed2200 = Date.parse('2026-09-02T16:30:00.000Z'); // 22:00 IST

assert.equal(refreshDue('companyNews', { capturedAt: new Date(wed2200 - 2.9 * hour).toISOString() }, wed2200), false);
assert.equal(refreshDue('companyNews', { capturedAt: new Date(wed2200 - 3.1 * hour).toISOString() }, wed2200), true);
assert.equal(refreshDue('marketNews', { capturedAt: new Date(wed2200 - 47 * 60 * 1000).toISOString() }, wed2200 - 60 * 1000), true, 'market news refreshes through 21:59 IST');
assert.equal(refreshDue('marketNews', { capturedAt: new Date(wed2200 - 47 * 60 * 1000).toISOString() }, wed2200), false, 'market news does not hammer a publisher outside its measured window');
assert.equal(refreshDue('announcements', { capturedAt: new Date(wed2200 - 2 * hour).toISOString() }, wed2200), true);
assert.equal(refreshDue('announcements', { capturedAt: null }, Date.parse('2026-09-05T16:30:00.000Z')), true, 'weekend filings are captured too');

const wed1859 = Date.parse('2026-09-02T13:29:00.000Z');
const wed1900 = Date.parse('2026-09-02T13:30:00.000Z');
const yesterday = '2026-09-01T13:30:00.000Z';
assert.equal(refreshDue('insider', { capturedAt: yesterday }, wed1859), false, 'insider capture is not due before 19:00 IST');
assert.equal(refreshDue('insider', { capturedAt: yesterday }, wed1900), true, 'insider capture is due at 19:00 IST');
assert.equal(refreshDue('insider', { capturedAt: '2026-09-02T13:30:00.000Z' }, wed2200), false, 'today\'s insider capture is current');

const wed0714 = Date.parse('2026-09-02T01:44:00.000Z');
const wed0715 = Date.parse('2026-09-02T01:45:00.000Z');
assert.equal(refreshDue('technicals', { capturedAt: yesterday }, wed0714), false, 'technical capture is not due before 07:15 IST');
assert.equal(refreshDue('technicals', { capturedAt: yesterday }, wed0715), true, 'technical capture has a 15-minute scheduler grace period');

const originalFetch = globalThis.fetch;
const calls = [];
try {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET' });
    if (url === 'api/capture-status') {
      return Response.json({
        ok: true,
        captures: {
          companyFilings: { capturedAt: new Date(wed2200).toISOString() },
          companyNews: { capturedAt: new Date(wed2200 - hour).toISOString() },
          marketNews: { capturedAt: new Date(wed2200 - 10 * 60 * 1000).toISOString() },
          announcements: { capturedAt: new Date(wed2200 - 30 * 60 * 1000).toISOString() },
          insider: { capturedAt: yesterday },
          technicals: { capturedAt: '2026-09-02T01:50:00.000Z' },
        },
      });
    }
    if (url === 'api/insider-snapshot/refresh?source=auto' && init.method === 'POST') {
      return Response.json({ ok: true, dispatched: true, workflow: 'insider-trades-refresh.yml' });
    }
    return Response.json({ ok: false, reason: 'unexpected' }, { status: 500 });
  };

  resetForTest();
  const beforeBoundary = await runCaptureWatchdog({ now: () => wed1859, watchRuns: false });
  const atBoundary = await runCaptureWatchdog({ now: () => wed1900, watchRuns: false });
  const insideCooldown = await runCaptureWatchdog({ now: () => wed1900, watchRuns: false });
  assert.deepEqual(beforeBoundary.started, [], 'an open dashboard does not dispatch insider trades before 19:00');
  assert.deepEqual(atBoundary.started.map((item) => item.name), ['insider'], 'the next periodic check dispatches only the source that became due');
  assert.deepEqual(insideCooldown.started, [], 'one page never dispatches the same source twice inside its cooldown');
  assert.equal(
    calls.filter((call) => call.url === 'api/insider-snapshot/refresh?source=auto' && call.method === 'POST').length,
    1,
    'the automatic safety net uses one POST with an auditable source',
  );
} finally {
  globalThis.fetch = originalFetch;
  resetForTest();
}

console.log('PASS capture watchdog freshness windows and duplicate guard');
