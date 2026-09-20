// Whole-source success and a partial attempt have separate clocks. Preserve the
// last complete check through repeated failed runs, including collector restarts.
export function reconcileSourceChecks(previous,incoming) {
  const prior=new Map((previous||[]).map(c=>[c.slug,c]));
  return incoming.map(next=>{
    const old=prior.get(next.slug),attempt=next.lastAttemptAt||next.partialCheckedAt||next.checkedAt||null;
    const complete=old?.lastCompleteCheckedAt||(old?.status==='ok'?old.checkedAt:null)||null;
    if(next.status==='ok'&&next.checkedAt)return {...next,lastCompleteCheckedAt:next.checkedAt,lastAttemptAt:attempt};
    return {...old,...next,month:next.month||old?.month||null,reason:next.reason||null,
      checkedAt:complete,lastCompleteCheckedAt:complete,lastAttemptAt:attempt||old?.lastAttemptAt||null,
      partialCheckedAt:next.partialCheckedAt||(next.schemeCount&&attempt?attempt:old?.partialCheckedAt||null)};
  });
}
