#!/usr/bin/env node
// The team brief, tested where it is decided: the pure contract, the durable store, the brief
// builder against fixtures, the broadsheet renderer, and the alarm that sends.
//
// Run with `node scripts/verify-newsletter.mjs`. Needs no server and no egress: the store runs on
// node:sqlite exactly as the concall summary and watchlist stores do, Yahoo and NSE answer from
// captured fixtures, the committed data files stand in for the assets binding, and the email
// endpoint is a stub that records what it was asked to send.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS, EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT,
  editionWindow, istDay, istInstant, istLabel, newsletterIntent, newsletterIntents, newsletterSettings,
  nextScheduled, normaliseEmail, previousWeekday, scheduledEditions,
} from '../public/js/data/newsletter-shared.js';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import {
  MARKET_ROWS, MOVE_PCT, TOPICS, briefStats, briefStories, briefStoryKeys, briefSubject, buildBrief, familyOf, foldAnnouncements,
  quoteFromChart, readableUrl, renderBriefHtml, renderBriefText, topicOf,
} from '../worker/newsletter-brief.mjs';
import { NewsletterSchedule, NEWSLETTER_TIMER_KEY, EMAIL_SEND_URL, CATCH_UP_MS, sendEmail } from '../worker/newsletter-schedule.mjs';

