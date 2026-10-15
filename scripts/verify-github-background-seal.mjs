import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {sealBackgroundState,openBackgroundState,backgroundFileHash} from './lib/github-background-seal.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(resolve('.cache/github-job-seal-'));
const env={GITHUB_REPOSITORY:'fixture/research',BACKGROUND_STATE_KEY:'fixture-state-secret-1234567890'},feature='breakouts';
try {
  const source=join(root,'source.sqlite'),sealed=join(root,'sealed.bin'),opened=join(root,'opened.sqlite');
  const bytes=Buffer.from('PRIVATE SAVED OBSERVATION AND HISTORICAL RECEIPT\n'.repeat(20000));fs.writeFileSync(source,bytes);
  await assert.rejects(sealBackgroundState(source,source,feature,{env}));assert.deepEqual(fs.readFileSync(source),bytes);
  const previous=join(root,'previous.bin');fs.writeFileSync(previous,'previous complete state');
  await assert.rejects(sealBackgroundState(source,previous,feature,{env,maxPlainBytes:100}));assert.equal(fs.readFileSync(previous,'utf8'),'previous complete state');assert(!fs.existsSync(previous+'.sealing'));
  const hash=await sealBackgroundState(source,sealed,feature,{env});assert.equal(hash,await backgroundFileHash(sealed));assert(!fs.readFileSync(sealed).includes(Buffer.from('PRIVATE')));
  await openBackgroundState(sealed,opened,feature,{env});assert.deepEqual(fs.readFileSync(opened),bytes);
  const protectedFile=join(root,'protected.sqlite');fs.writeFileSync(protectedFile,'existing verified database');
  await assert.rejects(openBackgroundState(sealed,protectedFile,feature,{env:{...env,BACKGROUND_STATE_KEY:'incorrect-state-key-000000000000'}}));assert.equal(fs.readFileSync(protectedFile,'utf8'),'existing verified database');
  for(const [kind,options] of [['other-feature',{env}],['wrong-key',{env:{...env,BACKGROUND_STATE_KEY:'different-fixture-secret-00000000'}}],['wrong-repo',{env:{...env,GITHUB_REPOSITORY:'fixture/other-research'}}],['size-cap',{env,maxPlainBytes:100}]]) {
    const target=join(root,kind+'.sqlite');await assert.rejects(openBackgroundState(sealed,target,kind==='other-feature'?'summaries':feature,options));assert(!fs.existsSync(target));assert(!fs.existsSync(target+'.restoring'),'Unauthenticated or oversized state never replaces the next database');
  }
  const damaged=Buffer.from(fs.readFileSync(sealed));damaged[damaged.length-1]^=1;fs.writeFileSync(join(root,'damaged.bin'),damaged);
  await assert.rejects(openBackgroundState(join(root,'damaged.bin'),join(root,'damaged.sqlite'),feature,{env}));
  assert(!fs.existsSync(join(root,'damaged.sqlite')));assert(!fs.existsSync(join(root,'damaged.sqlite.restoring')));
  console.log('PASS encrypted GitHub background state: streaming round trip, private bytes absent, distinct repository/feature keys, corruption rejection and bounded decompression');
}finally{fs.rmSync(root,{recursive:true,force:true});}
