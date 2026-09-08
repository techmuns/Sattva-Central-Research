#!/usr/bin/env node
// Refresh archive PRs from current main without losing records unique to their old head.
// Read only the guarded public JSON at that exact commit; never execute branch code.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TELEGRAM_LIMIT, TELEGRAM_REPO } from '../public/js/data/telegram-shared.js';
import { mergeTelegramRestore } from './telegram-artifact.mjs';

const FILE = 'public/data/telegram-posts.json';
const BRANCH = 'codex/telegram-capture';
const github = (args, maximum = 2 * 1024 * 1024) => execFileSync('gh', args, {
  encoding: 'utf8', maxBuffer: maximum, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
});
const json = text => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > TELEGRAM_LIMIT) throw Error('Archive exceeds the public capture limit');
  return JSON.parse(text);
};

export function prepareTelegramArchive({ repository, file = FILE, run = github, now = Date.now() } = {}) {
  if (repository !== TELEGRAM_REPO) throw Error('Unexpected archive repository');
  const pulls = JSON.parse(run(['pr', 'list', '--repo', repository, '--base', 'main', '--head', BRANCH,
    '--state', 'open', '--json', 'number']));
  if (!Array.isArray(pulls) || pulls.length > 1) throw Error('Archive PR selection is ambiguous');
  if (!pulls.length) return { existing: false };
  const number = pulls[0].number;
  if (!Number.isSafeInteger(number) || number <= 0) throw Error('Invalid archive PR number');
  const pr = JSON.parse(run(['pr', 'view', String(number), '--repo', repository, '--json',
    'state,headRefOid,headRefName,headRepository,isCrossRepository,baseRefName,files']));
  if (pr.state !== 'OPEN' || pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner !== repository ||
      pr.headRefName !== BRANCH || pr.baseRefName !== 'main' || !/^[a-f0-9]{40}$/.test(pr.headRefOid || '') ||
      !Array.isArray(pr.files) || pr.files.length !== 1 || pr.files[0].path !== FILE)
    throw Error('Refusing a PR outside the same-repository archive-only scope');
  const raw = run(['api', '--method', 'GET', `repos/${repository}/contents/${FILE}?ref=${pr.headRefOid}`,
    '--header', 'Accept: application/vnd.github.raw+json'], TELEGRAM_LIMIT);
  const merged = mergeTelegramRestore(json(readFileSync(file, 'utf8')), json(raw), now);
  const output = `${JSON.stringify(merged)}\n`;
  if (Buffer.byteLength(output) > TELEGRAM_LIMIT) throw Error('Merged archive exceeds the public capture limit');
  writeFileSync(file, output);
  return { existing: true, number, head: pr.headRefOid, retainedPosts: merged.posts.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== TELEGRAM_REPO ||
      resolve(process.env.GITHUB_WORKSPACE || '') !== process.cwd()) throw Error('Archive preparation requires the main Actions workspace');
  const result = prepareTelegramArchive({ repository: process.env.GITHUB_REPOSITORY });
  console.log(result.existing ? `Preserved ${result.retainedPosts} public posts including archive PR #${result.number}.` : 'No existing archive PR to preserve.');
}
