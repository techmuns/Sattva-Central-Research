// Portfolio-only forward calendar captured from the authenticated S Screen dashboard.
//
// The publisher page is a discovery surface, not a causal or directional signal. These rows are
// deliberately schedules: they can appear in All Alerts' Upcoming view and Ask Research evidence,
// but they do not become AI Alerts merely because an event is on the calendar.

export const SCREENER_UPCOMING_ID = 'screener-portfolio-upcoming';
export const SCREENER_UPCOMING_MAX_ROWS = 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TICKER = /^[A-Z0-9&-]{1,30}$/;

export function safeUpcomingUrl(value, { screener = false } = {}) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://www.screener.in');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (screener && !['www.screener.in', 'screener.in'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function screenerUpcomingKey(row) {
  return [row?.companyKey || row?.ticker || row?.name, row?.date, row?.eventType, row?.time || 'day'].join('|');
}

export function validateScreenerUpcomingRows(rows) {
  if (!Array.isArray(rows) || rows.length > SCREENER_UPCOMING_MAX_ROWS) throw Error('Invalid Screener upcoming rows');
  const ids = new Set();
  for (const row of rows) {
    const id = screenerUpcomingKey(row);
    const companyUrl = safeUpcomingUrl(row?.companyUrl, { screener: true });
    const sourceUrl = safeUpcomingUrl(row?.sourceUrl);
    if (
      !row ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 300 ||
      typeof row.companyKey !== 'string' ||
      !row.companyKey ||
      row.companyKey.length > 80 ||
      (row.ticker !== null && row.ticker !== undefined && (typeof row.ticker !== 'string' || !TICKER.test(row.ticker))) ||
      !DAY.test(row.date || '') ||
      (row.time !== null && row.time !== undefined && !TIME.test(row.time)) ||
      typeof row.eventType !== 'string' ||
      !row.eventType.trim() ||
      row.eventType.length > 100 ||
      !companyUrl ||
      !sourceUrl ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      ids.has(id)
    ) {
      throw Error('Invalid Screener upcoming record');
    }
    const company = new URL(companyUrl);
    if (!/^\/company\/[^/]+\/(?:consolidated\/)?$/.test(company.pathname)) throw Error('Invalid Screener upcoming company route');
    ids.add(id);
  }
  return rows;
}

