import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {githubBackgroundSqlite} from './lib/github-background-sqlite.mjs';
mkdirSync('.cache',{recursive:true});const root=mkdtempSync(resolve('.cache/github-job-sqlite-'));
let source,copy,onlineCopy;
try {
  const file=join(root,'state.sqlite');source=githubBackgroundSqlite(file);const {storage}=source;
  storage.sql.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY,value TEXT)');
  storage.transactionSync(()=>{storage.sql.exec('INSERT INTO observations VALUES(?,?)',1,'retained');storage.transactionSync(()=>storage.sql.exec('INSERT INTO observations VALUES(?,?)',2,'nested'));});
  assert.throws(()=>storage.transactionSync(()=>{storage.sql.exec('INSERT INTO observations VALUES(?,?)',3,'rolled back');throw Error('injected');}));
  assert.equal(storage.sql.exec('SELECT COUNT(*) n FROM observations').one().n,2);
  assert.throws(()=>storage.transactionSync(async()=>{}),/cannot await/);
  await storage.put('count',0);
  await Promise.all(Array.from({length:20},()=>storage.transaction(async tx=>{const count=await tx.get('count');await Promise.resolve();await tx.put('count',count+1);})));
  assert.equal(await storage.get('count'),20,'Concurrent KV claims serialize without losing updates');
  await assert.rejects(storage.transaction(async tx=>{await tx.put('count',999);await tx.setAlarm(123);storage.sql.exec('INSERT INTO observations VALUES(?,?)',3,'independent SQL');throw Error('injected');}));
  assert.equal(await storage.get('count'),20);assert.equal(await storage.getAlarm(),null);
  assert.equal(storage.sql.exec('SELECT value FROM observations WHERE id=3').one().value,'independent SQL','A failed awaiting KV transaction cannot roll back independently completed SQL work');
  const value={targets:['FIXTURE'],nested:{at:123}},queued=storage.put('inventory',value);value.targets.push('MUTATED');await queued;assert.deepEqual((await storage.get('inventory')).targets,['FIXTURE']);
  await storage.transaction(async tx=>{await tx.setAlarm(456);await tx.delete('count');});assert.equal(await storage.getAlarm(),456);assert.equal(await storage.get('count'),undefined);
  const checkpoint=join(root,'checkpoint.sqlite');await source.checkpoint(checkpoint);
  await storage.put('later',true);storage.sql.exec('UPDATE observations SET value=? WHERE id=1','changed after checkpoint');
  copy=githubBackgroundSqlite(checkpoint);assert.equal(await copy.storage.get('later'),undefined);assert.equal(copy.storage.sql.exec('SELECT value FROM observations WHERE id=1').one().value,'retained');assert.deepEqual(await copy.storage.get('inventory'),{targets:['FIXTURE'],nested:{at:123}});
  await source.close();source=githubBackgroundSqlite(file);assert.equal(await source.storage.get('later'),true);assert.equal(await source.storage.getAlarm(),456,'Restart preserves the runner deadline as metadata, with no external timer');
  source.db.exec('CREATE TABLE checkpoint_rows (key TEXT PRIMARY KEY,payload BLOB)');
  const insert=source.db.prepare('INSERT INTO checkpoint_rows(rowid,key,payload) VALUES(?,?,zeroblob(8192))');
  source.storage.transactionSync(()=>{for(let i=0;i<1200;i++)insert.run(i*3,String(i));});
  let ticks=0;const timer=setInterval(()=>{ticks++;},0),online=join(root,'online.sqlite');
  try{await source.checkpoint(online,{online:true});}finally{clearInterval(timer);}
  assert(ticks>0,'Online checkpoints yield to the quote/timer event loop while copying retained history');
  onlineCopy=githubBackgroundSqlite(online);assert.equal(onlineCopy.db.prepare('SELECT COUNT(*) n FROM checkpoint_rows').get().n,1200);
  assert.deepEqual(onlineCopy.db.prepare('SELECT rowid FROM checkpoint_rows ORDER BY rowid LIMIT 2').all().map(row=>row.rowid),[0,3],'Online copying preserves original rowid zero and gaps');
  assert.deepEqual(await onlineCopy.storage.get('inventory'),{targets:['FIXTURE'],nested:{at:123}});
  console.log('PASS local GitHub background state: SQL rollback, serialized KV claims, isolated asynchronous failures, immutable checkpoints and process restart');
}finally{await onlineCopy?.close();await copy?.close();await source?.close();rmSync(root,{recursive:true,force:true});}
