#!/usr/bin/env node

// Isolated browser regression for Public Chatter's Telegram section.
//
// It serves a SYNTHETIC capture rather than the committed one, so the assertions test the
// section's behaviour rather than whatever the channel happened to post, and blocks every external
// read — which also means the chatter API is unreachable here BY DESIGN. That is the first thing
// asserted: the two feeds on this tab are independent, and one being down may not take the other's
// section with it.
//
// WHY THIS EXISTS SEPARATELY FROM verify-ui.mjs: that suite is the manual pre-push checklist and CI
// does not run it, so the Telegram assertions living only there protected nothing on a pull
// request. This one is in the browser job.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, dirname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');

// ---------------------------------------------------------------------------------------
// A static check first, and it is the one that would have caught the release defect.
//
// The service worker treats /js/ as immutable and warms the module graph by walking imports from
// js/app.js at INSTALL. A module the walk cannot reach is never cached and, for a returning reader,
// never requested either. So the graph must actually reach the Telegram module — asserted here with
// the same traversal sw.js performs, rather than assumed because an import statement exists.
// ---------------------------------------------------------------------------------------
const SPECIFIER = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function moduleGraph(entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    let source;
    try { source = readFileSync(resolve(root, current.replace(/^\//, '')), 'utf8'); } catch { continue; }
    SPECIFIER.lastIndex = 0;
    let m;
    while ((m = SPECIFIER.exec(source))) {
      const spec = m[1] || m[2];
      if (!spec || (!spec.startsWith('.') && !spec.startsWith('/'))) continue;
      const abs = spec.startsWith('/') ? spec : resolve('/', dirname(current), spec).split(sep).join('/');
      if (!abs.startsWith('/js/') || seen.has(abs)) continue;
      seen.add(abs);
      queue.push(abs);
    }
  }
  return seen;
}
const graph = moduleGraph('/js/app.js');
assert(
  graph.has('/js/data/telegram-posts.js'),
  'js/data/telegram-posts.js is unreachable from js/app.js, so the service worker would never warm it and a returning reader would never load it',
);

// The other half of the same defect: a change under /js/ that does not move the cache name is
// invisible to every returning reader, because sw.js and that name ARE the code version boundary.
const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
assert(/CACHE_NAME = `\$\{CACHE_PREFIX\}[^`]+`/.test(sw), 'sw.js no longer declares a versioned cache name');

// ---------------------------------------------------------------------------------------
// The synthetic capture. Deliberately includes a gap in the ids (7 of the 10 in the span carry
// text) so the coverage arithmetic is exercised rather than trivially satisfied.
// ---------------------------------------------------------------------------------------
const capturedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const post = (id, text) => ({ id, text, url: `https://t.me/researchreportss/${id}`, publishedAt: '2026-05-13T10:57:05.000Z', firstSeenAt: capturedAt });
const capture = {
  source: 't.me public channel pages',
  channel: 'researchreportss',
  channelUrl: 'https://t.me/researchreportss',
  schemaVersion: 2, route: 'embed+permalink',
  publishesTime: true, lastCheckedAt: capturedAt, historyNextId: 490,
  lastRun: { status: 'ok' },
  capturedAt,
  headId: 500, lowestId: 491, spanFrom: 491, spanTo: 500, walkedFrom: 491,

  retryIds: [],
  posts: [
    post(500, 'Broker A sees 30% UPSIDE in Company One - a note <img src=x onerror=alert(1)>'),
    { ...post(499, null), contentStatus: 'telegram-only', attachments: [] },
    { ...post(498, null), mediaType: 'document', attachments: [{ type: 'document', name: 'Broker C sector update.pdf', size: '2 MB' }] },
    post(496, 'Broker D on Company Four'),
    post(495, 'Broker E results preview'),
    post(493, 'Broker F initiates coverage'),
    post(491, 'Broker G daily'),
  ],
};

const shellStyles = [...readFileSync(resolve(root, 'index.html'), 'utf8').matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]).join('');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css">${shellStyles}</head><body class="bg-slate-50 p-4"><main id="content-host"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/public-chatter.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
const live={register(){},start(){},stop(){},subscribe(){return()=>{};}};
coverage.prime({holdings:[{ticker:'TCS',name:'Tata Consultancy Services'}]});
watchlist.clear();
window.tab=tab;
window.renderScope=(scope,params={})=>{const root=document.querySelector('#content-host');tab.destroy();root.innerHTML='';tab.render({root,scope,live,data:{universe:[]},params});};
window.renderScope('universe');
</script></body></html>`;

let servedCapture = capture;
let servedArtifact = null;
let artifactStatus = 200, snapshotStatus = 200;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (pathname === '/api/telegram/posts') {
    response.setHeader('content-type', 'application/json');
    response.statusCode = artifactStatus !== 200 ? artifactStatus : servedArtifact ? 200 : 404;
    response.end(JSON.stringify(servedArtifact || { error: 'no artifact' }));
    return;
  }
  if (pathname === '/data/telegram-posts.json') {
    response.statusCode = snapshotStatus;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(servedCapture));
    return;
  }
  try {
    const file = resolve(root, pathname.replace(/^\//, ''));
    if (!file.startsWith(root + sep)) { response.statusCode = 403; response.end(); return; }
    const body = readFileSync(file);
    response.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    response.end(body);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // Every external origin is refused, so the chatter API is unreachable — which is the state this
  // section has to survive.
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));

  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#content-host [data-chatter-section-tabs] [role="tab"]').length === 3, null, { timeout: 20000 });

  const tabs = await page.$$eval('#content-host [data-chatter-section-tabs] [role="tab"]', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(tabs, ['Coverage', 'Not in coverage', 'Telegram'], 'the three in-page sections');
  await page.evaluate(() => window.renderScope('portfolio', { section: 'telegram', company: 'JAYNECOIND' }));
  await page.locator('[data-chatter-section-tabs] [role="tab"][aria-selected="true"]', { hasText: 'Telegram' }).waitFor();

  await page.locator('#content-host [data-chatter-section-tabs] [role="tab"]', { hasText: 'Telegram' }).click();
  await page.waitForSelector('[data-chatter-panel="telegram"] tbody tr', { timeout: 20000 });

  const content = page.locator('[data-chatter-panel="telegram"] select[aria-label="Content"]');
  assert.equal(await content.inputValue(), 'all', 'latest metadata-only posts must remain visible by default');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 7);
  await content.selectOption('readable');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 5, 'filenames and missing text are not readable reports');
  assert((await page.locator('[data-telegram-content-notice]').innerText()).includes('2 posts are saved with dates and original links, but no readable text'));
  assert(!(await page.locator('[data-chatter-panel="telegram"]').innerText()).includes('Content available in Telegram'));
  await content.selectOption('telegram');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 2);
  await content.selectOption('all');

  const view = await page.evaluate(async () => {
    const t = await import('/js/data/telegram-posts.js');
    const host = document.querySelector('#content-host');
    const m = t.meta();
    const ids = t.posts().map((r) => r.id);
    const keys = t.posts().map((r) => r.key);
    return {
      count: m.count, span: m.span, readable: m.readable, unreadable: m.unreadable, publishesTime: m.publishesTime,
      heads: [...host.querySelectorAll('[data-chatter-panel="telegram"] thead th')].map((th) => th.textContent.trim()),
      drawn: host.querySelectorAll('[data-chatter-panel="telegram"] tbody tr').length,
      descending: ids.every((id, i) => i === 0 || ids[i - 1] > id),
      unique: new Set(keys).size === keys.length,
      actualTimes: t.posts().every((r) => r.publishedAt === '2026-05-13T10:57:05.000Z'),
      hidden: t.posts().filter((r) => r.contentStatus === 'telegram-only').length,
      starIsButton: !!host.querySelector('[data-chatter-panel="telegram"] tbody tr button[data-watch]'),
      footnotes: host.querySelector('[data-telegram-footnotes]')?.textContent.replace(/\s+/g, ' ') || '',
      description: host.querySelector('p')?.textContent.replace(/\s+/g, ' ') || '',
      pill: host.querySelector('[data-telegram-live]')?.textContent.replace(/\s+/g, ' ').trim() || '',
      pillTag: host.querySelector('[data-telegram-live]')?.tagName || '',
    };
  });

  assert(view.pill.includes('7 archived') && view.pill.includes('5 readable here'));
  assert((await page.locator('[data-telegram-source-status]').innerText()).includes('has not been verified'));
  assert.equal(view.count, 7, 'every post in the capture is read');
  // All verified publications stay dated and linked, even when their text is Telegram-only.
  assert.equal(view.drawn, view.count, 'all captured posts remain visible, including Telegram-only publications');
  assert(view.hidden > 0, 'the fixture actually contains a media-only post, so the rule is exercised');
  assert(view.drawn > 0, 'and the readable posts are still drawn');
  assert(view.descending, 'ordered by message id, newest first');
  assert(view.unique, 'row keys are unique');
  assert.equal(view.publishesTime, true);
  assert(view.actualTimes, 'source dates survive normalisation');
  assert.equal(view.hidden, 1, 'a confirmed hidden post stays in the archive');
  assert(view.heads.includes('Published (IST)'));
  assert(/original publication dates/i.test(view.description));
  assert.equal(view.span, 10);
  assert.equal(view.readable, 7);
  assert.equal(view.unreadable, 3);
  assert(/Older history is incomplete/i.test(view.footnotes));
  assert(/awaiting retry/i.test(view.footnotes));
  assert(/Checked/i.test(view.pill), 'collector success time is visible');
  assert(await page.locator('[data-chatter-panel="telegram"]').innerText().then((t) => t.includes('13 May 2026')));
  const search = page.locator('[data-chatter-panel="telegram"] [data-table-search]');
  assert.equal(await search.getAttribute('placeholder'), 'Search posts, reports or message number…');
  // A captionless post keeps its original date and Telegram link.
  await search.fill('499');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 1,
    'a caption-less post is dated, searchable and linked');
  assert((await page.locator('[data-chatter-panel="telegram"] tbody').innerText()).includes('Post link captured'));
  assert((await page.locator('[data-chatter-panel="telegram"] tbody').innerText()).includes('Type unavailable'));
  await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').click();
  assert((await page.locator('[data-telegram-post-dialog]').innerText()).includes('No text was captured'));
  assert.equal(await page.locator('[data-telegram-post-dialog] a').getAttribute('href'), 'https://t.me/researchreportss/499');
  await page.locator('[data-telegram-post-dialog] [data-modal-close]').click();
  // Named documents remain searchable even without a caption.
  await search.fill('498');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 1,
    'a document post with no caption is still listed');
  await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').click();
  await page.waitForSelector('[data-telegram-post-dialog]');
  assert((await page.locator('[data-telegram-post-dialog]').innerText()).includes('filename was captured'));
  assert.equal(await page.locator('[data-telegram-post-dialog] a').getAttribute('href'), 'https://t.me/researchreportss/498');
  await page.locator('[data-telegram-post-dialog] [data-modal-close]').click();
  await search.fill('sector update.pdf');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 1, 'attachment filenames are searchable');
  await search.fill('500');
  await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').click();
  assert.equal(await page.locator('[data-telegram-post-dialog] img').count(), 0, 'source markup remains escaped text');
  assert((await page.locator('[data-telegram-post-dialog]').innerText()).includes('<img src=x'));
  await page.locator('[data-telegram-post-dialog] [data-modal-close]').click();
  await search.fill('');
  if (process.env.EXCELJS_ROOT) {
    await page.addScriptTag({ path: `${process.env.EXCELJS_ROOT}/dist/exceljs.min.js` });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-chatter-panel="telegram"] [data-export]').click(),
    ]);
    const ExcelJS = (await import(`${process.env.EXCELJS_ROOT}/excel.js`)).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await download.path());
    const sheet = workbook.getWorksheet('Telegram');
    assert.equal(sheet.rowCount, view.drawn + 2, 'headers + provenance + every listed post');
    const exportedIds = [];
    sheet.eachRow((row, index) => { if (index > 2) exportedIds.push(row.getCell('B').value); });
    assert.deepEqual(exportedIds, [500, 499, 498, 496, 495, 493, 491],
      'export preserves all captured rows, including Telegram-only and document-only posts');
    assert.equal(sheet.getCell('C3').value, '2026-05-13T10:57:05.000Z');
    assert.equal(sheet.getCell('G3').value, capturedAt, 'collector time is a separate column');
    assert.equal(sheet.getCell('A5').value, 'Broker C sector update.pdf');
    assert.equal(sheet.getCell('E5').value, 'Broker C sector update.pdf');
  }
  // `capturedAt` moves when the CHANNEL posts, not when the job ran, so the label may not claim it.
  assert(!/\bLive\b/i.test(view.pill), `the status label must not claim Live, got: ${view.pill}`);
  assert.equal(view.pillTag, 'SPAN', 'the status label is passive');
  assert.equal(view.starIsButton, false, 'a row with no company gets no star control');

  const fresh = await page.evaluate(() => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    const at = (h) => new Date(now - h * 3600 * 1000).toISOString();
    return {
      hour: window.tab.telegramFreshness(at(1), now).state,
      twoDays: window.tab.telegramFreshness(at(48), now).state,
      fourDays: window.tab.telegramFreshness(at(96), now).state,
      none: window.tab.telegramFreshness(null, now).state,
      rubbish: window.tab.telegramFreshness('not a date', now).state,
    };
  });
  assert.deepEqual(fresh, { hour: 'captured', twoDays: 'captured', fourDays: 'unchanged', none: 'unknown', rubbish: 'unknown' },
    'the freshness rule, asserted at both sides of its boundary and on the no-capture case');

  // Posts carry no company, so the scope cannot narrow them — and an empty watchlist must not let
  // the shell hide the section while claiming the tab has nothing to show.
  await page.evaluate(() => window.renderScope('watchlist'));
  await page.waitForFunction(() => document.querySelectorAll('#content-host [data-chatter-section-tabs] [role="tab"]').length === 3, null, { timeout: 20000 });
  await page.locator('#content-host [data-chatter-section-tabs] [role="tab"]', { hasText: 'Telegram' }).click();
  await page.waitForSelector('[data-chatter-panel="telegram"] tbody tr', { timeout: 20000 });
  await content.selectOption('all');
  const watchRows = await page.$$eval('[data-chatter-panel="telegram"] tbody tr', (r) => r.length);
  // Compared against what the Universe scope actually drew, not a typed number: the claim is that
  // the watchlist does not NARROW this section, and only the two counts together say that.
  assert.equal(watchRows, view.drawn, 'an empty watchlist neither hides the section nor narrows it');

  servedCapture = { ...capture, lastRun: { status: 'failed', error: 'upstream unavailable' } };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  await page.waitForFunction(() => document.querySelector('[data-telegram-live]')?.textContent.includes('needs attention'));
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn, 'source failures retain the archive');
  servedCapture = { ...capture, posts: [] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn, 'empty refresh retains last-good rows');
  servedCapture = { error: 'malformed response' };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn, 'malformed refresh cannot erase last-good rows');
  // A fresh artifact arrives without a static build. Older snapshots cannot undo it.
  const freshAt = new Date().toISOString();
  servedCapture = capture;
  servedArtifact = { ...capture, route: 'mtproto', lastRun: { at: freshAt, status: 'ok' },
    lastCheckedAt: freshAt, latestVerifiedAt: freshAt, posts: [post(501, 'New API report'), ...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn + 1);
  assert((await page.locator('[data-telegram-source-status]').innerText()).includes('Latest channel post verified'));
  servedArtifact = null;
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn + 1, 'older static capture cannot regress a newer artifact');
  servedArtifact = { ...capture, route:'mtproto', lastRun:{at:new Date(Date.parse(freshAt)+1000).toISOString(),status:'failed'},
    apiSafety:{paused:true,reason:'account-attention',failures:1}, posts:[post(501,'New API report'),...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert((await page.locator('[data-telegram-live]').innerText()).includes('Account collection paused for review'));
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(),view.drawn+1,'account pause retains every visible row');
  servedArtifact = { ...capture, route:'embed+permalink', lastRun:{at:new Date(Date.parse(freshAt)+2000).toISOString(),status:'partial'},
    publicSafety:{reason:'rate-limit',nextAttemptAt:new Date(Date.now()+3600000).toISOString()}, posts:[post(501,'New API report'),...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert((await page.locator('[data-telegram-live]').innerText()).includes('Public source retry after'));
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(),view.drawn+1,'public source backoff retains every visible row');
  // Validated persistent data must survive a malformed response AND a full browser reload.
  const cacheAt = new Date(Date.parse(freshAt) + 3000).toISOString();
  servedArtifact = { ...capture, lastRun: { at: cacheAt, status: 'ok' }, lastCheckedAt: cacheAt,
    posts: [{ ...post(502, null), publishedAt: cacheAt }, post(501, 'New API report'), ...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), view.drawn + 2);
  assert((await page.locator('[data-telegram-source-status]').innerText()).includes('Newest readable text:'), 'new restricted publications cannot masquerade as an old feed');
  await page.waitForFunction(() => new Promise(resolve => {
    const open = indexedDB.open('sattva-cache');
    open.onsuccess = () => { const db = open.result; const req = db.transaction('payloads').objectStore('payloads').get('telegram-artifact-v1');
      req.onsuccess = () => { resolve(req.result?.value?.posts?.some(p => p.id === 502)); db.close(); }; };
    open.onerror = () => resolve(false);
  }));
  servedCapture = { error: 'malformed static' };
  servedArtifact = { channel: 'researchreportss', posts: [{ id: 0, text: 'invalid' }] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  const stored = await page.evaluate(async () => (await (await import('/js/core/store.js')).readEntry('telegram-artifact-v1')).value);
  assert(stored.posts.some(p => p.id === 502), 'malformed 200 cannot replace last-good cache');
  servedArtifact = { ...capture, lastRun: { at: '2099-01-01T00:00:00Z', status: 'ok' } };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.evaluate(async () => (await (await import('/js/core/store.js')).readEntry('telegram-artifact-v1')).value.lastRun.at), cacheAt,
    'a future check timestamp cannot poison the cache and block later valid updates');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.renderScope === 'function');
  await page.evaluate(() => window.renderScope('universe', { section: 'telegram' }));
  await content.selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('[data-chatter-panel="telegram"] tbody tr[data-row-key]').length === 9);
  assert((await page.locator('[data-telegram-live]').innerText()).includes('needs attention'));
  // An older but valid fallback can replace its HTTP cache entry; it cannot erase the
  // additive archive that must survive the next offline reload.
  servedArtifact = { ...capture, lastRun: { at: freshAt, status: 'ok' }, lastCheckedAt: freshAt,
    delivery: { status: 'partial', degraded: true, collectorLatestFailed: true },
    posts: [post(501, 'Older API report'), ...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 9);
  assert((await page.locator('[data-telegram-live]').innerText()).includes('needs attention'));
  await page.waitForFunction(() => new Promise(resolve => {
    const open = indexedDB.open('sattva-cache');
    open.onsuccess = () => { const db = open.result; const req = db.transaction('payloads').objectStore('payloads').get('telegram-retained-v1');
      req.onsuccess = () => { resolve(req.result?.value?.posts?.some(p => p.id === 502)); db.close(); }; };
    open.onerror = () => resolve(false);
  }));
  artifactStatus = snapshotStatus = 503;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.renderScope === 'function');
  await page.evaluate(() => window.renderScope('universe', { section: 'telegram' }));
  await content.selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('[data-chatter-panel="telegram"] tbody tr[data-row-key]').length === 9);
  const offline = await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).meta());
  assert(offline.reason && offline.count === 9, 'offline reload retains validated records and reports unavailable collection');
  // A newer date/link-only refresh must not erase readable text, filename or first-seen time.
  artifactStatus = snapshotStatus = 200;
  const laterAt = new Date(Date.parse(cacheAt) + 1000).toISOString();
  servedCapture = { ...capture, posts: capture.posts.map(p => ({ ...p, text: null, attachments: [], mediaType: null })) };
  servedArtifact = { ...servedCapture, lastRun: { at: laterAt, status: 'ok' }, lastCheckedAt: laterAt };
  await content.selectOption('readable');
  await search.fill('Broker A');
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await content.inputValue(), 'readable', 'content filter survives automatic refresh');
  assert.equal((await search.inputValue()).toLowerCase(), 'broker a', 'search survives automatic refresh');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 1);
  let retained = await page.evaluate(async () => {
    const t = await import('/js/data/telegram-posts.js');
    return { text: t.byId(500).text, file: t.byId(498).attachments[0]?.name, firstSeen: t.byId(500).firstSeenAt };
  });
  assert.equal(retained.text, capture.posts[0].text);
  assert.equal(retained.file, 'Broker C sector update.pdf');
  assert.equal(retained.firstSeen, capturedAt);
  // Older captures can fill missing text, but cannot roll back a newer edit or source status.
  servedCapture = { ...capture, posts: capture.posts.map(p => p.id === 499 ? { ...p, text: 'Recovered older caption' } : p) };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).byId(499).text), 'Recovered older caption');
  servedArtifact = { ...servedArtifact, posts: servedArtifact.posts.map(p => p.id === 500 ? { ...p, text: 'New corrected report' } : p),
    lastRun: { at: new Date(Date.parse(laterAt) + 1000).toISOString(), status: 'ok' } };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal(await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).byId(500).text), 'New corrected report');
  artifactStatus = snapshotStatus = 503;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.renderScope === 'function');
  await page.evaluate(() => window.renderScope('universe', { section: 'telegram' }));
  await page.waitForSelector('[data-chatter-panel="telegram"] tbody tr[data-row-key]');
  assert.equal(await content.inputValue(), 'all', 'reopening restores the newest posts, including those without text');
  assert.equal(await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).byId(499).text), 'Recovered older caption', 'recovered text survives offline reload');
  assert.equal(await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).byId(500).text), 'New corrected report');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('[data-chatter-panel="telegram"]').isVisible());
  assert(await content.isVisible(), 'content selector remains reachable on mobile');
  await page.screenshot({ path: '/tmp/sattva-telegram-readable-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/sattva-telegram-readable-desktop.png', fullPage: true });
  // With no captured text at all, the default must expose the source links and honest zero.
  const emptyContext = await browser.newContext();
  const emptyPage = await emptyContext.newPage();
  await emptyPage.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  artifactStatus = snapshotStatus = 200;
  servedArtifact = null;
  servedCapture = { ...capture, posts: [{ ...post(499, null), mediaType: 'photo' }, capture.posts[2], { ...post(497, null), mediaType: 'video' }] };
  await emptyPage.goto(base, { waitUntil: 'domcontentloaded' });
  await emptyPage.waitForFunction(() => typeof window.renderScope === 'function');
  await emptyPage.evaluate(() => window.renderScope('universe', { section: 'telegram' }));
  const emptyContent = emptyPage.locator('[data-chatter-panel="telegram"] select[aria-label="Content"]');
  await emptyContent.waitFor();
  assert.equal(await emptyContent.inputValue(), 'all', 'no readable text still opens on the saved links');
  assert((await emptyPage.locator('[data-telegram-live]').innerText()).includes('0 readable here'), 'photos and filenames are not counted as readable text');
  assert((await emptyPage.locator('[data-chatter-panel="telegram"] tbody').innerText()).includes('Image · Open in Telegram'));
  assert((await emptyPage.locator('[data-chatter-panel="telegram"] tbody').innerText()).includes('Video · Open in Telegram'));
  assert((await emptyPage.locator('[data-chatter-panel="telegram"] tbody').innerText()).includes('Document in Telegram'));
  await emptyPage.locator('[data-row-key="tg:researchreportss:499"]').click();
  assert((await emptyPage.locator('[data-telegram-content-type]').innerText()).includes('Image in Telegram'));
  await emptyPage.locator('[data-modal-close]').click();
  await emptyContent.selectOption('readable');
  assert((await emptyPage.locator('[data-chatter-panel="telegram"]').innerText()).includes('Change the Content filter'));
  servedCapture = { ...servedCapture, posts: servedCapture.posts.map(p => p.id === 499 ? { ...p, text: 'Caption for the broker chart' } : p) };
  await emptyPage.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  const imageRow = emptyPage.locator('[data-row-key="tg:researchreportss:499"]');
  assert((await imageRow.innerText()).includes('Caption for the broker chart'));
  assert((await imageRow.innerText()).includes('Image in Telegram · Caption readable here'));
  await emptyPage.locator('[data-table-search]').fill('image');
  assert.equal(await emptyPage.locator('tbody tr[data-row-key]').count(), 1, 'media labels are searchable even with a caption');
  await emptyContext.close();
  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  console.log('PASS telegram section: newest posts visible by default, readable/media filters, honest media labels, source dates, modal, text recovery and offline retention, live edits, empty-watchlist scope and mobile');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

await import('./verify-telegram-cache-ui.mjs');
