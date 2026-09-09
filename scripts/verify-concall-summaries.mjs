import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConcallSummaryStore } from '../worker/concall-summary-store.mjs';
import { ConcallSummarySchedule } from '../worker/concall-summary-schedule.mjs';
import { SCREENER_CONCALL_WORKFLOW } from '../public/js/data/screener-concalls-shared.js';
import { authoriseSummaryReader, summaryCollectorIdentity } from '../worker/concall-summary-auth.mjs';
import { handleConcallSummaries } from '../worker/concall-summaries.mjs';
import { summaryId, summaryIdsForRow, validateSummaryBody, summaryStateMessage, summaryScheduleMessage, SUMMARY_WINDOW_MS, SUMMARY_ORIGIN, SUMMARY_WORKFLOW, SUMMARY_INVENTORY_BATCH, SUMMARY_TRANSPORT_LIMIT } from '../public/js/data/concall-summaries-shared.js';
import { buildSummaryInventory } from './lib/concall-summary-inventory.mjs';
import { summaryResponseError, summaryNavigationGate } from './lib/read-screener-summary.mjs';
import { SUMMARY_INTERVAL_MS, SUMMARY_CRON_OFFSET_MS } from '../public/js/data/concall-summaries-shared.js';
import { runSummaryCollection, summaryCollectorClient } from './collect-screener-summaries.mjs';

const START = Date.parse('2026-09-10T06:00:00Z');
const iso = at => new Date(at).toISOString();
const isin = n => `INE${String(n).padStart(9, '0')}`;
const source = (n, id = String(n), date = '2026-09-09') => ({ companyKey: `TEST${n}`, ticker: `TEST${n}`, name: `Test company ${n}`,
  companyUrl: `https://www.screener.in/company/TEST${n}/`, publishedDate: date, kind: 'Transcript',
  url: `https://example.com/${id}.pdf`, summaryUrl: `https://www.screener.in/concalls/summary/${id}/` });
const book = (n = 3, at = START) => ({ ok: true, syncStatus: 'live', storage: 'shared', sourceRevision: 'a'.repeat(64), asOf: '2026-08-31', syncedAt: iso(at),
  count: n, resolved: n, sourceWorkbook: { fileKey: 'active-book', label: 'Active book', uploadedAt: iso(START - 86400000) },
  holdings: Array.from({ length: n }, (_, index) => ({ isin: isin(index + 1), ticker: `TEST${index + 1}`, name: `Test company ${index + 1}` })) });
const inventory = (n = 3, at = START) => buildSummaryInventory(book(n, at), { fullHistory: true, checkedAt: iso(at), rows: Array.from({ length: n }, (_, index) => source(index + 1)) }, { now: at });
const body = { title: 'Concall Summary - Test company 1 - Sep 2026', blocks: [
  { type: 'heading', text: 'Operating performance' }, { type: 'paragraph', text: 'The company reported its operating performance and discussed the outlook for its current financial year. These are source notes preserved without adding any new conclusions.' },
  { type: 'list', ordered: false, items: ['Management discussed demand.', 'Management discussed costs.'] },
] };
function storage(path = ':memory:') {
  const db = new DatabaseSync(path), kv = new Map();
  let alarm = null;
  return {
    db, sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    transaction: async fn => fn({ get: async key => kv.get(key), put: async (key, value) => kv.set(key, structuredClone(value)),
      getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } }),
    get: async key => kv.get(key), put: async (key, value) => kv.set(key, structuredClone(value)), getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
}
const complete = (store, claim, outcome = 'ready') => store.complete('1:1', { ...claim, outcome, body });

