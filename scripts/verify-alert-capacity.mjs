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
const cache = createAlertWindowCache({ read: key => disk.get(key), write: async entries => {
  if (unavailable) throw Error('QuotaExceededError');
  disk.clear(); for (const [key, entry] of entries) disk.set(key, entry);
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
const session = createAlertWindowCache({ read: key => disk.get(key), write: async entries => {
  disk.clear(); for (const [key, entry] of entries) disk.set(key, entry);
  return { persistent: false };
} });
await session.write(value);
assert.equal(session.status().status, 'session-only');
assert.match(session.status().message, /reopening requires a source check/);
assert.equal((await session.read()).value.events.length, events.length, 'unavailable disk storage cannot discard this session evidence');
console.log(`PASS: ${events.length} events across ${manifest.parts.length} cache parts; all 600 AI cards, tail evidence, corruption, quota failure, legacy migration and recovery.`);
