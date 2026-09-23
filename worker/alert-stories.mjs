import { boundedJson } from '../public/js/data/family-book-contract.js';
import { STORY_BYTES, STORY_INSTRUCTIONS, storyDigest, validateStoryRequest, validateStoryGroups } from '../public/js/data/alert-stories-shared.js';
import { bedrockConfig, bedrockConfigured, claudeCredential } from './research-claude.mjs';
import { STORY_OBJECT } from './alert-stories-store.mjs';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function handleAlertStories(request, env, { fetcher = fetch } = {}) {
  if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
  const url = new URL(request.url);
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')
    return reply({ ok: false, reason: 'origin' }, 403);
  if (!env.CAPTURE_REGISTRY || !bedrockConfigured(env)) return reply({ ok: false, reason: 'unavailable' }, 503);
  let input;
  try { input = validateStoryRequest(await boundedJson(new Response(request.body), STORY_BYTES)); } catch { /* Bounded malformed input fails closed. */ }
  if (!input) return reply({ ok: false, reason: 'input' }, 400);
  const key = await storyDigest(JSON.stringify(input));
  const store = env.CAPTURE_REGISTRY.getByName(STORY_OBJECT);
  let reserved;
  try { reserved = await store.storyReviewReserve(key); } catch { return reply({ ok: false, reason: 'unavailable' }, 503); }
  if (reserved.result) return reply(reserved.result);
  if (!reserved.token) return reply({ ok: false, reason: 'deferred', retryAfterMs: reserved.retryAfterMs }, 429);
  let result;
  try {
    const config = bedrockConfig(env);
    const response = await fetcher(config.url, { method: 'POST', redirect: 'manual',
      headers: { 'x-api-key': claudeCredential(env), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, max_tokens: 6000, thinking: { type: 'disabled' },
        system: [{ type: 'text', text: STORY_INSTRUCTIONS }], messages: [{ role: 'user', content: JSON.stringify(input) }] }),
      signal: AbortSignal.timeout(30000) });
    if (!response.ok) { await response.body?.cancel(); throw Error('upstream'); }
    const body = await boundedJson(response, 100000);
    if (body.stop_reason !== 'end_turn') throw Error('incomplete');
    const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const stories = validateStoryGroups(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), input.reports);
    if (!stories) throw Error('partition');
    result = { ok: true, stories };
  } catch { result = { ok: false, reason: 'unavailable', retryAfterMs: 300000 }; }
  try { await store.storyReviewComplete(key, reserved.token, result); } catch { return reply({ ok: false, reason: 'unavailable' }, 503); }
  return reply(result, result.ok ? 200 : 503);
}
