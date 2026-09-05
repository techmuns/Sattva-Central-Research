#!/usr/bin/env node
// Focused, dependency-free checks for the Moneycontrol Earnings Calendar integration.

import assert from 'node:assert/strict';
import {
  CalendarPageBlocked,
  CALENDAR_MAX_PAGES,
  fetchCalendarDay,
  fetchCalendarStrip,
  parseCalendarHtml,
} from '../worker/mc.mjs';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`PASS  ${label}`);
};

const company = (i, { name = `Company ${i}`, exchange = 'N' } = {}) => ({
  scID: `SC${i}`,
  name,
  exchange,
});

const rowHtml = ({ scID, name }, date = '2 Sep') => `
  <tr>
    <td>${date}</td>
    <td class="eventName"><a class="evt_alink" href="https://www.moneycontrol.com/india/stockpricequote/test/${scID}">${name}</a></td>
    <td>Q1</td>
    <td id="${scID}-ltp">1,234.50</td>
    <td id="${scID}-changeP">1.25%</td>
    <td>Time Not Available</td>
    <td style="display:none">9,876.54</td>
  </tr>`;

const widgetHtml = (companies) => `
  <input id="scIds-widget" value="${JSON.stringify(companies).replaceAll('"', '&#34;')}">
  <table>${companies.map((item) => rowHtml(item)).join('')}</table>
  <script>Last Updated on 02/09/2026</script>`;

const paginationHtml = (companies) => `
  <table>
    <tr display="hidden" dataScId="${JSON.stringify(companies).replaceAll('"', '&#34;')}" id="paginate-scids"></tr>
    ${companies.map((item) => rowHtml(item)).join('')}
  </table>`;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const sample = widgetHtml([
  company(1, { name: 'Technocraft Ventures', exchange: 'N' }),
  company(2, { name: 'Vivanta Industries Limited', exchange: 'B' }),
]);
const parsed = parseCalendarHtml(sample, '2026-09-02');

ok('the widget parser keeps every named row', () => {
  assert.deepEqual(parsed.map((row) => row.name), ['Technocraft Ventures', 'Vivanta Industries Limited']);
});

ok('the parser preserves NSE and BSE identities from the widget metadata', () => {
  assert.deepEqual(parsed.map((row) => row.exchange), ['N', 'B']);
});

ok('missing scheduled time is null while published numbers remain numeric', () => {
  assert.equal(parsed[0].time, null);
  assert.equal(parsed[0].ltp, 1234.5);
  assert.equal(parsed[0].changePct, 1.25);
  assert.equal(parsed[0].marketCap, 9876.54);
});

ok('the page bound reserves room for the complete Screener artifact read', () => {
  assert.equal(CALENDAR_MAX_PAGES, 40);
});

const allCompanies = Array.from({ length: 21 }, (_, i) => company(i + 1));
const requested = [];
const day = await fetchCalendarDay({ date: '2026-09-02', expectedCount: 21 }, async (url) => {
  requested.push(String(url));
  return new Response(url.includes('earnings-widget') ? widgetHtml(allCompanies.slice(0, 20)) : paginationHtml(allCompanies.slice(20)), { status: 200 });
});

ok('the day reader follows the publisher pagination past the first twenty rows', () => {
  assert.equal(day.rows.length, 21);
  assert.equal(day.pagesFetched, 2);
  assert.equal(day.complete, true);
  assert.equal(requested.length, 2);
  assert.match(requested[1], /earnings-pagination/);
  assert.match(requested[1], /page=2/);
});

let paginationAttempts = 0;
const retried = await fetchCalendarDay({ date: '2026-09-02', expectedCount: 21 }, async (url) => {
  if (String(url).includes('earnings-widget')) return new Response(widgetHtml(allCompanies.slice(0, 20)), { status: 200 });
  paginationAttempts++;
  return paginationAttempts === 1
    ? new Response('temporary upstream failure', { status: 500 })
    : new Response(paginationHtml(allCompanies.slice(20)), { status: 200 });
});

ok('a transient pagination 5xx is retried and counted against the request budget', () => {
  assert.equal(retried.rows.length, 21);
  assert.equal(retried.pagesFetched, 2);
  assert.equal(retried.requestsMade, 3);
});

let stripUrl = '';
const strip = await fetchCalendarStrip({ fromDate: '2026-09-02', toDate: '2026-09-02' }, async (url) => {
  stripUrl = String(url);
  return jsonResponse({
    success: 1,
    data: {
      header: [{ name: 'date' }, { name: 'displayDate' }, { name: 'earningCount' }],
      list: [['2026-09-02', '02 Sep', '2']],
    },
  });
});

ok('the count request defaults to All exchanges and normalises string counts', () => {
  assert.match(stripUrl, /indexId=All/);
  assert.equal(strip[0].count, 2);
});

await assert.rejects(
  () => fetchCalendarDay({ date: '2026-09-02', expectedCount: 1 }, async () => new Response('<html>blocked</html>', { status: 200 })),
  CalendarPageBlocked
);
checks += 1;
console.log('PASS  a bot-wall response cannot masquerade as an empty calendar');

console.log(`\n${checks} calendar checks passed.`);
