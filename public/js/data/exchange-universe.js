// The listed-company universe is an exchange directory, independent of scored-feed coverage.
// Join exact ISINs across NSE main board, NSE SME and BSE. Suspended listings remain included;
// delisted-only identities stay in the filing registry/history rather than the current list.
import { mergeExchangeIdentitySteps, filingTicker } from './announcement-identity.js';
import { runSteps, runStepsInSlices, sortSteps } from '../core/slices.js';

const upper = value => String(value || '').trim().toUpperCase();
// NSDL's ISIN structure: E/9 identifies company shares and security code 01 identifies
// equity. Fund units (INF) and separately issued rights entitlements are not extra companies.
// https://nsdl.co.in/downloadables/Core%20Services.pdf
const companyEquity = c => /^IN[E9][A-Z0-9]{4}01[A-Z0-9]{3}$/.test(c.isin || '');
export function buildExchangeUniverse(bse = {}, nse = {}) {
  return runSteps(exchangeUniverseSteps(bse, nse));
}
// The browser yields to input while preparing a changed directory. Collectors use the same
// implementation synchronously; scheduling never changes identities, eligibility or ordering.
export function buildExchangeUniverseAsync(bse = {}, nse = {}, options = {}) {
  return runStepsInSlices(exchangeUniverseSteps(bse, nse), options);
}
function* exchangeUniverseSteps(bse, nse) {
  const bseEntries = bse.entries || [];
  const directories = nse.directories || {};
  const nseEntries = [...(directories.sme?.entries || []), ...(directories.equity?.entries || [])].filter(companyEquity);
  const nseIsins = new Set(nseEntries.map(c => c.isin));
  const smeIsins = new Set((directories.sme?.entries || []).map(c => c.isin));
  const eligible = new Set([...bseEntries.filter(c => companyEquity(c) && ['Active', 'Suspended'].includes(c.status)), ...nseEntries].map(c => c.isin));
  const merged = (yield* mergeExchangeIdentitySteps(bseEntries, nseEntries)).filter(c => eligible.has(c.isin));
  // A BSE symbol can identify a different NSE issuer (FOCUS, SEL, MAL, ...). Reserve NSE
  // symbols and use the exact BSE code for conflicting BSE-only entries; never drop either row.
  const owners = new Map();
  for (const c of merged) {
    for (const t of [c.ticker, c.bseSymbol, ...(c.aliases || [])].map(filingTicker).filter(Boolean)) {
      if (!owners.has(t)) owners.set(t, new Set());
      owners.get(t).add(c.isin);
    }
    yield;
  }
  const companies = [];
  for (const c of merged) {
    const candidate = filingTicker(c.ticker || c.bseSymbol);
    const ticker = nseIsins.has(c.isin) || owners.get(candidate)?.size === 1 ? candidate : String(c.bseCode || '');
    if (!/^IN[A-Z0-9]{10}$/.test(c.isin || '') || !/^[A-Z0-9&._-]{1,80}$/.test(ticker) || !c.name) {
      throw new Error('An exchange company has an invalid identity; no truncated universe has been assumed.');
    }
    const aliases = [...new Set([c.ticker, c.bseSymbol, ...(c.aliases || [])].map(upper).filter(Boolean))];
    const matchTickers = [...new Set([ticker, c.bseCode, ...(c.bseCodes || []),
      ...aliases.filter(t => owners.get(filingTicker(t))?.size === 1)].filter(Boolean).map(filingTicker))];
    companies.push({ ...c, ticker, announcementTicker: ticker, aliases, matchTickers,
      exchanges: [...(nseIsins.has(c.isin) ? ['NSE'] : []), ...(c.bseCode ? ['BSE'] : [])],
      segment: smeIsins.has(c.isin) ? 'SME' : null,
      country: 'India', listed: true });
    yield;
  }
  yield* sortSteps(companies, (a, b) => a.name.localeCompare(b.name) || a.isin.localeCompare(b.isin));
  if (new Set(companies.map(c => c.ticker)).size !== companies.length) throw new Error('Exchange universe contains conflicting company symbols.');
  return { companies, counts: { total: companies.length, nse: nseIsins.size,
    bse: companies.filter(c => c.bseCode).length, suspended: companies.filter(c => c.status === 'Suspended' && !nseIsins.has(c.isin)).length } };
}
