import {readBackgroundView} from './github-background-views.mjs';
import {decode64} from './mutual-funds-seal.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
export const privateRecordBucket=id=>[...id].reduce((value,char)=>(value*31+char.charCodeAt(0))>>>0,0)%64;
// Call only AFTER the existing feature-specific reader authorization. The memo
// belongs to this request and holds at most two decrypted chunks.
export async function readPrivateRecord(env,origin,feature,head,id,{memo=new Map(),maxBytes=5*1024*1024}={}) {
  const directory=head.parts?.[String(privateRecordBucket(id))]||[],page=directory.find(part=>id>=part.first&&id<=part.last);
  if(!page)return null;
  let records=memo.get(page.name);
  if(!records){records=await readBackgroundView(env,origin,feature,page.name);if(!records)throw Error('Prepared record page missing');if(memo.size>=2)memo.clear();memo.set(page.name,records);}
  const record=records[id];if(!record)return null;
  if(typeof record.gzip!=='string'||record.gzip.length>7*1024*1024)throw Error('Invalid prepared record');
  return boundedJson(new Response(new Response(decode64(record.gzip)).body.pipeThrough(new DecompressionStream('gzip'))),maxBytes);
}
