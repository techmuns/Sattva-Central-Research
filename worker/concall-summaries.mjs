import { SUMMARY_OBJECT, SUMMARY_ORIGIN, SUMMARY_TRANSPORT_LIMIT } from '../public/js/data/concall-summaries-shared.js';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { summaryCollectorIdentity, authoriseSummaryReader } from './concall-summary-auth.mjs';

import {preparedSummaries} from './summaries-github.mjs';

const reply = (body, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'private, no-store', vary: 'Authorization', 'x-content-type-options': 'nosniff',
} });
export async function handleConcallSummaries(request, env, { fetcher = fetch, now = Date.now } = {}) {
  const url = new URL(request.url);
  const collector = url.pathname === '/api/concall-summaries/collector';
  if (collector) {
    if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
    // Preview and local workflows cannot write into the production account's store.
    if (url.origin !== SUMMARY_ORIGIN) return reply({ ok: false, reason: 'not-enabled' }, 403);
    if (!env.SCREENER_SUMMARIES) return reply({ ok: false, reason: 'storage-unavailable' }, 503);
    let identity;
    try { identity = await summaryCollectorIdentity(request, { fetcher, now: now() }); }
    catch { return reply({ ok: false, reason: 'collector-identity' }, 403); }
    try {
      const input = await boundedJson(new Response(request.body), SUMMARY_TRANSPORT_LIMIT);
      if(input.action==='configuration')return reply({ok:true,enabled:env.SCREENER_SUMMARIES_ENABLED==='true'});
      const store = env.SCREENER_SUMMARIES.getByName(SUMMARY_OBJECT);
      if(input.action==='export')return reply(await store.summaryExport({table:input.table,cursor:input.cursor}));
      return reply({ok:false,reason:'github-actions-only'},410);
    } catch { return reply({ ok: false, reason: 'collection-state-unavailable' }, 503); }
  }
  if (!['GET', 'POST'].includes(request.method)) return reply({ ok: false, reason: 'method' }, 405);
  if ((request.headers.get('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    return reply({ ok: false, reason: 'origin' }, 403);
  const access = await authoriseSummaryReader(request, env, { fetcher });
  if (!access.ok) return reply(access, 401);
  try {
    const input=request.method==='POST'?await boundedJson(new Response(request.body),2048):null;
    if(request.method==='POST'&&!Array.isArray(input?.ids))throw Error('Private summary scope required');
    const prepared=await preparedSummaries(request,env,{ids:input?.ids??null,now:now()});
    if(prepared)return reply({ok:true,...prepared,...(request.method==='GET'?{enabled:env.SCREENER_SUMMARIES_ENABLED==='true'}:{})});
    if (!env.SCREENER_SUMMARIES) return reply({ ok: false, reason: 'storage-unavailable' }, 503);
    const store = env.SCREENER_SUMMARIES.getByName(SUMMARY_OBJECT);
    if (request.method === 'GET') return reply({ ok: true, ...await store.summaryStatus(), enabled: env.SCREENER_SUMMARIES_ENABLED === 'true' });
    return reply({ ok: true, records: await store.summaryRead(input.ids) });
  } catch { return reply({ ok: false, reason: 'summary-unavailable' }, 503); }
}
