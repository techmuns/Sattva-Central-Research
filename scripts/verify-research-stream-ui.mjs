#!/usr/bin/env node
// End-to-end Ask Research with local data and a synthetic authenticated peer.
// The peer deliberately never answers legacy model reads, reproducing the
// user's timeout. Real incremental HTTP responses verify progressive painting.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResearchBody } from '../worker/research.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const questions = [], timings = [], errors = [];
let holdAnswer = false;
let failAnswer = false;
let emptyStreamsRemaining = 0;
let firstDelayMs = 100;
let customAnswer = null;
// Presentation fixture only: figures and developments below are synthetic.
const readingAnswer = `Jayaswal Neco has a new company statement to review alongside its latest quarterly results. [Dashboard: News]

**Latest development:** The company published a clarification on 4 September. Read the filing before drawing conclusions about its financial effect. The available headline is a starting point; the attached document needs to be read for the complete statement. [Dashboard: Corp Announcements] Related reporting concerns a separate entity and does not establish a new event at this holding. [Dashboard: News]

**Market reaction:** The saved market reading shows higher activity. It does not establish that the company statement caused that activity. Keep publication dates and market observation dates separate when reviewing the sequence. [Dashboard: Breakouts/Technical]

**Financials (quarter ended June 2026):** Revenue is 120 and net profit is 8 in this synthetic fixture, compared with 100 and a loss of 2 in the comparison period. The change from a loss to a profit should be described directly rather than as a misleading percentage. [Dashboard: Earnings Hub]

**What needs attention:** Confirm the scope of the filing, distinguish direct company statements from related-entity reporting, and check the next disclosed milestone. No guidance or price target is established by these readings. [Dashboard: Corp Announcements]

**Next milestone:** A meeting is scheduled for 9 September; the notice does not establish that it has already occurred. [Dashboard: Corp Announcements]`;
const activeResponses = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/research') {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"configured":true}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const validated = validateResearchBody(body);
    if (!validated.ok) { res.writeHead(validated.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(validated)); return; }
    questions.push(body);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store, no-transform' });
    const send = event => res.write(JSON.stringify(event) + '\n');
    const failThisAnswer = failAnswer;
    const answer = customAnswer;
    send({ type: 'start' });
    if (emptyStreamsRemaining > 0) { emptyStreamsRemaining--; res.end(); return; }
    const first = setTimeout(() => send({ type: 'text', text: answer ? answer.slice(0, 150) : 'The latest available company update is dated 6 September. ' }), firstDelayMs);
    const second = setTimeout(() => send(failThisAnswer ? { type: 'error', message: 'Fixture model disconnected' } : { type: 'text', text: answer ? answer.slice(150) : 'Read the source filing alongside the news. [Dashboard: News]' }), firstDelayMs + 800);
    const finish = setTimeout(() => { if (!holdAnswer) { send({ type: 'done' }); res.end(); } }, firstDelayMs + 1600);
    activeResponses.add(res);
    res.on('close', () => { clearTimeout(first); clearTimeout(second); clearTimeout(finish); activeResponses.delete(res); });
    return;
  }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const familyOrigin = 'https://sattva-family.pages.dev';
