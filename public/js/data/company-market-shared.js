// Public market observations only. Never infer an exchange identity from a company name.
import { buildCompanyProfiles, profileIsin } from './company-profile.js';
import { marketTicker } from './market-identity.js';

const upper = value => String(value || '').trim().toUpperCase();
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const istDay = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 19800000).toISOString().slice(0, 10) : null;
const quoteKey = ticker => /^\d{6}$/.test(upper(ticker)) ? `BSE:${ticker}` : upper(ticker);
export function projectCompanyQuotes(payload, previous = null) {
  const rows = new Map((previous?.rows || []).map(row => [quoteKey(row.ticker), { ...row, retained: true, error: 'Not in the latest daily capture', attemptedAt: payload.generated_at }]));
  for (const company of payload.companies || []) {
    const ticker = marketTicker(company), key = quoteKey(ticker);
    if (!ticker) continue;
    const cmp = positive(company.cmp), date = company.bar_date || company.price_date || null;
    const old = rows.get(key);
    if (cmp && date && (!old?.price_date || date >= old.price_date)) rows.set(key, {
      ticker, cmp, price_date: date, pct_change_today: company.pct_change_today ?? null,
    });
    else if (old?.cmp > 0) rows.set(key, { ...old, retained: true, error: company.error || 'Latest daily price unavailable', attemptedAt: payload.generated_at });
    else rows.set(key, { ticker, cmp: null, price_date: null, error: company.error || 'No completed-session quote', attemptedAt: payload.generated_at });
  }
  return { version: 1, generated_at: payload.generated_at, rows: [...rows.values()] };
}

