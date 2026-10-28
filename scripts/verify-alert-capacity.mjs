#!/usr/bin/env node
// Lossless large-window cache tests; every byte stays local.
import assert from 'node:assert/strict';
import { createAlertWindowCache, ALERT_WINDOW_CACHE_KEY as KEY, ALERT_CACHE_PART_BYTES } from '../public/js/data/alert-window-cache.js';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { materializePublicAlertWindow, readCachedAlertWindow } = await import('../public/js/data/daily-alerts.js');
const { writeEntry } = await import('../public/js/core/store.js');
const { rankReport } = await import('../public/js/data/ai-alerts.js');
const disk = new Map();
let unavailable = false;
const cache = createAlertWindowCache({ read: key => disk.get(key), write: async (entries, deletes = []) => {
  if (unavailable) throw Error('QuotaExceededError');
  for (const key of deletes) disk.delete(key);
  for (const [key, entry] of entries) disk.set(key, entry);
  return { persistent: true };
} });
const events = Array.from({ length: 100_005 }, (_, i) => ({ id: `filing:${i}`, ticker: `CO${i % 600}`,
  company: `Company ${i % 600}`, day: '2026-09-07', feed: 'announcements', feedLabel: 'Announcements',
  headline: `Material contract Ω ${i}`, direction: 'neutral', importance: 'high', url: `https://source.example/${i}` }));
const value = materializePublicAlertWindow({ day: '2026-09-07', events, feeds: [{ id: 'announcements', status: 'ok', reachesToday: true }] });
assert.equal(materializePublicAlertWindow({ ...value, events: [
  { ...events[0], feed: 'company-documents' }, { ...events[0], feed: 'drhp-documents' }, { ...events[0], private: true },
] }).events.length, 0, 'private feed records are excluded even if the provider omits their private flag');
await cache.write(value);
const manifest = disk.get(KEY).value;
assert.equal(manifest.count, events.length);
assert(manifest.parts.length > 1);
assert(manifest.parts.every(part => part.bytes <= ALERT_CACHE_PART_BYTES));
assert.deepEqual((await cache.read()).value, value, 'more than 100k evidence events survive partitioning without truncation');
const holdings = Array.from({ length: 600 }, (_, i) => ({ ticker: `CO${i}`, name: `Company ${i}` }));
const ranked = rankReport({ ...value, scope: 'portfolio' }, { holdings, insightCompanies: [] });
assert.equal(ranked.cards.length, 600);
assert.equal(ranked.meta.dedupedEvents, events.length, 'every eligible event is evaluated, including the tail beyond the former cap');
assert(ranked.cards.some(card => card.events.some(event => event.id === 'filing:100004')));
// Legacy cache migration cannot turn a busy fortnight into a miss either.
await writeEntry(KEY, { value });
assert.equal((await readCachedAlertWindow({ scope: 'universe', holdings, day: value.day })).events.length, events.length);
const lastPart = `${KEY}:part:${manifest.parts.at(-1).hash}`;
const saved = disk.get(lastPart); disk.delete(lastPart);
assert.equal(await cache.read(), null, 'a missing part is never exposed as a complete subset');
disk.set(lastPart, { value: { json: '[]' } });
assert.equal(await cache.read(), null, 'corrupt bytes fail integrity verification');
disk.set(lastPart, saved);
unavailable = true;
await cache.write({ ...value, events: events.slice(0, 1) });
assert.deepEqual((await cache.read()).value, value, 'failed replacement retains the entire previous committed window');
unavailable = false;
const largeEvent = { ...events[0], detail: 'x'.repeat(ALERT_CACHE_PART_BYTES + 1) };
const replacement = { ...value, events: [largeEvent] };
await cache.write(replacement);
assert.deepEqual((await cache.read()).value, replacement, 'one oversized event gets its own part and is never shortened');
assert.equal(disk.size, 2, 'replaced cache fragments do not accumulate indefinitely');
const session = createAlertWindowCache({ read: key => disk.get(key), write: async (entries, deletes = []) => {
  for (const key of deletes) disk.delete(key);
  for (const [key, entry] of entries) disk.set(key, entry);
  return { persistent: false };
} });
await session.write(value);
assert.equal(session.status().status, 'session-only');
assert.match(session.status().message, /reopening requires a source check/);
assert.equal((await session.read()).value.events.length, events.length, 'unavailable disk storage cannot discard this session evidence');
// Hold a reader on the old manifest while two replacements reuse its content hashes.
// A later cleanup must retain both the active reader's parts and the current committed parts.
const concurrentDisk = new Map();
let releasePart, enteredPart, gatePart = false;
const partEntered = new Promise(resolve => { enteredPart = resolve; });
const partGate = new Promise(resolve => { releasePart = resolve; });
const concurrent = createAlertWindowCache({ partBytes: 1024, read: async key => {
  if (gatePart && key.includes(':part:')) { gatePart = false; enteredPart(); await partGate; }
  return concurrentDisk.get(key);
}, write: async (entries, deletes = []) => {
  for (const key of deletes) concurrentDisk.delete(key);
  for (const [key, entry] of entries) concurrentDisk.set(key, entry);
  return { persistent: true };
} });
const firstWindow = { ...value, events: events.slice(0, 30) };
const secondWindow = { ...value, events: events.slice(30, 60) };
await concurrent.write(firstWindow);
gatePart = true;
const readingOld = concurrent.read();
await partEntered;
await concurrent.write(secondWindow);
await concurrent.write(firstWindow);
releasePart();
assert.deepEqual((await readingOld).value, firstWindow, 'a reader retains its complete manifest while newer windows commit');
assert.deepEqual((await concurrent.read()).value, firstWindow, 'cleanup never deletes a hash reused by the current manifest');
await concurrent.write(firstWindow);
assert.equal(concurrentDisk.size, concurrentDisk.get(KEY).value.parts.length + 1, 'obsolete versions are reclaimed after readers finish');
console.log(`PASS: ${events.length} events across ${manifest.parts.length} cache parts; all 600 AI cards, tail evidence, corruption, quota failure, legacy migration and recovery.`);