let failures = 0;
let count = 0;
async function test(name, fn) {
  count++;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.stack || error.message}`);
  }
}

// ---- stand-ins ------------------------------------------------------------------------------------

function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

class Storage {
  constructor() { Object.assign(this, sqlStorage()); this.data = new Map(); this.alarm = null; this.tail = Promise.resolve(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  transaction(fn) { const result = this.tail.then(() => fn(this)); this.tail = result.catch(() => {}); return result; }
}

const fixture = (name) => readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8');
// The XBRL fixtures are shared with `verify-nse-xbrl.mjs`: the brief reads a filing through the
// same parser the dashboard's own filing panel uses, so it must be asserted against the same
// document rather than against a second copy that could drift from it.
const xbrlFixture = (name) => readFileSync(new URL(`./fixtures/nse-xbrl/${name}.xml`, import.meta.url), 'utf8');
const asset = (path) => readFileSync(new URL(`../public${path}`, import.meta.url), 'utf8');
const assets = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    try { return new Response(asset(path), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('missing', { status: 404 }); }
  },
};
// THE BRIEF IS ASSERTED AGAINST FIXTURES, NOT AGAINST TODAY'S CAPTURE. `assets` serves the real
// committed files and is what proves the brief builds on shipped data; `fixtureAssets` serves a
// small known book and two small known captures, and is what the ordering, grouping and
// denominator assertions run on. The shipped book is rewritten by family-book-sync.yml and both
// filing captures by their own evening workflows, so naming a company against those files asserts
// whatever a workflow committed that day — the shipped corp-announcements.json carried 27 rows for
// 19 book companies inside this very window when this was written, and which of them led the sheet
// was a property of the capture rather than of the rule under test.
const FIXTURE_ASSETS = {
  '/data/portfolio-companies.json': 'book.json',
  '/data/corp-announcements.json': 'corp-announcements.json',
  '/data/market-news.json': 'market-news.json',
  '/data/nse-filings/index.json': 'nse-filings-index.json',
  '/data/nse-filings/2026-09-16.json': 'nse-filings-2026-09-16.json',
  '/data/tradingview-news/latest.json': 'tradingview-news.json',
  '/data/technicals.json': 'technicals.json',
};
const fixtureAssets = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const file = FIXTURE_ASSETS[path];
    if (!file) return new Response('missing', { status: 404 });
    return new Response(fixture(file), { headers: { 'content-type': 'application/json' } });
  },
};

const CHARTS = { '^GSPC': 'yahoo-sp500.json', '^N225': 'yahoo-nikkei.json', 'BZ=F': 'yahoo-brent.json', 'JPY=X': 'yahoo-usdjpy.json', '^TNX': 'yahoo-us10y.json' };

// 08:00 IST on 17 September 2026, the morning after the captured feeds.
const MORNING = istInstant('2026-09-17', '08:00');
const nseXml = () => {
  const xml = fixture('nse-announcements.xml');
  // Two filings by a company in the FIXTURE book, inside the window, so the join, the keyword
  // reading, the direction reading and the escaping are asserted rather than hoped for. The
  // company is deliberately one the shipped capture has no rows for in this window.
  const item = '<item><title>Alankit Limited</title><link>https://nsearchives.nseindia.com/corporate/ALANKIT_17092026071500_test.pdf</link><description>Alankit Limited has informed the Exchange regarding Receipt of order from a customer &lt;script&gt;alert(1)&lt;/script&gt; |SUBJECT: Bagging/Receiving of orders/contracts</description><pubDate>17-Sep-2026 07:15:00</pubDate></item>'
    + '<item><title>Alankit Limited</title><link>https://nsearchives.nseindia.com/corporate/ALANKIT_17092026071600_test2.pdf</link><description>Alankit Limited has informed the Exchange regarding Credit rating downgrade by CRISIL |SUBJECT: Credit Rating</description><pubDate>17-Sep-2026 07:16:00</pubDate></item>';
  return xml.replace('<item>', `${item}<item>`);
};

function makeFetcher({ yahoo = 'ok', nse = 'ok', xbrl = 'ok', email = 'ok', log = [] } = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) {
      assert.equal(init.headers?.['user-agent'], 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)');
      const symbol = decodeURIComponent(url.slice('https://query1.finance.yahoo.com/v8/finance/chart/'.length).split('?')[0]);
      log.push({ kind: 'yahoo', symbol });
      if (yahoo === 'down') return new Response('nope', { status: 503 });
      const file = CHARTS[symbol] || 'yahoo-sp500.json';
      return new Response(fixture(file), { headers: { 'content-type': 'application/json' } });
    }
    // The archive, before the feed: an XBRL filing is a document at its own address on the same
    // host, and the brief reads the ones it is about to print.
    if (url.startsWith('https://nsearchives.nseindia.com/corporate/xbrl/')) {
      log.push({ kind: 'xbrl', url });
      if (xbrl === 'blocked') return new Response('<html>Access Denied</html>', { status: 403 });
      if (xbrl === 'interstitial') return new Response('<html>Are you a robot?</html>', { status: 200 });
      return new Response(xbrlFixture('reg30-restructuring-acquisition'), { headers: { 'content-type': 'application/xml' } });
    }
    if (url.startsWith('https://nsearchives.nseindia.com/')) {
      log.push({ kind: 'nse' });
      if (nse === 'blocked') return new Response('<html>Access Denied</html>', { status: 403 });
      return new Response(nseXml(), { headers: { 'content-type': 'application/xml' } });
    }
    if (url === EMAIL_SEND_URL) {
      const body = JSON.parse(init.body);
      log.push({ kind: 'email', to: body.email, subject: body.subject, html: body.html, text: body.text, auth: init.headers.authorization, method: init.method });
      if (email === 'unauthorised') return Response.json({ success: false, message: 'private upstream text' }, { status: 401 });
      if (email === 'down') return new Response('gateway', { status: 502 });
      if (email === 'hang') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      return Response.json({ data: { message: 'Email sent successfully!' }, message: '', success: true });
    }
    throw new Error(`Unexpected request in test: ${url}`);
  };
}

// ---- the contract -----------------------------------------------------------------------------------

console.log('\n— the contract —');

await test('an address is lower-cased and trimmed, and a bad one is null rather than a row', () => {
  assert.equal(normaliseEmail('  Pratik@Muns.IO '), 'pratik@muns.io');
  for (const bad of ['pratik', 'pratik@', '@muns.io', 'a b@muns.io', '', null, 'x'.repeat(250) + '@muns.io']) assert.equal(normaliseEmail(bad), null, String(bad));
});

await test('a subscription names who added it; an unsubscribe need not', () => {
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'a@muns.io' }), /who added/);
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'nope', by: 'Ravi' }), /valid email/);
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'a@muns.io', by: 'Ravi', editions: [] }), /at least one/);
  assert.throws(() => newsletterIntent({ op: 'delete', email: 'a@muns.io' }), /unknown op/);
  assert.deepEqual(newsletterIntent({ op: 'subscribe', email: 'A@muns.io', by: '  Ravi  Kumar ', editions: ['evening', 'morning', 'evening'] }),
    { op: 'subscribe', email: 'a@muns.io', name: null, by: 'Ravi Kumar', editions: ['morning', 'evening'] });
  assert.deepEqual(newsletterIntent({ op: 'unsubscribe', email: 'a@muns.io' }).editions, null);
  assert.throws(() => newsletterIntents([{ op: 'unsubscribe', email: 'a@muns.io' }, { op: 'subscribe', email: 'A@MUNS.IO', by: 'x' }]), /Duplicate/);
  assert.throws(() => newsletterIntents([]), /1 to 20/);
});

await test('the schedule defaults to 08:00 and 16:00 IST and refuses a morning after the evening', () => {
  assert.deepEqual(newsletterSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(newsletterSettings({ morning: { time: '07:30' } }).morning, { enabled: true, time: '07:30' });
  assert.throws(() => newsletterSettings({ morning: { time: '8am' } }), /HH:MM/);
  assert.throws(() => newsletterSettings({ morning: { time: '17:00' } }), /before the evening/);
});

await test('the Indian clock: a fixed +05:30, weekdays only, and the previous weekday steps over a weekend', () => {
  assert.equal(istDay(Date.UTC(2026, 8, 16, 20, 0)), '2026-09-17', '01:30 IST is the next day');
  assert.equal(istLabel(istInstant('2026-09-17', '08:00')), 'Thu 17 Sep, 08:00 IST');
  assert.equal(previousWeekday('2026-09-21'), '2026-09-18', 'Monday looks back to Friday');
  assert.equal(previousWeekday('2026-09-17'), '2026-09-16');
});

await test('the morning window reaches back to the previous weekday evening; the evening to that morning', () => {
  const s = DEFAULT_SETTINGS;
  const monday = editionWindow('morning', '2026-09-21', s);
  assert.equal(istLabel(monday.from), 'Fri 18 Sep, 16:00 IST');
  assert.equal(istLabel(monday.to), 'Mon 21 Sep, 08:00 IST');
  const evening = editionWindow('evening', '2026-09-17', s);
  assert.equal(istLabel(evening.from), 'Thu 17 Sep, 08:00 IST');
  assert.equal(istLabel(evening.to), 'Thu 17 Sep, 16:00 IST');
  const onDemand = editionWindow('morning', '2026-09-17', s, { to: istInstant('2026-09-17', '11:00') });
  assert.equal(istLabel(onDemand.to), 'Thu 17 Sep, 11:00 IST', 'a brief built on request covers up to now');
});

await test('the next send skips weekends and switched-off editions, and vanishes when both are off', () => {
  const s = DEFAULT_SETTINGS;
  const fridayNoon = istInstant('2026-09-18', '12:00');
  assert.deepEqual(nextScheduled(s, fridayNoon), { edition: 'evening', day: '2026-09-18', at: istInstant('2026-09-18', '16:00'), key: '2026-09-18:evening' });
  const fridayNight = istInstant('2026-09-18', '20:00');
  assert.equal(nextScheduled(s, fridayNight).key, '2026-09-21:morning', 'Friday night looks to Monday morning');
  assert.equal(nextScheduled({ ...s, morning: { enabled: false, time: '08:00' } }, fridayNight).key, '2026-09-21:evening');
  assert.equal(nextScheduled({ morning: { enabled: false, time: '08:00' }, evening: { enabled: false, time: '16:00' } }, fridayNight), null);
  assert.deepEqual(scheduledEditions(s, istInstant('2026-09-18', '15:00'), istInstant('2026-09-21', '09:00')).map((e) => e.key),
    ['2026-09-18:evening', '2026-09-21:morning']);
});

// ---- the store ------------------------------------------------------------------------------------

console.log('\n— the store —');

let clock = Date.parse('2026-09-16T05:00:00.000Z');
const makeStore = () => new NewsletterStore(sqlStorage(), { now: () => (clock += 1000) });

await test('subscribe, update, unsubscribe and re-subscribe are one row with a stated state each time', () => {
  const store = makeStore();
  assert.equal(store.snapshot().count, 0);
  let out = store.apply([{ op: 'subscribe', email: 'Pratik@muns.io', by: 'Pratik', editions: ['morning'] }]);
  assert.deepEqual(out.outcomes, [{ email: 'pratik@muns.io', outcome: 'subscribed' }]);
  assert.equal(out.snapshot.subscribers[0].addedBy, 'Pratik');
  assert.deepEqual(out.snapshot.subscribers[0].editions, ['morning']);
  out = store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Someone', editions: ['morning'] }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged', 'a repeated add changes nothing and does not move the revision');
  const revision = out.snapshot.revision;
  out = store.apply([{ op: 'editions', email: 'pratik@muns.io', editions: ['morning', 'evening'] }]);
  assert.equal(out.outcomes[0].outcome, 'updated');
  assert.equal(out.snapshot.revision, revision + 1);
  assert.deepEqual(store.recipients('evening').map((r) => r.email), ['pratik@muns.io']);
  out = store.apply([{ op: 'unsubscribe', email: 'pratik@muns.io' }]);
  assert.equal(out.outcomes[0].outcome, 'unsubscribed');
  assert.equal(out.snapshot.count, 0);
  assert.equal(store.apply([{ op: 'editions', email: 'pratik@muns.io', editions: ['morning'] }]).outcomes[0].outcome, 'not-subscribed');
  out = store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Ravi' }]);
  assert.equal(out.outcomes[0].outcome, 'subscribed');
  assert.equal(out.snapshot.subscribers[0].addedBy, 'Ravi', 'a re-subscription records who did it this time');
});

await test('the list has a ceiling and a refusal never reads as subscribed', () => {
  const store = makeStore();
  for (let i = 0; i < NEWSLETTER_SUBSCRIBER_LIMIT; i += 10) {
    store.apply(Array.from({ length: 10 }, (_, j) => ({ op: 'subscribe', email: `person${i + j}@muns.io`, by: 'Desk' })));
  }
  const out = store.apply([{ op: 'subscribe', email: 'one-more@muns.io', by: 'Desk' }]);
  assert.equal(out.outcomes[0].outcome, 'full');
  assert.equal(out.snapshot.count, NEWSLETTER_SUBSCRIBER_LIMIT);
});

await test('settings persist, an unchanged save moves nothing, a bad one is refused', () => {
  const store = makeStore();
  assert.equal(store.setSettings({ morning: { time: '07:30' } }).changed, true);
  assert.equal(store.settings().morning.time, '07:30');
  assert.equal(store.setSettings({ morning: { time: '07:30' } }).changed, false);
  assert.throws(() => store.setSettings({ evening: { time: '07:00' } }), /before the evening/);
  assert.equal(store.settings().evening.time, '16:00');
});

await test('a delivery key is claimed once, ever', () => {
  const store = makeStore();
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', scheduledAt: MORNING, source: 'timer', recipients: 2 }), true);
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', scheduledAt: MORNING, source: 'timer', recipients: 2 }), false);
  store.finishDelivery('2026-09-17:morning', { sent: 2, failed: 0, outcomes: [{ email: 'a@muns.io', ok: true }, { email: 'b@muns.io', ok: true }], subject: 'x' });
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', source: 'timer', recipients: 2 }), false, 'a finished key stays claimed');
  const d = store.deliveries(5)[0];
  assert.equal(d.sent, 2); assert.equal(d.outcomes.length, 2); assert.ok(d.finishedAt);
});

// ---- the brief --------------------------------------------------------------------------------------

console.log('\n— the brief —');

await test('a Yahoo chart becomes a quote with its own session state and time', () => {
  const sp = quoteFromChart(JSON.parse(fixture('yahoo-sp500.json')), MARKET_ROWS[0], MORNING);
  assert.equal(sp.state, 'close', 'the US session is over at 08:00 IST');
  assert.ok(sp.last > 0 && sp.prev > 0 && Number.isFinite(sp.changePct));
  assert.equal(sp.timezone, 'America/New_York');
  const nikkei = quoteFromChart(JSON.parse(fixture('yahoo-nikkei.json')), MARKET_ROWS[3], MORNING);
  assert.equal(nikkei.state, 'live', 'Tokyo is trading at 08:00 IST');
  assert.throws(() => quoteFromChart({ chart: { result: [{ meta: {} }] } }, MARKET_ROWS[0], MORNING), /shape/);
});

// Glow Central Research, which this brief is ported from, keeps a macro series store and fills a
// refused symbol from it. This dashboard has no such file, so there is no second reading and the
// row must stay refused — which is the property worth asserting, because the failure it guards
// against is a stale close printed as this morning's.
await test('this dashboard carries no series fallback, so no scan row may claim a second source', async () => {
  const briefModule = await import('../worker/newsletter-brief.mjs');
  assert.equal('quoteFromSeries' in briefModule, false, 'the fallback reader is not present');
  assert.equal('SERIES_INDEX_PATH' in briefModule, false, 'nor the path it would have read');
  assert.ok(MARKET_ROWS.every((r) => !('series' in r)), 'no scan row names a fallback series');
});

await test('the desk\'s keyword families fold onto the seven topics, and nothing matched is Other', () => {
  assert.equal(topicOf({ keywordIds: ['order'], keywordGroups: ['growth'] }).id, 'orders');
  assert.equal(topicOf({ keywordIds: ['capex'], keywordGroups: ['growth'] }).id, 'growth');
  assert.equal(topicOf({ keywordIds: ['credit-rating'], keywordGroups: ['risk'] }).id, 'trouble');
  assert.equal(topicOf({ keywordIds: [], keywordGroups: [] }).id, 'other');
  assert.deepEqual(TOPICS.map((t) => t.label), ['Growth', 'Orders', 'Deals', 'Money', 'Approvals & IP', 'Trouble', 'Other']);
});

let morning;
await test('the morning brief builds from the fixtures and every section states its window and sources', async () => {
  const log = [];
  morning = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: fixtureAssets }, fetcher: makeFetcher({ log }), now: MORNING });
  assert.equal(log.filter((l) => l.kind === 'yahoo').length, MARKET_ROWS.length, 'one chart read per symbol');
  assert.equal(log.filter((l) => l.kind === 'nse').length, 1);
  assert.equal(morning.markets.rows.length, MARKET_ROWS.length);
  assert.deepEqual(morning.markets.failed, []);
  assert.equal(istLabel(morning.window.from), 'Wed 16 Sep, 16:00 IST');
  assert.equal(istLabel(morning.window.to), 'Thu 17 Sep, 08:00 IST');
  assert.equal(morning.book.lines, 4, 'the book\'s own count travels');
  assert.equal(morning.book.listed, 3, 'the denominator is the LISTED lines — a line with no NSE symbol is still a holding');
  assert.equal(morning.announcements.nse.ok, true);
  const filer = morning.announcements.groups.find((g) => g.ticker === 'ALANKIT');
  assert.ok(filer, 'a filing by a book company inside the window joins');
  assert.equal(filer.items.length, 2);
  const order = filer.items.find((i) => /Receipt of order/.test(i.headline));
  assert.ok(order.keywords.includes('Receipt of Order'), 'the exchange\'s own phrase is a tracked keyword');
  assert.equal(order.direction, 'neutral', 'a customer order receipt is not called an award by the filing rule');
  const downgrade = filer.items.find((i) => /downgrade/.test(i.headline));
  assert.equal(downgrade.direction, 'negative', 'the filing rule reads a downgrade as negative');
  // The BSE capture contributes a second book company, and a filing by a company the desk does
  // not hold is not in the brief at all.
  assert.ok(morning.announcements.groups.some((g) => g.ticker === 'ABCAPITAL'), 'the BSE capture joins on the book too');
  assert.equal(log.filter((l) => l.kind === 'xbrl').length, 1, 'the one XBRL filing in this window is read, and only it');
  assert.ok(!morning.announcements.groups.some((g) => g.ticker === 'NOTINBOOK'), 'a filing by a company the desk does not hold never reaches the sheet');
  assert.equal(morning.news.source.ok, true);
  assert.ok(morning.news.source.publishers.length >= 1);
  const story = morning.news.groups.find((g) => g.ticker === 'ADANIENT');
  assert.ok(story, 'a published story about a book company joins');
  assert.equal(story.items.length, 2, 'the publisher story and the one TradingView headline that names the company');
  assert.ok(!story.items.some((i) => /earlier in the week/.test(i.headline)), 'a story published before the window opens stays out');
  for (const g of morning.news.groups) for (const item of g.items) assert.ok(item.at >= morning.window.from && item.at < morning.window.to);
});

// ---- the filing whose description said nothing ------------------------------------------------
//
// THE REPORT THIS CLOSES, in the desk's words: a filing arrived in the brief written as
// "Acquisition (including agreement to acquire)", which does not tell them anything, and clicking
// it opened a page of XML. Both halves are asserted here — what the line SAYS, and where it GOES.

const acquisitionStory = () => {
  const story = briefStories(morning).find((s) => /Acquisition \(including agreement to acquire\)/.test(s.headline));
  assert.ok(story, 'the XBRL-only acquisition filing is in the brief');
  return story;
};

await test('a filing whose description is the bare category still names the company, and carries the filing\'s own particulars', () => {
  const story = acquisitionStory();
  // NSE's description of one of these is "<company> has informed the Exchange regarding <category>".
  // Strip the preamble and what is left names a FORM; the exchange's whole sentence names the filer.
  assert.ok(story.headline.startsWith('Aditya Birla Capital Limited'), story.headline);
  assert.ok(story.headline.includes('Acquisition (including agreement to acquire)'), story.headline);
  // ...and the particulars come from the document, as `label: value` pairs, never as prose of ours.
  assert.ok(Array.isArray(story.detail) && story.detail.length > 1);
  const byLabel = new Map(story.detail.map((f) => [f.label, f]));
  assert.equal(byLabel.get('Name of the target entity').value, 'Meridian Analytics Private Limited');
  assert.equal(byLabel.get('Cost of acquisition or the price at which the shares are acquired').value, '1850000000');
  assert.equal(byLabel.get('Cost of acquisition or the price at which the shares are acquired').unit, 'INR');
  assert.ok(story.detailOmitted > 0, 'what the line did not carry is counted, not dropped silently');
  // The dek is the venue, and does not repeat the category the headline already carries.
  assert.equal(story.dek, 'NSE filing');
});

await test('a headline that names the filer does not put the company into the event vocabulary', () => {
  const story = acquisitionStory();
  // The keyword and direction rules read the EVENT, so a filer's own name can never match one.
  assert.deepEqual(story.keywords, ['Acquisition']);
  assert.equal(story.topic.id, 'deals');
  assert.equal(story.mood.id, 'neutral', 'an acquisition intimation is a topic, not a direction');
});

await test('a filing link lands on the filing, not on a page of XML', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test' });
  const story = acquisitionStory();
  const reader = `https://example.test/filing?src=${encodeURIComponent(story.url)}&view=2`;
  assert.ok(html.includes(`href="${reader.replace(/&/g, '&amp;')}"`), 'the XBRL filing opens through the dashboard\'s readable copy');
  assert.ok(!html.includes(`href="${story.url}"`), 'the raw .xml is no longer what a reader clicks');
  assert.ok(html.includes('Read the filing →'));
  assert.ok(html.includes('Name of the target entity:') && html.includes('Meridian Analytics Private Limited'));
  // Every other link in the brief still goes straight to the publisher or the exchange.
  const pdf = briefStories(morning).find((s) => /\.pdf$/.test(s.url || ''));
  assert.ok(pdf && html.includes(`href="${pdf.url}"`), 'a PDF filing is untouched');
  assert.equal(readableUrl(pdf.url, 'https://example.test'), pdf.url);
  // ...and the plain-text copy carries the same destination and the same particulars.
  const text = renderBriefText(morning, { dashboardUrl: 'https://example.test' });
  assert.ok(text.includes(reader));
  assert.ok(text.includes('Name of the target entity: Meridian Analytics Private Limited'));
  assert.ok(text.includes('Cost of acquisition or the price at which the shares are acquired: 1850000000 INR'));
});

