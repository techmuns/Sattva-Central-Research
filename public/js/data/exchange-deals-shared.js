// Sattva-owned exchange history. Compact tuples keep a year of reports inexpensive to deliver.
// source id, date, exchange security id, display name, client, side, shares, price, remarks.
import { mergeInsiderTrades } from './insider-history.js';
export const EXCHANGE_SOURCES = [
  { id: 'nse-bulk', exchange: 'NSE', category: 'Bulk deal', url: 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals' },
  { id: 'nse-block', exchange: 'NSE', category: 'Block deal', url: 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals' },
  { id: 'bse-bulk', exchange: 'BSE', category: 'Bulk deal', url: 'https://www.bseindia.com/markets/equity/eqreports/bulk_deals' },
  { id: 'bse-block', exchange: 'BSE', category: 'Block deal', url: 'https://www.bseindia.com/markets/equity/eqreports/block_deals' },
];
const fullName = (s) => String(s || '').normalize('NFKC').toUpperCase().replace(/\bPVT\b/g, 'PRIVATE').replace(/\bLTD\b/g, 'LIMITED').replace(/[^A-Z0-9]/g, '');
export const exchangeDealKey = (r) => [r[0], r[1], r[2], fullName(r[4]), r[5], r[6], r[7]].join('|');
export const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function validateExchangeSnapshot(data) {
  if (data?.version !== 1 || !Array.isArray(data.records) || !Array.isArray(data.sources) || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error('Unreadable exchange capture');
  if (data.sources.length !== 4 || new Set(data.sources.map((s) => s.id)).size !== 4) throw new Error('Incomplete exchange source manifest');
  for (const s of data.sources) {
    if (!EXCHANGE_SOURCES.some((c) => c.id === s.id) || !Array.isArray(s.coverage) || s.coverage.some((w) => !validDay(w.from) || !validDay(w.to) || w.from > w.to)) throw new Error('Invalid exchange coverage');
  }
  for (const r of data.records) {
    if (!Array.isArray(r) || !EXCHANGE_SOURCES.some((s) => s.id === r[0]) || !validDay(r[1]) || !(r[0].startsWith('bse-') ? /^\d{6}$/.test(r[2]) : /^[A-Z0-9&_.+\-]+$/.test(r[2])) || typeof r[3] !== 'string' || !r[3].trim() || typeof r[4] !== 'string' || !r[4].trim() || !['Buy', 'Sell'].includes(r[5]) || !Number.isSafeInteger(r[6]) || r[6] <= 0 || !Number.isFinite(r[7]) || r[7] < 0) throw new Error('Invalid exchange deal');
  }
  if (data.insiders) {
    if (!Array.isArray(data.insiders.targetTickers) || !data.insiders.byTicker || typeof data.insiders.byTicker !== 'object') throw new Error('Unreadable insider checkpoint');
    for (const entry of Object.values(data.insiders.byTicker)) {
      if (!Array.isArray(entry.trades) || entry.trades.some(r => !r?.ticker || !r.cells || typeof r.cells !== 'object')) throw new Error('Unreadable insider checkpoint rows');
    }
  }
  return data;
}
export const supplementalInsiders = snapshot => Object.values(snapshot?.insiders?.byTicker || {}).flatMap(entry => entry.trades || []);
export const sourceCovers = (source, date) => (source?.coverage || []).some((w) => w.from <= date && date <= w.to);
export function exchangeRows(snapshot) {
  return (snapshot?.records || []).map(([sourceId, date, security, company, client, side, quantity, price, remarks]) => {
    const source = EXCHANGE_SOURCES.find((s) => s.id === sourceId);
    const ticker = source.exchange === 'BSE' ? snapshot.securityMap?.[security]?.ticker || security : security;
    return { ticker, date, sourceId, url: source.url, exchangeSecurity: security,
      cells: { 'Trade Category': source.category, Company: snapshot.securityMap?.[security]?.name || company,
        Insider: client, Transaction: side, 'Trade Shares': String(quantity), Price: String(price),
        'Trade Value': `≈ ₹${(quantity * price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
        Exchange: source.exchange, ...(source.exchange === 'BSE' ? { 'BSE Code': security, 'Reported security': company } : {}),
        ...(remarks && remarks !== '-' ? { Remarks: remarks } : {}), Source: source.exchange } };
  });
}
/** Official reports replace secondary reports only inside successfully retrieved coverage.
 * No guesses about a missing exchange, rounded quantity, or similar client name are necessary.
 * The secondary capture remains stored and fills dates/venues outside official coverage.
 */
export function combineExchangeDeals(secondary, snapshot, officialRows = exchangeRows(snapshot), supplement = supplementalInsiders(snapshot)) {
  const kept = mergeInsiderTrades(secondary, supplement).filter((row) => {
    const category = row.cells?.['Trade Category'];
    if (!['Bulk deal', 'Block deal'].includes(category)) return true;
    const exchange = String(row.cells?.Exchange || '').toUpperCase();
    const needed = EXCHANGE_SOURCES.filter((s) => s.category === category && (!['BSE', 'NSE'].includes(exchange) || s.exchange === exchange));
    return !needed.every((s) => sourceCovers(snapshot?.sources?.find((v) => v.id === s.id), row.date));
  });
  return [...kept, ...officialRows];
}
export function exchangeSummary(snapshot, deliveryError = null, now = Date.now()) {
  if (!snapshot) return 'NSE / BSE reports are loading.';
  const identityNote = snapshot.identity?.ok === false ? ' Security mapping refresh failed; last verified identifiers are retained.' : '';
  const failed = snapshot.sources.filter((s) => !s.ok).map((s) => `${s.id.toUpperCase()}: ${s.error || 'unavailable'}`);
  const oldestSuccess = snapshot.sources.map(s => Date.parse(s.lastSuccessAt)).filter(Number.isFinite);
  const age = oldestSuccess.length === 4 ? now - Math.min(...oldestSuccess) : Infinity;
  const stale = age > 3 * 60 * 60 * 1000 ? ' Capture is delayed; retained reports are shown.' : '';
  const latest = snapshot.records.reduce((last, r) => r[1] > last ? r[1] : last, '');
  return `NSE + BSE · ${snapshot.records.length.toLocaleString('en-IN')} reports · latest deal ${latest || 'none reported'} · checked ${new Date(snapshot.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST.${stale}${failed.length ? ` Source gaps: ${failed.join('; ')}.` : ''}${identityNote}${deliveryError ? ` ${deliveryError}` : ''}`;
}

export function insiderSummary(snapshot, tickers, now = Date.now()) {
  const source = snapshot?.insiders;
  if (!source) return 'Supplementary insider disclosures have not been checked yet.';
  const wanted = tickers?.length ? tickers : source.targetTickers;
  const checks = wanted.map(t => source.byTicker[t]);
  const good = checks.filter(c => c?.lastSuccessAt);
  const latest = good.flatMap(c => c.trades).reduce((d, r) => r.date > d ? r.date : d, '');
  const missing = checks.filter(c => !c?.lastSuccessAt).length;
  const failed = checks.filter(c => c?.error).length;
  const delayed = good.filter(c => now - Date.parse(c.lastSuccessAt) > 4 * 3600000).length;
  const oldest = good.map(c => c.lastSuccessAt).sort()[0];
  const checked = oldest ? ` · oldest successful check ${new Date(oldest).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST` : '';
  return `Muns insider disclosures · ${good.length}/${wanted.length} companies checked · latest disclosure ${latest || 'none reported'}${checked}.` +
    (missing ? ` ${missing} unchecked.` : '') + (failed ? ` ${failed} failed checks; retained disclosures shown.` : '') +
    (delayed ? ` ${delayed} company checks are delayed.` : '') + (source.error ? ` ${source.error}` : '');
}
