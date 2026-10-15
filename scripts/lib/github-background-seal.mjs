import fs from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {resolve} from 'node:path';
import {createGzip,createGunzip} from 'node:zlib';
import {randomBytes,hkdfSync,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
const HEADER=Buffer.from('GHBK1'),MAX_PLAIN=8*1024*1024*1024;
function context(feature,env) {
  if(!/^[a-z][a-z0-9-]{1,30}$/.test(feature)||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY||'')||typeof env.BACKGROUND_STATE_KEY!=='string'||env.BACKGROUND_STATE_KEY.length<20)throw Error('Background state key or context unavailable');
  const aad=Buffer.from(`${env.GITHUB_REPOSITORY}:${feature}:github-state-v1`);
  return {aad,key:hkdfSync('sha256',env.BACKGROUND_STATE_KEY,'github-background-state-v1',aad,32)};
}
export async function backgroundFileHash(file) {const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function sealBackgroundState(file,destination,feature,{env=process.env,maxPlainBytes=MAX_PLAIN}={}) {
  if(resolve(file)===resolve(destination)||!Number.isSafeInteger(maxPlainBytes)||maxPlainBytes<1||maxPlainBytes>MAX_PLAIN)throw Error('Invalid state destination or budget');
  const {aad,key}=context(feature,env),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  const temporary=destination+'.sealing';let plainBytes=0,sealedBytes=17;
  async function* boundedPlain(source){for await(const chunk of source){plainBytes+=chunk.length;if(plainBytes>maxPlainBytes)throw Error('Background state exceeds runner budget');yield chunk;}}
  async function* boundedSealed(source){for await(const chunk of source){sealedBytes+=chunk.length;if(sealedBytes>1900*1024*1024-16)throw Error('Sealed background state exceeds release budget');yield chunk;}}
  fs.writeFileSync(temporary,Buffer.concat([HEADER,iv]));
  try{await pipeline(fs.createReadStream(file),boundedPlain,createGzip(),cipher,boundedSealed,fs.createWriteStream(temporary,{flags:'a'}));fs.appendFileSync(temporary,cipher.getAuthTag());fs.renameSync(temporary,destination);}
  catch(error){fs.rmSync(temporary,{force:true});throw error;}
  return backgroundFileHash(destination);
}
function stateReader(file,feature,env) {
  const {aad,key}=context(feature,env),size=fs.statSync(file).size;
  if(size<33||size>1900*1024*1024)throw Error('Invalid state size');
  const fd=fs.openSync(file,'r'),header=Buffer.alloc(17),tag=Buffer.alloc(16);
  try{fs.readSync(fd,header,0,17,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
  if(!header.subarray(0,5).equals(HEADER))throw Error('Unknown background state format');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(5));decipher.setAAD(aad);decipher.setAuthTag(tag);
  return {source:fs.createReadStream(file,{start:17,end:size-17}),decipher};
}
export async function authenticateBackgroundState(file,feature,{env=process.env}={}) {
  const {source,decipher}=stateReader(file,feature,env);
  await pipeline(source,decipher,async function(input){for await(const _chunk of input){}});
}
export async function openBackgroundState(file,destination,feature,{env=process.env,maxPlainBytes=MAX_PLAIN}={}) {
  if(resolve(file)===resolve(destination))throw Error('Invalid state destination');
  if(!Number.isSafeInteger(maxPlainBytes)||maxPlainBytes<1||maxPlainBytes>MAX_PLAIN)throw Error('Invalid state size');
  const {source,decipher}=stateReader(file,feature,env);
  const temporary=destination+'.restoring';let bytes=0;
  async function* bounded(source){for await(const chunk of source){bytes+=chunk.length;if(bytes>maxPlainBytes)throw Error('Inflated background state exceeds runner budget');yield chunk;}}
  try{await pipeline(source,decipher,createGunzip(),bounded,fs.createWriteStream(temporary));fs.renameSync(temporary,destination);}
  catch(error){fs.rmSync(temporary,{force:true});throw error;}
}
