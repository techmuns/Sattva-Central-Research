import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState} from './github-background-seal.mjs';
import {packEncryptedBackgroundViews} from './github-background-package.mjs';
import {sealBackgroundView} from './github-background-views.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';
import {localMutualFunds} from './mutual-funds-local.mjs';
import {restoreState,buildSnapshot,MF_LOCAL_FILE} from './mutual-funds-state.mjs';
const configuration=env=>({...env,BACKGROUND_STATE_KEY:env.MF_STATE_KEY});
export async function restoreStaticMutualFunds({env=process.env,fetcher=fetch,file=MF_LOCAL_FILE,legacyClient,onProgress}={}) {
  const config=configuration(env),transport=githubBackgroundRelease('mutual-funds',{env:config,fetcher}),snapshot=await transport.latest();
  if(!snapshot)return restoreState({env,fetcher,file,legacyClient,onProgress});
  const sealed=file+'.sealed';fs.mkdirSync(path.dirname(file),{recursive:true});
  try{await transport.download(snapshot,'state',sealed,{sourceSignature:await backgroundContract('mutual-funds')});await openBackgroundState(sealed,file,'mutual-funds',{env:config});}
  finally{fs.rmSync(sealed,{force:true});}
  const local=localMutualFunds(file);try{if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Ownership restart database invalid');}finally{local.close();}
}
export async function publishStaticMutualFunds(recipient,{env=process.env,fetcher=fetch,file=MF_LOCAL_FILE,out=path.resolve('.cache/mutual-funds/static-publish'),...options}={}) {
  const config=configuration(env),transport=githubBackgroundRelease('mutual-funds',{env:config,fetcher,...options});
  const built=await buildSnapshot(localMutualFunds(file),recipient,{env,out,file,staticViews:true,partBytes:3*1024*1024});
  const {state,...head}=built.manifest;head.files=Object.fromEntries(Object.entries(head.files).filter(([name])=>name!==state));
  const sourceSignature=await backgroundContract('mutual-funds'),views=path.join(out,'views.json.gz');
  async function* entries(){
    for(const name of Object.keys(head.files))yield {name,envelope:JSON.parse(fs.readFileSync(path.join(out,name),'utf8'))};
    yield {name:'head.json',envelope:JSON.parse((await sealBackgroundView(head,recipient,{repo:head.repo,feature:'mutual-funds',name:'head.json'})).bytes)};
  }
  await packEncryptedBackgroundViews(entries(),views,{repo:head.repo,feature:'mutual-funds',sourceSignature});
  return transport.publish({cycle:1,state:path.join(out,state),views,sourceSignature});
}
