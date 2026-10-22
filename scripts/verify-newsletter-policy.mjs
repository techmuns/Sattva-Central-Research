// Incident regressions: no historical replay, no email flood, safe frozen-queue recovery.
// Fixtures only; no external email, source, model or production state access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {buildBrief,briefStories,sourcesNote} from '../worker/newsletter-brief.mjs';
import {newsletterDeliveryPolicy,MAX_DELIVERY_EMAIL_PARTS} from '../worker/newsletter-email.mjs';
import {NewsletterDeliveryQueue} from './lib/newsletter-delivery-queue.mjs';
import {localNewsletter} from './lib/newsletter-local.mjs';
import {DEFAULT_SETTINGS,editionWindow,istInstant} from '../public/js/data/newsletter-shared.js';

const day='2026-10-22',now=istInstant(day,'08:00'),window=editionWindow('morning',day,DEFAULT_SETTINGS);
const book=JSON.parse(readFileSync(new URL('./fixtures/newsletter/book.json',import.meta.url)));
const holding=book.holdings.find(h=>h.ticker),articles=[
  ...Array.from({length:2584},(_,i)=>({title:`${holding.name} old contract ${i}`,publishedAt:'2026-10-15T12:00:00Z',url:`https://fixture.test/old/${i}`,publisher:'Fixture'})),
  {title:`${holding.name} new order`,publishedAt:new Date(window.from).toISOString(),url:'https://fixture.test/current',publisher:'Fixture'},
  {title:`${holding.name} future order`,publishedAt:new Date(window.to).toISOString(),url:'https://fixture.test/future',publisher:'Fixture'},
];
const captures={'/data/portfolio-companies.json':book,'/data/market-news.json':{articles,capturedAt:new Date(now).toISOString()}};
const before=JSON.stringify(captures);
const env={MUNS_TOKEN:'fixture-only',ASSETS:{fetch:async request=>{
  const value=captures[new URL(request.url).pathname];return value?Response.json(value):new Response(null,{status:404});
}}};
for(const reported of [null,{empty:true,has:()=>false},{empty:false,since:now-10*86400000,has:()=>false}]){
  const brief=await buildBrief({edition:'morning',day,settings:DEFAULT_SETTINGS,env,now,reported,includeAi:false,fetcher:async()=>new Response(null,{status:503})});
  const stories=briefStories(brief);
  assert.equal(stories.length,1,'2,584 freshly captured old reports cannot enter today’s email');
  assert.equal(stories[0].url,'https://fixture.test/current');
  assert.equal(brief.lateFrom,null);
  assert(!sourcesNote(brief).includes('reach the next brief'),'Coverage notes must not promise historical email catch-up');
  assert(stories.every(s=>s.at>=window.from&&s.at<window.to&&!s.late));
}
assert.equal(JSON.stringify(captures),before,'All archived source records survive unchanged');
assert.equal(newsletterDeliveryPolicy({partCount:MAX_DELIVERY_EMAIL_PARTS}),null);
assert.equal(newsletterDeliveryPolicy({partCount:7}),'email-part-limit');
assert.equal(newsletterDeliveryPolicy({partCount:86}),'email-part-limit');
assert.equal(newsletterDeliveryPolicy({partCount:2,lateCount:1}),'historical-backlog-stopped');

