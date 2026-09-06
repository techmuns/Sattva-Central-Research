// worker/finology.mjs — the authenticated client for the Ticker Finology super-investor API.
//
//   fetchInvestorList(fetchImpl, token)              GET /super-investors
//   fetchInvestorPortfolio(fetchImpl, token, slug)   GET /super-investors/{slug}
//
// PURE AND DEPENDENCY-FREE. `fetch` is a parameter, exactly as worker/mc.mjs takes one, so the
// Worker, a Node script and a test can all use it without any of them disagreeing about shape.
// The shape guards themselves live in public/js/data/finology-shared.js and are imported here —
// same arrangement as stockscans-shared.js, so the browser and the Worker cannot drift about what
// a blank quarter means.
//
// THE UPSTREAM IS A LIVE SCRAPE OF finology.in, AND THAT SHAPES EVERY DECISION AROUND IT.
//   Each call makes their service go and read a page. So the route that uses this caches hard at
//   the edge (holdings move once a quarter, not once a minute), fetches one investor at a time
//   rather than fanning out over every investor on every visit, and degrades to "we could not
//   read this" rather than to a zero.
//
// FAILURES CARRY A `code`, because the fixes differ: `no-token` and `unauthorised` are a
// credential for the operator to renew, everything else is a service to wait for. The Worker
// route turns that code into something the panel can say out loud.

import { isSlug, normaliseList, normalisePortfolio, isPortfolioPayload } from '../public/js/data/finology-shared.js';

export { isSlug };

export const BASE = 'https://devde.muns.io';

// THE CEILING HAS TO MATCH THE RATIONALE, AND FOR A LONG TIME IT DID NOT.
//
// The comment here said "a short ceiling plus retries beats one long wait: the common bad case
// costs a couple of seconds rather than twenty" — and then set fifteen seconds across three
// attempts. With the backoff that is 15 + 0.4 + 15 + 1.2 + 15 = **46.6 seconds** of blank screen
// before the panel could say the upstream had not answered. That is not a couple of seconds, and
// it is the single slowest thing this dashboard was capable of doing.
//
// The service answers in about a second when healthy, so six seconds is six times the healthy
// latency and two attempts is enough to ride out a restart. `DEADLINE_MS` is the guarantee that
// matters: no call to this module can take longer than that, whatever the retry arithmetic says,
// so a route built on it always answers a reader inside a window they will wait through.
//
// Retrying hard into a struggling upstream also makes the struggle worse, and ninety books each
// retrying three times is ninety times the harm.
export const REQ_TIMEOUT_MS = 6000;
export const ATTEMPTS = 2;
export const DEADLINE_MS = 13000;
const BACKOFF_MS = [400];

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Conditions worth trying again: the host was unreachable, the request timed out, or a gateway
// reported the app as briefly unavailable. A 401 and a 404 are answers, not blips — retrying
// either just delays the same result.
const TRANSIENT = new Set(['unreachable', 'timeout']);
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated GET against the API.
 *
 * The token never leaves the Worker — see the route in worker/index.js. It is read from
 * `env.MUNS_TOKEN` and injected here; nothing in `public/` has ever seen it.
 *
 * `base` exists so local development and the verification suite can point at a stand-in. A run
 * that verified this integration against the real service would be scraping somebody else's
 * production on every push, and would need a live credential to do it.
 */
export async function call(fetchImpl, token, path, base = BASE, { missing = 'not-found', now = Date.now } = {}) {
  if (!token) throw fail('No API token is configured for the super-investor feed.', 'no-token');

  // The deadline is absolute and is the promise this function makes to its caller. Each attempt
  // gets whatever is left of it, so a slow first attempt shortens the second rather than being
  // added to it — which is how the old arithmetic reached forty-seven seconds.
  const startedAt = now();
  const left = () => DEADLINE_MS - (now() - startedAt);

  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const budget = Math.min(REQ_TIMEOUT_MS, left());
    if (budget <= 0) throw last || fail(`${base}${path} did not answer within ${DEADLINE_MS}ms.`, 'timeout');
    try {
      return await attemptCall(fetchImpl, token, path, base, missing, budget);
    } catch (e) {
      last = e;
      const retryable = TRANSIENT.has(e.code) || (e.code === 'upstream' && TRANSIENT_STATUS.has(e.status));
      if (!retryable || attempt === ATTEMPTS - 1) throw e;
      const backoff = BACKOFF_MS[attempt] ?? 400;
      // No point sleeping into a deadline that will have passed by the time we wake.
      if (left() - backoff <= 0) throw e;
      await sleep(backoff);
    }
  }
  throw last;
}

async function attemptCall(fetchImpl, token, path, base, missing, timeoutMs = REQ_TIMEOUT_MS) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = /timeout|abort/i.test(String(e?.name || e?.message || ''));
    throw fail(`Could not reach ${base}${path}: ${String(e.message || e)}`, timedOut ? 'timeout' : 'unreachable');
  }

  if (res.status === 401 || res.status === 403) {
    throw fail(`The super-investor API rejected the token (HTTP ${res.status}). It may have expired.`, 'unauthorised');
  }
  // A 404 means different things on the two routes, and conflating them sent a real diagnosis in
  // the wrong direction: the list route 404'd and the panel said "No such investor", which reads
  // as a data problem when in fact the endpoint was not deployed on that service at all. So the
  // caller says what a 404 means for the path it asked for.
  if (res.status === 404) {
    throw missing === 'route-missing'
      ? fail(`${base}${path} does not exist on that service — the endpoint is not deployed there.`, 'route-missing')
      : fail(`No such investor: ${path}`, 'not-found');
  }
  if (!res.ok) {
    const err = fail(`${path} returned HTTP ${res.status}`, 'upstream');
    err.status = res.status;
    throw err;
  }

  try {
    return await res.json();
  } catch {
    throw fail(`${path} did not return JSON`, 'shape');
  }
}

/**
 * GET /super-investors -> { count, dropped, investors: [{ name, slug, bio, imageUrl }] }
 *
 * A 404 here is `route-missing`, not `not-found`: there is no investor being looked up, so the
 * only thing a 404 can mean is that the endpoint is absent from the service being called.
 */
export async function fetchInvestorList(fetchImpl, token, base) {
  return normaliseList(await call(fetchImpl, token, '/super-investors', base, { missing: 'route-missing' }));
}

/** GET /super-investors/{slug} -> one investor's book, quarter by quarter. */
export async function fetchInvestorPortfolio(fetchImpl, token, slug, base) {
  if (!isSlug(slug)) throw fail(`"${slug}" is not a valid investor slug.`, 'bad-slug');
  const body = await call(fetchImpl, token, `/super-investors/${encodeURIComponent(slug)}`, base);
  if (!isPortfolioPayload(body, slug)) throw fail('The source returned an incomplete portfolio payload.', 'shape');
  return normalisePortfolio(body, slug);
}
