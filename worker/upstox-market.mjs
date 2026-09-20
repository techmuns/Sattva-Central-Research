import { istDate, validateQuote } from '../public/js/data/breakout-live-shared.js';

export const yahooSymbol = target => {
  if (target.yahooTicker) return /\.(NS|BO)$/.test(target.yahooTicker) ? target.yahooTicker : `${target.yahooTicker}.NS`;
  return /^\d+$/.test(target.ticker) ? `${target.ticker}.BO` : `${target.ticker.replace(/-SM$/, '')}.NS`;
};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function upstoxRows(payload, targets, bases, now = Date.now()) {
  if (payload?.status !== 'success' || !payload.data) throw Error('unavailable');
  const requested = new Map();
  for (const target of targets) requested.set(target.instrumentKey, [...(requested.get(target.instrumentKey) || []), target]);
  const rows = [];
  for (const data of Object.values(payload.data)) {
    for (const target of requested.get(data.instrument_token) || []) {
      if (data.symbol !== target.upstoxSymbol) continue;
      try {
        rows.push(validateQuote({ ticker: target.ticker, name: target.name, price: data.last_price, volume: data.volume,
          quoteAt: new Date(Number(data.last_trade_time)).toISOString(), sessionDate: istDate(Number(data.last_trade_time)),
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
  return {exchange: symbol.endsWith('.BO') ? 'BSE' : 'NSE', symbol: symbol.slice(0,-3)};
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
