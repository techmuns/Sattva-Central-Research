// Automatic snapshot disposal must not start a new compatibility read.
import assert from 'node:assert/strict';
const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
globalThis.document=Object.assign(new EventTarget(),{visibilityState:'visible',hidden:false});
globalThis.window=Object.assign(new EventTarget(),{innerWidth:1280});
const wait=()=>new Promise(done=>setTimeout(done,1));
const now=Date.now(),iso=new Date(now).toISOString(),day=new Date(now+19800000).toISOString().slice(0,10);
const capture={version:1,state:'complete',targets:['TEST'],failures:[],rows:[{ticker:'TEST',price:102,prevClose:100,volume:1000,provider:'Upstox',exchange:'NSE',quoteAt:iso,checkedAt:iso,sessionDate:day}]};
try{
 for(const mode of ['disposed','shared','explicit']){
  let release,compatibility=0,notices=0;
  globalThis.fetch=async path=>{
   if(path==='/api/breakouts/snapshot')return new Promise(done=>{release=()=>done(Response.json({format:'invalid'}));});
   assert.equal(path,'/api/breakouts');compatibility++;return Response.json(capture);
  };
  const live=await import(`../public/js/data/breakout-live.js?watcher-fixture=${mode}`);
  const stop=live.watch(()=>{}),other=mode==='shared'?live.watch(()=>{notices++;}):()=>{};
  for(let i=0;!release&&i<1000;i++)await wait();assert(release,'Opening snapshot starts');
  const explicit=mode==='explicit'?live.refresh():null;
  stop();stop(); // Disposal is idempotent and cannot remove another reader's ownership.
  release();
  if(explicit)await explicit;
  else for(let i=0;i<20;i++)await wait();
  assert.equal(compatibility,mode==='disposed'?0:1,mode==='disposed'?'Leaving the last view prevents a late fallback':'A remaining reader or explicit refresh keeps the shared check');
  if(mode==='shared'){assert.equal(live.quote('TEST').price,102);assert(notices>0);}
  if(mode==='explicit')assert.equal(live.quote('TEST').price,102);
  other();
 }
 console.log('PASS CMP ownership: no compatibility read after disposal, idempotent cleanup, remaining readers and explicit refreshes retain shared work');
}finally{Object.assign(globalThis,previous);}
