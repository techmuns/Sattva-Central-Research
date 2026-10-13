import { boundedJson } from '../public/js/data/family-book-contract.js';
import { WORKSPACE_OBJECT, WORKSPACE_BYTES } from '../public/js/data/workspace-shared.js';
import { revalidate, tagged, withTag } from './http.mjs';
const fail = (reason, status) => Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store' } });
export async function handleWorkspace(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  if (!env.SHARED_WATCHLIST) return fail('workspace-unavailable', 503);
  const store = env.SHARED_WATCHLIST.getByName(WORKSPACE_OBJECT);
  if (request.method === 'GET') {
    try {
      const { body, tag } = withTag({ ok: true, ...await store.workspaceSnapshot() });
      return revalidate(request, tagged(body, tag, 0, { 'cache-control': 'private, max-age=0, must-revalidate' }), 'shared');
    } catch { return fail('workspace-unavailable', 503); }
  }
  if (request.headers.get('origin') !== url.origin || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return fail('origin', 403);
  if (!env.SHARED_WATCHLIST_LIMITER) return fail('workspace-unavailable', 503);
  const limit = await env.SHARED_WATCHLIST_LIMITER.limit({ key: `workspace:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
  if (!limit.success) return fail('rate-limit', 429);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
  let input;
  try { input = await boundedJson(new Response(request.body), WORKSPACE_BYTES); } catch { return fail('invalid-request', 400); }
  try {
    const result = await store.workspaceApply(input);
    return Response.json({ ok: !['conflict', 'full', 'missing', 'capacity'].includes(result.outcome), ...result.snapshot, outcome: result.outcome }, { status: ['conflict', 'missing'].includes(result.outcome) ? 409 : ['full', 'capacity'].includes(result.outcome) ? 422 : 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return fail(/^Invalid workspace/.test(String(error?.message)) ? 'invalid-request' : 'workspace-unavailable', /^Invalid workspace/.test(String(error?.message)) ? 400 : 503); }
}
