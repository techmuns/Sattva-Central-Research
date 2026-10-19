import {newsletterSettings,scheduledEditions} from '../../public/js/data/newsletter-shared.js';

// Match the existing five-minute runner cadence. An edition/retry becoming due
// can cross that boundary early; completion frequency cannot increase model work.
export const NEWSLETTER_WAKE_MS=5*60000;
const instant=value=>typeof value==='number'?value:Date.parse(value||'');
export function newsletterWakePlan(value,{now=Date.now()}={}){
 if(!Number.isFinite(now)||!value?.settings||!value?.schedule)throw Error('Newsletter wake state unavailable');
 const settings=newsletterSettings(value.settings),schedule=value.schedule;
 if(value.revision!==undefined&&value.inputRevision!==value.revision)return {due:true,reason:'inputs-changed'};
 const wake=instant(schedule.lastWakeAt),checked=instant(schedule.lastCheckedAt);
 if(!Number.isFinite(wake)||wake>now+60000)return {due:true,reason:'wake-unverified'};
 const since=Number.isFinite(checked)?checked:wake;
 if(scheduledEditions(settings,Math.max(since,now-26*3600000),now).length)return {due:true,reason:'edition-due'};
 const retry=schedule.deliveryRecovery;
 if(retry?.pendingEditions>0&&instant(retry.nextRetryAt)<=now)return {due:true,reason:'delivery-retry-due'};
 return now-wake>=NEWSLETTER_WAKE_MS?{due:true,reason:'check-overdue'}:{due:false,reason:'recent-check'};
}
