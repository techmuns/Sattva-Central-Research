// Real IndexedDB and shared components, local assets only. No production actions or data writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const harness = `<script type="module">
import * as notebook from '/js/core/bookmarks.js';
import * as records from '/js/core/bookmark-record.js';
import * as tab from '/js/tabs/bookmarks.js';
import { scoreTable, closeModal } from '/js/ui/screener.js';
import { setRoute } from '/js/core/state.js';
window.notebook=notebook; window.records=records; window.closeModal=closeModal;
const root=document.querySelector('#app'); root.style.cssText='max-width:1200px;margin:32px auto;padding:24px';
let dispose;
window.rows=[{id:'news-1',ticker:'RELIANCE',company:'Reliance Industries',title:'New capacity announced',date:'2025-03-12',summary:'A complete old event that will disappear from the feed.',source:'Test exchange',url:'https://example.test/story'},
{id:'news-2',ticker:'TCS',company:'Tata Consultancy Services',title:'Quarterly results announced',date:'2025-03-13',summary:'TCS retained results.',source:'Test publisher',url:'https://example.test/tcs'}];
window.showTable=(section='news')=>{tab.destroy();dispose?.();setRoute({workspace:'research',tab:section,subview:null});
 const table=scoreTable({rows:window.rows,key:r=>r.id,watchKey:r=>r.ticker,watchName:r=>r.company,name:r=>r.company,sub:r=>r.ticker,
  exportName:'sattva-'+section,showRank:false,showAvatar:false,nameMaxPx:280,onRowClick:()=>window.rowOpens=(window.rowOpens||0)+1,
  columns:[{label:'Event',get:r=>r.title},{label:'Reading',html:true,get:r=>'<span>Complete source reading</span>'}],link:r=>r.url});
 root.innerHTML=table.html;dispose=table.wire(root);};
