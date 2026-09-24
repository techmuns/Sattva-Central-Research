#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INDIA_INSTRUMENTS, GLOBAL_INSTRUMENTS, BSE_SENSEX_URL, quoteFromBse, readBseSensex, reconcileGlobalIndex, quoteFromNse, readNseIndices, reconcileIndianIndex, quoteFromChart, quoteFromUpstox, readUpstoxIndices, reconcileIndex } from '../worker/newsletter-markets.mjs';
import { MARKET_ROWS, readMarkets, asOfLabel, formatPct, formatChange, buildBrief, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { DEFAULT_SETTINGS } from '../public/js/data/newsletter-shared.js';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';

const at = Date.parse('2026-09-23T16:00:00+05:30');
const time = (day, clock = '15:30') => Date.parse(`${day}T${clock}:00+05:30`);
const nifty = MARKET_ROWS.find(r => r.id === 'nifty');
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url)));
const chart = (row = nifty, last = 23446.8, prev = 23329) => ({ chart: { result: [{
  meta: { symbol: row.symbol, regularMarketPrice: last, regularMarketTime: time('2026-09-23') / 1000,
    chartPreviousClose: 23270.6, dataGranularity: '1d', range: '5d', exchangeTimezoneName: 'Asia/Kolkata',
    currentTradingPeriod: { regular: { start: time('2026-09-23', '09:15') / 1000, end: time('2026-09-23') / 1000 } } },
  timestamp: ['2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23'].map(day => time(day, '09:15') / 1000),
  indicators: { quote: [{ close: [23000, 23100, 23200, prev, last] }] },
}] } });
const primary = (row = nifty, last = 23446.8, prev = 23329) => ({
  instrument_token: INDIA_INSTRUMENTS[row.id][0], symbol: INDIA_INSTRUMENTS[row.id][1],
  last_price: last, net_change: last - prev, prev_close_price: prev, ohlc: { close: last }, last_trade_time: String(time('2026-09-23')),
});
const sensex = MARKET_ROWS.find(r => r.id === 'sensex');
const bseBody = fixture('bse-sensex-2026-09-24.json');
const bseNow = time('2026-09-24', '09:39');
const alterBse = fn => {
  const [head, points] = bseBody.split('#@#').map(p => JSON.parse(p.replace(/\\"/g, '"')));
  fn(head[0], points);
  return `${JSON.stringify(head)}#@#${JSON.stringify(points)}`;
};
const globalQuote = (id = 'sp500', at = '2026-09-23T16:36:00-04:00') => ({
  instrument_token: GLOBAL_INSTRUMENTS[id][0], symbol: GLOBAL_INSTRUMENTS[id][1],
  last_price: 7706.03, prev_close_price: 7764.64, net_change: -58.61, last_trade_time: String(Date.parse(at)),
});

test('captured BSE chart dates the cash point, ignores the wrong header clock and validates its previous close', async () => {
  const q = quoteFromBse(bseBody, sensex, bseNow);
  assert.equal(q.last, 74267.72); assert.equal(q.prev, 74828.25); assert.equal(q.state, 'live');
  assert.equal(q.asOf, Date.parse('2026-09-24T09:38:38+05:30'));
  assert.equal(formatPct(q), '−0.75%'); assert.equal(formatChange(q), '−560.53');
  assert.match(asOfLabel(q), /24 Sept? 2026 09:38.*BSE Indices/);
  assert.equal(quoteFromBse(bseBody, sensex, time('2026-09-24', '16:00')).state, 'delayed');
  assert.equal(quoteFromBse(bseBody, sensex, time('2026-09-25', '10:00')).state, 'stale');
  const read = await readBseSensex(sensex, { now: bseNow, fetcher: async (url, init) => {
    assert.equal(url, BSE_SENSEX_URL); assert.equal(init.headers.authorization, undefined);
    assert.equal(init.redirect, 'manual'); assert(init.signal);
    return Response.json(bseBody);
  } });
  assert.equal(read.rows.get('sensex').prev, 74828.25);
});

test('BSE refuses pre-open, missing/duplicate/future/mixed-day points and incoherent or wrong-index headers', async () => {
  for (const mutate of [
    (h, p) => { p.splice(15); },
    (h, p) => { p.push(p.at(-1)); },
    (h, p) => { p.reverse(); },
    (h, p) => { p.at(-1).date = 'Fri Sep 25 2026 09:38:38'; },
    (h, p) => { p.at(-1).date = 'Thu Sep 24 2026 09:45:38'; },
    (h, p) => { p.at(-1).value = null; },
    (h, p) => { p.at(-1).value = 'invalid'; },
    (h, p) => { delete p.at(-1).value; },
    h => { h.LatestVal = '1'; }, h => { h.PreClose = '0'; }, h => { h.Scrip = 'BSE SENSEX NEXT 30'; },
  ]) assert.throws(() => quoteFromBse(alterBse(mutate), sensex, bseNow));
  assert.throws(() => quoteFromBse(bseBody, nifty, bseNow));
  for (const [status, reason] of [[403, 'blocked'], [302, 'unavailable'], [429, 'rate-limited'], [503, 'unavailable']]) {
    assert.equal((await readBseSensex(sensex, { now: bseNow, fetcher: async () => new Response('', { status }) })).reason, reason);
  }
  assert.equal((await readBseSensex(sensex, { now: bseNow, fetcher: async () => Response.json('x'.repeat(270000)) })).rows.size, 0);
});

test('global Upstox uses exact cash-index identities, previous-close arithmetic and exchange-local dates', () => {
  const now = Date.parse('2026-09-24T08:00:00+05:30'), row = MARKET_ROWS.find(r => r.id === 'sp500');
  const q = quoteFromUpstox(globalQuote(), row, now);
  assert.equal(q.state, 'close'); assert.equal(q.sessionDate, '2026-09-23');
  assert.equal(q.timezone, 'America/New_York'); assert.equal(formatPct(q), '−0.75%');
  assert.equal(formatChange(q), '−58.61');
  for (const data of [{ ...globalQuote(), symbol: 'IXIX' }, { ...globalQuote(), instrument_token: 'GLOBAL_INDEX|DOW FUTURES' },
    { ...globalQuote(), last_trade_time: '0', timestamp: new Date(now).toISOString() }]) assert.throws(() => quoteFromUpstox(data, row, now));
  assert.throws(() => quoteFromUpstox(globalQuote(), { ...row, symbol: '^IXIC' }, now));
  assert.equal(quoteFromUpstox({ ...globalQuote(), net_change: 0 }, row, now).changePct, null);
  assert(!GLOBAL_INSTRUMENTS.nasdaq); assert(!GLOBAL_INSTRUMENTS.brent); assert(!GLOBAL_INSTRUMENTS.usdinr);
});

test('global source timestamps survive DST/weekends, missed opens and intraday/delayed observations', () => {
  const row = MARKET_ROWS.find(r => r.id === 'sp500');
  const q = (at, now) => quoteFromUpstox(globalQuote('sp500', at), row, Date.parse(now));
  assert.equal(q('2026-09-25T16:00:00-04:00', '2026-09-28T09:00:00-04:00').state, 'close');
  assert.equal(q('2026-09-25T16:00:00-04:00', '2026-09-28T09:31:00-04:00').state, 'stale');
  assert.equal(q('2026-09-23T13:00:00-04:00', '2026-09-23T17:00:00-04:00').state, 'delayed');
  assert.equal(q('2026-09-23T13:00:00-04:00', '2026-09-23T13:01:00-04:00').state, 'live');
  assert.equal(q('2026-12-01T16:00:00-05:00', '2026-12-02T09:00:00-05:00').state, 'close');
  const hk = quoteFromUpstox(globalQuote('hangseng', '2026-09-24T10:00:00+08:00'), MARKET_ROWS.find(r => r.id === 'hangseng'), Date.parse('2026-09-24T10:15:00+08:00'));
  assert.equal(hk.state, 'delayed'); assert.match(asOfLabel(hk), /15-minute feed delay/);
});

test('global fallback repairs missing changes without mixing prices and withholds unresolved disagreements', () => {
  const row = MARKET_ROWS.find(r => r.id === 'sp500');
  const upstox = quoteFromUpstox(globalQuote(), row, Date.parse('2026-09-24T08:00:00+05:30'));
  const yahoo = { ...upstox, origin: 'yahoo', prev: null, change: null, changePct: null, changeReason: 'previous-close-unverified' };
  assert.equal(reconcileGlobalIndex(yahoo, upstox).origin, 'upstox');
  assert.equal(reconcileGlobalIndex(yahoo, upstox).verification, 'single-source');
  assert.equal(reconcileGlobalIndex({ ...yahoo, prev: upstox.prev }, upstox).verification, 'cross-checked');
  assert.equal(reconcileGlobalIndex({ ...yahoo, prev: 100 }, upstox).changePct, null);
  assert.equal(reconcileGlobalIndex({ ...yahoo, last: 7700 }, upstox).last, null);
  assert.equal(reconcileGlobalIndex(yahoo, { ...upstox, state: 'stale' }).origin, 'yahoo');
  assert.equal(reconcileGlobalIndex(yahoo, { ...upstox, state: 'delayed' }).state, 'delayed');
});

test('unknown Indian special-session hours cannot certify an intraday observation as the next morning close', () => {
  const asOf = time('2026-11-08', '18:20'), now = time('2026-11-09', '08:00');
  assert.equal(quoteFromUpstox({ ...primary(), last_trade_time: String(asOf) }, nifty, now).state, 'delayed');
  const nse = fixture('nse-indices-2026-09-23.json').data.find(r => r.index === 'NIFTY 50');
  assert.equal(quoteFromNse(nse, '08-Nov-2026 18:20:00', nifty, now).state, 'delayed');
  const bse = JSON.stringify([{ Scrip: 'BSE SENSEX', PreClose: '74828.25', LatestVal: '75000' }]) +
    '#@#' + JSON.stringify([{ date: 'Sun Nov 08 2026 18:20:00', value: '75000' }]);
  assert.equal(quoteFromBse(bse, sensex, now).state, 'delayed');
  const body = chart(), r = body.chart.result[0];
  r.meta.regularMarketTime = asOf / 1000;
  r.meta.currentTradingPeriod.regular = { start: time('2026-11-09', '09:15') / 1000, end: time('2026-11-09', '15:30') / 1000 };
  assert.equal(quoteFromChart(body, nifty, now).state, 'delayed');
});

test('source expansion isolates global failures, recovers Sensex with BSE and keeps provenance in every output', async () => {
  let globalFail = false;
  const fetcher = async (url, init) => {
    if (url === BSE_SENSEX_URL) return Response.json(bseBody);
    if (String(url).startsWith('https://api.upstox.com/')) {
      assert.equal(init.headers.authorization, 'Bearer fixture');
      const keys = new URL(url).searchParams.get('instrument_key').split(',');
      if (keys[0].startsWith('GLOBAL')) {
        assert.deepEqual(keys, Object.keys(GLOBAL_INSTRUMENTS).map(id => GLOBAL_INSTRUMENTS[id][0]));
        if (globalFail) return new Response('', { status: 400 });
        return Response.json({ status: 'success', data: { sp500: globalQuote(), dow: globalQuote('dow') } });
      }
      assert.equal(keys.length, 8);
      return Response.json({ status: 'success', data: { nifty: { ...primary(), last_trade_time: String(bseNow) } } });
    }
    assert.equal(init.headers?.authorization, undefined);
    return new Response('', { status: 503 });
  };
  const env = { UPSTOX_ACCESS_TOKEN: 'fixture', ASSETS: { fetch: async request => {
    try { return new Response(readFileSync(new URL(`../public${new URL(request.url).pathname}`, import.meta.url))); }
    catch { return new Response('', { status: 404 }); }
  } } };
  const markets = await readMarkets({ env, fetcher, now: bseNow });
  assert.equal(markets.bse.checked, 1); assert.equal(markets.globalUpstox.checked, 2);
  assert.equal(markets.rows.find(r => r.id === 'sensex').origin, 'bse');
  assert.equal(markets.rows.find(r => r.id === 'sp500').origin, 'upstox');
  assert.notEqual(markets.rows.find(r => r.id === 'nasdaq').origin, 'upstox');
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-24', settings: DEFAULT_SETTINGS, env, fetcher, now: bseNow });
  for (const output of [renderBriefHtml(brief), renderBriefText(brief), Buffer.from(renderBriefPdf(brief)).toString('latin1')]) {
    assert.match(output, /BSE Indices/); assert.match(output, /Upstox/); assert.match(output, /single source/);
  }
  globalFail = true;
  const failed = await readMarkets({ env, fetcher, now: bseNow });
  assert.equal(failed.globalUpstox.reason, 'unavailable'); assert.equal(failed.upstox.checked, 1);
  assert.equal(failed.rows.find(r => r.id === 'sensex').origin, 'bse');
});

test('23 September customer report: correct levels AND NSE daily changes, never the five-day reference', () => {
  for (const [id, last, prev, pct, change] of [
    ['nifty', 23446.8, 23329, '+0.50%', '+117.80'],
    ['niftybank', 56548.9, 56215.55, '+0.59%', '+333.35'],
    ['nifty500', 22935.1, 22794.2, '+0.62%', '+140.90'],
  ]) {
    const row = MARKET_ROWS.find(r => r.id === id);
    for (const q of [quoteFromChart(chart(row, last, prev), row, at), quoteFromUpstox(primary(row, last, prev), row, at)]) {
      assert.equal(formatPct(q), pct); assert.equal(formatChange(q), change);
      assert.equal(q.prev, prev); assert.equal(q.sessionDate, '2026-09-23');
    }
  }
});

test('captured global response uses prior daily bar and changes yields in basis points', () => {
  const row = MARKET_ROWS.find(r => r.id === 'sp500');
  const q = quoteFromChart(fixture('yahoo-sp500.json'), row, at);
  assert.equal(formatPct(q), '−0.45%'); assert.equal(formatChange(q), '−33.92');
  const yieldRow = MARKET_ROWS.find(r => r.id === 'us10y');
  assert.equal(formatChange(quoteFromChart(fixture('yahoo-us10y.json'), yieldRow, at)), '+1.0 bp');
});

test('old global quotes cannot acquire a fresh close label from a new read', () => {
  const row = MARKET_ROWS.find(r => r.id === 'sp500');
  const body = fixture('yahoo-sp500.json');
  assert.equal(quoteFromChart(body, row, at).state, 'stale');
  assert.equal(quoteFromChart(body, row, Date.parse('2026-09-17T15:00:00Z')).state, 'stale', 'the next US session opened without a new print');
  assert.equal(quoteFromChart(body, row, Date.parse('2026-09-17T08:00:00Z')).state, 'close', 'an overnight close remains valid before the next open');
});

test('actual Yahoo missing-close response cannot turn a two-day or five-day change into a daily gain', () => {
  const q = quoteFromChart(fixture('yahoo-nifty-missing-close.json'), nifty, at);
  assert.equal(q.last, 23446.8); assert.equal(q.prev, null); assert.equal(q.changePct, null);
  assert.match(asOfLabel(q), /daily change unavailable/);
});

test('null prior bars, intraday arrays, out-of-order dates and conflicting explicit close withhold changes', () => {
  for (const mutate of [
    r => { r.indicators.quote[0].close[3] = null; },
    r => { r.meta.dataGranularity = '1m'; },
    r => { r.timestamp[2] = r.timestamp[3]; },
    r => { r.timestamp.reverse(); },
    r => { r.meta.previousClose = 100; },
    r => { r.indicators.quote[0].close.pop(); },
  ]) {
    const body = chart(); mutate(body.chart.result[0]);
    const q = quoteFromChart(body, nifty, at);
    assert.equal(q.changePct, null); assert.equal(q.change, null);
  }
});

test('null current candle and weekends do not shift the comparison to the wrong day', () => {
  const body = chart(); body.chart.result[0].indicators.quote[0].close[4] = null;
  assert.equal(quoteFromChart(body, nifty, at).prev, 23329);
  const r = body.chart.result[0];
  r.meta.regularMarketTime = time('2026-09-21') / 1000;
  r.timestamp = r.timestamp.slice(0, 3); r.indicators.quote[0].close = [23000, 23100, 23200];
  assert.equal(quoteFromChart(body, nifty, at).previousSession, '2026-09-18');
  assert.match(asOfLabel(quoteFromChart(body, nifty, at)), /Earlier quote.*21 Sept? 2026/);
});

test('wrong symbol, invalid zone, missing/future timestamps and non-finite prices are rejected', () => {
  for (const changes of [{ symbol: '^NSEBANK' }, { exchangeTimezoneName: 'America/New_York' }, { currency: 'USD' }, { exchangeTimezoneName: 'Mars' }, { regularMarketTime: null },
    { regularMarketTime: at / 1000 + 120 }, { regularMarketPrice: NaN }, { regularMarketPrice: 0 }]) {
    const body = chart(); Object.assign(body.chart.result[0].meta, changes);
    assert.throws(() => quoteFromChart(body, nifty, at));
  }
  for (const changes of [{ symbol: 'BANKNIFTY' }, { instrument_token: 'NSE_FO|123' }, { last_trade_time: '' },
    { last_trade_time: String(at + 120000) }, { last_trade_time: String(time('2026-09-23', '08:00')) }, { net_change: '117.8' }, { prev_close_price: null }]) {
    assert.throws(() => quoteFromUpstox({ ...primary(), ...changes }, nifty, at));
  }
});

test('intraday observations never become closing quotes after the market closes', () => {
  const body = chart(); body.chart.result[0].meta.regularMarketTime = time('2026-09-23', '11:00') / 1000;
  assert.equal(quoteFromChart(body, nifty, at).state, 'delayed');
  assert.equal(quoteFromUpstox({ ...primary(), last_trade_time: String(time('2026-09-23', '11:00')) }, nifty, at).state, 'delayed');
  assert.equal(quoteFromUpstox(primary(), nifty, time('2026-09-24', '08:00')).state, 'close');
  assert.equal(quoteFromUpstox(primary(), nifty, time('2026-09-24', '10:00')).state, 'stale');
});

test('Upstox cross-checks intact rows, withholds conflicting changes/levels, never mixes providers', () => {
  const yahoo = quoteFromChart(chart(), nifty, at), upstox = quoteFromUpstox(primary(), nifty, at);
  assert.equal(reconcileIndex(yahoo, upstox).verification, 'cross-checked');
  const conflict = reconcileIndex(yahoo, { ...upstox, prev: 23270.6 });
  assert.equal(conflict.last, upstox.last); assert.equal(conflict.changePct, null);
  assert.match(asOfLabel(conflict), /sources disagree/);
  const priceConflict = reconcileIndex(yahoo, { ...upstox, last: 23500 });
  assert.equal(priceConflict.last, null); assert.equal(priceConflict.state, 'unavailable');
  assert.equal(reconcileIndex(yahoo, { ...upstox, state: 'stale' }).origin, 'yahoo');
  assert.equal(reconcileIndex({ ...yahoo, state: 'unavailable', last: null }, upstox).origin, 'upstox');
  assert.equal(quoteFromUpstox({ ...primary(), net_change: 100 }, nifty, at).changePct, null);
});

test('one bounded Upstox request uses only the existing secret and isolates missing/duplicate/bad index rows', async () => {
  const rows = MARKET_ROWS.filter(r => r.group === 'india'); let calls = 0;
  const fetcher = async (url, init) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.upstox.com');
    assert.equal(new URL(url).pathname, '/v3/market-quote/quotes');
    assert.equal(init.headers.authorization, 'Bearer fixture-secret'); assert.equal(init.redirect, 'manual');
    assert.deepEqual(new URL(url).searchParams.get('instrument_key').split(','), rows.map(r => INDIA_INSTRUMENTS[r.id][0]));
    return Response.json({ status: 'success', data: Object.fromEntries(rows.slice(0, 7).map(r => [r.id, primary(r)])) });
  };
  const result = await readUpstoxIndices(rows, { token: 'fixture-secret', fetcher, now: at });
  assert.equal(calls, 1); assert.equal(result.rows.size, 7); assert.equal(result.reason, 'partial');
  assert.equal(result.failures.indiavix, 'missing-or-duplicate');
  const duplicate = await readUpstoxIndices([nifty], { token: 'fixture-secret', now: at,
    fetcher: async () => Response.json({ status: 'success', data: { a: primary(), b: primary() } }) });
  assert.equal(duplicate.rows.size, 0);
  assert.equal((await readUpstoxIndices(rows, { fetcher: () => assert.fail('no secret means no request'), now: at })).reason, 'not-configured');
  for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [503, 'unavailable'], [302, 'unavailable']]) {
    assert.equal((await readUpstoxIndices(rows, { token: 'fixture', now: at, fetcher: async () => new Response('', { status }) })).reason, reason);
  }
  assert.equal((await readUpstoxIndices(rows, { token: 'fixture', now: at, fetcher: async () => { throw { name: 'TimeoutError' }; } })).reason, 'timeout');
});

