// Cloudflare Worker entry point.
//
// The dashboard is static assets (./public), served through the ASSETS binding. This Worker
// adds API routes on top:
//
//   POST /api/live-prices  { tickers: [...] }  ->  { generated_at, source, ticker_count, prices }
//   GET  /api/earnings                         ->  the live Moneycontrol results feed
//   GET  /api/earnings?fields=prices           ->  just the traded prices, for the poll
//   GET  /api/earnings-calendar                ->  who is SCHEDULED to report, and when
//   GET  /api/earnings-calendar?list=none      ->  the date strip alone, no per-date company list
//   GET  /api/concalls                         ->  live analysis + scheduled Screener document history
//   GET  /api/super-investors                  ->  the tracked super-investor list (Finology)
//   GET  /api/super-investors/{slug}           ->  one investor's book, quarter by quarter
//   GET  /api/stock-search?q=                   ->  company search for the scope editor (Muns)
//   GET  /api/research                          ->  whether Ask Research is configured
//   POST /api/research                          ->  streamed dashboard-grounded research answer
//
// Data reads are read-through overlays on committed data. The POST-only refresh routes dispatch
// fixed repository workflows; credentials remain in the Worker and duplicate runs are declined.
//
// THE SUPER-INVESTOR ROUTES EXIST TO HOLD A CREDENTIAL. Unlike every other upstream here, that
// API needs `Authorization: Bearer …`. A token in front-end code is a token published, so the
// browser calls this Worker and the Worker adds the header from `env.MUNS_TOKEN` — the same
// reason /api/live-prices is proxied. Set it with `npx wrangler secret put MUNS_TOKEN`.
//
// EVERY DATA GET ROUTE HERE IS CONDITIONAL — see `withTag` / `revalidate` at the foot of this
// file. `/api/research`'s small configuration response is deliberately `no-store` instead.
// The two big feeds are polled every 30 seconds and are 1.1MB and 450KB of JSON. Answering
// "nothing has changed" by re-sending the whole thing, 120 times an hour, is the single largest
// waste in the system. So each response carries a content-derived ETag, and a request that
// arrives with a matching `If-None-Match` gets a 304 with no body at all.

import { fetchLatestResults, freshnessOf, resolveMissing, applyIdentity, fetchCalendarStrip, fetchCalendarDay, CALENDAR_PAGE_SIZE } from './mc.mjs';
import { fetchConcallScans, fetchUpcoming, fetchToday, mergeScans, PAGE_SIZE } from './stockscans.mjs';
import { fetchInvestorList, fetchInvestorPortfolio, isSlug } from './finology.mjs';
import { fetchNews, fetchAnnouncements, fetchInsiderTrades, fetchDomesticFilings, searchStocks, withCallerToken, MunsError } from './muns.mjs';
import { DOMESTIC_FORMS } from '../public/js/data/domestic-filings-shared.js';
import { announcementRange } from '../public/js/data/announcements-shared.js';
import { assessFilingsHealth, FILINGS_HEALTH_FILES } from '../public/js/data/filings-health-shared.js';
import { CORS, preflight, contentTag, withTag, tagged, revalidate } from './http.mjs';
import {
  dispatchWorkflow,
  latestRun,
  parseRepo,
  isInFlight,
  NEWS_WORKFLOW,
  COMPANY_NEWS_WORKFLOW,
  INSIDER_WORKFLOW,
  ANNOUNCEMENTS_WORKFLOW,
  CORPORATE_ACTIONS_WORKFLOW,
  DATA_WORKFLOW,
  TWITTER_WORKFLOW,
  DEPLOY_WORKFLOW,
} from './github-actions.mjs';
import { handleResearch } from './research.mjs';
import { handleFamilyPortfolio } from './family-portfolio.mjs';
import { handleCombinedFilings } from './combined-filings.mjs';
import { handleDrhpFilings } from './drhp-filings.mjs';
import { handleIpoMonitor } from './ipo-monitor.mjs';
import { handleIpoFilings } from './ipo-filings.mjs';
import { handleCaptureRegistration } from './capture-registration.mjs';
import { readPlatformCollector } from './ipo-platform-collector.mjs';
import { readScreenerConcallCollector } from './screener-concalls-collector.mjs';
import { enrichConcallScans, SCREENER_CONCALL_FRESH_MS, SCREENER_CONCALL_WORKFLOW } from '../public/js/data/screener-concalls-shared.js';
import { FEED_URL as NSE_FEED_URL, HEADERS as NSE_HEADERS, parseAnnouncements, assertShape as assertNseShape, buildResolver, resolveAll as resolveNse } from './nse-ann.mjs';

const MUNSHOT_API = 'https://fastapi.muns.io/stock-data';
const MAX_TICKERS = 60;

// THE QUOTE UPSTREAM IS CACHE-BACKED, AND EVERY NUMBER BELOW COMES FROM MEASURING THAT.
// The same twenty tickers, the same concurrency, the same timeout, three times in a row:
// 8/20 with a p50 of 15s, then 20/20 with a p50 of 3.3s, then 20/20 with a p50 of 1.1s.
// A ticker they have warm answers in about a second; a cold one takes 8-15s and sometimes
// longer. That single fact explains the failure this route used to produce reliably:
//
//   - REQ_TIMEOUT_MS was 8000, which sits UNDER the cold path. Cold reads could not win.
//   - Nothing was cached here, so every refresh was a cold refresh. The slow path was not
//     the unlucky case, it was the only case.
//   - All 60 fetches were fired in one Promise.all, each with its own AbortSignal.timeout.
//     The runtime runs about six connections at a time, so the other fifty-four burned their
//     entire budget waiting for a socket. Measured: 24 fired together returned 0 of 24, all
//     aborting at exactly 8s, while the same tickers walked a few at a time returned 24 of 24.
//
// So the fix is not a better timeout. It is: cache each ticker here so the expensive read is
// paid once for every reader rather than once per click, give the cold path room to finish,
// bound the fan-out so a timer cannot expire in a queue, and — because some cold reads will
// still overrun — return what landed and NAME what did not, instead of failing the batch.
//
// The four constants below are ONE SETTING, NOT FOUR, and they have to stay consistent: a batch of MAX_TICKERS
// needs ceil(60 / POOL) waves, and a wave can cost a full TIMEOUT, so a POOL too small simply
// cannot reach the end of the batch before the BUDGET expires however healthy the upstream is.
// A first draft ran POOL 6 against a 22s budget and returned 6 of 60 with 48 never started —
// worse than the bug it replaced. Measured on disjoint cold batches of 60, at a 25s budget:
// POOL 12 -> 48/60, POOL 20 -> 31/60, POOL 30 -> 46/60. Higher fan-out does not buy throughput
// because the upstream slows under it, so 12 is both the best result and the politest of the three.
const QUOTE_TTL_S = 45; // one quote at the edge. Long enough to serve a burst, short enough to be a quote.
const QUOTE_TIMEOUT_MS = 15000; // per attempt, above the measured cold path
const QUOTE_POOL = 12; // in flight at once
const QUOTE_BUDGET_MS = 25000; // whole-route deadline; whatever has landed by then is returned
const QUOTE_ATTEMPTS = 2;