test('only exact HTTPS summary IDs join, with a single list of distinct sources per row', () => {
  for (const url of ['https://evil.test/concalls/summary/12/', 'http://www.screener.in/concalls/summary/12/',
    'https://www.screener.in:4430/concalls/summary/12/', 'https://a@www.screener.in/concalls/summary/12/',
    'https://www.screener.in/concalls/summary/12/?a=1', 'javascript:alert(1)']) assert.equal(summaryId(url), null);
  const url = source(1).summaryUrl;
  assert.deepEqual(summaryIdsForRow({ documents: [{url}, {url}, {url: source(2).summaryUrl}] }), ['1', '2']);
  assert.throws(() => validateSummaryBody({ title: 'summary', blocks: [{type:'html', html:'<script>'}] }));
});

test('current portfolio additions enter automatically; tickerless ISIN matches and gaps are explicit', () => {
  const portfolio = book(4);
  portfolio.holdings[2].ticker = null; portfolio.resolved--;
  portfolio.holdings[2].reason = 'BSE-only';
  const bse = { ...source(3), companyKey: '500003', ticker: null, name: 'Different source abbreviation', companyUrl: 'https://www.screener.in/company/500003/' };
  const found = buildSummaryInventory(portfolio, { fullHistory: true, checkedAt: iso(START), rows: [source(1), source(2), bse] },
    { now: START, identities: [{isin:isin(3),bseCode:'500003'}] });
  assert.equal(found.holdings.length, 4);
  assert.equal(found.targets.find(t=>t.isin===isin(3)).companyKey, '500003');
  assert.equal(found.holdings[3].discovery, 'no-matching-source-company');
  assert.throws(() => buildSummaryInventory(portfolio, {fullHistory:false,checkedAt:iso(START),rows:[]}, {now:START}));
  portfolio.holdings[1].ticker = 'TEST1-SM';
  const ambiguous = buildSummaryInventory(portfolio, {fullHistory:true,checkedAt:iso(START),rows:[source(1)]}, {now:START});
  assert(ambiguous.holdings.slice(0,2).every(h => h.discovery === 'ambiguous-identity'));
  assert.equal(ambiguous.targets.length, 0, 'neither holding wins an ambiguous source identity');
});

test('durable budget counts attempts before requests, survives interruption, and does not reset at midnight', () => {
  let now = START;
  const backing = storage(), store = new ConcallSummaryStore(backing, {now:()=>now});
  store.sync(inventory(70,now));
  const first = store.reserve('1:1', randomUUID());
  assert(first.reserved);
  assert.equal(store.reserve('1:1', first.requestId).reason, 'already-attempted');
  assert.equal(store.reserve('2:1', randomUUID()).reason, 'busy');
  now += 6*60000; // Crash: no completion; its slot and per-record retry deadline survive.
  const restarted = new ConcallSummaryStore(backing,{now:()=>now});
  for(let i=1;i<60;i++) { const claim=restarted.reserve('1:1',randomUUID()); assert(claim.reserved); complete(restarted,claim); now+=15001; }
  assert.equal(restarted.reserve('1:1',randomUUID()).reason,'daily-budget');
  assert.equal(restarted.status().automatedRequestsLast24h,60);
  now = Date.parse('2026-09-11T00:01:00Z');
  restarted.sync(inventory(70,now));
  assert.equal(restarted.reserve('1:1',randomUUID()).reason,'daily-budget');
  now = START+SUMMARY_WINDOW_MS+1;
  restarted.sync(inventory(70,now));
  assert(restarted.reserve('1:1',randomUUID()).reserved);
  backing.db.close();
});

