import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {sendEmail} from '../../worker/newsletter-schedule.mjs';
import {renderBriefHtml,briefStats} from '../../worker/newsletter-brief.mjs';
import {acceptedStoryKeys,emailBytes,EMAIL_HTML_BYTES} from '../../worker/newsletter-email.mjs';

// Only this encrypted GitHub database holds recipient bodies and retry state.
// Existing edition claims without a queue are deliberately never replayed.
export class NewsletterDeliveryQueue {
  constructor(local,{publish,context,now=Date.now}={}) {
    this.local=local;this.publish=publish;this.context=context;this.now=now;
    local.db.exec(`CREATE TABLE IF NOT EXISTS newsletter_delivery_queue (
      key TEXT PRIMARY KEY, edition TEXT NOT NULL, source TEXT NOT NULL,
      next_at INTEGER NOT NULL, payload BLOB, receipt TEXT)`);
  }

  pending() { return this.local.db.prepare("SELECT key,edition,source,next_at FROM newsletter_delivery_queue WHERE payload IS NOT NULL AND source != 'test' ORDER BY next_at,key").all(); }

  save(plan) {
    this.local.db.prepare('UPDATE newsletter_delivery_queue SET next_at=?,payload=? WHERE key=?')
      .run(plan.nextAt,gzipSync(JSON.stringify(plan)),plan.key);
  }

  async deliver({key,edition,source,brief,list,messages,pdfUrl,documentId,credential,subject,summary}) {
    const host=new URL(this.local.schedule.dashboardUrl()).hostname;
    const stats=briefStats(brief);
    const plan={key,edition,source,documentId,subject,summary,nextAt:this.now(),
      messages:messages.map(m=>({keys:m.keys})),reported:brief.reported,windowFrom:brief.window.from,
      recipients:list.map(recipient=>({email:recipient.email,ok:false,status:null,reason:'not-attempted',
        parts:messages.map((message,i)=>{
          const html=renderBriefHtml(brief,{...this.local.schedule.renderOptions(recipient),stats,pdfUrl,part:message.part});
          if(emailBytes(html)>EMAIL_HTML_BYTES)throw Error('Prepared newsletter part exceeds email limit');
          return {part:i+1,total:messages.length,bytes:emailBytes(html),html,subject:message.subject,
            requestedMessageId:`<newsletter.${crypto.randomUUID()}@${host}>`,ok:false,status:null,reason:'not-attempted',attempts:0};
        })}))};
    this.local.db.prepare('INSERT INTO newsletter_delivery_queue(key,edition,source,next_at,payload) VALUES(?,?,?,?,?)')
      .run(key,edition,source,plan.nextAt,gzipSync(JSON.stringify(plan)));
    return this.run(plan,credential);
  }

  progress(plan,{finished=false}={}) {
    const outcomes=plan.recipients.map(({parts,...recipient})=>({...recipient,parts:parts.map(({html,subject,requestedMessageId,...part})=>part)}));
    const sent=outcomes.filter(o=>o.ok).length,failed=outcomes.length-sent;
    const reason=failed ? outcomes.some(o=>o.parts.some(p=>p.ok))?'partial-send':outcomes.find(o=>!o.ok)?.reason||'failed' : null;
    const accepted=new Set();for(const o of outcomes)for(const [i,p]of o.parts.entries())if(p.ok)accepted.add(i);
    const published=new Map(plan.reported.map(item=>[item.key,item.publishedAt]));
    const reported=plan.source==='test'?[]:acceptedStoryKeys(plan.messages,accepted).map(key=>({key,publishedAt:published.get(key)}));
    const values={sent,failed,reason,outcomes,subject:plan.subject,summary:plan.summary,reported,windowFrom:plan.windowFrom};
    if(finished)this.local.store.finishDelivery(plan.key,values);
    else this.local.store.recordDeliveryProgress(plan.key,values);
    return {ok:!failed,key:plan.key,...values};
  }

  async run(plan,credential=this.local.schedule.env.MUNS_TOKEN) {
    return this.context(plan,async()=>{
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
          if(!credential){part.reason='no-token';recipient.reason='no-token';break;}
          // Publish this intent before the guarded provider I/O. If acceptance is
          // uncertain, recovery uses the very same RFC Message-ID and body.
          part.request={messageId:part.requestedMessageId,subject:part.subject,
            inReplyTo:part.part===1?null:recipient.threadMessageId,
            references:part.part===1?[]:[recipient.threadMessageId],
            bodySha256:createHash('sha256').update(part.html).digest('hex')};
          part.reason='sending';part.attempts++;this.save(plan);this.progress(plan);
          const root=recipient.parts[0];
          const result=await sendEmail({fetcher:this.local.schedule.fetcher,token:credential,email:recipient.email,
            subject:part.request.subject,html:part.html,messageId:part.request.messageId,
            inReplyTo:part.request.inReplyTo});
          Object.assign(part,result);
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
      const result=this.progress(plan,{finished:complete||plan.source==='test'});
      if(complete||plan.source==='test') {
        this.local.store.finishDocument(plan.documentId,plan.recipients.flatMap(r=>r.parts));
        this.local.db.prepare('UPDATE newsletter_delivery_queue SET payload=NULL,receipt=? WHERE key=?').run(JSON.stringify(result),plan.key);
      } else this.save(plan);
      await this.publish();return result;
    });
  }

  async recover() {
    const results=[];
    for(const row of this.pending()) {
      if(row.next_at>this.now())continue;
      const {payload}=this.local.db.prepare('SELECT payload FROM newsletter_delivery_queue WHERE key=?').get(row.key);
      const plan=JSON.parse(gunzipSync(payload,{maxOutputLength:128*1024*1024}));
      results.push(await this.run(plan));
    }
    return results;
  }
}