// THE SAVED WINDOW MUST BE CLONEABLE, OR NOTHING IS SAVED. IndexedDB structured-clones every row,
// and one function on one feed row (the NSE / X / IPO sources' `warm`, 21 October 2026) made each
// AI Alerts and All Alerts save throw DataCloneError: no offline copy existed, and every scope switch
// and reload waited for the whole live read. This disk clones exactly as IndexedDB does.
{
  const { FEEDS } = await import('../public/js/data/daily-alerts.js');
  const { materializeAllAlerts } = await import('../public/js/data/all-alerts-cache.js');
  assert.doesNotThrow(() => structuredClone(FEEDS), 'every alert feed row is plain data');
  const rows = FEEDS.map(feed => ({ ...feed, status: 'ok', events: [] }));
  assert.doesNotThrow(() => structuredClone(materializePublicAlertWindow({ day: '2026-09-07', feeds: rows, events: [] })), 'the AI Alerts window is cloneable');
  assert.doesNotThrow(() => structuredClone(materializeAllAlerts({ day: '2026-09-07', sourceFeeds: rows })), 'the All Alerts pool is cloneable');
  const cloningDisk = new Map();
  const cloning = createAlertWindowCache({ cacheKey: 'clone-fixture', read: key => cloningDisk.get(key), write: async (entries) => {
    try { for (const [key, entry] of entries) cloningDisk.set(key, structuredClone(entry)); } catch { return { persistent: false }; }
    return { persistent: true };
  } });
  const stray = { day: '2026-09-07', feeds: [{ id: 'announcements', status: 'ok', warm: () => null }], events: events.slice(0, 3) };
  assert.equal((await cloning.write(stray)).persistent, true, 'a stray function on a feed row is dropped, never fatal to the save');
  assert.deepEqual((await cloning.read()).value.events, events.slice(0, 3));
  assert.equal(typeof (await cloning.read()).value.feeds[0].warm, 'undefined');
  assert.deepEqual((await cloning.peek()).value.day, '2026-09-07', 'the manifest can be read without its parts');
  console.log('PASS: every feed row and saved alert window is structured-cloneable, so the offline copy is written.');
}
