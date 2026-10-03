// Reviewed 2026-10-01. Security identity is separate from exchange listing eligibility.
// Exact ISIN/issuer rows: https://zenodo.org/records/15121981 (ISIN.csv, NSDL-derived).
// Current issuer and public disclosures: https://everestfleet.com/newsroom/
const everest = {
  issuerName: 'Everest Fleet Private Limited',
  exchangeFilings: 'unavailable',
  reason: 'Private issuer: no listed-equity announcement feed. Company news is searched by issuer name; private disclosures are not a complete public archive.',
  officialUrl: 'https://everestfleet.com/newsroom/',
};
export const reviewedCompanySecurities = Object.freeze({
  INE0LTR01029: { ...everest, securityType: 'equity' },
  INE0LTR03090: { ...everest, securityType: 'preference' },
});
export const companySecurityIdentity = isin => reviewedCompanySecurities[String(isin || '').toUpperCase()] || null;
