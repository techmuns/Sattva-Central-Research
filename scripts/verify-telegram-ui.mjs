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
const post = (id, text) => ({ id, text, url: `https://t.me/researchreportss/${id}`, publishedAt: null, firstSeenAt: capturedAt });
const capture = {
  source: 't.me public channel pages',
  channel: 'researchreportss',
  channelUrl: 'https://t.me/researchreportss',
  route: 'permalink',
  publishesTime: false,
  capturedAt,
  headId: 500, lowestId: 491, spanFrom: 491, spanTo: 500, walkedFrom: 491,
  lastRun: { scanned: 10, readable: 7, unreadable: 3, errors: 0 },
  retryIds: [],
  posts: [
    post(500, 'Broker A sees 30% UPSIDE in Company One - a note'),
    post(499, 'Broker B on Company Two - visit note'),
    post(498, 'Broker C sector update'),
    post(496, 'Broker D on Company Four'),
    post(495, 'Broker E results preview'),
    post(493, 'Broker F initiates coverage'),
    post(491, 'Broker G daily'),
  ],
};

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body class="bg-slate-50 p-4"><main id="content-host"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/public-chatter.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
const live={register(){},start(){},stop(){},subscribe(){return()=>{};}};
coverage.prime({holdings:[{ticker:'TCS',name:'Tata Consultancy Services'}]});
watchlist.clear();
window.tab=tab;
window.renderScope=(scope)=>{const root=document.querySelector('#content-host');tab.destroy();root.innerHTML='';tab.render({root,scope,live,data:{universe:[]},params:{}});};
window.renderScope('universe');
</script></body></html>`;

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (pathname === '/data/telegram-posts.json') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(capture));
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
      allNullTimes: t.posts().every((r) => r.publishedAt === null),
      starIsButton: !!host.querySelector('[data-chatter-panel="telegram"] tbody tr button[data-watch]'),
      footnotes: host.querySelector('[data-telegram-footnotes]')?.textContent.replace(/\s+/g, ' ') || '',
      description: host.querySelector('p')?.textContent.replace(/\s+/g, ' ') || '',
      pill: host.querySelector('[data-telegram-live]')?.textContent.replace(/\s+/g, ' ').trim() || '',
      pillTag: host.querySelector('[data-telegram-live]')?.tagName || '',
    };
  });

  assert.equal(view.count, 7, 'every post in the capture is read');
  assert.equal(view.drawn, 7, 'and every one of them is drawn');
  assert(view.descending, 'ordered by message id, newest first');
  assert(view.unique, 'row keys are unique');
  assert.equal(view.publishesTime, false);
  assert(view.allNullTimes, 'this route publishes no post times, so every post carries none');
  // THE CENTRAL CHECK. A column of em dashes would say "we asked and were refused"; the honest
  // statement is that this disclosure does not answer the question, so there is no column at all.
  assert(!view.heads.some((h) => /time|date|when|posted/i.test(h)), `no time column, got: ${view.heads.join(' | ')}`);
  assert(/publishes no post times/i.test(view.description), 'the absence is stated in words');
  // Coverage is derived from the span, so it must reconcile exactly: 10 ids, 7 readable, 3 not.
  assert.equal(view.span, 10);
  assert.equal(view.readable, 7);
  assert.equal(view.unreadable, 3);
  assert(/spans message/i.test(view.footnotes) && /without a caption/i.test(view.footnotes), 'coverage is stated');
  assert(/None of them is the third kind/i.test(view.footnotes), 'our own fetch failures are separated from the channel having nothing to say');
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
  assert.equal(watchRows, 7, 'an empty watchlist neither hides the section nor narrows it');

  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  console.log('PASS telegram section: module graph reachable, three sections without the chatter feed, no time column, coverage reconciled, no Live claim, freshness boundaries, empty-watchlist scope');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
