import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MutualFundsStore } from '../../worker/mutual-funds-store.mjs';
import { MutualFundsScannerStore } from '../../worker/mutual-funds-scanner-store.mjs';

// The existing disclosure/reconciliation rules run on the GitHub runner's disk.
// This adapter never connects to a Cloudflare database.
export function localMutualFunds(file) {
  mkdirSync(dirname(file), {recursive:true});
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE');
  let transactionDepth = 0;
  const storage = {
    sql: { exec(sql, ...args) {
      const rows = db.prepare(sql).all(...args);
      return {toArray:()=>rows, one:()=>{
        if(rows.length!==1)throw Error('Expected one row');return rows[0];
      }, [Symbol.iterator]:()=>rows[Symbol.iterator]()};
    } },
    transactionSync(fn) {
      if(transactionDepth)return fn();
      db.exec('BEGIN IMMEDIATE');transactionDepth++;
      try {const result=fn();db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}
      finally{transactionDepth--;}
    }
  };
  const primary = new MutualFundsStore(storage), scanner = new MutualFundsScannerStore(storage, primary);
  primary.scanner = scanner;
  const run = `${process.env.GITHUB_RUN_ID||Date.now()}:${process.env.GITHUB_RUN_ATTEMPT||1}`;
  const client = async body => {
    const {action}=body;
    if(action==='arm')return {ok:true,schedule:{runtime:'github-actions'}};
    if(action==='begin')return primary.begin(run,body.manifest);
    if(action==='reports')return primary.reports(run,body.reports);
    if(action==='fragment')return primary.fragment(run,body.fragment);
    if(action==='checkpoint')return primary.checkpoint(run,body.companies);
    if(action==='confirm')return primary.confirm(run,body.companies);
    if(action==='finish')return primary.finish(run);
    if(action==='scanner-inventory')return scanner.inventory(body.companies);
    if(action==='scanner-reserve')return scanner.reserve(run,body.requestId,body.kind);
    if(action==='scanner-complete')return scanner.complete(run,body.input);
    if(action==='scanner-status')return {ok:true,supplement:scanner.status()};
    throw Error('Unknown local collector action');
  };
  return {db,storage,primary,scanner,client,close:()=>db.close()};
}