await test('the brief says how many filings it read for their particulars', async () => {
  const f = morning.announcements.filings;
  assert.deepEqual({ candidates: f.candidates, read: f.read, ok: f.ok, failed: f.failed }, { candidates: 1, read: 1, ok: 1, failed: 0 });
  const text = renderBriefText(morning);
  assert.ok(text.includes('1 of 1 XBRL filing read for the particulars they carry'), text.slice(-900));
  // ...and the delivery log records it, so an operator can see the particulars landing over time.
  const { briefSummary } = await import('../worker/newsletter-brief.mjs');
  assert.equal(briefSummary(morning).filingsRead, 1);
  assert.equal(briefSummary(morning).filingsUnread, 0);
});

await test('a filing the archive refuses keeps its headline and is counted, never guessed at', async () => {
  for (const mode of ['blocked', 'interstitial']) {
    const brief = await buildBrief({
      edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS,
      env: { ASSETS: fixtureAssets }, fetcher: makeFetcher({ xbrl: mode }), now: MORNING,
    });
    const story = briefStories(brief).find((s) => /Acquisition \(including agreement to acquire\)/.test(s.headline));
    assert.ok(story, `${mode}: the filing is still in the brief`);
    assert.equal(story.detail, null, `${mode}: nothing is invented for a filing that could not be read`);
    assert.ok(story.headline.startsWith('Aditya Birla Capital Limited'), `${mode}: the exchange's own words still stand`);
    assert.equal(brief.announcements.filings.failed, 1, `${mode}: the failure is counted`);
    assert.equal(brief.announcements.filings.ok, 0);
    // A 200 that is not the filing is not a filing with nothing in it — the route's rule.
    const html = renderBriefHtml(brief, { dashboardUrl: 'https://example.test' });
    assert.ok(html.includes(`https://example.test/filing?src=${encodeURIComponent(story.url)}`), `${mode}: the link still goes to the readable copy`);
    assert.ok(!/more fields in the filing/.test(html.slice(html.indexOf(story.headline), html.indexOf(story.headline) + 1200)), `${mode}: no count of fields nobody read`);
  }
});

