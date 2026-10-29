import {hash} from './mutual-funds-seal.mjs';
import {tagged,revalidate,etagMatches} from './http.mjs';

function generationTag(id) {
  if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid quote generation');
  return `cmp-asset-${id}`;
}
// GitHub asset IDs identify immutable bytes. A matching reader already holds the
// authenticated packet; source freshness still expires in that reader after 304.
export function unchangedPackedBreakouts(request,id) {
  const header=request.headers.get('if-none-match'),tag=generationTag(id);
  if(!header||header.trim()==='*'||!etagMatches(header,`"${tag}"`))return null;
  return revalidate(request,tagged(null,tag,0),'prepared');
}

// The server authenticates/decrypts the fixed current-view envelope. Its existing
// compressed JSON is interpreted by the reader, avoiding large JSON parsing,
// source selection and serialization under the request CPU limit.
export async function packedBreakoutResponse(bytes,request,generation) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>5*1024*1024)throw Error('Invalid packed quote budget');
  return revalidate(request,tagged(bytes,generation===undefined?await hash(bytes):generationTag(generation),0),'prepared');
}
