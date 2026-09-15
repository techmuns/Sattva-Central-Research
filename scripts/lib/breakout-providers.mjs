import { gunzipSync } from 'node:zlib';
import { boundedJson } from '../../public/js/data/family-book-contract.js';
import { istDate, validateQuote, expectedSession } from '../../public/js/data/breakout-live-shared.js';

export const yahooSymbol = target => {
  if (target.yahooTicker) return /\.(NS|BO)$/.test(target.yahooTicker) ? target.yahooTicker : `${target.yahooTicker}.NS`;
  return /^\d+$/.test(target.ticker) ? `${target.ticker}.BO` : `${target.ticker.replace(/-SM$/, '')}.NS`;
};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function baseFromBars(bars, sessionDate) {
  const days = bars.filter(row => row.date < sessionDate).sort((a,b)=>a.date.localeCompare(b.date)).slice(-30);
  if (days.length !== 30 || new Set(days.map(row=>row.date)).size !== 30 || days.at(-1).date !== expectedSession(Date.parse(`${sessionDate}T09:00:00+05:30`)) || days.some(row => !Number.isFinite(row.volume) || row.volume < 0)) return null;
  const averageVolume = days.reduce((sum, row) => sum + row.volume, 0) / 30;
  if (!(averageVolume > 0)) return null;
  return { high: Math.max(...days.map(row => row.high)), low: Math.min(...days.map(row => row.low)),
    average: days.reduce((sum, row) => sum + row.close, 0) / 30, averageVolume, count: 30, to: days.at(-1).date };
}
export function parseYahooQuote(payload, target, now = Date.now()) {
  const result = payload?.chart?.result?.[0], meta = result?.meta, q = result?.indicators?.quote?.[0];
  if (!meta || !q || meta.symbol !== yahooSymbol(target)) throw Error('unavailable');
  const quoteAt = new Date(meta.regularMarketTime * 1000).toISOString(), sessionDate = istDate(quoteAt);
  const bars = (result.timestamp || []).map((at, index) => ({ date: istDate(at * 1000), close: number(q.close?.[index]),
    high: number(q.high?.[index]), low: number(q.low?.[index]), volume: number(q.volume?.[index]) }))
    .filter(row => row.close > 0 && row.high > 0 && row.low > 0);
  const day = bars.findLast(row => row.date === sessionDate);
  const base = baseFromBars(bars, sessionDate);
  const row = validateQuote({ ticker: target.ticker, name: target.name, price: meta.regularMarketPrice,
    volume: number(meta.regularMarketVolume) ?? day?.volume, quoteAt, sessionDate,
    checkedAt: new Date(now).toISOString(), provider: 'Yahoo Finance', exchange: yahooSymbol(target).endsWith('.BO') ? 'BSE' : 'NSE', base,
    prevClose: bars.filter(row => row.date < sessionDate).at(-1)?.close }, now);
  return { ...row, historyBars: bars };
}
export async function yahooQuote(target, { now = Date.now, fetcher = fetch } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(target))}?range=3mo&interval=1d`;
  const response = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 429 ? 'rate-limited' : 'unavailable'); }
  return parseYahooQuote(await boundedJson(response, 512 * 1024), target, now());
}
export function upstoxRows(payload, targets, bases, now = Date.now()) {
  if (payload?.status !== 'success' || !payload.data) throw Error('unavailable');
  const requested = new Map(targets.map(target => [target.instrumentKey, target]));
  const rows = [];
  for (const data of Object.values(payload.data)) {
    const target = requested.get(data.instrument_token);
    if (!target || data.symbol !== target.ticker) continue;
    try {
      rows.push(validateQuote({ ticker: target.ticker, name: target.name, price: data.last_price, volume: data.volume,
        quoteAt: new Date(Number(data.last_trade_time)).toISOString(), sessionDate: istDate(Number(data.last_trade_time)),
        checkedAt: new Date(now).toISOString(), provider: 'Upstox', prevClose: number(data.net_change) == null ? null : data.last_price - data.net_change,
        base: bases.get(target.ticker) || null }, now));
    } catch { /* Missing/invalid rows remain explicit failures in the caller. */ }
  }
  return rows;
}
export async function upstoxQuotes(targets, bases, { token, fetcher = fetch, now = Date.now, instruments, historyBudgetMs = 90000 } = {}) {
  if (!token) return { rows: [], reason: 'not-configured' };
  if (!instruments) {
    const response = await fetcher('https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz', { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error('unmapped');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 20 * 1024 * 1024) throw Error('unmapped'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    instruments = JSON.parse(gunzipSync(Buffer.concat(chunks), { maxOutputLength: 100 * 1024 * 1024 }).toString());
  }
  const bySymbol = new Map();
  for (const item of instruments) if (item.segment === 'NSE_EQ' && item.instrument_type === 'EQ' && /^NSE_EQ\|IN[A-Z0-9]{10}$/.test(item.instrument_key || '')) {
    if (bySymbol.has(item.trading_symbol)) bySymbol.set(item.trading_symbol, null);
    else bySymbol.set(item.trading_symbol, item.instrument_key);
  }
  const mapped = targets.map(target => ({ ...target, instrumentKey: bySymbol.get(target.ticker) })).filter(target => target.instrumentKey);
  const rows = [];
  for (let i = 0; i < mapped.length; i += 500) {
    const batch = mapped.slice(i, i + 500);
    const url = new URL('https://api.upstox.com/v2/market-quote/quotes');
    url.searchParams.set('instrument_key', batch.map(target => target.instrumentKey).join(','));
    const response = await fetcher(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); return { rows, reason: [401,403].includes(response.status) ? 'authentication' : response.status === 429 ? 'rate-limited' : 'unavailable' }; }
    rows.push(...upstoxRows(await boundedJson(response, 4 * 1024 * 1024), batch, bases, now()));
  }
  // On a primary-feed outage, obtain the base from Upstox too. This only runs for
  // missing bases, and stops at its deadline or rate limit instead of hammering the source.
  const missingBase = rows.filter(row => !row.base), deadline = now() + historyBudgetMs;
  let historyStopped = false;
  for (let i=0; i<missingBase.length && !historyStopped && now()<deadline; i+=4) {
    await Promise.all(missingBase.slice(i,i+4).map(async row => {
      const target = mapped.find(target => target.ticker === row.ticker);
      const start = istDate(Date.parse(row.quoteAt)-90*86400000);
      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(target.instrumentKey)}/days/1/${row.sessionDate}/${start}`;
      try {
        const response = await fetcher(url, {headers:{authorization:`Bearer ${token}`,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
        if (!response.ok) { if ([401,403,429].includes(response.status)) historyStopped=true; await response.body?.cancel(); return; }
        const data = await boundedJson(response, 512*1024);
        if (data.status !== 'success' || !Array.isArray(data.data?.candles)) return;
        const bars = data.data.candles.map(c => ({date:istDate(c[0]),high:number(c[2]),low:number(c[3]),close:number(c[4]),volume:number(c[5])}))
          .filter(bar=>bar.high>0 && bar.low>0 && bar.close>0).sort((a,b)=>a.date.localeCompare(b.date));
        const base = baseFromBars(bars,row.sessionDate);
        if (base) { row.base=base; row.historyBars=bars; }
      } catch { /* The quote remains usable; the missing base remains explicit. */ }
    }));
  }
  return { rows, reason: mapped.length < targets.length ? 'unmapped' : historyStopped ? 'history-unavailable' : null };
}

