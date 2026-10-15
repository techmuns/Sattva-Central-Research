import {readBackgroundView} from './github-background-views.mjs';
import {readPrivateRecord} from './github-private-records.mjs';
import {mfRepo} from './mutual-funds-github.mjs';

// The caller must pass the feature-specific reader policy before this function.
export async function preparedSummaries(request,env,{ids=null,now=Date.now()}={}) {
  const head=await readBackgroundView(env,request.url,'summaries','head.json');
  if(!head)return null;
  if(head.version!==1||head.repo!==mfRepo(env)||head.feature!=='summaries'||!Number.isFinite(Date.parse(head.createdAt))||!head.state||!head.parts)throw Error('Invalid prepared summary inventory');
  if(ids!==null) {
    if(!Array.isArray(ids)||ids.length>10||ids.some(id=>typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id)))throw Error('Invalid private summary scope');
    const records=[],memo=new Map();
    for(const id of [...new Set(ids)]){const record=await readPrivateRecord(env,request.url,'summaries',head,id,{memo,maxBytes:256*1024});records.push(record||{id,status:'not-collected',active:false,nextAttemptAt:null});}
    return {records};
  }
  const state={...head.state};
  if(state.discoveryStatus==='ok'&&now-Date.parse(state.discoveredAt)>90*60000)state.discoveryStatus='stale';
  if(state.discoveryStatus==='checking'&&now-Date.parse(state.discoveryAttemptedAt)>15*60000)state.discoveryStatus='failed';
  state.schedule={...state.schedule,overdue:now-Date.parse(head.createdAt)>90*60000};
  return state;
}
