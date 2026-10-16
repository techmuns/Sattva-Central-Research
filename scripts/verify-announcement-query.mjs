// Bounded index responses must preserve a long reading window through quiet refreshes.
import assert from 'node:assert/strict';
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 503 });
const { createAnnouncementQuery } = await import('../public/js/data/announcement-query.js');
let rows = Array.from({ length: 1600 }, (_, i) => ({ id: String(i), title: `Filing ${i}` }));
let failOffset = null, holdOffset = null, release, held;
const requests = [];
const query = createAnnouncementQuery({ engine: {}, fetchImpl: async (_url, options) => {
  const q = JSON.parse(options.body); requests.push(q);
  assert(q.limit <= 500, 'every index request respects the server page limit');
  if (q.offset === failOffset) return Response.json({ reason: 'rate-limited' }, { status: 429 });
  const selected = q.q ? rows.slice(0, 3) : rows;
  const response = Response.json({ ok: true, rows: selected.slice(q.offset, q.offset + q.limit), total: selected.length });
  if (q.offset === holdOffset) { held(); await new Promise(done => { release = done; }); }
  return response;
} });
try {
  await query.load();
  for (let i = 0; i < 5; i++) await query.loadMore();
  assert.equal(query.rows().length, 1200);
  rows = [{ id: 'new', title: 'New filing' }, ...rows.map(row => row.id === '900' ? { ...row, title: 'Corrected filing' } : row)];
  requests.length = 0;
  await query.refresh();
  assert.deepEqual(query.rows(), rows.slice(0, 1200), 'a refresh keeps all loaded pages and adopts arrivals and corrections');
  assert.deepEqual(requests.map(q => [q.offset, q.limit]), [[0, 500], [500, 500], [1000, 200]]);
  assert.equal(query.meta().nextOffset, 1200, 'scrolling can continue after the retained window');
  const retained = query.rows();
  failOffset = 500;
  await query.refresh();
  assert.equal(query.rows(), retained, 'a failed later page never publishes a truncated prefix');
  assert.equal(query.meta().error.reason, 'rate-limited');
  assert.equal(query.meta().nextOffset, 1200);
  failOffset = null;
  holdOffset = 500;
  const paused = new Promise(done => { held = done; });
  const refresh = query.refresh(); await paused;
  query.setQuery({ q: 'narrow' }); await query.load();
  release(); await refresh;
  assert.deepEqual(query.rows(), rows.slice(0, 3), 'a superseded multi-page refresh cannot overwrite the new filter');
  assert.equal(query.meta().nextOffset, null);
  console.log('PASS bounded multi-page refresh, arrivals/corrections, complete-window retention, failed-page preservation and filter cancellation');
} finally { query.suspend(); globalThis.fetch = savedFetch; }
