import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseFiling, parseIndex, mergeFilings, sourceUrl, day } from './lib/shareholding-filings.mjs';
import { captureShareholdings, captureWindow, truncatedIndex } from './capture-shareholdings.mjs';
import { reconcilePublicHoldings, entityRegistry } from '../public/js/data/public-holdings-shared.js';
import { matchedDeals } from '../public/js/data/investor-changes.js';
import { withVerifiedEntities } from '../public/js/data/holdings-integrity.js';
const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const inline = read('./fixtures/shareholdings/bse-inline.xml'), xml = read('./fixtures/shareholdings/nse-original.xml');
const now = '2026-09-09T20:00:00Z';
const entry = { id: 'bse-example', sourceId: 'bse', company: 'Kesar India', bseCode: '543542', indexAsOf: '2026-09-09', filedAt: now,
  sourceUrl: 'https://www.bseindia.com/XBRLFILES/SHPXBRLDataXML/543542_99202619817_SP.html' };
const bse = parseFiling(inline, entry, now);
assert.equal(bse.asOf, '2026-09-01', 'holding date is the instant context, not the later report-preparation date');
assert.equal(bse.reportDate, '2026-09-09');
assert.deepEqual(bse.holders[0], ['GOPAL GUPTA', 18585747, 57.13, '2026-09-01']);
const nseEntry = { id: 'nse-example', sourceId: 'nse-sme', isin: 'INE0JZA01018', sourceUrl: 'https://nsearchives.nseindia.com/corporate/xbrl/SHP_1722705_08092026075634_WEB.xml', filedAt: now };
const nse = parseFiling(xml, nseEntry, now);
assert.deepEqual(nse.holders[0], ['RAMJI SHRINARAYAN PANDEY', 2472000, 19.4, '2026-08-20'], 'raw XBRL ratios and inline scale=-2 both become percentage points');
assert.equal(nse.reportDate, '2026-09-08');
assert.throws(() => parseFiling(xml, { ...nseEntry, isin: 'INE806C01018' }), /ISIN disagrees/);
const oldIndex = { ...nseEntry, isin: 'INE806C01018', ticker: nse.ticker };
const securityMaster = { [nse.bseCode || '999999']: { isin: nse.isin, ticker: nse.ticker } };
const withCode = xml.replace('</xbrli:xbrl>', '<in-bse-fin:ScripCode contextRef="MainI">999999</in-bse-fin:ScripCode></xbrli:xbrl>');
assert(parseFiling(withCode, oldIndex, now, securityMaster).identityNote, 'an obsolete index ISIN requires independently agreeing scrip, symbol and ISIN');
assert.throws(() => parseFiling(withCode, { ...oldIndex, ticker: 'OTHER' }, now, securityMaster), /ISIN disagrees/);
assert(parseFiling(xml, oldIndex, now, {}, { [nse.ticker]: { isin: nse.isin } }).identityNote, 'NSE-only equities can use the independent NSE master');
assert.equal(day('2026-02-30'), null);
assert.throws(() => parseFiling('only for testing purposes' + inline, entry), /testing data/);
assert.throws(() => parseFiling('<html>Access denied</html>', entry), /No XBRL/);
assert.throws(() => sourceUrl('https://evil.example/filing.xml'), /Unexpected/);
assert.throws(() => sourceUrl('javascript:alert(1)'), /Unexpected/);
const wrongCount = inline.replace('18585747', '18X');
assert.equal(parseFiling(wrongCount, entry).status, 'partial', 'unreadable counts must be an explicit parse exception');
assert.equal(parseFiling(wrongCount, entry).holders.length, 0);
const pac = inline.replaceAll('DetailsSharesHeldByIndividualsOrHUFAxis', 'DetailsOfTheShareholdersActingAsPersonsInConcertForPublicAxis');
assert.equal(parseFiling(pac, entry).holders.length, 0, 'concert-party counts cannot be assigned to an individual holder');
assert.equal(parseFiling(inline.replaceAll('DetailsSharesHeldByIndividualsOrHUFAxis', 'DetailsOfSharesHeldByCustodianOrDRHolderAxis'), entry).holders.length, 0, 'depository receipts held in custody are not attributed as investment positions');
assert.throws(() => parseIndex({ Table: 'No Record Found' }, 'bse'), /not an array/);
assert.throws(() => parseIndex([{ name: 'Example' }], 'nse-equities'), /Incomplete/);
assert.deepEqual(captureWindow(now), { from: '2026-03-31', to: '2026-09-09' });
const retained = mergeFilings({ filings: [bse] }, [entry], [{ ...entry, status: 'failed', error: 'outage' }], [], now);
assert.equal(retained.filings[0].holders[0][1], 18585747);
assert.equal(retained.filings[0].checkedAt, bse.checkedAt);
assert.equal(retained.filings[0].error, 'outage');
const changed = mergeFilings({ filings: [bse] }, [entry], [{ ...bse, sha256: 'b'.repeat(64), checkedAt: '2026-09-10T20:00:00Z' }], [], now);
assert.equal(changed.filings.length, 2, 'changed source bytes at the same URL retain the prior captured version');
assert(changed.filings.some((f) => f.supersededBy === bse.id && f.sha256 === bse.sha256));
const newerEntry = { ...entry, id: 'newer', filedAt: '2026-09-10T20:00:00Z' };
const supersededFailure = mergeFilings({ filings: [{ ...entry, status: 'failed', error: 'old URL unavailable' }] }, [newerEntry], [{ ...bse, ...newerEntry }], [], now);
assert.equal(supersededFailure.filings.find((f) => f.id === entry.id).supersededBy, newerEntry.id, 'an unread old URL stops being pending when its replacement is captured');

