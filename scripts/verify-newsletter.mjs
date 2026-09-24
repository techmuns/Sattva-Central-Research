#!/usr/bin/env node
// The team brief, tested where it is decided: the pure contract, the durable store, the brief
// builder against fixtures, the broadsheet renderer, and the alarm that sends.
//
// Run with `node scripts/verify-newsletter.mjs`. Needs no server and no egress: the store runs on
// node:sqlite exactly as the concall summary and watchlist stores do, Yahoo and NSE answer from
// captured fixtures, the committed data files stand in for the assets binding, and the email
// endpoint is a stub that records what it was asked to send.

import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS, EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT, REPORTED_RETENTION_MS,
  dayOnlyInstant, editionWindow, istDay, istInstant, istLabel, lateArrivalsFrom, newsletterIntent, newsletterIntents, newsletterSettings,
  nextScheduled, normaliseEmail, normaliseEmailList, previousWeekday, scheduledEditions,
} from '../public/js/data/newsletter-shared.js';
import { renderBriefEmails, emailBytes, EMAIL_HTML_BYTES, acceptedStoryKeys } from '../worker/newsletter-email.mjs';
import { renderBriefPdf, pdfFilename } from '../worker/newsletter-pdf.mjs';
import { handleNewsletter } from '../worker/newsletter.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import {
  CALENDAR_DAYS, MARKET_ROWS, MOVE_PCT, TOPICS, briefStats, briefStories, briefSubject, buildBrief, calendarDayLabel, clusterStories, fmtInrCompact, parseAiNotes, quoteFromChart, renderBriefHtml, renderBriefText, sameStory, storyTokens, topicOf,
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
const fixturePaths = {
  '/data/portfolio-companies.json':'feature-portfolio.json', '/data/corp-announcements.json':'corp-announcements.json',
  '/data/market-news.json':'market-news.json','/data/nse-filings/index.json':'nse-filings-index.json',
  '/data/nse-filings/2026-09-16.json':'nse-filings-2026-09-16.json',
  '/data/tradingview-news/latest.json':'tradingview-news.json','/data/technicals.json':'technicals.json',
};
const asset = path => {
  if (fixturePaths[path]) return fixture(fixturePaths[path]);
  if (path === '/data/announcement-identities.json') return JSON.stringify({ entries:[{ticker:'AARTIDRUGS',bseCode:'524348',isin:'INE767A01016',name:'Aarti Drugs Ltd'}] });
  if (path === '/data/corporate-actions.json') return JSON.stringify({ capturedAt:'2026-09-17T02:00:00Z', rows:[] });
  if (path === '/data/earnings-calendar.json') return JSON.stringify({ capturedAt:'2026-09-17T02:00:00Z', byDate:{} });
  if (path === '/data/insider-archive/index.json') return JSON.stringify({ months:{'2026-09':0} });
  if (path === '/data/insider-archive/2026-09.json') return JSON.stringify({ rows:[] });
  throw new Error(`Fixture not supplied: ${path}`);
};
const assets = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    try { return new Response(asset(path), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('missing', { status: 404 }); }
  },
};
/** The committed files, with named paths replaced by a fixture object (or removed with null), and every path asked for recorded. */
function assetsWith(overrides = {}, requested = []) {
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (path in overrides) {
        return overrides[path] == null ? new Response('missing', { status: 404 }) : new Response(JSON.stringify(overrides[path]), { headers: { 'content-type': 'application/json' } });
      }
      try { return new Response(asset(path), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('missing', { status: 404 }); }
    },
  };
}
/** A ledger stand-in: `keys` are what the desk has been sent, `since` where the ledger's knowledge begins. */
const ledger = (keys = [], since = null) => ({ empty: false, size: keys.length || 1, since, has: (key) => keys.includes(key) });
const CHARTS = { '^GSPC': 'yahoo-sp500.json', '^N225': 'yahoo-nikkei.json', 'BZ=F': 'yahoo-brent.json', 'JPY=X': 'yahoo-usdjpy.json', '^TNX': 'yahoo-us10y.json' };

// 08:00 IST on 17 September 2026, the morning after the captured feeds.
const MORNING = istInstant('2026-09-17', '08:00');
const nseXml = () => {
  const xml = fixture('nse-announcements.xml');
  // A filing by a book company inside the window, so the join is asserted rather than hoped for.
  const item = '<item><title>Aarti Drugs Ltd</title><link>https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071500_test.pdf</link><description>Aarti Drugs Ltd has informed the Exchange regarding Receipt of order from a customer &lt;script&gt;alert(1)&lt;/script&gt; |SUBJECT: Bagging/Receiving of orders/contracts</description><pubDate>17-Sep-2026 07:15:00</pubDate></item>'
    + '<item><title>Aarti Drugs Ltd</title><link>https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071600_test2.pdf</link><description>Aarti Drugs Ltd has informed the Exchange regarding Credit rating downgrade by CRISIL |SUBJECT: Credit Rating</description><pubDate>17-Sep-2026 07:16:00</pubDate></item>';
  return xml.replace('<item>', `${item}<item>`);
};

function makeFetcher({ yahoo = 'ok', nse = 'ok', email = 'ok', log = [] } = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) {
      assert.equal(init.headers?.['user-agent'], 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)');
      const symbol = decodeURIComponent(url.slice('https://query1.finance.yahoo.com/v8/finance/chart/'.length).split('?')[0]);
      log.push({ kind: 'yahoo', symbol });
      if (yahoo === 'down') return new Response('nope', { status: 503 });
      const file = CHARTS[symbol] || 'yahoo-sp500.json';
      const body = JSON.parse(fixture(file));
      const meta = body.chart.result[0].meta;
      meta.symbol = symbol; // Every mock response must identify the requested instrument.
      meta.regularMarketTime = Math.min(meta.regularMarketTime, MORNING / 1000);
      if (MARKET_ROWS.find(r => r.symbol === symbol)?.group === 'india') {
        const r = body.chart.result[0];
        const day = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
        meta.exchangeTimezoneName = 'Asia/Kolkata'; meta.currency = 'INR';
        meta.regularMarketTime = Date.parse(`${day}T15:31:00+05:30`) / 1000;
        r.timestamp = r.timestamp.map(t => Date.parse(`${new Date(t * 1000).toISOString().slice(0, 10)}T09:15:00+05:30`) / 1000);
      }
      return Response.json(body);
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

await test('a pasted list is read as several addresses, and what could not be read is NAMED', () => {
  // The shape a desk actually pastes: a column out of a table, then a mail client's separators.
  const pasted = normaliseEmailList('bharat@example.test\ngaurav@example.test\r\nprateek@example.test ,  ashwini@example.test;ankita@example.test\nYAMINI@example.test\n');
  assert.deepEqual(pasted.emails, ['bharat@example.test', 'gaurav@example.test', 'prateek@example.test', 'ashwini@example.test', 'ankita@example.test', 'yamini@example.test']);
  assert.deepEqual(pasted.invalid, []);
  // A display name is consumed with its brackets — neither refused as a bad address nor left as chaff.
  assert.deepEqual(normaliseEmailList('Bharat Kumar <bharat@example.test>, gaurav@example.test').emails, ['bharat@example.test', 'gaurav@example.test']);
  // One person is one row whatever case they were typed in, and one address twice is still one row.
  assert.deepEqual(normaliseEmailList('a@muns.io, A@MUNS.IO').emails, ['a@muns.io']);
  // The whole point: a token that is not an address is reported verbatim, never quietly dropped.
  assert.deepEqual(normaliseEmailList('a@muns.io, nope, b@muns.io').invalid, ['nope']);
  assert.deepEqual(normaliseEmailList('a@muns.io, nope, b@muns.io').emails, ['a@muns.io', 'b@muns.io']);
  assert.deepEqual(normaliseEmailList('   '), { emails: [], invalid: [] });
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
  const nikkei = quoteFromChart(JSON.parse(fixture('yahoo-nikkei.json')), MARKET_ROWS[3], Date.parse('2026-09-17T06:00:00Z'));
  assert.equal(nikkei.state, 'live', 'Tokyo is trading at 08:00 IST');
  assert.throws(() => quoteFromChart({ chart: { result: [{ meta: {} }] } }, MARKET_ROWS[0], MORNING), /shape/);
});


await test('the desk\'s keyword families fold onto the seven topics, and nothing matched is Other', () => {
  assert.equal(topicOf({ keywordIds: ['order'], keywordGroups: ['growth'] }).id, 'orders');
  assert.equal(topicOf({ keywordIds: ['capex'], keywordGroups: ['growth'] }).id, 'growth');
  assert.equal(topicOf({ keywordIds: ['credit-rating'], keywordGroups: ['risk'] }).id, 'trouble');
  assert.equal(topicOf({ keywordIds: [], keywordGroups: [] }).id, 'other');
  assert.deepEqual(TOPICS.map((t) => t.label), ['Growth', 'Orders', 'Deals', 'Money', 'Approvals & IP', 'Trade policy', 'Trouble', 'Trades', 'Price', 'Other']);
  assert.equal(topicOf({ kind: 'trade', keywordIds: ['order'], keywordGroups: ['growth'] }).id, 'trades', 'a trade is a trade whatever its cells say');
  assert.equal(topicOf({ kind: 'move' }).id, 'price');
});

let morning;
await test('the morning brief builds from the fixtures and every section states its window and sources', async () => {
  const log = [];
  morning = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher({ log }), now: MORNING });
  assert.equal(log.filter((l) => l.kind === 'yahoo').length, MARKET_ROWS.length, 'one chart read per symbol');
  assert.equal(log.filter((l) => l.kind === 'nse').length, 1);
  assert.equal(morning.markets.rows.length, MARKET_ROWS.length);
  assert.deepEqual(morning.markets.failed, []);
  assert.equal(istLabel(morning.window.from), 'Wed 16 Sep, 16:00 IST');
  assert.equal(istLabel(morning.window.to), 'Thu 17 Sep, 08:00 IST');
  assert.equal(morning.book.listed, JSON.parse(asset('/data/portfolio-companies.json')).holdings.length, 'fixture scope is the denominator');
  assert.equal(morning.announcements.nse.ok, true);
  const aarti = morning.announcements.groups.find((g) => g.ticker === 'AARTIDRUGS');
  assert.ok(aarti, 'a filing by a book company inside the window joins');
  assert.equal(aarti.items.length, 2);
  const order = aarti.items.find((i) => /Receipt of order/.test(i.headline));
  assert.ok(order.keywords.includes('Receipt of Order'), 'the exchange\'s own phrase is a tracked keyword');
  assert.equal(order.direction, 'neutral', 'a customer order receipt is not called an award by the filing rule');
  const downgrade = aarti.items.find((i) => /downgrade/.test(i.headline));
  assert.equal(downgrade.direction, 'negative', 'the filing rule reads a downgrade as negative');
  assert.equal(morning.news.source.ok, true);
  assert.ok(morning.news.source.publishers.length >= 1);
  for (const g of morning.news.groups) for (const item of g.items) assert.ok(item.at >= morning.window.from && item.at < morning.window.to);
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
  assert.ok(/Close · \w{3} \d{2} \w{3,4} \d{4} \d{2}:\d{2} \w+/.test(html), 'a closed market prints its close time');
  assert.ok(/Live · \w{3} \d{2} \w{3,4} \d{4} \d{2}:\d{2} \w+/.test(html), 'a trading market prints its last print');
  assert.ok(html.includes('color:#3b82f6;font-weight:bold'), 'the Orders topic colour appears');
  assert.ok(/\b1 watch-out\b/.test(html), 'the downgrade filing is counted as a watch-out on the stats line');
  assert.ok(html.includes('#f43f5e'), 'the watch-out colour appears');
  assert.ok(html.includes('Read →'), 'every story offers Read →');
  assert.ok(!html.includes('<style') && !html.includes('<script'), 'no stylesheet, no script');
  assert.ok(html.length < 200000);
  const subject = briefSubject(morning);
  assert.match(subject, /^Sattva Ventures · \d+ updates? on your portfolio companies — 17 Sep 2026 · Morning$/, subject);
  const text = renderBriefText(morning);
  assert.ok(text.startsWith('SATTVA VENTURES') && text.includes('GLOBAL MARKET SCAN') && text.includes('Aarti Drugs'));
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
  assert.equal(stats.companies[0].ticker, 'AARTIDRUGS', 'the company with a tracked order and a downgrade leads');
  assert.ok(html.indexOf('Your portfolio companies') > 0 && html.indexOf('Your portfolio companies') < html.indexOf('Global market scan'), 'companies before the market scan');
  assert.ok(html.indexOf('Aarti Drugs') < html.indexOf('Global market scan'));
  assert.ok(html.includes(`across <strong style="color:#0f172a;">${stats.companies.length} of ${morning.book.listed}</strong> portfolio companies`), 'the summary counts companies against the book');
  assert.ok(html.includes('https://example.test/#/research/daily-alerts?scope=portfolio&amp;company=AARTIDRUGS'), 'a company links to its own alerts on the dashboard');
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

await test('a refused quote source and a blocked exchange are stated on the page, never drawn as numbers', async () => {
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher({ yahoo: 'down', nse: 'blocked' }), now: istInstant('2026-09-17', '16:00') });
  assert.equal(brief.markets.rows.filter(r => r.last != null).length, 0, 'missing prices stay unavailable');
  assert.ok(brief.markets.failed.includes('taiex'), 'a symbol with no series stays unavailable');
  assert.equal(brief.announcements.nse.ok, false);
  assert.equal(brief.announcements.nse.reason, 'blocked');
  const html = renderBriefHtml(brief);
  assert.ok(html.includes('unavailable'));
  assert.ok(html.includes('NSE live feed could not be read (blocked)'));
  assert.ok(html.includes('NSE history'), 'the retained day files are a source of their own and are named as one');
  const stats = briefStats(brief);
  assert.equal(stats.stories, brief.announcements.count + brief.news.count + brief.trades.count + brief.moves.count, 'every story on the sheet is one the sources counted');
});

