import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {BREAKOUT_ORIGIN,BREAKOUT_LIMIT,validateQuote} from '../../public/js/data/breakout-live-shared.js';

// Read already collected public quotes only. The GitHub newsletter runner has
// no capture database, and this route must acknowledge GitHub delivery.
export function newsletterQuotes({fetcher=fetch,now=Date.now}={}){
 return {read:async()=>{
  const response=await fetcher(`${BREAKOUT_ORIGIN}/api/breakouts`,{method:'GET',headers:{accept:'application/json'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();throw Error('Prepared newsletter quotes unavailable');}
  const value=await boundedJson(response,8*1024*1024);
  if(value?.runtime!=='github-actions'||!['static-assets','github-prepared','github-release'].includes(value.delivery)||!Array.isArray(value.rows)||value.rows.length>BREAKOUT_LIMIT)throw Error('Newsletter quotes require prepared GitHub delivery');
  return {...value,rows:value.rows.map(row=>validateQuote(row,now()))};
 }};
}
