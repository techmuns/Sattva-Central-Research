#!/usr/bin/env node
// Sattva-specific boundaries around the Glow source-reading upgrade. No external I/O.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { buildBrief, briefStories, readPerformance, readAiNotes, readableUrl, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';

const now = istInstant('2026-09-24', '08:00');
const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
  transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};
// The pre-upgrade schema has neither the new ledger nor PDF association columns.
db.exec(`CREATE TABLE newsletter_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE newsletter_deliveries(key TEXT PRIMARY KEY,edition TEXT NOT NULL,day TEXT NOT NULL,scheduled_at TEXT,started_at TEXT NOT NULL,finished_at TEXT,source TEXT NOT NULL,recipients INTEGER NOT NULL,sent INTEGER,failed INTEGER,reason TEXT,subject TEXT,outcomes TEXT,summary TEXT,stories TEXT);
 CREATE TABLE newsletter_documents(id TEXT PRIMARY KEY,filename TEXT NOT NULL,body BLOB NOT NULL,created_at TEXT NOT NULL);`);
const legacyKey = 'CEAT|NSE:https://nsearchives.nseindia.com/corporate/xbrl/CEAT_23092026_WebXMLFile.xml';
const putLegacy = (key, source, stories, at) => db.prepare('INSERT INTO newsletter_deliveries(key,edition,day,started_at,source,recipients,stories) VALUES (?,\'morning\',\'2026-09-24\',?,?,1,?)').run(key, new Date(at).toISOString(), source, JSON.stringify(stories));
putLegacy('confirmed-part', 'timer', [legacyKey], now - 86400000);
putLegacy('test-only', 'test', ['must-not-suppress'], now);
putLegacy('outside-retention', 'timer', ['old'], now - 11 * 86400000);
const id = '00000000-0000-4000-8000-000000000001';
db.prepare('INSERT INTO newsletter_documents VALUES (?,?,?,?)').run(id, 'sattva-saved.pdf', new Uint8Array([37,80,68,70]), new Date(now).toISOString());
const store = new NewsletterStore(storage, { now: () => now });
store.apply([{ op:'subscribe', email:'reader@example.test', by:'Fixture' }]);
assert.deepEqual([...store.sentStoryKeys()], [legacyKey]);
assert.equal(store.reportedLookup().has(legacyKey), true);
assert.equal(store.snapshot().count, 1);
assert.deepEqual([...store.document(id).body], [37,80,68,70]);
assert.equal(store.beginDelivery({ key:'confirmed-part', edition:'morning', day:'2026-09-24', source:'timer', recipients:1 }), false);
const restarted = new NewsletterStore(storage, { now: () => now });
assert.equal(restarted.reportedCount(), 1);
assert.deepEqual(restarted.document(id), store.document(id));
for (let i=0; i<4; i++) assert.equal(restarted.claimManualDelivery(now+i).ok, true);
assert.equal(restarted.claimManualDelivery(now+5).ok, false);
assert.equal(restarted.claimManualDelivery(now+3600000).ok, false, 'keep Sattva’s daily manual-send limit');

// An old sent-key alias still suppresses a late source after the in-place ledger migration.
const paths = {
  '/data/portfolio-companies.json': { holdings:[{ticker:'CEAT',name:'CEAT Limited'}] },
  '/data/nse-filings/index.json': { days:[{day:'2026-09-23'}] },
  '/data/nse-filings/2026-09-23.json': { rows:[{ticker:'CEAT',company:'CEAT Limited',subject:'Acquisition',description:'CEAT has informed the Exchange regarding Acquisition',url:legacyKey.split('|NSE:')[1],publishedAt:'2026-09-23T08:00:00Z'}] },
  '/data/corp-announcements.json': { byTicker:{} },
  '/data/market-news.json': { articles:[] },
  '/data/tradingview-news/latest.json': { entities:[],byTicker:{} },
};
const env = { ASSETS:{ async fetch(request) {
  const path = new URL(request.url).pathname;
  assert.notEqual(path, '/data/book.json');
  return paths[path] ? Response.json(paths[path]) : new Response('',{status:404});
} } };
const args = { env, edition:'morning',day:'2026-09-24',settings:DEFAULT_SETTINGS,now,includeAi:false,fetcher:async()=>new Response('',{status:503}) };
const sent = await buildBrief({...args,reported:store.reportedLookup()});
assert.equal(briefStories(sent).length, 0);
const pending = await buildBrief({...args,reported:{empty:false,since:now-2*86400000,has:()=>false}});
assert.equal(briefStories(pending).length, 1);
const wrapper = readableUrl(legacyKey.split('|NSE:')[1]);
assert.ok(wrapper.includes('/filing?src='));
assert.ok(wrapper.endsWith('&view=2'), 'preserve the released readable-filing version');
for (const output of [renderBriefHtml(pending), renderBriefText(pending), new TextDecoder().decode(renderBriefPdf(pending))]) {
  assert.ok(output.includes(wrapper) || output.includes(wrapper.replace(/&/g, '&amp;')), 'HTML, text and PDF retain the readable filing route');
  assert.ok(!/Glow Ventures|statement quantities|rupee day change/i.test(output));
}
const prices = await readPerformance({ env:{ ASSETS:{ fetch(){throw new Error('private book must never be read');} } },
  holdings:[{ticker:'CEAT',name:'CEAT Limited'},{ticker:'UNKNOWN',name:'Unknown'}],
  quotes:{state:'capture',session:'2026-09-23',rows:[{ticker:'CEAT',last:105,prev:100,pct:5}]} });
assert.equal(prices.quoted, 1); assert.equal(prices.unquoted, 1);
assert.equal(prices.summary.median, 5);
assert.ok(!Object.hasOwn(prices.rows[0], 'quantity'));
assert.ok(!Object.hasOwn(prices.summary, 'change'));

// The displayed AI denominator counts every eligible update, even beyond the batch limit.
const companies = Array.from({length:45},(_,i)=>({ticker:`X${i}`,company:`Company ${i}`,clusters:[{
  id:`X${i}#1`,kind:'story',main:{kind:'filing',headline:'Source report',content:{state:'ready',facts:[{field:'event',value:'A disclosed contract',quote:'A disclosed contract',location:'page 1'}]}},others:[],
}]}));
const notes = await readAiNotes({env:{CLAUDE_KEY:'ABSKfixture-only'},companies,now,fetcher:async (_url,init)=>{
  const items=JSON.parse(JSON.parse(init.body).messages[0].content).ITEMS;
  return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(items.map(i=>({id:i.id,summary:'A contract was disclosed.',impact:'It could support the business.'})))}]});
}});
assert.equal(notes.requested,45); assert.equal(notes.answered,40); assert.equal(notes.partial,true);
console.log('PASS: legacy migration, sent-key aliases, immutable PDFs, daily manual limits, readable filing links, private-book separation and truthful AI coverage');
