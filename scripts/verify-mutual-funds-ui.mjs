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
 const fixtureSeed=JSON.parse(readFileSync(root+'/data/mutual-funds/index.json'));
 const fixtureBook=JSON.parse(readFileSync(root+'/data/portfolio-companies.json')).holdings;
 const ownershipFixtures=fixtureSeed.rows.filter(r=>r.totalShares>0&&fixtureBook.some(h=>h.isin===r.isin)).slice(0,3);
 ownershipFixtures.forEach((r,i)=>Object.assign(r,{companyPct:i===1?5:10,denominator:{shares:r.totalShares*(i===1?20:10),checkedAt:new Date(Date.now()-(i===2?8:0)*86400000).toISOString(),sourceName:'Moneycontrol',source:'https://example.com/shares',kind:i===1?'estimate':'reported'}}));
 let seedGate=null;
 await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!==origin)return route.fulfill({status:200,body:''});
   if(u.pathname==='/data/mutual-funds/index.json'){if(seedGate)await seedGate;return route.fulfill({contentType:'application/json',body:JSON.stringify(fixtureSeed)});}
   return route.continue();
 });
 await page.clock.install();await page.goto(origin);await page.waitForSelector('[data-row-key]');
 assert(await page.locator('text=MF ownership').count());
 const ownershipSearch=page.locator('input[placeholder="Search company..."]');
 for(const [i,r] of ownershipFixtures.entries()) {
   await ownershipSearch.fill(fixtureBook.find(h=>h.isin===r.isin).name);await page.waitForTimeout(350);
   const value=page.locator(`[data-row-key="${r.isin}"] span[title^="MF shares held ÷"]`);
   assert.equal(await value.innerText(),i===0?'10%':i===1?'≈5%':'—');
   assert.match(await value.getAttribute('title'),i===2?/Percentage withheld/:/Moneycontrol/);
 }
 await ownershipSearch.fill('');await page.waitForTimeout(350);
 const unmatched=fixtureSeed.rows.find(r=>r.totalShares===null&&!r.pendingFunds&&fixtureBook.some(h=>h.isin===r.isin));assert(unmatched);
 await ownershipSearch.fill(fixtureBook.find(h=>h.isin===unmatched.isin).name);await page.waitForTimeout(350);
 assert(await page.getByText('No disclosure',{exact:true}).count());
 await ownershipSearch.fill('');await page.waitForTimeout(350);
 assert.equal(await page.getByText('Awaiting comparison',{exact:true}).count(),0);
 assert(await page.locator('text=MF shares held').count());assert(await page.locator('text=Insight summary').count());
 const net=page.locator('[data-table-head] th').filter({hasText:'Net monthly shares'}), shares=page.locator('[data-table-head] th').filter({hasText:'MF shares held'});
 const a=await net.boundingBox(),b=await shares.boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width-2,b.y+b.height/2,{steps:8});await page.mouse.up();
 assert.match(await page.locator('[data-table-head] th').nth(3).textContent(),/Net monthly shares/,'requested MF layout');

 const book=JSON.parse(readFileSync(root+'/data/portfolio-companies.json'));const seed=JSON.parse(readFileSync(root+'/data/mutual-funds/index.json'));const held=seed.rows.find(r=>r.funds===undefined&&r.holders>10);assert(held);
 await page.evaluate(h=>{window.testBook=[{isin:h.isin,weightPct:90}];window.mount('portfolio');},held);await page.waitForTimeout(400);
 const first=page.locator('[data-row-key]').first();assert.equal(await first.getAttribute('data-row-key'),held.isin,'Largest holdings uses private portfolio weight');
 await first.click();await page.waitForSelector('.mf-detail-table tbody tr');assert(await page.locator('th:has-text("AUM (Cr)")').count());assert(await page.locator('th:has-text("Month Change")').count());
 assert((await page.locator('.mf-detail-table tbody tr').count())<=50,'Fund rendering is paged');
 await page.locator('[data-mf-fund-search]').fill('zzzzzz');assert(await page.getByText('No matching funds.').isVisible());await page.locator('[data-mf-fund-search]').fill('');
 mkdirSync('artifacts/mutual-funds-ui',{recursive:true});await page.screenshot({path:'artifacts/mutual-funds-ui/detail.png'});
 await page.keyboard.press('Escape');await page.waitForTimeout(150);assert(await page.locator('#modal-overlay').evaluate(e=>e.classList.contains('hidden')));
 await page.screenshot({path:'artifacts/mutual-funds-ui/table.png'});
 await page.getByRole('button',{name:'Coverage',exact:true}).click();await page.waitForSelector('#modal-content .mf-detail-table');
 assert.equal(await page.locator('#modal-content th').first().evaluate(e=>getComputedStyle(e).textAlign),'left');
 await page.locator('#modal-content th').first().focus();await page.keyboard.press('Alt+ArrowRight');
 assert.equal(await page.locator('#modal-content th.mf-identity').evaluate(e=>getComputedStyle(e).textAlign),'left','coverage identity styling follows its column');
 await page.keyboard.press('Escape');

 await page.selectOption('[data-mf-sort]','newest');
 // Large table filters must search beyond the rendered DOM window.
 const search=page.locator('input[placeholder="Search company..."]');await search.fill(book.holdings.at(-1).name);await page.waitForTimeout(400);assert((await page.locator('[data-row-key]').count())>=1);
 await search.fill('');await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'artifacts/mutual-funds-ui/dark.png'});
 await page.setViewportSize({width:420,height:850});await page.screenshot({path:'artifacts/mutual-funds-ui/mobile.png'});
 // Every popup header sorts all matching funds before pagination, using raw numbers.
 const fixture=JSON.parse(readFileSync(root+`/data/mutual-funds/companies/${held.isin}.json`));
 const [current,prior,older]=fixture.company.months;
 assert(current&&prior&&older);
 fixture.company.funds=Array.from({length:52},(_,offset)=>{const i=offset+1;return {id:`sort:${i}`,name:`Fund ${String(i).padStart(2,'0')}`,amc:'Fixture',current:{shares:i*100,valueCr:53-i,pctOfAum:i/10},change:i-26,changePct:i*2,action:i>26?'Added':'Reduced',months:{[prior]:{shares:(53-i)*10,changePct:-i},[older]:{shares:5000-i*3,changePct:i}}};});
 fixture.company.funds.push({id:'missing',name:'Missing Fund',amc:'Fixture',current:{},change:null,changePct:null,action:'Pending',months:{}},{id:'new',name:'New Fund',amc:'Fixture',current:{shares:1,valueCr:0,pctOfAum:0},change:1,changePct:null,action:'New',months:{[prior]:{shares:0,changePct:null},[older]:{shares:0,changePct:null}}});
 await page.route(`**/data/mutual-funds/companies/${held.isin}.json*`,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(fixture)}));
 await page.setViewportSize({width:1500,height:1000});await page.evaluate(()=>window.mount('universe'));
 await page.locator('input[placeholder="Search company..."]').fill(held.name);await page.locator(`[data-row-key="${held.isin}"]`).click();
 await page.waitForSelector('[data-mf-fund-sort="name"]');
 const firstFund=()=>page.locator('.mf-detail-table tbody tr').first().locator('td').first().locator('span').textContent();
 const header=key=>page.locator(`[data-mf-fund-sort="${key}"]`);
 assert.equal(await header('change').locator('..').getAttribute('aria-sort'),'descending');
 await header('name').click();assert.equal(await firstFund(),'Fund 01');
 const from=await header('shares').boundingBox(),to=await header('valueCr').locator('..').boundingBox();
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width-2,to.y+to.height/2,{steps:8});await page.mouse.up();
 assert.equal(await firstFund(),'Fund 01','Dragging the sort button does not activate its sort');
 assert.equal(await page.locator('.mf-detail-table thead tr').nth(1).locator('th').nth(1).locator('button').getAttribute('data-mf-fund-sort'),'shares');
 await page.locator('[data-mf-next]').click();assert.match(await page.locator('[data-mf-page]').textContent(),/^51–54/);
 await header('shares').locator('..').click();assert.equal(await firstFund(),'Fund 52','Sort includes funds beyond the previous rendered page');assert.match(await page.locator('[data-mf-page]').textContent(),/^1–50/);
 await header('shares').press('Enter');assert.equal(await firstFund(),'New Fund','The second click/keyboard activation sorts ascending');
 await page.locator('[data-mf-next]').click();assert.equal(await page.locator('.mf-detail-table tbody tr').last().locator('td span').first().textContent(),'Missing Fund','Missing shares remain last in ascending order');
 // Distinct expected extrema expose sorting the wrong month, percentages as text, or rendered commas.
 for(const [key,descending,ascending] of [['valueCr','Fund 01','New Fund'],['pctOfAum','Fund 52','New Fund'],['change','Fund 52','Fund 01'],['changePct','Fund 52','Fund 01'],['shares:0','Fund 01','New Fund'],['changePct:0','Fund 01','Fund 52'],['shares:1','Fund 01','New Fund'],['changePct:1','Fund 52','Fund 01']]){
   await header(key).click();assert.equal(await firstFund(),descending,`${key} descending`);
   assert.equal(await header(key).locator('..').getAttribute('aria-sort'),'descending');
   await header(key).click();assert.equal(await firstFund(),ascending,`${key} ascending`);
   assert.equal(await header(key).locator('..').getAttribute('aria-sort'),'ascending');
 }
 await header('changePct').click();await page.locator('[data-mf-next]').click();
 assert.deepEqual(await page.locator('.mf-detail-table tbody tr').locator('td:first-child > span').allTextContents(),['Fund 02','Fund 01','Missing Fund','New Fund'],'Missing and New percentages have no numeric rank in either direction');
 await header('name').click();await header('name').click();assert.equal(await firstFund(),'New Fund');
 await page.locator('[data-mf-fund-search]').fill('Fund 0');assert.equal(await firstFund(),'Fund 09','Search retains the chosen sort');
 fixture.company.name='Refreshed fixture company';await page.clock.fastForward(61000);
 await page.waitForSelector('h2:has-text("Refreshed fixture company")');
 assert.equal(await header('name').locator('..').getAttribute('aria-sort'),'descending');
 assert.equal(await page.locator('.mf-detail-table thead tr').nth(1).locator('th').nth(1).locator('button').getAttribute('data-mf-fund-sort'),'shares','Automatic refresh retains the column layout and sort');
 assert.equal(await page.locator('[data-mf-fund-search]').inputValue(),'Fund 0','Automatic refresh retains the query');assert.equal(await firstFund(),'Fund 09','Automatic refresh retains sorting');
 await page.keyboard.press('Escape');await page.locator(`[data-row-key="${held.isin}"]`).click();await page.waitForSelector('[data-mf-fund-sort="change"]');
 assert.equal(await header('change').locator('..').getAttribute('aria-sort'),'descending','Opening another detail starts with the normal monthly-change ordering');
 await page.keyboard.press('Escape');
 // Exercise the production reader on a local-only mocked origin, including pagination and failure.
 const apiPage=await browser.newPage();const apiOrigin='http://mutual-funds.test';let apiCalls=0,version=1,fail=false,privateFail=false,privateFailureReason=null;
 const apiBook=Array.from({length:502},(_,i)=>({isin:`INE${String(i).padStart(9,'0')}`,ticker:`FIX${i}`,name:`Fixture ${i}`}));
 await apiPage.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!==apiOrigin)return route.fulfill({status:200,body:''});
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<script type="module">window.feed=await import("/js/data/mutual-funds.js");</script>'});
   if(u.pathname==='/js/core/host-context.js')return route.fulfill({contentType:'text/javascript',body:`let token=null;const listeners=[];window.testSession=value=>{token=value;listeners.forEach(fn=>fn({}, {session:true}));};export const hostToken=()=>token;export const authHeaders=()=>token?{authorization:'Bearer '+token}:{};export const onHostContext=fn=>{listeners.push(fn);return()=>{};};`});
   if(u.pathname==='/api/mutual-funds/private'||u.pathname==='/api/mutual-funds/private/company'){assert.equal(route.request().headers().authorization,'Bearer fixture-private');if(privateFailureReason)return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({reason:privateFailureReason})});if(privateFail)return route.fulfill({status:503,body:'{}'});return route.fulfill({contentType:'application/json',headers:{'cache-control':'private, no-store'},body:JSON.stringify({rows:(u.searchParams.get('isins')||'').split(',').filter(Boolean).map(isin=>({...apiBook.find(h=>h.isin===isin),totalShares:999999})),meta:{supplement:{currentCompanies:502,expectedCompanies:502}},company:{isin:u.searchParams.get('isin'),totalShares:999999}})});}
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
 for(const reason of ['identity-unavailable','configuration-unavailable','no-session']){privateFailureReason=reason;await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);assert.equal(await apiPage.evaluate(()=>window.feed.meta().supplementAccess),reason,'Authentication failures retain their verified reason');assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3);}
 privateFailureReason=null;
 await apiPage.evaluate(()=>window.testSession(null));assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3);
 await apiPage.reload();await apiPage.waitForFunction(()=>!!window.feed);fail=true;
 await apiPage.evaluate(book=>window.feed.load('portfolio',{holdings:book}),apiBook);
 assert.equal(await apiPage.evaluate(()=>window.feed.all()[0].totalShares),3,'Private summaries never entered the persistent public cache');
 assert.equal(await apiPage.evaluate(async isin=>(await window.feed.detail(isin)).company.totalShares,apiBook[0].isin),3,'Private detail never entered the persistent public cache');
 await apiPage.close();
 // A real table paints from persisted summaries while the refresh is held open.
 let releaseSeed;seedGate=new Promise(done=>releaseSeed=done);
 await page.reload();await page.waitForSelector('[data-row-key]');
 const cachedSearch=page.locator('input[placeholder="Search company..."]');
 const cachedCompany=ownershipFixtures[0];
 await cachedSearch.fill(fixtureBook.find(h=>h.isin===cachedCompany.isin).name);await page.waitForTimeout(350);
 const cachedRow=page.locator(`[data-row-key="${cachedCompany.isin}"]`);
 assert((await cachedRow.textContent()).includes(cachedCompany.totalShares.toLocaleString('en-IN')),'saved rows render before the response');
 const oldShares=cachedCompany.totalShares;cachedCompany.totalShares=oldShares+123;
 releaseSeed();seedGate=null;
 await page.waitForFunction(({isin,shares})=>document.querySelector(`[data-row-key="${isin}"]`)?.textContent.includes(shares),{isin:cachedCompany.isin,shares:cachedCompany.totalShares.toLocaleString('en-IN')});
 assert.equal(await cachedSearch.inputValue(),fixtureBook.find(h=>h.isin===cachedCompany.isin).name,'background corrections preserve search');
 await page.evaluate(()=>window.tab.destroy());assert.deepEqual(errors,[]);console.log('PASS Mutual Funds browser: all portfolio rows, private weight order, month-grouped popup, bounded fund rows, offscreen search, keyboard close, dark/mobile rendering and zero page errors');
}finally{await browser.close();await new Promise(done=>server.close(done));}
