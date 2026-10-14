// Public Screener figures, in ₹ crore. Never use sector/free-float cap or infer share counts.
// Screen links identify exact NSE symbols or BSE codes; company-page fallbacks must prove
// the same exchange identity. Collection time and the publisher's price date stay separate.
import { parseCrore } from '../../public/js/data/company-profile.js';

export const SCREEN_URL = 'https://www.screener.in/screens/1196250/all-stocks/';
const plain = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|gt|lt);/g, ' ').replace(/\s+/g, ' ').trim();
const bad = message => { throw Error(`Market cap: ${message}`); };

export function parseMarketCapScreen(html) {
  if (!/<\/html\s*>/i.test(html)) bad('incomplete screen');
  // A public saved screen can be edited by its owner. Refuse a changed predicate/column.
  const query = plain(/<textarea\b[^>]*name="query"[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1]);
  if (!/^Market Capitalization\s+1$/i.test(query) || !/Market Capitalization\s*&gt;\s*1/i.test(html)) bad('screen query changed');
  const info = /(\d+) results found:\s*Showing page (\d+) of (\d+)/i.exec(plain(html));
  if (!info || +info[3] > 300 || +info[1] < 1) bad('screen pagination missing');
  const table = /<table\b[^>]*class="[^"]*data-table[^\"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) bad('screen table missing');
  const headers = [...table.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)];
  const index = headers.findIndex(m => /data-tooltip="Market Capitalization"/i.test(m[1]));
  if (index < 0 || !/Rs\.Cr\./i.test(headers[index][2])) bad('market-cap units changed');
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*data-row-company-id="\d+"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    const link = /href="(\/company\/(id\/)?([A-Z0-9&._-]+)\/(?:consolidated\/)?)"/i.exec((cells[1] || '').replace(/&amp;/g, '&'));
    const cr = parseCrore(plain(cells[index]));
    if (!link || !cr) bad(`invalid company or market cap: ${plain(cells[1])} / ${plain(cells[index])}`);
    rows.push({ key: `${link[2] ? 'ID:' : ''}${link[3].toUpperCase()}`, cr, sourceUrl: `https://www.screener.in${link[1]}` });
  }
  const { 1: total, 2: page, 3: pages } = info;
  if (rows.length !== Math.min(25, +total - (+page - 1) * 25)) bad('incomplete screen page');
  return { total: +total, page: +page, pages: +pages, rows };
}

export function sourceKeys(company) {
  return [...(company.exchanges?.includes('NSE') ? [company.ticker] : []), ...(company.bseCode ? [company.bseCode] : [])];
}

export function parseMarketCapCompany(html, company, checkedAt) {
  if (!/<\/html\s*>/i.test(html)) bad('incomplete company page');
  const top = html.slice(html.indexOf('id="top"'), html.indexOf('id="chart"'));
  const links = [...top.matchAll(/href="([^"]+)"/g)].flatMap(m => { try { return [new URL(m[1].replace(/&amp;/g, '&'))]; } catch { return []; } });
  const nse = links.some(u => /^(www\.)?nseindia\.com$/.test(u.hostname) && company.exchanges?.includes('NSE') && u.searchParams.get('symbol') === company.ticker);
  const bse = links.some(u => /^(www\.)?bseindia\.com$/.test(u.hostname) && company.bseCode && u.pathname.split('/').includes(company.bseCode));
  if (!nse && !bse) bad('company exchange identity differs');
  const item = [...top.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].find(m => /^Market Cap\b/.test(plain(m[1])));
  const value = plain(item?.[1]);
  const cr = parseCrore(/^Market Cap\s+₹\s+([\d,.]+)\s+Cr\./.exec(value)?.[1]);
  if (!cr) bad('company market cap unavailable');
  const clock = /<div class="ink-600 font-size-11 font-weight-500">([\s\S]*?)<\/div>/i.exec(top)?.[1];
  const priceDateLabel = plain(clock) || null;
  // Retain the source label verbatim. A day/month with no year is not an exact dated quote.
  return { cr, checkedAt, priceDateLabel, source: 'Screener', sourceUrl: `https://www.screener.in/company/${nse ? company.ticker : company.bseCode}/` };
}
