import fs from 'node:fs';
import path from 'node:path';
import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {mfRepo} from '../../worker/mutual-funds-github.mjs';
const FILES=['technicals.json','universe.json','portfolio-companies.json','announcement-identities.json','filing-capture/nse-identities.json'];
// Pin every input in one discovery pass to the same current main revision while
// keeping the running collector's code pinned to its original workflow commit.
export async function refreshBreakoutInputs({env=process.env,fetcher=fetch,root=path.resolve('.cache/breakouts/inputs')}={}) {
 const repo=mfRepo({GH_REPO:env.GITHUB_REPOSITORY});if(!env.GITHUB_TOKEN)throw Error('Current source inputs unavailable');
 const ref=await boundedJson(await fetcher(`https://api.github.com/repos/${repo}/git/ref/heads/main`,{headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(20000)}),64000);
 const sha=ref.object?.sha;if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Invalid input revision');
 const values=await Promise.all(FILES.map(async name=>({name,value:await boundedJson(await fetcher(`https://raw.githubusercontent.com/${repo}/${sha}/public/data/${name}`,{redirect:'manual',signal:AbortSignal.timeout(30000)}),32*1024*1024)})));
 for(const {name,value} of values)if(!value||typeof value!=='object'||name==='universe.json'&&!Array.isArray(value)||name==='portfolio-companies.json'&&!Array.isArray(value.holdings))throw Error('Invalid source input');
 fs.mkdirSync(root,{recursive:true});const destination=path.join(root,sha);if(!fs.existsSync(destination)){
  const temp=fs.mkdtempSync(path.join(root,'.install-'));
  try{for(const {name,value} of values){const file=path.join(temp,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}fs.renameSync(temp,destination);}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
 }
 // Old inputs are disposable after this complete generation is installed. They
 // are never an archive of source quotes or the retained restart database.
 for(const name of fs.readdirSync(root))if(/^[a-f0-9]{40}$/.test(name)&&name!==sha)fs.rmSync(path.join(root,name),{recursive:true,force:true});
 return {root:destination,revision:sha};
}
