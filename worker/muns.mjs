// worker/muns.mjs — authenticated Muns market-data and company-document clients.
//
//   fetchNews({ query, country, fromDate, toDate }, env)
//   fetchAnnouncements({ ticker, fromDate, toDate }, env)
//   fetchInsiderTrades({ ticker, country, fromDate, toDate }, env)
//   fetchDomesticFilings({ ticker, form }, env)
//
// THE TOKEN LIVES HERE AND NEVER REACHES THE BROWSER. These endpoints want
// `Authorization: Bearer …`, so they are proxied, exactly as worker/finology.mjs already
// proxies the super-investor API on the same host. A token shipped to the client is a token
// published; there is no obfuscated version of that which is not that.
//
//   npx wrangler secret put MUNS_TOKEN     production
//   .dev.vars                              local, gitignored
//
// TWO HOSTS, AND POSSIBLY TWO CREDENTIALS. `devde.muns.io` (nestjs) is the host the Finology feed
// already authenticates against, so MUNS_TOKEN covers announcements and insider trades.
// `fastapi.muns.io` is a different service; if it needs its own token, set MUNS_NEWS_TOKEN and this
// will prefer it. Falling back to MUNS_TOKEN means one secret works when one secret is enough.
//
// THE CREDENTIAL IS A SESSION JWT, NOT AN API KEY. The datasource registry types it `bearer_jwt`,
// which means it EXPIRES — unlike a static key, a working deployment will start returning 401 on a
// day nobody changed anything. That is why `unauthorised` is its own named failure state all the
// way to the screen, and why the message names the command that fixes it. Do not treat a 401 here
// as a bug in the request.
//
// EVERY RESPONSE SHAPE HERE IS UNVERIFIED. None of these three could be probed while this was
// written — the only token available locally was a placeholder — so nothing downstream reads a
// guessed field name directly. Parsing goes through js/data/filings-shared.js, which reads by shape
// and by a list of candidate keys, and carries the untouched record alongside. See its header.

import { normaliseArticle, normaliseInsiderTrades, collectRecords } from '../public/js/data/filings-shared.js';
import { announcementRange, normaliseCorporateAnnouncements } from '../public/js/data/announcements-shared.js';
import { DOMESTIC_FORMS, normaliseDomesticFilings } from '../public/js/data/domestic-filings-shared.js';

export const FASTAPI_BASE = 'https://fastapi.muns.io';
export const NESTJS_BASE = 'https://devde.muns.io';
export const STOCK_SEARCH_BASE = 'https://birdnest.muns.io';

// A RETRY CEILING HAS TO MATCH ITS OWN RATIONALE, and this one did not.
//
// The registry's own numbers are 30s, 3 attempts, backoff factor 2 — which with the backoff is
// 30 + 1 + 30 + 2 + 30 = **93 seconds** before a failing company can say so. Measured, with the
// insider-trades upstream down: every ticker took 93.5s. The browser walks forty companies four at
// a time, so a dead upstream cost **fifteen and a half minutes** of a spinning strip over an empty
// table, and the scheduled scrape would spend fifteen hours on six hundred of them.
//
// So there is an absolute DEADLINE_MS, and it is the guarantee that matters: each attempt gets what
// is LEFT of it, so a slow first attempt shortens the second instead of being added to it. Same
// arrangement, and the same reasoning, as worker/finology.mjs — see the note about it in CLAUDE.md.
//
// Retrying hard into a struggling upstream also makes the struggle worse, once per company.
const TIMEOUT_MS = 12_000;
const DEADLINE_MS = 20_000;
const ATTEMPTS = 2;
const BACKOFF_MS = 500;

const newsBase = (env) => (env?.MUNS_NEWS_BASE || FASTAPI_BASE).replace(/\/+$/, '');
const filingsBase = (env) => (env?.MUNS_BASE || NESTJS_BASE).replace(/\/+$/, '');
const stockSearchBase = (env) => (env?.MUNS_SEARCH_BASE || STOCK_SEARCH_BASE).replace(/\/+$/, '');
const tokenFor = (env, kind) => (kind === 'news' ? env?.MUNS_NEWS_TOKEN || env?.MUNS_TOKEN : env?.MUNS_TOKEN) || null;

