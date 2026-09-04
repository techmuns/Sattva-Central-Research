import { validateFamilyBook, assertBookChange, assertRecentCheck, validateResolvedPortfolio, boundedJson } from '../public/js/data/family-book-contract.js';
import { resolvePortfolio } from './portfolio-resolver.mjs';

export const FAMILY_HOLDINGS_URL = 'https://sattva-family.pages.dev/api/research-holdings';

/** Shared by the Worker and scheduled sync. No fallback to sattvaData.ts. */
export async function fetchFamilyBook(token, fetcher = fetch) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Family holdings sync is not configured');
  const response = await fetcher(FAMILY_HOLDINGS_URL, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    // Workers rejects redirect:'error' before making a request. 'manual' never
    // forwards the credential to a redirect target; boundedJson rejects 3xx.
    redirect: 'manual', signal: AbortSignal.timeout(10000), cache: 'no-store',
  });
  const book = validateFamilyBook(await boundedJson(response));
  assertRecentCheck(book.checkedAt);
  if (book.storage !== 'shared') throw new Error('No active shared workbook; the built-in baseline is not a live portfolio');
  return book;
}

export async function handleFamilyPortfolio(request, env, fetcher = fetch) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);
  try {
    // Pages Functions cannot be a service-binding target. The fixed HTTPS route
    // has a read-only token; neither URL nor credential comes from the caller.
    const asset = async name => {
      const r = await env.ASSETS.fetch(new Request(new URL(`/data/${name}.json`, request.url)));
      return boundedJson(r, 2 * 1024 * 1024);
    };
    const [book, previous, scans, mc, universe] = await Promise.all([
      fetchFamilyBook(env.FAMILY_HOLDINGS_TOKEN, fetcher), asset('portfolio-companies'),
      asset('concall-scans'), asset('mc-ticker-map'), asset('universe'),
    ]);
    assertBookChange(book, previous);
    const resolved = await resolvePortfolio(book, { scans, mc, universe });
    return json(validateResolvedPortfolio({ ok: true, ...resolved, syncStatus: 'live' }));
  } catch {
    // Do not turn failure into a green response containing the old static book.
    return json({ ok: false, syncStatus: 'unavailable', error: 'Family Office holdings could not be verified. Showing the last saved portfolio, which may be out of date.' }, 503);
  }
}
