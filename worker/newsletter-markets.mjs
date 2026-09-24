import { boundedJson } from '../public/js/data/family-book-contract.js';
import { expectedSession, marketWindow } from '../public/js/data/breakout-live-shared.js';

// Exact index identities checked against Upstox's NSE/BSE instrument masters, 24 Sep 2026.
// These are cash indices, never similarly named futures, ETFs or other index families.
export const INDIA_INSTRUMENTS = {
  nifty: ['NSE_INDEX|Nifty 50', 'NIFTY'],
  sensex: ['BSE_INDEX|SENSEX', 'SENSEX'],
  niftybank: ['NSE_INDEX|Nifty Bank', 'BANKNIFTY'],
  niftymid100: ['NSE_INDEX|NIFTY MIDCAP 100', 'NIFTY MIDCAP 100'],
  niftysmall100: ['NSE_INDEX|NIFTY SMLCAP 100', 'NIFTY SMLCAP 100'],
  nifty500: ['NSE_INDEX|Nifty 500', 'NIFTY 500'],
  niftyit: ['NSE_INDEX|Nifty IT', 'NIFTY IT'],
  indiavix: ['NSE_INDEX|India VIX', 'INDIA VIX'],
};
// Exact cash benchmarks from Upstox's global.json.gz master (24 Sep 2026).
// IXIX is US Tech 100, not Nasdaq Composite; BZUSD is not the BZ=F futures contract.
export const GLOBAL_INSTRUMENTS = {
  sp500: ['GLOBAL_INDEX|^GSPC', '^GSPC'], dow: ['GLOBAL_INDEX|^DJI', '^DJI'],
  nikkei: ['GLOBAL_INDEX|^N225', '^N225'], hangseng: ['GLOBAL_INDEX|^HSI', '^HSI'],
};
const GLOBAL_SESSIONS = {
  sp500: ['America/New_York', 'USD', 570, 960, 0], dow: ['America/New_York', 'USD', 570, 960, 0],
  nikkei: ['Asia/Tokyo', 'JPY', 540, 930, 15], hangseng: ['Asia/Hong_Kong', 'HKD', 570, 970, 15],
};
const instrument = id => INDIA_INSTRUMENTS[id] || GLOBAL_INSTRUMENTS[id];
export const NSE_INDICES = { nifty: 'NIFTY 50', niftybank: 'NIFTY BANK', niftymid100: 'NIFTY MIDCAP 100',
  niftysmall100: 'NIFTY SMALLCAP 100', nifty500: 'NIFTY 500', niftyit: 'NIFTY IT', indiavix: 'INDIA VIX' };
const positive = n => Number.isFinite(n) && n > 0;
const fail = reason => { throw Object.assign(new Error(`Market quote ${reason}`), { reason }); };
const differs = (a, b) => Math.abs(a - b) > Math.max(0.011, Math.abs(b) * 0.000001);
export function marketDay(at, timezone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return null; }
}
const delta = (last, prev) => ({ prev, change: prev == null ? null : last - prev, changePct: prev == null ? null : (last / prev - 1) * 100 });
const usable = r => r && ['live', 'close'].includes(r.state) && r.last != null;

function indianState(asOf, now, maxAgeMinutes = 20) {
  const day = marketDay(asOf, 'Asia/Kolkata');
  if (day !== expectedSession(now)) return 'stale';
  if (marketWindow(now).open) return now - asOf <= maxAgeMinutes * 60000 ? 'live' : 'delayed';
  // The calendar deliberately leaves Muhurat hours and future years unknown.
  // Passing the ordinary 15:30 cutoff cannot certify those sessions' close.
  return marketWindow(asOf).calendarKnown && asOf >= Date.parse(`${day}T15:30:00+05:30`) ? 'close' : 'delayed';
}

