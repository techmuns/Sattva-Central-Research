// data/sector-kpis-shared.js — WHICH KPI GROUP A COMPANY'S SECTOR BELONGS TO, IN ONE PLACE.
//
// Pure and dependency-free, imported by `scripts/build-sector-kpis.mjs` (which resolves every
// classified company when it writes `public/data/sector-kpis.json`) and by the browser (which reads
// that file). One definition of "these two industry strings are the same industry", so the build
// and the page cannot disagree about which KPIs a company carries.
//
// THE ONTOLOGY IS KEYED BY THE EXACT STRINGS OF ANOTHER SYSTEM. Its `sector_industry_map` holds the
// 644 (sector, industry) pairs found on Munshot's `stocks` table — several taxonomies side by side
// (NSE's, Yahoo's, Nasdaq's) — and says so in its own header: "Do not reword them". Our companies
// are classified by Screener's copy of NSE's four-level classification, which is the same taxonomy
// with different punctuation: Screener writes "Gems, Jewellery And Watches" and "Road Assets–Toll,
// Annuity, Hybrid-Annuity" where the table has "Gems Jewellery And Watches" and "Road Assets - Toll
// Annuity Hybrid-Annuity" — and Screener's export has even lost that dash, printing "Road
// AssetsToll". So both sides are compared through `labelKey`, which keeps every letter and digit,
// in order, and nothing else — not even the spaces. It never rewords, and the build refuses an
// ontology in which two different strings reduce to one key with two different groups.
//
// FOUR TIERS, TRIED IN ORDER, AND THE FIRST ANSWER WINS:
//   1. one stated override (below), where the ontology's own answer is the wrong group — tried
//      first, because the tiers after it would otherwise hand back that answer;
//   2. the (sector, industry) pair — the ontology's own key;
//   3. the same pair with a broader sector or industry level substituted, because the ontology
//      files some NSE pairs under the macro sector ("Fast Moving Consumer Goods: Personal Care");
//   4. the industry alone, ONLY where that industry string maps to a single group across the whole
//      ontology — an industry two taxonomies file under different groups is not guessed at.
// A company none of them resolves has NO group, and every surface says nothing about its KPIs
// rather than borrowing a nearest sector's.

/** Letters and digits only, lower-cased. Replacement characters and dashes become spaces. */
export function normaliseLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The comparison key: the label's letters and digits in order, nothing else. */
export const labelKey = (value) => normaliseLabel(value).replace(/ /g, '');

/** The same key with any parenthetical removed — "Real Estate Investment Trusts (REITs)". */
const withoutParenthetical = (value) => labelKey(String(value ?? '').replace(/\([^)]*\)/g, ' '));

export const pairKey = (sector, industry) => `${labelKey(sector)}|${labelKey(industry)}`;

/**
 * The one place this dashboard departs from the ontology's own answer, and why.
 *
 * NSE files every listed REIT under Realty › Real Estate Investment Trusts (REITs); the ontology maps
 * that industry to the DEVELOPER group (pre-sales, collections, area launched), while carrying its
 * own `reit` group (occupancy, rental income, WALE, distribution per unit) that it assigns only to
 * Yahoo's REIT industries. A REIT has no pre-sales, so the developer KPIs would be garbage on its
 * card. Each override is printed into `sector-kpis.json` with this reason, so it is visible.
 */
export const GROUP_OVERRIDES = [
  {
    id: 'nse-reit',
    test: (labels) => labels.some((label) => /\breal estate investment trusts?\b|\breits?\b/.test(label)),
    group: 'reit',
    reason: "NSE's REIT industry is mapped to the developer group in the ontology; its own reit group holds the REIT KPIs.",
  },
];

/**
 * Build the lookup the resolver reads, from the ontology's `sector_industry_map`.
 *
 * Throws where two different strings normalise to one pair (or, for the industry-alone tier, where
 * the collision would change the answer) — a silent collision would hand one of them the other's
 * KPIs, and nothing on screen would say so.
 */
export function buildSectorIndex(sectorIndustryMap = {}) {
  const pairs = new Map();
  const industries = new Map(); // normalised industry -> Set(groups)
  for (const [sector, industries_] of Object.entries(sectorIndustryMap)) {
    for (const [industry, group] of Object.entries(industries_ || {})) {
      const key = pairKey(sector, industry);
      if (pairs.has(key) && pairs.get(key) !== group) {
        throw new Error(`sector-kpis: "${sector}" / "${industry}" normalises onto a pair already mapped to ${pairs.get(key)}, not ${group}`);
      }
      pairs.set(key, group);
      for (const label of new Set([labelKey(industry), withoutParenthetical(industry)])) {
        if (!label) continue;
        if (!industries.has(label)) industries.set(label, new Set());
        industries.get(label).add(group);
      }
    }
  }
  const uniqueIndustry = new Map([...industries].filter(([, groups]) => groups.size === 1).map(([label, groups]) => [label, [...groups][0]]));
  return { pairs, uniqueIndustry };
}

/**
 * The KPI group for one company's classification, or null.
 *
 * `classification` is Screener's four NSE levels: `{ broadSector, sector, broadIndustry, industry }`.
 * Returns `{ group, via, matched }` — `via` is which tier answered and `matched` the strings it
 * matched on, both carried into the output so every resolution can be audited.
 */
export function resolveGroup(index, classification = {}) {
  const { broadSector, sector, broadIndustry, industry } = classification;
  const labels = [industry, broadIndustry].map(normaliseLabel).filter(Boolean);
  for (const override of GROUP_OVERRIDES) {
    if (override.test(labels)) return { group: override.group, via: 'override', matched: override.id };
  }
  const sectors = [sector, broadSector].filter(Boolean);
  const industries = [industry, broadIndustry].filter(Boolean);
  for (const ind of industries) {
    for (const sec of sectors) {
      for (const key of [pairKey(sec, ind), `${labelKey(sec)}|${withoutParenthetical(ind)}`]) {
        const group = index.pairs.get(key);
        if (group) return { group, via: 'pair', matched: `${sec} › ${ind}` };
      }
    }
  }
  for (const ind of industries) {
    for (const label of [labelKey(ind), withoutParenthetical(ind)]) {
      const group = index.uniqueIndustry.get(label);
      if (group) return { group, via: 'industry', matched: ind };
    }
  }
  return null;
}
