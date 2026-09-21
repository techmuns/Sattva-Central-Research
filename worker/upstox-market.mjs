import { istDate, validateQuote } from '../public/js/data/breakout-live-shared.js';

// Verified against each provider's exact BSE identity, 21 September 2026.
const YAHOO_BSE = {BENGALASM:'BENGALASM.BO','543225':'ALTIUSINVIT.BO','504375':'IDREAM.BO'};
export const yahooSymbol = target => {
  if (target.yahooTicker) return /\.(NS|BO)$/.test(target.yahooTicker) ? target.yahooTicker : `${target.yahooTicker}.NS`;
  if (YAHOO_BSE[target.ticker]) return YAHOO_BSE[target.ticker];
  return /^\d+$/.test(target.ticker) ? `${target.ticker}.BO` : `${target.ticker.replace(/-SM$/, '')}.NS`;
};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sourceTime = value => typeof value === 'number' || /^\d{13}$/.test(value || '') ? Number(value) : Date.parse(value);
export function upstoxRows(payload, targets, bases, now = Date.now()) {
  if (payload?.status !== 'success' || !payload.data) throw Error('unavailable');
  const requested = new Map();
  for (const target of targets) requested.set(target.instrumentKey, [...(requested.get(target.instrumentKey) || []), target]);
  const rows = [];
  for (const data of Object.values(payload.data)) {
    for (const target of requested.get(data.instrument_token) || []) {
      if (data.symbol !== target.upstoxSymbol) continue;
      try {
        const tradeAt = Number(data.last_trade_time), sourceAt = sourceTime(data.timestamp);
        if (!Number.isFinite(tradeAt) || tradeAt <= 0) continue;
        const feedAt = Number.isFinite(sourceAt) && sourceAt >= tradeAt && sourceAt <= now + 60000 ? sourceAt : null;
        rows.push(validateQuote({ ticker: target.ticker, name: target.name, price: data.last_price, volume: data.volume,
          quoteAt: new Date(tradeAt).toISOString(), ...(feedAt ? {feedAt:new Date(feedAt).toISOString()} : {}), sessionDate: istDate(feedAt || tradeAt),
          checkedAt: new Date(now).toISOString(), provider: 'Upstox', exchange: target.exchange,
          prevClose: number(data.net_change) == null ? null : data.last_price - data.net_change,
          base: bases.get(target.ticker) || null }, now));
      } catch { /* Missing/invalid rows remain explicit failures in the caller. */ }
    }
  }
  return rows;
}
export const upstoxIdentity = target => {
  const symbol = yahooSymbol(target);
  const exchange = symbol.endsWith('.BO') ? 'BSE' : 'NSE';
  return {exchange, symbol: exchange==='BSE' && /^\d+$/.test(target.ticker) ? target.ticker : symbol.slice(0,-3)};
};
export function mapUpstoxTargets(targets, instruments) {
  const index = new Map();
  const add = (key, item) => {
    if (!index.has(key)) index.set(key, item);
    else if (index.get(key)?.instrument_key !== item.instrument_key) index.set(key, null);
  };
  for (const item of instruments) {
    if (!item || !['NSE_EQ','BSE_EQ'].includes(item.segment) || !new RegExp(`^${item.segment}\\|IN[A-Z0-9]{10}$`).test(item.instrument_key || '') || !item.trading_symbol) continue;
    const exchange = item.segment.slice(0,3);
    // NSE_EQ also contains corporate bonds with the SAME trading symbol as shares.
    // These securities cannot identify a share-price target. Keep SME/trust series.
    if (exchange === 'NSE' && item.instrument_type && !['EQ','BE','BZ','SM','ST','SZ','RR','IV','IT','E1'].includes(item.instrument_type)) continue;
    // Cash-market series include SME shares, REITs and InvITs as well as EQ.
    // Match exact exchange identities; never guess a company from its name.
    add(`${exchange}:symbol:${item.trading_symbol}`, item);
    add(`${exchange}:isin:${item.instrument_key.split('|')[1]}`, item);
    if (exchange === 'BSE' && /^\d+$/.test(String(item.exchange_token))) add(`BSE:code:${item.exchange_token}`, item);
  }
  return targets.flatMap(target => {
    const {exchange,symbol} = upstoxIdentity(target);
    const kind = target.isin ? 'isin' : exchange === 'BSE' && /^\d+$/.test(symbol) ? 'code' : 'symbol';
    const item = index.get(`${exchange}:${kind}:${target.isin || symbol}`);
    return item ? [{...target,exchange,instrumentKey:item.instrument_key,upstoxSymbol:item.trading_symbol}] : [];
  });
}
