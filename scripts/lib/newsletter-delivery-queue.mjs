import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {sendEmail,CATCH_UP_MS} from '../../worker/newsletter-schedule.mjs';
import {renderBriefHtml,briefStats} from '../../worker/newsletter-brief.mjs';
import {acceptedStoryKeys,emailBytes,EMAIL_HTML_BYTES,newsletterDeliveryPolicy} from '../../worker/newsletter-email.mjs';
import {normaliseEmail,istDay} from '../../public/js/data/newsletter-shared.js';

function requestedTest(plan){
  const request=plan.testRequest;if(!request)return null;
  // The sealed request lives 24 hours from issuance; its accepted future-clock
  // skew can put that deadline up to 25 hours beyond the runner plan clock.
  if(plan.source!=='test'||!Number.isSafeInteger(plan.createdAt)||plan.createdAt<=0||!Number.isSafeInteger(request.expiresAt)||request.expiresAt<=0||request.expiresAt>plan.createdAt+25*3600000||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.id||'')||plan.recipients?.length!==1||
    !normaliseEmail(request.email)||request.email!==plan.recipients[0].email)throw Error('Requested test recovery scope invalid');
  return request;
}
export function newsletterPendingDeliveries(db){
  const pending=db.prepare('SELECT key,edition,source,next_at FROM newsletter_delivery_queue WHERE payload IS NOT NULL ORDER BY next_at,key').all().flatMap(row=>{
    if(row.source!=='test')return [row];
    const {payload}=db.prepare('SELECT payload FROM newsletter_delivery_queue WHERE key=?').get(row.key);
    const plan=JSON.parse(gunzipSync(payload,{maxOutputLength:128*1024*1024}));
    if(plan.key!==row.key||plan.source!==row.source||plan.edition!==row.edition)throw Error('Requested test queue identity invalid');
    const request=requestedTest(plan);
    // Legacy tests never acquire automatic recovery merely by upgrading code.
    return request?[{...row,requestedTest:true,expiresAt:request.expiresAt}]:[];
  });
  for(const row of db.prepare("SELECT i.id,i.payload FROM newsletter_request_intents i JOIN newsletter_requests r ON r.id=i.id WHERE r.state='queued' AND r.result IS NULL").all()){
    const input=JSON.parse(row.payload);
    if(input.id!==row.id||input.to!=='me'||input.sourceOnly!==true||!normaliseEmail(input.email)||!['morning','evening'].includes(input.edition)||!Number.isSafeInteger(input.at))throw Error('Requested test intent invalid');
    pending.push({key:'request-'+row.id,edition:input.edition,source:'test',requestedTest:true,next_at:input.at,expiresAt:input.at+24*3600000});
  }
  return pending;
}

// Only this encrypted GitHub database holds recipient bodies and retry state.
// Existing edition claims without a queue are deliberately never replayed.
export class NewsletterDeliveryQueue {
  constructor(local,{publish,context,now=Date.now}={}) {
    this.local=local;this.publish=publish;this.context=context;this.now=now;
    local.db.exec(`CREATE TABLE IF NOT EXISTS newsletter_delivery_queue (
      key TEXT PRIMARY KEY, edition TEXT NOT NULL, source TEXT NOT NULL,
      next_at INTEGER NOT NULL, payload BLOB, receipt TEXT);
      CREATE TABLE IF NOT EXISTS newsletter_delivery_bodies (
      delivery TEXT NOT NULL,email TEXT NOT NULL,part INTEGER NOT NULL,html TEXT NOT NULL,PRIMARY KEY(delivery,email,part))`);
  }

  pending() { return newsletterPendingDeliveries(this.local.db); }

  save(plan) {
    this.local.db.prepare('UPDATE newsletter_delivery_queue SET next_at=?,payload=? WHERE key=?')
      .run(plan.nextAt,gzipSync(JSON.stringify(plan)),plan.key);
  }

  async deliver({key,edition,source,brief,list,messages,pdfUrl,documentId,credential,subject,summary,testRequest=null}) {
    const host=new URL(this.local.schedule.dashboardUrl()).hostname;
    const stats=briefStats(brief);
    let plan;this.local.db.exec('BEGIN');
    try {
    const saveBody=this.local.db.prepare('INSERT INTO newsletter_delivery_bodies(delivery,email,part,html) VALUES(?,?,?,?)');
    plan={key,edition,source,documentId,subject,summary,nextAt:this.now(),createdAt:this.now(),editionAt:brief.at,...(testRequest?{testRequest,credential}:{}),
      messages:messages.map(m=>({keys:m.keys})),reported:brief.reported,windowFrom:brief.window.from,priceSession:brief.moves?.session,
      recipients:list.map(recipient=>({email:recipient.email,ok:false,status:null,reason:'not-attempted',
        parts:messages.map((message,i)=>{
          const html=renderBriefHtml(brief,{...this.local.schedule.renderOptions(recipient),stats,pdfUrl,part:message.part});
          if(emailBytes(html)>EMAIL_HTML_BYTES)throw Error('Prepared newsletter part exceeds email limit');
          saveBody.run(key,recipient.email,i+1,html);
          return {part:i+1,total:messages.length,bytes:emailBytes(html),subject:message.subject,
            requestedMessageId:`<newsletter.${crypto.randomUUID()}@${host}>`,ok:false,status:null,reason:'not-attempted',attempts:0};
        })}))};
    requestedTest(plan);
    this.local.db.prepare('INSERT INTO newsletter_delivery_queue(key,edition,source,next_at,payload) VALUES(?,?,?,?,?)')
      .run(key,edition,source,plan.nextAt,gzipSync(JSON.stringify(plan)));
    this.local.db.exec('COMMIT');
    }catch(error){this.local.db.exec('ROLLBACK');throw error;}
    // Acknowledged outbox precedes even the first SMTP guard. An interrupted
    // preparation restores its sealed intent; an interrupted send restores this plan.
    if(testRequest){this.progress(plan);this.local.db.prepare('DELETE FROM newsletter_request_intents WHERE id=?').run(testRequest.id);}
    await this.publish();
    return this.run(plan,credential);
  }