// ---- The reader's own credential, when this deployment has none ------------------------------
//
// The dashboard runs inside the Munshot host, which hands the browser the signed-in reader's
// session JWT over the SDK channel (public/js/core/host-context.js). The browser sends it to our
// own `api/…` routes, and this is what lets those routes USE it — otherwise the header would be
// decoration and the integration inert.
//
// THE DEPLOYMENT'S OWN SECRET ALWAYS WINS. This fills `MUNS_TOKEN` only when it is ABSENT, so it
// is strictly a new answer to an existing hard failure: the `no-token` state these clients already
// name on screen, which today needs an operator with access to the Cloudflare dashboard before the
// tab can show anything at all. Where a secret is configured nothing changes — same credential,
// same edge-cache behaviour, same everything.
//
// ONE FIELD, DELIBERATELY. `MUNS_NEWS_TOKEN` and `MUNS_LLM_TOKEN` both already fall back to
// `MUNS_TOKEN`, so filling that one covers news, announcements, insider trades, stock search, the
// investor books and Ask Research without four separate rules to keep in step.
//
// WHAT THIS ASSUMES ABOUT THE CACHE, AND THE ONE THING THAT WOULD BREAK IT. The routes behind this
// share `caches.default` entries keyed by URL, so a response fetched with one reader's token can be
// served to the next. That is safe here because every one of these upstreams returns MARKET data —
// the same filings, the same books, the same search results, whoever asks. **A future route that
// returns anything specific to the caller must not be given this env**: it would need its own cache
// key, or no cache at all.

/** The bearer token on a request, or null. Rejects anything that is not one clean token. */
export function callerToken(request) {
  const header = request?.headers?.get?.('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  // `\S+` already excludes the whitespace and CR/LF a header-splitting attempt would need; the
  // shape check narrows it to the base64url alphabet a JWT is written in, so a header this Worker
  // did not create cannot carry anything else into an upstream request.
  if (token.length < 16 || token.length > 4096) return null;
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) return null;
  return token;
}

/**
 * `env`, with the caller's token filling in for a MISSING `MUNS_TOKEN` — and nothing else.
 * Returns the original `env` untouched whenever a secret is configured or the caller sent nothing
 * usable, so the common path allocates nothing and behaves exactly as it did before.
 */
export function withCallerToken(env, request) {
  if (env?.MUNS_TOKEN) return env;
  const token = callerToken(request);
  if (!token) return env;
  return { ...env, MUNS_TOKEN: token, MUNS_TOKEN_SOURCE: 'caller' };
}

/** A failure that names itself, so the UI can say which of them an operator has to fix. */
export class MunsError extends Error {
  constructor(reason, message, { status = null, url = null } = {}) {
    super(message);
    this.reason = reason; // 'no-token' | 'unauthorised' | 'rate-limited' | 'not-found' | 'timeout' | 'unreachable' | 'upstream' | 'shape'
    this.status = status;
    this.url = url;
  }
}

/**
 * One authenticated request, retried on the failures that are worth retrying.
 *
 * 401/403 and 404 are NOT retried: a refused token is refused three times just as fast, and three
 * attempts only delays the moment the operator is told what to fix. 429 is not retried either —
 * the registry caps these at 60 requests a minute and hammering a rate limit is how you earn a
 * longer one. Timeouts and 5xx are the retryable cases.
 *
 * CARRIES THE REQUESTED URL INTO EVERY FAILURE. A bare status code is unfalsifiable; the last time
 * that rule was broken here it cost a long investigation during which the upstream was healthy and
 * answering the whole time (see "an upstream you CANNOT proxy" in CLAUDE.md).
 */
async function request(url, { method = 'GET', body = null, token, label, maxBytes = null }) {
  if (!token) {
    throw new MunsError('no-token', `No API token is configured for ${label}. An operator sets it with \`npx wrangler secret put MUNS_TOKEN\`.`, { url });
  }

  let last = null;
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // What is LEFT of the deadline, never a fresh full timeout. A first attempt that burns most of
    // the budget leaves the second a short one rather than doubling the wait.
    const budget = Math.min(TIMEOUT_MS, deadline - Date.now());
    if (budget <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!maxBytes) clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new MunsError(
          'unauthorised',
          `${label} refused the token (HTTP ${res.status}). These are session JWTs and they expire; renewing it is \`npx wrangler secret put MUNS_TOKEN\`.`,
          { status: res.status, url }
        );
      }
      if (res.status === 404) throw new MunsError('not-found', `${label} has no record at this address (HTTP 404).`, { status: 404, url });
      if (res.status === 429) throw new MunsError('rate-limited', `${label} is rate limiting this deployment (HTTP 429). The registry allows 60 requests a minute.`, { status: 429, url });
      if (!res.ok) {
        last = new MunsError('upstream', `${label} answered HTTP ${res.status}.`, { status: res.status, url });
        if (res.status < 500) throw last;
      } else {
        // The insider-trades endpoint is documented as returning a markdown TABLE, so a non-JSON
        // body is expected there rather than a failure. Read text and let the caller decide.
        let text;
        if (maxBytes) {
          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          let size = 0;
          text = '';
          if (reader) for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw new MunsError('shape', `${label} returned too much document metadata.`, { url });
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else text = await res.text();
        clearTimeout(timer);
        try {
          return { json: JSON.parse(text), text, status: res.status };
        } catch {
          return { json: null, text, status: res.status };
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof MunsError && err.reason !== 'upstream') throw err;
      last =
        err.name === 'AbortError'
          ? new MunsError('timeout', `${label} did not answer within ${Math.round(DEADLINE_MS / 1000)}s.`, { url })
          : last || new MunsError('unreachable', `${label} could not be reached: ${String(err?.message || err)}`, { url });
    }
    clearTimeout(timer);
    if (attempt < ATTEMPTS && Date.now() < deadline) await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** (attempt - 1)));
  }
  throw last || new MunsError('unreachable', `${label} could not be reached.`, { url });
}

