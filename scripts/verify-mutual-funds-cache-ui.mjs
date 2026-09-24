// Real browser persistence and controlled network gates: cached/precomputed
// summaries must paint before revalidation or private supplementation finishes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {comparisonStatus} from '../public/js/data/mutual-funds-status.js';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const origin='https://mf-cache.test',root=resolve('public'),errors=[],requests=[];
const isin='INE090A01021',other='INE040A01034';
const row={isin,name:'Cached Company',ticker:'FIXTURE',month:'2026-08',priorMonth:'2026-07',totalShares:120,netChange:20,comparableFunds:1,addedFunds:1,reducedFunds:0,pendingFunds:0,direction:'Added',insight:'Saved comparison',revision:'one'};
const meta={checkedAt:'2026-09-20T00:00:00Z',state:'complete',amcs:[{status:'ok',month:'2026-08'}]};
let publicValue={rows:[row],meta},privateValue=null,publicGate=null,privateGate=null,failPublic=false;
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
assert.equal(comparisonStatus({totalShares:null,comparableFunds:0,pendingFunds:0,direction:'Pending'}).label,'No disclosure');
assert.equal(comparisonStatus({missing:true}).label,'Unavailable','an unread company is not a verified empty source result');
assert.equal(comparisonStatus({totalShares:0,comparableFunds:0,pendingFunds:2}).detail,'Adjacent month missing','verified zero is a reported quantity');
assert.equal(comparisonStatus({totalShares:null,pendingFunds:2}).detail,'Monthly quantities missing');
assert.deepEqual(comparisonStatus(row),{label:'Added',detail:'1 added · 0 reduced',insight:'Saved comparison',reported:true});
try {
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin)return route.fulfill({body:''});
  const js=body=>route.fulfill({contentType:'text/javascript',body});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<script type="module">import * as feed from '/js/data/mutual-funds.js';import * as store from '/js/core/store.js';window.feed=feed;window.store=store;window.events=[];feed.onUpdate(()=>events.push({rows:feed.all(),meta:feed.meta(),at:performance.now()}));window.ready=true;</script>`});
  if(u.pathname==='/js/core/host-context.js')return js(`let token=null;const listeners=[];export const authHeaders=()=>token?{Authorization:'Bearer '+token}:{};export const hostToken=()=>token;export const onHostContext=fn=>listeners.push(fn);window.session=value=>{token=value;for(const fn of listeners)fn({}, {session:true});};`);
  if(u.pathname==='/js/data/coverage.js')return js(`export const holdings=()=>[{isin:'${isin}',name:'Cached Company'}];`);
  if(u.pathname==='/js/core/watchlist.js')return js('export const all=()=>[];');
  if(u.pathname==='/js/data/scope.js')return js('export const filterByScope=rows=>rows;');
  if(u.pathname==='/api/mutual-funds') {
   requests.push(u.href);const value=structuredClone(typeof publicValue==='function'?publicValue(u):publicValue),block=publicGate,fail=failPublic;
   if(block)await block.promise;
   if(fail)return route.abort('failed');
   return route.fulfill({contentType:'application/json',headers:{etag:JSON.stringify(JSON.stringify(value).length+':'+value.rows[0]?.totalShares),'cache-control':'no-cache'},body:JSON.stringify(value)});
  }
  if(u.pathname==='/api/mutual-funds/private') {
   const block=privateGate,value=structuredClone(privateValue);if(block)await block.promise;
   return route.fulfill({contentType:'application/json',headers:{'cache-control':'private, no-store'},body:JSON.stringify(value)});
  }
  const file=resolve(root,'.'+u.pathname);assert(file.startsWith(root+sep));
  return route.fulfill({contentType:{'.js':'text/javascript','.json':'application/json'}[extname(file)]||'text/plain',body:readFileSync(file)});
 });
 const open=async()=>{await page.goto(origin);await page.waitForFunction(()=>window.ready);};
 const start=()=>page.evaluate(()=>{window.finished=false;window.work=feed.load().then(()=>window.finished=true);});
 await open();await page.evaluate(()=>feed.load());
 assert.equal(await page.evaluate(()=>feed.all()[0].netChange),20);
 // Reload clears module memory. Withhold the whole network response; IndexedDB
 // alone must produce the original exact rows and source check, with no new stamp.
 publicGate=gate();publicValue={rows:[{...row,totalShares:250,netChange:150,revision:'two'},{...row,isin:other,name:'Late arrival'}],meta:{...meta,state:'collecting'}};
 await open();await start();await page.waitForFunction(()=>feed.all().length===1);
 assert.deepEqual(await page.evaluate(()=>feed.all()),[row]);
 assert.equal(await page.evaluate(()=>feed.meta().checkedAt),meta.checkedAt);
 assert.equal(await page.evaluate(()=>feed.meta().origin),'store');
 assert.equal(await page.evaluate(()=>finished),false);
 const before=requests.length;await page.evaluate(()=>{window.second=feed.load();});
 publicGate.release();publicGate=null;await page.evaluate(()=>Promise.all([work,second]));
 assert.equal(requests.length,before,'concurrent callers share one revalidation');
 assert.equal(await page.evaluate(()=>feed.all().length),2);
 assert.equal(await page.evaluate(()=>feed.all().find(r=>r.isin==='INE090A01021').totalShares),250);
 assert.equal(await page.evaluate(()=>feed.meta().state),'collecting','partial capture remains partial');
 // A failing refresh preserves the complete saved response and marks failure.
 failPublic=true;await page.evaluate(()=>feed.load());failPublic=false;
 assert.equal(await page.evaluate(()=>feed.all().length),2);
 assert.equal(await page.evaluate(()=>feed.meta().readFailed),true);
 assert.match(await page.evaluate(()=>feed.health()),/Read failed/);
 // Private supplement must not block the newly fetched public snapshot.
 await page.evaluate(()=>session('fixture-session'));
 privateGate=gate();privateValue={rows:[{...row,totalShares:275,netChange:175}],meta:{supplement:{expectedCompanies:1,currentCompanies:1}}};
 await start();await page.waitForFunction(()=>feed.meta().revalidating&&events.some(e=>e.rows.some(r=>r.totalShares===250)));
 assert.equal(await page.evaluate(()=>finished),false);
 assert.equal(await page.evaluate(()=>feed.all().find(r=>r.isin==='INE090A01021').totalShares),250);
 privateGate.release();privateGate=null;await page.evaluate(()=>work);
 assert.equal(await page.evaluate(()=>feed.all().find(r=>r.isin==='INE090A01021').totalShares),275);
 assert.equal(await page.evaluate(async()=> (await store.readEntry('mf-snapshot:INE090A01021')).value.rows[0].totalShares),250,'private rows are never persisted');
 // On a primary correction, invalidate only its obsolete private overlay while
 // waiting for the refreshed supplement; an account change rejects late results.
 publicValue={...publicValue,rows:[{...row,totalShares:300,netChange:200,revision:'three'}]};
 privateGate=gate();await start();await page.waitForFunction(()=>feed.all().some(r=>r.totalShares===300));
 await page.evaluate(()=>session(null));privateGate.release();privateGate=null;await page.evaluate(()=>work);
 assert.equal(await page.evaluate(()=>feed.all().find(r=>r.isin==='INE090A01021').totalShares),300);
 assert.equal(await page.evaluate(()=>feed.meta().supplementAccess),'no-session');
 // A growing portfolio remains batched; universe pagination remains complete.
 const many=Array.from({length:251},(_,i)=>({...row,isin:`INE${String(i).padStart(9,'0')}`,name:`Company ${i}`}));
 publicValue=u=>{const ids=u.searchParams.get('isins');return ids?{rows:many.filter(r=>ids.split(',').includes(r.isin)),meta}:{rows:u.searchParams.get('cursor')?[many.at(-1)]:many.slice(0,250),meta,nextCursor:u.searchParams.get('cursor')?null:many[249].isin};};
 const batchStart=requests.length;const scoped=await page.evaluate(holdings=>feed.load('portfolio',{holdings}),many);
 assert.deepEqual(scoped.rows,many);assert.equal(requests.length-batchStart,2);
 const universe=await page.evaluate(()=>feed.load('universe'));
 assert.deepEqual(universe.rows,many);
 assert.deepEqual(errors,[]);
 console.log('PASS MF cache-first reload, unchanged source dates, shared requests, new/corrected rows, failure retention, staged private reads, account isolation and full scope/pagination');
} finally {publicGate?.release();privateGate?.release();await browser.close();}
