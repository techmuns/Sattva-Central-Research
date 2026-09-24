const fresh=(value,now)=>Number.isFinite(Date.parse(value))&&now-Date.parse(value)>=-60000&&now-Date.parse(value)<=45*60000;
export const coverageTime=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST':'—';
export function coverageRows(meta={},now=Date.now()) {
  const date=new Date(now);date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);
  const target=date.toISOString().slice(0,7);
  const rows=(meta.amcs||[]).map(a=>{
    const checkedAt=a.lastCompleteCheckedAt||(a.status==='ok'?a.checkedAt:null);
    let status='Unavailable',tone='caution';
    if(a.status==='ok')status=a.month!==target?'Older report':!fresh(a.checkedAt,now)?'Check overdue':meta.readFailed?'Saved report':meta.state!=='complete'?'Partial':'Current';
    else if(a.status==='partial')status='Partial';
    if(status==='Current')tone='positive';
    return {name:a.name||a.slug,month:a.month,status,tone,checkedAt,attemptAt:a.lastAttemptAt||a.checkedAt};
  });
  const s=meta.supplement;
  if(s){
    const companies=s.companies||[],current=companies.filter(c=>c.state==='ok'&&c.month===target&&fresh(c.checkedAt,now)).length;
    const complete=s.expectedCompanies>0&&current===s.expectedCompanies&&!meta.supplementReadFailed&&s.catalogue?.state==='ok'&&!(s.cooldownUntil>now);
    rows.push({name:'MF Scanner · supplemental',month:companies.map(c=>c.month).filter(Boolean).sort().at(-1),
      status:meta.supplementReadFailed?'Read unavailable':s.cooldownUntil>now?'Source paused':`${current}/${s.expectedCompanies||0} checked`,tone:complete?'positive':'caution',
      checkedAt:companies.map(c=>c.checkedAt).filter(Boolean).sort().at(-1),attemptAt:companies.map(c=>c.lastAttemptAt).filter(Boolean).sort().at(-1)});
  }
  return rows.sort((a,b)=>(a.tone==='positive'?0:1)-(b.tone==='positive'?0:1)||a.name.localeCompare(b.name));
}
