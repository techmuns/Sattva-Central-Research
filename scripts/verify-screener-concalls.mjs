import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseScreenerConcallPage, addResolvedTickers } from './lib/screener-concalls.mjs';
import { parseScreenerUpcomingPage, upcomingDay, upcomingTime } from './lib/screener-upcoming.mjs';
import {
  enrichConcallScans,
  groupScreenerConcalls,
  mergeScreenerConcallCapture,
  mergeScreenerConcallRows,
  SCREENER_CONCALL_ARTIFACT,
  SCREENER_CONCALL_ID,
  validateScreenerConcallCapture,
} from '../public/js/data/screener-concalls-shared.js';
import { filterByScope } from '../public/js/data/scope.js';
import { readScreenerConcallCollector } from '../worker/screener-concalls-collector.mjs';

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
const upcomingHtml = `<!doctype html><aside class="sidebar-panel"><h2>Upcoming</h2><div>S Screen</div>
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
const portfolioUpcoming = parseScreenerUpcomingPage(upcomingHtml, observedAt);
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
  };
  const merged = mergeScreenerConcallCapture(incremental, capture, Date.parse(newRow.observedAt));
  assert.equal(merged.fullHistory, true);
  assert.equal(merged.rows.length, 4);
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
  const out = await readScreenerConcallCollector({ token: 'test-token', now: () => Date.parse(observedAt), fetcher: artifactFetch() });
  assert.equal(out.capture.rows.length, 3);
  assert.equal(out.source.portfolioUpcomingAvailable, true);
  assert.equal(out.source.portfolioUpcomingRecords, 4);
  for (const options of [{ digest: '0'.repeat(64) }, { host: 'https://evil.test/capture' }, { event: 'pull_request' }]) {
    await assert.rejects(readScreenerConcallCollector({ token: 'test-token', now: () => Date.parse(observedAt), fetcher: artifactFetch(options) }));
  }
});

test('workflow is incremental every 15 minutes and audits the full history daily', () => {
  const workflow = readFileSync(new URL('../.github/workflows/screener-concalls-refresh.yml', import.meta.url), 'utf8');
  const collector = readFileSync(new URL('./collect-screener-concalls.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(workflow, /cron: '7 1 \* \* \*'/);
  assert.match(workflow, /SCREENER_FULL_REFRESH/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /archive:\s*false/, 'the Worker consumes the direct gzip, not a zip wrapper');
  assert.doesNotMatch(workflow, /git push|contents:\s*write/);
  assert.match(collector, /page\.goto\(`\$\{SCREENER_CONCALL_URL\}\?p=\$\{number\}`/);
  assert.doesNotMatch(collector, /context\.request|get\([^)]*user-agent/i, 'history pages retain the authenticated browser fingerprint');
  assert.match(collector, /\['navigation', 'response', 'session', 'oversized', 'shape', 'pagination'\]/);
  assert.doesNotMatch(collector, /console\.error\([^\n]*(error|message|html|cookie)/i, 'failure logs contain only fixed stage, page and category fields');
});
