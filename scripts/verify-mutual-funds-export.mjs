import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {localMutualFunds} from './lib/mutual-funds-local.mjs';
import {exportMutualFunds} from '../worker/mutual-funds-export.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/mf-export-'));let local;
try {
  local=localMutualFunds(path.join(root,'source.sqlite'));local.primary.init();
  const small=local.db.prepare('INSERT INTO mf_meta VALUES(?,?)'),wide=local.db.prepare('INSERT INTO mf_parts VALUES(?,?,?,?)');
  local.storage.transactionSync(()=>{
    for(let n=0;n<2501;n++)small.run('fixture-'+n,'unchanged retained evidence');
    for(let n=0;n<400;n++)wide.run('1:1','INE090A01021',n,'अ'.repeat(4000));
  });
  const changes=local.db.prepare('SELECT total_changes() n').get().n;
  for(const [table,count] of [['mf_meta',2501],['mf_parts',400]]) {
    const copied=[];let cursor=0,pages=0;
    for(;;){const page=exportMutualFunds(local.storage.sql,table,cursor);pages++;assert(Buffer.byteLength(JSON.stringify(page.rows))<2*1024*1024,'Every response respects the byte ceiling, including Unicode');copied.push(...page.rows);if(!page.cursor)break;assert(page.cursor>cursor);cursor=page.cursor;}
    assert.equal(copied.length,count);assert.deepEqual(copied.map(row=>row.__migration_rowid),Array.from({length:count},(_,n)=>n+1),'No rows are lost or repeated at a byte-boundary page');
    if(table==='mf_meta')assert.equal(pages,3,'Small rows transfer in larger batches instead of thousands of tiny requests');
    else assert(pages>2,'Wide revisions stop at the byte limit before the row limit');
  }
  assert.equal(local.db.prepare('SELECT total_changes() n').get().n,changes,'Every export is read-only');
  for(const [table,cursor] of [['other',0],['mf_meta',-1],['mf_meta',0.5]])assert.throws(()=>exportMutualFunds(local.storage.sql,table,cursor));
  small.run('oversized','x'.repeat(2*1024*1024));assert.throws(()=>exportMutualFunds(local.storage.sql,'mf_meta',2501),/row too large/);
  console.log('PASS retained MF transfer: larger small-row batches, bounded Unicode/wide-row pages, exact cursor continuity, no source writes and oversized-row rejection');
}finally{local?.close();fs.rmSync(root,{recursive:true,force:true});}
