import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {newsletterRequest,beginNewsletterRequest,NEWSLETTER_DEADLINE} from '../worker/newsletter-request.mjs';
import {sendEmail,SEND_TIMEOUT_MS} from '../worker/newsletter-schedule.mjs';
let io=0;
const deferred=async(url,options)=>{
 await delay(80);
 assert.equal(options.signal.aborted,true,'The original transport timer expires during a slow checkpoint');
 const request=beginNewsletterRequest(options);assert.equal(request.signal.aborted,false);assert.equal(request[NEWSLETTER_DEADLINE],undefined);
 io++;return Response.json({ok:true});
};
assert.equal((await newsletterRequest(deferred,'https://fixture.test',{},50)).status,200);assert.equal(io,1);
const controller=new AbortController();
await assert.rejects(newsletterRequest(async(url,options)=>{controller.abort(new DOMException('Cancelled during checkpoint','AbortError'));beginNewsletterRequest(options);io++;},'https://fixture.test',{signal:controller.signal},50),error=>error.name==='AbortError');assert.equal(io,1);
const email=await sendEmail({token:'fixture-only',email:'fixture@example.com',subject:'Fixture',text:'Fixture',fetcher:async(url,options)=>{
 assert.equal(options[NEWSLETTER_DEADLINE].timeoutMs,SEND_TIMEOUT_MS);
 options.signal=AbortSignal.abort(new DOMException('Checkpoint exhausted the old timer','TimeoutError'));
 const request=beginNewsletterRequest(options);assert.equal(request.signal.aborted,false);assert.equal(request.headers.authorization,'Bearer fixture-only');
 return Response.json({success:true,data:{messageId:'<fixture@example.test>'}});
}});assert.equal(email.ok,true);assert.equal(email.messageId,'<fixture@example.test>');
console.log('PASS newsletter deadlines: checkpoint delay does not consume the provider timeout, caller cancellation survives renewal, original mail timeout and payload preserved');
