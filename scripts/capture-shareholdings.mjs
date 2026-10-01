// Local or scheduled public reads. Publishing is a separate checked-PR step.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseIndex, parseFiling, mergeFilings } from './lib/shareholding-filings.mjs';
import { csvRows, SECURITY_URLS, exchangeRequestHeaders } from './lib/exchange-deals.mjs';

export function publicRequestUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['www.bseindia.com', 'api.bseindia.com', 'www.nseindia.com', 'nsearchives.nseindia.com', 'archives.nseindia.com'].includes(url.hostname))
    throw new Error('Unexpected public source host');
  return url.href;
}
async function fetchOnce(input, maxBytes) {
  let url = publicRequestUrl(input), response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, { redirect: 'manual', headers: exchangeRequestHeaders(url), signal: AbortSignal.timeout(60000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirects === 3) throw new Error('Invalid public source redirect');
    url = publicRequestUrl(new URL(location, url).href);
  }

  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body.getReader(), parts = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > maxBytes) throw new Error('Public response exceeds size limit'); parts.push(value); } }
  catch (error) { await reader.cancel(); throw error; }
  return Buffer.concat(parts).toString('utf8');
}
export async function fetchPublic(url, maxBytes = 25000000) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetchOnce(url, maxBytes); }
    catch (error) {
      if (attempt >= 2 || /HTTP 40[134]|size limit|Unexpected public|Invalid public source/.test(error.message)) throw new Error(`${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
export function captureWindow(now) {
  const date = new Date(now), quarter = Math.floor(date.getUTCMonth() / 3) * 3;
  // Two completed quarters plus later event-driven disclosures, across all listed companies.
  return { from: new Date(Date.UTC(date.getUTCFullYear(), quarter - 3, 0)).toISOString().slice(0, 10), to: date.toISOString().slice(0, 10) };
}
export async function captureShareholdings(previous = {}, { now = new Date().toISOString(), fetchText = fetchPublic, maxFiles = 16000, concurrency = 4, checkpoint = () => {}, securityMap = {} } = {}) {
  const { from, to } = captureWindow(now), format = (s) => s.split('-').reverse().join('-');
  let securityMaster;
  try {
    const [header, ...rows] = csvRows(await fetchText(SECURITY_URLS.nse));
    if (!header?.includes('SYMBOL') || !header.includes('ISIN NUMBER') || !rows.length) throw new Error('Unreadable NSE security master');
    const entries = {};
    for (const row of rows) {
      const symbol = row[header.indexOf('SYMBOL')], isin = row[header.indexOf('ISIN NUMBER')];
      if (symbol && /^IN[A-Z0-9]{10}$/.test(isin)) entries[symbol] = Object.hasOwn(entries, symbol) && entries[symbol]?.isin !== isin ? null : { isin };
    }
    if (!Object.keys(entries).length || previous.securityMaster?.count > Object.keys(entries).length * 2) throw new Error('Unexpectedly truncated NSE security master');
    securityMaster = { url: SECURITY_URLS.nse, checkedAt: now, lastSuccessAt: now, ok: true, count: Object.keys(entries).length, entries };
  } catch (error) { securityMaster = { ...previous.securityMaster, url: SECURITY_URLS.nse, checkedAt: now, ok: false, error: error.message }; }
  const sourceDefs = [
    { id: 'bse', url: 'https://api.bseindia.com/BseIndiaAPI/api/Corp_Shareholding_ng/w?scripcode=&flag=6&indtype=ALL' },
    ...['equities', 'sme'].map((market) => ({ id: `nse-${market}`, url: `https://www.nseindia.com/api/corporate-share-holdings-master?index=${market}&from_date=${format(from)}&to_date=${format(to)}` })),
  ];
  const sources = [], entries = [];
  for (const source of sourceDefs) {
    const prior = previous.sources?.find((s) => s.id === source.id);
    try {
      const all = parseIndex(JSON.parse(await fetchText(source.url)), source.id);
      if (!all.length || prior?.indexed > 100 && all.length < prior.indexed * 0.5) throw new Error('Unexpected empty or sharply truncated exchange index');
      // A revised filing supersedes the prior filing for this venue, security and index date.
      // Previously captured versions remain in the archive for history and comparisons.
      const latest = new Map();
      for (const entry of all.filter((e) => e.indexAsOf >= from && e.indexAsOf <= to)) {
        const key = `${entry.bseCode || entry.isin || entry.ticker}|${entry.indexAsOf}`;
        if (!latest.has(key) || entry.filedAt > latest.get(key).filedAt) latest.set(key, entry);
      }
      entries.push(...latest.values());
      sources.push({ ...source, from, to, indexed: all.length, selected: latest.size, checkedAt: now, lastSuccessAt: now, ok: true, error: null });
    } catch (error) { sources.push({ ...prior, ...source, checkedAt: now, ok: false, error: error.message }); }
  }
  const retained = new Map((previous.filings || []).map((f) => [f.id, f]));
  const readable = new Map(entries.map((e) => [e.id, e]));
  for (const f of retained.values()) if (!readable.has(f.id) && !f.supersededBy && f.sourceUrl && (!f.holders || f.status === 'partial' || f.indexAsOf >= from && f.indexAsOf <= to)) readable.set(f.id, f);
  // Refresh a rotating sample after seven days to catch corrections at unchanged URLs.
  const unread = [...readable.values()].filter((e) => { const f = retained.get(e.id); return !f?.holders || f.status === 'partial' || f.parserVersion !== 1 || Date.parse(now) - Date.parse(f.checkedAt) > 7 * 86400000; })
    .sort((a, b) => Number(!!retained.get(a.id)?.holders) - Number(!!retained.get(b.id)?.holders) || (Date.parse(retained.get(a.id)?.lastAttemptAt || retained.get(a.id)?.checkedAt || '') || 0) - (Date.parse(retained.get(b.id)?.lastAttemptAt || retained.get(b.id)?.checkedAt || '') || 0) || b.indexAsOf.localeCompare(a.indexAsOf) || a.id.localeCompare(b.id));
  const queue = unread.slice(0, maxFiles);
  const results = []; let cursor = 0, consecutiveTransportFailures = 0;
  const snapshot = () => ({ ...mergeFilings(previous, entries, results, sources, now), securityMaster, window: { from, to } });
  console.log(`Shareholdings: ${entries.length} indexed filings for ${from} – ${to}; ${queue.length} reads this run`);
  for (const source of sources) console.log(`${source.id}: ${source.ok ? `${source.indexed} index rows, ${source.selected} selected` : source.error}`);
  checkpoint(snapshot());
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < queue.length && consecutiveTransportFailures < 20) {
      const entry = queue[cursor++];
      try {
        if (!entry.sourceUrl) throw new Error('Exchange index has no machine-readable attachment');
        const xml = await fetchText(entry.sourceUrl, 15000000);
        consecutiveTransportFailures = 0;
        const parsed = parseFiling(xml, entry, now, securityMap, securityMaster.entries);
        delete parsed.error; delete parsed.lastAttemptAt;
        results.push(parsed);
      } catch (error) {
        if (/fetch failed|HTTP|timeout|terminated|aborted/i.test(error.message)) consecutiveTransportFailures++;
        results.push({ ...entry, status: 'failed', lastAttemptAt: now, error: error.message });
      }
      if (results.length % 25 === 0) { checkpoint(snapshot()); console.log(`Read ${results.length}/${queue.length}; ${results.filter((f) => f.status === 'failed').length} failed`); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }));
  const result = snapshot();
  result.window = { from, to };
  result.pending = result.filings.filter((f) => !f.holders && !f.supersededBy).length;
  result.errors = result.filings.filter((f) => !f.supersededBy && (f.error || f.status === 'partial')).length;
  // Issuer data/identity exceptions need review; source outages and unfinished reads are
  // operational failures. Neither case marks the public portfolio as complete.
  result.operationalFailure = sources.some((s) => !s.ok) || securityMaster.ok === false || unread.length > queue.length || cursor < queue.length ||
    results.some((f) => f.status === 'failed' && /fetch failed|HTTP (?:403|429|5\d\d)|timeout|terminated|aborted/i.test(f.error));
  return result;
}
async function main() {
  const output = process.env.SHAREHOLDINGS_OUT || new URL('../public/data/shareholding-filings.json.gz', import.meta.url).pathname;
  const read = process.env.SHAREHOLDINGS_PREVIOUS || output;
  const previous = existsSync(read) ? JSON.parse(read.endsWith('.gz') ? gunzipSync(readFileSync(read)) : readFileSync(read, 'utf8')) : {};
  const save = (data) => { mkdirSync(dirname(output), { recursive: true }); const text = JSON.stringify(data); writeFileSync(`${output}.tmp`, output.endsWith('.gz') ? gzipSync(text) : text); renameSync(`${output}.tmp`, output); };
  const exchangeFile = new URL('../public/data/exchange-deals.json', import.meta.url);
  const securityMap = existsSync(exchangeFile) ? JSON.parse(readFileSync(exchangeFile, 'utf8')).securityMap || {} : {};
  const snapshot = await captureShareholdings(previous, { maxFiles: Number(process.env.SHAREHOLDINGS_LIMIT || 16000), checkpoint: save, securityMap });
  save(snapshot);
  console.log(`Saved ${snapshot.filings.length} filings; ${snapshot.pending} pending/failed, ${snapshot.errors} exceptions`);
  if (snapshot.operationalFailure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
