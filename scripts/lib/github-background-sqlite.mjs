import {DatabaseSync,backup as onlineBackup} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// Runner-local SQL and durable KV, with the narrow storage interface used by
// the existing pure collectors. No network or Cloudflare binding is involved.
export function githubBackgroundSqlite(file) {
  mkdirSync(dirname(file),{recursive:true});
  const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE');
  db.exec('CREATE TABLE IF NOT EXISTS github_job_kv (key TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  let depth=0,tail=Promise.resolve();
  const clone=value=>value===undefined?undefined:structuredClone(value);
  const encode=value=>{const text=JSON.stringify(value);if(text===undefined)throw Error('Invalid stored value');return text;};
  const sync=fn=>{
    if(fn.constructor.name==='AsyncFunction')throw Error('Synchronous transaction cannot await');
    if(depth)return fn();
    db.exec('BEGIN IMMEDIATE');depth++;
    try{const value=fn();if(value?.then)throw Error('Synchronous transaction cannot await');db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}finally{depth--;}
  };
  const serial=fn=>{const work=tail.then(fn);tail=work.catch(()=>{});return work;};
  const read=key=>{const row=db.prepare('SELECT payload FROM github_job_kv WHERE key=?').get(key);return row?JSON.parse(row.payload):undefined;};
  const write=(key,value)=>db.prepare('INSERT INTO github_job_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key,encode(value));
  const alarm='__github_job_alarm';
  const storage={
    sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args);return {toArray:()=>rows,one:()=>{if(rows.length!==1)throw Error('Expected one row');return rows[0];},[Symbol.iterator]:()=>rows[Symbol.iterator]()};}},
    transactionSync:sync,
    get:key=>serial(()=>clone(read(key))),
    put:(key,value)=>{const copied=clone(value);encode(copied);return serial(()=>{write(key,copied);});},
    delete:key=>serial(()=>db.prepare('DELETE FROM github_job_kv WHERE key=?').run(key).changes>0),
    getAlarm:()=>serial(()=>read(alarm)??null),
    setAlarm:value=>serial(()=>{const at=Number(value);if(!Number.isFinite(at))throw Error('Invalid alarm deadline');write(alarm,at);}),
    deleteAlarm:()=>serial(()=>{db.prepare('DELETE FROM github_job_kv WHERE key=?').run(alarm);}),
    transaction:fn=>serial(async()=>{
      // Stage KV changes outside a SQL transaction. SQL-only collector tasks may
      // continue while the callback awaits, without joining or rolling back it.
      const snapshot=new Map(db.prepare('SELECT key,payload FROM github_job_kv').all().map(row=>[row.key,JSON.parse(row.payload)])),changed=new Set();
      const tx={
        get:key=>clone(snapshot.get(key)),
        put:(key,value)=>{encode(value);snapshot.set(key,clone(value));changed.add(key);},
        delete:key=>{const had=snapshot.delete(key);changed.add(key);return had;},
        getAlarm:()=>snapshot.get(alarm)??null,
        setAlarm:value=>{const at=Number(value);if(!Number.isFinite(at))throw Error('Invalid alarm deadline');snapshot.set(alarm,at);changed.add(alarm);},
        deleteAlarm:()=>{snapshot.delete(alarm);changed.add(alarm);},
      };
      const value=await fn(tx);
      sync(()=>{for(const key of changed)if(snapshot.has(key))write(key,snapshot.get(key));else db.prepare('DELETE FROM github_job_kv WHERE key=?').run(key);});
      return value;
    }),
  };
  return {db,storage,
    async checkpoint(destination,{online=false}={}){await tail;if(depth||existsSync(destination)||resolve(destination)===resolve(file))throw Error('Invalid checkpoint destination');mkdirSync(dirname(destination),{recursive:true});if(online)await onlineBackup(db,destination,{rate:128});else db.prepare('VACUUM INTO ?').run(destination);},
    async close(){await tail;db.close();},
  };
}
