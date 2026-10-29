// A failed source attempt is a check, never a successful disclosure. Keep these
// two clocks separate so one old success cannot date every subsequent attempt.
export function sourceFreshness(meta={},now=Date.now()) {
  meta ||= {};
  const amcs=meta.amcs||[],limit=45*60000;
  const fresh=value=>{const age=now-Date.parse(value);return Number.isFinite(age)&&age>=-60000&&age<=limit;};
  const date=new Date(now);date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);
  const target=date.toISOString().slice(0,7);
  const attempts=amcs.map(a=>a.lastAttemptAt||a.partialCheckedAt||a.checkedAt||null);
  const checkedAmcs=attempts.filter(fresh).length;
  const currentAmcs=amcs.filter(a=>a.status==='ok'&&a.month===target).length;
  const freshAmcs=amcs.filter(a=>a.status==='ok'&&a.month===target&&fresh(a.checkedAt)).length;
  return {state:!amcs.length?'unavailable':checkedAmcs<amcs.length?'stale':freshAmcs<amcs.length||meta.state!=='complete'?'partial':'current',
    targetMonth:target,currentAmcs,totalAmcs:amcs.length,freshAmcs,checkedAmcs,overdueAmcs:amcs.length-checkedAmcs,
    checkedAt:meta.checkedAt||null,
    // The oldest latest attempt establishes that the whole inventory was checked.
    // Missing/invalid clocks must never be dropped from this minimum.
    lastAttemptAt:attempts.length&&attempts.every(t=>Number.isFinite(Date.parse(t)))?[...attempts].sort((a,b)=>Date.parse(a)-Date.parse(b))[0]:null};
}
