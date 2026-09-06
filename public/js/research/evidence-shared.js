// research/evidence-shared.js — the ONE definition of what the model actually receives.
//
// Pure and dependency-free, imported by BOTH the browser (js/research/estate.js, which fits the
// packet to the budget) and the Worker (worker/research.mjs, which builds the prompt and enforces
// the request bound) — the same arrangement as finology-shared.js and stockscans-shared.js, and
// for the same reason: the two sides must not be able to disagree about what counts.
//
// WHY THE BUDGET IS MEASURED ON THIS SHAPE AND NOT ON THE WIRE PACKET. The browser's packet carries
// UI-only fields — every source's `route`, the duplicate `catalog`, the prose in `selection` — that
// the Worker strips before the model sees them. Measuring the budget on the wire packet charged
// about 1,600 characters of chrome against a 10,000-character budget, and the rowless skeleton of
// fourteen sources came to 10,242 characters on real data. Every row was pushed and immediately
// popped; the model received fourteen sources with `includedRows: 0` and answered, accurately,
// that the dashboard held no company data. Nothing threw, the packet was well-formed and under
// bound, and it was useless. The budget is a claim about the prompt, so it is measured on the
// prompt's shape.

const UI_ONLY_SOURCE_FIELDS = new Set(['route', 'description']);

// A column schema removes five repeated JSON keys per holding without sampling
// away any ISIN, unresolved symbol, fund or weight from the complete denominator.
export function providerPositions(positions) {
  if (!Array.isArray(positions?.holdings)) return positions;
  const columns = ['isin', 'ticker', 'name', 'sector', 'weightPct'];
  return { sizes: positions.sizes, columns,
    holdings: positions.holdings.map(holding => columns.map(key => holding[key] ?? null)) };
}

/**
 * The provider-facing packet: everything analytical, none of the browser's chrome.
 *
 * `selection` keeps the question tokens, the companies recognised in the question and the source
 * counts — the model needs those to say "this company is outside the active scope" — and drops the
 * method prose and the budget arithmetic, which describe this code rather than the dashboard.
 */
export function providerEvidence(evidence = {}) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const selection = evidence?.selection && typeof evidence.selection === 'object' ? evidence.selection : {};
  return {
    generatedAt: evidence?.generatedAt,
    scope: evidence?.scope,
    scopeDefinition: evidence?.scopeDefinition,
    portfolio: evidence?.portfolio,
    portfolioPositions: providerPositions(evidence?.portfolioPositions),
    selection: {
      tokens: Array.isArray(selection.tokens) ? selection.tokens : [],
      companies: Array.isArray(selection.companies) ? selection.companies : [],
      sourcesRegistered: selection.sourcesRegistered,
      sourcesReady: selection.sourcesReady,
      sourcesUnavailable: selection.sourcesUnavailable,
    },
    sources: sources.map((source) => {
      if (!source || typeof source !== 'object') return source;
      return Object.fromEntries(Object.entries(source).filter(([key]) => !UI_ONLY_SOURCE_FIELDS.has(key)));
    }),
  };
}

/** The number the budget and the Worker bound are both stated in. */
export function providerEvidenceChars(evidence) {
  return JSON.stringify(providerEvidence(evidence)).length;
}

/** Full holdings have a separate bound so they cannot crowd out research rows. */
export const PORTFOLIO_POSITIONS_MAX_CHARS = 60_000;
export function researchEvidenceChars(evidence) {
  return providerEvidenceChars({ ...evidence, portfolioPositions: undefined });
}
