// Reviewed search identities, shared by collectors and readers. A relationship widens discovery;
// it NEVER turns the affiliate into an alias of the listed company or proves financial exposure.
export const reviewedNewsIdentities = [
  // Existing curated ISIN overrides, moved unchanged into the shared registry so publisher/X
  // matching sees the same identities as scheduled company search.
  { match: { isin: 'INE12F801023' }, brands: ['Kissht'] },
  { match: { isin: 'INE526E01018' }, legalName: 'SPR Auto Technologies Ltd', formerNames: ['Shriram Pistons & Rings Ltd'] },
  { match: { isin: 'INE879I01012' }, formerNames: ['DB Realty Ltd'] },
  { match: { isin: 'INE010J01012' }, legalName: 'Tejas Networks Limited' },
  {
    match: { ticker: 'JAYNECOIND' },
    aliases: ['Jayaswal NECO Industries'],
    searchAliases: ['Jayaswal Neco'],
    officialDomains: ['necoindia.com'],
    officialPages: ['https://www.necoindia.com/investors/presentations/'],
    evidenceUrls: ['https://www.necoindia.com/wp-content/uploads/2025/02/pressrelease04092026_Datasel-SRL.pdf'],
    relatedEntities: [
      { name: 'Neco Defence Munitions', aliases: ['Neco Defence Munitions Private Limited'],
        relationship: 'common-promoter',
        evidenceUrl: 'https://www.necoindia.com/wp-content/uploads/2025/02/pressrelease04092026_Datasel-SRL.pdf',
        note: 'JNIL states that Neco Defence shares promoters and a director but is not its subsidiary, associate or joint venture; JNIL states it has no transactions with it and no financial impact.' },
      { name: 'Datasel', aliases: ['Datasel S.R.L.'], relationship: 'promoter-linked-affiliate',
        evidenceUrl: 'https://www.necoindia.com/wp-content/uploads/2025/02/pressrelease04092026_Datasel-SRL.pdf',
        note: 'JNIL identifies Datasel as a subsidiary of Neco Defence, not JNIL. The company denies transactions or financial impact for JNIL; allegations about Datasel must not be restated as findings against JNIL.' },
    ],
  },
  {
    match: { ticker: 'STLTECH' },
    aliases: ['SterliteTech', 'Sterlite Technologies'],
    searchAliases: ['Sterlite analyst day', 'STL analyst day'],
    officialDomains: ['stl.tech'],
    officialPages: ['https://stl.tech/investor/'],
    evidenceUrls: ['https://stl.tech/investor/'],
    // Bare "Sterlite" / "STL" are not reviewed aliases: they match other companies and terms.
  },
  {
    match: { ticker: 'EDELWEISS' },
    officialDomains: ['edelweissfin.com'],
    officialPages: ['https://www.edelweissfin.com/investor-relations', 'https://www.eaaa.in/ipo-page/'],
    evidenceUrls: ['https://cdn1.edelweissfin.com/wp-content/uploads/2026/01/EFSLExchangeIntimation.pdf'],
    relatedEntities: [
      { name: 'EAAA India Alternatives', aliases: ['EAAA', 'Edelweiss Alternative Asset Advisors'], relationship: 'group-company',
        evidenceUrl: 'https://cdn1.edelweissfin.com/wp-content/uploads/2026/01/EFSLExchangeIntimation.pdf',
        note: 'Edelweiss disclosed EAAA India Alternatives (formerly Edelweiss Alternative Asset Advisors) filing its DRHP. This is the related issuer’s IPO, not an Edelweiss Financial Services IPO or confirmation of an opening date.' },
    ],
  },
];

export function reviewedNewsIdentity(identity = {}) {
  const isins = new Set([identity.isin, ...(identity.portfolioIsins || []),
    String(identity.entityId || '').startsWith('isin:') ? identity.entityId.slice(5) : null].filter(Boolean).map(value => String(value).toUpperCase()));
  const match = reviewedNewsIdentities.find(entry => entry.match.ticker && entry.match.ticker === String(identity.ticker || '').toUpperCase() || entry.match.isin && isins.has(entry.match.isin));
  if (!match) return identity;
  const out = { ...identity };
  if (match.legalName && !out.legalName) out.legalName = match.legalName;
  for (const field of ['brands', 'formerNames', 'aliases', 'searchAliases', 'officialDomains', 'officialPages', 'evidenceUrls', 'relatedEntities']) {
    out[field] = [...new Map([...(identity[field] || []), ...(match[field] || [])]
      .map(value => [typeof value === 'string' ? value.toLowerCase() : value.name.toLowerCase(), value])).values()];
  }
  return out;
}
