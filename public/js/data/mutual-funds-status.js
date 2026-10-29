// A missing comparison is a source-data state, never a running calculation.
// Derive the display from quantities so already-cached legacy "Pending" rows
// become readable without rebuilding or rewriting any captured observations.
export function comparisonStatus(row) {
  if(row.missing&&row.checking)return {label:'Loading report',detail:'Reading saved disclosures',reported:false,
    insight:'Saved disclosures are being checked for this company.'};
  if(row.missing)return {label:'Unavailable',detail:'No saved company report',reported:false,
    insight:'No saved disclosure is available for this company. Check Coverage for source status.'};
  if(row.activityUnavailable)return {label:'Comparison unavailable',detail:'Equity/hybrid projection pending',reported:!!row.month,
    insight:'Saved activity predates the equity/hybrid filter. An updated projection is required; unfiltered buying/selling is withheld.'};
  if(row.eligibleFunds===0&&Object.values(row.excludedFunds||{}).some(n=>n>0))return {
    label:'No eligible schemes',detail:'Excluded from activity',reported:!!row.month,
    insight:'No verified equity/hybrid schemes are available in the captured company reports.'
  };
  if(row.comparableFunds>0)return {label:row.direction,detail:`${row.addedFunds} added · ${row.reducedFunds} reduced`,insight:row.insight,reported:true};
  if(Number.isFinite(row.totalShares))return {
    label:'Comparison unavailable',detail:'Adjacent month missing',reported:true,
    insight:'Reported holdings are saved. A monthly change needs quantities for the same funds in both adjacent months.'
  };
  if(row.pendingFunds>0)return {
    label:'Comparison unavailable',detail:'Monthly quantities missing',reported:true,
    insight:'Fund history is saved, but comparable quantities for this month and the previous month are unavailable.'
  };
  return {label:'No disclosure',detail:'No matched fund reports',reported:false,
    insight:'No mutual-fund disclosure matched in the captured sources. This does not establish zero mutual-fund ownership.'};
}
