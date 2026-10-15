import {PRIMARY_TIMER} from './breakout-primary.mjs';

export const BREAKOUT_TABLES=['breakout_runs','breakout_quotes','breakout_recovered','breakout_gaps','breakout_latest','breakout_failures','breakout_primary_current','breakout_primary_latest','breakout_primary_history','breakout_primary_metadata','breakout_primary_events','breakout_primary_signals','breakout_primary_cleanup','breakout_primary_quote_gaps','breakout_primary_gaps','breakout_primary_gap_archive','breakout_primary_gap_summary'];
const PARTS={capture:{tables:BREAKOUT_TABLES,keys:['breakout-timer']},primary:{tables:['upstox_config'],keys:[PRIMARY_TIMER]}};
// The caller must authenticate the fixed main-branch workflow before invoking
// this read-only helper. No arbitrary namespace, table or KV key is exportable.
export async function exportBreakouts(storage,{part='capture',table=null,cursor=0}={}) {
  const allowed=PARTS[part];
  if(!allowed||!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid migration cursor');
  const existing=new Set(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
  if(!table) {
    const keys=[];for(const key of allowed.keys){const value=await storage.get(key);if(value!==undefined)keys.push({key,value});}
    return {ok:true,part,tables:allowed.tables.filter(name=>existing.has(name)).map(name=>({name,count:storage.sql.exec(`SELECT COUNT(*) n FROM ${name}`).one().n})),keys};
  }
  if(!allowed.tables.includes(table)||!existing.has(table))throw Error('Invalid migration table');
  let limit=200,rows;
  while(limit) {
    rows=storage.sql.exec(`SELECT rowid AS __migration_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,cursor,limit).toArray();
    if(new TextEncoder().encode(JSON.stringify(rows)).byteLength<2*1024*1024)return {ok:true,part,rows,cursor:rows.length?rows.at(-1).__migration_rowid:null};
    limit=Math.floor(limit/2);
  }
  throw Error('Migration row exceeds transfer budget');
}
