// A valuation of disclosed share changes at the displayed CMP, not executed cash flow.
export function netVolumeCr(row, cmp) {
  if (row.missing || !(row.comparableFunds > 0) || !Number.isFinite(row.netChange) || !Number.isFinite(cmp) || cmp <= 0) return null;
  const value = row.netChange * cmp / 10_000_000;
  return Number.isFinite(value) ? value : null;
}

const houseName = name => String(name || '').replace(/\s+Mutual\s+Fund\s*$/i, '').trim();
const words = name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function fundHouse(fund, amcs) {
  if (!fund?.name) return null;
  const source = amcs.find(a => a.slug && (a.slug === fund.id || a.slug === fund.amc));
  if (source?.name) return houseName(source.name);
  if (fund.amc?.trim()) return houseName(fund.amc);
  // Older captures contain only the exact scheme name. Use a unique published
  // AMC prefix; otherwise retain that full scheme name rather than guessing.
  const scheme = words(fund.name);
  const matches = [...new Set(amcs.map(amc => houseName(amc.name)).filter(name => name &&
    (scheme === words(name) || scheme.startsWith(words(name) + ' '))))];
  return matches.length === 1 ? matches[0] : fund.name;
}
export function fundHouseLead(row, amcs = []) {
  if (row.missing || !(row.comparableFunds > 0) || !Number.isFinite(row.netChange)) return '';
  const net = row.netChange, amount = Math.abs(net).toLocaleString('en-IN');
  const houses = sign => (row.fundHouses || []).filter(h => h.change * sign > 0)
    .sort((a,b) => (b.change-a.change)*sign || a.id.localeCompare(b.id)).slice(0,2)
    .map(h => fundHouse({id:h.id,amc:h.name,name:h.schemeName||h.name},amcs)).filter(Boolean).join(', ');
  const buyers = houses(1), sellers = houses(-1);
  return [`${net>0?'Net buying':net<0?'Net selling':'No net change'}: ${net>0?'+':net<0?'−':''}${amount} shares`,
    buyers && `Buyers: ${buyers}`, sellers && `Sellers: ${sellers}`].filter(Boolean).join(' · ');
}
export function activityNotes(row) {
  const excluded = row.excludedFunds || {}, notes = [];
  if (row.comparableFunds > 0) notes.push(`${row.addedFunds} funds added · ${row.reducedFunds} reduced`);
  if (row.pendingFunds > 0) notes.push(`${row.pendingFunds} awaiting comparable reports`);
  const omitted = [excluded.arbitrage && `${excluded.arbitrage} arbitrage`,
    excluded['fixed-income'] && `${excluded['fixed-income']} fixed income`, excluded.unclassified && `${excluded.unclassified} unclassified`].filter(Boolean);
  if (omitted.length) notes.push(`${omitted.join(', ')} excluded`);
  return notes.join(' · ');
}