// How long the edge holds one upstream response. This is the whole reason the browser polls us
// rather than Moneycontrol directly: a thousand readers on the tab cost Moneycontrol ONE fetch
// per window, not a thousand. Worst-case staleness is EARNINGS_TTL + the client's poll interval.
const EARNINGS_TTL_S = 30;
const EARNINGS_SNAPSHOT = '/data/earnings-live.json';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------------------
    // API ROUTES
    // Add new handlers here and keep them in their own module once this grows past a
    // couple of routes. Everything not matched falls through to the static assets.
    // ---------------------------------------------------------------------------------
    // A conditional GET carries `If-None-Match`, which is not a CORS-safelisted request header, so
    // a cross-origin caller preflights it. Production is same-origin and never sees this; local
    // development, where the static site and the Worker sit on different ports, does.
    if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
      return preflight();
    }

    // isRead is caller-specific. This route must bypass deployment-token fallback and edge caches.
    if (url.pathname === '/api/combined-filings') return handleCombinedFilings(request);
    if (url.pathname === '/api/drhp-filings') return handleDrhpFilings(request);
    if (url.pathname === '/api/ipo-monitor') return handleIpoMonitor(request);
    if (url.pathname === '/api/ipo-filings') return handleIpoFilings(request, { readPlatform: ({ signal }) => readPlatformCollector({ token: env.GH_DISPATCH_TOKEN, signal }) });
    if (url.pathname === '/api/capture-registration') return handleCaptureRegistration(request, env);

    // THE READER'S OWN TOKEN, BUT ONLY WHERE THIS DEPLOYMENT HAS NONE. The dashboard runs inside
    // the Munshot host, which hands the browser the signed-in reader's session JWT; the browser
    // sends it back on these same-origin routes (js/core/host-context.js). `withCallerToken` fills
    // an ABSENT `MUNS_TOKEN` with it and changes nothing otherwise — a configured secret always
    // wins, so a deployment that has one behaves exactly as it did. What it buys is the `no-token`
    // state, which is a hard failure on screen today and needed an operator to clear. Read the note
    // above `withCallerToken` in worker/muns.mjs before giving this env to a route whose response
    // is specific to the caller: these all share a URL-keyed edge cache.
    env = withCallerToken(env, request);

    if (url.pathname === '/api/research') {
      return handleResearch(request, env);
    }
    if (url.pathname === '/api/family-portfolio') {
      return handleFamilyPortfolio(request, env);
    }
    if (url.pathname === '/api/live-prices') {
      return handleLivePrices(request, env, ctx);
    }
    if (url.pathname === '/api/earnings') {
      return handleEarnings(request, env, ctx);
    }
    if (url.pathname === '/api/earnings-calendar') {
      return handleCalendar(request, env, ctx);
    }
    if (url.pathname === '/api/nse-announcements') {
      return handleNseAnnouncements(request, env, ctx);
    }
    if (url.pathname === '/api/concalls') {
      return handleConcalls(request, env, ctx);
    }
    if (url.pathname === '/api/super-investors') {
      return handleInvestorList(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/super-investors/')) {
      return handleInvestorPortfolio(request, env, ctx, url.pathname.slice('/api/super-investors/'.length));
    }
    if (url.pathname === '/api/stock-search') {
      return handleStockSearch(request, env, ctx);
    }
    if (url.pathname === '/api/news') {
      return handleMuns(request, env, ctx, 'news');
    }
    if (url.pathname.startsWith('/api/announcements/')) {
      return handleMuns(request, env, ctx, 'announcements', url.pathname.slice('/api/announcements/'.length));
    }
    if (url.pathname.startsWith('/api/insider-trades/')) {
      return handleMuns(request, env, ctx, 'insider', url.pathname.slice('/api/insider-trades/'.length));
    }
    if (url.pathname.startsWith('/api/domestic-filings/')) {
      return handleMuns(request, env, ctx, 'domestic', url.pathname.slice('/api/domestic-filings/'.length));
    }
    // POST-ONLY, DELIBERATELY. This is the one route here that makes something happen rather than
    // reporting something — a GET that started a scrape could be fired by a prefetcher, a link
    // preview or a crawler.
    if (url.pathname === '/api/market-news/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a scrape with POST.' }, 405);
      return handleNewsDispatch(request, env, ctx);
    }
    if (url.pathname === '/api/market-news/run') {
      return handleNewsRunStatus(request, env, ctx);
    }
    // X/Twitter collection. Same shape as every other dispatch route here, with one addition: it
    // may carry the handle that prompted it, so a newly added account is read now rather than at
    // the next scheduled run.
    //
    // THE HANDLE IS VALIDATED HERE, NOT TRUSTED. It reaches a `workflow_dispatch` input and from
    // there a runner's shell, so it is checked against X's own rule — 1-15 of [A-Za-z0-9_] — and
    // dropped entirely if it does not match, exactly as `?source=` is an allow-list of three words
    // rather than a string that reaches the run name. A request cannot choose the repository, the
    // workflow or the ref either; all three are fixed on this Worker.
    if (url.pathname === '/api/twitter/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a collection with POST.' }, 405);
      const raw = url.searchParams.get('handle') || '';
      const handle = /^[A-Za-z0-9_]{1,15}$/.test(raw) ? raw : null;
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: TWITTER_WORKFLOW,
        // Keyed by handle so adding a second account is not swallowed by the first one's cooldown,
        // while holding the button down on one account still is.
        cacheName: `twitter-dispatch${handle ? `:${handle.toLowerCase()}` : ''}`,
        cooldownS: TWITTER_DISPATCH_COOLDOWN_S,
        extraInputs: handle ? { handle } : null,
      });
    }
    if (url.pathname === '/api/twitter/run') {
      return handleWorkflowRunStatus(env, ctx, { workflow: TWITTER_WORKFLOW, cacheName: 'twitter-run-status' });
    }
    if (url.pathname === '/api/company-news/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a scrape with POST.' }, 405);
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: COMPANY_NEWS_WORKFLOW,
        cacheName: 'company-news-dispatch',
        cooldownS: COMPANY_NEWS_DISPATCH_COOLDOWN_S,
      });
    }
    if (url.pathname === '/api/company-news/run') {
      return handleWorkflowRunStatus(env, ctx, {
        workflow: COMPANY_NEWS_WORKFLOW,
        cacheName: 'company-news-run-status',
      });
    }
    if (url.pathname === '/api/insider-snapshot/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a refresh with POST.' }, 405);
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: INSIDER_WORKFLOW,
        cacheName: 'insider-snapshot-dispatch',
        cooldownS: FILINGS_DISPATCH_COOLDOWN_S,
      });
    }
    if (url.pathname === '/api/insider-snapshot/run') {
      return handleWorkflowRunStatus(env, ctx, {
        workflow: INSIDER_WORKFLOW,
        cacheName: 'insider-snapshot-run-status',
      });
    }
    if (url.pathname === '/api/announcements-snapshot/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a refresh with POST.' }, 405);
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: ANNOUNCEMENTS_WORKFLOW,
        cacheName: 'announcements-snapshot-dispatch',
        cooldownS: ANNOUNCEMENTS_DISPATCH_COOLDOWN_S,
      });
    }
    if (url.pathname === '/api/announcements-snapshot/run') {
      return handleWorkflowRunStatus(env, ctx, {
        workflow: ANNOUNCEMENTS_WORKFLOW,
        cacheName: 'announcements-snapshot-run-status',
      });
    }
    if (url.pathname === '/api/corporate-actions-snapshot/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a refresh with POST.' }, 405);
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: CORPORATE_ACTIONS_WORKFLOW,
        cacheName: 'corporate-actions-snapshot-dispatch',
        cooldownS: ANNOUNCEMENTS_DISPATCH_COOLDOWN_S,
      });
    }
    if (url.pathname === '/api/corporate-actions-snapshot/run') {
      return handleWorkflowRunStatus(env, ctx, {
        workflow: CORPORATE_ACTIONS_WORKFLOW,
        cacheName: 'corporate-actions-snapshot-run-status',
      });
    }
    if (url.pathname === '/api/data-snapshot/refresh') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method', message: 'Start a refresh with POST.' }, 405);
      return handleWorkflowDispatch(request, env, ctx, {
        workflow: DATA_WORKFLOW,
        cacheName: 'data-snapshot-dispatch',
        cooldownS: DATA_DISPATCH_COOLDOWN_S,
      });
    }
    if (url.pathname === '/api/data-snapshot/run') {
      return handleWorkflowRunStatus(env, ctx, {
        workflow: DATA_WORKFLOW,
        cacheName: 'data-snapshot-run-status',
      });
    }
    if (url.pathname === '/api/filings-health') {
      return handleFilingsHealth(request, env, ctx);
    }
    if (url.pathname === '/api/capture-status') {
      return handleCaptureStatus(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not implemented', path: url.pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  // ---------------------------------------------------------------------------------------
  // CRON: KEEP THE NEWS FRESH, BECAUSE GITHUB'S OWN SCHEDULER WILL NOT.
  //
  // The capture was supposed to refresh every 20 minutes on a GitHub `schedule:` trigger. It does
  // not, and tuning the cron did not help — measured on this repository:
  //
  //     `*/20 * * * *`   fired  12 times against 124 scheduled over 41 hours   (10%)
  //     then relaxed to `*/30` across a 12-hour window, and in the 5.7 hours that followed it
  //     fired  ZERO  times against ~11 scheduled.
  //
  // Their scheduler is best-effort on shared infrastructure and this repository is evidently at
  // the back of that queue. So the schedule is not a lever worth pulling again.
  //
  // `workflow_dispatch` IS NOT THROTTLED, and that is the whole fix. Every manual dispatch made
  // today started a run **within seconds** of the POST — 10:24:00, 10:27:33, 10:41:01, 11:27:25,
  // 11:47:55, 12:57:01. So the cadence comes from a scheduler that works (Cloudflare's) driving
  // the trigger that works (GitHub's dispatch API), and GitHub's own `schedule:` block stays only
  // as a fallback for a deployment without this Worker.
  //
  // NOTHING ELSE CHANGES. This calls the same `dispatchWorkflow` the button calls, which reads the
  // latest run first and does nothing when one is already going — so a cron tick that lands on top
  // of a reader's click costs no second run.
  //
  // AND IT RESPECTS THE WINDOW THE PUBLISHER ANSWERS IN. Measured across 12 scheduled runs, every
  // success fell between 10:27 and 21:14 IST and every refusal between 20:28 and 05:29 IST. So
  // outside 03:00-14:59 UTC this drops to hourly rather than spending three runs an hour being
  // refused — politeness towards somebody else's site, and it costs the reader nothing, because
  // Moneycontrol publish very little to that page overnight.
  // ---------------------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchNewsScrape(event, env));
  },
};

/** The dense window, in UTC. 03:00-14:59 UTC is 08:30-20:29 IST. */
const NEWS_DENSE_FROM_UTC = 3;
const NEWS_DENSE_TO_UTC = 15;

async function dispatchNewsScrape(event, env) {
  const cfg = githubConfig(env);
  if (cfg.error) {
    // Nothing to retry and nothing to alarm about: an operator sets the secret, or does not.
    console.log(`[news-cron] skipped — ${cfg.error.reason}`);
    return;
  }

  const at = new Date(event?.scheduledTime || Date.now());
  const hour = at.getUTCHours();
  const dense = hour >= NEWS_DENSE_FROM_UTC && hour < NEWS_DENSE_TO_UTC;
  // The cron ticks every 20 minutes. Outside the window only the top-of-hour tick dispatches.
  if (!dense && at.getUTCMinutes() >= 20) {
    console.log(`[news-cron] ${at.toISOString()} — outside the window the publisher answers, hourly only`);
    return;
  }

  try {
    const out = await dispatchWorkflow(fetch, cfg, NEWS_WORKFLOW, cfg.ref, { source: 'cron' });
    console.log(`[news-cron] ${at.toISOString()} — ${out.dispatched ? 'dispatched' : 'a run was already going'}`);
  } catch (err) {
    // A failed dispatch is not worth throwing over: the next tick is twenty minutes away and the
    // reader's own Fetch button reports the same failure with its fix attached.
    console.log(`[news-cron] ${at.toISOString()} — could not dispatch: ${err?.code || 'error'} ${err?.message || ''}`);
  }
}

// ---------------------------------------------------------------------------------------
// GET /api/earnings — the live results feed.
//
// Proxies Moneycontrol's Rapid Results API, normalises it (worker/mc.mjs), and caches the
// result at the edge for EARNINGS_TTL_S.
//
// WHY PROXY AT ALL, GIVEN MONEYCONTROL SENDS `access-control-allow-origin: *`?
// The browser could call them directly. Three reasons not to:
//   1. Politeness and cost. One upstream fetch per 30s window serves every reader.
//   2. A fallback. If the upstream 403s or changes shape, we serve the last committed snapshot
//      and SAY SO in `degraded`, instead of the tab going blank.
//   3. One place to normalise. The snapshot on disk and the live response come out of the same
//      code path (mc.mjs), so the fallback can never disagree with the live feed about shape.
//
// `?subType=qoq` and `?category=std|con` pass through; anything else is ignored rather than
// forwarded, so this cannot be used as an open proxy to arbitrary upstream paths.
//
// TWO REPRESENTATIONS, BECAUSE ONLY ONE FIELD MOVES ON A TICK.
// `?fields=prices` returns the traded price and day change per scID and nothing else — measured at
// 30KB against 1.1MB for the full feed. This exists because the results feed is the one place
// where a conditional GET alone buys nothing: `ltp` moves on every tick during market hours, so
// the full representation genuinely changes every 30 seconds even though not one reported figure
// has. Splitting the volatile field out means the poll carries only what actually moved.
//
// The projection carries `structureTag` — a tag over identity and the REPORTED FIGURES, price
// excluded. The client refetches the full feed exactly when that moves, which is when a company
// has filed or revised. So a filing still reaches the screen on the very next tick.
// ---------------------------------------------------------------------------------------
async function handleEarnings(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const subType = url.searchParams.get('subType') === 'qoq' ? 'qoq' : 'yoy';
  const category = ['std', 'con'].includes(url.searchParams.get('category')) ? url.searchParams.get('category') : 'all';
  const fields = url.searchParams.get('fields') === 'prices' ? 'prices' : 'full';

  // Cache key is the normalised option set, not the raw URL — so a stray tracking param can't
  // fragment the cache and multiply upstream fetches. The two representations are cached
  // separately so the poll never has to parse the 1.1MB one to answer with 10KB.
  const cache = caches.default;
  const fullKey = edgeKey(`earnings?subType=${subType}&category=${category}`);
  const pricesKey = edgeKey(`earnings-prices?subType=${subType}&category=${category}`);

  const hit = await cache.match(fields === 'prices' ? pricesKey : fullKey);
  if (hit) return revalidate(request, hit, 'hit');

  // The other representation may still be warm. Deriving the projection from a cached full payload
  // is a parse rather than an upstream fetch, and the two keys can be evicted independently.
  if (fields === 'prices') {
    const warm = await cache.match(fullKey);
    if (warm) {
      const { body, tag } = withTag(pricesPayload(await warm.json()));
      ctx?.waitUntil?.(cache.put(pricesKey, tagged(body, tag, EARNINGS_TTL_S)));
      return revalidate(request, tagged(body, tag, EARNINGS_TTL_S), 'derived');
    }
  }

  let payload;
  try {
    const { rows, meta } = await fetchLatestResults({ limit: 5000, subType, category });
    if (!rows.length) throw new Error('upstream returned no rows');

    // Identity from the committed map, plus on-the-fly resolution for anything it has never seen.
    // A company that reports today is not in a map built yesterday, and those are precisely the
    // rows at the top of a live results table — shipping them with no ticker, market cap or
    // industry would make the freshest data the least useful data on the page.
    const known = (await loadTickerMap(env, request)) || {};
    const { resolved, attempted, failed } = await resolveMissing(rows, known, { limit: 40 });
    const merged = Object.keys(resolved).length ? { ...known, ...resolved } : known;

    const joined = applyIdentity(rows, merged);
    payload = {
      ok: true,
      degraded: null,
      ...freshnessOf(rows),
      meta: { ...meta, resolvedOnTheFly: attempted, unresolved: failed, structureTag: structureTagOf(joined, `${subType}|${category}`) },
      rows: joined,
    };
  } catch (err) {
    // Upstream is down, rate-limited, or has changed shape. Serve the committed snapshot and
    // label it, rather than an empty feed that would read as "no results reported".
    const fallback = await loadSnapshot(env, request);
    if (!fallback) {
      return json({ ok: false, degraded: `upstream failed and no snapshot is available: ${String(err.message || err)}`, rows: [] }, 502);
    }
    payload = {
      ...fallback,
      ok: true,
      degraded: `Live feed unavailable (${String(err.message || err)}) — showing the last committed snapshot.`,
      meta: { ...(fallback.meta || {}), structureTag: structureTagOf(fallback.rows || [], `${subType}|${category}|snapshot`) },
    };
    // Retry the upstream sooner than usual, and do not poison the edge cache with the fallback —
    // a degraded answer must not be handed to the next reader for a full window.
    const { body, tag } = withTag(fields === 'prices' ? pricesPayload(payload) : payload);
    return revalidate(request, tagged(body, tag, 10), 'fallback');
  }

  const full = withTag(payload);
  const prices = withTag(pricesPayload(payload));
  ctx?.waitUntil?.(
    Promise.all([
      cache.put(fullKey, tagged(full.body, full.tag, EARNINGS_TTL_S)),
      cache.put(pricesKey, tagged(prices.body, prices.tag, EARNINGS_TTL_S)),
    ])
  );
  const out = fields === 'prices' ? prices : full;
  return revalidate(request, tagged(out.body, out.tag, EARNINGS_TTL_S), 'miss');
}

