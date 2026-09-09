import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { addResolvedTickers, parseScreenerConcallPage, parseScreenerMarketUpcomingPage, screenerTime } from './lib/screener-concalls.mjs';
import { parseScreenerUpcomingPage as parseScreenerPortfolioUpcomingPage, upcomingDay, upcomingTime } from './lib/screener-upcoming.mjs';
import {
  enrichConcallScans,
  groupScreenerConcalls,
  mergeScreenerConcallCapture,
  mergeScreenerConcallRows,
  mergeScreenerMarketUpcomingRows,
  SCREENER_CONCALL_ARTIFACT,
  SCREENER_CONCALL_ID,
  validateScreenerConcallCapture,
} from '../public/js/data/screener-concalls-shared.js';
import { mergeEarningsCalendarSources } from '../public/js/data/earnings-calendar-shared.js';
import { filterByScope } from '../public/js/data/scope.js';
import { deepDiveEligible, matchingDeepDive, reportingQuarter } from '../public/js/concall/scans.js';
import * as deepDiveData from '../public/js/data/deep-dive.js';
import { readScreenerConcallCollector, readScreenerConcallCollection, SCREENER_DOCUMENT_ARTIFACT } from '../worker/screener-concalls-collector.mjs';
import { writeDocumentCheckpoint } from './lib/concall-document-checkpoint.mjs';

const observedAt = '2026-09-05T01:00:00.000Z';
const row = ({ company = 'Dhoot Transmission', key = 'DHOOTTRANS', date = '4 September 2026', kind = 'Recording', url, summary = null } = {}) => `
  <tr><th class="field-company_display"><a href="${url}"></a><a href="/company/${key}/consolidated/"><span>${company}</span></a></th>
  <td class="field-pub_date nowrap">${date}</td><td class="field-action_display"><a href="${url}">View ${kind}</a>${summary ? ` <a href="${summary}">View Summary</a>` : ''}</td></tr>`;
const html = `<!doctype html><table id="result_list"><tbody>
  ${row({ url: 'http://legacy.example.com/audio/call.mp3', summary: '/concalls/summary/23328860/' })}
  ${row({ kind: 'Presentation', url: 'https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=deck.pdf' })}
  ${row({ company: 'Leap India', key: '544999', kind: 'Transcript', url: 'https://media.example.com:3000/leap.pdf' })}
  </tbody></table><a href="?p=2">2</a><div>3 concalls</div>`;

const parsed = parseScreenerConcallPage(html, observedAt);
const rows = addResolvedTickers(parsed.rows, (name) => (name === 'Leap India' ? 'LEAPIND' : null));
const portfolioUpcomingHtml = `<!doctype html><aside class="sidebar-panel"><h2>Upcoming</h2><div>S Screen</div>
  <ul class="bg-base list-style-none">
    <li><strong>Today</strong></li>
    <li class="flex"><a href="/company/GAEL/consolidated/"><span class="ink-900">Guj. Ambuja Exp</span></a><div><span class="badge sub">AGM</span></div></li>
    <li><strong>Tue, 8 Sep</strong></li>
    <li class="flex"><a href="/company/GODREJAGRO/consolidated/"><span class="ink-900">Godrej Agrovet</span></a><div><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=call.pdf"><span class="tag tag-small"><i class="icon-phone"></i>9:30 a.m.</span></a></div></li>
    <li><strong>Thu, 10 Sep</strong></li>
    <li class="flex"><a href="/company/GAJA/consolidated/"><span class="ink-900">Gaja Alternative Asset</span></a><div><span class="badge sub"><i class="icon-chart-bar"></i>Result</span></div></li>
    <li><strong>Sat, 2 Jan</strong></li>
    <li class="flex"><a href="/company/531569/"><span class="ink-900">Sanjiv.Parant.</span></a><div><span class="badge sub">Postal ballot</span></div></li>
  </ul></aside>`;
