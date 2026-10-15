import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip,createGunzip,gzipSync } from 'node:zlib';
import { randomBytes,hkdfSync,createCipheriv,createDecipheriv,createHash,createHmac } from 'node:crypto';
import { mfRepo,MF_RELEASE,mfManifest,mfPart,mfDetailKey } from '../../worker/mutual-funds-github.mjs';
import { sealForReader,hash } from '../../worker/mutual-funds-seal.mjs';
import { localMutualFunds } from './mutual-funds-local.mjs';
import { scannerOperationalStatus } from '../../worker/mutual-funds-scanner-model.mjs';
import { MF_TABLES } from '../../worker/mutual-funds-export.mjs';
import {sealBackgroundView} from './github-background-views.mjs';
import {sealBackgroundState} from './github-background-seal.mjs';

export const MF_LOCAL_FILE=path.resolve('.cache/mutual-funds/state.sqlite');
const encoder=new TextEncoder();
const key=env=>{
  if(!env.MF_STATE_KEY||env.MF_STATE_KEY.length<20)throw Error('GitHub snapshot key unavailable');
  return hkdfSync('sha256',env.MF_STATE_KEY,'mutual-funds-github-v1','runner-state',32);
};
export function runnerEnv(env=process.env) {return {...env,GH_REPO:env.GITHUB_REPOSITORY,GH_RELEASE_TOKEN:env.GITHUB_TOKEN};}
export async function fileHash(file) {const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
export async function encryptState(file,out,env=process.env) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(env),iv);cipher.setAAD(encoder.encode(`${env.GITHUB_REPOSITORY}:mf-state-v1`));
  fs.writeFileSync(out,Buffer.concat([Buffer.from('MFGH1'),iv]));
  await pipeline(fs.createReadStream(file),createGzip(),cipher,fs.createWriteStream(out,{flags:'a'}));
  fs.appendFileSync(out,cipher.getAuthTag());
}
export async function decryptState(file,out,env=process.env) {
  const size=fs.statSync(file).size;if(size<33)throw Error('Invalid state snapshot');
  const fd=fs.openSync(file,'r'),header=Buffer.alloc(17),tag=Buffer.alloc(16);
  try{fs.readSync(fd,header,0,17,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
  if(header.subarray(0,5).toString()!=='MFGH1')throw Error('Invalid state format');
  const decipher=createDecipheriv('aes-256-gcm',key(env),header.subarray(5));decipher.setAAD(encoder.encode(`${env.GITHUB_REPOSITORY}:mf-state-v1`));decipher.setAuthTag(tag);
  const temp=out+'.restoring';
  try{await pipeline(fs.createReadStream(file,{start:17,end:size-17}),decipher,createGunzip(),fs.createWriteStream(temp));fs.renameSync(temp,out);}
  catch(error){fs.rmSync(temp,{force:true});throw error;}
}
export async function restoreState({env=process.env,legacyClient,fetcher=fetch,file=MF_LOCAL_FILE,onProgress=()=>{}}={}) {
  key(env);fs.mkdirSync(path.dirname(file),{recursive:true});
  const config=runnerEnv(env),snapshot=await mfManifest(config,{fetcher});
  if(snapshot) {
    const name=snapshot.manifest.state,asset=snapshot.assets.get(name),prefix=`https://github.com/${mfRepo(config)}/releases/download/${MF_RELEASE}/`;
    if(!asset?.browser_download_url?.startsWith(prefix))throw Error('Invalid state asset');
    const response=await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(300000)});
    if(!response.ok||Number(response.headers.get('content-length'))>1900*1024*1024)throw Error('State download unavailable');
    const encrypted=file+'.sealed';let bytes=0;
    async function* bounded(){for await(const chunk of Readable.fromWeb(response.body)){bytes+=chunk.length;if(bytes>1900*1024*1024)throw Error('State snapshot too large');yield chunk;}}
    await pipeline(bounded(),fs.createWriteStream(encrypted));
    if(await fileHash(encrypted)!==snapshot.manifest.files[name])throw Error('State integrity failed');
    await decryptState(encrypted,file,env);fs.rmSync(encrypted,{force:true});
    const local=localMutualFunds(file);try{if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('State database invalid');}finally{local.close();}
    return;
  }
  // Never replace inaccessible prior history with a fresh, apparently healthy DB.
  if(!legacyClient)throw Error('Migration source unavailable');
  const inventory=await legacyClient({action:'export'}),local=localMutualFunds(file);
  try {
    local.primary.init();local.scanner.init();
    for(const {name,count} of inventory.tables) {
      if(!MF_TABLES.includes(name)||!Number.isSafeInteger(count)||count<0)throw Error('Invalid migration table');
      const columns=local.db.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name);
      const insert=local.db.prepare(`INSERT OR REPLACE INTO ${name}(rowid,${columns.map(c=>`"${c}"`).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
      let cursor=0,received=0;
      for(;;) {
        const page=await legacyClient({action:'export',table:name,cursor});
        if(!Array.isArray(page.rows))throw Error('Migration page missing');
        local.storage.transactionSync(()=>{for(const row of page.rows)insert.run(row.__migration_rowid,...columns.map(c=>row[c]??null));});
        received+=page.rows.length;onProgress({table:name,received,count});if(!page.cursor)break;if(page.cursor<=cursor)throw Error('Migration did not advance');cursor=page.cursor;
      }
      if(received!==count)throw Error('Migration row count changed; source must be quiescent');
    }
  }catch(error){local.close();fs.rmSync(file,{force:true});throw error;}
  local.close();
}
export async function buildSnapshot(local,recipient,{env=process.env,out=path.resolve('.cache/mutual-funds/publish'),file=MF_LOCAL_FILE,previous=null,partBytes=4*1024*1024,staticViews=false}={}) {
  fs.mkdirSync(out,{recursive:true});
  const repo=mfRepo(runnerEnv(env)),prefix=`mf-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT||1}`,files={};
  const manifest={version:1,repo,createdAt:new Date().toISOString(),files,publicParts:{},privateParts:{},logical:{}};
  if(staticViews){
    manifest.delivery='static-v1';
    local.db.exec('CREATE TABLE IF NOT EXISTS github_mf_prepared_files (name TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL)');
    local.db.exec('CREATE TABLE IF NOT EXISTS github_mf_prepared_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    if(!previous){const saved=local.db.prepare("SELECT value FROM github_mf_prepared_meta WHERE key='manifest'").get();if(saved)previous=JSON.parse(saved.value);}
  }
  async function save(label,payload,{privateRead=false}={}) {
    const plain=encoder.encode(JSON.stringify(payload));
    if(privateRead&&plain.byteLength>5*1024*1024)throw Error('Private snapshot part exceeds delivery budget');
    const revision=privateRead?createHmac('sha256',key(env)).update(plain).update(recipient.kid).digest('hex'):staticViews?createHash('sha256').update(plain).update(recipient.kid).digest('hex'):await hash(plain);
    const old=(staticViews?previous?.delivery==='static-v1':previous?.delivery!=='static-v1')?previous?.logical?.[label]:null;
    if(old?.revision===revision&&previous.files[old.name]){
      const cached=staticViews?local.db.prepare('SELECT hash,body FROM github_mf_prepared_files WHERE name=?').get(old.name):null;
      if(!staticViews||cached?.hash===previous.files[old.name]&&await hash(encoder.encode(cached.body))===cached.hash){if(cached)fs.writeFileSync(path.join(out,old.name),cached.body);files[old.name]=previous.files[old.name];manifest.logical[label]=old;return old.name;}
    }
    const name=`${prefix}-${label}.json`,context=`${repo}:${name}`;
    const value=staticViews?JSON.parse((await sealBackgroundView(payload,recipient,{repo,feature:'mutual-funds',name})).bytes):privateRead?await sealForReader(plain,recipient,context):payload;
    const data=encoder.encode(JSON.stringify(value));if(data.byteLength>8*1024*1024)throw Error('Snapshot part exceeds safe delivery size');
    fs.writeFileSync(path.join(out,name),data);files[name]=await hash(data);manifest.logical[label]={name,revision};
    if(staticViews)local.db.prepare('INSERT INTO github_mf_prepared_files VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,body=excluded.body').run(name,files[name],new TextDecoder().decode(data));
    return name;
  }
  local.primary.init();local.scanner.init();
  const ids=local.db.prepare('SELECT isin FROM mf_companies UNION SELECT isin FROM mf_scanner_targets ORDER BY isin').all().map(r=>r.isin);
  const primaryRows=[],privateRows=[],publicParts=new Map(),privateParts=new Map();
  const primaryMeta=local.primary.read([], '').meta;
  const supplement=local.scanner.status();
  const prepared=value=>({gzip:gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')});
  for(const isin of ids) {
    const company=local.primary.company(isin),merged=local.scanner.company(isin),part=mfPart(isin);
    const summary=local.primary.read([isin],'').rows[0];if(summary)primaryRows.push(summary);
    const privateSummary=local.scanner.read([isin],'').rows[0];if(privateSummary)privateRows.push(privateSummary);
    for(const [current,store,parts] of [[company,local.primary,publicParts],[merged,local.scanner,privateParts]]) {
      if(!current)continue;
      if(!parts.has(part))parts.set(part,{});
      const entries=parts.get(part);entries[await mfDetailKey(isin)]=prepared(current);
      // Each historical month is independently addressable. Growing history adds
      // bounded pages instead of eventually making one bucket unreadably large.
      for(const month of current.availableMonths||[])entries[await mfDetailKey(isin,month)]=prepared(store.company(isin,month));
    }
  }
  manifest.publicIndex=await save('public-index',{meta:{...primaryMeta,supplement:scannerOperationalStatus(supplement)},rows:primaryRows});
  async function pages(parts,index,prefix,privateRead=false) {
    for(const [part,data] of parts) {
      // Neither a public hash of an ISIN/month nor its bucket is private: both
      // can be enumerated. Keep the directory encrypted and its filenames opaque.
      const label=privateRead?createHmac('sha256',key(env)).update(`${repo}:private-bucket:${part}`).digest('hex'):part;
      const records=Object.entries(data).sort(([a],[b])=>a.localeCompare(b));index[part]=[];
      let page={},bytes=2,first=null,last=null;
      const flush=async()=>{
        if(!first)return;
        const name=await save(`${prefix}-${label}-${index[part].length}`,page,{privateRead});
        index[part].push({first,last,name});page={};bytes=2;first=null;
      };
      for(const [address,value] of records) {
        const size=Buffer.byteLength(JSON.stringify({[address]:value}));
        if(size>partBytes)throw Error('One prepared monthly view exceeds delivery budget');
        if(first&&bytes+size>partBytes)await flush();
        first||=address;last=address;page[address]=value;bytes+=size;
      }
      await flush();
    }
  }
  await pages(publicParts,manifest.publicParts,'public');
  const privateDirectory={};
  await pages(privateParts,privateDirectory,'private',true);
  manifest.privateIndex=await save('private-index',{meta:{...primaryMeta,supplement},rows:privateRows,parts:privateDirectory},{privateRead:true});
  if(staticViews)local.storage.transactionSync(()=>{
    local.db.prepare("INSERT INTO github_mf_prepared_meta VALUES('manifest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(manifest));
    local.db.prepare('DELETE FROM github_mf_prepared_files WHERE name NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(Object.keys(files)));
  });
  local.close();
  manifest.state=`${prefix}-state.bin`;
  if(staticViews)await sealBackgroundState(file,path.join(out,manifest.state),'mutual-funds',{env:{...env,BACKGROUND_STATE_KEY:env.MF_STATE_KEY}});
  else await encryptState(file,path.join(out,manifest.state),env);
  files[manifest.state]=await fileHash(path.join(out,manifest.state));
  const manifestName=`${prefix}-manifest.json`;fs.writeFileSync(path.join(out,manifestName),JSON.stringify(manifest));
  return {manifest,manifestName,out};
}