test('complete market reader and HTML/text/PDF preserve verified numbers, missing rows and source disagreements', async () => {
  let disagree = false, missing = false, tokenRejected = false;
  const fetcher = async (url, init) => {
    if (String(url).startsWith('https://api.upstox.com/')) {
      if (tokenRejected) return new Response('', { status: 401 });
      return Response.json({ status: 'success', data: Object.fromEntries(MARKET_ROWS.filter(r => r.group === 'india' && !(missing && r.id === 'nifty')).map(r => [r.id, primary(r, 23446.8, disagree && r.id === 'nifty' ? 23270.6 : 23329)])) });
    }
    assert.equal(init.headers?.authorization, undefined, 'no Upstox credential goes to another provider');
    if (String(url).includes('finance.yahoo.com')) {
      const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      return Response.json(chart(MARKET_ROWS.find(r => r.symbol === symbol)));
    }
    return new Response('', { status: 503 });
  };
  const env = { UPSTOX_ACCESS_TOKEN: 'fixture-secret', ASSETS: { fetch: async request => {
    try { return new Response(readFileSync(new URL(`../public${new URL(request.url).pathname}`, import.meta.url))); }
    catch { return new Response('', { status: 404 }); }
  } } };
  const markets = await readMarkets({ env, fetcher, now: at });
  assert.equal(markets.rows.length, MARKET_ROWS.length); assert.equal(markets.upstox.checked, 8);
  assert.equal(markets.rows.find(r => r.id === 'nifty').verification, 'cross-checked');
  // The brief also lists the book's own movers from committed data, and a real holding can move +0.76% on
  // any day (on 23 Sept two did). So the check is that the disagreement adds no +0.76%: same data, with and without it.
  const conflictPct = '+0.76%', occurrences = s => s.split(conflictPct).length - 1;
  const agreed = occurrences(renderBriefText(await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS, env, fetcher, now: at })));
  disagree = true;
  const conflicted = await readMarkets({ env, fetcher, now: at });
  assert.deepEqual(conflicted.conflicts, ['nifty']);
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS, env, fetcher, now: at });
  const html = renderBriefHtml(brief), text = renderBriefText(brief);
  assert.match(html, /daily change withheld: sources disagree/); assert.match(text, /daily change withheld: sources disagree/);
  assert(!html.includes("today&#39;s close")); assert.equal(occurrences(text), agreed, 'the withheld Nifty change never reaches the text brief');
  assert.match(Buffer.from(renderBriefPdf(brief)).toString('latin1'), /daily change withheld/);
  disagree = false; missing = true;
  const partial = await readMarkets({ env, fetcher, now: at });
  assert.equal(partial.rows.find(r => r.id === 'nifty').origin, 'yahoo');
  assert.equal(partial.rows.find(r => r.id === 'niftybank').origin, 'upstox');
  tokenRejected = true;
  const fallback = await readMarkets({ env, fetcher, now: at });
  assert.equal(fallback.upstox.reason, 'authentication'); assert.equal(fallback.rows.find(r => r.id === 'nifty').verification, 'single-source');
});


