import { mergeCompany, projectCompany, summaryOf, validIsin, coverageState, companyRevision } from './mutual-funds-model.mjs';
import { contentTag, stableJson } from './http.mjs';
export class MutualFundsStore {
  constructor(storage,{now=Date.now}={}) { this.storage=storage;this.now=now; }
  init() {
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS mf_companies (isin TEXT PRIMARY KEY, payload TEXT NOT NULL, summary TEXT NOT NULL, revision TEXT NOT NULL, input_revision TEXT NOT NULL)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS mf_revisions (isin TEXT NOT NULL, revision TEXT NOT NULL, captured TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(isin,revision))');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS mf_runs (id TEXT PRIMARY KEY, started TEXT NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS mf_received (run TEXT NOT NULL, isin TEXT NOT NULL, PRIMARY KEY(run,isin))');
  }
  begin(run,manifest) {
    this.init();
    if (!/^\d+:\d+$/.test(run) || !Array.isArray(manifest?.targets) || !manifest.targets.length || manifest.targets.length>15000 || manifest.targets.some(id=>!validIsin(id)) || new Set(manifest.targets).size!==manifest.targets.length || !Array.isArray(manifest.amcs) || manifest.amcs.length>100) throw Error('Invalid manifest');
    return this.storage.transactionSync(()=>{
      const active=this.active();
      if(active && active.id!==run && compareRun(active.id,run)>0) throw Error('Superseded run');
      const existing=this.storage.sql.exec('SELECT id FROM mf_runs WHERE id=?',run).toArray()[0];
      if(!existing)this.storage.sql.exec('INSERT INTO mf_runs VALUES(?,?,?,?)',run,new Date(this.now()).toISOString(),'collecting',JSON.stringify(manifest));
      return {ok:true};
    });
  }
  active() { return this.storage.sql.exec('SELECT * FROM mf_runs ORDER BY rowid DESC LIMIT 1').toArray()[0]; }
  checkpoint(run,companies) {
    this.init();
    if(!Array.isArray(companies)||companies.length>10)throw Error('Invalid batch');
    return this.storage.transactionSync(()=>{
      const active=this.active();if(active?.id!==run || active.state!=='collecting')throw Error('Inactive run');
      const targets=new Set(JSON.parse(active.manifest).targets);
      for(const company of companies) {
        if(!targets.has(company.isin)||company.funds?.length>5000)throw Error('Unexpected company');
        const row=this.storage.sql.exec('SELECT payload FROM mf_companies WHERE isin=?',company.isin).toArray()[0];
        const merged=mergeCompany(row?JSON.parse(row.payload):null,company);
        const payload=JSON.stringify(merged),revision=companyRevision(merged);
        const inputRevision=companyRevision(company);
        const summary=JSON.stringify({...summaryOf(projectCompany(merged,{now:this.now()})),revision:inputRevision});
        this.storage.sql.exec('INSERT OR IGNORE INTO mf_revisions VALUES(?,?,?,?)',company.isin,revision,new Date(this.now()).toISOString(),payload);
        this.storage.sql.exec('INSERT INTO mf_companies VALUES(?,?,?,?,?) ON CONFLICT(isin) DO UPDATE SET payload=excluded.payload,summary=excluded.summary,revision=excluded.revision,input_revision=excluded.input_revision',company.isin,payload,summary,revision,inputRevision);
        this.storage.sql.exec('INSERT OR IGNORE INTO mf_received VALUES(?,?)',run,company.isin);
      }
      return {ok:true};
    });
  }
  confirm(run,companies) {
    this.init();if(!Array.isArray(companies)||companies.length>250)throw Error('Invalid confirmations');
    return this.storage.transactionSync(()=>{
      const active=this.active();if(active?.id!==run||active.state!=='collecting')throw Error('Inactive run');const targets=new Set(JSON.parse(active.manifest).targets);
      for(const item of companies){if(!targets.has(item.isin))throw Error('Unexpected company');const row=this.storage.sql.exec('SELECT input_revision AS revision FROM mf_companies WHERE isin=?',item.isin).toArray()[0];if(!row||row.revision!==item.revision)throw Error('Revision changed');this.storage.sql.exec('INSERT OR IGNORE INTO mf_received VALUES(?,?)',run,item.isin);}
      return {ok:true};
    });
  }
  finish(run) {
    this.init();const active=this.active();if(active?.id!==run)throw Error('Inactive run');
    const received=this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_received WHERE run=?',run).one().n;
    if(received!==JSON.parse(active.manifest).targets.length)throw Error('Incomplete run');
    this.storage.sql.exec("UPDATE mf_runs SET state='complete' WHERE id=?",run);return {ok:true};
  }
  status() {
    this.init();const active=this.active();if(!active)return {state:'unavailable',amcs:[],checkedAt:null};
    const {targets,...manifest}=JSON.parse(active.manifest);
    return {...manifest,state:active.state,run:active.id,expectedCompanies:targets.length,
      receivedCompanies:this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_received WHERE run=?',active.id).one().n,
      captureStartedAt:this.storage.sql.exec('SELECT MIN(started) AS first FROM mf_runs').one().first};
  }
  read(isins=null,cursor='') {
    this.init();if(isins && (isins.length>250 || isins.some(id=>!validIsin(id))))throw Error('Invalid ISINs');
    const list=isins?.length ? this.storage.sql.exec(`SELECT summary FROM mf_companies WHERE isin IN (${isins.map(()=>'?').join(',')}) ORDER BY isin`,...isins).toArray()
      : isins ? [] : this.storage.sql.exec('SELECT summary FROM mf_companies WHERE isin>? ORDER BY isin LIMIT 251',cursor).toArray();
    const rows=list.slice(0,250).map(row=>{const r=JSON.parse(row.summary);if(r.denominator && this.now()-Date.parse(r.denominator.checkedAt)>7*86400000){r.companyPct=null;r.denominatorFresh=false;}return r;}),meta=this.status();
    return {meta:{...meta,health:coverageState(meta,this.now())},rows,nextCursor:list.length>250?rows.at(-1).isin:null};
  }
  detail(isin,month=null) {
    this.init();if(!validIsin(isin)||month && !/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw Error('Invalid detail');
    const row=this.storage.sql.exec('SELECT payload FROM mf_companies WHERE isin=?',isin).toArray()[0],meta=this.status();
    return {meta:{...meta,health:coverageState(meta,this.now())},company:row?projectCompany(JSON.parse(row.payload),{month,now:this.now()}):null};
  }
}
function compareRun(a,b) { const aa=a.split(':').map(BigInt),bb=b.split(':').map(BigInt);return aa[0]===bb[0]?Number(aa[1]-bb[1]):aa[0]>bb[0]?1:-1; }
