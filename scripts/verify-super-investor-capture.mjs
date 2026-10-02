// Offline check of scripts/scrape-super-investors.mjs against a stand-in Worker: the real script,
// run as a child process with SI_BASE pointed at a local server, so the walk, the retry pass and
// the snapshot it writes are the ones the scheduled job runs. No egress and no upstream.
//
// What it holds the capture to:
// - a book the Worker served stale during the walk is asked again once its stale entry has expired,
//   and is captured when that answer is live;
// - a book still stale on the retry stays a named failure and the run exits non-zero;
// - a book that answered but is not a book is retried and does not count towards an outage;
// - an outage stops the retry pass after OUTAGE_STREAK failures in a row instead of spending a
//   deadline on every book;
// - Finology's decorated period labels ("Sep 2026%") pass through the whole script.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scrape-super-investors.mjs');
const RETRY_AFTER_MS = 300;

const book = (slug, quarters = ['Jun 2026', 'Mar 2026']) => ({
  ok: true, source: 'stand-in', fetchedAt: new Date().toISOString(), name: slug, slug,
  totalStocks: 1, quarters,
  holdings: [{ company: `Company of ${slug}`, quarterlyHoldings: Object.fromEntries(quarters.map((q, i) => [q, String(2 - i * 0.5)])), valueCr: 10 }],
});

// Each behaviour answers the n-th request (0-based) for its book.
const BEHAVIOURS = {
  live: (slug) => book(slug),
  decorated: (slug) => book(slug, ['Sep 2026%', 'Jun 2026%', 'Mar 2026%']),
  'stale-then-live': (slug, n) => (n === 0 ? { ...book(slug), stale: true, staleReason: 'timeout' } : book(slug)),
  'always-stale': (slug) => ({ ...book(slug), stale: true, staleReason: 'timeout' }),
  'bad-shape': (slug) => ({ ...book(slug), quarters: ['not a period'], holdings: [{ company: 'X', quarterlyHoldings: {} }] }),
};

async function run(plan) {
  const requests = {};
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let body;
    if (path === '/api/super-investors') {
      body = { ok: true, investors: Object.keys(plan).map((slug) => ({ name: slug, slug })) };
    } else {
      const slug = decodeURIComponent(path.replace('/api/super-investors/', ''));
      (requests[slug] ||= []).push(Date.now());
      body = BEHAVIOURS[plan[slug]](slug, requests[slug].length - 1);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'si-capture-'));
  const out = join(dir, 'super-investors.json');
  try {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, SI_BASE: `http://127.0.0.1:${server.address().port}`, SI_OUT: out,
        SI_CONCURRENCY: '1', SI_STALE_RETRY_AFTER_MS: String(RETRY_AFTER_MS), GITHUB_STEP_SUMMARY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, output, requests, snapshot: JSON.parse(readFileSync(out, 'utf8')) };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. Mixed: a stale book recovers on the retry; one stays stale; one is not a book.
{
  const { code, output, requests, snapshot } = await run({
    live: 'live', recovers: 'stale-then-live', stuck: 'always-stale', broken: 'bad-shape', decorated: 'decorated',
  });
  assert.equal(code, 1, `a remaining failure keeps the run red\n${output}`);
  assert.deepEqual(Object.keys(snapshot.books).sort(), ['decorated', 'live', 'recovers']);
  assert.equal(snapshot.failed.stuck?.reason, 'stale', 'a book stale on the retry stays a named stale failure');
  assert.equal(snapshot.failed.broken?.reason, 'shape');
  assert.equal(snapshot.failed.recovers, undefined, 'a recovered book is not left in the failures');
  assert.equal(requests.recovers.length, 2, 'the stale book is asked again once');
  assert.ok(requests.recovers[1] - requests.recovers[0] >= RETRY_AFTER_MS,
    `the retry waits for the Worker's stale entry to expire (${requests.recovers[1] - requests.recovers[0]}ms)`);
  assert.equal(requests.stuck.length, 2, 'a book still stale is asked twice and no more');
  assert.equal(requests.live.length, 1, 'a book captured on the walk is not asked again');
  assert.deepEqual(snapshot.books.decorated.quarters.slice(0, 2), ['Sep 2026', 'Jun 2026'], 'decorated labels are filed as periods');
  assert.equal(snapshot.lastAttempt.refreshed, 3);
  assert.equal(snapshot.lastAttempt.failed, 2);
}

// 2. An outage: every book stays stale, and the retry pass stops after five in a row.
{
  const plan = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`down${i + 1}`, 'always-stale']));
  const { code, output, requests, snapshot } = await run(plan);
  assert.equal(code, 1, 'an outage keeps the run red');
  assert.equal(Object.keys(snapshot.books).length, 0);
  assert.equal(Object.keys(snapshot.failed).length, 7);
  const retried = Object.values(requests).filter((times) => times.length === 2).length;
  assert.equal(retried, 5, 'the retry pass stops after five failures in a row');
  assert.match(output, /stopped after 5 failures in a row/);
}

// 3. Books that answered but are not books say nothing about the relay, so they never stop the pass.
{
  const plan = Object.fromEntries([...Array.from({ length: 6 }, (_, i) => [`odd${i + 1}`, 'bad-shape']), ['late', 'stale-then-live']]);
  const { code, requests, snapshot } = await run(plan);
  assert.equal(code, 1, 'the malformed books keep the run red');
  assert.ok(snapshot.books.late, 'a stale book after six malformed ones is still retried and captured');
  assert.equal(requests.late.length, 2);
  assert.equal(Object.values(snapshot.failed).filter((f) => f.reason === 'shape').length, 6);
}

// 4. Nothing failed: nothing is retried and the run is green.
{
  const { code, requests, snapshot } = await run({ one: 'live', two: 'decorated' });
  assert.equal(code, 0);
  assert.equal(snapshot.failedCount, 0);
  assert.ok(Object.values(requests).every((times) => times.length === 1));
}

console.log('PASS super-investor capture: stale books retried after the stale entry expires, still-stale books stay failures, outages stop the retry pass, malformed books never count as an outage, decorated period labels captured');