// Synthetic sizes; never represent these as the customer's actual allocation.
const holdings = [
  { isin: 'INE854B01010', ticker: 'JAYNECOIND', name: 'Jayaswal Neco Industries Ltd', sector: 'Steel', weightPct: 60 },
  { isin: 'INE530B01024', ticker: 'IIFL', name: 'IIFL Finance Ltd', sector: 'Financials', weightPct: 30 },
  { isin: 'INE114A01011', ticker: 'SAIL', name: 'Steel Authority of India Ltd', sector: 'Steel', weightPct: 9 },
  { isin: 'INF000000001', ticker: null, name: 'Unmapped fund', sector: 'Fund', weightPct: 1 },
];
const familyHtml = `<script>
const channel='sattva-portfolio-v1', origin=${JSON.stringify(origin)}, holdings=${JSON.stringify(holdings)};
window.legacyReads=0; window.positionReads=0; window.failed=false; window.version=1;
const send=data=>parent.postMessage({channel,...data},origin);
window.invalidate=()=>{ window.version++; send({type:'invalidated',version}); };
addEventListener('message', event=>{
 if(event.source!==parent || event.origin!==origin || event.data.channel!==channel) return;
 const {id,type}=event.data;
 if(type==='hello') { send({id,type:'ready',capabilities:['position-sizes','portfolio-context']}); return; }
 if(type==='read') { window.legacyReads++; return; }
 if(type==='cancel') { send({id,type:'error',message:'Cancelled'}); return; }
 if(type!=='positions') return;
 window.positionReads++;
 setTimeout(()=>{
  if(window.failed) { send({id,type:'error',message:'Fixture archive check failed'}); return; }
  send({id,type:'result',holdings,sizes:{basis:'listed-market-value',complete:true,bookAsOf:'2026-08-31',archiveVersion:version,checkedAt:new Date().toISOString(),quotes:{asOf:'2026-09-04',status:'ready',priced:4,notLive:0}}});
 },40);
});
send({type:'available'});
</script>`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === familyOrigin && url.pathname === '/research-bridge') return route.fulfill({ contentType: 'text/html', body: familyHtml });
    if (url.origin !== origin) return route.fulfill({ status: 503, body: 'External network disabled' });
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/research') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"Test API unavailable"}' });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/research/ask-research?scope=portfolio`);
  await page.getByText('Portfolio connected', { exact: false }).waitFor();
  const family = page.frames().find(frame => frame.url().startsWith(familyOrigin));
  assert(family);
  const input = page.getByRole('textbox', { name: 'Ask about the dashboard' });
  const send = page.getByRole('button', { name: 'Send question' });
  const submit = async question => { await input.fill(question); await send.click(); };
  const exactQuestion = 'What is the latest info on jayaswal neco for me?';
  const started = Date.now();
  await submit(exactQuestion);
  await page.locator('.is-streaming .research-answer-body').filter({ hasText: 'latest available company update' }).waitFor({ timeout: 10_000 });
  timings.push({ scenario: 'cold exact user question', firstTextMs: Date.now() - started });
  assert.equal(await page.locator('.is-streaming .research-answer-body').innerText(), 'The latest available company update is dated 6 September.');
  assert.equal(await page.locator('.research-assistant-answer:not(.is-streaming)').count(), 0, 'first text is visible before completion');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].evidence.portfolio.mode, 'verified-holdings');
  assert.equal(questions[0].evidence.portfolioPositions.holdings.length, holdings.length);
  assert(questions[0].evidence.selection.companies.some(c => c.ticker === 'JAYNECOIND'));
  assert(questions[0].evidence.sources.some(s => s.rows.some(r => r.ticker === 'JAYNECOIND')), 'named company evidence is actually included');
  await page.locator('.research-assistant-answer:not(.is-streaming)').waitFor();
  await page.evaluate(() => { window.savedAnswerNode = document.querySelector('.research-assistant-answer'); });

  const warmStart = Date.now();
  await submit('And what are its main risks?');
  await page.locator('.is-streaming .research-answer-body').waitFor({ timeout: 3500 });
  timings.push({ scenario: 'warm follow-up', firstTextMs: Date.now() - warmStart });
  assert(questions[1].evidence.selection.companies.some(c => c.ticker === 'JAYNECOIND'), 'follow-up retrieves the same issuer');
  // Capture the completed node after the one allowed submit repaint, then make
  // sure subsequent stream chunks leave it attached and preserve scroll.
  await page.evaluate(() => {
    window.savedAnswerNode = document.querySelector('.research-assistant-answer:not(.is-streaming)');
    const transcript = document.querySelector('[data-research-transcript]');
    transcript.style.maxHeight = '120px';
    transcript.scrollTop = 0;
  });
  await page.locator('.is-streaming .research-answer-body').filter({ hasText: 'source filing' }).waitFor();
  assert(await page.evaluate(() => savedAnswerNode.isConnected), 'streaming never rebuilds earlier answers');
  assert.equal(await page.locator('[data-research-transcript]').evaluate(node => node.scrollTop), 0, 'new tokens respect a reader scrolling back');
  await page.waitForFunction(() => document.querySelectorAll('.research-assistant-answer:not(.is-streaming)').length === 2);
  assert(await page.evaluate(() => savedAnswerNode.isConnected), 'completion also preserves earlier message nodes');
  assert.equal(await page.locator('[data-research-transcript]').evaluate(node => node.scrollTop), 0, 'completion respects a reader scrolling back');
  assert.equal(await family.evaluate(() => legacyReads), 0, 'the timed-out Family model path was never called');
  assert((await family.evaluate(() => positionReads)) >= 2, 'each question revalidates its holdings');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct') || JSON.stringify(localStorage).includes('jayaswal neco')), false, 'private context and questions stay out of storage');

  await family.evaluate(() => { window.failed = true; });
  await submit('What changed at IIFL Finance?');
  await page.getByText('Fixture archive check failed', { exact: false }).waitFor();
  assert(await page.locator('.research-user-bubble').last().innerText().then(text => text === 'What changed at IIFL Finance?'), 'failed holdings read keeps the user question visible');
  assert.equal(await page.locator('.research-assistant-answer').last().locator('[data-research-preview]').count(), 0, 'unverified holdings never produce a portfolio preview');
  assert.equal(questions.length, 2, 'an invalid private book never reaches the model');
  assert.equal(await input.inputValue(), 'What changed at IIFL Finance?', 'failed question is recoverable');
  await family.evaluate(() => { window.failed = false; });
  holdAnswer = true;
  await send.click();
  await page.locator('.is-streaming .research-answer-body').waitFor();
  assert(questions[2].evidence.selection.companies.some(c => c.ticker === 'IIFL'));
  assert(!questions[2].evidence.selection.companies.some(c => c.ticker === 'JAYNECOIND'), 'explicit company switches replace the old issuer');
  await family.evaluate(() => window.invalidate());
  await page.getByText('The Family workbook changed', { exact: false }).waitFor();
  assert.equal(await page.locator('.is-streaming').count(), 0, 'invalidation cancels in-flight output');
  await send.click();
  await page.locator('.is-streaming .research-answer-body').waitFor();
  const stopStarted = Date.now();
  assert.equal(await page.getByRole('button', { name: 'Stop answer' }).locator('svg rect').count(), 1, 'mobile cancellation uses a stop icon');
  await page.getByRole('button', { name: 'Stop answer' }).click();
  await send.waitFor();
  assert(await page.locator('.research-assistant-answer').last().innerText().then(text => text.includes('Answer stopped') && text.includes('latest available company update')), 'Stop preserves already streamed text');
  assert(Date.now() - stopStarted < 1000, 'Stop restores the composer immediately');
  assert.equal(await input.inputValue(), 'What changed at IIFL Finance?');
  holdAnswer = false;
  failAnswer = true;
  await send.click();
  await page.getByText('Incomplete answer', { exact: false }).waitFor();
  assert.equal(await input.inputValue(), 'What changed at IIFL Finance?');
  assert(await page.locator('.research-assistant-answer:not(.is-streaming)').last().innerText().then(text => text.includes('latest available company update')), 'network errors keep labelled partial text');
  await page.locator('[data-research-transcript]').evaluate(node => { node.style.maxHeight = ''; });

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await input.isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile layout does not overflow');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  // A cold source that never resolves must not hold every other source hostage.
  failAnswer = false;
  const slow = await context.newPage();
  slow.on('pageerror', error => errors.push(error.message));
  const parked = [];
  await slow.route('**/api/screener-insights', route => { parked.push(route); });
  await slow.goto(`${origin}/#/research/ask-research?scope=portfolio`);
  await slow.getByText('Portfolio connected', { exact: false }).waitFor();
  const slowStart = Date.now();
  await slow.getByRole('textbox', { name: 'Ask about the dashboard' }).fill(exactQuestion);
  await slow.getByRole('button', { name: 'Send question' }).click();
  await slow.locator('.is-streaming .research-answer-body').waitFor({ timeout: 10_000 });
  timings.push({ scenario: 'stalled optional source', firstTextMs: Date.now() - slowStart });
  assert(parked.length > 0);
  assert.equal(questions.at(-1).evidence.sources.find(s => s.id === 'screener-insights').status, 'unavailable');
  assert(questions.at(-1).evidence.sources.some(s => s.rows.some(r => r.ticker === 'JAYNECOIND')), 'other evidence survives a stalled feed');
  for (const route of parked) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  await slow.close();

  // Exact customer screenshot: HTTP 200 closes without text or done. Recover
  // once before any answer; a second closure must stop, not retry forever.
  const screenshotQuestion = 'any new updates on jayaswal neco?';
  emptyStreamsRemaining = 1;
  const beforeRetry = questions.length;
  const completedBefore = await page.locator('.research-assistant-answer:not(.is-streaming)').count();
  await submit(screenshotQuestion);
  await page.waitForFunction(n => document.querySelectorAll('.research-assistant-answer:not(.is-streaming)').length > n, completedBefore);
  assert.equal(questions.length - beforeRetry, 2, 'an empty transport reconnects once');
  assert.deepEqual(questions.at(-1).evidence, questions.at(-2).evidence, 'reconnection retains the verified question context');
  assert.equal(await input.inputValue(), '');
  emptyStreamsRemaining = 2;
  const beforeFailure = questions.length;
  await submit(screenshotQuestion);
  await page.getByText('The answer ended before a complete response arrived.', { exact: true }).waitFor();
  assert.equal(questions.length - beforeFailure, 2, 'persistent empty responses have a bounded retry');
  assert.equal(await input.inputValue(), screenshotQuestion, 'persistent failure keeps the question');
  assert.equal(await page.locator('.research-opening').count(), 0, 'empty failure never resets the conversation to the welcome screen');
  assert.equal(await page.locator('.research-user-bubble').last().innerText(), screenshotQuestion);
  assert(await page.locator('.research-assistant-answer').last().locator('[data-research-preview]').isVisible(), 'source readings remain available after an empty failure');

  // Hold the model before its first token. Source readings must paint honestly
  // before it, and typing/IME composition cannot submit or erase a next draft.
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Start a new research conversation' }).click();
  firstDelayMs = 2500;
  const previewStarted = Date.now();
  await submit(screenshotQuestion);
  const livePreview = page.locator('.is-streaming [data-research-preview]');
  await livePreview.waitFor({ timeout: 10_000 });
  timings.push({ scenario: 'source readings before delayed model', evidenceVisibleMs: Date.now() - previewStarted });
  assert.equal(await page.locator('.is-streaming .research-answer-body').count(), 0, 'literal source preview is never presented as model prose');
  assert((await livePreview.innerText()).includes('before the generated answer'));
  assert((await livePreview.locator('.research-evidence-item').count()) > 0, 'exact company question has useful confirmed headlines');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-preview.png'), fullPage: true });
  const packet = questions.at(-1).evidence;
  for (const title of await livePreview.locator('.research-evidence-item > p').allTextContents()) {
    assert(packet.sources.some(s => s.rows.some(r => (r.title || r.headline) === title)), 'preview quotes a reading in the verified packet verbatim');
  }
  await input.fill('What changed at IIFL Finance?');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  const requestsWhileWriting = questions.length;
  await page.locator('.research-assistant-answer:not(.is-streaming)').waitFor();
  assert.equal(questions.length, requestsWhileWriting, 'typing does not start a second model');
  assert.equal(await input.inputValue(), 'What changed at IIFL Finance?', 'completed answer preserves a next draft');

  firstDelayMs = 100;
  failAnswer = true;
  await send.click();
  await input.fill('Any earnings updates for Jayaswal Neco?');
  await page.getByText('Fixture model disconnected', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'Any earnings updates for Jayaswal Neco?', 'failed answer preserves a next draft');
  const messagesBeforeRetry = await page.locator('.research-user-bubble').count();
  const holdingsBeforeRetry = await family.evaluate(() => positionReads);
  failAnswer = false;
  await page.getByRole('button', { name: 'Retry answer', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.is-streaming'));
  assert.equal(await page.locator('.research-user-bubble').count(), messagesBeforeRetry, 'manual retry replaces only the failed attempt');
  assert.equal(await input.inputValue(), 'Any earnings updates for Jayaswal Neco?', 'manual retry preserves the next draft');
  assert((await family.evaluate(() => positionReads)) > holdingsBeforeRetry, 'manual retry revalidates holdings');
  assert.equal(questions.at(-1).question, 'What changed at IIFL Finance?');
  assert.equal(questions.at(-1).history.length, 2, 'only the preceding completed exchange enters model history');
  assert(!questions.at(-1).history.some(m => /What changed at IIFL Finance/.test(m.text)), 'failed question is not included as model history');

  // Customer reading experience on the actual page, using synthetic prose.
  customAnswer = readingAnswer;
  await page.getByRole('button', { name: 'Start a new research conversation' }).click();
  await submit('What needs my attention at Jayaswal Neco?');
  await page.locator('.is-streaming .research-answer-body').waitFor();
  assert.equal(await page.locator('.is-streaming [data-research-preview]').evaluate(node => node.open), false, 'source preview yields space when answer text starts');
  await page.waitForFunction(() => !document.querySelector('.is-streaming'));
  const answerArticle = page.locator('.research-assistant-answer').last();
  assert.equal(await answerArticle.locator('.research-answer-heading').count(), 5, 'bold section labels become readable headings');
  assert.equal(await answerArticle.locator('.research-cite-unresolved').count(), 0, 'slash spacing in a valid tab citation still resolves');
  assert.equal(await answerArticle.locator('.research-answer-references a').count(), 4, 'repeated citations share one source reference');
  assert.equal(await answerArticle.getByRole('link', { name: 'Source 1: News', exact: true }).count(), 2);
  assert.equal(await answerArticle.getByRole('link', { name: 'Source 3: Breakouts / Technical', exact: true }).getAttribute('href'), '#/research/breakouts?scope=portfolio&company=JAYNECOIND');
  assert.match(await answerArticle.locator('.research-answer-freshness').innerText(), /2026-08-31/);
  assert.equal(await answerArticle.locator('.research-answer-context').evaluate(node => node.open), false, 'detailed provenance is available without crowding the answer');
  await answerArticle.locator('.research-answer-context > summary').click();
  assert(await answerArticle.getByText('Snapshot for this answer, not a live refresh.', { exact: false }).isVisible());
  await answerArticle.locator('.research-answer-context > summary').click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await answerArticle.getByRole('button', { name: 'Copy answer', exact: true }).click();
  await answerArticle.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), readingAnswer, 'copy retains the exact answer, figures and named citations');
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Clipboard denied by host'); } }));
  await answerArticle.getByRole('button', { name: 'Copy answer', exact: true }).click();
  await answerArticle.getByText('Select the answer text to copy it.', { exact: true }).waitFor();
  await page.evaluate(() => { delete navigator.clipboard.writeText; });
  await input.fill('Keep this next question');
  await page.getByRole('button', { name: 'Reading view', exact: true }).click();
  assert.equal(await page.locator('.research-sidebar').isVisible(), false);
  assert.equal(await input.inputValue(), 'Keep this next question');
  await answerArticle.getByRole('button', { name: 'Read from start', exact: false }).click();
  await page.getByRole('button', { name: 'Latest answer', exact: false }).waitFor();
  const geometry = await answerArticle.locator(':scope > .research-answer-body').evaluate(node => ({ width: node.getBoundingClientRect().width, font: parseFloat(getComputedStyle(node).fontSize) }));
  assert(geometry.width < 750 && geometry.font >= 15, 'wide screens keep a readable line length and text size');
  assert(await page.locator('[data-research-composer]').evaluate(node => node.getBoundingClientRect().height < 75), 'one-line composer leaves more space for reading');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-reading.png'), fullPage: true });
  await page.getByRole('button', { name: 'Latest answer', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('[data-research-latest]').hidden);
  await page.setViewportSize({ width: 390, height: 844 });
  await answerArticle.getByRole('button', { name: 'Read from start', exact: false }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'reading view and citations fit mobile');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-reading-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Exit reading view', exact: true }).click();
  assert(await page.locator('.research-sidebar').isVisible());
  await page.setViewportSize({ width: 1440, height: 1050 });
  customAnswer = null;

  const safeRender = await page.evaluate(async () => {
    const { renderResearchAnswer } = await import('/js/research/renderer.js');
    const node = document.createElement('div');
    document.body.appendChild(node);
    renderResearchAnswer(node, '**Facts:** Zero is 0, missing is unavailable. [Dashboard: Unknown]\n\n<img src=x onerror="window.badPreview=true">\n\n| Period | Value |\n| --- | --- |\n| June | 120 |', { compactCitations: true, cite: () => null });
    const result = { text: node.textContent, unsafe: node.querySelectorAll('img,script').length, tables: node.querySelectorAll('table').length, unresolved: node.querySelectorAll('.research-cite-unresolved').length };
    renderResearchAnswer(node, 'Stable first paragraph.\n\nNext reading [Dashboard: Ne', { streaming: true });
    const first = node.firstChild;
    result.partialCitationHidden = !node.textContent.includes('[Dashboard:');
    renderResearchAnswer(node, 'Stable first paragraph.\n\nNext reading [Dashboard: News]\n\nMore text.', { streaming: true });
    result.stableParagraph = first === node.firstChild && first.isConnected;
    renderResearchAnswer(node, 'Portfolio reading [Dashboard: Ask Sattva]', { compactCitations: true, cite: () => ({ href: 'https://sattva-family.pages.dev/ask', label: 'Ask Sattva' }) });
    result.externalTarget = node.querySelector('.research-cite').target;
    renderResearchAnswer(node, '# Summary\n\n**Revenue**: 120\n\n**Risks**\n\nStill unresolved.');
    result.headingVariants = [...node.querySelectorAll('h3')].map(heading => heading.textContent);
    node.remove(); return result;
  });
  assert.equal(safeRender.unsafe, 0);
  assert.equal(safeRender.tables, 1);
  assert.equal(safeRender.unresolved, 1, 'unknown pages never become fabricated working citations');
  assert(safeRender.stableParagraph, 'completed paragraphs remain mounted while later blocks stream');
  assert(safeRender.partialCitationHidden, 'split citation syntax does not flash into the answer');
  assert.equal(safeRender.externalTarget, '_blank', 'external portfolio sources preserve the research conversation');
  assert.deepEqual(safeRender.headingVariants, ['Summary', 'Revenue:', 'Risks']);
  assert(safeRender.text.includes('Zero is 0, missing is unavailable.'));

  // A proxy that never sends a terminal event is bounded by a browser deadline.
  await page.clock.install();
  holdAnswer = true;
  await send.click();
  await page.locator('.is-streaming .research-answer-body').waitFor();
  await page.clock.fastForward(56_000);
  await page.getByText('The answer is taking too long.', { exact: false }).waitFor();
  assert(await send.isEnabled(), 'a stalled stream releases the composer');
  assert(await page.locator('.research-assistant-answer').last().innerText().then(text => text.includes('latest available company update')), 'timeout retains labelled partial text');
  holdAnswer = false;
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct') || JSON.stringify(localStorage).includes('Any earnings updates')), false, 'preview and recovery keep private conversations out of storage');

  // Initial server connection failures can recover without refreshing the app.
  const disconnected = await context.newPage();
  disconnected.on('pageerror', error => errors.push(error.message));
  let configFailures = 1;
  await disconnected.route('**/api/research', route => configFailures-- > 0
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await disconnected.goto(`${origin}/#/research/ask-research?scope=portfolio`);
  await disconnected.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
  await disconnected.getByRole('textbox', { name: 'Ask about the dashboard' }).fill(screenshotQuestion);
  await disconnected.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await disconnected.waitForFunction(() => !document.querySelector('[data-research-send]').disabled);
  assert.equal(await disconnected.getByRole('textbox', { name: 'Ask about the dashboard' }).inputValue(), screenshotQuestion);
  await disconnected.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, timings, assertions: ['progressive HTTP stream', 'exact user regression', 'no duplicate model', 'fresh complete holdings', 'follow-up retrieval', 'company switch', 'stable transcript and scroll through completion', 'private storage', 'failed archive', 'workbook invalidation', 'Stop preserves text', 'partial recovery', 'mobile', 'source preview before inference', 'visible empty failure', 'next draft and IME input', 'manual retry revalidates holdings', 'browser deadline', 'connection recovery', 'readable heading variants', 'numbered citations with source names', 'reading view and compact composer', 'copy with exact provenance', 'jump to latest and start', 'mobile line length', 'safe markup and tables', 'stable streamed paragraphs', 'external sources preserve conversation'] }, null, 2));
} finally {
  await browser.close();
  for (const response of activeResponses) response.destroy();
  await new Promise(done => server.close(done));
}
