// Offline boundary and combination checks for the shared market filters.
import assert from 'node:assert/strict';
import { TECHNICAL_FILTERS as filters, TECHNICAL_DEFAULTS, chipCounts } from '../public/js/tabs/technical-filters.js';
const values = [[1.5, .95, true], [1, .9, false], [3, .8, true], [.7, .99, true], [null, null, null], [1.4999, .9499, true]];
const rows = values.map(([volume, proximity, above], i) => ({ id: 'ABCDEF'[i], company: {
  consolidation_breakout: volume == null ? null : { today_volume_ratio: volume },
  volume_ratio_today: 9, high_proximity_pct: proximity, above_200dma: above,
} }));
const state = overrides => Object.fromEntries(Object.entries({ ...TECHNICAL_DEFAULTS, ...overrides }).map(([key, value]) => [key, [value]]));
const matching = overrides => rows.filter(row => Object.values(filters).every(group => group.test(row, state(overrides)[group.param]))).map(row => row.id).join('');
assert.equal(matching({}), 'ABCDEF', 'All retains missing measurements');
assert.equal(matching({ vol: '1.5' }), 'AC', 'volume uses the same 30-session ratio as Strong Breakouts, including the exact threshold');
assert.equal(matching({ vol: '1.0' }), 'ABCF');
assert.equal(matching({ near: '5' }), 'AD', 'exactly 5% below the high is included');
assert.equal(matching({ near: '10' }), 'ABDF');
assert.equal(matching({ near: '20' }), 'ABCDF');
assert.equal(matching({ dma: 'above' }), 'ACDF', 'only an explicit above-200-DMA observation qualifies');
assert.equal(matching({ vol: '1.5', near: '10', dma: 'above' }), 'A');
assert.deepEqual(chipCounts(rows, filters, state({ vol: '1.5', near: '10', dma: 'above' })), {
  vol: { all: 3, '1.5': 1, '1.0': 2 }, near: { all: 2, '5': 1, '10': 1, '20': 2 }, dma: { all: 1, above: 1 },
}, 'option counts preserve the other selections');
assert.equal(filters.proximity.test({ company: { high_proximity_pct: .949999 } }, ['5']), false);
console.log('PASS shared technical filters: defaults, missing data, exact thresholds, base-volume semantics, intersections and contextual counts');
