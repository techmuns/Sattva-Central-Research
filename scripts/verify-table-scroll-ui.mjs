// Full shell, local captures and bounded paginated/returns fixtures. One worker; no production calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TAB_META } from '../public/js/tabs/catalog.js';
import { dashboardFixture } from './lib/dashboard-browser-fixture.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const evidence = resolve('.cache/table-scroll');
mkdirSync(evidence, { recursive: true });
const index = readFileSync('public/index.html', 'utf8');
const fixtureBoot = `<script type="module">
import {scoreTable,openModal,openWorkspace} from '/js/ui/screener.js';
import {fitTableViewport} from '/js/ui/table-viewport.js';
const rows=Array.from({length:1200},(_,i)=>({id:String(i),name:'Scroll fixture '+i,value:i}));
const build=()=>scoreTable({rows,key:r=>r.id,name:r=>r.name,showRank:false,showWatchFilter:false,
  stickyHead:'500px',columns:[{label:'Value',get:r=>r.value}]});
window.fixtureMount=(kind='viewport')=>{
  window.fixtureDispose?.();
  if(kind==='viewport'){
    document.querySelector('#app').innerHTML='<header data-app-header style="height:180px">Header</header><main id="fixture" style="padding:24px"></main><footer style="height:500px">Following content</footer>';
    const table=build(),root=document.querySelector('#fixture');root.innerHTML=table.html;
    const off=table.wire(root),unfit=fitTableViewport(root);window.fixtureDispose=()=>{off();unfit();};
  }else if(kind==='modal'){
    document.querySelector('#app').innerHTML='';
    const table=build();openModal('<div style="padding:24px">'+table.html+'</div>');
    window.fixtureDispose=table.wire(document.querySelector('#modal-content'));
  }else{
    document.querySelector('#app').innerHTML='';
    const table=build();openWorkspace({title:'Scroll fixture',tabs:[{id:'table',label:'Table',
      render:()=>table.html,wire:root=>{window.fixtureDispose=table.wire(root);}}]});
  }
};window.fixtureMount();window.fixtureReady=true;
</script>`;
const funds = Array.from({ length: 180 }, (_, i) => ({ schemecode: `scroll-${i}`,
  fundName: `Scroll fixture fund ${i}`, classification: `Equity : Category ${i % 18}`,
  plan: 'direct', option: 'growth', cohortKey: `category-${i % 18}`,
  returns: { '1Y': { return: i / 10, categoryAverage: 8, categoryMedian: 7, rank: i % 10 + 1, peerCount: 10 } } }));
// Exercise the normal server-index path with enough variable-height records for several native
// page transitions. Complete real-capture indexing/pagination has its own announcement suite.
const companies = JSON.parse(readFileSync('public/data/portfolio-companies.json')).holdings.filter(row => row.ticker).slice(0, 24);
const fixtureDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const announcements = Array.from({ length: 1200 }, (_, i) => {
  const company = companies[i % companies.length];
  return { id: `scroll-announcement-${i}`, company: company.name, ticker: company.ticker, isin: company.isin,
    date: fixtureDay, time: '10:00', title: `Scroll fixture announcement ${i}. ${'Reported company update. '.repeat(i % 3 + 1)}`,
    sources: ['BSE'], categories: [], source: 'BSE', url: 'https://www.bseindia.com/fixture.pdf', relevance: 10, keys: [] };
});
const { server, origin } = await dashboardFixture({ respond(url, req, res) {
  if (url.pathname === '/api/announcement-index/query' && req.method === 'POST') {
    void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const query = JSON.parse(Buffer.concat(chunks));
      const wanted = new Set((query.companies || []).map(company => company.ticker));
      const selected = announcements.filter(row => query.scope === 'universe' || wanted.has(row.ticker));
      const offset = Math.max(0, Number(query.offset) || 0), limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, rows: selected.slice(offset, offset + limit), total: selected.length,
        companies: new Set(selected.map(row => row.ticker)).size, index: { meta: {} } }));
    })().catch(error => { res.writeHead(400); res.end(JSON.stringify({ message: error.message })); });
    return true;
  }
  if (url.pathname === '/fixture/viewport') {
    res.setHeader('content-type', 'text/html');
    res.end(index.replace(/<script type="module" src="js\/app\.js"><\/script>/, fixtureBoot)); return true;
  }
  if (url.pathname === '/api/returns-ranking') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ asOfDate: new Date().toISOString().slice(0, 10), periods: ['1Y'], funds })); return true;
  }
  return false;
} });
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ignoreDefaultArgs: ['--hide-scrollbars'] });
const results = [], failures = [], errors = [];
const sizes = [{ width: 1440, height: 900 }, { width: 1345, height: 622 }, { width: 390, height: 600 }];
const routes = Object.values(TAB_META).filter(meta => meta.id !== 'super-investors')
  .flatMap(meta => (meta.subviews.length ? meta.subviews.map(view => `${meta.id}/${view.id}`) : [meta.id]));