test('official NSE snapshot reproduces every published index change, including VIX rounding', async () => {
  const body = fixture('nse-indices-2026-09-23.json');
  const rows = MARKET_ROWS.filter(r => r.group === 'india');
  const result = await readNseIndices(rows, { now: at, fetcher: async (url, init) => {
    assert.equal(url, 'https://www.nseindia.com/api/allIndices');
    assert.equal(init.headers.authorization, undefined); assert.equal(init.redirect, 'manual');
    return Response.json(body);
  } });
  assert.equal(result.rows.size, 7); assert.equal(result.reason, null); assert(!result.rows.has('sensex'));
  const complete = await readMarkets({ env: { UPSTOX_ACCESS_TOKEN: 'fixture' }, now: at, fetcher: async url => {
    if (String(url).includes('nseindia.com/api/allIndices')) return Response.json(body);
    if (String(url).includes('api.upstox.com')) return Response.json({ status: 'success', data: Object.fromEntries(rows.map(r => {
      const q = result.rows.get(r.id); return [r.id, primary(r, q?.last || 74828.25, q?.prev || 74500)];
    })) });
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    const row = MARKET_ROWS.find(r => r.symbol === symbol), q = result.rows.get(row.id);
    return Response.json(chart(row, q?.last || 74828.25, row.id === 'nifty' ? 23270.6 : q?.prev || 74500));
  } });
  assert.equal(complete.rows.find(r => r.id === 'nifty').origin, 'nse');
  assert.equal(formatPct(complete.rows.find(r => r.id === 'nifty')), '+0.50%');
  assert.deepEqual(complete.outliers, ['nifty']);
  assert.equal(complete.rows.find(r => r.id === 'sensex').origin, 'upstox');

  assert.equal(formatPct(result.rows.get('nifty')), '+0.50%');
  assert.equal(formatPct(result.rows.get('niftyit')), '−0.87%');
  assert.equal(result.rows.get('indiavix').last, 10.29); assert.equal(formatPct(result.rows.get('indiavix')), '−6.41%');
  const nse = result.rows.get('nifty'), good = quoteFromUpstox(primary(), nifty, at);
  const wrongYahoo = quoteFromChart(chart(nifty, 23446.8, 23270.6), nifty, at);
  const chosen = reconcileIndianIndex(wrongYahoo, good, nse);
  assert.equal(chosen.origin, 'nse'); assert.equal(chosen.verification, 'cross-checked');
  assert.equal(formatPct(chosen), '+0.50%'); assert.deepEqual(chosen.otherSourcesDisagree, ['yahoo']);
  assert.equal(reconcileIndianIndex(wrongYahoo, null, nse).changePct, null, 'unresolved exchange/provider disagreement remains withheld');
  assert.equal(reconcileIndianIndex({ ...wrongYahoo, state: 'unavailable', last: null }, null, nse).verification, 'single-source');
  assert.equal(reconcileIndianIndex(quoteFromChart(chart(), nifty, at), good, { ...nse, state: 'stale' }).origin, 'upstox');
  assert.throws(() => quoteFromNse(body.data[0], '31-Feb-2026 15:30', nifty, at));
  assert.throws(() => quoteFromNse(body.data[0], '24-Sep-2026 15:30', nifty, at));
  assert.equal(quoteFromNse({ ...body.data[0], percentChange: 20 }, body.timestamp, nifty, at).changePct, null);
  assert.equal((await readNseIndices(rows, { now: at, fetcher: async () => new Response('', { status: 403 }) })).reason, 'blocked');
  const duplicate = await readNseIndices(rows, { now: at, fetcher: async () => Response.json({ ...body, data: [...body.data, body.data[0]] }) });
  assert.equal(duplicate.reason, 'partial'); assert.equal(duplicate.rows.size, 6);
});