/**
 * The polling projection: scID -> [ltp, changePct], plus the structure tag that tells the client
 * whether it still holds the right rows underneath those prices.
 *
 * A two-element array rather than an object per row on purpose — `"CHC":[1191,6.43]` is 20 bytes
 * where `{"ltp":1191,"changePct":6.43}` is 44, and there are 1,384 of them.
 */
function pricesPayload(payload) {
  const prices = {};
  for (const r of payload.rows || []) {
    if (r.ltp == null && r.changePct == null) continue;
    prices[r.scId] = [r.ltp ?? null, r.changePct ?? null];
  }
  return {
    ok: true,
    fields: 'prices',
    structureTag: payload.meta?.structureTag || null,
    latestResultDate: payload.latestResultDate ?? null,
    count: (payload.rows || []).length,
    degraded: payload.degraded || null,
    prices,
    meta: {
      subType: payload.meta?.subType || null,
      category: payload.meta?.category || null,
      quarter: payload.meta?.quarter || null,
      currentPeriod: payload.meta?.currentPeriod || null,
      priorPeriod: payload.meta?.priorPeriod || null,
      source: payload.meta?.source || null,
      fetchedAt: payload.meta?.fetchedAt || null,
    },
  };
}

/**
 * A tag over identity and the reported figures, with the traded price DELIBERATELY EXCLUDED.
 *
 * This is the server-side twin of `hasStructuralChange` in js/data/earnings-live.js, and it exists
 * for the same reason: prices move constantly and results do not. A client polling the price
 * projection needs one number that tells it "the rows themselves changed, come and get them", and
 * that number must not move just because someone traded.
 */
function structureTagOf(rows, salt) {
  const fig = (m) => (m ? `${m.current ?? ''},${m.prior ?? ''},${m.reportedPct ?? ''},${m.kind ?? ''}` : '');
  let acc = `${salt}#${rows.length}#`;
  for (const r of rows) {
    acc += `${r.scId}|${r.resultDate}|${r.basis}|${r.ticker || ''}|${fig(r.revenue)}|${fig(r.netProfit)}|${fig(r.grossProfit)}\n`;
  }
  return contentTag(acc);
}

// ---------------------------------------------------------------------------------------
// GET /api/earnings-calendar?date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD[&list=none]
//
// The Earnings Calendar schedule. Moneycontrol splits it across a clean JSON count endpoint and
// the paginated HTML endpoint used by its public /earnings-calendar page. Both are requested for
// All exchanges, and fetchCalendarDay follows every published twenty-row page, so the rows and the
// count answer the same question.
//
// Cached longer than the results feed (CALENDAR_TTL_S vs 30s) because a schedule changes on the
// order of hours, not ticks. The strip is fetched even when the day list fails, so a reader always
// learns how many companies report — an empty list would read as "nobody reports that day".
// ---------------------------------------------------------------------------------------
const CALENDAR_TTL_S = 300;

