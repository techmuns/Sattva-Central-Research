// Copy only the named application's tables into a new runner database. The
// source is read twice for a quiescent inventory; any mismatch stops the copy.
export async function copyBackgroundStore(local,legacyClient,{tables,keys=[],decode=value=>value,onProgress=()=>{}}) {
  if(!Array.isArray(tables)||!tables.length||new Set(tables).size!==tables.length||tables.some(table=>typeof table!=='string'||!/^[a-z_]+$/.test(table)))throw Error('Invalid background table allowlist');
  const inventory=await legacyClient({action:'export'});
  if(inventory?.ok!==true||inventory.rowidCursor!==2||!Array.isArray(inventory.tables)||!Array.isArray(inventory.keys)||new Set(inventory.tables.map(row=>row.name)).size!==inventory.tables.length||new Set(inventory.keys.map(row=>row.key)).size!==inventory.keys.length)throw Error('Invalid background migration inventory');
  if(inventory.tables.map(row=>row.name).sort().join(',')!==[...tables].sort().join(','))throw Error('Background source table inventory is incomplete');
  for(const {name,count} of inventory.tables)if(!tables.includes(name)||!Number.isSafeInteger(count)||count<0)throw Error('Unknown background source table');
  for(const value of inventory.keys)if(!keys.includes(value.key)||value.value===undefined)throw Error('Unknown background source key');
  const existing=new Set(local.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  if(tables.some(table=>!existing.has(table)))throw Error('Background schema is not initialized');
  local.storage.transactionSync(()=>{for(const table of tables)local.db.exec(`DELETE FROM ${table}`);});
  for(const {name,count} of inventory.tables) {
    const columns=local.db.prepare(`PRAGMA table_info(${name})`).all().map(row=>row.name),expected=[...columns,'__migration_rowid'].sort().join(',');
    const insert=local.db.prepare(`INSERT INTO ${name}(rowid,${columns.map(column=>`"${column}"`).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
    let cursor=null,received=0;
    onProgress({table:name,received,total:count});let reportedAt=Date.now();
    for(;;) {
      const page=await legacyClient({action:'export',table:name,cursor});
      if(page?.ok!==true||!Array.isArray(page.rows)||page.rows.length>2000)throw Error('Invalid background migration page');
      local.storage.transactionSync(()=>{
        for(const row of page.rows) {
          if(Object.keys(row).sort().join(',')!==expected||!Number.isSafeInteger(row.__migration_rowid)||cursor!==null&&row.__migration_rowid<=cursor)throw Error('Background migration schema or cursor changed');
          insert.run(row.__migration_rowid,...columns.map(column=>decode(row[column]??null,name,column)));
        }
      });
      received+=page.rows.length;
      if(Date.now()-reportedAt>=30000){onProgress({table:name,received,total:count});reportedAt=Date.now();}
      if(page.cursor===null)break;
      if(!page.rows.length||page.cursor!==page.rows.at(-1).__migration_rowid||cursor!==null&&page.cursor<=cursor)throw Error('Background migration did not advance');cursor=page.cursor;
    }
    onProgress({table:name,received,total:count});
    if(received!==count||local.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n!==count)throw Error('Background migration count mismatch');
  }
  if(JSON.stringify(await legacyClient({action:'export'}))!==JSON.stringify(inventory))throw Error('Background source changed during migration');
  for(const {key,value} of inventory.keys)await local.storage.put(key,value);
  if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Background migration database invalid');
  return inventory;
}
