#!/usr/bin/env node
// Read-only Anthropic access probe. Never print the key or upstream response body.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLAUDE_MODEL } from '../worker/research-claude.mjs';

export async function checkClaudeAccess(key, fetcher = fetch) {
  const credential = String(key || '').trim();
  if (!credential) return { ok: false, reason: 'missing-key' };
  try {
    const response = await fetcher(`https://api.anthropic.com/v1/models/${CLAUDE_MODEL}`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' },
    });
    await response.body?.cancel().catch(() => {});
    return { ok: response.status === 200, status: response.status,
      reason: response.status === 200 ? 'key-and-model-access-verified'
        : [401, 403].includes(response.status) ? 'authentication-or-permission-rejected'
        : response.status === 404 ? 'model-unavailable'
        : response.status === 429 ? 'rate-limited' : 'provider-unavailable' };
  } catch {
    return { ok: false, reason: 'request-failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkClaudeAccess(process.env.CLAUDE_API_KEY);
  const summary = `Claude GitHub secret check: ${result.reason}${result.status ? ` (HTTP ${result.status})` : ''}. Model: ${CLAUDE_MODEL}. No generation or deployment was performed.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (!result.ok) process.exitCode = 1;
}
