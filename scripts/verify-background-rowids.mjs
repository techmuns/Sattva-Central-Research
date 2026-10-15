import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {githubBackgroundSqlite} from './lib/github-background-sqlite.mjs';
import {copyBackgroundStore} from './lib/github-background-restore.mjs';
import {exportBackgroundInventory,exportBackgroundTable} from '../worker/background-export.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/background-rowids-'));let source,copy;
try{
 source=githubBackgroundSqlite(path.join(root,'source.sqlite'));copy=githubBackgroundSqlite(path.join(root,'copy.sqlite'));
 for(const store of [source,copy])store.db.exec('CREATE TABLE retained(id INTEGER PRIMARY KEY,payload TEXT)');
 for(const id of [-10,0,7,42])source.db.prepare('INSERT INTO retained VALUES(?,?)').run(id,'retained-'+id);
 const writes=source.db.prepare('SELECT total_changes() n').get().n,cursors=[];
 const client=async input=>{if(!input.table)return exportBackgroundInventory(source.storage,['retained']);cursors.push(input.cursor);const page=exportBackgroundTable(source.storage.sql,['retained'],input.table,input.cursor),rows=page.rows.slice(0,2);return {ok:true,rows,cursor:rows.length?rows.at(-1).__migration_rowid:null};};
 await copyBackgroundStore(copy,client,{tables:['retained']});assert.deepEqual(copy.db.prepare('SELECT rowid,* FROM retained ORDER BY rowid').all(),source.db.prepare('SELECT rowid,* FROM retained ORDER BY rowid').all());assert.deepEqual(cursors,[null,0,42],'Zero is an advancing cursor; only null ends a page');assert.equal(source.db.prepare('SELECT total_changes() n').get().n,writes);
 await assert.rejects(copyBackgroundStore(copy,async input=>{const value=await client(input);delete value.rowidCursor;return value;},{tables:['retained']}),/inventory/);
 for(const store of [source,copy])store.db.exec('CREATE TABLE framed(bucket INTEGER PRIMARY KEY,at INTEGER,payload TEXT)');
 for(const id of [1,2])source.db.prepare('INSERT INTO framed VALUES(?,?,?)').run(id,1792080000000,'x'.repeat(1048486));
 const framedWrites=source.db.prepare('SELECT total_changes() n').get().n;
 await copyBackgroundStore(copy,async input=>{
  if(!input.table)return exportBackgroundInventory(source.storage,['framed']);
  const wire=JSON.stringify({...exportBackgroundTable(source.storage.sql,['framed'],input.table,input.cursor),part:'capture'});
  assert(Buffer.byteLength(wire)<=2*1024*1024,'The complete response, including its wrapper, fits the receiver budget');
  return boundedJson(new Response(wire),2*1024*1024);
 },{tables:['framed']});
 assert.deepEqual(copy.db.prepare('SELECT rowid,* FROM framed ORDER BY rowid').all(),source.db.prepare('SELECT rowid,* FROM framed ORDER BY rowid').all());
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,framedWrites,'Framed transfer performs no source writes');
 console.log('PASS background rowid transfer: negative and zero INTEGER PRIMARY KEY rows, zero at a page boundary, exact original rowids, zero source writes and rejection of incompatible legacy cursors');
 console.log('PASS complete export framing fits the 2 MiB transport limit and retains both boundary-sized rows through actual bounded JSON decoding');
}finally{await source?.close();await copy?.close();fs.rmSync(root,{recursive:true,force:true});}
