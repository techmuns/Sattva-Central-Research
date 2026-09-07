#!/usr/bin/env node
// Reproduce completion before a provider closes its transport, with no paid calls.
import assert from 'node:assert/strict';
import { handleResearch } from '../worker/research.mjs';
const encoder = new TextEncoder();
const frame = event => encoder.encode(JSON.stringify(event) + '\n');
const question = () => new Request('https://dashboard.example/api/research', { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Did JM Financial initiate coverage?', scope: 'portfolio', history: [], evidence: { sources: [] } }) });
const env = { MUNS_TOKEN: 'synthetic-test-credential' };
const answer = 'The supplied report says JM Financial initiated coverage. [Dashboard: News]';
const originalFetch = globalThis.fetch;
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Completed answer waited for provider transport shutdown')), 500); })]); }
  finally { clearTimeout(timer); }
};
try {
  for (const tail of ['open-connection', 'pending-cancel', 'late-error', 'malformed-tail', 'oversized-tail', 'same-chunk-error', 'same-chunk-oversized']) {
    let upstreamSignal, wasCancelled = false;
    globalThis.fetch = async (_url, options) => {
      upstreamSignal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          const extra = tail === 'same-chunk-error' ? JSON.stringify({ error: 'Late failure' }) + '\n' : tail === 'same-chunk-oversized' ? 'x'.repeat(64_001) : '';
          controller.enqueue(encoder.encode(JSON.stringify({ text: '<research-answer>' + answer + '</research-answer>' }) + '\n' + extra));
          if (tail === 'late-error') controller.enqueue(frame({ error: 'Failure after the final answer' }));
          if (tail === 'malformed-tail') controller.enqueue(encoder.encode('{malformed-tail}\n'));
          if (tail === 'oversized-tail') controller.enqueue(encoder.encode('x'.repeat(64_001)));
          // A provider can leave HTTP open after the answer is complete.
        },
        cancel() { wasCancelled = true; if (tail === 'pending-cancel') return new Promise(() => {}); },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
    };
    const response = await handleResearch(question(), env);
    const text = await bounded(response.text());
    const events = text.trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), answer);
    assert.deepEqual(events.filter(e => ['done', 'error'].includes(e.type)).map(e => e.type), ['done'], tail);
    assert(wasCancelled, 'release the provider reader after answer completion');
    assert(upstreamSignal.aborted, 'stop the upstream fetch after completion');
  }
  for (const stream of [
    frame({ text: '<research-answer>Partial answer without a closing marker' }),
    frame({ text: 'No final answer was framed' }),
    frame({ error: 'Provider failed before an answer' }),
    frame({ text: '<research-answer>Text</research-answer>', error: 'Provider explicitly failed this event' }),
  ]) {
    globalThis.fetch = async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    const events = (await (await handleResearch(question(), env)).text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'error');
    assert(!events.some(e => e.type === 'done'), 'a truncated answer never becomes a success');
  }
  console.log('PASS completed answers finish before connection/cancellation settlement; late transport failures cannot reverse completion; real truncation stays incomplete.');
} finally { globalThis.fetch = originalFetch; }
