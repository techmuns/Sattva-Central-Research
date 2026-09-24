#!/usr/bin/env node
// ONE DEVELOPMENT, ONE ITEM — the fold behind AI Alerts and All Alerts, on fixtures.
//
// The customer's case (September 2026): Puravankara's ₹2,600 crore Goregaon redevelopment win was
// the company's own BSE announcement, filed again on NSE, and then reported by a stream of
// publishers — seven or eight items of one event, with the card leading on a publisher's write-up
// as though it were generic news. These fixtures reproduce that shape with public-style rows and
// assert the four rules in data/alert-developments.js, the card that the AI ranking builds from it,
// and the All Alerts row. No network, no captures.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

const dev = await import('../public/js/data/alert-developments.js');
const ai = await import('../public/js/data/ai-alerts.js');
const utils = await import('../public/js/ui/ai-alert-utils.js');
const { ATTRIBUTION_VERSION } = await import('../public/js/data/company-news-attribution.js');

const confirmed = { version: ATTRIBUTION_VERSION, status: 'confirmed', companyTicker: 'PURVA' };
const COMPANY = 'Puravankara Ltd';
const bse = {
  id: 'ann:purva-goregaon', feed: 'announcements', feedLabel: 'Announcements', ticker: 'PURVA', company: COMPANY,
  day: '2026-09-17', time: '18:05', importance: 'low', direction: 'neutral', aiEligible: true,
  headline: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon',
  filingSubject: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon',
  filingSubCategory: 'Press Release / Media Release',
  detail: 'BSE · Press Release / Media Release', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/goregaon.pdf',
};
const nse = {
  id: 'nse:purva-goregaon', feed: 'nse-filings', feedLabel: 'NSE Filings', ticker: 'PURVA', company: COMPANY,
  day: '2026-09-17', time: '18:11', importance: 'low', direction: 'neutral', aiEligible: true,
  headline: 'Press Release', filingSubject: 'Press Release',
  filingDescription: 'Puravankara Limited has informed the Exchange about Rs 2,600 crore redevelopment project inGoregaon',
  detail: 'NSE · Press Release', url: 'https://nsearchives.nseindia.com/corporate/PURVA_17092026181100_goregaon.pdf',
};
const story = (id, day, time, headline, publisher, extra = {}) => ({
  id: `news:${id}`, feed: 'news', feedLabel: 'Company news', ticker: 'PURVA', company: COMPANY, day, time, headline,
  importance: 'high', direction: 'neutral', aiEligible: true, namesCompany: true, attribution: confirmed,
  detail: `Published by ${publisher}`, url: `https://${publisher.toLowerCase().replace(/\W+/g, '')}.example/${id}`,
  sourceRecord: { source: publisher }, ...extra,
});
const reports = [
  story('bs', '2026-09-17', '19:30', "Puravankara bags ₹2,600-crore redevelopment project in Mumbai's Goregaon | Business Standard", 'Business Standard'),
  story('et', '2026-09-18', '08:10', 'Puravankara wins Rs 2,600 cr society redevelopment project in Goregaon West - The Economic Times', 'The Economic Times'),
  story('mint', '2026-09-18', '09:40', 'Puravankara shares rise 4% after ₹2,600 crore Goregaon redevelopment win', 'Mint'),
  story('mc', '2026-09-18', '11:02', 'Puravankara secures redevelopment project worth Rs 2,600 crore in Goregaon', 'Moneycontrol'),
  story('whale', '2026-09-19', '10:15', 'Puravankara ki Goregaon mein ₹2,600 Cr ki badi redevelopment deal!', 'Whalesbook'),
];
const unrelatedSameCompany = story('q1', '2026-09-18', '12:00', 'Puravankara Q1 results: net profit falls 20% on lower bookings', 'Mint', { importance: 'high' });
const clarification = { ...bse, id: 'ann:purva-clarify', time: '20:30', day: '2026-09-18',
  headline: 'Puravankara Limited clarifies on news item regarding Goregaon redevelopment project', filingSubject: 'Clarification sought on news item' };
const otherCompany = { ...reports[0], id: 'news:other', ticker: 'OTHER', company: 'Other Realty Ltd',
  headline: 'Other Realty bags ₹2,600-crore redevelopment project in Goregaon', attribution: { ...confirmed, companyTicker: 'OTHER' } };

const events = [...reports, bse, nse, unrelatedSameCompany, clarification, otherCompany];

