// ui/sources.js — the data-source registry behind the header's "Sources" button.
//
// This is presentation metadata, not a data source: it mirrors docs/DATA-CONTRACTS.md so a
// user can see, in one place, everything that feeds the dashboard and how fresh it is.
//
// KEEPING THIS ACCURATE IS PART OF ADDING A DATA SOURCE. When a real feed is wired,
// update three things together: the JSON contract in docs/DATA-CONTRACTS.md, the loader
// in js/app.js, and the entry here. `status` is the honest current state:
//   'live'    — a real feed is wired and refreshing on a schedule
//   'static'  — real data, committed to the repo, refreshed by hand rather than on a cron
//   'mock'    — placeholder data ships in the repo; the real source is named but not connected
//   'pending' — nothing exists yet; named so the gap is visible rather than hidden

import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime, formatNumber } from '../core/format.js';
import * as coverage from '../data/coverage.js';
import * as concalls from '../data/concall-scans.js';
import * as earningsLive from '../data/earnings-live.js';
import * as chatter from '../data/chatter-live.js';
import * as institutions from '../data/institution-holdings.js';
import * as technicals from '../data/technicals.js';
import { announcements as annFeed } from '../data/filings.js';
import * as marketNews from '../data/market-news.js';
import * as superInvestors from '../data/super-investors.js';
// NOT TYPED OUT. The threshold is stated in the General Alerts row reasons, its export and here; all
// three read the same constant, so changing it cannot leave one of them describing the old filter.
import * as dailyAlerts from '../data/daily-alerts.js';
import * as aiAlerts from '../data/ai-alerts.js';

// ---------------------------------------------------------------------------------------
// NO FIGURE ON THIS SCREEN MAY BE TYPED BY HAND.
//
// This registry used to describe each feed with the numbers that were true the day it was
// written: "1,319 companies in the current pull", "877 in the current pull", "37 Indian holdings
// worth ₹35,818 Cr as of Jun 2026", "142 companies from the family office statement". Every one
// of those is a measurement with a date on it, printed as though it were a property of the feed.
// They were already drifting, and in a year they would be describing a dashboard nobody is
// looking at — while reading, to anyone who did not know, exactly like the live counts beside
// them. A stale number is worse than no number, because it cannot be told apart from a fresh one.
//
// So every quantity below is READ WHEN THE MODAL OPENS, from the same module the tab reads.
// `num()` returns null rather than a zero when a feed has not loaded, and each sentence is
// written to lose the clause rather than print a wrong figure — "every earnings call held this
// quarter" is true forever; "877 of them" is true for about a day.
// ---------------------------------------------------------------------------------------

