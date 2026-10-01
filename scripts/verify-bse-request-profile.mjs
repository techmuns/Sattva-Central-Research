#!/usr/bin/env node
// Offline checks for the shared BSE request profile and the diagnosis that names a new refusal.
// No network: BSE is simulated with the rules measured on 1 October 2026.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEADERS, bseRequestHeaders, chromeBrands, chromeMajor } from '../worker/bse-ann.mjs';
import { exchangeRequestHeaders } from './lib/exchange-deals.mjs';
import { fetchPublic } from './capture-shareholdings.mjs';
import { PREVIOUS_PROFILE, diagnoseBseProfile, profileVariants } from './check-bse-request-profile.mjs';

const DAY = 86_400_000;

// 1. The browser version is derived from the date, one release behind Chrome's four-week schedule,
//    so a version typed on one day cannot become the "old browser" BSE refuses on a later one.
assert.equal(chromeMajor(Date.UTC(2025, 8, 30)), 140, 'Chrome 141 shipped on 30 September 2025');
assert.equal(chromeMajor(Date.UTC(2026, 9, 1)), 153, 'Chrome 154 shipped on 29 September 2026');
assert.equal(chromeMajor(Date.UTC(2026, 9, 27)), 154, 'one release four weeks later');
assert.equal(chromeMajor(Date.UTC(2020, 0, 1)), 140, 'a clock before the anchor never names an older browser');
let previous = chromeMajor(Date.UTC(2025, 8, 30));
for (let at = Date.UTC(2025, 8, 30); at < Date.UTC(2030, 0, 1); at += DAY) {
  const major = chromeMajor(at);
  assert.ok(major === previous || major === previous + 1, `the version only ever steps forward by one (${new Date(at).toISOString()})`);
  previous = major;
}
assert.ok(previous >= 190, 'still advancing years from now');

// 2. Client hints are the exact strings those Chrome releases send (Chromium's GREASE algorithm).
const SENT_BY_CHROME = {
  116: '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
  120: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  122: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  124: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  131: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  138: '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  140: '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
};
for (const [major, sent] of Object.entries(SENT_BY_CHROME)) assert.equal(chromeBrands(Number(major)), sent, `Chrome ${major}`);

