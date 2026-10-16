// Request deadlines cover provider I/O, after the GitHub runner has saved its
// claim and verified any public PDF. Caller cancellation remains authoritative.
export const NEWSLETTER_DEADLINE=Symbol.for('research.newsletter.request-deadline.v1');
const valid=ms=>Number.isSafeInteger(ms)&&ms>0&&ms<=300000;
function signalFor({timeoutMs,callerSignal}){
 if(!valid(timeoutMs))throw Error('Invalid newsletter request timeout');
 callerSignal?.throwIfAborted();
 const deadline=AbortSignal.timeout(timeoutMs);
 return callerSignal?AbortSignal.any([callerSignal,deadline]):deadline;
}
export function newsletterRequest(fetcher,url,options,timeoutMs){
 const descriptor={timeoutMs,callerSignal:options?.signal||null};
 return fetcher(url,{...options,[NEWSLETTER_DEADLINE]:descriptor,signal:signalFor(descriptor)});
}
export function newsletterCallerSignal(options){
 return options?.[NEWSLETTER_DEADLINE]?options[NEWSLETTER_DEADLINE].callerSignal:options?.signal;
}
export function beginNewsletterRequest(options){
 const descriptor=options?.[NEWSLETTER_DEADLINE];if(!descriptor)return options;
 const request={...options,signal:signalFor(descriptor)};delete request[NEWSLETTER_DEADLINE];return request;
}
