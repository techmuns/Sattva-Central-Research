import {createHash} from 'node:crypto';
const KEY='github-upstox-request-budget:v1',WINDOW=30*60000;
// One account budget shared by minute quotes, history fallback and private level
// checks. Deliberately below Upstox's standard 50/s, 500/min, 2,000/30min limits.
export function upstoxBudget({storage,token,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms))}){
  const fingerprint=createHash('sha256').update(token||'').digest('hex');let tail=Promise.resolve();
  const held=(reason,until)=>new Response(null,{status:reason==='authentication'?401:429,headers:{'retry-after':String(Math.max(1,Math.ceil((until-now())/1000)))}});
  async function request(url,options){
    const store=typeof storage==='function'?storage():storage;if(!store)throw Error('Quote request budget unavailable');
    let at=now(),state=await store.get(KEY)||{},attempts=(state.attempts||[]).filter(value=>Number.isFinite(value)&&value>at-WINDOW);
    if(state.token!==fingerprint&&state.reason==='authentication')state={...state,holdUntil:0,reason:null};
    if(state.holdUntil>at)return held(state.reason,state.holdUntil);
    const minute=attempts.filter(value=>value>at-60000),quote=new URL(url).pathname.includes('/market-quote/');
    // Historical backfill cannot consume the capacity reserved for live prices.
    const minuteLimit=quote?60:50,windowLimit=quote?900:600;
    if(attempts.length>=windowLimit||minute.length>=minuteLimit){const until=Math.max(attempts.length>=windowLimit?attempts[0]+WINDOW:0,minute.length>=minuteLimit?minute[0]+60000:0);return held('rate-limited',until);}
    const spacing=200-(at-(attempts.at(-1)||0));if(spacing>0)await sleep(spacing);at=now();
    state={...state,token:fingerprint,attempts:[...attempts,at],holdUntil:0,reason:null};await store.put(KEY,state);
    const response=await fetcher(url,options);
    if([401,403,429].includes(response.status)){
      const retry=response.headers.get('retry-after'),requested=/^\d+$/.test(retry||'')?now()+Number(retry)*1000:Date.parse(retry||'');
      const reason=response.status===429?'rate-limited':'authentication';
      const strikes=reason==='rate-limited'?(state.strikes||0)+1:0;
      state={...state,reason,strikes,holdUntil:Math.max(now()+(reason==='authentication'?3600000:Math.min(30*60000,60000*2**Math.min(strikes-1,5))),Number.isFinite(requested)?requested:0)};
      await store.put(KEY,state);
    }else if(response.ok&&state.strikes)await store.put(KEY,{...state,strikes:0});
    return response;
  }
  return (url,options={})=>{
    if(new URL(url).hostname!=='api.upstox.com')return fetcher(url,options);
    const work=tail.then(()=>request(url,options));tail=work.then(()=>{},()=>{});return work;
  };
}
