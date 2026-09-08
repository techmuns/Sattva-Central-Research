// Local browser fixtures only: no real account, paid text or source quota is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScreenerSummary } from './lib/read-screener-summary.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(root, 'data/concall-scans.json')));
const row = { ...fixture.rows[0], name: 'Summary fixture company', documents: [
  {type:'Transcript',url:'https://example.test/transcript.pdf'},
  {type:'Summary',url:'https://www.screener.in/concalls/summary/123/'},
  {type:'Summary',url:'https://www.screener.in/concalls/summary/124/'},
  {type:'Summary',url:'https://www.screener.in/concalls/summary/123/'},
] };
fixture.rows = [row, {...row,companyKey:'OTHER',ticker:'OTHER',name:'Other fixture',documents:[{type:'Summary',url:'https://www.screener.in/concalls/summary/999/'}]}];
const text = 'Private fixture notes describe management discussion of operating performance, current demand and costs. These words are synthetic test data and are never a company report.';
const body = {title:'Concall Summary - Summary fixture company - Sep 2026',blocks:[
  {type:'heading',text:'Operating performance'}, {type:'paragraph',text},
  {type:'list',items:['<img src=x onerror=alert(1)>','Second note'],ordered:false},
  {type:'table',rows:[['Measure','Value'],['Fixture','12']]},
]};
let enabled = true, denied = false, delayed = null, pendingId = null, timerReason = 'recent-run';
let savedIds=['123','124'], discoveryStatus='ok', cooldownUntil=null;
let getCount=0, postCount=0;
const state = () => ({ok:true,enabled,ready:savedIds.length,readyIds:savedIds,pending:1,discoveryStatus,cooldownUntil,portfolioCheckedAt:new Date().toISOString(),sourceCheckedAt:new Date().toISOString(),
  schedule:{started:true,reason:timerReason,alarmAt:Date.now()+1800000,lastAttemptAt:Date.now()},
  holdings:[{isin:'INE000000001',name:'Summary fixture company',ready:2,pending:1,discovery:'matched'},
    {isin:'INE000000002',name:'New portfolio holding',ready:0,pending:0,discovery:'no-published-summary'}]});