const portfolioUpcoming = parseScreenerPortfolioUpcomingPage(portfolioUpcomingHtml, observedAt);
const marketUpcomingHtml = `<!doctype html><table id="result_list"><tbody>
  <tr><th class="field-company_object_display"><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=studds.pdf"></a><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=studds.pdf">Studds Accessor.</a></th><td class="field-date nowrap">5 September 2026</td><td class="field-time nowrap">4:00:00 PM</td></tr>
  <tr><th class="field-company_object_display"><a href="https://nsearchives.nseindia.com/corporate/PURPLEUNITED_invite.pdf">Purple United</a></th><td class="field-date nowrap">6 September 2026</td><td class="field-time nowrap">12:00:00 AM</td></tr>
</tbody></table><a href="?p=2">2</a><div>2 concall invites</div>`;
const upcomingParsed = parseScreenerMarketUpcomingPage(marketUpcomingHtml, observedAt);
const upcomingRows = addResolvedTickers(upcomingParsed.rows, (name) => (name === 'Studds Accessor.' ? 'STUDDS' : null));
const capture = {
  version: 1,
  sourceId: SCREENER_CONCALL_ID,
  checkedAt: observedAt,
  publishedTotal: 3,
  pagesFetched: 2,
  fullHistory: true,
  duplicatesRemoved: 0,
  portfolioUpcoming,
  rows,
  upcomingPublishedTotal: 2,
  upcomingPagesFetched: 2,
  upcomingDuplicatesRemoved: 0,
  upcoming: upcomingRows,
};

test('authenticated page parser keeps every document and its fixed Screener identities', () => {
  assert.equal(parsed.publishedTotal, 3);
  assert.equal(parsed.lastPage, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((item) => item.kind), ['Recording', 'Presentation', 'Transcript']);
  assert.equal(rows[0].ticker, 'DHOOTTRANS');
  assert.equal(rows[2].ticker, 'LEAPIND');
  assert.equal(rows[0].url, 'http://legacy.example.com/audio/call.mp3', 'legacy HTTP documents remain available as inert web links');
  assert.equal(rows[2].url, 'https://media.example.com:3000/leap.pdf', 'publisher document ports are preserved');
  assert.equal(rows[0].summaryUrl, 'https://www.screener.in/concalls/summary/23328860/');
  validateScreenerConcallCapture(capture, Date.parse(observedAt));
});

test('S Screen parser keeps today, times, event types and year rollover without inventing a BSE ticker', () => {
  assert.equal(portfolioUpcoming.length, 4);
  assert.deepEqual(portfolioUpcoming.map((item) => [item.date, item.eventType, item.time]), [
    ['2026-09-05', 'AGM', null],
    ['2026-09-08', 'Con-call', '09:30'],
    ['2026-09-10', 'Result', null],
    ['2027-01-02', 'Postal ballot', null],
  ]);
  assert.equal(portfolioUpcoming[1].sourceUrl, 'https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=call.pdf');
  assert.equal(portfolioUpcoming[3].ticker, null);
  assert.equal(upcomingDay('Fri, 2 Oct', '2026-09-05'), '2026-10-02');
  assert.equal(upcomingTime('12 p.m.'), '12:00');
  assert.equal(upcomingTime('12:15 a.m.'), '00:15');
});

test('a short final page retains the catalogue page count instead of inflating it', () => {
  const lastPage = `<!doctype html><table id="result_list"><tbody>${row({ url: 'https://example.com/final.mp3' })}</tbody></table><a href="?p=168">168</a><div>4,189 concalls</div>`;
  assert.equal(parseScreenerConcallPage(lastPage, observedAt).lastPage, 168);
});

test('upcoming parser keeps company, date, IST time and exchange notice identity', () => {
  assert.equal(upcomingParsed.publishedTotal, 2);
  assert.equal(upcomingParsed.lastPage, 2);
  assert.equal(screenerTime('12:00:00 AM'), '00:00:00');
  assert.equal(screenerTime('4:00:00 PM'), '16:00:00');
  assert.deepEqual(upcomingRows.map((item) => item.exchange), ['BSE', 'NSE']);
  assert.equal(upcomingRows[0].ticker, 'STUDDS');
  assert.equal(mergeScreenerMarketUpcomingRows(upcomingRows, upcomingRows).length, 2);
  validateScreenerConcallCapture(capture, Date.parse(observedAt));
});