// Ordinary cash-session hours only. Unknown holidays/early closes stay visibly
// earlier/delayed rather than certifying a close from an intraday observation.
function globalState(asOf, now, config) {
  const [zone, , open, close, delayMinutes] = config;
  const minute = at => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    return Number(p.find(p => p.type === 'hour').value) * 60 + Number(p.find(p => p.type === 'minute').value);
  };
  const day = marketDay(asOf, zone), today = marketDay(now, zone);
  let expected = Date.parse(`${today}T12:00:00Z`);
  if (minute(now) < open) expected -= 86400000;
  while ([0, 6].includes(new Date(expected).getUTCDay())) expected -= 86400000;
  if (day !== new Date(expected).toISOString().slice(0, 10) || now - asOf > 4 * 86400000) return 'stale';
  if (minute(asOf) < open) fail('timestamp');
  if (minute(asOf) >= close) return 'close';
  return day === today && minute(now) < close && !delayMinutes && now - asOf <= 2 * 60000 ? 'live' : 'delayed';
}

export const BSE_SENSEX_URL = 'https://www.bseindices.com/AsiaIndexAPI/api/AsiaIndicesGraphData/w?index=16&flag=1&sector=&seriesid=R&frd=null&tod=null';
/** The public BSE Indices Sensex chart carries dated cash observations and its
 * own PreClose. value1 is pre-open and must never be substituted for value.
 * Its header clock is unreliable (09:00 on a 09:38 response); date the point.
 */
