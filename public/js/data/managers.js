// Private Family manager projection. Memory only: no public assets, browser storage or model.
import { readManagerWorkbook, onPortfolioInvalidation, onPortfolioReady, onPortfolioConnection, portfolioConnectionState } from '../research/portfolio-bridge.js';
let snapshot = null, pending = null, epoch = 0, failure = null;
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };
export { validSnapshot, managerId } from './managers-contract.js';
import { validSnapshot, managerId } from './managers-contract.js';
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
  if (pending?.generation === epoch) return pending.promise;
  if (!force && snapshot && Date.now() - Date.parse(snapshot.checkedAt) < 55000) return Promise.resolve(snapshot);
  const generation = epoch;
  const entry = { generation, promise: null };
  entry.promise = readManagerWorkbook().then(v => {
    if (epoch !== generation) return null;
    const next = { ...v, managers: v.managers.map(m => ({ ...m, id: managerId(m) })) };
    if (!validSnapshot(next, Date.parse(v.checkedAt))) throw Error('Manager identities could not be verified.');
    snapshot = next; failure = null; emit(); return next;
  }).catch(error => {
    if (epoch === generation) { snapshot = null; failure = String(error.message || 'Manager data is unavailable.').slice(0, 400); emit(); }
    return null;
  }).finally(() => { if (pending === entry) pending = null; });
  pending = entry;
  return entry.promise;
}
export function watchFreshness() {
  const check = () => { if (!document.hidden) load().catch(() => {}); };
  const timer = setInterval(check, 60000);
  for (const event of ['focus', 'online', 'pageshow']) window.addEventListener(event, check);
  document.addEventListener('visibilitychange', check); check();
  return () => { clearInterval(timer); for (const event of ['focus', 'online', 'pageshow']) window.removeEventListener(event, check); document.removeEventListener('visibilitychange', check); };
}
