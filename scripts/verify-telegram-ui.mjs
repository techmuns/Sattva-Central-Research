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
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (pathname === '/api/telegram/posts') {
    response.setHeader('content-type', 'application/json');
    response.statusCode = servedArtifact ? 200 : 404;
    response.end(JSON.stringify(servedArtifact || { error: 'no artifact' }));
    return;
  }
  if (pathname === '/data/telegram-posts.json') {
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

  assert(view.pill.includes('7 archived') && view.pill.includes('6 readable'));
  assert((await page.locator('[data-telegram-source-status]').innerText()).includes('has not been verified'));
  assert.equal(view.count, 7, 'every post in the capture is read');
  // ARCHIVED IS NOT LISTED. A message with no caption is kept — it is a real message, it carries
  // the publication date the ordering rests on, and the newest of them anchors the channel's head
  // — but a row reading only "Open in Telegram to read" answers nothing on a page of report
  // headlines, so it is not drawn. The two numbers are asserted against each other rather than
  // typed, or this passes for the wrong reason the day the fixture gains another media post.
  assert.equal(view.drawn, view.count - view.hidden, 'media-only posts are archived but not listed');
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
  // 499 is the caption-less image: archived, dated, counted — and never a row.
  await search.fill('499');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 0,
    'a caption-less image post is archived but never listed');
  // 498 carries no text either and IS listed, because its attachment is the content. That pair is
  // the whole rule: what decides a row is whether the message has something to read, not whether
  // Telegram happened to put it in the text field.
  await search.fill('498');
  assert.equal(await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').count(), 1,
    'a document post with no caption is still listed');
  await page.locator('[data-chatter-panel="telegram"] tbody tr[data-row-key]').click();
  await page.waitForSelector('[data-telegram-post-dialog]');
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
    assert.deepEqual(exportedIds, [500, 498, 496, 495, 493, 491],
      'export matches readable rows, including the document-only post, while captionless media remains archived');
    assert.equal(sheet.getCell('C3').value, '2026-05-13T10:57:05.000Z');
    assert.equal(sheet.getCell('G3').value, capturedAt, 'collector time is a separate column');
    assert.equal(sheet.getCell('A4').value, 'Broker C sector update.pdf');
    assert.equal(sheet.getCell('E4').value, 'Broker C sector update.pdf');
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
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('[data-chatter-panel="telegram"]').isVisible());
  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  console.log('PASS telegram section: module graph reachable, three sections without the chatter feed, source dates, restricted content, filenames, modal, retained failed refresh, empty-watchlist scope and mobile');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
