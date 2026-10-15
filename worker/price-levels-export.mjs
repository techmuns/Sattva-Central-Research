import {exportBackgroundInventory,exportBackgroundTable} from './background-export.mjs';
export const LEVEL_TABLES=['price_level_meta','price_level_companies','price_levels','price_level_hits'];
export const LEVEL_KEYS=['price-level-timer'];
// Fixed workflow only. Inputs remain the immediate interactive source of truth;
// quote checks and newly observed hits never write back into this source.
export async function exportPriceLevels(storage,{table=null,cursor=null,inputs=false}={}) {
 const existing=new Set(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
 if(inputs){
  if(!LEVEL_TABLES.some(table=>existing.has(table)))return {ok:true,revision:0,companies:[],levels:[]};
  if(!LEVEL_TABLES.every(table=>existing.has(table)))throw Error('Incomplete price-level input schema');
  const meta=storage.sql.exec("SELECT value FROM price_level_meta WHERE key='state'").toArray()[0];
  return {ok:true,revision:meta?JSON.parse(meta.value).revision:0,companies:storage.sql.exec('SELECT * FROM price_level_companies ORDER BY ticker').toArray(),levels:storage.sql.exec('SELECT * FROM price_levels ORDER BY ticker,level').toArray()};
 }
 return table?exportBackgroundTable(storage.sql,LEVEL_TABLES,table,cursor):exportBackgroundInventory(storage,LEVEL_TABLES,LEVEL_KEYS);
}
