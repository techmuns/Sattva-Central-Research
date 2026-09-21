import { boundedJson } from '../public/js/data/family-book-contract.js';
import { BREAKOUT_OBJECT, BREAKOUT_LIMIT, tickerValid, marketWindow, expectedSession, quoteFresh, istDate } from '../public/js/data/breakout-live-shared.js';
import { mapUpstoxTargets, upstoxIdentity, upstoxRows } from './upstox-market.mjs';

export const PRIMARY_OBJECT = 'breakout-upstox:v1';
export const PRIMARY_TIMER = 'upstox-minute-timer';
export const PRIMARY_INTERVAL = 60000;
export const PRIMARY_MAX_AGE = 120000;
const INVENTORY = 'upstox-inventory';
const UPSTOX_CLIENT = 'SattvaCentralResearch/1.0';
const MAPPING_VERSION = 2;

export function primaryInventory(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > BREAKOUT_LIMIT || new Set(targets.map(t => t.ticker)).size !== targets.length) throw Error('Invalid inventory');
  return targets.map(t => {
    if (!tickerValid(t.ticker) || (t.isin && !/^IN[A-Z0-9]{10}$/.test(t.isin)) || (t.yahooTicker && !tickerValid(t.yahooTicker))) throw Error('Invalid identity');
    return {ticker:t.ticker,name:String(t.name || t.ticker).slice(0,180),...(t.isin ? {isin:t.isin} : {}),...(t.yahooTicker ? {yahooTicker:t.yahooTicker} : {})};
  });
}

// Native Worker streams; no Node zlib or redirects carrying the credential.
export async function cashInstruments(stream, exchange) {
  const reader=stream.getReader(), decoder=new TextDecoder(), rows=[];
  let pending='', cursor=0, start=-1, depth=0, quoted=false, escaped=false, phase='start', bytes=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (value) {bytes+=value.byteLength;if(bytes>100*1024*1024)throw Error('Instrument list too large');}
      pending+=decoder.decode(value || new Uint8Array(),{stream:!done});
      for (;cursor<pending.length;cursor++) {
        const c=pending[cursor];
        if (start>=0) {
          if (quoted) {if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
          else if(c==='"')quoted=true;
          else if(c==='{' || c==='[')depth++;
          else if(c==='}' || c===']')depth--;
          if (!depth) {
            const item=JSON.parse(pending.slice(start,cursor+1));
            if (item.segment===`${exchange}_EQ` || (exchange==='SUSPENDED' && ['NSE_EQ','BSE_EQ'].includes(item.segment))) rows.push({segment:item.segment,instrument_type:item.instrument_type,instrument_key:item.instrument_key,trading_symbol:item.trading_symbol,exchange_token:item.exchange_token});
            start=-1;phase='comma';
          }
        } else if (/\s/.test(c)) continue;
        else if (phase==='start' && c==='[') phase='first';
        else if (['first','item'].includes(phase) && c==='{') {start=cursor;depth=1;quoted=false;escaped=false;}
        else if (['first','comma'].includes(phase) && c===']') phase='done';
        else if (phase==='comma' && c===',') phase='item';
        else throw Error('Invalid instrument list');
      }
      if(start>=0){pending=pending.slice(start);cursor=pending.length;start=0;if(pending.length>64000)throw Error('Instrument too large');}
      else {pending='';cursor=0;}
      if(done){if(phase!=='done' || start>=0)throw Error('Incomplete instrument list');return rows;}
    }
  } finally {await reader.cancel().catch(()=>{});}
}
export async function primaryInstruments(exchange, fetcher = fetch) {
  // Native Workers fetch has no default User-Agent. Upstox's CDN rejects the
  // anonymous request; identify this application without impersonating a browser.
  if (!['NSE','BSE','SUSPENDED'].includes(exchange)) throw Error('Invalid exchange');
  const file = exchange==='SUSPENDED' ? 'suspended-instrument' : exchange;
  const response = await fetcher(`https://assets.upstox.com/market-quote/instruments/exchange/${file}.json.gz`, {headers:{'user-agent':UPSTOX_CLIENT},redirect:'manual',signal:AbortSignal.timeout(12000)});
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('instrument-list-unavailable'); }
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return cashInstruments(stream,exchange);
}

