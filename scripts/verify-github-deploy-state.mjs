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
  let previous=initial,requests=[];
  const fetcher=async(url,options)=>{
    const body=options.body&&JSON.parse(options.body);requests.push({url,body});
    if(body?.ref)return Response.json({id:11,sha:body.ref});
    if(body)return Response.json({id:99});
    if(url.includes('/statuses'))return Response.json([{state:'success'}]);
    return Response.json([{id:10,sha:previous,payload:{publisher:'github-direct-v1'}}]);
  };
  const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'techmuns/Fixture',GITHUB_TOKEN:'fixture-token',GITHUB_SHA:initial,GITHUB_RUN_ID:'1'};
  assert.deepEqual(await planDeployment({env,fetcher,git}),{changed:false});
  fs.writeFileSync(path.join(root,'notes.md'),'Repository-only update');env.GITHUB_SHA=commit('No published change');
  assert.deepEqual(await planDeployment({env,fetcher,git}),{changed:false},'No unchanged asset uploads, even after non-site commits');
  for(const file of ['public/data.json','worker/index.js','wrangler.jsonc']) {
    fs.appendFileSync(path.join(root,file),'\nchanged');env.GITHUB_SHA=commit('Changed '+file);requests=[];
    assert.deepEqual(await planDeployment({env,fetcher,git}),{changed:true,id:11});
    const claim=requests.find(r=>r.body?.ref)?.body;assert.equal(claim.ref,env.GITHUB_SHA);assert.equal(claim.environment,DEPLOY_ENV);assert.equal(claim.auto_merge,false);
    assert.equal(requests.at(-1).body.state,'in_progress');previous=env.GITHUB_SHA;
  }
  await assert.rejects(planDeployment({env:{...env,GITHUB_REF:'refs/heads/development'},fetcher,git}),/main-branch/);
  await assert.rejects(planDeployment({env:{...env,GITHUB_SHA:initial},fetcher,git}),/checkout/);
  await finishDeployment({env:{...env,DEPLOYMENT_ID:'11',DEPLOY_OUTCOME:'failure'},fetcher});assert.equal(requests.at(-1).body.state,'failure','A failed upload never advances the successful baseline');
  await finishDeployment({env:{...env,DEPLOYMENT_ID:'11',DEPLOY_OUTCOME:'success'},fetcher});assert.equal(requests.at(-1).body.state,'success');
  console.log('PASS GitHub direct deployment: exact main checkout, unchanged-tree skips, all published inputs detected, and success recorded only after upload');
}finally{fs.rmSync(root,{recursive:true,force:true});}
