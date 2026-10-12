import assert from 'node:assert/strict';
import { validSnapshot } from '../public/js/data/managers.js';
import { managerTrades } from '../public/js/data/investor-changes.js';
import { exportRows } from '../public/js/ui/export.js';
const tx = { id: 'ledger-1', date: '2026-09-01', dateSheet: null, security: 'Example', isin: 'INE000000001', ticker: 'EXAMPLE', side: 'buy', quantity: 10, amount: 0, unitPrice: 0, transfer: false };
const snapshot = { version: 1, valuation: 'workbook', bookAsOf: '2026-08-31', listedValuationAt: '2026-09-04', listedValuationBasis: 'stated', checkedAt: new Date().toISOString(), archiveVersion: 1, sourceRevision: 'fixture', privateWorkbook: null,
  coverage: { note: 'Fixture source coverage', transactionAsOf: '2026-08-31', sourceCount: 6, privateCount: 0 }, managers: [{ id: 'custodian-example', kind: 'custodian', name: 'Example', asOf: '2026-08-31',
    values: { marketValue: 100, costBasis: null, unrealised: null, cashValue: 0, positionCount: 1 }, positions: [{ isin: 'INE000000001', ticker: 'EXAMPLE', security: 'Example', assetClass: 'Equity', quantity: 10, marketValue: 100, costBasis: null, weightPct: 100 }],
    transactions: [tx, { ...tx, id: 'ledger-2', dateSheet: '2026-03-31', transfer: true }] }] };
assert(validSnapshot(snapshot));
for (const mutate of [v => v.checkedAt = '2020-01-01', v => v.bookAsOf = '2026-02-31', v => v.managers.push(v.managers[0]), v => v.managers[0].kind = 'pms', v => v.managers[0].positions[0].weightPct = 101, v => v.managers[0].transactions.push(v.managers[0].transactions[0]), v => v.managers[0].transactions[0].ticker = 'javascript:evil', v => v.managers[0].transactions[0].dateSheet = '2026-02-31']) {
  const v = structuredClone(snapshot); mutate(v); assert.equal(validSnapshot(v), false);
}
const events = managerTrades(snapshot.managers);
assert.equal(events.length, 2, 'distinct identical lots remain separate');
assert.equal(events[0].amount, 0, 'stated nil amount remains zero');
assert.equal(events[1].source, 'Family ledger · date unverified');
assert.equal(events[1].raw.transfer, true);
assert.equal(events[1].raw.dateSheet, '2026-03-31');
let authorised = true;
globalThis.window = { ExcelJS: { Workbook: class { constructor() { this.xlsx = { writeBuffer: async () => { authorised = false; return new Uint8Array([1]); } }; } addWorksheet() { return { addRow() {}, getRow: () => ({}) }; } } } };
assert.equal(await exportRows({ rows: [{ value: 1 }], columns: [{ key: 'value', header: 'Value', get: r => r.value }], canExport: () => authorised }), false, 'revoked access stops an asynchronous private download');
console.log('PASS private managers: bounded/fresh schema, missing figures, distinct lots, carried dates and transfer evidence');
