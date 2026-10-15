import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {planDeployment,finishDeployment,DEPLOY_ENV} from './github-deploy-state.mjs';
fs.mkdirSync('.cache',{recursive:true});
const root=fs.mkdtempSync(path.resolve('.cache/github-deploy-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
try {
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.mkdirSync(path.join(root,'public'));fs.mkdirSync(path.join(root,'worker'));
  fs.writeFileSync(path.join(root,'public/data.json'),'retained source');fs.writeFileSync(path.join(root,'worker/index.js'),'export default {}');fs.writeFileSync(path.join(root,'wrangler.jsonc'),'{}');
  const commit=message=>{git('add','.');git('commit','-m',message);return git('rev-parse','HEAD');};
  const initial=commit('Initial published inputs');
  let previous=initial,requests=[],background=[],previousPrepared={};
  const plan=options=>planDeployment({...options,prepared:async()=>background});
  const fetcher=async(url,options)=>{
    const body=options.body&&JSON.parse(options.body);requests.push({url,body});
    if(body?.ref)return Response.json({id:11,sha:body.ref});
    if(body)return Response.json({id:99});
    if(url.includes('/statuses'))return Response.json([{state:'success'}]);
    return Response.json([{id:10,sha:previous,payload:{publisher:'github-direct-v2',prepared:previousPrepared}}]);
  };
  const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'techmuns/Fixture',GITHUB_TOKEN:'fixture-token',GITHUB_SHA:initial,GITHUB_RUN_ID:'1'};
  assert.deepEqual(await plan({env,fetcher,git}),{changed:false});
  fs.writeFileSync(path.join(root,'notes.md'),'Repository-only update');env.GITHUB_SHA=commit('No published change');
  assert.deepEqual(await plan({env,fetcher,git}),{changed:false},'No unchanged asset uploads, even after non-site commits');
  for(const file of ['public/data.json','worker/index.js','wrangler.jsonc']) {
    fs.appendFileSync(path.join(root,file),'\nchanged');env.GITHUB_SHA=commit('Changed '+file);requests=[];
    assert.deepEqual(await plan({env,fetcher,git}),{changed:true,id:11,background:[]});
    const claim=requests.find(r=>r.body?.ref)?.body;assert.equal(claim.ref,env.GITHUB_SHA);assert.equal(claim.environment,DEPLOY_ENV);assert.equal(claim.auto_merge,false);
    assert.equal(requests.at(-1).body.state,'in_progress');previous=env.GITHUB_SHA;
  }
  background=[{feature:'summaries',asset:{id:123}},{feature:'newsletter',asset:{id:124}}];requests=[];
  assert.equal((await plan({env,fetcher,git})).changed,true,'New prepared data publishes even when the main checkout did not change');
  assert.deepEqual(requests.find(r=>r.body?.ref).body.payload.prepared,{summaries:123,newsletter:124});
  previousPrepared={newsletter:124,summaries:123};assert.deepEqual(await plan({env,fetcher,git}),{changed:false},'GitHub JSON property ordering cannot cause repeated uploads');
  background=[];await assert.rejects(plan({env,fetcher,git}),/previously published prepared dataset/,'A missing GitHub generation cannot delete the previously published reader files');
  previousPrepared={};
  await assert.rejects(plan({env:{...env,GITHUB_REF:'refs/heads/development'},fetcher,git}),/main-branch/);
  await assert.rejects(plan({env:{...env,GITHUB_SHA:initial},fetcher,git}),/checkout/);
  await finishDeployment({env:{...env,DEPLOYMENT_ID:'11',DEPLOY_OUTCOME:'failure'},fetcher});assert.equal(requests.at(-1).body.state,'failure','A failed upload never advances the successful baseline');
  await finishDeployment({env:{...env,DEPLOYMENT_ID:'11',DEPLOY_OUTCOME:'success'},fetcher});assert.equal(requests.at(-1).body.state,'success');
  console.log('PASS GitHub direct deployment: exact main checkout, unchanged-tree skips, all published inputs detected, and success recorded only after upload');
}finally{fs.rmSync(root,{recursive:true,force:true});}
