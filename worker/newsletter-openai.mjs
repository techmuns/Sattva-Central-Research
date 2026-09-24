import { boundedJson } from '../public/js/data/family-book-contract.js';
export const NEWS_MODEL = 'gpt-6-luna';
export const NEWS_REVIEW_MODEL = 'gpt-6-sol';
// Standard, uncached USD/million tokens, checked 24 September 2026. No Batch/cache discount
// assumed. Requests stay well below the 272K long-context threshold and use no billable tools.
export const NEWS_PRICES = { 'gpt-6-luna': [0.10, 0.50], 'gpt-6-sol': [2, 10] };
export const openaiConfigured = env => typeof env?.OPENAI_API_KEY === 'string' && !!env.OPENAI_API_KEY.trim();
export const newsAiEnabled = env => openaiConfigured(env) || env?.NEWSLETTER_NEWS_AI_PROVIDER === 'openai';
const failure = reason => Object.assign(new Error(reason), { reason });
export const objectSchema = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const stringSchema = { type: 'string' };
export async function newsModelCall({ env, fetcher = fetch, budget, job, now = Date.now(), model = NEWS_MODEL, instructions, input, schema, maxOutput = 2200 }) {
  if (!openaiConfigured(env)) throw failure('no-key');
  if (!budget) throw failure('news-budget-unavailable');
  const prices = NEWS_PRICES[model];
  if (!prices) throw failure('unpriced-model');
  const body = { model, store: false, service_tier: 'default', reasoning: { effort: 'none' }, max_output_tokens: maxOutput,
    instructions, input: JSON.stringify(input), text: { format: { type: 'json_schema', name: 'news_result', strict: true, schema } } };
  // UTF-8 bytes are a conservative upper bound on text tokens. Include schema, framing and
  // ample protocol allowance and the maximum cache-write input rate. Missing usage/timeouts retain this whole reservation forever.
  const inputBound = new TextEncoder().encode(JSON.stringify(body)).length + 4096;
  if (inputBound > 180000) throw failure('too-large');
  const reservation = budget.reserve({ job, model, amount: Math.ceil(inputBound * prices[0] * 1.25 + maxOutput * prices[1]), now: budget.now ? budget.now() : now });
  if (!reservation.ok) throw failure(reservation.reason);
  let response;
  try {
    response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  } catch { throw failure('model-unreachable'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(response.status === 429 ? 'rate-limited' : [401,403].includes(response.status) ? 'refused' : 'model-upstream');
  }
  const reply = await boundedJson(response, 100000);
  const inputTokens = reply.usage?.input_tokens, outputTokens = reply.usage?.output_tokens;
  // Output usage includes reasoning tokens. Cache writes cost 1.25x input for these models.
  // Ignore read discounts; if cache-write detail is missing, price all input at the higher rate.
  const writes = reply.usage?.input_tokens_details?.cache_write_tokens;
  if ([inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    const writeTokens = Number.isSafeInteger(writes) && writes >= 0 && writes <= inputTokens ? writes : inputTokens;
    budget.settle(reservation.id, { amount: Math.ceil((inputTokens + writeTokens * 0.25) * prices[0] + outputTokens * prices[1]), input: inputTokens, output: outputTokens });
  }
  if (reply.status !== 'completed') throw failure('incomplete-response');
  const parts = (reply.output || []).flatMap(o => o.content || []);
  if (parts.some(p => p.type === 'refusal')) throw failure('model-refusal');
  try { return { data: JSON.parse(parts.filter(p => p.type === 'output_text').map(p => p.text).join('')), model }; }
  catch { throw failure('unreadable'); }
}