await test('with nothing filed or published the sheet says so, and only about what it could read', async () => {
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '02:00') });
  const html = renderBriefHtml(brief);
  if (!briefStats(brief).stories) {
    assert.ok(html.includes('Quiet window — nothing to report.'));
    assert.ok(html.includes('Nothing was filed, published, traded or moved about a portfolio company in this window.'));
  }
  assert.ok(html.includes('SATTVA VENTURES'));
});

// ---- nothing falls between two briefs -------------------------------------------------------------

console.log('\n— coverage —');

const BOOK_ROW = (overrides = {}) => ({
  newsId: 'late-order-1', scripCode: '524348', company: 'Aarti Drugs Ltd', headline: 'Receipt of order from an overseas customer worth Rs 40 crore',
  category: 'Company Update', subCategory: 'Award of Order / Receipt of Order', date: '2026-09-16', time: '15:50:00', url: 'https://www.bseindia.com/xml-data/corpfiling/late-order-1.pdf', ...overrides,
});
const bseWith = (rows) => ({ capturedAt: '2026-09-17T02:20:00.000Z', from: '2026-09-15', to: '2026-09-17', byTicker: { AARTIDRUGS: rows } });
const findStory = (brief, test) => briefStories(brief).find(test) || null;

await test('a filing captured after the previous brief went out reaches the next brief once, marked, and never twice', async () => {
  // 15:50 on the 16th is inside the previous (evening) window; the 08:00 brief on the 17th is the next send.
  const build = (reported) => buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith([BOOK_ROW()]), '/data/nse-filings/index.json': { days: [] } }) }, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING, reported });
  const isLate = (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /overseas customer/.test(s.headline);

  const unknown = await build(null);
  assert.equal(findStory(unknown, isLate), null, 'with no ledger at all nothing outside the window is read: "unknown" is not "not sent"');
  assert.equal(unknown.lateFrom, null);

  const unsent = await build(ledger([]));
  const late = findStory(unsent, isLate);
  assert.ok(late, 'against a ledger that does not hold it, the filing is carried');
  assert.equal(late.late, true);
  assert.equal(late.keys[0], 'bse:late-order-1', 'the ledger key is the exchange\'s own stable id');
  assert.equal(istLabel(unsent.lateFrom), istLabel(lateArrivalsFrom('morning', '2026-09-17', DEFAULT_SETTINGS)), 'the lookback reaches two windows back');
  assert.equal(briefStats(unsent).late, briefStories(unsent).filter((s) => s.late).length);
  assert.ok(briefStats(unsent).late >= 1);
  const html = renderBriefHtml(unsent, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('not in the previous brief'), 'a late arrival says so on its row');
  assert.ok(html.includes(`${briefStats(unsent).late} not in the previous brief`), 'and the summary line counts them');
  assert.ok(/16 Sept, 15:50 IST/.test(html), 'it keeps its own publication time, never the brief\'s');
  assert.ok(unsent.reported.some((r) => r.key === 'bse:late-order-1' && r.publishedAt === istInstant('2026-09-16', '15:50')), 'a send of this brief would put the filing in the ledger');

  const sent = await build(ledger(['bse:late-order-1']));
  assert.equal(findStory(sent, isLate), null, 'once the desk has been sent it, it is not sent again');

  const before = await build(ledger([], istInstant('2026-09-16', '16:00')));
  assert.equal(findStory(before, isLate), null, 'nothing published before the ledger began is judged unsent — an earlier brief carried it');
  assert.equal(before.lateFrom, null, 'a lookback the ledger cannot vouch for collapses to the window');

  const monday = editionWindow('morning', '2026-09-21', DEFAULT_SETTINGS);
  assert.equal(istLabel(lateArrivalsFrom('morning', '2026-09-21', DEFAULT_SETTINGS)), 'Thu 17 Sep, 16:00 IST', 'Monday looks back over Friday\'s two windows');
  assert.ok(lateArrivalsFrom('morning', '2026-09-21', DEFAULT_SETTINGS) < monday.from);
});

await test('a filing inside the window is carried whether or not the ledger holds it, and the ledger never suppresses the window', async () => {
  const row = BOOK_ROW({ newsId: 'in-window-1', date: '2026-09-16', time: '18:10:00', headline: 'Credit rating upgraded by CRISIL' });
  const env = { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith([row]), '/data/nse-filings/index.json': { days: [] } }) };
  for (const reported of [null, ledger([]), ledger(['bse:in-window-1'])]) {
    const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING, reported });
    const story = findStory(brief, (s) => s.kind === 'filing' && /CRISIL/.test(s.headline));
    assert.ok(story, 'the printed window is a promise about what is inside it');
    assert.equal(story.late, false);
    assert.equal(story.mood.id, 'good', 'the filing rule reads an upgrade as positive');
  }
});

