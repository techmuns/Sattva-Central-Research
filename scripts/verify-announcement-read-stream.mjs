// Local-only latency/validation oracle: the provider withholds its tail until the early read arrives.
import assert from 'node:assert/strict';
import { AnnouncementReadStore } from '../worker/announcement-read-store.mjs';
import { sqliteStorage } from './lib/announcement-test-server.mjs';
import { parseReadProgress, parseRead } from '../public/js/data/announcement-read-shared.js';
import { requestAnnouncementRead } from '../public/js/data/announcement-read-client.js';

const READING = { readable: true, issuerMatches: true, documentType: 'Order win', whatHappened: 'The company received a ₹245 crore order, conditional on approval.',
  keyDetails: [{ label: 'Value', value: '₹245 crore', quote: 'Order value: ₹245 crore', location: 'page 2' }],
  whyItMatters: 'The order could add revenue if approved and executed.', impact: { direction: 'positive', horizon: 'medium-term', text: 'Approval and execution remain conditions.' } };
const text = JSON.stringify(READING), cut = text.indexOf('"keyDetails"');
assert.equal(parseReadProgress(text.slice(0, cut - 2)), null, 'unfinished whatHappened never paints');
assert.equal(parseReadProgress(text.slice(0, cut)).whatHappened, READING.whatHappened);
assert.equal(parseReadProgress(text.replace('"issuerMatches":true', '"issuerMatches":false')), null);
assert.equal(parseReadProgress(text.replace('"readable":true', '"readable":false')), null);
assert.deepEqual(parseReadProgress(text).keyDetails, READING.keyDetails);
assert.equal(parseReadProgress(text.replace('₹245 crore', 'quoted \\"value\\"')).keyDetails.length, 1, 'escaped quotes and nested fields parse');

const encode = new TextEncoder();
const frame = (value) => encode.encode(`data: ${JSON.stringify(value)}\n\n`);
function provider(answer = READING, { gate = Promise.resolve(), stop = 'end_turn', truncate = false } = {}) {
  const full = JSON.stringify(answer), at = full.indexOf('"keyDetails"');
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(frame({ type: 'message_start', message: {} }));
    c.enqueue(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    const bytes = frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(0, at) } });
    // Split even UTF-8 code points, SSE delimiters and JSON escapes across network chunks.
    for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
    await gate;
    c.enqueue(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(at) } }));
    if (!truncate) {
      c.enqueue(frame({ type: 'content_block_stop', index: 0 }));
      c.enqueue(frame({ type: 'message_delta', delta: { stop_reason: stop } }));
      c.enqueue(frame({ type: 'message_stop' }));
    }
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

let release, modelCalls = 0, documentCalls = 0, options = {};
const gate = new Promise(done => { release = done; });
const fetcher = async (url, init) => {
  if (url.includes('bseindia.com')) { documentCalls++; return new Response('%PDF-1.7\nwhole document including annexure\n%%EOF'); }
  modelCalls++;
  const body = JSON.parse(init.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(atob(body.messages[0].content[0].source.data), '%PDF-1.7\nwhole document including annexure\n%%EOF');
  assert.match(body.system[0].text, /Read every page/);
  return provider(options.answer || READING, options);
};
const store = new AnnouncementReadStore(sqliteStorage(), { CLAUDE_KEY: 'ABSKfixture-key' }, { fetcher });
const item = { id: 'a:latency', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/latency.pdf', company: 'Fixture Co', ticker: 'FIXTURE' };
options = { gate };
const first = store.stream(item), reader = first.body.getReader();
let buffer = '', initial;
while (!initial?.reading) {
  buffer += new TextDecoder().decode((await reader.read()).value);
  initial = buffer.trim().split('\n').map(JSON.parse).find(e => e.reading);
}
assert.equal(initial.reading.whatHappened, READING.whatHappened, 'first useful section is available while the provider tail is held');
assert.equal(initial.reading.whyItMatters, undefined, 'investment analysis waits for final validation');
let finished = false;
const events = [];
let observed;
const observation = new Promise(done => { observed = done; });
const duplicate = store.read({ ...item, id: 'another-row' }, value => { events.push(value); observed(); }).then(result => { finished = true; return result; });
await observation;
assert.equal(finished, false);
assert.equal(events.at(-1).reading.whatHappened, READING.whatHappened, 'a later reader receives the current section immediately');
await reader.cancel();
release();
const result = await duplicate;
assert.equal(result.state, 'ready', JSON.stringify(result));
assert.deepEqual(result.reading, parseRead(text).reading);
assert.equal(modelCalls, 1); assert.equal(documentCalls, 1);
assert.equal(store.status().used, 1, 'both readers reserve only one attempt');
assert.equal((await store.read(item)).stored, true, 'closing a popup does not lose the saved read');
assert(result.timings.firstSectionMs <= result.timings.totalMs);

for (const [name, opts, reason] of [
  ['truncated', { truncate: true }, 'unreadable'], ['tokens', { stop: 'max_tokens' }, 'unreadable'],
  ['advice', { answer: { ...READING, impact: { ...READING.impact, text: 'Buy the stock now.' } } }, 'recommendation'],
  ['issuer', { answer: { ...READING, issuerMatches: false } }, 'issuer-mismatch'],
]) {
  options = opts;
  const value = await store.read({ ...item, url: item.url.replace('latency', name) });
  assert.equal(value.reason, reason);
  assert.equal(value.state, 'failed');
}
assert.equal(store.status().stored, 1, 'provisional/rejected answers never enter durable history');

// Browser transport: same document under different rows shares one request, then reopens locally.
const nativeFetch = globalThis.fetch;
let requests = 0, clientRelease;
const clientGate = new Promise(done => { clientRelease = done; });
globalThis.fetch = async () => {
  requests++;
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(encode.encode(`${JSON.stringify({ type: 'progress', stage: 'reading', reading: initial.reading })}\n`));
    await clientGate;
    c.enqueue(encode.encode(`${JSON.stringify({ type: 'result', ...result })}\n`)); c.close();
  } }), { headers: { 'content-type': 'application/x-ndjson' } });
};
try {
  let firstProgress;
  const a = requestAnnouncementRead(item, [], value => { firstProgress = value; });
  await new Promise(done => setTimeout(done, 0));
  assert(firstProgress.reading);
  let replay;
  const b = requestAnnouncementRead({ ...item, id: 'copy' }, [], value => { replay = value; });
  assert.equal(replay.reading.whatHappened, READING.whatHappened);
  clientRelease();
  assert.equal((await a).state, 'ready'); assert.equal((await b).state, 'ready');
  assert.equal((await requestAnnouncementRead(item)).state, 'ready');
  assert.equal(requests, 1);
  globalThis.fetch = async () => new Response(`${JSON.stringify({ type: 'progress', reading: initial.reading })}\n`, { headers: { 'content-type': 'application/x-ndjson' } });
  assert.equal((await requestAnnouncementRead({ ...item, url: item.url.replace('latency', 'lost') })).reason, 'read-unavailable', 'missing terminal event retracts provisional content');
} finally { globalThis.fetch = nativeFetch; }
console.log('PASS early useful sections with provider tail held; complete-document parity; issuer/EOF/truncation/advice rejection; shared flight, cancellation, saved reads and budget.');