export async function minuteQuotes(mapped, bases, token, {fetcher = fetch, now = Date.now} = {}) {
  const rows = []; let reason = null;
  for (let offset=0; offset<mapped.length; offset+=500) {
    const batch = mapped.slice(offset,offset+500), url = new URL('https://api.upstox.com/v2/market-quote/quotes');
    url.searchParams.set('instrument_key',[...new Set(batch.map(t=>t.instrumentKey))].join(','));
    try {
      const response = await fetcher(url,{headers:{authorization:`Bearer ${token}`,accept:'application/json','user-agent':UPSTOX_CLIENT},redirect:'manual',signal:AbortSignal.timeout(10000)});
      if (!response.ok) {
        reason = [401,403].includes(response.status) ? 'authentication' : response.status === 429 ? 'rate-limited' : 'unavailable';
        await response.body?.cancel(); break;
      }
      rows.push(...upstoxRows(await boundedJson(response,4*1024*1024),batch,bases,now()));
    } catch { reason='unavailable'; break; }
  }
  return {rows,reason};
}

// A distinct object owns this alarm. The existing 15-minute GitHub watchdog keeps its own alarm.
export class BreakoutPrimary {
  constructor(storage, env, {now=Date.now,fetcher=fetch,instruments=primaryInstruments,quotes=minuteQuotes,store}={}) {
    this.storage=storage; this.env=env; this.now=now; this.fetcher=fetcher; this.instruments=instruments; this.quotes=quotes;
    this.store=store || (()=>env.CAPTURE_REGISTRY.getByName(BREAKOUT_OBJECT));
  }
  config(key) {
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS upstox_config (key TEXT NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(key,part))');
    const rows=this.storage.sql.exec('SELECT payload FROM upstox_config WHERE key=? ORDER BY part',key).toArray();
    return rows.length ? JSON.parse(rows.map(r=>r.payload).join('')) : null;
  }
  saveConfig(key,value) {
    this.config(key);
    const text=JSON.stringify(value);
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('DELETE FROM upstox_config WHERE key=?',key);
      for(let at=0,part=0;at<text.length;at+=32000,part++) this.storage.sql.exec('INSERT INTO upstox_config VALUES(?,?,?)',key,part,text.slice(at,at+32000));
    });
  }
  async status() {
    const state=await this.storage.get(PRIMARY_TIMER) || {started:false};
    const alarmAt=await this.storage.getAlarm();
    return {...state,configured:!!this.env.UPSTOX_ACCESS_TOKEN,alarmAt,
      overdue:!!state.started && (alarmAt===null || this.now()>state.nextAt+PRIMARY_MAX_AGE)};
  }
  async arm() {
    await this.storage.transaction(async tx=>{
      const state=await tx.get(PRIMARY_TIMER);
      if (!state) await tx.put(PRIMARY_TIMER,{started:true,nextAt:this.now()+1000});
      if (await tx.getAlarm()===null) await tx.setAlarm(Math.max(this.now()+1000,state?.nextAt || 0));
    });
    return this.status();
  }
  async inventory(targets, discoveryFailed=false) {
    let clean=primaryInventory(targets);
    if(discoveryFailed) {
      const retained=new Map((this.config(INVENTORY)?.targets || []).map(t=>[t.ticker,t]));
      for(const target of clean) {
        const previous=retained.get(target.ticker);
        retained.set(target.ticker,{...previous,...target,name:target.name===target.ticker && previous?.name?previous.name:target.name});
      }
      clean=primaryInventory([...retained.values()]);
    }
    this.saveConfig(INVENTORY,{targets:clean,discoveryFailed:discoveryFailed===true,checkedAt:this.now()});
    return this.arm();
  }
  async mappings(targets) {
    const signature=JSON.stringify(targets), day=istDate(this.now());
    const prior=this.config('upstox-mappings');
    if (prior?.client===UPSTOX_CLIENT && prior.version===MAPPING_VERSION && prior.day===day && prior.signature===signature && this.now()<prior.retryAt) return prior;
    const mapped=[], failed=[];
    for (const exchange of new Set(targets.map(t=>upstoxIdentity(t).exchange))) {
      const subset=targets.filter(t=>upstoxIdentity(t).exchange===exchange);
      try { mapped.push(...mapUpstoxTargets(subset,await this.instruments(exchange,this.fetcher))); }
      catch {
        failed.push(exchange);
        // A same-inventory cache can continue supplying exact identities through a list outage.
        if (prior?.signature===signature) mapped.push(...prior.mapped.filter(t=>t.exchange===exchange));
      }
    }
    const missing=targets.filter(t=>!mapped.some(m=>m.ticker===t.ticker)), suspended=[];
    if (missing.length) {
      try { suspended.push(...mapUpstoxTargets(missing,await this.instruments('SUSPENDED',this.fetcher)).map(t=>t.ticker)); }
      catch { failed.push('SUSPENDED'); }
    }
    const result={client:UPSTOX_CLIENT,version:MAPPING_VERSION,day,signature,mapped,suspended,failed,retryAt:this.now()+(failed.length?15*60000:86400000)};
    this.saveConfig('upstox-mappings',result); return result;
  }
  async wake() {
    const at=this.now();
    const claimed=await this.storage.transaction(async tx=>{
      const old=await tx.get(PRIMARY_TIMER) || {};
      if (old.lastAttemptAt && old.nextAt>at) {await tx.setAlarm(old.nextAt);return false;}
      const nextAt=at+PRIMARY_INTERVAL;
      await tx.put(PRIMARY_TIMER,{...old,started:true,lastAttemptAt:at,nextAt,reason:'checking'});
      await tx.setAlarm(nextAt); return true;
    });
    if (!claimed) return;
    let reason='closed', saved=0, failed=0;
    try {
      await this.store().breakoutPrimaryPrune();
      if (marketWindow(at).collect) {
        if (!this.env.UPSTOX_ACCESS_TOKEN) reason='not-configured';
        else {
          const store=this.store(), fallback=await store.breakoutReadFallback();
          const inventory=this.config(INVENTORY);
          const inventoryStale=!inventory || this.now()-inventory.checkedAt>20*60000;
          const targets=inventory?.targets || primaryInventory((fallback.targets || []).map(ticker=>({ticker,name:fallback.rows.find(r=>r.ticker===ticker)?.name})));
          const mapping=await this.mappings(targets);
          const session=expectedSession(at), previousSession=expectedSession(Date.parse(`${session}T09:00:00+05:30`));
          const exchanges=new Map(mapping.mapped.map(t=>[t.ticker,t.exchange]));
          const bases=new Map((fallback.rows || []).filter(r=>r.sessionDate===session && r.base?.to===previousSession && r.exchange===exchanges.get(r.ticker)).map(r=>[r.ticker,r.base]));
          const result=await this.quotes(mapping.mapped,bases,this.env.UPSTOX_ACCESS_TOKEN,{fetcher:this.fetcher,now:this.now});
          const valid=result.rows.filter(r=>quoteFresh(r,this.now())), success=new Set(valid.map(r=>r.ticker)), mapped=new Set(mapping.mapped.map(r=>r.ticker));
          const failures=targets.filter(t=>!success.has(t.ticker)).map(t=>({ticker:t.ticker,reason:mapping.suspended.includes(t.ticker)?'suspended':!mapped.has(t.ticker)?'unmapped':result.reason || 'stale'}));
          await store.breakoutPrimarySave({at,completedAt:this.now(),targets:targets.map(t=>t.ticker),rows:valid,failures,
            discoveryFailed:inventoryStale || (inventory?.discoveryFailed ?? fallback.discoveryFailed ?? true),instrumentFailures:mapping.failed});
          saved=valid.length; failed=failures.length;
          reason=result.reason || (mapping.failed.length?'instrument-list-unavailable':inventoryStale?'inventory-stale':failed?'partial':'ok');
        }
      }
    } catch { reason='unavailable'; }
    await this.storage.transaction(async tx=>{
      const state=await tx.get(PRIMARY_TIMER);
      if (state?.lastAttemptAt===at) await tx.put(PRIMARY_TIMER,{...state,reason,saved,failed,completedAt:this.now()});
    });
  }
}
