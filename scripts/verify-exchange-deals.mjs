import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync, deflateRawSync } from 'node:zlib';
import { EXCHANGE_SOURCES, exchangeDealKey, exchangeRows, combineExchangeDeals, validateExchangeSnapshot } from '../public/js/data/exchange-deals-shared.js';
import { parseExchange, applyExchangeSlice, emptyExchangeSnapshot, securityMap } from './lib/exchange-deals.mjs';
import { captureExchanges } from './capture-exchange-deals.mjs';
import { unzipCapture, latestExchangeArtifact, readLimited, ARTIFACT_FILE } from '../worker/exchange-artifact.mjs';
import { handleExchangeDeals } from '../worker/exchange-deals.mjs';

const at = '2026-09-09T12:00:00Z', nse = EXCHANGE_SOURCES[0], bse = EXCHANGE_SOURCES[2];
const header = 'Date,Symbol,Security Name,Client Name,Buy / Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks\n';
const csv = header + '08-SEP-2026,EXAMPLE,"Example, Ltd","EXAMPLE FUND",BUY,"1,20,000",100.50,"hello ""quoted"""\n';
const parsed = parseExchange(csv, nse);
assert.deepEqual(parsed[0].slice(0, 8), ['nse-bulk', '2026-09-08', 'EXAMPLE', 'Example, Ltd', 'EXAMPLE FUND', 'Buy', 120000, 100.5]);
assert.equal(parsed[0][8], 'hello "quoted"');
assert.throws(() => parseExchange('{"data":[]}', nse), /complete CSV/);
assert.throws(() => parseExchange(header + '"broken', nse), /Truncated/);
assert.throws(() => parseExchange('{}', bse), /historical table/);
assert.deepEqual(parseExchange(header, nse), []);
const bseRow = parseExchange(JSON.stringify({ Table: [{ DEAL_DATE: '2026-09-08T00:00:00', SCRIP_CODE: 500001, scripname: 'EXAMPLE', CLIENT_NAME: 'EXAMPLE FUND', TRANSACTION_TYPE: 'P', QUANTITY: 120000, PRICE: 100.5 }] }), bse)[0];
const slice = { from: '2026-09-01', to: '2026-09-09', checkedAt: at };
let snapshot = emptyExchangeSnapshot(at);
snapshot = applyExchangeSlice(snapshot, nse, [parsed[0], parsed[0]], slice);
snapshot = applyExchangeSlice(snapshot, bse, [bseRow, [...bseRow.slice(0, 5), 'Sell', ...bseRow.slice(6)]], slice);
assert.equal(snapshot.records.length, 3, 'buy, sell, and different venue are separate; duplicate repeats disappear');
const before = snapshot;
snapshot = applyExchangeSlice(snapshot, nse, [[...parsed[0].slice(0, 6), 240000, ...parsed[0].slice(7)]], { ...slice, checkedAt: '2026-09-09T13:00:00Z' });
assert.equal(snapshot.records.filter((r) => r[0] === nse.id).length, 1);
assert.equal(snapshot.records.find((r) => r[0] === nse.id)[6], 240000, 'a correction replaces the old quantity');
const failure = applyExchangeSlice(snapshot, nse, [], { from: '2026-09-10', to: '2026-09-10', checkedAt: '2026-09-10T12:00:00Z', error: 'HTTP 403' });
assert.deepEqual(failure.records, snapshot.records);
assert.equal(failure.sources.find((s) => s.id === nse.id).coverage.at(-1).to, '2026-09-09');
assert.equal(failure.sources.find((s) => s.id === nse.id).lastSuccessAt, '2026-09-09T13:00:00Z');
assert.throws(() => applyExchangeSlice(snapshot, nse, [[nse.id, '2026-09-99', ...parsed[0].slice(2)]], slice));
assert.throws(() => applyExchangeSlice(snapshot, nse, [[...parsed[0].slice(0, 6), NaN, 1, '']], slice));
assert.throws(() => applyExchangeSlice(snapshot, bse, [[bse.id, '2026-09-08', 'undefined', ...bseRow.slice(3)]], slice), /Invalid exchange deal/);
const secondary = { ticker: 'EXAMPLE', date: '2026-09-08', cells: { 'Trade Category': 'Bulk deal', Insider: 'EXAMPLE FUND', 'Trade Shares': '1' } };
assert.equal(combineExchangeDeals([secondary], before).length, 3, 'authoritative coverage prevents even rounded secondary duplicates');
assert.equal(combineExchangeDeals([{ ...secondary, date: '2026-08-01' }], before).length, 4, 'secondary history outside covered windows is retained');
assert.equal(combineExchangeDeals([secondary], emptyExchangeSnapshot(at)).length, 1, 'no official coverage means secondary data remains visible');
assert.equal(combineExchangeDeals([{ ...secondary, cells: { 'Trade Category': 'Insider trade' } }], before).length, 4);

