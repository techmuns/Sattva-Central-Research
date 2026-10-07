// data/company-profile.js — MARKET CAP AND SECTOR FOR A COMPANY, from files this dashboard already
// captures. Shared by the announcement-index build, the Corporate Announcements table and the
// relevance reading on every surface, so a company is one size and one sector everywhere.
//
// WHERE THE NUMBERS COME FROM, in order of preference — and every figure keeps its own date:
//   1. technicals.json `marketCap` — Screener's figure on the technicals capture's price date.
//   2. mc-ticker-map.json `shares` × the last traded price in earnings-live.json, where that price
//      is newer than the map's own build — a derived figure, labelled `shares × last price`.
//   3. mc-ticker-map.json `mktCapAtBuild` — Moneycontrol's figure when the map was built.
// A company none of them knows has NO market cap — never zero, never a guess. Its filings stay
// visible; the Market cap column says "—" and the range filter offers "Not available" by name.
//
// THE SECTOR GROUP is the desk's own sector → KPI ontology (sector-kpis.json, 41 groups) where the
// company is classified there, and otherwise Moneycontrol's industry folded into the same groups by
// the small table below. It is a ranking input and a label, never a claim about the business.

/** Market-cap bands the range filter offers, in ₹ crore. A band includes its minimum. */
export const MCAP_BANDS = Object.freeze([
  { id: 'mega', label: '₹1 lakh Cr and above', short: 'Mega', min: 100_000, max: Infinity },
  { id: 'large', label: '₹20,000 Cr – ₹1 lakh Cr', short: 'Large', min: 20_000, max: 100_000 },
  { id: 'mid', label: '₹5,000 – ₹20,000 Cr', short: 'Mid', min: 5_000, max: 20_000 },
  { id: 'small', label: '₹1,000 – ₹5,000 Cr', short: 'Small', min: 1_000, max: 5_000 },
  { id: 'micro', label: 'Below ₹1,000 Cr', short: 'Micro', min: 0, max: 1_000 },
]);
export const MCAP_UNKNOWN = 'unknown';

export function mcapBand(cr) {
  if (!Number.isFinite(cr) || cr <= 0) return MCAP_UNKNOWN;
  return MCAP_BANDS.find((b) => cr >= b.min && cr < b.max)?.id || MCAP_UNKNOWN;
}