const server = createServer(async (req,res) => {
  const path=new URL(req.url,'http://localhost').pathname;
  res.setHeader('cache-control','no-store');
  if(path.startsWith('/api/')) {
    res.setHeader('content-type','application/json');
    if(path==='/api/concalls') return res.end(JSON.stringify(fixture));
    if(path==='/api/concall-summaries') {
      assert.equal(req.headers.authorization,'Bearer local-test-token');
      if(req.method==='GET') {getCount++; return res.end(JSON.stringify(state()));}
      postCount++;
      let raw='';for await(const chunk of req) raw+=chunk;
      if(delayed) await delayed;
      if(denied) {res.statusCode=401;return res.end('{"ok":false,"reason":"access"}');}
      return res.end(JSON.stringify({ok:true,records:JSON.parse(raw).ids.map(id=> id===pendingId ? {id,status:'queued'} :
        {id,status:'ready',name:row.name,kind:id==='124'?'Recording':'Transcript',publishedDate:'2026-09-04',fetchedAt:new Date().toISOString(),body:{...body,title:body.title+(id==='124'?' - recording':'')}})}));
    }
    return res.end('{"ok":false,"error":"Local fixture"}');
  }
  const file=resolve(root,`.${path==='/'?'/index.html':path}`);
  if(!file.startsWith(root+sep)) return res.writeHead(404).end();
  try {res.setHeader('content-type',{'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'text/plain');res.end(readFileSync(file));}
  catch {res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const external=[];
  await context.route('**/*',route=>{
    if(route.request().url().startsWith(origin+'/')) return route.continue();
    external.push(route.request().url());
    const script=route.request().resourceType()==='script';
    return route.fulfill({status:200,contentType:script?'text/javascript':'application/json',body:script?'':'{"ok":false}'});
  });
  await context.addInitScript(()=>{
    let ctx={session:{token:'local-test-token',email:'fixture@example.test'}},listeners=[];
    window.MunshotDashboardSDK={createDashboardClientSdk:()=>({getContext:()=>ctx,onMessage:fn=>{listeners.push(fn);return()=>{};},onRequest:()=>()=>{},onEvent:()=>()=>{},emit:()=>false,requestContext:()=>false})};
    window.fixtureSession=token=>{ctx={session:token?{token,email:'fixture@example.test'}:null};listeners.forEach(fn=>fn());};
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/#/research/concall?scope=universe`);
  const button=page.locator('[data-screener-summary]').first();
  await button.waitFor();assert.equal(await page.locator('[data-screener-summary]').count(),2);
  assert.equal(await button.evaluate(el=>el.closest('tr').querySelectorAll('[data-screener-summary]').length),1,'one action for duplicate and distinct summary references');
  assert.equal(await page.locator('a[href*="/concalls/summary/"]').count(),0);
  const before=page.url(), pages=context.pages().length;
  await button.click();await page.locator('[data-summary-version]').waitFor();
  assert(await page.evaluate(()=>document.querySelector('#modal-container').contains(document.activeElement)),'loading keeps keyboard focus inside the reader');
  assert.equal(postCount,1);assert.equal(page.url(),before);assert.equal(context.pages().length,pages);
  assert.equal(await page.locator('[data-summary-body] img').count(),0,'provider strings are inert');
  assert((await page.locator('[data-summary-body]').innerText()).includes('<img src=x onerror=alert(1)>'));
  await page.locator('[data-summary-version]').selectOption('1');
  assert((await page.locator('[data-summary-body]').innerText()).includes(' - recording'));
  await page.getByRole('button',{name:'Close summary',exact:true}).click();
  await button.click();await page.locator('[data-summary-version]').waitFor();assert.equal(postCount,1,'repeat click reads the saved in-session body');
  assert.equal(external.some(url=>url.includes('/concalls/summary/')),false,'reader does not visit Screener');
  await page.keyboard.press('Escape');
  await page.locator('[data-summary-coverage-open]').click();
  assert((await page.locator('#modal-content').innerText()).includes('New portfolio holding'));
  assert((await page.locator('#modal-content').innerText()).includes('No summary listed by Screener'));
  timerReason='unavailable';
  await page.evaluate(async()=>{await (await import('/js/data/concall-summaries.js')).refresh({force:true});});
  assert((await page.locator('[data-summary-coverage]').innerText()).includes('could not check or start'));
  assert((await page.locator('[data-summary-schedule]').innerText()).includes('could not check or start'),'open coverage view updates without reopening');
  assert((await page.locator('[data-summary-schedule]').innerText()).includes('Next timer check:'));
  timerReason='recent-run';
  discoveryStatus='failed';cooldownUntil=new Date(Date.now()+86400000).toISOString();
  await page.evaluate(async()=>{await (await import('/js/data/concall-summaries.js')).refresh({force:true});});
  for(const selector of ['[data-summary-coverage]','#modal-content']) {
    const text=await page.locator(selector).innerText();assert(text.includes('could not be refreshed')&&text.includes('paused'),'a source pause cannot conceal failed discovery');
  }
  discoveryStatus='ok';cooldownUntil=null;
  await page.keyboard.press('Escape');
  // A pending note is requested again once collected, never cached as permanently unavailable.
  pendingId='123';await page.evaluate(async()=>{const s=await import('/js/data/concall-summaries.js');s.clear();await s.refresh({force:true});});
  await button.click();await page.locator('[data-summary-reader]').waitFor();assert.equal(await page.locator('[data-summary-version]').count(),0);
  pendingId=null;await page.keyboard.press('Escape');await button.click();await page.locator('[data-summary-version]').waitFor();
  assert.equal(postCount,3);
  await page.keyboard.press('Escape');
  body.blocks.push(...Array.from({length:35},()=>({type:'paragraph',text})));
  await page.evaluate(async()=>{const s=await import('/js/data/concall-summaries.js');s.clear();await s.refresh({force:true});});
  await button.click();await page.locator('[data-summary-version]').waitFor();
  assert(await page.locator('#modal-content').evaluate(el=>el.scrollHeight>el.clientHeight),'a full report scrolls within the reader');
  assert(await page.locator('#modal-container').evaluate(el=>el.getBoundingClientRect().top>=0),'long reports do not hide the top of the modal above the viewport');
  await page.locator('#modal-content').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert(await page.getByRole('button',{name:'Close summary',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'close remains accessible at the end of a long report');
  // Reader layout in both themes and on a narrow viewport.
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.waitForFunction(theme=>getComputedStyle(document.querySelector('#modal-container')).backgroundColor === (theme==='dark'?'rgb(22, 33, 52)':'rgb(255, 255, 255)'),theme);
    const contrast=await page.locator('[data-summary-body] p.whitespace-pre-wrap').first().evaluate(el=>{
      const luma=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
      const a=luma(getComputedStyle(el).color),b=luma(getComputedStyle(document.querySelector('#modal-container')).backgroundColor);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });assert(contrast>=4.5,'summary body text is readable in each theme');
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('#modal-container').evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
    if(process.env.SUMMARY_SCREENSHOTS) {mkdirSync(process.env.SUMMARY_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.SUMMARY_SCREENSHOTS}/summary-${theme}.png`,fullPage:true});}
  }
  await page.setViewportSize({width:1440,height:1000});await page.keyboard.press('Escape');
  // Logging out after navigating away still clears bodies; the next account cannot inherit them.
  await page.evaluate(()=>location.hash='#/research/ask-research?scope=universe');
  await page.locator('.research-workspace').waitFor();
  await page.evaluate(()=>{window.fixtureSession(null);window.fixtureSession('local-test-token');});
  denied=true;
  const result=await page.evaluate(async()=>{try {await (await import('/js/data/concall-summaries.js')).read(['123']);return 'leaked';}catch{return 'refused';}});
  assert.equal(result,'refused');assert.equal(postCount,5);
  denied=false;enabled=false;savedIds=['123'];
  await page.evaluate(()=>location.hash='#/research/concall?scope=universe');
  await page.locator('[data-summary-coverage]').waitFor();
  await page.evaluate(async()=>{await (await import('/js/data/concall-summaries.js')).refresh({force:true});});
  await button.waitFor();
  assert.equal(await page.locator('[data-screener-summary]').nth(1).isVisible(),false,'disabled collection exposes only exact saved IDs');
  const search=page.locator('[data-table-search]');
  await search.fill('Other fixture');await page.waitForFunction(()=>document.querySelectorAll('[data-screener-summary]').length===1);
  assert.equal(await button.isVisible(),false,'unsaved cached rows stay hidden after filtering');
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-screener-summary]').length===2);
  await button.waitFor();
  savedIds=[];await page.evaluate(async()=>{await (await import('/js/data/concall-summaries.js')).refresh({force:true});});
  assert.equal(await button.isVisible(),false,'disabled collection without saved notes hides every Summary action');
  enabled=true;savedIds=['123','124'];await page.evaluate(async()=>{await (await import('/js/data/concall-summaries.js')).refresh({force:true});});
  await button.waitFor();
  let release;delayed=new Promise(done=>release=done);await button.click();
  await page.waitForFunction(()=>document.querySelector('#modal-content')?.textContent.includes('Loading saved'));
  await page.evaluate(()=>window.fixtureSession(null));release();delayed=null;
  await page.waitForFunction(()=>document.querySelector('#modal-overlay').classList.contains('hidden'));
  assert.equal(await page.locator('[data-summary-body]').count(),0,'late prior-session content cannot reopen the reader');
  assert(getCount>=4);assert.deepEqual(errors,[]);
  await context.close();

  // Source parser is exercised offline with script execution disabled, as in collection.
  const sourceContext=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
  let html=`<main><h1>Concall Summary - Test Ltd - Sep 2026</h1><a href="/company/TEST/">Test Ltd</a><h2>Operating performance</h2><p>${text}</p><ul><li>Demand discussion</li><li>Cost discussion</li></ul><table><tr><th>Measure</th><th>Value</th></tr><tr><td>Fixture</td><td>12</td></tr></table><footer>Account footer</footer></main>`;
  await sourceContext.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
  const sourcePage=await sourceContext.newPage();
  const target={id:'123',url:'https://www.screener.in/concalls/summary/123/',companyUrl:'https://www.screener.in/company/TEST/'};
  const parsed=await readScreenerSummary(sourcePage,target);
  assert.equal(parsed.blocks.length,4);assert.equal(parsed.blocks[1].text,text);
  html=html.replace('<p>','<div>').replace('</p>','</div>');
  await assert.rejects(readScreenerSummary(sourcePage,target),e=>e.summaryCode==='structure-changed');
  html='<main><h1>Concall Summary - Test Ltd</h1><p>Limit exceeded - Please try again later. Premium users can request 80 summaries each day.</p></main>';
  await assert.rejects(readScreenerSummary(sourcePage,target),e=>e.summaryCode==='rate-limited');
  console.log('PASS private summary UI and parser: one inline reader, versions, inert content, pending recovery, portfolio gaps, session isolation, disabled state, responsive themes and quota/template refusals');
} finally {await browser.close();await new Promise(done=>server.close(done));}
