// Private Family manager projection. Memory only: no public assets, browser storage or model.
import { readManagerWorkbook, onPortfolioInvalidation, onPortfolioReady, onPortfolioConnection, portfolioConnectionState } from '../research/portfolio-bridge.js';
import { newsDay } from './news-window.js';
let snapshot = null, pending = null, epoch = 0, failure = null;
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };
const text = (v, max = 300) => typeof v === 'string' && v.length > 0 && v.length <= max;
const nullableNumber = v => v === null || Number.isFinite(v);
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const isin = v => typeof v === 'string' && /^[A-Z]{2}[A-Z0-9]{10}$/.test(v);
const ticker = v => v === null || typeof v === 'string' && /^[A-Z0-9&.-]{1,30}$/.test(v);
export function validSnapshot(v, startedAt = Date.now()) {
  try { return snapshotShape(v, startedAt); } catch { return false; }
}
function snapshotShape(v, startedAt) {
  const checked = Date.parse(v?.checkedAt || '');
  if (!v || v.version !== 1 || v.valuation !== 'workbook' || !day(v.bookAsOf) || v.bookAsOf > newsDay() ||
      !Number.isSafeInteger(v.archiveVersion) || v.archiveVersion < 0 || !text(v.sourceRevision, 1000) ||
      !Number.isFinite(checked) || checked < startedAt - 1000 || checked > Date.now() + 10000 ||
      !Array.isArray(v.managers) || v.managers.length > 1000 || new Set(v.managers.map(m => m?.id)).size !== v.managers.length ||
      JSON.stringify(v).length > 5_000_000 || !text(v.coverage?.note, 2000) || !day(v.coverage.transactionAsOf) ||
      (v.listedValuationAt !== null && !day(v.listedValuationAt)) || ![null, 'stated', 'traded', 'period', 'today'].includes(v.listedValuationBasis) ||
      !Number.isSafeInteger(v.coverage.sourceCount) || v.coverage.sourceCount < 1 || !Number.isSafeInteger(v.coverage.privateCount) || v.coverage.privateCount !== v.managers.filter(m => m?.kind === 'fund').length) return false;
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
      (m.capital.firstInvest === null || day(m.capital.firstInvest))));
}
export const all = () => snapshot?.managers || [];
/** Fund units also remain inside their custodian books; this directory is not an added NAV. */
export function listedFunds() {
  if (!snapshot) return [];
  const groups = new Map();
  for (const m of all().filter(m => m.kind === 'custodian')) for (const p of m.positions.filter(p => p.isin.startsWith('INF'))) {
    const group = groups.get(p.isin) || []; group.push({ m, p }); groups.set(p.isin, group);
  }
  const sum = values => values.every(Number.isFinite) ? values.reduce((n, v) => n + v, 0) : null;
  return [...groups].map(([isin, rows]) => {
    const marketValue = sum(rows.map(r => r.p.marketValue)), costBasis = sum(rows.map(r => r.p.costBasis));
    const p = { ...rows[0].p, quantity: sum(rows.map(r => r.p.quantity)), marketValue, costBasis, weightPct: null };
    return { id: `scheme-${isin}`, name: p.security, kind: 'listed-fund', asOf: snapshot.bookAsOf, positions: [p],
      transactions: all().filter(m => m.kind === 'custodian').flatMap(m => m.transactions.filter(t => t.isin === isin).map(t => ({ ...t, id: `${m.id}-${t.id}` }))),
      values: { marketValue, costBasis, unrealised: marketValue !== null && costBasis !== null ? marketValue - costBasis : null, cashValue: null, positionCount: 1 } };
  });
}
export const meta = () => snapshot;
export const failureInfo = () => failure;
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
function clear() { epoch++; snapshot = null; failure = null; emit(); }
onPortfolioInvalidation(clear);
onPortfolioConnection(() => { if (portfolioConnectionState() === 'locked') clear(); });
onPortfolioReady(() => { if (listeners.size && !document.hidden) load({ force: true }).catch(() => {}); });
export function load({ force = false } = {}) {
  if (pending) return pending;
  if (!force && snapshot && Date.now() - Date.parse(snapshot.checkedAt) < 55000) return Promise.resolve(snapshot);
  const generation = epoch, startedAt = Date.now();
  pending = readManagerWorkbook().then(v => {
    if (epoch !== generation) return null;
    if (!validSnapshot(v, startedAt)) throw Error('The Family manager reading was incomplete or invalid.');
    snapshot = v; failure = null; emit(); return v;
  }).catch(error => {
    if (epoch === generation) { snapshot = null; failure = String(error.message || 'Manager data is unavailable.').slice(0, 400); emit(); }
    return null;
  }).finally(() => { pending = null; });
  return pending;
}
export function watchFreshness() {
  const check = () => { if (!document.hidden) load().catch(() => {}); };
  const timer = setInterval(check, 60000);
  for (const event of ['focus', 'online', 'pageshow']) window.addEventListener(event, check);
  document.addEventListener('visibilitychange', check); check();
  return () => { clearInterval(timer); for (const event of ['focus', 'online', 'pageshow']) window.removeEventListener(event, check); document.removeEventListener('visibilitychange', check); };
}
