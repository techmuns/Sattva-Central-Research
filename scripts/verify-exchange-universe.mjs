import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExchangeUniverse } from '../public/js/data/exchange-universe.js';
import { captureCompanies } from './lib/company-capture.mjs';
import * as listed from '../public/js/data/listed-companies.js';
import * as lists from '../public/js/core/scope-lists.js';
import { filterByScope } from '../public/js/data/scope.js';

const read = path => JSON.parse(readFileSync(new URL(`../public/data/${path}`, import.meta.url)));
const bse = read('announcement-identities.json'), nse = read('filing-capture/nse-identities.json');
const built = buildExchangeUniverse(bse, nse);
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
lists.reset('universe');

const fixtureRead = async path => ({ value: path.includes('nse-identities') ? nse : bse, stale: false });
await listed.load({ read: fixtureRead });
const previous = listed.all().map(c => c.isin), checkTimes = listed.meta().sources.map(s => s.checkedAt);
await listed.load({ read: async () => { throw Error('source offline'); } });
assert.deepEqual(listed.all().map(c => c.isin), previous);
assert.deepEqual(listed.meta().sources.map(s => s.checkedAt), checkTimes);
assert(listed.meta().errors.length >= 2);
await listed.load({ read: async path => ({ value: path.includes('nse-identities')
  ? { ...nse, directories: { ...nse.directories, equity: { ...nse.directories.equity, entries: [] } } }
  : { ...bse, entries: [] }, stale: false }) });
assert.deepEqual(listed.all().map(c => c.isin), previous, 'a truncated directory cannot shrink the universe');
assert(listed.meta().errors.length);
console.log(`PASS ${expected.size} exchange equity identities: complete union, BSE/NSE collisions, automatic enrollment, persisted exclusions and failure retention.`);