const mapping = securityMap('SYMBOL,ISIN NUMBER\nCORRECT,INE000000001\nCOLLISION,INE000000002\n', JSON.stringify([{ SCRIP_CD: '500001', Scrip_Name: 'A company', scrip_id: 'COLLISION', ISIN_NUMBER: 'INE000000001' }]));
assert.equal(mapping['500001'].ticker, 'CORRECT', 'cross-exchange security joins use ISIN, not similar symbols');
assert.equal(exchangeRows({ ...before, securityMap: mapping }).find((r) => r.sourceId === bse.id).ticker, 'CORRECT');
assert.equal(exchangeRows(before).find((r) => r.sourceId === bse.id).ticker, '500001', 'unmapped BSE securities keep their code');
const partial = await captureExchanges(before, { now: new Date('2026-09-10T12:00:00Z'), fetchText: async (url) => {
  if (url.includes('optionType=bulk_deals')) return csv;
  throw new Error('test source outage');
} });
assert.equal(partial.sources.find((s) => s.id === nse.id).ok, true);
assert.equal(partial.sources.find((s) => s.id === bse.id).ok, false);
assert.equal(partial.records.filter((r) => r[0] === bse.id).length, 2);
assert.equal(partial.sources.find((s) => s.id === nse.id).coverage.at(-1).to, '2026-09-10');

// ZIP fixtures exercise the real Actions artifact transport and both compression methods.
function zip(text, method = 0) {
  const plain = gzipSync(text), file = method === 8 ? deflateRawSync(plain) : plain, name = Buffer.from(ARTIFACT_FILE);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10); central.writeUInt32LE(file.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(30 + name.length + file.length, 16);
  return Buffer.concat([local, name, file, central, name, end]);
}
for (const method of [0, 8]) assert.equal(await unzipCapture(zip(JSON.stringify(before), method)), JSON.stringify(before));
await assert.rejects(unzipCapture(Buffer.from('bad archive')));
await assert.rejects(readLimited(new Response('too big'), 3), /size limit/);
const archive = zip(JSON.stringify(before));
const calls = [];
const fetchImpl = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.redirect, 'manual', 'Workers supports manual/follow redirect modes only');
  if (url.includes('/workflows/')) return Response.json({ workflow_runs: [{ id: 42, event: 'schedule', head_branch: 'main', head_repository: { full_name: 'org/repo' } }] });
  if (url.includes('/runs/42/')) return Response.json({ artifacts: [{ id: 99, name: 'exchange-deals', size_in_bytes: archive.length, expired: false }] });
  if (url.endsWith('/99/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/capture.zip' } });
  assert.equal(options.headers, undefined, 'GitHub token must not follow the download redirect');
  return new Response(archive);
};
assert.equal((await latestExchangeArtifact({ repo: 'org/repo', token: 'test-token', fetchImpl })).text, JSON.stringify(before));
const cacheMap = new Map(), cache = { match: async (key) => cacheMap.get(key.url)?.clone(), put: async (key, value) => { cacheMap.set(key.url, value); } };
const waits = [], ctx = { waitUntil: (p) => waits.push(p) }, request = new Request('https://local.example/api/bulk-block-deals');
const env = { GH_REPO: 'org/repo', GH_DISPATCH_TOKEN: 'test-token', ASSETS: { fetch: async () => Response.json(before) } };
const live = await handleExchangeDeals(request, env, ctx, { fetchImpl, cache });
assert.equal(live.status, 200); assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await live.clone().arrayBuffer()))).records, before.records); await Promise.all(waits);
const unchanged = await handleExchangeDeals(new Request(request.url, { headers: { 'if-none-match': live.headers.get('etag') } }), env, ctx, { fetchImpl: () => { throw new Error('cache missed'); }, cache });
assert.equal(unchanged.status, 304);
const fallback = await handleExchangeDeals(request, env, ctx, { fetchImpl: async () => { throw new Error('archive offline'); }, cache: { ...cache, match: async () => null } });
assert.equal(fallback.headers.get('x-sattva-exchange-fallback'), '1');
assert.deepEqual((await fallback.json()).records, before.records);
assert.equal((await handleExchangeDeals(new Request(request.url, { method: 'POST' }), env, ctx, { cache })).status, 405);

