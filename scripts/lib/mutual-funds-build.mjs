import { createHash } from 'node:crypto';
import { monthKey, targetMonth, projectCompany, summaryOf, validIsin, number } from '../../worker/mutual-funds-model.mjs';
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const fundKey = (amc, name) => `${amc}:${norm(name)}`;
// AMC sheets can reuse the underlying equity ISIN for futures. Those contracts
// are exposure, not owned shares, and must not poison the matching cash holding.
const derivative = h => h.quantity < 0 || /[- ](?:\d{1,2}[- ]?)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ]*(?:20)?\d{2}\b|\b(?:futures?|options?|derivatives?)\b/i.test(h.name||'');
// Equity ISIN security type 10; retain REIT/InvIT names only when their exact ISIN is in the book.
const equity = (h, wanted) => validIsin(h.isin) && (/^INE/.test(h.isin) && h.isin.slice(8,10)==='10' || wanted.has(h.isin)) && !/^\s*\d+(\.\d+)?\s*%/.test(h.name || '');
export function buildOwnership(snapshots, { portfolio = [], identities = [], denominators = {}, now = Date.now() } = {}) {
  const known = new Map([...identities,...portfolio].map(h=>[h.isin,h])), wanted = new Set(portfolio.map(h=>h.isin)), companies = new Map(), warnings=[], reports=[];
  for (const snapshot of snapshots) {
    const buckets = [{ asOfMonth:snapshot.asOfMonth, schemes:snapshot.schemes }, ...(snapshot.history || [])];
    const schemes = new Map();
    for (const bucket of buckets) {
      const month = monthKey(bucket.asOfMonth);
      if (!month || month>targetMonth(now) || !Array.isArray(bucket.schemes)) { warnings.push(`${snapshot.amcSlug}:invalid-month`); continue; }
      for (const scheme of bucket.schemes) {
        if (!scheme.schemeName || !Array.isArray(scheme.holdings) || (!scheme.holdings.length && scheme.validatedNoIndianHoldings!==true)) continue;
        // Exact disclosed names are stable; sheet order / generated d-AMC-N codes are not.
        const id = fundKey(snapshot.amcSlug,scheme.schemeName);
        if (!schemes.has(id)) schemes.set(id,{id,name:scheme.schemeName,amc:snapshot.amc,months:new Map()});
        const fund=schemes.get(id);
        const own=monthKey(scheme.asOf);
        if (own && own!==month) { warnings.push(`${id}:${month}:date-mismatch`); continue; }
        const rows=new Map(), totalPct=scheme.holdings.reduce((s,h)=>s+(number(h.pctToNav) || 0),0);
        let complete = scheme.validatedNoIndianHoldings===true&&scheme.holdings.length===0 || totalPct >= 95 && totalPct <= 105;
        for (const holding of scheme.holdings) {
          if (!equity(holding,wanted) || derivative(holding)) continue;
          // Tata's instrument footnote marker lacks asset-class context in the
          // flattened upstream data. Withhold it until its section is verified.
          if(snapshot.amcSlug==='tata' && /\^/.test(holding.name||'')){warnings.push(`${id}:${month}:unclassified-instrument`);complete=false;continue;}
          const h={...holding,quantity:Number.isSafeInteger(holding.quantity)&&holding.quantity>=0?holding.quantity:null};
          if(h.quantity===null)warnings.push(`${id}:${month}:missing-quantity`);
          if (rows.has(h.isin)) { rows.set(h.isin,{...h,quantity:null}); warnings.push(`${id}:${month}:duplicate-isin`); }
          else rows.set(h.isin,h);
        }
        const entry={rows,complete,checkedAt:scheme.checkedAt || bucket.checkedAt || snapshot.fetchedAt,sourceUrl:scheme.sourceUrl || bucket.sourceUrl || snapshot.sourceUrl};
        if (fund.months.has(month)) {
          warnings.push(`${id}:${month}:duplicate-scheme`);
          const prior=fund.months.get(month);
          // Conflicting sheets with the same identity cannot select an arbitrary winner.
          for(const isin of new Set([...prior.rows.keys(),...rows.keys()])) {
            const before=prior.rows.get(isin),after=rows.get(isin);
            if(!before || !after || before.quantity!==after.quantity) prior.rows.set(isin,{...(before||after),quantity:null});
          }
          prior.complete=false;
          continue;
        }
        fund.months.set(month,entry);
      }
    }
    for (const fund of schemes.values()) {
      for(const [month,m] of fund.months)if(m.complete && Number.isFinite(Date.parse(m.checkedAt)))reports.push({id:fund.id,month,complete:true,checkedAt:m.checkedAt,sourceUrl:m.sourceUrl||null,isins:[...m.rows.keys()].sort()});
      const isins=new Set([...fund.months.values()].flatMap(m=>[...m.rows.keys()]));
      for (const isin of isins) {
        const holding=[...fund.months.values()].map(m=>m.rows.get(isin)).find(Boolean), book=known.get(isin);
        if (!companies.has(isin)) companies.set(isin,{isin,name:book?.name || holding.name,ticker:book?.ticker || null,sector:book?.sector || holding.industry || '',denominator:denominators[isin] || null,funds:[]});
        const months={};
        for (const [month,m] of fund.months) {
          const h=m.rows.get(isin);
          months[month]={shares:h?h.quantity:m.complete?0:null,
            valueCr:h?number(h.marketValueCr):m.complete?0:null,
            pctOfAum:h && number(h.pctToNav)!==null && h.pctToNav>=0 && h.pctToNav<=100 ? h.pctToNav : !h&&m.complete?0:null,
            checkedAt:m.checkedAt || null,sourceUrl:m.sourceUrl || null,absenceVerified:!h&&m.complete};
        }
        companies.get(isin).funds.push({id:fund.id,name:fund.name,amc:fund.amc,months});
      }
    }
  }
  for (const holding of portfolio) if (validIsin(holding.isin) && !companies.has(holding.isin)) companies.set(holding.isin,{isin:holding.isin,name:holding.name,ticker:holding.ticker || null,sector:holding.sector || '',denominator:denominators[holding.isin] || null,funds:[]});
  return { companies:[...companies.values()],warnings,reports };
}
export function seededPayload(companies, meta, now=Date.now()) {
  return {meta,rows:companies.map(c=>summaryOf(projectCompany(c,{now}))) };
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
