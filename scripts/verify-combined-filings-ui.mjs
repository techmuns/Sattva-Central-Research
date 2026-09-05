#!/usr/bin/env node
// Headless local regression harness, not a connection to the user's browser or production APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCombinedFilings } from '../worker/combined-filings.mjs';
import { handleDrhpFilings } from '../worker/drhp-filings.mjs';

const pwRoot = process.env.PLAYWRIGHT_ROOT;
if (!pwRoot) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${pwRoot}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const queries = [];
let fail = false;
const drhpQueries = [];
let drhpMode = 'normal';
let drhpDelay = 0;
const drhpCompany = 'Example Alternative Asset Advisors Limited';
const drhpFixture = { symbol: null, company_name: drhpCompany, form_type: 'DRHP', filing_date: '2026-09-03', source: 'IND', documents: [
  { title: 'Draft prospectus', url: 'https://example.test/draft.pdf' },
  { name: 'Addendum', document_url: 'https://example.test/addendum.pdf' },
  { name: 'Unsafe link', url: 'javascript:alert(1)' },
] };
const fixture = [
  { ticker: 'STLTECH', title: 'Analyst meeting', source: 'NSE', date: '2026-09-03', filing_url: 'https://nsearchives.nseindia.com/corporate/stl.pdf', isRead: false },
  { ticker: 'STLTECH', title: 'Board outcome', source: 'BSE', date: '2026-09-02', filing_url: 'https://www.bseindia.com/stl.pdf', isRead: true },
  { ticker: 'STLTECH', title: 'Annual report', source: 'Screener', form: 'annual_report', date: '2026-08-01', filing_url: 'https://www.screener.in/stl.pdf' },
  { ticker: 'STLTECH', title: 'Outside requested dates', source: 'NSE', date: '2027-01-01', filing_url: 'https://example.test/future.pdf' },
];
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head><body class="bg-slate-50 p-6"><main id="root"></main>
<script>
let context = { session: { token: 'fixture.reader-a.session' } }; const listeners=[];
window.MunshotDashboardSDK={createDashboardClientSdk:()=>({getContext:()=>context,onMessage:fn=>{listeners.push(fn);return ()=>{};}})};
window.setTestSession=token=>{context={session:{token}};listeners.forEach(fn=>fn());};
window.clearTestSession=()=>{context={session:null};listeners.forEach(fn=>fn());};
</script><script type="module">
import {mountCompanyDocuments} from '/js/ui/company-documents.js';
import {mountDrhpDocuments} from '/js/ui/drhp-documents.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({holdings:[{ticker:'STLTECH',name:'Sterlite Technologies'}]});
let dispose; let activeTab;
window.showDocuments=(form='all',source=null,scope='portfolio')=>{dispose?.();dispose=mountCompanyDocuments({root:document.querySelector('#root'),scope,data:{universe:[{ticker:'STLTECH',name:'Sterlite Technologies'}]}},{form,source,label:'Company filings & reports'});};
window.showTab=async(name)=>{dispose?.();activeTab?.destroy();activeTab=await import('/js/tabs/'+name+'.js');activeTab.render({root:document.querySelector('#root'),scope:'portfolio',data:{universe:[]},params:{},live:{register(){},start(){},stop(){},subscribe(){return ()=>{};}}});};
window.showDrhp=()=>{dispose?.();activeTab?.destroy();activeTab=null;dispose=mountDrhpDocuments({root:document.querySelector('#root')});};
window.showDocuments();
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/stock-search') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok:true,results:[{ticker:'STLTECH',name:'Sterlite Technologies',country:'India',validTicker:true}]})); return; }
    if (url.pathname === '/api/drhp-filings') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const headers=new Headers(req.headers); headers.delete('origin');
      const response=await handleDrhpFilings(new Request('http://localhost/api/drhp-filings',{method:'POST',headers,body:Buffer.concat(chunks)}),{fetcher:async(path,init)=>{
        drhpQueries.push({company:decodeURIComponent(new URL(path).pathname.split('/').at(-1)),token:init.headers.authorization,method:init.method});
        if(drhpDelay)await new Promise(done=>setTimeout(done,drhpDelay));
        if(drhpMode==='failure')return Response.json({},{status:503});
        if(drhpMode==='empty')return Response.json([]);
        if(drhpMode==='unknown')return Response.json([{unexpected:true}]);
        if(drhpMode==='limit')return Response.json(Array.from({length:50},()=>drhpFixture));
        return Response.json([drhpFixture]);
      }});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    if (url.pathname === '/api/combined-filings') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers); headers.delete('origin');
      const request = new Request('http://localhost/api/combined-filings', { method:'POST', headers, body:Buffer.concat(chunks) });
      const response = await handleCombinedFilings(request, { now:()=>Date.parse('2026-09-04T07:00:00Z'), fetcher:async (_,init)=> {
        const query=JSON.parse(init.body); queries.push(query);
        if (fail) return Response.json({}, {status:503});
        return Response.json(query.form[0] === 'all' ? fixture : fixture.filter(r=>r.form===query.form[0]));
      }});
      res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const path=resolve(root,`.${url.pathname}`);
    if (!path.startsWith(root+sep)) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
