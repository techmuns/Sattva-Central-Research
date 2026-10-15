import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {backgroundFileHash,authenticateBackgroundState} from './github-background-seal.mjs';
import {validateBackgroundPackage} from './github-background-package.mjs';
export const MAX_BACKGROUND_BUNDLE=1900*1024*1024;
const MAGIC=Buffer.from('GHRB1');
function validate(value,expected={}) {
  if(value?.version!==1||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo||'')||!/^[a-z][a-z0-9-]{1,30}$/.test(value.feature||'')||!/^[a-f0-9]{40}$/.test(value.sourceSha||'')||!/^[a-f0-9]{64}$/.test(value.sourceSignature||'')||!/^\d+$/.test(value.workflowRun||'')||!Number.isFinite(Date.parse(value.createdAt)))throw Error('Invalid background bundle header');
  if(Object.keys(value).sort().join(',')!=='createdAt,feature,files,repo,sourceSha,sourceSignature,version,workflowRun'||!value.files||Object.keys(value.files).sort().join(',')!=='state,views')throw Error('Unexpected bundle fields');
  for(const key of ['repo','feature','sourceSignature'])if(expected[key]&&value[key]!==expected[key])throw Error('Background bundle context mismatch');
  for(const part of Object.values(value.files))if(Object.keys(part).sort().join(',')!=='hash,size'||!/^[a-f0-9]{64}$/.test(part.hash||'')||!Number.isSafeInteger(part.size)||part.size<1||part.size>=MAX_BACKGROUND_BUNDLE)throw Error('Invalid background bundle part');
  return value;
}
export async function createBackgroundBundle(state,views,destination,options,{env=process.env}={}) {
  if([state,views].some(file=>path.resolve(file)===path.resolve(destination)))throw Error('Invalid bundle destination');
  const metadata={version:1,...options,files:{}};
  await validateBackgroundPackage(views,options);
  const fd=fs.openSync(state,'r'),magic=Buffer.alloc(5);try{fs.readSync(fd,magic,0,5,0);}finally{fs.closeSync(fd);}
  if(magic.toString()!=='GHBK1')throw Error('Plaintext restart state must never be published');
  await authenticateBackgroundState(state,options.feature,{env});
  for(const [kind,file] of [['state',state],['views',views]])metadata.files[kind]={size:fs.statSync(file).size,hash:await backgroundFileHash(file)};
  validate(metadata);
  const text=Buffer.from(JSON.stringify(metadata));if(text.length>16384)throw Error('Background bundle header too large');
  const header=Buffer.alloc(9);MAGIC.copy(header);header.writeUInt32BE(text.length,5);
  const size=9+text.length+metadata.files.state.size+metadata.files.views.size;if(size>=MAX_BACKGROUND_BUNDLE)throw Error('Background bundle exceeds release budget');
  const temporary=destination+'.bundling';fs.mkdirSync(path.dirname(destination),{recursive:true});
  async function* parts(){
    yield header;yield text;
    for(const [kind,file] of [['state',state],['views',views]]) {
      let bytes=0;const hash=createHash('sha256');
      for await(const chunk of fs.createReadStream(file)){bytes+=chunk.length;if(bytes>metadata.files[kind].size)throw Error('Bundle input changed');hash.update(chunk);yield chunk;}
      if(bytes!==metadata.files[kind].size||hash.digest('hex')!==metadata.files[kind].hash)throw Error('Bundle input changed');
    }
  }
  try{await pipeline(Readable.from(parts()),fs.createWriteStream(temporary));fs.renameSync(temporary,destination);}
  catch(error){fs.rmSync(temporary,{force:true});throw error;}
  return {manifest:metadata,size,hash:await backgroundFileHash(destination)};
}
// A single upload is the commit marker. Splitting every minute into three assets
// plus three deletes needlessly consumes GitHub's hourly mutation allowance.
// Only prepared reader envelopes may be installed in static hosting; state stays
// in this runner's scratch directory and the encrypted GitHub release.
export async function readBackgroundBundle(file,outputs={},expected={}) {
  const fd=fs.openSync(file,'r');let metadata,start;
  try {
    const header=Buffer.alloc(9);if(fs.readSync(fd,header,0,9,0)!==9||!header.subarray(0,5).equals(MAGIC))throw Error('Invalid background bundle');
    const bytes=header.readUInt32BE(5);if(bytes<1||bytes>16384)throw Error('Invalid background header size');
    const text=Buffer.alloc(bytes);if(fs.readSync(fd,text,0,bytes,9)!==bytes)throw Error('Truncated background header');
    metadata=validate(JSON.parse(text),expected);start=9+bytes;
    const size=start+metadata.files.state.size+metadata.files.views.size;if(size>=MAX_BACKGROUND_BUNDLE||fs.statSync(file).size!==size)throw Error('Truncated or oversized background bundle');
  }finally{fs.closeSync(fd);}
  if(Object.keys(outputs).some(key=>!['state','views'].includes(key))||Object.values(outputs).some(destination=>path.resolve(destination)===path.resolve(file))||new Set(Object.values(outputs).map(destination=>path.resolve(destination))).size!==Object.keys(outputs).length)throw Error('Invalid background output');
  const staged=[];
  try {
    for(const kind of ['state','views']) {
      const part=metadata.files[kind],hash=createHash('sha256'),destination=outputs[kind];let size=0;
      async function* checked(source){for await(const chunk of source){size+=chunk.length;hash.update(chunk);yield chunk;}if(size!==part.size||hash.digest('hex')!==part.hash)throw Error('Background part integrity failed');}
      const stream=fs.createReadStream(file,{start,end:start+part.size-1});
      if(destination){fs.mkdirSync(path.dirname(destination),{recursive:true});const temporary=destination+'.unpacking';staged.push({destination,temporary});await pipeline(stream,checked,fs.createWriteStream(temporary));}
      else for await(const _chunk of checked(stream)){};
      start+=part.size;
    }
    for(const {destination,temporary} of staged)fs.renameSync(temporary,destination);
    return metadata;
  }catch(error){for(const {temporary} of staged)fs.rmSync(temporary,{force:true});throw error;}
}
