import assert from 'node:assert/strict';
import { validSnapshot, managerId, snapshotIssue, MAX_MANAGER_CHARS } from '../public/js/data/managers-contract.js';
import { managerTrades } from '../public/js/data/investor-changes.js';
import { exportRows } from '../public/js/ui/export.js';
const tx = { id: 'ledger-1', date: '2026-09-01', dateSheet: null, security: 'Example', isin: 'INE000000001', ticker: 'EXAMPLE', side: 'buy', quantity: 10, amount: 0, unitPrice: 0, transfer: false };
const snapshot = { version: 1, valuation: 'workbook', bookAsOf: '2026-08-31', listedValuationAt: '2026-09-04', listedValuationBasis: 'stated', checkedAt: new Date().toISOString(), archiveVersion: 1, sourceRevision: 'fixture', privateWorkbook: null,
  coverage: { note: 'Fixture source coverage', transactionAsOf: '2026-08-31', sourceCount: 6, privateCount: 0 }, managers: [{ id: 'custodian-example', kind: 'custodian', name: 'Example', asOf: '2026-08-31',
    values: { marketValue: 100, costBasis: null, unrealised: null, cashValue: 0, positionCount: 1 }, positions: [{ isin: 'INE000000001', ticker: 'EXAMPLE', security: 'Example', assetClass: 'Equity', quantity: 10, marketValue: 100, costBasis: null, weightPct: 100 }],
    transactions: [tx, { ...tx, id: 'ledger-2', dateSheet: '2026-03-31', transfer: true }] }] };
assert(validSnapshot(snapshot));
// Family sends the entire catalogue identity. It grows with retained workbooks,
// and must stay exact so revisions still revoke open workspaces and exports.
const catalogueRevision = JSON.stringify(Array.from({ length: 60 }, (_, i) => [`workbook-${i}`, `revision-${i}`, '2026-10-01T00:00:00Z', null])) + '|whole-family';
assert(catalogueRevision.length > 1000);
for (const sourceRevision of [catalogueRevision, 'r'.repeat(250_000)]) {
  const v = { ...snapshot, sourceRevision };
  assert(validSnapshot(v), 'valid retained catalogue is bounded by the complete message, not a placeholder revision length');
  assert.equal(v.sourceRevision, sourceRevision, 'revision identity must not be truncated or replaced');
}
assert.equal(snapshotIssue({ ...snapshot, sourceRevision: '' }), 'revision');
assert.equal(snapshotIssue({ ...snapshot, sourceRevision: 123 }), 'revision');
assert.equal(snapshotIssue({ ...snapshot, sourceRevision: 'r'.repeat(MAX_MANAGER_CHARS) }), 'sharing limit', 'the complete payload still has the producer’s 5 MB character bound');
assert.equal(snapshotIssue({ ...snapshot, managers: [null] }), 'manager records');

for (const mutate of [v => v.checkedAt = '2020-01-01', v => v.bookAsOf = '2026-02-31', v => v.managers.push(v.managers[0]), v => v.managers[0].kind = 'pms', v => v.managers[0].positions[0].weightPct = 101, v => v.managers[0].transactions.push(v.managers[0].transactions[0]), v => v.managers[0].transactions[0].ticker = 'javascript:evil', v => v.managers[0].transactions[0].dateSheet = '2026-02-31']) {
  const v = structuredClone(snapshot); mutate(v); assert.equal(validSnapshot(v), false);
}
const events = managerTrades(snapshot.managers);
assert.equal(events.length, 2, 'distinct identical lots remain separate');
assert.equal(events[0].amount, 0, 'stated nil amount remains zero');
assert.equal(events[1].source, 'Family ledger · date unverified');
assert.equal(events[1].raw.transfer, true);
assert.equal(events[1].raw.dateSheet, '2026-03-31');
assert.notEqual(managerId({ id: 'fund-pe-12', kind: 'fund', name: 'Alpha Fund' }), managerId({ id: 'fund-pe-12', kind: 'fund', name: 'Beta Fund' }), 'a reassigned workbook row cannot inherit another fund’s public relationships');
assert.notEqual(managerId({ id: 'fund-pe-12', kind: 'fund', name: 'Alpha Fund' }), managerId({ id: 'fund-pe-13', kind: 'fund', name: 'Alpha Fund' }), 'repeated investments remain separate');
let authorised = true;
globalThis.window = { ExcelJS: { Workbook: class { constructor() { this.xlsx = { writeBuffer: async () => { authorised = false; return new Uint8Array([1]); } }; } addWorksheet() { return { addRow() {}, getRow: () => ({}) }; } } } };
assert.equal(await exportRows({ rows: [{ value: 1 }], columns: [{ key: 'value', header: 'Value', get: r => r.value }], canExport: () => authorised }), false, 'revoked access stops an asynchronous private download');
console.log('PASS private managers: bounded/fresh schema, missing figures, distinct lots, carried dates and transfer evidence');