async function handleCalendar(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const date = iso(url.searchParams.get('date'));
  if (!date) return json({ error: 'date=YYYY-MM-DD is required' }, 400);
  // Default window: a fortnight around the chosen date, which is what the strip is for — seeing
  // where the clusters are without asking for a date you cannot see the shape of.
  const from = iso(url.searchParams.get('from')) || shiftDays(date, -7);
  const to = iso(url.searchParams.get('to')) || shiftDays(date, 14);

  // `list=none` remains available to read only the strip. The dashboard itself requests the full
  // list for every selected date; Earnings Reported is the separate filings view.
  const wantsList = url.searchParams.get('list') !== 'none';

  const cacheKey = edgeKey(`earnings-calendar?date=${date}&from=${from}&to=${to}&list=${wantsList ? 'full' : 'none'}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return revalidate(request, hit, 'hit');

  // Fetch the count first so the list reader knows exactly how many published pages exist. A
  // rejected half remains independent: the other half can still be served with honest provenance.
  const [stripOut] = await Promise.allSettled([fetchCalendarStrip({ fromDate: from, toDate: to, indexId: 'All' })]);
  let days = stripOut.status === 'fulfilled' ? stripOut.value : [];
  const expectedCount = days.find((d) => d.date === date)?.count ?? null;
  const [dayOut] = await Promise.allSettled([
    wantsList ? fetchCalendarDay({ date, indexId: 'All', expectedCount }) : Promise.resolve(null),
  ]);

  // The list has two possible origins and the payload must say which. Live is preferred; the
  // committed capture is the fallback, because www.moneycontrol.com may answer an edge request
  // differently from an ordinary browser or GitHub runner.
  let day = dayOut.status === 'fulfilled' ? dayOut.value : null;
  let listSource = day ? 'live' : null;
  let listCapturedAt = null;
  let listNote = null;
  const snapshot = await loadCalendarSnapshot(env, request);

  if (!wantsList) {
    // Not asked for, so not looked for. `listSource` stays null and `listRequested: false` travels
    // in the payload; nothing here may pretend to have checked.
    day = { rows: [], asOnDate: null, pageSize: CALENDAR_PAGE_SIZE, pagesFetched: 0, complete: false };
  } else if (!day) {
    const hit = snapshot?.byDate?.[date];
    if (hit) {
      day = {
        rows: hit.rows || [],
        asOnDate: hit.asOnDate || null,
        pageSize: hit.pageSize || snapshot.pageSize || CALENDAR_PAGE_SIZE,
        pagesFetched: hit.pagesFetched || Math.max(1, Math.ceil((hit.rows?.length || 0) / CALENDAR_PAGE_SIZE)),
        // Old captures used `capped:false` for a short, therefore complete, page.
        complete: hit.complete ?? !hit.capped,
      };
      listSource = 'snapshot';
      listCapturedAt = snapshot.capturedAt || null;
    } else {
      day = { rows: [], asOnDate: null, pageSize: CALENDAR_PAGE_SIZE, pagesFetched: 0, complete: false };
      listNote = snapshot
        ? `The committed capture covers ${snapshot.from} to ${snapshot.to} and does not include this date.`
        : 'No committed capture is available.';
    }
  }

  // A COUNT OF ZERO ON A DATE WHOSE COMPLETE LIST NAMES COMPANIES IS NOT A MEASUREMENT.
  //
  // The count endpoint has previously gone flat while the calendar page still named companies.
  // It is the endpoint's failure mode, not a quiet fortnight. The capture is now also All-exchange,
  // so it is a like-for-like fallback rather than a different market substituted under the label.
  //
  // The test is EVIDENCE, not a threshold: the live strip carries no non-zero count anywhere, and
  // the capture — which overlaps it — does. A genuinely empty window fails that test, because the
  // capture would be empty too.
  let countSource = days.length ? 'live' : null;
  let countsCapturedAt = null;
  const liveHasCounts = days.some((d) => d.count > 0);
  const snapDays = snapshot?.days || [];
  const overlap = snapDays.filter((d) => d.date >= from && d.date <= to);

  if (!liveHasCounts && overlap.some((d) => d.count > 0)) {
    // Keep the live strip's dates so the window is unchanged, and take the counts from the capture.
    const captured = new Map(overlap.map((d) => [d.date, d.count]));
    days = (days.length ? days : overlap).map((d) => ({ ...d, count: captured.get(d.date) ?? d.count }));
    countSource = 'snapshot';
    countsCapturedAt = snapshot.capturedAt || null;
  }
  // Keep external subrequests below the Workers Free limit. One request is spent on the count and
  // `pagesFetched` on the list; whatever remains (with two requests of headroom for redirects) can
  // resolve missing identities. Existing map hits cost no external request.
  const known = wantsList ? (await loadTickerMap(env, request)) || {} : {};
  const listRequests = listSource === 'live'
    ? day.requestsMade || day.pagesFetched || 1
    : dayOut.status === 'rejected'
      ? dayOut.reason?.requestsMade || 1
      : 1;
  const identityLimit = Math.min(25, Math.max(0, 48 - listRequests - (stripOut.status === 'fulfilled' ? 1 : 0)));
  const { resolved, attempted, failed } = wantsList ? await resolveMissing(day.rows, known, { limit: identityLimit }) : { resolved: {}, attempted: 0, failed: 0 };
  const merged = Object.keys(resolved).length ? { ...known, ...resolved } : known;

  const payload = {
    ok: true,
    resolvedOnTheFly: attempted,
    unresolved: failed,
    degraded: !wantsList
      ? // Nothing is degraded: the list was not requested. Saying otherwise would report a failure
        // that did not happen, and the caller in this mode has a better list than this route's.
        null
      : listSource === 'live'
        ? null
        : listSource === 'snapshot'
          ? null // not degraded — a labelled capture, and the UI prints how old it is
          : `The company list for this date is unavailable (${String(dayOut.reason?.message || dayOut.reason)}). ${listNote || ''} The per-date counts are live.`,
    date,
    from,
    to,
    asOnDate: day.asOnDate,
    // `false` means the caller did not ask for the company list, so `rows: []` here is not a claim
    // that nobody reports on this date. Any consumer reading `rows` must check this first.
    listRequested: wantsList,
    listSource,
    listCapturedAt,
    listNote,
    // Count and rows are the same All-exchange population. They still carry separate provenance
    // because the live count and a captured list can have been observed at different times.
    scheduledCount: days.find((d) => d.date === date)?.count ?? null,
    // Counts and the company list fail independently, so they carry their provenance separately.
    // Freezing them together would hide a schedule that has moved since the capture.
    countSource,
    countsCapturedAt,
    pageSize: day.pageSize || CALENDAR_PAGE_SIZE,
    pagesFetched: day.pagesFetched || 0,
    requestsMade: listRequests,
    complete: day.complete === true,
    days,
    rows: applyIdentity(day.rows, merged),
    meta: {
      source: 'Moneycontrol — Earnings Calendar (all-exchange counts plus the paginated earnings-widget list)',
      fetchedAt: new Date().toISOString(),
    },
  };

  // Nothing at all: no counts and no list. That is a real outage, not a partial view.
  if (!days.length && !payload.rows.length) {
    return json({ ok: false, degraded: `calendar upstream unavailable: ${String(stripOut.reason?.message || stripOut.reason || 'no data')}`, days: [], rows: [] }, 502);
  }

  const { body, tag } = withTag(payload);
  const extra = { 'x-sattva-list-source': wantsList ? listSource || 'none' : 'not-requested' };
  ctx?.waitUntil?.(cache.put(cacheKey, tagged(body, tag, CALENDAR_TTL_S, extra)));
  return revalidate(request, tagged(body, tag, CALENDAR_TTL_S, extra), 'miss');
}

// ---------------------------------------------------------------------------------------
// GET /api/news · /api/announcements/{ticker} · /api/insider-trades/{ticker}
//
// The three Muns feeds behind the News, Corporate Announcements and Insider Trades tabs. All three
// need `Authorization: Bearer …`, which is the whole reason they are routes here rather than fetches
// from the browser — see the header of worker/muns.mjs.
//
// ONE HANDLER, THREE UPSTREAMS, because everything that differs between them is already inside
// muns.mjs. What is shared is what belongs here: the edge cache, the content ETag, and the rule
// that a failure arrives as a 200 carrying `ok: false` and a NAMED reason.
//
// WHY A FAILURE IS A 200. The request to *us* succeeded; it is the upstream that did not answer.
// Returning 502 would make the browser's fetch throw, and a thrown fetch cannot carry the one thing
// the reader needs — which of `no-token`, `unauthorised`, `rate-limited`, `timeout`, `unreachable`
// or `shape` it was. The first two are things an operator fixes and the rest are things to wait
// for, and collapsing them into "could not load" throws away the only actionable information.
// Same pattern, and same reasoning, as /api/super-investors.
//
// A FAILURE IS CACHED FOR SECONDS, NOT MINUTES. These are session JWTs and they expire, so a
// corrected token has to take effect at once rather than after the success TTL.
// ---------------------------------------------------------------------------------------
const MUNS_TTL_S = { news: 180, announcements: 900, insider: 900, domestic: 900 };
const MUNS_FAIL_TTL_S = 15;

// Company names move much less often than filings. Cache each query at the edge so ten readers
// typing the same ticker spend one authenticated upstream search, not ten.
const STOCK_SEARCH_TTL_S = 300;

async function handleStockSearch(request, env, ctx) {
  if (request.method !== 'GET') return json({ ok: false, reason: 'method', message: 'Search with GET.' }, 405);
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (query.length < 2) return json({ ok: false, reason: 'shape', message: 'Search needs at least two characters.' }, 400);

  const cacheKey = edgeKey(`stock-search?q=${encodeURIComponent(query.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return revalidate(request, hit, 'hit');

  let payload;
  let ttl = STOCK_SEARCH_TTL_S;
  try {
    payload = { ok: true, ...(await searchStocks({ query }, env)) };
  } catch (err) {
    const e = err instanceof MunsError ? err : new MunsError('upstream', String(err?.message || err));
    payload = { ok: false, reason: e.reason, message: e.message, status: e.status, requestedUrl: e.url, query };
    ttl = MUNS_FAIL_TTL_S;
  }
  payload.fetchedAt = new Date().toISOString();
  const { body, tag } = withTag(payload);
  const res = tagged(body, tag, ttl);
  ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
  return revalidate(request, res, 'miss');
}

async function handleMuns(request, env, ctx, kind, rawTicker = '') {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  let from = iso(url.searchParams.get('from'));
  let to = iso(url.searchParams.get('to'));
  if (kind === 'announcements') {
    try { ({ from, to } = announcementRange(url.searchParams.get('from') || url.searchParams.get('fromDate'), url.searchParams.get('to') || url.searchParams.get('toDate'))); }
    catch (err) { return json({ ok: false, reason: 'shape', message: err.message }, 400); }
  }

  // A ticker is a path segment on two of these routes, so it is validated rather than passed
  // through: this must not become an open proxy to arbitrary upstream paths.
  let ticker;
  try { ticker = decodeURIComponent(rawTicker).trim().toUpperCase(); }
  catch { return json({ ok: false, reason: 'shape', message: 'That is not a valid ticker.' }, 400); }
  const tickerPattern = ['announcements', 'domestic'].includes(kind) ? /^[A-Z0-9&._-]{1,80}$/ : /^[A-Z0-9&.\-]{1,20}$/;
  if (kind !== 'news' && !tickerPattern.test(ticker)) {
    return json({ ok: false, reason: 'shape', message: 'That is not a ticker this route will ask about.' }, 400);
  }

  const query = kind === 'news' ? (url.searchParams.get('q') || '').trim().slice(0, 200) : null;
  if (kind === 'news' && !query) {
    return json({ ok: false, reason: 'shape', message: 'A news search needs ?q=.' }, 400);
  }

  const form = kind === 'domestic' ? url.searchParams.get('form') || 'all' : null;
  if (form && !Object.hasOwn(DOMESTIC_FORMS, form)) return json({ ok: false, reason: 'shape', message: 'Choose all, concalls, annual_report or earnings_report.' }, 400);
  const cacheKey = edgeKey(`muns-${kind}?t=${encodeURIComponent(ticker)}&q=${encodeURIComponent(query || '')}&from=${from || ''}&to=${to || ''}${form ? `&form=${form}&schema=2` : kind === 'announcements' ? '&schema=2' : ''}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return revalidate(request, hit, 'hit');

  let payload;
  let ttl = MUNS_TTL_S[kind];
  try {
    if (kind === 'news') payload = { ok: true, kind, ...(await fetchNews({ query, country: url.searchParams.get('country') || 'IN', fromDate: from, toDate: to }, env)) };
    else if (kind === 'announcements') payload = { ok: true, kind, ...(await fetchAnnouncements({ ticker, fromDate: from, toDate: to }, env)) };
    else if (kind === 'domestic') payload = { ok: true, kind, ...(await fetchDomesticFilings({ ticker, form }, env)) };
    else payload = { ok: true, kind, ...(await fetchInsiderTrades({ ticker, country: 'india', fromDate: from, toDate: to }, env)) };
  } catch (err) {
    const e = err instanceof MunsError ? err : new MunsError('upstream', String(err?.message || err));
    // THE REQUESTED URL TRAVELS WITH THE FAILURE. A bare status code is unfalsifiable — the last
    // time that rule was broken here it cost a long investigation during which the upstream was
    // healthy the whole time. See "an upstream you CANNOT proxy" in CLAUDE.md.
    payload = { ok: false, kind, reason: e.reason, message: e.message, status: e.status, requestedUrl: e.url, ticker: ticker || null, query };
    ttl = MUNS_FAIL_TTL_S;
  }

  payload.fetchedAt = new Date().toISOString();
  const { body, tag } = withTag(payload);
  const res = tagged(body, tag, ttl);
  ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
  return revalidate(request, res, 'miss');
}

// ---------------------------------------------------------------------------------------
// GET /api/concalls — live StockScans analysis plus the scheduled Screener document index.
//
// INDEPENDENT CACHES, ONE ROUTE, BECAUSE THE SOURCES MOVE AT DIFFERENT SPEEDS.
// A quarter is ~880 calls across 18 pages. Re-pulling all eighteen every 30 seconds to catch one
// new row would be both slow and rude to someone else's server. But the feed descends by call
// time from offset 0, verified across a full quarter, so a call that has just been analysed can
// only appear on page ONE. That makes the split safe:
//
//   HEAD  offset 0, 50 rows   — cached CONCALL_HEAD_TTL_S (30s). The freshness path.
//   TAIL  offset 50 onwards   — cached CONCALL_TAIL_TTL_S (10 min). It cannot change.
//
// The head is merged OVER the tail, so a row whose analysis landed between the two fetches is
// taken from the head with its score rather than from the tail without one. The complete Screener
// Actions artifact is checked once a minute, then grouped by company/publication date and joined
// to the nearest unambiguous analysis call. Every distinct document survives that grouping.
//
// In steady state that is one upstream request per 30 seconds instead of eighteen.
//
// AND WHY THERE IS NO ?fields= PROJECTION HERE, UNLIKE /api/earnings.
// Nothing on a con-call row moves on a tick. A row appears when the call is held and changes once
// more when StockScans finishes analysing it — a handful of times an hour in season, never
// otherwise. So the conditional GET does the whole job: 119 of every 120 polls are answered with
// a 304 and no body, and the one that is not has to carry the changed rows anyway. Splitting the
// payload would save a few hundred KB an hour and add a merge path that could drift from the
// server's truth; the earnings feed pays that complexity only because its price field leaves it
// no choice.
// ---------------------------------------------------------------------------------------
const CONCALL_HEAD_TTL_S = 30;
const CONCALL_TAIL_TTL_S = 600;
const CONCALL_SCHEDULE_TTL_S = 120;
const CONCALL_SCREENER_TTL_S = 60;
const CONCALL_SCREENER_DISPATCH_COOLDOWN_S = 15 * 60;
const CONCALL_SNAPSHOT = '/data/concall-scans.json';

// ---------------------------------------------------------------------------------------
// NSE live announcements — the one exchange feed that can be narrowed to a reader's companies
// ---------------------------------------------------------------------------------------
//
// The browser cannot read NSE (CORS `null`), so this proxies it: fetch the RSS with a full desktop
// user-agent (a weak one is Akamai-blocked), resolve each filing's company name to a ticker, and
// return JSON the page can narrow by scope. Edge-cached NSE_TTL_S so a thousand readers cost NSE one
// fetch per window; a content ETag lets an unchanged poll come back a bodyless 304.
//
// Resolution needs the universe, so the resolver is built once from three committed files and cached
// in module scope across requests — rebuilding it per request would parse ~700 KB of JSON every tick.

const NSE_TTL_S = 90;
const NSE_SNAPSHOT = '/data/nse-announcements.json';
let nseResolver = null;

async function nseResolverFor(env, request) {
  if (nseResolver) return nseResolver;
  const read = async (path) => {
    try {
      const r = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const [mc, tech, book] = await Promise.all([
    read('/data/mc-ticker-map.json'),
    read('/data/technicals.json'),
    read('/data/portfolio-companies.json'),
  ]);
  nseResolver = buildResolver({
    book: book?.holdings || [],
    mcMap: mc?.map || {},
    tech: tech?.rows || tech?.companies || [],
  });
  return nseResolver;
}

// A weak user-agent is refused; a slow fetch is bounded and retried once, because NSE is behind the
// same best-effort Akamai edge as the rest of the exchange.
async function fetchNseXml() {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(NSE_FEED_URL, { headers: NSE_HEADERS, signal: AbortSignal.timeout(15000) });
      const body = await res.text();
      if (!res.ok) { lastErr = new Error(`NSE HTTP ${res.status}`); continue; }
      assertNseShape(body, { status: res.status });
      return body;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('NSE unreachable');
}

async function loadNseSnapshot(env, request) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(NSE_SNAPSHOT, request.url)));
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function handleNseAnnouncements(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const cache = caches.default;
  const cacheKey = edgeKey('nse-announcements');
  const hit = await cache.match(cacheKey);
  if (hit) return revalidate(request, new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), 'x-sattva-cache': 'hit' } }), 'hit');

  try {
    const xml = await fetchNseXml();
    const resolver = await nseResolverFor(env, request);
    const rows = resolveNse(parseAnnouncements(xml), resolver);
    const resolved = rows.filter((r) => r.ticker).length;
    const payload = {
      ok: true,
      capturedAt: new Date().toISOString(),
      count: rows.length,
      resolved,
      unresolved: rows.length - resolved,
      rows,
    };
    const { body, tag } = withTag(payload);
    const stored = tagged(body, tag, NSE_TTL_S, { 'x-sattva-cache': 'live' });
    ctx?.waitUntil?.(cache.put(cacheKey, stored.clone()));
    return revalidate(request, stored, 'miss');
  } catch (err) {
    // NSE is unreachable or refused us — serve the committed snapshot rather than nothing, labelled
    // so the page can say the age is the snapshot's, not a live read. `blocked` is Akamai saying no,
    // which is a wait-and-retry state, not a bug in anything here.
    const snap = await loadNseSnapshot(env, request);
    if (snap) {
      const { body, tag } = withTag({ ...snap, ok: true, degraded: `NSE is unavailable (${err?.reason || err?.message || err}) — showing the last committed snapshot.` });
      return revalidate(request, tagged(body, tag, 15), 'fallback');
    }
    return json({ ok: false, reason: err?.reason || 'unreachable', degraded: `NSE is unreachable and no snapshot is committed: ${String(err?.message || err)}`, rows: [] }, 502);
  }
}

function screenerNeedsRefresh(source, now = Date.now()) {
  const checkedAt = Date.parse(source?.checkedAt || '');
  return source?.status !== 'ok' || !Number.isFinite(checkedAt) || now - checkedAt > SCREENER_CONCALL_FRESH_MS;
}

async function dispatchScreenerRefresh(env) {
  const cfg = githubConfig(env);
  if (cfg.error) return;
  const cache = caches.default;
  const key = edgeKey('concalls/screener-refresh-dispatch');
  if (await cache.match(key)) return;
  // Write the cooldown before calling GitHub. A credential or publisher failure should retry on a
  // measured cadence, not make every reader start another runner. dispatchWorkflow independently
  // declines an in-flight run, which closes the race between locations.
  await cache.put(key, new Response('1', { headers: { 'cache-control': `public, max-age=${CONCALL_SCREENER_DISPATCH_COOLDOWN_S}` } }));
  try {
    await dispatchWorkflow(fetch, cfg, SCREENER_CONCALL_WORKFLOW, cfg.ref, { source: 'auto', full: 'false' });
  } catch (error) {
    console.error(JSON.stringify({ message: 'Screener concall refresh dispatch failed', reason: error?.code || 'upstream' }));
  }
}

async function handleConcalls(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const cache = caches.default;

  // A tiny helper so the three sub-fetches share one caching shape. Each caches its own JSON
  // under its own key and TTL; the route itself is never cached as a whole, because its parts
  // expire at very different rates.
  const cached = async (key, ttl, load) => {
    const cacheKey = edgeKey(`concalls/${key}`);
    const hit = await cache.match(cacheKey);
    if (hit) return { value: await hit.json(), fresh: false };
    const value = await load();
    // These three entries are internal scratch, never handed to a client, so the tag is only
    // there because `tagged` wants one — nothing revalidates against it. The client-facing
    // validator is computed once over the assembled payload below.
    ctx?.waitUntil?.(cache.put(cacheKey, tagged(JSON.stringify(value), contentTag(key), ttl)));
    return { value, fresh: true };
  };

  try {
    const [head, tail, sched, screener] = await Promise.all([
      cached('head', CONCALL_HEAD_TTL_S, () => fetchConcallScans({ pages: 1 })),
      cached('tail', CONCALL_TAIL_TTL_S, () => fetchConcallScans({ pages: 'all', startOffset: PAGE_SIZE })),
      cached('schedule', CONCALL_SCHEDULE_TTL_S, async () => {
        const [upcoming, today] = await Promise.all([fetchUpcoming(), fetchToday()]);
        return { upcoming, today };
      }),
      cached('screener-v1', CONCALL_SCREENER_TTL_S, async () => {
        try {
          return await readScreenerConcallCollector({
            token: env.GH_DISPATCH_TOKEN,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
          });
        } catch {
          // Scores remain live when the scheduled document index is unavailable. The payload says
          // which half is missing; an auxiliary source must never blank the primary analysis feed.
          return {
            capture: null,
            source: {
              id: 'screener-concalls',
              status: 'failed',
              checkedAt: new Date().toISOString(),
              publishedTotal: 0,
              records: 0,
              fullHistory: false,
            },
          };
        }
      }),
    ]);

    const stockscansRows = mergeScans(head.value.rows, tail.value.rows);
    if (!stockscansRows.length) throw new Error('upstream returned no rows');
    const rows = screener.value.capture
      ? enrichConcallScans(stockscansRows, screener.value.capture.rows)
      : stockscansRows;

    const payload = {
      ok: true,
      degraded: null,
      rows,
      upcoming: sched.value.upcoming || [],
      // Portfolio-only schedule from the exact S Screen dashboard. Kept separate from the
      // market-wide StockScans schedule so the browser can enforce scope without guessing.
      portfolioUpcoming: screener.value.capture?.portfolioUpcoming || [],
      today: sched.value.today || { day: null, rows: [] },
      meta: {
        ...head.value.meta,
        total: rows.length,
        stockscansTotal: stockscansRows.length,
        headRows: head.value.rows.length,
        tailRows: tail.value.rows.length,
        screener: screener.value.source,
        // True if OUR page bound stopped the walk, not the feed's own end. A truncated quarter
        // must not be presented as the whole quarter.
        truncated: !!tail.value.meta.truncated,
      },
    };
    // The body deliberately carries no "served at" stamp. It would differ on every request while
    // the content did not, so the ETag would never match and the 304 this route exists for would
    // never fire. `meta.fetchedAt` — when the upstream was actually read — is the honest freshness
    // signal, and the client stamps its own "last checked" on every poll, 304s included.
    if (screenerNeedsRefresh(screener.value.source)) ctx?.waitUntil?.(dispatchScreenerRefresh(env));
    const { body, tag } = withTag(payload);
    return revalidate(request, tagged(body, tag, CONCALL_HEAD_TTL_S, { 'x-sattva-head': head.fresh ? 'fresh' : 'cached' }), head.fresh ? 'miss' : 'hit');
  } catch (err) {
    const fallback = await loadConcallSnapshot(env, request);
    if (!fallback) {
      return json({ ok: false, degraded: `StockScans is unreachable and no snapshot is available: ${String(err.message || err)}`, rows: [] }, 502);
    }
    const { body, tag } = withTag({
      ...fallback,
      ok: true,
      degraded: `StockScans is unavailable (${String(err.message || err)}) — showing the last committed snapshot.`,
    });
    return revalidate(request, tagged(body, tag, 15), 'fallback'); // retry sooner than a normal window
  }
}

// ---------------------------------------------------------------------------------------
// THERE IS NO /api/chatter, AND THERE CANNOT BE. Read this before adding one.
//
// The retail-chatter upstream is another Cloudflare Worker on this same account,
// `sentimentdash-api.<subdomain>.workers.dev`. A route here that proxied it was written, deployed,
// and returned 404 in production while `curl` got 200 from the identical URL.
//
// The cause is a platform rule: **Cloudflare refuses a subrequest from one Worker to another
// Worker's `*.workers.dev` hostname on the same zone** — error 1042, "Worker tried to fetch from
// another Worker on the same zone, which is not allowed" — and surfaces it as a 404. That is
// indistinguishable from the upstream being absent, which is exactly how it was first misread.
//
// Every other upstream here is off-zone (moneycontrol.com, stockscans.in, devde.muns.io), so this
// is the only route that could ever have hit it, and no amount of fixing the client would help.
//
// The browser calls that API directly instead — see js/data/chatter-live.js. It is public,
// CORS-open, exposes its ETag and answers `If-None-Match` with a 304, so nothing is lost. The
// Concall Deep Dive Worker is called from the browser for the same reason.
//
// If it ever needs to be proxied — to hold a credential, say — the options are a Cloudflare
// SERVICE BINDING (`"services"` in wrangler.jsonc, which is the supported same-account path) or
// giving that Worker a custom domain so it leaves the workers.dev zone. Not another fetch.
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// GET /api/super-investors  and  GET /api/super-investors/{slug}
//
// A THIN, AUTHENTICATED PROXY — and the edge cache is the point, not a nicety.
//
// The upstream scrapes finology.in on every call. Shareholding data moves ONCE A QUARTER, so
// serving a hundred readers a hundred fresh scrapes would be pure waste on somebody else's
// service. The edge holds each response for hours; the browser then revalidates against our
// ETag and gets a bodyless 304, so a repeat visit costs a header exchange.
//
// The fan-out is deliberately NOT here. One route returns one investor, and the client walks the
// list a few at a time — see js/data/super-investors.js. A `?full=1` that fetched sixty books in
// one request would turn a cold cache into sixty simultaneous scrapes upstream.
//
// FAILURE IS REPORTED BY KIND, because the fixes differ. A missing or expired token is a
// credential to renew; an unreachable host is a service to wait for. The UI says which.
//
// THE EDGE CACHE IS THE POINT, AND FOR A LONG TIME IT WAS ONLY A COMMENT.
//   The paragraph above claimed "the edge holds each response for hours" and nothing implemented
//   it. `caches.default` was consulted by /api/earnings, /api/earnings-calendar and /api/concalls
//   and by neither of these two routes, so a `cache-control: max-age=21600` header was the whole
//   mechanism — and the client fetches with `cache: 'no-cache'`, which revalidates unconditionally
//   and therefore never reuses it. Every reader with a cold device store made the upstream scrape
//   finology.in ninety-one times, at about a second apiece.
//
//   That is the wait the reader was seeing, and it was pure waste: ninety-one readers asked for
//   the same ninety-one pages and every one of them was fetched afresh. The routes now go through
//   `investorRoute`, which reads the edge first and writes it on the way out, exactly as the other
//   three do. Warm, a book costs a cache read instead of somebody else's page load.
//
// AND A LAST-GOOD COPY, BECAUSE AN OUTAGE IS NOT A REASON TO SHOW NOTHING.
//   Every other upstream here degrades to a snapshot and says so. This one had no fallback at all:
//   when the API restarted, a reader who had a perfectly good copy at the edge from twenty minutes
//   earlier got a wall of prose instead. Successes are now also written to a long-lived `last-good`
//   entry, and a failure serves that — marked `stale: true`, carrying its ORIGINAL `fetchedAt`, and
//   never for longer than INVESTOR_STALE_TTL_S so recovery is quick. It is labelled, not laundered.
// ---------------------------------------------------------------------------------------

// Six hours. Quarterly data with a generous margin: even at the very end of a window the figure
// on screen is the same figure the source would give.
const INVESTOR_TTL_S = 6 * 60 * 60;
// How long a successful read is kept as the fallback. Long, because a fortnight-old shareholding
// pattern under a "last read on <date>" label is worth incomparably more than an empty panel, and
// this entry is only ever reached when a live read has just failed.
const INVESTOR_LAST_GOOD_TTL_S = 14 * 24 * 60 * 60;
// How long a STALE answer may be reused before the upstream is tried again. Short: the whole point
// is that recovery reaches the screen quickly.
const INVESTOR_STALE_TTL_S = 30;
// An error must not be cached for the length of a success, or pasting the right token would appear
// not to have worked until the afternoon. It IS cached briefly, though — see investorRoute.
const ERROR_TTL_S = 15;

const INVESTOR_SOURCE = 'Ticker Finology, via devde.muns.io';

function handleInvestorList(request, env, ctx) {
  return investorRoute(request, ctx, 'super-investors', () => fetchInvestorList(fetch, env.MUNS_TOKEN, env.MUNS_BASE), {
    count: 0,
    investors: [],
  });
}

function handleInvestorPortfolio(request, env, ctx, slug) {
  if (!isSlug(slug)) {
    return json({ ok: false, error: 'bad-slug', message: 'An investor slug may only contain a-z, 0-9 and hyphens.' }, 400);
  }
  return investorRoute(request, ctx, `super-investors/${slug}`, () => fetchInvestorPortfolio(fetch, env.MUNS_TOKEN, slug, env.MUNS_BASE), {
    slug,
    quarters: [],
    holdings: [],
  });
}

/**
 * Both investor routes, which differ only in what they load and what an empty one looks like.
 *
 * Order of preference, and each step exists because the one below it is worse:
 *   1. the edge copy, if it is inside its six-hour window          — no upstream call at all
 *   2. a live read                                                 — one scrape, then cached
 *   3. the last-good copy, marked `stale`                          — labelled, never laundered
 *   4. a named failure                                             — a 200 with `ok: false`
 *
 * That last shape is the one /api/concalls uses for its degraded case, and it is a 200 on purpose:
 * the request to THIS Worker succeeded, and what failed was the upstream. The body says which by
 * name, so the panel can tell a reader whose problem it is — `no-token` and `unauthorised` are a
 * credential for the operator to fix, everything else is a service to wait for. A bare 502 would
 * collapse those into one unreadable state, and the store layer would discard the body explaining
 * it. `holdings: []` never travels without `ok: false` beside it, so a book that failed to load
 * can never read as an investor who holds nothing.
 *
 * Steps 3 and 4 are BOTH written to the fresh key for a few seconds. Without that, an upstream
 * outage costs every one of the ninety-one requests its own full timeout, so the failure a reader
 * waits through is ninety-one times longer than the one failure that actually happened.
 */
async function investorRoute(request, ctx, key, load, empty) {
  const cache = caches.default;
  const freshKey = edgeKey(key);
  const lastGoodKey = edgeKey(`${key}::last-good`);

  const hit = await cache.match(freshKey);
  if (hit) return revalidate(request, hit, 'hit');

  try {
    const data = await load();
    const { body, tag } = withTag({ ok: true, stale: false, source: INVESTOR_SOURCE, fetchedAt: new Date().toISOString(), ...data });
    // Two independent Responses, not one cloned: `tagged` builds from the serialised string, so
    // each call produces a fresh unread body and neither put can consume the one being returned.
    ctx?.waitUntil?.(cache.put(freshKey, tagged(body, tag, INVESTOR_TTL_S)));
    ctx?.waitUntil?.(cache.put(lastGoodKey, tagged(body, tag, INVESTOR_LAST_GOOD_TTL_S)));
    return revalidate(request, tagged(body, tag, INVESTOR_TTL_S), 'live');
  } catch (err) {
    const reason = err?.code || 'upstream';
    // A bad slug is the caller's mistake and an unknown investor genuinely does not exist. Neither
    // is a service condition, so neither may serve a stale copy or be cached as one.
    if (reason === 'not-found') return json({ ok: false, reason, message: String(err?.message || err), ...empty }, 404);

    const stale = await readLastGood(cache, lastGoodKey);
    const { body, tag } = stale
      ? withTag({
          ...stale,
          ok: true,
          stale: true,
          // `fetchedAt` KEEPS THE ORIGINAL READ TIME. It means "when the upstream was read", and
          // restamping it with now() would be the cache claiming a freshness it does not have —
          // the one thing the whole store layer is built not to do. The client stamps its own
          // `checkedAt` on every response, which is the other, different fact.
          staleReason: String(err?.message || err),
          reason,
        })
      : withTag({ ok: false, stale: false, reason, message: String(err?.message || err), fetchedAt: new Date().toISOString(), ...empty });

    const ttl = stale ? INVESTOR_STALE_TTL_S : ERROR_TTL_S;
    ctx?.waitUntil?.(cache.put(freshKey, tagged(body, tag, ttl)));
    return revalidate(request, tagged(body, tag, ttl), stale ? 'stale' : reason);
  }
}

/**
 * The last successful read of one key, or null.
 *
 * Never throws and never blocks the failure path for long: this runs only after a live read has
 * already failed, and a fallback that could itself hang would turn one outage into two.
 */
async function readLastGood(cache, key) {
  try {
    const res = await cache.match(key);
    if (!res) return null;
    const body = await res.json();
    return body && body.ok !== false ? body : null;
  } catch {
    return null;
  }
}

/** The committed con-call snapshot, read through the ASSETS binding. */
async function loadConcallSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(CONCALL_SNAPSHOT, request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The committed calendar capture, read through the ASSETS binding. Null if it isn't there. */
async function loadCalendarSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/earnings-calendar.json', request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** "2026-08-11", -7 -> "2026-08-04". UTC arithmetic so a timezone can never move a date. */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The committed scID -> identity map, read through the ASSETS binding. */
async function loadTickerMap(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/mc-ticker-map.json', request.url)));
    if (!res.ok) return null;
    return (await res.json())?.map || null;
  } catch {
    return null;
  }
}

/** The committed last-good file, read through the ASSETS binding. Null if it isn't there. */
async function loadSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(EARNINGS_SNAPSHOT, request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POST /api/live-prices — on-demand intraday quotes for the Breakouts tab.
 *
 * A PARTIAL RESULT IS A SUCCESS, AND IT SAYS WHICH NAMES IT IS MISSING.
 * Some cold reads will overrun the budget however it is set — that is the upstream's shape, not
 * a bug to tune away. Failing all sixty because eight were slow throws away fifty-two good quotes
 * and tells the reader nothing. So the response carries `requested`, `ticker_count` and a
 * `missing[]` naming every ticker that did not land AND why, and the caller renders that instead
 * of a bare "failed". The names that did land are also now warm at the edge and upstream, so
 * clicking again genuinely completes the set — which is a thing the UI can only offer honestly
 * because the response says what is outstanding.
 *
 * Only a refresh that retrieved NOTHING is an error. That distinction is the same one the rest of
 * this dashboard makes everywhere: an empty result and a failed read must never render alike.
 */
async function handleLivePrices(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let tickers;
  try {
    const body = await request.json();
    tickers = Array.isArray(body?.tickers) ? body.tickers : [];
  } catch {
    return json({ error: 'bad request body' }, 400);
  }
  const requested = [...new Set(tickers.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
  const capped = requested.slice(0, MAX_TICKERS);
  if (!capped.length) return json({ error: 'no tickers' }, 400);

  const started = Date.now();
  const deadline = started + QUOTE_BUDGET_MS;
  const prices = {};
  const missing = [];

  // 1. The edge first. These are local lookups, not subrequests, so asking for all of them at
  //    once costs nothing — and on a second click within the TTL this answers the whole batch
  //    without touching the upstream at all.
  const cache = await openCache();
  const cold = [];
  await Promise.all(
    capped.map(async (t) => {
      const hit = await cacheGetQuote(cache, t);
      if (hit) prices[t] = hit;
      else cold.push(t);
    })
  );
  const fromCache = capped.length - cold.length;

  // 2. Everything still cold, a few at a time, each timer starting when its request does.
  await pooled(cold, QUOTE_POOL, async (ticker) => {
    if (Date.now() >= deadline) {
      missing.push({ ticker, reason: 'deadline' });
      return;
    }
    const res = await fetchQuote(ticker, deadline);
    if (res.quote) {
      prices[ticker] = res.quote;
      // Written back so the next reader — and the next click — gets it for free. `waitUntil`
      // keeps the write off the response's critical path.
      ctx?.waitUntil?.(cachePutQuote(cache, ticker, res.quote));
    } else {
      missing.push({ ticker, reason: res.reason });
    }
  });

  for (const t of requested.slice(MAX_TICKERS)) missing.push({ ticker: t, reason: 'over-cap' });

  const count = Object.keys(prices).length;
  const elapsedMs = Date.now() - started;

  // A refresh that fetched nothing is a failure, not an empty "fresh" feed — the caller keeps its
  // last-known prices rather than blanking the display. It carries the upstream it asked and what
  // went wrong: a bare status code is unfalsifiable, and diagnosing this route once already cost
  // an investigation that a named reason would have ended immediately.
  if (!count) {
    return json(
      {
        error: 'no quotes retrieved',
        upstream: MUNSHOT_API,
        requested: capped.length,
        elapsed_ms: elapsedMs,
        reasons: tallyReasons(missing),
        missing,
      },
      502
    );
  }

  return json(
    {
      generated_at: new Date().toISOString(),
      source: 'Munshot quote API (on-demand refresh)',
      upstream: MUNSHOT_API,
      // The FULL deduped ask, not the capped slice, so `ticker_count + missing.length` always
      // reconciles against it. Reporting the cap as the ask would hide the over-cap names inside
      // a total that never counted them — a silent truncation wearing an honest-looking number.
      requested: requested.length,
      ticker_count: count,
      cached_count: fromCache,
      partial: count < capped.length,
      elapsed_ms: elapsedMs,
      missing,
      prices,
    },
    200
  );
}

/**
 * Run `job` over `items` with at most `limit` in flight.
 *
 * The point is not politeness. `Promise.all` over sixty fetches starts sixty
 * `AbortSignal.timeout` clocks at once while the runtime runs about six connections, so the
 * queued requests spend their whole budget waiting for a socket and abort before they are ever
 * sent. Here a timer only starts when its request does. `job` is expected to absorb its own
 * failures; one rejection must not cancel the pool.
 */
async function pooled(items, limit, job) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await job(item);
      } catch {
        /* job records its own failures */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One quote from Munshot. Never throws — returns `{ quote }` or `{ reason }`, because the caller
 * needs to tell the reader WHY a name is missing, and "null" cannot.
 *
 * The per-attempt timeout is clamped to whatever is left of the route's budget, so a slow read
 * cannot push the whole response past the deadline it is supposed to respect.
 */
async function fetchQuote(ticker, deadline) {
  let reason = 'unreachable';
  for (let attempt = 0; attempt < QUOTE_ATTEMPTS; attempt++) {
    const budget = Math.min(QUOTE_TIMEOUT_MS, deadline - Date.now());
    if (budget <= 0) return { reason: attempt ? reason : 'deadline' };
    try {
      const r = await fetch(MUNSHOT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker_symbol: ticker, type: 'stockquote', country: 'india' }),
        signal: AbortSignal.timeout(budget),
      });
      if (!r.ok) {
        reason = `http-${r.status}`;
        // A 4xx is an answer about this ticker — retrying just asks the same question again and
        // spends budget a cold name behind it in the queue could have used.
        if (r.status >= 400 && r.status < 500) return { reason };
        throw new Error(reason);
      }
      const body = await r.json(); // the API returns a quoted CSV-ish string
      if (typeof body !== 'string') return { reason: 'shape' };
      const quote = parseQuote(body);
      return quote ? { quote } : { reason: 'unparseable' };
    } catch (e) {
      if (!String(reason).startsWith('http-')) {
        reason = /timeout|abort/i.test(String(e?.name || e?.message || '')) ? 'timeout' : 'unreachable';
      }
      // A timeout here means the upstream had this ticker cold, and a cold read costs 8-15s.
      // Immediately asking the same cold question again spends another 15s of a 25s budget on
      // one name while a dozen others have not been started at all — so a timeout ends this
      // ticker's turn. The attempt was not wasted: it left the ticker warming upstream, which is
      // exactly why the caller is told to click again rather than told it failed.
      if (reason === 'timeout' || attempt === QUOTE_ATTEMPTS - 1) return { reason };
      await new Promise((res) => setTimeout(res, 300)); // brief pause before the single retry
    }
  }
  return { reason };
}

function tallyReasons(missing) {
  const out = {};
  for (const m of missing) out[m.reason] = (out[m.reason] || 0) + 1;
  return out;
}

// ---- the per-ticker quote cache -----------------------------------------------------------
// One entry per ticker rather than one per batch: two readers looking at different scopes ask
// for overlapping sets, and a batch-keyed entry would make each of them a full cold miss.

async function openCache() {
  try {
    return caches.default;
  } catch {
    return null; // no Cache API (a plain Node stand-in) — everything is simply a miss
  }
}

function quoteKey(ticker) {
  return edgeKey(`quote/${encodeURIComponent(ticker)}`);
}

async function cacheGetQuote(cache, ticker) {
  if (!cache) return null;
  try {
    const hit = await cache.match(quoteKey(ticker));
    if (!hit) return null;
    const q = await hit.json();
    return q && typeof q.current === 'number' ? q : null;
  } catch {
    return null; // a store miss is never an error; it means "fetch it"
  }
}

async function cachePutQuote(cache, ticker, quote) {
  if (!cache) return;
  try {
    await cache.put(
      quoteKey(ticker),
      new Response(JSON.stringify(quote), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${QUOTE_TTL_S}` },
      })
    );
  } catch {
    /* caching is an optimisation — never let it fail the request */
  }
}

