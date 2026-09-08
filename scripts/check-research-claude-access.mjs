#!/usr/bin/env node
// Read-only Anthropic access probe. Never print the key or upstream response body.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLAUDE_MODEL, claudeCredential } from '../worker/research-claude.mjs';

export function claudeKeyFormat(key) {
  const value = String(key || '').trim();
  if (!value) return 'missing';
  if (/^(["'])sk-ant-[\s\S]*\1$/.test(value)) return 'quoted-Anthropic-value';
  if (/^[A-Z_]+\s*=/.test(value)) return 'environment-assignment';
  if (/^Bearer\s/i.test(value)) return 'Bearer-prefixed-value';
  if (value.startsWith('sk-ant-oat')) return 'Claude-OAuth-token-shaped';
  if (value.startsWith('sk-ant-')) return 'Anthropic-key-shaped';
  if (value.startsWith('sk-or-')) return 'OpenRouter-key-shaped';
  if (value.startsWith('AIza')) return 'Google-key-shaped';
  return 'unrecognized';
}

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
  const credential = claudeCredential(process.env);
  const binding = String(process.env.CLAUDE_KEY || '').trim() ? 'CLAUDE_KEY' : 'CLAUDE_API_KEY';
  const result = await checkClaudeAccess(credential);
  const summary = `Claude environment check (${binding}): ${result.reason}${result.status ? ` (HTTP ${result.status})` : ''}. Stored format: ${claudeKeyFormat(credential)} (shape only, not proof of issuer or validity). Model: ${CLAUDE_MODEL}. This checks only the current process environment, not another secret store. No generation or deployment was performed.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (!result.ok) process.exitCode = 1;
}
