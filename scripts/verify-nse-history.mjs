#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveNseFilings } from './lib/nse-history.mjs';
import { createNseFeed } from '../public/js/data/nse-filings.js';
import { filingDay, filingKey, firstHistoryDay, mergeFilings } from '../public/js/data/nse-history-shared.js';

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log(`PASS ${label}`); };
const clock = () => Date.parse('2026-09-04T06:00:00Z');
const sterlite = { company: 'Sterlite Technologies Limited', ticker: 'STLTECH', resolvedBy: 'filename',
  publishedAt: '2026-09-03T16:02:07Z', subject: 'Analyst / Investor Meet', url: 'https://example.test/sterlite.pdf' };
const today = { company: 'Today Limited', ticker: 'TODAY', publishedAt: '2026-09-04T05:00:00Z', subject: 'Updates', url: 'https://example.test/today.pdf' };
const older = { ...sterlite, url: 'https://example.test/older.pdf', publishedAt: '2026-08-12T10:00:00Z' };
const capture = (rows, capturedAt = '2026-09-04T06:00:00Z') => ({ ok: true, rows, capturedAt });
const live = (rows) => ({ status: 200, value: capture(rows), checkedAt: clock() });
const defaults = { now: clock, readLive: async () => live([today]),
  readSnapshot: async () => capture([sterlite], '2026-09-03T17:00:00Z'),
  readIndex: async () => ({ days: [] }), readSaved: async () => null, save: async () => {} };

await check('a successful smaller live window does not hide Sterlite from the snapshot', async () => {
  const feed = createNseFeed(defaults);
  await feed.load();
  assert.equal(feed.rows().length, 2);
  assert.equal(feed.rows().filter((row) => /sterlite/i.test(row.company)).length, 1);
  assert.equal(feed.meta().origin, 'live');
  assert.equal(feed.meta().capturedAt, '2026-09-04T06:00:00Z');
});

await check('refresh and 304 reload preserve filings and persisted live-only history', async () => {
  let saved;
  let response = live([today]);
  let snapshot = capture([sterlite]);
  const deps = { ...defaults, readLive: async () => response, readSnapshot: async () => snapshot,
    readSaved: async () => saved, save: async (value) => { saved = { value, savedAt: clock() }; } };
  const feed = createNseFeed(deps);
  await feed.load();
  snapshot = capture([]);
  response = { status: 304, value: capture([today]) };
  await feed.refresh();
  assert.equal(feed.rows().length, 2);
  const reopened = createNseFeed(deps);
  await reopened.load();
  assert.equal(reopened.rows().length, 2);
});

await check('same-count corrections repaint, dedupe and preserve resolved identities', async () => {
  let response = live([sterlite]);
  const feed = createNseFeed({ ...defaults, readLive: async () => response });
  await feed.load();
  let updates = 0;
  feed.onChange(() => updates++);
  response = live([{ ...sterlite, subject: 'Corrected subject', ticker: null, resolvedBy: null }]);
  await feed.refresh();
  assert.equal(feed.rows().length, 1);
  assert.equal(feed.rows()[0].subject, 'Corrected subject');
  assert.equal(feed.rows()[0].ticker, 'STLTECH');
  assert.ok(updates > 0);
});

await check('Portfolio search includes manually added Sterlite without leaking other companies', async () => {
  const feed = createNseFeed(defaults);
  await feed.load();
  assert.equal(feed.forScope('portfolio', []).length, 0);
  const rows = feed.forScope('portfolio', [{ ticker: 'STLTECH', name: 'Sterlite Technologies' }]);
  assert.deepEqual(rows.map((row) => row.ticker), ['STLTECH']);
  assert.equal(feed.forScope('universe', []).length, 2);
});

await check('an old snapshot cannot undo a live correction after the filing rolls out', async () => {
  let response = live([{ ...sterlite, subject: 'Corrected presentation' }]);
  const feed = createNseFeed({ ...defaults, readLive: async () => response });
  await feed.load();
  response = live([today]);
  await feed.refresh();
  assert.equal(feed.rows().find((row) => row.ticker === 'STLTECH').subject, 'Corrected presentation');
});

