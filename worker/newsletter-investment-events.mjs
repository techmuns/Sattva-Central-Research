// Saved acquisition/update evidence. No name lookup, model or source mutation.
import {eventDate} from './newsletter-event-identity.mjs';
import {noticeTags} from './newsletter-notice-events.mjs';
const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
const normal=v=>clean(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const nameKey=v=>normal(v).replace(/\bpvt\b/g,'private').replace(/\b(?:limited|ltd)\b/g,'').replace(/\s+/g,' ').trim();
const day=item=>new Date(item.at+330*60000).toISOString().slice(0,10);
const facts=item=>item.content?.state==='ready'?item.content.facts||[]:[];
const namedCompanies=text=>[...clean(text).matchAll(/\b(?:[A-Z][A-Za-z0-9&’'-]*\s+){1,7}(?:Private Limited|Limited|Ltd\.?)/g)].map(m=>m[0]);
const action=/\b(?:acquisiti\w*|acquir\w*|invest(?:s|ed|ment)|subscription|definitive (?:deals|agreements))\b/i;
const changed=/\b(?:revised|corrected|cancelled|canceled|terminated|withdrawn|rejected|denies|denied|revoked|rescinded|abandoned|not proceeding|not executed|not approved)\b/i;
const moneyPattern=/(₹|€|\bINR\b|\bEUR\b|\bRs\.?(?![A-Za-z]))[ ]*(\d[\d,]*(?:\.\d+)?)[ ]*(crores?\b|cr\b|lakhs?\b|lacs?\b|million\b|billion\b|mn\b|m\b)?/ig;
export function investmentMoney(text){
 const out=[];
 for(const m of String(text||'').matchAll(moneyPattern)){
  const [whole,fraction='']=m[2].replaceAll(',','').split('.');
  if(fraction.length>6)continue;
  const factor=/^cr/i.test(m[3]||'')?10000000n:/^(?:lakh|lac)/i.test(m[3]||'')?100000n:/^(?:million|mn|m)$/i.test(m[3]||'')?1000000n:/^billion/i.test(m[3]||'')?1000000000n:1n;
  if(!m[3]&&/^\s*(?:thousand|crore\w+|lakh\w+|million\w+|billion\w+)\b/i.test(String(text).slice(m.index+m[0].length)))continue;
  const scaled=BigInt(whole+fraction)*factor,divisor=10n**BigInt(fraction.length);
  if(scaled%divisor)continue;
  const currency=/€|EUR/i.test(m[1])?'EUR':'INR';
  const prefix=String(text).slice(0,m.index),upper=/\b(?:up to|upto|not exceed|maximum(?: of)?|capped at)\s*$/i.test(prefix);
  const qualifier=upper?'up to':/\b(?:at least|not less than|minimum(?: of)?)\s*$/i.test(prefix)?'at least':/\b(?:approximately|approx\.?|about|around)\s*$/i.test(prefix)?'approximately':null;
  out.push({key:currency+':'+scaled/divisor,currency,value:String(scaled/divisor),raw:m[0],upper,qualifier});
 }
 return out;
}
const unique=values=>[...new Set(values.filter(Boolean))];
const million=value=>{const n=BigInt(value),whole=n/1000000n,remainder=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');return String(whole)+(remainder?'.'+remainder:'');};
const labelMoney=m=>m.currency==='INR'&&BigInt(m.value)%10000000n===0n?'₹'+BigInt(m.value)/10000000n+' crore':m.currency==='EUR'&&BigInt(m.value)>=1000000n?'€'+million(m.value)+' million':m.raw;
const explicitAlias=(text,alias)=>{
 const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp('(?:^|\\b(?:in|of|for|subsidiary|unit|million|crore|cr) +)'+escaped+'(?: +(?:for|at|acquisition|stake|deal|transaction)\\b|[?.!,]|$)','i').test(text);
};
const conditionKey=value=>/^(?:Transaction completion conditional on fulfilment\/waiver of conditions precedent in transaction documents|(?:Completion )?(?:is )?subject to (?:fulfilment of )?conditions precedent)[.!]?$/i.test(clean(value))?'conditions-precedent':normal(value);
const termsAgree=(x,y)=>{
 for(const key of ['amount','total'])if(x[key]&&y[key]&&x[key].key!==y[key].key)return false;
 for(const key of ['stake','stage','instrument','tranche'])if(x[key]&&y[key]&&x[key]!==y[key])return false;
 // A publisher paraphrase of the same condition is not a new event. An extra or
 // conflicting condition remains a development instead of disappearing behind
 // the concise original-filing reading.
 for(const [report,source]of [[x,y],[y,x]])if(report.item.kind==='news'&&source.firm&&!source.native&&report.conditions.some(k=>!source.conditions.includes(k)))return false;
 if(x.item.kind==='filing'&&y.item.kind==='filing'&&!x.native&&!y.native&&x.item.content?.state==='ready'&&y.item.content?.state==='ready')for(const field of ['conditions','status','ownership']){
  const values=p=>facts(p.item).filter(f=>f.field===field).map(f=>normal(f.value)).sort().join('|');
  if(values(x)&&values(y)&&values(x)!==values(y))return false;
 }
 return true;
};
function rawProfile(item){
 if(!['filing','news'].includes(item.kind)||item.related||!item.ticker||!Number.isFinite(item.at))return null;
 const fs=facts(item),tags=noticeTags(item),native=item.content?.format==='xbrl';
 let body='',targetText='',date=null;
 if(native){
  if(tags.get('TypeOfAnnouncementPertainingToRegulation30Restructuring')!=='Update'||tags.get('UpdateForTheEvent')!=='Acquisition (including agreement to acquire)')return null;
  body=[tags.get('OtherUpdates'),tags.get('AnyOtherBriefSignificantInformationForAnnouncementUpdate')].filter(v=>v&&!/^(?:NA|N\/A)$/i.test(v)).join(' ');
  targetText=body+' '+(tags.get('BriefDetailsOfInitialAnnouncement')||'');
  date=eventDate(tags.get('DateOfOccurrenceOfEvent'));
  if(!date||!action.test(body))return null;
 }else if(item.kind==='filing'){
  if(item.content?.state!=='ready')return null;
  body=fs.filter(f=>['event','status'].includes(f.field)).map(f=>f.value).join(' ');
  targetText=fs.filter(f=>['event','counterparty'].includes(f.field)).map(f=>f.value).join(' ');
  const dates=fs.filter(f=>f.field==='date'&&/^(?:Investment completed|Agreements executed) on /i.test(f.value)).map(f=>eventDate(clean(f.value).replace(/^.+? on /i,'')));
  if(!dates.length||dates.some(d=>!d||d!==dates[0]))return null;
  date=dates[0];
 }else{
  body=[item.headline,...fs.filter(f=>['event','status'].includes(f.field)).map(f=>f.value)].map(clean).join(' ');
  targetText=body+' '+fs.filter(f=>f.field==='counterparty').map(f=>f.value).join(' ');
  const dates=fs.filter(f=>f.field==='date'&&/^(?:Investment completed|Agreements executed) on /i.test(f.value)).map(f=>eventDate(clean(f.value).replace(/^.+? on /i,'')));
  if(dates.some(d=>!d||d!==dates[0]))return null;date=dates[0]||null;
 }
 if(!action.test(body)||changed.test(body))return null;
 if(native&&/\b(?:subject to|conditional|conditions precedent|approval|financing|guarantee|loan|litigation|delay|amend\w*)\b/i.test(body))return null;
 if(item.kind==='news'&&/\b(?:subject to|pending approval|regulatory approval|financing|funding|dispute|delay|default|extend\w*|amend\w*)\b/i.test(body))return null;
 const names=unique(namedCompanies(targetText).filter(n=>nameKey(n)!==nameKey(item.company)).map(nameKey));
 if(names.length>1)return null;
 const amountFacts=fs.filter(f=>f.field==='amount'&&!/\b(?:turnover|overall|total board|FY\s?\d|financial year)\b/i.test(f.value));
 const monetaryText=amountFacts.length?amountFacts.map(f=>f.value).join(' '):body;
 if(/\b(?:USD|GBP|JPY|RMB|CNY|AUD|CAD)\b|[$£¥]/i.test(monetaryText))return null;
 const amounts=item.kind==='news'&&!amountFacts.length?investmentMoney(body):native?investmentMoney(tags.get('AnyOtherBriefSignificantInformationForAnnouncementUpdate')||'').filter((m,i)=>i===0):amountFacts.flatMap(f=>investmentMoney(f.value).slice(0,1));
 const pricedTexts=item.kind==='news'&&!amountFacts.length?[body]:native?[tags.get('AnyOtherBriefSignificantInformationForAnnouncementUpdate')||'']:amountFacts.map(f=>f.value);
 if(pricedTexts.some(text=>/₹|€|\b(?:INR|EUR|Rs\.?)\s*\d/i.test(text)&&!investmentMoney(text).length))return null;
 const amountKeys=unique(amounts.map(m=>m.key));if(amountKeys.length>1)return null;
 const ownershipFacts=fs.filter(f=>f.field==='ownership'&&!/promoter|pre-acquisition/i.test(f.value));
 const ownershipText=item.kind==='news'&&!ownershipFacts.length?body:ownershipFacts.map(f=>f.value).join(' ');
 const stakes=unique([...ownershipText.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)].map(m=>String(Number(m[1]))));if(stakes.length>1||stakes.some(s=>Number(s)>100))return null;
 const pending=/\b(?:completion still pending|not yet completed)\b/i.test(body),completed=/\b(?:investment completed|completed the investment|completed acquisition|completed the acquisition|acquisition completed)\b/i.test(body);
 if(pending&&completed)return null;
 const signed=/\b(?:agreements? (?:signed|executed)|executed the Securities|signed definitive|executes agreements)\b/i.test(body);
 const stage=completed?'completed':signed?'agreement':/\bproposed (?:acquisition|investment|transaction)\b/i.test(body)?'proposed':null;
 const instrument=/\b(?:NOCPS|preference shares?)\b/i.test(body)?'preference':/\bequity shares?\b/i.test(body)?'equity':null;
 const trancheText=native||item.kind==='news'?body:fs.filter(f=>['event','amount','status'].includes(f.field)).map(f=>f.value).join(' ');
 const tranches=unique([...trancheText.matchAll(/\b(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?) tranche\b/ig)].map(m=>({first:'1',second:'2',third:'3',fourth:'4',fifth:'5'}[m[1].toLowerCase()]||String(parseInt(m[1],10)))));if(tranches.length>1)return null;
 const totalFact=fs.find(f=>f.field==='amount'&&/^Overall investment /i.test(f.value));
 const total=native?investmentMoney(/overall investment[\s\S]*?enhanced to ([\s\S]+)/i.exec(body)?.[1]||'')[0]:totalFact?investmentMoney(totalFact.value)[0]:null;
 const aliases=[];
 for(const m of targetText.matchAll(/\b((?:[A-Z][A-Za-z0-9&’'-]*\s+){1,7}(?:Private Limited|Limited|Ltd\.?))\s*\(?[“"(]([A-Za-z][A-Za-z0-9]{2,20})[”")]/g))if(nameKey(m[1])===names[0])aliases.push(normal(m[2]));
 return {item,body,date:date||day(item),target:names[0]||null,aliases,amount:amounts[0]||null,total,stake:stakes[0]||null,stage,pending,instrument,tranche:tranches[0]||null,conditions:fs.filter(f=>f.field==='conditions').map(f=>conditionKey(f.value)),firm:item.kind==='filing'&&!!names[0],native};
}
export function investmentProfiles(items){
 const profiles=new Map(items.map(item=>[item,rawProfile(item)]));
 const anchors=[...profiles.values()].filter(p=>p?.firm);
 for(const p of profiles.values())if(p&&!p.target){
  const candidates=anchors.filter(a=>a.item.ticker===p.item.ticker&&a.date===p.date&&
   termsAgree(p,a)&&
   ([a.target,a.target.replace(/ private$/,''),...a.aliases].some(n=>explicitAlias(p.body,n))||p.amount&&(!a.amount||a.amount.key===p.amount.key)&&/\bin beauty (?:unit|subsidiary)\b/i.test(p.body)&&/\bbeauty\b/.test(a.target)));
  const names=unique(candidates.map(a=>a.target));if(names.length===1)p.target=names[0];
 }
 for(const p of profiles.values())if(p?.target){
  const possible=anchors.filter(a=>a.item.ticker===p.item.ticker&&a.date===p.date&&a.target===p.target&&termsAgree(p,a));
  p.ambiguous=possible.some(a=>possible.some(b=>!termsAgree(a,b)));
 }
 return profiles;
}
export function sameInvestmentEvent(a,b,profiles){
 const x=profiles?.get(a),y=profiles?.get(b);
 if(!x?.target||!y?.target||x.ambiguous||y.ambiguous||a.ticker!==b.ticker||!!a.related!==!!b.related||x.target!==y.target||x.date!==y.date||Math.abs(a.at-b.at)>86400000)return false;
 if(a.kind==='news'&&b.kind==='news'&&(a.eventId||b.eventId)&&a.eventId!==b.eventId)return false;
 return termsAgree(x,y);
}
/** One short saved-source reading. Unknown material conditions remain explicit;
 * historical turnover and earlier approvals stay in the complete source register. */
export function investmentReading(items){
 if(!items.some(item=>item.kind==='filing'&&item.content?.state==='ready'&&item.content.format!=='xbrl'&&facts(item).some(f=>f.field==='event'&&action.test(f.value))))return null;
 const profiles=investmentProfiles(items),ready=items.filter(i=>i.content?.state==='ready');
 const candidates=ready.map(i=>profiles.get(i)).filter(p=>p?.firm&&!p.native&&p.amount);
 if(!candidates.length||!items.every(a=>items.every(b=>a===b||sameInvestmentEvent(a,b,profiles))))return null;
 const lead=candidates.sort((a,b)=>facts(b.item).length-facts(a.item).length)[0],fs=facts(lead.item);
 const party=fs.find(f=>f.field==='counterparty'&&namedCompanies(f.value).some(n=>nameKey(n)===lead.target));
 const target=party?namedCompanies(party.value).find(n=>nameKey(n)===lead.target):null;
 if(!target)return null;
 const acronym=/\(([A-Z]{3,12})\)/.exec(party.value)?.[1];
 let note;
 if(lead.stage==='completed'&&/preference/i.test(lead.body)&&/rights issue/i.test(lead.body)){
  const total=fs.find(f=>f.field==='amount'&&/^Overall investment /i.test(f.value)),tranche=/\b(first|second|third|fourth) tranche\b/i.exec(fs.map(f=>f.value).join(' '))?.[0];
  const value=total&&investmentMoney(total.value)[0];
  const instrument=/\bNOCPS\b/i.test(lead.body)?'NOCPS':'preference-share';
  note=`${lead.amount.qualifier?lead.amount.qualifier+' ':''}${labelMoney(lead.amount)} ${tranche?tranche+' ':''}${instrument} rights-issue investment in ${acronym||target} completed.`+(value?` Total preference investment: ${labelMoney(value)}.`:'');
 }else if(lead.stage==='agreement'){
  const securities=fs.filter(f=>f.field==='ownership').map(f=>/\band (\d[\d,]* OCPRS)\b/i.exec(f.value)?.[1]).filter(Boolean);
  note=`${/\bdefinitive agreements\b/i.test(lead.body)?'Definitive agreements':'Agreements'} signed for ${target}: ${lead.amount.qualifier?lead.amount.qualifier+' ':''}${labelMoney(lead.amount)}`+(lead.stake?` for a ${lead.stake}% equity stake`:'')+(securities.length?` plus ${securities.join(' and ')}`:'')+'.'+(lead.pending?' Completion pending.':'');
 }else return null;
 const clauses=[];
 for(const f of fs.filter(f=>f.field==='conditions')){
  if(/^(?:Consideration form|Nature of consideration) is cash[.!]?$/i.test(f.value))continue;
  if(/^No governmental or regulatory approvals required for the acquisition[.!]?$/i.test(f.value))continue;
  if(/^Transaction classified as related party transaction; arm's length not applicable as [A-Z]{3,12} is wholly owned subsidiary[.!]?$/i.test(f.value)){clauses.push("Related-party investment; arm's length not applicable (wholly owned subsidiary).");continue;}
  if(/^Transaction completion conditional on fulfilment\/waiver of conditions precedent in transaction documents[.!]?$/i.test(f.value)){clauses.push('Conditions precedent apply.');continue;}
  clauses.push(clean(f.value).replace(/[.!]$/,'')+'.');
 }
 for(const f of fs.filter(f=>f.field==='date'&&/^Indicative completion timeline /i.test(f.value)))clauses.push(clean(f.value).replace(/[.!]$/,'')+'.');
 for(const item of ready.filter(i=>i!==lead.item&&i.kind==='filing'&&!profiles.get(i)?.native)){
  const own=new Set(fs.filter(f=>['conditions','amount','status','ownership'].includes(f.field)).map(f=>normal(f.value)));
  if(facts(item).some(f=>['conditions','amount','status','ownership'].includes(f.field)&&!own.has(normal(f.value))))return null;
 }
 note+=' '+unique(clauses).join(' ');
 return note.length<=600?{note:note.trim(),lead:lead.item}:null;
}
