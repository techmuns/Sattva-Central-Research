// Captured recovery notices must survive into the runner's prepared alert feed.
import assert from 'node:assert/strict';
import { verifyAnnouncementDelivery } from './lib/announcement-delivery.mjs';
import { mergeAnnouncements, mergeAnnouncementsAsync } from '../public/js/data/announcements-shared.js';
import { createFeed } from '../public/js/data/filings.js';
import { withFilingArchive } from '../public/js/data/filing-archives.js';
import { warmRows, toFeedRowSteps } from '../public/js/data/daily-alerts.js';
import { runSteps, runStepsInSlices } from '../public/js/core/slices.js';

const dated = { ticker: 'TEST', date: '2026-10-01', title: 'Original filing',
  url: 'https://www.bseindia.com/fixture/original.pdf', source: 'BSE' };
const notice = { ticker: 'TEST', date: '2026-10-02', time: '10:00', title: 'Notice without attachment',
  referenceUrl: 'https://www.screener.in/company/TEST/', source: 'Screener' };
const neighbour = { ...dated, title: 'Separate filing', url: 'https://www.bseindia.com/fixture/separate.pdf' };
const incoming = [{ ...dated, source: 'NSE', providers: ['Recovery'] }, notice, neighbour];
const merged = mergeAnnouncements([dated], incoming);
let yields = 0;
const many = Array.from({ length: 3000 }, (_, i) => ({ ...neighbour, title: `Historical ${i}`, url: `https://example.test/${i}.pdf` }));
assert.deepEqual(await mergeAnnouncementsAsync([[dated], incoming, many], {
  sliceMs: 0, yieldForInput: async () => { yields++; },
}), mergeAnnouncements([dated], incoming, many));
assert(yields > 10, 'large archive merges offer input opportunities without dropping rows');
const events = merged.map(sourceRecord => ({ sourceRecord }));
assert.equal(verifyAnnouncementDelivery(incoming, events), incoming.length);
assert.throws(() => verifyAnnouncementDelivery(incoming, events.filter(e => e.sourceRecord.title !== notice.title)), /missing from alerts/);
assert.throws(() => verifyAnnouncementDelivery(incoming, events.filter(e => e.sourceRecord.title !== neighbour.title)), /missing from alerts/);

const base = createFeed('announcements', { read: async () => ({ value: {
  capturedAt: '2026-10-01T10:00:00Z', coversUniverse: true, byTicker: { TEST: [dated] },
} }), allowColdStart: false });
await base.load([{ ticker: 'TEST', name: 'Original display name' }]);
const first = base.rows();
base.setWanted([{ ticker: 'TEST', name: 'New scope label' }, { ticker: 'TEST' }]);
assert.equal(base.rows(), first, 'scope labels cannot invalidate unchanged filing projections');

const feed = withFilingArchive(base, 'announcements');
await feed.prepareRows();
assert.deepEqual(feed.rows(), first, 'archive warm-up preserves the complete source data');
// A view that leaves during a source reading stops its unused classifications.
// The replacement still has every original record available to read.
let active = true, abandoned = 0;
await warmRows(many, () => {
  abandoned++;
  const end = performance.now() + 0.02;
  while (performance.now() < end) { /* simulate a cold per-record reading */ }
}, async () => { active = false; }, () => active);
assert(abandoned > 0 && abandoned < many.length, 'abandoned per-view readings stop at an input opportunity');
const replacement = [];
await warmRows(many, row => replacement.push(row), async () => {}, () => true);
assert.deepEqual(replacement, many, 'cancelling computation cannot discard captured history');

// Duplicate source IDs are not permission to erase distinct original records. A sliced
// normalization must retain those collisions, date counts and provenance just like a direct read.
const originals = many.map((sourceRecord, i) => ({ id: `filing-${i}`, day: '2026-10-01', sourceRecord }));
const collision = { ...originals[0], sourceRecord: { ...originals[0].sourceRecord, title: 'Corrected original' } };
const input = { events: [...originals, { ...originals[0] }, collision,
  { id: 'undated', day: null }, { id: 'later', day: '2026-10-02' }], status: 'failed', note: 'Retained during outage' };
const descriptor = { id: 'announcements', label: 'Announcements', tab: 'corp-announcements' };
yields = 0;
const normalized = await runStepsInSlices(toFeedRowSteps(descriptor, input, '2026-10-02'), {
  sliceMs: 0, yieldForInput: async () => { yields++; },
});
assert(yields > 10, 'record normalization must offer input opportunities before completing');
assert.deepEqual(normalized, runSteps(toFeedRowSteps(descriptor, input, '2026-10-02')));
assert.equal(normalized.count, many.length + 3, 'only an exact source duplicate is removed');
assert.equal(normalized.events.filter(row => row.id === 'filing-0').length, 2, 'distinct originals survive an ID collision');
assert.equal(normalized.events[0].sourceRecord, originals[0].sourceRecord, 'normalization retains the original evidence object');
assert.equal(normalized.todayCount, 1);
assert.equal(normalized.oldestDay, '2026-10-01');
assert.equal(normalized.newestDay, '2026-10-02');
assert.equal(normalized.status, 'failed', 'scheduling never certifies a failed source');
assert.equal(normalized.note, 'Retained during outage');
console.log('PASS recovery delivery: original links, merged provenance, attachment-free notices, full sliced history and stable scope projections');
