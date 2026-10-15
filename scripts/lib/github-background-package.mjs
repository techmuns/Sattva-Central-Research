import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {sealBackgroundView,backgroundViewContext} from './github-background-views.mjs';
const MAX_LINE=8*1024*1024,MAX_PACKAGE=1900*1024*1024,MAX_FILES=20000;
const fileName=name=>/^[a-z0-9-]{1,180}\.json$/.test(name);
function header({repo,feature,sourceSignature,createdAt=new Date().toISOString()}) {
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo||'')||!/^[a-z][a-z0-9-]{1,30}$/.test(feature||'')||!/^[a-f0-9]{64}$/.test(sourceSignature||'')||!Number.isFinite(Date.parse(createdAt)))throw Error('Invalid prepared package context');
  return {format:'encrypted-static-views-v1',repo,feature,sourceSignature,createdAt};
}
function envelope(value,context) {
  if(value?.version!==1||value.context!==context||!/^[a-f0-9]{64}$/.test(value.kid||'')||typeof value.body!=='string'||value.body.length<24||value.body.length>7*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.body)||Buffer.from(value.body,'base64').toString('base64')!==value.body)throw Error('Prepared package requires an encrypted envelope');
  for(const [name,size] of [['iv',12],['ephemeral',32]])if(typeof value[name]!=='string'||Buffer.from(value[name],'base64').length!==size)throw Error('Invalid prepared envelope');
  if(Object.keys(value).sort().join(',')!=='body,context,ephemeral,iv,kid,version')throw Error('Unexpected plaintext fields in prepared package');
}
// A stream of individually authenticated encrypted files. No plaintext source
// records or restart database can enter the static delivery package.
export async function packBackgroundViews(entries,recipient,destination,options) {
  async function* sealed(){for await(const {name,value,maxBytes} of entries){const result=await sealBackgroundView(value,recipient,{...options,name,...(maxBytes?{maxBytes}:{})});yield {name,envelope:JSON.parse(result.bytes)};}}
  return packEncryptedBackgroundViews(sealed(),destination,options);
}
export async function packEncryptedBackgroundViews(entries,destination,options) {
  const metadata=header(options),names=new Set(),temporary=destination+'.packing';let bytes=0;
  async function* lines() {
    yield JSON.stringify(metadata)+'\n';
    for await(const {name,envelope:sealed} of entries) {
      if(!fileName(name)||names.has(name)||names.size>=MAX_FILES)throw Error('Invalid or duplicate prepared filename');
      names.add(name);
      envelope(sealed,backgroundViewContext(metadata.repo,metadata.feature,name));
      const line=JSON.stringify({name,envelope:sealed})+'\n';
      if(Buffer.byteLength(line)>MAX_LINE)throw Error('Prepared file exceeds package line budget');
      yield line;
    }
    if(!names.size)throw Error('Empty prepared package');
    yield JSON.stringify({format:'complete',files:names.size})+'\n';
  }
  async function* bounded(source){for await(const chunk of source){bytes+=chunk.length;if(bytes>=MAX_PACKAGE)throw Error('Prepared package exceeds release budget');yield chunk;}}
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  try{await pipeline(Readable.from(lines()),createGzip(),bounded,fs.createWriteStream(temporary));fs.renameSync(temporary,destination);}
  catch(error){fs.rmSync(temporary,{force:true});throw error;}
  return {...metadata,files:names.size};
}
export async function validateBackgroundPackage(source,options,{onFile=()=>{}}={}) {
  const expected=header(options),names=new Set();
  let pending=Buffer.alloc(0),inflated=0,first=true,complete=false;
  const accept=line=>{
    if(complete)throw Error('Prepared package has trailing records');
    const value=JSON.parse(line.toString('utf8'));
    if(first){first=false;const actual=header(value);if(value.format!=='encrypted-static-views-v1'||Object.keys(value).sort().join(',')!=='createdAt,feature,format,repo,sourceSignature'||['repo','feature','sourceSignature'].some(key=>actual[key]!==expected[key]))throw Error('Prepared package belongs to different code or repository');return;}
    if(value.format==='complete'){if(value.files!==names.size||!names.size||Object.keys(value).sort().join(',')!=='files,format')throw Error('Incomplete prepared file inventory');complete=true;return;}
    if(!fileName(value.name)||names.has(value.name)||names.size>=MAX_FILES||Object.keys(value).sort().join(',')!=='envelope,name')throw Error('Invalid prepared package record');
    envelope(value.envelope,backgroundViewContext(expected.repo,expected.feature,value.name));
    names.add(value.name);onFile(value.name,value.envelope);
  };
  const decoder=fs.createReadStream(source).pipe(createGunzip());
  try {
    for await(const chunk of decoder) {
      inflated+=chunk.length;if(inflated>4*1024*1024*1024)throw Error('Prepared package exceeds installation budget');
      pending=Buffer.concat([pending,chunk]);let end;
      while((end=pending.indexOf(10))>=0){if(end>MAX_LINE)throw Error('Prepared package line too large');accept(pending.subarray(0,end));pending=pending.subarray(end+1);}
      if(pending.length>MAX_LINE)throw Error('Prepared package line too large');
    }
    if(pending.length||first||!complete)throw Error('Truncated prepared package');
    return {...expected,files:names.size};
  }finally{decoder.destroy();}
}
export async function installBackgroundViews(source,publicRoot,options) {
  const expected=header(options),root=path.resolve(publicRoot),base=path.join(root,'generated-views'),destination=path.join(base,expected.feature);
  fs.mkdirSync(base,{recursive:true});const temporary=fs.mkdtempSync(path.join(base,'.install-'));
  try {
    const result=await validateBackgroundPackage(source,options,{onFile:(name,value)=>fs.writeFileSync(path.join(temporary,name),JSON.stringify(value))});
    // Installation occurs only on the isolated build checkout after the entire
    // archive was validated. A failed transfer preserves the previous directory.
    fs.rmSync(destination,{force:true,recursive:true});fs.renameSync(temporary,destination);return result;
  }catch(error){fs.rmSync(temporary,{recursive:true,force:true});throw error;}
}