// "Current Price=1341.8,...,Day Range=1268.9 - 1359.0,..." -> structured quote.
function parseQuote(str) {
  const kv = {};
  for (const part of str.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const range = (v) => {
    const m = String(v || '')
      .split('-')
      .map((s) => num(s));
    return m.length === 2 && m[0] != null && m[1] != null ? { lo: Math.min(m[0], m[1]), hi: Math.max(m[0], m[1]) } : null;
  };
  const day = range(kv['Day Range']);
  const wk = range(kv['52-Week Range']);
  const current = num(kv['Current Price']);
  if (current == null) return null;
  return {
    current,
    open: num(kv['Opening Price']),
    prevClose: num(kv['Previous Close']),
    dayHigh: day?.hi ?? null,
    dayLow: day?.lo ?? null,
    week52High: wk?.hi ?? null,
    week52Low: wk?.lo ?? null,
    ma50: num(kv['50-Day Moving Average']),
    ma200: num(kv['200-Day Moving Average']),
    vol10d: num(kv['10-Day Average Volume']),
    marketCap: num(kv['Market Cap']),
    yearlyChangePct: num(kv['Yearly Change (%)']),
  };
}

// ---------------------------------------------------------------------------------------
// POST /api/market-news/refresh — start a scrape.   GET /api/market-news/run — watch one.
//
// THE BUTTON THAT COULD NOT DO WHAT IT SAID, AND HOW IT CAN NOW.
//
// Everywhere else here "refresh" means "ask the upstream again". For market news it could not:
// `www.moneycontrol.com` answers a Cloudflare Worker with 403 exactly as it answers node's fetch,
// by TLS fingerprint rather than by headers, so there is no request this Worker can make that
// returns the news. The only reader that works is a normal GitHub runner with curl.
//
// So the button asks the runner to run. `workflow_dispatch` on market-news-refresh.yml, with the
// token held here and never in the browser, then a free poll of GitHub's own run status while it
// goes. The reader gets the thing they actually asked for — a fresh read of the publisher — and
// the page keeps being able to say truthfully where every number came from.
//
// FOUR RULES, AND THE FIRST THREE ARE THE DEEP DIVE RULES ARRIVING AGAIN.
//
//   1. WHAT COSTS AND WHAT DOES NOT ARE SEPARATE ROUTES, AND ONLY ONE OF THEM IS POST.
//      Nothing dispatches on a page load, on a render, or on a poll. `/run` is a plain read and
//      may be polled; `/refresh` happens on a click and nowhere else.
//   2. ASK BEFORE STARTING. `dispatchWorkflow` reads the latest run first and returns
//      `dispatched: false` if one is already going. The workflow's own concurrency group would
//      queue a duplicate harmlessly — this is about never being the thing that started a run
//      nobody needed.
//   3. REPRODUCE THEIR VOCABULARY. `status` and `conclusion` are passed through as GitHub writes
//      them. Translating `in_progress` into words of our own would describe their pipeline in our
//      language and drift the moment they changed it.
//   4. A FAILURE IS NAMED, BECAUSE THE FIXES DIFFER. `no-token` and `no-repo` are one command for
//      an operator; `unauthorised` is a token to reissue; `not-found` is ambiguous between a
//      missing workflow and a token that cannot see the repository, and says both. Collapsing
//      these into "could not refresh" throws away the only useful part of the failure.
//
// AND A COOLDOWN, BECAUSE THIS ROUTE IS UNAUTHENTICATED. The repository, the workflow and the ref
// are fixed here and are not readable from the request, so nobody who finds the URL can point it
// somewhere else — but they could still hold the button down. `DISPATCH_COOLDOWN_S` at the edge
// plus the in-flight check above means a click-storm costs one run. It is per-colo and therefore
// best-effort, which is why it is the second line of defence and not the first.
// ---------------------------------------------------------------------------------------

const DISPATCH_COOLDOWN_S = 120;
// A universe company-news walk is roughly ten minutes. Hold the automatic route across that
// window so readers arriving in different moments cannot start a second run during publish lag.
const COMPANY_NEWS_DISPATCH_COOLDOWN_S = 15 * 60;
// A full universe filings walk takes roughly ten minutes. The cooldown spans the scrape and the
// publish delay, so readers arriving in different moments cannot queue duplicate work.
const FILINGS_DISPATCH_COOLDOWN_S = 30 * 60;
// BSE's date index is cheap, but a deploy still takes a couple of minutes.
const ANNOUNCEMENTS_DISPATCH_COOLDOWN_S = 10 * 60;
// End-of-day technicals can take most of an hour and must never overlap themselves.
const DATA_DISPATCH_COOLDOWN_S = 60 * 60;
// Short, because this one is usually a reader who has just added an account and is waiting to see
// its posts. The duplicate-run guard in dispatchWorkflow is what stops a second run either way.
const TWITTER_DISPATCH_COOLDOWN_S = 3 * 60;
const RUN_STATUS_TTL_S = 5; // so twenty readers watching one run cost GitHub four calls a minute
// How far back `lastAutomatic` looks. Ten runs is about a day at the schedule's own cadence.
const RUN_WINDOW = 10;
// A run nobody had to press a button for: an external scheduler (`cron`), or the tab fetching for
// a reader who opened it on a stale capture (`auto`). `github-cron` is GitHub's own schedule.
const AUTOMATIC_RUN = /\((?:github-)?cron\)|\(auto\)/i;

/**
 * What the Worker can actually SEE, for when `no-token` is the answer and nobody believes it.
 *
 * The operator added the secret, the route still said `no-token`, and there was no way to tell a
 * typo in the name from a change that was never deployed from a secret on a different Worker.
 * "It is not there" is a true statement that diagnoses nothing.
 *
 * NAMES ONLY, AND BOOLEANS FOR THE VALUES. Binding names are not secrets — `GH_REPO`, `GH_REF` and
 * both token names are in the public repository already — while the values never appear. What this
 * buys is the one thing guessing cannot: a key named `GH_DISPATH_TOKEN` shows up in `githubKeys`
 * immediately, and `munsToken: true` beside `dispatchToken: false` proves dashboard secrets reach
 * this Worker in general, so the fault is that one binding rather than the whole configuration.
 */
function visibleConfig(env) {
  return {
    githubKeys: Object.keys(env || {})
      .filter((k) => /^(GH|GITHUB)/i.test(k))
      .sort(),
    dispatchToken: !!env?.GH_DISPATCH_TOKEN,
    munsToken: !!env?.MUNS_TOKEN,
    repo: env?.GH_REPO || null,
    ref: env?.GH_REF || null,
  };
}

/** Everything the two routes need, or a named reason they cannot run. */
function githubConfig(env) {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) {
    return {
      error: {
        ok: false,
        reason: 'no-token',
        message: 'This deployment has no GitHub token, so it cannot start a scrape.',
        visible: visibleConfig(env),
        // NAME THE PLACE THIS DEPLOYMENT ACTUALLY USES. This said `npx wrangler secret put …`,
        // which needs a terminal logged in to Cloudflare — and measured on the live deployment,
        // there isn't one: the site publishes through Cloudflare's own Git integration and the
        // repo's deploy workflow has been SKIPPED on every run for want of CLOUDFLARE_API_TOKEN.
        // So the only instruction the page could give named a route the operator does not have.
        // The dashboard is a web form and is the honest first answer; the command still works for
        // anyone who does have a terminal.
        fix: 'Cloudflare dashboard → Workers & Pages → this Worker → Settings → Variables and Secrets → add a Secret named GH_DISPATCH_TOKEN. (Or: npx wrangler secret put GH_DISPATCH_TOKEN)',
      },
    };
  }
  try {
    const { owner, repo } = parseRepo(env.GH_REPO);
    return { token, owner, repo, ref: env.GH_REF || 'main', ...(env.GH_API_BASE ? { base: env.GH_API_BASE } : {}) };
  } catch (err) {
    return {
      error: {
        ok: false,
        reason: err.code || 'no-repo',
        message: 'This deployment has no repository configured, so it cannot start a scrape.',
        fix: 'Set "GH_REPO": "owner/name" in wrangler.jsonc and redeploy.',
        configured: err.configured ?? null,
      },
    };
  }
}

