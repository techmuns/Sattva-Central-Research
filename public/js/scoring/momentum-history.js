// Shared calendar and volume windows for the daily capture and live scanner.
export const istDay = value => new Date(new Date(value).getTime() + 19800000).toISOString().slice(0, 10);
export const monthKey = date => String(date).slice(0, 7);
export function isoWeekKey(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7 + 3);
  const year = d.getUTCFullYear();
  return `${year}-W${String(Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
export function resample(bars, keyFn) {
  const periods = new Map();
  for (const bar of bars || []) {
    if (!bar?.date || !Number.isFinite(bar.close)) continue;
    const key = keyFn(bar.date);
    periods.set(key, { key, date: bar.date, close: bar.close });
  }
  return [...periods.values()];
}
// referenceDate is the session being screened, not the date of the last available bar.
// A Monday capture must keep the completed previous week; the first of a month keeps last month.
export function completedPeriods(bars, timeframe, referenceDate = bars?.at(-1)?.date) {
  if (!bars?.length || !referenceDate) return [];
  const keyFn = timeframe === 'week' ? isoWeekKey : monthKey;
  const current = keyFn(referenceDate);
  return resample(bars, keyFn).filter(period => period.key < current);
}
export function volumeWindow10d(bars, before, sourceSymbol) {
  const days = (bars || []).filter(bar => !before || bar.date < before).slice(-10);
  if (days.length !== 10 || new Set(days.map(bar => bar.date)).size !== 10 ||
      days.some(bar => !Number.isFinite(bar.volume) || bar.volume < 0)) return null;
  const average = days.reduce((sum, bar) => sum + bar.volume, 0) / 10;
  if (!(average > 0)) return null;
  return { average, from: days[0].date, to: days.at(-1).date, count: 10,
    exchange: sourceSymbol?.endsWith('.BO') ? 'BSE' : 'NSE' };
}