await test('NSE\'s retained day files are read for the window, only the days the index holds, and resolved against the book', async () => {
  const requested = [];
  const dayRow = { company: 'Aarti Drugs Ltd', url: 'https://nsearchives.nseindia.com/corporate/AARTIDRUGS_16092026183000_history.pdf', subject: 'Analyst/Investor Meet Para A-XBRL', description: 'Aarti Drugs Ltd has informed the Exchange about Schedule of Analysts or Institutional Investors Meet |SUBJECT: Analyst/Investor Meet Para A-XBRL', publishedAt: '2026-09-16T13:00:00.000Z', symbolHint: 'AARTIDRUGS', ticker: null, resolvedBy: null, observedAt: '2026-09-16T13:30:00.000Z' };
  const env = { ASSETS: assetsWith({
    '/data/nse-filings/index.json': { version: 1, capturedAt: '2026-09-17T02:00:00.000Z', count: 2, days: [{ day: '2026-09-16', count: 1 }, { day: '2026-09-17', count: 1 }] },
    '/data/nse-filings/2026-09-16.json': { day: '2026-09-16', rows: [dayRow] },
    '/data/nse-filings/2026-09-17.json': { day: '2026-09-17', rows: [{ ...dayRow, url: 'https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071500_test.pdf', publishedAt: '2026-09-17T01:45:00.000Z', description: 'Aarti Drugs Ltd has informed the Exchange regarding Receipt of order from a customer |SUBJECT: Bagging/Receiving of orders/contracts', subject: 'Bagging/Receiving of orders/contracts' }] },
    '/data/nse-filings/2026-09-15.json': null,
  }, requested) };
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING });
  assert.equal(brief.announcements.nse.ok, false, 'the live feed is blocked in this run');
  assert.deepEqual(brief.announcements.nseHistory.days, ['2026-09-16', '2026-09-17']);
  assert.ok(!requested.includes('/data/nse-filings/2026-09-15.json'), 'a day the index does not list is never asked for');
  const meet = findStory(brief, (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Investors Meet/.test(s.headline));
  assert.ok(meet, 'a history row with no ticker is resolved by the book\'s own name');
  assert.equal(meet.source, 'NSE');
  assert.equal(istLabel(meet.at), 'Wed 16 Sep, 18:30 IST');
  const order = findStory(brief, (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Receipt of order from a customer/.test(s.headline));
  assert.ok(order, 'the history copy of the live fixture\'s filing is one filing');
  assert.equal(briefStories(brief).filter((s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Receipt of order from a customer/.test(s.headline)).length, 1, 'never two rows for one filing');
  assert.ok(renderBriefHtml(brief).includes('NSE history 2 day files (2026-09-16, 2026-09-17)'), 'the sources line names the day files read');
});

await test('routine filings are counted on the page and not listed, so they cannot crowd out a material one', async () => {
  const rows = [
    BOOK_ROW({ newsId: 'np-1', date: '2026-09-16', time: '18:00:00', subCategory: 'Newspaper Publication', category: 'Company Update', headline: 'Newspaper publication of the unaudited financial results' }),
    BOOK_ROW({ newsId: 'res-1', date: '2026-09-16', time: '18:05:00', subCategory: 'Financial Results', category: 'Result', headline: 'Unaudited financial results for the quarter ended 30 June 2026' }),
  ];
  // BSE only in this run: the NSE index is emptied so the count is the fixture's and nothing else's.
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith(rows), '/data/nse-filings/index.json': { version: 1, capturedAt: '2026-09-17T02:00:00.000Z', count: 0, days: [] } }) }, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING });
  assert.equal(brief.announcements.routineHidden, 1);
  assert.equal(findStory(brief, (s) => /Newspaper publication/.test(s.headline)), null);
  assert.ok(findStory(brief, (s) => /Unaudited financial results/.test(s.headline)), 'the result itself is listed');
  const html = renderBriefHtml(brief);
  assert.ok(html.includes('1 routine filing (newspaper copies'), html.match(/\d+ routine filing[^<]*/)?.[0]);
  assert.ok(!brief.reported.some((r) => r.key === 'bse:np-1'), 'a filing not shown is not marked as sent');
});

