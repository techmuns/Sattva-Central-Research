import {exportBackgroundTable,exportBackgroundInventory} from './background-export.mjs';
export const SUMMARY_TABLES=['summary_meta','summary_records','summary_attempts','summary_inventory'];
export const SUMMARY_KEYS=['summary-timer'];
export async function exportSummaries(storage,{table=null,cursor=0}={}) {
  if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid summary migration cursor');
  return table?exportBackgroundTable(storage.sql,SUMMARY_TABLES,table,cursor):exportBackgroundInventory(storage,SUMMARY_TABLES,SUMMARY_KEYS);
}
