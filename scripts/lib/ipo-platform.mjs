// Publisher data only. Never execute source HTML or fetch document/issuer URLs found in it.
import { filingUrl, ipoDay, mergeIpoFilings } from '../../public/js/data/ipo-filings-shared.js';
import { PLATFORM_ID, PLATFORM_URL, platformCompanyId, mergePlatformCompanies, validatePlatformCapture } from '../../public/js/data/ipo-platform-shared.js';
import { boundedIpoText } from '../../worker/ipo-sources.mjs';

const decode = (s) => String(s || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, v) => {
  const n = v[0].toLowerCase() === 'x' ? parseInt(v.slice(1), 16) : Number(v);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[k.toLowerCase()]);
const text = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (s, key) => decode(new RegExp(`\\b${key}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(s)?.[2] || '');
const anchors = (s) => [...s.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)].map((m) => ({ url: filingUrl(attr(m[1], 'href')), title: attr(m[1], 'title'), text: text(m[2]), className: attr(m[1], 'class') }));
const day = (s) => ipoDay(s) || ipoDay(String(s || '').trim().replace(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/, '$1-$2-$3'));
const company = (a, board, at) => ({ id: platformCompanyId(a?.url), company: text(a?.title || a?.text), url: a?.url, board, observedAt: at, retained: false });
const doc = (c, url, type, documentDate = null) => ({ company: c.company, title: `${c.company} · ${type}`, filingType: type,
  filingDate: null, documentDate, dateBasis: 'Publisher document date; not an exchange filing date', sourceId: PLATFORM_ID,
  source: 'IPOPlatform', origin: 'secondary', board: c.board, isin: c.isin || null, ticker: c.ticker || null,
  companyId: c.id, sourcePage: c.url, url, observedAt: c.observedAt });

export function parsePlatformPage(data, board, at) {
  if (!data || !Number.isSafeInteger(data.recordsTotal) || data.recordsTotal < 1 || data.recordsTotal > 10000
    || data.recordsFiltered !== data.recordsTotal || !Array.isArray(data.data)) throw Error('IPOPlatform pagination shape changed');
  const companies = [], rows = [];
  for (const r of data.data) {
    const a = anchors(r.company_link || '').find((a) => platformCompanyId(a.url));
    const c = { ...company(a, board, at), company: text(r.company_name), draftDate: day(r.date_of_drhp), refiledDate: day(r.refiled_date),
      openingDate: day(r.ipo_opening_date), closingDate: day(r.ipo_closing_date), exchange: text(r.exchange) || null,
      isin: /^IN[A-Z0-9]{10}$/.test(r.isin || '') ? r.isin : null, ticker: /^[A-Z0-9&-]{1,30}$/.test(r.nse_script_symbol || '') ? r.nse_script_symbol : null,
      sector: text(r.sector) || null, publisherUpdatedAt: r.updated_at || null };
    if (!c.id || c.id !== String(r.id) || !c.company) throw Error('Unmapped IPOPlatform company');
    companies.push(c);
    for (const [key, type] of [['drhp_link', 'DRHP / Draft prospectus'], ['rhp_link', 'RHP']]) {
      const raw = r[key]; if (!raw || raw === '-') continue;
      const url = filingUrl(raw);
      // The original DRHP date cannot safely date a later refiled document.
      rows.push({ ...doc(c, url, type, key === 'drhp_link' && !c.refiledDate ? c.draftDate : null), ...(!url ? { note: 'Publisher document link unavailable or unsafe; no URL inferred.' } : {}) });
    }
  }
  return { total: data.recordsTotal, companies, rows };
}
export function parsePlatformDashboard(html, at) {
  const table = /<table\b[^>]*\bid=["']pe-based["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw Error('IPOPlatform dashboard table unavailable');
  const companies = [];
  for (const m of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cols = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (!cols.length) continue;
    if (cols.length !== 9) throw Error('IPOPlatform dashboard columns changed');
    const a = anchors(cols[0]).find((a) => platformCompanyId(a.url));
    const c = { ...company(a, text(cols[1]), at), status: text(cols[2]), openingWindow: text(cols[3]), listingDate: day(text(cols[4])), exchange: text(cols[7]) };
    if (!c.id || !c.company || !['SME', 'Mainboard'].includes(c.board) || !['Upcoming', 'Now Open', 'Closed', 'Listed'].includes(c.status)) throw Error('Unmapped IPOPlatform dashboard row');
    companies.push(c);
  }
  if (!companies.length || new Set(companies.map((c) => c.id)).size !== companies.length) throw Error('Empty or duplicate IPOPlatform dashboard');
  return companies;
}
export function parsePlatformDrafts(html, board, at) {
  const starts = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bitemdiv\b[^"']*["'][^>]*>/gi)];
  if (!starts.length) throw Error('IPOPlatform DRHP listing unavailable');
  const companies = [], rows = [];
  for (let i = 0; i < starts.length; i++) {
    const part = html.slice(starts[i].index, starts[i + 1]?.index || html.length), links = anchors(part);
    const a = links.find((a) => platformCompanyId(a.url)), draft = links.find((a) => /^Read DRHP\b/i.test(a.text));
    const c = { ...company(a, board, at), draftDate: day(attr(starts[i][0], 'data-date_of_drhp')),
      status: 'DRHP filed', drhpStatus: links.find((a) => /\bbtn-primary\b/.test(a.className))?.text || null,
      exchange: attr(starts[i][0], 'data-exchange').toUpperCase(), sector: attr(starts[i][0], 'data-sector') || null };
    c.status = c.drhpStatus || c.status;
    if (!c.id || !c.company) throw Error('Unmapped IPOPlatform DRHP issuer');
    companies.push(c); rows.push({ ...doc(c, draft?.url || null, 'DRHP / Draft prospectus', c.draftDate), ...(!draft?.url ? { note: 'Publisher did not supply a usable public DRHP link.' } : {}) });
  }
  if (new Set(companies.map((c) => c.id)).size !== companies.length) throw Error('Duplicate IPOPlatform DRHP card');
  return { companies, rows };
}

export async function collectPlatform({ fetcher = fetch, now = Date.now, signal = AbortSignal.timeout(240000), pageSize = 100 } = {}) {
  const at = new Date(now()).toISOString();
  const read = async (url, json = false) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      try {
        const r = await fetcher(url, { method: 'GET', redirect: 'manual', signal: s, headers: { accept: json ? 'application/json' : 'text/html', 'x-requested-with': 'XMLHttpRequest', 'user-agent': 'Sattva-IPO-Collector/1.0' } });
        if (!r.ok) { await r.body?.cancel(); throw Error(`IPOPlatform HTTP ${r.status}`); }
        const body = await boundedIpoText(r, s, 12 * 1024 * 1024);
        return json ? JSON.parse(body) : body;
      } catch (error) { if (attempt || signal.aborted) throw error; }
    }
  };
  const counts = {}, allCompanies = [], allRows = [];
  // Stable id order, complete pagination and exact unique-count reconciliation. No page-number cap truncation.
  for (const [kind, board, key] of [['SME', 'SME', 'sme'], ['MainBoard', 'Mainboard', 'mainboard']]) {
    let total = null; const ids = new Set();
    for (let start = 0; total === null || start < total; start += pageSize) {
      const url = `https://www.ipoplatform.com/main-board/index?${new URLSearchParams({ draw: '1', start: String(start), length: String(pageSize), ipo_type: kind, order_by: 'id', order_direction: 'asc' })}`;
      const p = parsePlatformPage(await read(url, true), board, at);
      if (total !== null && p.total !== total) throw Error('IPOPlatform changed during pagination; retry next collection');
      total = p.total;
      if (p.companies.length !== Math.min(pageSize, total - start)) throw Error('Incomplete IPOPlatform page');
      for (const c of p.companies) { if (ids.has(c.id)) throw Error('IPOPlatform repeated a pagination row'); ids.add(c.id); }
      allCompanies.push(...p.companies); allRows.push(...p.rows);
    }
    if (ids.size !== total) throw Error('IPOPlatform pagination count mismatch');
    counts[key] = total;
  }
  const dashboard = parsePlatformDashboard(await read(PLATFORM_URL), at); counts.dashboard = dashboard.length;
  const dashboardIds = new Set(dashboard.map((c) => c.id));
  if (allCompanies.some((c) => !dashboardIds.has(c.id))) throw Error('IPOPlatform directory/dashboard mismatch');
  const drafts = [];
  for (const [kind, board, key] of [['sme', 'SME', 'smeDrafts'], ['mainboard', 'Mainboard', 'mainboardDrafts']]) {
    const p = parsePlatformDrafts(await read(`https://www.ipoplatform.com/ipo/drhp-filed-${kind}-ipos`), board, at);
    counts[key] = p.companies.length; drafts.push(...p.companies); allRows.push(...p.rows);
  }
  // Dashboard lifecycle wins over the separate draft-approval status. Neither is an exchange confirmation.
  return validatePlatformCapture({ version: 1, sourceId: PLATFORM_ID, checkedAt: at, counts,
    companies: mergePlatformCompanies(drafts, allCompanies, dashboard), rows: mergeIpoFilings(allRows) }, now());
}
