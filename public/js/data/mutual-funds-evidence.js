// Source dates belong to the observations that contributed to each answer.
// The primary collector's timestamp cannot certify a private backup observation.
export function mutualFundEvidenceRows(rows,meta={}) {
  const checks=new Map((meta.supplement?.companies||[]).map(c=>[c.isin,c]));
  return rows.map(r=>({company:r.name,ticker:r.ticker,month:r.month||null,shares:r.totalShares??null,net:r.netChange??null,
    buyer:r.topBuyer?`${r.topBuyer.name}: +${r.topBuyer.change}`:null,
    seller:r.topSeller?`${r.topSeller.name}: ${r.topSeller.change}`:null,pending:r.pendingFunds??null,
    ...(r.supplement?.used||r.supplement?.supplementedFunds>0?{mfScanner:{source:'MF Scanner',month:r.supplement.month,checkedAt:r.supplement.checkedAt,
      checkState:meta.supplementReadFailed?'read-failed':checks.get(r.isin)?.state||'unknown',unpublishedFunds:r.supplement.unreportedFunds||0,ambiguousFunds:r.supplement.ambiguousFunds||0}}:{})}));
}
