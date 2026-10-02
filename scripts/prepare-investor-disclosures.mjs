#!/usr/bin/env node
// Restore validated public checkpoints and an open capture PR without executing their code.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mergeFilings, sourceUrl } from './lib/shareholding-filings.mjs';
export const REPOSITORY = 'techmuns/Sattva-Central-Research';
export const CAPTURE_BRANCH = 'codex/investor-disclosures-capture';
export const CAPTURE_FILE = 'public/data/shareholding-filings.json.gz';
export const CAPTURE_FILES = [CAPTURE_FILE, 'public/data/public-holdings.json'];
const MAX_COMPRESSED = 24 * 1024 * 1024, MAX_EXPANDED = 256 * 1024 * 1024;
const runGh = (args) => execFileSync('gh', args, { maxBuffer: MAX_COMPRESSED, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
export function decodeArchive(bytes) {
  if (bytes.length > MAX_COMPRESSED) throw Error('Shareholding archive exceeds asset limit');
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }));
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.checkedAt)) || !Array.isArray(value.filings) || !Array.isArray(value.sources)) throw Error('Invalid shareholding archive');
  const ids = new Set();
  for (const f of value.filings) {
    if (!f.id || ids.has(f.id) || !['bse', 'nse-equities', 'nse-sme'].includes(f.sourceId)) throw Error('Invalid or duplicate filing identity');
    ids.add(f.id); if (f.sourceUrl) sourceUrl(f.sourceUrl);
    if (f.holders && (!Array.isArray(f.holders) || !/^IN[A-Z0-9]{10}$/.test(f.isin) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isFinite(Date.parse(f.checkedAt)) ||
      f.holders.some((h) => !Array.isArray(h) || !h[0] || !Number.isSafeInteger(h[1]) || h[1] < 0 || !Number.isFinite(h[2]) || h[2] < 0 || h[2] > 100 || !Number.isFinite(Date.parse(h[3]))))) throw Error('Invalid filing evidence');
  }
  return value;
}
export function mergeArchives(a, b) {
  if (!a) return b; if (!b) return a;
  const [older, newer] = Date.parse(a.checkedAt) <= Date.parse(b.checkedAt) ? [a, b] : [b, a];
  // The latest checkpoint supplies health; both contribute all previously captured versions.
  return { ...newer, ...mergeFilings(older, [], newer.filings, newer.sources, newer.checkedAt) };
}
export function validateCapturePr(pr) {
  if (pr.state !== 'OPEN' || pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner !== REPOSITORY ||
    pr.headRefName !== CAPTURE_BRANCH || pr.baseRefName !== 'main' || !/^[a-f0-9]{40}$/.test(pr.headRefOid || '') ||
    !pr.files?.length || pr.files.some((f) => !CAPTURE_FILES.includes(f.path))) throw Error('Refusing a PR outside the public capture scope');
  return pr;
}
export function prepareInvestorDisclosures({ repository, file = CAPTURE_FILE, run = runGh, currentRun = 0 } = {}) {
  if (repository !== REPOSITORY) throw Error('Unexpected repository');
  const json = (args) => JSON.parse(String(run(args)));
  let archive = existsSync(file) ? decodeArchive(readFileSync(file)) : null;
  const runs = json(['run', 'list', '--repo', repository, '--workflow', 'investor-disclosures-refresh.yml', '--branch', 'main', '--limit', '15', '--json', 'databaseId,headBranch,status,event']);
  for (const candidate of runs.filter((r) => r.databaseId !== currentRun && r.headBranch === 'main' && r.status === 'completed' && ['schedule', 'push', 'workflow_dispatch'].includes(r.event))) {
    const meta = json(['api', `repos/${repository}/actions/runs/${candidate.databaseId}`]);
    if (meta.path !== '.github/workflows/investor-disclosures-refresh.yml' || meta.head_repository?.full_name !== repository || meta.head_branch !== 'main') throw Error('Checkpoint run provenance mismatch');
    const artifacts = json(['api', `repos/${repository}/actions/runs/${candidate.databaseId}/artifacts`]).artifacts || [];
    if (!artifacts.some((a) => a.name === 'investor-disclosures-checkpoint' && !a.expired)) continue;
    const temp = mkdtempSync(join(tmpdir(), 'investor-checkpoint-'));
    try {
      run(['run', 'download', String(candidate.databaseId), '--repo', repository, '--name', 'investor-disclosures-checkpoint', '--dir', temp]);
      archive = mergeArchives(archive, decodeArchive(readFileSync(join(temp, 'shareholding-filings.json.gz'))));
    } finally { rmSync(temp, { recursive: true, force: true }); }
    break;
  }
  const pulls = json(['pr', 'list', '--repo', repository, '--base', 'main', '--head', CAPTURE_BRANCH, '--state', 'open', '--json', 'number']);
  if (pulls.length > 1) throw Error('Capture PR selection is ambiguous');
  if (pulls.length) {
    const pr = validateCapturePr(json(['pr', 'view', String(pulls[0].number), '--repo', repository, '--json', 'state,headRefOid,headRefName,headRepository,isCrossRepository,baseRefName,files']));
    // `raw`, never `raw+json`: gh treats a response it believes is JSON as text and rewrites its
    // control characters, so the gzip archive arrived as two bytes and "transform: short source
    // buffer", and every run from 25 September failed here while capture PR #289 stayed open.
    if (pr.files.some((f) => f.path === CAPTURE_FILE)) archive = mergeArchives(archive, decodeArchive(run(['api', `repos/${repository}/contents/${CAPTURE_FILE}?ref=${pr.headRefOid}`, '--header', 'Accept: application/vnd.github.raw'])));
  }
  if (archive) {
    const bytes = gzipSync(JSON.stringify(archive)); decodeArchive(bytes); writeFileSync(file, bytes);
  }
  return { restored: archive?.filings.length || 0, pendingPr: pulls[0]?.number || null };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || resolve(process.env.GITHUB_WORKSPACE || '') !== process.cwd()) throw Error('Preparation requires the main Actions workspace');
  console.log(prepareInvestorDisclosures({ repository: process.env.GITHUB_REPOSITORY, currentRun: Number(process.env.GITHUB_RUN_ID) }));
}
