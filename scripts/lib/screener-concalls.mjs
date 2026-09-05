// Pure parser for https://www.screener.in/concalls/. Publisher HTML is data only; nothing found
// in it is executed, followed as an instruction, or allowed to choose another collection origin.
import { safeDocumentUrl, screenerConcallKey, screenerMarketUpcomingKey } from '../../public/js/data/screener-concalls-shared.js';

const ORIGIN = 'https://www.screener.in';
const ROWS_PER_PAGE = 25;
const MONTHS = new Map(
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((name, i) => [name.toLowerCase(), i + 1]),
);

const decode = (value) =>
  String(value || '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
      const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    })
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, key) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[key.toLowerCase()]);
const text = (value) => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (value, name) => decode(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(value)?.[2] || '');
const anchors = (html) =>
  [...String(html || '').matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)].map((match) => ({
    href: safeDocumentUrl(attr(match[1], 'href')),
    label: text(match[2]),
  }));

export function screenerDay(value) {
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const day = `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  const date = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

export function screenerTime(value) {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)\s*(AM|PM)$/i.exec(String(value || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  if (hour < 1 || hour > 12) return null;
  if (match[4].toUpperCase() === 'AM') hour %= 12;
  else hour = (hour % 12) + 12;
  return `${String(hour).padStart(2, '0')}:${match[2]}:${match[3]}`;
}

function companyIdentity(url) {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.screener.in', 'screener.in'].includes(parsed.hostname)) return null;
  const match = /^\/company\/([^/]+)\/(?:consolidated\/)?$/.exec(parsed.pathname);
  if (!match) return null;
  const companyKey = decodeURIComponent(match[1]).toUpperCase();
  return { companyKey, ticker: /^\d+$/.test(companyKey) || !/^[A-Z0-9&-]{1,30}$/.test(companyKey) ? null : companyKey };
}

function kindOf(label) {
  const match = /^View\s+(Transcript|Recording|Presentation)\b/i.exec(label || '');
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` : null;
}

export function parseScreenerConcallPage(html, observedAt = new Date().toISOString()) {
  const table = /<table\b[^>]*\bid=["']result_list["'][^>]*>([\s\S]*?)<\/table>/i.exec(String(html || ''))?.[1];
  if (!table) throw Error('Screener concall table unavailable');
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => ({ attrs: cell[1], html: cell[2] }));
    if (!cells.length || !cells.some((cell) => /\bfield-company_display\b/.test(attr(cell.attrs, 'class')))) continue;
    if (cells.length !== 3) throw Error('Screener concall columns changed');
    const companyLinks = anchors(cells[0].html);
    const company = companyLinks.find((link) => companyIdentity(link.href));
    const identity = companyIdentity(company?.href);
    const name = text(cells[0].html);
    const publishedDate = screenerDay(text(cells[1].html));
    const actionLinks = anchors(cells[2].html);
    const action = actionLinks.map((link) => ({ ...link, kind: kindOf(link.label) })).find((link) => link.kind);
    const summaryUrl = actionLinks.find((link) => {
      if (!link.href) return false;
      const url = new URL(link.href);
      return url.protocol === 'https:' && ['www.screener.in', 'screener.in'].includes(url.hostname) && /^\/concalls\/summary\/\d+\/$/.test(url.pathname);
    })?.href || null;
    if (!identity || !name || !publishedDate || !action?.href) throw Error('Unmapped Screener concall row');
    const row = {
      companyKey: identity.companyKey,
      ticker: identity.ticker,
      name,
      companyUrl: company.href,
      publishedDate,
      kind: action.kind || 'Other',
      url: action.href,
      summaryUrl,
      observedAt,
    };
    rows.push({ ...row, id: screenerConcallKey(row) });
  }
  if (!rows.length) throw Error('Screener concall page is empty');

  const countMatch = /([\d,]+)\s+concalls\b/i.exec(text(html));
  const publishedTotal = countMatch ? Number(countMatch[1].replace(/,/g, '')) : null;
  const pages = [...String(html).matchAll(/[?&]p=(\d+)/g)].map((match) => Number(match[1])).filter(Number.isSafeInteger);
  // Screener serves 25 rows on every page except the last. Using this page's row count as the
  // divisor would make the final short page invent a larger page count halfway through a crawl.
  const lastPage = Math.max(1, ...pages, publishedTotal ? Math.ceil(publishedTotal / ROWS_PER_PAGE) : 1);
  if (!Number.isSafeInteger(publishedTotal) || publishedTotal < rows.length || lastPage < 1) throw Error('Screener concall pagination unavailable');
  return { rows, publishedTotal, lastPage };
}

export function addResolvedTickers(rows, resolve) {
  return rows.map((row) => {
    if (row.ticker) return row;
    const ticker = resolve(row.name);
    return ticker ? { ...row, ticker } : row;
  });
}

const upcomingCompanyKey = (name) => text(name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 80) || null;
const exchangeOf = (value) => {
  const url = new URL(value);
  if (url.hostname === 'nsearchives.nseindia.com') return 'NSE';
  if (url.hostname === 'www.bseindia.com' || url.hostname === 'bseindia.com') return 'BSE';
  return null;
};

/** Parse one authenticated page from Screener's Upcoming Concalls table. */
export function parseScreenerMarketUpcomingPage(html, observedAt = new Date().toISOString()) {
  const source = String(html || '');
  const table = /<table\b[^>]*\bid=["']result_list["'][^>]*>([\s\S]*?)<\/table>/i.exec(source)?.[1];
  if (!table) throw Error('Screener upcoming table unavailable');
  const countMatch = /([\d,]+)\s+concall\s+invites?\b/i.exec(text(source));
  const publishedTotal = countMatch ? Number(countMatch[1].replace(/,/g, '')) : null;
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => ({ attrs: cell[1], html: cell[2] }));
    if (!cells.length || !cells.some((cell) => /\bfield-company_object_display\b/.test(attr(cell.attrs, 'class')))) continue;
    if (cells.length !== 3) throw Error('Screener upcoming columns changed');
    const companyLinks = anchors(cells[0].html);
    const company = companyLinks.find((link) => link.href && link.label) || companyLinks.find((link) => link.href);
    const name = text(cells[0].html);
    const companyKey = upcomingCompanyKey(name);
    const date = screenerDay(text(cells[1].html));
    const time = screenerTime(text(cells[2].html));
    if (!companyKey || !name || !company?.href || !date || !time) throw Error('Unmapped Screener upcoming row');
    const row = {
      companyKey,
      ticker: null,
      name,
      date,
      time,
      exchange: exchangeOf(company.href),
      url: company.href,
      observedAt,
    };
    rows.push({ ...row, id: screenerMarketUpcomingKey(row) });
  }
  if (!rows.length && publishedTotal !== 0) throw Error('Screener upcoming page is empty');

  const pages = [...source.matchAll(/[?&]p=(\d+)/g)].map((match) => Number(match[1])).filter(Number.isSafeInteger);
  const lastPage = Math.max(1, ...pages, publishedTotal ? Math.ceil(publishedTotal / ROWS_PER_PAGE) : 1);
  if (!Number.isSafeInteger(publishedTotal) || publishedTotal < rows.length || lastPage < 1) throw Error('Screener upcoming pagination unavailable');
  return { rows, publishedTotal, lastPage };
}

export const SCREENER_CONCALL_URL = `${ORIGIN}/concalls/`;
export const SCREENER_MARKET_UPCOMING_URL = `${ORIGIN}/concalls/upcoming/`;