const shipped = validateExchangeSnapshot(JSON.parse(readFileSync(new URL('../public/data/exchange-deals.json', import.meta.url))));
assert.equal(new Set(shipped.records.map(exchangeDealKey)).size, shipped.records.length);
assert(shipped.records.length > 40000 && shipped.sources.every((s) => s.coverage[0].from <= '2025-09-09'));
console.log(`PASS exchanges: complete exports, ${shipped.records.length} distinct shipped reports, corrections, venue/side separation, coverage gaps, ISIN joins, partial failures, artifact transport, credential isolation and conditional delivery`);

// Delivery callbacks may rerender a view and replace themselves. The new subscription must
// wait for the next delivery rather than being visited forever by a live Set iterator.
const feed = await import('../public/js/data/exchange-deals.js');
const savedFetch = globalThis.fetch;
let originalCalls = 0, replacementCalls = 0, stopReplacement;
let stopOriginal = feed.onChange(() => {
  originalCalls++;
  stopOriginal();
  stopReplacement = feed.onChange(() => { replacementCalls++; });
});
globalThis.fetch = async () => Response.json(before);
try {
  await feed.refresh();
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 1, 'replacement receives the final delivery, not the seed delivery that installed it');
  assert.equal(feed.revision(), before.checkedAt);
} finally { stopOriginal(); stopReplacement?.(); globalThis.fetch = savedFetch; }
console.log('PASS exchange subscriptions: headless reads and safe repaint replacement');

const { mergeInsiderTrades } = await import('../public/js/data/insider-history.js');
const { withFilingArchive } = await import('../public/js/data/filing-archives.js');
const official = { ticker: 'EXAMPLE', date: '2026-09-09', exchangeSecurity: 'EXAMPLE', sourceId: 'nse-bulk', cells: { 'Trade Category': 'Bulk deal', Insider: 'Example Fund', Transaction: 'Buy', 'Trade Shares': '1000', Price: '50', Exchange: 'NSE' } };
const venues = [official, { ...official, sourceId: 'bse-bulk', cells: { ...official.cells, Exchange: 'BSE' } }, { ...official, cells: { ...official.cells, Price: '51' } }];
assert.equal(mergeInsiderTrades(venues, venues).length, 3, 'archive keeps venue and price distinctions while deduplicating identical reports');
const archivedFeed = withFilingArchive({ rows: () => venues }, 'insider');
assert.equal(archivedFeed.rows(), archivedFeed.rows(), 'unchanged exchange/archival rows preserve normalized feed cache identity');
console.log('PASS official deal archive: venue/price identity and stable repeated reads');
