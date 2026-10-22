import {hash} from './mutual-funds-seal.mjs';
import {tagged,revalidate} from './http.mjs';

// The server authenticates/decrypts the fixed current-view envelope. Its existing
// compressed JSON is interpreted by the reader, avoiding large JSON parsing,
// source selection and serialization under the request CPU limit.
export async function packedBreakoutResponse(bytes,request) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>5*1024*1024)throw Error('Invalid packed quote budget');
  return revalidate(request,tagged(bytes,await hash(bytes),0),'prepared');
}
