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
    send({ type: 'start' });
    const first = setTimeout(() => send({ type: 'text', text: 'The latest available company update is dated 6 September. ' }), 100);
    const second = setTimeout(() => send(failThisAnswer ? { type: 'error', message: 'Fixture model disconnected' } : { type: 'text', text: 'Read the source filing alongside the news. [Dashboard: News]' }), 900);
    const finish = setTimeout(() => { if (!holdAnswer) { send({ type: 'done' }); res.end(); } }, 1700);
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
  assert.equal(await family.evaluate(() => legacyReads), 0, 'the timed-out Family model path was never called');
  assert((await family.evaluate(() => positionReads)) >= 2, 'each question revalidates its holdings');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct') || JSON.stringify(localStorage).includes('jayaswal neco')), false, 'private context and questions stay out of storage');

  await family.evaluate(() => { window.failed = true; });
  await submit('What changed at IIFL Finance?');
  await page.getByText('Fixture archive check failed', { exact: false }).waitFor();
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, timings, assertions: ['progressive HTTP stream', 'exact user regression', 'no duplicate model', 'fresh complete holdings', 'follow-up retrieval', 'company switch', 'stable transcript and scroll', 'private storage', 'failed archive', 'workbook invalidation', 'Stop', 'partial recovery', 'mobile'] }, null, 2));
} finally {
  await browser.close();
  for (const response of activeResponses) response.destroy();
  await new Promise(done => server.close(done));
}
