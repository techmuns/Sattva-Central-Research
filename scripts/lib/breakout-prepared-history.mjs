import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MINUTE_RETENTION_MS,MINUTE_RETENTION_DAYS} from '../../worker/breakout-archive.mjs';
export const breakoutRecordKey=(kind,value)=>createHash('sha256').update(`${kind}:${value}`).digest('hex');

// Normalize the already-retained source once on the runner. The derived index is
// disposable and stays outside the encrypted master; no Cloudflare query is used.
export function preparedBreakoutHistory(local,file,{now=Date.now()}={}) {
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.rmSync(file,{force:true});
  const db=new DatabaseSync(file);db.exec('CREATE TABLE history(ticker TEXT,at INTEGER,run TEXT,payload TEXT,PRIMARY KEY(ticker,at,run)); CREATE TABLE views(id TEXT PRIMARY KEY,payload TEXT)');
  const insert=db.prepare('INSERT INTO history VALUES(?,?,?,?)'),cutoff=now-MINUTE_RETENTION_MS;
  const metadata=new Map(local.db.prepare('SELECT day,key,payload FROM breakout_primary_metadata').all().map(row=>[`${row.day}:${row.key}`,row.payload]));
  db.exec('BEGIN');
  try {
    for(const row of local.db.prepare('SELECT ticker,at,run,payload FROM breakout_quotes').iterate())insert.run(row.ticker,row.at,row.run,row.payload);
    for(const row of local.db.prepare('SELECT ticker,at,run,payload FROM breakout_recovered').iterate())insert.run(row.ticker,row.at,'0'+row.run,row.payload);
    for(const row of local.db.prepare('SELECT ticker,at,payload FROM breakout_primary_events WHERE at<?').iterate(cutoff))insert.run(row.ticker,row.at,`9${row.at}:0`,row.payload);
    for(const row of local.db.prepare('SELECT at,payload FROM breakout_primary_history WHERE at>=?').iterate(cutoff)) {
      for(const [ticker,packed] of Object.entries(JSON.parse(row.payload))) {
        let value=packed;
        if(Array.isArray(packed)) {
          const [key,price,volume,quoteAt,checkedAt,feedAt]=packed,base=metadata.get(`${Math.floor(row.at/86400000)}:${key}`);
          if(!base)throw Error('Retained minute metadata unavailable');
          value={...JSON.parse(base),price,volume,quoteAt:new Date(quoteAt).toISOString(),checkedAt:new Date(checkedAt).toISOString(),...(feedAt?{feedAt:new Date(feedAt).toISOString()}:{})};
        }
        insert.run(ticker,row.at,`9${row.at}:0`,JSON.stringify(value));
      }
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
  const save=db.prepare('INSERT INTO views VALUES(?,?)'),identities=[];
  const put=(id,value)=>{save.run(id,JSON.stringify(value));identities.push(id);};
  const tickers=new Set(db.prepare('SELECT DISTINCT ticker FROM history').all().map(row=>row.ticker));
  for(const row of local.db.prepare('SELECT payload FROM breakout_primary_gap_archive').iterate())for(const value of Object.values(JSON.parse(row.payload)))if(value.ticker)tickers.add(value.ticker);
  for(const ticker of [...tickers].sort()) {
    const pages=[];let rows=[],bytes=2,hour=null,part=0;
    const flush=()=>{
      if(!rows.length)return;
      const id=breakoutRecordKey('history-page',`${ticker}:${hour}:${part++}`);
      put(id,{rows});pages.push({id,first:{at:rows[0].at,run:rows[0].run},last:{at:rows.at(-1).at,run:rows.at(-1).run}});rows=[];bytes=2;
    };
    for(const row of db.prepare('SELECT at,run,payload FROM history WHERE ticker=? ORDER BY at DESC,run DESC').iterate(ticker)) {
      const value={at:row.at,run:row.run,value:JSON.parse(row.payload)},size=Buffer.byteLength(JSON.stringify(value)),block=Math.floor(row.at/3600000);
      if(size>3*1024*1024)throw Error('One retained quote exceeds the prepared delivery budget');
      if(rows.length&&(block!==hour||bytes+size>3*1024*1024))flush();
      if(block!==hour){hour=block;part=0;}rows.push(value);bytes+=size;
    }
    flush();put(breakoutRecordKey('history',ticker),{minuteRetentionDays:MINUTE_RETENTION_DAYS,olderGapTotals:local.store.archive.gapTotals(ticker),pages});
  }
  db.exec('DROP TABLE history');
  return {ids:identities,put,read:id=>{const row=db.prepare('SELECT payload FROM views WHERE id=?').get(id);return row?JSON.parse(row.payload):null;},close:()=>db.close()};
}