await test('trades on a holding come from the insider archive, dated day-only, read with the dashboard\'s own direction and thresholds', async () => {
  const EVENING = istInstant('2026-09-17', '16:00');
  const bseCode = JSON.parse(asset('/data/announcement-identities.json')).entries.find((e) => e.ticker === 'AARTIDRUGS')?.bseCode;
  assert.ok(bseCode, 'the identity file carries the book company\'s BSE code');
  const rows = [
    { ticker: 'AARTIDRUGS', date: '2026-09-17', url: 'https://www.screener.in/trades/insiders/?o=-2', sourceId: 'insiders', cells: { 'Trade Category': 'Insider trade', Company: 'Aarti Drugs', Insider: 'Ramesh Shah', Category: 'Promoter', 'Security Type': 'Equity', Transaction: 'Sold', 'Trade Shares': '50000', 'Trade Value': '2.25 crore', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
    { ticker: String(bseCode), date: '2026-09-17', url: 'https://www.screener.in/trades/sast/?o=-2', sourceId: 'sast', cells: { 'Trade Category': 'SAST', Company: 'Aarti Drugs', Insider: 'Long Only Fund LP', Transaction: 'Acquisition', 'Trade Shares': '2300000', 'Trade %': '2.50', Mode: 'Market', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
    { ticker: 'AARTIDRUGS', date: '2026-09-16', url: 'https://www.screener.in/trades/bulk/?o=-2', sourceId: 'bulk', cells: { 'Trade Category': 'Bulk deal', Company: 'Aarti Drugs', Insider: 'Some Capital LLP', 'Security Type': 'Equity', Transaction: 'Buy', 'Trade Shares': '17000', 'Trade Value': '1.88 crore', Price: '1105', 'Broadcast Date': '2026-09-16', Source: 'Screener.in' } },
    { ticker: 'NOTINBOOK', date: '2026-09-17', sourceId: 'bulk', cells: { 'Trade Category': 'Bulk deal', Company: 'Somebody Else', Insider: 'X', Transaction: 'Buy', 'Trade Shares': '1', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
  ];
  const env = { ASSETS: assetsWith({ '/data/insider-archive/index.json': { version: 1, months: { '2026-09': rows.length }, rowCount: rows.length, updatedAt: '2026-09-17T10:30:00.000Z' }, '/data/insider-archive/2026-09.json': { kind: 'insider', rows } }) };
  const evening = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher(), now: EVENING });
  const trades = briefStories(evening).filter((s) => s.kind === 'trade');
  assert.equal(trades.length, 2, 'the 17th\'s two disclosures; the 16th\'s is the previous day\'s and a stranger\'s is nobody\'s');
  for (const t of trades) {
    assert.equal(t.ticker, 'AARTIDRUGS');
    assert.equal(t.dayOnly, true);
    assert.equal(t.at, dayOnlyInstant('2026-09-17'), 'a day-dated record is filed at its day\'s close');
    assert.equal(t.topic.id, 'trades');
    assert.ok(t.keys[0].startsWith('trade:'), t.keys[0]);
  }
  const sold = trades.find((t) => /Sold/.test(t.headline));
  assert.equal(sold.headline, 'Insider trade: Ramesh Shah — Sold');
  assert.equal(sold.mood.id, 'watch', 'a disposal reads as a watch-out from its own transaction word');
  assert.equal(sold.importance, 'low', '₹2.25 crore is under the ₹10 crore bar');
  const sast = trades.find((t) => /SAST/.test(t.headline));
  assert.equal(sast.mood.id, 'good');
  assert.equal(sast.importance, 'high', '2.5% of the company is over the 1% bar');
  assert.ok(sast.score > sold.score, 'the material one leads');
  assert.ok(/2\.50% of the company/.test(sast.dek), sast.dek);
  const html = renderBriefHtml(evening);
  assert.ok(html.includes('17 Sept, day only'), 'no clock is invented for a broadcast day');
  assert.ok(html.includes('trades (bulk, block, SAST, insider) captured Thu 17 Sep, 16:00 IST, dated by broadcast day'));
  // The 16th's bulk deal belongs to the 16th's evening brief; captured late, it reaches the next one through the ledger.
  const morning = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher(), now: MORNING, reported: ledger([]) });
  const bulk = findStory(morning, (s) => s.kind === 'trade' && /Bulk deal/.test(s.headline));
  assert.ok(bulk && bulk.late, 'the bulk deal of the 16th is carried as not in the previous brief');
  const real = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(real.trades.source.ok, true, 'the committed archive reads');
  assert.ok(real.trades.source.months.includes('2026-09'));
});

await test('price moves: the evening brief reads the closing quotes, the morning the completed bars, at the dashboard\'s own ±5% bar', async () => {
  const EVENING = istInstant('2026-09-17', '16:00');
  const quote = (ticker, price, prevClose, sessionDate = '2026-09-17', time = '15:47') => ({ ticker, price, prevClose, quoteAt: new Date(istInstant(sessionDate, time)).toISOString(), checkedAt: new Date(istInstant(sessionDate, time) + 60000).toISOString(), sessionDate, provider: 'Yahoo Finance' });
  const capture = { getByName: (name) => { assert.equal(name, 'breakout-capture:v1'); return { breakoutRead: async () => ({ state: 'complete', rows: [
    quote('AARTIDRUGS', 1070, 1000), quote('PURVA', 210, 218), quote('NOTINBOOK', 109, 100), quote('ABCAPITAL', 300, 200, '2026-09-16'), quote('SBIN', 950, 900, '2026-09-17', '11:00'),
  ] }) }; } };
  assert.equal(MOVE_PCT, 5);
  const evening = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets, CAPTURE_REGISTRY: capture }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(evening.moves.state, 'capture');
  assert.equal(evening.moves.session, '2026-09-17');
  const moves = briefStories(evening).filter((s) => s.kind === 'move');
  assert.equal(moves.length, 1, '+7% is a move; −3.7% is not; a stranger, yesterday\'s quote and a mid-morning print are not');
  assert.equal(moves[0].ticker, 'AARTIDRUGS');
  assert.equal(moves[0].headline, 'Up 7.0% on the day at ₹1,070.00');
  assert.equal(moves[0].mood.id, 'good');
  assert.deepEqual(moves[0].keys, ['move:AARTIDRUGS|2026-09-17']);
  assert.equal(moves[0].topic.id, 'price');
  const html = renderBriefHtml(evening);
  assert.ok(html.includes('Previous close ₹1,000.00 · last print 15:47 IST'));
  assert.ok(html.includes('prices from the closing quotes captured Thu 17 Sep, 15:47 IST for the 2026-09-17 session'));

  // No capture, and daily bars that end the previous session — the state an evening brief is in when
  // the collector did not run. (The committed file already carries the 17th, so it is aged here.)
  const behind = { ...JSON.parse(asset('/data/technicals.json')), price_date: '2026-09-16' };
  const none = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/technicals.json': behind }) }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(none.moves.state, 'unavailable');
  assert.equal(none.moves.count, 0);
  assert.ok(renderBriefHtml(none).includes('price moves unavailable (capture-unavailable; daily-behind; daily bars end 2026-09-16)'), 'an unread price feed is named, never drawn as no moves');

  // The next morning: the completed daily bars carry the same session, keyed the same way, so a move the
  // evening brief sent is not sent again — and one it could not send is.
  const daily = JSON.parse(asset('/data/technicals.json'));
  const nextMorning = istInstant(daily.price_date, '08:00') + 86400000;
  const morning = await buildBrief({ edition: 'morning', day: istDay(nextMorning), settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: nextMorning, reported: ledger([], istInstant(daily.price_date, '08:00')) });
  assert.equal(morning.moves.state, 'daily');
  assert.equal(morning.moves.session, daily.price_date);
  const book = new Set(JSON.parse(asset('/data/portfolio-companies.json')).holdings.map((h) => h.ticker).filter(Boolean));
  // The file's list is `companies` (the resolver reads `rows || companies` too), and a row with no bar
  // date belongs to the file's own session, the fallback General Alerts make.
  const expected = (daily.rows || daily.companies || []).filter((r) => book.has(r.ticker) && (r.bar_date || daily.price_date) === daily.price_date && Math.abs(Number(r.pct_change_today)) >= MOVE_PCT).length;
  const dailyMoves = briefStories(morning).filter((s) => s.kind === 'move');
  assert.equal(dailyMoves.length, Math.min(expected, 30), 'every holding past the bar, and nothing under it');
  for (const m of dailyMoves) { assert.ok(Math.abs(m.pct) >= MOVE_PCT); assert.equal(m.late, true, 'a close before the window opened is a late arrival'); }
  const alreadySent = await buildBrief({ edition: 'morning', day: istDay(nextMorning), settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: nextMorning, reported: ledger(dailyMoves.map((m) => m.keys[0]), istInstant(daily.price_date, '08:00')) });
  assert.equal(briefStories(alreadySent).filter((s) => s.kind === 'move').length, 0, 'what the evening brief sent is not sent again');
});

await test('TradingView\'s symbol-tagged headlines join only under the dashboard\'s name match or as a story tagged with this company alone', async () => {
  const feed = JSON.parse(asset('/data/tradingview-news/latest.json'));
  const tv = (title, relatedSymbols, publishedAt = '2026-09-16T14:00:00.000Z') => ({ title, source: 'Reuters', url: `https://in.tradingview.com/news/${encodeURIComponent(title)}/`, publishedAt, date: publishedAt.slice(0, 10), tradingViewId: `t:${title}`, relatedSymbols, sourceSymbol: 'NSE:AARTIDRUGS', ticker: 'AARTIDRUGS' });
  const latest = { ...feed, entities:[{ticker:'AARTIDRUGS',entityId:'AARTIDRUGS',company:'Aarti Drugs Ltd',name:'Aarti Drugs Ltd'}], byTicker: { AARTIDRUGS: [
    tv('Aarti Drugs wins USFDA approval for Tarapur unit', ['NSE:AARTIDRUGS', 'BSE:AARTIDRUGS', 'NSE:NIFTY', 'NSE:SUNPHARMA']),
    tv('Pharma stocks rally as rupee slides', ['NSE:AARTIDRUGS', 'NSE:SUNPHARMA', 'NSE:CIPLA', 'NSE:DRREDDY']),
    tv('Board approves capex for new API block', ['NSE:AARTIDRUGS']),
  ] } };
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/tradingview-news/latest.json': latest }) }, fetcher: makeFetcher(), now: MORNING });
  const titles = briefStories(brief).filter((s) => s.kind === 'news' && s.ticker === 'AARTIDRUGS' && /via TradingView/.test(s.source)).map((s) => s.headline);
  assert.ok(titles.includes('Aarti Drugs wins USFDA approval for Tarapur unit'), 'named in the headline');
  assert.ok(!titles.includes('Board approves capex for new API block'), 'a symbol tag alone does not establish company attribution');
  assert.ok(!titles.includes('Pharma stocks rally as rupee slides'), 'a sector story tagged with four companies is not this company\'s news');
  assert.equal(brief.news.tradingview.tagged, 3);
  assert.equal(brief.news.tradingview.matched, 1);
  const story = briefStories(brief).find((s) => s.headline === 'Aarti Drugs wins USFDA approval for Tarapur unit');
  assert.equal(story.mood.id, 'neutral', 'a headline carries no sentiment reading');
  assert.equal(story.source, 'Reuters · via TradingView');
  assert.ok(story.keys[0].startsWith('tv:AARTIDRUGS|'));
});

// ---- the week ahead ----------------------------------------------------------------------------------

console.log('\n— the week ahead —');

const upcoming = (overrides) => ({
  id: 'x', companyKey: 'AARTIDRUGS', ticker: 'AARTIDRUGS', name: 'Aarti Drugs Ltd', date: '2026-09-17', time: null, eventType: 'Result',
  companyUrl: 'https://www.screener.in/company/AARTIDRUGS/consolidated/', sourceUrl: 'https://www.screener.in/company/AARTIDRUGS/consolidated/#documents', observedAt: '2026-09-17T01:00:00.000Z', ...overrides,
});
const screenerStub = (rows, checkedAt = '2026-09-17T01:30:00.000Z') => async () => ({ capture: { checkedAt, portfolioUpcoming: rows }, source: { status: 'ok', checkedAt, portfolioUpcomingAvailable: true } });
const mcRow = (ticker, name, extra = {}) => ({ scId: `${ticker}-mc`, name, ticker, resultDate: '2026-09-17', time: null, mcUrl: `https://www.moneycontrol.com/india/stockpricequote/x/${ticker.toLowerCase()}/${ticker}`, ...extra });
const mcSnapshot = { capturedAt: '2026-09-17T01:45:00.000Z', from: '2026-09-14', to: '2026-10-08', pageSize: 20, days: [], byDate: {
  '2026-09-17': { rows: [mcRow('AARTIDRUGS', 'Aarti Drugs')], complete: true },
  '2026-09-18': { rows: [mcRow('SBIN', 'State Bank of India', { resultDate: '2026-09-18', time: '11:30 AM' }), mcRow('NOTINBOOK', 'Somebody Else', { resultDate: '2026-09-18' })], complete: true },
  '2026-09-26': { rows: [mcRow('ABCAPITAL', 'Aditya Birla Capital', { resultDate: '2026-09-26' })], complete: true },
} };

await test('the calendar names the holdings\' scheduled results, calls and meetings for the week, once each however many sources name them', async () => {
  const screener = screenerStub([
    upcoming({ id: 'a' }),
    upcoming({ id: 'b', date: '2026-09-19', time: '10:30', eventType: 'Con-call' }),
    upcoming({ id: 'c', ticker: 'SBIN', companyKey: 'SBIN', name: 'State Bank of India', date: '2026-09-30', eventType: 'AGM' }),
    upcoming({ id: 'd', ticker: 'NOTINBOOK', companyKey: 'NOTINBOOK', name: 'Somebody Else', date: '2026-09-18' }),
    upcoming({ id: 'e', ticker: null, companyKey: 'AD2', date: '2026-09-22', eventType: 'AGM' }),
  ]);
  const env = { ASSETS: assetsWith({ '/data/earnings-calendar.json': mcSnapshot }) };
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher(), now: MORNING, screener });
  const c = brief.calendar;
  assert.equal(CALENDAR_DAYS, 7);
  assert.deepEqual([c.from, c.to], ['2026-09-17', '2026-09-24'], 'the brief\'s own day and the seven after it');
  assert.equal(c.screener.ok, true);
  assert.equal(c.moneycontrol.ok, true);
  assert.deepEqual(c.rows.map((r) => [r.date, r.ticker, r.label, r.time, r.sources.join('+')]), [
    ['2026-09-17', 'AARTIDRUGS', 'Result', null, 'Screener+Moneycontrol'],
    ['2026-09-18', 'SBIN', 'Result', '11:30', 'Moneycontrol'],
    ['2026-09-19', 'AARTIDRUGS', 'Con-call', '10:30', 'Screener'],
    ['2026-09-22', 'AARTIDRUGS', 'AGM', null, 'Screener'],
  ], 'one row per event, by date; the AGM outside the week and the stranger are not here; a row with no ticker resolves by the book\'s name');
  assert.equal(c.count, 4);
  assert.equal(calendarDayLabel('2026-09-17', '2026-09-17'), 'Today · Thu 17 Sep');
  assert.equal(calendarDayLabel('2026-09-18', '2026-09-17'), 'Tomorrow · Fri 18 Sep');
  assert.equal(calendarDayLabel('2026-09-22', '2026-09-17'), 'Tue 22 Sep');
  const html = renderBriefHtml(brief, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('On the calendar'));
  assert.ok(html.includes('Today · Thu 17 Sep') && html.includes('Tomorrow · Fri 18 Sep'));
  assert.ok(html.includes('Con-call · 10:30 IST'), 'a call carries its clock');
  assert.ok(html.includes('Screener · Moneycontrol'), 'both sources named on the row both carry');
  assert.ok(html.includes('Screener portfolio calendar checked Thu 17 Sep, 07:00 IST'), 'the sources line dates the calendar');
  assert.ok(html.includes('Moneycontrol results calendar captured Thu 17 Sep, 07:15 IST'));
  const text = renderBriefText(brief);
  assert.ok(text.includes('ON THE CALENDAR · Thu 17 Sep → Thu 24 Sep'));
  assert.ok(text.indexOf('ON THE CALENDAR') < text.indexOf('GLOBAL MARKET SCAN'), 'the week ahead sits before the market scan');
  assert.ok(!brief.reported.some((r) => r.key.startsWith('cal:')), 'a calendar row is not news and never enters the ledger');
});

await test('a calendar that could not be read is named, and the other calendar still carries', async () => {
  const noToken = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/earnings-calendar.json': mcSnapshot }) }, fetcher: makeFetcher(), now: MORNING });
  assert.equal(noToken.calendar.screener.reason, 'no-token', 'without the Worker\'s GitHub token the artifact is not asked for');
  assert.deepEqual(noToken.calendar.rows.map((r) => r.ticker), ['AARTIDRUGS', 'SBIN'], 'Moneycontrol\'s results still carry');
  assert.ok(renderBriefHtml(noToken).includes('Screener portfolio calendar unavailable (no-token)'));
  const broken = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/earnings-calendar.json': null }) }, fetcher: makeFetcher(), now: MORNING, screener: async () => { throw new Error('No successful Screener concall capture is available'); } });
  assert.equal(broken.calendar.screener.ok, false);
  assert.equal(broken.calendar.moneycontrol.ok, false);
  assert.equal(broken.calendar.count, 0);
  const html = renderBriefHtml(broken);
  assert.ok(html.includes('Neither calendar could be read, so the week ahead is not known — not empty.'));
  assert.ok(html.includes('Moneycontrol results calendar unavailable'));
  const quiet = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/earnings-calendar.json': { ...mcSnapshot, byDate: {} } }) }, fetcher: makeFetcher(), now: MORNING, screener: screenerStub([]) });
  assert.ok(renderBriefHtml(quiet).includes('No result, con-call or meeting is scheduled on a portfolio company in the next seven days'), 'an empty week from readable calendars says so');
});