export function quoteFromBse(body, row, now) {
  if (row.id !== 'sensex' || row.symbol !== '^BSESN' || typeof body !== 'string') fail('identity');
  const parts = body.split('#@#');
  if (parts.length !== 2) fail('shape');
  const [headers, points] = parts.map(p => JSON.parse(p.replace(/\\"/g, '"')));
  if (!Array.isArray(headers) || headers.length !== 1 || headers[0]?.Scrip !== 'BSE SENSEX') fail('identity');
  if (!Array.isArray(points) || !points.length || points.length > 2000) fail('shape');
  const number = v => typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
  const prev = number(headers[0].PreClose), last = number(headers[0].LatestVal);
  if (!positive(prev) || !positive(last)) fail('shape');
  let asOf = null, sessionDate = null, previousAt = 0, pointLast = null;
  for (const point of points) {
    const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{2}) (\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(point?.date || '');
    const month = m && ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2]);
    if (!m || month < 0) fail('timestamp');
    const day = `${m[4]}-${String(month + 1).padStart(2, '0')}-${m[3]}`;
    const at = Date.parse(`${day}T${m[5]}+05:30`);
    if (!positive(at) || at > now + 60000 || at <= previousAt || marketDay(at, 'Asia/Kolkata') !== day || (sessionDate && sessionDate !== day)) fail('timestamp');
    previousAt = at; sessionDate = day;
    if (point.value === undefined) continue;
    if (at < Date.parse(`${day}T09:15:00+05:30`) || !positive(number(point.value))) fail('shape');
    asOf = at; pointLast = number(point.value);
  }
  if (!asOf || asOf !== previousAt || differs(pointLast, last)) fail('shape');
  const state = indianState(asOf, now, 2);
  return { ...row, last, ...delta(last, prev), asOf, sessionDate, state,
    timezone: 'Asia/Kolkata', currency: 'INR', origin: 'bse', checkedAt: now, changeReason: null };
}

export async function readBseSensex(row, { fetcher, now, timeout = 8000 }) {
  try {
    const res = await fetcher(BSE_SENSEX_URL, { headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0' },
      redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { await res.body?.cancel(); return { rows: new Map(), reason: [401, 403].includes(res.status) ? 'blocked' : res.status === 429 ? 'rate-limited' : 'unavailable' }; }
    const quote = quoteFromBse(await boundedJson(res, 256 * 1024), row, now);
    return { rows: new Map([[row.id, quote]]), reason: null };
  } catch (e) { return { rows: new Map(), reason: /abort|timeout/i.test(e?.name) ? 'timeout' : e.reason || 'unavailable' }; }
}

export function quoteFromNse(data, timestamp, row, now) {
  if (!NSE_INDICES[row.id] || data?.index !== NSE_INDICES[row.id]) fail('identity');
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timestamp || '');
  const month = match && ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[2]);
  if (!match || month < 0) fail('timestamp');
  const sessionDate = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]}`;
  const asOf = Date.parse(`${sessionDate}T${match[4]}:${match[5]}:${match[6] || '00'}+05:30`);
  if (!positive(asOf) || asOf > now + 60000 || marketDay(asOf, 'Asia/Kolkata') !== sessionDate) fail('timestamp');
  if (asOf < Date.parse(`${sessionDate}T09:15:00+05:30`)) fail('timestamp');
  const last = data.last, prev = data.previousClose;
  if (!positive(last) || !positive(prev) || !Number.isFinite(data.variation) || !Number.isFinite(data.percentChange)) fail('shape');
  // Exchange levels are rounded to two decimals; VIX's published percent can use
  // the unrounded values. Accept only a percent consistent with those intervals.
  const pctLow = ((last - 0.005) / (prev + 0.005) - 1) * 100;
  const pctHigh = ((last + 0.005) / (prev - 0.005) - 1) * 100;
  const conflict = differs(last - prev, data.variation) || prev <= 0.005 ||
    data.percentChange + 0.005 < pctLow || data.percentChange - 0.005 > pctHigh;
  const state = indianState(asOf, now);
  return { ...row, last, prev: conflict ? null : prev, change: conflict ? null : data.variation,
    changePct: conflict ? null : data.percentChange, asOf, sessionDate, state, timezone: 'Asia/Kolkata',
    currency: 'INR', origin: 'nse', checkedAt: now, changeReason: conflict ? 'previous-close-conflict' : null };
}

export async function readNseIndices(rows, { fetcher, now, timeout = 8000 }) {
  const requested = rows.filter(r => NSE_INDICES[r.id]);
  try {
    const res = await fetcher('https://www.nseindia.com/api/allIndices', { headers: { accept: 'application/json',
      'user-agent': 'SattvaCentralResearch/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { await res.body?.cancel(); return { rows: new Map(), reason: [401, 403].includes(res.status) ? 'blocked' : res.status === 429 ? 'rate-limited' : 'unavailable' }; }
    const body = await boundedJson(res, 1024 * 1024), found = new Map(), failures = {};
    if (!Array.isArray(body?.data)) fail('shape');
    for (const row of requested) {
      try {
        const matches = body.data.filter(q => q?.index === NSE_INDICES[row.id]);
        if (matches.length !== 1) fail('missing-or-duplicate');
        found.set(row.id, quoteFromNse(matches[0], body.timestamp, row, now));
      } catch (e) { failures[row.id] = e.reason || 'shape'; }
    }
    return { rows: found, failures, reason: found.size === requested.length ? null : 'partial' };
  } catch (e) { return { rows: new Map(), reason: /abort|timeout/i.test(e?.name) ? 'timeout' : 'unavailable' }; }
}

/** chartPreviousClose is the RANGE's starting reference, not yesterday's close.
 * Use the immediately preceding dated, unadjusted daily bar. Never skip a null bar.
 */
export function quoteFromChart(body, row, now) {
  const result = body?.chart?.result?.[0], meta = result?.meta;
  if (!meta || body.chart.error || !positive(meta.regularMarketPrice)) fail('shape');
  const aliases = row.symbol === 'JPY=X' ? ['JPY=X', 'USDJPY=X'] : [row.symbol];
  if (!aliases.includes(meta.symbol)) fail('identity');
  if (row.group === 'india' && (meta.exchangeTimezoneName !== 'Asia/Kolkata' || (meta.currency && meta.currency !== 'INR'))) fail('identity');
  const asOf = meta.regularMarketTime * 1000, timezone = meta.exchangeTimezoneName;
  if (!positive(meta.regularMarketTime) || asOf > now + 60000 || !timezone || !marketDay(asOf, timezone)) fail('timestamp');
  const sessionDate = marketDay(asOf, timezone), last = meta.regularMarketPrice;
  const times = result.timestamp, closes = result.indicators?.quote?.[0]?.close;
  let prev = null, previousSession = null, changeReason = 'previous-close-unverified';
  if (meta.dataGranularity === '1d' && Array.isArray(times) && Array.isArray(closes) && times.length === closes.length) {
    const days = times.map(t => positive(t) ? marketDay(t * 1000, timezone) : null);
    // Out-of-order / duplicate sessions cannot establish the preceding session.
    if (days.every((day, i) => day && (!i || day > days[i - 1]))) {
      const current = days.indexOf(sessionDate);
      const previous = current - 1;
      if (previous >= 0 && positive(closes[previous]) && Date.parse(sessionDate) - Date.parse(days[previous]) <= 7 * 86400000) {
        prev = closes[previous]; previousSession = days[previous]; changeReason = null;
      }
    }
  }
  if (prev != null && row.group === 'india' && marketWindow(asOf).calendarKnown &&
      previousSession !== expectedSession(Date.parse(`${sessionDate}T09:14:00+05:30`))) {
    prev = null; changeReason = 'previous-close-unverified';
  }
  if (prev != null && positive(meta.previousClose) && differs(meta.previousClose, prev)) {
    prev = null; changeReason = 'previous-close-conflict';
  }
  const regular = meta.currentTradingPeriod?.regular;
  const start = regular?.start * 1000, end = regular?.end * 1000;
  const inSession = Number.isFinite(start) && end > start && now >= start && now < end && asOf >= start;
  let state = inSession ? (now - asOf <= 20 * 60000 ? 'live' : 'delayed') : 'close';
  // A mid-session observation cannot become a close merely because the clock advanced.
  if (!inSession && asOf >= start && asOf < end - 60000) state = 'delayed';
  // Provider session bounds detect a missed open; a long gap remains visibly dated
  // even when a provider advances its next-session bounds during an outage.
  if (now - asOf > 4 * 86400000 || (Number.isFinite(start) && now >= start + 20 * 60000 && asOf < start)) state = 'stale';
  if (row.group === 'india') {
    if (sessionDate !== expectedSession(now)) state = 'stale';
    else if (!marketWindow(now).open && asOf < Date.parse(`${sessionDate}T15:30:00+05:30`)) state = 'delayed';
    else if (state === 'close' && !marketWindow(asOf).calendarKnown) state = 'delayed';
  }
  return { ...row, last, ...delta(last, prev), asOf, sessionDate, previousSession, state,
    timezone, currency: meta.currency || null, origin: 'yahoo', checkedAt: now, changeReason };
}

/** V3 prev_close_price explicitly identifies the previous trading session's close.
 * Check it against net_change; OHLC close can describe the current session.
 * Index last-trade time is required: a fresh HTTP/feed timestamp cannot date an old level.
 */
export function quoteFromUpstox(data, row, now) {
  const identity = instrument(row.id), global = GLOBAL_SESSIONS[row.id];
  if (!identity || (global && row.symbol !== identity[1]) || data?.instrument_token !== identity[0] ||
      ![identity[1], identity[0].split('|')[1].toUpperCase()].includes(String(data.symbol || '').toUpperCase())) fail('identity');
  if (!positive(data.last_price) || !Number.isFinite(data.net_change)) fail('shape');
  const asOf = typeof data.last_trade_time === 'string' && /^\d+$/.test(data.last_trade_time)
    ? Number(data.last_trade_time) : data.last_trade_time;
  if (!positive(asOf) || asOf < 1e12 || asOf > now + 60000) fail('timestamp');
  const timezone = global?.[0] || 'Asia/Kolkata';
  const sessionDate = marketDay(asOf, timezone), last = data.last_price, prev = data.prev_close_price;
  if (!positive(prev)) fail('previous-close-unverified');
  // Do not adopt a freshly dated feed at midnight / before the cash session starts.
  if (!global && asOf < Date.parse(`${sessionDate}T09:15:00+05:30`)) fail('timestamp');
  const state = global ? globalState(asOf, now, global) : indianState(asOf, now);
  const conflict = differs(last - data.net_change, prev);
  return { ...row, last, ...delta(last, conflict ? null : prev), asOf, sessionDate, state,
    timezone, currency: global?.[1] || 'INR', origin: 'upstox', checkedAt: now, delayMinutes: global?.[4] || 0,
    changeReason: conflict ? 'previous-close-conflict' : null };
}

export async function readUpstoxIndices(rows, { token, fetcher, now, timeout = 8000 }) {
  if (!token) return { rows: new Map(), reason: 'not-configured' };
  rows = rows.filter(r => instrument(r.id));
  if (!rows.length) return { rows: new Map(), reason: null };
  const url = new URL('https://api.upstox.com/v3/market-quote/quotes');
  url.searchParams.set('instrument_key', rows.map(r => instrument(r.id)[0]).join(','));
  try {
    const res = await fetcher(url.href, { headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      'user-agent': 'SattvaCentralResearch/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { await res.body?.cancel(); return { rows: new Map(), reason: [401, 403].includes(res.status) ? 'authentication' : res.status === 429 ? 'rate-limited' : 'unavailable' }; }
    const body = await boundedJson(res, 256 * 1024);
    if (body?.status !== 'success' || !body.data || typeof body.data !== 'object') fail('shape');
    const values = Object.values(body.data), found = new Map(), failures = {};
    for (const row of rows) {
      try {
        const matches = values.filter(q => q?.instrument_token === instrument(row.id)[0]);
        if (matches.length !== 1) fail('missing-or-duplicate');
        found.set(row.id, quoteFromUpstox(matches[0], row, now));
      } catch (e) { failures[row.id] = e.reason || 'shape'; }
    }
    return { rows: found, failures, reason: found.size === rows.length ? null : 'partial' };
  } catch (e) { return { rows: new Map(), reason: /abort|timeout/i.test(e?.name) ? 'timeout' : 'unavailable' }; }
}

export function reconcileIndex(yahoo, primary, primaryReason) {
  if (!usable(primary)) return { ...yahoo, verification: 'single-source', primaryReason: primaryReason || primary?.state || 'unavailable' };
  return compareIndex(yahoo, primary);
}

function compareIndex(yahoo, primary) {
  const row = { ...primary, verification: 'single-source' };
  if (!(usable(yahoo) || yahoo?.state === 'delayed' && yahoo.last != null) || yahoo.sessionDate !== primary.sessionDate) return row;
  // Closing levels can be compared; intraday quotes from different seconds can legitimately differ.
  if (yahoo.state === 'close' && primary.state === 'close' && differs(yahoo.last, primary.last)) {
    return { ...row, last: null, ...delta(null, null), state: 'unavailable', reason: 'source-conflict', verification: 'conflict' };
  }
  if (yahoo.prev != null && primary.prev != null && differs(yahoo.prev, primary.prev)) {
    return { ...row, ...delta(row.last, null), changeReason: 'previous-close-conflict', verification: 'conflict' };
  }
  if (yahoo.prev != null && primary.prev != null) row.verification = 'cross-checked';
  return row;
}

export function reconcileGlobalIndex(yahoo, primary, primaryReason) {
  if (usable(primary)) return compareIndex(yahoo, primary);
  if (primary?.state === 'delayed' && primary.last != null) {
    // A timestamped delayed quote can fill a gap, but keeps its delay label and
    // never displaces a complete current quote or claims to be a closing value.
    return usable(yahoo) && yahoo.prev != null ? compareIndex(primary, yahoo) : compareIndex(yahoo, primary);
  }
  return { ...yahoo, verification: 'single-source', primaryReason: primaryReason || primary?.state || 'unavailable' };
}

/** The exchange is preferred when usable. A corroborated exchange quote survives
 * a third provider's bad reading; unresolved disagreement still withholds figures.
 */
export function reconcileIndianIndex(yahoo, upstox, nse, primaryReason) {
  if (!usable(nse)) return reconcileIndex(yahoo, upstox, primaryReason);
  const peers = [upstox, yahoo].filter(r => usable(r) && r.sessionDate === nse.sessionDate);
  const comparisons = peers.map(peer => ({ peer, result: reconcileIndex(peer, nse) }));
  const agreed = comparisons.find(c => c.result.verification === 'cross-checked');
  const conflicts = comparisons.filter(c => c.result.verification === 'conflict');
  if (agreed) return { ...agreed.result, corroboratedBy: agreed.peer.origin,
    otherSourcesDisagree: conflicts.map(c => c.peer.origin) };
  if (conflicts.length) return conflicts[0].result;
  return { ...nse, verification: 'single-source' };
}

export const marketIssue = row => row.reason === 'source-conflict' ? 'sources disagree'
  : row.changeReason === 'previous-close-conflict' ? 'daily change withheld: sources disagree'
  : row.last != null && row.changePct == null ? 'daily change unavailable' : null;
