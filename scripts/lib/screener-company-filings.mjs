// Free public company pages provide document links and a LIMITED recent-notice list.
// This is a fallback, never evidence that a requested announcement window is complete.
import { documentUrl } from '../../public/js/data/domestic-filings-shared.js';

const origin = 'https://www.screener.in';
const decode = value => String(value || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
  const n = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[k.toLowerCase()]);
const text = value => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (html, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html || '');
  return decode(m?.[1] ?? m?.[2] ?? m?.[3] ?? '');
};
const bad = message => Object.assign(Error(`Screener company page: ${message}`), { reason: 'shape' });
async function boundedText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw bad('empty response');
  const decoder = new TextDecoder();
  let size = 0, html = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw bad('response too large');
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
function block(html, tag, matches) {
  let depth = 0, start = null;
  for (const m of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (m[0].startsWith('</')) {
      if (start !== null && --depth === 0) return html.slice(start, m.index);
    } else if (start !== null) depth++;
    else if (matches(m[0])) { start = m.index + m[0].length; depth = 1; }
  }
  if (start !== null) throw bad('truncated section');
  return null;
}
const links = html => [...String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
  .map(m => ({ attrs: m[1], html: m[2], label: text(m[2]), href: attr(m[1], 'href') }));
const items = html => [...String(html || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map(m => m[1]);

export function companySourceTicker(company) { return company.announcementTicker || company.ticker; }

export function parseScreenerCompanyFilings(html, company, now = Date.now()) {
  const ticker = companySourceTicker(company);
  if (typeof html !== 'string' || !/<\/html\s*>/i.test(html)) throw bad('incomplete page');
  const info = block(html, 'section', tag => attr(tag, 'id') === 'top')
    || html.slice(0, html.indexOf('id="quarters"'));
  // An exact exchange link proves the requested issuer. Similar company names do not.
  const exchangeLinks = links(info).map(a => { try { return new URL(a.href); } catch { return null; } }).filter(Boolean);
  const identity = exchangeLinks.some(url => /^(www\.)?nseindia\.com$/.test(url.hostname)
    && url.searchParams.get('symbol') === ticker)
    || exchangeLinks.some(url => /^(www\.)?bseindia\.com$/.test(url.hostname)
      && /^\d{6}$/.test(String(company.bseCode || ticker)) && url.pathname.split('/').includes(String(company.bseCode || ticker)));
  if (!identity) throw bad('exchange identity not verified');
  const companyId = /\bdata-company-id=["'](\d+)["']/.exec(html)?.[1];
  const documentsSection = () => {
    const section = block(html, 'section', tag => attr(tag, 'id') === 'documents');
    if (section === null) throw bad('documents section missing');
    return section;
  };
  const documents = [];
  let skipped = 0, unavailableLinks = 0;
  const documentErrors = [];
  // A category failure keeps other validated documents and cannot suppress recent notices.
  // The skipped count prevents the collector from advancing domestic success/coverage.
  const readCategory = read => {
    try { read(); } catch (error) { skipped++; documentErrors.push(error.message); }
  };
  const add = (href, form, title, date) => {
    let url; try { url = documentUrl(new URL(href, origin).href); } catch {}
    if (!url || !date) { skipped++; return; }
    documents.push({ ticker: company.ticker, form, title, date, url, provider: 'Screener company documents' });
  };
  readCategory(() => {
    const annual = block(documentsSection(), 'div', tag => attr(tag, 'class').split(/\s+/).includes('annual-reports'));
    if (annual === null) throw bad('annual report section missing');
    for (const a of links(annual)) {
      const year = /^Annual Report (\d{4})$/.exec(a.label)?.[1];
      if (year) add(a.href, 'annual_report', a.label, year);
      else if (!['DRHP', 'RHP'].includes(a.label)) skipped++;
    }
    if (!links(annual).length && !/No data available/i.test(annual)) throw bad('unverified empty annual reports');
  });
  readCategory(() => {
    const concalls = block(documentsSection(), 'div', tag => attr(tag, 'class').split(/\s+/).includes('concalls'));
    if (concalls === null) throw bad('concall section missing');
    if (!items(concalls).length && !/No data available/i.test(concalls)) throw bad('unverified empty concalls');
    for (const item of items(concalls)) {
      const period = text(block(item, 'div', () => true));
      if (!/^[A-Z][a-z]{2} \d{4}$/.test(period)) { skipped++; continue; }
      for (const a of links(item)) {
        if (a.label === 'Transcript') add(a.href, 'concalls', `Concall transcript ${period}`, period);
        // Presentations and recordings are not earnings result reports or transcripts.
      }
      if (!links(item).some(a => a.label === 'Transcript')) unavailableLinks++;
    }
  });
  readCategory(() => {
    if (!companyId) throw bad('document company identity missing');
    const quarters = block(html, 'section', tag => attr(tag, 'id') === 'quarters');
    if (quarters === null) throw bad('quarterly reports section missing');
    const quarterLinks = links(quarters).filter(a => attr(a.attrs, 'aria-label') === 'Raw PDF');
    if (!quarterLinks.length && !/No data available/i.test(quarters)) {
      // JAYBEE explicitly renders a result table with no period columns and an empty Raw PDF row.
      // A populated table whose link markup changed must not be treated as that empty state.
      const table = block(quarters, 'table', tag => attr(tag, 'class').split(/\s+/).includes('data-table')) || '';
      const headings = [...(block(table, 'thead', () => true) || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
      const pdfCells = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)])
        .find(cells => text(cells[0]?.[1]) === 'Raw PDF') || [];
      if (!(headings.length === 1 && !text(headings[0][1]) && pdfCells.length === 1)) {
        throw bad('unverified empty quarterly reports');
      }
    }
    for (const a of quarterLinks) {
      const match = /^\/company\/source\/quarter\/(\d+)\/(\d{1,2})\/(\d{4})\/$/.exec(a.href);
      if (!match || match[1] !== companyId || +match[2] < 1 || +match[2] > 12) { skipped++; continue; }
      const period = `${match[3]}-${match[2].padStart(2, '0')}`;
      add(a.href, 'earnings_report', `Quarterly results ${period}`, period);
    }
  });
  let recent = null, announcementError = null;
  try { recent = block(html, 'div', tag => attr(tag, 'id') === 'company-announcements-tab'); }
  catch (error) { announcementError = error.message; }
  const announcements = [];
  let announcementSkipped = 0;
  for (const item of items(recent)) {
    const a = links(item)[0];
    const publishedAt = attr(/<time\b([^>]*)>/i.exec(a?.html || '')?.[1], 'datetime');
    const title = text((a?.html || '').split(/<(?:i|time|span|div)\b/i)[0]);
    let url; try { url = new URL(a?.href); } catch {}
    const source = /^(www\.)?bseindia\.com$/.test(url?.hostname || '') ? 'BSE'
      : /^(nsearchives\.|archives\.|www\.)?nseindia\.com$/.test(url?.hostname || '') ? 'NSE' : null;
    const at = Date.parse(publishedAt);
    if (!title || !source || !documentUrl(url?.href) || !Number.isFinite(at) || at > now + 300000) { announcementSkipped++; continue; }
    announcements.push({ ticker: company.ticker, company: company.name, title, url: url.href,
      date: publishedAt.slice(0, 10), publishedAt: new Date(at).toISOString(), source, sources: [source],
      providers: ['Screener company recent notices'], ...(company.isin ? { isin: company.isin } : {}) });
  }
  return { documents, skipped, unavailableLinks, documentErrors, announcements, announcementSkipped, announcementError,
    // An explicitly empty recent list is readable, but still cannot certify a full history.
    announcementReadable: recent !== null && (announcements.length > 0 || /No (?:announcements|data available)/i.test(recent)) };
}

export function screenerCompanyResponse(page, kind, primary) {
  const metadata = { fetchedAt: page.fetchedAt, provider: 'Screener company page', sourceUrl: page.sourceUrl,
    primaryError: { reason: primary.reason, message: String(primary.message || 'Primary provider has no company feed').slice(0, 300) } };
  if (kind === 'domestic') return { ok: true, documents: page.documents, skipped: page.skipped,
    unavailableLinks: page.unavailableLinks, parseError: page.documentErrors?.join(' ').slice(0, 300) || null, ...metadata };
  if (!page.announcementReadable) throw Error(page.announcementError || 'Recent notices could not be parsed.');
  return { ok: true, announcements: page.announcements, limited: true, skipped: page.announcementSkipped, ...metadata };
}

export function createScreenerCompanyFallback({ fetcher = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const pages = new Map();
  return async company => {
    const ticker = companySourceTicker(company);
    if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker || '')) throw bad('invalid source ticker');
    const key = `${ticker}|${company.bseCode || ''}|${company.isin || ''}`;
    if (!pages.has(key)) pages.set(key, (async () => {
      const url = `${origin}/company/${encodeURIComponent(ticker)}/consolidated/`;
      let html;
      // The initial connection occasionally resets on both local and GitHub hosts. Retry that
      // idempotent read once; HTTP refusals, rate limits and invalid page shapes are not retried.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'text/html' } });
          if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error(`Screener company page returned HTTP ${response.status}`), { reason: 'upstream' }); }
          html = await boundedText(response, 4 * 1024 * 1024);
          break;
        } catch (error) {
          if (attempt || !['TypeError', 'TimeoutError'].includes(error.name)) throw error;
          await sleep(1500);
        }
      }
      const parsed = parseScreenerCompanyFilings(html, company, now());
      return { ...parsed, fetchedAt: new Date(now()).toISOString(), sourceUrl: url };
    })());
    return pages.get(key);
  };
}