await test('corporate action dates on the holdings for the week ahead, in the source\'s own words, debt instruments aside', async () => {
  const isin = JSON.parse(asset('/data/portfolio-companies.json')).holdings.find((h) => h.ticker === 'ABCAPITAL')?.isin;
  assert.ok(isin, 'the book carries the ISIN this test matches on');
  const action = (overrides) => ({ id: `t:${Math.random()}`, ticker: 'AARTIDRUGS', company: 'Aarti Drugs', isin: null, purpose: 'Dividend · Final · 100.00%', actionType: 'dividend', exDate: null, recordDate: null, bookClosureStart: null, source: 'Screener', sources: ['Screener'], sourceUrl: 'https://www.screener.in/actions/dividend/', screenerCompanyUrl: 'https://www.screener.in/company/AARTIDRUGS/consolidated/', ...overrides });
  const rows = [
    action({ id: 'div-1', exDate: '2026-09-19', recordDate: '2026-09-20' }),
    action({ id: 'bonus-1', ticker: null, isin, company: 'Aditya Birla Capital', purpose: 'Bonus 1:1', actionType: 'bonus', recordDate: '2026-09-23', source: 'NSE', sources: ['NSE', 'Screener'] }),
    action({ id: 'split-1', ticker: 'SBIN', company: 'State Bank of India', purpose: 'Stock split', actionType: 'split', exDate: '2026-10-10' }),
    action({ id: 'stranger-1', ticker: 'NOTINBOOK', company: 'Somebody Else', exDate: '2026-09-18' }),
    action({ id: 'int-1', purpose: 'Interest payment', actionType: 'interest', exDate: '2026-09-18' }),
    action({ id: 'bc-1', ticker: 'SBIN', company: 'State Bank of India', purpose: 'Dividend - Rs 15 Per Share', actionType: 'dividend', bookClosureStart: '2026-09-21', bookClosureEnd: '2026-09-23', source: 'NSE', sources: ['NSE'] }),
  ];
  const overlay = { version: 1, capturedAt: '2026-09-17T02:00:00.000Z', rowCount: rows.length, rows };
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corporate-actions.json': overlay }) }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '16:00') });
  const x = brief.actions;
  assert.equal(x.source.ok, true);
  assert.deepEqual([x.from, x.to], ['2026-09-17', '2026-09-24']);
  assert.deepEqual(x.rows.map((r) => [r.on, r.ticker, r.purpose, r.dates.map((d) => `${d.label} ${d.date}`).join(' · '), r.source]), [
    ['2026-09-19', 'AARTIDRUGS', 'Dividend · Final · 100.00%', 'Ex-date 2026-09-19 · Record date 2026-09-20', 'Screener'],
    ['2026-09-21', 'SBIN', 'Dividend - Rs 15 Per Share', 'Book closure 2026-09-21', 'NSE'],
    ['2026-09-23', 'ABCAPITAL', 'Bonus 1:1', 'Record date 2026-09-23', 'NSE · Screener'],
  ], 'by date; the split outside the week and the stranger are not here; an ISIN-only line matches the book; the interest date is counted, not listed');
  assert.equal(x.source.debtSkipped, 1);
  assert.deepEqual(x.rows.map((r) => r.key), ['action:div-1', 'action:bc-1', 'action:bonus-1']);
  const html = renderBriefHtml(brief, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('Corporate actions'));
  assert.ok(html.includes('Ex-date Sat 19 Sep · Record date Sun 20 Sep'));
  assert.ok(html.includes('Bonus 1:1'));
  assert.ok(html.includes('1 interest or redemption date on an issuer&#39;s debt instruments is not listed'));
  assert.ok(html.includes('corporate actions captured Thu 17 Sep, 07:30 IST'));
  const text = renderBriefText(brief);
  assert.ok(text.includes('CORPORATE ACTIONS · Thu 17 Sep → Thu 24 Sep'));
  assert.ok(text.includes('Ex-date Sat 19 Sep · Record date Sun 20 Sep · Aarti Drugs Ltd (AARTIDRUGS) · Dividend · Final · 100.00% · Screener'));
  assert.ok(!brief.reported.some((r) => r.key.startsWith('action:')), 'a date is not news and never enters the ledger');
  const none = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corporate-actions.json': { ...overlay, rows: [rows[3]], rowCount: 1 } }) }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '16:00') });
  assert.ok(renderBriefHtml(none).includes('No ex-date, record date or book closure falls on a portfolio company in the next seven days'));
  const unread = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corporate-actions.json': null }) }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '16:00') });
  assert.equal(unread.actions.source.ok, false);
  assert.ok(renderBriefHtml(unread).includes('The corporate-actions capture could not be read, so the week ahead is not known — not empty.'));
  const real = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '16:00') });
  assert.equal(real.actions.source.ok, true, 'the committed capture reads');
  for (const r of real.actions.rows) assert.ok(r.on >= '2026-09-17' && r.on <= '2026-09-24' && r.dates.length >= 1);
});

// ---- the ledger ----------------------------------------------------------------------------------------

// ---- one update, not four copies of it -------------------------------------------------------------

console.log('\n— one update, not four copies of it —');

const EVENING_17 = istInstant('2026-09-17', '16:00');
/** Puravankara's 17 September: one press release on both exchanges, one investor-meet intimation on both, three publisher accounts of the project and one share-price story. */
const purvaAssets = (extra = {}) => assetsWith({
  '/data/corp-announcements.json': { capturedAt: '2026-09-17T10:30:00.000Z', from: '2026-09-15', to: '2026-09-17', byTicker: { PURVA: [
    { newsId: 'purva-pr-1', scripCode: '532891', company: 'Puravankara Ltd', headline: 'Press Release titled "Puravankara Secures Rs. 2600 Crore redevelopment project in Goregaon West, Mumbai"', category: 'Company Update', subCategory: 'Press Release / Media Release', date: '2026-09-17', time: '14:12:04', url: 'https://www.bseindia.com/xml-data/corpfiling/purva-pr-1.pdf' },
    { newsId: 'purva-meet-1', scripCode: '532891', company: 'Puravankara Ltd', headline: 'Intimation of schedule of Investor Conference', category: 'Company Update', subCategory: 'Analyst / Investor Meet - Intimation', date: '2026-09-17', time: '11:20:00', url: 'https://www.bseindia.com/xml-data/corpfiling/purva-meet-1.pdf' },
  ] } },
  '/data/nse-filings/index.json': { version: 1, capturedAt: '2026-09-17T10:00:00.000Z', count: 2, days: [{ day: '2026-09-17', count: 2 }] },
  '/data/nse-filings/2026-09-17.json': { day: '2026-09-17', rows: [
    { company: 'Puravankara Limited', symbolHint: 'PURVA', ticker: 'PURVA', resolvedBy: 'name', observedAt: '2026-09-17T09:00:00.000Z', url: 'https://nsearchives.nseindia.com/corporate/PURVA_17092026141319_SEintimation.pdf', subject: 'Press Release', description: 'Puravankara Limited has informed the Exchange regarding a press release dated September 17, 2026, titled "Puravankara secures Rs 2,600 crore redevelopment project in Goregaon West, Mumbai". |SUBJECT: Press Release', publishedAt: '2026-09-17T08:43:33.000Z' },
    { company: 'Puravankara Limited', symbolHint: 'PURVA', ticker: 'PURVA', resolvedBy: 'name', observedAt: '2026-09-17T09:00:00.000Z', url: 'https://nsearchives.nseindia.com/corporate/PURVA_17092026112200_meet.xml', subject: 'Analyst/Investor Meet Para A-XBRL', description: 'Puravankara Limited has informed the Exchange about Schedule of Analysts or Institutional Investors Meet |SUBJECT: Analyst/Investor Meet Para A-XBRL', publishedAt: '2026-09-17T05:52:00.000Z' },
  ] },
  '/data/market-news.json': { ...JSON.parse(asset('/data/market-news.json')), capturedAt: '2026-09-17T10:35:00.000Z', articles: [
    ['bs-1', 'Puravankara secures redevelopment project in Goregaon West worth Rs 2,600 crore', '2026-09-17T08:50:00.000Z', 'Business Standard'],
    ['et-1', 'Puravankara Ltd eyes Rs 2,600 cr revenue from redevelopment of 3 housing societies in Mumbai', '2026-09-17T09:10:00.000Z', 'Economic Times'],
    ['bs-2', 'Puravankara secures 4.68-acre redevelopment project in Goregaon West, Mumbai', '2026-09-17T09:40:00.000Z', 'Business Standard'],
    ['mint-1', 'Puravankara shares jump 4%, extend rally to second day. Why is the realty stock rebounding?', '2026-09-17T09:55:00.000Z', 'Mint'],
  ].map(([id, title, publishedAt, publisher]) => ({ id, url: `https://example.test/${id}`, title, summary: '', publishedAt, publisher, source: publisher })) },
  '/data/tradingview-news/latest.json': { byTicker: {} },
  ...extra,
});

await test('unread exchange filings stay conservative while specific publisher accounts retain their links', async () => {
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: purvaAssets() }, fetcher: makeFetcher({ nse: 'blocked' }), now: EVENING_17 });
  const purva = briefStats(brief).companies.find((c) => c.ticker === 'PURVA');
  assert.ok(purva);
  assert.equal(purva.stories.length, 8, 'two exchange copies of two filings and four stories are eight items');
  assert.equal(purva.clusters.length, 5, 'unread generic meetings and an unconfirmed additional account stay separate');
  const project = purva.clusters.find((k) => k.main.source === 'BSE' && /2600|2,600/.test(k.main.headline));
  assert.equal(project.main.kind, 'filing', 'the exchange\'s own statement leads a publisher\'s account of it');
  assert.equal(project.main.source, 'BSE', 'the source filing leads its specific related accounts');
  assert.equal(project.others.length, 2, 'only reports matching every existing member are related');
  assert.deepEqual(project.others.map((r) => r.source).sort(), ['Business Standard', 'Economic Times']);
  assert.deepEqual(project.others.map((r) => r.at), [...project.others.map((r) => r.at)].sort((a, b) => a - b), 'related items read in time order');
  const meet = purva.clusters.find((k) => /Investor/.test(k.main.headline));
  assert.equal(meet.others.length, 0, 'unread generic investor-meet filings cannot establish the same event');
  const move = purva.clusters.find((k) => /shares jump/.test(k.main.headline));
  assert.equal(move.others.length, 0, 'a story about the share price is not the project story');
  assert.equal(purva.clusters.map((k) => k.id).join(' '), 'PURVA#1 PURVA#2 PURVA#3 PURVA#4 PURVA#5', 'an update\'s id is its place under its company');
  const stats = briefStats(brief);
  assert.equal(stats.updates, stats.companies.reduce((n, c) => n + c.clusters.length, 0));
  assert.ok(stats.updates < stats.stories, 'the summary counts updates, not copies');
  const html = renderBriefHtml(brief, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('5 updates from 8 source items'), 'the company header says how many items the updates fold');
  assert.ok(html.includes(`<strong style="color:#0f172a;">${stats.updates} updates</strong>`), 'the summary line counts updates');
  assert.match(briefSubject(brief), new RegExp(`^Sattva Ventures · ${stats.updates} updates on your`));
  assert.ok(html.includes('Related coverage'), 'the copies travel as related links');
  assert.ok(html.includes('Economic Times · 17 Sept, 14:40 IST · Puravankara Ltd eyes Rs 2,600 cr revenue'), 'a related story keeps its source, time and headline');
  assert.ok(html.includes('https://example.test/et-1'), 'and its link');
  assert.equal((html.match(/Puravankara secures 4\.68-acre/g) || []).length, 1, 'each item is on the page once');
  assert.ok(brief.reported.some((r) => r.key === 'bse:purva-pr-1') && brief.reported.some((r) => r.key.startsWith('nse:')) && brief.reported.some((r) => r.key === 'news:PURVA|https://example.test/et-1'), 'every folded item still reaches the ledger under its own identity');
  const text = renderBriefText(brief);
  assert.ok(text.includes('Puravankara Limited (PURVA) · 5 updates from 8 items'));
  assert.ok(text.includes('NSE · 17 Sept, 14:13 IST'), 'the separate exchange filing remains visible');
});