await check('archive revisions update corrections but cannot revert a newer live observation', async () => {
  let revision = '1';
  let response = live([today]);
  let archived = capture([sterlite], '2026-09-03T18:00:00Z');
  const feed = createNseFeed({ ...defaults, readLive: async () => response,
    readIndex: async () => ({ days: [{ day: '2026-09-03', count: 1, revision }] }),
    readDay: async () => archived });
  await feed.load();
  revision = '2';
  archived = capture([{ ...sterlite, subject: 'Archive correction' }], '2026-09-04T02:00:00Z');
  await feed.refresh();
  assert.equal(feed.rows().find((row) => row.ticker === 'STLTECH').subject, 'Archive correction');
  revision = '3';
  response = live([{ ...sterlite, subject: 'Live correction' }]);
  archived = capture([{ ...sterlite, subject: 'Older archive correction' }], '2026-09-04T03:00:00Z');
  await feed.refresh();
  assert.equal(feed.rows().find((row) => row.ticker === 'STLTECH').subject, 'Live correction');
});

await check('a partial archive file cannot be silently marked loaded', async () => {
  const feed = createNseFeed({ ...defaults,
    readIndex: async () => ({ days: [{ day: '2026-09-03', count: 2, revision: '1' }] }),
    readDay: async () => capture([sterlite]) });
  await feed.load();
  assert.deepEqual(feed.meta().missingDays, ['2026-09-03']);
});

await check('an outage is labelled, not treated as no filings or a fresh capture', async () => {
  const feed = createNseFeed({ ...defaults, readLive: async () => { throw new Error('offline'); } });
  await feed.load();
  assert.equal(feed.rows().length, 1);
  assert.match(feed.meta().degraded, /unavailable/);
  assert.equal(feed.meta().capturedAt, '2026-09-03T17:00:00Z');
});

await check('date ranges load archived days on demand and expose failed history reads', async () => {
  let broken = true;
  const requests = [];
  const feed = createNseFeed({ ...defaults,
    readIndex: async () => ({ days: [{ day: '2026-08-12', revision: '1' }] }),
    readDay: async (day) => { requests.push(day); return broken ? null : capture([older]); },
  });
  await feed.load();
  assert.equal(requests.length, 0);
  await feed.loadHistory(30);
  assert.deepEqual(feed.meta().missingDays, ['2026-08-12']);
  broken = false;
  await feed.loadHistory(30);
  assert.equal(feed.rows().length, 3);
  assert.deepEqual(feed.meta().missingDays, []);
  await feed.loadHistory(7);
  assert.equal(feed.rows().length, 2);
  await feed.loadHistory(30);
  assert.equal(requests.length, 2, 'unchanged archive shards are reused');
});

await check('missing archive index stays visible even while the latest live feed succeeds', async () => {
  const feed = createNseFeed({ ...defaults, readIndex: async () => null });
  await feed.load();
  assert.equal(feed.meta().historyUnavailable, true);
  assert.equal(feed.rows().length, 2);
});

await check('IST date boundaries and undated notices are preserved without invented dates', () => {
  assert.equal(filingDay('2026-09-03T19:00:00Z'), '2026-09-04');
  assert.equal(firstHistoryDay(7, clock()), '2026-08-29');
  const notice = { company: 'Notice Limited', publishedAt: null, subject: 'Surveillance', url: null, ticker: null };
  assert.equal(filingKey(notice), filingKey({ ...notice, ticker: 'NOTICE' }));
  assert.equal(mergeFilings([notice], [{ ...notice, ticker: 'NOTICE' }]).length, 1);
});

await check('daily archives preserve yesterday through rollover, corrections and repeated runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sattva-nse-history-test-'));
  try {
    archiveNseFilings(dir, [capture([sterlite], '2026-09-03T17:00:00Z')]);
    const result = archiveNseFilings(dir, [capture([today])]);
    assert.equal(result.count, 2);
    assert.equal(result.days.length, 2);
    const yesterday = JSON.parse(readFileSync(join(dir, 'nse-filings/2026-09-03.json'), 'utf8'));
    assert.equal(yesterday.rows[0].ticker, 'STLTECH');
    const corrected = archiveNseFilings(dir, [capture([{ ...sterlite, description: 'Presentation published' }])]);
    assert.equal(corrected.count, 2);
    assert.notEqual(corrected.days[1].revision, result.days[1].revision);
    const again = archiveNseFilings(dir, [capture([{ ...sterlite, description: 'Presentation published' }])]);
    assert.deepEqual(again, corrected);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // only this test's newly-created temporary directory
  }
});

await check('the seeded archive contains the customer-reported Sterlite analyst meeting', () => {
  const index = JSON.parse(readFileSync(new URL('../public/data/nse-filings/index.json', import.meta.url), 'utf8'));
  const rows = index.days.flatMap(({ day }) => JSON.parse(readFileSync(new URL(`../public/data/nse-filings/${day}.json`, import.meta.url), 'utf8')).rows);
  assert.ok(rows.some((row) => row.ticker === 'STLTECH' && /analyst/i.test(row.subject)));
});

console.log(`\n${checks} NSE history checks passed.`);
