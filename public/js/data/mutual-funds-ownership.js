// Shared validation only: ownership arithmetic remains in the collector/Worker.
export const SHARE_COUNT_MAX_AGE = 7 * 86400000;
const recent = (value, now) => Number.isFinite(Date.parse(value)) && now-Date.parse(value)>=-60000 && now-Date.parse(value)<=SHARE_COUNT_MAX_AGE;
export const validShareCount = d => Number.isSafeInteger(d?.shares) && d.shares>0 && Number.isFinite(Date.parse(d.checkedAt));
export const freshShareCount = (d, now=Date.now()) => validShareCount(d) && recent(d.checkedAt,now) && (!d.quoteAt || recent(d.quoteAt,now));
export function selectShareCount(previous, incoming, now=Date.now()) {
  const candidates=[previous,incoming].filter(validShareCount);
  // A fresh directly supplied count beats a rounded market-cap/price estimate.
  return candidates.sort((a,b)=>Number(freshShareCount(b,now))-Number(freshShareCount(a,now)) ||
    Number(a.kind==='estimate')-Number(b.kind==='estimate') || Date.parse(b.checkedAt)-Date.parse(a.checkedAt))[0] || null;
}
export function readableOwnership(row, now=Date.now()) {
  if(!row?.denominator || freshShareCount(row.denominator,now))return row;
  return {...row,companyPct:null,denominatorFresh:false,ownershipUnavailable:'stale-share-count'};
}
