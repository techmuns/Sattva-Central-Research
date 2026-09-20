import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {monthKey,targetMonth} from '../../worker/mutual-funds-model.mjs';

// Sattva consumes one coherent AmfiBeas commit. It never starts AMC collection,
// executes upstream scripts, or uses the Git commit time as a source check time.
export function loadSharedHoldings(root,{now=Date.now()}={}) {
  const dir=path.join(root,'public/amc-holdings');
  const read=(file,limit)=>{
    const p=path.join(dir,file),stat=fs.lstatSync(p);
    if(!stat.isFile()||stat.size>limit)throw Error('Invalid shared source file');
    return fs.readFileSync(p);
  };
  const manifest=JSON.parse(read('coverage.json',2*1024*1024)),index=JSON.parse(read('index.json',2*1024*1024));
  if(manifest.schemaVersion!==1||!['complete','interrupted'].includes(manifest.state)||!Array.isArray(manifest.amcs)||!manifest.amcs.length||manifest.amcs.length>500||!Array.isArray(manifest.files)||!Array.isArray(index.amcs))throw Error('Unsupported shared source manifest');
  if(monthKey(manifest.targetMonth)!==manifest.targetMonth||manifest.targetMonth>targetMonth(now))throw Error('Invalid shared source month');
  const validTime=t=>t===null||t===undefined||typeof t==='string'&&Number.isFinite(Date.parse(t))&&Date.parse(t)<=now+60000;
  if(!manifest.generatedAt||!validTime(manifest.generatedAt))throw Error('Invalid shared source time');
  const checks=new Map(),snapshots=[],files=new Set();
  for(const c of manifest.amcs) {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.slug)||checks.has(c.slug)||!['ok','partial','unavailable','unchecked','checking'].includes(c.status)||[c.checkedAt,c.lastAttemptAt,c.lastCompleteCheckedAt,c.partialCheckedAt].some(t=>!validTime(t)))throw Error('Invalid shared source check');
    if(c.month!==null&&c.month!==undefined&&(monthKey(c.month)!==c.month||c.month>targetMonth(now)))throw Error('Invalid source reporting month');
    if(c.status==='ok'&&(!c.checkedAt||!c.month))throw Error('Unverified source success');
    checks.set(c.slug,{...c});
  }
  const indexed=index.amcs.map(c=>c.slug);
  if(indexed.length!==checks.size||new Set(indexed).size!==checks.size||indexed.some(slug=>!checks.has(slug)))throw Error('Incomplete source inventory');
  for(const file of manifest.files) {
    if(!checks.has(file.slug)||files.has(file.slug)||file.file!==file.slug+'.json'||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<=0)throw Error('Invalid snapshot manifest');
    const bytes=read(file.file,64*1024*1024);
    if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(`Shared snapshot checksum mismatch: ${file.slug}`);
    const snapshot=JSON.parse(bytes);
    if(snapshot.amcSlug!==file.slug||!Array.isArray(snapshot.schemes)||snapshot.history!==undefined&&!Array.isArray(snapshot.history))throw Error('Invalid shared snapshot');
    files.add(file.slug);snapshots.push(snapshot);
  }
  for(const c of checks.values()) {
    if(c.status==='ok'&&!files.has(c.slug))throw Error('Successful source has no snapshot');
    if(c.status==='ok'&&(manifest.state!=='complete'||manifest.directory?.status!=='ok'))Object.assign(c,{status:'partial',reason:manifest.state!=='complete'?'upstream-capture-interrupted':'upstream-directory-unavailable'});
  }
  return {snapshots,amcs:[...checks.values()],manifest};
}
