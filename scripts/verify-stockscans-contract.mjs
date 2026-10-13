// Offline contracts for the published provider API. No source requests or generated assessments.
import assert from 'node:assert/strict';
import { fetchConcallScans, fetchConcallHistory, fetchUpcoming, fetchToday, mergeScans } from '../worker/stockscans.mjs';
import { retainConcallAnalysis } from '../public/js/data/concall-analysis-history.js';
import { newConcallHistory, advanceConcallHistory } from '../worker/concall-history.mjs';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const row = (key, when, doc = key, score = 54.4) => [key, `NSE:${key}`, `${key} Limited`, 'Industry', when, `${doc}.pdf`, 1, true, score, 2, ['▲ Published highlight'], null];
const requests = [];
const transport = async (url, options) => {
  const path = new URL(url).pathname;
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, body });
  if (path.endsWith('/today')) return Response.json({ day: '2026-10-14', rows: [['NEW', 'NSE:NEW', 'New Limited', '2026-10-14T16:00:00+05:30']] });
  if (path.endsWith('/upcoming')) return Response.json({ rows: [['NEW', 'NSE:NEW', 'New Limited', '2026-10-14T16:00:00+05:30']] });
  assert.equal(path, '/api/scans/concall/run');
  assert.deepEqual(body.filters, [], 'no implicit market-cap or source UI filter narrows coverage');
  const quarter = body.quarter || '202609';
  const rows = quarter === '202609' ? [row('NEW', '2026-10-13T19:00:00+05:30')]
    : body.offset === 0 ? [row('OLD', '2026-08-01T11:00:00+05:30', 'first', 0)]
    : [row('OLD', '2026-08-01T11:00:00+05:30', 'second', 80)];
  return Response.json({ quarter, quarters: ['202609', '202606'], rows,
    total: body.offset ? null : quarter === '202609' ? 1 : 2, next: quarter === '202606' && !body.offset ? 1 : null });
};
const history = await fetchConcallHistory({}, transport);
assert.equal(history.rows.length, 3, 'all quarters and distinct analysis documents remain available');
assert.equal(history.meta.truncated, false);
assert.deepEqual(history.meta.quarterChecks.map(q => q.quarter), ['202609', '202606']);
assert(history.rows.some(r => r.resultScore === 0), 'published zero stays zero');
assert(history.rows.some(r => r.resultScore === 54.4 && r.tags[0] === '▲ Published highlight'));
assert.equal(requests.filter(r => r.path.endsWith('/run')).length, 3);
assert.equal(requests.at(-1).body.quarter, '202606', 'every page stays pinned to its selected quarter');
assert.equal((await fetchUpcoming(transport)).length, 1);
assert.equal((await fetchToday(transport)).day, '2026-10-14');
assert.equal(requests.find(r => r.path.endsWith('/upcoming')).body.days, 60);
const page = body => async () => Response.json(body);
await assert.rejects(fetchConcallScans({ quarter: '202606' }, page({ quarter: '202609', total: 0, rows: [], next: null })), /changed-quarter/);
await assert.rejects(fetchConcallScans({}, page({ quarter: '202609', total: 2, rows: [row('BAD', '2026-10-13')], next: 0 })), /invalid/);
await assert.rejects(fetchConcallScans({}, page({ quarter: '202609', total: 2, rows: {}, next: null })), /invalid/);
const partial = await fetchConcallScans({ maxPages: 1, quarter: '202606' }, transport);
assert(partial.meta.truncated, 'a bounded walk is explicitly incomplete');
const corrected = { ...history.rows[0], resultScore: 70 };
assert.equal(mergeScans([corrected], history.rows).find(r => r.ssUrl === corrected.ssUrl).resultScore, 70);
const held = { ...history.rows[0], resultScore: 90, analysisCheckedAt: '2026-10-14T00:00:00Z',
  documents: [{ type: 'Transcript', url: 'https://example.test/exact.pdf' }] };
const older = { ...held, resultScore: 20, analysisCheckedAt: '2026-09-14T00:00:00Z' };
const documentOnly = { ...held, companyKey: 'screener:NEW', resultScore: null, tags: [], analysisTracked: false };
let retained = retainConcallAnalysis([older, documentOnly], [held], older.analysisCheckedAt);
assert.equal(retained.rows.length, 1, 'an exact shared document reconnects retained analysis on fallback');
assert.equal(retained.rows[0].resultScore, 90, 'an old delivery cannot regress a newer saved assessment');
retained = retainConcallAnalysis([{ ...documentOnly, documents: [{ type: 'Transcript', url: 'https://example.test/other.pdf' }] }], [held]);
assert.equal(retained.rows.length, 2, 'a date/company coincidence cannot erase an unmatched document');
retained = retainConcallAnalysis([{ ...documentOnly, ticker: 'OTHER' }], [held]);
assert.equal(retained.rows.length, 2, 'a shared file cannot join another company');
retained = retainConcallAnalysis([{ ...documentOnly, documents: [...documentOnly.documents, { type: 'Recording', url: 'https://example.test/new-version.mp3' }] }], [held]);
assert.equal(retained.analysisRows[0].documents.length, 2, 'new source versions survive the exact call join');
const head = await fetchConcallScans({ pages: 1 }, transport);
const pauses = [];
let cursor = await advanceConcallHistory(newConcallHistory(head), { fetchImpl: transport, maxPages: 1,
  sleep: async ms => pauses.push(ms) });
