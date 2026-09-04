// Pure parser for the authenticated Insights section on a Screener company page. Publisher HTML
// is untrusted data: no script is executed and no discovered navigation target is followed.
import { safeInsightUrl } from '../../public/js/data/screener-insights-shared.js';

const decode = (value) => String(value || '')
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
    const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  })
  .replace(/&(amp|quot|apos|lt|gt|nbsp|ndash|mdash);/gi, (_, key) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' })[key.toLowerCase()]);
const text = (value) => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (value, name) => decode(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(value)?.[2] || '');

function elementById(html, tag, id) {
  const source = String(html || '');
  const startRe = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const start = startRe.exec(source);
  if (!start) return null;
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tags.lastIndex = start.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    depth += /^<\//.test(match[0]) ? -1 : 1;
    if (depth === 0) return source.slice(start.index, tags.lastIndex);
  }
  return null;
}

function numeric(value) {
  const cleaned = String(value || '').replace(/[,\s%₹]/g, '');
  if (!cleaned || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function pointOf(cell, period, label) {
  const direct = /<span\b[^>]*class=["'][^"']*\binline-flex\b[^"']*["'][^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(cell)?.[1];
  const value = text(direct == null ? cell.replace(/<span\b[^>]*class=["'][^"']*\btooltip\b[^"']*["'][^>]*>[\s\S]*$/i, '') : direct);
  if (!value || value === '—' || value === '-') return null;
  const sourceTitle = text(/<span\b[^>]*class=["'][^"']*\bfont-weight-500\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(cell)?.[1]);
  const quote = text(/<span\b[^>]*class=["'][^"']*\bink-700\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(cell)?.[1]);
  const page = /\bPage\s+([\w.-]+)/i.exec(text(cell))?.[1] || null;
  const href = [...cell.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)]
    .map((match) => safeInsightUrl(attr(match[1], 'href'))).find(Boolean) || null;
  return {
    period,
    label,
    value,
    numeric: numeric(value),
    source: sourceTitle ? { title: sourceTitle.slice(0, 180), quote: quote ? quote.slice(0, 500) : null, page, url: href } : null,
  };
}

function parseTable(container, periodicity) {
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(container || '')?.[1];
  if (!table) return [];
  const header = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(table)?.[1] || '';
  const columns = [...header.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)]
    .map((match) => ({ period: attr(match[1], 'data-date-key'), label: text(match[2]) }))
    .filter((column) => column.period);
  if (!columns.length) throw Error('Screener insight periods unavailable');
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table)?.[1] || '';
  const rows = [];
  for (const match of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
    if (cells.length !== columns.length + 1) continue;
    const unit = text(/<span\b[^>]*class=["'][^"']*\bsub\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(cells[0])?.[1]) || null;
    const metric = text(cells[0].replace(/<br\s*\/?>[\s\S]*$/i, ''));
    if (!metric) continue;
    const values = columns.map((column, index) => pointOf(cells[index + 1], column.period, column.label)).filter(Boolean);
    if (!values.length) continue;
    rows.push({ periodicity, metric, unit, values });
  }
  return rows;
}

export function parseScreenerInsightsPage(html) {
  const source = String(html || '');
  const section = elementById(source, 'section', 'insights');
  if (!section) return { available: false, companyId: null, rows: [] };
  const companyId = /\/insights\/company\/(\d+)\/(?:quarter|flag)\//i.exec(section)?.[1] || null;
  const yearly = elementById(section, 'div', 'yearly-insights');
  const quarterly = elementById(section, 'div', 'quarterly-insights');
  if (!yearly && !quarterly) throw Error('Screener Insights tabs unavailable');
  const rows = [...parseTable(yearly, 'yearly'), ...parseTable(quarterly, 'quarterly')];
  return { available: true, companyId, rows };
}
