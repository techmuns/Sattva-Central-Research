import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function atomicJson(file,value) {
  fs.writeFileSync(`${file}.tmp`,JSON.stringify(value));
  fs.renameSync(`${file}.tmp`,file);
}

// A blocked AMC must not consume the entire pass. Each child owns one AMC file;
// only this coordinator writes the shared coverage checkpoint.
export async function runSourcePool(entries,{command,args,env=process.env,checksFile,initial=[],concurrency=4,timeoutMs=120000,signal,onResult=()=>{}}) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mf-source-checks-'));
  const prior=new Map(initial.map(c=>[c.slug,c])),checks=new Map(prior),cancel=new AbortController();
  const stop=()=>cancel.abort();
  signal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const save=()=>atomicJson(checksFile,[...checks.values()]);
  for(const entry of entries)checks.set(entry.slug,{...prior.get(entry.slug),slug:entry.slug,name:entry.amc,month:prior.get(entry.slug)?.month||null,status:'unchecked',checkedAt:null});
  save();
  let cursor=0;
  async function collect(entry,index) {
    const startedAt=new Date().toISOString(),file=path.join(scratch,`${index}.json`);
    const unavailable=reason=>({...prior.get(entry.slug),slug:entry.slug,name:entry.amc,month:prior.get(entry.slug)?.month||null,status:'unavailable',checkedAt:null,lastAttemptAt:startedAt,reason});
    checks.set(entry.slug,{...unavailable('checking'),status:'checking'});save();
    return new Promise(resolve=>{
      const child=spawn(command,args,{env:{...env,MF_SOURCE_WORKER:'1',MF_SOURCE_AMCS:entry.slug,MF_SOURCE_CHECK_FILE:file,MF_SOURCE_PREVIOUS_CHECK:JSON.stringify(prior.get(entry.slug)||null)},detached:true,stdio:'ignore'});
      let reason=null,finished=false,hardStop;
      const kill=signal=>{if(child.pid)try{process.kill(-child.pid,signal);}catch{/* Already exited. */}};
      const terminate=value=>{if(finished||reason)return;reason=value;kill('SIGTERM');hardStop=setTimeout(()=>kill('SIGKILL'),1000);};
      const abort=()=>terminate('interrupted');
      const timer=setTimeout(()=>terminate('source-timeout'),timeoutMs);
      cancel.signal.addEventListener('abort',abort,{once:true});
      if(cancel.signal.aborted)abort();
      const finish=code=>{
        if(finished)return;finished=true;clearTimeout(timer);clearTimeout(hardStop);cancel.signal.removeEventListener('abort',abort);
        // Also stop any curl process left behind by an unexpectedly exited child.
        kill('SIGKILL');
        let result=unavailable(reason||'source-process-failed');
        try{
          const saved=JSON.parse(fs.readFileSync(file)),match=saved.find(c=>c.slug===entry.slug);
          if(match&&(!reason&&code===0))result=match;
          else if(match&&(match.schemeCount>0||match.resumeUrl)&&(match.checkedAt||match.partialCheckedAt))result={...match,status:'partial',reason:reason||'source-process-failed',lastAttemptAt:startedAt};
        }catch{/* A missing checkpoint is not a successful check. */}
        checks.set(entry.slug,result);save();onResult(result);resolve();
      };
      child.once('error',()=>finish(null));child.once('close',finish);
    });
  }
  try {
    await Promise.all(Array.from({length:Math.min(concurrency,entries.length)},async()=>{
      while(cursor<entries.length&&!cancel.signal.aborted){const index=cursor++;await collect(entries[index],index);}
    }));
    return {checks:[...checks.values()],interrupted:cancel.signal.aborted};
  } finally {
    process.off('SIGTERM',stop);process.off('SIGINT',stop);signal?.removeEventListener('abort',stop);
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}