/** A named failure becomes a 200 with `ok: false` — the request to US succeeded. */
function githubFailure(err) {
  const reason = err?.code || 'upstream';
  const fixes = {
    unauthorised: 'Reissue the token, then replace the GH_DISPATCH_TOKEN secret in the Cloudflare dashboard (Settings → Variables and Secrets).',
    forbidden: 'The token needs "Actions: read and write" on this repository.',
    'rate-limited': "GitHub's hourly limit for this token is spent. It resets on the hour.",
    refused: 'Check that the workflow exists on the configured branch and is not disabled.',
    'not-found': 'Check the workflow file name and that the token can see this repository.',
  };
  return {
    ok: false,
    reason,
    message: String(err?.message || err),
    // CARRY THE URL THAT WAS ASKED FOR. A bare "404" is unfalsifiable — that lesson cost a long
    // investigation on the chatter API while the upstream was healthy the whole time.
    requested: err?.url || null,
    ...(fixes[reason] ? { fix: fixes[reason] } : {}),
  };
}

/**
 * Who asked for this run, for the workflow's own run name.
 *
 * AN ALLOWLIST, NOT THE CALLER'S STRING. The value ends up in `run-name`, which GitHub renders in
 * their UI and which `lastAutomatic` matches on — so an arbitrary value from an unauthenticated
 * route would be somebody else's text in our run list, and could forge the "this was automatic"
 * label. Three words are the whole vocabulary; anything else is a button press.
 *
 * THE THREE ARE THREE DIFFERENT ANSWERS TO "IS THIS REFRESHING BY ITSELF", which is the question
 * this label exists for and the one that has been answered wrongly twice here:
 *
 *   cron    an external scheduler pinged the route — the cadence holds with nobody watching
 *   auto    a reader opened the tab on a stale capture and the page fetched without being asked
 *   button  a person pressed Fetch, having noticed the staleness themselves
 *
 * Only the last of those is the page failing at its job, so `lastAutomatic` counts the first two
 * and not the third. Folding `auto` into `button` would have made every unattended refresh
 * invisible to the one field that measures them — the same measurement gap, one layer down, that
 * `?source=` was added to close.
 */