routes.push('earnings-hub?view=calendar', 'earnings-hub?view=filings', 'public-chatter|Telegram', 'ipos?view=directory');
for (const type of ['my-managers', 'investors']) for (const category of type === 'investors' ? ['tracked', 'institutions'] : ['tracked']) {
  for (const view of ['overview', 'changes', 'holdings']) routes.push(`super-investors?type=${type}&category=${category}&view=${view}`);
}
const frames = frame => frame.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); });
async function checkTables(page, frame, label, retry = 0) {
  let activeSurface = null;
  try {
  const iframeBox = await page.locator('iframe').boundingBox();
  await page.mouse.move(iframeBox.x + iframeBox.width - 24, iframeBox.y + 16);
  const beaconClose = frame.locator('[data-beacon-close]:visible');
  if (await beaconClose.count()) await beaconClose.click();
  const tableCount = await frame.locator('#content-host table:visible, #fixture table:visible, #modal-content table:visible, #workspace-panel table:visible').count();
  const checked = [];
  for (let i = 0; i < tableCount; i++) {
    const table = frame.locator('#content-host table:visible, #fixture table:visible, #modal-content table:visible, #workspace-panel table:visible').nth(i);
    const populated = await table.evaluate(table => [...table.querySelectorAll('tbody tr')].some(row =>
      !row.matches('[data-virtual-spacer]') && !row.querySelector('[data-window-spacer], [data-loading-row]') && row.cells.length > 1));
    if (!populated) { checked.push({ rows: 0 }); continue; }
    // Wheel on the page margin first. Programmatic scrollIntoView alone would also move an
    // overflow:hidden parent and could falsely certify the original page-scroll lock.
    const pageScroll = await table.evaluate(table => ({ below: table.getBoundingClientRect().bottom > innerHeight - (document.querySelector('.beacon-launcher') ? 64 : 0),
      top: scrollY, max: document.scrollingElement.scrollHeight - innerHeight }));
    if (pageScroll.below && pageScroll.max > pageScroll.top + 2 && !await frame.locator('body').evaluate(el => el.classList.contains('workspace-open'))) {
      const iframe = await page.locator('iframe').boundingBox();
      await page.mouse.move(iframe.x + 4, iframe.y + 100);
      await page.mouse.wheel(0, 1e9);
      await frame.waitForFunction(top => scrollY > top, pageScroll.top, { timeout: 5000 });
    }
    const surface = await table.evaluateHandle(table => {
      for (let node = table.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 2) return node;
      }
      return document.scrollingElement;
    });
    activeSurface = surface;
    const internal = await surface.evaluate(el => el !== document.scrollingElement);
    if (internal) {
      await surface.evaluate(el => el.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
      await surface.evaluate(el => { el.scrollTop = 0; });
      await frames(frame);
      const point = await surface.evaluate(el => {
        const box = el.getBoundingClientRect(), head = el.querySelector('thead')?.getBoundingClientRect();
        const top = Math.max(0, box.top, head?.bottom || 0), bottom = Math.min(innerHeight, box.bottom);
        return { x: Math.min(innerWidth, box.right) - 32, y: top + Math.max(1, (bottom - top) / 2), visible: bottom - top };
      });
      assert(point.visible > 8, `${label}: table has a reachable wheel target`);
      const iframe = await page.locator('iframe').boundingBox();
      await page.mouse.move(iframe.x + point.x, iframe.y + point.y);
      await page.mouse.wheel(0, 700);
      await frame.waitForFunction(el => el.scrollTop > 0, surface, { timeout: 5000 });
      for (let end = 0; end < 1000; end++) {
        await page.mouse.wheel(0, 1e9); await frames(frame);
        // Announcements append another page at the loaded boundary. Follow native scroll's
        // requests until its explicit Load more control disappears, then check the final row.
        await frame.waitForFunction(() => !document.querySelector('[data-ca-load-more]:disabled, [data-table-loading]'), null, { timeout: 30000 });
        await frames(frame);
        if (await surface.evaluate(el => {
          if (!el.isConnected) throw new Error('Table replaced during native scrolling');
          const card = el.closest('[data-score-table]');
          const tail = !card?.hasAttribute('data-virtualized') ||
            Number(card.dataset.virtualStart) + el.querySelectorAll('tr[data-row-key]').length >= Number(card.dataset.virtualTotal);
          const rows = [...el.querySelectorAll('tbody tr')].filter(row => !row.matches('[data-virtual-spacer]') && !row.querySelector('[data-window-spacer]'));
          const last = rows.at(-1)?.getBoundingClientRect(), box = el.getBoundingClientRect();
          const bottom = Math.min(innerHeight, box.top + el.clientTop + el.clientHeight);
          return tail && last && last.bottom <= bottom + 2 && el.scrollHeight - el.clientHeight - el.scrollTop < 2;
        }) &&
            !await frame.locator('[data-ca-load-more]').count()) break;
      }
      assert.equal(await frame.locator('[data-ca-load-more]').count(), 0, `${label}: native scrolling loads every announcement page`);
      assert(await surface.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 2), `${label}: native wheel reaches the table's end`);
    }
    if (!internal) {
      await table.evaluate(table => table.querySelector('tbody tr:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
      await frames(frame);
    }
    const end = await table.evaluate(table => {
      const rows = [...table.querySelectorAll('tbody tr')].filter(row => !row.matches('[data-virtual-spacer]') && !row.querySelector('[data-window-spacer]'));
      const last = rows.at(-1), box = last?.getBoundingClientRect(), card = table.closest('[data-score-table]');
      let left = 0, right = innerWidth, bottom = innerHeight, clipper = 'viewport';
      // Body overflow propagates to the viewport; its document box is not a clipping box.
      for (let node = table.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, rect.left + node.clientLeft);
          right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
        }
        const edge = rect.top + node.clientTop + node.clientHeight;
        if (style.overflowY !== 'visible' && edge < bottom) { bottom = edge; clipper = node.id || node.tagName; }
      }
      // Both ends of the row must remain usable, including the identity/watch controls near
      // the floating source launcher. Stay inside the native scrollbar's client box.
      const x = box ? Math.min(right, box.right) - 12 : 0;
      const leading = box ? Math.max(left, box.left) + 12 : 0;
      const y = box ? Math.min(bottom, box.bottom) - 8 : 0;
      const hit = document.elementFromPoint(x, y);
      const firstHit = document.elementFromPoint(leading, y);
      const hiddenScroll = [];
      for (let node = table.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY === 'hidden' && node.scrollTop > 1) hiddenScroll.push(node.id || node.tagName);
      }
      return { rows: rows.length, bottom: box?.bottom, viewport: innerHeight, clipBottom: bottom, clipper,
        total: Number(card?.dataset.virtualTotal || 0), start: Number(card?.dataset.virtualStart || 0),
        virtual: card?.hasAttribute('data-virtualized'), pending: Number(card?.dataset.rowsPending || 0),
        hiddenScroll, hit: hit?.tagName, leadingHit: firstHit?.tagName,
        reachable: !!last && (hit === last || last.contains(hit)) && (firstHit === last || last.contains(firstHit)) };
    });
    assert.deepEqual(end.hiddenScroll, [], `${label}: no hidden ancestor had to scroll to reveal the final row`);
    assert(end.rows > 0 && end.bottom <= Math.min(end.viewport, end.clipBottom) + 2 && end.reachable, `${label}: final row is visible and receives pointer input: ${JSON.stringify(end)}`);
    if (end.virtual) assert(end.start + end.rows >= end.total, `${label}: the final retained record is mounted: ${JSON.stringify(end)}`);
    checked.push(end);
    await surface.dispose(); activeSurface = null;
  }
  return checked;
  } catch (error) {
    // A source check may replace its table during the gesture. Retry only a retired DOM node;
    // attached-but-clipped tables still fail immediately (including the negative control).
    if (activeSurface && !await activeSurface.evaluate(el => el.isConnected)) {
      await activeSurface.dispose();
      // Each paged announcement append replaces its table; a 1,200-row fixture has several
      // legitimate replacements. Other readers need only their initial source refreshes.
      if (retry < (label.startsWith('corp-announcements/') ? 20 : 3)) {
        await frames(frame); return checkTables(page, frame, label, retry + 1);
      }
    }
    throw error;
  }
}