await test('the broadsheet carries the Sattva Ventures masthead, escapes the exchanges\' text and dates every figure', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test', recipient: { email: 'pratik@muns.io', addedBy: 'Ravi' } });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<meta name="color-scheme" content="light">'));
  assert.ok(html.includes('letter-spacing:3px;color:#0f172a;">SATTVA VENTURES</div>'), 'the masthead is the family office\'s name');
  assert.ok(!html.includes('MUNSHOT'), 'no Munshot masthead on a Sattva Ventures brief');
  assert.ok(html.includes('border-top:3px double #0f172a'), 'the double rule');
  assert.ok(html.includes('Research Central — Morning Portfolio Brief'));
  assert.ok(html.includes('Edition: Portfolio companies'));
  assert.ok(html.includes('Sattva Ventures · Research Central'), 'the caption under the sheet');
  assert.ok(html.includes('https://example.test/#/research/ask-research?newsletter=manage'), 'the unsubscribe link lands on the panel');
  assert.ok(html.includes('Added by Ravi'));
  assert.ok(html.includes('Global market scan'));
  assert.ok(html.includes('S&amp;P 500'));
  assert.ok(!html.includes('<script>'), 'exchange text is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(/Close · \w{3} \d{2}:\d{2} \w+/.test(html), 'a closed market prints its close time');
  assert.ok(/Live · \w{3} \d{2}:\d{2} \w+/.test(html), 'a trading market prints its last print');
  assert.match(html, /<strong style="[^"]*color:#3b82f6;[^"]*">ORDERS<\/strong>/, 'the Orders topic keeps its bold label and colour');
  assert.ok(/\b1 watch-out\b/.test(html), 'the downgrade filing is counted as a watch-out on the stats line');
  assert.ok(html.includes('#f43f5e'), 'the watch-out colour appears');
  assert.ok(html.includes('Read →'), 'every story offers Read →');
  assert.ok(!html.includes('<style') && !html.includes('<script'), 'no stylesheet, no script');
  assert.ok(html.length < 200000);
  const subject = briefSubject(morning);
  assert.match(subject, /^Sattva Ventures · \d+ updates? on your portfolio companies — 17 Sep$/, subject);
  const text = renderBriefText(morning);
  assert.ok(text.startsWith('SATTVA VENTURES') && text.includes('GLOBAL MARKET SCAN') && text.includes('Alankit'));
  assert.ok(text.indexOf('YOUR PORTFOLIO COMPANIES') < text.indexOf('GLOBAL MARKET SCAN'), 'the text copy leads with the companies too');
});