// ---------------------------------------------------------------------------------------
// 1. The fold itself
// ---------------------------------------------------------------------------------------
{
  const devs = dev.foldDevelopments(events);
  const goregaon = devs.find((d) => d.members.includes(bse));
  assert(goregaon, 'the BSE filing is in a development');
  assert.equal(goregaon.lead, bse, "the company's own BSE filing leads, not a publisher's write-up");
  assert.equal(goregaon.kind, 'filing');
  assert.equal(goregaon.label, 'Corporate announcement', 'the item is labelled a Corporate announcement');
  assert.deepEqual(goregaon.venues, ['BSE', 'NSE'], 'both exchanges are named');
  assert.equal(goregaon.members.length, 7, 'the BSE filing, the NSE copy and all five reports are one development');
  for (const report of reports) assert(goregaon.members.includes(report), `${report.id} folds under the filing`);
  assert(goregaon.members.includes(nse), 'the NSE "Press Release" row with the same statement is an exchange copy');
  assert.equal(goregaon.importance, 'high', 'a folded high-importance report keeps the development material');
  assert.equal(goregaon.importanceFrom?.feed, 'news', '…and says which member made it so');
  assert.equal(dev.developmentLine(goregaon), 'Secures ₹2,600 Cr redevelopment project in Goregaon',
    'LINE 1 is the filing\'s own statement, the company name dropped and the rupee written the Indian way');
  assert.equal(dev.foldedSummary(goregaon), '1 exchange copy · 5 news reports');
  assert.match(dev.foldedList(goregaon, { withLinks: true }), /Business Standard · 2026-09-17 19:30 — .*https:\/\//, 'every folded member is listed with its source, time and link');
  assert.equal(dev.developmentSource(goregaon), 'BSE · NSE');
  for (const separate of [unrelatedSameCompany, clarification, otherCompany]) {
    assert(!goregaon.members.includes(separate), `${separate.id} is a different development`);
  }
  const total = devs.reduce((n, d) => n + d.members.length, 0);
  assert.equal(total, events.length, 'nothing is dropped: every row is in exactly one development');
  assert.equal(new Set(devs.flatMap((d) => d.members)).size, events.length);
  console.log('PASS the Goregaon filing, its NSE copy and five reports fold into one Corporate announcement; the rest stay apart.');
}

// ---------------------------------------------------------------------------------------
// 2. Only the compact fields are read: a pooled event (no source record) folds the same way
// ---------------------------------------------------------------------------------------
{
  const pooled = events.map(({ sourceRecord, ...rest }) => ({ ...rest }));
  const shape = (list) => dev.foldDevelopments(list).map((d) => d.members.map((m) => m.id).sort().join('|')).sort();
  assert.deepEqual(shape(pooled), shape(events), 'the AI pool and the full history fold identically');
  console.log('PASS a pooled event without its source record folds exactly as the full event does.');
}

// ---------------------------------------------------------------------------------------
// 3. Trust: an unverified search match never opens a development anybody else joins
// ---------------------------------------------------------------------------------------
{
  const uncertain = (id, headline) => story(id, '2026-09-20', '10:00', headline, 'Blog', { attribution: { version: ATTRIBUTION_VERSION, status: 'uncertain' } });
  const a = uncertain('u1', 'Mumbai redevelopment market heats up as developers chase Goregaon societies');
  const b = uncertain('u2', 'Goregaon societies redevelopment race: developers chase Mumbai market');
  const devs = dev.foldDevelopments([a, b]);
  assert.equal(devs.length, 2, 'two possible matches never fold into each other');
  const withFiling = dev.foldDevelopments([bse, story('u3', '2026-09-18', '09:00', 'Puravankara secures Rs 2,600 crore Goregaon redevelopment project', 'Blog', { attribution: { version: ATTRIBUTION_VERSION, status: 'uncertain' } })]);
  assert.equal(withFiling.length, 1, 'a possible match may join a development the filing opened');
  const related = story('rel', '2026-09-18', '09:00', 'Puravankara partner secures Rs 2,600 crore Goregaon redevelopment project', 'Blog',
    { attribution: { version: ATTRIBUTION_VERSION, status: 'related', relationships: [{ relationship: 'partner', evidenceUrl: 'https://example.test' }] } });
  assert.equal(dev.foldDevelopments([bse, related]).length, 2, 'a related-entity report is never folded into the company\'s own development');
  console.log('PASS possible matches never open a shared development; related-entity reports never fold.');
}

// ---------------------------------------------------------------------------------------
// 4. Exchange copies: same text, same document, NSE's category form; two filings stay two
// ---------------------------------------------------------------------------------------
{
  const base = { feed: 'announcements', ticker: 'SKY', company: 'Sky Gold Ltd', day: '2026-09-18', importance: 'low', direction: 'neutral' };
  const first = { ...base, id: 'a1', time: '10:00', headline: 'Stream batch first arrival of 120 units', filingSubject: 'Stream batch first arrival of 120 units', url: 'https://www.bseindia.com/1.pdf', detail: 'BSE · General' };
  const second = { ...base, id: 'a2', time: '10:10', headline: 'Stream batch second arrival of 480 units', filingSubject: 'Stream batch second arrival of 480 units', url: 'https://www.bseindia.com/2.pdf', detail: 'BSE · General' };
  assert.equal(dev.foldDevelopments([first, second]).length, 2, 'two filings whose statements differ are two developments, however alike their words');
  const hashA = { ...first, id: 'h1', documentHash: 'abc123' };
  const hashB = { ...second, id: 'h2', day: '2026-09-19', documentHash: 'abc123', feed: 'nse-filings', detail: 'NSE · General', url: 'https://nsearchives.nseindia.com/2.pdf' };
  assert.equal(dev.foldDevelopments([hashA, hashB]).length, 1, 'one document hash is one filing, whatever the time');
  const resign = { ...base, id: 'r1', time: '17:00', headline: 'Resignation of Mr A Kumar as Chief Financial Officer', filingSubject: 'Resignation of Mr A Kumar as Chief Financial Officer', url: 'https://www.bseindia.com/r.pdf' };
  const form = { ...base, id: 'r2', feed: 'nse-filings', time: '17:20', headline: 'Resignation of Director/KMP/SMP', filingSubject: 'Resignation of Director/KMP/SMP', url: 'https://nsearchives.nseindia.com/r.pdf', detail: 'NSE · Resignation' };
  const appoint = { ...base, id: 'r3', feed: 'nse-filings', time: '17:25', headline: 'Appointment of Director/KMP/SMP', filingSubject: 'Appointment of Director/KMP/SMP', url: 'https://nsearchives.nseindia.com/a.pdf', detail: 'NSE · Appointment' };
  const folded = dev.foldDevelopments([resign, form, appoint]);
  assert.equal(folded.find((d) => d.members.includes(resign)).members.includes(form), true, "NSE's resignation form is the resignation's copy");
  assert.equal(folded.find((d) => d.members.includes(resign)).members.includes(appoint), false, '…and never the appointment beside it');
  // Two day-only filings, one of them from a feed that names no exchange, share a word: nothing
  // says they were lodged within the hour or on two exchanges, so they stay two.
  const dayOnlyNse = { ...base, id: 'd1', feed: 'nse-filings', time: null, headline: 'Saved current-day alert', filingSubject: 'Saved current-day alert' };
  const dayOnlyOther = { ...base, id: 'd2', feed: 'announcements', time: null, headline: 'Fast source alert', filingSubject: 'Fast source alert', detail: 'Original evidence' };
  assert.equal(dev.foldDevelopments([dayOnlyNse, dayOnlyOther]).length, 2, 'day-only rows take no rule that needs the hour');
  const timedUnknown = { ...dayOnlyOther, id: 'd3', time: '10:05' };
  const timedNse = { ...dayOnlyNse, id: 'd4', time: '10:00' };
  assert.equal(dev.foldDevelopments([timedNse, timedUnknown]).length, 2, 'a row that names no exchange is not the other exchange\'s copy');
  console.log('PASS exchange copies fold by document, statement and category form; distinct filings stay apart.');
}

// ---------------------------------------------------------------------------------------
// 4b. LINE 1 is short where the exchange's own texts allow it, and never a bare category
// ---------------------------------------------------------------------------------------
{
  const base = { feed: 'announcements', ticker: 'PURVA', company: 'Puravankara Ltd', day: '2026-09-19', time: '12:30', importance: 'high', direction: 'neutral', url: 'https://www.bseindia.com/p6.pdf', detail: 'BSE · General' };
  const phase = { ...base, id: 'p6', headline: 'Product launch', filingSubject: 'Product launch',
    filingHeadline: 'Intimation of launch of phase 6 of the existing project Provident Equinox',
    filingDescription: 'Puravankara Limited has informed the Exchange about launch of Phase 6 in the existing project  Provident Equinox  by Provident Housing Limited a wholly owned subsidiary of Puravankara Limited' };
  assert.equal(dev.developmentLine(dev.foldDevelopments([phase])[0]), 'Launch of phase 6 of the existing project Provident Equinox',
    'the company\'s own short title beats NSE\'s long description, its "Intimation of" dropped');
  const guarantee = { ...base, id: 'g1', headline: 'Giving guarantees/indemnity/ becoming a surety for third party', filingSubject: 'Giving guarantees/indemnity/ becoming a surety for third party',
    filingHeadline: 'Intimation of Corporate Guarantee given on behalf of Purva Blue Agate Private Limited, Wholly Owned Subsidiary of the Company' };
  assert.equal(dev.developmentLine(dev.foldDevelopments([guarantee])[0]), 'Corporate Guarantee given on behalf of Purva Blue Agate Private Limited, Wholly Owned Subsidiary of the Company',
    'a category line that drops the specifics never replaces the statement that names them');
  const amounts = { ...base, id: 'a1', headline: 'Order win', filingSubject: 'Order win',
    filingHeadline: 'Receipt of order worth Rs 450 crore from NHAI for highway project in Maharashtra',
    filingDescription: 'Puravankara Limited has informed the Exchange about receipt of order for highway project in Maharashtra from NHAI' };
  assert.match(dev.developmentLine(dev.foldDevelopments([amounts])[0]), /₹450 Cr/, 'a shorter statement that loses the rupee amount is never chosen');
  console.log('PASS LINE 1 takes the shortest of the exchange\'s own statements that keeps the specifics and every amount.');
}

// ---------------------------------------------------------------------------------------
// 5. All Alerts rows: one per development, nothing lost, the sliced fold is the synchronous one
// ---------------------------------------------------------------------------------------
{
  const stream = [...events].sort((a, b) => `${b.day}${b.time}`.localeCompare(`${a.day}${a.time}`));
  const rows = dev.foldAlertRows(stream);
  const folded = rows.find((row) => row.development?.lead === bse);
  assert(folded, 'the Goregaon development is one row');
  assert.equal(folded.id, bse.id, 'the row carries the lead filing\'s id, so it opens the filing');
  assert.equal(folded.url, bse.url);
  assert.equal(folded.importance, 'high');
  assert.match(folded.importanceReason || '', /folded report by/, 'the row says a folded report made it material');
  assert.equal(rows.filter((row) => row.development === folded.development).length, 1);
  const covered = rows.reduce((n, row) => n + (row.development ? row.development.members.length : 1), 0);
  assert.equal(covered, stream.length, 'every event is either a row or folded under exactly one row');
  assert.equal(dev.foldAlertRows(stream), rows, 'the fold is memoised on the array');
  // A report re-published with the same rows is the same fold: the newest completed one answers it.
  assert.equal(dev.foldAlertRows([...stream]), rows, 'a new array of the same rows reuses the fold');
  assert.equal(dev.foldedAlready([...stream]), true);
  // The two drivers on a sequence nothing has folded yet (the reuse above would otherwise answer).
  // The synchronous side carries one unrelated extra row so it cannot be answered from the sliced
  // side's result either; that row folds with nothing and is set aside before comparing.
  const reversed = [...stream].reverse();
  const sliced = await dev.foldAlertRowsInSlices(reversed, { yieldForInput: () => Promise.resolve(), sliceMs: 0 });
  const extra = { id: 'unrelated-extra', ticker: 'ZZEXTRA', company: 'Unrelated Extra', day: '2026-09-01', time: '09:00',
    headline: 'Board meeting intimation', feed: 'announcements', importance: 'low', direction: 'neutral', url: 'https://example.test/extra' };
  const synchronous = dev.foldAlertRows([...reversed, extra]).filter((row) => row !== extra);
  assert.deepEqual(sliced.map((row) => row.id), synchronous.map((row) => row.id), 'the sliced drive gives the synchronous answer');
  const changed = [...stream];
  changed[0] = { ...changed[0] };
  assert.equal(dev.foldedAlready(changed), false, 'one replaced row is a different sequence, so a new fold');
  assert.equal(await dev.foldAlertRowsInSlices(changed, { yieldForInput: () => Promise.resolve(), keepGoing: () => false, sliceMs: 0 }), undefined,
    'an abandoned fold resolves to nothing, never to a partial answer');
  const single = rows.find((row) => row.id === unrelatedSameCompany.id);
  assert.equal(single, unrelatedSameCompany, 'a row that folds with nothing is the event itself');
  assert.equal(dev.developmentOfRow(single).members.length, 1);
  assert.match(dev.developmentSearchText(folded.development), /Economic Times/, 'search reads every folded member');
  console.log('PASS All Alerts reads one row per development, loses nothing, slices to the same answer and reuses a fold for the same rows.');
}

// ---------------------------------------------------------------------------------------
// 6. The AI card: led by the filing, one evidence row per development, dated by the development
// ---------------------------------------------------------------------------------------
{
  const holdings = [{ ticker: 'PURVA', name: 'Puravankara Limited', sector: 'Realty' }];
  const feeds = ['news', 'announcements', 'nse-filings'].map((id) => ({ id, status: 'ok', reachesToday: true }));
  const rank = (list, day = '2026-09-19') => ai.rankReport({ day, scope: 'portfolio', events: list, feeds },
    { holdings, insightCompanies: [], companyMetadata: [], sectorKpis: null });
  const cardEvents = [...reports, bse, nse, unrelatedSameCompany];
  const card = rank(cardEvents).cards.find((c) => c.ticker === 'PURVA');
  assert(card, 'the company surfaces');
  assert.equal(ai.leadEvent(card), bse, 'the card leads with the BSE filing');
  assert.equal(ai.leadDevelopment(card).label, 'Corporate announcement');
  assert.equal(ai.whatHappened(card), 'Secures ₹2,600 Cr redevelopment project in Goregaon', 'LINE 1');
  assert.equal(card.insight, 'Secures ₹2,600 Cr redevelopment project in Goregaon.', 'the card\'s first bullet is LINE 1 as a sentence');
  const rows = ai.topEvidence(card, 4);
  assert.equal(rows.filter((row) => ai.developmentOfEvent(card, row) === ai.leadDevelopment(card)).length, 1,
    'the development is ONE evidence row, however many reports folded under it');
  assert(rows.includes(unrelatedSameCompany), 'a different development of the same company keeps its own row');
  const pinned = ai.topEvidence(card, 4, { first: reports.at(-1) });
  assert.equal(pinned[0], bse, 'pinning a folded report pins its development\'s lead, never the report as a second row');
  assert.equal(utils.latestAlertSignal(card).day, '2026-09-18', 'the newest development (the result story) dates the card');
  const onlyGoregaon = rank([...reports, bse, nse]).cards.find((c) => c.ticker === 'PURVA');
  assert.equal(utils.latestAlertSignal(onlyGoregaon).day, '2026-09-17', 'a late write-up does not make a two-day-old development today\'s news');
  assert.equal(utils.latestAlertEvent(onlyGoregaon), bse, 'the event that dates the card is the development\'s lead');
  const highBonus = card.scoreBreakdown.find((part) => /high-importance events/.test(part.label));
  assert.equal(highBonus?.label, '2 high-importance events', 'thirty reports of one event are one high-importance event');
  // Archive identity: a further report of the same development does not revive an archived card;
  // a new development does.
  const moreCoverage = rank([...cardEvents, story('late', '2026-09-19', '09:00', 'Puravankara Goregaon redevelopment project worth ₹2,600 crore: what it means', 'Zee Business')]).cards.find((c) => c.ticker === 'PURVA');
  assert.equal(moreCoverage.evidenceKey, card.evidenceKey, 'another write-up of the same development leaves the archive identity unchanged');
  const newOrder = rank([...cardEvents, story('order', '2026-09-19', '09:30', 'Puravankara wins Bengaluru township contract from Karnataka housing board', 'Mint')]).cards.find((c) => c.ticker === 'PURVA');
  assert.notEqual(newOrder.evidenceKey, card.evidenceKey, 'a new development is new material evidence');
  // A card with no developments (a saved snapshot, a fixture) is read exactly as before.
  const bare = { ...card, developments: undefined };
  assert.equal(ai.topEvidence(bare, 4).length, 4);
  console.log('PASS the AI card leads with the filing, shows one row per development, dates by the development and archives by it.');
}

// ---------------------------------------------------------------------------------------
// 7. Scale: a company with a hundred same-minute filings folds without comparing each with all
// ---------------------------------------------------------------------------------------
{
  const many = Array.from({ length: 20_000 }, (_, i) => ({
    id: `cap:${i}`, ticker: `CAP${i % 40}`, company: `Capacity ${i % 40}`, day: '2026-09-04', time: '08:00',
    headline: `Material contract ${i}`, feed: 'announcements', importance: 'high', direction: 'neutral', url: `https://example.test/${i}`,
  }));
  const started = performance.now();
  const devs = dev.foldDevelopments(many);
  const elapsed = performance.now() - started;
  assert.equal(devs.length, many.length, 'distinct filings stay distinct');
  assert(elapsed < 5000, `20,000 same-minute filings fold in bounded time (${Math.round(elapsed)}ms)`);
  console.log(`PASS 20,000 same-minute filings across 40 companies fold in ${Math.round(elapsed)}ms, every one kept apart.`);
}
