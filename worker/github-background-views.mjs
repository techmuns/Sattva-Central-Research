import {boundedJson} from '../public/js/data/family-book-contract.js';
import {openForReader,decode64,hash} from './mutual-funds-seal.mjs';
import {mfRepo} from './mutual-funds-github.mjs';
const address=(repo,feature,name)=>`${repo}:github-prepared:${feature}:${name}:v1`;
// Prepared encrypted files belong to static hosting. Background restart state
// never enters ASSETS. The calling API must authenticate private readers first.
export async function readBackgroundViewBytes(env,origin,feature,name,{maxBytes=5*1024*1024,expectedHash}={}) {
  if(!/^[a-z][a-z0-9-]{1,30}$/.test(feature)||!/^[a-z0-9-]{1,180}\.json$/.test(name)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw Error('Invalid prepared view address');
  if(!env.ASSETS)return null;
  const response=await env.ASSETS.fetch(new Request(new URL(`/generated-views/${feature}/${name}`,origin)));
  if(response.status===404){await response.body?.cancel();return null;}
  const envelope=await boundedJson(response,8*1024*1024);
  if(expectedHash&&await hash(new TextEncoder().encode(JSON.stringify(envelope)))!==expectedHash)throw Error('Prepared file integrity failed');
  const plain=await openForReader(envelope,env.GH_DISPATCH_TOKEN,address(mfRepo(env),feature,name));
  if(plain.byteLength>5*1024*1024)throw Error('Prepared envelope exceeds delivery budget');
  return plain;
}
export async function readBackgroundView(env,origin,feature,name,{maxBytes=5*1024*1024,expectedHash}={}) {
  const plain=await readBackgroundViewBytes(env,origin,feature,name,{maxBytes,expectedHash});
  if(!plain)return null;
  const packed=JSON.parse(new TextDecoder().decode(plain));
  if(packed.format!=='gzip-json'||typeof packed.gzip!=='string'||packed.gzip.length>7*1024*1024)throw Error('Invalid prepared compression');
  return boundedJson(new Response(new Response(decode64(packed.gzip)).body.pipeThrough(new DecompressionStream('gzip'))),maxBytes);
}
