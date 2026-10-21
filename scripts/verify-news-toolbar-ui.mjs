// Full dashboard with local captures: search identities, filter intersections and toolbar geometry.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public'),at='2026-10-13T06:00:00Z';
const company=(i)=>({isin:`INE${String(i).padStart(4,'0')}01${String(i%1000).padStart(3,'0')}`,ticker:`TEST${i}`,name:`Fixture Company ${i}`,bseCode:String(550000+i),status:'Active'});
const ltim={isin:'INE214T01019',ticker:'LTIM',name:'LTI Mindtree Limited',bseCode:'540005',status:'Active'};
const harbor={isin:'INE1HA201011',name:'Harbor Textiles Limited',bseCode:'545678',status:'Suspended'};
const bse=[ltim,harbor,...Array.from({length:1000},(_,i)=>company(i))];
const equity=[ltim,...Array.from({length:1000},(_,i)=>company(i))],sme=Array.from({length:100},(_,i)=>company(i+5000));
const story=(id,title,publisher='Mint',section='stocks',date=at)=>({id,title,publisher,section,publishedAt:date,image:'https://example.test/news-thumb.svg',url:`https://example.test/${id}`,summary:'Published fixture summary'});
let articles=[story('lti','LTI Mindtree raises guidance'),story('harbor','Harbor Textiles announces expansion','Economic Times','news'),story('old','LTI Mindtree older dividend','Mint','stocks','2026-10-10T06:00:00Z'),
 ...Array.from({length:1200},(_,i)=>story(`other-${i}`,`Other business update ${i}`,i%2?'Mint':'Economic Times',i%2?'stocks':'news'))];
const companyRows=[{ticker:'LTIM',company:ltim.name,title:'Dividend declared without a company in the headline',date:'2026-10-13',source:'Mint',url:'https://example.test/company-news',
 companyAttribution:{status:'uncertain',queryTicker:'LTIM',queryCompany:ltim.name}}];
