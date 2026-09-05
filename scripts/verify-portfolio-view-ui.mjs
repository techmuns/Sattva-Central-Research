// Full Research shell with a synthetic authenticated Family peer. All network
// traffic is intercepted locally; no customer book or production action.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const familyOrigin = 'https://sattva-family.pages.dev';
const onemi = { isin: 'INE12F801023', name: 'OnEMI Technology Solutions Ltd', ticker: 'KISSHT', sector: 'Financials', weightPct: 60 };
const other = { isin: 'INE532F01054', name: 'Edelweiss', ticker: 'EDELWEISS', sector: 'Financials', weightPct: 30 };
const unknown = { isin: 'INE000000001', name: 'Unmapped held company', ticker: null, sector: 'Unclassified', weightPct: 10 };
const initial = [onemi, other, unknown];
const concallRow = ({ ticker, name, date = '2026-09-04', analysisTracked = false, type = 'Transcript' }) => ({
  companyKey: ticker || `screener:${name}`,
  companyId: ticker ? `NSE:${ticker}` : `SCREENER:${name}`,
  ticker: ticker || null,
  exchange: ticker ? 'NSE' : null,
  name,
  industry: null,
  when: `${date}T00:00:00+05:30`,
  date,
  publishedDate: date,
  ssUrl: null,
  pptSsUrl: null,
  src: null,
  notesReady: false,
  resultScore: analysisTracked ? 72 : null,
  sentimentTier: analysisTracked ? 3 : null,
  tags: analysisTracked ? ['Fixture growth'] : [],
  analysisTracked,
  documents: [{ type, url: `https://example.com/${encodeURIComponent(ticker || name)}.pdf` }],
});
const concallRows = [
  concallRow({ ticker: 'KISSHT', name: 'OnEMI Technology Solutions', analysisTracked: true, type: 'Presentation' }),
  concallRow({ ticker: 'NEWCO', name: 'New holding concall' }),
  concallRow({ ticker: 'OUTSIDE', name: 'Outside universe concall', type: 'Recording' }),
  concallRow({ ticker: null, name: 'Unresolved BSE concall' }),
];
const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const calendarRows = [
  { eventId: `result:${todayIst}:KISSHT`, eventType: 'Result', eventSource: 'Moneycontrol', scId: 'KISSHT', ticker: 'KISSHT', name: 'OnEMI scheduled result', resultDate: todayIst, quarter: 'Q2', time: null, exchange: 'N', noticeUrl: null },
  { eventId: 'concall:newco', eventType: 'Con-call', eventSource: 'Screener', scId: 'screener:newco', ticker: 'NEWCO', name: 'New holding scheduled call', resultDate: todayIst, quarter: null, time: '16:00:00', exchange: 'B', noticeUrl: 'https://www.bseindia.com/newco.pdf' },
  { eventId: 'concall:outside', eventType: 'Con-call', eventSource: 'Screener', scId: 'screener:outside', ticker: 'OUTSIDE', name: 'Outside scheduled call', resultDate: todayIst, quarter: null, time: '17:00:00', exchange: 'N', noticeUrl: 'https://nsearchives.nseindia.com/outside.pdf' },
  { eventId: 'concall:unresolved', eventType: 'Con-call', eventSource: 'Screener', scId: 'screener:unresolved', ticker: null, name: 'Unresolved scheduled call', resultDate: todayIst, quarter: null, time: '18:00:00', exchange: 'B', noticeUrl: 'https://www.bseindia.com/unresolved.pdf' },
];
const freshCalendarRow = { eventId: 'concall:fresh', eventType: 'Con-call', eventSource: 'Screener', scId: 'screener:fresh', ticker: 'KISSHT', name: 'Fresh portfolio call', resultDate: todayIst, quarter: null, time: '19:00:00', exchange: 'N', noticeUrl: 'https://nsearchives.nseindia.com/fresh.pdf' };
const familyHtml = `<script>
window.book = ${JSON.stringify(initial)}; window.version = 1; window.failed = false; window.requests = 0;
const channel = 'sattva-portfolio-v1', origin = ${JSON.stringify(origin)};
const send = data => parent.postMessage({ channel, ...data }, origin);
window.replaceBook = entries => { window.book = entries; window.version++; send({ type:'invalidated',version }); send({ type:'positions-ready',version }); };
addEventListener('message', event => {
 if(event.source !== parent || event.origin !== origin || event.data.channel !== channel) return;
 const { id, type } = event.data;
 if(type === 'hello') { send({ id, type:'ready', capabilities:['position-sizes','portfolio-context'] }); return; }
 if(type === 'cancel') return;
 window.requests++;
 if(window.failed) { send({ id, type:'error', message:'Fixture workbook unavailable' }); return; }
 setTimeout(() => {
 const stamp = { bookAsOf:'2026-08-31', checkedAt:new Date().toISOString(), archiveVersion:version };
 send({ id, type:'result', holdings:book, sizes:{ ...stamp, complete:true, basis:'listed-market-value', quotes:{} }, reading:{ ...stamp,status:'ready',answer:'Fixture book checked.' } });
 }, 30);
});
send({ id:'connector',type:'available' });
</script>`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = [], questions = [];
let searches = 0, calendarRequests = 0, calendarVersion = 0;
await context.addInitScript(() => localStorage.setItem('sattva:scope-lists:v1', JSON.stringify({ portfolio: { added: [{ ticker:'MANUAL',name:'Manual research selection' }], removed:[{ ticker:'KISSHT',name:'OnEMI' }] } })));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.origin === familyOrigin && url.pathname === '/research-bridge') return route.fulfill({ contentType:'text/html', body:familyHtml });
  if (url.origin !== origin) return route.fulfill({ status:503, body:'External network disabled' });
  if (url.pathname === '/data/portfolio-companies.json') return json({ asOf:'2026-06-30', count:1, resolved:1, holdings:[other] });
  if (url.pathname === '/data/news.json') return json({
    kind:'news', capturedAt:new Date().toISOString(), retention:'permanent-archive', overlapHours:48,
    portfolioLines:3, portfolioEntities:3, tickerlessPortfolioLines:1, tickerlessPortfolioEntities:1,
    entities:[
      {entityId:'isin:INE12F801023',key:'KISSHT',ticker:'KISSHT',name:'OnEMI Technology Solutions Ltd'},
      {entityId:'isin:INE532F01054',key:'EDELWEISS',ticker:'EDELWEISS',name:'Edelweiss'},
      {entityId:'isin:INE000000001',key:'ISIN:INE000000001',ticker:null,name:'Unmapped held company'},
    ],
    byTicker:{
      ...Object.fromEntries(['KISSHT','EDELWEISS','NEWCO'].map(t => [t,[{ date:'2026-09-04',title:`${t} announces dividend`,url:`https://example.com/${t}`,source:'Fixture' }]])),
      'ISIN:INE000000001':[{entityId:'isin:INE000000001',ticker:null,company:'Unmapped held company',date:'2026-09-04',title:'Tickerless private company routine update',url:'https://example.com/private-company',source:'Fixture'}],
    },
    empty:[], failed:{}, headers:[],
  });
  if (url.pathname === '/api/concalls') return json({
    ok: true,
    rows: concallRows,
    upcoming: [],
    today: { day: '2026-09-05', rows: [] },
    meta: { fetchedAt: new Date().toISOString(), quarter: 202609, screener: { status: 'ok', checkedAt: new Date().toISOString(), publishedTotal: 4, records: 4, fullHistory: true } },
  });
  if (url.pathname === '/api/earnings-calendar') {
    calendarRequests++;
    const currentCalendarRows = calendarVersion ? [...calendarRows, freshCalendarRow] : calendarRows;
    return json({
    ok: true,
    degraded: null,
    date: url.searchParams.get('date') || todayIst,
    from: url.searchParams.get('from') || todayIst,
    to: url.searchParams.get('to') || todayIst,
    listRequested: true,
    listSource: 'live',
    countSource: 'live',
    screenerUpcomingSource: 'artifact',
    screenerUpcomingCheckedAt: new Date().toISOString(),
    screenerUpcomingPublishedTotal: calendarVersion ? 4 : 3,
    screenerUpcomingRecords: calendarVersion ? 4 : 3,
    screenerUpcomingPagesFetched: 1,
    scheduledCount: currentCalendarRows.length,
    resultScheduledCount: 1,
    concallScheduledCount: currentCalendarRows.length - 1,
    pageSize: 20,
    pagesFetched: 1,
    resultComplete: true,
    concallComplete: true,
    complete: true,
    days: [{ date: todayIst, displayDate: todayIst, resultCount: 1, concallCount: currentCalendarRows.length - 1, count: currentCalendarRows.length }],
    rows: currentCalendarRows,
    meta: { source: 'Fixture schedules', fetchedAt: new Date().toISOString() },
    });
  }
  if (url.pathname === '/api/research') {
    if(route.request().method() === 'GET') return json({ configured:true });
    questions.push(route.request().postDataJSON());
    return route.fulfill({ contentType:'application/x-ndjson', body:JSON.stringify({type:'text',text:'Fixture answer.'})+'\n'+JSON.stringify({type:'done'})+'\n' });
  }
  if (url.pathname === '/api/stock-search') searches++;
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status:503,contentType:'application/json',body:'{"ok":false}' });
  return route.continue();
});
let page;
try {
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/research/news?scope=portfolio`);
  await page.waitForFunction(async () => (await import('/js/data/coverage.js')).meta().syncStatus === 'family-session');
  const peer = await (await page.locator('iframe[title="Private portfolio connection"]').elementHandle()).contentFrame(); assert.ok(peer);
  await peer.waitForFunction(() => Array.isArray(window.book));
  assert.equal(await page.locator('iframe[title="Private portfolio connection"]').isVisible(), false);
  await page.getByText('KISSHT announces dividend', { exact:true }).waitFor();
  await page.getByText('Tickerless private company routine update', { exact:true }).waitFor();
  assert.equal(await page.evaluate(async () => {
    const rows = (await import('/js/data/filings.js')).news.rows();
    const row = rows.find(item => item.title === 'Tickerless private company routine update');
    return row?.entityId === 'isin:INE000000001' && row?.ticker === null;
  }), true, 'tickerless company news stays linked by ISIN without a synthetic ticker');
  assert.deepEqual(await page.evaluate(async () => (await import('/js/data/coverage.js')).holdings().map(h => h.isin).sort()), initial.map(h => h.isin).sort());
  assert.deepEqual(await page.evaluate(async () => (await import('/js/core/watchlist.js')).all().map(h => h.ticker)), ['MANUAL']);
  await page.getByRole('button', { name:'View Portfolio',exact:true }).click();
  await page.getByRole('heading', { name:'View Portfolio',exact:true }).waitFor();
  assert.equal(await page.locator('[data-scope-count]').innerText(), '3');
  assert.equal(await page.locator('[data-scope-remove], [data-scope-reset], [data-scope-result]').count(), 0);
  const search = page.locator('[data-scope-search]');
  for (const query of ['OnEMI', 'kissht', onemi.isin]) {
    await search.fill(query);
    assert.equal(await page.locator('[data-scope-member]').count(), 1);
    assert.match(await page.locator('[data-scope-member]').innerText(), /Owned/);
  }
  assert.equal(searches, 0, 'owned-list search never creates an external Add result');
  await search.fill('Unmapped');
  assert.match(await page.locator('[data-scope-member]').innerText(), /Owned/);
  assert.match(await page.locator('[data-scope-member]').innerText(), /No NSE research symbol/);
  await search.fill('');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path:process.env.SCREENSHOT_PATH });
  const replacement = [onemi, { ...other, isin:'INE000000002',ticker:'NEWCO',name:'New holding' },unknown];
  await peer.evaluate(book => window.replaceBook(book), replacement);
  await page.locator('[data-scope-member]').filter({ hasText:'New holding' }).waitFor();
  assert.equal(await page.locator('[data-scope-member]').filter({ hasText:'Edelweiss' }).count(), 0);
  await page.getByRole('button', { name:'Done',exact:true }).click();
  await page.getByText('NEWCO announces dividend', { exact:true }).waitFor();
  assert.equal(await page.getByText('EDELWEISS announces dividend', { exact:true }).count(), 0);
  // Every tab shares the same identity set, including direct links and empty feeds.
  for (const tab of ['daily-alerts','earnings-hub','concall','public-chatter','breakouts','super-investors','ipos','corp-announcements','nse-filings','insider-trades','ai-alerts','ask-research']) {
    await page.evaluate(tab => { location.hash = `#/research/${tab}?scope=portfolio`; }, tab);
    await page.waitForFunction(async tab => (await import('/js/core/state.js')).state.tab === tab, tab);
    await page.getByRole('button', { name:'View Portfolio',exact:true }).click();
    assert.equal(await page.locator('[data-scope-count]').innerText(), '3', tab);
    await page.getByRole('button', { name:'Done',exact:true }).click();
    if (tab === 'concall') {
      await page.getByRole('heading', { name:'Concall Library', exact:true }).waitFor();
      const portfolioCalls = await page.locator('#content-host').innerText();
      assert.match(portfolioCalls, /OnEMI Technology Solutions/);
      assert.match(portfolioCalls, /New holding concall/);
      assert.doesNotMatch(portfolioCalls, /Outside universe concall|Unresolved BSE concall/);
      assert.match(portfolioCalls, /Presentation|Transcript/);
      assert.match(portfolioCalls, /documents/);
      await page.evaluate(() => { location.hash = '#/research/concall?scope=universe'; });
      await page.waitForFunction(async () => (await import('/js/core/state.js')).state.scope === 'universe');
      await page.getByText('Unresolved BSE concall', { exact:true }).waitFor();
      const universeCalls = await page.locator('#content-host').innerText();
      assert.match(universeCalls, /Outside universe concall/);
      assert.match(universeCalls, /Unresolved BSE concall/);
    }
    if (tab === 'earnings-hub') {
      await page.evaluate(date => { location.hash = `#/research/earnings-hub?scope=portfolio&view=calendar&date=${date}`; }, todayIst);
      await page.getByRole('heading', { name:'Earnings Calendar', exact:true }).waitFor();
      await page.getByText('New holding scheduled call', { exact:true }).waitFor();
      const portfolioCalendar = await page.locator('#content-host').innerText();
      assert.match(portfolioCalendar, /OnEMI scheduled result/);
      assert.match(portfolioCalendar, /New holding scheduled call/);
      assert.doesNotMatch(portfolioCalendar, /Outside scheduled call|Unresolved scheduled call/);
      assert.match(portfolioCalendar, /Result|Con-call/);
      calendarVersion = 1;
      await page.getByRole('button', { name:'Refresh', exact:true }).click();
      await page.getByText('Fresh portfolio call', { exact:true }).waitFor();
      assert.ok(calendarRequests >= 2, 'the header refresh revalidates an already-open calendar');
      await page.evaluate(async () => { (await import('/js/core/watchlist.js')).add('KISSHT', 'OnEMI scheduled result'); });
      await page.evaluate(date => { location.hash = `#/research/earnings-hub?scope=watchlist&view=calendar&date=${date}`; }, todayIst);
      await page.waitForFunction(async () => (await import('/js/core/state.js')).state.scope === 'watchlist');
      await page.getByText('OnEMI scheduled result', { exact:true }).waitFor();
      const watchlistCalendar = await page.locator('#content-host').innerText();
      assert.doesNotMatch(watchlistCalendar, /New holding scheduled call|Outside scheduled call|Unresolved scheduled call/);
      await page.evaluate(date => { location.hash = `#/research/earnings-hub?scope=universe&view=calendar&date=${date}`; }, todayIst);
      await page.waitForFunction(async () => (await import('/js/core/state.js')).state.scope === 'universe');
      await page.getByText('Unresolved scheduled call', { exact:true }).waitFor();
      const universeCalendar = await page.locator('#content-host').innerText();
      assert.match(universeCalendar, /Outside scheduled call/);
      assert.match(universeCalendar, /Unresolved scheduled call/);
    }
  }
  await page.getByRole('textbox', { name:'Ask about the dashboard' }).fill('What should I know?');
  await page.getByRole('button', { name:'Send question' }).click();
  await page.getByText('Fixture answer.', { exact:false }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-research-input]')?.disabled === false);
  assert.deepEqual(questions[0].evidence.portfolioPositions.holdings.map(h => h.isin).sort(), replacement.map(h => h.isin).sort());
  assert.equal(questions[0].evidence.portfolioPositions.holdings.find(h => h.ticker === 'KISSHT').weightPct, 60);
  // A connected iframe can lose workbook access between questions. Background
  // failures must repaint the badge, and only a valid read may restore it.
  const connectionBadge = page.locator('[data-portfolio-connection]');
  assert.match(await connectionBadge.innerText(), /Portfolio connected/);
  await peer.evaluate(() => { window.failed = true; });
  await page.evaluate(async () => { await (await import('/js/data/family-session.js')).refreshFamilySession(); });
  assert.match(await connectionBadge.innerText(), /Portfolio connection unavailable/);
  await page.evaluate(async () => { await (await import('/js/research/portfolio-bridge.js')).connectPortfolio(); });
  assert.match(await connectionBadge.innerText(), /Portfolio connection unavailable/);
  await page.getByRole('textbox', { name:'Ask about the dashboard' }).fill('Read my portfolio again');
  await page.getByRole('button', { name:'Send question' }).click();
  await page.getByText('Fixture workbook unavailable', { exact:false }).waitFor();
  assert.equal(questions.length, 1, 'a failed holdings read never reaches the Research model');
  assert.match(await connectionBadge.innerText(), /Portfolio connection unavailable/);
  await peer.evaluate(() => { window.failed = false; });
  await page.evaluate(async () => { await (await import('/js/data/family-session.js')).refreshFamilySession(); });
  assert.match(await connectionBadge.innerText(), /Portfolio connected/);
  assert.equal(await page.getByRole('textbox', { name:'Ask about the dashboard' }).inputValue(), 'Read my portfolio again');
  await page.getByRole('button', { name:'Send question' }).click();
  await page.waitForFunction(() => document.querySelector('[data-research-input]')?.disabled === false);
  assert.equal(questions.length, 2, 'a recovered question can use the verified portfolio');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct')), false);
  assert.deepEqual(errors, []);
  console.log('PASS: any-tab startup, OnEMI name/ticker/ISIN search, read-only ownership, uncovered holdings, legacy Watchlist migration, whole-book parity, additions/exits while open, Con-call and Earnings Calendar scope isolation across Portfolio/Watchlist/Universe, open-calendar refresh, all tabs, Ask exposure, outage status and verified recovery.');
} catch(error) {
  if(page) console.error((await page.locator('body').innerText()).slice(-5000), errors);
  throw error;
} finally { await browser.close(); await new Promise(done => server.close(done)); }
