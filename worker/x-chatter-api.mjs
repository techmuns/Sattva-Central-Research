// Only the documented, public-post API. Never a browser session/cookie fallback.
export class XReadError extends Error {
  constructor(code, retryAt = null) { super(code); this.code = code; this.retryAt = retryAt; }
}

export async function boundedJson(response, maxBytes = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new XReadError('invalid-response');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new XReadError('invalid-response');
      chunks.push(value);
    }
  } catch (err) { await reader.cancel().catch(() => {}); throw err; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new XReadError('invalid-response'); }
}

export function normaliseX(payload, limit, now) {
  if (!payload?.meta || !Number.isInteger(payload.meta.result_count) ||
      (payload.meta.result_count > 0 && !Array.isArray(payload.data)) ||
      (payload.data && !Array.isArray(payload.data))) throw new XReadError('invalid-response');
  if (payload.errors?.length && !payload.data?.length) throw new XReadError('partial-response');
  const users = new Map((payload.includes?.users || []).map((u) => [u.id, u]));
  const media = new Map((payload.includes?.media || []).map((m) => [m.media_key, m]));
  const posts = new Map(); let rejected = 0;
  for (const p of (payload.data || []).slice(0, limit)) {
    const author = users.get(p.author_id);
    const text = p.note_tweet?.text || p.text;
    const created = Date.parse(p.created_at);
    if (!/^\d{1,25}$/.test(p.id) || !/^[A-Za-z0-9_]{1,15}$/.test(author?.username || '') ||
        typeof text !== 'string' || !text.trim() || text.length > 30000 || !Number.isFinite(created) ||
        created > now + 60000 || created < now - 7 * 86400000) { rejected++; continue; }
    const images = (p.attachments?.media_keys || []).map((key) => media.get(key)).filter(Boolean)
      .map((m) => ({ type: m.type, url: safeMedia(m.type === 'photo' ? m.url : m.preview_image_url), alt: String(m.alt_text || '').slice(0, 2000) }))
      .filter((m) => m.url).slice(0, 4);
    posts.set(p.id, { id: p.id, text, createdAt: new Date(created).toISOString(),
      author: { name: String(author.name || author.username).slice(0, 150), username: author.username },
      url: `https://x.com/${author.username}/status/${p.id}`, images,
      editIds: (p.edit_history_tweet_ids || [p.id]).filter((id) => /^\d{1,25}$/.test(id)).slice(-10) });
  }
  return { posts: [...posts.values()], partial: Boolean(payload.meta.next_token || payload.errors?.length || rejected ||
    payload.meta.result_count !== (payload.data || []).length || (payload.data || []).length > limit),
    returned: payload.meta.result_count };
}

function safeMedia(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' ? u.href : null; }
  catch { return null; }
}

export async function searchRecent({ token, query, limit = 20, now = Date.now(), fetcher = fetch }) {
  const url = new URL('https://api.x.com/2/tweets/search/recent');
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', String(limit));
  url.searchParams.set('sort_order', 'recency');
  // Five seconds inside the seven-day boundary avoids a request ageing out in transit.
  url.searchParams.set('start_time', new Date(now - 7 * 86400000 + 5000).toISOString());
  url.searchParams.set('tweet.fields', 'created_at,author_id,attachments,note_tweet,edit_history_tweet_ids');
  url.searchParams.set('expansions', 'author_id,attachments.media_keys');
  url.searchParams.set('user.fields', 'name,username');
  url.searchParams.set('media.fields', 'type,url,preview_image_url,alt_text');
  let response;
  try { response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new XReadError('unavailable', now + 15 * 60000); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      const retry = response.headers.get('retry-after');
      const after = /^\d+$/.test(retry || '') ? now + Number(retry) * 1000 : Date.parse(retry);
      throw new XReadError('rate-limited', Math.max(now + 60000, reset || 0, after || 0));
    }
    if ([401, 402, 403].includes(response.status)) throw new XReadError('access-required');
    if (response.status >= 500) throw new XReadError('unavailable', now + 15 * 60000);
    throw new XReadError('request-rejected');
  }
  return normaliseX(await boundedJson(response), limit, now);
}
