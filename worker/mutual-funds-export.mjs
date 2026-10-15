export const MF_TABLES=['mf_meta','mf_companies','mf_revisions','mf_runs','mf_received','mf_funds','mf_observations','mf_observation_revisions','mf_uploads','mf_parts','mf_reports','mf_report_receipts','mf_scanner_meta','mf_scanner_targets','mf_scanner_funds','mf_scanner_points','mf_scanner_history'];

// Read-only, main-workflow-authenticated transfer. Nothing is deleted, armed,
// initialized or updated in the old store while its history is copied.
export function exportMutualFunds(sql,table=null,cursor=0) {
  const existing=new Set(sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(r=>r.name));
  if(!table)return {ok:true,tables:MF_TABLES.filter(t=>existing.has(t)).map(name=>({name,count:sql.exec(`SELECT COUNT(*) AS n FROM ${name}`).one().n}))};
  if(!MF_TABLES.includes(table)||!existing.has(table)||!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid migration cursor');
  const rows=[],encoder=new TextEncoder();let bytes=2;
  // Consume the cursor synchronously, keeping at most one bounded response in
  // memory. Tiny observation rows can share a request; wide company revisions
  // stop at the same byte ceiling without repeated queries of the same rows.
  for(const row of sql.exec(`SELECT rowid AS __migration_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,cursor,2000)) {
    const size=encoder.encode(JSON.stringify(row)).byteLength+(rows.length?1:0);
    if(bytes+size>=2*1024*1024){if(!rows.length)throw Error('Migration row too large');break;}
    rows.push(row);bytes+=size;
  }
  return {ok:true,rows,cursor:rows.length?rows.at(-1).__migration_rowid:null};
}
