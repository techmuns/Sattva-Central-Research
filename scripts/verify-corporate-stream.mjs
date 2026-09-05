import assert from 'node:assert/strict';
import { createCorporateAnnouncementsFeed, nseAnnouncement, LIVE_ID, POLL_MS } from '../public/js/data/corporate-announcements.js';
import { createAnnouncementIdentity, filingTicker } from '../public/js/data/announcement-identity.js';
import { buildAnnouncementIdentities } from './lib/announcement-identities.mjs';
import { mergeAnnouncements } from '../public/js/data/announcements-shared.js';

const identityRows = [{ isin: 'INEKAMATS001', bseCode: '539659', bseSymbol: 'KAMATS', ticker: 'KAMATS', name: 'Vikram Kamats Hospitality Ltd' }];
const identity = createAnnouncementIdentity(identityRows);
assert.equal(filingTicker('SAHANA-SM'), 'SAHANA');
assert.equal(identity.key({ isin: 'INEKAMATS001' }), identity.key({ scripCode: '539659', ticker: 'WRONG' }));
assert.equal(identity.row({ scripCode: '539659', ticker: 'OLD' }).ticker, 'KAMATS');
assert.equal(identity.key({ ticker: '539659' }), identity.key({ isin: 'INEKAMATS001' }), 'BSE watchlist codes join the same issuer as its announcements');
assert.notEqual(identity.key({ isin: 'INEOTHER001', ticker: 'KAMATS' }), identity.key({ isin: 'INEKAMATS001' }));
assert.equal(identity.find({ company: 'Vikram Kamats Hospitality Other Ltd' }), null, 'prefix names cannot match another issuer');
const master = buildAnnouncementIdentities([{ ISIN_NUMBER: 'INE564S01019', SCRIP_CD: '539659', scrip_id: 'KAMATS', Scrip_Name: 'Vikram Kamats Hospitality Ltd' }]);
const issuers = createAnnouncementIdentity(master.entries);
assert.equal(issuers.find({ isin: 'INE564S13022' }).ticker, 'KAMATS', 'warrants join their verified equity issuer only for announcements');
assert.equal(issuers.find({ isin: 'INE0R4713012' }).ticker, 'ALPEXSOLAR');
assert.equal(issuers.find({ isin: 'INE935Q01015' }).ticker, 'FSC', 'delisted holdings retain their verified historical filing identity');
assert.equal(issuers.key({ scripCode: '540798' }), issuers.key({ isin: 'INE935Q01015' }));
assert.equal(mergeAnnouncements([{ ticker: 'ALPEXSOLAR-SM', date: '2026-09-04', url: 'https://example.test/a.pdf' }].map(issuers.row),
  [{ ticker: 'ALPEXSOLAR', date: '2026-09-04', url: 'https://example.test/a.pdf' }].map(issuers.row)).length, 1, 'quote aliases cannot duplicate the same announcement');

const nseRow = { ticker: 'TEST', company: 'Test Company', subject: 'Board meeting', publishedAt: '2026-09-03T20:00:00Z', url: 'https://example.test/nse.pdf' };
const mapped = nseAnnouncement(nseRow);
assert.equal(mapped.date, '2026-09-04');
assert.equal(mapped.time, '01:30:00');
assert.equal(nseAnnouncement({ ...nseRow, publishedAt: null }).date, null);
assert.equal(nseAnnouncement({ ...nseRow, url: 'javascript:alert(1)' }).url, null);