test('saved bodies survive real SQLite reopen, portfolio exits, repeat publication and failed discovery', () => {
  const dir=mkdtempSync(join(tmpdir(),'sattva-summary-')); const path=join(dir,'summary.sqlite'); let now=START;
  let backing=storage(path), store=new ConcallSummaryStore(backing,{now:()=>now});
  try {
    store.sync(inventory(5)); const claim=store.reserve('1:1',randomUUID()); complete(store,claim);
    assert.equal(complete(store,claim).duplicate,true);
    backing.db.close(); backing=storage(path); store=new ConcallSummaryStore(backing,{now:()=>now});
    assert.deepEqual(store.read(['1'])[0].body,body);
    assert.deepEqual(store.status().readyIds,['1']);
    now+=60000; const next=inventory(5,now);
    next.holdings[0]={isin:isin(6),ticker:'TEST6',name:'Test company 6',discovery:'matched',summaries:1};
    next.targets=next.targets.filter(t=>t.id!=='1'); next.targets.unshift({...next.targets[0],id:'6',isin:isin(6),companyKey:'TEST6',
      companyUrl:'https://www.screener.in/company/TEST6/',name:'Test company 6',sourceName:'Test company 6',url:source(6).summaryUrl,rank:0,publishedDate:'2026-09-10'});
    next.portfolioRevision='b'.repeat(64); store.sync(next);
    assert.equal(store.status().holdings.some(h=>h.isin===isin(1)),false);
    assert.deepEqual(store.status().readyIds,['1'],'saved IDs remain readable after a portfolio exit');
    assert.equal(store.read(['1'])[0].status,'ready');
    assert.equal(store.read(['1'])[0].active,false,'portfolio exits stop eligibility without removing the saved body');
    assert.equal(store.reserve('1:1',randomUUID()).target.id,'6');
    store.discoveryFailed(); assert.equal(store.status().discoveryStatus,'failed'); assert.equal(store.read(['1'])[0].status,'ready');
    now+=6*60000; assert.equal(store.reserve('1:1',randomUUID()).reason,'inventory-unavailable');
    store.sync(inventory(1,now));
    assert.equal(store.status().holdings.length,1,'a validated complete portfolio reduction is accepted');
    assert.equal(store.read(['1'])[0].status,'ready');
    assert.throws(()=>store.sync({...inventory(1,now),portfolioAsOf:'2026-07-31'}),/reconciliation/);
    assert.throws(()=>store.sync({...inventory(1,now),portfolioWorkbookUploadedAt:iso(START-2*SUMMARY_WINDOW_MS)}),/reconciliation/);
  } finally {backing.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('all refusals stop the account; failed writes cannot replace a saved summary or consume another slot', () => {
  for (const outcome of ['rate-limited','access-denied','session-expired','structure-changed']) {
    const backing=storage();let now=START;const store=new ConcallSummaryStore(backing,{now:()=>now});store.sync(inventory());
    const claim=store.reserve('1:1',randomUUID()); complete(store,claim,outcome);
    assert.equal(store.reserve('1:1',randomUUID()).reason,outcome);
    now+=60000;store.sync(inventory(4,now));assert.equal(store.reserve('1:1',randomUUID()).reason,outcome);
    assert.equal(store.status().automatedRequestsLast24h,1);backing.db.close();
  }
  assert.equal(summaryResponseError(200,'Limit exceeded - Please try again later. Premium users can request 80 summaries each day.').summaryCode,'rate-limited');
  assert.equal(summaryResponseError(429,'','172800',START).retryAt,iso(START+2*SUMMARY_WINDOW_MS));
  assert.equal(summaryResponseError(403).summaryCode,'access-denied');
  assert.equal(summaryResponseError(403).httpStatus,403);
  assert.equal(summaryResponseError(200,'Welcome back! Login to your account. Upgrade to Premium'),null,
    'ordinary promotion on the valid public login page is not a refusal');
  assert.equal(summaryResponseError(200,'The company has an upgrade plan for its factories.'),null);
  for(const message of ['Access denied','Verify you are human','CAPTCHA'])
    assert.equal(summaryResponseError(200,message).summaryCode,'access-denied');
  const backing=storage(), store=new ConcallSummaryStore(backing,{now:()=>START});store.sync(inventory());
  const claim=store.reserve('1:1',randomUUID()), retryAt=iso(START+45*SUMMARY_WINDOW_MS);
  store.complete('1:1',{...claim,outcome:'rate-limited',retryAt});
  assert.equal(store.status().cooldownUntil,retryAt,'longer source cooldowns are never shortened');backing.db.close();
});

test('one newest note per company precedes its older history; duplicates do not take queue slots', () => {
  const capture={fullHistory:true,checkedAt:iso(START),rows:[source(1,'1'),source(1,'1'),source(1,'11','2026-08-01'),source(2,'2','2026-08-30')]};
  const plan=buildSummaryInventory(book(2),capture,{now:START});
  assert.deepEqual(plan.targets.map(t=>t.id),['1','2','11']);
});

test('private readers receive actual deferred eligibility and no invented date for untracked IDs', () => {
  const backing=storage(), store=new ConcallSummaryStore(backing,{now:()=>START});
  try {
    store.sync(inventory());
    const claim=store.reserve('1:1',randomUUID());complete(store,claim,'not-published');
    const deferred=store.read([claim.target.id])[0];
    assert.equal(deferred.active,true);assert.equal(deferred.status,'not-published');
    assert.equal(deferred.nextAttemptAt,iso(START+7*SUMMARY_WINDOW_MS));
    assert.deepEqual(store.read(['999'])[0],{id:'999',status:'not-collected',active:false,nextAttemptAt:null});
  } finally {backing.db.close();}
});

test('reader access requires verified owner identity and never uses the caller as a deployment fallback', async () => {
  const token='reader-token-123456789';const owner='owner-token-123456789';
  const request=new Request(`${SUMMARY_ORIGIN}/api/concall-summaries`,{headers:{authorization:`Bearer ${token}`}});
  let calls=0;
  const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://fastapi.muns.io/auth/me');assert.equal(options.redirect,'manual');return Response.json({email:options.headers.authorization.includes(owner)?'owner@example.com':'reader@example.com'});};
  assert.equal((await authoriseSummaryReader(request,{}, {fetcher})).ok,false);assert.equal(calls,0);
  assert.equal((await authoriseSummaryReader(request,{MUNS_TOKEN:owner},{fetcher})).ok,false);
  assert.equal((await authoriseSummaryReader(request,{SCREENER_SUMMARY_READER_EMAILS:'reader@example.com'},{fetcher})).ok,true);
  let touched=false; const env={SCREENER_SUMMARIES:{getByName:()=>{touched=true;throw Error();}}};
  const denied=await handleConcallSummaries(request,env,{fetcher});assert.equal(denied.status,401);assert.equal(touched,false);
  assert.match(denied.headers.get('cache-control'),/private, no-store/);
  const collector=await handleConcallSummaries(new Request(`${SUMMARY_ORIGIN}/api/concall-summaries/collector`,{method:'POST'}),env);
  assert.equal(collector.status,403);
});

test('GitHub OIDC checks the signature, audience, exact workflow, immutable repository IDs, ref and expiry', async () => {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test',use:'sig',alg:'RS256'};
  const base={iss:'https://token.actions.githubusercontent.com',aud:`${SUMMARY_ORIGIN}/api/concall-summaries/collector`,repository:'techmuns/Sattva-Central-Research',repository_id:'1329567087',repository_owner_id:'278697674',
    ref:'refs/heads/main',workflow_ref:`techmuns/Sattva-Central-Research/.github/workflows/${SUMMARY_WORKFLOW}@refs/heads/main`,event_name:'schedule',exp:START/1000+300,iat:START/1000,nbf:START/1000,run_id:'12',run_attempt:'1'};
  const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const request=async changes=>{const text=`${b64({alg:'RS256',kid:'test'})}.${b64({...base,...changes})}`;const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(text));return new Request(SUMMARY_ORIGIN,{headers:{authorization:`Bearer ${text}.${Buffer.from(sig).toString('base64url')}`}});};
  const options={now:START,fetcher:async()=>Response.json({keys:[jwk]})};
  assert.equal(await summaryCollectorIdentity(await request({}),options),'12:1');
  for(const changes of [{ref:'refs/heads/other'},{repository_id:'1'},{repository_owner_id:'1'},{aud:'elsewhere'},{event_name:'pull_request'},{exp:START/1000},{workflow_ref:'other'},{nbf:START/1000+60}]) {
    const req=await request(changes);await assert.rejects(()=>summaryCollectorIdentity(req,options));
  }
  const req=await request({}); const raw=req.headers.get('authorization');
  const tampered=new Request(SUMMARY_ORIGIN,{headers:{authorization:raw.slice(0,-8)+'AAAAAAAA'}});
  await assert.rejects(()=>summaryCollectorIdentity(tampered,options));
});

test('collector refreshes membership even during quota cooldown and stops after one source refusal', async () => {
  let requests=0,opened=0;const calls=[];
  const stopped=await runSummaryCollection({inventory:async()=>inventory(),client:async input=>{calls.push(input);return {state:{cooldownUntil:iso(START+60000)}};},openSession:async()=>{opened++;},now:()=>START});
  assert.equal(stopped.reason,'source-cooldown');assert.equal(opened,0);assert.equal(calls[0].action,'sync');
  assert.equal(stopped.cooldownUntil,iso(START+60000),'the next automatic eligibility is visible without opening a source session');
  const failed=[];
  await assert.rejects(()=>runSummaryCollection({inventory:async()=>inventory(),client:async input=>{
    failed.push(input.action);if(input.action==='sync') throw Error('capacity');return {ok:true};
  },openSession:async()=>{opened++;}}));
  assert.deepEqual(failed,['sync','discovery-failed']);assert.equal(opened,0);
  const actions=[];
  const result=await runSummaryCollection({inventory:async()=>inventory(),client:async input=>{actions.push(input);if(input.action==='sync')return {state:{}};if(input.action==='reserve')return {reserved:true,requestId:input.requestId,token:'token',target:source(1)};return {ok:true};},
    openSession:async()=>({page:{},close:async()=>{}}),read:async()=>{requests++;throw Object.assign(Error(),{summaryCode:'rate-limited'});},now:()=>START});
  assert.equal(result.reason,'rate-limited');assert.equal(requests,1);assert.equal(actions.at(-1).outcome,'rate-limited');
  assert.equal(result.stage,'summary');assert.equal(result.httpStatus,null);
});

test('failure diagnostics distinguish login from summary refusals and exclude arbitrary source data', async () => {
  for(const stage of ['login','summary']) {
    const actions=[];
    const refused=Object.assign(summaryResponseError(403),{message:'PRIVATE MESSAGE',html:'PRIVATE HTML',token:'PRIVATE TOKEN'});
    const client=async input=>{actions.push(input.action);if(input.action==='sync')return {state:{}};
      if(input.action==='reserve')return {reserved:true,requestId:input.requestId,token:'token',target:source(1)};
      return {ok:true,saved:false};};
    const result=await runSummaryCollection({inventory:async()=>inventory(),client,
      openSession:async()=>{if(stage==='login')throw refused;return {page:{},close:async()=>{}};},
      read:async()=>{throw refused;},now:()=>START});
    assert.deepEqual(result,{saved:0,attempted:1,reason:'access-denied',stage,httpStatus:403});
    assert.deepEqual(actions,['sync','reserve','complete']);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
});

test('durable timer is read-only until armed and keeps recovery after dispatch failure', async () => {
  const backing=storage();const env={SCREENER_SUMMARIES_ENABLED:'true',GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main'};
  let now=START;const schedule=new ConcallSummarySchedule(backing,env,{now:()=>now,fetcher:async()=>{throw Error();}});
  assert.equal((await schedule.status()).alarmAt,null);await schedule.arm();assert.equal((await schedule.status()).alarmAt,now+30*60000);
  now+=30*60000;await schedule.wake();assert.equal((await schedule.status()).reason,'unavailable');assert.equal((await schedule.status()).alarmAt,now+30*60000);
  env.SCREENER_SUMMARIES_ENABLED='false';await schedule.wake();assert.equal((await schedule.status()).alarmAt,null);backing.db.close();
});

function timerHarness() {
  const backing = storage(), runs = new Map(), posts = [];
  const env = { SCREENER_SUMMARIES_ENABLED: 'true', GH_REPO: 'techmuns/Sattva-Central-Research', GH_REF: 'main', GH_DISPATCH_TOKEN: 'fixture' };
  let now = START, loseDispatch = false;
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    const workflow = parsed.pathname.split('/workflows/')[1]?.split('/')[0];
    assert([SUMMARY_WORKFLOW, SCREENER_CONCALL_WORKFLOW].includes(workflow));
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.ref, 'main'); posts.push({ workflow, ...body });
      if (loseDispatch) throw Error('Response lost after dispatch');
      return new Response(null, { status: 204 });
    }
    assert.equal(parsed.searchParams.get('branch'), 'main');
    const run = runs.get(workflow), status = parsed.searchParams.get('status');
    return Response.json({ workflow_runs: run && (!status || run.status === status) ? [run] : [] });
  };
  const schedule = () => new ConcallSummarySchedule(backing, env, { now: () => now, fetcher });
  return { backing, runs, posts, schedule, advance: ms => { now += ms; }, now: () => now,
    loseDispatch: () => { loseDispatch = true; },
    run: (status, age = 0, conclusion = 'success') => ({ id: 12, status, conclusion, created_at: iso(now - age) }) };
}

test('the armed timer refreshes the catalogue without a browser or cron and waits before starting summaries', async () => {
  const h = timerHarness();
  try {
    await h.schedule().arm(); h.advance(SUMMARY_INTERVAL_MS);
    await h.schedule().wake();
    assert.deepEqual(h.posts.map(post => post.workflow), [SCREENER_CONCALL_WORKFLOW]);
    assert.deepEqual(h.posts[0].inputs, { source: 'summary-timer', full: 'false' });
    assert.equal((await h.schedule().status()).alarmAt, h.now() + 2 * 60000);
    await h.schedule().wake(); assert.equal(h.posts.length, 1, 'duplicate delivery cannot dispatch twice');
    h.advance(2 * 60000); await h.schedule().wake();
    assert.equal(h.posts.length, 1, 'a delayed run listing cannot start another source job');
    assert.equal((await h.schedule().status()).reason, 'checking');
    h.runs.set(SCREENER_CONCALL_WORKFLOW, h.run('in_progress'));
    h.advance(2 * 60000); await h.schedule().wake();
    assert.equal(h.posts.length, 1, 'an active catalogue is awaited, not duplicated');
    assert.equal((await h.schedule().status()).dependency, 'catalogue');
    h.runs.set(SCREENER_CONCALL_WORKFLOW, h.run('completed', 2 * 60000, 'failure'));
    h.advance(2 * 60000); await h.schedule().wake();
    assert.deepEqual(h.posts.map(post => post.workflow), [SCREENER_CONCALL_WORKFLOW, SUMMARY_WORKFLOW]);
    assert.equal((await h.schedule().status()).dependency, null);
    assert.equal((await h.schedule().status()).alarmAt, h.now() + SUMMARY_INTERVAL_MS);
    // A workflow failure can carry a valid document checkpoint. Paid eligibility remains the
    // collector's separate digest, outcome, freshness, portfolio and durable-budget decision.
  } finally { h.backing.db.close(); }
});

test('recent run creation does not turn the half-hour timer into an hourly timer', async () => {
  const h = timerHarness();
  try {
    h.runs.set(SUMMARY_WORKFLOW, h.run('completed', SUMMARY_INTERVAL_MS - 2000));
    await h.schedule().wake();
    assert.equal(h.posts.length, 0);
    assert.equal((await h.schedule().status()).alarmAt, h.now() + 60000);
    h.runs.set(SCREENER_CONCALL_WORKFLOW, h.run('completed'));
    h.advance(60000); await h.schedule().wake();
    assert.deepEqual(h.posts.map(post => post.workflow), [SUMMARY_WORKFLOW]);
  } finally { h.backing.db.close(); }
});

test('catalogue dispatch uncertainty, invalid times and overdue runs preserve a bounded recovery alarm', async () => {
  for (const mode of ['lost-dispatch', 'invalid-time', 'overdue']) {
    const h = timerHarness();
    try {
      if (mode === 'lost-dispatch') h.loseDispatch();
      if (mode === 'invalid-time') h.runs.set(SCREENER_CONCALL_WORKFLOW, { ...h.run('completed'), created_at: null });
      if (mode === 'overdue') h.runs.set(SCREENER_CONCALL_WORKFLOW, h.run('in_progress', 46 * 60000));
      await h.schedule().wake();
      assert.equal(h.posts.length, mode === 'lost-dispatch' ? 1 : 0);
      assert(!h.posts.some(post => post.workflow === SUMMARY_WORKFLOW));
      const status = await h.schedule().status();
      assert.equal(status.alarmAt, h.now() + SUMMARY_INTERVAL_MS);
      assert.equal(status.reason, mode === 'overdue' ? 'run-overdue' : 'unavailable');
    } finally { h.backing.db.close(); }
  }
});

test('workflow is opt-in, main-only and has no public summary artifact or source-text publication', () => {
  const yaml=readFileSync(new URL('../.github/workflows/screener-summaries-refresh.yml',import.meta.url),'utf8');
  assert(yaml.includes(`cron: '${SUMMARY_CRON_OFFSET_MS/60000},${(SUMMARY_CRON_OFFSET_MS+SUMMARY_INTERVAL_MS)/60000} * * * *'`),
    'reader check-back times follow the actual independent workflow cadence');
  assert.match(yaml,/vars\.SCREENER_SUMMARIES_ENABLED == 'true'/);assert.match(yaml,/github.ref == 'refs\/heads\/main'/);
  assert.match(yaml,/family-book-updated/);assert.match(yaml,/cancel-in-progress: false/);assert(!yaml.includes('upload-artifact'));
});

test('the transport accepts the full 25,000-target inventory in bounded batches', async () => {
  const backing=storage(), store=new ConcallSummaryStore(backing,{now:()=>START}), plan=inventory(1);
  plan.targets=Array.from({length:25000},(_,index)=>({...plan.targets[0],id:String(index+1),rank:index,
    url:`https://www.screener.in/concalls/summary/${index+1}/`,sourceDocumentUrl:'https://example.test/'+ 'x'.repeat(300)}));
  assert(Buffer.byteLength(JSON.stringify(plan))>4*1024*1024,'fixture exceeds the rejected single-request boundary');
  let largest=0,batches=0;
  const client=summaryCollectorClient({env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://runner.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture'},fetcher:async(url,options)=>{
    if(url.includes('.actions.githubusercontent.com/')) return Response.json({value:'fixture-oidc'});
    largest=Math.max(largest,Buffer.byteLength(options.body));const input=JSON.parse(options.body);
    if(input.action==='sync-begin') return Response.json(store.beginInventory('1:1',input.syncId,input.manifest));
    if(input.action==='sync-batch') {batches++;return Response.json(store.inventoryBatch('1:1',input.syncId,input.offset,input.targets));}
    assert.equal(input.action,'sync-finish');return Response.json({ok:true,state:store.finishInventory('1:1',input.syncId)});
  }});
  try {
    const result=await client({action:'sync',inventory:plan});
    assert.equal(result.state.pending,25000);assert.equal(result.state.automatedRequestsLast24h,0);
    assert.equal(batches,Math.ceil(25000/SUMMARY_INVENTORY_BATCH));assert(largest<SUMMARY_TRANSPORT_LIMIT);
  } finally {backing.db.close();}
});

