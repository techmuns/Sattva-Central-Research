import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public'),errors=[];
const actual=readFileSync(root+'/index.html','utf8'),head=actual.slice(actual.indexOf('<head>')+6,actual.indexOf('</head>'));
const html=`<!doctype html><html><head>${head}</head><body><main id="root" class="mx-auto max-w-7xl p-6"></main><div id="modal-overlay" class="hidden fixed inset-0 z-50 overflow-y-auto bg-black/40 p-6"><div id="modal-container" class="mx-auto"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/mutual-funds.js';import * as coverage from '/js/data/coverage.js';
const book=await(await fetch('/data/portfolio-companies.json')).json();coverage.prime(book);window.tab=tab;window.mount=scope=>tab.render({scope,root:document.querySelector('#root'),live:{}});window.mount('portfolio');
</script></body></html>`;
const bridge=`export const cachedPositionSizes=()=>({sizes:{complete:true},holdings:window.testBook||[]});export const readPositionSizes=async()=>cachedPositionSizes();export const onPortfolioReady=()=>()=>{};export const onPortfolioInvalidation=()=>()=>{};export const portfolioConnectionState=()=> 'connected';export const unlockPortfolio=()=>{};`;
const server=createServer((req,res)=>{const url=new URL(req.url,'http://fixture');try{
  if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(url.pathname==='/js/research/portfolio-bridge.js'){res.setHeader('content-type','text/javascript');res.end(bridge);return;}
  const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+sep))throw Error();res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css','.html':'text/html'}[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
}catch{res.writeHead(404).end('{}');}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
 await page.goto(origin);await page.waitForSelector('[data-row-key]');
 assert(await page.locator('text=MF shares held').count());assert(await page.locator('text=Insight summary').count());
 const book=JSON.parse(readFileSync(root+'/data/portfolio-companies.json'));const seed=JSON.parse(readFileSync(root+'/data/mutual-funds/index.json'));const held=seed.rows.find(r=>r.funds===undefined&&r.holders>10);assert(held);
 await page.evaluate(h=>{window.testBook=[{isin:h.isin,weightPct:90}];window.mount('portfolio');},held);await page.waitForTimeout(400);
 const first=page.locator('[data-row-key]').first();assert.equal(await first.getAttribute('data-row-key'),held.isin,'Largest holdings uses private portfolio weight');
 await first.click();await page.waitForSelector('.mf-detail-table tbody tr');assert(await page.locator('th:has-text("AUM (Cr)")').count());assert(await page.locator('th:has-text("Month Change")').count());
 assert((await page.locator('.mf-detail-table tbody tr').count())<=50,'Fund rendering is paged');
 await page.locator('[data-mf-fund-search]').fill('zzzzzz');assert(await page.getByText('No matching funds.').isVisible());await page.locator('[data-mf-fund-search]').fill('');
 mkdirSync('artifacts/mutual-funds-ui',{recursive:true});await page.screenshot({path:'artifacts/mutual-funds-ui/detail.png'});
 await page.keyboard.press('Escape');await page.waitForTimeout(150);assert(await page.locator('#modal-overlay').evaluate(e=>e.classList.contains('hidden')));
 await page.screenshot({path:'artifacts/mutual-funds-ui/table.png'});
 await page.selectOption('[data-mf-sort]','newest');
 // Large table filters must search beyond the rendered DOM window.
 const search=page.locator('input[placeholder="Search company..."]');await search.fill(book.holdings.at(-1).name);await page.waitForTimeout(400);assert((await page.locator('[data-row-key]').count())>=1);
 await search.fill('');await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'artifacts/mutual-funds-ui/dark.png'});
 await page.setViewportSize({width:420,height:850});await page.screenshot({path:'artifacts/mutual-funds-ui/mobile.png'});
 // Exercise the production reader on a local-only mocked origin, including pagination and failure.
 const apiPage=await browser.newPage();const apiOrigin='http://mutual-funds.test';let apiCalls=0,version=1,fail=false,privateFail=false;
 const apiBook=Array.from({length:502},(_,i)=>({isin:`INE${String(i).padStart(9,'0')}`,ticker:`FIX${i}`,name:`Fixture ${i}`}));
 await apiPage.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!==apiOrigin)return route.fulfill({status:200,body:''});
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<script type="module">window.feed=await import("/js/data/mutual-funds.js");</script>'});
   if(u.pathname==='/js/core/host-context.js')return route.fulfill({contentType:'text/javascript',body:`let token=null;const listeners=[];window.testSession=value=>{token=value;listeners.forEach(fn=>fn({}, {session:true}));};export const hostToken=()=>token;export const authHeaders=()=>token?{authorization:'Bearer '+token}:{};export const onHostContext=fn=>{listeners.push(fn);return()=>{};};`});
   if(u.pathname==='/api/mutual-funds/private'||u.pathname==='/api/mutual-funds/private/company'){assert.equal(route.request().headers().authorization,'Bearer fixture-private');if(privateFail)return route.fulfill({status:503,body:'{}'});return route.fulfill({contentType:'application/json',headers:{'cache-control':'private, no-store'},body:JSON.stringify({rows:(u.searchParams.get('isins')||'').split(',').filter(Boolean).map(isin=>({...apiBook.find(h=>h.isin===isin),totalShares:999999})),meta:{supplement:{currentCompanies:502,expectedCompanies:502}},company:{isin:u.searchParams.get('isin'),totalShares:999999}})});}
   if(u.pathname==='/api/mutual-funds/company')return route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify({meta:{checkedAt:new Date().toISOString()},company:{isin:u.searchParams.get('isin'),totalShares:version}})});
   if(u.pathname==='/api/mutual-funds'){
     apiCalls++;const ids=u.searchParams.get('isins').split(',');assert(ids.length<=250);
     if(fail)return route.fulfill({status:503,body:'{}'});
     return route.fulfill({contentType:'application/json',headers:{etag:`"${version}:${ids[0]}"`},body:JSON.stringify({rows:ids.map(isin=>({...apiBook.find(h=>h.isin===isin),totalShares:version})),meta:{state:'complete',checkedAt:new Date().toISOString(),amcs:[]},nextCursor:null})});
   }
   const response=await route.fetch({url:origin+u.pathname});return route.fulfill({response});
 });
 await apiPage.goto(apiOrigin);await apiPage.waitForFunction(()=>!!window.feed);
 await apiPage.evaluate(async book=>{window.book=book;await window.feed.load('portfolio',{holdings:book});},apiBook);
 assert.equal(apiCalls,3);assert.equal(await apiPage.evaluate(()=>window.feed.scopedRows('portfolio',window.book).length),502);
 version=2;await apiPage.evaluate(()=>window.feed.load('portfolio',{holdings:window.book}));assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),2);
 await apiPage.evaluate(()=>window.feed.detail(window.book[0].isin));
 fail=true;assert.equal(await apiPage.evaluate(async()=>(await window.feed.detail(window.book[0].isin)).company.totalShares),2,'A failed detail refresh retains the latest capture, not the seed');
 await apiPage.evaluate(()=>window.feed.load('portfolio',{holdings:window.book}));assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),2);assert(await apiPage.evaluate(()=>window.feed.meta().readFailed));
 assert.match(await apiPage.evaluate(()=>window.feed.health({state:'complete',checkedAt:'2026-10-01T00:00:00Z',targetMonth:'2026-08',amcs:[{month:'2026-08',status:'ok'}]},Date.parse('2026-10-01T00:01:00Z'))),/Partial/);
 await apiPage.waitForTimeout(200);await apiPage.reload();await apiPage.waitForFunction(()=>!!window.feed);
 await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all().length),502,'A new session restores every saved API page during an outage');
 assert.equal(await apiPage.evaluate(async isin=>(await window.feed.detail(isin)).company.totalShares,apiBook[0].isin),2,'A new session restores persisted fund detail');
 assert(await apiPage.evaluate(()=>window.feed.meta().readFailed));
 // Private responses stay in memory and disappear on logout / a new page session.
 fail=false;await apiPage.evaluate(()=>window.testSession('fixture-private'));
 await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),999999);
 assert.equal(await apiPage.evaluate(async isin=>(await window.feed.detail(isin)).company.totalShares,apiBook[0].isin),999999);
 version=3;privateFail=true;
 await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3,'A failed private read cannot shadow fresh primary disclosures with an old merged row');
 assert.equal(await apiPage.evaluate(async isin=>(await window.feed.detail(isin)).company.totalShares,apiBook[0].isin),3,'Detail also prefers newer primary facts during a private API outage');
 assert(await apiPage.evaluate(()=>window.feed.meta().supplementReadFailed));
 privateFail=false;await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),999999,'Private data returns after recovery');
 assert(!await apiPage.evaluate(()=>window.feed.meta().supplementReadFailed));
 await apiPage.evaluate(()=>window.testSession(null));assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3);
 await apiPage.reload();await apiPage.waitForFunction(()=>!!window.feed);fail=true;
 await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3,'Private summaries never entered the persistent public cache');
 assert.equal(await apiPage.evaluate(async isin=>(await window.feed.detail(isin)).company.totalShares,apiBook[0].isin),3,'Private detail never entered the persistent public cache');
 await apiPage.close();
 await page.evaluate(()=>window.tab.destroy());assert.deepEqual(errors,[]);console.log('PASS Mutual Funds browser: all portfolio rows, private weight order, month-grouped popup, bounded fund rows, offscreen search, keyboard close, dark/mobile rendering and zero page errors');
}finally{await browser.close();await new Promise(done=>server.close(done));}
