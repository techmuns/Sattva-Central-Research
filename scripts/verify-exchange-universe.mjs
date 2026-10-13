import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExchangeUniverse, buildExchangeUniverseAsync } from '../public/js/data/exchange-universe.js';
import { captureCompanies } from './lib/company-capture.mjs';
import * as listed from '../public/js/data/listed-companies.js';
import * as lists from '../public/js/core/scope-lists.js';
import { filterByScope } from '../public/js/data/scope.js';
import { writeEntry } from '../public/js/core/store.js';

const read = path => JSON.parse(readFileSync(new URL(`../public/data/${path}`, import.meta.url)));
const bse = read('announcement-identities.json'), nse = read('filing-capture/nse-identities.json');
const built = buildExchangeUniverse(bse, nse);
let yields = 0;
assert.deepEqual(await buildExchangeUniverseAsync(bse, nse, {
  sliceMs: 0, yieldForInput: async () => { yields++; },
}), built, 'yielding to input preserves every identity, field and sorted position');
assert(yields > built.companies.length, 'the full directory gives input opportunities during preparation');
const expected = new Set([...bse.entries.filter(c => ['Active', 'Suspended'].includes(c.status)),
  ...Object.values(nse.directories).flatMap(d => d.entries)].filter(c => /^IN[E9][A-Z0-9]{4}01[A-Z0-9]{3}$/.test(c.isin)).map(c => c.isin));
assert.deepEqual(new Set(built.companies.map(c => c.isin)), expected);
assert(built.companies.length > 5000);
assert.equal(new Set(built.companies.map(c => c.ticker)).size, expected.size);
const dp = built.companies.find(c => c.ticker === 'DPABHUSHAN');
assert(dp && dp.exchanges.includes('NSE'));
const focused = built.companies.filter(c => c.aliases.includes('FOCUS'));
assert.equal(focused.length, 2);
assert(focused.some(c => c.ticker === '543312') && focused.some(c => c.ticker === 'FOCUS'));
for (const announcements of [false, true]) {
  const scope = captureCompanies(new URL('../public/data/', import.meta.url).pathname, { announcements });
  const captured = new Set(scope.companies.map(c => c.isin));
  assert([...expected].every(isin => captured.has(isin)), 'every listed identity is enrolled independently of the scored subset');
}
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) };
const bseFocus = focused.find(c => c.ticker === '543312'), nseFocus = focused.find(c => c.ticker === 'FOCUS');
lists.remove('universe', bseFocus, built.companies);
assert.deepEqual(filterByScope([{ ...bseFocus, ticker: 'FOCUS' }, nseFocus], 'universe').map(c => c.isin), [nseFocus.isin]);
lists.reset('universe'); lists.remove('universe', nseFocus, built.companies);
assert.deepEqual(filterByScope([{ ...bseFocus, ticker: 'FOCUS' }, nseFocus], 'universe').map(c => c.isin), [bseFocus.isin]);
assert.equal(filterByScope([{ ticker: 'FOCUS', scripCode: bseFocus.bseCode }], 'universe').length, 1,
  'an explicit BSE code distinguishes the other issuer even before ISIN enrichment');
lists.reset('universe'); lists.remove('universe', dp, built.companies);
assert.equal(lists.removed('universe')[0].isin, dp.isin, 'saved exclusions retain security identity');
assert.equal(filterByScope([{ ticker: dp.bseCode }, dp], 'universe').length, 0, 'BSE-code and NSE rows follow the same company exclusion');
const renamed = { ...dp, ticker: 'RENAMEDDP' };
assert.equal(lists.apply('universe', [renamed]).length, 0, 'an exchange rename cannot restore an excluded issuer');
lists.add('universe', renamed, [renamed]);
assert.equal(lists.apply('universe', [renamed]).length, 1, 'restoring a renamed company clears its original exclusion');
lists.reset('universe');

