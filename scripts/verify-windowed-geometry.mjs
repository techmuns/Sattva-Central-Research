import assert from 'node:assert/strict';
import { rowGeometry } from '../public/js/ui/windowed-list.js';
const count = 100000;
const geometry = rowGeometry(count, 72);
const heights = new Array(count).fill(72);
for (let i = 0; i < count; i += 97) { heights[i] = 49 + i % 311; geometry.set(i, heights[i]); }
let offset = 0;
for (let i = 0; i < count; i++) {
  assert.equal(geometry.offset(i), offset);
  assert.equal(geometry.indexAt(offset), i);
  assert.equal(geometry.indexAt(offset + heights[i] - 0.5), i);
  offset += heights[i];
}
assert.equal(geometry.offset(count), offset);
assert.equal(geometry.indexAt(offset + 100), count - 1);
assert.equal(geometry.indexAt(-100), 0);
assert.equal(geometry.set(-1, 50), false);
assert.equal(geometry.set(3, NaN), false);
assert.equal(geometry.set(3, 0), false);
assert.equal(rowGeometry(0).offset(0), 0);
assert.equal(rowGeometry(0).indexAt(100), 0);
console.log('PASS: exact prefix offsets and boundary lookup for 100,000 variable-height rows.');
