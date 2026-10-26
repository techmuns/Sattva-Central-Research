import {readBackgroundView} from './github-background-views.mjs';
import {privateRecordBucket} from './github-private-records.mjs';
import {sourceTarget,SOURCE_INDEX_FORMAT,SOURCE_RECORD_BYTES,SOURCE_DIRECTORY_BYTES,SOURCE_LOOKUP_BATCH_SIZE} from './newsletter-source-shortcuts.mjs';

// Source clicks must never inflate a neighbouring PDF. The head names 64 small
// directories; each directory points to independently bounded source-only pages.
export function newsletterSourceReader(env,origin,head,legacyRead) {
  const memo=new Map();
  const load=async(name,maxBytes)=>{
    if(memo.has(name))return memo.get(name);
    const value=await readBackgroundView(env,origin,'newsletter',name,{maxBytes});
    if(!value)throw Error('Prepared source page missing');
    if(memo.size>=SOURCE_LOOKUP_BATCH_SIZE*2)memo.clear();memo.set(name,value);return value;
  };
  return async id=>{
    if(!head)return null;
    const key='source-'+id,directory=head.sourceLinks;
    if(!directory)return sourceTarget(await legacyRead(key));
    if(directory.format!==SOURCE_INDEX_FORMAT)throw Error('Invalid source directory');
    const bucket=directory.buckets?.[String(privateRecordBucket(key))];
    if(!bucket)return null;
    const index=await load(bucket,SOURCE_DIRECTORY_BYTES);
    if(index.version!==1||!Array.isArray(index.pages))throw Error('Invalid source index');
    const page=index.pages.find(p=>key>=p.first&&key<=p.last);
    if(!page)return null;
    const value=await load(page.name,SOURCE_RECORD_BYTES+1024);
    if(value.version!==1||!value.records)throw Error('Invalid source page');
    return sourceTarget(value.records[key]);
  };
}