for(const [count,late,expected,age=0,oldPublished=false,priceContext=false]of [[86,2584,'historical-backlog-stopped'],[7,0,'email-part-limit'],[2,1,'historical-backlog-stopped'],[2,0,'historical-backlog-stopped',0,true],[2,0,'edition-expired',4*3600000],[2,0,null,0,false,true],[2,0,null]]){
  let mail=0,published=0;
  const local=localNewsletter(':memory:',{env,now:()=>now,fetcher:async()=>{mail++;return Response.json({success:true,data:{messageId:'<fixture@fixture.test>'}});}});
  try{
    const email='fixture@example.test',key=`${day}:morning`;
    local.store.apply([{op:'subscribe',email,by:'Fixture',editions:['morning']}]);
    local.store.beginDelivery({key,edition:'morning',day,scheduledAt:now,source:'timer',recipients:1});
    const documentId=local.store.saveDocument(new TextEncoder().encode('%PDF fixture evidence'),'fixture.pdf',key);
    const queue=new NewsletterDeliveryQueue(local,{publish:async()=>{published++;},now:()=>now+age,context:async(_plan,work)=>work()});
    const parts=Array.from({length:count},(_,i)=>({part:i+1,total:count,bytes:4,subject:'Fixture edition',requestedMessageId:`<fixture-${i}@fixture.test>`,ok:i===0,status:i===0?201:null,reason:i===0?null:'not-attempted',attempts:i===0?1:0}));
    const plan={key,edition:'morning',source:'timer',documentId,createdAt:now,nextAt:now,windowFrom:window.from,summary:{late},subject:'Fixture edition',
      priceSession:priceContext?'2026-10-21':null,
      messages:parts.map((_,i)=>({keys:[priceContext?`move:FIXTURE${i}|2026-10-21`:`fixture:${i}`]})),reported:parts.map((_,i)=>({key:priceContext?`move:FIXTURE${i}|2026-10-21`:`fixture:${i}`,publishedAt:priceContext?istInstant('2026-10-21','15:30'):window.from+i-(oldPublished?86400000:0)})),
      recipients:[{email,ok:false,reason:'partial-send',threadMessageId:'<fixture-0@fixture.test>',parts}]};
    local.db.prepare('INSERT INTO newsletter_delivery_queue(key,edition,source,next_at,payload) VALUES(?,?,?,?,?)').run(key,'morning','timer',now,gzipSync(JSON.stringify(plan)));
    for(const part of parts)local.db.prepare('INSERT INTO newsletter_delivery_bodies VALUES(?,?,?,?)').run(key,email,part.part,'body');
    const result=await queue.run(plan);
    assert.equal(result.reason,expected);
    assert.equal(mail,expected?0:1,'Policy is checked before any provider submission; bounded current plans resume normally');
    assert.equal(queue.pending().length,0);
    assert(published>0,'Cancellation is retained before returning');
    assert.equal(local.store.delivery(key).outcomes[0].parts[0].ok,true,'Prior acceptance is preserved');
    assert(local.store.document(documentId),'Existing PDF links survive');
    assert.notEqual(local.db.prepare('SELECT delivery_state FROM newsletter_documents WHERE id=?').get(documentId).delivery_state,'pending','A stopped PDF cannot block later sends as an unfinished publication');
    if(expected)assert.equal(local.db.prepare('SELECT COUNT(*) n FROM newsletter_delivery_bodies').get().n,count,'Stopped frozen bodies remain incident evidence');
    const restarted=new NewsletterDeliveryQueue(local,{publish:async()=>{},now:()=>now,context:async(_plan,work)=>work()});
    assert.deepEqual(await restarted.recover(),[],'A stopped edition cannot replay after recovery restarts');
  }finally{await local.close();}
}

// A newly built oversized edition must fail as a whole before its first email or PDF is saved.
const oversized=structuredClone(captures);
oversized['/data/market-news.json'].articles=Array.from({length:220},(_,i)=>({
  title:`${holding.name} distinct order number ${i}`,publishedAt:new Date(window.from+i).toISOString(),
  url:`https://fixture.test/current/${i}`,publisher:'Fixture',summary:'Distinct terms of this specific order. '.repeat(150),
}));
let sends=0;
const large=localNewsletter(':memory:',{env:{...env,ASSETS:{fetch:async request=>{
  const value=oversized[new URL(request.url).pathname];return value?Response.json(value):new Response(null,{status:404});
}}},now:()=>now,fetcher:async(raw)=>{if(String(raw).includes('/email/send/'))sends++;return new Response(null,{status:503});}});
try{
  const result=await large.schedule.deliver({edition:'morning',day,at:now,key:'large-edition',source:'timer',now,includeAi:false,recipients:[{email:'fixture@example.test'}]});
  assert.equal(result.reason,'email-part-limit');
  assert.equal(sends,0);
  assert.equal(large.db.prepare('SELECT COUNT(*) n FROM newsletter_documents').get().n,0);
  assert.equal(large.store.reportedCount(),0,'Refusing delivery does not mark unsent updates delivered');
}finally{await large.close();}
console.log('PASS newsletter policy: strict publication window, 2,584 old reports excluded, six-part delivery ceiling, frozen backlog stopped, receipts/history preserved, restart cannot replay, normal recovery retained');
