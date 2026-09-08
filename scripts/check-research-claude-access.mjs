#!/usr/bin/env node
// Read-only AWS Bedrock catalog-access probe. Never print the key or upstream response body.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLAUDE_MODEL, bedrockConfig, bedrockConfigured, claudeCredential } from '../worker/research-claude.mjs';

export function claudeKeyFormat(key) {
  const value = String(key || '').trim();
  if (!value) return 'missing';
  if (value.startsWith('ABSK')) return 'Bedrock-key-shaped';
  if (/^(["'])sk-ant-[\s\S]*\1$/.test(value)) return 'quoted-Anthropic-value';
  if (/^[A-Z_]+\s*=/.test(value)) return 'environment-assignment';
  if (/^Bearer\s/i.test(value)) return 'Bearer-prefixed-value';
  if (value.startsWith('sk-ant-oat')) return 'Claude-OAuth-token-shaped';
  if (value.startsWith('sk-ant-')) return 'Anthropic-key-shaped';
  if (value.startsWith('sk-or-')) return 'OpenRouter-key-shaped';
  if (value.startsWith('AIza')) return 'Google-key-shaped';
  return 'unrecognized';
}

export async function checkClaudeAccess(key, fetcher = fetch, env = {}) {
  const credential = String(key || '').trim();
  if (!credential) return { ok: false, reason: 'missing-key' };
  const config = bedrockConfig(env);
  if (!config) return { ok: false, reason: 'invalid-bedrock-config' };
  if (!bedrockConfigured({ ...env, CLAUDE_KEY: credential })) return { ok: false, reason: 'not-a-bedrock-api-key' };
  const model = config.model.replace(/^(?:global|us|eu|apac|au|jp)\./, '');
  try {
    const response = await fetcher(`https://bedrock.${config.region}.amazonaws.com/foundation-models/${encodeURIComponent(model)}`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${credential}` },
    });
    const verified = response.status === 200 && (await response.json().catch(() => null))?.modelDetails?.modelId === model;
    void response.body?.cancel().catch(() => {});
    return { ok: verified, status: response.status,
      reason: verified ? 'bedrock-catalog-access-verified-inference-not-tested'
        : response.status === 401 ? 'bedrock-authentication-rejected'
        : response.status === 403 ? 'bedrock-permission-denied'
        : response.status === 404 ? 'model-unavailable'
        : response.status === 429 ? 'rate-limited' : 'bedrock-unavailable-or-invalid-response' };
  } catch {
    return { ok: false, reason: 'request-failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const credential = claudeCredential(process.env);
  const binding = ['CLAUDE_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_API_KEY'].find(name => String(process.env[name] || '').trim()) || 'CLAUDE_KEY';
  const result = await checkClaudeAccess(credential, fetch, process.env);
  const summary = `AWS Bedrock environment check (${binding}): ${result.reason}${result.status ? ` (HTTP ${result.status})` : ''}. Stored format: ${claudeKeyFormat(credential)} (shape only, not proof of issuer or validity). Region: ${bedrockConfig(process.env)?.region || "invalid"}. Model: ${bedrockConfig(process.env)?.model || CLAUDE_MODEL}. This checks only the current process environment, not another secret store. No generation or deployment was performed.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (!result.ok) process.exitCode = 1;
}
