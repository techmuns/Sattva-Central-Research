// Public factual table rows only. No article bodies, accounts or paid providers.
import { createHash } from 'node:crypto';

export const SOURCE = 'https://inc42.com/tag/funding-galore/';
export const RESERVATION_ERROR = 'Collection started; completion not yet confirmed';
export const FIELDS = ['date', 'company', 'sector', 'subsector', 'businessModel', 'amount', 'round', 'investors', 'leadInvestor'];
export function textContent(html = '') {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, key) => {
      if (key[0] !== '#') return named[key.toLowerCase()] ?? all;
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }).replace(/[\t\r ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
const attr = (s, name) => textContent(s.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || '');
export function articleUrl(raw) {
  try { const u = new URL(raw); return u.origin === 'https://inc42.com' && /^\/(buzz|features|startups)\/[a-z0-9-]+\/$/.test(u.pathname) ? u.origin + u.pathname : null; } catch { return null; }
}
export function discover(html) {
  const articles = new Map();
  for (const a of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = articleUrl(attr(a[1], 'href'));
    const title = attr(a[1], 'title') || textContent(a[2]);
    if (url && title && /(?:this.week|funding.galore|funding.of.the.week|weekly.funding)/i.test(title + ' ' + url)) articles.set(url, { url, title });
  }
  // Configuration comes from the normal public archive, never an authenticated API.
  const config = html.match(/var ajax_object\s*=\s*(\{[^;]+\});/)?.[1];
  const ajax = config ? JSON.parse(config) : null;
  const query = html.match(/'query'\s*:\s*'([^']+)'/)?.[1];
  return { articles: [...articles.values()], ajax, query };
}
const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  date: ['date', 'fundingdate', 'announcedon'], company: ['name', 'startup', 'startupname', 'company', 'companyname', 'startups'],
  sector: ['sector', 'industry'], subsector: ['subsector'], businessModel: ['businessmodel', 'model'],
  amount: ['fundingroundsize', 'fundingamount', 'amount', 'amountraised', 'funding', 'fundingraised', 'roundsize', 'dealvalue'],
  round: ['fundingroundtype', 'round', 'roundtype', 'fundinground', 'stage'], investors: ['investors', 'investor'], leadInvestor: ['leadinvestor', 'leadinvestors'],
};
export function sourceDay(raw) {
  const m = String(raw).match(/^(\d{1,2})[\s-]+([A-Za-z]+)[\s,-]+(20\d{2})$/);
  if (!m) return null;
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].slice(0,3).toLowerCase()) + 1;
  if (!month) return null;
  const value = `${m[3]}-${String(month).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value ? value : null;
}
export function parseArticle(html, article) {
  const publishedAt = html.match(/<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)/i)?.[1] || null;
  const title = textContent(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || article.title);
  const rows = []; const occurrences = new Map(); const notes = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const lines = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr => [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => textContent(c[1])));
    const headerIndex = lines.findIndex(cells => cells.some(c => aliases.company.includes(normalize(c))) && cells.some(c => aliases.amount.includes(normalize(c))));
    if (headerIndex < 0) continue;
    const headers = lines[headerIndex];
    const index = Object.fromEntries(FIELDS.map(f => [f, headers.findIndex(c => aliases[f].includes(normalize(c)))]));
    for (const cells of lines.slice(headerIndex + 1)) {
      if (cells.some(c => /^source:|^\*+\s*(mix|part)/i.test(c))) { notes.push(cells.filter(Boolean).join('\n')); continue; }
      if (cells.every(c => !c)) continue;
      if (cells.length !== headers.length || !cells[index.company] || cells[index.company] === headers[index.company]) throw Error('Funding table has an incomplete or repeated row');
      const record = Object.fromEntries(FIELDS.map(f => [f, index[f] >= 0 ? cells[index[f]] : '']));
      const company = record.company.normalize('NFKC').toLowerCase().trim(); const occurrence = occurrences.get(company) || 0; occurrences.set(company, occurrence + 1);
      const id = createHash('sha256').update(article.url + '\n' + company + '\n' + occurrence).digest('hex').slice(0,24);
      rows.push({ id, ...record, dateISO: sourceDay(record.date), sourceFields: Object.fromEntries(headers.map((h,i) => [h, cells[i]])), sourceUrl: article.url, sourceTitle: title, publishedAt });
    }
  }
  if (!rows.length) return { rows: [], title, publishedAt, notes: [], status: 'unavailable', error: 'No supported public funding table found; original article remains linked.' };
  return { rows, title, publishedAt, notes: [...new Set(notes)], status: 'ok' };
}
export function mergeArticle(state, article, parsed, now) {
  const held = new Map(state.deals.map(row => [row.id, row]));
  const ids = new Set(parsed.rows.map(row => row.id));
  for (const row of parsed.rows) {
    const before = held.get(row.id);
    const changed = before && JSON.stringify(before.sourceFields) !== JSON.stringify(row.sourceFields);
    const revisions = [...(before?.revisions || [])];
    if (changed) revisions.push({ sourceFields: before.sourceFields, capturedAt: before.updatedAt });
    held.set(row.id, { ...row, firstSeenAt: before?.firstSeenAt || now, updatedAt: changed || !before ? now : before.updatedAt, revisions, sourceMissing: false });
  }
  // A correction may remove a row; preserve the earlier observation explicitly.
  if (parsed.status === 'ok') for (const [id, row] of held) if (row.sourceUrl === article.url && !ids.has(id)) held.set(id, { ...row, sourceMissing: true });
  state.deals = [...held.values()];
  Object.assign(article, { title: parsed.title, publishedAt: parsed.publishedAt, notes: parsed.notes, status: parsed.status, error: parsed.error || null, attemptedAt: now,
    ...(parsed.status === 'ok' ? { checkedAt: now, rows: parsed.rows.length } : {}), retryAfter: new Date(Date.parse(now) + (parsed.status === 'ok' ? 7 : 30) * 86400000).toISOString() });
}
export function emptyCapture() { return { version: 1, source: SOURCE, createdAt: new Date().toISOString(), generatedAt: null, sourceCheckedAt: null, attemptedAt: null, cooldownUntil: null, error: null, archive: { nextPage: 2, maxPage: null, complete: false }, articles: [], deals: [] }; }
export function validateCapture(value) {
  if (value?.version !== 1 || value.source !== SOURCE || !Array.isArray(value.deals) || !Array.isArray(value.articles) || !value.archive || !Number.isInteger(value.archive.nextPage)) throw Error('Invalid private funding capture');
  const ids = new Set();
  for (const row of value.deals) {
    if (!/^[a-f0-9]{24}$/.test(row.id) || ids.has(row.id) || !articleUrl(row.sourceUrl) || FIELDS.some(f => typeof row[f] !== 'string')) throw Error('Invalid funding deal');
    ids.add(row.id);
  }
  if (value.articles.some(a => !articleUrl(a.url))) throw Error('Invalid funding provenance');
  return value;
}
