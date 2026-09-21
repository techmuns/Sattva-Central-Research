// data/universe.js — adapter between the raw NSE-500 screener export and the simple
// `{ ticker, name, marketCap, sector, industry }` shape the mock tabs were built against.
//
// public/data/universe.json is now the real screener export (535 rows, Screener.in column
// names, values as display strings like "27,582 Cr."). Rather than rewrite eight tabs that
// only need a ticker and a market cap, app.js exposes BOTH:
//
//   ctx.data.universe     — the adapted legacy shape (what every mock tab already reads)
//   ctx.data.universeRaw  — the untouched screener rows (what the technicals layer joins on)
//
// Keep this adapter thin. If a tab needs a screener column that isn't here, read it off
// `universeRaw` rather than widening the legacy shape.

// "https://www.screener.in/company/PGHH/" -> "PGHH"
import { tickerFromScreenerUrl } from './market-identity.js';
export { tickerFromScreenerUrl } from './market-identity.js';

// "27,582 Cr." -> 27582 (₹ crore, as a number). Returns null when unparseable.
export function parseMarketCapCr(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, '').replace(/Cr\.?/i, '').replace(/₹/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// "-0.25 %" -> -0.25. Same parser the scraper uses, so the UI and the pipeline agree.
export function parsePercentValue(value) {
  if (value == null) return null;
  const s = String(value).replace(/%/g, '').replace(/,/g, '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Raw screener rows -> the legacy universe shape.
export function adaptUniverse(rows = []) {
  return rows
    .map((r) => ({
      ticker: tickerFromScreenerUrl(r['Screener URL']),
      name: r.Company,
      marketCap: parseMarketCapCr(r['Market Cap']),
      sector: r.Sector || r['Broad Sector'] || null,
      industry: r['Broad Industry'] || r.Industry || null,
      screenerUrl: r['Screener URL'] || null,
      chgFiiHold: parsePercentValue(r['Chg in FII Hold']),
      chgDiiHold: parsePercentValue(r['Chg in DII Hold']),
    }))
    .filter((r) => r.ticker);
}