// Recovery uses completed 15-minute candles. These are explicitly labelled historical,
// never treated as a quote or allowed to replace the newest observed price.
export async function recoverYahoo(target, current, from, { now = Date.now, fetcher = fetch } = {}) {
  const response = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(target))}?range=5d&interval=15m`, {
    headers: {'user-agent':'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)'}, redirect:'error', signal:AbortSignal.timeout(12000) });
  if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 429 ? 'rate-limited' : 'unavailable'); }
  return recoveryCandles(await boundedJson(response, 1024*1024), target, current, from, now());
}
export function recoveryCandles(payload, target, current, from, now = Date.now()) {
  const result = payload?.chart?.result?.[0], q = result?.indicators?.quote?.[0];
  if (result?.meta?.symbol !== yahooSymbol(target) || !q) throw Error('unavailable');
  const rows = []; let date = null, volume = 0, expected = null, complete = false;
  for (const [index, second] of (result.timestamp || []).entries()) {
    const start = second * 1000, day = istDate(start), end = start + 15*60000;
    if (date !== day) { date = day; volume = 0; expected = Date.parse(`${day}T09:15:00+05:30`); complete = true; }
    if (start !== expected || !Number.isFinite(q.volume?.[index]) || q.volume[index] < 0) complete = false;
    expected = end;
    volume += q.volume?.[index] || 0;
    if (!complete || end <= from || end > now || end > Date.parse(`${day}T15:30:00+05:30`)) continue;
    const base = current.historyBars ? baseFromBars(current.historyBars, day) : day === current.sessionDate ? current.base : null;
    if (!base) continue;
    try { rows.push(validateQuote({ticker:target.ticker,name:target.name,price:q.close?.[index],volume,
      quoteAt:new Date(end).toISOString(),checkedAt:new Date(now).toISOString(),sessionDate:day,provider:'Yahoo Finance',exchange:yahooSymbol(target).endsWith('.BO')?'BSE':'NSE',kind:'recovered-candle',base,
      prevClose:current.historyBars?.filter(bar=>bar.date<day).at(-1)?.close || null},now)); } catch { /* An invalid candle remains a gap. */ }
  }
  return rows;
}
