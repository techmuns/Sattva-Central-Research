// THE FAMILY'S PRIVATE COMPANIES — the unlisted lines in the book (`portfolio-companies.json`,
// `listed: false`), named as the COMPANY with the exact names a funding report may print for it.
// The Private Market tab reads them for its Portfolio scope. Pure: no fetch, no DOM.
//
// Ported from Glow Central Research, where the list comes from the GlowVentures book. Here the book
// is the family office's direct-equity statement, so a private company is a line the resolver marks
// not listed for a reason other than being warrants on a listed company. Every alias below is the
// company's own legal-name/brand pair, keyed by ISIN; matching is EXACT on a normalised name — never
// a substring, a token overlap or a fuzzy score.

/** ISIN → the brand a funding report prints and the other names the company is reported under. */
export const REVIEWED = {
  // Finbud Financial Services trades as FinBud (finbud.in).
  INE0EDU01014: { name: 'FinBud', aliases: ['Finbud Financial Services'] },
};

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const LEGAL = /\b(private|pvt|limited|ltd|llp|plc)\b\.?/gi;

/** The key two names must share to be the same name: lower case, legal suffixes and punctuation gone. */
export const nameKey = (value) => clean(value).toLowerCase().replace(/&/g, ' and ').replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, '');

const displayName = (value) => clean(String(value || '').replace(LEGAL, ' ').replace(/\s*\.\s*$/, ''));
const isWarrant = (line) => /\bwarrants?\b/i.test(`${line?.name || ''} ${line?.bookName || ''} ${line?.reason || ''}`);

/**
 * The private companies in the book: lines the resolver marks not listed, less warrants on a listed
 * company. `current`, when given, is the set of ISINs the reader's live book holds — a line the
 * family no longer holds is dropped. One entry per company, every book line under it.
 */
export function privateCompaniesFromBook(holdings = [], current = null) {
  const byId = new Map();
  for (const line of holdings) {
    if (line?.listed !== false || line.ticker || isWarrant(line)) continue;
    if (current && !current.has(line.isin)) continue;
    const reviewed = REVIEWED[line.isin];
    const name = reviewed?.name || displayName(line.name) || clean(line.bookName);
    if (!nameKey(name)) continue;
    const id = `private:${nameKey(name)}`;
    const entry = byId.get(id) || { id, name, legalName: clean(line.bookName) || null, aliases: [], isins: [], bookNames: [] };
    for (const alias of [displayName(line.name), ...(reviewed?.aliases || [])]) {
      if (alias && alias !== name && !entry.aliases.includes(alias)) entry.aliases.push(alias);
    }
    if (line.isin && !entry.isins.includes(line.isin)) entry.isins.push(line.isin);
    if (line.bookName && !entry.bookNames.includes(line.bookName)) entry.bookNames.push(line.bookName);
    byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every exact name a company is matched on. */
export const matchNames = (company) => [company.name, company.legalName, ...(company.aliases || [])].filter(Boolean);

/**
 * `(name) => company | null` over a list of companies. EXACT normalised equality only; a name two
 * companies share matches neither, because it cannot say which one it means.
 */
export function privateCompanyMatcher(companies = []) {
  const byKey = new Map();
  for (const company of companies) for (const name of matchNames(company)) {
    const key = nameKey(name);
    if (key.length < 3) continue;
    const held = byKey.get(key);
    byKey.set(key, held && held !== company ? null : company);
  }
  return (name) => byKey.get(nameKey(name)) || null;
}
