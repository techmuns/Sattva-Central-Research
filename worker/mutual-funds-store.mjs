import {readableOwnership} from '../public/js/data/mutual-funds-ownership.js';
import { mergeCompany, projectCompany, summaryOf, validIsin, coverageState, companyRevision, monthKey, previousMonth, targetMonth } from './mutual-funds-model.mjs';
import { contentTag } from './http.mjs';
// One observation per row. No database cell or upload grows with a company's history.
export class MutualFundsStore {
  constructor(storage,{now=Date.now}={}) { this.storage=storage;this.now=now; }
  init() {
    if(this.initialized)return;
    for(const sql of [
      'CREATE TABLE IF NOT EXISTS mf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mf_companies (isin TEXT PRIMARY KEY, payload TEXT NOT NULL, summary TEXT NOT NULL, revision TEXT NOT NULL, input_revision TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mf_revisions (isin TEXT NOT NULL, revision TEXT NOT NULL, captured TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(isin,revision))',
      'CREATE TABLE IF NOT EXISTS mf_runs (id TEXT PRIMARY KEY, started TEXT NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mf_received (run TEXT NOT NULL, isin TEXT NOT NULL, PRIMARY KEY(run,isin))',
      'CREATE TABLE IF NOT EXISTS mf_funds (isin TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(isin,id))',
      'CREATE TABLE IF NOT EXISTS mf_observations (isin TEXT NOT NULL, fund TEXT NOT NULL, month TEXT NOT NULL, checked TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(isin,fund,month))',
      'CREATE TABLE IF NOT EXISTS mf_observation_revisions (isin TEXT NOT NULL, fund TEXT NOT NULL, month TEXT NOT NULL, revision TEXT NOT NULL, captured TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(isin,fund,month,revision))',
      'CREATE TABLE IF NOT EXISTS mf_uploads (run TEXT NOT NULL, isin TEXT NOT NULL, parts INTEGER NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(run,isin))',
      'CREATE TABLE IF NOT EXISTS mf_parts (run TEXT NOT NULL, isin TEXT NOT NULL, part INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run,isin,part))',
      'CREATE TABLE IF NOT EXISTS mf_reports (fund TEXT NOT NULL, month TEXT NOT NULL, checked TEXT NOT NULL, source TEXT, isins TEXT NOT NULL, run TEXT NOT NULL, PRIMARY KEY(fund,month))',
      'CREATE TABLE IF NOT EXISTS mf_report_receipts (run TEXT NOT NULL, fund TEXT NOT NULL, month TEXT NOT NULL, PRIMARY KEY(run,fund,month))'
    ])this.storage.sql.exec(sql);
    this.initialized=true;
  }
  begin(run,manifest) {
    this.init();
    if (!/^\d+:\d+$/.test(run) || !Array.isArray(manifest?.targets) || !manifest.targets.length || manifest.targets.length>15000 || manifest.targets.some(id=>!validIsin(id)) || new Set(manifest.targets).size!==manifest.targets.length || !Array.isArray(manifest.amcs) || manifest.amcs.length>100 || !Number.isSafeInteger(manifest.reportCount||0) || (manifest.reportCount||0)<0 || manifest.reportCount>50000) throw Error('Invalid manifest');
    return this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT OR IGNORE INTO mf_meta VALUES(?,?)','capture-started',new Date(this.now()).toISOString());
      const active=this.active();if(active && active.id!==run && compareRun(active.id,run)>0) throw Error('Superseded run');
      if(!this.storage.sql.exec('SELECT id FROM mf_runs WHERE id=?',run).toArray().length)this.storage.sql.exec('INSERT INTO mf_runs VALUES(?,?,?,?)',run,new Date(this.now()).toISOString(),'collecting',JSON.stringify(manifest));
      return {ok:true};
    });
  }
  active() { return this.storage.sql.exec('SELECT * FROM mf_runs ORDER BY rowid DESC LIMIT 1').toArray()[0]; }
  collecting(run,{reports=false}={}) {
    const active=this.active();if(active?.id!==run || active.state!=='collecting')throw Error('Inactive run');
    const manifest=JSON.parse(active.manifest);
    if(!reports && this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_report_receipts WHERE run=?',run).one().n!==(manifest.reportCount||0))throw Error('Incomplete source reports');
    return manifest;
  }
  reports(run,reports) {
    this.init();if(!Array.isArray(reports)||reports.length>200)throw Error('Invalid reports');
    return this.storage.transactionSync(()=>{
      this.collecting(run,{reports:true});
      for(const r of reports) {
        if(typeof r.id!=='string'||!r.id||r.id.length>300||monthKey(r.month)!==r.month||!Number.isFinite(Date.parse(r.checkedAt))||!Array.isArray(r.isins)||r.isins.length>15000||r.isins.some(id=>!validIsin(id))||r.complete!==true)throw Error('Invalid complete report');
        this.storage.sql.exec('INSERT INTO mf_reports VALUES(?,?,?,?,?,?) ON CONFLICT(fund,month) DO UPDATE SET checked=excluded.checked,source=excluded.source,isins=excluded.isins,run=excluded.run WHERE excluded.checked>=mf_reports.checked',r.id,r.month,r.checkedAt,r.sourceUrl||null,JSON.stringify(r.isins),run);
        this.storage.sql.exec('INSERT OR IGNORE INTO mf_report_receipts VALUES(?,?,?)',run,r.id,r.month);
      }
      return {ok:true};
    });
  }
  point(isin,fund,month,point,changes) {
    const row=this.storage.sql.exec('SELECT payload,revision FROM mf_observations WHERE isin=? AND fund=? AND month=?',isin,fund,month).toArray()[0];
    const old=row?JSON.parse(row.payload):null;
    if(old && ((Date.parse(point.checkedAt)||0)<(Date.parse(old.checkedAt)||0) || point.shares===null && old.shares!==null))return;
    const payload=JSON.stringify(point),revision=companyRevision({isin,funds:[{id:fund,months:{[month]:point}}]});
    this.storage.sql.exec('INSERT INTO mf_observations VALUES(?,?,?,?,?,?) ON CONFLICT(isin,fund,month) DO UPDATE SET checked=excluded.checked,revision=excluded.revision,payload=excluded.payload',isin,fund,month,point.checkedAt||'',revision,payload);
    if(row?.revision!==revision){
      this.storage.sql.exec('INSERT OR IGNORE INTO mf_observation_revisions VALUES(?,?,?,?,?,?)',isin,fund,month,revision,new Date(this.now()).toISOString(),payload);
      changes.push({fund,month,revision});
    }
  }
  reconcile(run,isin,changes) {
    // A verified complete newer scheme report may correct a removed observation to nil.
    // Unreported/partial schemes never provide this authority.
    const missing=this.storage.sql.exec(`SELECT r.fund,r.month,r.checked,r.source FROM mf_funds f JOIN mf_reports r ON r.fund=f.id LEFT JOIN mf_observations o ON o.isin=f.isin AND o.fund=r.fund AND o.month=r.month WHERE f.isin=? AND r.run=? AND (o.checked IS NULL OR r.checked>=o.checked) AND NOT EXISTS (SELECT 1 FROM json_each(r.isins) WHERE value=?)`,isin,run,isin).toArray();
    for(const r of missing)this.point(isin,r.fund,r.month,{shares:0,valueCr:0,pctOfAum:0,checkedAt:r.checked,sourceUrl:r.source,absenceVerified:true},changes);
  }
  company(isin,month=null) {
    const row=this.storage.sql.exec('SELECT payload FROM mf_companies WHERE isin=?',isin).toArray()[0];if(!row)return null;
    const available=this.storage.sql.exec('SELECT DISTINCT month FROM mf_observations WHERE isin=? AND month<=? ORDER BY month DESC',isin,targetMonth(this.now())).toArray().map(r=>r.month);
    const latest=month||available[0]||targetMonth(this.now());let from=latest;for(let i=0;i<3;i++)from=previousMonth(from);
    const funds=new Map(this.storage.sql.exec('SELECT id,metadata FROM mf_funds WHERE isin=?',isin).toArray().map(r=>[r.id,{...JSON.parse(r.metadata),months:{}}]));
    for(const r of this.storage.sql.exec('SELECT fund,month,payload FROM mf_observations WHERE isin=? AND month>=? AND month<=?',isin,from,latest).toArray())funds.get(r.fund).months[r.month]=JSON.parse(r.payload);
    const company=projectCompany({...JSON.parse(row.payload),funds:[...funds.values()]},{month:latest,now:this.now()});
    return {...company,availableMonths:available,months:[latest,previousMonth(latest),previousMonth(previousMonth(latest))]};
  }
  saveSummary(isin,changes,{inputRevision=null,metadataChanged=false}={}) {
    const row=this.storage.sql.exec('SELECT revision,input_revision,payload FROM mf_companies WHERE isin=?',isin).one();
    const revision=changes.length||metadataChanged?contentTag(JSON.stringify({previous:row.revision,metadata:row.payload,changes})):row.revision;
    const summary={...summaryOf(this.company(isin)),revision:inputRevision||row.input_revision};
    // Revision records form an immutable chain of point references, never a growing full blob.
    if(revision!==row.revision)this.storage.sql.exec('INSERT OR IGNORE INTO mf_revisions VALUES(?,?,?,?)',isin,revision,new Date(this.now()).toISOString(),JSON.stringify({previous:row.revision,metadata:JSON.parse(row.payload),changes}));
    this.storage.sql.exec('UPDATE mf_companies SET summary=?,revision=?,input_revision=? WHERE isin=?',JSON.stringify(summary),revision,inputRevision||row.input_revision,isin);
    this.scanner?.refresh(isin);
  }
  fragment(run,{company,part,parts,revision}) {
    this.init();if(!Number.isSafeInteger(part)||!Number.isSafeInteger(parts)||parts<1||parts>100000||part<0||part>=parts||typeof revision!=='string'||revision.length>100)throw Error('Invalid fragment');
    mergeCompany(null,company); // Validate each bounded observation before entering the transaction.
    return this.storage.transactionSync(()=>{
      const manifest=this.collecting(run);if(!manifest.targets.includes(company.isin)||company.funds.length>5000)throw Error('Unexpected company');
      const upload=this.storage.sql.exec('SELECT parts,revision FROM mf_uploads WHERE run=? AND isin=?',run,company.isin).toArray()[0];
      if(upload && (upload.parts!==parts||upload.revision!==revision))throw Error('Upload changed');
      this.storage.sql.exec('INSERT OR IGNORE INTO mf_uploads VALUES(?,?,?,?)',run,company.isin,parts,revision);
      const hash=companyRevision(company),priorPart=this.storage.sql.exec('SELECT hash FROM mf_parts WHERE run=? AND isin=? AND part=?',run,company.isin,part).toArray()[0];
      if(priorPart){if(priorPart.hash!==hash)throw Error('Fragment changed');return {ok:true};}
      const {funds,...incoming}=company,old=this.storage.sql.exec('SELECT payload FROM mf_companies WHERE isin=?',company.isin).toArray()[0];
      const previous=old?JSON.parse(old.payload):null,metadata=mergeCompany({...previous,funds:[]},{...incoming,funds:[]},{now:this.now()});delete metadata.funds;
      const payload=JSON.stringify(metadata),metadataChanged=!old||old.payload!==payload;
      this.storage.sql.exec('INSERT INTO mf_companies VALUES(?,?,?,?,?) ON CONFLICT(isin) DO UPDATE SET payload=excluded.payload',company.isin,payload,'{}','','');
      const changes=[];
      for(const fund of funds){
        const existing=this.storage.sql.exec('SELECT metadata FROM mf_funds WHERE isin=? AND id=?',company.isin,fund.id).toArray()[0];
        const {months,...fields}=fund;const fm={...fields,everHeld:!!(existing&&JSON.parse(existing.metadata).everHeld)||Object.values(months).some(p=>p.shares>0)};
        this.storage.sql.exec('INSERT INTO mf_funds VALUES(?,?,?) ON CONFLICT(isin,id) DO UPDATE SET metadata=excluded.metadata',company.isin,fund.id,JSON.stringify(fm));
        for(const [month,point] of Object.entries(months))this.point(company.isin,fund.id,month,point,changes);
      }
      this.reconcile(run,company.isin,changes);
      this.storage.sql.exec('INSERT INTO mf_parts VALUES(?,?,?,?)',run,company.isin,part,hash);
      const complete=this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_parts WHERE run=? AND isin=?',run,company.isin).one().n===parts;
      this.saveSummary(company.isin,changes,{inputRevision:complete?revision:null,metadataChanged});
      if(complete)this.storage.sql.exec('INSERT OR IGNORE INTO mf_received VALUES(?,?)',run,company.isin);
      return {ok:true};
    });
  }
  checkpoint(run,companies) {
    if(!Array.isArray(companies)||companies.length>10)throw Error('Invalid batch');
    for(const company of companies)this.fragment(run,{company,part:0,parts:1,revision:companyRevision(company)});
    return {ok:true};
  }
  confirm(run,companies) {
    this.init();if(!Array.isArray(companies)||companies.length>250)throw Error('Invalid confirmations');
    return this.storage.transactionSync(()=>{
      const manifest=this.collecting(run);
      for(const item of companies){
        if(!manifest.targets.includes(item.isin))throw Error('Unexpected company');
        const row=this.storage.sql.exec('SELECT input_revision FROM mf_companies WHERE isin=?',item.isin).toArray()[0];if(!row||row.input_revision!==item.revision)throw Error('Revision changed');
        const changes=[];this.reconcile(run,item.isin,changes);if(changes.length)this.saveSummary(item.isin,changes);
        this.storage.sql.exec('INSERT OR IGNORE INTO mf_received VALUES(?,?)',run,item.isin);
        this.scanner?.refresh(item.isin);
      }
      return {ok:true};
    });
  }
  finish(run) {
    this.init();const active=this.active();if(active?.id!==run)throw Error('Inactive run');if(active.state==='complete')return {ok:true};
    const manifest=this.collecting(run);
    if(this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_received WHERE run=?',run).one().n!==manifest.targets.length)throw Error('Incomplete run');
    this.storage.sql.exec("UPDATE mf_runs SET state='complete' WHERE id=?",run);
    // Completed upload receipts are transient coordination, not disclosure history.
    // Keep three runs for recovery; all observations and correction chains survive.
    const old=this.storage.sql.exec('SELECT id FROM mf_runs ORDER BY rowid DESC LIMIT -1 OFFSET 3').toArray();
    for(const r of old){for(const table of ['mf_received','mf_uploads','mf_parts','mf_report_receipts'])this.storage.sql.exec(`DELETE FROM ${table} WHERE run=?`,r.id);this.storage.sql.exec('DELETE FROM mf_runs WHERE id=?',r.id);}
    return {ok:true};
  }
  status() {
    this.init();const active=this.active();if(!active)return {state:'unavailable',amcs:[],checkedAt:null};
    const {targets,...manifest}=JSON.parse(active.manifest);
    return {...manifest,state:active.state,run:active.id,expectedCompanies:targets.length,receivedCompanies:this.storage.sql.exec('SELECT COUNT(*) AS n FROM mf_received WHERE run=?',active.id).one().n,captureStartedAt:this.storage.sql.exec('SELECT value FROM mf_meta WHERE key=?','capture-started').toArray()[0]?.value||null};
  }
  read(isins=null,cursor='') {
    this.init();if(isins && (isins.length>250 || isins.some(id=>!validIsin(id))))throw Error('Invalid ISINs');
    // Cloudflare SQLite allows only 100 bound parameters. Bind the validated
    // scope as one JSON array so the full 250-company API page remains readable.
    const list=isins?.length ? this.storage.sql.exec('SELECT summary FROM mf_companies WHERE isin IN (SELECT value FROM json_each(?)) ORDER BY isin',JSON.stringify(isins)).toArray()
      : isins ? [] : this.storage.sql.exec('SELECT summary FROM mf_companies WHERE isin>? ORDER BY isin LIMIT 251',cursor).toArray();
    const rows=list.slice(0,250).map(row=>{const r=JSON.parse(row.summary);return readableOwnership(r,this.now());}),meta=this.status();
    return {meta:{...meta,health:coverageState(meta,this.now())},rows,nextCursor:list.length>250?rows.at(-1).isin:null};
  }
  detail(isin,month=null) {
    this.init();if(!validIsin(isin)||month && !/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw Error('Invalid detail');
    const meta=this.status();return {meta:{...meta,health:coverageState(meta,this.now())},company:this.company(isin,month)};
  }
}
function compareRun(a,b) { const aa=a.split(':').map(BigInt),bb=b.split(':').map(BigInt);return aa[0]===bb[0]?Number(aa[1]-bb[1]):aa[0]>bb[0]?1:-1; }
