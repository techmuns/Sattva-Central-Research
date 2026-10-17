// Read-only, aggregate audit. Never return input objects, addresses or message IDs:
// the result is safe to retain in the public repository's monitor release.
export const MONITOR = Object.freeze({
  key:'2026-10-19:morning', day:'2026-10-19',
  due:Date.parse('2026-10-19T02:30:00Z'), end:Date.parse('2026-10-20T02:30:00Z'),
  targets:[
    {name:'Sattva',url:'https://sattva-central-research.tech-441.workers.dev/api/newsletter'},
    {name:'Glow',url:'https://glow-central-research.tech-441.workers.dev/api/newsletter'},
  ],
});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const id=s=>typeof s==='string'&&s.length<=998&&/^<[^<>\s@]+@[^<>\s@]+>$/.test(s);
const date=s=>typeof s==='string'?Date.parse(s):NaN;
const address=s=>typeof s==='string'&&/^[^\s@]+@[^\s@]+$/.test(s);

export function auditNewsletter(value,{name,now=Date.now(),identities=new Set()}={}) {
  const issues=new Set(),add=code=>issues.add(code);
  const report={name,state:'pending',plannedRecipients:0,partsPerRecipient:0,
    expectedParts:0,acceptedParts:0,verifiedRecipients:0,cancelledRecipients:0,
    currentRecipients:0,addedAfterClaim:0,removedSinceClaim:0,extraAttempts:0,
    preparedAt:null,lastWakeAt:null,finishedAt:null,issues:[]};
  if(!value||value.ok!==true||value.runtime!=='github-actions'||value.delivery!=='static-assets')add('reader-unavailable');
  const schedule=value?.schedule;
  if(schedule?.deliveryRecovery?.version!==1)add('recovery-unavailable');
  if(schedule?.deliveryRecovery?.receiptVersion!==1)add('submitted-receipts-unavailable');
  if(schedule?.tokenConfigured!==true)add('sender-not-configured');
  if(value?.settings?.morning?.enabled!==true||value?.settings?.morning?.time!=='08:00')add('morning-schedule-changed');
  const prepared=date(value?.preparedAt),wake=date(schedule?.lastWakeAt);
  if(!Number.isFinite(prepared)||prepared>now+60000)add('invalid-reader-time');
  else report.preparedAt=new Date(prepared).toISOString();
  if(Number.isFinite(wake)&&wake<=now+60000)report.lastWakeAt=new Date(wake).toISOString();
  if(!Array.isArray(value?.subscribers))add('subscriber-list-unavailable');
  const eligible=(value?.subscribers||[]).filter(r=>Array.isArray(r.editions)&&r.editions.includes('morning'));
  report.currentRecipients=eligible.length;
  if(eligible.some(r=>!address(r.email))||new Set(eligible.map(r=>r.email)).size!==eligible.length)add('invalid-subscriber-list');
  const rows=Array.isArray(value?.deliveries)?value.deliveries.filter(d=>d.key===MONITOR.key):[];
  if(rows.length>1)add('duplicate-edition');
  const row=rows[0];
  if(!row){
    if(now<MONITOR.due){
      if(schedule?.next?.key!==MONITOR.key||date(schedule?.next?.at)!==MONITOR.due)add('next-edition-not-armed');
      report.state=issues.size?'attention':'armed';
    }else{add('edition-not-observed');report.state=now>=MONITOR.end?'incomplete':now>=MONITOR.due+1800000?'delayed':'pending';}
    report.issues=[...issues];return report;
  }
  if(typeof row.subject!=='string'||!row.subject.trim()||row.subject.length>2000)add('edition-subject-invalid');
  if(row.source!=='timer'||row.edition!=='morning'||row.day!==MONITOR.day||date(row.scheduledAt)!==MONITOR.due)add('not-target-automatic-edition');
  const started=date(row.startedAt),finished=date(row.finishedAt);
  if(!Number.isFinite(started)||started<MONITOR.due||started>now+60000)add('invalid-claim-time');
  if(Number.isFinite(finished)){
    report.finishedAt=new Date(finished).toISOString();
    if(finished<started||finished>prepared||finished>now+60000)add('invalid-finish-time');
  }
  if(!integer(row.recipients)||row.recipients<1)add('invalid-recipient-count');
  if(!integer(row.summary?.emailParts)||row.summary.emailParts<1||row.summary.emailParts>1000)add('invalid-part-count');
  const outcomes=Array.isArray(row.outcomes)?row.outcomes:[];
  report.plannedRecipients=integer(row.recipients)?row.recipients:0;
  report.partsPerRecipient=integer(row.summary?.emailParts)?row.summary.emailParts:0;
  report.expectedParts=report.plannedRecipients*report.partsPerRecipient;
  if(outcomes.length!==report.plannedRecipients)add('recipient-outcomes-incomplete');
  const recipients=new Set();
  for(const outcome of outcomes){
    let valid=true;
    const bad=code=>{valid=false;add(code);};
    if(!address(outcome.email)||recipients.has(outcome.email))bad('duplicate-or-invalid-recipient');
    recipients.add(outcome.email);
    if(!eligible.some(r=>r.email===outcome.email))report.removedSinceClaim++;
    if(outcome.cancelled){report.cancelledRecipients++;add('recipient-cancelled');}
    const parts=Array.isArray(outcome.parts)?outcome.parts:[];
    if(parts.length!==report.partsPerRecipient)bad('part-outcomes-incomplete');
    const root=parts[0]?.messageId||parts[0]?.request?.messageId;
    if(!id(root)||outcome.threadMessageId!==root)bad('root-receipt-invalid');
    for(const [i,part]of parts.entries()){
      if(part.part!==i+1||part.total!==report.partsPerRecipient)bad('part-order-invalid');
      if(!integer(part.bytes)||part.bytes<1||part.bytes>90000)bad('part-size-invalid');
      if(!integer(part.attempts)||part.attempts<1)bad('part-not-attempted');
      else report.extraAttempts+=part.attempts-1;
      const accepted=part.ok===true&&integer(part.status)&&part.status>=200&&part.status<300;
      if(accepted)report.acceptedParts++;else bad('part-not-accepted');
      if(part.reason!=null)bad('part-has-failure');
      const request=part.request;
      if(!request||!id(request.messageId)||request.subject!==row.subject||
        typeof request.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(request.bodySha256))bad('submitted-receipt-invalid');
      if(request?.inReplyTo!==(i?root:null)||!Array.isArray(request?.references)||
        JSON.stringify(request.references)!==JSON.stringify(i?[root]:[]))bad('thread-headers-invalid');
      if(!id(part.messageId))bad('provider-message-id-unavailable');
      for(const identity of new Set([part.messageId,request?.messageId].filter(id))){
        if(identities.has(identity))bad('message-identity-reused');
        identities.add(identity);
      }
    }
    if(outcome.ok!==true||outcome.reason!=null)bad('recipient-incomplete');
    if(valid&&!outcome.cancelled)report.verifiedRecipients++;
  }
  for(const subscriber of eligible)if(!recipients.has(subscriber.email)){
    if(date(subscriber.addedAt)>started)report.addedAfterClaim++;
    else add('eligible-recipient-missing');
  }
  const successful=outcomes.filter(r=>r.ok===true).length;
  if(row.sent!==successful||row.failed!==outcomes.length-successful)add('delivery-totals-inconsistent');
  if(!Number.isFinite(finished))add('edition-not-finished');
  if(row.reason!=null)add('edition-has-failure');
  if(prepared<MONITOR.due)add('reader-before-target');
  const complete=!issues.size&&report.verifiedRecipients===report.plannedRecipients&&report.acceptedParts===report.expectedParts;
  report.state=complete?'sender-accepted-and-headers-verified':now>=MONITOR.end?'incomplete':now>=MONITOR.due+1800000?'delayed':'pending';
  report.issues=[...issues];return report;
}