  progress(plan,{finished=false,terminalReason=null}={}) {
    const outcomes=plan.recipients.map(({parts,...recipient})=>({...recipient,parts:parts.map(({html,subject,requestedMessageId,...part})=>part)}));
    const sent=outcomes.filter(o=>o.ok).length,failed=outcomes.length-sent;
    const reason=failed ? outcomes.some(o=>o.parts.some(p=>p.ok))?'partial-send':outcomes.find(o=>!o.ok)?.reason||'failed' : null;
    const accepted=new Set();for(const o of outcomes)for(const [i,p]of o.parts.entries())if(p.ok)accepted.add(i);
    const published=new Map(plan.reported.map(item=>[item.key,item.publishedAt]));
    const reported=plan.source==='test'?[]:acceptedStoryKeys(plan.messages,accepted).map(key=>({key,publishedAt:published.get(key)}));
    const values={sent,failed,reason:terminalReason||reason,outcomes,subject:plan.subject,summary:plan.summary,reported,windowFrom:plan.windowFrom};
    if(finished)this.local.store.finishDelivery(plan.key,values);
    else this.local.store.recordDeliveryProgress(plan.key,values);
    const result={ok:!failed,key:plan.key,...values},request=requestedTest(plan);
    if(request)this.local.db.prepare('UPDATE newsletter_requests SET state=?,result=? WHERE id=?').run(finished?'completed':'pending',JSON.stringify(result),request.id);
    return result;
  }

