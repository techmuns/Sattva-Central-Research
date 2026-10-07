#!/usr/bin/env node
// RELEVANCE, CATEGORIES, EVENT STITCHING, SHARED FEEDBACK, THE ANNOUNCEMENT INDEX AND AI READ —
// the pure and server-side halves, with no browser and no egress.
//
// Every rule is asserted as a GENERIC behaviour over a class of inputs (a bigger stated amount ranks
// higher at the same company, routine paperwork ranks below a material event, a social post below a
// filing), never as "this example lands here". The index checks run the real Durable Object store
// over an index built by the runner's own code from the committed BSE and NSE captures.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');

const cats = await import('../public/js/data/announcement-categories.js');
const rel = await import('../public/js/data/relevance.js');
const fb = await import('../public/js/data/relevance-feedback-shared.js');
const stitch = await import('../public/js/data/event-stitching.js');
const affinity = await import('../public/js/data/sector-affinity.js');
const shared = await import('../public/js/data/announcement-index-shared.js');
const readShared = await import('../public/js/data/announcement-read-shared.js');
const { TRIGGERS } = await import('../public/js/data/kpi-impact.js');
const { RelevanceFeedbackStore } = await import('../worker/relevance-feedback-store.mjs');
const { AnnouncementIndexStore, skippable } = await import('../worker/announcement-index-store.mjs');
const { AnnouncementReadStore, READ_DAILY_LIMIT } = await import('../worker/announcement-read-store.mjs');
const { handleRelevanceFeedback } = await import('../worker/relevance-feedback.mjs');
const { handleAnnouncementIndex } = await import('../worker/announcement-index.mjs');
const { handleAnnouncementRead } = await import('../worker/announcement-read.mjs');
const { sqliteStorage, directorySource } = await import('./lib/announcement-test-server.mjs');
const { buildFixtureIndex } = await import('./lib/announcement-index-fixture.mjs');

let checks = 0;
const ok = (label) => { checks++; console.log(`  PASS  ${label}`); };

// ---------------------------------------------------------------------------------------------
// 1. The category master list
// ---------------------------------------------------------------------------------------------
{
  const ids = cats.ANNOUNCEMENT_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'category ids are unique');
  assert(ids.length <= 52, 'the mask can hold every category');
  const groups = new Set(cats.CATEGORY_GROUPS.map((g) => g.id));
  for (const c of cats.ANNOUNCEMENT_CATEGORIES) {
    assert(groups.has(c.group), `${c.id} names a known group`);
    assert(c.label && c.hint, `${c.id} has a label and a hint`);
    for (const k of ['materiality', 'financial', 'governance', 'future']) assert(Number.isFinite(c.dims[k]), `${c.id}.${k}`);
  }
  assert.equal(cats.ANNOUNCEMENT_CATEGORIES.filter((c) => c.routine).length, 1, 'exactly one routine category');
  assert.deepEqual(cats.maskCategories(cats.categoryMask(['results', 'esop', 'other'])), ['results', 'esop', 'other'].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), 'masks round-trip');
  ok(`${ids.length} categories in ${groups.size} groups; masks round-trip`);

  const tag = (item, kind = 'filing') => cats.categorize(item, kind).ids;
  // Several tags per item, from the exchange label and the item's own words.
  assert.deepEqual(tag({ title: 'Board Meeting Outcome for Capital Raise Through QIP And Preferential Issue', subCategory: 'Outcome of Board Meeting', category: 'Board Meeting' }).sort(), ['board-meeting', 'capital-raise'].sort());
  // An order cancelled says so in its own words; the label alone does not make it a win.
  assert.deepEqual(tag({ title: 'Bagging/Receiving of orders/contracts', summary: 'Cancellation of Letter of Award received from the railway' }), ['order-loss']);
  assert(tag({ title: 'Bagging/Receiving of orders/contracts', summary: 'Receipt of Letter of Award for Rs 245 crore' }).includes('order-win'));
  // An order a court or tax officer PASSED is a legal action, never an order win.
  const legal = tag({ title: 'Announcement under Regulation 30 (LODR)-Award_of_Order_Receipt_of_Order', subCategory: 'Award of Order / Receipt of Order', summary: 'Receipt of order from the GST appellate authority confirming a demand' });
  assert(!legal.includes('order-win') && legal.includes('legal-regulatory'), `legal order: ${legal}`);
  // Routine copies are exclusive: a newspaper copy of results borrows none of the results' weight.
  assert.deepEqual(tag({ title: 'Newspaper Publication', subCategory: 'Newspaper Publication', summary: 'Copy of newspaper advertisement of the financial results for the quarter' }), ['routine-admin']);
  // Nothing is guessed: an unrecognised filing is "other" and stays in the list.
  assert.deepEqual(tag({ title: 'General Updates', summary: 'General Updates' }), ['other']);
  // News reads its headline.
  assert(tag({ title: 'Company X bags Rs 1,200 crore order from NHAI', publisher: 'ET' }, 'news').includes('order-win'));
  ok('multi-tag, label/text precedence, order cancellations, legal orders, routine exclusivity, untagged items stay "other"');
}