// 3. The profile is what a current Chrome sends from BSE's own page.
const at = Date.UTC(2026, 9, 1, 6);
const profile = bseRequestHeaders(at);
assert.equal(profile.referer, 'https://www.bseindia.com/', 'a browser on any BSE page sends only the origin to the API host');
assert.doesNotMatch(JSON.stringify(profile), /ann\.html/, 'never the retired announcements page BSE refuses');
assert.equal(profile.origin, 'https://www.bseindia.com');
assert.equal(profile['sec-fetch-site'], 'same-site');
assert.equal(profile['sec-fetch-mode'], 'cors');
assert.match(profile['accept-language'], /^en/);
assert.match(profile['user-agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .* Chrome\/153\.0\.0\.0 Safari\/537\.36$/);
assert.equal(profile['sec-ch-ua'], chromeBrands(153), 'client hints agree with the user agent');
assert.equal(profile['sec-ch-ua-platform'], '"Windows"', 'and with its platform');
assert.deepEqual(Object.keys(HEADERS).sort(), Object.keys(profile).sort(), 'one profile, at import and on demand');

// 4. Every BSE reader shares it — deals, shareholdings and documents included. NSE keeps its own.
const nse = { 'user-agent': 'Mozilla/5.0', accept: '*/*', referer: 'https://www.nseindia.com/' };
assert.deepEqual(exchangeRequestHeaders('https://api.bseindia.com/BseIndiaAPI/api/BulkDealData_ng/w?DealType=1', at), profile);
assert.deepEqual(exchangeRequestHeaders('https://api.bseindia.com/BseIndiaAPI/api/Corp_Shareholding_ng/w?flag=6', at), profile);
assert.deepEqual(exchangeRequestHeaders('https://www.bseindia.com/XBRLFILES/SHPXBRLDataXML/1_SP.html', at), profile);
assert.deepEqual(exchangeRequestHeaders('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', at), nse);
assert.deepEqual(exchangeRequestHeaders('https://evilbseindia.com/x', at), nse, 'a look-alike host is not BSE');

const realFetch = globalThis.fetch;
try {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push([url, init.headers]); return new Response('{"Table":[]}'); };
  await fetchPublic('https://api.bseindia.com/BseIndiaAPI/api/Corp_Shareholding_ng/w?scripcode=&flag=6&indtype=ALL');
  await fetchPublic('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv');
  assert.equal(sent[0][1].referer, 'https://www.bseindia.com/');
  assert.ok(sent[0][1]['sec-ch-ua'], 'the shareholding reader sends the browser profile to BSE');
  assert.deepEqual(sent[1][1], nse, 'and the plain set to NSE');
} finally {
  globalThis.fetch = realFetch;
}
const dealsSource = readFileSync(new URL('./capture-exchange-deals.mjs', import.meta.url), 'utf8');
assert.match(dealsSource, /headers: exchangeRequestHeaders\(url\)/, 'the deals reader uses the shared profile');
assert.doesNotMatch(dealsSource + readFileSync(new URL('./capture-shareholdings.mjs', import.meta.url), 'utf8'),
  /'user-agent': 'Mozilla\/5\.0'/, 'no BSE reader keeps a private header set');

// 5. The diagnosis tries every header and group alone and names the ones a refusal turns on.
const variants = Object.fromEntries(profileVariants(profile));
assert.deepEqual(variants.current, profile);
for (const name of Object.keys(profile)) assert.equal(variants[`without ${name}`][name], undefined, name);
for (const name of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) assert.equal(variants['without client hints'][name], undefined);
for (const name of ['sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site']) assert.equal(variants['without fetch metadata'][name], undefined);
assert.equal(variants['retired Referer /corporates/ann.html'].referer, 'https://www.bseindia.com/corporates/ann.html');
assert.match(variants['Chrome 140']['user-agent'], /Chrome\/140\.0\.0\.0/);
assert.equal(variants['Chrome 140']['sec-ch-ua'], chromeBrands(140), 'an older browser keeps consistent hints');

// BSE as measured from a weaker client: a hard rule on the retired page, a redirect without a
// Referer, and a refusal when no client hint is present at all.
const measuredBse = async (url, init) => {
  assert.equal(init.redirect, 'manual', 'a redirect is reported, never followed to a page that reads as success');
  const h = init.headers;
  if (!h.referer) return new Response('', { status: 301, headers: { location: 'https://www.bseindia.com/' } });
  if (h.referer.endsWith('/corporates/ann.html')) return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { status: 403 });
  if (!h['sec-ch-ua'] && !h['sec-ch-ua-mobile'] && !h['sec-ch-ua-platform']) return new Response('Access Denied', { status: 403 });
  return Response.json({ Table: [], Table1: [{ ROWCNT: 0 }] });
};
const diagnosis = await diagnoseBseProfile({ headers: profile, fetchImpl: measuredBse, gapMs: 0, now: at });
assert.equal(diagnosis.accepted, true);
assert.deepEqual(diagnosis.required, ['referer', 'client hints']);
assert.equal(diagnosis.results['without referer'], 'HTTP 301');
assert.equal(diagnosis.results['retired Referer /corporates/ann.html'], 'HTTP 403');
assert.equal(diagnosis.results['without sec-ch-ua'], 'accepted', 'one missing hint alone is not the cause');
assert.match(diagnosis.url, /AnnSubCategoryGetData\/w\?.*strPrevDate=20260930.*strToDate=20260930/, 'yesterday in India');

const challenge = await diagnoseBseProfile({ headers: profile, gapMs: 0, now: at,
  fetchImpl: async () => new Response('<html>Checking your browser…</html>', { status: 200 }) });
assert.equal(challenge.accepted, false, 'a 200 challenge page is not access');
assert.equal(challenge.required, null, 'when everything is refused no single header explains it');
assert.equal(challenge.results.current, 'HTTP 200 that is not JSON');

const unreachable = await diagnoseBseProfile({ headers: profile, gapMs: 0, now: at,
  fetchImpl: async () => { throw new TypeError('fetch failed'); } });
assert.equal(unreachable.accepted, false);
assert.match(unreachable.results.current, /^unreadable: fetch failed/);

// 6. The previous profile is the one BSE refused on 29 September 2026.
assert.equal(PREVIOUS_PROFILE.referer, 'https://www.bseindia.com/corporates/ann.html');
assert.equal(PREVIOUS_PROFILE['sec-ch-ua'], undefined);

console.log('BSE request profile: date-derived Chrome version, exact client hints, shared by every BSE reader, diagnosis verified.');