assert.equal(cursor.offset, 1); assert.equal(cursor.complete, false);
const checkpoints = JSON.parse(JSON.stringify(cursor));
cursor = await advanceConcallHistory(checkpoints, { fetchImpl: transport, maxPages: 1, sleep: async ms => pauses.push(ms) });
assert.equal(cursor.complete, true); assert.equal(cursor.rows.length, 3);
assert.deepEqual(pauses,[4000,4000], 'paged source reads are paced even across resumed batches');
const refused = await advanceConcallHistory(newConcallHistory(head), { sleep: async()=>{}, fetchImpl: async()=>
  new Response('',{status:429,headers:{'retry-after':'180'}}) });
assert.match(refused.error,/429/); assert(refused.retryAt>=Date.now()+179000);
assert.equal(refused.rows.length,1,'a refusal retains completed pages and its checkpoint');
await advanceConcallHistory(refused,{fetchImpl:()=>assert.fail('must not request within the source cooldown')});
assert.throws(() => newConcallHistory({ ...head, meta: { ...head.meta, total: 10 } }), /declared row count/);
let writes = 0;
await advanceConcallHistory(newConcallHistory(head), { fetchImpl: transport, maxPages: 5, sleep: async()=>{},
  save: async()=> { writes++; return false; } });
assert.equal(writes,1,'a superseded cache owner stops rather than replacing newer checkpoints');

// Exercise the real snapshot entry point in an isolated output directory, including a rollover,
// schedule failures and an unsuccessful analysis walk. The repository data file is never touched.
const scratch = await mkdtemp(join(tmpdir(),'sattva-concall-capture-'));
try {
  await mkdir(join(scratch,'scripts')); await mkdir(join(scratch,'public/data'),{recursive:true});
  await copyFile(resolve('scripts/scrape-concalls.mjs'),join(scratch,'scripts/capture.mjs'));
  await symlink(resolve('worker'),join(scratch,'worker'));
  const output = join(scratch,'public/data/concall-scans.json');
  await writeFile(output,JSON.stringify({ rows:[held], meta:{fetchedAt:held.analysisCheckedAt},
    upcoming:[{ticker:'RETAINED'}], today:{day:'2026-10-13',rows:[{ticker:'RETAINED'}]} }));
  const preload = join(scratch,'fixture.mjs');
  await writeFile(preload,`globalThis.fetch=async (url,options)=>{
    if(new URL(url).hostname!=='www.stockscans.in') throw Error('Unexpected external request');
    if(process.env.CONCALL_FIXTURE_FAIL || !url.endsWith('/run')) return new Response('',{status:404});
    return Response.json({quarter:'202609',quarters:['202609'],total:1,next:null,
      rows:${JSON.stringify([row('CURRENT','2026-10-13T19:00:00+05:30')])}});
  };`);
  const run = env => promisify(execFile)(process.execPath,['--import',preload,join(scratch,'scripts/capture.mjs')],{env:{...process.env,...env}});
  await run({CONCALL_FIXTURE_FAIL:''});
  const captured = JSON.parse(await readFile(output,'utf8'));
  assert.equal(captured.rows.length,2); assert(captured.rows.some(r=>r.resultScore===90 && r.analysisRetained));
  assert.equal(captured.upcoming[0].ticker,'RETAINED'); assert.equal(captured.today.rows[0].ticker,'RETAINED');
  assert.equal(captured.meta.scheduleErrors.length,2); assert.match(captured.degraded,/schedule unavailable/);
  await assert.rejects(access(`${output}.tmp`));
  const good = await readFile(output,'utf8');
  await assert.rejects(run({CONCALL_FIXTURE_FAIL:'1'}));
  assert.equal(await readFile(output,'utf8'),good,'a failed capture cannot overwrite the retained analysis archive');
} finally { await rm(scratch,{recursive:true,force:true}); }
console.log('PASS migrated endpoints, full published quarters, pinned pagination, distinct documents, source values and honest bounds');
