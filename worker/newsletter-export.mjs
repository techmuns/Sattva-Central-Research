import {exportBackgroundInventory,exportBackgroundTable} from './background-export.mjs';
import {encode64,hash} from './mutual-funds-seal.mjs';
export const NEWSLETTER_TABLES=['newsletter_meta','newsletter_subscribers','newsletter_deliveries','newsletter_reported','newsletter_manual_attempts','newsletter_documents','newsletter_content','newsletter_content_meta','newsletter_news_ai_calls','newsletter_news_ai_cache'];
export const NEWSLETTER_KEYS=['newsletter-timer'];
export async function exportNewsletter(storage,{table=null,cursor=0,inputs=false}={}){
 if(inputs){
  const existing=new Set(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
  const meta=existing.has('newsletter_meta')?storage.sql.exec("SELECT value FROM newsletter_meta WHERE key='state'").toArray()[0]?.value:null;
  return {ok:true,meta:meta?JSON.parse(meta):null,subscribers:existing.has('newsletter_subscribers')?storage.sql.exec('SELECT * FROM newsletter_subscribers ORDER BY email').toArray():[]};
 }
 if(!table){const inventory=await exportBackgroundInventory(storage,NEWSLETTER_TABLES,NEWSLETTER_KEYS);const input=await exportNewsletter(storage,{inputs:true});return {...inventory,inputMeta:input.meta};}
 if(!NEWSLETTER_TABLES.includes(table)||!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid newsletter transfer table');
 if(table!=='newsletter_documents')return exportBackgroundTable(storage.sql,NEWSLETTER_TABLES,table,cursor);
 const row=storage.sql.exec('SELECT rowid AS __migration_rowid,* FROM newsletter_documents WHERE rowid>? ORDER BY rowid LIMIT 1',cursor).toArray()[0];
 if(!row)return {ok:true,rows:[],cursor:null};
 const bytes=new Uint8Array(row.body);if(bytes.length>1500000)throw Error('Retained PDF exceeds original source limit');
 return {ok:true,rows:[{...row,body:{blob64:encode64(bytes),bytes:bytes.length,hash:await hash(bytes)}}],cursor:row.__migration_rowid};
}
