import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCompanySources, captureCompanies, readJson, writeJson, mergeRanges, missingRanges, nextRange } from './lib/company-capture.mjs';
import { archiveFilings } from './lib/filing-archive.mjs';
import { companyCaptureStatus, loadCompanyCaptureIndex } from '../public/js/data/company-captures.js';
import { withFilingArchive } from '../public/js/data/filing-archives.js';
import { clearAll } from '../public/js/core/store.js';
import { mergeAnnouncements } from '../public/js/data/announcements-shared.js';
import { enrichCrossExchangeDocumentHashes, expandCrossExchangeObservations } from './lib/announcement-document-hashes.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'sattva-capture-'));
const originalFetch = globalThis.fetch;
try {
  let clock = Date.parse('2026-09-04T12:00:00Z');
  const calls = [];
  const companies = [{ ticker: 'A', name: 'Company A' }, { ticker: 'B', name: 'Company B' }];
  const doc = { ticker: 'A', form: 'annual_report', title: 'Annual report', url: 'https://example.com/report.pdf' };
  const ann = { ticker: 'A', date: '2026-09-04', title: 'Board meeting', url: 'https://example.com/meeting.pdf', source: 'NSE' };
  const request = async (kind, ticker, range) => {
    calls.push({ kind, ticker, range, at: clock });
    return { ok: true, documents: [{ ...doc, ticker }], announcements: [{ ...ann, ticker }], skipped: 0 };
  };
  const options = { dir: join(scratch, 'capture'), companies, request, now: () => clock,
    sleep: async (ms) => { clock += ms; }, concurrency: 3, spacingMs: 2500 };
  let index = await captureCompanySources({ ...options, maxRequests: 1 });
  const createdAt = index.createdAt;
  assert.equal(calls.length, 1);
  assert(index.sources.announcements.A.lastSuccessAt);
  assert(!index.sources.announcements.B.lastSuccessAt, 'unreached companies remain explicit');
  assert(!index.sources.domestic.A.lastSuccessAt);
  clock += 3600000;
  index = await captureCompanySources({ ...options, maxRequests: 3 });
  assert.equal(index.createdAt, createdAt, 'a new run cannot reset the initial coverage grace period');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((c) => `${c.kind}/${c.ticker}`), ['announcements/B', 'domestic/A', 'domestic/B'], 'restart reaches the remaining companies before repeating work');
  assert(calls[2].at - calls[1].at >= 2500 && calls[3].at - calls[2].at >= 2500, 'one rate gate across concurrent workers');
  assert(index.sources.domestic.B.lastSuccessAt);

  clock += 86400000;
  const prior = readJson(join(options.dir, 'announcements/A.json'));
  index = await captureCompanySources({ ...options, maxRequests: 1, request: async () => ({ ok: true, announcements: [], skipped: 0 }) });
  assert.deepEqual(readJson(join(options.dir, 'announcements/A.json')).rows, prior.rows, 'empty answers cannot retract captured events');
  const rowsBeforeFailure = readJson(join(options.dir, 'announcements/B.json')).rows;
  const rangesBefore = index.sources.announcements.B.ranges;
  index = await captureCompanySources({ ...options, maxRequests: 1, request: async () => ({ ok: false, reason: 'unauthorised', message: 'Session expired' }) });
  assert.equal(index.stoppedForAuth, true);
  assert.deepEqual(index.sources.announcements.B.ranges, rangesBefore, 'failure does not advance date coverage');
  assert.deepEqual(readJson(join(options.dir, 'announcements/B.json')).rows, rowsBeforeFailure);
  assert.equal(index.sources.announcements.B.error.reason, 'unauthorised');
  const floor = index.requestedFrom;
  clock += 86400000;
  index = await captureCompanySources({ ...options, maxRequests: 0 });
  assert.equal(index.requestedFrom, floor, 'unread backfill dates never fall out of a moving window');

  const partialDir = join(scratch, 'partial');
  const partial = await captureCompanySources({ ...options, dir: partialDir, maxRequests: 1,
    request: async () => ({ ok: true, announcements: [ann], skipped: 1 }) });
  assert.equal(readJson(join(partialDir, 'announcements/A.json')).rows.length, 1, 'good rows in a partial response are saved');
  assert(partial.sources.announcements.A.error);
  assert.equal(partial.sources.announcements.A.ranges.length, 0, 'partial response stays incomplete');
  const budgetCalls = [];
  await captureCompanySources({ ...options, dir: join(scratch, 'budget'), budgetMs: 1000,
    request: async (...args) => { budgetCalls.push(args); return request(...args); } });
  assert.equal(budgetCalls.length, 1, 'time budget exits with enough margin to publish checkpoints');

  assert.deepEqual(mergeRanges([{ from: '2026-01-01', to: '2026-01-03' }], { from: '2026-01-04', to: '2026-01-09' }), [{ from: '2026-01-01', to: '2026-01-09' }]);
  assert.deepEqual(missingRanges([{ from: '2026-01-03', to: '2026-01-04' }], '2026-01-01', '2026-01-06'), [{ from: '2026-01-01', to: '2026-01-02' }, { from: '2026-01-05', to: '2026-01-06' }]);
  const recent = new Date(clock).toISOString();
  assert.deepEqual(nextRange({ recentCheckedAt: recent, ranges: [{ from: '2026-08-01', to: '2026-09-04' }] }, '2025-09-05', '2026-09-04', clock), { from: '2026-07-01', to: '2026-07-31' });

  writeJson(join(scratch, 'universe.json'), [{ Company: 'Only in raw universe', 'Screener URL': 'https://www.screener.in/company/RAW/' }]);
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ ticker: 'BOOK' }, { name: 'Unresolved' }] });
  writeJson(join(scratch, 'technicals.json'), { companies: [{ ticker: 'TECH' }, { ticker: 'BOOK' }] });
  assert.deepEqual(captureCompanies(scratch).companies.map((c) => c.ticker), ['BOOK', 'RAW', 'TECH']);
  assert.deepEqual(captureCompanies(scratch).unresolved, ['Unresolved']);
  writeJson(join(scratch, 'announcement-identities.json'), { entries: [{ isin: 'INE000000001', ticker: 'BSEONLY', bseSymbol: 'BSEONLY', bseCode: '500001' }] });
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ isin: 'INE000000001', name: 'BSE-only holding' }] });
  const mappedBook = captureCompanies(scratch, { announcements: true }).companies.find(c => c.ticker === 'BSEONLY');
  assert.equal(mappedBook.announcementTicker, 'BSEONLY');
  assert.equal(mappedBook.bseCode, '500001', 'a verified BSE code follows the company into automatic capture');
  assert.equal(mappedBook.priority, true);
  writeJson(join(scratch, 'portfolio-companies.json'), { holdings: [{ ticker: 'ALPEXSOLAR-SM', name: 'Alpex Solar' }] });
  assert.equal(captureCompanies(scratch, { announcements: true }).companies[0].announcementTicker, 'ALPEXSOLAR');

  const aliasDir = join(scratch, 'portfolio-alias');
  writeJson(join(aliasDir, 'announcement-identities.json'), { entries: [{ isin: 'INE094B01013',
    ticker: 'ASHIKAG', bseCode: '543766', name: 'Ashika Global Securities' }] });
  writeJson(join(aliasDir, 'universe.json'), [{ ticker: 'ASHIKA', name: 'Ashika Credit Capital' }]);
  const aliasHoldings = [{ ticker: 'ASHIKA', isin: 'INE094B01013', name: 'Ashika Credit Capital' }];
  const aliasScope = captureCompanies(aliasDir, { announcements: true, holdings: aliasHoldings });
  assert.equal(aliasScope.companies.length, 1, 'an unresolved universe alias cannot create a second storage ticker');
  assert.equal(aliasScope.companies[0].announcementTicker, 'ASHIKAG');
  assert.equal(aliasScope.companies[0].priority, true);
  const aliasCalls = [];
  const aliasOptions = { ...options, dir: join(aliasDir, 'capture'), companies: aliasScope.companies, maxRequests: 1,
    request: async (kind, ticker, range, company, context) => {
      aliasCalls.push({ kind, ticker, company, context });
      return { ok: true, announcements: [], bse: { ok: true, announcements: [], declared: 0, collected: 0, pages: 1, requests: 1 } };
    } };
  const aliasFirst = await captureCompanySources(aliasOptions);
  const aliasSecond = await captureCompanySources({ ...aliasOptions, maxRequests: 0 });
  assert.equal(aliasCalls[0].company.announcementTicker, 'ASHIKAG');
  assert.equal(aliasCalls[0].context.bseCode, '543766');
  assert.equal(aliasSecond.sources.announcements.ASHIKA.priority, true);
  assert.equal(aliasSecond.sources.announcements.ASHIKA.lastSuccessAt, aliasFirst.sources.announcements.ASHIKA.lastSuccessAt,
    'a later run cannot reset the verified alias watermark');
  writeJson(join(aliasDir, 'universe.json'), [{ ticker: 'ASHIKA', isin: 'INE000000099' }]);
  assert.throws(() => captureCompanies(aliasDir, { announcements: true, holdings: aliasHoldings }), /Conflicting company identities/,
    'an explicitly different issuer cannot overwrite a shared capture ticker');
  writeJson(join(aliasDir, 'universe.json'), [{ ticker: 'ASHIKA', bseCode: '500099' }]);
  assert.throws(() => captureCompanies(aliasDir, { announcements: true, holdings: aliasHoldings }), /Conflicting company identities/,
    'an unrecognized explicit BSE code is not a less-specific ticker alias');

  const priorityDir = join(scratch, 'priority');
  const recentEntry = { lastAttemptAt: recent, lastSuccessAt: recent, recentCheckedAt: recent,
    ranges: [{ from: '2026-08-29', to: dayForTest(clock) }], rowCount: 0 };
  function dayForTest(t) { return new Date(t).toISOString().slice(0, 10); }
  const background = Array.from({ length: 8 }, (_, i) => ({ ticker: `U${i}` }));
  const prioritised = [{ ticker: 'BOOK', priority: true }, ...background];
  const savedEntries = Object.fromEntries(prioritised.map(c => [c.ticker, { ...recentEntry, lastAttemptAt: c.priority ? recent : '2026-01-01T00:00:00Z' }]));
  writeJson(join(priorityDir, 'index.json'), { version: 1, sources: { announcements: savedEntries,
    domestic: Object.fromEntries(prioritised.map(c => [c.ticker, { rowCount: 0, ranges: [], lastAttemptAt: '2026-01-01T00:00:00Z' }])) } });
  const priorityCalls = [];
  await captureCompanySources({ ...options, dir: priorityDir, companies: prioritised, maxRequests: 3,
    request: async (kind, ticker, range, company) => { priorityCalls.push({ kind, ticker, range, company }); return { ok: true, announcements: [], documents: [] }; } });
  assert.equal(priorityCalls[0].ticker, 'BOOK', 'portfolio history precedes repeatedly visited universe companies');
  assert(priorityCalls[0].range.to < dayForTest(clock), 'fresh portfolio companies progress through older history');
  assert.equal(priorityCalls[2].kind, 'domestic', 'announcement priority cannot starve the other source');

  const firstRunPriorityCalls = [];
  await captureCompanySources({ ...options, dir: join(scratch, 'first-run-priority'),
    companies: [{ ticker: 'BACKGROUND' }, { ticker: 'NEWBOOK', priority: true }], maxRequests: 1,
    request: async (kind, ticker) => { firstRunPriorityCalls.push(`${kind}/${ticker}`); return { ok: true, announcements: [], documents: [] }; } });
  assert.equal(firstRunPriorityCalls[0], 'announcements/NEWBOOK', 'a newly enrolled portfolio company wins an equal first-run queue rank');

  const clockBeforeOfficialTests = clock;
  const officialDir = join(scratch, 'official-bse');
  const kissht = { ticker: 'KISSHT', name: 'OnEMI Technology Solutions', announcementTicker: 'KISSHT',
    bseCode: '544754', priority: true };
  const nseRow = { ticker: 'KISSHT', date: dayForTest(clock), title: 'NSE investor meeting',
    url: 'https://nsearchives.nseindia.com/corporate/kissht-nse.pdf', source: 'NSE', sources: ['NSE'] };
  const bseRow = { ticker: 'KISSHT', date: dayForTest(clock), title: 'BSE investor meeting',
    url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/kissht-bse.pdf', source: 'BSE', sources: ['BSE'],
    providers: ['BSE company index'] };
  let officialContext;
  let official = await captureCompanySources({ ...options, dir: officialDir, companies: [kissht], maxRequests: 1,
    request: async (kind, ticker, range, company, context) => {
      officialContext = { kind, ticker, range, company, context };
      return { ok: true, announcements: [nseRow], skipped: 0,
        bse: { ok: true, announcements: [bseRow], skipped: 0, declared: 1, collected: 1, pages: 1, requests: 1 } };
    } });
  assert.equal(officialContext.context.bseCode, '544754');
  assert.deepEqual(officialContext.context.bseRange, officialContext.range, 'a new holding starts both source histories with the recent overlap');
  assert(official.sources.announcements.KISSHT.lastSuccessAt);
  assert(official.sources.announcements.KISSHT.bse.lastSuccessAt);
  assert.deepEqual(official.sources.announcements.KISSHT.bse.ranges, official.sources.announcements.KISSHT.ranges);
  assert.equal(official.sources.announcements.KISSHT.bse.declared, 1);
  assert.equal(official.sources.announcements.KISSHT.bse.rowCount, 1, 'direct BSE coverage counts provider-proven rows');
  assert.deepEqual(new Set(readJson(join(officialDir, 'announcements/KISSHT.json')).rows.flatMap(row => row.sources)), new Set(['NSE', 'BSE']));

  const bseRanges = structuredClone(official.sources.announcements.KISSHT.bse.ranges);
  const bseSuccessAt = official.sources.announcements.KISSHT.bse.lastSuccessAt;
  clock += 86400000;
  const nextNse = { ...nseRow, date: dayForTest(clock), url: 'https://nsearchives.nseindia.com/corporate/kissht-next.pdf' };
  official = await captureCompanySources({ ...options, dir: officialDir, companies: [kissht], maxRequests: 2,
    request: async (kind) => kind === 'domestic' ? { ok: true, documents: [], skipped: 0 } :
      ({ ok: true, announcements: [nextNse], skipped: 0,
        bse: { ok: false, reason: 'upstream', message: 'BSE temporarily unavailable' } }) });
  const retained = readJson(join(officialDir, 'announcements/KISSHT.json')).rows;
  assert(retained.some(row => row.url === bseRow.url), 'a BSE failure cannot retract the last good BSE row');
  assert(retained.some(row => row.url === nextNse.url), 'a BSE failure cannot block a successful NSE/Muns row');
  assert.equal(official.sources.announcements.KISSHT.error, null);
  assert.deepEqual(official.sources.announcements.KISSHT.bse.ranges, bseRanges, 'failed BSE windows never advance BSE coverage');
  assert.equal(official.sources.announcements.KISSHT.bse.lastSuccessAt, bseSuccessAt);
  assert.equal(official.sources.announcements.KISSHT.bse.error.reason, 'upstream');

  const authDir = join(scratch, 'official-bse-auth');
  const auth = await captureCompanySources({ ...options, dir: authDir, companies: [kissht], maxRequests: 1,
    request: async () => ({ ok: false, reason: 'unauthorised', message: 'Session expired',
      bse: { ok: true, announcements: [bseRow], skipped: 0, declared: 1, collected: 1, pages: 1, requests: 1 } }) });
  assert.equal(auth.stoppedForAuth, true, 'the authenticated lane reports its outage while independent BSE work continues');
  assert.equal(auth.sourceOutages.authenticatedAnnouncements.reason, 'unauthorised');
  assert.equal(auth.sources.announcements.KISSHT.error.reason, 'unauthorised');
  assert.equal(auth.sources.announcements.KISSHT.ranges.length, 0, 'failed Muns coverage remains open');
  assert(auth.sources.announcements.KISSHT.bse.lastSuccessAt, 'BSE is checkpointed before the authenticated source stops the run');
  assert.equal(readJson(join(authDir, 'announcements/KISSHT.json')).rows[0].source, 'BSE');

  const thrownAuth = await captureCompanySources({ ...options, dir: join(scratch, 'thrown-auth'),
    companies: [{ ticker: 'A' }], maxRequests: 1,
    request: async () => { throw Object.assign(new Error('Session expired'), { reason: 'unauthorised' }); } });
  assert.equal(thrownAuth.stoppedForAuth, true);
  assert.equal(thrownAuth.sourceOutages.authenticatedAnnouncements.reason, 'unauthorised',
    'a thrown authenticated-source failure also becomes a global visible outage');

  const correctedDir = join(scratch, 'corrected-identities');
  const correctionPair = `sha256:${'9c'.repeat(32)}`;
  const correctionHash = `sha256:${'4c'.repeat(32)}`;
  const wrongDirect = { ...bseRow, ticker: 'KISSHT', scripCode: '500001', documentHash: correctionHash,
    crossExchangeDocumentId: correctionPair };
  const pairedNse = { ...nseRow, providers: ['Muns corporate announcements'], documentHash: correctionHash,
    crossExchangeDocumentId: correctionPair };
  const wrongMerged = mergeAnnouncements([wrongDirect], [pairedNse])[0];
  wrongMerged.crossExchangeObservations = [wrongDirect, pairedNse].map(({ crossExchangeDocumentId, ...row }) => row);
  writeJson(join(correctedDir, 'announcements/KISSHT.json'), { ticker: 'KISSHT', kind: 'announcements', rows: [wrongDirect, wrongMerged, nseRow] });
  writeJson(join(correctedDir, 'index.json'), { version: 1, sources: { announcements: { KISSHT: {
    queryTicker: 'KISSHT', rowCount: 3, ranges: [{ from: '2025-09-01', to: dayForTest(clock) }],
    lastSuccessAt: recent, recentCheckedAt: recent, bse: { bseCode: '500001', rowCount: 1,
      ranges: [{ from: '2025-09-01', to: dayForTest(clock) }], lastSuccessAt: recent, recentCheckedAt: recent },
  } }, domestic: {} } });
  const corrected = await captureCompanySources({ ...options, dir: correctedDir, companies: [kissht], maxRequests: 0 });
  assert.equal(corrected.sources.announcements.KISSHT.queryTicker, 'KISSHT');
  assert.deepEqual(corrected.sources.announcements.KISSHT.ranges, [], 'a corrected announcement symbol reopens historical coverage');
  assert.equal(corrected.sources.announcements.KISSHT.lastSuccessAt, null);
  assert.equal(corrected.sources.announcements.KISSHT.bse.bseCode, '544754');
  assert.deepEqual(corrected.sources.announcements.KISSHT.bse.ranges, [], 'a corrected BSE code reopens historical coverage');
  const correctedRows = readJson(join(correctedDir, 'announcements/KISSHT.json')).rows;
  assert.equal(correctedRows.length, 2);
  assert(correctedRows.some(row => row.url === pairedNse.url && row.source === 'NSE' && !row.providers.includes('BSE company index')),
    'a corrected BSE code strips its evidence while retaining an independently captured NSE half');
  assert(correctedRows.every(row => row.crossExchangeObservations == null),
    'identity correction also removes stored pair observations that could restore invalid evidence');
  assert(correctedRows.some(row => row.url === nseRow.url), 'unrelated retained rows survive a BSE code correction');

  const correctedTickerDir = join(scratch, 'corrected-query-ticker');
  writeJson(join(correctedTickerDir, 'announcements/KISSHT.json'), { ticker: 'KISSHT', kind: 'announcements', rows: [pairedNse, bseRow] });
  writeJson(join(correctedTickerDir, 'index.json'), { version: 1, sources: { announcements: { KISSHT: {
    queryTicker: 'OLDKISSHT', rowCount: 2, ranges: [{ from: '2025-09-01', to: dayForTest(clock) }],
    lastSuccessAt: recent, recentCheckedAt: recent, bse: { bseCode: '544754', rowCount: 1, ranges: [] },
  } }, domestic: {} } });
  const correctedTicker = await captureCompanySources({ ...options, dir: correctedTickerDir, companies: [kissht], maxRequests: 0 });
  assert.deepEqual(correctedTicker.sources.announcements.KISSHT.ranges, [],
    'a corrected authenticated-provider symbol reopens all historical windows');
  assert.deepEqual(readJson(join(correctedTickerDir, 'announcements/KISSHT.json')).rows.map(row => row.url), [bseRow.url],
    'a corrected authenticated-provider symbol removes its rows while independent BSE evidence survives');

  const invalidBseDir = join(scratch, 'invalid-bse-metadata');
  const invalidBse = await captureCompanySources({ ...options, dir: invalidBseDir, companies: [kissht], maxRequests: 1,
    request: async () => ({ ok: true, announcements: [], skipped: 0,
      bse: { ok: true, announcements: [bseRow], skipped: 0 } }) });
  assert.equal(invalidBse.sources.announcements.KISSHT.bse.error.reason, 'shape');
  assert.deepEqual(invalidBse.sources.announcements.KISSHT.bse.ranges, [],
    'missing BSE pagination proof cannot close a source window');
  assert(readJson(join(invalidBseDir, 'announcements/KISSHT.json'), { rows: [] }).rows.some(row => row.url === bseRow.url),
    'readable BSE rows survive for recovery even though malformed pagination cannot close the window');

  const retainedCodeDir = join(scratch, 'retained-bse-code');
  writeJson(join(retainedCodeDir, 'announcements/KISSHT.json'), { ticker: 'KISSHT', kind: 'announcements', rows: [bseRow] });
  writeJson(join(retainedCodeDir, 'index.json'), { version: 1, sources: { announcements: { KISSHT: {
    queryTicker: 'KISSHT', rowCount: 1, ranges: [], bse: { bseCode: '544754', rowCount: 1, ranges: [] },
  } }, domestic: {} } });
  const retainedCode = await captureCompanySources({ ...options, dir: retainedCodeDir,
    companies: [{ ticker: 'KISSHT', announcementTicker: 'KISSHT' }], maxRequests: 0 });
  assert.equal(retainedCode.sources.announcements.KISSHT.bse.bseCode, '544754',
    'a temporarily missing identity feed cannot erase the last verified BSE code');
  assert.equal(readJson(join(retainedCodeDir, 'announcements/KISSHT.json')).rows.length, 1,
    'a temporarily missing identity feed cannot purge retained official BSE records');

  const hashDir = join(scratch, 'official-bse-hash');
  const retainedBse = { ...bseRow, time: '15:46:24' };
  const recoveredNse = { ...nseRow, time: '15:56:52' };
  writeJson(join(hashDir, 'announcements/KISSHT.json'), { ticker: 'KISSHT', kind: 'announcements', rows: [retainedBse] });
  const exactHash = `sha256:${'4c'.repeat(32)}`;
  let preparedUrls;
  const hashed = await captureCompanySources({ ...options, dir: hashDir, companies: [kissht], maxRequests: 1,
    expandAnnouncements: expandCrossExchangeObservations,
    prepareAnnouncements: async rows => {
      preparedUrls = rows.map(row => row.url);
      const durableBeforeHashing = readJson(join(hashDir, 'announcements/KISSHT.json')).rows;
      assert.deepEqual(new Set(durableBeforeHashing.map(row => row.url)), new Set([retainedBse.url, recoveredNse.url]),
        'raw exchange rows are durable before optional document comparison starts');
      assert(readJson(join(hashDir, 'index.json')).sources.announcements.KISSHT.lastSuccessAt,
        'source coverage is checkpointed before optional document comparison starts');
      assert.equal(readJson(join(hashDir, 'index.json')).sources.announcements.KISSHT.fileRevision, 1,
        'the raw file has its own published revision before optional comparison');
      return { rows: rows.map(row => ({ ...row, documentHash: exactHash,
        crossExchangeDocumentId: `sha256:${'7a'.repeat(32)}` })), eligible: 2, candidatePairs: 1,
        fetched: 2, downloaded: 2, failed: 0, failedPairs: 0, hashed: 2, reused: 0, compared: 1, matched: 1, different: 0,
        failureReasons: { 'must-not-be-persisted': 99 } };
    },
    request: async () => ({ ok: true, announcements: [recoveredNse], skipped: 0,
      bse: { ok: false, reason: 'upstream', message: 'BSE temporarily unavailable' } }) });
  assert.deepEqual(new Set(preparedUrls), new Set([retainedBse.url, recoveredNse.url]), 'hashing compares retained and incoming counterparts together');
  const exact = readJson(join(hashDir, 'announcements/KISSHT.json')).rows;
  assert.equal(exact.length, 1);
  assert.deepEqual(exact[0].sources, ['BSE', 'NSE']);
  assert.equal(hashed.sources.announcements.KISSHT.fileRevision, 2,
    'the enriched file gets a second revision even within one source attempt');
  assert.equal(hashed.sources.announcements.KISSHT.documentHashes.matched, 1);
  assert.equal(hashed.sources.announcements.KISSHT.documentHashes.failureReasons, undefined, 'only controlled numeric hash diagnostics persist');

  const incrementalHashDir = join(scratch, 'official-bse-incremental-hash');
  const incrementalDate = dayForTest(clock);
  const firstBse = { ...bseRow, date: incrementalDate, time: '10:00:00',
    url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/incremental-first.pdf' };
  const firstNse = { ...nseRow, date: incrementalDate, time: '10:01:00',
    url: 'https://nsearchives.nseindia.com/corporate/incremental-first.pdf', providers: ['Muns corporate announcements'] };
  const lateBse = { ...firstBse, time: '10:02:00',
    url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/incremental-late.pdf' };
  const pdf = Buffer.from(`%PDF-1.7\nincremental shared bytes\n${'.'.repeat(80)}\n%%EOF\n`);
  const prepareIncremental = rows => enrichCrossExchangeDocumentHashes(rows, {
    fetcher: async () => new Response(pdf, { headers: { 'content-length': String(pdf.length) } }),
  });
  await captureCompanySources({ ...options, dir: incrementalHashDir, companies: [kissht], maxRequests: 1,
    expandAnnouncements: expandCrossExchangeObservations,
    prepareAnnouncements: prepareIncremental,
    request: async () => ({ ok: true, announcements: [firstNse], skipped: 0,
      bse: { ok: true, announcements: [firstBse], skipped: 0, declared: 1, collected: 1, pages: 1, requests: 1 } }) });
  const initiallyPaired = readJson(join(incrementalHashDir, 'announcements/KISSHT.json')).rows;
  assert.equal(initiallyPaired.length, 1);
  assert.equal(initiallyPaired[0].crossExchangeObservations.length, 2);
  clock += 86400000;
  const refreshedNse = { ...firstNse, category: 'NEW CATEGORY',
    providers: ['Muns corporate announcements', 'NEW PROVIDER'] };
  const incremental = await captureCompanySources({ ...options, dir: incrementalHashDir, companies: [kissht], maxRequests: 2,
    expandAnnouncements: expandCrossExchangeObservations,
    prepareAnnouncements: prepareIncremental,
    request: async kind => kind === 'domestic' ? { ok: true, documents: [], skipped: 0 } :
      ({ ok: true, announcements: [refreshedNse], skipped: 0,
        bse: { ok: true, announcements: [lateBse], skipped: 0, declared: 1, collected: 1, pages: 1, requests: 1 } }) });
  const reconsidered = readJson(join(incrementalHashDir, 'announcements/KISSHT.json')).rows;
  assert.equal(reconsidered.length, 3,
    'capture accepts safe row growth when a late filing makes an earlier cross-exchange pair ambiguous');
  assert(reconsidered.every(row => row.crossExchangeDocumentId == null));
  const refreshed = reconsidered.find(row => row.url === firstNse.url);
  assert.equal(refreshed.category, 'NEW CATEGORY');
  assert(refreshed.providers.includes('NEW PROVIDER'),
    'fresh constituent metadata survives pair expansion and ambiguity re-clustering');
  assert.equal(incremental.sources.announcements.KISSHT.documentHashes.ambiguous, 3);
  assert.equal(incremental.sources.announcements.KISSHT.bse.rowCount, 2);

  const hashFailureDir = join(scratch, 'hash-failure');
  const hashFailure = await captureCompanySources({ ...options, dir: hashFailureDir, companies: [{ ticker: 'A' }], maxRequests: 1,
    expandAnnouncements: expandCrossExchangeObservations,
    prepareAnnouncements: async () => { throw new Error('private document failure'); },
    request: async () => ({ ok: true, announcements: [ann], skipped: 0 }) });
  assert(hashFailure.sources.announcements.A.lastSuccessAt, 'hashing failure cannot fail a successful source read');
  assert.equal(hashFailure.sources.announcements.A.documentHashes.status, 'unavailable');
  assert.equal(readJson(join(hashFailureDir, 'announcements/A.json')).rows.length, 1, 'unhashed rows remain independently visible');

  const newlyAddedCalls = [];
  await captureCompanySources({ ...options, dir: officialDir, companies: [kissht, { ticker: 'NEW', bseCode: '500002', priority: true }], maxRequests: 1,
    request: async (kind, ticker, range, company, context) => {
      newlyAddedCalls.push({ ticker, range, context });
      return { ok: true, announcements: [], skipped: 0,
        bse: { ok: true, announcements: [], skipped: 0, declared: 0, collected: 0, pages: 1, requests: 1 } };
    } });
  assert.equal(newlyAddedCalls[0].ticker, 'NEW', 'a newly added holding precedes already attempted company history');
  assert(newlyAddedCalls[0].context.bseRange?.recent, 'a newly added holding immediately starts official BSE backfill');
  clock = clockBeforeOfficialTests;

  const archiveDir = join(scratch, 'archive');
  const oldTrade = { ticker: 'A', date: '2020-01-01', cells: { Insider: 'Person', Shares: '10' } };
  const distinctTrade = { ticker: 'A', date: '2020-01-01', cells: { Insider: 'Other Person', Shares: '10' } };
  archiveFilings(archiveDir, 'insider', [oldTrade, oldTrade, distinctTrade]);
  archiveFilings(archiveDir, 'insider', [oldTrade]);
  assert.equal(readJson(join(archiveDir, '2020-01.json')).rows.length, 2, 'archive removes repeated events while retaining distinct trades');
  archiveFilings(archiveDir, 'insider', []);
  assert.equal(readJson(join(archiveDir, 'index.json')).rowCount, 2, 'empty capture never truncates the archive');

  await clearAll();
  globalThis.fetch = async (path) => {
    if (path === 'data/filing-capture/index.json') return Response.json(index);
    const name = String(path).split('/').at(-1);
    const value = readJson(join(archiveDir, name));
    return value ? Response.json(value) : new Response('', { status: 404 });
  };
  await loadCompanyCaptureIndex({ force: true });
  const health = companyCaptureStatus('announcements', ['A', 'B', 'LOCAL'], clock);
  assert.equal(health.unregistered, 1);
  assert.equal(health.failed, 2, 'the persisted authenticated-source outage applies to untouched registered companies');
  assert.equal(health.checked, 0);
  assert(health.gaps.some(gap => gap.reason === 'Authenticated announcement source is unavailable'));
  const base = { rows: () => [], meta: () => ({ headers: [] }), onChange: () => () => {}, invalidate() {} };
  const feed = withFilingArchive(base, 'insider');
  await feed.loadArchive();
  assert.equal(feed.rows().length, 2);
  assert(feed.meta().headers.includes('Shares'));
  assert(feed.meta().archive.loaded);
  globalThis.fetch = async () => new Response('', { status: 503 });
  await feed.loadArchive();
  assert.equal(feed.rows().length, 2, 'failed archive refresh retains visible rows');
  assert(!feed.meta().archive.loaded, 'offline saved history does not claim a fresh complete read');
  assert(feed.meta().archive.error);
} finally {
  globalThis.fetch = originalFetch;
  await clearAll();
  rmSync(scratch, { recursive: true, force: true });
}
console.log('PASS automatic capture resume, rate budget, scope union, partial/auth failures, date backfill, durable archives and visible gaps');
