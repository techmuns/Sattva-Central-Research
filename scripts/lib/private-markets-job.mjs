import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {privateMarketsSlot,WEEK} from '../../public/js/data/private-markets-shared.js';
import {buildIntelligence,fingerprint,intelligenceEmails,validRoster} from './private-markets-intelligence.mjs';
import {sendEmail} from '../../worker/newsletter-schedule.mjs';
import {fundMatches} from '../../public/js/data/private-market-funds.js';
const iso=at=>new Date(at).toISOString();
// Retained inside the existing encrypted newsletter checkpoint/account mutex.
// No daily-brief setting, delivery claim, reported item or PDF is touched.
export class PrivateMarketsJob {
 constructor(local,{readSources,publish,refreshInputs,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  Object.assign(this,{local,readSources,publish,refreshInputs,fetcher,now,sleep});
  local.db.exec(`CREATE TABLE IF NOT EXISTS private_markets_seen(id TEXT PRIMARY KEY,hash TEXT NOT NULL,row TEXT NOT NULL,pending INTEGER NOT NULL,change TEXT);
   CREATE TABLE IF NOT EXISTS private_markets_editions(key TEXT PRIMARY KEY,at INTEGER NOT NULL,state TEXT NOT NULL,plan BLOB NOT NULL);
   CREATE TABLE IF NOT EXISTS private_markets_meta(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS private_markets_match_pending(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS private_markets_quarantine(id TEXT PRIMARY KEY,hash TEXT NOT NULL,edition TEXT NOT NULL,part INTEGER NOT NULL)`);
  if(!this.meta().activatedAt)this.setMeta({...this.meta(),activatedAt:iso(this.now())});
 }
 meta(){const row=this.local.db.prepare("SELECT payload FROM private_markets_meta WHERE key='state'").get();return row?JSON.parse(row.payload):{};}
 setMeta(value){this.local.db.prepare("INSERT INTO private_markets_meta VALUES('state',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(value));}
 saveView(id,value){this.local.db.prepare('INSERT INTO newsletter_views VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(value));}
 status(){const meta=this.meta(),next=privateMarketsSlot(this.now(),{next:true});const delivery=this.local.db.prepare('SELECT key,state FROM private_markets_editions ORDER BY at DESC LIMIT 1').get();
  return {enabled:true,title:'Private Markets Intelligence',cadence:'Monday 09:00 IST',nextAt:iso(next.at),lastCheckedAt:meta.lastCheckedAt||null,sourceCheckedAt:meta.sourceCheckedAt||null,rosterCheckedAt:meta.rosterCheckedAt||null,rosterAvailable:meta.rosterAvailable===true,sourceState:meta.sourceState||'preparing',lastResult:meta.lastResult||'preparing',mailCooldownUntil:meta.mailCooldownUntil||null,lastEdition:delivery||null};}
 savePlan(plan,state){this.local.db.prepare('INSERT INTO private_markets_editions VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,plan=excluded.plan').run(plan.key,plan.at,state,gzipSync(JSON.stringify(plan)));}
 async prepare({force=false}={}) {
  const now=this.now(),meta=this.meta();
  if(!force&&meta.lastCheckedAt&&now-Date.parse(meta.lastCheckedAt)<3600000)return;
  let capture,roster;
  try{({capture,roster}=await this.readSources());}catch{this.runResult='funding-source-unavailable';this.capture=null;this.setMeta({...meta,lastCheckedAt:iso(now),sourceState:'funding-source-unavailable'});this.saveView('preview-private-markets-html-1',{ok:false,reason:'funding-source-unavailable'});this.saveView('private-markets-status',this.status());return;}
  try{validRoster(roster);}catch{roster={ok:false,reason:'Invested fund directory unavailable'};}
  const slot=privateMarketsSlot(now,{next:true}),model=buildIntelligence({capture,roster,at:now,slot});
  const initialized=!!meta.initializedAt,save=this.local.db.prepare('INSERT INTO private_markets_seen VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,row=excluded.row,pending=excluded.pending,change=excluded.change');
  this.local.storage.transactionSync(()=>{
   for(const row of capture.deals){const hash=fingerprint(row,capture.articles.find(a=>a.url===row.sourceUrl)?.notes||[]),old=this.local.db.prepare('SELECT hash,pending,change FROM private_markets_seen WHERE id=?').get(row.id);
    if(old?.hash===hash)continue;
    const change=old?'Source correction':initialized?'Late arrival / newly captured report':null;
    // Initial historical import is the baseline, not thousands of new emails.
    const recent=model.rows.some(r=>r.observations.some(o=>o.id===row.id));
    save.run(row.id,hash,JSON.stringify(row),old?.pending||initialized||recent?1:0,change);
    this.local.db.prepare('UPDATE private_markets_match_pending SET hash=? WHERE id=?').run(hash,row.id);
   }
  });
  this.capture=capture;this.roster=roster;
  if(roster.ok)for(const entry of this.pendingMatches()){const row=capture.deals.find(r=>r.id===entry.id);if(row&&!fundMatches(row,roster).length)this.local.db.prepare('DELETE FROM private_markets_match_pending WHERE id=?').run(entry.id);}
  this.setMeta({...meta,initializedAt:meta.initializedAt||iso(now),lastCheckedAt:iso(now),sourceCheckedAt:capture.sourceCheckedAt,rosterCheckedAt:roster.checkedAt||null,rosterAvailable:roster.ok===true,sourceState:roster.ok?'ready':'fund-roster-unavailable',lastResult:!meta.lastResult||['build-failed','funding-source-unavailable'].includes(meta.lastResult)?'ready':meta.lastResult});
  this.preparePreview();this.saveView('private-markets-status',this.status());
 }
 fail(){this.runResult='build-failed';this.setMeta({...this.meta(),lastCheckedAt:iso(this.now()),sourceState:'build-failed',lastResult:'build-failed'});this.saveView('preview-private-markets-html-1',{ok:false,reason:'build-failed'});}
 pending(){return this.local.db.prepare('SELECT id,change FROM private_markets_seen WHERE pending=1').all();}
 pendingMatches(){return this.local.db.prepare('SELECT id,hash FROM private_markets_match_pending').all();}
 model(slot){return buildIntelligence({capture:this.capture,roster:this.roster,at:this.now(),slot,pending:this.pending(),pendingMatches:this.pendingMatches(),quarantined:this.local.db.prepare('SELECT id,hash FROM private_markets_quarantine').all()});}
 senderHoldReason(){const token=this.local.schedule.env.MUNS_TOKEN,hash=token?createHash('sha256').update(token).digest('hex'):null;return hash&&this.meta().blockedCredential===hash?'sender-unavailable':Date.parse(this.meta().mailCooldownUntil||'')>this.now()?'sender-cooldown':null;}
 senderHeld(){return !!this.senderHoldReason();}
 quarantine(plan,part){for(const o of plan.messages[part.part-1].observations){this.local.db.prepare('INSERT OR REPLACE INTO private_markets_quarantine VALUES(?,?,?,?)').run(o.id,o.hash,plan.key,part.part);this.local.db.prepare('UPDATE private_markets_seen SET pending=0 WHERE id=? AND hash=?').run(o.id,o.hash);this.local.db.prepare('DELETE FROM private_markets_match_pending WHERE id=? AND hash=?').run(o.id,o.hash);}}
 preparePreview(){
  if(!this.capture)return;
  const model=this.model(privateMarketsSlot(this.now(),{next:true}));
  const messages=intelligenceEmails(model,{dashboardUrl:this.local.schedule.dashboardUrl()});
  this.local.db.prepare("DELETE FROM newsletter_views WHERE id LIKE 'preview-private-markets-%'").run();
  for(const message of messages)this.saveView(`preview-private-markets-html-${message.part}`,{ok:true,...message,builtAt:model.builtAt});
 }
 async wake() {
  const now=this.now(),slot=privateMarketsSlot(now),meta=this.meta();
  // Launching midweek never sends an earlier Monday's edition retrospectively.
  const launch=Date.parse(meta.activatedAt||iso(now)),eligible=slot.at>=launch;
  for(const row of this.local.db.prepare("SELECT plan FROM private_markets_editions WHERE state='pending' AND key != ? ORDER BY at LIMIT 4").all(slot.key))await this.run(JSON.parse(gunzipSync(row.plan,{maxOutputLength:32*1024*1024})));
  const existing=this.local.db.prepare('SELECT state,plan FROM private_markets_editions WHERE key=?').get(slot.key);
  if(existing){if(existing.state==='pending'){const plan=JSON.parse(gunzipSync(existing.plan,{maxOutputLength:32*1024*1024}));await this.run(plan);}return;}
  if(!eligible)return;
  if(now-slot.at>3*3600000){this.runResult='missed';this.savePlan({...slot,recipients:[]},'missed');this.setMeta({...this.meta(),lastResult:'missed'});return;}
  await this.prepare({force:true});if(!this.capture){this.runResult='funding-source-unavailable';this.setMeta({...this.meta(),lastResult:'funding-source-unavailable'});return;}
  // A failed protected source does not become a false zero-investments section.
  const model=this.model(slot);
  // An unavailable directory never consumes the chance to report fund matches.
  if(!model.roster.ok)for(const row of model.rows)for(const o of row.observations)this.local.db.prepare('INSERT OR REPLACE INTO private_markets_match_pending VALUES(?,?)').run(o.id,o.hash);
  const messages=intelligenceEmails(model,{dashboardUrl:this.local.schedule.dashboardUrl()});
  await this.refreshInputs();
  const recipients=this.local.store.subscriberRows().map(r=>({email:r.email,parts:messages.map(m=>({part:m.part,messageId:`<private-markets.${crypto.randomUUID()}@${new URL(this.local.schedule.dashboardUrl()).hostname}>`,state:'pending',attempts:0,nextAt:now}))}));
  const plan={...slot,recipients,messages,parts:messages.length,rosterVerified:model.roster.ok===true};this.savePlan(plan,'pending');await this.publish();await this.run(plan);
 }
 async run(plan) {
  const token=this.local.schedule.env.MUNS_TOKEN, credentialHash=token?createHash('sha256').update(token).digest('hex'):null;
  if(Date.parse(this.meta().mailCooldownUntil||'')>this.now()||credentialHash&&this.meta().blockedCredential===credentialHash)return;
  for(const recipient of plan.recipients){
   for(const part of recipient.parts)if(part.state==='sending'){part.state='uncertain';this.quarantine(plan,part);}
   await this.refreshInputs();
   if(!this.local.store.subscriberRows().some(r=>r.email===recipient.email)){for(const part of recipient.parts)if(part.state==='pending')part.state='removed';continue;}
   for(const part of recipient.parts){
    if(part.state==='accepted')continue;
    if(part.state!=='pending'){for(const later of recipient.parts)if(later.part>part.part&&later.state==='pending')later.state='blocked';break;}
    if(part.nextAt>this.now())break;
    if(!this.local.schedule.env.MUNS_TOKEN){part.reason='no-token';if(this.now()-plan.at>3*3600000)part.state='refused';break;}
    const root=recipient.parts[0],message=plan.messages[part.part-1];
    if(part.part>1&&root.state!=='accepted')break;
    // Persist intent before I/O. An interrupted or uncertain send is never replayed.
    part.state='sending';part.attempts++;this.savePlan(plan,'pending');await this.publish();
    await this.refreshInputs();
    if(!this.local.store.subscriberRows().some(r=>r.email===recipient.email)){part.state='removed';this.savePlan(plan,'pending');await this.publish();break;}
    const result=await sendEmail({fetcher:this.fetcher,token:this.local.schedule.env.MUNS_TOKEN,email:recipient.email,subject:message.subject,html:message.html,messageId:part.messageId,inReplyTo:part.part===1?null:root.acceptedMessageId||root.messageId});
    part.reason=result.reason;part.status=result.status;part.state=result.ok?'accepted':result.reason==='rate-limited'&&part.attempts<3?'pending':result.status!==null?'refused':'uncertain';
    part.nextAt=this.now()+30*60000*part.attempts;
    if(part.state==='uncertain')this.quarantine(plan,part);
    if(result.reason==='rate-limited')this.setMeta({...this.meta(),mailCooldownUntil:iso(part.nextAt),lastResult:'sender-cooldown'});
    if(result.ok){part.acceptedMessageId=result.messageId;for(const o of message.observations){this.local.db.prepare('UPDATE private_markets_seen SET pending=0 WHERE id=? AND hash=?').run(o.id,o.hash);if(plan.rosterVerified)this.local.db.prepare('DELETE FROM private_markets_match_pending WHERE id=? AND hash=?').run(o.id,o.hash);}}
    this.savePlan(plan,'pending');await this.publish();await this.sleep(1000);
    if(!result.ok){
     this.runResult=result.reason==='unauthorised'?'sender-unavailable':part.state==='uncertain'?'delivery-uncertain':result.reason==='rate-limited'?'sender-cooldown':'delivery-failed';
     if(result.reason==='unauthorised')this.setMeta({...this.meta(),blockedCredential:credentialHash,lastResult:'sender-unavailable'});
     else if(result.reason!=='rate-limited')this.setMeta({...this.meta(),mailCooldownUntil:iso(this.now()+30*60000),lastResult:part.state==='uncertain'?'delivery-uncertain':'delivery-failed'});
     this.saveView('private-markets-status',this.status());await this.publish();return;
    }
   }
  }
  const unfinished=plan.recipients.some(r=>r.parts.some(p=>p.state==='pending'||p.state==='sending'));
  const uncertain=plan.recipients.some(r=>r.parts.some(p=>p.state==='sending'||p.state==='uncertain'));
  const failed=plan.recipients.some(r=>r.parts.some(p=>p.state==='refused'));
  // A restored 'sending' intent needs operator evidence, not another mail request.
  this.savePlan(plan,unfinished?'pending':uncertain?'uncertain':failed?'failed':plan.recipients.length?'sent':'no-recipients');
  this.runResult=uncertain?'delivery-uncertain':failed?'delivery-failed':null;
  this.setMeta({...this.meta(),lastResult:uncertain?'delivery-uncertain':unfinished?'delivery-pending':failed?'delivery-failed':plan.recipients.length?'sent':'no-recipients'});
  this.saveView('private-markets-status',this.status());await this.publish();
 }
}
