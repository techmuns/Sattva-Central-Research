// scripts/lib/screener-classification.mjs — the NSE industry classification Screener prints on a
// company's public page, read as data.
//
// Every Screener company page opens its Peer comparison section with a breadcrumb of four links —
// Broad Sector › Sector › Broad Industry › Industry — each titled with its level and pointing at a
// stable market code (`/market/IN06/IN0601/IN060101/IN060101001/`). That is NSE's own four-level
// classification, the same one `public/data/universe.json` carries for the NSE-500 export, so a
// company read here and a company read from the export are classified in one vocabulary.
//
// Pure: HTML in, four labels and their codes out. The page is somebody else's HTML and is treated
// as untrusted text — nothing is executed and no link is followed. A page without all four levels
// is NOT partially classified: `null` is returned and the caller records the company as unread,
// because a sector with no industry would resolve to a nearest guess downstream.

const decode = (value) => String(value || '')
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
    const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  })
  .replace(/&(amp|quot|apos|lt|gt|nbsp|ndash|mdash);/gi, (_, key) =>
    ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' })[key.toLowerCase()]);
const text = (value) => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const LEVELS = [
  ['Broad Sector', 'broadSector'],
  ['Sector', 'sector'],
  ['Broad Industry', 'broadIndustry'],
  ['Industry', 'industry'],
];

/**
 * `{ broadSector, sector, broadIndustry, industry, code }` from one company page, or null.
 *
 * `code` is the deepest market code (the Industry link's), which names the classification
 * independently of its wording.
 */
export function parseScreenerClassification(html) {
  const source = String(html || '');
  const peers = source.search(/<section\b[^>]*\bid=["']peers["']/i);
  if (peers < 0) return null;
  const region = source.slice(peers, peers + 6000);
  const out = {};
  let code = null;
  for (const match of region.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const title = /\btitle=["']([^"']*)["']/i.exec(attrs)?.[1];
    const href = /\bhref=["']([^"']*)["']/i.exec(attrs)?.[1] || '';
    const level = LEVELS.find(([label]) => label === title);
    if (!level || !/^\/market\/[A-Z0-9/]+\/?$/i.test(href)) continue;
    const value = text(match[2]);
    if (!value || out[level[1]]) continue;
    out[level[1]] = value;
    if (level[1] === 'industry') code = href.replace(/\/+$/, '').split('/').pop();
  }
  if (!LEVELS.every(([, field]) => out[field])) return null;
  return { ...out, code };
}

/** The NSE ticker on a Screener company URL, or null. */
export function tickerFromScreenerUrl(url) {
  const match = /\/company\/([^/]+)\//.exec(String(url || ''));
  if (!match) return null;
  const symbol = decodeURIComponent(match[1]).toUpperCase();
  return /^[A-Z0-9&-]{1,30}$/.test(symbol) ? symbol : null;
}
