// Weekly edition, independent of the public-market brief's settings and ledger.
export const PRIVATE_MARKETS_TITLE = 'Private Markets Intelligence';
export const PRIVATE_MARKETS_EDITION = 'private-markets';
export const IST = 19800000, WEEK = 7 * 86400000;
export function privateMarketsSlot(at = Date.now(), { next = false } = {}) {
  const local = new Date(at + IST), day = local.toISOString().slice(0, 10);
  const midnight = Date.parse(day + 'T00:00:00Z');
  let slot = midnight - ((local.getUTCDay() + 6) % 7) * 86400000 + 9 * 3600000 - IST;
  if (next && slot <= at) slot += WEEK;
  if (!next && slot > at) slot -= WEEK;
  return { at: slot, day: new Date(slot + IST).toISOString().slice(0, 10), key: `private-markets:${new Date(slot + IST).toISOString().slice(0, 10)}` };
}
export const investorName = value => String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Public manager spellings already used by the manager directory. Matching a
// house never establishes which of that house's vehicles funded a transaction.
const HOUSES = [
  ['Fireside Ventures', ['fireside ventures']], ['Stellaris Venture Partners', ['stellaris venture partners']],
  ['WaterBridge Ventures', ['waterbridge ventures', 'waterbridge']], ['Multiply Ventures', ['multiply ventures']],
  ['Roots Ventures', ['roots ventures']], ['Sauce VC', ['sauce vc', 'sauce consumer venture capital', 'sauce continuity fund', 'sauce continiuity fund']],
  ['Aeravti Ventures', ['aeravti ventures']], ['Blume Ventures', ['blume ventures']],
  ['Chiratae Ventures', ['chiratae ventures']], ['Elevation Capital', ['elevation capital']],
  ['Peak XV Partners', ['peak xv partners']], ['Accel', ['accel']],
];
const containsName = (haystack, needle) => (` ${haystack} `).includes(` ${needle} `);
export function fundMatches(row, roster) {
  if (roster?.ok !== true || !Array.isArray(roster.funds)) return [];
  const investors = [row.investors, row.leadInvestor].map(investorName);
  const matches = [];
  for (const fund of roster.funds) {
    const name = investorName(fund.name);
    if (!name) continue;
    const exact = investors.some(v => containsName(v, name));
    const house = HOUSES.find(([, aliases]) => aliases.some(alias => containsName(name, investorName(alias))));
    const houseMatch = house && investors.some(v => house[1].some(alias => containsName(v, investorName(alias))));
    if (exact || houseMatch) matches.push({ fund: fund.name, reportedInvestor: exact ? fund.name : house[0], basis: exact ? 'name-match' : 'manager-match', vehicleConfirmed: false });
  }
  return matches;
}