const person = { slug: 'investor', name: 'Example Investor' }, fund = 'Example Opportunity Fund I';
const evidence = { relations: [{ entityId: 'fund-i', legalName: fund, investorSlugs: ['investor'], managerIds: ['manager'],
  relationship: 'Associated fund', sourceUrl: 'https://example.com/official-team', verifiedAt: '2026-09-09' }] };
const snapshot = { investors: [person], books: { investor: { quarters: ['Jun 2026', 'Mar 2026'], fetchedAt: now, holdings: [
  { company: 'Example company', companySlug: 'EXAMPLE', quarterlyHoldings: { 'Jun 2026': 1.2, 'Mar 2026': 1 } },
  { company: 'Unmapped company', companySlug: 'UNMAPPED', quarterlyHoldings: { 'Jun 2026': 2 } },
] } } };
const managers = { managers: [{ id: 'manager', name: 'Manager' }] };
const f = { ...bse, id: 'original', ticker: 'EXAMPLE', asOf: '2026-06-30', filedAt: '2026-07-01T01:00:00Z', holders: [
  ['Example Investor', 100, 1.1, '2026-06-30'], [fund, 200, 2, '2026-06-30'], ['Example Investor HUF', 300, 3, '2026-06-30'],
] };
const revised = { ...f, id: 'revision', filedAt: '2026-07-03T01:00:00Z', holders: [['Example Investor', 120, 1.2, '2026-06-30'], ...f.holders.slice(1)] };
let report = reconcilePublicHoldings({ archive: { filings: [f, revised] }, snapshot, managers, evidence, now });
assert.equal(report.holdings.find((h) => !h.associated).shares, 120, 'revised filing replaces the original at that date');
assert.equal(report.holdings.find((h) => !h.associated).comparison, 'agrees');
assert.equal(report.holdings.filter((h) => h.legalHolder === fund).length, 2, 'the fund can appear in investor and manager audiences without losing its legal holder');
assert.equal(report.holdings.some((h) => h.legalHolder.includes('HUF')), false, 'name resemblance never attributes a family entity');
assert.equal(report.candidates.length, 1);
for (const ticker of ['NOTLISTED', 'NOTLSITED', 'Not listed', 'NA', 'N/A', 'NIL', '-']) {
  const placeholder = reconcilePublicHoldings({ archive: { filings: [{ ...revised, ticker }] }, snapshot, managers, evidence, now });
  assert(placeholder.holdings.every(h => h.ticker === revised.bseCode), `${ticker} is a filing placeholder, not a listed company symbol`);
}
const legalNames = { relations: [{ entityId: 'example-person', legalName: 'Example Fullname Investor', investorSlugs: ['investor'], kind: 'same-person', sourceUrl: 'https://example.com/issuer', verifiedAt: '2026-09-09' }] };
const nameVariant = { ...revised, sourceId: 'nse-equities', id: 'full-name', holders: [['Example Fullname Investor', 120, 1.2, '2026-06-30']] };
const identityReport = reconcilePublicHoldings({ archive: { filings: [revised, nameVariant] }, snapshot, managers, evidence: legalNames, now });
assert.equal(identityReport.holdings.length, 1, 'verified name variants of one legal person merge across exchanges');
assert.equal(identityReport.holdings[0].sources.length, 2);
const bseOnlyBook = { ...snapshot, books: { investor: { ...snapshot.books.investor, holdings: [{ company: f.company, companySlug: 'SOURCE_ONLY_TICKER', quarterlyHoldings: { 'Jun 2026': 1.2 } }] } } };
assert.equal(reconcilePublicHoldings({ archive: { filings: [revised] }, snapshot: bseOnlyBook, now }).holdings[0].comparison, 'agrees', 'exact unique company names resolve source-only symbols for BSE companies');
const oldSecurity = { ...revised, id: 'before-split', asOf: '2026-03-31', isin: 'INE806C01018', holders: [['Example Investor', 100, 1, '2026-03-31']] };
const splitReport = reconcilePublicHoldings({ archive: { filings: [oldSecurity, revised] }, snapshot, now });
assert(splitReport.holdings.every((h) => h.comparison === 'agrees'), 'an ISIN change must use the security identity for the relevant holding date');
assert(report.issues.some((i) => i.type === 'primary-unconfirmed' && i.company === 'Unmapped company'));
const extra = { ...revised, id: 'additional', isin: 'INE806C01018', ticker: 'TIL' };
report = reconcilePublicHoldings({ archive: { filings: [revised, extra] }, snapshot, managers, evidence, now });
assert(report.holdings.some((h) => h.ticker === 'TIL' && h.legalHolder === fund), 'verified funds discover holdings beyond the existing source book');
assert(!report.holdings.some((h) => h.ticker === 'TIL' && !h.associated), 'a directory name alone cannot attribute a previously unknown company to that person');
assert(report.candidates.some((c) => c.legalName === person.name), 'new-company exact names remain visible in the identity review queue');
const conflicting = { ...revised, id: 'other-exchange', sourceId: 'nse-equities', holders: [['Example Investor', 130, 1.3, '2026-06-30']] };
report = reconcilePublicHoldings({ archive: { filings: [revised, conflicting] }, snapshot, managers, evidence, now });
assert.equal(report.holdings.find((h) => !h.associated).state, 'source-conflict');
assert(report.issues.some((i) => i.type === 'source-conflict'));
assert(!report.issues.some((i) => i.type === 'stake-difference'), 'conflicting source figures must not become a chosen Finology comparison');
const later = { ...revised, id: 'later', asOf: '2026-08-01', filedAt: now, holders: [['Another holder', 1, 0.1, '2026-08-01']] };
report = reconcilePublicHoldings({ archive: { filings: [revised, later] }, snapshot, managers, evidence, now });
assert(report.holdings.every((h) => h.state === 'historical-disclosure'), 'an earlier holding must not look current after a later issuer filing');
assert.equal(entityRegistry(snapshot, managers, evidence, '2027-01-01').names.has('exampleopportunityfundi'), false, 'expired identity evidence needs renewed review');
const peers = withVerifiedEntities([{ id: 'investor', name: person.name }, { id: 'fund-profile', name: 'Fund profile' }], { relations: [{ ...evidence.relations[0], investorSlugs: ['investor', 'fund-profile'] }] }, 'investor', now);
const trade = { ticker: 'EXAMPLE', date: '2026-09-09', cells: { 'Trade Category': 'Bulk deal', Insider: fund, Transaction: 'Buy' } };
assert.equal(matchedDeals([trade], peers).length, 2, 'explicitly linked fund and investor profiles both see the same reported legal holder');
assert.equal(matchedDeals([trade], [...peers, { id: 'unverified', name: fund }]).length, 0, 'unverified collisions stay unresolved');

