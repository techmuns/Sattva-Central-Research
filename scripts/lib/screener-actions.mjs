// Pure parser for Screener's authenticated corporate-action catalogues. Publisher HTML is treated
// only as data; URLs are pinned to known HTTPS routes and nothing from the page is executed.
import { screenerActionKey } from '../../public/js/data/corporate-actions-shared.js';

const ORIGIN = 'https://www.screener.in';
const MONTHS = new Map(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((name, index) => [name.toLowerCase(), index + 1]));
const SPEC = {
  bonus: { actionType: 'bonus', columns: 3, fields: ['ratio'] },
  right: { actionType: 'rights', columns: 4, fields: ['premium', 'ratio'] },
  split: { actionType: 'split', columns: 4, fields: ['oldFaceValue', 'newFaceValue'] },
  buyback: { actionType: 'buyback', columns: 6, fields: ['endDate', 'offerType', 'maxPrice', 'amountCrore'] },
  dividend: { actionType: 'dividend', columns: 4, fields: ['dividendType', 'percent'] },
};

const decode = (value) => String(value || '')
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
    const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  })
  .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, key) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[key.toLowerCase()]);
const text = (value) => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (value, name) => decode(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(value)?.[2] || '');

export function screenerActionDay(value) {
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const day = `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  const date = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

function companyIdentity(href) {
  try {
    const url = new URL(href, ORIGIN);
    if (url.protocol !== 'https:' || !['www.screener.in', 'screener.in'].includes(url.hostname)) return null;
    const match = /^\/company\/(id\/)?([^/]+)\/(?:consolidated\/)?$/.exec(url.pathname);
    if (!match) return null;
    const rawKey = decodeURIComponent(match[2]).toUpperCase();
    const companyKey = match[1] ? `ID:${rawKey}` : rawKey;
    return {
      companyKey,
      ticker: match[1] || /^\d+$/.test(companyKey) || !/^[A-Z0-9&._-]{1,80}$/.test(companyKey) ? null : companyKey,
      companyUrl: url.href,
    };
  } catch { return null; }
}

export function parseScreenerActionPage(html, { kind, observedAt = new Date().toISOString(), catalogueKey = kind } = {}) {
  const spec = SPEC[kind];
  if (!spec) throw new Error('Unknown Screener corporate-action catalogue.');
  const source = String(html || '');
  const plain = text(source);
  const totalMatch = /([\d,]+)\s+(?:bonuses|rights|splits|buy\s*backs|dividends)\b/i.exec(plain);
  const publishedTotal = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
  const pages = [...source.matchAll(/[?&]p=(\d+)/g)].map((item) => Number(item[1])).filter(Number.isSafeInteger);
  const lastPage = Math.max(1, ...pages, publishedTotal ? Math.ceil(publishedTotal / 25) : 1);
  if (!Number.isSafeInteger(publishedTotal) || lastPage < 1) throw new Error('Screener corporate-action pagination unavailable.');
  const table = /<table\b[^>]*\bid=["']result_list["'][^>]*>([\s\S]*?)<\/table>/i.exec(source)?.[1];
  if (!table && publishedTotal === 0) return { rows: [], publishedTotal, lastPage };
  if (!table) throw new Error('Screener corporate-action table unavailable.');
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => ({ attrs: cell[1], html: cell[2] }));
    if (!cells.length || !cells.some((cell) => /\bfield-company_display\b/.test(attr(cell.attrs, 'class')))) continue;
    if (cells.length !== spec.columns) throw new Error('Screener corporate-action columns changed.');
    const links = [...cells[0].html.matchAll(/<a\b([^>]*)>/gi)].map((anchor) => attr(anchor[1], 'href'));
    const identity = links.map(companyIdentity).find(Boolean);
    const company = text(cells[0].html).replace(/[\uE000-\uF8FF]/g, '').trim();
    const exDate = screenerActionDay(text(cells[1].html));
    if (!identity || !company || !exDate) throw new Error('Unmapped Screener corporate-action row.');
    const row = {
      companyKey: identity.companyKey,
      ticker: identity.ticker,
      company,
      companyUrl: identity.companyUrl,
      actionType: spec.actionType,
      exDate,
      catalogueKey,
      sourceUrl: `${ORIGIN}/actions/${kind}/`,
      observedAt,
    };
    spec.fields.forEach((field, index) => {
      const value = text(cells[index + 2].html);
      row[field] = !value || value === '-' ? null : value;
    });
    if (row.endDate) row.endDate = screenerActionDay(row.endDate);
    rows.push({ ...row, id: screenerActionKey(row) });
  }
  if (publishedTotal < rows.length) throw new Error('Screener corporate-action pagination unavailable.');
  if (!rows.length && publishedTotal !== 0) throw new Error('Screener corporate-action page is empty.');
  return { rows, publishedTotal, lastPage };
}

export const SCREENER_ACTION_ORIGIN = ORIGIN;
export const SCREENER_ACTION_KINDS = Object.freeze(Object.keys(SPEC));
