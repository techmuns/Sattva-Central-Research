import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyCaptureDue, COMPANY_CAPTURE_INTERVAL_MS } from './check-company-capture-due.mjs';

const now = Date.parse('2026-09-08T06:00:00Z');
const checkpoint = (age) => ({ version: 1, companies: [{ ticker: 'TCS' }], sources: { announcements: {}, domestic: {} },
  lastRunAt: new Date(now - age).toISOString(), lastRunFinishedAt: new Date(now - age + 20 * 60000).toISOString() });
assert.equal(companyCaptureDue(checkpoint(3600000), { now }).due, false, 'frequent trade runs do not repeat recent company collection');
assert.equal(companyCaptureDue(checkpoint(COMPANY_CAPTURE_INTERVAL_MS), { now }).due, true, 'two-hour boundary is eligible');
assert.equal(companyCaptureDue(checkpoint(6 * 3600000), { now }).due, true, 'missed cron recovers on the next dispatch');
const beforeLongTrade = checkpoint(90 * 60000);
assert.equal(companyCaptureDue(beforeLongTrade, { now }).due, false);
assert.equal(companyCaptureDue(beforeLongTrade, { now: now + 45 * 60000 }).due, true,
  'a company capture becoming due during the trade lane must run when that lane finishes');
for (const value of [null, {}, { ...checkpoint(3600000), companies: [] }]) {
  assert.equal(companyCaptureDue(value, { now }).reason, 'missing-checkpoint');
}
for (const kind of ['announcements', 'domestic']) {
  for (const invalid of [undefined, null, [], 'invalid', true, 1]) {
    const recent = checkpoint(3600000);
    recent.sources[kind] = invalid;
    assert.equal(companyCaptureDue(recent, { now }).due, true,
      `a malformed or missing ${kind} source map cannot make a recent combined checkpoint fresh`);
  }
}
for (const invalid of [undefined, null, [], 'invalid', true]) {
  assert.equal(companyCaptureDue({ ...checkpoint(3600000), sources: invalid }, { now }).due, true);
}
for (const field of ['lastRunAt', 'lastRunFinishedAt']) {
  for (const value of [null, 'invalid', new Date(now + 1000).toISOString()]) {
    assert.equal(companyCaptureDue({ ...checkpoint(3600000), [field]: value }, { now }).due, true);
  }
}
assert.equal(companyCaptureDue({ ...checkpoint(3600000), lastRunFinishedAt: new Date(now - 7200000).toISOString() }, { now }).reason,
  'interrupted-capture', 'an older successful completion cannot hide a later interrupted run');

const scratch = mkdtempSync(join(tmpdir(), 'company-capture-due-'));
try {
  const path = join(scratch, 'index.json'), output = join(scratch, 'output');
  writeFileSync(path, JSON.stringify({ ...checkpoint(6 * 3600000),
    lastRunAt: new Date(Date.now() - 6 * 3600000).toISOString(),
    lastRunFinishedAt: new Date(Date.now() - 5 * 3600000).toISOString() }));
  execFileSync(process.execPath, ['scripts/check-company-capture-due.mjs', path], {
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.match(readFileSync(output, 'utf8'), /^due=true\nreason=capture-due\n$/);
  writeFileSync(path, '{broken'); writeFileSync(output, '');
  execFileSync(process.execPath, ['scripts/check-company-capture-due.mjs', path], {
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.match(readFileSync(output, 'utf8'), /^due=true\nreason=missing-checkpoint\n$/);
} finally { rmSync(scratch, { recursive: true, force: true }); }

const workflow = readFileSync('.github/workflows/insider-trades-refresh.yml', 'utf8');
const companyStep = workflow.slice(workflow.indexOf('- name: Capture company announcements'), workflow.indexOf('- name: Upload insider-trades data'));
assert.match(companyStep, /steps\.company_due\.outputs\.due == 'true'/);
assert(!companyStep.includes('github.event'), 'company recovery is eligible for cron and watchdog/manual dispatch alike');
assert.match(workflow, /ref: \$\{\{ github\.ref \}\}/, 'queued runs read the current branch checkpoint before deciding');
assert(workflow.indexOf('node scripts/check-company-capture-due.mjs') < workflow.indexOf('- name: Capture company announcements'));
const dueStep = workflow.slice(workflow.indexOf('- name: Check whether company filings are due'), workflow.indexOf('- name: Capture company announcements'));
assert(workflow.indexOf('- name: Check whether company filings are due') > workflow.indexOf('node scripts/scrape-screener-trades.mjs'));
assert(dueStep.includes('if: ${{ !cancelled() }}'), 'trade failure cannot prevent the independent company eligibility check');
console.log('PASS company capture cadence, missed-cron dispatch recovery, interrupted/corrupt/future checkpoints, CLI output and workflow eligibility');
