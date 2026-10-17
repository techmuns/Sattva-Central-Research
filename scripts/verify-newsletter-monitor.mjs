import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MONITOR,auditNewsletter,monitorNewsletters,readNewsletter} from './lib/newsletter-delivery-audit.mjs';

const now=MONITOR.due+60000;
function fixture(prefix='sattva',count=2,total=3){
  const outcomes=Array.from({length:count},(_,i)=>{
    const root=`<${prefix}-${i}-0@example.test>`;
    return {email:`${prefix}-${i}@example.test`,ok:true,threadMessageId:root,
      parts:Array.from({length:total},(_,j)=>({part:j+1,total,bytes:1234,ok:true,status:201,attempts:1,
        messageId:`<${prefix}-${i}-${j}@example.test>`,request:{messageId:`<${prefix}-${i}-${j}@example.test>`,
          subject:`Fixture ${prefix}`,inReplyTo:j?root:null,references:j?[root]:[],bodySha256:'a'.repeat(64)}}))};
  });
  return {ok:true,runtime:'github-actions',delivery:'static-assets',preparedAt:new Date(now).toISOString(),
    schedule:{tokenConfigured:true,deliveryRecovery:{version:1,receiptVersion:1},lastWakeAt:new Date(MONITOR.due).toISOString(),next:{key:MONITOR.key,at:new Date(MONITOR.due).toISOString()}},
    settings:{morning:{enabled:true,time:'08:00'}},
    subscribers:outcomes.map(o=>({email:o.email,editions:['morning'],addedAt:'2026-10-01T00:00:00Z'})),
    deliveries:[{key:MONITOR.key,edition:'morning',day:MONITOR.day,source:'timer',scheduledAt:new Date(MONITOR.due).toISOString(),
      startedAt:new Date(MONITOR.due).toISOString(),finishedAt:new Date(now-1000).toISOString(),
      recipients:count,sent:count,failed:0,reason:null,summary:{emailParts:total},subject:`Fixture ${prefix}`,outcomes}]};
}
const audit=v=>auditNewsletter(v,{name:'Sattva',now});
assert.equal(audit(fixture()).state,'sender-accepted-and-headers-verified');
assert.equal(audit(fixture('one',1,1)).verifiedRecipients,1);
assert.equal(audit(fixture('many',7,9)).expectedParts,63);
const bad=(mutate,code)=>{const v=fixture();mutate(v,v.deliveries[0]);const r=audit(v);assert.notEqual(r.state,'sender-accepted-and-headers-verified');assert(r.issues.includes(code),JSON.stringify(r));};
bad((v,r)=>r.source='manual','not-target-automatic-edition');
bad((v,r)=>r.scheduledAt='2026-10-18T02:30:00Z','not-target-automatic-edition');
bad((v,r)=>r.outcomes.pop(),'recipient-outcomes-incomplete');
bad((v,r)=>r.outcomes[0].parts.pop(),'part-outcomes-incomplete');
bad((v,r)=>r.outcomes[0].parts[1].part=3,'part-order-invalid');
bad((v,r)=>r.outcomes[0].parts[1].request.inReplyTo=r.outcomes[1].threadMessageId,'thread-headers-invalid');
bad((v,r)=>r.outcomes[0].parts[1].request.references=[],'thread-headers-invalid');
bad((v,r)=>r.outcomes[0].parts[1].request.subject+=' changed','submitted-receipt-invalid');
bad((v,r)=>delete r.outcomes[0].parts[1].request,'submitted-receipt-invalid');
bad((v,r)=>r.outcomes[0].parts[1].messageId=null,'provider-message-id-unavailable');
bad((v,r)=>r.outcomes[0].parts[1].status=429,'part-not-accepted');
bad((v,r)=>r.outcomes[0].parts[1].request.messageId=r.outcomes[1].parts[1].request.messageId,'message-identity-reused');
bad((v,r)=>r.outcomes[0].cancelled=true,'recipient-cancelled');
bad((v,r)=>{r.subject=null;for(const o of r.outcomes)for(const p of o.parts)p.request.subject=null;},'edition-subject-invalid');
bad((v,r)=>r.outcomes[0].parts[1].reason='upstream','part-has-failure');
bad((v,r)=>r.sent=1,'delivery-totals-inconsistent');
bad((v,r)=>r.finishedAt=null,'edition-not-finished');
bad(v=>v.subscribers.push({email:'missed@example.test',editions:['morning'],addedAt:'2026-10-01T00:00:00Z'}),'eligible-recipient-missing');
bad(v=>v.settings.morning.enabled=false,'morning-schedule-changed');
bad(v=>v.schedule.tokenConfigured=false,'sender-not-configured');
const changed=fixture();changed.subscribers.push({email:'new@example.test',editions:['morning'],addedAt:new Date(now).toISOString()});
assert.equal(audit(changed).addedAfterClaim,1);assert.equal(audit(changed).verifiedRecipients,2);
changed.deliveries[0].outcomes[0].parts[1].attempts=2;assert.equal(audit(changed).extraAttempts,1);
const waiting=fixture();waiting.deliveries=[];
assert.equal(audit(waiting).state,'pending');
assert.equal(auditNewsletter(waiting,{name:'Sattva',now:MONITOR.due+1800000}).state,'delayed');
assert.equal(auditNewsletter(waiting,{name:'Sattva',now:MONITOR.end}).state,'incomplete');
waiting.preparedAt=new Date(MONITOR.due-1000).toISOString();
assert.equal(auditNewsletter(waiting,{name:'Sattva',now:MONITOR.due-500}).state,'armed');
waiting.schedule.next.key='wrong';assert.equal(auditNewsletter(waiting,{name:'Sattva',now:MONITOR.due-500}).state,'attention');
let requests=0;
const fetcher=async(url,options)=>{
  requests++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert(!options.headers.authorization);assert(!options.body);
  return Response.json(fixture(url.includes('glow-')?'glow':'sattva'));
};
const result=await monitorNewsletters({now,fetcher});
assert.equal(requests,2);assert(result.terminal);assert(!result.actionable);
assert(!result.inboxDeliveryVerified);assert(!result.inboxThreadMembershipVerified);
const encoded=JSON.stringify(result);
for(const privateValue of ['@example.test','bodySha256','request','threadMessageId','Fixture sattva','<sattva'])assert(!encoded.includes(privateValue));
const collision=await monitorNewsletters({now,fetcher:async()=>Response.json(fixture())});
assert(!collision.terminal);assert(collision.results[1].issues.includes('message-identity-reused'));
const unavailable=await monitorNewsletters({now:MONITOR.end,fetcher:async()=>{throw Error('private@example.test token=secret');}});
assert(unavailable.terminal&&unavailable.actionable);assert(!JSON.stringify(unavailable).includes('secret'));
await assert.rejects(readNewsletter('https://example.test/api/newsletter',{fetcher}),/origin/);
await assert.rejects(readNewsletter(MONITOR.targets[0].url,{fetcher:async()=>new Response(null,{status:500})}),/status/);
await assert.rejects(readNewsletter(MONITOR.targets[0].url,{fetcher:async()=>new Response('x'.repeat(8*1024*1024+1))}),/size/);
const utf8=Buffer.from(JSON.stringify({...fixture(),privateName:'अनु'}));
const split=utf8.indexOf(Buffer.from('अनु'))+1;
const streamed=await readNewsletter(MONITOR.targets[0].url,{fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(utf8.subarray(0,split));c.enqueue(utf8.subarray(split));c.close();}}))});
assert.equal(streamed.privateName,'अनु');
const workflow=fs.readFileSync('.github/workflows/newsletter-monitor.yml','utf8');
assert(workflow.includes('runs-on: ubuntu-latest'));assert(workflow.includes('ref: main'));
assert(!/secrets\.|send\/raw|workflow run newsletter-refresh|paid|OPENAI_API_KEY/.test(workflow));
assert(workflow.includes('gh workflow disable newsletter-monitor.yml'));
console.log('PASS Monday monitoring: exact edition, dynamic coverage, submitted threading, retry/cancellation exceptions, privacy, read-only requests and bounded streaming.');
