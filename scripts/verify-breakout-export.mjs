import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {githubBackgroundSqlite} from './lib/github-background-sqlite.mjs';
import {BreakoutStore} from '../worker/breakout-store.mjs';
import {exportBreakouts,BREAKOUT_TABLES} from '../worker/breakout-export.mjs';
mkdirSync('.cache',{recursive:true});const root=mkdtempSync(resolve('.cache/breakout-export-'));let source,primary;
try {
  source=githubBackgroundSqlite(join(root,'source.sqlite'));new BreakoutStore(source.storage).init();
  source.db.exec('CREATE TABLE secret_settings (token TEXT)');source.db.prepare('INSERT INTO secret_settings VALUES(?)').run('must-not-export');
  for(let id=1;id<=430;id++)source.db.prepare('INSERT INTO breakout_runs VALUES(?,?,?,NULL)').run(`${id}:1`,id,JSON.stringify({targets:['TEST']}));
  await source.storage.put('breakout-timer',{lastDispatchAt:123});await source.storage.put('unrelated-secret','must-not-export');
  const before=source.db.prepare('SELECT total_changes() n').get().n;
  const storage={sql:source.storage.sql,get:source.storage.get,put(){throw Error('Export must never write KV');},setAlarm(){throw Error('Export must not arm a timer');}};
  const inventory=await exportBreakouts(storage);assert.equal(inventory.tables.find(row=>row.name==='breakout_runs').count,430);
  assert(inventory.tables.every(row=>BREAKOUT_TABLES.includes(row.name)));assert.deepEqual(inventory.keys,[{key:'breakout-timer',value:{lastDispatchAt:123}}]);
  const copied=[];let cursor=0;
  for(;;){const page=await exportBreakouts(storage,{table:'breakout_runs',cursor});copied.push(...page.rows);if(!page.cursor)break;assert(page.cursor>cursor);cursor=page.cursor;}
  assert.equal(copied.length,430);assert.deepEqual(copied.map(row=>row.__migration_rowid),Array.from({length:430},(_,i)=>i+1));
  assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before,'Inventory and paged transfer do not change SQL');
  for(const request of [{part:'other'},{table:'secret_settings'},{table:'github_job_kv'},{table:'breakout_runs; DROP TABLE breakout_runs'},{table:'breakout_runs',cursor:0.5},{table:'breakout_runs',cursor:1.5}])await assert.rejects(exportBreakouts(storage,request));
  primary=githubBackgroundSqlite(join(root,'primary.sqlite'));primary.db.exec('CREATE TABLE upstox_config (key TEXT,part INTEGER,payload TEXT)');primary.db.prepare('INSERT INTO upstox_config VALUES(?,?,?)').run('upstox-inventory',0,JSON.stringify({targets:[{ticker:'TEST'}]}));
  await primary.storage.put('upstox-minute-timer',{lastAttemptAt:123,reason:'ok'});
  const second=await exportBreakouts(primary.storage,{part:'primary'});assert.deepEqual(second.tables,[{name:'upstox_config',count:1}]);assert.deepEqual(second.keys,[{key:'upstox-minute-timer',value:{lastAttemptAt:123,reason:'ok'}}]);
  await assert.rejects(exportBreakouts(primary.storage,{part:'primary',table:'breakout_runs'}));
  console.log('PASS read-only breakout transfer: bounded paging, exact rowids/counts, independent primary configuration, retained timer metadata and no unrelated table/key access');
}finally{await source?.close();await primary?.close();rmSync(root,{recursive:true,force:true});}