test('earnings calendar preserves result and con-call events and filters only after ticker resolution', () => {
  const result = { scId: 'MC1', name: 'Studds Accessor.', ticker: 'STUDDS', resultDate: '2026-09-05', time: null };
  const merged = mergeEarningsCalendarSources({
    date: '2026-09-05',
    days: [{ date: '2026-09-05', displayDate: '5 Sep', count: 1 }],
    resultRows: [result],
    upcoming: upcomingRows,
  });
  assert.equal(merged.scheduledCount, 2);
  assert.equal(merged.resultScheduledCount, 1);
  assert.equal(merged.concallScheduledCount, 1);
  assert.deepEqual(merged.rows.map((item) => item.eventType), ['Con-call', 'Result']);
  assert.equal(new Set(merged.rows.map((item) => item.eventId)).size, 2, 'a result and its con-call remain distinct events');
  assert.deepEqual(filterByScope(merged.rows, 'portfolio', [{ ticker: 'STUDDS' }]).map((item) => item.ticker), ['STUDDS', 'STUDDS']);
  assert.equal(filterByScope(merged.rows, 'watchlist', []).length, 0);
  assert.ok(merged.days.some((item) => item.date === '2026-09-06' && item.concallCount === 1), 'long-range call dates join the strip');
});

test('same company/date becomes one visible call with all unique documents', () => {
  const groups = groupScreenerConcalls(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((item) => item.ticker === 'DHOOTTRANS').documents.map((document) => document.type), ['Recording', 'Presentation', 'Summary']);
});

test('Screener history enriches matching analysis without duplicate rows and scopes by ticker', () => {
  const scan = {
    companyKey: '42', companyId: 'NSE:DHOOTTRANS', ticker: 'DHOOTTRANS', exchange: 'NSE', name: 'Dhoot Transmission Ltd',
    industry: 'Auto Components', when: '2026-09-04T16:00:00+05:30', date: '2026-09-04', ssUrl: 'analysis.pdf', pptSsUrl: null,
    src: 1, notesReady: true, resultScore: 66, sentimentTier: 3, tags: ['▲ Growth'],
  };
  const enriched = enrichConcallScans([scan], rows);
  assert.equal(enriched.length, 2, 'two Dhoot documents do not create two Dhoot call rows');
  assert.equal(enriched.find((item) => item.ticker === 'DHOOTTRANS').documents.length, 3);
  assert.equal(enriched.find((item) => item.ticker === 'LEAPIND').analysisTracked, false);
  const holdings = [{ ticker: 'DHOOTTRANS' }];
  assert.deepEqual(filterByScope(enriched, 'portfolio', holdings).map((item) => item.ticker), ['DHOOTTRANS']);
  assert.deepEqual(filterByScope(enriched, 'universe', holdings).map((item) => item.ticker).sort(), ['DHOOTTRANS', 'LEAPIND']);
});

test('Deep Dive fills document-only gaps only for a confirmed, transcript-backed, unambiguous call', () => {
  assert.equal(deepDiveEligible({ name: 'Unlisted Example Ltd', ticker: null }), true, 'a missing exchange ticker does not remove the Deep Dive action');
  assert.equal(deepDiveEligible({ name: ' ', ticker: 'LISTED' }), true, 'a ticker remains a valid fallback identity');
  assert.equal(deepDiveEligible({ name: '', ticker: null }), false, 'a row with no company identity cannot be dispatched');
  assert.equal(reportingQuarter('2026-03-31'), 'Q3FY26');
  assert.equal(reportingQuarter('2026-04-01'), 'Q4FY26');
  assert.equal(reportingQuarter('2026-07-01'), 'Q1FY27');
  assert.equal(reportingQuarter('2026-10-01'), 'Q2FY27');

  const documentOnly = {
    rowUid: 'screener:GAPTEST:2026-08-05',
    ticker: 'GAPTEST',
    date: '2026-08-05',
    publishedDate: '2026-08-05',
    analysisTracked: false,
  };
  const exact = {
    slug: 'gaptest-q1fy27',
    ticker: 'GAPTEST',
    quarter: 'Q1FY27',
    quarter_confirmed: true,
    transcript_available: true,
    result: 'Beat',
    verdict: 'Positive',
    headline: 'Margins expanded on stronger execution.',
  };
  const reports = { GAPTEST: [exact] };

  assert.equal(matchingDeepDive(documentOnly, [documentOnly], reports), exact);
  assert.equal(matchingDeepDive(documentOnly, [documentOnly], { GAPTEST: [{ ...exact, quarter_confirmed: false }] }), null);
  assert.equal(matchingDeepDive(documentOnly, [documentOnly], { GAPTEST: [{ ...exact, transcript_available: false }] }), null);
  assert.equal(
    matchingDeepDive(documentOnly, [documentOnly, { ...documentOnly, rowUid: 'screener:GAPTEST:2026-08-20', date: '2026-08-20' }], reports),
    null,
    'two calls for one ticker and quarter are ambiguous even when the current scope hides one',
  );
});

