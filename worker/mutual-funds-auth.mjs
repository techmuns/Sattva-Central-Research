import {readProfile} from './concall-summary-auth.mjs';
import {callerToken} from './muns.mjs';

// An MF-only reader list must never grant access to private Screener documents.
// Identity always comes from Munshot's verified profile, not browser/JWT claims.
export async function authoriseMutualFundsReader(request,env,{fetcher=fetch}={}) {
  const token=callerToken(request);if(!token)return {ok:false,reason:'no-session'};
  let reader;try{reader=await readProfile(token,fetcher);}catch{return {ok:false,reason:'identity-unavailable'};}
  const emails=value=>String(value||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  const additional=emails(env.MF_SCANNER_READER_EMAILS);
  if(additional.includes(reader))return {ok:true};
  const existing=emails(env.SCREENER_SUMMARY_READER_EMAILS);
  if(existing.length)return {ok:existing.includes(reader),reason:'access'};
  if(!env.MUNS_TOKEN)return {ok:false,reason:additional.length?'access':'configuration-unavailable'};
  try{return {ok:reader===await readProfile(env.MUNS_TOKEN,fetcher),reason:'access'};}
  catch{return {ok:false,reason:'configuration-unavailable'};}
}
