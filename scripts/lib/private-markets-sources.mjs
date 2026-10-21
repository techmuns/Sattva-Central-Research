import {privateMarketRelease} from './private-market-release.mjs';
import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {validRoster} from './private-markets-intelligence.mjs';
const FAMILY='https://sattva-family.pages.dev/api/research-holdings?include=funds';
export async function privateMarketsSources({env=process.env,fetcher=fetch}={}) {
 const transport=privateMarketRelease({env,fetcher}),latest=await transport.latest();
 if(!latest)throw Error('Funding release unavailable');
 const capture=await transport.download(latest);
 let roster;
 try{
  if(typeof env.FAMILY_HOLDINGS_TOKEN!=='string'||env.FAMILY_HOLDINGS_TOKEN.length<32)throw Error('Fund reader not configured');
  const response=await fetcher(FAMILY,{headers:{authorization:`Bearer ${env.FAMILY_HOLDINGS_TOKEN}`,accept:'application/json'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});
  roster=validRoster(await boundedJson(response,512*1024));
 }catch{roster={ok:false,reason:'The protected Family fund directory could not be read.'};}
 return {capture,roster};
}
