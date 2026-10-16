import assert from 'node:assert/strict';
import {newsletterQuotes} from './lib/newsletter-quotes.mjs';
import {readSessionQuotes,readPerformance} from '../worker/newsletter-brief.mjs';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
const at=Date.parse('2026-10-16T10:05:00Z'),holdings=[{ticker:'SBIN',name:'State Bank of India'}];
const row={ticker:'SBIN',price:102,prevClose:100,volume:1000,provider:'Upstox',exchange:'NSE',quoteAt:'2026-10-16T10:00:00Z',checkedAt:'2026-10-16T10:05:00Z',sessionDate:'2026-10-16'};
let payload={runtime:'github-actions',delivery:'github-prepared',rows:[row]},calls=0;
const reader=newsletterQuotes({now:()=>at,fetcher:async(url,options)=>{
 calls++;assert.equal(url,`${BREAKOUT_ORIGIN}/api/breakouts`);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.deepEqual(Object.keys(options.headers),['accept']);
 return Response.json(payload);
}});
const env={NEWSLETTER_QUOTES:reader,CAPTURE_REGISTRY:{getByName(){throw Error('Prepared readers must not touch the old capture database');}},ASSETS:{fetch:async()=>new Response(null,{status:404})}};
const read=()=>readSessionQuotes({env,now:at,edition:'evening',holdings});
for(const delivery of ['static-assets','github-prepared','github-release']){
 payload={...payload,delivery};const quotes=await read();assert.equal(quotes.state,'capture');assert.equal(quotes.rows[0].last,102);assert.equal(quotes.rows[0].pct,2);assert.equal((await readPerformance({quotes,holdings})).quoted,1);
}
assert.equal(calls,3);
payload={...payload,rows:[{...row,sessionDate:'2026-10-15',quoteAt:'2026-10-15T10:00:00Z',checkedAt:'2026-10-15T10:05:00Z'}]};assert.equal((await read()).state,'unavailable','A valid retained quote from a different session is not current');
payload={...payload,runtime:'cloudflare',rows:[row]};await assert.rejects(reader.read(),/GitHub delivery/);assert.equal((await read()).state,'unavailable');
payload={runtime:'github-actions',delivery:'github-prepared',rows:[{...row,price:-1}]};await assert.rejects(reader.read(),/market observation/);
const refused=newsletterQuotes({fetcher:async()=>new Response(null,{status:302,headers:{location:'https://untrusted.test'}})});await assert.rejects(refused.read(),/unavailable/);
console.log('PASS newsletter prepared quotes: fixed read-only GET without credentials, GitHub delivery required, original price/return arithmetic, prior session unavailable, invalid quotes and redirects refused, no Cloudflare capture storage');