test('partial, conflicting and replayed inventory batches cannot publish a partial portfolio', () => {
  const backing=storage();let now=START;const store=new ConcallSummaryStore(backing,{now:()=>now});store.sync(inventory(2));
  const claim=store.reserve('1:1',randomUUID());complete(store,claim);
  const next=inventory(251),{targets,...manifest}=next,syncId=randomUUID();
  store.beginInventory('2:1',syncId,{...manifest,targetCount:targets.length});
  store.inventoryBatch('2:1',syncId,250,targets.slice(250));
  assert.throws(()=>store.finishInventory('2:1',syncId),/incomplete/);
  assert.equal(store.status().holdings.length,2);assert.equal(store.read(['1'])[0].status,'ready');
  assert.throws(()=>store.inventoryBatch('3:1',syncId,0,targets.slice(0,250)),/unavailable/);
  store.inventoryBatch('2:1',syncId,0,targets.slice(0,250));
  store.inventoryBatch('2:1',syncId,0,targets.slice(0,250));
  assert.throws(()=>store.inventoryBatch('2:1',syncId,250,[{...targets[250],name:'Changed'}]),/changed/);
  assert.equal(store.finishInventory('2:1',syncId).holdings.length,251);
  assert.equal(store.finishInventory('2:1',syncId).holdings.length,251);
  assert.equal(store.read(['1'])[0].status,'ready');
  const interrupted=randomUUID();store.beginInventory('2:1',interrupted,{...manifest,targetCount:targets.length});
  now+=16*60000;assert.equal(store.status().discoveryStatus,'failed');
  assert.throws(()=>store.finishInventory('2:1',interrupted),/unavailable/);
  backing.db.close();
});