// ---------------------------------------------------------------------------------------
// Company search — POST birdnest.muns.io/stock/search
// ---------------------------------------------------------------------------------------

/**
 * Search Muns' stock registry. `user_index` is part of that endpoint's contract and is always the
 * documented static value 124; it is never accepted from the browser. The upstream returns an
 * object keyed by ticker, so normalise it into an ordered array the autocomplete can render.
 */
export async function searchStocks({ query }, env) {
  const q = String(query || '').trim();
  const url = `${stockSearchBase(env)}/stock/search`;
  if (q.length < 2 || q.length > 80) throw new MunsError('shape', 'Company search needs between 2 and 80 characters.', { url });

  const { json } = await request(url, {
    method: 'POST',
    body: { query: q, user_index: 124 },
    token: tokenFor(env),
    label: 'The company-search API',
  });
  if (!json) throw new MunsError('shape', 'The company-search API answered with something that is not JSON.', { url });

  const raw = json?.data?.results;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MunsError('shape', 'The company-search API returned no readable result map.', { url });
  }
  const results = Object.entries(raw).map(([rawTicker, value]) => {
    const cells = Array.isArray(value) ? value : [];
    const ticker = String(rawTicker || '').trim().toUpperCase();
    return {
      ticker,
      country: cells[0] == null ? null : String(cells[0]),
      name: cells[1] == null ? ticker : String(cells[1]),
      industry: cells[2] == null ? null : String(cells[2]),
      validTicker: /^[A-Z0-9&.\-]{1,20}$/.test(ticker),
    };
  });
  return {
    query: q,
    totalResults: Number.isFinite(json?.data?.total_results) ? json.data.total_results : results.length,
    results,
  };
}

// ---------------------------------------------------------------------------------------
// News — POST /tools/news-search
// ---------------------------------------------------------------------------------------

/**
 * Recent articles for a query.
 *
 * The registry names the response field `results`; `collectRecords` looks there first and then at
 * the other envelopes a service of this shape uses, so a rename costs nothing. Articles are
 * returned in the upstream's own order — relevance is theirs to decide, and re-sorting by date
 * would quietly replace their ranking with ours.
 */
export async function fetchNews({ query, country = null, fromDate = null, toDate = null }, env) {
  const url = `${newsBase(env)}/tools/news-search`;
  const body = { query: String(query || '').trim() };
  if (country) body.country = country;
  if (fromDate) body.from_date = fromDate;
  if (toDate) body.to_date = toDate;
  if (!body.query) throw new MunsError('shape', 'A news search needs a query.', { url });

  const { json, text } = await request(url, { method: 'POST', body, token: tokenFor(env, 'news'), label: 'The news API' });
  if (!json) throw new MunsError('shape', 'The news API answered with something that is not JSON.', { url });

  const records = collectRecords(json);
  return {
    query: body.query,
    count: records.length,
    articles: records.map((r) => normaliseArticle(r, body.query)),
    // Kept so a reader can see what came back when the normaliser found nothing to show — the
    // difference between "no articles" and "articles in a shape we did not recognise".
    rawSample: records.length ? null : String(text).slice(0, 400),
  };
}

// ---------------------------------------------------------------------------------------
// Corporate announcements — GET /filings/corp/announcements/{ticker}
// ---------------------------------------------------------------------------------------

/** `YYYY-MM-DD` or `YYYYMMDD` in, `YYYYMMDD` out — this endpoint wants the compact form. */
export const compactDate = (d) => String(d || '').replace(/-/g, '').slice(0, 8);

