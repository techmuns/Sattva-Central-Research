// Captured recovery notices must survive into the runner's prepared alert feed.
import assert from 'node:assert/strict';
import { verifyAnnouncementDelivery } from './lib/announcement-delivery.mjs';
import { mergeAnnouncements, mergeAnnouncementsAsync } from '../public/js/data/announcements-shared.js';
import { createFeed } from '../public/js/data/filings.js';
import { withFilingArchive } from '../public/js/data/filing-archives.js';

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
console.log('PASS recovery delivery: original links, merged provenance, attachment-free notices, full sliced history and stable scope projections');