let identityFailure = false;
let bse = [{ ticker: 'TEST', title: 'BSE filing', date: '2026-09-03', url: 'https://example.test/bse.pdf', source: 'BSE' }, { ...mapped, providers: ['Muns corporate announcements'] }];
let nse = [nseRow], failNse = false, baseReads = 0, nseReads = 0, release;
const archiveReady = new Promise((done) => { release = done; });
const subscribers = new Set();
const base = {
  rows: () => bse, meta: () => ({ kind: 'announcements', reason: null }), isLoaded: () => true,
  load: async () => { baseReads++; }, refreshSnapshot: async () => { baseReads++; },
  onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  async loadArchive(options) {
    assert.equal(options.onlyChanged, true);
    await archiveReady;
    bse = [...bse, { ticker: 'OTHER', title: 'Older history', date: '2025-01-01', url: 'https://example.test/old.pdf', source: 'DRHP' }];
  },
};
const live = {
  retainedRows: () => nse, meta: () => ({ capturedAt: '2026-09-04T00:00:00Z' }),
  load: async () => { nseReads++; }, refresh: async () => { nseReads++; if (failNse) throw new Error('Offline'); },
  loadHistory: async (days, options) => { assert.equal(days, 90); assert.equal(options.updateWindow, false); },
  onChange: () => () => {},
};
const feed = createCorporateAnnouncementsFeed({ base, nse: live,
  readIdentities: async () => {
    if (identityFailure) throw new Error('Identity source unavailable');
    return { value: { version: 1, capturedAt: '2026-09-04T00:00:00Z', entries: identityRows } };
  }, readNseIdentities: async () => ({ value: { version: 1, directories: { equity: { entries: [] }, sme: {
    entries: [{ isin: 'INEFUTURE001', ticker: 'FUTURE', aliases: ['FUTURE-SM'], name: 'Future SME' }] } } } }) });
let arrivals = 0;
const off = feed.onChange(() => { arrivals++; });
const loading = feed.load([]);
assert.equal(feed.refresh(), loading, 'load and refresh share one in-flight read');
await new Promise((done) => setImmediate(done));
assert(arrivals > 0, 'newest records are published before history finishes');
assert.equal(feed.rows().length, 2, 'the same NSE document from Muns and RSS appears once');
assert.deepEqual(feed.rows()[0].providers, ['Muns corporate announcements', 'NSE announcements RSS']);
await loading;
await feed.refresh();
assert.equal(baseReads, 2, 'live updates do not wait for a slow archive download');
release(); await feed.loadArchive();
assert.equal(feed.rows().length, 3);
assert.equal(baseReads, 2); assert.equal(nseReads, 2);
bse = []; nse = [{ ...nseRow, subject: 'New filing', publishedAt: '2026-09-04T11:00:00Z', url: 'https://example.test/new.pdf' }];
await feed.refresh();
assert.equal(feed.rows()[0].title, 'New filing');
assert.equal(feed.rows().length, 4, 'rollover never erases previously observed filings');
failNse = true; nse = [];
await feed.refresh();
assert.equal(feed.rows().length, 4, 'source failure retains the whole stream');
assert.equal(feed.meta().nse.error, 'Offline');
assert.equal(feed.forTicker('test').length, 3);
assert.equal(feed.filterByScope([{ ticker: 'KAMATS', scripCode: '539659' }], 'portfolio', [{ isin: 'INEKAMATS001', ticker: null }]).length, 1);
assert.equal(feed.filterByScope([{ ticker: 'FUTURE-SM' }], 'portfolio', [{ isin: 'INEFUTURE001', ticker: null }]).length, 1, 'dynamic NSE SME identities join future holdings to retained quote-alias filings');
identityFailure = true; await feed.refresh();
assert.equal(feed.filterByScope([{ ticker: 'KAMATS', scripCode: '539659' }], 'portfolio', [{ isin: 'INEKAMATS001', ticker: null }]).length, 1, 'identity outages retain previously verified scope matching');
assert.equal(feed.meta().identity.error, 'Identity source unavailable');
assert.deepEqual(feed.forTicker(null), []);
const calls = [];
const engine = { register: (id, config) => calls.push([id, config.intervalMs]), start: (id) => calls.push(['start', id]), stop: (id) => calls.push(['stop', id]) };
feed.startLive(engine); feed.stopLive(engine);
assert.deepEqual(calls, [[LIVE_ID, POLL_MS], ['start', LIVE_ID], ['stop', LIVE_ID]]);
off(); assert.equal(subscribers.size, 0);
console.log('PASS corporate stream: IST dates, safe links, deduplication, automatic history, live arrivals, retention, coalescing and poll lifecycle');