test('a tickerless company can dispatch and reattach by exact call row', async () => {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const storage = new Map();
  const requests = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return Response.json({ ok: true, slug: 'unlisted-example', status: 'done' });
    return Response.json({ ok: true, slug: 'unlisted-example', status: 'done', report: { meta: { company: 'Unlisted Example Ltd' } } });
  };

  try {
    deepDiveData.setBaseUrl('https://deep-dive.test');
    const out = await deepDiveData.start({
      company: 'Unlisted Example Ltd',
      ticker: null,
      recordId: 'screener-row-without-ticker',
      date: '2026-08-05',
    });
    assert.equal(out.slug, 'unlisted-example');
    assert.deepEqual(requests[0].body, { company: 'Unlisted Example Ltd', force: false }, 'the service receives the company name without an invented ticker');
    assert.equal(deepDiveData.remembered(null, 'screener-row-without-ticker')?.slug, 'unlisted-example');
    assert.equal(deepDiveData.rememberedByRecord()['screener-row-without-ticker']?.slug, 'unlisted-example');
  } finally {
    globalThis.fetch = originalFetch;
    if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    else delete globalThis.localStorage;
  }
});

test('incremental captures retain the complete baseline and reject malformed or duplicate data', () => {
  const newRow = {
    ...rows[2], id: 'https://example.com/new.pdf', url: 'https://example.com/new.pdf', publishedDate: '2026-09-05', observedAt: '2026-09-05T02:00:00.000Z',
  };
  const incremental = {
    ...capture,
    checkedAt: newRow.observedAt,
    publishedTotal: 4,
    pagesFetched: 1,
    fullHistory: false,
    rows: [newRow],
    upcomingPublishedTotal: 1,
    upcomingPagesFetched: 1,
    upcomingDuplicatesRemoved: 0,
    upcoming: [upcomingRows[1]],
  };
  const merged = mergeScreenerConcallCapture(incremental, capture, Date.parse(newRow.observedAt));
  assert.equal(merged.fullHistory, true);
  assert.equal(merged.rows.length, 4);
  assert.deepEqual(merged.upcoming.map((item) => item.name), ['Purple United'], 'withdrawn invitations do not survive from the previous mutable snapshot');
  const retainedDuplicate = mergeScreenerConcallCapture(
    { ...incremental, publishedTotal: 5 },
    { ...capture, publishedTotal: 4, duplicatesRemoved: 1 },
    Date.parse(newRow.observedAt),
  );
  assert.equal(retainedDuplicate.duplicatesRemoved, 1, 'incremental heads retain duplicate accounting from the complete tail');
  assert.equal(mergeScreenerConcallRows(rows, rows).length, rows.length);
  assert.throws(() => validateScreenerConcallCapture({ ...capture, rows: [...rows, rows[0]] }, Date.parse(observedAt)));
  assert.throws(() => validateScreenerConcallCapture({ ...capture, rows: rows.map((item, i) => (i ? item : { ...item, url: 'javascript:alert(1)' })) }, Date.parse(observedAt)));
  assert.throws(() => validateScreenerConcallCapture({ ...capture, rows: rows.map((item, i) => (i ? item : { ...item, companyUrl: 'http://www.screener.in/company/DHOOTTRANS/' })) }, Date.parse(observedAt)));
  assert.throws(() => validateScreenerConcallCapture({ ...capture, rows: rows.map((item, i) => (i ? item : { ...item, companyUrl: 'https://www.screener.in:3000/company/DHOOTTRANS/' })) }, Date.parse(observedAt)));
});