const SOURCES = new Set(['cron', 'auto', 'button']);
const sourceOf = (url) => (SOURCES.has(url.searchParams.get('source')) ? url.searchParams.get('source') : 'button');

async function handleNewsDispatch(request, env, ctx) {
  return handleWorkflowDispatch(request, env, ctx, {
    workflow: NEWS_WORKFLOW,
    cacheName: 'mcnews-dispatch',
    cooldownS: DISPATCH_COOLDOWN_S,
  });
}

async function handleWorkflowDispatch(request, env, ctx, { workflow, cacheName, cooldownS, extraInputs = null }) {
  const cfg = githubConfig(env);
  if (cfg.error) return json(cfg.error, 200);
  const source = sourceOf(new URL(request.url));

  const cache = caches.default;
  const key = edgeKey(cacheName);
  const held = await cache.match(key);
  if (held) {
    const body = await held.json().catch(() => null);
    // NOT A FAILURE, AND IT MUST NOT READ AS ONE. A scrape was started moments ago and is what the
    // reader wanted; saying "too many requests" about their own click would be nonsense.
    return json({ ...(body || {}), ok: true, dispatched: false, reason: 'cooling-down', cooldownS }, 200);
  }

  try {
    const out = await dispatchWorkflow(fetch, cfg, workflow, cfg.ref, { source, ...(extraInputs || {}) });
    const payload = {
      ok: true,
      dispatched: out.dispatched,
      reason: out.dispatched ? 'dispatched' : 'already-running',
      run: out.run,
      workflow,
      source,
      requestedAt: new Date().toISOString(),
    };
    ctx.waitUntil(
      cache.put(key, new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${cooldownS}` } })),
    );
    return json(payload, 200);
  } catch (err) {
    return json(githubFailure(err), 200);
  }
}

/**
 * How the run is going — free, and therefore the half that may be polled.
 *
 * TWO WORKFLOWS, BECAUSE A SCRAPE FINISHING IS NOT THE NEWS ARRIVING. The scrape commits only when
 * it found something; `public/` reaches readers only when deploy.yml then runs. So a deploy that
 * STARTED AFTER the scrape finished is the evidence that something was committed, and its absence
 * is the evidence that the run found nothing new. Without that second read the page would have to
 * guess between "nothing was published" and "it is on its way", and those are different claims.
 */
async function handleNewsRunStatus(request, env, ctx) {
  return handleWorkflowRunStatus(env, ctx, {
    workflow: NEWS_WORKFLOW,
    cacheName: 'mcnews-run-status',
  });
}

async function handleWorkflowRunStatus(env, ctx, { workflow, cacheName }) {
  const cfg = githubConfig(env);
  if (cfg.error) return json(cfg.error, 200);

  const cache = caches.default;
  const key = edgeKey(cacheName);
  const held = await cache.match(key);
  if (held) return new Response(held.body, { status: 200, headers: { ...Object.fromEntries(held.headers), ...CORS, 'x-sattva-cache': 'hit' } });

  try {
    // A WINDOW, NOT THE LATEST RUN, FOR THE SCRAPE. `lastAutomatic` searches this list, so asking
    // for one run made it answerable only when the newest run happened to be automatic: a single
    // button press hid a cron that had fired minutes earlier, and the field read as though nothing
    // unattended had ever run. Ten covers about a day at the schedule's own cadence.
    const [scrapeRuns, deployRuns] = await Promise.all([
      latestRun(fetch, cfg, workflow, { perPage: RUN_WINDOW }),
      latestRun(fetch, cfg, DEPLOY_WORKFLOW, { perPage: 1 }).catch(() => []),
    ]);
    const payload = {
      ok: true,
      scrape: scrapeRuns[0] || null,
      publish: deployRuns[0] || null,
      // Whether the cadence is holding on its own, answerable without opening a run. Matches on
      // the run NAME rather than on `event`, because every dispatch carries event=workflow_dispatch
      // and a scheduler's dispatch is indistinguishable from a reader's by that field alone.
      lastAutomatic: scrapeRuns.find((r) => AUTOMATIC_RUN.test(r.title || '')) || null,
      inFlight: isInFlight(scrapeRuns[0]) || isInFlight(deployRuns[0]),
      servedAt: new Date().toISOString(),
    };
    const res = json(payload, 200);
    const store = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${RUN_STATUS_TTL_S}` } });
    ctx.waitUntil(cache.put(key, store));
    res.headers.set('x-sattva-cache', 'live');
    return res;
  } catch (err) {
    return json(githubFailure(err), 200);
  }
}

