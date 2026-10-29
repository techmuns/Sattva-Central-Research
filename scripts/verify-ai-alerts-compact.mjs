#!/usr/bin/env node
// AI Alerts' Compact view and the broker reports behind it — offline, no server.
//
//   1. The broker-post parser on the channel's real formats (copied verbatim from the capture).
//   2. The build script against the committed capture: the group-company and look-alike-name
//      refusals, and a file small enough for the landing tab.
//   3. The Compact filter on ranked fixture cards: what is left out, what folds, what leads, the
//      sixty-word cap, and that nothing new is said.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const shared = await import('../public/js/data/broker-reports-shared.js');
const { parseBrokerPost, mergeReports, brokerImportance, brokerHeadline, brokerDirection, brokerCall } = shared;

// ------------------------------------------------------------------------------------------
// 1. Parser
// ------------------------------------------------------------------------------------------
const post = (id, text, publishedAt = '2026-10-19T10:43:05.000Z') => ({ id, text, publishedAt, url: `https://t.me/researchreportss/${id}` });
{
  const [r] = parseBrokerPost(post(1, 'Motilal Oswal sees 33% UPSIDE in Jindal Stainless- Strong NSR and volume recovery drive earnings'));
  assert.deepEqual([r.broker, r.named, r.upsidePct, r.rating, r.stance, r.target, r.points, r.kind],
    ['Motilal Oswal', 'Jindal Stainless', 33, null, null, null, 'Strong NSR and volume recovery drive earnings', 'view']);
  assert.equal(brokerDirection(r), 'positive', 'the broker said upside');
  assert.equal(r.stance, null, 'an upside figure is never a stance — a 6% upside can sit with a HOLD');
  assert.equal(r.target, null, 'no target is derived from an upside');
}
{
  const [r] = parseBrokerPost(post(2, 'PL Capital sees 8% DOWNSIDE in BHEL- Strong Q2; execution pick up across segments'));
  assert.equal(r.upsidePct, -8);
  assert.equal(brokerDirection(r), 'negative');
  assert.equal(brokerImportance(r).high, true, 'a downside call is material');
  assert.equal(brokerCall(r), '8% downside');
}
{
  const [r] = parseBrokerPost(post(3, 'ICICI Securities sees 44% UPSIDE in Piramal Finance- Superior execution continues; on track to achieve FY27 guidance'));
  assert.equal(r.named, 'Piramal Finance');
  const [colon] = parseBrokerPost(post(4, 'Choice Equities sees 33% UPSIDE in Jupiter Life Line Hospitals: Multiple Growth Levers to Drive Sustained Expansion'));
  assert.deepEqual([colon.named, colon.points], ['Jupiter Life Line Hospitals', 'Multiple Growth Levers to Drive Sustained Expansion']);
  const [bare] = parseBrokerPost(post(5, 'Joindre Capital Services sees 19% UPSIDE in BHEL LTD.'));
  assert.deepEqual([bare.broker, bare.named, bare.points], ['Joindre Capital', 'BHEL LTD', null], 'a broker alias is one firm');
}
{
  const [r] = parseBrokerPost(post(6, 'Antique Initiating Coverage on Transrail Lighting, with 83% UPSIDE- Powering the next leg of growth', '2026-10-07T11:25:18.000Z'));
  assert.deepEqual([r.broker, r.named, r.kind, r.upsidePct, r.points], ['Antique', 'Transrail Lighting', 'initiation', 83, 'Powering the next leg of growth']);
  assert.equal(brokerImportance(r).high, true, 'an initiation is material');
  const [withBuy] = parseBrokerPost(post(7, 'Equirus Securities Initiating Coverage on Time Technoplast Ltd, with 50% UPSIDE- A Strong Core, with VAPs Driving the Next Leg of Growth – Initiate with BUY'));
  assert.deepEqual([withBuy.named, withBuy.rating, withBuy.stance], ['Time Technoplast Ltd', 'BUY', 'bullish'], '"Initiate with BUY" is the broker printing its rating');
}
{
  const digest = parseBrokerPost(post(8, 'Antique on\n\n\nICICI Bank: BUY | TP 1,755 | Margins in-line, PAT beat on lower opex and provisions\n\n\nSouth Indian Bank: BUY | TP 59 | Beat led by better margins and non-core income\n\nInitiating Coverage on Neogen Chemicals: BUY | TP 3,050 | Bromine to battery: India\'s non-FEOC play\n\nAMC: 2QFY27 Preview: Lower MTM impacts growth'));
  assert.deepEqual(digest.map((r) => [r.broker, r.named, r.rating, r.target, r.kind]), [
    ['Antique', 'ICICI Bank', 'BUY', 1755, 'view'], ['Antique', 'South Indian Bank', 'BUY', 59, 'view'], ['Antique', 'Neogen Chemicals', 'BUY', 3050, 'initiation']],
    'each digest line belongs to its own company; a sector line is not a company report');
  assert.equal(digest[1].named, 'South Indian Bank', 'never cut to "Indian Bank"');
}
{
  const pipes = parseBrokerPost(post(9, 'Yes Securities on Expert Interaction Update- Current MHCV upcycle is unique & here to stay\n\n\nAshok Leyland | ADD | TP 192 |\nCEAT | NEUTRAL | TP 3,459 |\nM&M | BUY | TP 3,862 |'));
  assert.deepEqual(pipes.map((r) => [r.broker, r.named, r.rating, r.stance, r.target, r.reportTitle]), [
    ['Yes Securities', 'Ashok Leyland', 'ADD', 'bullish', 192, 'Current MHCV upcycle is unique & here to stay'],
    ['Yes Securities', 'CEAT', 'NEUTRAL', 'neutral', 3459, 'Current MHCV upcycle is unique & here to stay'],
    ['Yes Securities', 'M&M', 'BUY', 'bullish', 3862, 'Current MHCV upcycle is unique & here to stay']], 'the broker name stops before " on "');
  const swapped = parseBrokerPost(post(10, 'Systematix Update on Paints Sector- Demand holds at moderate levels; caution on rebound\n\nAPNT | TP 3,285 | BUY |\nKNPL | TP 230 | HOLD |\n\n#sector'));
  assert.deepEqual(swapped.map((r) => [r.named, r.rating, r.target]), [['APNT', 'BUY', 3285], ['KNPL', 'HOLD', 230]]);
}
{
  const morning = parseBrokerPost(post(11, 'Motilal Oswal’s Morning India- Today’s top research idea\n\n\nUrban Company, with 22% UPSIDE- Core accelerating\n\nInitiating Coverage on Symbiotec Pharmalab, with 23% UPSIDE- Anchored by APIs\n\nB P C L, with 4% DOWNSIDE- Weak marketing outlook\n\nCEAT- Margin beat despite RMC pressure leads to a beat on PAT'));
  assert.deepEqual(morning.map((r) => [r.broker, r.named, r.kind, r.upsidePct]), [
    ['Motilal Oswal', 'Urban Company', 'view', 22], ['Motilal Oswal', 'Symbiotec Pharmalab', 'initiation', 23],
    ['Motilal Oswal', 'B P C L', 'view', -4], ['Motilal Oswal', 'CEAT', 'view', null]]);
}
assert.deepEqual(parseBrokerPost(post(12, 'Antique IPO Note on Jio Platforms- Subscriber growth and ARPU upside not in the price!')), [], 'an IPO note is not a listed-company report');
assert.deepEqual(parseBrokerPost(post(13, 'Jai Mata Di')), []);
assert.deepEqual(parseBrokerPost({ id: 14, text: null, url: 'https://t.me/x/14' }), []);
{
  // The same initiation, posted on its own and again in the broker's digest: one report, both links.
  const solo = parseBrokerPost(post(20, 'Antique Initiating Coverage on Transrail Lighting, with 83% UPSIDE- Powering the next leg of growth', '2026-10-07T11:25:18.000Z'));
  const inDigest = parseBrokerPost(post(19, 'Antique on (06-Oct-26)\n\n\nInitiating Coverage on Transrail Lighting: BUY | TP 851 | Powering the next leg of growth', '2026-10-07T11:24:12.000Z'));
  const merged = mergeReports([...solo, ...inDigest].map((r) => ({ ...r, ticker: 'TRANSRAILL' })));
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].rating, merged[0].target, merged[0].upsidePct, merged[0].kind, merged[0].urls.length], ['BUY', 851, 83, 'initiation', 2]);
  assert.equal(brokerHeadline(merged[0]), 'Antique initiated coverage: BUY · TP ₹851 · 83% upside');
}
{
  const r = { broker: 'Systematix', rating: 'BUY', stance: 'bullish', previous: { rating: 'HOLD' }, kind: 'view' };
  assert.equal(brokerImportance(r).high, true, 'a rating change against the broker\'s previous rated report is material');
  assert.equal(brokerHeadline(r), 'Systematix: HOLD → BUY');
  assert.equal(brokerImportance({ broker: 'Yes Securities', rating: 'ADD', stance: 'bullish', previous: { rating: 'BUY' }, kind: 'view' }).high, true,
    'BUY → ADD is a rating change even inside one stance');
  assert.equal(brokerImportance({ broker: 'Nuvama', upsidePct: 16, kind: 'view' }).high, false, 'one routine view is context');
  assert.equal(brokerImportance({ broker: 'Nuvama', upsidePct: 16, kind: 'view' }, 2).high, true, 'two brokers in the window is material');
}
console.log('PASS broker posts: sees / downside / initiation / digest colon and pipe lines / morning ideas / IPO notes refused / duplicates merged / importance');

