// Pure merge rules for the Earnings Calendar's two scheduled-event sources.
//
// Moneycontrol names scheduled result publications. Screener's authenticated Upcoming Concalls
// page names calls and investor meetings. They remain distinct event types even when the same
// company has both on one day; only duplicate invitation identities are collapsed.

import { mergeScreenerMarketUpcomingRows, safeDocumentUrl } from './screener-concalls-shared.js';

const eventIdentity = (row) =>
  row?.eventId ||
  (row?.eventType === 'Con-call'
    ? `concall:${row?.id || row?.url || ''}`
    : `result:${row?.resultDate || ''}:${row?.scId || ''}`);

function resultEvent(row) {
  return {
    ...row,
    eventId: `result:${row.resultDate || ''}:${row.scId || ''}`,
    eventType: 'Result',
    eventSource: 'Moneycontrol',
    noticeUrl: null,
  };
}

function concallEvent(row) {
  const noticeUrl = safeDocumentUrl(row.url);
  return {
    eventId: `concall:${row.id || row.url}`,
    eventType: 'Con-call',
    eventSource: 'Screener',
    scId: `screener-upcoming:${row.id || row.url}`,
    name: row.name,
    shortName: null,
    ticker: row.ticker || null,
    industry: null,
    sectorSlug: null,
    resultDate: row.date,
    displayDate: row.date,
    quarter: null,
    time: row.time || null,
    ltp: null,
    changePct: null,
    marketCap: null,
    exchange: row.exchange === 'NSE' ? 'N' : row.exchange === 'BSE' ? 'B' : null,
    mcUrl: null,
    noticeUrl,
  };
}

/**
 * Combine selected-day rows and the full date strip.
 *
 * `days` is Moneycontrol's requested window. Every current Screener invitation is added to the
 * strip even when it is months beyond that window, so a long-range announced call remains
 * navigable instead of being silently hidden by the default three-week horizon.
 */
export function mergeEarningsCalendarSources({ date, days = [], resultRows = [], upcoming = [] } = {}) {
  const calls = mergeScreenerMarketUpcomingRows(upcoming);
  const dayMap = new Map(
    days.map((day) => [day.date, {
      ...day,
      resultCount: Number(day.count) || 0,
      concallCount: 0,
      count: Number(day.count) || 0,
    }]),
  );

  for (const call of calls) {
    const old = dayMap.get(call.date) || { date: call.date, displayDate: call.date, resultCount: 0, concallCount: 0, count: 0 };
    old.concallCount += 1;
    old.count = old.resultCount + old.concallCount;
    dayMap.set(call.date, old);
  }

  const selectedCalls = calls.filter((row) => row.date === date).map(concallEvent);
  const rows = [...resultRows.map(resultEvent), ...selectedCalls];
  const unique = [...new Map(rows.map((row) => [eventIdentity(row), row])).values()].sort(
    (a, b) =>
      String(a.time || '99:99:99').localeCompare(String(b.time || '99:99:99')) ||
      String(a.name || '').localeCompare(String(b.name || '')) ||
      String(a.eventType || '').localeCompare(String(b.eventType || '')),
  );

  const selected = dayMap.get(date) || { resultCount: 0, concallCount: 0, count: 0 };
  return {
    days: [...dayMap.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    rows: unique,
    scheduledCount: selected.count,
    resultScheduledCount: selected.resultCount,
    concallScheduledCount: selected.concallCount,
  };
}
