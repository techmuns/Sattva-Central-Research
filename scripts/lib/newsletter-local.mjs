import {NEWSLETTER_GITHUB_PDF_BYTES} from '../../worker/newsletter-document.mjs';
import {githubBackgroundSqlite} from './github-background-sqlite.mjs';
import {NewsletterStore} from '../../worker/newsletter-store.mjs';
import {NewsletterSchedule} from '../../worker/newsletter-schedule.mjs';
export function localNewsletter(file,{env=process.env,now=Date.now,fetcher=fetch}={}){
 const local=githubBackgroundSqlite(file),store=new NewsletterStore(local.storage,{now,maxDocumentBytes:NEWSLETTER_GITHUB_PDF_BYTES});store.init();
 const schedule=new NewsletterSchedule(local.storage,env,store,{now,fetcher});schedule.content.meta();schedule.content.newsBudget.status(now());
 local.db.exec('CREATE TABLE IF NOT EXISTS newsletter_requests(id TEXT PRIMARY KEY,state TEXT NOT NULL,result TEXT,at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS newsletter_request_intents(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS newsletter_views(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
 async function applyInputs(input){
  if(input?.ok!==true||!Array.isArray(input.subscribers)||input.meta!==null&&typeof input.meta!=='object')throw Error('Newsletter input unavailable');
  const revision=input.meta?.revision||0,prior=await local.storage.get('newsletter-source-revision');
  if(prior!==undefined&&revision<prior)throw Error('Newsletter inputs moved backwards');if(prior===revision)return;
  local.storage.transactionSync(()=>{
   local.db.exec('DELETE FROM newsletter_subscribers');const insert=local.db.prepare('INSERT INTO newsletter_subscribers VALUES(?,?,?,?,?,?,?,?,?,?)');
   for(const row of input.subscribers)insert.run(row.email,row.name,row.editions,row.state,row.added_at,row.added_by,row.removed_at,row.removed_by,row.updated_at,row.seq);
   const meta=store.meta();store.putMeta({...meta,revision:Math.max(meta.revision||0,revision),settings:input.meta?.settings||null,updatedAt:input.meta?.updatedAt||meta.updatedAt,seq:input.meta?.seq||0});
  });await local.storage.put('newsletter-source-revision',revision);
 }
 return {...local,store,schedule,applyInputs};
}
