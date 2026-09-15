// Shared capture contract. Quotes never overwrite the completed-session technical score.
export const BREAKOUT_INTERVAL_MS = 15 * 60000;
export const BREAKOUT_MAX_AGE_MS = 20 * 60000;
export const BREAKOUT_WORKFLOW = 'breakouts-refresh.yml';
export const BREAKOUT_OBJECT = 'breakout-capture:v1';
export const BREAKOUT_ORIGIN = 'https://sattva-central-research.tech-441.workers.dev';
export const BREAKOUT_ENDPOINT = `${BREAKOUT_ORIGIN}/api/breakouts/collector`;
export const BREAKOUT_LIMIT = 5000;
export const BREAKOUT_BATCH = 50;
export const tickerValid = value => typeof value === 'string' && /^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(value);
const positive = value => Number.isFinite(value) && value > 0;
export const istDate = value => new Date(new Date(value).getTime() + 19800000).toISOString().slice(0, 10);
const holidays2026 = new Set(['01-26','03-03','03-26','03-31','04-03','04-14','05-01','05-28','06-26','09-14','10-02','10-20','11-10','11-24','12-25']);
// NSE/CMTR/71775. Unknown future calendars remain explicit; collection still attempts weekdays.
// Muhurat timing is not yet announced: the exceptional date is checked throughout the day.
export function marketWindow(now = Date.now()) {
  const d = new Date(now + 19800000), day = d.toISOString().slice(0, 10);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const special = day === '2026-11-08';
  const tradingDay = special || (d.getUTCDay() > 0 && d.getUTCDay() < 6 && !(d.getUTCFullYear() === 2026 && holidays2026.has(day.slice(5))));
  return { day, calendarKnown: d.getUTCFullYear() === 2026 && !special,
    collect: tradingDay && (special || (minutes >= 555 && minutes <= 975)),
    open: tradingDay && (special || (minutes >= 555 && minutes < 930)) };
}
export function expectedSession(now = Date.now()) {
  let at = now;
  if (new Date(now + 19800000).getUTCHours() * 60 + new Date(now + 19800000).getUTCMinutes() < 555) at -= 86400000;
  for (let i = 0; i < 10; i++, at -= 86400000) {
    const d = new Date(at + 19800000);
    if (istDate(at) === '2026-11-08' || (d.getUTCDay() > 0 && d.getUTCDay() < 6 && !(d.getUTCFullYear() === 2026 && holidays2026.has(istDate(at).slice(5))))) return istDate(at);
  }
  return null;
}
export function validateQuote(row, now = Date.now()) {
  if (!row || !tickerValid(row.ticker) || !positive(row.price) || !Number.isFinite(row.volume) || row.volume < 0 ||
      !['Yahoo Finance', 'Upstox'].includes(row.provider) || !Number.isFinite(Date.parse(row.quoteAt)) ||
      !Number.isFinite(Date.parse(row.checkedAt)) || Date.parse(row.quoteAt) > now + 60000 || Date.parse(row.checkedAt) > now + 60000 ||
      row.sessionDate !== istDate(row.quoteAt)) throw Error('Invalid market observation');
  const base = row.base;
  if (base != null && (!positive(base.high) || !positive(base.low) || base.high < base.low || !positive(base.average) ||
      !positive(base.averageVolume) || base.count !== 30 || !/^\d{4}-\d{2}-\d{2}$/.test(base.to) || base.to >= row.sessionDate)) throw Error('Invalid breakout base');
  return { ticker: row.ticker, name: String(row.name || row.ticker).slice(0, 180), price: row.price,
    volume: row.volume, prevClose: positive(row.prevClose) ? row.prevClose : null,
    quoteAt: new Date(row.quoteAt).toISOString(), checkedAt: new Date(row.checkedAt).toISOString(),
    sessionDate: row.sessionDate, provider: row.provider, exchange: row.exchange === 'BSE' ? 'BSE' : 'NSE', kind: row.kind === 'recovered-candle' ? 'recovered-candle' : 'quote',
    base: base ? { high: base.high, low: base.low, average: base.average, averageVolume: base.averageVolume, count: 30, to: base.to } : null };
}
export function quoteFresh(row, now = Date.now()) {
  if (!row || row.sessionDate !== expectedSession(now)) return false;
  if (marketWindow(now).open) return now - Date.parse(row.quoteAt) <= BREAKOUT_MAX_AGE_MS;
  // After the session, an earlier intraday quote is not a closing observation.
  return Date.parse(row.quoteAt) >= Date.parse(`${row.sessionDate}T15:10:00+05:30`) && Date.parse(row.checkedAt) >= Date.parse(`${row.sessionDate}T15:30:00+05:30`);
}
// On the same date, a completed daily close wins over a stale intraday observation.
// With no daily price, retain the last available observation with its original time.
export function preferQuote(row, daily, now = Date.now()) {
  return !!row && (!positive(daily?.cmp) || !daily.price_date || row.sessionDate > daily.price_date ||
    (row.sessionDate === daily.price_date && quoteFresh(row, now)));
}
export function liveBreakout(row) {
  if (!row?.base) return null;
  const b = row.base, range = (b.high - b.low) / b.average * 100;
  const ratio = row.volume / b.averageVolume, breaks = row.price > b.high;
  return { base_range_pct: range, base_max: b.high, today_close: row.price, today_volume_ratio: ratio,
    tight_base: range < 12, breaks_out: breaks, volume_confirm: ratio > 1.5,
    quality: !breaks ? 'no_breakout' : ratio <= 1.5 ? 'low_volume' : range < 12 ? 'strong' : 'weak_base' };
}
export function liveCoverage(capture, tickers, now = Date.now()) {
  const rows = new Map((capture?.rows || []).map(row => [row.ticker, row]));
  const failed = new Set((capture?.failures || []).map(item => item.ticker));
  const missing = tickers.filter(ticker => failed.has(ticker) || !quoteFresh(rows.get(ticker), now) || !rows.get(ticker)?.base);
  const pending = capture?.state !== 'complete';
  return { checked: tickers.length - missing.length, total: tickers.length, missing,
    partial: !tickers.length || !!missing.length || pending || capture?.discoveryFailed === true || !marketWindow(now).calendarKnown,
    checkedAt: capture?.completedAt || null, pending };
}

// Expected completed regular-session candle slots. Unknown special sessions stay explicit.
export function recoverySlots(from, to) {
  const slots = [];
  let at = Math.floor(from / BREAKOUT_INTERVAL_MS) * BREAKOUT_INTERVAL_MS + BREAKOUT_INTERVAL_MS;
  for (; at <= to; at += BREAKOUT_INTERVAL_MS) {
    const before = marketWindow(at - 1);
    if (before.open && before.calendarKnown) slots.push(at);
  }
  return slots;
}
