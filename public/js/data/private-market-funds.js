// Reuse the public identities already checked for My Managers. No roster or
// Family membership belongs in this catalogue or in public storage.
import {managerImage} from '../investors/manager-images.js';
export const investorName = value => String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const containsName = (value, name) => name && (` ${value} `).includes(` ${name} `);
export function fundMatches(row, roster) {
 if (roster?.ok !== true || !Array.isArray(roster.funds)) return [];
 const investors = [row.investors, row.leadInvestor].map(investorName), seen = new Set(), matches = [];
 for (const fund of roster.funds) {
  const name = investorName(fund.name); if (!name || seen.has(name)) continue;
  seen.add(name);
  const exact = investors.some(value => containsName(value, name));
  const house = managerImage({name:fund.name,kind:'fund'});
  const aliases = house ? [...house.aliases, ...house.name.split('·').map(v=>v.trim().replace(/^formerly /i,''))] : [];
  if (fund.manager) aliases.push(fund.manager);
  const managerMatch = aliases.some(alias=>investors.some(value=>containsName(value,investorName(alias))));
  if (exact || managerMatch) matches.push({fund:fund.name,closed:fund.closed===true,reportedInvestor:exact?fund.name:house?.name||fund.manager,basis:exact?'name-match':'manager-match',vehicleConfirmed:false});
 }
 return matches;
}