const rawIndex = { FLD_ScripCode: 543542, Company_NAme: 'Kesar India', EndDate: '2026-09-09', D: '2026-09-09T19:08:00', XBRLAttachment: entry.sourceUrl };
const captured = await captureShareholdings({}, { now, concurrency: 1, fetchText: async (url) => {
  if (url.includes('Corp_Shareholding')) return JSON.stringify({ Table: [rawIndex] });
  if (url.includes('corporate-share-holdings-master')) throw new Error('NSE unavailable');
  return inline;
} });
assert.equal(captured.filings[0].status, 'parsed');
assert.equal(captured.sources.filter((s) => !s.ok).length, 2);
assert.equal(captured.operationalFailure, true);

// A QUARTER ROLLOVER IS NOT A TRUNCATED INDEX (2 October 2026). The window starts a quarter later,
// and most SME issuers file half-yearly, so the March filings leave the SME index and its count
// falls sharply while every row it still covers is present. Only rows dated where both windows
// overlap may be compared; a real loss inside that overlap is still refused.
{
  const sme = (n, asOf, from = 0, sourceId = 'nse-sme') => Array.from({ length: n }, (_, i) => ({ id: `${sourceId}-${from + i}-${asOf}`, sourceId,
    company: `SME ${from + i}`, ticker: `SME${from + i}`, isin: `INE${String(from + i).padStart(9, '0')}`, indexAsOf: asOf, filedAt: `${asOf}T10:00:00+05:30`, sourceUrl: null }));
  const archive = [...sme(549, '2026-03-31'), ...sme(57, '2026-06-30', 1000)];
  const prior = { id: 'nse-sme', from: '2026-03-31', to: '2026-09-30', indexed: 825, ok: true };
  const rolled = [...sme(57, '2026-06-30', 1000), ...sme(3, '2026-10-01', 2000)];
  assert.equal(truncatedIndex(rolled, prior, archive, 'nse-sme', '2026-06-30'), false, 'the half-yearly March filings leaving the window is not a truncation');
  const busy = [...archive, ...sme(300, '2026-06-30', 3000)];
  assert.equal(truncatedIndex(rolled, prior, busy, 'nse-sme', '2026-06-30'), true, 'losing most of the rows both windows cover is still refused');
  assert.equal(truncatedIndex(rolled, prior, busy.map((f) => ({ ...f, sourceId: 'nse-equities' })), 'nse-sme', '2026-06-30'), false, "another source's rows are not this source's baseline");
  const same = { ...prior, from: '2026-06-30', to: '2026-10-01', indexed: 400 };
  assert.equal(truncatedIndex(sme(150, '2026-06-30'), same, busy, 'nse-sme', '2026-06-30'), true, 'inside one window the row count comparison is unchanged');
  assert.equal(truncatedIndex(sme(250, '2026-06-30'), same, busy, 'nse-sme', '2026-06-30'), false);
  assert.equal(truncatedIndex(sme(1, '2026-06-30'), { ...prior, indexed: 90 }, busy, 'nse-sme', '2026-06-30'), false, 'a small source is not guarded, as before');
  // Wired through the capture with the archive it actually reads.
  const nseRow = (f) => ({ name: f.company, symbol: f.ticker, isin: f.isin, date: f.indexAsOf, broadcastDate: `${f.indexAsOf} 10:00:00` });
  const rolledCapture = await captureShareholdings({ sources: [prior], filings: archive }, { now: '2026-10-02T08:00:00Z', maxFiles: 0, fetchText: async (url) => {
    if (url.includes('index=sme')) return JSON.stringify(rolled.map(nseRow));
    throw new Error('not needed here');
  } });
  const smeSource = rolledCapture.sources.find((s) => s.id === 'nse-sme');
  assert.equal(smeSource.ok, true, `the rolled SME index is read (${smeSource.error})`);
  assert.deepEqual([smeSource.from, smeSource.indexed], ['2026-06-30', 60]);
  const truncatedCapture = await captureShareholdings({ sources: [prior], filings: busy }, { now: '2026-10-02T08:00:00Z', maxFiles: 0, fetchText: async (url) => {
    if (url.includes('index=sme')) return JSON.stringify(rolled.map(nseRow));
    throw new Error('not needed here');
  } });
  assert.match(truncatedCapture.sources.find((s) => s.id === 'nse-sme').error, /sharply truncated/);
}
// A pending filing does not vanish from collection when its quarter leaves the index window.
const oldPending = { ...entry, id: 'old-pending', indexAsOf: '2025-12-31', sourceUrl: 'https://www.bseindia.com/old-pending.xml', status: 'failed', lastAttemptAt: '2026-09-01T00:00:00Z' };
let oldReads = 0, checkpoints = 0;
const resumed = await captureShareholdings({ ...captured, filings: [...captured.filings, oldPending] }, { now, maxFiles: 1, concurrency: 1, checkpoint: () => { checkpoints++; }, fetchText: async (url) => {
  if (url.includes('Corp_Shareholding')) return JSON.stringify({ Table: [rawIndex] });
  if (url.includes('corporate-share-holdings-master')) throw new Error('NSE unavailable');
  if (url === oldPending.sourceUrl) oldReads++;
  return inline;
} });
assert.equal(oldReads, 1, 'unread historical attachment resumes outside the new index window');
assert(resumed.filings.find((f) => f.id === oldPending.id).holders.length > 0);
assert(checkpoints > 0, 'progress is saved before any filing read');
const archivePath = new URL('../public/data/shareholding-filings.json.gz', import.meta.url);
if (existsSync(archivePath)) {
  const actual = JSON.parse(gunzipSync(readFileSync(archivePath)));
  assert.equal(actual.sources.length, 3);
  for (const filing of actual.filings.filter((f) => f.holders)) {
    assert(/^IN[A-Z0-9]{10}$/.test(filing.isin)); assert(/^\d{4}-\d{2}-\d{2}$/.test(filing.asOf));
    assert(/^[a-f0-9]{64}$/.test(filing.sha256)); sourceUrl(filing.sourceUrl);
    for (const [holder, shares, pct, date] of filing.holders) { assert(holder && Number.isSafeInteger(shares) && shares >= 0 && pct >= 0 && pct <= 100 && date); }
  }
  const published = JSON.parse(read('../public/data/public-holdings.json'));
  const regenerated = reconcilePublicHoldings({ archive: actual, snapshot: JSON.parse(read('../public/data/super-investors.json')), managers: {},
    evidence: existsSync(new URL('../public/data/holding-evidence.json', import.meta.url)) ? JSON.parse(read('../public/data/holding-evidence.json')) : {}, exchange: existsSync(new URL('../public/data/exchange-deals.json', import.meta.url)) ? JSON.parse(read('../public/data/exchange-deals.json')) : {}, now: published.checkedAt });
  if (process.env.PUBLIC_HOLDINGS_VERIFY_CURRENT === '1') assert.deepEqual(JSON.parse(JSON.stringify(regenerated)), published, 'published attribution must match the current evidence and archive');
}
{
  const published = reconcilePublicHoldings({ archive: { checkedAt: now, filings: [revised], sources: [] }, snapshot, evidence, now });
  const feed = await import('../public/js/data/public-holdings.js');
  const originalFetch = globalThis.fetch;
  try {
    let payload = JSON.parse(read('../public/data/public-holdings.json'));
    globalThis.fetch = async () => Response.json(payload);
    if (payload.status === 'not-started') {
      await feed.refresh();
      assert.equal(feed.report(), null, 'an unstarted capture does not become a checked empty portfolio');
      assert.equal(feed.lastError(), 'Exchange capture has not started');
    }
    payload = structuredClone(published);
    await feed.refresh();
    const retainedReport = feed.report();
    payload = {version:1,status:'not-started'};
    await feed.refresh();
    assert.equal(feed.report(), retainedReport, 'an unstarted deployment cannot erase captured evidence');
    payload = structuredClone(published);
    await feed.refresh();
    assert.equal(feed.newArrivals().length, 0, 'initial backlog is quiet');
    payload = { ...payload, checkedAt: new Date().toISOString(), holdings: [...payload.holdings, { ...payload.holdings.find((h) => h.state === 'latest-disclosure' && h.shares > 0), id: 'new-associated-disclosure', associated: true }] };
    await feed.refresh();
    assert.equal(feed.newArrivals().length, 1, 'new associated fund disclosures generate in-app alerts too');
    await feed.refresh();
    assert.equal(feed.newArrivals().length, 1, 'repeated captures do not duplicate alerts');
    globalThis.fetch = async () => Response.json({ ...payload, checkedAt: '2090-01-01T00:00:00Z' });
    await feed.refresh();
    assert.equal(feed.report().checkedAt, payload.checkedAt, 'a future timestamp cannot poison retained evidence');
    globalThis.fetch = async () => Response.json({}, { status: 503 });
    await feed.refresh();
    assert.equal(feed.report().checkedAt, payload.checkedAt);
    assert(feed.lastError(), 'failed fetch preserves evidence and surfaces failure');
    globalThis.fetch = async () => Response.json({ ...payload, coverage: {} });
    await feed.refresh();
    assert(feed.lastError(), 'malformed coverage cannot replace a usable report');
  } finally { globalThis.fetch = originalFetch; }
}
console.log('PASS public holdings: original XBRL dates/units, PAC exclusion, blocked/provisional sources, revisions, retention, all-company discovery, exact/ambiguous identities, source conflicts, reverse reconciliation and published archive');