// ---------------------------------------------------------------------------------------------
// 2. The relevance reading — generic behaviours, no labels
// ---------------------------------------------------------------------------------------------
{
  const read = (item, ctx = {}) => rel.relevanceReading(item, { kind: 'filing', ...ctx });
  const mid = { mcapCr: 8000, band: 'mid', group: 'capital_goods' };
  const order = (amount) => ({ title: 'Bagging/Receiving of orders/contracts', summary: `Receipt of Letter of Award worth Rs ${amount} crore` });
  // Size of the stated amount against the company's own size.
  assert(read(order(2000), { profile: mid }).base > read(order(20), { profile: mid }).base, 'a larger order at the same company ranks higher');
  assert.equal(rel.impactLevel(2000, 8000), 'vhigh');
  assert.equal(rel.impactLevel(5, 8000), 'tiny');
  assert.equal(rel.impactLevel(500, null), 'abs-mid', 'with no market cap the absolute size is the only reading');
  assert.deepEqual(rel.statedAmountsCr('Rs. 5,00,00,000 and USD 2 million and Rs 10 per share'), [5, 17], 'amounts in crore; per-share figures skipped');
  // Material beats routine, at the same company.
  const routine = read({ title: 'Closure of Trading Window', subCategory: 'Closure of Trading Window' }, { profile: mid }).base;
  assert(read(order(200), { profile: mid }).base > routine, 'an order outranks routine paperwork');
  assert(read({ title: 'Financial Results for the quarter ended June 2026', subCategory: 'Financial Results' }, { profile: mid }).base > routine);
  // Company size: the same event matters more at a larger company.
  const event = { title: 'Announcement under Regulation 30 (LODR)-Acquisition', subCategory: 'Acquisition' };
  assert(read(event, { profile: { band: 'mega' } }).base > read(event, { profile: { band: 'micro' } }).base, 'size raises the same event');
  // A notice that something WILL be considered is not the thing itself.
  const prospective = read({ title: 'Board Meeting Intimation', summary: 'Board meeting to be held on 15 October to consider the financial results' }, { profile: mid });
  const done = read({ title: 'Financial Results', summary: 'Audited financial results for the quarter ended September 2026' }, { profile: mid });
  assert(done.base > prospective.base && prospective.facts.prospective, 'the event outranks its prior intimation');
  // Sector: the ontology says inspections move pharma, not banks.
  const inspection = { title: 'USFDA inspection', summary: 'The USFDA conducted an inspection at our formulations facility and issued Form 483 with 3 observations' };
  assert(read(inspection, { profile: { band: 'mid', group: 'pharma' } }).parts.sector >= 0);
  assert(read(order(100), { profile: { band: 'mid', group: 'banks' } }).parts.sector < 0, 'the ontology says orders do not move banks');
  // Source reliability: an unverified social post reads lower than the same words in a filing.
  const text = { title: 'Company bags Rs 500 crore order', headline: 'Company bags Rs 500 crore order' };
  assert(rel.relevanceReading(text, { kind: 'alert', feed: 'twitter', profile: mid }).base < rel.relevanceReading(text, { kind: 'alert', feed: 'announcements', profile: mid }).base);
  // The reading is a number and a set of keys — never a High/Medium/Low label.
  const reading = read(order(100), { profile: mid });
  assert.equal(typeof reading.base, 'number');
  assert(!JSON.stringify(reading).match(/"(?:high|medium|low)"/i) || reading.facts.importance === null, 'no rank label in the reading');
  ok('amount vs market cap, routine below material, size, prospective damping, sector ontology, source reliability, numeric only');

  // Ordering: newest day first, then relevance, then time — every row kept.
  const keys = [rel.rankKey('2026-10-01', -3, '09:00:00'), rel.rankKey('2026-10-01', 4, '08:00:00'), rel.rankKey('2026-09-30', 9, '23:00:00'), rel.rankKey(null, 50, ''), rel.rankKey('2026-10-01', 4, '10:00:00')];
  const sorted = [...keys].sort(rel.compareRanked);
  assert.deepEqual(sorted, [keys[4], keys[1], keys[0], keys[2], keys[3]]);
  ok('rank keys order by day, then relevance, then time; undated last');

  // News and All Alerts order only the recent days by relevance, read within one short budget per
  // run, and finish the rest in slices — a large history must never be read inside one sort.
  {
    const sr = await import('../public/js/data/surface-relevance.js');
    const istDay = (offsetDays) => new Date(Date.now() + 19_800_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
    const today = istDay(0), lastRecent = istDay(sr.RECENT_RELEVANCE_DAYS - 1), older = istDay(sr.RECENT_RELEVANCE_DAYS);
    assert(sr.isRecentDay(today) && sr.isRecentDay(lastRecent) && !sr.isRecentDay(older) && !sr.isRecentDay(null), 'the last seven IST days, today included');
    let reads = 0;
    const read = (row) => { reads++; return sr.surfaceReading(row, { surface: 'alerts', kind: 'alert', categoryKind: 'filing' }); };
    const oldRow = { title: 'Company bags Rs 900 crore order', date: older };
    assert.equal(sr.rankedKey(oldRow, { day: older, time: '10:00:00', surface: 'alerts', read }), rel.rankKey(older, 0, '10:00:00'));
    assert.equal(reads, 0, 'an older day keeps its time order and is never read');
    const rows = Array.from({ length: 400 }, (_, i) => ({ title: i % 2 ? `Company bags Rs ${100 + i} crore order from NHAI` : `Newspaper publication of notice ${i}`, date: today }));
    let announced = 0;
    const off = sr.onRelevanceChange(() => { announced++; });
    // Make one reading cost a millisecond, so a single run must stop at its budget.
    const slow = (row) => { const t = performance.now(); while (performance.now() - t < 1) { /* spin */ } return read(row); };
    rows.forEach((row) => sr.rankedKey(row, { day: today, time: '09:00:00', surface: 'alerts', read: slow }));
    assert(reads > 0 && reads < rows.length, `a single run stops reading at its budget (${reads} of ${rows.length})`);
    await sr.relevanceSettled();
    assert.equal(reads, rows.length, 'every deferred reading is made, in slices');
    assert.equal(announced, 1, 'the surface is told once, when the order has settled');
    const settled = new Map(rows.map((row) => [row, sr.rankedKey(row, { day: today, time: '09:00:00', surface: 'alerts', read: () => { throw new Error('read twice'); } })]));
    const ordered = [...rows].sort((a, b) => rel.compareRanked(settled.get(a), settled.get(b)));
    assert(ordered.slice(0, 200).every((r) => /order/.test(r.title)), 'within the day, the material orders lead the routine notices');
    assert.equal(ordered.length, rows.length, 'nothing is dropped by its rank');
    off();

    // A collection rebuilds row objects when a feed's payload changes. The same identity with the same
    // words reuses its reading, so the next sort is not a re-read of the whole window (which would run
    // past the budget and briefly move rows), while changed words are read again.
    const opts = (e) => ({ surface: 'alerts', kind: 'alert', categoryKind: 'filing', context: { direction: e.direction || null, feed: e.feed || null }, itemKey: `alerts:${e.id}` });
    const batch = Array.from({ length: 3000 }, (_, i) => ({ id: `nse:${i}`, feed: 'nse-filings', direction: 'neutral', title: `Company bags Rs ${200 + i} crore order`, date: today }));
    let fresh = 0;
    const readBatch = (e) => { fresh++; return sr.surfaceReading(e, opts(e)); };
    const before = new Map(batch.map((e) => [e.id, sr.surfaceReading(e, opts(e))]));
    await sr.relevanceSettled();
    const rebuilt = batch.map((e) => ({ ...e }));
    const keysBefore = batch.map((e) => sr.rankedKey(e, { day: today, time: '09:00:00', surface: 'alerts', read: readBatch }));
    fresh = 0;
    const keysAfter = rebuilt.map((e) => sr.rankedKey(e, { day: today, time: '09:00:00', surface: 'alerts', read: readBatch }));
    assert.equal(fresh, rebuilt.length, 'a rebuilt row is read through the identity cache');
    assert.deepEqual(keysAfter, keysBefore, 'a rebuilt batch sorts in one run, exactly as before, with nothing deferred');
    assert(rebuilt.every((e) => sr.surfaceReading(e, opts(e)) === before.get(e.id)), 'the same identity and words reuse the same reading');
    const edited = { ...batch[0], title: 'Newspaper publication of notice' };
    assert.notEqual(sr.surfaceReading(edited, opts(edited)), before.get(batch[0].id), 'changed words are read again');
    const otherFeed = { ...batch[1], direction: 'negative' };
    assert.notEqual(sr.surfaceReading(otherFeed, opts(otherFeed)), before.get(batch[1].id), 'changed reading inputs are read again');
    await sr.relevanceSettled();
  }
  ok('relevance orders the last seven days only; a sort reads within its budget and the rest settle in slices; rebuilt rows reuse their readings');

  // The sector table is the ontology's, recomputed.
  const derived = affinity.affinityFromTriggers(TRIGGERS);
  for (const [cat, entry] of Object.entries(affinity.SECTOR_AFFINITY)) {
    assert.deepEqual(entry.plus, derived[cat].plus, `${cat} plus`);
    assert.deepEqual(entry.minus, derived[cat].minus, `${cat} minus`);
    assert.deepEqual(Object.fromEntries(Object.entries(entry.conditional).map(([g, re]) => [g, re.source])), derived[cat].conditional, `${cat} conditional`);
  }
  ok('sector affinity equals the KPI ontology (kpi-impact.js TRIGGERS)');
}

// ---------------------------------------------------------------------------------------------
// 3. Shared feedback: one preference for the desk, learned per key, never hiding an item
// ---------------------------------------------------------------------------------------------
{
  assert.equal(fb.keyWeight(0, 0), 0, 'a key nobody voted on is exactly zero');
  assert(fb.keyWeight(1, 0) > 0 && fb.keyWeight(0, 1) < 0);
  assert(fb.keyWeight(1, 0) < fb.keyWeight(5, 0), 'agreement moves a key further than one vote');
  assert(fb.keyWeight(1000, 0) <= fb.KEY_CAP);
  const vote = (surface, v, item, features, extra = {}) => ({ surface, vote: v, itemKey: item, eventKey: extra.eventKey || null, device: 'device-0001', features, at: Date.now(), ...extra });
  const model = fb.aggregateModel([
    vote('announcements', 'not-important', 'a:1', ['cat:routine-admin', 'size:micro']),
    vote('news', 'not-important', 'news:2', ['cat:routine-admin']),
    vote('alerts', 'important', 'alerts:3', ['cat:order-win', 'size:mid'], { eventKey: 'ev:x' }),
  ]);
  assert.equal(model.votes, 3);
  assert(model.weights['cat:routine-admin'] < 0 && model.weights['cat:order-win'] > 0, 'votes from every surface train one global weight');
  assert(model.surfaces.news['cat:routine-admin'] < 0 && !model.surfaces.news['cat:order-win'], 'each surface also learns on its own');
  assert(fb.learnedAdjustment(model, { keys: ['cat:order-win'], surface: 'announcements' }) > 0, 'a vote cast in All Alerts moves Corporate Announcements');
  assert(fb.learnedAdjustment(model, { keys: ['cat:esop'] }) === 0, 'an untouched topic is unchanged');
  assert(Math.abs(fb.learnedAdjustment(model, { keys: Array.from({ length: 40 }, () => 'cat:routine-admin') })) <= fb.ITEM_CAP);
  assert(fb.learnedAdjustment(model, { keys: [], itemKey: 'alerts:3' }) > 0, 'the voted item moves at once');
  assert(fb.learnedAdjustment(model, { keys: [], eventKey: 'ev:x' }) > 0, 'its stitched filings move with it');
  assert.notEqual(model.revision, fb.EMPTY_MODEL.revision);
  for (const bad of [{ surface: 'x' }, { surface: 'news', vote: 'maybe' }, { surface: 'news', vote: 'important', itemKey: 'a', device: 'short' },
    { surface: 'news', vote: 'important', itemKey: 'a', device: 'device-0001', features: ['BAD KEY'] }]) {
    assert.throws(() => fb.normaliseVote(bad), /Invalid feedback/);
  }
  assert.equal(fb.normaliseVote({ surface: 'news', vote: 'important', itemKey: 'a', device: 'device-0001', why: 'x'.repeat(900) }).why.length, fb.WHY_MAX);
  ok('key weights, global + per-surface learning, caps, direct item/event nudges, vote validation');

  const store = new RelevanceFeedbackStore(sqliteStorage());
  const base = { surface: 'announcements', itemKey: 'a:abc', device: 'device-aaaa1', features: ['cat:results', 'size:large'], label: 'Results' };
  store.apply({ ...base, vote: 'important' });
  store.apply({ ...base, vote: 'not-important', why: 'routine for this company' });
  assert.equal(store.model().votes, 1, 'one browser, one vote per item: the second replaces the first');
  assert(store.model().weights['cat:results'] < 0);
  assert.equal(store.mine('device-aaaa1').votes['a:abc'].vote, 'not-important');
  store.apply({ ...base, device: 'device-bbbb2', vote: 'important' });
  assert.equal(store.model().votes, 2, 'another browser counts separately');
  store.apply({ ...base, vote: 'clear' });
  assert.equal(store.model().votes, 1, 'clear withdraws');
  assert.equal(store.model().recent[0].surface, 'announcements');
  ok('feedback store: replace, separate browsers, withdraw, model rebuilt from votes');
}

// ---------------------------------------------------------------------------------------------
// 4. Event stitching — generic rules over every company
// ---------------------------------------------------------------------------------------------
{
  const day = (d, t = '10:00:00') => Date.parse(`2026-${d}T${t}+05:30`);
  const filing = (id, company, when, title, summary = '', source = 'BSE') => ({ id, company, at: when, title, summary, sources: [source] });
  const rows = [
    filing('1', 'A', day('07-10'), 'Board Meeting Intimation', 'Board meeting to consider the financial results for the quarter ended June 2026'),
    filing('2', 'A', day('07-28', '15:00:00'), 'Financial Results', 'Unaudited financial results for the quarter ended June 2026'),
    filing('3', 'A', day('07-28', '15:05:00'), 'Financial Results', 'Unaudited financial results for the quarter ended June 2026', 'NSE'),
    filing('4', 'A', day('07-29'), 'Investor Presentation', 'Earnings presentation for Q1 FY27 results'),
    filing('5', 'A', day('07-05'), 'Acquisition', 'Acquisition of 51% stake in Alpha Robotics Private Limited'),
    filing('6', 'A', day('07-20'), 'Acquisition', 'Acquisition of Beta Foods Limited by way of share purchase'),
    filing('7', 'B', day('07-28', '15:01:00'), 'Financial Results', 'Unaudited financial results for the quarter ended June 2026'),
    filing('8', 'A', day('07-28', '18:00:00'), 'Closure of Trading Window', 'Closure of trading window'),
  ];
  const tagged = new Map(rows.map((r) => [r.id, cats.categorize(r, 'filing').ids]));
  const { byRow } = stitch.stitchEvents(rows, { companyOf: (r) => r.company, idOf: (r) => r.id, timeOf: (r) => r.at, tagsOf: (r) => tagged.get(r.id), sourcesOf: (r) => r.sources });
  const ev = (id) => byRow.get(id)?.eventId;
  assert.equal(ev('1'), ev('2'), 'the board intimation joins the results it names');
  assert.equal(ev('2'), ev('3'), "the other exchange's copy joins");
  assert.equal(ev('2'), ev('4'), 'the presentation joins the results cycle');
  assert.notEqual(ev('5'), ev('6'), 'two different acquisitions stay two events');
  assert.notEqual(ev('7'), ev('2'), 'events never cross companies');
  assert.notEqual(ev('8'), ev('2'), 'routine paperwork does not join an event');
  assert.equal(byRow.get('2').size, 4);
  ok('results cycle, exchange copies, separate deals, no cross-company or routine joins');
}

// ---------------------------------------------------------------------------------------------
// 5. The index: built from real committed filings, queried through the real object
// ---------------------------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'announcement-index-'));
try {
  const built = buildFixtureIndex(tmp, { root });
  const { index } = built;
  assert(index.counts.rows > 1000 && index.days.length >= 2, 'a real-data fixture');
  const now = () => Date.parse(`${index.range.to}T18:00:00+05:30`);
  const readAsset = async (p) => { try { return JSON.parse((await import('node:fs')).readFileSync(join(root, p), 'utf8')); } catch { return null; } };
  const counter = { reads: 0 };
  let model = fb.EMPTY_MODEL;
  const store = new AnnouncementIndexStore(null, { NSE_LIVE: 'off' }, { source: directorySource(tmp, { counter }), readAsset, now, model: async () => model });

  const all = await store.query({ period: 'all', limit: 500 });
  assert.equal(all.total, index.counts.rows, 'All time holds every filing — ranking never drops one');
  // Days never increase down the list; within a day the (displayed, rounded) relevance never rises.
  for (let i = 1; i < all.rows.length; i++) {
    const a = all.rows[i - 1], b = all.rows[i];
    if (!b.date) continue;
    assert(!a.date || a.date >= b.date, `day order ${a.date} then ${b.date}`);
    if (a.date === b.date) assert(a.relevance >= b.relevance - 0.011, `relevance order within ${a.date}: ${a.relevance} then ${b.relevance}`);
  }
  ok(`${all.total} real filings; newest day first, relevance within the day`);

  // Paging: every page is a slice of one order, with no repeats.
  const seen = new Set();
  let offset = 0;
  for (;;) {
    const page = await store.query({ period: 'all', offset, limit: 500 });
    for (const row of page.rows) { assert(!seen.has(row.id), 'no filing on two pages'); seen.add(row.id); }
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(seen.size, index.counts.rows);
  ok('paging visits every filing exactly once');

  // The fast path (counts from the stored facets) answers exactly as the full scan does.
  for (const q of [{ period: 'all' }, { period: 'all', categories: ['results'] }, { period: 'all', mcap: 'large' }, { period: 'all', mcap: 'unknown', categories: ['other'] }, { period: 'today' }]) {
    const n = shared.normaliseQuery(q);
    assert(skippable(n, store.current.index.days.filter((d) => true)), `skippable ${JSON.stringify(q)}`);
    const fast = await store.query({ ...q, limit: 300 });
    // Full scan reference: the same query through createSelection over every decoded day.
    const segments = await store.segmentsFor(store.current.index.days.filter((d) => {
      const r = shared.periodRange(n.period, now());
      return d.day === shared.UNDATED ? r.undated : r.dated && d.day >= r.from && d.day <= r.to;
    }));
    const reference = shared.selectRows(segments, n, { companyAt: (i) => store.companyAt(i), model });
    assert.equal(fast.total, reference.total, `total ${JSON.stringify(q)}`);
    assert.deepEqual(fast.rows.map((r) => r.id), reference.selected.slice(0, 300).map(([day, i]) => segments.find((s) => s.day === day).rows[i][shared.ROW.ID]), `rows ${JSON.stringify(q)}`);
    assert.deepEqual(fast.facets.categories, reference.facets.categories, `category facets ${JSON.stringify(q)}`);
  }
  ok('the stored per-day counts answer exactly as a full scan (totals, rows, facets)');

  // Filters.
  const orders = await store.query({ period: 'all', categories: ['order-win'], limit: 500 });
  assert(orders.rows.length && orders.rows.every((r) => r.categories.includes('order-win')), 'a category filter keeps only that category');
  assert.equal(orders.total, all.facets.categories['order-win'], 'the facet count is the filtered total');
  const multi = await store.query({ period: 'all', categories: ['order-win', 'acquisition'], limit: 500 });
  assert(multi.total >= Math.max(orders.total, all.facets.categories.acquisition), 'any-of is at least as wide as either category');
  assert(multi.rows.every((r) => r.categories.includes('order-win') || r.categories.includes('acquisition')), 'ticked categories are any-of');
  const mega = await store.query({ period: 'all', mcap: 'mega', limit: 500 });
  assert(mega.rows.every((r) => r.band === 'mega' && r.mcapCr >= 100000));
  const custom = await store.query({ period: 'all', mcap: '5000-20000', limit: 500 });
  assert(custom.rows.every((r) => r.mcapCr >= 5000 && r.mcapCr <= 20000), 'a custom ₹ crore range');
  const unknown = await store.query({ period: 'all', mcap: 'unknown', limit: 500 });
  assert(unknown.rows.every((r) => r.mcapCr === null), '"Not available" lists filings with no market cap');
  const sample = all.rows.find((r) => r.ticker && r.title?.length > 12);
  const word = sample.title.split(/\s+/).slice(0, 3).join(' ');
  const search = await store.query({ period: 'all', q: word, limit: 500 });
  assert(search.rows.some((r) => r.id === sample.id), 'a search finds the filing by its own subject');
  const company = await store.query({ period: 'all', company: { ticker: sample.ticker }, limit: 500 });
  assert(company.rows.length && company.rows.every((r) => r.ticker === sample.ticker), 'one company');
  ok('category (any-of), market cap band / custom range / not available, search and one-company filters');

  // Subjects are the exchange's own words, exactly.
  const raw = new Map(built.rows.map((r) => [`${r.date}|${r.title}`, r]));
  assert(all.rows.every((r) => raw.has(`${r.date}|${r.title}`)), 'every subject is a captured subject, unedited');
  ok('subjects are reproduced exactly as filed');

  // Related filings.
  const linked = all.rows.find((r) => r.event?.size > 1) || (await store.query({ period: 'all', offset: 500, limit: 500 })).rows.find((r) => r.event?.size > 1);
  assert(linked, 'the fixture holds a multi-filing event');
  const event = await store.event(linked.event.id, linked.event);
  assert.equal(event.members.length, linked.event.size, 'the event holds as many filings as the row says');
  assert(event.members.some((m) => m.id === linked.id));
  ok(`related filings: an event of ${event.members.length} filings reads back whole`);

  // Shared feedback moves the order within a day, and never removes a row.
  const today = await store.query({ period: 'all', limit: 50 });
  const top = today.rows[0];
  model = fb.aggregateModel([{ surface: 'announcements', vote: 'not-important', itemKey: top.id, features: top.keys, at: Date.now() }]);
  store.modelCache.at = 0;
  store.queries.clear();
  const after = await store.query({ period: 'all', limit: 500 });
  assert.equal(after.total, all.total, 'a vote hides nothing');
  const sameDay = after.rows.filter((r) => r.date === top.date);
  assert(sameDay.findIndex((r) => r.id === top.id) > 0, 'a Not important vote moves the filing down its day');
  ok('a Not important vote re-orders the day without removing the filing');

  // Profiles for News and All Alerts.
  const profiles = await store.profiles();
  assert(profiles.rows.length > 100 && profiles.rows.every((r) => r.length === 6));
  ok(`company profiles: ${profiles.rows.length} companies with size or sector`);

  // The routes: same-origin writes, structured failures, conditional reads.
  const registry = { getByName: (name) => (name === 'announcement-index:v1'
    ? { annIndexQuery: (i) => store.query(i), annIndexEvent: (id, r) => store.event(id, r), annIndexProfiles: () => store.profiles(), annIndexStatus: () => store.status() }
    : { feedbackModel: async () => model, feedbackApply: async () => ({ ok: true }), feedbackMine: async () => ({ ok: true, votes: {} }) }) };
  const env = { CAPTURE_REGISTRY: registry };
  const post = (path, body, headers = {}) => new Request(`https://dash.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dash.example', ...headers }, body: JSON.stringify(body) });
  assert.equal((await handleAnnouncementIndex(post('/api/announcement-index/query', { period: 'today' }, { origin: 'https://evil.example' }), env)).status, 403, 'a cross-site query is refused');
  const queried = await handleAnnouncementIndex(post('/api/announcement-index/query', { period: 'all', limit: 5 }), env);
  assert.equal(queried.status, 200);
  assert.equal((await queried.json()).rows.length, 5);
  const evRes = await handleAnnouncementIndex(new Request(`https://dash.example/api/announcement-index/event?id=${linked.event.id}&first=${linked.event.first}&last=${linked.event.last}`), env);
  const tag = evRes.headers.get('etag');
  assert(tag);
  assert.equal((await handleAnnouncementIndex(new Request(`https://dash.example/api/announcement-index/event?id=${linked.event.id}&first=${linked.event.first}&last=${linked.event.last}`, { headers: { 'if-none-match': tag } }), env)).status, 304);
  const unavailable = await handleAnnouncementIndex(post('/api/announcement-index/query', {}), { CAPTURE_REGISTRY: { getByName: () => ({ annIndexQuery: async () => ({ ok: false, reason: 'index-unavailable', message: 'No announcement index has been published yet.' }) }) } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).reason, 'index-unavailable', 'no index is a named state, never an empty page');
  assert.equal((await handleRelevanceFeedback(post('/api/relevance/feedback', {}, { origin: 'https://evil.example' }), { ...env, RELEVANCE_FEEDBACK_LIMITER: { limit: async () => ({ success: true }) } })).status, 403);
  const modelRes = await handleRelevanceFeedback(new Request('https://dash.example/api/relevance/model'), env);
  assert.equal(modelRes.status, 200);
  assert.equal((await handleRelevanceFeedback(new Request('https://dash.example/api/relevance/model', { headers: { 'if-none-match': modelRes.headers.get('etag') } }), env)).status, 304);
  ok('routes: same-origin writes, named failures, conditional event and model reads');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// 6. AI Read: one document, read on request, stored, bounded
// ---------------------------------------------------------------------------------------------
{
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
  let documentCalls = 0, modelCalls = 0, modelAnswer = null;
  const reading = { readable: true, issuerMatches: true, documentType: 'Order win', whatHappened: 'The company received a letter of award worth Rs 245 crore from the railway.',
    keyDetails: [{ label: 'Order value', value: 'Rs 245 crore', quote: 'worth Rs 245 crore', location: 'page 1' }],
    whyItMatters: 'The order is about three percent of the market cap and adds to the order book.', impact: { direction: 'positive', horizon: 'medium-term', text: 'Could add to revenue over two years if executed on schedule.' } };
  const fetcher = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://www.bseindia.com/') || href.startsWith('https://nsearchives.nseindia.com/')) {
      documentCalls++;
      if (href.includes('missing')) return new Response('gone', { status: 404 });
      return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    }
    if (href.startsWith('https://bedrock-runtime.')) {
      modelCalls++;
      const body = JSON.parse(init.body);
      assert.equal(body.messages[0].content[0].type, 'document', 'the whole PDF is sent as a document');
      assert.match(body.system[0].text, /untrusted DATA/);
      return Response.json(modelAnswer || { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reading) }] });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  const store = new AnnouncementReadStore(sqliteStorage(), { CLAUDE_KEY: 'ABSKtest-key-not-real' }, { fetcher });
  const item = { id: 'a:1', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/order.pdf', title: 'Award of Order', company: 'Rail Co', ticker: 'RAILCO', date: '2026-10-01' };
  const first = await store.read(item);
  assert.equal(first.state, 'ready');
  assert.equal(first.reading.whatHappened, reading.whatHappened);
  assert.equal(first.reading.keyDetails[0].quote, 'worth Rs 245 crore');
  const again = await store.read({ ...item, id: 'a:other-row-same-document' });
  assert.equal(again.stored, true);
  assert.equal(modelCalls, 1, 'a document is read once, whoever asks');
  const [x, y] = await Promise.all([store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/two.pdf' }), store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/two.pdf' })]);
  assert.equal(x.state, 'ready'); assert.equal(y.state, 'ready');
  assert.equal(modelCalls, 2, 'two readers asking at once pay once');
  assert.equal((await store.read({ ...item, url: 'https://evil.example/x.pdf' })).reason, 'unsupported-source', 'only exchange documents are fetched');
  assert.equal((await store.read({ ...item, url: null })).reason, 'no-document');
  const missing = await store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/missing.pdf' });
  assert.equal(missing.state, 'failed');
  assert(missing.retryAt > Date.now(), 'a temporary failure backs off');
  const callsBefore = documentCalls;
  assert.equal((await store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/missing.pdf' })).state, 'failed');
  assert.equal(documentCalls, callsBefore, 'and is not retried before its time');
  modelAnswer = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...reading, impact: { direction: 'positive', horizon: 'near-term', text: 'Investors should buy the stock now.' } }) }] };
  assert.equal((await store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/advice.pdf' })).reason, 'recommendation', 'a recommendation is not shown');
  modelAnswer = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ readable: true, issuerMatches: false }) }] };
  assert.equal((await store.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/other.pdf' })).reason, 'issuer-mismatch');
  const none = new AnnouncementReadStore(sqliteStorage(), {}, { fetcher });
  assert.equal((await none.read(item)).reason, 'no-key', 'no key, no reading — and no document fetch');
  const budget = new AnnouncementReadStore(sqliteStorage(), { CLAUDE_KEY: 'ABSKtest-key-not-real' }, { fetcher });
  budget.rows("INSERT INTO announcement_read_meta(key,value) VALUES ('budget',?)", JSON.stringify({ day: new Date(Date.now() + 19800000).toISOString().slice(0, 10), used: READ_DAILY_LIMIT }));
  assert.equal((await budget.read({ ...item, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/late.pdf' })).reason, 'budget', 'the daily allowance holds');
  assert.deepEqual(readShared.READ_SECTIONS.map((s) => s.title), ['What happened', 'Key details', 'Why it matters / Investment impact', 'Related event history', 'Source']);
  const route = await handleAnnouncementRead(new Request('https://dash.example/api/announcement-read', { method: 'GET' }), { CAPTURE_REGISTRY: {} });
  assert.equal(route.status, 405, 'a read can only be asked for with POST');
  ok('AI Read: whole PDF to the model, stored per document, shared in flight, exchange hosts only, backoff, budget, no advice, fixed five sections');
}

console.log(`\n${checks} groups of checks passed.`);