function artifactFetch({ digest = null, host = 'https://example.blob.core.windows.net/capture', event = 'schedule' } = {}) {
  const bytes = gzipSync(JSON.stringify(capture));
  const goodDigest = createHash('sha256').update(bytes).digest('hex');
  const run = { id: 10, head_branch: 'main', head_repository: { full_name: 'techmuns/Sattva-Central-Research' }, event, status: 'completed', conclusion: 'success' };
  return async (url, init = {}) => {
    if (!url.startsWith('https://api.github.com/')) {
      assert.equal(init.headers, undefined, 'GitHub credential is never forwarded to the signed artifact host');
      return new Response(bytes);
    }
    if (url.includes('/runs?')) return Response.json({ total_count: 1, workflow_runs: [run] });
    if (url.includes('/runs/10/artifacts')) return Response.json({ artifacts: [{ id: 20, name: SCREENER_CONCALL_ARTIFACT, expired: false, workflow_run: { id: 10 }, size_in_bytes: bytes.length, digest: `sha256:${digest || goodDigest}` }] });
    if (url.endsWith('/artifacts/20/zip')) return new Response(null, { status: 302, headers: { location: host } });
    throw Error(`Unexpected test URL ${url}`);
  };
}

test('Worker accepts only trusted, digest-verified Actions artifacts', async () => {
  let requests=0;
  const fetcher=artifactFetch();
  const out = await readScreenerConcallCollector({ token: 'test-token', now: () => Date.parse(observedAt), fetcher: (...args)=>{requests++;return fetcher(...args);} });
  assert.equal(requests,5,'the calendar-only reader stays within the identity budget reserved by its route');
  assert.equal(out.capture.rows.length, 3);
  assert.equal(out.source.portfolioUpcomingAvailable, true);
  assert.equal(out.source.portfolioUpcomingRecords, 4);
  assert.equal(out.source.upcomingRecords, 2);
  assert.equal(out.source.upcomingDuplicatesRemoved, 0);
  for (const options of [{ digest: '0'.repeat(64) }, { host: 'https://evil.test/capture' }, { event: 'pull_request' }]) {
    await assert.rejects(readScreenerConcallCollector({ token: 'test-token', now: () => Date.parse(observedAt), fetcher: artifactFetch(options) }));
  }
});

function checkpointFetch({ outcome = 'calendar-shape', missingLatest = false, corrupt = false, expired = false,
  document = true, latestConclusion = 'failure' } = {}) {
  const { portfolioUpcoming, upcoming, upcomingPublishedTotal, upcomingPagesFetched, upcomingDuplicatesRemoved, ...history } = capture;
  const value = document ? { ...history, documentCheckpoint: {version:1,outcome} } : capture;
  const bytes = gzipSync(JSON.stringify(value));
  const artifact = id => ({id:20, name:document ? SCREENER_DOCUMENT_ARTIFACT : SCREENER_CONCALL_ARTIFACT,
    expired,workflow_run:{id},size_in_bytes:bytes.length,digest:`sha256:${corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}`});
  const run = id => ({ id, head_branch:'main', head_repository:{full_name:'techmuns/Sattva-Central-Research'}, event:'schedule',
    status:'completed', conclusion:id===11 ? latestConclusion : 'success' });
  return async (url, init = {}) => {
    if (!url.startsWith('https://api.github.com/')) { assert.equal(init.headers, undefined); return new Response(bytes); }
    if (url.includes('/runs?')) return Response.json({total_count:2,workflow_runs:url.includes('status=success') ? [run(10)] : [run(11),run(10)]});
    if (url.includes('/actions/artifacts?')) return Response.json({artifacts:document ? [artifact(missingLatest?10:11)] : []});
    if (/\/runs\/\d+\/artifacts/.test(url)) {
      const id = Number(/\/runs\/(\d+)/.exec(url)[1]);
      return Response.json({artifacts: missingLatest && id===11 ? [] : [artifact(id)]});
    }
    if (url.endsWith('/artifacts/20/zip')) return new Response(null,{status:302,headers:{location:'https://example.blob.core.windows.net/checkpoint'}});
    throw Error('Unexpected checkpoint fixture request');
  };
}

