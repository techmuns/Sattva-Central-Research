import {createHmac} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {privateRecordBucket} from '../../worker/github-private-records.mjs';
// The directory travels INSIDE encrypted head.json. Keyed page names reveal no
// enumerable source IDs or private portfolio membership in the public package.
export async function* privateRecordViews(ids,read,head,{repo,feature,env=process.env,partBytes=4*1024*1024,recordBytes=partBytes}={}) {
  if(typeof env.BACKGROUND_STATE_KEY!=='string'||env.BACKGROUND_STATE_KEY.length<20||!Number.isSafeInteger(partBytes)||partBytes<1||partBytes>4*1024*1024||!Number.isSafeInteger(recordBytes)||recordBytes<partBytes||recordBytes>4*1024*1024)throw Error('Private record configuration unavailable');
  const groups=new Map(),parts={};
  for(const id of ids){if(typeof id!=='string'||id.length>128||!id.length)throw Error('Invalid private record ID');const bucket=privateRecordBucket(id);if(!groups.has(bucket))groups.set(bucket,[]);groups.get(bucket).push(id);}
  for(const [bucket,identities] of groups) {
    const label=createHmac('sha256',env.BACKGROUND_STATE_KEY).update(`${repo}:${feature}:private-bucket:${bucket}`).digest('hex');parts[bucket]=[];
    let page=Object.create(null),bytes=2,first=null,last=null;
    const entry=()=>{const name=`page-${label}-${parts[bucket].length}.json`;parts[bucket].push({first,last,name});return {name,value:page};};
    for(const id of [...new Set(identities)].sort()) {
      const value=await read(id);if(value==null)throw Error('Retained private record missing');
      const record={gzip:gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')},size=Buffer.byteLength(JSON.stringify({[id]:record}));
      if(size>recordBytes)throw Error('Private source record exceeds delivery budget');
      if(first&&bytes+size>partBytes){yield entry();page=Object.create(null);bytes=2;first=null;}
      first??=id;last=id;page[id]=record;bytes+=size;
    }
    if(first)yield entry();
  }
  yield {name:'head.json',value:{...head,parts}};
}
