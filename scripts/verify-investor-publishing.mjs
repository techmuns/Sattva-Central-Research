import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeArchive, mergeArchives, validateCapturePr, prepareInvestorDisclosures, REPOSITORY, CAPTURE_BRANCH, CAPTURE_FILE, CAPTURE_FILES } from './prepare-investor-disclosures.mjs';
import { publicRequestUrl, fetchPublic } from './capture-shareholdings.mjs';
const first = { version: 1, checkedAt: '2026-09-20T00:00:00Z', sources: [], filings: [{ id: 'one', sourceId: 'bse', bseCode: '123456', isin: 'INE000A01001', indexAsOf: '2026-06-30', asOf: '2026-06-30', status: 'parsed', sourceUrl: 'https://www.bseindia.com/filing.xml', checkedAt: '2026-09-20T00:00:00Z', sha256: 'a'.repeat(64), holders: [['Example Investor', 100, 1, '2026-06-30']] }] };
assert.deepEqual(decodeArchive(gzipSync(JSON.stringify(first))), first);
const later = { ...first, checkedAt: '2026-09-21T00:00:00Z', sources: [{ id: 'bse', ok: false, error: 'HTTP 403' }], filings: [{ ...first.filings[0], status: 'failed', holders: undefined, error: 'HTTP 403', sha256: undefined }, { id: 'two', sourceId: 'nse-sme', status: 'pending' }] };
const merged = mergeArchives(first, later);
assert.equal(merged.filings.find((f) => f.id === 'one').holders[0][1], 100);
assert.equal(merged.filings.find((f) => f.id === 'one').checkedAt, first.checkedAt);
assert.equal(merged.filings.find((f) => f.id === 'one').error, 'HTTP 403');
assert.equal(merged.filings.length, 2);
assert.equal(merged.sources[0].ok, false);
assert.deepEqual(mergeArchives(later, first), merged, 'restore order cannot overwrite the newest health');
const revised = mergeArchives(first, { ...first, checkedAt: later.checkedAt, filings: [{ ...first.filings[0], checkedAt: later.checkedAt, sha256: 'b'.repeat(64), holders: [['Example Investor', 110, 1.1, '2026-06-30']] }] });
assert.equal(revised.filings.length, 2, 'source revisions retain the prior dated version');
assert.throws(() => decodeArchive(gzipSync(JSON.stringify({ ...first, filings: [...first.filings, ...first.filings] }))), /duplicate/);
assert.throws(() => decodeArchive(gzipSync(JSON.stringify({ ...first, filings: [{ ...first.filings[0], holders: [['Example', -1, 2, '2026-06-30']] }] }))), /evidence/);
for (const url of ['http://www.bseindia.com/x', 'https://www.bseindia.com:444/x', 'https://user:pass@www.bseindia.com/x', 'https://example.com/x']) assert.throws(() => publicRequestUrl(url), /Unexpected/);
const realFetch = globalThis.fetch; let calls = 0;
try {
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.test/private' } }); };
  await assert.rejects(fetchPublic('https://www.bseindia.com/filing.xml'), /Unexpected/);
  assert.equal(calls, 1, 'redirect destination is refused before any request');
} finally { globalThis.fetch = realFetch; }
const pr = { state: 'OPEN', isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, headRefName: CAPTURE_BRANCH, baseRefName: 'main', headRefOid: 'c'.repeat(40), files: CAPTURE_FILES.map((path) => ({ path })) };
assert.equal(validateCapturePr(pr), pr);
assert.throws(() => validateCapturePr({ ...pr, files: [...pr.files, { path: 'worker/index.js' }] }), /scope/);
assert.throws(() => validateCapturePr({ ...pr, isCrossRepository: true }), /scope/);
const dir = mkdtempSync(join(tmpdir(), 'sattva-investor-publish-')), file = join(dir, 'archive.gz');
try {
  writeFileSync(file, gzipSync(JSON.stringify(first)));
  const run = (args) => {
    if (args[0] === 'run' && args[1] === 'list') return '[]';
    if (args[0] === 'pr' && args[1] === 'list') return '[{"number":12}]';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr);
    assert(args.includes(`repos/${REPOSITORY}/contents/${CAPTURE_FILE}?ref=${pr.headRefOid}`));
    assert(args.includes('Accept: application/vnd.github.raw') && !args.some((a) => /raw\+json/.test(a)),
      "the gzip archive is read raw, never through gh's JSON output sanitizer");
    return gzipSync(JSON.stringify(later));
  };
  assert.equal(prepareInvestorDisclosures({ repository: REPOSITORY, file, run }).restored, 2);
  assert.deepEqual(decodeArchive(readFileSync(file)), merged, 'pending capture PR history survives a branch refresh');
} finally { rmSync(dir, { recursive: true, force: true }); }
for (const path of CAPTURE_FILES) if (existsSync(path)) {
  assert(statSync(path).size < 24 * 1024 * 1024, `${path} fits the static asset ceiling`);
  if (path.endsWith('.gz')) decodeArchive(readFileSync(path));
}
const workflow = readFileSync(new URL('../.github/workflows/investor-disclosures-refresh.yml', import.meta.url), 'utf8');
assert(!/git push.*main|git commit/.test(workflow));
assert(workflow.indexOf('actions/upload-artifact') < workflow.indexOf('create-pull-request'), 'checkpoint is retained before publication');
assert(workflow.includes('cancel-in-progress: false'));
console.log('PASS public investor publication: bounded source hosts/redirects, retained history/revisions, failed reads, exact PR scope, checkpoint-first publishing and asset size');
