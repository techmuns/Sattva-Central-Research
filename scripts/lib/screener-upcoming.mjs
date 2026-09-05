// Pure parser for the Upcoming panel on the authenticated S Screen dashboard. Publisher HTML is
// data only: nothing in it is executed, followed as an instruction, or allowed to select another
// watchlist or origin.
import {
  safeUpcomingUrl,
  screenerUpcomingKey,
  validateScreenerUpcomingRows,
} from '../../public/js/data/screener-upcoming-shared.js';

export const SCREENER_PORTFOLIO_DASHBOARD = 'https://www.screener.in/dash/10850427/';
export const SCREENER_PORTFOLIO_WATCHLIST_ID = '10850427';
export const SCREENER_PORTFOLIO_WATCHLIST_NAME = 'S Screen';

const MONTHS = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((name, i) => [name.toLowerCase(), i + 1]),
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
const classHas = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(attr(attrs, 'class'));

function companyIdentity(href) {
  const url = safeUpcomingUrl(href, { screener: true });
  if (!url) return null;
  const parsed = new URL(url);
  const match = /^\/company\/([^/]+)\/(?:consolidated\/)?$/.exec(parsed.pathname);
  if (!match) return null;
  const companyKey = decodeURIComponent(match[1]).toUpperCase();
  const ticker = /^\d+$/.test(companyKey) || !/^[A-Z0-9&-]{1,30}$/.test(companyKey) ? null : companyKey;
  return { companyKey, ticker, companyUrl: url };
}

function isoDay(year, month, day) {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function upcomingDay(label, capturedDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(capturedDay || '')) return null;
  if (/^today$/i.test(String(label || '').trim())) return capturedDay;
  const match = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})$/.exec(String(label || '').trim());
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const baseYear = Number(capturedDay.slice(0, 4));
  let day = isoDay(baseYear, month, Number(match[1]));
  if (day && day < capturedDay) day = isoDay(baseYear + 1, month, Number(match[1]));
  return day;
}

export function upcomingTime(label) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(String(label || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (match[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'a' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function eventTypeOf(html, label) {
  if (/\bicon-phone\b/.test(html)) return 'Con-call';
  if (/\bicon-chart-bar\b/.test(html)) return 'Result';
  return label;
}

function anchors(html) {
  return [...String(html || '').matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)].map((match) => ({
    href: safeUpcomingUrl(attr(match[1], 'href')),
    label: text(match[2]),
  }));
}

/** Parse one complete dashboard response into a date-normalized, portfolio-only schedule. */
export function parseScreenerUpcomingPage(html, observedAt = new Date().toISOString()) {
  const capturedMs = Date.parse(observedAt);
  if (!Number.isFinite(capturedMs)) throw Error('Invalid Screener upcoming observation time');
  const capturedDay = new Date(capturedMs + 19800000).toISOString().slice(0, 10);
  const lists = [...String(html || '').matchAll(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi)].map((match) => match[1]);
  const candidates = lists.filter((list) => {
    const headings = [...list.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/gi)].map((match) => text(match[1]));
    return headings.length && headings.every((label) => !!upcomingDay(label, capturedDay)) && /href=["']\/company\//i.test(list);
  });
  if (candidates.length !== 1) throw Error('Screener Upcoming panel unavailable or ambiguous');

  const rows = [];
  let date = null;
  for (const match of candidates[0].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/gi)) {
    const body = match[2];
    const heading = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(body);
    if (heading) {
      date = upcomingDay(text(heading[1]), capturedDay);
      continue;
    }
    const links = anchors(body);
    const company = links.map((link) => ({ ...link, identity: companyIdentity(link.href) })).find((link) => link.identity);
    if (!company || !date) throw Error('Unmapped Screener Upcoming row');
    const labelMatch = /<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi;
    let label = '';
    for (const span of body.matchAll(labelMatch)) {
      if (classHas(span[1], 'badge') || classHas(span[1], 'tag')) label = text(span[2]);
    }
    if (!label) throw Error('Screener Upcoming event label unavailable');
    const time = upcomingTime(label);
    const eventType = eventTypeOf(body, label);
    const sourceUrl = links.find((link) => link.href && link.href !== company.href)?.href || company.identity.companyUrl;
    const row = {
      ...company.identity,
      name: company.label,
      date,
      time,
      eventType,
      sourceUrl,
      observedAt,
    };
    rows.push({ ...row, id: screenerUpcomingKey(row) });
  }
  if (!rows.length) throw Error('Screener Upcoming panel is empty');
  return validateScreenerUpcomingRows(rows).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '99:99').localeCompare(String(b.time || '99:99')) || a.name.localeCompare(b.name));
}