  async run(plan,credential=plan.credential||this.local.schedule.env.MUNS_TOKEN) {
    return this.context(plan,async()=>{
      // Check frozen plans as well as new builds: upgrading must not resume the old
      // 86-part backlog. Preserve accepted outcomes, PDF links and incident bodies.
      const priorSessionPrice = item => plan.priceSession && item.key?.startsWith('move:') &&
        item.key.endsWith('|'+plan.priceSession) && Number.isFinite(item.publishedAt) && istDay(item.publishedAt) === plan.priceSession;
      const outsideWindow = Number.isFinite(plan.windowFrom) && plan.reported.some(item => item.publishedAt < plan.windowFrom && !priorSessionPrice(item));
      const editionAt = plan.editionAt ?? Date.parse(this.local.store.delivery(plan.key)?.scheduledAt || '');
      const expiredEdition = plan.source !== 'test' && this.now() - (Number.isFinite(editionAt) ? editionAt : plan.createdAt) > CATCH_UP_MS;
      const policyReason = newsletterDeliveryPolicy({
        partCount: Math.max(plan.messages.length, ...plan.recipients.map(r => r.parts.length)),
        lateCount: plan.summary?.late || (outsideWindow ? 1 : 0),
      }) || (expiredEdition ? 'edition-expired' : null);
      if (policyReason) {
        for (const recipient of plan.recipients) {
          if (recipient.ok) continue;
          recipient.cancelled = true;
          recipient.reason = policyReason;
          for (const part of recipient.parts) if (!part.ok && !part.attempts) part.reason = policyReason;
        }
        const result = this.progress(plan, { finished: true, terminalReason: policyReason });
        const parts = plan.recipients.flatMap(r => r.parts);
        const documentState = parts.some(p => p.ok) ? 'sent' : parts.some(p => p.attempts > 0 && p.providerAttempted !== false) ? 'delivery-uncertain' : 'cancelled';
        this.local.db.prepare('UPDATE newsletter_documents SET delivery_state=? WHERE id=?').run(documentState,plan.documentId);
        this.local.db.prepare('UPDATE newsletter_delivery_queue SET payload=NULL,receipt=? WHERE key=?').run(JSON.stringify(result),plan.key);
        await this.publish();
        return result;
      }
      const request=requestedTest(plan),expired=()=>!!request&&this.now()>=request.expiresAt;
      if(request){
        const claim=this.local.db.prepare('SELECT state,result FROM newsletter_requests WHERE id=?').get(request.id);
        if(!claim||!claim.result&&claim.state!=='claimed')throw Error('Requested test claim unavailable');
        if(claim.result){const prior=JSON.parse(claim.result);
          if(prior.key!==plan.key||prior.outcomes?.length!==1||prior.outcomes[0].email!==request.email)throw Error('Requested test claim scope changed');
          if(prior.ok&&!plan.recipients.every(r=>r.ok))throw Error('Completed requested test cannot replay');
        }
      }
      // Process recipients sequentially so acknowledgements reach retained state
      // before another external send. Every part keeps its original bytes and ID.
      for(const recipient of plan.recipients) {
        if(recipient.ok||recipient.cancelled)continue;
        const automatic=plan.source==='timer';
        if(automatic&&!this.local.store.settings()[plan.edition]?.enabled)continue;
        if(plan.source!=='test'&&!this.local.store.recipients(plan.edition).some(r=>r.email===recipient.email)) {
          recipient.cancelled=true;recipient.reason='recipient-removed';continue;
        }
        for(const part of recipient.parts) {
          if(part.ok)continue;
          if(expired()){if(!part.attempts)part.reason='request-expired';recipient.reason='request-expired';continue;}
          if(!credential){part.reason='no-token';recipient.reason='no-token';break;}
          // Publish this intent before the guarded provider I/O. If acceptance is
          // uncertain, recovery uses the very same RFC Message-ID and body.
          // Older retained plans carry inline bodies; new plans read one bounded frozen
          // body at a time, independent of the subscriber/part cross product.
          const html=part.html??this.local.db.prepare('SELECT html FROM newsletter_delivery_bodies WHERE delivery=? AND email=? AND part=?').get(plan.key,recipient.email,part.part)?.html;
          if(typeof html!=='string'||emailBytes(html)>EMAIL_HTML_BYTES)throw Error('Frozen newsletter body unavailable');
          part.request={messageId:part.requestedMessageId,subject:part.subject,
            inReplyTo:part.part===1?null:recipient.threadMessageId,
            references:part.part===1?[]:[recipient.threadMessageId],
            bodySha256:createHash('sha256').update(html).digest('hex')};
          const priorOutcome={reason:part.reason,status:part.status},priorAttempts=part.attempts;
          part.reason='sending';part.attempts++;this.save(plan);this.progress(plan);
          const root=recipient.parts[0];
          const result=await sendEmail({fetcher:this.local.schedule.fetcher,token:credential,email:recipient.email,
            subject:part.request.subject,html,messageId:part.request.messageId,
            inReplyTo:part.request.inReplyTo});
          if(result.providerAttempted===false&&priorAttempts){part.reason=priorOutcome.reason;part.status=priorOutcome.status;}
          else Object.assign(part,result);
          if(part===root&&result.ok)recipient.threadMessageId=result.messageId||part.requestedMessageId;
          recipient.ok=recipient.parts.every(p=>p.ok);
          const unfinished=recipient.parts.find(p=>!p.ok);
          recipient.status=unfinished?.status??result.status;
          recipient.reason=recipient.ok?null:recipient.parts.some(p=>p.ok)?'partial-send':unfinished.reason;
          this.save(plan);this.progress(plan);await this.publish();
          // Never send a later part before the root/previous part is acknowledged.
          if(!result.ok)break;
        }
      }
      const complete=plan.recipients.every(r=>r.ok||r.cancelled);
      const attempts=Math.max(1,...plan.recipients.flatMap(r=>r.parts.map(p=>p.attempts)));
      plan.nextAt=this.now()+Math.min(6*3600000,300000*3**Math.min(attempts-1,5));
      if(request)plan.nextAt=Math.min(plan.nextAt,request.expiresAt);
      const finished=complete||plan.source==='test'&&!request||expired();
      const result=this.progress(plan,{finished,terminalReason:expired()&&!complete?'request-expired':null});
      if(finished) {
        const submitted=plan.recipients.flatMap(r=>r.parts).filter(p=>p.attempts>0&&p.providerAttempted!==false);
        if(submitted.length)this.local.store.finishDocument(plan.documentId,submitted);
        else this.local.db.prepare('DELETE FROM newsletter_documents WHERE id=?').run(plan.documentId);
        this.local.db.prepare('UPDATE newsletter_delivery_queue SET payload=NULL,receipt=? WHERE key=?').run(JSON.stringify(result),plan.key);
        this.local.db.prepare('DELETE FROM newsletter_delivery_bodies WHERE delivery=?').run(plan.key);
      } else this.save(plan);
      await this.publish();return result;
    });
  }

  async recover() {
    const results=[];
    for(const row of this.pending()) {
      if(row.key.startsWith('request-'))continue;
      if(row.next_at>this.now())continue;
      const {payload}=this.local.db.prepare('SELECT payload FROM newsletter_delivery_queue WHERE key=?').get(row.key);
      const plan=JSON.parse(gunzipSync(payload,{maxOutputLength:128*1024*1024}));
      results.push(await this.run(plan));
    }
    return results;
  }
}