await test('the portfolio companies lead the sheet, each company once, strongest first, with its stories under it', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test' });
  const stats = briefStats(morning);
  assert.ok(stats.companies.length > 0);
  assert.equal(stats.companies.reduce((n, c) => n + c.stories.length, 0), stats.stories, 'every story sits under exactly one company');
  assert.equal(new Set(stats.companies.map((c) => c.ticker)).size, stats.companies.length, 'a company appears once, filings and news together');
  for (let i = 1; i < stats.companies.length; i++) {
    const [a, b] = [stats.companies[i - 1], stats.companies[i]];
    assert.ok(a.score > b.score || (a.score === b.score && a.stories.length >= b.stories.length), `${a.ticker} before ${b.ticker}`);
  }
  assert.equal(stats.companies[0].ticker, 'ALANKIT', 'the company with a tracked order and a downgrade leads');
  assert.deepEqual(stats.companies.map((c) => c.ticker), ['ALANKIT', 'ABCAPITAL', 'ADANIENT'],
    'a tracked AND directional filing outranks a merely directional one, which outranks a neutral published story');
  // 4: a tracked keyword, a direction and high importance. 3: ABCAPITAL's acquisition intimation
  // is tracked and material to the filing rule but carries no direction. 0: a published headline.
  assert.deepEqual(stats.companies.map((c) => c.score), [4, 3, 0], 'the ladder is the score, and no company invents one');
  assert.equal(stats.companies[0].watch, 1, 'the downgrade is the watch-out');
  assert.equal(stats.companies[0].stories[0].headline.includes('downgrade'), true, 'within a company the tie breaks on recency');
  assert.equal(stats.companies.at(-1).stories[0].mood.id, 'neutral', 'a published headline carries no direction of ours');
  assert.ok(html.indexOf('Your portfolio companies') > 0 && html.indexOf('Your portfolio companies') < html.indexOf('Global market scan'), 'companies before the market scan');
  assert.ok(html.indexOf('Alankit') < html.indexOf('Global market scan'));
  assert.ok(html.includes(`across <strong style="color:#0f172a;">${stats.companies.length} of ${morning.book.listed}</strong> portfolio companies`), 'the summary counts companies against the book');
  assert.ok(html.includes('https://example.test/#/research/daily-alerts?scope=portfolio&amp;company=ALANKIT'), 'a company links to its own alerts on the dashboard');
});

// The tests above run on fixtures so their assertions mean the same thing tomorrow. This one runs
// on the SHIPPED files — the real book and the two real captures — because a brief that only ever
// builds against a fixture has not been shown to build against the data it will actually be sent
// from. It therefore asserts structure and honesty, never a company or a count.
await test('the brief also builds against the shipped book and captures, and invents nothing doing it', async () => {
  const real = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: MORNING });
  assert.ok(real.book.listed > 100 && real.book.listed <= real.book.lines, 'the shipped book is the denominator, listed lines only');
  const stats = briefStats(real);
  assert.equal(stats.companies.reduce((n, c) => n + c.stories.length, 0), stats.stories);
  assert.equal(new Set(stats.companies.map((c) => c.ticker)).size, stats.companies.length, 'a company appears once');
  for (let i = 1; i < stats.companies.length; i++) {
    const [a, b] = [stats.companies[i - 1], stats.companies[i]];
    assert.ok(a.score > b.score || (a.score === b.score && a.stories.length >= b.stories.length), `${a.ticker} before ${b.ticker}`);
  }
  const bookTickers = new Set(JSON.parse(asset('/data/portfolio-companies.json')).holdings.filter((h) => h?.ticker).map((h) => h.ticker.toUpperCase()));
  for (const c of stats.companies) assert.ok(bookTickers.has(c.ticker), `${c.ticker} is a direct holding`);
  for (const s of briefStories(real)) {
    assert.ok((s.late ? s.at >= real.window.since && s.at < real.window.from : s.at >= real.window.from) && s.at < real.window.to, 'every story is inside the window it is filed under, or is a marked late arrival from the previous one');
    if (s.kind === 'news') assert.equal(s.mood.id, 'neutral', 'a published headline never carries a direction of ours');
  }
  const html = renderBriefHtml(real, { dashboardUrl: 'https://example.test' });
  assert.ok(!html.includes('<script'), 'nothing the exchanges or publishers wrote reaches the DOM as markup');
  assert.ok(html.includes('SATTVA VENTURES'));
});

await test('every link in the brief opens in a new tab', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test', recipient: { email: 'pratik@muns.io' } });
  const anchors = html.match(/<a\s[^>]*>/g) || [];
  assert.ok(anchors.length > 5, 'stories, companies and the footer carry links');
  for (const a of anchors) {
    assert.ok(a.includes('target="_blank"'), a);
    assert.ok(a.includes('rel="noopener noreferrer"'), a);
  }
  assert.ok(html.includes('<base target="_blank">'), 'the preview page opens anything else in a new tab too');
});


