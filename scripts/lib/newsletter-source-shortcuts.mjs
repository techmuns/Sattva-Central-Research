import {randomUUID,createHmac} from 'node:crypto';
import {briefStats} from '../../worker/newsletter-brief.mjs';
import {editorialEvents} from '../../worker/newsletter-editorial.mjs';
import {sourceId,sourceTarget,SOURCE_LINK_FORMAT,SOURCE_LOOKUP_BATCH_SIZE,SOURCE_INDEX_FORMAT,SOURCE_PAGE_BYTES,SOURCE_RECORD_BYTES,SOURCE_DIRECTORY_BYTES} from '../../worker/newsletter-source-shortcuts.mjs';
import {privateRecordBucket} from '../../worker/github-private-records.mjs';

export function newsletterSourceViews(records,{repo,env=process.env}={}) {
  if(typeof env.BACKGROUND_STATE_KEY!=='string'||env.BACKGROUND_STATE_KEY.length<20)throw Error('Source index key unavailable');
  const groups=new Map(),views=[],directory={format:SOURCE_INDEX_FORMAT,buckets:{}};
  for(const [id,value]of records){
    if(!id.startsWith('source-'))continue;
    if(!sourceId(id.slice(7))||!sourceTarget(value))throw Error('Invalid retained source index record');
    const bucket=privateRecordBucket(id);if(!groups.has(bucket))groups.set(bucket,[]);groups.get(bucket).push(id);
  }
  for(const [bucket,ids]of groups){
    const label=createHmac('sha256',env.BACKGROUND_STATE_KEY).update(`${repo}:newsletter-source-index:${bucket}:v1`).digest('hex');
    const indexName=`sources-index-${label}.json`,pages=[];directory.buckets[bucket]=indexName;
    let page=Object.create(null),bytes=2,first=null,last=null;
    const flush=()=>{
      if(!first)return;
      const name=`sources-page-${label}-${pages.length}.json`;
      pages.push({first,last,name});views.push({name,value:{version:1,records:page},maxBytes:SOURCE_RECORD_BYTES+1024});
      page=Object.create(null);bytes=2;first=null;
    };
    for(const id of ids.sort()){
      const value=records.get(id),size=Buffer.byteLength(JSON.stringify({[id]:value}));
      if(size>SOURCE_RECORD_BYTES)throw Error('Source index record exceeds delivery budget');
      if(first&&bytes+size>SOURCE_PAGE_BYTES)flush();
      first??=id;last=id;page[id]=value;bytes+=size;
    }
    flush();const index={version:1,pages};
    if(Buffer.byteLength(JSON.stringify(index))>SOURCE_DIRECTORY_BYTES)throw Error('Source directory exceeds delivery budget');
    views.push({name:indexName,value:index,maxBytes:SOURCE_DIRECTORY_BYTES});
  }
  return {directory,views};
}

// This is retained alongside edition PDFs, never in the replaceable preview namespace.
// INSERT only: an emailed identifier must always resolve to the same captured source.
export function newsletterSourceShortcuts(db,origin,{now=Date.now}={}) {
  const links=new Map(),records=new Map();
  for(const row of db.prepare("SELECT id,payload FROM newsletter_views WHERE id LIKE 'source-%'").all()){
    const id=row.id.slice(7),record=JSON.parse(row.payload),target=sourceTarget(record);
    if(!sourceId(id)||!target)throw Error('Invalid retained source shortcut');
    records.set(id,record);if(!links.has(target))links.set(target,`${origin}/api/newsletter/s/${id}`);
  }
  const register=original=>{
    if(!original||original.length<=160||links.has(original))return links.get(original)||original;
    const record={format:SOURCE_LINK_FORMAT,url:original,createdAt:new Date(now()).toISOString()};
    if(!sourceTarget(record))throw Error('Invalid source shortcut destination');
    const id=randomUUID(),alias=`${origin}/api/newsletter/s/${id}`;
    if(alias.length>=original.length)return original;
    db.prepare('INSERT INTO newsletter_views(id,payload) VALUES(?,?)').run('source-'+id,JSON.stringify(record));
    records.set(id,record);links.set(original,alias);return alias;
  };
  return {links,register,record:id=>records.get(id),prepare(brief){
    for(const event of editorialEvents(brief,briefStats(brief).companies).events)for(const url of event.sources)register(url);
  }};
}

// Verify deployed routing and every exact immutable destination before provider I/O.
export function sourcePublicationVerifier(origin,{fetcher=fetch,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),timeout=12*60000}={}) {
  const verified=new Map();
  return async links=>{
    const pending=links.filter(({id,url})=>verified.get(id)!==url),deadline=now()+timeout;
    for(let offset=0;offset<pending.length;offset+=SOURCE_LOOKUP_BATCH_SIZE){
      const batch=pending.slice(offset,offset+SOURCE_LOOKUP_BATCH_SIZE);
      for(;;){
        try{
          const response=await fetcher(`${origin}/api/newsletter/sources?ids=${batch.map(r=>r.id).join(',')}`,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});
          if(response.ok){
            const value=await response.json();
            if(value?.ok===true&&value.format===SOURCE_LINK_FORMAT&&value.lookupFormat===SOURCE_INDEX_FORMAT&&Array.isArray(value.links)&&value.links.length===batch.length&&batch.every(expected=>value.links.some(actual=>actual.id===expected.id&&actual.url===expected.url))){
              for(const {id,url} of batch)verified.set(id,url);break;
            }
          }else await response.body?.cancel();
        }catch{/* A static deployment may still be publishing these immutable records. */}
        if(now()>=deadline)throw Error('Exact source links were not published; email was not sent');
        await sleep(Math.min(15000,Math.max(0,deadline-now())));
      }
    }
  };
}
