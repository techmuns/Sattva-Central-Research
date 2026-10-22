import {boundedJson} from './family-book-contract.js';
import {decode64} from '../core/base64.js';
import {validateQuote,liveCoverage,BREAKOUT_REPO} from './breakout-live-shared.js';
import {selectPreparedBreakouts} from './breakout-selection.js';

// Only the current authenticated quote view reaches this reader. Restart state,
// collection, source requests and retained history stay on the GitHub runner.
let decoded=null;
function validateCapture(value,now,primary=false) {
  if(!value||!Array.isArray(value.rows)||!Array.isArray(value.targets)||!Array.isArray(value.failures)||
    (!primary&&value.version!==1)||primary&&(!Number.isFinite(value.at)||!Number.isFinite(value.completedAt)))throw Error('Invalid quote snapshot');
  for(const row of value.rows)validateQuote(row,now);
}
export async function snapshotCapture(packed,now=Date.now()) {
  if(packed?.format!=='gzip-json'||typeof packed.gzip!=='string'||packed.gzip.length>7*1024*1024)throw Error('Invalid compressed quote snapshot');
  let head=decoded?.gzip===packed.gzip?decoded.head:null;
  if(!head)head=await boundedJson(new Response(new Response(decode64(packed.gzip)).body.pipeThrough(new DecompressionStream('gzip'))),5*1024*1024);
  if(head.version!==1||head.feature!=='breakouts-live'||head.repo!==BREAKOUT_REPO||!Number.isFinite(Date.parse(head.createdAt))||Date.parse(head.createdAt)>now+60000)throw Error('Invalid prepared quote context');
  validateCapture(head.fallback,now);
  if(head.primary)validateCapture(head.primary,now,true);
  // Publish the decode cache only after every source row passes validation. A
  // failed new packet cannot replace the reader's last good evidence.
  decoded={gzip:packed.gzip,head};
  const capture=selectPreparedBreakouts(head,head.fallback,head.primary,'/api/breakouts',{now,delivery:'github-prepared'});
  return {...capture,health:liveCoverage(capture,capture.targets,now)};
}
