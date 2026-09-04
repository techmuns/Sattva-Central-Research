// Fixed public sources only. No private lookup, credentials, pipeline dispatch or issuer fan-out.
import { filingUrl, ipoDay, filingType, mergeIpoFilings } from '../public/js/data/ipo-filings-shared.js';
const sebi = (smid) => `https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&ssid=15&smid=${smid}`;
export const IPO_SOURCES = [
  { id: 'nse-equity', label: 'NSE mainboard', kind: 'nse', board: 'Mainboard', url: 'https://www.nseindia.in/api/corporates/offerdocs?index=equities', page: 'https://www.nseindia.com/companies-listing/corporate-filings-offer-documents' },
  { id: 'nse-sme', label: 'NSE SME', kind: 'nse', board: 'SME', url: 'https://www.nseindia.in/api/corporates/offerdocs?index=sme', page: 'https://www.nseindia.com/companies-listing/corporate-filings-offer-documents' },
  { id: 'bse-sme', label: 'BSE SME', kind: 'bse', board: 'SME', url: 'https://www.bsesme.com/PublicIssues/SMEIPODRHP.aspx' },
  { id: 'sebi-draft', label: 'SEBI drafts', kind: 'sebi', type: 'DRHP / Draft prospectus', url: sebi(10) },
  { id: 'sebi-rhp', label: 'SEBI red herring', kind: 'sebi', type: 'RHP', url: sebi(11) },
  { id: 'sebi-final', label: 'SEBI final offers', kind: 'sebi', type: 'Prospectus', url: sebi(12) },
  { id: 'sebi-other', label: 'SEBI other documents', kind: 'sebi', type: 'Other document', url: sebi(78) },
];
export const IPO_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'application/json,text/html;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
// BSE's public site answers the hosted reader when its own navigation referrer is supplied.
// Fixed publisher metadata only: never forward the dashboard URL, caller headers or credentials.
export const BSE_IPO_HEADERS = { ...IPO_HEADERS, referer: 'https://www.bsesme.com/' };
const decode = (s) => String(s || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
  const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[k.toLowerCase()]);
