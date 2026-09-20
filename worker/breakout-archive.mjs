import { liveBreakout } from '../public/js/data/breakout-live-shared.js';
import { contentTag } from './http.mjs';

const DAY=86400000;
export const MINUTE_RETENTION_DAYS=4;
export const MINUTE_RETENTION_MS=MINUTE_RETENTION_DAYS*DAY;
export const primaryBucket=ticker=>[...ticker].reduce((n,c)=>(n*31+c.charCodeAt(0))%16,0);

// Server-only archive. The dashboard's current-price response never reads these tables.
export class MinuteArchive {
  constructor(storage,{tag=contentTag}={}) { this.storage=storage;this.tag=tag; }
  init() {
    const sql=this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_primary_history (bucket INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(bucket,at))');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_primary_metadata (day INTEGER NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(day,key))');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_primary_events (ticker TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(ticker,at))');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_primary_signals (ticker TEXT PRIMARY KEY, quality TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_primary_cleanup (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)');
  }
  save(rows,at,accepted) {
    const sql=this.storage.sql,day=Math.floor(at/DAY),buckets=new Map();
    const signals=new Map(sql.exec('SELECT ticker,quality FROM breakout_primary_signals').toArray().map(r=>[r.ticker,r.quality]));
    for(const original of rows) {
      let row=original;
      const quality=liveBreakout(row)?.quality,previous=signals.get(row.ticker);
      if(accepted.has(row.ticker) && quality && quality!==previous) {
        sql.exec('INSERT INTO breakout_primary_signals VALUES(?,?) ON CONFLICT(ticker) DO UPDATE SET quality=excluded.quality',row.ticker,quality);
        // The first non-breakout merely establishes a baseline. Entries, exits and
        // subsequent quality changes retain their observed quote beyond four days.
        if(previous || quality!=='no_breakout') {
          row={...row,breakoutChange:{from:previous || null,to:quality,detectedAt:new Date(at).toISOString()}};
          sql.exec('INSERT INTO breakout_primary_events VALUES(?,?,?)',row.ticker,at,JSON.stringify(row));
        }
      }
      const {price,volume,quoteAt,checkedAt,...metadata}=row;
      const payload=JSON.stringify(metadata),hash=this.tag(payload);
      let key=hash,collision=0;
      for(;;) {
        const old=sql.exec('SELECT payload FROM breakout_primary_metadata WHERE day=? AND key=?',day,key).toArray()[0];
        if(!old) {sql.exec('INSERT INTO breakout_primary_metadata VALUES(?,?,?)',day,key,payload);break;}
        if(old.payload===payload)break;
        key=`${hash}:${++collision}`; // A hash collision must never substitute another company's base.
      }
      const bucket=primaryBucket(row.ticker);
      if(!buckets.has(bucket))buckets.set(bucket,{});
      buckets.get(bucket)[row.ticker]=[key,price,volume,Date.parse(quoteAt),Date.parse(checkedAt)];
    }
    for(const [bucket,payload] of buckets)sql.exec('INSERT INTO breakout_primary_history VALUES(?,?,?)',bucket,at,JSON.stringify(payload));
  }
  decode(payload,at) {
    const value=JSON.parse(payload);
    if(!Array.isArray(value))return value; // Existing full-row snapshots remain readable until expiry.
    const [key,price,volume,quoteAt,checkedAt]=value;
    const metadata=this.storage.sql.exec('SELECT payload FROM breakout_primary_metadata WHERE day=? AND key=?',Math.floor(at/DAY),key).toArray()[0];
    if(!metadata)throw Error('Minute metadata unavailable');
    return {...JSON.parse(metadata.payload),price,volume,quoteAt:new Date(quoteAt).toISOString(),checkedAt:new Date(checkedAt).toISOString()};
  }
  prune(now) {
    this.init();
    const sql=this.storage.sql,last=sql.exec('SELECT at FROM breakout_primary_cleanup WHERE id=1').toArray()[0];
    if(last && now-last.at<15*60000)return {ok:true};
    // Cleanup is independent of successful quotes and runs even on holidays or outages.
    // Keep the cutoff day's dictionary: an observation from that day may still be retained.
    return this.storage.transactionSync(()=>{
      const cutoff=now-MINUTE_RETENTION_MS;
      for(let bucket=0;bucket<16;bucket++)sql.exec('DELETE FROM breakout_primary_history WHERE bucket=? AND at<?',bucket,cutoff);
      sql.exec('DELETE FROM breakout_primary_metadata WHERE day<?',Math.floor(cutoff/DAY));
      sql.exec('INSERT INTO breakout_primary_cleanup VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at',now);
      return {ok:true};
    });
  }
}
