import {mergeCompany} from '../../worker/mutual-funds-model.mjs';

// The dated portfolio fallback contains verified observations collected before
// rollout. Bring those into durable capture too; a failed fresh download cannot
// discard a disclosure that is already available to a returning reader.
export function retainSeedObservations(companies,seeds) {
  const retained=new Map();
  for(const {company:c} of seeds) {
    if(!c)continue;
    const funds=c.funds.map(f=>({id:f.id,name:f.name,amc:f.amc,months:Object.fromEntries(Object.entries(f.months).map(([month,p])=>[month,{
      shares:p.shares,valueCr:p.valueCr,pctOfAum:p.pctOfAum,checkedAt:p.checkedAt,sourceUrl:p.sourceUrl,absenceVerified:p.absenceVerified
    }]))}));
    retained.set(c.isin,{isin:c.isin,name:c.name,ticker:c.ticker,sector:c.sector,denominator:c.denominator,funds});
  }
  for(const c of companies)retained.set(c.isin,mergeCompany(retained.get(c.isin),c));
  return [...retained.values()];
}
