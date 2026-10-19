import {newsletterSettings,scheduledEditions} from '../../public/js/data/newsletter-shared.js';

// Match the existing five-minute runner cadence. An edition/retry becoming due
// can cross that boundary early; completion frequency cannot increase model work.
export const NEWSLETTER_WAKE_MS=5*60000;
const instant=value=>typeof value==='number'?value:Date.parse(value||'');
export function newsletterRetryState(rows){
 const groups=new Map();
 for(const row of rows){
  if(row.source==='test')continue;
  const key=row.edition+':'+row.source,at=instant(row.next_at);
  if(!Number.isFinite(at))throw Error('Newsletter retry time unavailable');
  const group=groups.get(key)||{edition:row.edition,source:row.source,pendingEditions:0,at};
  group.pendingEditions++;group.at=Math.min(group.at,at);groups.set(key,group);
 }
 const pending=[...groups.values()].map(({at,...group})=>({...group,nextRetryAt:new Date(at).toISOString()}));
 return {version:1,receiptVersion:1,pendingEditions:pending.reduce((n,row)=>n+row.pendingEditions,0),
  nextRetryAt:pending.length?new Date(Math.min(...pending.map(row=>Date.parse(row.nextRetryAt)))).toISOString():null,pending};
}
export function newsletterWakePlan(value,{now=Date.now()}={}){
 if(!Number.isFinite(now)||!value?.settings||!value?.schedule)throw Error('Newsletter wake state unavailable');
 const settings=newsletterSettings(value.settings),schedule=value.schedule;
 // The public API signals an unapplied input revision through schedule.reason;
 // only the restored checkpoint has both numeric revision fields available.
 if(schedule.reason==='waiting-for-inputs'||value.inputRevision!==undefined&&value.revision!==undefined&&value.inputRevision!==value.revision)return {due:true,reason:'inputs-changed'};
 const wake=instant(schedule.lastWakeAt),checked=instant(schedule.lastCheckedAt);
 if(!Number.isFinite(wake)||wake>now+60000)return {due:true,reason:'wake-unverified'};
 const since=Number.isFinite(checked)?checked:wake;
 if(scheduledEditions(settings,Math.max(since,now-26*3600000),now).length)return {due:true,reason:'edition-due'};
 // Old aggregate-only readers cannot identify a disabled timer edition. They
 // retain the ordinary five-minute check rather than admitting every event.
 const pending=schedule.deliveryRecovery?.pending;
 if(Array.isArray(pending)&&pending.some(row=>row.pendingEditions>0&&
   (row.source==='button'||row.source==='timer'&&settings[row.edition]?.enabled)&&instant(row.nextRetryAt)<=now))return {due:true,reason:'delivery-retry-due'};
 return now-wake>=NEWSLETTER_WAKE_MS?{due:true,reason:'check-overdue'}:{due:false,reason:'recent-check'};
}
