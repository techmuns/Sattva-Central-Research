import { FAMILY_HOLDINGS_URL } from './family-portfolio.mjs';
import { boundedJson, assertRecentCheck } from '../public/js/data/family-book-contract.js';
import { validPositionSizes } from '../public/js/data/position-sizes-contract.js';

export async function handleHoldingSizes(request, env, fetcher = fetch) {
  const json = (body, status = 200) => Response.json(body, { status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);
  try {
    const token = env.FAMILY_HOLDINGS_TOKEN;
    if (typeof token !== 'string' || token.length < 32) throw Error('Not configured');
    const startedAt = Date.now();
    const response = await fetcher(`${FAMILY_HOLDINGS_URL}?include=sizes`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    const body = await boundedJson(response, 1_500_000);
    const reply = body?.positionSizes;
    assertRecentCheck(body?.checkedAt);
    if (body?.ok !== true || body.storage !== 'shared' || !validPositionSizes(reply, startedAt) ||
        reply.sizes.valuation !== 'workbook' || reply.sizes.sourceRevision !== body.revision ||
        !/^[a-f0-9]{64}$/.test(body.revision || '')) throw Error('Invalid size reply');
    // Explicit projection: future source fields must never publish account data.
    const { basis, valuation, bookAsOf, checkedAt, archiveVersion, sourceRevision, complete, markedAt } = reply.sizes;
    return json({ sizes: { basis, valuation, bookAsOf, checkedAt, archiveVersion, sourceRevision, complete, markedAt },
      holdings: reply.holdings.map(({ isin, name, sector, ticker, weightPct }) => ({ isin, name, sector, ticker, weightPct })) });
  } catch {
    return json({ ok: false, error: 'Portfolio sizes could not be verified.' }, 503);
  }
}