const text = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
// Quoted attributes may themselves contain HTML (SEBI title="...<br><a ...>...").
const anchors = (s) => [...s.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)].map((m) => {
  const attr = (key) => decode(new RegExp(`\\b${key}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(m[1])?.[2] || '');
  return { href: attr('href'), title: attr('title'), id: attr('id'), text: text(m[2]) };
});
const baseRow = (s, at) => ({ sourceId: s.id, source: s.kind === 'nse' ? 'NSE' : s.kind === 'bse' ? 'BSE SME' : 'SEBI', board: s.board || null, isin: null, ticker: null, observedAt: at, origin: 'official' });

export function parseNseOffers(body, s, at) {
  const data = JSON.parse(body);
  if (!Array.isArray(data) || !data.length || data.length > 10000) throw Error('NSE offer-document shape changed');
  const rows = []; let unmapped = 0;
  for (const r of data) {
    if (typeof r.company !== 'string' || !r.company.trim()) { unmapped++; continue; }
    let count = 0;
    for (const [key, type] of [['drhp', 'DRHP / Draft prospectus'], ['rhp', 'RHP'], ['fp', 'Prospectus'], ['adv', 'Advertisement']]) {
      if (!r[key + 'Attach'] && !r[key + 'Date'] && !r[key]) continue;
      const url = filingUrl(r[key + 'Attach']);
      rows.push({ ...baseRow(s, at), company: r.company.trim(), title: `${r.company} · ${r[key] || type}`, filingType: type, filingDate: ipoDay(r[key + 'Date']), url, isin: /^IN[A-Z0-9]{10}$/.test(r.isin || '') ? r.isin : null, ticker: r.symbol && r.symbol !== '-' ? r.symbol : null }); count++;
    }
    if (!count) unmapped++;
  }
  if (!rows.length) throw Error('No readable NSE offer documents');
  return { rows: mergeIpoFilings(rows), records: data.length, unmapped, note: `All ${data.length} issuer records returned by NSE; draft, red herring, final prospectus and advertisement attachments. The exchange response is not a guarantee of a complete historical archive.` };
}
export function parseSebiOffers(body, s, at) {
  const table = /<table\b[^>]*\bid=["']sample_1["'][^>]*>([\s\S]*?)<\/table>/i.exec(body)?.[1];
  if (!table) throw Error('SEBI listing unavailable or shape changed');
  const rows = []; let unmapped = 0;
  for (const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (!/<td\b/i.test(tr[1])) continue;
    const date = text(/<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(tr[1])?.[1]);
    const a = anchors(tr[1]).find((a) => /\/filings\/public-issues\/|\/sebi_data\//.test(a.href));
    if (!a) { unmapped++; continue; }
    const title = text((a.title || a.text).split(/<br\s*\/?\s*>/i)[0]);
    const company = title.replace(/\s*[-–—:]?\s*\b(?:UDRHP|DRHP|RHP|draft (?:red herring|offer|prospectus)|red herring|prospectus|addendum|corrigendum)\b[\s\S]*$/i, '').trim() || title;
    const url = filingUrl(a.href, s.url);
    if (!title || !url) { unmapped++; continue; }
    rows.push({ ...baseRow(s, at), company, title, filingType: filingType(title, s.type), filingDate: ipoDay(date), url });
  }
  if (!rows.length) throw Error('No readable SEBI public-issue filings');
  const total = Number(/\d+\s+to\s+\d+\s+of\s+([\d,]+)\s+records/i.exec(body)?.[1]?.replace(/,/g, '')) || null;
  return { rows: mergeIpoFilings(rows), records: rows.length, unmapped, total, note: `Latest ${rows.length} records on this SEBI listing${total ? ` (${total} historical records on SEBI)` : ''}. Older SEBI pages are not automatically crawled; exchange records and imported history supplement this window.` };
}
export function parseBseOffers(body, s, at) {
  const table = /<table\b[^>]*\bid=["']ContentPlaceHolder1_gvData["'][^>]*>([\s\S]*?)<\/table>/i.exec(body)?.[1];
  if (!table) throw Error('BSE SME listing unavailable or shape changed');
  const rows = []; let records = 0, unmapped = 0;
  for (const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (!/<td\b/i.test(tr[1])) continue;
    records++;
    const company = text(/<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(tr[1])?.[1]);
    let count = 0;
    for (const a of anchors(tr[1])) {
      const kind = /_hy(DRHP|RHP|Prospectus|Basis)_\d+$/i.exec(a.id)?.[1];
      const url = filingUrl(a.href, s.url);
      if (!kind || !url || !company) continue;
      const type = { drhp: 'DRHP / Draft prospectus', rhp: 'RHP', prospectus: 'Prospectus', basis: 'Basis of allotment' }[kind.toLowerCase()];
      rows.push({ ...baseRow(s, at), company, title: `${company} · ${type}`, filingType: type, filingDate: ipoDay(a.text), url }); count++;
    }
    if (!count) unmapped++;
  }
  if (!rows.length) throw Error('No readable BSE SME offer documents');
  return { rows: mergeIpoFilings(rows), records, unmapped, note: `All ${records} issuer rows in the BSE SME offer-document table. BSE supplies dates for drafts; other attachments often have no filing date. Undated documents remain undated.` };
}

export async function boundedIpoText(response, signal, limit = 4 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('Source exceeds size limit'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty source body');
  let body = '', bytes = 0; const decoder = new TextDecoder();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw Error('Source exceeds size limit');
      body += decoder.decode(value, { stream: true });
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function captureIpoFilings({ fetcher = fetch, now = Date.now, signal = AbortSignal.timeout(25000) } = {}) {
  const checkedAt = new Date(now()).toISOString(), results = new Array(IPO_SOURCES.length);
  let next = 0;
  // Bounded connection pool, response sizes and total deadline; requests never follow redirects.
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < IPO_SOURCES.length) {
      const i = next++, s = IPO_SOURCES[i];
      try {
        const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
        const response = await fetcher(s.url, { method: 'GET', headers: s.kind === 'bse' ? BSE_IPO_HEADERS : IPO_HEADERS, redirect: 'manual', cache: 'no-store', signal: sourceSignal });
        if (!response.ok) { await response.body?.cancel(); throw Error(`Source HTTP ${response.status}`); }
        const body = await boundedIpoText(response, sourceSignal);
        const parsed = (s.kind === 'nse' ? parseNseOffers : s.kind === 'bse' ? parseBseOffers : parseSebiOffers)(body, s, checkedAt);
        results[i] = { rows: parsed.rows, source: { id: s.id, label: s.label, url: s.page || s.url, status: 'ok', checkedAt, count: parsed.rows.length, records: parsed.records, unmapped: parsed.unmapped, note: parsed.note + (parsed.unmapped ? ` ${parsed.unmapped} issuer/filing rows could not be mapped.` : '') } };
      } catch (error) {
        results[i] = { rows: [], source: { id: s.id, label: s.label, url: s.page || s.url, status: 'failed', checkedAt, count: 0, reason: String(error?.message || 'source-read').slice(0, 120), note: signal.aborted || error?.name === 'TimeoutError' ? 'Source timed out; retained filings are not a fresh confirmation.' : 'Source could not be read; retained filings are not a fresh confirmation.' } };
      }
    }
  }));
  const sources = results.map((r) => r.source);
  return { version: 1, ok: sources.some((s) => s.status === 'ok'), checkedAt, sources, rows: mergeIpoFilings(...results.map((r) => r.rows)) };
}
