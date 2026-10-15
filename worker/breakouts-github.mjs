import {readBackgroundView} from './github-background-views.mjs';
import {readPrivateRecord} from './github-private-records.mjs';
import {hash} from './mutual-funds-seal.mjs';
import {tickerValid} from '../public/js/data/breakout-live-shared.js';
import {mfRepo} from './mutual-funds-github.mjs';
const recordKey=(kind,value)=>hash(new TextEncoder().encode(`${kind}:${value}`));
const earlier=(row,cursor)=>!cursor||row.at<cursor.at||row.at===cursor.at&&row.run<cursor.run;

// Prepared history retains the source's exact (at, run) cursor semantics. A
// cursor from an older response remains valid after a new minute arrives.
export async function preparedBreakouts(request,env) {
  const head=await readBackgroundView(env,request.url,'breakouts','head.json');if(!head)return null;
  if(head.version!==1||head.repo!==mfRepo(env)||head.feature!=='breakouts'||!head.parts)throw Error('Invalid prepared breakout inventory');
  const memo=new Map(),read=id=>readPrivateRecord(env,request.url,'breakouts',head,id,{memo});
  const url=new URL(request.url);
  if(url.pathname==='/api/breakouts/history') {
    const ticker=url.searchParams.get('ticker'),before=url.searchParams.get('before');if(!tickerValid(ticker))throw Error('Invalid ticker');
    const cursor=before?JSON.parse(before):null;
    if(cursor&&(!Number.isFinite(cursor.at)||!/^\d+:\d+$/.test(cursor.run)))throw Error('Invalid history cursor');
    const index=await read(await recordKey('history',ticker));
    if(!index)return {minuteRetentionDays:4,olderGapTotals:[],rows:[],nextCursor:null};
    const found=[];
    for(const page of index.pages) {
      if(!earlier(page.last,cursor))continue;
      const chunk=await read(page.id);if(!Array.isArray(chunk?.rows))throw Error('Prepared history chunk missing');
      for(const row of chunk.rows)if(earlier(row,cursor)){found.push(row);if(found.length>100)break;}
      if(found.length>100)break;
    }
    const rows=found.slice(0,100),last=rows.at(-1);
    return {minuteRetentionDays:index.minuteRetentionDays,olderGapTotals:index.olderGapTotals,rows:rows.map(row=>row.value),nextCursor:found.length>100?JSON.stringify({at:last.at,run:last.run}):null};
  }
  const kind=url.pathname==='/api/breakouts/fallback'?'fallback':'current',metadata=head[kind];
  if(!metadata||!Array.isArray(metadata.pages))throw Error('Prepared current quotes missing');
  const rows=[];for(const id of metadata.pages){const page=await read(id);if(!Array.isArray(page?.rows))throw Error('Prepared quote page missing');rows.push(...page.rows);}
  const {pages,...rest}=metadata;return {...rest,rows,schedule:head.schedule,primarySchedule:head.primarySchedule,runtime:'github-actions',delivery:'static-assets'};
}
