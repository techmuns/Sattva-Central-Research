// The caller supplies a literal allowlist and authenticates its fixed workflow.
// This helper never creates tables, alters data, exports arbitrary KV or arms an alarm.
export function exportBackgroundTable(sql,allowed,table,cursor=null) {
  if(!allowed.includes(table)||!/^[a-z_]+$/.test(table)||cursor!==null&&!Number.isSafeInteger(cursor))throw Error('Invalid background migration table or cursor');
  const rows=[],encoder=new TextEncoder();let bytes=2;
  const result=cursor===null?sql.exec(`SELECT rowid AS __migration_rowid,* FROM ${table} ORDER BY rowid LIMIT ?`,2000):sql.exec(`SELECT rowid AS __migration_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,cursor,2000);
  for(const row of result) {
    const size=encoder.encode(JSON.stringify(row)).byteLength+(rows.length?1:0);
    if(bytes+size>=2*1024*1024){if(!rows.length)throw Error('Background migration row too large');break;}
    rows.push(row);bytes+=size;
  }
  return {ok:true,rows,cursor:rows.length?rows.at(-1).__migration_rowid:null};
}
export async function exportBackgroundInventory(storage,tables,keys=[]) {
  const values=[];for(const key of keys){const value=await storage.get(key);if(value!==undefined)values.push({key,value});}
  const existing=new Set(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
  return {ok:true,rowidCursor:2,tables:tables.filter(table=>existing.has(table)).map(name=>({name,count:storage.sql.exec(`SELECT COUNT(*) n FROM ${name}`).one().n})),keys:values};
}