/** "27,582 Cr." / "₹1,23,456.7 Cr" / 27582 → 27582. Anything unreadable is null, never 0. */
export function parseCrore(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const text = String(value ?? '').replace(/[₹,\s]/g, '').replace(/(?:cr|crore)s?\.?$/i, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

const indian = (n, digits = 0) => n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** ₹27,582 Cr · ₹1.23 lakh Cr · ₹480 Cr. Null when unknown. */
export function formatMarketCap(cr) {
  if (!Number.isFinite(cr) || cr <= 0) return null;
  if (cr >= 100_000) return `₹${indian(cr / 100_000, 2)} lakh Cr`;
  if (cr >= 100) return `₹${indian(Math.round(cr))} Cr`;
  return `₹${indian(cr, 1)} Cr`;
}

/**
 * A market-cap range the filter understands: 'all', a band id, 'unknown', or 'min-max' in ₹ crore
 * with either side optional ('5000-' is ₹5,000 Cr and above, '-1000' below ₹1,000 Cr).
 */
export function parseMcapRange(value) {
  const v = String(value ?? 'all').trim().toLowerCase();
  if (!v || v === 'all') return { kind: 'all' };
  if (v === MCAP_UNKNOWN) return { kind: 'unknown' };
  const band = MCAP_BANDS.find((b) => b.id === v);
  if (band) return { kind: 'range', min: band.min, max: band.max, band: band.id };
  const m = /^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/.exec(v);
  if (m && (m[1] || m[2])) {
    const min = m[1] ? Number(m[1]) : 0, max = m[2] ? Number(m[2]) : Infinity;
    if (min <= max) return { kind: 'range', min, max, custom: true };
  }
  return { kind: 'all' };
}

export function inMcapRange(cr, range) {
  if (!range || range.kind === 'all') return true;
  const known = Number.isFinite(cr) && cr > 0;
  if (range.kind === 'unknown') return !known;
  // A custom upper bound is inclusive so "0–1,000" includes exactly ₹1,000 Cr; band edges stay
  // half-open so no company falls in two bands.
  return known && cr >= range.min && (range.custom ? cr <= range.max : cr < range.max);
}

export function mcapRangeLabel(value) {
  const range = parseMcapRange(value);
  if (range.kind === 'all') return 'All market caps';
  if (range.kind === 'unknown') return 'Market cap not available';
  if (range.band) return MCAP_BANDS.find((b) => b.id === range.band).label;
  const lo = range.min > 0 ? formatMarketCap(range.min) : null, hi = Number.isFinite(range.max) ? formatMarketCap(range.max) : null;
  return lo && hi ? `${lo} – ${hi}` : lo ? `${lo} and above` : `Up to ${hi}`;
}

// Moneycontrol industry → the desk's sector groups. Only a ranking input; unmatched stays null.
const INDUSTRY_GROUPS = [
  [/pharma|drug|biotech|life sciences/i, 'pharma'],
  [/hospital|healthcare services/i, 'hospitals'],
  [/medical equipment|medical devices/i, 'medical_devices'],
  [/labs? |diagnostic/i, 'diagnostics'],
  [/^bank/i, 'banks'],
  [/finance - nbfc|finance - housing|finance term lending|finance - others/i, 'nbfc'],
  [/stock broking|ratings|finance - investment|exchange|asset management|capital market/i, 'capital_markets'],
  [/insurance/i, 'insurance'],
  [/software|it services|bpo|ites|it - |computer/i, 'it_services'],
  [/automobile/i, 'auto'],
  [/auto ancillar|tyres|batteries/i, 'auto_components'],
  [/aerospace|defence|ship building/i, 'aerospace_defense'],
  [/construction - infrastructure|infrastructure|engineering - construction|engineering & construction|transport infrastructure|ports|transmission towers/i, 'infrastructure'],
  [/engineering|electric equipment|compressors|pumps|cables|electrodes|railways wagons|fasteners|abrasives/i, 'capital_goods'],
  [/construction - residential|real estate|construction - real estate|housing/i, 'real_estate'],
  [/cement|ceramics|construction materials/i, 'cement'],
  [/iron & steel|steel|aluminium|metals|ferro|castings|forgings|gold/i, 'metals'],
  [/mining|coal|minerals/i, 'mining'],
  [/oil exploration|refineries|gas distribution|lubricants|lpg|industrial gases/i, 'oil_gas'],
  [/power|renewables/i, 'power'],
  [/telecommunication - service|telecommunications services|cable & d2h/i, 'telecom'],
  [/telecommunication - equipment|electronics|computer peripherals|it - networking/i, 'hardware'],
  [/chemical|dyes|pigments|carbon black|paints|fertilizers|pesticides|agrochemical/i, 'chemicals'],
  [/textile|apparel|leather|footwear/i, 'textiles'],
  [/paper|printing/i, 'paper'],
  [/packaging|plastic|containers/i, 'packaging'],
  [/hotel|resort|travel|leisure|amusement/i, 'hotels'],
  [/restaurant/i, 'restaurants'],
  [/retail|trading|dealers/i, 'retail'],
  [/consumer food|food processing|tea|coffee|sugar|vegetable oils|breweries|distilleries|cigarettes|household|personal products|fish|poultry|agriculture|aquaculture/i, 'consumer_staples'],
  [/domestic appliances|air conditioners|consumer durables|electronic goods|watches|cycles|laminates/i, 'consumer_durables'],
  [/logistics|courier|shipping|freight|airlines/i, 'logistics'],
  [/media|film|tv broadcasting|entertainment|publishing/i, 'media'],
  [/education/i, 'education'],
  [/commercial services|diversified/i, 'business_services'],
];
export function industryGroup(industry) {
  if (!industry) return null;
  return INDUSTRY_GROUPS.find(([re]) => re.test(industry))?.[1] || null;
}

const upper = (v) => String(v ?? '').trim().toUpperCase();
const bseKey = (v) => (/^\d{6}$/.test(String(v ?? '').trim()) ? `BSE:${String(v).trim()}` : null);

/**
 * Build the lookup. Every input is optional; pass what is loaded.
 *
 * @param {object} p
 * @param {object} [p.tickerMap]   mc-ticker-map.json
 * @param {object} [p.earnings]    earnings-live.json (for last traded prices)
 * @param {object} [p.technicals]  technicals.json
 * @param {object} [p.sectorKpis]  sector-kpis.json
 */
export function buildCompanyProfiles({ tickerMap = null, earnings = null, technicals = null, sectorKpis = null } = {}) {
  const byKey = new Map();
  const aliases = new Map();
  const put = (keys, value) => { for (const k of keys) if (k && !byKey.has(k)) byKey.set(k, value); };
  const mapAsOf = tickerMap?.generated_at || null;
  const priceAsOf = earnings?.meta?.fetchedAt || earnings?.fetchedAt || null;
  const prices = new Map();
  for (const row of earnings?.rows || []) if (row?.scId && Number.isFinite(row.ltp) && row.ltp > 0) prices.set(row.scId, row.ltp);
  const groups = new Map();
  for (const [key, company] of Object.entries(sectorKpis?.companies || {})) {
    if (company?.group) groups.set(/^\d{6}$/.test(key) ? `BSE:${key}` : upper(key), { group: company.group, sector: company.sector || null });
  }
  // 1. technicals — Screener's own market cap on its price date.
  const technicalsAsOf = technicals?.price_date || technicals?.generated_at || null;
  for (const company of technicals?.companies || []) {
    const cr = parseCrore(company?.marketCap);
    const ticker = upper(company?.ticker);
    if (!ticker || !cr) continue;
    put([ticker], { cr, asOf: technicalsAsOf, source: 'Screener market cap (technicals capture)', industry: company.industry || null, sector: company.sector || null });
  }
  // 2/3. The Moneycontrol map — shares × a newer last price where there is one, its build figure otherwise.
  const newerPrice = priceAsOf && (!mapAsOf || Date.parse(priceAsOf) > Date.parse(mapAsOf));
  for (const [scId, entry] of Object.entries(tickerMap?.map || {})) {
    const ticker = upper(entry?.ticker), bse = bseKey(entry?.bseId);
    let value = null;
    const ltp = prices.get(scId);
    if (newerPrice && ltp && Number.isFinite(entry?.shares) && entry.shares > 0) {
      value = { cr: (entry.shares * ltp) / 1e7, asOf: priceAsOf, source: 'Shares × last traded price (Moneycontrol)' };
    } else {
      const cr = parseCrore(entry?.mktCapAtBuild);
      if (cr) value = { cr, asOf: mapAsOf, source: 'Moneycontrol market cap' };
    }
    // One company, one figure: a BSE code resolves to the same profile its NSE symbol has.
    if (ticker && bse) aliases.set(bse, ticker);
    if (!value) continue;
    value.industry = entry.industry || null;
    if (ticker && byKey.has(ticker)) { byKey.get(ticker).industry ||= value.industry; continue; }
    put([ticker, bse], value);
  }
  const profileOf = (company = {}) => {
    const bse = bseKey(company.scripCode || company.bseCode || company.bseId);
    const ticker = upper(company.ticker) || (bse ? aliases.get(bse) : '') || '';
    const keys = [ticker, bse].filter(Boolean);
    let cap = null, group = null;
    for (const k of keys) { cap ||= byKey.get(k) || null; group ||= groups.get(k) || null; }
    const groupId = group?.group || industryGroup(cap?.industry) || null;
    return {
      mcapCr: cap ? Math.round(cap.cr * 100) / 100 : null,
      mcapAsOf: cap?.asOf || null,
      mcapSource: cap?.source || null,
      band: mcapBand(cap?.cr),
      group: groupId,
      sector: group?.sector || cap?.sector || null,
    };
  };
  return {
    profileOf,
    size: byKey.size,
    meta: { tickerMapAsOf: mapAsOf, priceAsOf, technicalsAsOf, companies: byKey.size, sectorCompanies: groups.size },
  };
}
