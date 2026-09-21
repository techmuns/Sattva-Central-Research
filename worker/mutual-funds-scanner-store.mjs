import { validIsin, monthKey, targetMonth, previousMonth, summaryOf, companyRevision } from './mutual-funds-model.mjs';
import { supplementCompany } from './mutual-funds-scanner-model.mjs';
const INTERVAL=15*60000, GAP=2000, LEASE=90000;
const validUrl=url=>/^https:\/\/mfscanner\.com\/(?:stock\/[a-z0-9-]+)?$/.test(url||'');

// Private supplement tables share the primary object's transaction boundary.
// Public MF reads never query them. Summaries are prepared on capture, not by
// sending a full fund universe to the browser or fetching a provider on reads.
export class MutualFundsScannerStore {
  constructor(storage,primary,{now=Date.now}={}) {this.storage=storage;this.primary=primary;this.now=now;}
  init() {
    if(this.initialized)return;
    this.primary.init();
    for(const sql of [
      'CREATE TABLE IF NOT EXISTS mf_scanner_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mf_scanner_targets (isin TEXT PRIMARY KEY,company TEXT NOT NULL,active INTEGER NOT NULL,url TEXT,next_at INTEGER NOT NULL,checked TEXT,state TEXT NOT NULL,request TEXT,lease INTEGER NOT NULL,coverage TEXT,summary TEXT)',
      'CREATE TABLE IF NOT EXISTS mf_scanner_funds (isin TEXT NOT NULL,id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(isin,id))',
      'CREATE TABLE IF NOT EXISTS mf_scanner_points (isin TEXT NOT NULL,fund TEXT NOT NULL,month TEXT NOT NULL,payload TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(isin,fund,month))',
      'CREATE TABLE IF NOT EXISTS mf_scanner_history (isin TEXT NOT NULL,fund TEXT NOT NULL,month TEXT NOT NULL,revision TEXT NOT NULL,captured TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(isin,fund,month,revision))'
    ])this.storage.sql.exec(sql);
    this.initialized=true;
  }
  get(key,fallback=null) {const r=this.storage.sql.exec('SELECT value FROM mf_scanner_meta WHERE key=?',key).toArray()[0];return r?JSON.parse(r.value):fallback;}
  set(key,value) {this.storage.sql.exec('INSERT INTO mf_scanner_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
  inventory(companies) {
    this.init();
    if(!Array.isArray(companies)||!companies.length||companies.length>5000||new Set(companies.map(c=>c.isin)).size!==companies.length||companies.some(c=>!validIsin(c.isin)||typeof c.name!=='string'||c.name.length>300||JSON.stringify(c).length>4000))throw Error('Invalid private portfolio');
    return this.storage.transactionSync(()=>{
      this.storage.sql.exec('UPDATE mf_scanner_targets SET active=0');
      for(const c of companies)this.storage.sql.exec("INSERT INTO mf_scanner_targets VALUES(?,?,1,NULL,0,NULL,'pending',NULL,0,NULL,NULL) ON CONFLICT(isin) DO UPDATE SET company=excluded.company,active=1",c.isin,JSON.stringify(c));
      this.set('inventoryCheckedAt',new Date(this.now()).toISOString());
      return {ok:true,targets:companies.length};
    });
  }
  catalogue(entries,checkedAt) {
    if(!Array.isArray(entries)||!entries.length||entries.length>10000||entries.some(e=>!validUrl(e.url)||typeof e.name!=='string'||e.name.length>300))throw Error('Invalid catalogue');
    this.set('catalogue',{entries,checkedAt});
  }
  reserve(run,requestId,kind='stock') {
    this.init();if(!/^\d+:\d+$/.test(run)||!/^\d{1,5}$/.test(requestId)||!['catalogue','stock'].includes(kind))throw Error('Invalid reservation');
    const key=`${run}:${requestId}`;
    return this.storage.transactionSync(()=>{
      const now=this.now(),control=this.get('control',{});
      if(control.blockedUntil>now)return {ok:true,waitUntil:control.blockedUntil,reason:'source-cooldown'};
      // The collector retries a reservation before making its source request.
      // Replay the same lease after a lost acknowledgement, without spending
      // another request. Completed or expired leases cannot fetch again.
      const receipt=this.get(`receipt:${key}`);
      if(receipt)return this.get(`done:${key}`)?{ok:true,reason:'already-completed'}:receipt.at+LEASE>now?receipt.payload:{ok:true,reason:'reservation-expired'};
      if(control.nextAt>now)return {ok:true,waitUntil:control.nextAt,reason:'spacing'};
      if(kind==='catalogue') {
        const saved=this.get('catalogue');
        if(saved && now-Date.parse(saved.checkedAt)<INTERVAL)return {ok:true,catalogue:saved.entries};
        if(control.catalogueLease>now)return {ok:true,waitUntil:control.catalogueLease,reason:'in-flight'};
        this.set('control',{...control,nextAt:now+GAP,catalogueLease:now+LEASE,catalogueRequest:key});
        const payload={ok:true,reservation:key,url:'https://mfscanner.com/',savedCatalogue:saved?.entries||null};
        this.set(`receipt:${key}`,{at:now,payload});return payload;
      }
      const target=this.storage.sql.exec('SELECT * FROM mf_scanner_targets WHERE active=1 AND next_at<=? AND lease<=? ORDER BY next_at,isin LIMIT 1',now,now).toArray()[0];
      if(!target)return {ok:true,reason:'nothing-due'};
      this.storage.sql.exec('UPDATE mf_scanner_targets SET request=?,lease=?,next_at=?,state=? WHERE isin=?',key,now+LEASE,now+INTERVAL,'checking',target.isin);
      this.set('control',{...control,nextAt:now+GAP});
      const payload={ok:true,reservation:key,company:JSON.parse(target.company),url:target.url};
      this.set(`receipt:${key}`,{at:now,payload});
      // Coordination receipts have no disclosure data and need only a day.
      this.storage.sql.exec("DELETE FROM mf_scanner_meta WHERE key LIKE 'receipt:%' AND json_extract(value,'$.at')<?",now-86400000);
      return payload;
    });
  }
  complete(run,input) {
    this.init();const {reservation,isin=null,page=null,catalogue=null,failure=null}=input||{};
    if(typeof reservation!=='string'||!reservation.startsWith(`${run}:`)||!this.get(`receipt:${reservation}`))throw Error('Unreserved source request');
    if(failure && !['http-403','http-429','http-error','timeout','invalid-page','unmatched'].includes(failure))throw Error('Invalid source outcome');
    return this.storage.transactionSync(()=>{
      const now=this.now(),stamp=new Date(now).toISOString(),control=this.get('control',{});
      if(this.get(`done:${reservation}`))return {ok:true};
      const target=isin?this.storage.sql.exec('SELECT * FROM mf_scanner_targets WHERE isin=? AND request=?',isin,reservation).toArray()[0]:null;
      if(isin&&!target || !isin&&control.catalogueRequest!==reservation)throw Error('Source reservation expired');
      if(['http-403','http-429'].includes(failure)) {
        const delay=failure==='http-403'?86400000:Math.max(3600000,Math.min(86400000,Number(input.retryAfterMs)||0));
        this.set('control',{...control,blockedUntil:now+delay,reason:failure,catalogueLease:0});
      }
      if(!isin) {
        if(!failure)this.catalogue(catalogue,stamp);
        this.set('catalogueStatus',{state:failure||'ok',lastAttemptAt:stamp});
        const latest=this.get('control',{});this.set('control',{...latest,catalogueLease:0});
      } else {
        if(!failure) {
          this.validatePage(page,isin,now);
          for(const fund of page.funds) {
            const {months,...metadata}=fund;
            this.storage.sql.exec('INSERT INTO mf_scanner_funds VALUES(?,?,?) ON CONFLICT(isin,id) DO UPDATE SET metadata=excluded.metadata',isin,fund.id,JSON.stringify(metadata));
            for(const [month,point] of Object.entries(months)) {
              const old=this.storage.sql.exec('SELECT payload FROM mf_scanner_points WHERE isin=? AND fund=? AND month=?',isin,fund.id,month).toArray()[0];
              if(old && (Date.parse(JSON.parse(old.payload).checkedAt)>Date.parse(point.checkedAt) || point.shares===null&&JSON.parse(old.payload).shares!==null))continue;
              const payload=JSON.stringify(point),revision=companyRevision({isin,funds:[{id:fund.id,months:{[month]:point}}]});
              this.storage.sql.exec('INSERT INTO mf_scanner_points VALUES(?,?,?,?,?) ON CONFLICT(isin,fund,month) DO UPDATE SET payload=excluded.payload,revision=excluded.revision',isin,fund.id,month,payload,revision);
              this.storage.sql.exec('INSERT OR IGNORE INTO mf_scanner_history VALUES(?,?,?,?,?,?)',isin,fund.id,month,revision,stamp,payload);
            }
          }
          const {funds,...coverage}=page;
          this.storage.sql.exec('UPDATE mf_scanner_targets SET url=?,coverage=?,checked=? WHERE isin=?',page.sourceUrl,JSON.stringify(coverage),page.checkedAt,isin);
        }
        this.storage.sql.exec('UPDATE mf_scanner_targets SET lease=0,next_at=?,state=? WHERE isin=?',now+INTERVAL,failure||'ok',isin);
        if(['http-error','invalid-page'].includes(failure))this.storage.sql.exec('UPDATE mf_scanner_targets SET url=NULL WHERE isin=?',isin);
        this.set(`attempt:${isin}`,stamp);
        this.refresh(isin);
      }
      this.set(`done:${reservation}`,now);
      this.storage.sql.exec("DELETE FROM mf_scanner_meta WHERE key LIKE 'done:%' AND CAST(value AS INTEGER)<?",now-86400000);
      return {ok:true};
    });
  }
  validatePage(p,isin,now) {
    if(p?.isin!==isin||!validUrl(p.sourceUrl)||monthKey(p.month)!==p.month||p.month>targetMonth(now)||p.priorMonth!==previousMonth(p.month)||Math.abs(Date.parse(p.checkedAt)-now)>5*60000||!Number.isFinite(Date.parse(p.checkedAt))||!Array.isArray(p.funds)||p.funds.length>5000||new Set(p.funds.map(f=>f.id)).size!==p.funds.length)throw Error('Invalid stock observation');
    for(const n of ['reportedFunds','unreportedFunds','unknownAmcs'])if(!Number.isSafeInteger(p[n])||p[n]<0||p[n]>5000)throw Error('Invalid page coverage');
    for(const f of p.funds) {
      if(!/^scanner:[a-z0-9-]+$/.test(f.id)||f.id.length>300||typeof f.name!=='string'||f.name.length>300||typeof f.amc!=='string'||f.amc.length>100||!f.months)throw Error('Invalid scheme');
      for(const [month,point] of Object.entries(f.months))if(![p.month,p.priorMonth].includes(month)||point.source!=='MF Scanner'||point.sourceUrl!==p.sourceUrl||point.checkedAt!==p.checkedAt||point.shares!==null&&(!Number.isSafeInteger(point.shares)||point.shares<0)||point.valueCr!==null||point.pctOfAum!==null)throw Error('Invalid scheme observation');
    }
  }
  supplement(isin,month) {
    const row=this.storage.sql.exec('SELECT company,coverage FROM mf_scanner_targets WHERE isin=?',isin).toArray()[0];if(!row?.coverage)return null;
    const coverage=JSON.parse(row.coverage),latest=month||coverage.month;let from=latest;for(let i=0;i<3;i++)from=previousMonth(from);
    const funds=new Map(this.storage.sql.exec('SELECT id,metadata FROM mf_scanner_funds WHERE isin=?',isin).toArray().map(f=>[f.id,{...JSON.parse(f.metadata),months:{}}]));
    for(const p of this.storage.sql.exec('SELECT fund,month,payload FROM mf_scanner_points WHERE isin=? AND month>=? AND month<=?',isin,from,latest).toArray())funds.get(p.fund).months[p.month]=JSON.parse(p.payload);
    const availableMonths=this.storage.sql.exec('SELECT DISTINCT month FROM mf_scanner_points WHERE isin=? ORDER BY month DESC',isin).toArray().map(r=>r.month);
    return {...JSON.parse(row.company),...coverage,availableMonths,funds:[...funds.values()]};
  }
  company(isin,month=null) {
    const primary=this.primary.company(isin,month),supplement=this.supplement(isin,month);
    if(!supplement)return primary;
    const latest=month||[primary?.month,supplement.month].filter(Boolean).sort().at(-1);
    return supplementCompany(primary,supplement,{amcs:this.primary.status().amcs,month:latest,now:this.now()});
  }
  refresh(isin) {
    this.init();const target=this.storage.sql.exec('SELECT isin FROM mf_scanner_targets WHERE isin=?',isin).toArray()[0];if(!target)return;
    const company=this.company(isin);if(company)this.storage.sql.exec('UPDATE mf_scanner_targets SET summary=? WHERE isin=?',JSON.stringify(summaryOf(company)),isin);
  }
  status() {
    this.init();const targets=this.storage.sql.exec('SELECT isin,state,checked,coverage FROM mf_scanner_targets WHERE active=1 ORDER BY isin').toArray();
    const target=targetMonth(this.now()),current=targets.filter(t=>t.state==='ok'&&t.coverage&&JSON.parse(t.coverage).month===target&&this.now()-Date.parse(t.checked)<=45*60000);
    return {source:'MF Scanner',scope:'portfolio',expectedCompanies:targets.length,currentCompanies:current.length,inventoryCheckedAt:this.get('inventoryCheckedAt'),catalogue:this.get('catalogueStatus'),cooldownUntil:this.get('control',{}).blockedUntil||null,
      companies:targets.map(t=>({isin:t.isin,state:t.state,checkedAt:t.checked,lastAttemptAt:this.get(`attempt:${t.isin}`),month:t.coverage?JSON.parse(t.coverage).month:null}))};
  }
  read(isins,cursor='') {
    this.init();if(isins&&(isins.length>250||isins.some(id=>!validIsin(id))))throw Error('Invalid ISINs');
    const candidates=isins||this.storage.sql.exec('SELECT isin FROM (SELECT isin FROM mf_companies UNION SELECT isin FROM mf_scanner_targets WHERE summary IS NOT NULL) WHERE isin>? ORDER BY isin LIMIT 251',cursor).toArray().map(r=>r.isin);
    const ids=[...new Set(candidates)].sort().slice(0,250),base=this.primary.read(ids);
    const saved=new Map(this.storage.sql.exec('SELECT isin,summary FROM mf_scanner_targets WHERE summary IS NOT NULL AND isin IN (SELECT value FROM json_each(?))',JSON.stringify(ids)).toArray().map(r=>[r.isin,JSON.parse(r.summary)]));
    const primary=new Map(base.rows.map(r=>[r.isin,r]));
    return {...base,nextCursor:candidates.length>250?ids.at(-1):null,meta:{...base.meta,supplement:this.status()},rows:ids.map(id=>saved.get(id)||primary.get(id)).filter(Boolean).map(r=>{
      if(r.denominator&&this.now()-Date.parse(r.denominator.checkedAt)>7*86400000)return {...r,companyPct:null,denominatorFresh:false};return r;
    })};
  }
  detail(isin,month=null) {
    this.init();if(!validIsin(isin)||month&&monthKey(month)!==month)throw Error('Invalid company');
    return {meta:{...this.primary.status(),supplement:this.status()},company:this.company(isin,month)};
  }
}