await test('the retained NSE history joins; one filing lodged with both exchanges is one story; an XBRL twin folds into its readable copy', () => {
  assert.equal(morning.announcements.history.ok, true);
  assert.deepEqual(morning.announcements.history.days, ['2026-09-16'], 'only the day the window touches is read');
  const abc = morning.announcements.groups.find((g) => g.ticker === 'ABCAPITAL');
  assert.ok(abc);
  const office = abc.items.filter((i) => /registered office/.test(i.headline));
  assert.equal(office.length, 1, 'the filing BSE and NSE both carry is one story');
  assert.deepEqual(office[0].exchanges, ['BSE', 'NSE'], 'and it names both venues');
  assert.ok(office[0].keys.some((k) => k.startsWith('ABCAPITAL|BSE:')) && office[0].keys.some((k) => k.startsWith('ABCAPITAL|NSE:')), 'it keeps the key of every copy it absorbed');
  const meets = abc.items.filter((i) => /analysts or institutional investors meet/i.test(i.headline));
  assert.equal(meets.length, 1, 'NSE\'s readable PDF and its XBRL twin are one story');
  assert.deepEqual(meets[0].exchanges, ['NSE'], 'an NSE-only filing is on the sheet as NSE\'s');
  assert.ok(meets[0].keys.some((k) => k.endsWith('meet.xml')), 'the twin\'s key travels with the story it folded into');
  assert.ok(!meets[0].headline.includes('has informed the Exchange'), 'NSE\'s "X has informed the Exchange about" preamble is not printed under a heading that already names X');
  assert.ok(!morning.announcements.groups.some((g) => g.ticker === 'NOTINBOOK'));
});

await test('two filings sharing their first sixty characters are two stories: the fold keys on the exchange\'s own document, never a headline prefix', () => {
  const abc = morning.announcements.groups.find((g) => g.ticker === 'ABCAPITAL');
  const reg30 = abc.items.filter((i) => i.headline.startsWith('Intimation under Regulation 30 of the Securities and Exchange Board of India'));
  assert.equal(reg30.length, 2, 'both Regulation 30 intimations survive');
  assert.ok(reg30.some((i) => /registered office/.test(i.headline)) && reg30.some((i) => /Newspaper publication/.test(i.headline)));
  const at = istInstant('2026-09-16', '19:00');
  const rows = [
    { exchange: 'BSE', ticker: 'X', headline: 'Please refer the enclosed file.', url: 'https://bse.test/a.pdf', at, subject: 'General', family: familyOf('General', 'Company Update') },
    { exchange: 'BSE', ticker: 'X', headline: 'Please refer the enclosed file.', url: 'https://bse.test/b.pdf', at: at + 60000, subject: 'General', family: familyOf('General', 'Company Update') },
    { exchange: 'NSE', ticker: 'X', headline: 'Credit rating of the bank affirmed by CRISIL', url: 'https://nse.test/c.pdf', at: at + 120000, subject: 'Credit rating', family: familyOf('Credit rating') },
  ];
  assert.equal(foldAnnouncements(rows, { from: at - 1 }).length, 3, 'nothing from the same exchange folds, and a rating does not fold into a general update');
  const withRating = [...rows, { exchange: 'BSE', ticker: 'X', headline: 'Please refer the enclosed file.', url: 'https://bse.test/d.pdf', at: at + 100000, subject: 'Credit Rating', family: familyOf('Credit Rating', 'Company Update') }];
  const folded = foldAnnouncements(withRating, { from: at - 1 });
  assert.equal(folded.length, 3);
  const rating = folded.find((s) => s.exchanges.length === 2);
  assert.ok(rating, 'NSE\'s credit-rating filing folds into BSE\'s, on the subject family, minutes apart');
  assert.equal(rating.headline, 'Credit rating of the bank affirmed by CRISIL', 'BSE\'s placeholder headline gives way to NSE\'s description of the same filing');
  assert.equal(familyOf('Analysts/Institutional Investor Meet/Con. Call Updates'), familyOf('Analyst / Investor Meet', 'Company Update'));
  assert.equal(familyOf('Outcome of Board Meeting'), 'board');
  assert.equal(familyOf('Disclosures under Reg. 29(2) of SEBI (SAST) Regulations, 2011', 'Insider Trading / SAST'), 'insider');
  assert.equal(familyOf('Declaration of NAV'), null, 'a subject with no family folds only on identical text');
});

await test('TradingView\'s portfolio headlines join the news only where the dashboard confirms the story names the company, and a story two feeds carry is one story', () => {
  assert.equal(morning.news.tradingView.ok, true);
  const adani = morning.news.groups.find((g) => g.ticker === 'ADANIENT');
  assert.ok(adani);
  assert.equal(adani.items.length, 2);
  const park = adani.items.filter((i) => /logistics park/.test(i.headline));
  assert.equal(park.length, 1, 'the same story from the publisher feed and from TradingView is one story');
  assert.ok(park[0].url.startsWith('https://www.business-standard.com/'), 'which keeps the publisher\'s own address');
  const airports = adani.items.find((i) => /airports business/.test(i.headline));
  assert.ok(airports, 'a TradingView headline naming the company joins');
  assert.equal(airports.publisher, 'Mint');
  assert.equal(airports.origin, 'tradingview');
  assert.ok(!adani.items.some((i) => /Five safe dividend stocks/.test(i.headline)), 'a headline tagged to the symbol that never names the company stays off the sheet');
  assert.equal(morning.news.tradingView.unverified, 1);
  assert.ok(briefStories(morning).filter((s) => s.kind === 'news').every((s) => s.mood.id === 'neutral'), 'a published headline still carries no direction of ours');
});

await test('a holding that moved 5% or more on its last completed session is on the sheet, dated by the session and marked whether its close was verified', () => {
  assert.equal(morning.moves.source.ok, true);
  assert.equal(morning.moves.source.threshold, MOVE_PCT);
  assert.deepEqual(morning.moves.rows.map((r) => r.ticker), ['ABCAPITAL', 'ALANKIT'], 'largest move first; a 1.2% move and a company not held are absent');
  const stories = briefStories(morning);
  const abc = stories.find((s) => s.kind === 'move' && s.ticker === 'ABCAPITAL');
  assert.equal(abc.headline, 'Rose 6.2% at the 16 Sept close · ₹212.35');
  assert.equal(abc.mood.id, 'good', 'a rise is good by the dashboard\'s own price-move rule');
  assert.match(abc.dek, /verified against the exchange/);
  const alankit = stories.find((s) => s.kind === 'move' && s.ticker === 'ALANKIT');
  assert.match(alankit.dek, /not yet verified/);
  assert.ok(abc.late && alankit.late, 'a session that closed inside the previous window and reached the file this morning is a late arrival');
  assert.ok(renderBriefText(morning).includes('Rose 6.2% at the 16 Sept close'));
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('closes for the 2026-09-16 session captured'), 'the sources line dates the closes');
  assert.ok(html.includes('filing and price-move rules'), 'the footer says where a move\'s mood comes from');
  // The threshold is the dashboard's own, and the two constants may not drift.
  assert.equal(Number(asset('/js/data/daily-alerts.js').match(/export const MOVE_PCT = (\d+(?:\.\d+)?);/)[1]), MOVE_PCT);
});