let checks=0;
const check=(label,value)=>{assert.ok(value,label);checks++;console.log(`PASS ${label}`);};
try {
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await page.clock.install({time:new Date('2026-09-04T07:00:00Z')});
  await page.goto(origin); await page.locator('[data-doc-company]').waitFor();
  check('a page visit never fans out over the portfolio',queries.length===0);
  const load=async()=>{await page.locator('[data-doc-company]').fill('STLTECH');await page.locator('[data-doc-load]').click();await page.locator('[data-doc-load]:not([disabled])').waitFor();};
  await load();
  check('company documents have original source labels and caller read status',await page.locator('[data-doc-results] tbody tr').count()===3 && /Unread/.test(await page.locator('[data-doc-results]').innerText()) && /BSE/.test(await page.locator('[data-doc-results]').innerText()));
  check('records outside the selected dates are excluded with a visible count',!/Outside requested dates/.test(await page.locator('[data-doc-results]').innerText()) && /outside this company\/source\/date view/.test(await page.locator('[data-doc-status]').innerText()));
  check('duplicate/source lookup results never change portfolio membership',await page.evaluate(async()=>{const c=await import('/js/data/coverage.js');return c.holdings().length===1;}));
  await page.locator('[data-doc-results] [data-watch="STLTECH"]').first().click();
  check('starring a document watches the company, never the document id',await page.evaluate(async()=>{const w=await import('/js/core/watchlist.js');return w.all().length===1&&w.all()[0].ticker==='STLTECH';}));
  await page.evaluate(()=>window.showDocuments('all','NSE')); await load();
  check('NSE history excludes BSE and Screener-only documents',await page.locator('[data-doc-results] tbody tr').count()===1 && !/Board outcome|Annual report/.test(await page.locator('[data-doc-results]').innerText()));
  await page.evaluate(()=>window.showDocuments('concalls')); await load();
  check('Con-call requests only the documented concalls form',queries.at(-1).form[0]==='concalls');
  check('an empty document response is qualified, not proof of no filing',/does not prove no filing exists/.test(await page.locator('[data-doc-results]').innerText()));
  await page.evaluate(()=>window.showDocuments('earnings_report')); await load();
  check('company documents request earnings reports, not fabricated earnings figures',queries.at(-1).form[0]==='earnings_report');
  await page.evaluate(()=>window.showDocuments());
  await page.locator('[data-doc-form-type]').selectOption('annual_report'); await load();
  check('annual reports are available from the corporate document view',queries.at(-1).form[0]==='annual_report' && /Annual report/.test(await page.locator('[data-doc-results]').innerText()));
  await page.locator('[data-doc-company]').fill('Sterlite'); await page.locator('[data-doc-load]').click();
  await page.locator('[data-doc-suggestions] button').waitFor();
  check('company-name lookup requires an explicit identity selection',/Select the intended company/.test(await page.locator('[data-doc-status]').innerText()));
  await page.locator('[data-doc-suggestions] button').click(); await page.locator('[data-doc-results] tbody').waitFor();
  fail=true; await page.locator('[data-doc-load]').click();
  await page.waitForFunction(()=>document.querySelector('[data-doc-status]').textContent.includes('could not be reached'));
  check('service failure is visible and never presented as no documents',!(await page.locator('[data-doc-results]').innerText()).includes('No matching documents'));
  fail=false; await load();
  await page.evaluate(()=>window.setTestSession(null));
  check('logout clears private document records immediately',await page.locator('[data-doc-results]').innerText()==='' && /Sign in/.test(await page.locator('[data-doc-status]').innerText()));
  const before=queries.length; await page.locator('[data-doc-load]').click();
  check('missing user session never sends the deployment identity',queries.length===before);
  await page.evaluate(()=>window.setTestSession('fixture.reader-b.session')); await load();
  check('new sessions require a fresh document request',queries.length===before+1);
  if(process.env.DOCUMENT_SCREENSHOT_PATH)await page.screenshot({path:process.env.DOCUMENT_SCREENSHOT_PATH,fullPage:true});
  await page.evaluate(()=>window.clearTestSession());
  check('an explicit null session also clears private records and the token',await page.locator('[data-doc-results]').innerText()==='' && await page.evaluate(async()=>!(await import('/js/core/host-context.js')).hostToken()));
  check('desktop layout fits the viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:390,height:844});
  check('mobile layout contains the lookup controls',await page.locator('[data-doc-load]').isVisible());
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.setTestSession('fixture.reader-a.session'));
  for (const [name,form] of [['nse-filings','all'],['concall','concalls']]) {
    await page.evaluate(name=>window.showTab(name),name);
    await page.locator('[data-doc-mode="documents"]').click();
    await page.locator('[data-doc-company]').waitFor();
    await load();
    check('the actual '+name+' tab reaches its assigned document form',queries.at(-1).form[0]===form);
  }
  await page.evaluate(()=>window.showTab('earnings-hub'));
  await page.locator('[data-view-toggle]').waitFor();
  check('Earnings Hub has no redundant Filed earnings reports mode',await page.locator('[data-doc-mode]').count()===0);
  await page.evaluate(()=>window.showTab('corp-announcements'));
  await page.locator('[data-score-table]').waitFor();
  check('Corp Announcements opens its feed without duplicate document or IPO tabs',await page.locator('[data-document-tabs]').count()===0&&await page.locator('[data-score-table]').isVisible());
  // The retained DRHP component is tested directly; it is no longer a Corporate Announcements view.
  await page.evaluate(()=>window.showDrhp());
  await page.locator('[data-drhp-company]').waitFor();
  check('mounting the DRHP component does not automatically request companies',drhpQueries.length===0);
  const loadDrhp=async(name=drhpCompany)=>{await page.locator('[data-drhp-company]').fill(name);await page.locator('[data-drhp-load]').click();await page.locator('[data-drhp-load]:not([disabled])').waitFor();};
  await loadDrhp();
  check('unlisted issuers use their exact name without stock-search resolution',drhpQueries.at(-1).company===drhpCompany&&drhpQueries.at(-1).method==='GET');
  check('all nested safe links appear under the returned filing identity',await page.locator('[data-drhp-filing] a').count()===2&&/Symbol not supplied/.test(await page.locator('[data-drhp-results]').innerText())&&/Addendum/.test(await page.locator('[data-drhp-results]').innerText()));
  check('unsafe nested links are omitted with a mapping warning',await page.locator('[data-drhp-results] a[href^="javascript:"]').count()===0&&/could not be mapped/.test(await page.locator('[data-drhp-status]').innerText()));
  check('IPO lookup states that scope and upcoming-offer status are not inferred',/independent of Portfolio/.test(await page.locator('[data-drhp-form]').innerText())&&/not confirmation/.test(await page.locator('[data-drhp-form]').innerText()));
  check('looking up an unlisted issuer does not add it to holdings',await page.evaluate(async()=>{const c=await import('/js/data/coverage.js');return c.holdings().length===1&&c.holdings()[0].ticker==='STLTECH';}));
  await loadDrhp('A & B (India) Limited');
  check('spaces and ampersands survive exact-name path encoding',drhpQueries.at(-1).company==='A & B (India) Limited');
  await loadDrhp('PAYTM');
  check('listed tickers also reach the DRHP endpoint',drhpQueries.at(-1).company==='PAYTM');
  const beforeInvalid=drhpQueries.length;await loadDrhp('sync_us');
  check('reserved administrative names cannot be sent from the browser',drhpQueries.length===beforeInvalid&&/Enter a ticker/.test(await page.locator('[data-drhp-status]').innerText()));
  drhpMode='empty';await loadDrhp();
  check('no DRHP results are qualified, not proof of no IPO',/does not prove/.test(await page.locator('[data-drhp-results]').innerText()));
  drhpMode='unknown';await loadDrhp();
  check('unrecognised records are not presented as a genuinely empty history',/unrecognised records/.test(await page.locator('[data-drhp-results]').innerText()));
  drhpMode='limit';await loadDrhp();
  check('the 50-filing cap is visible',await page.locator('[data-drhp-filing]').count()===50&&/50-filing limit/.test(await page.locator('[data-drhp-status]').innerText()));
  drhpMode='failure';await loadDrhp();
  check('DRHP service errors clear old records without claiming no filing',/could not be reached/.test(await page.locator('[data-drhp-status]').innerText())&&await page.locator('[data-drhp-results]').innerText()==='');
  drhpMode='normal';await loadDrhp();
  await page.evaluate(()=>window.clearTestSession());
  check('logout clears IPO results',await page.locator('[data-drhp-results]').innerText()===''&&/Sign in/.test(await page.locator('[data-drhp-status]').innerText()));
  const beforeNoSession=drhpQueries.length;await loadDrhp();
  check('IPO lookup without a reader session makes no upstream request',drhpQueries.length===beforeNoSession);
  await page.evaluate(()=>window.setTestSession('fixture.reader-b.session'));await loadDrhp();
  check('a new session uses its own bearer token',drhpQueries.at(-1).token==='Bearer fixture.reader-b.session');
  drhpDelay=150;
  await page.locator('[data-drhp-load]').click();
  await page.waitForFunction(()=>document.querySelector('[data-drhp-load]').disabled);
  await page.evaluate(()=>window.clearTestSession());
  await new Promise(done=>setTimeout(done,250));
  check('an in-flight response cannot repopulate records after logout',await page.locator('[data-drhp-results]').innerText()===''&&/Sign in/.test(await page.locator('[data-drhp-status]').innerText()));
  drhpDelay=0;await page.evaluate(()=>window.setTestSession('fixture.reader-a.session'));await loadDrhp();
  if(process.env.DRHP_SCREENSHOT_PATH)await page.screenshot({path:process.env.DRHP_SCREENSHOT_PATH,fullPage:true});
  check('IPO desktop layout fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:390,height:844});
  check('IPO controls and document cards fit a mobile viewport',await page.locator('[data-drhp-load]').isVisible()&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>window.showTab('nse-filings'));
  await page.locator('[data-doc-mode="documents"]').click();
  check('leaving the DRHP component restores NSE company documents and removes IPO results',await page.locator('[data-doc-company]').isVisible()&&await page.locator('[data-drhp-results]').count()===0);
  check('the document views have no browser runtime errors',errors.length===0);
  console.log(`\n${checks} combined filings browser checks passed.`);
} finally { await browser?.close(); await new Promise(done=>server.close(done)); }
