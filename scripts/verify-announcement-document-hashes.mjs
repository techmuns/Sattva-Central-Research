#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { enrichCrossExchangeDocumentHashes } from './lib/announcement-document-hashes.mjs';
import { mergeAnnouncements } from '../public/js/data/announcements-shared.js';

const bse = name => `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}.pdf`;
const nse = name => `https://nsearchives.nseindia.com/corporate/${name}.pdf`;
const bytes = value => Buffer.from(`%PDF-1.7\n${value}\n${'.'.repeat(80)}\n%%EOF\n`);
const digest = value => `sha256:${createHash('sha256').update(bytes(value)).digest('hex')}`;
const row = (ticker, source, time, url, extra = {}) => ({
  ticker, source, sources: [source], date: '2026-09-01', time, url,
  title: `${ticker} filing`, ...extra,
});
const response = value => new Response(bytes(value), {
  headers: { 'content-type': 'application/pdf', 'content-length': String(bytes(value).length) },
});

{
  const input = [row('KISSHT', 'BSE', '15:46:24', bse('kissht')), row('KISSHT', 'NSE', '15:56:52', nse('kissht'))];
  const calls = [];
  const result = await enrichCrossExchangeDocumentHashes(input, {
    fetcher: async (url, init) => { calls.push([url, init]); return response('same filing'); },
  });
  assert.equal(result.candidatePairs, 1);
  assert.equal(result.compared, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.different, 0);
  assert.equal(result.hashed, 2);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 2);
  assert(calls.every(([, init]) => init.signal instanceof AbortSignal));
  assert.equal(calls[0][1].headers.referer, 'https://www.bseindia.com/');
  assert.equal(calls[1][1].headers.referer, 'https://www.nseindia.com/');
  assert.equal(result.rows[0].documentHash, digest('same filing'));
  assert.equal(result.rows[1].documentHash, result.rows[0].documentHash);
  assert.match(result.rows[0].crossExchangeDocumentId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.rows[1].crossExchangeDocumentId, result.rows[0].crossExchangeDocumentId);
  assert.equal(result.rows[0].crossExchangeObservations.length, 2);
  assert.equal(input[0].documentHash, undefined, 'enrichment never mutates the caller records');
  const merged = mergeAnnouncements(result.rows);
  assert.equal(merged.length, 1, 'equal exchange documents can be presented once');
  assert.deepEqual(merged[0].sources, ['BSE', 'NSE']);
}

{
  const first = await enrichCrossExchangeDocumentHashes([
    row('INCREMENTAL', 'BSE', '10:00:00', bse('incremental-first')),
    row('INCREMENTAL', 'NSE', '10:01:00', nse('incremental-first')),
  ], { fetcher: async () => response('incremental shared bytes') });
  const previouslyMerged = mergeAnnouncements(first.rows);
  assert.equal(previouslyMerged.length, 1);
  assert.equal(previouslyMerged[0].crossExchangeObservations.length, 2,
    'a merged row retains both independently reconstructable source observations');

  let calls = 0;
  const reconsidered = await enrichCrossExchangeDocumentHashes([
    ...previouslyMerged,
    row('INCREMENTAL', 'BSE', '10:02:00', bse('incremental-late-third')),
  ], { fetcher: async () => { calls++; return response('incremental shared bytes'); } });
  assert.equal(calls, 1, 'the retained source observations reuse their hashes; only the late PDF is read');
  assert.equal(reconsidered.rows.length, 3, 'the old merged pair is reconstructed before the late row is compared');
  assert.equal(reconsidered.candidatePairs, 2);
  assert.equal(reconsidered.matched, 0);
  assert.equal(reconsidered.ambiguous, 3);
  assert(reconsidered.rows.every(value => value.crossExchangeDocumentId == null));
  const final = mergeAnnouncements(reconsidered.rows);
  assert.equal(final.length, 3,
    'a late same-digest filing makes the cluster ambiguous and restores all three source records');
  assert.deepEqual(final.map(value => value.sources), [['BSE'], ['NSE'], ['BSE']]);

  const legacyMerged = { ...previouslyMerged[0] };
  delete legacyMerged.crossExchangeObservations;
  const legacy = await enrichCrossExchangeDocumentHashes([
    legacyMerged,
    row('INCREMENTAL', 'BSE', '10:02:00', bse('incremental-legacy-late-third')),
  ], { fetcher: async () => response('incremental shared bytes') });
  assert.equal(legacy.rows.length, 3);
  assert.equal(legacy.matched, 0);
  assert.equal(legacy.ambiguous, 3);
  assert.equal(mergeAnnouncements(legacy.rows).length, 3,
    'cryptographically valid legacy pairs are also reconstructed when a late filing arrives');
}