await test('a capture that landed after the previous brief went out is carried by the next brief, marked late, and only when no earlier brief sent it', async () => {
  const sent = new Set(briefStoryKeys(morning));
  assert.ok(sent.size > 0);
  const evening = (keys) => buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: fixtureAssets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '16:00'), sent: keys });
  const unsent = await evening(new Set());
  assert.equal(istLabel(unsent.window.since), 'Wed 16 Sep, 16:00 IST', 'the evening reaches back over the morning\'s window');
  const late = briefStories(unsent);
  assert.ok(late.length >= 8, `every fixture row sits in the morning window: ${late.length}`);
  assert.ok(late.every((s) => s.late), 'nothing in the evening window itself, so every story is a late arrival');
  const html = renderBriefHtml(unsent, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes(`${late.length} not in the previous brief`), 'the summary line counts them');
  assert.ok(html.includes('· not in the previous brief'), 'and each one says so');
  assert.ok(html.includes(`${late.length} items from before this window were not in the previous brief and are included.`));
  const all = await evening(sent);
  assert.equal(briefStories(all).length, 0, 'once the morning brief carried them, the evening repeats none');
  assert.equal(all.announcements.suppressed + all.news.suppressed + all.moves.suppressed, late.length);
  assert.ok(renderBriefHtml(all, {}).includes('Quiet window'));
  const office = late.find((s) => /registered office/.test(s.headline));
  const partial = await evening(new Set([...sent].filter((k) => !office.keys.includes(k))));
  assert.deepEqual(briefStories(partial).map((s) => s.headline), [office.headline], 'drop one story\'s keys and only that story comes back — the one the desk never received');
});

await test('a refused quote source and a blocked exchange are stated on the page, never drawn as numbers', async () => {
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher({ yahoo: 'down', nse: 'blocked' }), now: istInstant('2026-09-17', '16:00') });
  assert.ok(brief.markets.failed.length > 0, 'a refused symbol is recorded as refused');
  assert.equal(brief.markets.stored, undefined, 'there is no stored-fallback bucket to hide a refusal in');
  assert.ok(brief.markets.rows.filter((r) => brief.markets.failed.includes(r.id)).every((r) => r.last == null),
    'a refused row carries NO number');
  assert.equal(brief.announcements.nse.ok, false);
  assert.equal(brief.announcements.nse.reason, 'blocked');
  const html = renderBriefHtml(brief);
  assert.ok(!html.includes('Series store'), 'nothing claims a store this dashboard does not keep');
  assert.ok(html.includes('unavailable'), 'a refused quote says so on its own row');
  assert.ok(html.includes('NSE feed could not be read (blocked)'));
  const stats = briefStats(brief);
  assert.equal(stats.stories, brief.announcements.count + brief.news.count + brief.moves.count);
});

await test('with nothing filed or published the sheet says so, and only about what it could read', async () => {
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '02:00') });
  const html = renderBriefHtml(brief);
  if (!briefStats(brief).stories) {
    assert.ok(html.includes('Quiet window — nothing to report.'));
    assert.ok(html.includes('Nothing was filed or published about a portfolio company in this window.'));
  }
  assert.ok(html.includes('SATTVA VENTURES'));
});

// ---- the schedule -----------------------------------------------------------------------------------

console.log('\n— the schedule —');

function makeSchedule({ env = {}, fetcherOptions = {}, now = () => clock } = {}) {
  const storage = new Storage();
  const store = new NewsletterStore(storage, { now });
  const log = fetcherOptions.log || (fetcherOptions.log = []);
  const schedule = new NewsletterSchedule(storage, { ASSETS: assets, MUNS_TOKEN: 'team-secret-token', ...env }, store, { fetcher: makeFetcher(fetcherOptions), now });
  return { storage, store, schedule, log };
}

await test('arming points the alarm at the next weekday send and re-arms after every wake', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  assert.equal(await storage.getAlarm(), null);
  await schedule.arm();
  assert.equal(await storage.getAlarm(), MORNING, 'Wednesday evening arms Thursday 08:00 IST');
  const status = await schedule.status();
  assert.equal(status.next.key, '2026-09-17:morning');
  assert.equal(status.tokenConfigured, true);
  store.setSettings({ morning: { enabled: false, time: '08:00' } });
  await schedule.arm();
  assert.equal(await storage.getAlarm(), istInstant('2026-09-17', '16:00'), 'switching the morning off moves the alarm to the evening');
});

await test('the alarm sends the morning brief to its subscribers once, with html only, and a replay sends nothing', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule, log } = makeSchedule();
  store.apply([
    { op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik', name: 'Pratik' },
    { op: 'subscribe', email: 'ravi@muns.io', by: 'Pratik', editions: ['evening'] },
    { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' },
  ]);
  await schedule.arm();
  clock = MORNING + 5000;
  await schedule.wake();
  const emails = log.filter((l) => l.kind === 'email');
  assert.deepEqual([...new Set(emails.map((e) => e.to))].sort(), ['meera@muns.io', 'pratik@muns.io'], 'only morning subscribers, ravi is evening-only');
  const delivery = store.delivery('2026-09-17:morning');
  assert.equal(emails.length, 2 * delivery.summary.emailParts, 'every subscriber receives every part');
  for (const e of emails) {
    assert.equal(e.method, 'POST');
    assert.equal(e.auth, 'Bearer team-secret-token');
    assert.ok(e.html && e.text === undefined, 'exactly one of html/text');
    assert.match(e.subject, /^Sattva Ventures · \d+ updates? on your portfolio companies — 17 Sep(?: · Morning · Part \d+ of \d+)?$/);
    assert.ok(e.html.includes('SATTVA VENTURES'));
  }
  assert.equal(delivery.sent, 2); assert.equal(delivery.failed, 0); assert.equal(delivery.source, 'timer');
  assert.ok(delivery.finishedAt);
  assert.equal(delivery.summary.quotes, MARKET_ROWS.length);
  assert.equal(await storage.getAlarm(), istInstant('2026-09-17', '16:00'), 're-armed for the evening');
  const before = log.length;
  await schedule.wake();
  assert.equal(log.length, before, 'a replayed alarm reads nothing and sends nothing');
  assert.equal((await schedule.status()).lastResult, 'nothing-due');
  assert.ok(!JSON.stringify([...storage.data.values()]).includes('team-secret-token'), 'the token never enters durable storage');
});


