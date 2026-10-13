import { TAB_META } from './catalog.js';
import * as holdings from './mutual-fund-holdings.js';
import * as feed from '../data/fund-returns.js';
import {publishedCohorts} from '../data/fund-cohorts.js';
import {renderFundReturns} from '../investors/fund-returns.js';
import {scoreTable,sectionHead} from '../ui/screener.js';
import {exportSheets,todayStamp} from '../ui/export.js';
import {escapeHtml as esc} from '../core/dom.js';
import {mutualFundView} from '../ui/mutual-fund-view.js';
import {fitTableViewport} from '../ui/table-viewport.js';
export const meta = TAB_META['mutual-funds'];
let ctx=null,off=null,timer=null,disposers=[],view=null,categoryView=null,management='all',period='1Y',measure='return';
let normalReading=null;
export function getSavedView(){return {management,period,measure,...holdings.getSavedView()};}
export function applySavedView(extras={}){
  normalReading={management,period,measure};
  management=['all','active','passive'].includes(extras.management)?extras.management:'all';
  period=typeof extras.period==='string'?extras.period:'1Y';
  measure=extras.measure==='excess'?'excess':'return';
  holdings.applySavedView(extras);
}
function clearTable(){for(const off of disposers)off?.();disposers=[];}
const pct=n=>Number.isFinite(n)?`${n.toLocaleString('en-IN',{maximumFractionDigits:2})}%`:'—';
export function render(context){
  destroy({preserveSaved:true});ctx=context;
  if(!context.subview||context.subview==='company-holdings'){holdings.render(context);return;}
  off=feed.onUpdate(sourceChanged);
  window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  timer=setInterval(resume,60000);
  paint();feed.load();
}
function resume(){if(ctx&&!document.hidden)feed.load();}
function sourceChanged(){
  if(!ctx)return;
  const focused=ctx.root.contains(document.activeElement)?document.activeElement:null;
  if(focused?.matches('input,select,[data-fund-category]')){focused.addEventListener('blur',()=>{if(ctx)paint();},{once:true});return;}
  paint();
}
function paint(){
  if(!ctx)return;
  const root=ctx.root;
  const top=root.querySelector('[data-table-scroll]')?.scrollTop||0;
  clearTable();
  const m=feed.meta();
  const viewControl=mutualFundView(ctx);
  if(!m){root.innerHTML=`${viewControl.html}<p class="text-sm text-slate-500">Loading fund returns…</p>`;disposers.push(viewControl.wire(root));return;}
  if(ctx.subview==='category-performance'&&!m.reason){paintCategories(m);return;}
  const all=feed.all(),rows=all.filter(r=>management==='all'||r.taxonomy?.management===management);
  const controls=`<div class="mf-toolbar"><label>Management <select data-fund-management aria-label="Fund management"><option value="all">All funds</option><option value="active">Active</option><option value="passive">Passive</option></select></label><label>Measure <select data-fund-measure aria-label="Fund return measure"><option value="return">Returns</option><option value="excess">Gap vs category median</option></select></label><span class="text-xs text-slate-500">All published schemes · independent of company scope</span></div>`;
  const panel=renderFundReturns(ctx,{disposers,repaint:paint,rows,view,measure,headHtml:controls,metaHtml:viewControl.html,onView:v=>{view=v;}});
  root.innerHTML=(m.reason?viewControl.html:'')+panel.html;panel.wire(root);disposers.push(viewControl.wire(root));
  const managementControl=root.querySelector('[data-fund-management]');
  if(managementControl){managementControl.value=management;managementControl.onchange=e=>{management=e.target.value;paint();};}
  const measureControl=root.querySelector('[data-fund-measure]');
  if(measureControl){measureControl.value=measure;measureControl.onchange=e=>{measure=e.target.value;view={...view,sort:null};paint();};}
  const scroller=root.querySelector('[data-table-scroll]');if(scroller)scroller.scrollTop=top;
  disposers.push(fitTableViewport(root));
}
function paintCategories(m){
  const periods=feed.periods();if(!periods.includes(period))period=periods[0];
  const rows=publishedCohorts(feed.allPlans(),periods);
  const status=m.readFailed?'Latest check failed · Saved figures':m.origin==='saved'?'Saved figures · Checking source':'Source checked';
  const checked=m.checkedAt?new Date(m.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST':'Not yet confirmed';
  const table=scoreTable({rows,key:r=>r.key,name:r=>r.name,sub:r=>`${r.plan} · ${r.option} · ${r.key}`,watchKey:()=>null,showWatchFilter:false,showAvatar:false,showRank:false,nameLabel:'Source category',dense:true,wrapHeads:true,stickyHead:'120px',initialView:categoryView,
    countNoun:'cohorts',searchable:r=>`${r.name} ${r.plan} ${r.option} ${r.key}`,exportName:'sattva-fund-categories',onExport:visible=>exportSheets({filename:`sattva-fund-categories-${todayStamp()}`,banner:`AmfiBeas published cohort figures. NAV date ${m.asOfDate||'unavailable'}. Period ${period}. ${status}. Last source check ${checked}. All source cohorts; plan and option separate. Missing or conflicting values are blank.`,sheets:[{name:'Category Performance',rows:visible,columns:[
      {header:'Cohort',key:'key',get:r=>r.key},{header:'Category',key:'name',get:r=>r.name},{header:'Plan',key:'plan',get:r=>r.plan},{header:'Option',key:'option',get:r=>r.option},
      {header:`${period} Average %`,key:'average',get:r=>r.stats[period]?.average??''},{header:`${period} Median %`,key:'median',get:r=>r.stats[period]?.median??''},{header:'Peers',key:'peers',get:r=>r.stats[period]?.peers??''}
    ]}]}),
    columns:[
      {label:'Category average',align:'right',sortValue:r=>r.stats[period]?.average??-Infinity,get:r=>pct(r.stats[period]?.average)},
      {label:'Category median',align:'right',sortValue:r=>r.stats[period]?.median??-Infinity,get:r=>pct(r.stats[period]?.median)},
      {label:'Peers',align:'right',get:r=>r.stats[period]?.peers??'—'},
      {label:'Source status',get:r=>r.stats[period]?.conflict?'Conflicting figures withheld':Number.isFinite(r.stats[period]?.median)?'Published':'Not reported'}
    ]});
  const viewControl=mutualFundView(ctx);
  ctx.root.innerHTML=sectionHead({title:'Category Performance',meta:viewControl.html,description:`${status} · NAV date ${m.asOfDate||'unavailable'} · Last successful check ${checked}. Published cohort averages and medians; 3Y–10Y are CAGR.`,controls:`<div class="mf-toolbar"><label>Period <select data-fund-period aria-label="Category return period">${periods.map(p=>`<option value="${esc(p)}">${esc(feed.PERIOD_LABEL[p])}</option>`).join('')}</select></label><span class="text-xs text-slate-500">All source cohorts · plan and option remain separate · — means unavailable</span></div>`})+table.html;
  disposers.push(viewControl.wire(ctx.root));
  disposers.push(table.wire(ctx.root));categoryView=table.view;
  disposers.push(fitTableViewport(ctx.root));
  const picker=ctx.root.querySelector('[data-fund-period]');picker.value=period;picker.onchange=e=>{period=e.target.value;categoryView={...categoryView,sort:null};paint();};
}
export function destroy({preserveSaved=false}={}){holdings.destroy({preserveSaved});clearTable();off?.();off=null;clearInterval(timer);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);ctx=null;if(normalReading&&!preserveSaved){({management,period,measure}=normalReading);normalReading=null;}}