const MOODS_STUB = { watch: { id: 'watch' } };
await test('the story matcher: shared words or a shared figure, never the company\'s own name, never a year', () => {
  const a = storyTokens('Puravankara Secures Rs. 2600 Crore redevelopment project in Goregaon West, Mumbai', 'Puravankara Limited');
  assert.ok(a.has('2600') && a.has('redevelopment') && a.has('goregaon'));
  assert.ok(!a.has('puravankara') && !a.has('crore') && !a.has('rs'), 'the company\'s name and the currency words identify nothing');
  const b = storyTokens('Puravankara Ltd eyes Rs 2,600 cr revenue from redevelopment of 3 housing societies in Mumbai', 'Puravankara Limited');
  assert.ok(b.has('2600'), 'a figure with Indian grouping is one figure');
  assert.ok(sameStory(a, b), 'a shared figure and two shared words are one story');
  const c = storyTokens('Puravankara shares jump 4%, extend rally to second day', 'Puravankara Limited');
  assert.ok(!sameStory(a, c));
  assert.ok(!storyTokens('Board meeting on September 17, 2026 to consider results', '').has('2026'), 'a year is a date, not a figure');
  const clusters = clusterStories([
    { kind: 'trade', headline: 'Block deal: Somebody — Sell', at: 1, score: 1, mood: MOODS_STUB.watch, topic: {} },
    { kind: 'trade', headline: 'Block deal: Somebody — Sell', at: 2, score: 1, mood: MOODS_STUB.watch, topic: {} },
  ], { company: 'X' });
  assert.equal(clusters.length, 2, 'two trades are two updates even when worded alike — each is its own measurement');
});

await test('the AI notes: one bounded request per brief, JSON in and out, each note under its own update — and none without a key, from a refusal or from an unreadable reply', async () => {
  const key = { CLAUDE_KEY: 'ABSKtestkey12345' };
  const bedrock = 'https://bedrock-runtime.ap-south-1.amazonaws.com/anthropic/v1/messages';
  const aiFetcher = (reply, calls) => async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith('https://bedrock-runtime.')) return makeFetcher({ nse: 'blocked' })(input, init);
    const body = JSON.parse(init.body);
    if (JSON.parse(body.messages[0].content).REPORTS) return new Response('duplicate check unavailable in the notes-only fixture', { status: 503 });
    calls.push({ url, init, body });
    if (reply === 'refused') return Response.json({ message: 'private upstream text' }, { status: 403 });
    if (reply === 'garbled') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry — {not json' }] });
    const items = JSON.parse(body.messages[0].content).ITEMS;
    const notes = items.map((i) => ({ id: i.id, summary: `What: ${i.headline.slice(0, 30)}`, impact: 'Could add to revenue; the size is stated in the filing.' }));
    if (reply === 'partial') notes.pop();
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: `Here is the JSON you asked for:\n${JSON.stringify([...notes, { id: 'NOT#1', summary: 'stray', impact: 'stray' }])}` }] });
  };
  const contentService = { enqueue() {}, async process() {}, get(id) { return { state: 'ready', sourceUrl: 'https://www.bseindia.com/fixture.pdf', facts: [{ field: 'source', value: 'Fixture source detail', quote: 'Fixture source detail', location: 'page 1' }] }; } };
  const build = (reply, env = key) => { const calls = []; return buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: purvaAssets(), ...env }, fetcher: aiFetcher(reply, calls), now: EVENING_17, contentService }).then((brief) => ({ brief, calls })); };

  const { brief, calls } = await build('ok');
  assert.equal(calls.length, 1, 'one request per brief');
  assert.equal(calls[0].url, bedrock);
  assert.equal(calls[0].init.headers['x-api-key'], 'ABSKtestkey12345');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.stream, undefined, 'a plain reply, not a stream');
  assert.equal(calls[0].body.model, 'global.anthropic.claude-sonnet-5');
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.ok(calls[0].body.system[0].text.toLowerCase().includes('never add a figure'), 'the instructions forbid new facts');
  const asked = JSON.parse(calls[0].body.messages[0].content).ITEMS;
  const stats = briefStats(brief);
  const storyUpdates = stats.companies.flatMap((c) => c.clusters.filter((k) => k.kind === 'story'));
  assert.equal(asked.length, storyUpdates.length, 'every filing or story update is asked about; a trade or a price move is not');
  assert.ok(asked.every((i) => storyUpdates.some((k) => k.id === i.id)));
  const project = asked.find((i) => /2600|2,600/.test(i.headline));
  assert.ok(project.related.length >= 1, 'related source headlines travel with the leading item');
  assert.equal(project.kind, 'exchange filing');
  assert.ok(asked.every(i => i.SOURCE_EVIDENCE.some(s => s.facts.length && s.url)), 'the writer receives source facts, passages and links');
  assert.equal(brief.ai.ok, true);
  assert.equal(brief.ai.requested, asked.length);
  assert.equal(brief.ai.answered, asked.length);
  assert.ok(!brief.ai.items['NOT#1'], 'a note for an update nobody asked about is dropped');
  const html = renderBriefHtml(brief);
  assert.ok(html.includes('AI SUMMARY') && html.includes('POTENTIAL IMPACT · AI'), 'the notes are marked AI on their face');
  assert.ok(html.includes('What: Press Release titled &quot;Purav'), 'a note is escaped like any other text');
  assert.ok(html.includes(`AI notes by global.anthropic.claude-sonnet-5 on ${asked.length} of ${asked.length} updates, written Thu 17 Sep, 16:00 IST`), 'the sources line names the model and the count');
  assert.ok(html.includes('AI summaries use extracted source-document or article facts'), 'the footer says what the notes are');
  const text = renderBriefText(brief);
  assert.ok(text.includes('    AI summary: What: ') && text.includes('    Potential impact: Could add to revenue'));

  const noKey = await build('ok', {});
  assert.equal(noKey.calls.length, 0, 'nothing is asked without a key');
  assert.equal(noKey.brief.ai.ok, false);
  assert.equal(noKey.brief.ai.reason, 'no-key');
  assert.ok(renderBriefHtml(noKey.brief).includes('AI notes unavailable (no-key)'));
  assert.ok(!renderBriefHtml(noKey.brief).includes('AI summary'), 'no note is invented without the model');
  assert.ok(renderBriefHtml(noKey.brief).includes('BSE filing · Press Release'), 'the item keeps the source\'s own line instead');

  const refused = await build('refused');
  assert.equal(refused.brief.ai.reason, 'refused');
  assert.equal(refused.brief.ai.status, 403);
  assert.ok(!renderBriefHtml(refused.brief).includes('private upstream text'), 'the upstream\'s words never reach the page');
  assert.ok(renderBriefHtml(refused.brief).includes('AI notes unavailable (refused)'));

  const garbled = await build('garbled');
  assert.equal(garbled.brief.ai.reason, 'unreadable');
  assert.ok(!renderBriefHtml(garbled.brief).includes('AI summary'));

  const partial = await build('partial');
  assert.equal(partial.brief.ai.ok, true);
  assert.equal(partial.brief.ai.answered, asked.length - 1, 'an update the model skipped has no note and keeps its own line');
  assert.ok(renderBriefHtml(partial.brief).includes(`on ${asked.length - 1} of ${asked.length} updates`));

  assert.deepEqual(parseAiNotes('```json\n[{"id":"A#1","summary":"s","impact":"i"},{"id":"A#1","summary":"dup","impact":"dup"},{"id":"A#2","summary":"","impact":"i"}]\n```', new Set(['A#1', 'A#2'])), { 'A#1': { summary: 's', impact: 'i' } }, 'fenced JSON is read, a duplicate id keeps the first, a note missing a line is dropped');
  assert.equal(parseAiNotes('no json here', new Set(['A#1'])), null);
  assert.equal(parseAiNotes('{"id":"A#1"}', new Set(['A#1'])), null, 'an object is not the array asked for');
  assert.deepEqual(parseAiNotes(`[{"id":"A#1","summary":"${'x'.repeat(800)}","impact":"i"}]`, new Set(['A#1'])), {}, 'an oversized note is rejected without dropping its conditions');
});

// ---- the portfolio on the session, and the Indian indices ------------------------------------------

console.log('\n— the portfolio on the session —');