test('only a validated, settled document checkpoint can isolate a calendar failure', async () => {
  const read = options => readScreenerConcallCollector({token:'fixture',documentsOnly:true,now:()=>Date.parse(observedAt),fetcher:checkpointFetch(options)});
  const partial = await read();
  assert.equal(partial.capture.rows.length,3);
  assert.equal(partial.source.collectorLatestFailed,false);
  assert.equal(partial.source.collectorLatestConclusion,'failure');
  assert.equal(partial.source.calendarFailure,true);
  assert.equal(partial.source.portfolioUpcomingAvailable,false,'document checkpoint cannot certify calendar coverage');
  for (const outcome of ['pending','blocked']) assert.equal((await read({outcome})).source.collectorLatestFailed,true);
  assert.equal((await read({missingLatest:true})).source.collectorLatestFailed,true,'an older checkpoint cannot hide a newer failed document read');
  assert.equal((await read({document:false})).source.collectorLatestFailed,true,'legacy green artifacts retain their latest-failure gate');
  for (const options of [{corrupt:true},{expired:true},{outcome:'invented'}]) await assert.rejects(read(options));
  const legacy = await read({document:false,latestConclusion:'success'});
  assert.equal(legacy.source.collectorLatestFailed,false,'rolling deployment can still use a successful legacy capture');
});