await test('the evening brief repeats nothing the morning brief sent, and a test copy records nothing', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule({ env: { ASSETS: fixtureAssets } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + 5000;
  await schedule.wake();
  const sentKeys = store.sentStoryKeys();
  assert.ok(sentKeys.size > 0, 'the morning delivery recorded what it carried');
  assert.ok(log.filter((l) => l.kind === 'email').at(-1).html.includes('Alankit'));
  assert.ok(!/\|(?:BSE|NSE|url|title|text|move):/.test(JSON.stringify(store.deliveries(1))), 'the panel sees counts, never the keys');
  clock = istInstant('2026-09-17', '16:00') + 5000;
  await schedule.wake();
  const evening = log.filter((l) => l.kind === 'email').at(-1).html;
  assert.ok(evening.includes('Evening Portfolio Brief'));
  assert.ok(evening.includes('Quiet window') && !evening.includes('Alankit'), 'nothing new in the evening window, and nothing repeated from the morning');
  assert.ok(store.delivery('2026-09-17:evening').summary.suppressed > 0);
  const out = await schedule.sendNow({ edition: 'evening', to: 'me', email: 'pratik@muns.io' });
  assert.equal(out.ok, true);
  assert.equal(store.deliveries(1)[0].source, 'test');
  assert.equal(store.sentStoryKeys().size, sentKeys.size, 'a test copy adds nothing to what the desk has read');
});

await test('a missed morning brief\'s window is carried by the evening brief as late arrivals rather than lost', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule({ env: { ASSETS: fixtureAssets } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + CATCH_UP_MS + 60000;
  await schedule.wake();
  assert.equal(store.delivery('2026-09-17:morning').reason, 'missed');
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  clock = istInstant('2026-09-17', '16:00') + 5000;
  await schedule.wake();
  const html = log.filter((l) => l.kind === 'email').at(-1).html;
  assert.ok(html.includes('Evening Portfolio Brief') && html.includes('Alankit') && html.includes('not in the previous brief'));
  assert.ok(store.delivery('2026-09-17:evening').summary.late > 0);
});

await test('without a token the delivery is recorded as no-token against every recipient and nothing is posted', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule({ env: { MUNS_TOKEN: undefined } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + 1000;
  await schedule.wake();
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal(log.filter((l) => l.kind === 'yahoo').length, 0, 'nothing is even built without a way to send it');
  const d = store.delivery('2026-09-17:morning');
  assert.equal(d.reason, 'no-token'); assert.equal(d.failed, 1); assert.deepEqual(d.outcomes, [{ email: 'pratik@muns.io', ok: false, reason: 'no-token' }]);
  assert.equal((await schedule.status()).tokenConfigured, false);
});

await test('a refused send is a failure per recipient, never a sent count, and carries no upstream text', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule } = makeSchedule({ fetcherOptions: { email: 'unauthorised' } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + 1000;
  await schedule.wake();
  const d = store.delivery('2026-09-17:morning');
  assert.equal(d.sent, 0); assert.equal(d.failed, 1); assert.equal(d.reason, 'unauthorised');
  assert.equal(d.outcomes[0].status, 401);
  assert.ok(!JSON.stringify([...storage.data.values()]).includes('private upstream'));
  assert.ok(!JSON.stringify(store.snapshot()).includes('private upstream'));
});

await test('an edition the timer reaches hours late is recorded as missed rather than sent at lunch', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + CATCH_UP_MS + 60000;
  await schedule.wake();
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal(store.delivery('2026-09-17:morning').reason, 'missed');
});

await test('a test copy goes to one address only, covers up to now, and never claims the scheduled key', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule({ env: { MUNS_TOKEN: undefined } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  assert.equal((await schedule.sendNow({ edition: 'morning', to: 'me', email: 'nobody' })).reason, 'invalid-email');
  const out = await schedule.sendNow({ edition: 'morning', to: 'me', email: 'Pratik@muns.io' }, 'reader-session-token');
  assert.equal(out.ok, true); assert.equal(out.sent, 1);
  const emails = log.filter((l) => l.kind === 'email');
  assert.equal(emails.length, out.summary.emailParts); assert.ok(emails.every(e => e.to === 'pratik@muns.io'));
  assert.equal(emails[0].auth, 'Bearer reader-session-token', 'the reader\'s own token stands in when the Worker has none');
  assert.ok(emails[0].html.includes('This is a test copy you asked for.'));
  assert.ok(emails[0].html.includes('built on request'));
  assert.ok(emails[0].html.includes('10:30 IST'), 'the on-demand window runs up to now');
  assert.equal(store.delivery('2026-09-17:morning'), null, 'the scheduled key is untouched');
  assert.equal(store.deliveries(1)[0].source, 'test');
});

await test('sending to everyone cools down for five minutes and a second press within it is refused', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  const out = await schedule.sendNow({ edition: 'evening', to: 'all' });
  assert.equal(out.sent, 2);
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  clock += 60000;
  assert.equal((await schedule.sendNow({ edition: 'evening', to: 'all' })).reason, 'cooling-down');
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  assert.equal((await schedule.sendNow({ edition: 'evening', to: 'nobody' })).reason, 'invalid-target');
});

await test('a preview builds the edition up to now without sending, in html or text', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { schedule, log } = makeSchedule();
  const html = await schedule.preview({ edition: 'morning' });
  assert.equal(html.ok, true); assert.ok(html.body.startsWith('<!doctype html>')); assert.match(html.subject, /^Sattva Ventures ·/);
  const text = await schedule.preview({ edition: 'morning', format: 'text' });
  assert.ok(text.body.startsWith('SATTVA VENTURES'));
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal((await schedule.preview({ edition: 'weekly' })).reason, 'invalid-edition');
});

await test('sendEmail sends exactly one body and names every failure without the upstream\'s words', async () => {
  const log = [];
  await assert.rejects(() => sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's', html: '<p>x</p>', text: 'x' }), /exactly one/);
  await assert.rejects(() => sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's' }), /exactly one/);
  assert.deepEqual(await sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's', text: 'plain' }), { ok: true, status: 200, reason: null });
  assert.equal(log.at(-1).text, 'plain'); assert.equal(log.at(-1).html, undefined);
  assert.equal((await sendEmail({ fetcher: makeFetcher({ email: 'down' }), token: 't', email: 'a@muns.io', subject: 's', html: 'x' })).reason, 'upstream');
  assert.equal((await sendEmail({ fetcher: makeFetcher({ email: 'hang' }), token: 't', email: 'a@muns.io', subject: 's', html: 'x' })).reason, 'timeout');
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);