{
  const inputs = [
    row('DENSE', 'BSE', '10:00:00', bse('dense-a')),
    row('DENSE', 'BSE', '10:02:00', bse('dense-b')),
    row('DENSE', 'NSE', '10:01:00', nse('dense-a')),
    row('DENSE', 'NSE', '10:03:00', nse('dense-b')),
  ];
  const result = await enrichCrossExchangeDocumentHashes(inputs, {
    fetcher: async url => response(String(url).includes('dense-a') ? 'dense filing A' : 'dense filing B'),
  });
  assert.equal(result.eligible, 4);
  assert.equal(result.candidatePairs, 4, 'all four in-window cross-exchange comparisons are retained');
  assert.equal(result.fetched, 4);
  assert.equal(result.compared, 4);
  assert.equal(result.matched, 2, 'content resolves two matches even though timestamps alone are ambiguous');
  assert.equal(result.different, 2);
  assert.equal(result.ambiguous, 0);
  assert.equal(mergeAnnouncements(result.rows).length, 2);
}

{
  const inputs = [
    row('PARTIALDENSE', 'BSE', '10:00:00', bse('partial-dense-a')),
    row('PARTIALDENSE', 'NSE', '10:01:00', nse('partial-dense-a')),
    row('PARTIALDENSE', 'BSE', '10:02:00', bse('partial-dense-b')),
    row('PARTIALDENSE', 'NSE', '10:03:00', nse('partial-dense-b')),
  ];
  const result = await enrichCrossExchangeDocumentHashes(inputs, {
    maxDownloads: 2, fetcher: async () => response('temporarily unique-looking bytes'),
  });
  assert.equal(result.hashed, 2);
  assert.equal(result.matched, 0);
  assert.equal(mergeAnnouncements(result.rows).length, 4,
    'a resolved equal pair stays separate until every competing in-window neighbour has a digest');
}

{
  const inputs = [
    row('REPEAT', 'BSE', '10:00:00', bse('repeat-a')),
    row('REPEAT', 'BSE', '10:02:00', bse('repeat-b')),
    row('REPEAT', 'NSE', '10:01:00', nse('repeat-a')),
    row('REPEAT', 'NSE', '10:03:00', nse('repeat-b')),
  ];
  const result = await enrichCrossExchangeDocumentHashes(inputs, { fetcher: async () => response('repeated bytes') });
  assert.equal(result.candidatePairs, 4);
  assert.equal(result.matched, 0);
  assert.equal(result.ambiguous, 4);
  assert.equal(mergeAnnouncements(result.rows).length, 4,
    'a repeated digest in a dense window cannot choose which exchange rows represent one event');
}

{
  const inputs = [
    row('ALPHA', 'BSE', '10:00:00', bse('first-bse')),
    row('ALPHA', 'NSE', '10:01:00', nse('first-nse')),
    row('ALPHA', 'BSE', '15:00:00', bse('second-bse')),
    row('ALPHA', 'NSE', '15:01:00', nse('second-nse')),
  ];
  const result = await enrichCrossExchangeDocumentHashes(inputs, { fetcher: async () => response('reused attachment bytes') });
  assert.equal(result.matched, 2);
  assert.notEqual(result.rows[0].crossExchangeDocumentId, result.rows[2].crossExchangeDocumentId,
    'each selected exchange pair has its own merge identity');
  assert.equal(mergeAnnouncements(result.rows).length, 2,
    'two same-day events survive when both reuse identical PDF bytes');
}

