#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { storyRecord, storyKey, storyDigest, validateStoryRequest, validateStoryGroups, sameDevelopmentSafe } from '../public/js/data/alert-stories-shared.js';
import { createStoryGrouping, storyGrouping } from '../public/js/data/alert-stories.js';
import { AlertStoriesStore, STORY_DAILY_REQUESTS } from '../worker/alert-stories-store.mjs';
import { handleAlertStories } from '../worker/alert-stories.mjs';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
// Keep retention and archive receipts relative to the same fixture day, including future CI runs.
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-26T12:00:00Z') });
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
const { rankReport, materialEvidence, clearRankingCache, topEvidence, leadEvent } = await import('../public/js/data/ai-alerts.js');
const mute = await import('../public/js/core/ai-mute.js');
const { latestAlertSignal, latestAlertEvent, matchesSearch } = await import('../public/js/ui/ai-alert-utils.js');

const event = (id, headline = 'Alpha Bank proposes merger with Beta Bank', extra = {}) => ({ id, headline, company: 'Alpha Bank', ticker: 'ALPHA', day: '2026-09-23', time: '09:00',
  feed: 'news', feedLabel: 'Company news', url: `https://outlet-${id}.example/report`, detail: '', importance: 'high', direction: 'neutral',
  namesCompany: true, keywords: ['Merger'], attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed' }, ...extra });
const r = (e, i) => ({ ...storyRecord(e), id: `r${i}` });
const proposal = event('a'), copy = event('b', 'Alpha Bank plans merger with Beta Bank');
const approval = event('approval', 'RBI approves Alpha Bank merger with Beta Bank', { day: '2026-09-24' });
const terms = event('terms', 'Alpha Bank merger with Beta Bank: revised cash payment ₹500 crore', { day: '2026-09-25' });
const cancel = event('cancel', 'Alpha Bank cancels merger with Beta Bank', { day: '2026-09-26', direction: 'negative' });
assert(sameDevelopmentSafe(r(proposal, 0), r(copy, 1)));
for (const update of [approval, terms, cancel, event('corr', proposal.headline, { detail: 'Correction: the exchange ratio is 2 shares.' }),
  event('period', proposal.headline, { detail: 'Applies to financial year 2027.' }), event('figure', proposal.headline, { detail: 'Deal worth ₹100 crore.' })]) {
  assert(!sameDevelopmentSafe(r(proposal, 0), r(update, 1)), update.headline);
  assert.equal(validateStoryGroups([{ developments: [{ reports: ['r0', 'r1'], change: 'new' }] }], [r(proposal, 0), r(update, 1)]), null);
}
const pair = [r(proposal, 0), r(copy, 1)];
for (const bad of [[], [{ developments: [{ reports: ['r0'], change: 'new' }] }], [{ developments: [{ reports: ['r0', 'r0'], change: 'new' }] }],
  [{ developments: [{ reports: ['r0', 'r1', 'invented'], change: 'new' }] }]]) assert.equal(validateStoryGroups(bad, pair), null);
assert.equal(storyRecord(event('private', 'Private', { private: true })), null);
assert.equal(validateStoryRequest({ version: 1, reports: [r(proposal, 0), { ...r(copy, 1), time: '26:00' }] }), null);
console.log('PASS: complete partitions, cross-company boundaries, and new stages/figures/corrections cannot be merged as copies.');

// The response fixtures exercise the full client and server contract. They are not a model-accuracy claim.
const classify = reports => {
  const developments = new Map();
  for (const item of reports) {
    const change = /cancels/.test(item.headline) ? 'cancellation' : /completes/.test(item.headline) ? 'completion' : /RBI approves/.test(item.headline) ? 'approval' : /revised cash/.test(item.headline) ? 'terms' : 'new';
    const key = item.known?.development || change;
    if (!developments.has(key)) developments.set(key, { reports: [], change });
    developments.get(key).reports.push(item.id);
  }
  // New copies join a known proposed development; material developments keep separate keys.
  const fresh = developments.get('new');
  const prior = reports.find(item => item.known && /proposes|plans/.test(item.headline));
  if (fresh && prior) { developments.get(prior.known.development).reports.push(...fresh.reports); developments.delete('new'); }
  return [{ developments: [...developments.values()] }];
};
let requests = 0, saved = null;
const fetcher = async (_url, init) => { requests++; const body = JSON.parse(init.body); assert(validateStoryRequest(body)); return Response.json({ ok: true, stories: classify(body.reports) }); };
const reader = createStoryGrouping({ read: async () => saved, write: async (_key, entry) => { saved = structuredClone(entry); }, fetcher,
  now: () => Date.parse('2026-09-26T12:00:00Z') });
const hundred = Array.from({ length: 100 }, (_, i) => event(`publisher${i}`, i % 2 ? copy.headline : proposal.headline,
  { sourceRecord: { publisher: `Publisher ${i % 65 + 1}` } }));
await reader.review(hundred);
let grouped = reader.project(hundred);
assert.equal(grouped.length, 1); assert.equal(grouped[0].storyReports.length, 100); assert.equal(requests, 2);
assert.equal(reader.status(hundred).reviewed, 100);
const firstId = grouped[0].developmentId, firstStory = grouped[0].storyId;
const firstScore = materialEvidence(grouped);
await reader.review([...hundred].reverse()); assert.equal(requests, 2, 'unchanged inputs cost no request');
const late = event('late', copy.headline, { day: '2026-09-24', time: '15:00' });
await reader.review([...hundred, late]);
grouped = reader.project([...hundred, late]);
assert.equal(grouped.length, 1); assert.equal(grouped[0].developmentId, firstId);
assert.equal(grouped[0].day, '2026-09-23', 'a later outlet cannot advance source event time');
mute.hide('ALPHA', JSON.stringify(firstScore));
assert(mute.isHidden('ALPHA', JSON.stringify(materialEvidence(grouped))), 'another publisher cannot wake an archived development');
await reader.review([...hundred, late, approval, terms, cancel]);
grouped = reader.project([...hundred, late, approval, terms, cancel]);
assert.equal(grouped.length, 4); assert(grouped.every(e => e.storyId === firstStory));
assert(!mute.isHidden('ALPHA', JSON.stringify(materialEvidence(grouped))), 'material evolution restores the archived alert');
assert.equal(topEvidence({ events: grouped }, 4).length, 1, 'one story row, history keeps every development');
assert.equal(topEvidence({ events: grouped }, 4)[0].storyChange, 'cancellation');
assert.equal(latestAlertSignal({ events: grouped }).day, '2026-09-26');
assert.equal(grouped.at(-1).storyHistory.length, 3);
const quietApproval = { ...approval, importance: 'low' };
await reader.review([...hundred, quietApproval]);
const quietUpdate = reader.project([...hundred, quietApproval]);
mute.hide('ALPHA', JSON.stringify(firstScore));
assert(!mute.isHidden('ALPHA', JSON.stringify(materialEvidence(quietUpdate))), 'a checked material development wakes the story even with a low source tag');
assert.equal(latestAlertSignal({ events: quietUpdate }).day, quietApproval.day, 'a checked material development advances the reading order');
assert(matchesSearch({ sourceEvents: [...hundred, late, approval, terms, cancel] }, 'revised cash'));
const restored = createStoryGrouping({ read: async () => saved, write: async () => {}, fetcher: () => { throw Error('offline'); }, now: () => Date.parse('2026-09-26T12:00:00Z') });
await restored.load();
assert.equal(restored.project(hundred)[0].developmentId, firstId, 'reload restores identities');
assert.equal(restored.project(hundred)[0].storyHistory.length, 3, 'history survives different loaded scopes');
const beforeChecked = materialEvidence([hundred[0]]);
mute.hide('ALPHA', JSON.stringify(beforeChecked));
assert(mute.isHidden('ALPHA', JSON.stringify(materialEvidence(reader.project(hundred)))), 'finishing review does not resurface previously read facts');
const outage = createStoryGrouping({ read: async () => null, write: async () => {}, fetcher: async () => Response.json({ ok: false }, { status: 503 }) });
await outage.review([proposal, copy]);
assert.equal(outage.project([proposal, copy]).length, 2); assert(outage.status([proposal, copy]).partial);
assert(outage.status([event('large', 'x'.repeat(16001))]).partial, 'oversized unchecked text cannot claim complete grouping');
const sameUrlCorrection = event('a', proposal.headline, { detail: 'Correction: exchange ratio is 3 shares' });
assert.equal(outage.project([proposal, sameUrlCorrection]).length, 2, 'same URL never conceals a correction');
assert.equal(outage.project([event('money1','Alpha wins $100 million order'),event('money2','Alpha wins ₹100 million order')]).length,2,'currencies survive exact-copy filtering');
assert(!sameDevelopmentSafe(r(event('negative','Alpha earnings change -5%'),0),r(event('positive','Alpha earnings change +5%'),1)),'signed figures cannot merge');
// The source text itself is part of a receipt, including while semantic checking is unavailable.
mute.hide('ALPHA', JSON.stringify(materialEvidence([proposal])));
assert(!mute.isHidden('ALPHA', JSON.stringify(materialEvidence([sameUrlCorrection]))), 'same-title/body-only corrections must resurface immediately');
assert.equal(outage.project([event('type1', 'General Updates'), event('type2', 'General Updates')]).length, 2,
  'generic filing labels do not establish event identity');
const { writeEntry } = await import('../public/js/core/store.js');
const laterCompletion = event('completion', 'Alpha Bank completes merger with Beta Bank', { day: '2026-10-10', importance: 'low' });
await reader.review([laterCompletion]);
await writeEntry('ai-alerts:story-decisions:v1', saved);
await storyGrouping.load();
const rank = items => rankReport({ day: '2026-09-26', scope: 'portfolio', feeds: [{ id: 'news', status: 'ok', reachesToday: true }], events: items },
  { holdings: [{ ticker: 'ALPHA', name: 'Alpha Bank' }] });
const one = rank([hundred[0]]), many = rank([...hundred, late]);
assert.equal(one.cards[0].score, many.cards[0].score, 'a hundred copies do not inflate priority');
assert.equal(many.cards[0].events.length, 1);assert.equal(many.cards[0].sourceEvents.length, 101);
assert.equal(many.cards[0].contextEvents.length, 0, 'copies cannot return as related context');
const evolved = rank([...hundred, approval]);
assert.equal(evolved.cards[0].events.length, 2);
assert.match(evolved.cards[0].insight, /RBI approves/);
assert.match(rank([...hundred, quietApproval]).cards[0].insight, /RBI approves/, 'a low-tagged material development leads the claim');
assert.equal(evolved.cards[0].events.flatMap(e => e.storyReports).length, 101);
const outside = rankReport({ day: '2026-10-10', scope: 'portfolio', feeds: [{id:'news',status:'ok',reachesToday:true}], events: [late] },
  {holdings:[{ticker:'ALPHA'}]});
assert.equal(outside.cards.length,0,'old facts do not re-enter the review window');
for (const scope of ['portfolio', 'universe']) {
  const fresh = rankReport({ day: laterCompletion.day, scope, feeds: [{id:'news',status:'ok',reachesToday:true}], events: [laterCompletion] },
    {holdings: scope === 'portfolio' ? [{ticker:'ALPHA'}] : []});
  assert.equal(fresh.cards.length,1,'a low-tagged material development surfaces after all earlier evidence ages out');
  assert.equal(fresh.cards[0].priority,'important');
  assert.equal(fresh.cards[0].events[0].importance,'low','the original source tag stays intact');
  assert(fresh.cards[0].events[0].storyHistory.length > 0,'the original story remains accessible in history');
}
console.log('PASS: 100 reports from 65 outlets become one development; new facts resurface, late copies stay quiet, every source/history survives reload and failure.');

let clocklessSaved;
const clockless = createStoryGrouping({read: async()=>null,write:async(_key,value)=>{clocklessSaved=value;},fetcher,
  now:()=>Date.parse('2026-09-26T12:00:00Z')});
await clockless.review([proposal,copy]);
const noClockApproval = {...approval,day:proposal.day,time:null};
const noClockTerms = {...terms,day:proposal.day,time:null};
for (const update of [noClockApproval,noClockTerms]) {
  await clockless.review([update]);
  const events=clockless.project([proposal,noClockApproval,...(update===noClockTerms?[noClockTerms]:[])]);
  assert.equal(topEvidence({events},1)[0].headline,update.headline,'a same-day development with an unknown clock is visible');
  assert.equal(leadEvent({events}).headline,update.headline);
  assert.equal(latestAlertEvent({events}).headline,update.headline);
  assert.equal(latestAlertSignal({events}).time,null,'no publication time is invented');
}
const sequence=clockless.project([noClockTerms])[0].storySequence;
const termsCopy={...noClockTerms,url:'https://later-copy.example/terms',time:'16:00'};
await clockless.review([termsCopy]);
assert.equal(clockless.project([termsCopy])[0].storySequence,sequence,'a later copy cannot advance discovery order');
const clocklessRestored=createStoryGrouping({read:async()=>clocklessSaved,now:()=>Date.parse('2026-09-26T12:00:00Z')});
await clocklessRestored.load();
assert.equal(clocklessRestored.project([noClockTerms])[0].storySequence,sequence,'discovery order survives reload');
console.log('PASS: clockless same-day developments lead the story, without inventing publication times or advancing copies.');

const db = new DatabaseSync(':memory:');
const durable = { sql: { exec(query, ...args) { const statement = db.prepare(query); return { toArray: () => statement.all(...args) }; } }, transactionSync(fn) {
  db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
} };
let clock = Date.now();
const store = new AlertStoriesStore(durable, () => clock);
const key = await storyDigest('fixture');
const reservation = store.reserve(key); assert(reservation.token); assert(store.reserve(key).retryAfterMs > 0);
store.complete(key, reservation.token, { ok: true, stories: [] });
assert(store.reserve(key).result.ok, 'shared cache does not reserve another paid request');
for (let i = 1; i < STORY_DAILY_REQUESTS; i++) assert(store.reserve(`unique-${i}`).token);
assert(store.reserve('over-budget').retryAfterMs > 0);
assert(new AlertStoriesStore(durable, () => clock).reserve('after-restart').retryAfterMs > 0, 'budget survives a new instance');
clock += 86400001; assert(store.reserve('next-day').token);
const env = { CLAUDE_KEY: 'ABSKfixture-test-key', CAPTURE_REGISTRY: { getByName: () => ({ storyReviewReserve: key => store.reserve(key),
  storyReviewComplete: (key, token, result) => store.complete(key, token, result) }) } };
const body = { version: 1, reports: pair };
const request = (origin = 'https://dashboard.example') => new Request('https://dashboard.example/api/alert-stories', { method: 'POST',
  headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
let calls = 0;
const model = async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); assert(!init.body.includes('weightPct')); return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(classify(pair)) }] }); };
assert.equal((await handleAlertStories(request('https://foreign.example'), env, { fetcher: model })).status, 403);
assert((await (await handleAlertStories(request(), env, { fetcher: model })).json()).ok);
assert((await (await handleAlertStories(request(), env, { fetcher: model })).json()).ok); assert.equal(calls, 1);
console.log('PASS: same-origin route, exact-request cache, concurrent reservation and durable rolling request budget.');
mock.timers.reset();