try {
  const context = await browser.newContext({ viewport: sizes[0], serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/')
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript(origin => {
    localStorage.setItem('sattva:chatter-base', `${origin}/fixture/chatter`);
    localStorage.setItem('sattva:amfibeas-base', origin);
  }, origin);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/embed`);
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('#content-host').waitFor();
  await frame.evaluate(async () => {
    const coverage = await import('/js/data/coverage.js'), watchlist = await import('/js/core/watchlist.js');
    const payload = await (await fetch('/data/portfolio-companies.json')).json();
    coverage.prime(payload);
    for (const row of payload.holdings.filter(row => row.ticker).slice(0, 12)) watchlist.add(row.ticker, row.name, 'Local scroll fixture');
  });
  for (const scope of ['universe', 'portfolio', 'watchlist']) for (const route of routes) {
    const [path, section] = route.split('|'), url = `#/research/${path}${path.includes('?') ? '&' : '?'}scope=${scope}`;
    try {
      // Begin navigation with the header in view. The previous route ends in a narrow window
      // at the page bottom, where click's automatic reveal can land under the source launcher.
      await page.setViewportSize(sizes[0]);
      await frame.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      const hostBox = await page.locator('iframe').boundingBox();
      await page.mouse.move(hostBox.x + hostBox.width - 24, hostBox.y + 16);
      const closeSources = frame.locator('[data-beacon-close]:visible');
      if (await closeSources.count()) await closeSources.click();
      await frame.evaluate(async url => {
        if (location.hash !== url) {
          const changed = new Promise(done => addEventListener('hashchange', done, { once: true }));
          location.hash = url; await changed;
        }
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      }, url);
      await frame.waitForFunction(id => document.querySelector('#content-host')?.dataset.activeTab === id &&
        !document.querySelector('#content-host').inert, path.split(/[/?]/)[0], { timeout: 60000 });
      if (path === 'public-chatter') await frame.evaluate(async () => {
        await Promise.all([import('/js/data/chatter-live.js').then(feed => feed.load()),
          import('/js/data/telegram-posts.js').then(feed => feed.load())]);
      });
      if (section) await frame.locator('[data-chatter-section-tabs]').getByRole('tab', { name: section, exact: true }).click();
      for (const name of ['Date range', 'News period', 'Announcement period (IST)', 'Trade period', 'IPO filing period']) {
        const select = frame.getByRole('combobox', { name, exact: true });
        if (await select.count() && await select.locator('option[value="all"]').count()) await select.selectOption('all');
      }
      await frame.waitForFunction(() => !document.querySelector('#content-host .skeleton-shimmer, [data-table-loading]') &&
        document.querySelector('[data-alerts-workspace]')?.getAttribute('aria-busy') !== 'true', null, { timeout: 180000 });
      // Geometry is ready once row grouping settles. Background source checks can continue while
      // readers scroll; their freshness/completeness is verified separately by the alert suites.
      for (const size of sizes) {
        await page.setViewportSize(size);
        await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frames(frame);
        const tables = await checkTables(page, frame, `${route}/${scope}/${size.width}x${size.height}`);
        results.push({ route, scope, size, tables });
        console.log(JSON.stringify(results.at(-1)));
      }
    } catch (error) {
      failures.push({ route, scope, error: error.message }); console.error(JSON.stringify(failures.at(-1)));
      await page.screenshot({ path: resolve(evidence, `failure-${failures.length}.png`) });
      throw error;
    }
  }
  // Shared viewport helper: a source/footer or saved-view header can leave the document scrolled
  // when a resize or late toolbar measurement occurs. Its height must not grow by scrollY.
  await frame.goto(`${origin}/fixture/viewport`);
  await frame.waitForFunction(() => window.fixtureReady && document.querySelector('[data-table-scroll]').style.height);
  for (const size of sizes) {
    await page.setViewportSize(size); await frames(frame);
    await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await frames(frame);
    const height = await frame.locator('[data-table-scroll]').evaluate(el => el.getBoundingClientRect().height);
    await frame.evaluate(() => window.scrollTo({ top: 160, behavior: 'instant' }));
    await frame.evaluate(() => window.dispatchEvent(new Event('resize'))); await frames(frame);
    const next = await frame.locator('[data-table-scroll]').evaluate(el => el.getBoundingClientRect().height);
    assert(Math.abs(height - next) < 2, `shared viewport height is stable after page scroll at ${size.width}px: ${height} → ${next}`);
  }
  // Negative control: reproduce a clipped app shell. A programmatic scrollIntoView can reveal
  // its rows, but the audit must still reject the hidden parent that a reader cannot scroll.
  await frame.evaluate(() => {
    scrollTo(0, 0);
    document.body.style.cssText = 'height:100vh;overflow:hidden';
    document.querySelector('#app').style.cssText = 'height:100vh;overflow:hidden';
    document.querySelector('[data-app-header]').style.height = '700px';
    dispatchEvent(new Event('resize'));
  });
  await frames(frame);
  await assert.rejects(checkTables(page, frame, 'clipped-shell negative control'), /hidden ancestor/);
  await frame.evaluate(() => {
    document.body.style.cssText = '';
    document.querySelector('#app').style.cssText = '';
  });
  for (const kind of ['modal', 'workspace']) {
    await frame.evaluate(kind => window.fixtureMount(kind), kind);
    for (const size of sizes) {
      await page.setViewportSize(size); await frames(frame);
      await checkTables(page, frame, `${kind}/${size.width}x${size.height}`);
    }
    await page.keyboard.press('Escape');
  }
  assert(results.some(result => result.tables.some(table => table.total > 1000)), 'the audit exercises retained history rather than only short first pages');
  assert.deepEqual(errors, [], 'zero application exceptions across the scroll audit');
  assert.deepEqual(failures, [], 'every table and scope must reach its bottom');
  console.log(`PASS ${routes.length} route/view variants × 3 scopes × 3 window sizes; nested modal/workspace tables and scrolled-page resizing.`);
} finally {
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ results, failures, errors }, null, 2));
  await browser.close(); await new Promise(done => server.close(done));
}