const fixtureRead = async path => ({ value: path.includes('nse-identities') ? nse : bse, stale: false });
let builds = 0, reads = 0;
const trackedBuild = (...args) => { builds++; return buildExchangeUniverseAsync(...args); };
const trackedRead = path => { reads++; return fixtureRead(path); };
await listed.load({ read: trackedRead, build: trackedBuild });
const stableRows = listed.all(), firstBuilds = builds;
await listed.load({ read: trackedRead, build: trackedBuild });
assert.equal(reads, 4, 'a repeat opening still revalidates both exchange sources');
assert.equal(builds, firstBuilds, 'unchanged verified directories require no derived rebuild');
assert.equal(listed.all(), stableRows, 'unchanged rows keep consumers\' caches and geometry valid');
const previous = listed.all().map(c => c.isin), checkTimes = listed.meta().sources.map(s => s.checkedAt);
await listed.load({ read: async () => { throw Error('source offline'); }, build: trackedBuild });
assert.deepEqual(listed.all().map(c => c.isin), previous);
assert.deepEqual(listed.meta().sources.map(s => s.checkedAt), checkTimes);
assert(listed.meta().errors.length >= 2);
assert.equal(builds, firstBuilds, 'a source outage reuses the verified result without rebuilding it');
await listed.load({ read: async path => ({ value: path.includes('nse-identities')
  ? { ...nse, directories: { ...nse.directories, equity: { ...nse.directories.equity, entries: [] } } }
  : { ...bse, entries: [] }, stale: false }) });
assert.deepEqual(listed.all().map(c => c.isin), previous, 'a truncated directory cannot shrink the universe');
assert(listed.meta().errors.length);
const changedBse = { ...bse, capturedAt: new Date().toISOString(), entries: [...bse.entries,
  { isin: 'INE999Z01011', ticker: 'NEWLISTED', bseCode: '599999', bseSymbol: 'NEWLISTED', name: 'New Listed Company', status: 'Active' }] };
await listed.load({ read: async path => ({ value: path.includes('nse-identities') ? nse : changedBse, stale: false }), build: trackedBuild });
assert.deepEqual(listed.all(), buildExchangeUniverse(changedBse, nse).companies, 'a changed source replaces the entire derived result with exact current data');
assert.equal(builds, firstBuilds + 2, 'only the changed source and combined directory are rebuilt');
assert.equal(listed.meta().sources.find(s => s.label === 'BSE').checkedAt, changedBse.capturedAt);
assert.deepEqual(listed.meta().errors, [], 'fresh successful checks clear previous failures');
const changedRows = listed.all();
await listed.load({ read: async path => ({ value: path.includes('nse-identities') ? nse : changedBse, stale: true }), build: trackedBuild });
assert.equal(listed.all(), changedRows);
assert.equal(builds, firstBuilds + 2);
assert(listed.meta().errors.some(e => e.includes('revalidated')), 'cache reuse cannot turn failed revalidation into success');
await listed.load({ read: fixtureRead, build: trackedBuild });
assert.equal(listed.all(), changedRows, 'an older delivered directory cannot roll back a newer verified listing');
assert(listed.meta().errors.length, 'a regressed capture is a failed check, not a fresh success');
const beforeConflict = listed.meta().sources.map(s => s.checkedAt).sort();
await listed.load({ read: async path => ({ value: path.includes('nse-identities') ? nse :
  { ...changedBse, capturedAt: new Date(Date.parse(changedBse.capturedAt) + 1000).toISOString() }, stale: false }),
  build: (b, n) => { if (b.entries && n.directories) throw Error('Combined identity conflict'); return buildExchangeUniverseAsync(b, n); } });
assert.equal(listed.all(), changedRows, 'a failed combined build retains the complete prior row objects');
assert.deepEqual(listed.meta().sources.map(s => s.checkedAt).sort(), beforeConflict, 'a rejected join cannot advance source check times');
assert(listed.meta().errors.some(e => e.includes('combined')));

// Simulate a reload with only the verified disk/RAM cache and held network replies. Restore
// must publish names before those replies settle, preserving the actual source timestamps.
await writeEntry('snapshot:listed-companies:verified-sources:v1', { value: { version: 1, bse: changedBse, nse } });
const reloaded = await import('../public/js/data/listed-companies.js?saved-first-fixture');
let restoredBeforeNetwork = false, release;
const held = new Promise(resolve => { release = resolve; });
const off = reloaded.onChange(() => { if (reloaded.all().length) restoredBeforeNetwork = true; });
const loading = reloaded.load({ read: async () => { await held; throw Error('offline'); } });
await reloaded.restore();
assert(restoredBeforeNetwork);
assert.deepEqual(reloaded.all(), changedRows, 'every company and field survives saved-first recovery');
assert(reloaded.meta().errors.some(e => e.includes('Saved')));
const restoredTimes = reloaded.meta().sources.map(s => s.checkedAt);
release(); await loading; off();
assert.deepEqual(reloaded.all(), changedRows);
assert.deepEqual(reloaded.meta().sources.map(s => s.checkedAt), restoredTimes);
assert(reloaded.meta().errors.length >= 2);