companyRows.push(...['illustrated','broken',...Array.from({length:240},(_,i)=>'saved-'+i)].map(id=>({...companyRows[0],title:'LTI Mindtree portfolio update '+id,url:'https://example.test/'+id,summary:'Publisher standfirst is preserved.',image:id==='illustrated'?'https://example.test/news-thumb.svg':id==='broken'?'https://example.test/broken-image.svg':null})));
companyRows[1].publishedAt='2026-10-13'; // A source day alone must never grow an invented clock.
const votes={}, postedVotes=[];
const requests=[];
const bootstrap=`<script type="module">import * as coverage from '/js/data/coverage.js';import {mount} from '/js/ui/shell.js';coverage.prime({holdings:${JSON.stringify([ltim])}});mount(document.querySelector('#app'));</script>`;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://local').pathname;requests.push(path);res.setHeader('cache-control','no-store');
 const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
 if(path==='/api/relevance/feedback' && req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const entry=JSON.parse(body);postedVotes.push(entry);if(entry.vote==='clear')delete votes[entry.itemKey];else votes[entry.itemKey]=entry;json({ok:true});});return;}
 if(path==='/api/relevance/mine')return json({ok:true,votes});
 if(path==='/data/announcement-identities.json')return json({version:1,capturedAt:at,entries:bse});
 if(path==='/data/filing-capture/nse-identities.json')return json({version:1,directories:{equity:{checkedAt:at,entries:equity},sme:{checkedAt:at,entries:sme}}});
 if(path==='/data/market-news.json')return json({capturedAt:at,articles,sources:[],archivedCount:articles.length,archive:[]});
 if(path==='/data/twitter-handles.json')return json({capturedAt:at,handles:['fixture']});
 if(path==='/data/twitter-posts.json')return json({capturedAt:at,posts:[{id:'post',handle:'fixture',text:'LTI Mindtree management raises guidance',created_at:at,url:'https://example.test/post'}],byHandle:{},failed:[]});
 if(path==='/data/news.json')return json({capturedAt:at,entities:[{...ltim,key:'LTIM'}],byTicker:{LTIM:companyRows}});
 if(path==='/js/core/watch.js'){res.setHeader('content-type','text/javascript');return res.end('export const start=()=>{};export const ensureRunning=()=>{};export const refreshNow=async()=>{};');}
 if(path.startsWith('/api/')||path.startsWith('/data/'))return res.writeHead(404).end('{}');
 const file=resolve(root,`.${path==='/'?'/index.html':path}`);if(!file.startsWith(root+sep))return res.writeHead(404).end();
 try{let body=readFileSync(file);if(path==='/'||path==='/index.html')body=body.toString().replace(/<script type="module" src="js\/app\.js"><\/script>/,bootstrap);
 res.setHeader('content-type',{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'text/plain');res.end(body);}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const evidence=resolve('.cache/news-ui');mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch();
try{
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:800}});
 await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.request().url()==='https://example.test/news-thumb.svg'?r.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="135" height="76"><rect width="135" height="76" fill="#065f46"/><text x="10" y="43" fill="white">Publisher image</text></svg>'}):r.fulfill({status:404,body:'{}'}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date(at)});
 await page.goto(origin+'/#/research/news?scope=universe');
 await page.waitForFunction(()=>document.querySelector('[data-news-count]')?.textContent.includes('1,20'));
 await page.waitForFunction(()=>!document.querySelector('[data-table-loading]'));
 const search=page.getByRole('textbox',{name:'Search company, ticker or headline'});
 assert(!requests.includes('/data/announcement-identities.json'),'full directory stays off initial News load');
 for(const [width,height] of [[1345,647],[1280,800],[1024,768],[390,800]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
  await page.waitForFunction(()=>{const s=document.querySelector('[data-news-scroll]');return Math.abs(s.getBoundingClientRect().bottom-(innerHeight-44))<2});
  const geometry=await page.evaluate(()=>({search:document.querySelector('[data-news-search]').getBoundingClientRect().width,
   primary:[...document.querySelector('.news-toolbar-primary').children].map(x=>x.getBoundingClientRect().top),
   second:document.querySelector('.news-toolbar-filters').getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth+1}));
  assert(!geometry.overflow,'no page overflow at '+width);
  assert(geometry.search>(width===390?280:350),'search has useful company/headline width at '+width);
  for(const selector of ['[data-news-period]','[data-news-publisher]','[data-news-section]','[data-news-topic]','[data-news-export]'])assert(await page.locator(selector).isVisible(),'reachable '+selector);
  if(width>=1024)assert(geometry.second>Math.max(...geometry.primary)+25,'filters have their own deliberate row');
  const firstCard=page.locator('[data-news-key]').first();
  assert.equal(await firstCard.locator('a [data-news-feedback]').count(),0,'feedback stays outside the story link');
  assert.equal(await firstCard.getByRole('button',{name:'Important',exact:true}).isVisible(),false,'feedback stays out of the scan');
  assert.equal(await firstCard.locator('.news-story-summary').isVisible(),false,'summaries expand on demand');
  if(width>=1024){
   const visible=await page.evaluate(()=>{const s=document.querySelector('[data-news-scroll]').getBoundingClientRect();return [...document.querySelectorAll('[data-news-key]')].filter(r=>{const b=r.getBoundingClientRect();return b.top>=s.top && b.bottom<=Math.min(s.bottom,innerHeight)}).length});
   console.log(`Market News ${width}x${height}: ${visible} complete rows`);
   assert(visible>=10,'at least 10 complete stories at normal zoom');
   assert(await page.evaluate(()=>document.querySelector('.beacon-launcher').getBoundingClientRect().top>=document.querySelector('[data-news-scroll]').getBoundingClientRect().bottom),'source launcher does not cover a story');
  }
  assert.equal(await page.locator('[data-section-head] p').count(),0,'no explanatory paragraph above News');
  assert.equal(await page.locator('[data-news-more]').isVisible(),false,'successful history adds no footer clutter');
  await page.screenshot({path:resolve(evidence,`market-${width}.png`)});
  await firstCard.locator('summary').click();
  for(const name of ['Important','Not important','Why?'])assert(await firstCard.getByRole('button',{name,exact:true}).isVisible(),'expanded feedback '+name+' at '+width);
  const footer=await firstCard.evaluate(card=>({top:card.querySelector('[data-news-feedback]').getBoundingClientRect().top,bottom:card.querySelector('a').getBoundingClientRect().bottom}));
  assert(footer.top>=footer.bottom,'feedback is below the story at '+width);
  await firstCard.locator('summary').click();
 }
 await page.setViewportSize({width:1280,height:800});
 await search.fill('LTIM guidance');
 await page.waitForFunction(()=>!document.querySelector('[data-table-loading]') && document.querySelector('[data-news-key]')?.textContent.includes('LTI Mindtree raises guidance'));
 await page.waitForFunction(()=>document.querySelectorAll('[data-news-key]').length===2);
 assert.equal(await page.evaluate(async()=>(await import('/js/data/twitter-news.js')).rows()[0].ticker),undefined,'text search does not attribute a post to a company');
 await page.getByRole('combobox',{name:'Source',exact:true}).selectOption('publishers');
 await page.waitForFunction(()=>document.querySelectorAll('[data-news-key]').length===1);
 assert.equal(await page.locator('[data-news-key]').count(),1,'ticker plus headline keyword expands to canonical company name');
 await search.fill('LTI Mindtree Limited guidance');
 await page.waitForFunction(()=>!document.querySelector('[data-table-loading]') && document.querySelector('[data-news-key]')?.textContent.includes('LTI Mindtree raises guidance'));
 assert.equal(await page.locator('[data-news-key]').count(),1,'full legal company name plus keyword matches a headline without the legal suffix');
 await search.fill('545678');await page.waitForFunction(()=>document.querySelector('[data-news-key]')?.textContent.includes('Harbor Textiles'));
 assert.equal(await page.locator('[data-news-key]').count(),1,'BSE-only suspended company is searchable by code');
 await search.fill('mindtree');await page.waitForFunction(()=>document.querySelector('[data-news-key]')?.textContent.includes('guidance'));
 await page.getByRole('combobox',{name:'News period',exact:true}).selectOption('7');
 await page.waitForFunction(()=>document.querySelectorAll('[data-news-key]').length===2);
 await page.getByRole('combobox',{name:'Publisher',exact:true}).selectOption('Mint');
 assert.equal(await search.inputValue(),'mindtree','filters preserve search');
 // Source updates retain query, period and outlet. Export uses this full intersection.
 articles=[story('new-lti','LTI Mindtree guidance update'),...articles];
 await page.evaluate(async()=>await(await import('/js/data/market-news.js')).refresh());
 await page.waitForFunction(()=>document.querySelectorAll('[data-news-key]').length===3);
 assert.equal(await search.inputValue(),'mindtree');
 assert.equal(await page.getByRole('combobox',{name:'News period',exact:true}).inputValue(),'7');
 assert.equal(await page.getByRole('combobox',{name:'Publisher',exact:true}).inputValue(),'Mint');
 await page.evaluate(()=>{window.exportedRows=0;window.ExcelJS={Workbook:class{constructor(){this.xlsx={writeBuffer:async()=>new Uint8Array()};}addWorksheet(){return{addRow(){window.exportedRows++;},getRow(){return{};}};}}};});
 await page.locator('[data-news-export]').click();await page.waitForFunction(()=>window.exportedRows>0);
 assert.equal(await page.evaluate(()=>window.exportedRows),4,'export includes exactly three filtered articles and provenance');
 await search.fill('');await page.getByRole('combobox',{name:'Publisher',exact:true}).selectOption('all');
 await page.waitForFunction(()=>Number(document.querySelector('[data-mcnews-list]')?.dataset.virtualTotal)>1000);
 assert(await page.locator('[data-news-key]').count()<100,'full capture remains available with bounded mounted cards');
 await page.goto(origin+'/#/research/news?scope=portfolio');
 await page.locator('[data-table-search]').waitFor();
 await page.getByRole('textbox',{name:'Search company, ticker or headline'}).fill('LTIM dividend');
 await page.waitForFunction(()=>document.querySelector('tbody tr[data-row-key]')?.textContent.includes('Dividend declared without'));
 assert.equal(await page.locator('tbody tr[data-row-key]').count(),1,'company metadata is searched when absent from the headline');
 assert.equal(await page.locator('.news-toolbar-primary [data-table-search]').count(),1);
 assert.equal(await page.locator('.news-toolbar-filters select').count(),3,'all scoped secondary filters remain available');
 const companyStory=page.locator('tbody tr[data-row-key]').first();
 assert.match(await companyStory.locator('.news-story-company').textContent(),/Possible match.*LTI Mindtree.*LTIM/,'unverified company relationship stays visible');
 await companyStory.locator('summary').click();
 for(const name of ['Important','Not important','Why?'])assert(await companyStory.getByRole('button',{name,exact:true}).isVisible(),'visible company-news feedback '+name);
 assert.equal(await companyStory.locator('a [data-news-feedback]').count(),0,'company feedback is outside the article link');
 await companyStory.locator('summary').click();
 await page.getByRole('textbox',{name:'Search company, ticker or headline'}).fill('');
 await page.waitForFunction(()=>Number(document.querySelector('[data-score-table]')?.dataset.virtualTotal)>240);
 assert(await page.locator('tbody tr[data-row-key]').count()<100,'Portfolio bounds mounted cards, with every article still eligible');
 const illustrated=page.locator('[data-news-key]').filter({hasText:'portfolio update illustrated'});
 const broken=page.locator('[data-news-key]').filter({hasText:'portfolio update broken'});
 await illustrated.waitFor();
 for(const [width,height] of [[1345,647],[1280,800],[1024,768]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
  await page.waitForFunction(()=>{const s=document.querySelector('[data-table-scroll]');return Math.abs(s.getBoundingClientRect().bottom-(innerHeight-44))<2});
  const visible=await page.evaluate(()=>{const s=document.querySelector('[data-table-scroll]').getBoundingClientRect();return [...document.querySelectorAll('[data-news-key]')].filter(r=>{const b=r.getBoundingClientRect();return b.top>=s.top && b.bottom<=Math.min(s.bottom,innerHeight)}).length});
  console.log(`Portfolio News ${width}x${height}: ${visible} complete rows`);assert(visible>=10,'at least 10 scoped stories at normal zoom');
 }
 await page.setViewportSize({width:1280,height:800});
 await illustrated.locator('summary').click();
 await broken.locator('summary').click();
 await illustrated.locator('.news-story-thumbnail img').evaluate(img=>img.decode());
 assert.equal(await illustrated.locator('.news-story-thumbnail img').evaluate(img=>img.complete&&img.naturalWidth>0),true,'publisher image reaches Portfolio');
 await page.waitForFunction(()=>[...document.querySelectorAll('.news-story-thumbnail img')].some(img=>img.src.endsWith('broken-image.svg')&&img.hidden));
 assert(await broken.locator('.news-story-placeholder').isVisible(),'broken images show a clean placeholder');
 assert(!/05:30/.test(await illustrated.locator('.news-story-meta').textContent()),'date-only publications do not gain a clock');
 assert(await illustrated.locator('.news-story-summary').isVisible(),'Portfolio reproduces the publisher standfirst');
 assert.match(await illustrated.locator('.news-story-company').textContent(),/Company matched.*LTI Mindtree.*LTIM/,'identity confidence remains visible');
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:800});
   const colors=await illustrated.evaluate(card=>Object.fromEntries(['important','not-important'].map(value=>{const b=card.querySelector('[data-vote="'+value+'"]'),s=getComputedStyle(b);return[value,{ink:s.color,bg:s.backgroundColor,height:b.getBoundingClientRect().height}]})));
   assert.notEqual(colors.important.ink,colors['not-important'].ink,'green/red choices differ in '+theme);
   assert.notEqual(colors.important.bg,colors['not-important'].bg,'green/red surfaces differ in '+theme);
   if(width===390)assert(colors.important.height>=44,'touch target stays usable');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Portfolio has no horizontal overflow');
   await illustrated.scrollIntoViewIfNeeded();
   await page.screenshot({path:resolve(evidence,`portfolio-${theme}-${width}.png`)});
  }
 }
 await page.setViewportSize({width:1280,height:800});
 await illustrated.getByRole('button',{name:'Important',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-news-key*="illustrated"] [data-vote="important"]')?.getAttribute('aria-pressed')==='true');
 const solid=await illustrated.locator('[data-vote="important"]').evaluate(b=>getComputedStyle(b).backgroundColor);
 assert.equal(solid,'rgb(4, 120, 87)','selected Important uses a solid green fill');
 await illustrated.getByRole('button',{name:'Not important',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-news-key*="illustrated"] [data-vote="not-important"]')?.getAttribute('aria-pressed')==='true');
 assert.equal(await illustrated.locator('[data-vote="not-important"]').evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(190, 18, 60)','selected Not important uses a solid red fill');
 await illustrated.getByRole('button',{name:'Why?',exact:true}).click();
 await illustrated.locator('[data-why-text]').fill('Routine update');
 await illustrated.getByRole('button',{name:'Save as not important',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-news-key*="illustrated"] [data-why]')?.getAttribute('aria-expanded') || document.querySelector('[data-news-key*="illustrated"] [data-why]')?.getAttribute('aria-expanded')==='false');
 assert.equal(postedVotes.at(-1).why,'Routine update','optional reason is saved with the vote');
 await illustrated.getByRole('button',{name:'Not important',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-news-key*="illustrated"] [data-vote="not-important"]')?.getAttribute('aria-pressed')==='false');
 assert.equal(postedVotes.at(-1).vote,'clear','pressing the selected choice still withdraws it');
 assert(!requests.some(path=>path==='/api/stock-search'),'company lookup uses captured exchange directories, not another search service');
 assert.deepEqual(errors,[]);
 console.log('PASS full-shell News toolbar: wide unified search, desktop/mobile filters, ticker/name and BSE-only code expansion, company metadata, refresh retention, full filtered export, bounded cards in both scopes, publisher images/fallbacks, mobile/dark layouts and semantic feedback with reasons/undo');
}finally{await browser.close();await new Promise(done=>server.close(done));}