test('scheduler failures are visible immediately even while source coverage is fresh', () => {
  const state={enabled:true,discoveryStatus:'ok',ready:2,pending:1,schedule:{started:true,alarmAt:START+60000}};
  for(const reason of ['unavailable','recent-run-failed','run-overdue']) {
    const failed={...state,schedule:{...state.schedule,reason}};
    assert(summaryScheduleMessage(failed,START));
    assert(summaryStateMessage(failed).includes(summaryScheduleMessage(failed,START)));
  }
  assert.equal(summaryScheduleMessage(state,START),'');
  assert.match(summaryScheduleMessage({...state,schedule:{started:true,alarmAt:null}},START),/no next check/);
  assert.match(summaryScheduleMessage({...state,schedule:{started:true,alarmAt:START-6*60000}},START),/overdue/);
  assert.equal(summaryScheduleMessage({...state,enabled:false},START),'');
});

test('each durable reservation allows exactly one main-frame summary navigation', () => {
  const gate=summaryNavigationGate(), target={id:'123',url:'https://www.screener.in/concalls/summary/123/'};
  assert.equal(gate.accept(target.url,'document',true),false);
  gate.arm(target);
  assert.equal(gate.accept(target.url,'stylesheet',true),false);
  assert.equal(gate.accept(target.url,'document',false),false);
  assert.equal(gate.accept('https://www.screener.in/concalls/summary/124/','document',true),false);
  assert.equal(gate.accept(target.url,'document',true),true);
  assert.equal(gate.accept(target.url,'document',true),false,'automatic reload cannot spend another request');
  assert.equal(gate.accept('https://www.screener.in/concalls/summary/124/','document',true),false,'redirects cannot spend another request');
  gate.arm(target);assert.equal(gate.accept(target.url,'document',true),true,'only a new durable claim can re-arm a source read');
});

test('a source cooldown never masks failed or stale portfolio discovery', () => {
  for(const discoveryStatus of ['failed','stale']) {
    const text=summaryStateMessage({enabled:true,discoveryStatus,cooldownUntil:iso(Date.now()+SUMMARY_WINDOW_MS),
      schedule:{started:true,alarmAt:Date.now()+1800000}});
    assert.match(text,/new holdings or calls/i);assert.match(text,/paused/);
    assert.match(text,discoveryStatus==='stale'?/stale/:/could not be refreshed/);
  }
});
