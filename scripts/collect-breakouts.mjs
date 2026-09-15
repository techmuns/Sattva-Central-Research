#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { BREAKOUT_ENDPOINT, BREAKOUT_ORIGIN, BREAKOUT_BATCH, BREAKOUT_LIMIT, marketWindow, quoteFresh, tickerValid, validateQuote, recoverySlots } from '../public/js/data/breakout-live-shared.js';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
import { yahooQuote, upstoxQuotes, recoverYahoo } from './lib/breakout-providers.mjs';

export function captureTarget(company) {
  const ticker = String(company.ticker || /\/company\/([^/]+)/.exec(company['Screener URL'] || '')?.[1] || '').trim().toUpperCase();
  return tickerValid(ticker) ? {ticker,name:company.name || company.Company || ticker,yahooTicker:company.yahooTicker} : null;
}
export function closingSeedComplete(capture, now = Date.now()) {
  if (capture?.state !== 'complete' || capture.discoveryFailed || capture.failures?.length || !capture.targets?.length) return false;
  const rows = new Map((capture.rows || []).map(row => [row.ticker, row]));
  return capture.targets.every(ticker => quoteFresh(rows.get(ticker), now));
}
export function breakoutClient({ env = process.env, fetcher = fetch } = {}) {
  return async input => {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL || '');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com') || url.username || url.password || url.port) throw Error('OIDC unavailable');
    url.searchParams.set('audience', BREAKOUT_ENDPOINT);
    const identity = await boundedJson(await fetcher(url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15000) }), 64000);
    if (typeof identity.value !== 'string' || identity.value.length > 16000) throw Error('OIDC unavailable');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(BREAKOUT_ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${identity.value}`, 'content-type': 'application/json' },
          body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30000) });
        const out = await boundedJson(response, 2 * 1024 * 1024);
        if (!out.ok) throw Error('Checkpoint unavailable');
        return out;
      } catch { if (attempt) throw Error('Checkpoint unavailable'); }
    }
  };
}
export async function collectBreakouts({ targets, previous = null, client, primary = yahooQuote, backup = upstoxQuotes,
  recovery = recoverYahoo, token = '', discoveryFailed = false, now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (!targets.length || targets.length > BREAKOUT_LIMIT || new Set(targets.map(t => t.ticker)).size !== targets.length || targets.some(t => !tickerValid(t.ticker))) throw Error('Invalid inventory');
  await client({ action: 'begin', targets: targets.map(t => t.ticker), discoveryFailed });
  const rows = [], misses = [], bases = new Map();
  const retained = new Map((previous?.rows || []).map(row => [row.ticker, row]));
  const closingRetry = !marketWindow(now()).collect;
  for (const row of previous?.rows || []) if (row.sessionDate === marketWindow(now()).day && row.base) bases.set(row.ticker, row.base);
  let rateLimited = false;
  const captureDeadline = now() + 8*60000, recoveryDeadline = now() + 10*60000;
  // Small waves checkpoint independently. An interrupted run retains every acknowledged wave.
  for (let offset = 0; offset < targets.length; offset += 8) {
    const wave = targets.slice(offset, offset + 8), saved = [];
    await Promise.all(wave.map(async target => {
      // Retry only missing closing observations overnight. Reused observations keep
      // their actual source/check times; they are not newly fetched prices.
      const prior = retained.get(target.ticker);
      if (closingRetry && quoteFresh(prior, now())) { saved.push(prior); rows.push(prior); return; }
      if (now() >= captureDeadline) { misses.push({ target, reason:'unavailable' }); return; }
      if (rateLimited) { misses.push({ target, reason: 'rate-limited' }); return; }
      try {
        const row = await primary(target, { now });
        if (row.sessionDate === marketWindow(now()).day && row.base) bases.set(target.ticker, row.base);
        if (!quoteFresh(row, now())) { misses.push({ target, reason: 'stale' }); return; }
        // Delay this row's first checkpoint until its optional base lookup finishes,
        // so it is saved once without mutating an acknowledged observation.
        if (token && !row.base) { misses.push({target,reason:'missing-base',quote:row}); return; }
        saved.push(row); rows.push(row);
      } catch (error) {
        if (error.message === 'rate-limited') rateLimited = true;
        misses.push({ target, reason: error.message === 'rate-limited' ? 'rate-limited' : 'unavailable' });
      }
    }));
    if (saved.length) await client({ action: 'checkpoint', rows: saved.map(row=>validateQuote(row,now())) });
    if (!rateLimited && offset + 8 < targets.length) await sleep(300);
  }
  let backupReason = token ? 'unused' : 'not-configured';
  if (misses.length && token) {
    let result = {rows:[]};
    try {
      result = await backup(misses.map(m => m.target), bases, { token, now });
      if (!Array.isArray(result?.rows)) throw Error('Invalid backup result');
      backupReason = result.reason || 'ok';
    } catch { result = {rows:[]}; backupReason = 'unavailable'; }
    const candidates = new Map(result.rows.map(row=>[row.ticker,row]));
    const saved = misses.flatMap(m => {
      const row = candidates.get(m.target.ticker);
      if (m.quote) return [{...m.quote,...(row?.base && row.sessionDate===m.quote.sessionDate ? {base:row.base,historyBars:row.historyBars || m.quote.historyBars} : {})}];
      return row && quoteFresh(row,now()) ? [row] : [];
    });
    for (let i = 0; i < saved.length; i += BREAKOUT_BATCH) await client({ action: 'checkpoint', rows: saved.slice(i, i + BREAKOUT_BATCH).map(row=>validateQuote(row,now())) });
    rows.push(...saved);
  }
  const succeeded = new Set(rows.map(row => row.ticker));
  const failures = misses.filter(m => !succeeded.has(m.target.ticker)).map(m => ({ ticker: m.target.ticker, reason: m.reason }));
  for (let i = 0; i < failures.length; i += BREAKOUT_BATCH) await client({ action: 'checkpoint', failures: failures.slice(i, i + BREAKOUT_BATCH) });
  await client({ action: 'finish' });
  // Recover saved gaps as well as newly missed intervals. Current quotes have already landed.
  let recovered = 0, recoveryFailed = 0;
  for (const row of rows) {
    const prior = previous?.rows?.find(old=>old.ticker===row.ticker);
    const retry = previous?.recoveryPending?.find(gap=>gap.ticker===row.ticker);
    const original = retry?.since ?? (prior ? Date.parse(prior.quoteAt) : null);
    if (original == null) continue; // No archive claim before first capture.
    const from = Math.max(original, now()-5*86400000), to = Math.min(now(), Date.parse(row.quoteAt));
    if (to <= from || (!retry && recoverySlots(from,to).length < 2)) continue;
    const target = targets.find(target=>target.ticker===row.ticker);
    // Record the gap first, so an interrupted recovery remains eligible on the next run.
    await client({action:'recovery',ticker:row.ticker,from,to,rows:[]});
    try {
      if (rateLimited || now() >= recoveryDeadline) throw Error('unavailable');
      const historical = await recovery(target,row,from,{now});
      for (let i=0;i<historical.length;i+=BREAKOUT_BATCH) await client({action:'recovery',ticker:row.ticker,from,to,rows:historical.slice(i,i+BREAKOUT_BATCH).filter(q=>Date.parse(q.quoteAt)<=to)});
      recovered += historical.length;
    } catch (error) { recoveryFailed++; if (error.message==='rate-limited') rateLimited=true; }
  }
  return { targetCount: targets.length, saved: rows.length, failures: failures.length, noBase: rows.filter(r => !r.base).length,
    discoveryFailed, recovered, recoveryFailed, upstox: backupReason, completedAt: new Date(now()).toISOString() };
}
export async function bootstrapBreakouts({client=breakoutClient(),now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}) {
  const deadline=now()+8*60000;
  do {
    try { const result=await client({action:'arm'}); if(result.schedule?.started && result.schedule.alarmAt) return result; }
    catch { /* The new Worker may still be publishing. No source collection is needed. */ }
    await sleep(15000);
  } while(now()<deadline);
  throw Error('The backup timer could not start; verify website publishing.');
}
async function main() {
  if(process.argv.includes('--bootstrap')) { await bootstrapBreakouts(); console.log('Durable backup timer started.'); return; }
  const now = Date.now();
  let previous;
  try { previous = await boundedJson(await fetch(`${BREAKOUT_ORIGIN}/api/breakouts`, {signal:AbortSignal.timeout(20000)}), 8*1024*1024); }
  catch { if (!marketWindow(now).collect) throw Error('Capture service unavailable'); }
  if (!marketWindow(now).collect && closingSeedComplete(previous, now)) {
    console.log('Outside market collection hours; no market-source requests.'); return;
  }
  // The first scheduled run also seeds the latest closing observations after hours.
  // Otherwise a newly published dashboard could display the old CMP until next morning.
  if (!marketWindow(now).collect && previous?.version !== 1) throw Error('Capture service unavailable');
  const technicals = JSON.parse(readFileSync('public/data/technicals.json', 'utf8'));
  const targets = new Map();
  let discoveryFailed = false;
  for (const c of technicals.companies) { const target=captureTarget(c); if(target) targets.set(target.ticker,target); else discoveryFailed=true; }
  const universe = JSON.parse(readFileSync('public/data/universe.json', 'utf8'));
  for (const c of universe) { const target=captureTarget(c); if(target) { if(!targets.has(target.ticker)) targets.set(target.ticker,target); } else discoveryFailed=true; }
  try {
    const book = await loadActivePortfolio(resolve('public/data/portfolio-companies.json'), { live: true });
    for (const c of book.holdings || []) if (tickerValid(c.ticker)) targets.set(c.ticker, { ticker: c.ticker, name: c.name, yahooTicker: c.yahooTicker });
  } catch { discoveryFailed = true; }
  try {
    const watchlist = await boundedJson(await fetch(`${BREAKOUT_ORIGIN}/api/watchlist`, { signal: AbortSignal.timeout(20000) }), 2 * 1024 * 1024);
    if (!Array.isArray(watchlist.companies)) throw Error('Watchlist unavailable');
    for (const c of watchlist.companies) if (tickerValid(c.ticker)) targets.set(c.ticker, { ticker: c.ticker, name: c.name });
  } catch { discoveryFailed = true; }
  if (discoveryFailed) for (const ticker of previous?.targets || []) if (!targets.has(ticker)) targets.set(ticker, {ticker,name:previous?.rows?.find(row=>row.ticker===ticker)?.name || ticker});
  const client = breakoutClient();
  const summary = await collectBreakouts({ targets: [...targets.values()].sort((a,b)=>(Date.parse(previous?.rows?.find(row=>row.ticker===a.ticker)?.quoteAt)||0)-(Date.parse(previous?.rows?.find(row=>row.ticker===b.ticker)?.quoteAt)||0)), previous, client, discoveryFailed,
    token: process.env.UPSTOX_BACKUP_ENABLED === 'true' ? process.env.UPSTOX_ACCESS_TOKEN || '' : '' });
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/breakout-health.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (summary.failures || summary.noBase || summary.discoveryFailed || !marketWindow(now).calendarKnown) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Breakout capture did not complete. Saved checkpoints are retained; inspect the capture health endpoint.'); process.exitCode = 1; });