// ------------------------------------------------------------------------------------------
// 2. Build against the committed capture
// ------------------------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'broker-reports-'));
  const out = join(dir, 'broker-reports.json');
  const capture = JSON.parse(readFileSync('public/data/telegram-posts.json', 'utf8'));
  const newest = capture.posts.map((p) => Date.parse(p.publishedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  execFileSync(process.execPath, ['scripts/build-broker-reports.mjs', 'public/data/telegram-posts.json', out], { env: { ...process.env, BROKER_NOW_MS: String(newest) }, stdio: 'pipe' });
  const file = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(file.schemaVersion, 1);
  assert(file.reports.length > 50, 'the last 30 days of the capture carry broker reports');
  assert(readFileSync(out).length < 600_000, 'small enough for the landing tab');
  const named = (re) => file.reports.filter((r) => re.test(r.named));
  for (const r of named(/^Mahindra & Mahindra Financial/i)) assert.notEqual(r.ticker, 'M&M', 'a group company is never filed under its parent');
  for (const r of named(/^South Indian Bank/i)) assert.notEqual(r.ticker, 'INDIANB', 'South Indian Bank is not Indian Bank');
  for (const r of named(/^(?:BHEL|Bharat Heavy Electricals)/i)) assert.equal(r.ticker, 'BHEL');
  assert(file.reports.every((r) => r.url?.startsWith('https://t.me/')), 'every report links to its post');
  assert(file.reports.every((r) => r.stance == null || r.rating), 'a stance exists only with a printed rating');
  assert.equal(file.counts.resolved + file.counts.unresolved, file.counts.reports);
  console.log(`PASS broker build: ${file.counts.reports} reports, ${file.counts.unresolved} unresolved, group-company and look-alike names refused`);
}

// ------------------------------------------------------------------------------------------
// 3. The Compact filter over ranked cards
// ------------------------------------------------------------------------------------------
const { rankReport } = await import('../public/js/data/ai-alerts.js');
const { ATTRIBUTION_VERSION } = await import('../public/js/data/company-news-attribution.js');
const confirmed = { version: ATTRIBUTION_VERSION, status: 'confirmed' };
const compact = await import('../public/js/data/ai-alerts-compact.js');
const { brokerRecord } = await import('../public/js/data/broker-reports.js');
const day = '2026-10-28';
let n = 0;
const ev = (ticker, feed, headline, extra = {}) => ({ id: `${feed}:${ticker}:${++n}`, ticker, company: `${ticker} Limited`, feed, feedLabel: feed,
  headline, detail: '', day, time: '10:00', importance: 'high', direction: 'neutral', url: `https://example.test/${ticker}/${n}`,
  signalReason: 'fixture', importanceReason: 'fixture', aiEligible: true, ...extra });
// The collector stamps each source's events with its feed (daily-alerts `toFeedRowSteps`).
const broker = (ticker, fields) => ({ ...brokerRecord({ id: `${++n}:${ticker}`, ticker, company: `${ticker} Limited`, named: ticker, kind: 'view',
  publishedAt: `${day}T05:00:00.000Z`, url: `https://t.me/researchreportss/${n}`, ...fields }, 3), feed: 'broker-reports', feedLabel: 'Broker reports' });
const events = [
  // Only a trading indicator and a call date: left to Detailed.
  ev('TAPE', 'technicals', 'Rose 6.2% at the 2026-10-27 close', { detail: 'Close ₹100 · RSI 61', direction: 'positive' }),
  ev('TAPE', 'announcements', 'Intimation of Earnings Conference Call', { filingSubject: 'Intimation of Earnings Conference Call', filingSubCategory: 'Analyst / Investor Meet' }),
  // A result reported five ways: one row, the company's filing as its link.
  ev('RESULTCO', 'earnings', 'YOY quarterly result filed', { resultBasis: 'YOY', metrics: { netProfit: { label: 'Net Profit', kind: 'normal', pct: 21 }, revenue: { label: 'Revenue', kind: 'normal', pct: 16 } }, url: 'https://www.moneycontrol.com/x', direction: 'positive' }),
  ev('RESULTCO', 'announcements', 'Unaudited Financial Results for the quarter ended September 30, 2026', { filingSubject: 'Unaudited Financial Results for the quarter ended September 30, 2026', filingSubCategory: 'Financial Results', url: 'https://www.bseindia.com/result.pdf' }),
  ev('RESULTCO', 'news', 'RESULTCO Q2 FY27 results: net profit rises 21% to ₹100 crore', { namesCompany: true, attribution: confirmed }),
  ev('RESULTCO', 'news', 'RESULTCO Q2 revenue up 16%; margins steady', { namesCompany: true, attribution: confirmed }),
  ev('RESULTCO', 'technicals', 'Volume 3.1x its 20-day average', { direction: 'neutral' }),
  // Broker views lead when they are the company's material item; chatter never outranks them.
  ev('BROKERCO', 'chatter', 'Bullish public chatter (30d snapshot)', { direction: 'positive' }),
  broker('BROKERCO', { broker: 'Antique', rating: 'BUY', stance: 'bullish', target: 1755, points: 'Margins in-line, PAT beat on lower opex' }),
  broker('BROKERCO', { broker: 'Axis Securities', upsidePct: 34, points: 'Consistent Outperformance Merits a Premium' }),
  broker('BROKERCO', { broker: 'Centrum', upsidePct: 29 }),
  broker('BROKERCO', { broker: 'PL Capital', upsidePct: -8, points: 'Strong Q2' }),
  // One story tagged to two companies leads only one row.
  ev('AAA', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
  ev('BBB', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
  ev('BBB', 'insider', 'Promoter — Buy · ₹12.0 crore block deal', { tradeCategory: 'Block deal', direction: 'positive' }),
  // A board meeting announced ahead of itself is a date.
  ev('MEETCO', 'announcements', 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results', { filingSubject: 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results' }),
  // A long statement is clipped to sixty words, all of it kept on the title.
  ev('LONGCO', 'announcements', `Disclosure of ${'material terms of the agreement executed with the counterparty '.repeat(12)}`.trim(), { filingSubject: 'x' }),
];
const holdings = ['TAPE', 'RESULTCO', 'BROKERCO', 'AAA', 'BBB', 'MEETCO', 'LONGCO'].map((ticker) => ({ ticker, name: `${ticker} Limited` }));
const report = rankReport({ day, events, feeds: [...new Set(events.map((e) => e.feed))].map((id) => ({ id, status: 'ok', reachesToday: true })), pending: 0 }, { holdings });
const all = report.allCards;
assert(all.some((c) => c.ticker === 'TAPE'), 'Detailed still carries the company Compact leaves out');
const { cards, hidden } = compact.compactCards(all);
assert(!cards.some((c) => c.ticker === 'TAPE'), 'price-volume and call-date only companies are left to Detailed');
assert(hidden.some((h) => h.company === 'TAPE Limited'));
assert(!cards.some((c) => c.ticker === 'MEETCO'), 'a board-meeting intimation is a date, whatever type the exchange filed it under');
assert(cards.every((c) => c.events.every((e) => e.feed !== 'technicals' && !compact.isScheduleNotice(e))), 'nothing excluded survives into a Compact card');
const destination = (e) => ({ href: e.url, external: true, label: 'Source ↗', ariaLabel: e.headline });
const { rows } = compact.compactRows(cards, { destination });
const row = (ticker) => rows.find((r) => r.ticker === ticker);
assert.equal(new Set(rows.map((r) => r.ticker)).size, rows.length, 'one row per company');

const result = row('RESULTCO');
assert.equal(result.kind, 'result');
assert.equal(result.href, 'https://www.bseindia.com/result.pdf', 'a result opens the company\'s own filing');
assert.equal(result.folded, 3, 'the result data, the filing and both write-ups are one result');
assert.match(result.text, /net profit \+21\.0%, revenue \+16\.0%/);

const brokerRow = row('BROKERCO');
assert.equal(brokerRow.brokerLed, true, 'four broker reports lead over a public-chatter snapshot');
assert.equal(brokerRow.brokers.length, 4);
assert.equal(brokerRow.text, '4 broker reports in 14 days. Antique rates it BUY with a ₹1,755 target; Axis Securities and Centrum see 29–34% upside; PL Capital sees 8% downside.');

const [aaa, bbb] = [row('AAA'), row('BBB')];
assert(aaa && bbb);
assert.notEqual(aaa.href, bbb.href, 'a story leads one row; the other company leads with its own next item');
assert.equal((aaa.href === 'https://example.test/shared-story' ? bbb : aaa).kind, 'deal');

const long = row('LONGCO');
assert(long.text.split(/\s+/).length <= compact.COMPACT_WORD_LIMIT + 1 && long.text.endsWith('…'), 'sixty words at most, clipped with an ellipsis');
assert(long.fullText.length > long.text.length, 'the whole statement is kept for the title');

for (const r of rows) {
  assert(!/check both directions below/i.test(r.text), 'the Detailed card\'s pointer is never carried');
  assert(r.text.split(/\s+/).length <= compact.COMPACT_WORD_LIMIT + 1, `${r.ticker} text within sixty words`);
}
assert.equal(compact.clipWords('one two three', 2), 'one two…');
assert.equal(compact.isScheduleNotice({ feed: 'news', headline: 'Mastek Q2 FY27 Earnings Call Recording Now Available' }), true);
for (const headline of ['Mastek Q2FY27 Earnings Call Set for October 26, 2026', 'Ather Energy Q2 2027 Earnings Call Is Live', 'Intimation of Investors Conference Call on Thursday, October 29, 2026'])
  assert.equal(compact.isScheduleNotice({ feed: 'news', headline }), true, headline);
for (const headline of ['Activist investor calls for CEO removal', 'Investor calls for board meeting after fraud allegations'])
  assert.equal(compact.isScheduleNotice({ feed: 'news', headline }), false, `${headline} is news, not a date`);
assert.equal(compact.isScheduleNotice({ feed: 'news', headline: 'Earnings call transcript: Mastek misses Q2 EPS' }), false, 'a transcript is content');
assert.equal(compact.isScheduleNotice({ feed: 'announcements', filingSubject: 'Outcome of Board Meeting held on October 26, 2026.' }), false, 'an outcome is content');
assert.equal(compact.compactExclusion({ feed: 'price-levels' }), null, 'the family\'s own price levels are not trading indicators');
console.log(`PASS compact: ${rows.length} rows from ${all.length} cards — indicators and dates left to Detailed, results folded, brokers summarised, stories used once, sixty words`);

// Two results filed within a week are two results: the row's figures and its link are one period's.
{
  const d1 = '2026-10-21', d2 = '2026-10-26';
  const at = (d, extra) => ({ day: d, time: null, ...extra });
  const events2 = [
    ev('TWOPER', 'earnings', 'YOY quarterly result filed', at(d1, { resultBasis: 'YOY', metrics: { netProfit: { label: 'Net Profit', kind: 'normal', pct: 5 }, revenue: { label: 'Revenue', kind: 'normal', pct: 3 } }, url: 'https://mc.test/old' })),
    ev('TWOPER', 'announcements', 'Financial Results for the quarter ended June 30, 2026', at(d1, { filingSubject: 'Financial Results for the quarter ended June 30, 2026', filingSubCategory: 'Financial Results', url: 'https://bse.test/june.pdf' })),
    ev('TWOPER', 'earnings', 'YOY quarterly result filed', at(d2, { resultBasis: 'YOY', metrics: { netProfit: { label: 'Net Profit', kind: 'normal', pct: 40 }, revenue: { label: 'Revenue', kind: 'normal', pct: 22 } }, url: 'https://mc.test/new' })),
    ev('TWOPER', 'announcements', 'Financial Results for the quarter ended September 30, 2026', at(d2, { filingSubject: 'Financial Results for the quarter ended September 30, 2026', filingSubCategory: 'Financial Results', url: 'https://bse.test/september.pdf' })),
  ];
  const rep2 = rankReport({ day, events: events2, feeds: [{ id: 'earnings', status: 'ok', reachesToday: true }, { id: 'announcements', status: 'ok', reachesToday: true }], pending: 0 }, { holdings: [{ ticker: 'TWOPER', name: 'x' }] });
  const [r2] = compact.compactRows(compact.compactCards(rep2.allCards).cards, { destination }).rows;
  const figures = /\+40\.0%/.test(r2.text) ? 'new' : /\+5\.0%/.test(r2.text) ? 'old' : 'none';
  assert.notEqual(figures, 'none', r2.text);
  assert.equal(r2.href, figures === 'new' ? 'https://bse.test/september.pdf' : 'https://bse.test/june.pdf', 'the figures and the filing behind a row are one period\'s');
  assert.equal(r2.folded, 1, 'only that period\'s filing is folded in');
}

// A failed Telegram collection is the broker feed's failure, with the last good reports kept.
{
  const reportsModule = await import('../public/js/data/broker-reports.js');
  const file = { schemaVersion: 1, generatedAt: '2026-10-28T08:40:00.000Z', captureCheckedAt: `${day}T08:30:00.000Z`, windowDays: 30,
    counts: { reports: 1, unresolved: 0 }, captureHealth: { state: 'partial', failed: true, partial: false, lastRunStatus: 'failed', lastRunAt: `${day}T08:33:00.000Z` },
    reports: [{ id: '1:ICICIBANK', broker: 'Antique', ticker: 'ICICIBANK', company: 'ICICI Bank', named: 'ICICI Bank', kind: 'view', rating: 'BUY', stance: 'bullish', target: 1755, publishedAt: `${day}T05:00:00.000Z`, url: 'https://t.me/researchreportss/1' }] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } });
  try { await reportsModule.load(); } finally { globalThis.fetch = realFetch; }
  const feed = reportsModule.readFeed({ day });
  assert.equal(feed.status, 'failed', 'an upstream failure is not complete coverage');
  assert.equal(feed.reachesToday, false);
  assert.equal(feed.events.length, 1, 'the last good reports stay');
  assert.match(feed.note, /latest Telegram collection failed/);
}
console.log('PASS compact review fixes: rating words compared, call news needs schedule wording, one result period per row, upstream collection failure carried');
