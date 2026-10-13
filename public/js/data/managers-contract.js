// Ephemeral Family manager contract, shared by the transport and reader.
import { newsDay } from './news-window.js';
const text = (v, max = 300) => typeof v === 'string' && v.length > 0 && v.length <= max;
const nullableNumber = v => v === null || Number.isFinite(v);
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const isin = v => typeof v === 'string' && /^[A-Z]{2}[A-Z0-9]{10}$/.test(v);
const ticker = v => v === null || typeof v === 'string' && /^[A-Z0-9&.-]{1,30}$/.test(v);
// A workbook row can later contain a different fund. Its old public relationships
// must never follow that row to the new name; repeated investments still stay distinct.
export function managerId(m) {
  if (m.kind !== 'fund') return m.id;
  let hash = 14695981039346656037n;
  for (const char of m.name.normalize('NFKC').trim().toLowerCase()) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  return `${m.id.slice(0, 100)}-${hash.toString(16)}`;
}
export const MAX_MANAGER_CHARS = 5_000_000;
export function validSnapshot(v, startedAt = Date.now()) {
  return snapshotIssue(v, startedAt) === null;
}
// Report the failed contract section, never a private name, amount or source value.
export function snapshotIssue(v, startedAt = Date.now()) {
  try { return snapshotShape(v, startedAt); } catch { return 'structure'; }
}
function snapshotShape(v, startedAt) {
  const checked = Date.parse(v?.checkedAt || '');
  if (!v || v.version !== 1 || v.valuation !== 'workbook') return 'format';
  if (!day(v.bookAsOf) || v.bookAsOf > newsDay()) return 'period';
  // Family's revision is the complete serialized workbook catalogue, not a hash.
  // Its length grows with retained workbooks; the whole-message budget bounds it.
  if (!Number.isSafeInteger(v.archiveVersion) || v.archiveVersion < 0 || !text(v.sourceRevision, MAX_MANAGER_CHARS)) return 'revision';
  if (!Number.isFinite(checked) || checked < startedAt - 1000 || checked > Date.now() + 10000) return 'check time';
  if (JSON.stringify(v).length > MAX_MANAGER_CHARS) return 'sharing limit';
  if (!Array.isArray(v.managers) || v.managers.length > 1000 || new Set(v.managers.map(m => m?.id)).size !== v.managers.length) return 'manager identities';
  if (!text(v.coverage?.note, 2000) || !day(v.coverage.transactionAsOf) ||
      !Number.isSafeInteger(v.coverage.sourceCount) || v.coverage.sourceCount < 1 || !Number.isSafeInteger(v.coverage.privateCount) ||
      v.coverage.privateCount !== v.managers.filter(m => m?.kind === 'fund').length) return 'coverage';
  if ((v.listedValuationAt !== null && !day(v.listedValuationAt)) || ![null, 'stated', 'traded', 'period', 'today'].includes(v.listedValuationBasis)) return 'valuation date';
  return v.managers.every(m => text(m?.id, 120) && /^[a-zA-Z0-9-]+$/.test(m.id) && text(m.name) && ['custodian', 'fund'].includes(m.kind) &&
    (m.kind === 'fund' ? m.asOf === null : m.asOf === v.bookAsOf) && ['marketValue', 'costBasis', 'unrealised', 'cashValue'].every(k => nullableNumber(m.values?.[k])) &&
    Number.isSafeInteger(m.values.positionCount) && m.values.positionCount >= 0 &&
    Array.isArray(m.positions) && m.positions.length <= 2000 && new Set(m.positions.map(p => p.isin)).size === m.positions.length &&
    (m.kind !== 'custodian' || m.values.positionCount === m.positions.length) &&
    m.positions.every(p => isin(p.isin) && ticker(p.ticker) && text(p.security) && ['Equity', 'ETF', 'Liquid'].includes(p.assetClass) &&
      ['quantity', 'marketValue', 'costBasis', 'weightPct'].every(k => nullableNumber(p[k])) && (p.weightPct === null || p.weightPct >= 0 && p.weightPct <= 100)) &&
    Array.isArray(m.transactions) && m.transactions.length <= 50000 && new Set(m.transactions.map(t => t.id)).size === m.transactions.length &&
    m.transactions.every(t => text(t.id, 120) && day(t.date) && (t.dateSheet === null || day(t.dateSheet)) && isin(t.isin) && ticker(t.ticker) &&
      text(t.security) && ['buy', 'sell'].includes(t.side) && ['quantity', 'amount', 'unitPrice'].every(k => Number.isFinite(t[k])) && typeof t.transfer === 'boolean') &&
    (m.kind !== 'fund' || m.capital && ['committed', 'drawn', 'distributed', 'currentValue', 'tvpi', 'dpi'].every(k => nullableNumber(m.capital[k])) &&
      (m.capital.firstInvest === null || day(m.capital.firstInvest)))) ? null : 'manager records';
}