await test('the Indian indices sit in their own table above the global scan, which no longer repeats them', () => {
  const india = MARKET_ROWS.filter((r) => r.group === 'india');
  assert.deepEqual(india.map((r) => r.label), ['Nifty 50', 'Sensex', 'Nifty Bank', 'Nifty Midcap 100', 'Nifty Smallcap 100', 'Nifty 500', 'Nifty IT', 'India VIX']);
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test' });
  const at = (s) => html.indexOf(s);
  assert.ok(at('Indian markets') > 0 && at('Nifty Bank') > at('Indian markets') && at('India VIX') > at('Indian markets'));
  assert.ok(at('Your portfolio companies') < at('Portfolio · previous session') && at('Portfolio · previous session') < at('Indian markets') && at('Indian markets') < at('Global market scan'), 'companies, then the desk\'s numbers, then the world');
  assert.ok(html.lastIndexOf('Nifty 50') < at('Global market scan'), 'the global scan does not repeat the Indian rows');
  assert.ok(at('Global market scan') < at('S&amp;P 500'));
  const text = renderBriefText(morning);
  assert.ok(text.indexOf('INDIAN MARKETS') < text.indexOf('GLOBAL MARKET SCAN') && text.indexOf('YOUR PORTFOLIO COMPANIES') < text.indexOf('INDIAN MARKETS'));
  assert.ok(/INDIAN MARKETS\n\s+Nifty 50/.test(text));
});

console.log('\n— the ledger —');

await test('the ledger remembers what a send carried, from the first window it recorded, and forgets after ten days', () => {
  const store = makeStore();
  assert.deepEqual([store.reportedLookup().empty, store.reportedLookup().since], [true, null]);
  const first = istInstant('2026-09-16', '08:00');
  assert.deepEqual(store.markReported([{ key: 'bse:a', publishedAt: first + 3600000 }, { key: 'nse:b', publishedAt: null }, { key: '' }], '2026-09-16:evening', { windowFrom: first }), { added: 2 });
  const lookup = store.reportedLookup();
  assert.equal(lookup.empty, false);
  assert.ok(lookup.has('bse:a') && lookup.has('nse:b') && !lookup.has('bse:c'));
  assert.equal(lookup.since, first, 'the ledger\'s knowledge begins at its first delivery\'s window');
  assert.deepEqual(store.markReported([{ key: 'bse:a', publishedAt: first }], '2026-09-17:morning', { windowFrom: first + 86400000 }), { added: 0 }, 'a replay adds nothing');
  assert.equal(store.reportedLookup().since, first, 'and does not move the start');
  assert.equal(store.reportedCount(), 2);
  clock += REPORTED_RETENTION_MS + 60000;
  store.markReported([{ key: 'bse:z', publishedAt: null }], '2026-09-26:morning', { windowFrom: clock });
  assert.ok(!store.reportedLookup().has('bse:a') && store.reportedLookup().has('bse:z'), 'ten-day-old items are pruned on the next write');
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
  for (const e of emails) {
    assert.equal(e.method, 'POST');
    assert.equal(e.auth, 'Bearer team-secret-token');
    assert.ok(e.html && e.text === undefined, 'exactly one of html/text');
    assert.match(e.subject, /^Sattva Ventures · \d+ updates? on your portfolio companies — 17 Sep 2026 · Morning(?: · Part \d+ of \d+)?$/);
    assert.ok(e.html.includes('SATTVA VENTURES'));
  }
  const delivery = store.delivery('2026-09-17:morning');
  assert.equal(delivery.sent, 2); assert.equal(delivery.failed, 0); assert.equal(delivery.source, 'timer');
  assert.ok(delivery.finishedAt);
  assert.equal(delivery.summary.quotes, MARKET_ROWS.length);
  assert.ok(store.reportedCount() >= delivery.summary.stories, 'every item the brief carried is in the ledger once it reached the desk');
  assert.equal(store.reportedLookup().since, istInstant('2026-09-16', '16:00'), 'the ledger begins at this brief\'s window');
  assert.equal((await schedule.status()).reported, store.reportedCount());
  assert.equal(await storage.getAlarm(), istInstant('2026-09-17', '16:00'), 're-armed for the evening');
  const before = log.length;
  await schedule.wake();
  assert.equal(log.length, before, 'a replayed alarm reads nothing and sends nothing');
  assert.equal((await schedule.status()).lastResult, 'nothing-due');
  assert.ok(!JSON.stringify([...storage.data.values()]).includes('team-secret-token'), 'the token never enters durable storage');
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
  assert.equal(store.reportedCount(), 0, 'a send nobody received marks nothing as reported');
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
  assert.equal(store.reportedCount(), 0, 'a test copy marks nothing as reported: the list did not see it');
});

await test('sending to everyone cools down for five minutes and a second press within it is refused', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  const out = await schedule.sendNow({ edition: 'morning', to: 'all' });
  assert.equal(out.sent, 2);
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  assert.ok(store.reportedCount() > 0, 'a send to everyone is a send the desk saw, so it is recorded');
  clock += 60000;
  assert.equal((await schedule.sendNow({ edition: 'morning', to: 'all' })).reason, 'cooling-down');
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  assert.equal((await schedule.sendNow({ edition: 'morning', to: 'nobody' })).reason, 'invalid-target');
});

await test('a preview builds the edition up to now without sending, in html or text', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { schedule, log } = makeSchedule({ env: { CLAUDE_KEY: 'ABSKfixture-preview-key' } });
  let paidCalls = 0;
  const fetcher = schedule.fetcher;
  schedule.fetcher = (url, init) => {
    if (String(url).includes('bedrock-runtime.')) paidCalls++;
    return fetcher(url, init);
  };
  const html = await schedule.preview({ edition: 'morning' });
  assert.equal(html.ok, true); assert.ok(html.body.startsWith('<!doctype html>')); assert.match(html.subject, /^Sattva Ventures ·/);
  const text = await schedule.preview({ edition: 'morning', format: 'text' });
  assert.ok(text.body.startsWith('SATTVA VENTURES'));
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal(paidCalls, 0, 'public previews cannot invoke either paid model pass');
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


await test('busy editions preserve every source, AI note and supplemental row within the UTF-8 email budget', () => {
  const busy = structuredClone(morning);
  busy.announcements.groups = []; busy.trades.groups = []; busy.moves.groups = [];
  busy.news.groups = [{ ticker: 'AARTIDRUGS', company: 'Aarti Drugs Ltd', items: Array.from({ length: 32 }, (_, i) => ({
    headline: `Distinct fixture development ${i}`, summary: `Source conditions ${i}: ` + '₹ & business conditions remain subject to approval. '.repeat(100),
    url: `https://example.test/news/${i}`, at: MORNING - i * 1000 - 1000, publisher: 'Fixture News', keys: [`fixture:${i}`],
    direction: 'neutral', keywords: [], eventId: `event:${i}`,
  })) }];
  busy.performance = { state: 'capture', session: '2026-09-16', quoted: 180, listed: 180, unquoted: 0, book: { ok: false },
    summary: { up: 180, down: 0, flat: 0, median: 1 }, rows: Array.from({ length: 180 }, (_, i) => ({ ticker: `H${i}`, company: `Holding row ${i} END`, last: 100 + i, pct: 1, change: null })) };
  const stats = briefStats(busy);
  busy.ai = { ok: true, items: Object.fromEntries(stats.companies.flatMap(c => c.clusters.map(k => [k.id, { summary: `Summary ${k.id}`, impact: `Impact ${k.id}` }]))) };
  const options = { pdfUrl: 'https://example.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000000' };
  const parts = renderBriefEmails(busy, options);
  assert.ok(parts.length > 3);
  assert.equal(new Set(parts.map(p => p.subject)).size, parts.length, 'numbered subjects prevent conversation-level clipping');
  assert.notEqual(parts[0].subject, briefSubject({ ...busy, edition: 'evening' }));
  assert.notEqual(parts[0].subject, briefSubject({ ...busy, day: '2027-09-17' }));
  assert.deepEqual(parts.flatMap(p => p.keys).sort(), briefStories(busy).flatMap(s => s.keys).sort());
  const html = parts.map(p => p.html).join('\n');
  const escape = text => text.replace(/&/g, '&amp;');
  for (const s of briefStories(busy)) {
    assert.ok(html.includes(s.headline)); assert.ok(html.includes(escape(s.dek)), 'complete source text is retained');
  }
  for (const note of Object.values(busy.ai.items)) assert.ok(html.includes(note.summary) && html.includes(note.impact));
  for (const row of busy.performance.rows) assert.equal(parts.filter(p => p.html.includes(row.company)).length, 1);
  for (const [i, p] of parts.entries()) {
    assert.ok(p.bytes <= EMAIL_HTML_BYTES); assert.equal(p.bytes, Buffer.byteLength(p.html));
    assert.ok(p.subject.endsWith(`Part ${i + 1} of ${parts.length}`));
    assert.ok(p.html.includes(`Part ${i + 1} of ${parts.length}`) && p.html.includes(options.pdfUrl));
  }
  assert.equal(emailBytes('₹漢😀'), Buffer.byteLength('₹漢😀'));
  const full = renderBriefHtml(morning, options);
  assert.equal(renderBriefEmails(morning, options, { maxBytes: emailBytes(full) }).length, 1);
  assert.ok(renderBriefEmails(morning, options, { maxBytes: emailBytes(full) - 1 }).length > 1);
  const impossible = structuredClone(busy); impossible.news.groups[0].items[0].summary = 'x'.repeat(100000);
  assert.throws(() => renderBriefEmails(impossible, options), { code: 'email-too-large' });
  const shared = [{ keys: ['url:one', 'shared'] }, { keys: ['url:two', 'shared'] }];
  assert.deepEqual(acceptedStoryKeys(shared, new Set([0])), ['url:one']);
  if (process.env.NEWSLETTER_PREVIEW_DIR) {
    mkdirSync(process.env.NEWSLETTER_PREVIEW_DIR, { recursive: true });
    parts.forEach((p, i) => writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/part-${i + 1}.html`, p.html));
    writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/sattva-full-brief.pdf`, renderBriefPdf(busy));
    writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/sattva-short-brief.pdf`, renderBriefPdf(morning));
  }
});

await test('split-company sentiment counts updates rather than related exchange copies', () => {
  const paired = structuredClone(morning);
  const template = morning.announcements.groups[0].items[0];
  paired.news.groups = []; paired.trades.groups = []; paired.moves.groups = [];
  paired.announcements.groups = [{ ticker: 'AARTIDRUGS', company: 'Aarti Drugs Ltd', items: Array.from({ length: 32 }, (_, i) => ['NSE', 'BSE'].map(exchange => ({
    ...template, headline: `Disclosure${i}`, content: { state: 'ready', hash: `fixture-document-${i}`, facts: [] },
    subject: 'Credit Rating / ' + 'Full source particulars and conditions. '.repeat(50),
    at: MORNING - i * 7200_000 - 60000, exchanges: [exchange], direction: 'negative',
    url: `https://example.test/${exchange}/${i}`, keys: [`paired:${exchange}:${i}`],
  }))).flat() }];
  const parts = renderBriefEmails(paired);
  assert.ok(parts.length > 1);
  const companies = parts.flatMap(p => p.part.companies);
  assert.ok(companies.length > 1 && companies.some(c => c.continued));
  assert.ok(companies.some(c => c.clusters.some(k => k.others.length)), 'fixture includes paired reports');
  for (const c of companies) {
    assert.equal(c.watch, c.clusters.length, 'each negative update counts once');
    assert.equal(c.good, 0);
    assert.ok(c.stories.length > c.watch, 'related source copies are retained separately');
  }
});