window.showNotebook=()=>{dispose?.();dispose=null;tab.render({root,scope:'watchlist',data:{},params:{}});};
window.showNotebook(); window.ready=true;
</script>`;
const appHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const html = appHtml.replace('<script type="module" src="js/app.js"></script>', harness);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/shell') { res.setHeader('content-type', 'text/html'); res.end(appHtml); return; }
  if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":false,"status":"unavailable","reason":"local-test"}'); return; }
  if (path === '/' || path === '/fixture') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + '/')) { res.writeHead(404).end(); return; }
  try { res.setHeader('content-type', ({ '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
await context.route('**/*', route => {
  if (route.request().url().startsWith(base)) return route.continue();
  return route.fulfill({ status: 200, body: '', contentType: route.request().resourceType() === 'script' ? 'application/javascript' : 'text/css' });
});
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(base); await page.waitForFunction(() => window.ready);
  await page.getByText('Your next insight starts here').waitFor();
  await page.evaluate(() => window.showTable());
  await page.locator('[data-bookmark-key]').first().click();
  await page.waitForFunction(() => window.notebook.all().length === 1);
  assert.equal(await page.evaluate(() => window.rowOpens || 0), 0, 'Saving does not open the row or source');
  assert.equal(await page.locator('[data-bookmark-key]').first().getAttribute('aria-pressed'), 'true');
  await page.locator('[data-bookmark-key]').nth(1).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.notebook.all().length === 2);
  assert.equal(await page.evaluate(() => window.notebook.all()[0].details[1].value), 'Complete source reading');
  // Source refresh, source disappearance and route changes cannot erase saved snapshots.
  await page.evaluate(() => { window.rows=[]; window.showTable(); window.showNotebook(); });
  await page.locator('[data-notebook-entry]').nth(1).waitFor();
  await page.reload(); await page.waitForFunction(() => window.ready && window.notebook.all().length === 2);
  await page.getByRole('button', { name: 'New capacity announced', exact: true }).click();
  await page.locator('#notebook-note').fill('Watch the commissioning date and margin impact.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByText('Note saved', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-notebook-search]').fill('margin impact');
  assert.equal(await page.locator('[data-notebook-entry]').count(), 1);
  await page.locator('[data-notebook-search]').fill('');
  await page.locator('[data-notebook-company="TCS"]').click();
  assert.equal(await page.locator('[data-notebook-entry]').count(), 1);
  assert((await page.locator('[data-notebook-results]').innerText()).includes('Quarterly results announced'));
  await page.locator('[data-notebook-clear]').click();
  // Separate pages share storage without lost updates; duplicate saves retain notes and text.
  const second = await context.newPage(); await second.goto(base); await second.waitForFunction(() => window.ready);
  await Promise.all([
    page.evaluate(() => window.notebook.save({title:'A distinct filing',company:'Reliance Industries',ticker:'RELIANCE',kind:'Corporate announcements',sourceId:'new-filing',eventDate:'2025-01-01'})),
    second.evaluate(() => window.notebook.save({title:'A different result',company:'Tata Consultancy Services',ticker:'TCS',kind:'Earnings',sourceId:'other-result',eventDate:'2025-02-01'})),
  ]);
  await page.waitForFunction(() => window.notebook.all().length === 4);
  await second.waitForFunction(() => window.notebook.all().length === 4);
  await page.evaluate(async () => { const old=window.notebook.all().find(e=>e.title==='New capacity announced'); await window.notebook.save({...old,body:'Changed upstream',note:'Overwrite attempt'}); });
  assert.equal(await page.evaluate(() => window.notebook.all().find(e=>e.title==='New capacity announced').note), 'Watch the commissioning date and margin impact.');
  assert.match(await page.evaluate(() => window.notebook.all().find(e=>e.title==='New capacity announced').body), /complete old event/);
  // Actual transaction abort: no successful UI state and no damage to existing saves.
  await page.evaluate(() => { window.showTable('nse-filings'); const add=IDBObjectStore.prototype.add; window.restoreAdd=()=>IDBObjectStore.prototype.add=add; IDBObjectStore.prototype.add=function(){this.transaction.abort();throw new DOMException('Test quota failure','QuotaExceededError');}; });
  await page.locator('[data-bookmark-key]').first().click();
  await page.getByRole('alert').filter({ hasText: 'could not be saved' }).waitFor();
  assert.equal(await page.locator('[data-bookmark-key]').first().getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.notebook.all().length), 4);
  await page.evaluate(() => { window.restoreAdd(); window.showNotebook(); });
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  // Backup is complete, portable and additive. Corrupt imports are all-or-nothing.
  const downloadPromise=page.waitForEvent('download'); await page.locator('[data-notebook-export]').click();
  const download=await downloadPromise;
  const backup=JSON.parse(readFileSync(await download.path(),'utf8'));
  assert.equal(backup.entries.length,4);
  await assert.rejects(page.evaluate(async backup=>window.notebook.importBackup({...backup,entries:[backup.entries[0],{title:'Invalid'}]}),backup));
  assert.equal(await page.evaluate(()=>window.notebook.all().length),4);
  const firstCard=page.locator('[data-notebook-entry]').first(); const removed=await firstCard.getAttribute('data-notebook-entry');
  await firstCard.locator('[data-bookmark-key]').click(); await page.waitForFunction(()=>window.notebook.all().length===3);
  await page.getByRole('button',{name:'Undo',exact:true}).click(); await page.waitForFunction(()=>window.notebook.all().length===4);
  assert(await page.evaluate(id=>window.notebook.has(id),removed));
  await page.locator('[data-notebook-file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.getByText('0 bookmarks imported. Existing bookmarks and notes kept.').waitFor();
  const fresh=await browser.newContext({serviceWorkers:'block'});
  await fresh.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.fulfill({status:200,body:''}));
  const restored=await fresh.newPage();await restored.goto(base);await restored.waitForFunction(()=>window.ready);
  await restored.locator('[data-notebook-file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await restored.waitForFunction(()=>window.notebook.all().length===4);
  assert.equal(await restored.evaluate(()=>window.notebook.all().find(e=>e.title==='New capacity announced').note),'Watch the commissioning date and margin impact.');
  await fresh.close();
  // Search includes every saved row, beyond the mounted page. No truncation on export.
  await page.evaluate(async()=>{
    const entries=Array.from({length:65},(_,i)=>window.records.normalizeBookmark({title:'Older event '+i,company:'Reliance Industries',ticker:'RELIANCE',kind:'News',sourceId:'older:'+i,eventDate:'2020-01-01',body:i===64?'Needle at the end of retained history':''}));
    await window.notebook.importBackup({format:'sattva-bookmarked-notebook',version:1,entries});
  });
  assert.equal(await page.locator('[data-notebook-entry]').count(),30);
  await page.locator('[data-notebook-search]').fill('Needle at the end');assert.equal(await page.locator('[data-notebook-entry]').count(),1);
  await page.locator('[data-notebook-search]').fill('');
  assert.equal(await page.evaluate(async()=>JSON.parse(await window.notebook.exportBackup()).entries.length),69);
  await page.locator('[data-notebook-kind]').selectOption('Earnings');assert.equal(await page.locator('[data-notebook-entry]').count(),1);
  await page.locator('[data-notebook-clear]').click();
  await page.locator('[data-notebook-notes]').check();assert.equal(await page.locator('[data-notebook-entry]').count(),1);
  await page.locator('[data-notebook-clear]').click();
  await page.locator('[data-notebook-company="TCS"]').click();
  const shots=process.env.BOOKMARK_SCREENSHOTS;
  if(shots)mkdirSync(shots,{recursive:true});
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page-level horizontal overflow');
      assert.equal(await page.locator('[data-notebook-entry]').count(),2);
      if(width===390)assert(await page.locator('[data-notebook-company-select]').isVisible());
      if(shots)await page.screenshot({path:`${shots}/notebook-${theme}-${width}.png`,fullPage:true});
    }
  }
  // Reject active content and preserve literal text in imported events/notes.
  await page.evaluate(async()=>window.notebook.save({title:'<img src=x onerror=alert(1)>',kind:'News',body:'<script>window.compromised=true</script>',url:'javascript:alert(1)'}));
  await page.locator('[data-notebook-clear]').click(); await page.locator('[data-notebook-search]').fill('onerror');
  assert.equal(await page.locator('[data-notebook-results] img').count(),0);
  assert.equal(await page.evaluate(()=>window.compromised),undefined);
  const blocked=await browser.newContext({serviceWorkers:'block'});
  await blocked.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined}));
  await blocked.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.fulfill({status:200,body:''}));
  const unavailable=await blocked.newPage();await unavailable.goto(base);await unavailable.waitForFunction(()=>window.ready);
  await unavailable.getByText('Notebook storage is unavailable.',{exact:false}).waitFor();
  assert.equal(await unavailable.locator('[data-notebook-layout]').isVisible(),false,'Unavailable storage cannot masquerade as an empty notebook');
  await unavailable.evaluate(()=>window.showTable());await unavailable.locator('[data-bookmark-key]').first().click();
  await unavailable.getByRole('alert').filter({hasText:'storage is unavailable'}).waitFor();
  assert.equal(await unavailable.locator('[data-bookmark-key]').first().getAttribute('aria-pressed'),'false');
  await blocked.close();
  // The actual shell must not remount this scope-independent tab under an open note.
  const shell=await context.newPage();shell.on('pageerror',error=>errors.push(error.message));
  await shell.goto(base+'/shell#/research/bookmarks?scope=watchlist');
  const bookmarksLink=shell.getByRole('link',{name:'Bookmarks',exact:true});
  await bookmarksLink.waitFor();
  assert.equal(await bookmarksLink.getAttribute('aria-current'),'page');
  assert.equal(await shell.locator('[data-theme-toggle] + [data-header-bookmarks]').count(),1);
  assert.equal(await shell.getByRole('tab',{name:/Bookmark/}).count(),0);
  assert.equal(await shell.locator('[role="tab"][tabindex="0"]').count(),1,'Research navigation remains keyboard-accessible from Bookmarks');
  await shell.getByRole('tab',{name:'All Alerts',exact:true}).click();
  await shell.locator('[data-tab-id="daily-alerts"][aria-selected="true"]').waitFor();
  assert.equal(await bookmarksLink.getAttribute('aria-current'),null);
  await bookmarksLink.focus();await shell.keyboard.press('Enter');
  await shell.getByRole('heading',{name:'Bookmarks',exact:true}).waitFor();
  assert.equal(await bookmarksLink.getAttribute('aria-current'),'page');
  assert.equal(await shell.locator('[data-scope-controls]').isVisible(),false);
  await shell.locator('[data-notebook-search]').fill('New capacity announced');
  await shell.getByRole('button',{name:'New capacity announced',exact:true}).click();
  await shell.locator('#notebook-note').fill('A note in progress must survive company membership changes.');
  await shell.evaluate(async()=>{(await import('/js/core/watchlist.js')).add('RELIANCE','Reliance Industries');await new Promise(done=>setTimeout(done,50));});
  assert.equal(await shell.locator('#notebook-note').inputValue(),'A note in progress must survive company membership changes.');
  await shell.evaluate(()=>location.hash='/research/bookmarks?scope=portfolio');
  await shell.getByRole('button',{name:'New capacity announced',exact:true}).click();
  await shell.locator('#notebook-note').fill('Portfolio refresh must keep this editor open.');
  await shell.evaluate(async()=>{(await import('/js/data/coverage.js')).useFamilyBook([{ticker:'TCS',name:'Tata Consultancy Services'}],'2026-09-07');await new Promise(done=>setTimeout(done,50));});
  assert.equal(await shell.locator('#notebook-note').inputValue(),'Portfolio refresh must keep this editor open.');
  await shell.close();
  assert.deepEqual(errors.filter(error=>!error.includes('Test quota failure')),[]);
  console.log('PASS notebook save, keyboard, reload, archived sources, notes, company filters, cross-tab races, rollback, backup/restore, safe rendering, all-record search and both themes at mobile/desktop widths');
} finally { await browser.close(); await new Promise(done=>server.close(done)); }
