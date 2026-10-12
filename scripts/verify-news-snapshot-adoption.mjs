// Exercise the actual browser feed's cooperative adoption, with all network replies local.
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.fetch = async path => {
  assert(String(path).startsWith('api/news?'), `unexpected network request: ${path}`);
  return new Response(JSON.stringify({ ok: true, articles: [article('live-arrival')] }), { headers: { 'content-type': 'application/json' } });
};
const { createFeed } = await import('../public/js/data/filings.js');
// Make cooperative slices yield real turns, as they do in the browser.
globalThis.window = {};
const now = Date.now(), stamp = offset => new Date(now + offset).toISOString();
function article(id, extra = {}) { return { id, title: `Original source ${id}`, url: `https://example.test/${id}`,
  publishedAt: stamp(-86400000), originalEvidence: `all fields ${id}`, ...extra }; }
let capture = { capturedAt: stamp(-120000), byTicker: { TEST: [article('old')], OLD: [article('old-company')] }, empty: [] };
let reads = 0, onRead = null;
const feed = createFeed('news', { allowColdStart: false, read: async () => {
  reads++; const value = capture; onRead?.(); return { value, checkedAt: Date.now() };
} });
await feed.load([]);
capture = { capturedAt: stamp(-90000), byTicker: { TEST: [article('old', { corrected: true }), article('new')] }, empty: ['OLD'] };
await feed.refreshSnapshot();
assert.equal(feed.forTicker('TEST').length, 2, 'shrinking captures retain previous records');
assert.equal(feed.forTicker('TEST').find(row => row.id === 'old').corrected, true, 'the new source correction wins');
assert.equal(feed.forTicker('OLD')[0].originalEvidence, 'all fields old-company', 'an empty source response cannot erase retained history');
capture = { capturedAt: stamp(-60000), byTicker: { TEST: Array.from({ length: 5000 }, (_, i) => article(`capture-${i}`)) }, empty: [] };
let arrival;
onRead = () => { onRead = null; arrival = new Promise(resolve => setTimeout(() => resolve(feed.loadOne('TEST', { force: true })), 0)); };
await feed.refreshSnapshot(); await arrival;
assert(feed.forTicker('TEST').some(row => row.id === 'live-arrival'), 'an arrival during yielded preparation survives');
assert(feed.forTicker('TEST').some(row => row.id === 'capture-4999'), 'the concurrent capture is merged completely');
assert.equal(feed.meta().newsDelivery.core.pending, false, 'preparation completes before announcing settled state');
const before = feed.forTicker('TEST');
capture = { capturedAt: stamp(-150000), byTicker: { TEST: [article('rollback')] }, empty: [] };
await feed.refreshSnapshot();
assert.deepEqual(feed.forTicker('TEST'), before, 'an older capture cannot replace newer live or retained readings');
assert(feed.meta().newsDelivery.core.error.includes('older'), 'rollback stays visible as a source problem');
capture = null;
await Promise.all([feed.refreshSnapshot(), feed.refreshSnapshot()]);
assert.deepEqual(feed.forTicker('TEST'), before, 'failed queued refreshes retain every record');
assert.equal(feed.meta().newsDelivery.core.pending, false);
assert.equal(reads, 6);
feed.dispose();
console.log('PASS actual news feed: correction, shrinking/empty history, live arrival during preparation, rollback and failed queued refreshes.');