/**
 * Every announcement for one company, from BSE (primary), NSE (fallback) and DRHP documents.
 *
 * The documented response is "grouped by source" with the grouping unspecified, so
 * `collectRecords` walks the envelope and keeps the group name on each row. WHICH EXCHANGE SAID
 * THIS IS INFORMATION: flattening BSE, NSE and DRHP into one undifferentiated list would lose the
 * one field that lets a reader tell a filing from a prospectus.
 */
export async function fetchAnnouncements({ ticker, fromDate, toDate }, env) {
  const t = String(ticker || '').trim().toUpperCase();
  let range;
  try { range = announcementRange(fromDate, toDate); }
  catch (err) { throw new MunsError('shape', err.message); }
  const from = range.fromDate;
  const to = range.toDate;
  const url = `${filingsBase(env)}/filings/corp/announcements/${encodeURIComponent(t)}?fromDate=${from}&toDate=${to}`;
  if (!/^[A-Z0-9&._-]{1,80}$/.test(t)) {
    throw new MunsError('shape', 'Announcements need a ticker and a YYYYMMDD date range.', { url });
  }

  const { json } = await request(url, { token: tokenFor(env), label: 'The announcements API', maxBytes: 4_000_000 });
  if (!json) throw new MunsError('shape', 'The announcements API answered with something that is not JSON.', { url });

  let parsed;
  try { parsed = normaliseCorporateAnnouncements(json, t); }
  catch (err) { throw new MunsError('shape', err.message, { url }); }
  return {
    ticker: t,
    from,
    to,
    count: parsed.announcements.length,
    ...parsed,
  };
}

// ---------------------------------------------------------------------------------------
// Insider trades — POST /filings/data/insider_trades
// ---------------------------------------------------------------------------------------

/**
 * Insider trades for one company, as a table.
 *
 * THIS ONE ANSWERS WITH MARKDOWN, not JSON — the only upstream in this dashboard that does. The
 * parser lives in filings-shared.js and keeps the source's own column headings rather than mapping
 * them onto names of ours: this is somebody else's table and relabelling "Acq/Disp" as "Action"
 * would put our word on their data.
 *
 * `country: 'india'` routes them to NSE/BSE/Trendlyne; anything else goes to Finviz. India is the
 * default because every company in this dashboard is Indian, and the documented India path is
 * capped at 100 records when no date filter is given — so a date range is always sent.
 */
export async function fetchInsiderTrades({ ticker, country = 'india', fromDate = null, toDate = null }, env) {
  const t = String(ticker || '').trim().toUpperCase();
  const url = `${filingsBase(env)}/filings/data/insider_trades`;
  if (!t) throw new MunsError('shape', 'Insider trades need a ticker.', { url });

  const body = { ticker: t, country };
  if (fromDate) body.fromDate = fromDate;
  if (toDate) body.toDate = toDate;

  const { json, text } = await request(url, { method: 'POST', body, token: tokenFor(env), label: 'The insider-trades API' });
  const parsed = normaliseInsiderTrades(json ?? text, t);
  return {
    ticker: t,
    country,
    from: fromDate,
    to: toDate,
    format: parsed.format,
    headers: parsed.headers,
    count: parsed.rows.length,
    trades: parsed.rows,
    // The India path caps at 100 without date filters; with them it does not, but a run that comes
    // back at exactly the cap is worth flagging rather than presenting as a complete history.
    capped: parsed.rows.length >= 100 && !fromDate && !toDate,
    rawSample: parsed.rows.length ? null : String(text || '').slice(0, 400),
  };
}

/** Screener document links, never interpreted as financial actuals or analyst estimates. */
export async function fetchDomesticFilings({ ticker, form = 'all' }, env) {
  const t = String(ticker || '').trim().toUpperCase();
  const url = `${filingsBase(env)}/filings/domestic`;
  if (!/^[A-Z0-9&._-]{1,80}$/.test(t) || !Object.hasOwn(DOMESTIC_FORMS, form)) {
    throw new MunsError('shape', 'Choose a valid ticker and filing type.', { url });
  }
  const { json } = await request(url, { method: 'POST', body: { ticker: t, form }, token: tokenFor(env), label: 'The domestic-filings API', maxBytes: 4_000_000 });
  let parsed;
  try { parsed = normaliseDomesticFilings(json, t, form); }
  catch (err) { throw new MunsError('shape', err.message, { url }); }
  return { ticker: t, form, source: 'Screener.in via Muns', count: parsed.documents.length, ...parsed };
}