/** A live count, or null if the feed has not loaded. Never 0-as-unknown — see the header. */
function num(fn) {
  try {
    const v = fn();
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
/** `clause(n, '(<n> in the current pull)')` — drops the whole clause when the count is unknown. */
function clause(v, template) {
  return v == null ? '' : template.replace('<n>', formatNumber(v));
}
/** ₹ crore, rounded the way a headline figure should be: no false precision on a big number. */
function cr(v) {
  return v == null ? null : `₹${formatNumber(Math.round(v))} Cr`;
}

/**
 * "How this reached you" — the line every polled feed's provenance modal carries.
 *
 * A cached feed is the one case where the number on screen can be older than the moment you are
 * looking at it, so the reader is owed two separate facts, not one: when the upstream was actually
 * read (`fetchedAt`), and when we last confirmed that reading was still current (`checkedAt`). A
 * 304 moves the second and not the first, and collapsing them into a single "last updated" would
 * make a five-hour-old figure look like it arrived seconds ago.
 *
 * `origin` is where THIS paint came from: 'live' from the network, 'store' from this device's own
 * copy, 'snapshot' from the file committed to the repo.
 */
export function deliveryNote(meta, { poll } = {}) {
  if (!meta) return '';
  const stamp = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    return Number.isFinite(t) ? formatRelativeTime(t) : null;
  };
  const read = stamp(meta.fetchedAt);
  const checked = stamp(meta.checkedAt);
  const stale = meta.origin === 'store' && !checked;

  const where =
    meta.origin === 'snapshot'
      ? 'the snapshot committed to this repo'
      : meta.origin === 'store'
        ? 'this device&rsquo;s own cached copy'
        : 'the live feed';

  return `
    <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How this reached you</h3>
    <p class="mt-1 text-xs leading-relaxed text-slate-500">
      Painted from <strong>${where}</strong>${meta.persisted === false ? ' <span class="text-slate-400">(storage unavailable in this browser, so it lasts for this session only)</span>' : ''}.
      ${read ? `Upstream was read <strong>${escapeHtml(read)}</strong>` : 'The upstream read time is unknown'}${
        checked ? `, and last confirmed still current <strong>${escapeHtml(checked)}</strong>.` : '.'
      }
      ${stale ? '<span class="text-amber-700">The feed could not be reached this visit, so this copy has not been confirmed.</span>' : ''}
    </p>
    <p class="mt-1 text-xs leading-relaxed text-slate-500">
      ${poll ? `Polled every ${poll} seconds. ` : ''}Each poll sends the fingerprint of the copy already held, so an unchanged
      feed answers with <strong>no data at all</strong> rather than resending itself. The full payload crosses the wire only
      when something in it actually changed.
    </p>`;
}

/**
 * Built fresh on every open, so every figure in it is the one the tabs are showing right now.
 * Call it — do not hoist the result into a module-level const, which is how the numbers went
 * stale in the first place.
 */
export function sourceGroups() {
  const uni = num(() => technicals.all().length);
  const reported = num(() => earningsLive.all().length);
  const calls = num(() => concalls.all().length);
  const book = coverage.isLoaded?.() ? coverage.meta() : null;
  // Read from the module the view reads, like every other figure here — never typed.
  const si = { count: num(() => superInvestors.meta().loadedBooks) };
  const chat = num(() => chatter.all().length);
  const chatResolved = num(() => chatter.companies().length);
  const funds = (() => {
    try {
      return institutions.isLoaded() ? institutions.all() : [];
    } catch {
      return [  ];
      }
    })();
    const fundBlurb = (disclosure, noun) =>
      funds
        .filter((f) => f.disclosure === disclosure)
        .map((f) => `<strong>${escapeHtml(f.name)}</strong> (${formatNumber(f.holdings?.length || 0)} ${noun}${
          f.portfolioValueCr ? `, ${cr(f.portfolioValueCr)}` : ''
        }${f.periodLabels?.length ? `, ${formatNumber(f.periodLabels.length)} ${f.periodNoun || 'period'}s to ${escapeHtml(f.periodLabels[0])}` : ''})`)
        .join(' and ');

    return [
    {
      // THE ALERT PAIR COMES FIRST because this is the only group whose whole point is that it
      // introduces NOTHING. A reader is owed "no new feed" before looking for a source that does
      // not exist.
      title: 'AI & General Alerts',
      icon: '🔔',
      tabs: 'AI Alerts · General Alerts',
      items: [
        {
          name: 'No source of its own — two views over the research feeds below',
          feeds:
            '<strong>General Alerts</strong> consolidates Earnings, Con-calls, Public Chatter, Breakouts / Technical, Super Investors, News, Corp Announcements and Insider Trades, ordered newest-first by Indian date and available time. Its date filter narrows the already-loaded timeline without issuing another request. ' +
            '<strong>Positive / Negative / Neutral</strong> direction and <strong>High / Low</strong> importance are separate, and every row prints both reasons. Source sentiment is reproduced where it exists; insider and investor transactions use their own direction; announcements use the narrow rules documented here; news remains neutral. ' +
            `High thresholds include ±${dailyAlerts.MOVE_PCT}% price moves, ${dailyAlerts.INSIDER_HIGH_PCT}% or ₹${dailyAlerts.INSIDER_HIGH_VALUE / 10_000_000} crore insider activity, ${dailyAlerts.INVESTOR_HIGH_PP}pp investor changes, and ${dailyAlerts.CHATTER_HIGH_MENTIONS} mentions or ${dailyAlerts.CHATTER_HIGH_CHANGE_PCT}% mention change. ` +
            `Its panel keeps retained rows separate from whether each feed has looked today. <strong>AI Alerts</strong> groups the same company-specific events over ${aiAlerts.WINDOW_DAYS} days and applies an explainable ${aiAlerts.MIN_SCORE}-point priority threshold. It scores materiality, recency, direction, real Portfolio membership, independent-feed corroboration, conflicts and portfolio-sector clusters; stale feeds are penalised. Tickerless market news and lower-scoring names stay in General Alerts. Portfolio Analytics weights and conviction are not used because that ledger is illustrative.`,
          cadence: 'Rebuilt on every visit and on Refresh from each owning feed; nothing on it walks per company',
          status: 'live',
          file: 'js/data/ai-alerts.js · js/tabs/ai-alerts.js · js/data/daily-alerts.js · js/tabs/daily-alerts.js',
        },
      ],
    },
    {
      title: 'Market data',
      icon: '💹',
      tabs: 'Breakouts / Technical · Portfolio Analytics',
      items: [
        {
          name: 'Yahoo Finance — EOD OHLCV',
          url: 'https://finance.yahoo.com',
          feeds:
            'Daily close and volume for the NSE 500, every listed company in the book, and the Nifty 500 index (^CRSLDX). ' +
            'Every technical indicator on the Breakouts tab — EMA/SMA, RSI, MACD, ADX, ATR, beta, relative strength, breakout ' +
            'and base patterns — is computed from this. The holdings that are not index constituents are scraped because they ' +
            'are held; having no screener row behind them they carry no market cap and no FII/DII change, and the institutional ' +
            'rule scores those N/A rather than zero.',
          cadence: 'Weekdays 07:00 IST · GitHub Actions',
          status: 'live',
          file: 'public/data/technicals.json',
        },
        {
          name: 'NSE bhavcopy — delivery %',
          url: 'https://www.nseindia.com/all-reports',
          feeds: 'Daily DELIV_PER from sec_bhavdata_full over the last ~30 trading days, folded into the Delivery Percentage rule as a recent-half vs older-half trend.',
          cadence: 'Weekdays 07:00 IST, alongside the technicals scrape',
          status: 'live',
          file: 'public/data/technicals.json',
        },
        {
          name: 'ATR trend accumulator',
          url: null,
          feeds: 'A rolling 30-day history of each ticker\'s ATR%, appended one snapshot per scrape. The ATR Stability rule needs ≥10 days before it can call the trend declining, stable or rising.',
          cadence: 'One snapshot per technicals run',
          status: 'live',
          file: 'public/data/atr-history.json',
        },
        {
          name: 'Munshot quote API — live prices',
          url: 'https://muns.io',
          feeds: 'On-demand intraday quotes behind the Breakouts tab\'s "Refresh prices" button, proxied server-side by the Worker so no token reaches the browser. Session-only; nothing is written to the repo. It moves the CMP column ONLY — the 16-rule technicals score stays as computed from the EOD series, and a live cell is marked with an indigo dot saying so. The upstream is cache-backed, so a cold name can overrun the request budget: the response names what did not land and whether another click would fetch it.',
          cadence: 'On demand · quotes held 45s at the edge · needs the Cloudflare Worker',
          status: 'live',
          file: 'worker/index.js · POST /api/live-prices',
        },
        {
          name: 'NSE 500 constituent list (Screener export)',
          url: 'https://www.screener.in/',
          // The count rides at the END of a complete sentence, deliberately. The Sources modal opens
          // from every screen and the technicals feed loads only when Breakouts mounts, so this
          // figure is genuinely unknown about half the time — and a sentence built around a number
          // that may not arrive reads as broken prose when it does not.
          feeds: `The coverage universe: every NSE 500 constituent, with name, Screener URL, market cap, sector/industry and the FII/DII holding changes the Institutional Activity rule scores.${clause(uni, ' <n> companies in the current file.')}`,
          cadence: 'Manual re-export; constituents change quarterly',
          status: 'static',
          file: 'public/data/universe.json',
        },
        {
          name: 'TradingView — indicator overlay',
          url: 'https://in.tradingview.com/',
          feeds: 'Optional. When a scrape is wired up it overwrites RSI, ADX, EMA-50, SMA-50 and SMA-200 with the values an analyst sees on TradingView, and the drill panel re-points those rules\' Source chip accordingly. The file ships empty today.',
          cadence: 'Not yet scheduled',
          status: 'pending',
          file: 'public/data/technicals-source.json',
        },
      ],
    },
    {
      title: 'Earnings & filings',
      icon: '📊',
      tabs: 'Earnings Hub · Breakouts → Earnings Surprise',
      items: [
        {
          name: 'Live published-results feed',
          url: 'https://www.moneycontrol.com/markets/earnings/latest-results/',
          feeds:
            `The Earnings Hub, live. Revenue, gross profit and net profit for every listed company that has reported this quarter, with the prior-year comparison${clause(reported, ' — <n> in the current pull')}. Proxied through <code class="rounded bg-slate-100 px-1">/api/earnings</code> behind a 30-second edge cache and polled by the browser, so a company that files appears within about a minute without a rebuild or a page reload.`,
          cadence: 'Live — 30s edge cache, 30s client poll. A daily snapshot is committed as the first paint and the offline fallback.',
          status: 'live',
          file: 'worker/index.js → /api/earnings · public/data/earnings-live.json · scripts/scrape-earnings.mjs',
        },
        {
          name: 'Market identity and share-count feed',
          url: 'https://www.moneycontrol.com/',
          feeds:
            'Resolves the publisher\'s internal company code to an NSE ticker, and carries the industry and shares outstanding. This is the join that makes the results feed usable: upstream names are truncated to 15 characters, so the code is the only safe key. The share count is what lets market cap be computed live (shares × current price) rather than going stale between refreshes.',
          cadence: 'Incremental — only companies never seen before are resolved; refreshed in full weekly',
          status: 'live',
          file: 'public/data/mc-ticker-map.json · scripts/scrape-earnings.mjs',
        },
        {
          name: 'Yahoo Finance — result-day closes',
          url: 'https://finance.yahoo.com/',
          feeds:
            'The base price for the <strong>Return since result</strong> column: the close on the date each company reported. A past close never changes, so each is fetched once and cached forever; the current price arrives live with every poll, which is what makes the column move without refetching any history.',
          cadence: 'Incremental — one call per newly-reported company, on the daily refresh',
          status: 'live',
          file: 'public/data/result-returns.json · scripts/scrape-result-returns.mjs',
        },
        {
          name: 'BSE / NSE corporate filings',
          url: 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results',
          feeds:
            'Eight quarters of revenue, operating profit, PAT, EPS, other income, exceptional items and tax — the actuals behind the 15-rule quality score used by <strong>Breakouts → Earnings Surprise</strong>. <strong class="text-amber-700">Synthetic today:</strong> generated by <code class="rounded bg-amber-100 px-1">scripts/gen-mock-earnings.mjs</code> (seed 20260810), with real names, tickers, sectors and market caps. The Earnings Hub no longer uses this — it uses the live published-results feed above.',
          cadence: 'Event-driven during results season — not yet connected',
          status: 'mock',
          file: 'public/data/mock/earnings.json · scripts/gen-mock-earnings.mjs',
        },
        {
          name: 'Screener.in / Trendlyne — consensus',
          url: 'https://www.screener.in/',
          feeds:
            'Street EPS and revenue estimates behind the two Surprise rules and the beat/miss tag in Breakouts. <strong class="text-amber-700">Synthetic today:</strong> generated alongside the actuals, so a beat is an artefact of the generator, not of the street.',
          cadence: 'Refreshed alongside each result — not yet connected',
          status: 'mock',
          file: 'public/data/mock/earnings.json · scripts/gen-mock-earnings.mjs',
        },
        {
          name: 'Published results calendar — counts',
          url: 'https://www.moneycontrol.com/markets/earnings/results-calendar/',
          feeds:
            'The Earnings Hub\'s <strong>Earnings Calendar</strong> view: how many companies are scheduled to report on each date — the number on every chip in the date strip. Complete and unpaginated for the <strong>NSE</strong>, which is the index it is asked for. The company list beside it is asked for <em>every</em> exchange, so on a quiet date the count can be smaller than the number of companies named; where that happens the pill prints no total, and says why.',
          cadence: 'Live — 5-minute edge cache. A schedule moves in hours, not ticks.',
          status: 'live',
          file: 'worker/index.js → /api/earnings-calendar · worker/mc.mjs → fetchCalendarStrip()',
        },
        {
          name: 'Published results calendar — company list',
          url: 'https://www.moneycontrol.com/markets/earnings/results-calendar/',
          feeds:
            'The named companies for a date <strong>still to come</strong>, with quarter, scheduled time, price and market cap. <strong>Publisher-limited view:</strong> the publisher lists the <strong>20 largest by market cap</strong> per date and offers no way to page past it — the JSON route its own "load more" uses is blocked to non-browser clients. So the table names 20 of however many the count says, and states that under itself. <strong>And it is read from a capture, not live, wherever the server is refused:</strong> this list exists only inside the calendar page\'s HTML, which sits behind Akamai and answers a Cloudflare Worker with a page carrying no data. The scheduled job captures it from a runner the page does answer, and the tab shows when the schedule was updated. <strong>A date that has already happened is not answered from here at all</strong> — see the row below.',
          cadence: 'Live when the page answers; otherwise the daily capture, labelled with its age',
          status: 'live',
          file: 'worker/index.js → /api/earnings-calendar · worker/mc.mjs → fetchCalendarDay() · public/data/earnings-calendar.json · scripts/scrape-calendar.mjs',
        },
        {
          name: 'Live published results — past calendar dates',
          url: 'https://www.moneycontrol.com/markets/earnings/',
          feeds:
            'A date in the Earnings Calendar that has <strong>already happened</strong> is answered by the live results feed rather than by the schedule: every company that <em>filed</em> on that date, with its reported revenue and net profit. Not a top-20 and not a claim about the future — these are published results, the same rows as the Earnings Reported table, narrowed to one date. It needs no request of its own, which is why walking back through a reporting season is instant. The schedule\'s count for the date is still shown alongside, from the separate feed above, and the two are never differenced: companies file a day either side of their announced date, so the gap between "due" and "filed" is not a list of anybody.',
          cadence: 'Live — the same 30-second feed as Earnings Reported',
          status: 'live',
          file: 'public/js/tabs/earnings-hub.js → renderCalendar() · public/js/data/earnings-live.js → reportedOn()',
        },
      ],
    },
    {
      title: 'Con-call scans',
      icon: '🎙️',
      tabs: 'Con-call',
      items: [
        {
          // The provider is named in the code and in docs/DATA-CONTRACTS.md, and every row links
          // straight to their own page for that call — but their brand is deliberately not printed
          // on any customer-facing surface. What the reader is owed is that the analysis is NOT
          // this dashboard's, and that claim is made in full here and on every other surface.
          name: 'Con-call scans — third-party research provider',
          feeds:
            `The whole Con-call tab: every earnings call held this quarter${clause(calls, ' (<n> in the current pull)')} with the provider's own <strong>result score</strong> (0–100), <strong>management sentiment tier</strong> (Bullish → Bearish) and three highlight bullets per call, plus the schedule of calls not yet held, behind the <strong>Upcoming Concalls</strong> button. <strong>These are their numbers, not ours</strong> — reproduced unchanged, with their published tier bands, and this dashboard adds no scoring of its own on top. Full summaries and transcripts stay with them; every row links to theirs.`,
          cadence: 'Live — 30s edge cache on the newest page, 30s client poll. A call analysed at 14:32 is on screen by ~14:33.',
          status: 'live',
          file: 'worker/index.js → /api/concalls · public/data/concall-scans.json',
        },
        {
          name: 'Concall Deep Dive — per-company report',
          url: 'https://concall-sattva.tech-441.workers.dev',
          feeds:
            'The <strong>Deep Dive</strong> button on every scan row. A separate dashboard runs its own LLM pipeline over that company\'s call and returns a report — provenance, guidance, themes, the analyst Q&amp;A with transcript quotes, thesis and anti-thesis, financials, valuation. <strong>The whole report is theirs</strong>; this page lays it out, computes nothing on top, and links back to their own rendering. Their index of finished reports is read once per visit, which is free, and the rows it names get a filled <strong>Deep Dive ✓</strong> button that opens the report without starting anything. Every other row <strong>starts a real run that costs real compute</strong>, so it confirms first and nothing ever dispatches on its own. <strong>A report you have seen is kept on this device</strong>, so reopening it needs no run and no request at all — including after their own store drops it, which it does after about a fortnight.',
          cadence: 'On demand — a report already on this device opens with no network; one they hold opens with one request; a new run is polled every 4s and takes minutes. A report under a fortnight old is reused from their cache.',
          status: 'ondemand',
          file: 'public/js/data/deep-dive.js · public/js/concall/deep-dive.js · public/js/core/store.js',
        },
      ],
    },
    {
      title: 'Public chatter',
      icon: '💬',
      tabs: 'Public Chatter',
      items: [
        {
          name: 'SentimentDash — mention counts and sentiment',
          url: 'https://sentimentdash-api.tech-441.workers.dev/v1',
          feeds:
            'Mentions of companies and topics across <strong>ValuePickr</strong>, <strong>TradingQnA</strong> and <strong>Google News</strong> over a rolling 30 days, with a keyword-scored sentiment split per entry. ' +
            'The counts and the sentiment are <strong>theirs</strong> and are reproduced unchanged, never re-banded. Called <strong>directly from your browser</strong>, not through this site\'s Worker &mdash; Cloudflare refuses a Worker-to-Worker request inside one account, so a proxy here returned 404 while the API was healthy. Their ETag and a 304 keep it cheap. ' +
            '<strong>"Mentions Δ" is a change in mention volume, not a price move</strong> — there is no price anywhere in this feed.',
          cadence: 'Re-scraped twice daily, 01:30 and 13:30 UTC · this page polls hourly',
          status: 'live',
          file: 'public/js/data/chatter-live.js · window.SATTVA_CHATTER_URL in index.html',
        },
        {
          name: 'Slug → NSE symbol (computed)',
          url: null,
          feeds:
            '<strong>Not a feed — derived here.</strong> The chatter API has no exchange symbol: its key is a forum-topic slug like <code class="rounded bg-slate-100 px-1">tata-motors</code>, and entries are discovered bottom-up so the list also carries brokers, themes and bare words. ' +
            `Each slug is matched, exactly and never by prefix, against universe.json, the book and the market ticker map.${
            chat != null && chatResolved != null ? ` On the current pull, ${formatNumber(chatResolved)} of ${formatNumber(chat)} resolved.` : ''
          } ` +
            'The rest are shown in their own section with the reason rather than dropped — a mis-resolved slug would file someone else\'s forum posts under a company you hold.',
          cadence: 'Recomputed on every load',
          status: 'static',
          file: 'public/js/data/sentiment-shared.js',
        },
      ],
    },
    {
      title: 'Shareholding & flows',
      icon: '🤝',
      tabs: 'Super Investors · Breakouts → FII Accumulation',
      items: [
        {
          name: 'Muns news API — company news',
          url: 'https://fastapi.muns.io',
          feeds:
            "<strong>Real, and not ours.</strong> Recent articles per company from <code class=\"rounded bg-slate-100 px-1\">POST /tools/news-search</code>, read through this dashboard's Worker because the API needs a bearer token the browser must never hold. Headlines, outlets and dates are the publishers', reproduced unchanged; the article stays where it is published and is never summarised into our words. <strong>No sentiment and no ranking of ours</strong> — articles keep the order the API returned them in. The company a story is filed under is our search term, not a claim by the article. <strong>The shape is unverified</strong>: no working token was available when this was wired, so the parser reads by shape and by candidate key rather than by one guessed field name.",
          cadence: 'Rolling 30 days · captured weekdays at 07:00 and 09:00 IST; the live routes answer the Refresh button, never a page load',
          status: 'live',
          file: 'worker/index.js → /api/news · worker/muns.mjs · public/js/data/filings-shared.js · scripts/scrape-filings.mjs',
        },
        {
          name: 'Market-wide stocks news feed',
          url: 'https://www.moneycontrol.com/news/business/stocks/',
          feeds:
            "<strong>Real reporting, and not ours.</strong> Every story in the market-wide publisher feed — the Universe half of the News tab. Headlines, standfirsts and section names are theirs, reproduced unchanged; the article stays on their site and every row links to it. Nothing is summarised, scored, ranked or flagged as important, and <strong>the order is the publisher's own</strong>, by their article id. <strong>It is a capture, not a live read, and that is not a choice:</strong> their site refuses automated readers by TLS fingerprint — curl with a browser user-agent gets 200 and 598 KB, node's <code class=\"rounded bg-slate-100 px-1\">fetch</code> gets 403 on every header set tried, and a Cloudflare Worker gets 403 too — so a scheduled Action reads the page and the browser reads what it committed. Their listing page carries <strong>no date at all</strong>, so a story's time comes from its own page, costs one request each and is budgeted; the rest read <em>time not published</em> and are <strong>never</strong> stamped with the moment this dashboard saw them. <strong>The stories are rendered as the publisher's own cards</strong> — their thumbnail, headline and standfirst — and the whole card links to their page.",
          cadence:
            `Captured on a schedule through the day.${clause(num(() => marketNews.meta().count), ' <n> stories in the current file.')}${clause(num(() => marketNews.meta().withPublishedAt), " <n> carry the publisher's own time.")}`,
          status: 'live',
          file: 'worker/mc-news.mjs · scripts/scrape-mc-news.mjs · .github/workflows/market-news-refresh.yml',
        },
        {
          name: 'BSE — corporate announcements, indexed by date',
          url: 'https://www.bseindia.com/corporates/ann.html',
          feeds:
            "<strong>Real filings, for the whole exchange.</strong> Read from BSE's own date index (<code class=\"rounded bg-slate-100 px-1\">AnnSubCategoryGetData</code>), which answers <em>what was filed on these dates</em> rather than <em>what did this company file</em>. That difference is why coverage went from 118 companies to every listing: the per-company route costs one request each against a ~60/minute cap, so the universe was ten minutes of somebody else's service and a run cut short by the limit reached whatever it reached. This costs about twenty requests and needs no credential. <strong>So a company with no rows filed nothing in the window</strong> — it was not skipped for want of budget. Headlines, categories and sub-categories are BSE's own strings; the filing PDF stays on their server and every row links to it. Nothing here judges an announcement material or routine — BSE's own critical flag is reproduced where they set it.",
          // Two counts, each dropping its own clause when unknown — the modal opens from every
          // screen and this feed only loads when its tab mounts. A sentence built AROUND a number
          // reads as broken prose the moment it does not arrive.
          cadence:
            `Refreshed weekdays at 20:00 IST, after filing stops for the day.${clause(num(() => annFeed.meta().windowDays), ' Rolling <n>-day window.')}${clause(num(() => annFeed.meta().rowCount), ' <n> filings in the current file.')}${clause(num(() => annFeed.meta().covered), ' <n> companies filed something.')}`,
          status: 'live',
          file: 'worker/bse-ann.mjs · scripts/scrape-bse-announcements.mjs · .github/workflows/announcements-refresh.yml',
        },
        {
          name: 'Muns filings API — insider trades',
          url: 'https://devde.muns.io',
          feeds:
            "<strong>Real disclosures.</strong> Promoter, director and designated-person dealing from <code class=\"rounded bg-slate-100 px-1\">POST /filings/data/insider_trades</code> with <code class=\"rounded bg-slate-100 px-1\">country: india</code>, routing to NSE, BSE and Trendlyne. <strong>This endpoint answers with a markdown table, not JSON</strong> — the only upstream here that does — so the columns on screen are whatever their table declared, in their order, under their headings. Nothing is renamed and <strong>nothing is summed</strong>: a quantity written \"1,20,000 (pledged)\" is not a number.",
          cadence: 'Rolling 365 days · captured weekdays at 07:00 and 09:00 IST; the live routes answer the Refresh button, never a page load',
          status: 'live',
          file: 'worker/index.js → /api/insider-trades/{ticker} · worker/muns.mjs · public/js/data/filings-shared.js',
        },
        {
          name: 'Ticker Finology — superstar investors',
          url: 'https://ticker.finology.in/superstar-portfolios',
          feeds:
            '<strong>Real filings.</strong> The whole Superstar Investors view: every tracked investor Finology carry, and for each one the full book they publish — company by company, one column per quarter of disclosed holding percentage, with their net worth, active and total stock counts and any biography. <strong>Percentages are what the company filed with the exchanges; the ₹ value beside each holding is Finology\'s own derivation</strong> from that percentage and a market cap, reproduced unchanged rather than recomputed. A blank quarter means <strong>not disclosed</strong> — below the threshold a real holding is invisible — so it renders as a dash and is excluded from totals, never counted as zero. The one figure this dashboard computes is the quarter-over-quarter change, headed <em>Change (derived)</em>.',
          cadence: 'Quarterly, as filings arrive · a committed snapshot covers the grid, live for what it misses',
          status: 'live',
          file: 'worker/index.js → /api/super-investors · worker/finology.mjs · public/js/data/finology-shared.js',
        },
        {
          name: 'Superstar investors — the committed snapshot',
          url: null,
          feeds: clause(
            si.count,
            '<strong>Every book in one file.</strong> <code class="rounded bg-slate-100 px-1">public/data/super-investors.json</code>, written by <code class="rounded bg-slate-100 px-1">scripts/scrape-super-investors.mjs</code> reading this dashboard\'s own Worker, carries <n> investors\' books as the Worker itself served them.'
          ) +
            ' It exists because that view is <strong>one request per investor</strong> — each book is a separate scrape upstream — so a first visit meant ninety-one round trips and most of a minute of the grid filling in. One conditional GET replaces them. <strong>A book the capture could not read is absent, never empty</strong>, and is fetched live instead; a book already on this device wins over the file, because those bytes were confirmed later. The pill says <em>Captured</em> rather than <em>Live</em> for anything nobody has confirmed in this session.',
          cadence: 'Refreshed on a schedule · re-read on demand from the Live pill',
          status: 'live',
          file: 'scripts/scrape-super-investors.mjs · public/data/super-investors.json · public/js/data/super-investors.js',
        },
        {
          name: 'Ticker Finology — the credential',
          url: null,
          feeds:
            'That API requires <code class="rounded bg-slate-100 px-1">Authorization: Bearer …</code>, so unlike every other upstream here the browser cannot call it. The Worker holds the token in <code class="rounded bg-slate-100 px-1">env.MUNS_TOKEN</code> and adds the header server-side; <strong>nothing in <code class="rounded bg-slate-100 px-1">public/</code> has ever seen it</strong>, the same arrangement as the Munshot quote route. Set or renew it with <code class="rounded bg-slate-100 px-1">npx wrangler secret put MUNS_TOKEN</code>. With no token the view says so by name instead of showing an empty grid.',
          cadence: 'Set once per deployment · renewed if the token expires',
          status: 'ondemand',
          file: 'worker/index.js · .dev.vars for local development',
        },
        {
          name: 'Bandhan Mutual Fund — monthly portfolio disclosures',
          url: 'https://bandhanmutual.com/',
          feeds:
            `<strong>Real disclosures.</strong> Indian AMCs publish the full portfolio of every scheme each month, naming each instrument with its weight and its market value.${
              fundBlurb('portfolio', 'holdings') ? ` Wired for ${fundBlurb('portfolio', 'holdings')}.` : ''
            } <strong>The percentage is % to NAV — how much of the FUND is in each company</strong>, which is the opposite measurement from the shareholding filings below and is never summed with them. Weights and values are the AMC's own published figures; the only figure computed here is the month-on-month change. The NSE symbol is ours, resolved from the dashboard's other feeds, and a line that could not be matched says so rather than guessing.`,
          cadence: 'Monthly · drop the new workbook in scripts/fixtures/ and re-run the importer',
          status: 'live',
          file: 'public/data/institution-holdings.json · scripts/import-amc-portfolio.mjs · scripts/lib/xlsx-read.mjs · scripts/lib/company-index.mjs',
        },
        {
          name: 'Trendlyne — superstar shareholdings (filed)',
          url: 'https://trendlyne.com/portfolio/superstar-shareholders/54015/latest/smallcap-world-fund-inc/',
          feeds:
            `<strong>Real filings.</strong> Indian companies file their shareholding pattern with the exchanges every quarter, naming each holder above 1% with a share count and a percentage of the company; Trendlyne aggregate those filings by holder.${
              fundBlurb('shareholding', 'Indian holdings') ? ` Wired for ${fundBlurb('shareholding', 'Indian holdings')}.` : ''
            } <strong>Share counts and percentages are the filings; the ₹ value is Trendlyne's own derivation</strong> (holding % × market cap), reproduced unchanged and attributed rather than recomputed. A blank percentage means the company has not filed yet, not that the position was sold.`,
          cadence: 'Quarterly, as filings arrive over the weeks after a quarter closes · re-run the scraper',
          status: 'live',
          file: 'public/data/institution-holdings.json · scripts/scrape-institution-holdings.mjs · scripts/lib/trendlyne.mjs',
        },
      ],
    },
    {
      title: 'Portfolio',
      icon: '💼',
      tabs: 'Portfolio Analytics',
      items: [
        {
          name: 'Direct-equity statement — the book',
          url: null,
          feeds:
            `What the Portfolio toggle means on every research tab.${clause(book?.count, ' <n> companies')} from the family office statement, ` +
            `resolved to NSE symbols by scripts/resolve-portfolio-companies.mjs. Names and sectors only — no quantity, ` +
            `no cost, no value.${clause(book?.uncovered, ' <n> lines carry no NSE symbol')} (unlisted, warrants, the Vedanta demerger entities, ` +
            `BSE-only, or unresolved); they are kept with the reason and shown as held-but-not-covered rather than dropped.`,
          cadence: 'When the statement changes · re-run the resolver and commit the diff',
          status: 'static',
          file: 'public/data/portfolio-companies.json',
        },
        {
          name: 'Holdings (user-maintained)',
          url: null,
          feeds:
            'The holdings list — tickers, names, sectors, conviction tiers. Quantity and average cost are NOT edited here: ' +
            'they are derived from a FIFO replay of the ledger below, so the position table and the ledger cannot disagree.',
          cadence: 'User-edited; qty/avgPrice regenerated with the ledger',
          status: 'mock',
          file: 'public/data/portfolio.json',
        },
        {
          name: 'Broker contract notes',
          url: null,
          feeds:
            'The buy/sell/dividend/corporate-action ledger behind the book. Which trades were made and when is synthetic; ' +
            'every execution price in it is a real Yahoo close on a real trading day. CSV import parses in-browser and lasts until reload.',
          cadence: 'Event-driven, per trade · regenerate with scripts/gen-mock-transactions.mjs',
          status: 'mock',
          file: 'public/data/mock/transactions.json',
        },
        {
          name: 'Yahoo Finance — daily closes, 3 years',
          url: 'https://query1.finance.yahoo.com/v8/finance/chart/',
          feeds:
            'The equity curve and every drawdown figure. Daily closes for each ticker the ledger touches plus the Nifty 500 ' +
            '(^CRSLDX) benchmark. Tickers Yahoo will not serve are recorded in failures[] and named in the UI, never dropped.',
          cadence: 'Weekdays 07:00 IST via GitHub Actions, alongside the technicals refresh',
          status: 'live',
          file: 'public/data/portfolio-history.json',
        },
      ],
    },
  ];
}

const STATUS_CHIP = {
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  static: 'bg-blue-50 text-blue-700 ring-blue-200',
  mock: 'bg-amber-50 text-amber-700 ring-amber-200',
  // Indigo is the brand/action colour and this status IS an action — a source that produces
  // nothing until the reader asks it to. It is deliberately not emerald: counting it among the
  // live feeds would claim data is flowing when none is until someone clicks.
  ondemand: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  pending: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const STATUS_LABEL = { live: 'Live', static: 'Real · manual', mock: 'Mock data', ondemand: 'On demand', pending: 'Not yet built' };

// Renders the Sources modal body. Kept here (beside the data) so the two never drift.
export function sourcesModalHtml() {
  const groups = sourceGroups();
  const items = groups.flatMap((g) => g.items);
  const total = items.length;
  const live = items.filter((i) => i.status === 'live').length;
  const realStatic = items.filter((i) => i.status === 'static').length;
  const onDemand = items.filter((i) => i.status === 'ondemand').length;

  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">All Data Sources</h2>
          <p class="mt-1 text-sm text-slate-500">
            Every source that feeds this dashboard, grouped by the tabs it serves.
            <span class="font-semibold text-slate-700">${live} of ${total}</span> are wired to a live feed today,
            ${realStatic} more carry real data refreshed by hand${onDemand ? `, and ${onDemand} runs only when you ask it to` : ''} —
            the rest ship with mock data and are labelled as such.
          </p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      </div>

      <div class="space-y-5">
        ${groups.map(
          (g) => `
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <span class="text-base">${g.icon}</span>
              <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-700">${g.title}</h3>
              <span class="text-[11px] text-slate-400">${g.tabs}</span>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              ${g.items
                .map((it) => {
                  const inner = `
                    <div class="mb-1 flex items-start justify-between gap-2">
                      <span class="text-sm font-semibold text-slate-900 ${it.url ? 'group-hover:text-indigo-700' : ''}">${it.name}</span>
                      <span class="inline-flex flex-shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[it.status]}">${STATUS_LABEL[it.status]}</span>
                    </div>
                    <div class="text-[11px] leading-snug text-slate-500">${it.feeds}</div>
                    <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400">
                      <span class="font-medium text-slate-500">${it.cadence}</span>
                      <span>·</span>
                      <code class="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">${it.file}</code>
                    </div>`;
                  return it.url
                    ? `<a href="${it.url}" target="_blank" rel="noopener"
                         class="group block rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70 transition hover:bg-indigo-50/60 hover:ring-indigo-200">${inner}</a>`
                    : `<div class="block rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">${inner}</div>`;
                })
                .join('')}
            </div>
          </div>`
        ).join('')}
      </div>

      <div class="mt-6 border-t border-slate-100 pt-4 text-[11px] leading-relaxed text-slate-400">
        <p><strong class="text-slate-500">Kept on this device.</strong> The results feed and the con-call scan are large and
        polled, so the copy last received is stored in this browser and reused on the next visit. Every poll sends its
        fingerprint and an unchanged feed replies with nothing at all, so what travels is only what actually changed.
        A cached paint is never presented as a live one — each of those tabs' Live pill says where the figures on screen
        came from and when the feed was last confirmed. Nothing is stored for a feed you have not opened, and clearing
        this site&rsquo;s data removes it.</p>
        <p class="mt-2">Full field-level contracts — exact JSON shapes, units and refresh cadence — live in
        <code class="rounded bg-slate-100 px-1 py-0.5">docs/DATA-CONTRACTS.md</code>.</p>
      </div>
    </div>`;
}