function multipartHarness(response = () => Response.json({ success: true })) {
  const holdings = [{ name: 'Aarti Drugs Ltd', ticker: 'AARTIDRUGS', isin: 'INE767A01016', listed: true },
    { name: 'Capri Global Capital Ltd', ticker: 'CGCL', isin: 'INE180C01042', listed: true }];
  const articles = holdings.flatMap(h => Array.from({ length: 12 }, (_, i) => ({
    title: `${h.name} reports business development ${i}`, summary: `Full source detail ${i}: ` + 'Contract conditions and business details. '.repeat(200),
    url: `https://example.test/${h.ticker}/${i}`, publishedAt: new Date(MORNING - (i + 1) * 60000).toISOString(), publisher: 'Fixture News',
  })));
  const h = makeSchedule({ now: () => MORNING, env: { ASSETS: assetsWith({ '/data/portfolio-companies.json': { holdings }, '/data/market-news.json': { articles } }) } });
  h.store.apply([{ op: 'subscribe', email: 'reader@example.test', by: 'Fixture & <name>' }]);
  const previous = h.schedule.fetcher; h.emails = [];
  h.schedule.fetcher = async (url, init) => {
    if (url !== EMAIL_SEND_URL) return previous(url, init);
    const body = JSON.parse(init.body); h.emails.push(body); return response(body, h.emails.length);
  };
  return h;
}
const deliveryArgs = { edition: 'morning', day: '2026-09-17', at: MORNING, now: MORNING, key: 'multipart:fixture', source: 'timer' };

await test('saved PDFs and confirmed part outcomes survive failures, interruptions and log pruning', async () => {
  const good = multipartHarness();
  const result = await good.schedule.deliver(deliveryArgs);
  assert.equal(result.ok, true); assert.ok(result.summary.emailParts > 1);
  assert.equal(good.emails.length, result.summary.emailParts);
  const pdfIds = good.emails.map(e => e.html.match(/\/api\/newsletter\/pdf\/([a-f0-9-]+)/)[1]);
  assert.equal(new Set(pdfIds).size, 1, 'one complete PDF for every part');
  assert.equal(new Set(good.emails.map(e => e.subject)).size, good.emails.length);
  const saved = good.store.document(pdfIds[0]);
  assert.equal(new TextDecoder().decode(saved.body.slice(0, 8)), '%PDF-1.4');
  assert.equal(saved.filename, 'sattva-2026-09-17-morning-brief.pdf');
  assert.equal((await good.schedule.deliver(deliveryArgs)).reason, 'already-sent');
  assert.equal(good.emails.length, result.summary.emailParts);
  const firstKeys = good.emails[0].html;
  assert.ok(firstKeys.includes('business development'));

  const partial = multipartHarness((_body, n) => n === 1 ? Response.json({ success: true }) : new Response('', { status: 403 }));
  const failed = await partial.schedule.deliver(deliveryArgs);
  assert.equal(failed.reason, 'partial-send'); assert.equal(failed.sent, 0); assert.equal(failed.failed, 1);
  assert.ok(partial.store.reportedCount() > 0 && partial.store.reportedCount() < good.store.reportedCount());
  const accepted = partial.store.rows('SELECT item FROM newsletter_reported').map(r => r.item).sort();
  const fullBrief = await buildBrief({ edition: 'morning', day: '2026-09-17', now: MORNING, settings: DEFAULT_SETTINGS, env: partial.schedule.env, fetcher: partial.schedule.fetcher });
  const plan = renderBriefEmails(fullBrief, { pdfUrl: 'https://sattva-central-research.tech-441.workers.dev/api/newsletter/pdf/00000000-0000-0000-0000-000000000000', recipient: partial.store.recipients('morning')[0] });
  assert.deepEqual(accepted, acceptedStoryKeys(plan, new Set([0])).sort());
  assert.equal(partial.store.rows('SELECT delivery_state FROM newsletter_documents')[0].delivery_state, 'sent');

  const interrupted = multipartHarness();
  const record = interrupted.store.recordDeliveryProgress.bind(interrupted.store);
  interrupted.store.recordDeliveryProgress = (...args) => {
    record(...args);
    if (args[1].outcomes.some(o => o.parts.some(p => p.ok))) throw new Error('simulated interruption');
  };
  await assert.rejects(interrupted.schedule.deliver(deliveryArgs), /simulated interruption/);
  const restarted = new NewsletterStore(interrupted.storage);
  assert.equal(restarted.delivery(deliveryArgs.key).finishedAt, null);
  assert.deepEqual(restarted.rows('SELECT item FROM newsletter_reported').map(r => r.item).sort(), accepted);
  assert.equal((await interrupted.schedule.deliver(deliveryArgs)).reason, 'already-sent');
  assert.equal(interrupted.emails.length, 1);

  for (const [reason, reply, expected] of [
    ['rejected', () => new Response('', { status: 403 }), 0],
    ['timeout', () => { throw new DOMException('timeout', 'TimeoutError'); }, 1],
  ]) {
    const h = multipartHarness(reply); await h.schedule.deliver(deliveryArgs);
    assert.equal(h.store.reportedCount(), 0, reason);
    assert.equal(h.store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n, expected);
  }
  const testCopy = multipartHarness(); await testCopy.schedule.deliver({ ...deliveryArgs, source: 'test' });
  assert.equal(testCopy.store.reportedCount(), 0);
  for (let i = 0; i < 210; i++) { good.store.beginDelivery({ ...deliveryArgs, key: `old:${i}`, recipients: 0 }); good.store.finishDelivery(`old:${i}`); }
  assert.deepEqual(good.store.document(pdfIds[0]).body, saved.body, 'emailed PDFs survive delivery log pruning');
  assert.equal(good.store.document('invalid'), null);
});

await test('PDF download routes, preview limits and manual budgets are explicit and read-only', async () => {
  const h = multipartHarness();
  const pdf = renderBriefPdf(morning);
  const id = h.store.saveDocument(pdf, pdfFilename(morning), 'fixture');
  const apiEnv = { NEWSLETTER_LIMITER: { limit: async () => ({ success: true }) }, NEWSLETTER: { getByName: () => ({
    newsletterPdf: id => h.store.document(id), newsletterPreview: input => h.schedule.preview(input),
  }) } };
  const base = 'https://example.test/api/newsletter';
  const response = await handleNewsletter(new Request(`${base}/pdf/${id}`), apiEnv);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.ok(response.headers.get('content-disposition').includes('attachment; filename="sattva-'));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
  assert.equal((await handleNewsletter(new Request(`${base}/pdf/00000000-0000-0000-0000-000000000000`), apiEnv)).status, 404);
  assert.equal((await handleNewsletter(new Request(`${base}/pdf/${id}`, { method: 'POST' }), apiEnv)).status, 405);
  const preview = await handleNewsletter(new Request(`${base}/preview`), apiEnv);
  const count = Number(preview.headers.get('x-newsletter-parts')); assert.ok(count > 1);
  for (let part = 1; part <= count; part++) {
    const p = await handleNewsletter(new Request(`${base}/preview?part=${part}`), apiEnv);
    assert.equal(p.status, 200); assert.ok((await p.text()).includes(`Part ${part} of ${count}`));
  }
  assert.equal((await handleNewsletter(new Request(`${base}/preview?part=${count + 1}`), apiEnv)).status, 400);
  const previewPdf = await handleNewsletter(new Request(`${base}/preview?format=pdf`), apiEnv);
  assert.equal(previewPdf.headers.get('content-type'), 'application/pdf');
  assert.equal(h.emails.length, 0);
  assert.equal(h.store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n, 1, 'previews save no documents');
  assert.equal((await handleNewsletter(new Request(`${base}/preview`), { ...apiEnv, NEWSLETTER_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  for (let i = 0; i < 4; i++) assert.equal(h.store.claimManualDelivery(MORNING).ok, true);
  assert.equal(new NewsletterStore(h.storage).claimManualDelivery(MORNING).ok, false);
  assert.equal(h.store.claimManualDelivery(MORNING + 86400000).ok, true);
  assert.equal((await sendEmail({ html: '₹'.repeat(EMAIL_HTML_BYTES), fetcher: () => { throw new Error('must not send'); } })).reason, 'email-too-large');
});

await test('current shipped assets build source-only with direct-company scope and explicit coverage', async () => {
  const shipped = { fetch: async request => {
    const path = new URL(request.url).pathname;
    assert.notEqual(path, '/data/book.json');
    if (!path.startsWith('/data/') || path.includes('..')) return new Response('', {status:404});
    try { return new Response(readFileSync(new URL(`../public${path}`, import.meta.url))); }
    catch { return new Response('', {status:404}); }
  }};
  const now = Date.now(), day = istDay(now);
  const real = await buildBrief({ edition:'morning', day, settings:DEFAULT_SETTINGS, env:{ASSETS:shipped},
    fetcher:async()=>new Response('',{status:503}), now, includeAi:false });
  const holdings = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url))).holdings;
  const tickers = new Set(holdings.map(h=>h.ticker?.toUpperCase()).filter(Boolean));
  assert.ok(real.book.listed > 0 && real.book.listed <= real.book.lines);
  for (const story of briefStories(real)) {
    assert.ok(tickers.has(story.ticker));
    assert.ok(story.at >= (real.lateFrom ?? real.window.from) && story.at < real.window.to);
    if (story.kind === 'news') assert.equal(story.mood.id, 'neutral');
  }
  const html = renderBriefHtml(real);
  assert.ok(html.includes('SATTVA VENTURES'));
  assert.ok(!html.includes('<script'));
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);