// An interrupted save can leave an old partial joined snapshot and independently newer source
// entries. Recover all exchanges/segments, not just whichever fields the joined snapshot had.
await writeEntry('snapshot:listed-companies:verified-sources:v1', { value: { version: 1, bse,
  nse: { version: 1, directories: { equity: nse.directories.equity } } } });
await writeEntry('capture:data/announcement-identities.json', { value: changedBse });
await writeEntry('capture:data/filing-capture/nse-identities.json', { value: nse });
const interrupted = await import('../public/js/data/listed-companies.js?interrupted-source-save');
await interrupted.load({ read: async () => { throw Error('offline'); } });
assert.deepEqual(interrupted.all(), changedRows, 'newer per-exchange caches fill every missing exchange and NSE segment');
assert.equal(interrupted.meta().sources.find(s => s.label === 'BSE').checkedAt, changedBse.capturedAt);
await writeEntry('capture:data/announcement-identities.json', { value: { ...changedBse, entries: [] } });
const malformed = await import('../public/js/data/listed-companies.js?malformed-source-cache');
await malformed.restore();
assert.deepEqual(malformed.all(), changedRows, 'a malformed per-source cache cannot replace the verified joined snapshot');

// Returning during an older read must schedule one subsequent source check. Joining only
// the old promise misses a listing published after that request began until the next poll.
const overlapping = await import('../public/js/data/listed-companies.js?return-during-read');
let deliveredBse = changedBse, overlapReads = 0, releaseOld, began, releaseFollowUp, followUpBegan;
const oldReadHeld = new Promise(resolve => { releaseOld = resolve; });
const readsBegan = new Promise(resolve => { began = resolve; });
const followUpHeld = new Promise(resolve => { releaseFollowUp = resolve; });
const followUpStarted = new Promise(resolve => { followUpBegan = resolve; });
const overlapRead = async path => {
  const value = path.includes('nse-identities') ? nse : deliveredBse;
  const index = ++overlapReads;
  if (index <= 2) { if (index === 2) began(); await oldReadHeld; }
  if (index === 3 || index === 4) { if (index === 4) followUpBegan(); await followUpHeld; }
  return { value, stale: false };
};
const priorRead = overlapping.load({ read: overlapRead });
await readsBegan;
deliveredBse = { ...changedBse, capturedAt: new Date(Date.parse(changedBse.capturedAt) + 2000).toISOString(),
  entries: [...changedBse.entries, { isin: 'INE999Z01029', ticker: 'AFTERRETURN', bseCode: '599998',
    bseSymbol: 'AFTERRETURN', name: 'Listed After Earlier Read', status: 'Active' }] };
const returnCheck = overlapping.load({ read: overlapRead, recheck: true });
assert.equal(overlapping.load({ read: overlapRead, recheck: true }), returnCheck, 'overlapping return/focus events share one queued check');
releaseOld();
await priorRead;
await followUpStarted;
deliveredBse = { ...deliveredBse, capturedAt: new Date(Date.parse(changedBse.capturedAt) + 4000).toISOString(),
  entries: [...deliveredBse.entries, { isin: 'INE999Z01037', ticker: 'DURINGFOLLOWUP', bseCode: '599997',
    bseSymbol: 'DURINGFOLLOWUP', name: 'Listed During Follow-up Read', status: 'Active' }] };
assert.equal(overlapping.load({ read: overlapRead, recheck: true }), returnCheck, 'a return during the follow-up waits for the same complete recheck chain');
assert.equal(overlapping.load({ read: overlapRead, recheck: true }), returnCheck, 'repeated events during the follow-up coalesce');
releaseFollowUp();
await returnCheck;
assert.equal(overlapReads, 6, 'each overlapping return burst adds one subsequent pair of source reads');
assert.deepEqual(overlapping.all(), buildExchangeUniverse(deliveredBse, nse).companies,
  'the return check includes a listing published after the previous source request began');
assert.equal(overlapping.meta().sources.find(s => s.label === 'BSE').checkedAt, deliveredBse.capturedAt);
console.log(`PASS ${expected.size} exchange equity identities: complete union, BSE/NSE collisions, automatic enrollment, persisted exclusions and failure retention.`);
