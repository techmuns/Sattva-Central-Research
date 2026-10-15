import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {refreshBreakoutInputs} from './lib/breakout-inputs.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/breakout-inputs-'));
const env={GITHUB_REPOSITORY:'techmuns/Sattva-Central-Research',GITHUB_TOKEN:'fixture-token'},files={'technicals.json':{companies:[{ticker:'TEST'}]},'universe.json':[{ticker:'TEST'}],'portfolio-companies.json':{holdings:[{isin:'INE000000001'}]},'announcement-identities.json':{entries:[]},'filing-capture/nse-identities.json':{directories:{equity:{entries:[]},sme:{entries:[]}}}};let sha='a'.repeat(40),fail=false,calls=0;
const fetcher=async(raw,options)=>{calls++;const url=new URL(raw);if(url.hostname==='api.github.com'){assert.equal(options.headers.authorization,'Bearer fixture-token');assert(url.pathname.endsWith('/git/ref/heads/main'));return Response.json({object:{sha}});}assert.equal(url.hostname,'raw.githubusercontent.com');assert.equal(options.headers?.authorization,undefined);assert(url.pathname.includes('/'+sha+'/public/data/'));const name=url.pathname.split('/public/data/')[1];assert(Object.hasOwn(files,name));return fail&&name==='universe.json'?new Response(null,{status:503}):Response.json(files[name]);};
try{
 const first=await refreshBreakoutInputs({env,fetcher,root});assert.equal(first.revision,sha);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.root,'portfolio-companies.json'))),files['portfolio-companies.json']);
 sha='b'.repeat(40);fail=true;await assert.rejects(refreshBreakoutInputs({env,fetcher,root}));assert(fs.existsSync(first.root));assert(!fs.existsSync(path.join(root,sha)),'Failed or partial input publication cannot replace verified identities');
 fail=false;const next=await refreshBreakoutInputs({env,fetcher,root});assert.equal(next.revision,sha);assert(!fs.existsSync(first.root));assert(calls>=12);
 console.log('PASS current quote inputs: one fixed main revision per discovery, credentials only to GitHub API, atomic complete installs, previous inputs retained on failure and no quote/history deletion');
}finally{fs.rmSync(root,{recursive:true,force:true});}