export function companyMarketLookup({ quotes = null, marketCaps = null, tickerMap = null, now = Date.now } = {}) {
  const daily = new Map((quotes?.rows || []).map(row => [quoteKey(row.ticker), row]));
  const owners = new Map(), byIsin = new Map(), shares = new Map(), bseOnlySymbols = new Set();
  const put = (key, entry) => {
    if (!key) return;
    if (!owners.has(key)) owners.set(key, entry);
    else if (owners.get(key)?.isin !== entry.isin) owners.set(key, null);
  };
  for (const entry of marketCaps?.entries || []) {
    if (!entry?.isin) continue;
    byIsin.set(upper(entry.isin), entry);
    if (entry.exchanges?.includes('NSE')) put(upper(entry.ticker), entry);
    else if (entry.ticker) bseOnlySymbols.add(upper(entry.ticker));
    if (entry.bseCode) put(`BSE:${entry.bseCode}`, entry);
  }
  for (const entry of Object.values(tickerMap?.map || {})) {
    if (positive(entry?.shares) && Number.isFinite(Date.parse(entry.sharesCheckedAt))) shares.set(upper(entry.ticker), { value: entry.shares, checkedAt: entry.sharesCheckedAt });
  }
  const profiles = buildCompanyProfiles({ marketCaps, tickerMap });
  function identity(company = {}) {
    const isin = profileIsin(company), bse = company.scripCode || company.bseCode || company.bseId;
    const ticker = upper(marketTicker(company) || company.symbol), tickerKey = quoteKey(ticker);
    const unresolved = (conflict = false) => ({ ...company, ticker: null, quoteTicker: null, isin: null, entityId: null,
      scripCode: null, bseCode: null, bseId: null, identityConflict: conflict });
    const isinOwner = byIsin.get(isin), bseOwner = bse ? owners.get(`BSE:${bse}`) : null;
    const tickerOwner = owners.get(tickerKey), owner = isinOwner || bseOwner || tickerOwner;
    // A BSE display symbol is qualified by the supplied exact ISIN/code, never treated as NSE.
    const bseDisplay = owner && !owner.exchanges?.includes('NSE') && ticker === upper(owner.ticker) && (isinOwner || bseOwner);
    const claimed = [isinOwner, bseOwner, bseDisplay ? null : tickerOwner].filter(Boolean);
    if (owner && (claimed.some(value => value.isin !== owner.isin) || isin && isin !== owner.isin || bse && owner.bseCode && String(bse) !== String(owner.bseCode))) return unresolved(true);
    if (owner) {
      const nse = owner.exchanges?.includes('NSE');
      return { ...company, isin: owner.isin, scripCode: owner.bseCode || null, bseCode: owner.bseCode || null,
        ticker: nse ? upper(owner.ticker) : null, quoteTicker: nse ? upper(owner.ticker) : String(owner.bseCode || '') || null };
    }
    if ((tickerKey && owners.has(tickerKey) && !tickerOwner) || bse || isin) return unresolved();
    if (bseOnlySymbols.has(ticker)) return unresolved();
    return { ...company, ticker, quoteTicker: ticker };
  }
  return { identity, daily: ticker => daily.get(quoteKey(ticker)) || null,
    read(company, priceInfo) {
      const resolved = identity(company), ticker = resolved.ticker, priceTicker = resolved.quoteTicker;
      if (resolved.identityConflict) return { cmp: null, mcapCr: null, quoteInput: 'none', mcapInput: 'none',
        identityConflict: true, quoteLabel: 'Company identifiers disagree; quote withheld', mcapLabel: 'Company identifiers disagree; market cap withheld' };
      const dailyRow = daily.get(quoteKey(priceTicker));
      // Screens already own a completed-session row. Their added cap must use the same CMP
      // their existing renderer shows, even while another daily revision is arriving.
      const ownDaily = Object.hasOwn(company, 'cmp') ? { ...company, ticker: priceTicker, price_date: company.price_date || company.bar_date || null } : null;
      const override = company.marketQuote;
      let quote = priceTicker ? override ? { price: positive(override.price), label: override.label, at: null }
        : priceInfo(ownDaily || (dailyRow ? { ...dailyRow, ticker: priceTicker } : { ticker: priceTicker, cmp: null, price_date: null })) : null;
      let quoteInput = override ? 'provided' : quote?.at ? 'live' : 'quotes';
      if (!override && quote && !quote.at && dailyRow?.retained) quote = { ...quote, label: `Retained · ${quote.label} · latest daily price unavailable${dailyRow.attemptedAt ? ` · attempted ${dailyRow.attemptedAt}` : ''}` };
      const captured = byIsin.get(upper(resolved.isin));
      if (!override && !(quote?.price > 0) && positive(captured?.cmp)) {
        quote = { price: captured.cmp, label: `Screener saved price · ${captured.cmpPriceDateLabel || 'price date not supplied'} · checked ${captured.cmpCheckedAt || 'time not supplied'}${captured.error ? ' · latest source check failed' : ''}` };
        quoteInput = 'marketCaps';
      }
      const cmp = positive(quote?.price);
      const profile = profiles.profileOf(resolved);
      // A source table's captured cap stays consistent with its own range filters.
      const ownCap = positive(company.mcapCr);
      const count = ticker && shares.get(ticker);
      const quoteDate = quote?.at ? istDay(quote.at) : override?.date || (!override || override.price === ownDaily?.cmp ? ownDaily?.price_date || dailyRow?.price_date : null);
      const countAge = count ? now() - Date.parse(count.checkedAt) : Infinity;
      const derive = count && cmp && countAge >= -60000 && countAge <= 86400000 && quoteDate && quoteDate === istDay(count.checkedAt);
      const cap = ownCap || (derive ? count.value * cmp / 1e7 : profile.mcapCr);
      const capSource = ownCap ? [company.mcapSource || 'Captured market cap', company.mcapAsOf && `as of ${company.mcapAsOf}`].filter(Boolean).join(' · ')
        : derive ? `Moneycontrol shares outstanding (observed ${count.checkedAt}) × CMP · ${quote.label}`
          : [profile.mcapSource, profile.mcapAsOf && `as of ${profile.mcapAsOf}`].filter(Boolean).join(' · ');
      return { cmp, quoteLabel: cmp ? quote.label : 'No captured quote for a verified exchange identity', quoteInput,
        mcapInput: ownCap ? 'provided' : derive || profile.mcapSource?.startsWith('Moneycontrol') ? 'tickerMap' : 'marketCaps',
        mcapCr: positive(cap), mcapLabel: capSource || 'No captured market cap for a verified exchange identity' };
    } };
}