export async function readNewsletter(url,{fetcher=fetch}={}){
  // Fixed known origins only; never forward the GitHub token to a dashboard.
  if(!MONITOR.targets.some(t=>t.url===url))throw Error('monitor-origin');
  const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json','cache-control':'no-cache'}});
  if(!response.ok)throw Error('monitor-reader-status');
  let text='',bytes=0;const decoder=new TextDecoder();
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('monitor-reader-size');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();
  return JSON.parse(text);
}

export async function monitorNewsletters({now=Date.now(),fetcher=fetch}={}){
  const identities=new Set(),results=[];
  for(const target of MONITOR.targets){
    try{results.push(auditNewsletter(await readNewsletter(target.url,{fetcher}),{name:target.name,now,identities}));}
    catch{results.push({name:target.name,state:'attention',issues:['reader-fetch-failed']});}
  }
  const complete=results.every(r=>r.state==='sender-accepted-and-headers-verified');
  return {version:1,key:MONITOR.key,checkedAt:new Date(now).toISOString(),
    dueAt:new Date(MONITOR.due).toISOString(),endAt:new Date(MONITOR.end).toISOString(),
    state:complete?'sender-accepted-and-headers-verified':now<MONITOR.due?'readiness':now>=MONITOR.end?'incomplete':'monitoring',
    terminal:complete||now>=MONITOR.end,
    actionable:results.some(r=>['attention','delayed','incomplete'].includes(r.state)),
    evidence:'Saved provider acknowledgements and submitted Message-ID, In-Reply-To, References and subject; automatic timer edition only.',
    inboxDeliveryVerified:false,inboxThreadMembershipVerified:false,
    limitation:'Sender acceptance and submitted headers do not establish receipt or thread placement inside subscriber inboxes. No recipient mailbox access is available to this job.',
    results};
}