{
  const uuid = 'a1111111-1111-1111-1111-111111111111.pdf';
  const live = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${uuid}`;
  const history = `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${uuid}`;
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', live, { sourceUrls: [{ source: 'BSE', url: live }, { source: 'BSE', url: history }] }),
    row('ALPHA', 'NSE', '10:00:01', nse('same-bse-uuid')),
  ], { fetcher: async () => response('same moved attachment') });
  assert.equal(result.candidatePairs, 1, 'equivalent BSE live/history URLs remain eligible for comparison');
  assert.equal(result.matched, 1);
  assert.equal(mergeAnnouncements(result.rows).length, 1);
}

{
  const result = await enrichCrossExchangeDocumentHashes([
    row('KISSHT', 'BSE', '15:46:24', bse('changed')),
    row('KISSHT', 'NSE', '15:56:52', nse('changed')),
  ], { fetcher: async url => response(String(url).includes('bseindia') ? 'first filing' : 'changed filing') });
  assert.equal(result.compared, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.different, 1);
  assert.notEqual(result.rows[0].documentHash, result.rows[1].documentHash);
  assert.equal(mergeAnnouncements(result.rows).length, 2, 'changed exchange documents remain separate');
}

{
  let calls = 0;
  const far = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('far')),
    row('ALPHA', 'NSE', '11:00:01', nse('far')),
    row('BETA', 'BSE', '10:00:00', 'http://www.bseindia.com/unsafe.pdf'),
    row('BETA', 'NSE', '10:00:01', 'https://example.test/not-official.pdf'),
    row('GAMMA', 'BSE', '10:00:00', bse('not-a-pdf').replace('.pdf', '.zip')),
    row('GAMMA', 'NSE', '10:00:01', nse('not-a-pdf').replace('.pdf', '.zip')),
  ], { fetcher: async () => { calls++; return response('unreachable'); } });
  assert.equal(far.candidatePairs, 0);
  assert.equal(far.hashed, 0);
  assert.equal(calls, 0, 'far, non-PDF and unofficial URLs are never downloaded');
}

{
  let calls = 0;
  const redirected = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('redirect')),
    row('ALPHA', 'NSE', '10:00:01', nse('redirect')),
  ], { fetcher: async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://example.test/stolen.pdf' } });
  } });
  assert.equal(calls, 2);
  assert.equal(redirected.failed, 2);
  assert.deepEqual(redirected.failureReasons, { 'document-redirect-unofficial': 2 });
  assert.equal(mergeAnnouncements(redirected.rows).length, 2);
}

{
  let clock = 0, calls = 0;
  const limited = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('budget')),
    row('ALPHA', 'NSE', '10:00:01', nse('budget')),
  ], { concurrency: 1, budgetMs: 10, now: () => clock, fetcher: async () => {
    calls++; clock = 11; return response('first only');
  } });
  assert.equal(calls, 1);
  assert.equal(limited.deferredDownloads, 1);
  assert.equal(limited.matched, 0);
  assert.equal(mergeAnnouncements(limited.rows).length, 2, 'the time budget leaves unprocessed exchange rows intact');
}

{
  let calls = 0;
  const deferred = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('limit-a')),
    row('ALPHA', 'NSE', '10:00:01', nse('limit-a')),
    row('ALPHA', 'BSE', '15:00:00', bse('limit-b')),
    row('ALPHA', 'NSE', '15:00:01', nse('limit-b')),
  ], { maxDownloads: 2, fetcher: async () => { calls++; return response('same'); } });
  assert.equal(calls, 2);
  assert.equal(deferred.deferredPairs, 1);
  assert.equal(deferred.deferredDownloads, 2);
  assert.equal(deferred.nextPairOffset, 2);
  assert.equal(mergeAnnouncements(deferred.rows).length, 3, 'unprocessed pairs remain available for a later run');
}

{
  const inputs = [
    row('ALPHA', 'BSE', '10:00:00', bse('blocked-first')),
    row('ALPHA', 'NSE', '10:00:01', nse('blocked-first')),
    row('ALPHA', 'BSE', '15:00:00', bse('reachable-second')),
    row('ALPHA', 'NSE', '15:00:01', nse('reachable-second')),
  ];
  const first = await enrichCrossExchangeDocumentHashes(inputs, {
    maxDownloads: 2, fetcher: async () => new Response('blocked'),
  });
  assert.equal(first.matched, 0);
  const fetched = [];
  const second = await enrichCrossExchangeDocumentHashes(inputs, {
    maxDownloads: 2, pairOffset: first.nextPairOffset,
    fetcher: async url => { fetched.push(url); return response('reachable'); },
  });
  assert.equal(second.matched, 1);
  assert(fetched.every(url => String(url).includes('reachable-second')),
    'the persisted pair cursor lets later candidates progress past permanently blocked documents');
}

{
  let calls = 0;
  const tied = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('tie-a')),
    row('ALPHA', 'BSE', '10:00:00', bse('tie-b')),
    row('ALPHA', 'NSE', '10:00:00', nse('tie')),
  ], { fetcher: async () => { calls++; return response('unreachable'); } });
  assert.equal(tied.candidatePairs, 2);
  assert.equal(tied.ambiguous, 3);
  assert.equal(calls, 3, 'every official in-window candidate is hashed within the download cap');
  assert(tied.rows.every(item => item.documentHash));
  assert.equal(mergeAnnouncements(tied.rows).length, 3, 'a repeated digest group stays independent');
}

{
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('partial')),
    row('ALPHA', 'NSE', '10:00:05', nse('partial')),
  ], { fetcher: async url => String(url).includes('bseindia') ? response('readable') : new Response('<html>blocked</html>') });
  assert.equal(result.downloaded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failureReasons, { 'document-not-pdf': 1 });
  assert.equal(result.failedPairs, 1);
  assert.equal(result.compared, 0);
  assert.equal(result.rows[0].documentHash, digest('readable'));
  assert.equal(result.rows[1].documentHash, undefined);
  assert.equal(mergeAnnouncements(result.rows).length, 2, 'a failed counterpart cannot cause a merge');
}

{
  const shared = bse('cached-once');
  const inputs = [
    row('ALPHA', 'BSE', '10:00:00', shared), row('ALPHA', 'NSE', '10:00:01', nse('alpha')),
    row('BETA', 'BSE', '11:00:00', shared), row('BETA', 'NSE', '11:00:01', nse('beta')),
  ];
  const counts = new Map(), cache = new Map();
  let active = 0, peak = 0;
  const fetcher = async url => {
    counts.set(url, (counts.get(url) || 0) + 1);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return response('shared bytes');
  };
  const first = await enrichCrossExchangeDocumentHashes(inputs, { fetcher, concurrency: 2, cache });
  assert.equal(first.candidatePairs, 2);
  assert.equal(first.fetched, 3);
  assert.equal(first.matched, 2);
  assert.equal(counts.get(shared), 1, 'one URL is read once even when several rows reference it');
  assert(peak <= 2, 'document reads respect the configured concurrency bound');
  const second = await enrichCrossExchangeDocumentHashes(inputs, { fetcher, concurrency: 2, cache });
  assert.equal(second.fetched, 0, 'a supplied digest cache is reusable across enrichment passes');
  assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 3);
}

{
  const existing = digest('already read');
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('existing'), { documentHash: existing }),
    row('ALPHA', 'NSE', '10:00:01', nse('existing')),
  ], { fetcher: async () => response('already read') });
  assert.equal(result.fetched, 1);
  assert.equal(result.reused, 1);
  assert.equal(result.hashed, 1);
  assert.equal(result.matched, 1);
}

{
  const tooLarge = () => new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('%PDF-1.7\n123456789'));
    controller.close();
  } });
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('oversized')),
    row('ALPHA', 'NSE', '10:00:01', nse('oversized')),
  ], { maxBytes: 16, fetcher: async () => new Response(tooLarge()) });
  assert.equal(result.failed, 2, 'the streamed byte limit applies without Content-Length');
  assert.deepEqual(result.failureReasons, { 'document-too-large': 2 });
  assert.equal(result.hashed, 0);
  assert(result.rows.every(item => item.documentHash == null));
}

{
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('truncated')),
    row('ALPHA', 'NSE', '10:00:01', nse('truncated')),
  ], { fetcher: async () => new Response('%PDF-1.7', { headers: { 'content-length': '8' } }) });
  assert.equal(result.failed, 2);
  assert.deepEqual(result.failureReasons, { 'document-not-pdf': 2 });
  assert.equal(mergeAnnouncements(result.rows).length, 2, 'matching truncated placeholders never prove duplicate filings');
}

{
  const incomplete = Buffer.concat([bytes('valid first revision'), Buffer.from('INCOMPLETE UPDATE')]);
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('incomplete-update')),
    row('ALPHA', 'NSE', '10:00:01', nse('incomplete-update')),
  ], { fetcher: async () => new Response(incomplete) });
  assert.equal(result.failed, 2);
  assert.deepEqual(result.failureReasons, { 'document-not-pdf': 2 });
  assert.equal(mergeAnnouncements(result.rows).length, 2,
    'an earlier EOF followed by an incomplete appended revision cannot prove matching documents');
}

{
  const complete = bytes('length mismatch');
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('short-body')),
    row('ALPHA', 'NSE', '10:00:01', nse('short-body')),
  ], { fetcher: async () => new Response(complete, { headers: { 'content-length': String(complete.length + 1) } }) });
  assert.equal(result.failed, 2);
  assert.deepEqual(result.failureReasons, { 'document-length-mismatch': 2 });
}

{
  let cancelled = 0;
  const result = await enrichCrossExchangeDocumentHashes([
    row('ALPHA', 'BSE', '10:00:00', bse('declared-oversized')),
    row('ALPHA', 'NSE', '10:00:01', nse('declared-oversized')),
  ], { maxBytes: 16, fetcher: async () => ({
    ok: true,
    headers: new Headers({ 'content-length': '17' }),
    body: { cancel: async () => { cancelled++; } },
  }) });
  assert.equal(result.failed, 2, 'declared oversized documents are rejected before reading');
  assert.deepEqual(result.failureReasons, { 'document-too-large': 2 });
  assert.equal(cancelled, 2);
}

await assert.rejects(enrichCrossExchangeDocumentHashes([], { concurrency: 0 }), /Invalid concurrency/);
await assert.rejects(enrichCrossExchangeDocumentHashes({}, {}), /must be an array/);

console.log('PASS announcement PDF hashing: exact cross-exchange matches, ambiguity, bounds, failures and URL cache');
