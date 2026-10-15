import {githubBackgroundSqlite} from './github-background-sqlite.mjs';
import {PriceLevelStore} from '../../worker/price-levels-store.mjs';
import {PriceLevelSchedule} from '../../worker/price-levels-schedule.mjs';

export function localPriceLevels(file,{env=process.env,now=Date.now,fetcher=fetch}={}) {
 const local=githubBackgroundSqlite(file),store=new PriceLevelStore(local.storage,{now});store.init();
 const schedule=new PriceLevelSchedule(local.storage,env,store,{now,fetcher});
 function reconcile(input){
  if(input?.ok!==true||!Number.isSafeInteger(input.revision)||input.revision<0||!Array.isArray(input.companies)||!Array.isArray(input.levels)||input.companies.length>100000||input.levels.length>3000)throw Error('Invalid price-level inputs');
  const previous=local.db.prepare("SELECT payload FROM github_job_kv WHERE key=?").get('price-level-source-revision');
  const revision=previous?JSON.parse(previous.payload):null;
  if(revision!==null&&input.revision<revision)throw Error('Price-level source revision moved backwards');
  if(revision===input.revision)return false;
  const old=new Map(local.db.prepare('SELECT * FROM price_levels').all().map(row=>[`${row.ticker}:${row.level}`,row]));
  local.storage.transactionSync(()=>{
   local.db.exec('DELETE FROM price_levels;DELETE FROM price_level_companies');
   const company=local.db.prepare('INSERT INTO price_level_companies VALUES(?,?,?,?,?,?)'),level=local.db.prepare('INSERT INTO price_levels VALUES(?,?,?,?,?,?,?,?)');
   for(const row of input.companies)company.run(row.ticker,row.isin,row.name,row.state,row.updated_at,row.seq);
   for(const row of input.levels){
    const prior=old.get(`${row.ticker}:${row.level}`),same=prior?.value===row.value&&prior.set_at===row.set_at;
    const value=same&&prior.reached_at?prior:row;
    level.run(row.ticker,row.level,row.value,row.set_at,value.reached_at,value.reached_price,value.reached_basis,value.reached_session);
   }
   const meta=store.meta();store.putMeta({...meta,revision:meta.revision+1,updatedAt:input.companies.reduce((at,row)=>row.updated_at>at?row.updated_at:at,meta.updatedAt||'')||null});
  });
  return true;
 }
 async function applyInputs(input){const changed=reconcile(input);if(changed)await local.storage.put('price-level-source-revision',input.revision);return changed;}
 return {...local,store,schedule,applyInputs};
}