test('checkpoint publication is atomic, excludes calendars and cannot bless incomplete history', () => {
  const dir = mkdtempSync(join(tmpdir(),'sattva-document-checkpoint-')), path=join(dir,'documents.gz');
  try {
    writeDocumentCheckpoint(path,capture);
    const first = readFileSync(path);
    assert.equal(JSON.parse(gunzipSync(first)).documentCheckpoint.outcome,'pending');
    assert.throws(()=>writeDocumentCheckpoint(path,{...capture,fullHistory:false},'complete'));
    assert.deepEqual(readFileSync(path),first,'failed validation leaves the previous complete bytes');
    const value = writeDocumentCheckpoint(path,capture,'complete');
    assert.equal(value.portfolioUpcoming,undefined);
    assert.equal(value.upcoming,undefined);
    assert.equal(value.rows.length,3);
    assert.equal(existsSync(`${path}.tmp`),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('new documents reach the dashboard while retained calendars keep their original health and date', async () => {
  const { portfolioUpcoming, upcoming, upcomingPublishedTotal, upcomingPagesFetched, upcomingDuplicatesRemoved, ...history } = capture;
  const later='2026-09-05T02:00:00.000Z';
  const full={capture,source:{checkedAt:observedAt,status:'ok',collectorLatestFailed:true,portfolioUpcomingAvailable:true}};
  const checkpoint={capture:{...history,checkedAt:later,rows:[...rows,{...rows[0],id:'https://example.com/new.pdf',url:'https://example.com/new.pdf'}],publishedTotal:4},
    source:{checkedAt:later,collectorLatestFailed:false,collectorRunId:22}};
  const result=await readScreenerConcallCollection({},async options=>options.documentsOnly?checkpoint:full);
  assert.equal(result.capture.rows.length,4);
  assert.deepEqual(result.capture.portfolioUpcoming,portfolioUpcoming);
  assert.deepEqual(result.capture.upcoming,upcoming);
  assert.equal(result.source.checkedAt,observedAt,'a new document check cannot make an old calendar fresh');
  assert.equal(result.source.collectorLatestFailed,true);
  assert.equal(result.source.documentCheckedAt,later);
  assert.equal(result.source.documentLatestFailed,false);
  const withoutCalendar=await readScreenerConcallCollection({},async options=>{if(options.documentsOnly)return checkpoint;throw Error('calendar unavailable');});
  assert.equal(withoutCalendar.capture.rows.length,4);
  assert.equal(withoutCalendar.capture.portfolioUpcoming,undefined);
  assert.equal(withoutCalendar.source.checkedAt,null);
  assert.equal(withoutCalendar.source.status,'failed');
  const documentsDown=await readScreenerConcallCollection({},async options=>{if(!options.documentsOnly)return full;throw Error('document unavailable');});
  assert.deepEqual(documentsDown,full,'a checkpoint outage preserves the previously complete capture');
});

test('real collector preserves documents on independent calendar failures, with no source traffic in tests', () => {
  const dir = mkdtempSync(join(tmpdir(),'sattva-calendar-recovery-'));
  try {
    // Fake only the browser transport. The production CLI, parser, reconciliation and artifact
    // writer run unchanged; an unexpected navigation fails instead of reaching the network.
    const documentHtml = html.replace('<a href="?p=2">2</a>','');
    const marketHtml = marketUpcomingHtml.replace('<a href="?p=2">2</a>','');
    const changedPortfolio = portfolioUpcomingHtml.replace('class="badge sub"','class="new-event-label"');
    const changedMarket = marketHtml.replace('5 September 2026','Unrecognised source date');
    writeFileSync(join(dir,'index.mjs'), `
      const mode=process.env.CALENDAR_FIXTURE_MODE;
      const healthy=['good','transient-market','transient-portfolio','empty-market'].includes(mode), visits={market:0,portfolio:0};
      let url='https://www.screener.in/concalls/';
      const locator={count:async()=>1,waitFor:async()=>{},fill:async()=>{},click:async()=>{},
        innerText:async()=>mode==='refusal'?'Daily summary quota reached. Try again tomorrow.':'Authenticated calendar',
        locator:()=>locator};
      const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},locator:()=>locator,getByText:()=>locator,
        waitForTimeout:async()=>{},waitForURL:async()=>{url='https://www.screener.in/concalls/';},url:()=>url,
        goto:async target=>{if(!target.startsWith('https://www.screener.in/'))throw Error('Unexpected fixture origin');url=target;
          const feed=url.includes('/upcoming/')?'market':url.includes('/dash/')?'portfolio':null;
          if(feed)visits[feed]++;
          const status=feed && mode==='http-refusal'?429:feed && mode==='transient-'+feed && visits[feed]<3?503:200;
          return {ok:()=>status===200,status:()=>status,headers:()=>({})};},
        content:async()=>url.includes('/dash/') ? (healthy?${JSON.stringify(portfolioUpcomingHtml)}:mode==='interstitial-portfolio'?'<h2>Upcoming</h2><div>Temporarily busy</div>':mode==='partial-portfolio'?'<h2>Upcoming</h2><ul><li><strong>Today</strong></li>':${JSON.stringify(changedPortfolio)})
          :url.includes('/upcoming/') ? (mode==='market'?${JSON.stringify(changedMarket)}:mode==='interstitial-market'?'Temporarily busy':mode==='empty-market'?'<table id="result_list"><tbody></tbody></table><div>0 concall invites</div>':${JSON.stringify(marketHtml)})
          :mode==='documents'?'Changed document table':${JSON.stringify(documentHtml)}};
      export const chromium={launch:async()=>({close:async()=>{console.log('FIXTURE_VISITS:'+JSON.stringify(visits));},newContext:async()=>({newPage:async()=>page,
        cookies:async()=>[{name:'sessionid',value:'fixture'}]})})};
    `);
    for (const mode of ['portfolio','market','refusal','http-refusal','documents','interstitial-market','interstitial-portfolio','partial-portfolio','transient-market','transient-portfolio','empty-market','good']) {
      const path=join(dir,`${mode}.gz`);
      const healthy=['good','transient-market','transient-portfolio','empty-market'].includes(mode);
      const run=spawnSync(process.execPath,['scripts/collect-screener-concalls.mjs',path],{cwd:new URL('..',import.meta.url),encoding:'utf8',
        env:{...process.env,GITHUB_ACTIONS:'false',SCREENER_USERNAME:'fixture',SCREENER_PASSWORD:'fixture',PLAYWRIGHT_ROOT:dir,CALENDAR_FIXTURE_MODE:mode},timeout:10000});
      assert.equal(run.status,healthy?0:1,run.stderr);
      if(mode==='documents') {assert.equal(existsSync(`${path}.documents.gz`),false);continue;}
      const checkpoint=JSON.parse(gunzipSync(readFileSync(`${path}.documents.gz`)));
      validateScreenerConcallCapture(checkpoint);
      assert.equal(checkpoint.rows.length,3);
      assert.equal(checkpoint.documentCheckpoint.outcome,healthy?'complete':['portfolio','market'].includes(mode)?'calendar-shape':'blocked',mode);
      assert.equal(existsSync(path),healthy,'failed calendars never publish a misleading full capture');
      if(mode==='portfolio') assert.match(run.stderr,/Portfolio calendar diagnostic: label/);
      const visits=JSON.parse(/FIXTURE_VISITS:(.*)/.exec(run.stdout)[1]);
      if(mode.startsWith('transient-')) assert.equal(visits[mode.slice(10)],3,'temporary 5xx responses receive their bounded retries');
      if(['refusal','http-refusal','market','interstitial-market'].includes(mode)) assert.equal(visits.market,1,'refusals and unchanged bad pages are not retried');
      if(mode==='empty-market') assert.deepEqual(JSON.parse(gunzipSync(readFileSync(path))).upcoming,[]);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('workflow is incremental every 15 minutes and audits the full history daily', () => {
  const workflow = readFileSync(new URL('../.github/workflows/screener-concalls-refresh.yml', import.meta.url), 'utf8');
  const collector = readFileSync(new URL('./collect-screener-concalls.mjs', import.meta.url), 'utf8');
  const calendarClient = readFileSync(new URL('../public/js/data/earnings-calendar.js', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(workflow, /cron: '7 1 \* \* \*'/);
  assert.match(workflow, /SCREENER_FULL_REFRESH/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /archive:\s*false/, 'the Worker consumes the direct gzip, not a zip wrapper');
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/,'the independent checkpoint uploads after a calendar failure');
  assert.match(workflow, /name: screener-concall-documents-v1\.json\.gz/);
  assert.doesNotMatch(workflow, /git push|contents:\s*write/);
  assert.match(collector, /page\.goto\(`\$\{SCREENER_CONCALL_URL\}\?p=\$\{number\}`/);
  assert.match(collector, /number === 1 \? SCREENER_MARKET_UPCOMING_URL : `\$\{SCREENER_MARKET_UPCOMING_URL\}\?p=\$\{number\}`/);
  assert.match(collector, /await page\.waitForTimeout\(full \? 5000 : 750\)/);
  assert.match(collector, /upcomingCollected\.length !== upcomingFirst\.publishedTotal/);
  assert.match(collector, /const readPortfolioUpcoming = async/);
  assert.match(collector, /failureFeed = 'portfolio'/);
  assert.match(collector, /watchlistLink\.count\(\)\) < 1/, 'responsive duplicate links are layout, while the fixed watchlist must still be present');
  assert.match(calendarClient, /const POLL_MS = 60_000/);
  assert.match(calendarClient, /live\.register\(LIVE_ID/);
  assert.match(calendarClient, /const request = current\(\)/, 'the open-tab poll follows the date the reader selected');
  assert.doesNotMatch(collector, /context\.request|get\([^)]*user-agent/i, 'history pages retain the authenticated browser fingerprint');
  assert.match(collector, /\['navigation', 'response', 'session', 'oversized', 'shape', 'pagination'\]/);
  assert.doesNotMatch(collector, /console\.error\([^\n]*(error|message|html|cookie)/i, 'failure logs contain only fixed stage, page and category fields');
});
