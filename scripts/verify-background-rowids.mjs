import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {githubBackgroundSqlite} from './lib/github-background-sqlite.mjs';
import {copyBackgroundStore} from './lib/github-background-restore.mjs';
import {exportBackgroundInventory,exportBackgroundTable} from '../worker/background-export.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/background-rowids-'));let source,copy;
try{
 source=githubBackgroundSqlite(path.join(root,'source.sqlite'));copy=githubBackgroundSqlite(path.join(root,'copy.sqlite'));
 for(const store of [source,copy])store.db.exec('CREATE TABLE retained(id INTEGER PRIMARY KEY,payload TEXT)');
 for(const id of [-10,0,7,42])source.db.prepare('INSERT INTO retained VALUES(?,?)').run(id,'retained-'+id);
 const writes=source.db.prepare('SELECT total_changes() n').get().n,cursors=[];
 const client=async input=>{if(!input.table)return exportBackgroundInventory(source.storage,['retained']);cursors.push(input.cursor);const page=exportBackgroundTable(source.storage.sql,['retained'],input.table,input.cursor),rows=page.rows.slice(0,2);return {ok:true,rows,cursor:rows.length?rows.at(-1).__migration_rowid:null};};
 await copyBackgroundStore(copy,client,{tables:['retained']});assert.deepEqual(copy.db.prepare('SELECT rowid,* FROM retained ORDER BY rowid').all(),source.db.prepare('SELECT rowid,* FROM retained ORDER BY rowid').all());assert.deepEqual(cursors,[null,0,42],'Zero is an advancing cursor; only null ends a page');assert.equal(source.db.prepare('SELECT total_changes() n').get().n,writes);
 await assert.rejects(copyBackgroundStore(copy,async input=>{const value=await client(input);delete value.rowidCursor;return value;},{tables:['retained']}),/inventory/);
 console.log('PASS background rowid transfer: negative and zero INTEGER PRIMARY KEY rows, zero at a page boundary, exact original rowids, zero source writes and rejection of incompatible legacy cursors');
}finally{await source?.close();await copy?.close();fs.rmSync(root,{recursive:true,force:true});}