// A small, same-origin view of the committed captures. The browser uses it as a watchdog without
// downloading every multi-megabyte feed merely to learn its timestamp. Each source is independent:
// one missing file cannot erase the status of the others, and the short edge cache makes a busy
// dashboard cost one internal asset read per half-minute rather than one per reader.
const CAPTURE_STATUS_TTL_S = 30;
const CAPTURE_FILES = {
  companyFilings: '/data/filing-capture/index.json',
  companyNews: '/data/news.json',
  insider: '/data/insider-trades.json',
  announcements: '/data/corp-announcements.json',
  corporateActions: '/data/corporate-actions.json',
  technicals: '/data/technicals.json',
  marketNews: '/data/market-news.json',
};

// Read-only health signal for an independent uptime monitor. Never starts a capture or calls Muns.
async function handleFilingsHealth(request, env, ctx) {
  if (request.method !== 'GET') return json({ ok: false, reason: 'method', message: 'GET only.' }, 405);
  const key = edgeKey('filings-operational-health-v1');
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const report = await hit.json();
    return json(report, report.ok ? 200 : 503);
  }
  const captures = {};
  await Promise.all(Object.entries(FILINGS_HEALTH_FILES).map(async ([source, path]) => {
    try {
      const response = await env.ASSETS.fetch(new Request(new URL(`/data/${path}`, request.url)));
      if (!response.ok) throw new Error('Capture unavailable');
      captures[source] = await response.json();
    } catch { captures[source] = null; }
  }));
  const report = assessFilingsHealth(captures);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(report), {
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=30' },
  })));
  return json(report, report.ok ? 200 : 503);
}

async function handleCaptureStatus(request, env, ctx) {
  if (request.method !== 'GET') return json({ ok: false, reason: 'method', message: 'GET only.' }, 405);

  const cache = caches.default;
  const key = edgeKey('capture-status-v2');
  const held = await cache.match(key);
  if (held) {
    return new Response(held.body, {
      status: 200,
      headers: { ...Object.fromEntries(held.headers), ...CORS, 'x-sattva-cache': 'hit' },
    });
  }

  const captures = {};
  await Promise.all(
    Object.entries(CAPTURE_FILES).map(async ([name, path]) => {
      try {
        const response = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        // WHOSE FRESHNESS THIS IS, when a capture has several contributors.
        //
        // The market-news file is written by two jobs — the Moneycontrol listing walk and the RSS
        // reader — and its `capturedAt` is whichever ran last. The watchdog uses this value to
        // decide whether to dispatch the MONEYCONTROL workflow, so reading the top-level field
        // would let an hourly RSS run keep the timestamp fresh while Moneycontrol went unread for
        // days, and nothing would ever notice: the one measurement that exists to catch a stalled
        // source would be answered by a different source. So a per-source time is reported where
        // the file carries one, and `capturedAt` stays the whole capture's for everything else.
        const perSource = Array.isArray(body.sources)
          ? Object.fromEntries(body.sources.map((s) => [s.id, { capturedAt: s.capturedAt || null, ok: s.ok !== false }]))
          : null;
        captures[name] = {
          ok: true,
          capturedAt: body.capturedAt || body.generated_at || body.fetchedAt || body.lastRunFinishedAt || null,
          ...(perSource ? { sources: perSource } : {}),
          covered: Number.isFinite(body.covered) ? body.covered : Number.isFinite(body.company_count) ? body.company_count : null,
          failed: Number.isFinite(body.failedCount) ? body.failedCount : Number.isFinite(body.failures) ? body.failures : null,
          fallback: Number.isFinite(body.fallbackCount) ? body.fallbackCount : 0,
        };
      } catch (error) {
        captures[name] = { ok: false, capturedAt: null, reason: String(error?.message || error) };
      }
    }),
  );

  const payload = { ok: true, captures, servedAt: new Date().toISOString() };
  const store = new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CAPTURE_STATUS_TTL_S}` },
  });
  ctx.waitUntil(cache.put(key, store));
  const response = json(payload, 200);
  response.headers.set('x-sattva-cache', 'live');
  return response;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

/** Cache keys live on a hostname that cannot resolve, so an entry can never be confused for a fetch. */
function edgeKey(path) {
  return new Request(`https://cache.invalid/${path}`, { method: 'GET' });
}
