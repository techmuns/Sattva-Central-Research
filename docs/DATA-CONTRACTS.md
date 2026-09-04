# Data Contracts

Every JSON file the dashboard reads, its exact shape, field types, units, refresh cadence and
the real source it will be wired to. This document is how live data gets connected — treat it as
the interface, and change the doc and the producer together.

## Conventions

- **Currency** — Indian rupees. Fields ending `Cr` are in **crore** (1 Cr = 10,000,000).
  Fields named `price`, `avgPrice`, `lastPrice`, `high52w`, `value` are absolute rupees.
- **Percentages** — stored as numbers, already in percent. `12.4` means 12.4%, not 0.124.
  Fields ending `Pct` follow this rule without exception.
- **Dates** — `YYYY-MM-DD` (ISO date, no time) for report/as-of dates.
- **Timestamps** — full ISO 8601 with the IST offset, e.g. `2026-08-10T09:12:00+05:30`.
- **Tickers** — NSE symbols, uppercase, no `.NS` suffix. The ticker is the join key across
  every file in this document.
- All files are loaded once at startup by `public/js/app.js` and exposed to tabs as
  `ctx.data.<key>`. The key for each file is listed in its section below.

### Loading map

| `ctx.data` key | File |
| --- | --- |
| `portfolioCompanies` | `public/data/portfolio-companies.json` |
| `universe` | `public/data/universe.json` |
| `earnings` | `public/data/mock/earnings.json` |
| `earningsCalendar` | `public/data/mock/earnings-calendar.json` |
| `filedHoldings` | `public/data/institution-holdings.json` |

`universe.json` is loaded twice over: the raw screener rows stay on `ctx.data.universeRaw`, and
`ctx.data.universe` carries the adapted `{ ticker, name, marketCap, sector, industry }` shape the
older tabs were built against (see `js/data/universe.js`).

`earnings.json` follows the same pattern: the full payload stays on `ctx.data.earningsRaw` and
primes `js/data/earnings.js` (so the module never refetches it), while `ctx.data.earnings` carries
the flat one-row-per-company summary that Breakouts → Earnings Surprise was written against.

**Not in that map:** several heavy feeds are fetched lazily by their own data modules the first
time their tab mounts, then cached for the life of the page — the other tabs shouldn't pay for
data they never read. All of them revalidate rather than re-download; see *Conditional delivery
and the device store*.

| File | Loaded by | Size |
| --- | --- | --- |
| `technicals.json`, `atr-history.json`, `technicals-source.json` | `js/data/technicals.js` (Breakouts, global search) | ~800KB |
| `chatter-valuepickr.json`, `chatter-telegram.json` | `js/data/chatter.js` (Public Chatter) | ~160KB |
| `earnings-live.json`, `mc-ticker-map.json`, `result-returns.json` | `js/data/earnings-live.js` (Earnings Hub) | ~1.2MB |

The three Super Investors files load at bootstrap and seed `js/data/investors.js` through
`prime()`, because the investor grid needs all three together on first paint.

> **Mock vs real.** Everything under `public/data/mock/` is placeholder data so the shell has
> something to render. Outside `mock/`: `technicals.json`, `atr-history.json`,
> `earnings-live.json`, `mc-ticker-map.json` and `result-returns.json` are **live** (scraped on a
> schedule, and the Earnings Hub is live per-request on top of that), `universe.json` is a **real**
> NSE-500 screener export refreshed by hand, and `portfolio-companies.json` is **real** — the
> family office's own book, synced from `techmuns/Sattva-Family`.
>
> **THERE IS NO LEDGER ANY MORE, AND THAT IS THE POINT.** `portfolio.json` (twelve positions with
> quantities and costs), `mock/transactions.json` (the synthetic trade ledger) and
> `portfolio-history.json` (290KB of equity-curve closes) fed a Portfolio Analytics workspace that
> mixed mock and real inside single numbers — a market value, an XIRR, a max drawdown. It carried an
> honest *Illustrative ledger · live marks* pill on every sub-view, and it is still deleted: a pill
> does not survive a screenshot, and an invented ₹30.7L market value under this dashboard's chrome
> reads as the family's money. The only portfolio data here is the book — names and sectors. See
> *Portfolio means a list of names* in `CLAUDE.md`; the files are in git history at `d3bba30`.

---

## `public/data/technicals.json` — LIVE

**The dashboard's one genuinely live feed.** Written by `scripts/scrape-technicals.mjs`, refreshed
weekdays at 07:00 IST by `.github/workflows/technicals-refresh.yml`, and consumed by
`public/js/data/technicals.js`, which scores every row through `public/js/scoring/tech-scoring.js`.

### The universe is the index PLUS the book, and that is not cosmetic

The scrape's input is the **union** of `universe.json` (the NSE-500 screener export) and every
listed line in `portfolio-companies.json`. It used to be the export alone, which quietly made this
file *the Nifty 500 and nothing else* — so a holding outside the index had no price series, no
score, no Breakouts row and nothing in the global search, and **no surface said the index was the
reason**. Only 55 of the book's 123 listed companies are constituents, so nearly half the book was
invisible in Portfolio scope on the one tab that scores technicals. A company is scraped because it
is held, whatever index it is or is not in.

A row that came from the book and not the export carries `listSource: "book"` and, having no
screener row behind it, **no market cap and no FII/DII holding change**. Those stay null: the market
cap renders as an em dash and the institutional-activity rule scores `na` with its full `max`.
Neither is a zero — `na` means "we never had the figure", and a zero would mean "no institutional
buying", which is a different and false claim.

Root is an **object** with a metadata header and a `companies` array.

```jsonc
{
  "generated_at": "2026-08-13T13:56:03.304Z",
  "source": "Yahoo Finance",
  "index_symbol": "^CRSLDX",
  "index_close": 23723.55,
  "index_6m_return": 0.0113,
  "market_breadth": { "advances": 143, "declines": 177, "unchanged": 200, "ad_ratio": 0.81, "universe": 520 },
  "company_count": 603,
  "nse500_count": 535,
  "book_count": 68,
  "partial_refresh": null,
  "failures": 17,
  "companies": [ /* … */ ]
}
```

| Header field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `generated_at` | string | ISO 8601 UTC | When the scrape finished. Drives the gradient "Last Refresh" card. **Not** the date of the closes — see `price_date`. |
| `price_date` | string \| null | YYYY-MM-DD (IST) | The session the closes belong to: the most common `bar_date` across priced rows. On the scheduled 07:00 IST run this is the previous trading day. General Alerts dates every price move by this (per row `bar_date`), never by `generated_at`. |
| `price_date_rows` | number | count | How many rows share `price_date`. A row on another date is a company whose latest Yahoo bar lags. |
| `move_verification` | object \| null | — | What `scripts/lib/muns-market-data.mjs` did, across the scrape and every follow-up pass: `{ source, threshold_pct, alert_pct, flagged, cached, checked, confirmed, corrected, unavailable, refusals, elapsed_ms, budget_exhausted, passes?, last_pass_at? }`. Null when the check was skipped (`MUNS_VERIFY=0`). |

**`price-move-checks.json`** sits beside it: every answer the Muns market-data endpoint has given,
keyed `TICKER@bar_date` → `{ pct, close, prevClose, prevDate, checkedAt }`, pruned to ten days. It
exists because the endpoint's anonymous quota is a few requests an hour and a refusal outlasts a
run: the daily scrape asks what it can and commits, and `.github/workflows/price-move-verify.yml`
runs `scripts/verify-price-moves.mjs` hourly through the Indian day to ask only about the rows still
`unavailable` — reading this file first, so no name is asked twice. A `MUNS_TOKEN` repository secret
is sent as a Bearer token by both jobs and is what lets one pass answer the whole set.
| `source` | string | — | Always `"Yahoo Finance"` today. |
| `index_symbol` | string | — | `^CRSLDX` — Nifty 500 on Yahoo. |
| `index_close` | number | index points | Latest index close. |
| `index_6m_return` | number | **fraction**, not percent | `0.0113` = +1.13% over ~126 trading days. |
| `market_breadth` | object \| null | counts | Advances / declines / unchanged, plus `ad_ratio` (advances ÷ declines, null when declines is 0). **NSE-500 rows only** — breadth is a statement about the index, so the held non-constituents are excluded rather than quietly folded into a figure still labelled "Nifty 500". |
| `company_count` | number | count | Rows in `companies`, including failures. |
| `nse500_count` | number | count | Of those, the ones from the screener export. |
| `book_count` | number | count | Of those, the held companies the index does not carry. Drives `coverage().label`, which is why the Breakouts notes read *"NSE 500 + 68 held"* rather than *"NSE 500"*. |
| `partial_refresh` | object \| null | — | Non-null only after a `TECH_FILL_GAPS=1` run — see below. Its presence means `generated_at` describes when the file was written, **not** when most of its rows were priced. |
| `failures` | number | count | Rows carrying an `error` instead of indicators. |

### `TECH_FILL_GAPS=1` — scraping only what is missing

`TECH_FILL_GAPS=1 node scripts/scrape-technicals.mjs` fetches only the companies the committed file
does not already carry successfully, and merges them in. Adding names to the book should not cost a
600-company re-fetch of tickers priced hours ago, and the re-fetch is not free for Yahoo either.

Two rules make the merge honest:

- **A row carrying an `error` counts as a gap and is retried**, and the row being retried is dropped
  from the carry-over set — otherwise a successful retry would land beside the stale failure it
  replaces and the file would hold that ticker twice.
- **Everything else is carried byte-for-byte, including the NSE delivery %.** A gap-fill has no way
  to re-collect delivery figures for rows it did not fetch, and blanking them would turn a real
  measurement into an `na`. `partial_refresh` records `added`, `carried_over` and the timestamp, so
  one `generated_at` never silently stands for two runs.

### SME symbols: NSE says `-SM`, Yahoo does not

NSE suffixes SME-platform symbols (`ALPEXSOLAR-SM`, `SAHANA-SM`); Yahoo carries them under the bare
symbol. Left alone, `ALPEXSOLAR-SM.NS` returns a **one-bar stub** — which reads exactly like a
delisting, because the ticker is right, the exchange is right, and the company simply appears to
have no history. The scrape now strips the suffix as a fallback before trying `.BO`; both of those
have 270 bars under the bare symbol.

### `companies[]` — a company that scraped successfully

Every numeric field is `null` when it could not be computed (usually too little history). The
scoring model treats `null` as **N/A**, which scores 0 out of that rule's max — it never
substitutes a guess.

**Identity and pass-through (from `universe.json`, or from the book — see `listSource`)**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `ticker` | string | — | NSE symbol, uppercase. Join key everywhere. |
| `name` | string | — | Company name. |
| `listSource` | `"nse500"` \| `"book"` | — | Which list put this company in the scrape. **`"book"` means the four fields below are null and cannot be filled** — there is no screener row behind it. |
| `screenerUrl` | string | — | Screener.in company page; the drill panel's "View on Screener.in" link. |
| `marketCap` | string \| null | display text | Verbatim from the screener export, e.g. `"27,582 Cr."`. Null on a `book` row. |
| `sector`, `broadSector`, `industry` | string \| null | — | Classification. A `book` row carries the statement's sector and no industry. |
| `chg_fii_hold` | number \| null | **percentage points** | Change in FII holding, latest period. Scored by Institutional Activity. Null on a `book` row, where the rule scores `na` — never a zero, which would read as "no institutional buying". |
| `chg_dii_hold` | number \| null | **percentage points** | Change in DII holding. Same. |

**Delivery % (NSE bhavcopy)**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `delivery_avg_recent` | number \| null | percent | Mean DELIV_PER over the recent half of the ~30-day window. |
| `delivery_avg_older` | number \| null | percent | Mean over the older half. |
| `delivery_trend_diff` | number \| null | **percentage points** | `recent − older`. > 1 pp passes the Delivery Percentage rule. |
| `delivery_days_count` | number | count | Trading days matched for this ticker. Fewer than 6 → the rule reports N/A. |

**Liquidity**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `adtv_20d_cr` | number \| null | ₹ crore | 20-day average daily traded value. |
| `fno_eligible` | boolean | — | In the NSE F&O underlying list. `false` for all today — the static list is not shipped. |
| `bid_ask_spread_pct` | number \| null | percent | From Yahoo chart meta. Null in practice — Yahoo carries no NSE Level-1. |
| `bid_ask_spread_pct_est` | number \| null | percent | Abdi–Ranaldo estimate from 30 days of OHLC. |
| `impact_cost_pct_est_5cr` | number \| null | percent | Expected price move on a ₹5 crore order, from the Amihud illiquidity ratio over 30 days. |
| `liquidity_tier` | string \| null | — | Band derived from `adtv_20d_cr`. |

> These four are computed by the ported pipeline but **not scored by the technicals model** —
> they belong to a Sentiment & Liquidity pillar that this dashboard has not built. They are kept
> so the feed stays a faithful port and a later prompt can use them without a re-scrape.

**Price and trend**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `cmp` | number | ₹ | The last **completed** close. A session still in progress is dropped by `scripts/lib/yahoo.mjs` (`completedBars`, cut at 16:00 IST), so a scrape that runs mid-session — as GitHub's late scheduler made it — carries yesterday's close, not a mid-morning print. |
| `bar_date` | string \| null | YYYY-MM-DD | The session `cmp` closed on. |
| `prev_bar_date` | string \| null | YYYY-MM-DD | The session `pct_change_today` is measured against. |
| `bar_gap_days` | number \| null | days | Calendar distance between the two. A weekend is 3, a holiday weekend 4. |
| `pct_change_today` | number \| null | percent | `cmp` vs the close on `prev_bar_date`. **Null when the gap exceeds 4 days** — Yahoo skipped a session, and the figure would be a multi-day move under a one-day label. Feeds `market_breadth` and the ±5% price alert. |
| `move_source` | string | — | Present when the move was re-derived from the Muns market-data endpoint (`fastapi.muns.io/market_data`); absent when it is Yahoo's. |
| `move_check` | string | `confirmed` \| `corrected` \| `unavailable` | Only on rows whose move reached the check threshold (4%). `unavailable` keeps Yahoo's figure and `move_check_reason` says why: `rate-limited`, `no close for <date>` (the endpoint has not published that session yet — it lags the close by hours), `<date> not published by the endpoint yet` (the pass stopped early once three answers in a row lacked it), `verification budget exhausted`. |
| `move_prev_date`, `move_close`, `move_prev_close` | — | — | The endpoint's two closes and the prior date, when it answered. |
| `ema50` | number | ₹ | 50-day exponential moving average. |
| `sma50` | number | ₹ | 50-day simple moving average. |
| `sma200` | number \| null | ₹ | 200-day SMA. Null below 200 bars of history. |
| `above_50ema` | boolean | — | `cmp > ema50`. |
| `above_200dma` | boolean \| null | — | `cmp > sma200`. **`false` is the model's only hard fail.** |
| `golden_cross` | boolean \| null | — | `sma50 > sma200`. |
| `death_cross` | boolean \| null | — | `sma50 < sma200`. |
| `bars_count` | number | count | Trading bars fetched. Under 60 the company is recorded as an error instead. |

**Momentum**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `rsi14` | number \| null | 0–100 | Wilder RSI over 14 closes. |
| `macd` | object \| null | — | `{ line, signal, above_zero, positive_crossover }`. `line` = EMA(12) − EMA(26); `signal` = EMA(9) of the line; `positive_crossover` is true only on the day the line crossed above. |
| `adx14` | number \| null | 0–100 | Wilder ADX(14). |
| `return_6m` | number \| null | **fraction** | Stock return over ~126 trading days. |
| `return_6m_index` | number \| null | **fraction** | Nifty 500 over the same window. |
| `relative_strength_6m` | number \| null | **fraction** | `return_6m − return_6m_index`. Positive = outperforming. |

**Volume, range and risk**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `avg_volume_20d` | number | shares | Average of the prior 20 sessions, excluding today. |
| `volume_ratio_today` | number \| null | multiple | Today ÷ 20-day average. `1.5` = 1.5×. |
| `high_52w`, `low_52w` | number | ₹ | Extremes of the last 250 closes. |
| `high_proximity_pct` | number \| null | **ratio 0–1** | `cmp ÷ high_52w`. `0.93` means 7% below the high. Distance % = `(1 − value) × 100`. |
| `atr14_pct` | number \| null | percent of price | Wilder ATR(14) ÷ close × 100. |
| `beta_1y` | number \| null | multiple | Covariance of stock vs index daily returns ÷ index variance, over up to 252 **date-aligned** pairs. |

**Pattern detection** — each is an object or `null` when history is too short.

| Field | Shape | Meaning |
| --- | --- | --- |
| `higher_highs_lows` | `{ higher_high, higher_low, pattern_present, recent_high, recent_low, prior_high, prior_low, timeframe, window_weeks }` | Daily bars aggregated to weekly, recent 13 weeks vs prior 13. `pattern_present` requires both a higher high and a higher low. |
| `consolidation_breakout` | `{ base_range_pct, tight_base, breaks_out, volume_confirm, today_close, base_max, today_volume_ratio, quality }` | Base = prior 30 sessions excluding today. `quality` is `strong` \| `weak_base` \| `low_volume` \| `no_breakout` and drives the Strong Breakouts sub-view. |
| `base_formation` | `{ drawdown_pct, tightness_pct, healthy_base }` | Over the last 60 closes. Healthy = drawdown < 15% **and** closing-range SD < 4% of mean. |

### `companies[]` — a company that failed

```jsonc
{ "ticker": "BAGMANE", "name": "Bagmane Prime REIT", "screenerUrl": "…", "error": "ticker not found" }
```

Only those four fields. The model returns `totalPoints: 0, totalMax: 0` with `tickerError` set,
and the UI ranks the row last and labels it "no data" — it is never dropped silently or
back-filled. Common causes: a recent listing with fewer than 60 bars, or a ticker renamed or
demerged since the universe export.

**Refresh cadence** — weekdays 07:00 IST via GitHub Actions, plus manual `workflow_dispatch`.
**Real source** — Yahoo Finance Chart v8 (`TICKER.NS`, falling back to `.BO`) and the Nifty 500
index `^CRSLDX`; NSE `sec_bhavdata_full` for delivery %.
**Consumed by** — the whole Breakouts / Technical tab, and the global search drill from any tab.

---

## `public/data/atr-history.json`

The ATR Stability rule needs a *trend*, not just today's level. This accumulator grows one
snapshot per scrape. Root is an **object** keyed by ticker.

```jsonc
{ "TITAN": [ { "date": "2026-08-10", "atr_pct": 1.92 } ] }
```

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| *(key)* | string | ticker | NSE symbol. |
| `[].date` | string | `YYYY-MM-DD` | Scrape date. One entry per ticker per day — a same-day re-run replaces it. |
| `[].atr_pct` | number | percent of price | That day's `atr14_pct`. |

Trimmed to the most recent **30** entries per ticker. The rule needs **≥ 10** before it will call
the trend `declining` / `stable` / `rising`; below that it scores on the absolute level alone and
says the trend is still building. A capped `TECH_LIMIT` run deliberately skips this file so a
partial run cannot poison the accumulator.

**Refresh cadence** — one snapshot per full technicals run.
**Consumed by** — `data/technicals.js`, attached to each row as `atr_history`.

---

## `public/data/technicals-source.json` — optional overlay

Ships **empty**. If a TradingView scrape is wired up later, it writes per-ticker indicator values
here and `data/technicals.js` overwrites `rsi14`, `adx14`, `ema50`, `sma50` and `sma200` from it,
recording which fields were replaced in `row._source_tech_fields` so the drill panel's Source chip
points at TradingView instead of the Yahoo-computed path.

```jsonc
{
  "generated_at": null,
  "source": "TradingView · Technical Analysis",
  "total_companies_covered": 0,
  "companies": {
    "TITAN": { "oscillators": { "rsi_14": 75.0, "adx_14": 50.5 }, "moving_averages": { "ema_50": 4605, "sma_50": 4519, "sma_200": 4199 } }
  }
}
```

**Status** — not yet built. The file is committed empty so the loader has something valid to read
and the contract is visible; nothing on the dashboard is currently sourced from TradingView.

---

## `POST /api/live-prices` — Cloudflare Worker route

On-demand intraday quotes behind the Breakouts tab's "Refresh prices" button. Session-only:
nothing is written to the repo, and the committed EOD feed is unaffected. Implemented in
`worker/index.js`, so it exists under `npx wrangler dev` / a deployed Worker but **not** under a
plain static preview — the button says so rather than erroring.

**Request** — `{ "tickers": ["TITAN", "RELIANCE"] }`. Deduplicated, uppercased, **capped at 60**.
An empty list returns `400`.

**Response `200`**

```jsonc
{
  "generated_at": "2026-08-10T10:12:00.000Z",
  "source": "Munshot quote API (on-demand refresh)",
  "upstream": "https://fastapi.muns.io/stock-data",
  "requested": 60,          // after dedupe and the cap
  "ticker_count": 52,       // how many quotes are actually in `prices`
  "cached_count": 40,       // of those, how many came off the edge without an upstream read
  "partial": true,          // ticker_count < requested
  "elapsed_ms": 25000,
  "missing": [{ "ticker": "AAA", "reason": "timeout" }],
  "prices": {
    "TITAN": {
      "current": 5100, "open": 4980, "prevClose": 4941,
      "dayHigh": 5122, "dayLow": 4975,
      "week52High": 5180, "week52Low": 2925,
      "ma50": 4519, "ma200": 4199,
      "vol10d": 1284000, "marketCap": 452800, "yearlyChangePct": 41.2
    }
  }
}
```

Every price field is a number or `null`. A ticker whose quote failed is absent from `prices` and
present in `missing` — one bad symbol never fails the batch.

### The upstream is cache-backed, and every setting on this route follows from that

Measured against the live service, the same twenty tickers three times in a row at identical
concurrency and timeout: **8/20, then 20/20, then 20/20 in a quarter of the wall time.** A ticker
the upstream holds warm answers in about a second; a cold one takes **8–15s** and sometimes longer.

That one fact explains a failure this route produced *reliably* until August 2026 — the tab read
"Live quote refresh failed" on every click, for every reader:

| What was wrong | Why it was fatal |
| --- | --- |
| Per-request timeout of **8s** | Below the cold path. A cold read could not win. |
| **Nothing cached here** | So every refresh was a cold refresh. The slow path was the only path. |
| All 60 fired in one `Promise.all` | Each started its own `AbortSignal.timeout` while the runtime ran ~6 connections, so the queued 54 spent their whole budget waiting for a socket. Measured: 24 fired together → **0 of 24**, all aborting at exactly 8s; the same names walked a few at a time → 24 of 24. |

So the fix is not a better timeout. `QUOTE_TTL_S` / `QUOTE_TIMEOUT_MS` / `QUOTE_POOL` /
`QUOTE_BUDGET_MS` in `worker/index.js` are **one setting, not four**, and they have to stay
consistent: a batch of `MAX_TICKERS` needs `ceil(60 / POOL)` waves and a wave can cost a full
timeout, so a pool too small cannot reach the end of the batch before the budget expires however
healthy the upstream is. A first draft ran `POOL 6` against a 22s budget and returned **6 of 60,
with 48 never started** — worse than the bug it replaced. Measured on disjoint cold batches of 60
at a 25s budget: **POOL 12 → 48/60, POOL 20 → 31/60, POOL 30 → 46/60.** Higher fan-out buys no
throughput because the upstream slows under it. **Re-measure before changing any of the four.**

A timeout also ends that ticker's turn rather than retrying it: asking the same cold question
again costs another 15s of a 25s budget while a dozen names have not been started at all. The
attempt is not wasted — it leaves the ticker warming upstream, which is what makes "click again" a
real instruction. Successive clicks converge: **52/60 → 56/60 → 56/60**, the last two mostly off
the edge cache, the residual four being symbols the quote API genuinely does not carry.

### A partial is a success; only nothing at all is a failure

Some cold reads will overrun any budget — that is the upstream's shape, not something to tune
away. Failing all sixty because eight were slow discards fifty-two good quotes. So `missing[]`
names every ticker that did not land **and why**, and the UI splits those reasons into the two
kinds that must never read alike:

| Reason | Kind | What the tab says |
| --- | --- | --- |
| `timeout` `deadline` `unreachable` `http-5xx` | transient | *"N still warming upstream — click again to fill them in"* |
| `http-4xx` `shape` `unparseable` `over-cap` | permanent | *"N not carried by the quote API"* |

Telling a reader to retry something that cannot succeed is the same class of error as rendering a
missing value as a zero — one message for two different states.

**Failures are never cached.** A `200` quote is stored per ticker for `QUOTE_TTL_S`; nothing that
failed is. Same rule as the Finology route: replaying a stored failure would undo the recovery the
short TTL exists to allow.

**Errors** — `405` non-POST · `400` bad body or no tickers · **`502` only when zero quotes came
back**. A refresh that fetched nothing is a failure, not an empty "fresh" feed, so the UI keeps the
prices already on screen instead of blanking the display. The 502 body carries `upstream`,
`requested`, `elapsed_ms` and a `reasons` tally, and **the tab renders all of it** — a bare status
code is unfalsifiable, which is the lesson `/api/chatter` already charged us for once.

### What a live quote may and may not change on screen

The quote lands in `company.liveQuote` and **`company.cmp` is left alone.** All 16 technical rules
are computed from the daily OHLCV series — a 50 EMA, an RSI, a 52-week position — so overwriting
the close those rules were scored against would sit a 14:32 price underneath a score that never
read it, and the drill panel would explain a rule using a number that is not the one it used.

So a refresh moves **the CMP column and nothing else**: the cell shows the live price, an indigo
dot marks it as live, the dot's title names the EOD date the score still belongs to, and the note
under the button ends *"CMP only; the 16-rule score stays EOD."* The day change beside it is
recomputed from the quote's **own** previous close, or rendered as an em dash — carrying this
morning's EOD percentage next to an intraday price would render two measurements as one.

---

## `public/data/portfolio-companies.json` — REAL, the book the Portfolio scope means

Every listed company the family office holds directly, resolved to NSE symbols. **The book is read
from the family office's own repository** — `techmuns/Sattva-Family`, `src/data/sattvaData.ts`, the
positions file generated from the custody workbooks — by `scripts/sync-family-book.mjs`, one line
per equity ISIN, into `scripts/fixtures/family-book.json`; `scripts/resolve-portfolio-companies.mjs`
turns that into this file. It used to be a list of names typed into the resolver from a statement,
which was a second copy of a book that lives somewhere else, and a second copy can only drift.
This is what the **Portfolio / Universe toggle filters by** on every research tab: Earnings Hub,
Con-call, Breakouts, Public Chatter, Institutions and Superstar Investors all ask *"is this ticker
one of ours?"* and this file is the answer. Loaded at bootstrap onto `ctx.data.portfolioCompanies`
and primed into `js/data/coverage.js`.

**IT CARRIES NAMES AND SECTORS, AND IT MUST NEVER BE WIDENED.** The statement this file came from
was given as names only — value and weight were explicitly out of scope — so a quantity, a cost or a
valuation added here would be invented rather than supplied. There used to be a second file,
`portfolio.json`, holding twelve positions with quantities and costs for a Portfolio Analytics
workspace; both are deleted, so this is now the whole of what "portfolio" means in this dashboard.

| | `portfolio-companies.json` |
| --- | --- |
| Answers | *is this company one of ours?* |
| Lines | 142 (19 with no NSE symbol, each with a stated reason) |
| Fields | name, ticker, sector — and nothing else |
| Drives | the Portfolio scope on every research tab |

```jsonc
{
  "_provenance": "…",
  "asOf": "2026-06-30",
  "source": "techmuns/Sattva-Family · src/data/sattvaData.ts",
  "sourceCommit": { "sha": "…", "date": "2026-08-30T09:12:44Z" },   // null when read from a local path
  "syncedAt": "2026-09-02T20:44:28.685Z",
  "count": 142, "resolved": 123, "unlisted": 11, "bseOnly": 5, "unresolved": 3,
  "holdings": [
    { "isin": "INE103A01014", "name": "Mangalore Petrochemicals and Refinery",
      "bookName": "MANGALORE PETROCHEMICALS AND REFINERY LIMITED", "ticker": "MRPL", "sector": "Unclassified",
      "listed": true, "matchedName": "MANGALORE REFINERY & PETROCHEMICALS", "matchedBy": "confirmed:yahoo" },
    { "isin": "INE0OC301013", "name": "Turtlemint Fintech Solutions", "bookName": "TURTLEMINT FINTECH SOLUTIONS LIMITED",
      "ticker": null, "sector": "Financials", "listed": false, "reason": "unlisted — private company, held directly" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `asOf` | string | The family file's own `asOf` — the custody workbook date, `YYYY-MM-DD`. |
| `source` / `sourceCommit` / `syncedAt` | string / object \| null / string | Where the book was read from, which commit of theirs (null on a local read), and when. |
| `count` / `resolved` / `unlisted` / `bseOnly` / `unresolved` | number | `resolved + unlisted + bseOnly + unresolved === count`, asserted by the suite. |
| `holdings[].isin` | string | **The identity of a line.** One equity ISIN (`INE…`) is one holding, however many entities hold it and whatever each calls it. Unique; asserted. |
| `holdings[].name` | string | The display name — what the reader recognises. From `DISPLAY_NAMES` in the resolver where a line has one; otherwise the full name on the feed it resolved on, or the custodian's wording title-cased. Never blank. |
| `holdings[].bookName` | string | **The custodian's own wording**, as their file carries it — upper-cased, cut at twenty characters ("JUBILANT PHARMOVA LT"). Kept beside the display name as the audit trail back to the source. |
| `holdings[].ticker` | string \| **null** | NSE symbol, or `null` — see below. |
| `holdings[].sector` | string | From the statement; `Unclassified` where it gave none. |
| `holdings[].listed` | boolean | Whether the company is listed at all, which is a different fact from whether we resolved it. |
| `holdings[].matchedName` | string | The name on the feed the symbol came from — the audit trail for a fuzzy match. |
| `holdings[].matchedBy` | string | How it resolved: `exact:` / `prefix:` + the source, `yahoo-search`, or `confirmed:yahoo` for one checked by hand. |
| `holdings[].reason` | string | Present **only** when `ticker` is null. Why no symbol exists, in the words the UI prints. |

### `ticker: null` is a real holding, and it is kept

Nineteen of the 142 have no NSE symbol. They are still owned. Dropping them would make "Portfolio"
quietly mean *"the 123 we happen to have a feed for"*, with nothing on screen saying so — the same
class of error as rendering a missing value as zero. So they stay in the file with a `reason`, and
the tabs surface them as **held but not covered**:

| Why | Lines |
| --- | --- |
| Unlisted — private company, held directly | 5 · Turtlemint, OnEMI, Standard Engineering Technology, Finbud, AvenuesAI |
| Demerged entity, not listed as at the book date | 4 · the Vedanta aluminium / power / iron & steel / oil & gas lines |
| Warrants, not the equity line | 2 · Vikram Kamats, Alpex Solar |
| BSE-only — every feed wired here is keyed by NSE symbol | 5 · Concord Control Systems, Ashika Credit Capital, Sanjivani Paranteral, Glittke Granites, Vikram Kamats |
| No symbol found on either exchange | 3 · String Metaverse, Nisus Finance Services (SME), Future Supply Chain Solutions (delisted after insolvency) |

`coverageNote()` in `js/data/coverage.js` is the one place that sentence is written, and
`scopeSummary({ book })` prints the denominator in the pill beside every scoped table — *"Portfolio
· 96 of 142 reported"*. A count with no denominator is the thing to avoid: 96 rows looks complete
until you know the book is 142.

### The sync — `scripts/sync-family-book.mjs` and `scripts/fixtures/family-book.json`

```bash
node scripts/sync-family-book.mjs                 # read the family repo, write the fixture, re-resolve
FAMILY_BOOK_PATH=../sattva-family/src/data/sattvaData.ts node scripts/sync-family-book.mjs   # a local clone
node scripts/sync-family-book.mjs --no-resolve    # the fixture only
```

The family repository is private, so a fetch needs `FAMILY_REPO_TOKEN` — a fine-grained token on
`techmuns/Sattva-Family` alone with **Contents: read** — and the script exits non-zero naming that
secret when it has neither the token nor a local path. It reads `src/data/sattvaData.ts` through the
GitHub contents API, parses the `SATTVA_POSITIONS` literal (333 positions across the family's
seventeen entities), keeps **one line per `INE…` ISIN** and writes the fixture:

```jsonc
{ "source": "techmuns/Sattva-Family · src/data/sattvaData.ts", "asOf": "2026-06-30",
  "sourceCommit": { "sha": "…", "date": "…" }, "fetchedAt": "…",
  "positions": 333, "excluded": { "etf": 4, "liquid": 2, "other": 1 }, "count": 142,
  "lines": [ { "isin": "INE004A01022", "name": "Protean eGov Technologies Ltd", "sector": "Information Technology" } ] }
```

Three things it refuses to do:

- **Carry a value.** Their file has quantity, cost, market value and P&L on every line; none of it
  reaches the fixture, and the suite asserts each line is exactly `{ isin, name, sector }`. The book
  answers *is this company one of ours?* and a stale rupee figure beside a live price is the kind of
  number this dashboard does not show.
- **Treat fund units as companies.** `INF…` ISINs — the gold, silver and liquid ETFs — are counted
  under `excluded` and not carried, because no research feed here is keyed by them. The ISIN prefix
  decides, not their `assetClass`: the Liquid BeES line is filed as "Equity".
- **Overwrite a good fixture with a bad read.** A regex that stopped matching their file would parse
  to nothing, and an empty book would make "Portfolio" mean nothing on every tab at once. The shape
  is asserted, and a result below 80% of the committed line count is refused.

It is byte-stable when nothing moved — `fetchedAt` alone never makes a commit — and prints which
ISINs were added and removed since the committed fixture.

**Refresh cadence** — `.github/workflows/family-book-sync.yml`: 06:00 IST every day, by hand, and on
`repository_dispatch` with event type `family-book-updated`, which is what lets the family repository
poke this one the moment its book changes. GitHub's cron is best-effort; the dispatch is the path
that keeps the two genuinely in sync. From the family repository's own workflow, one step:

```yaml
- run: |
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      https://api.github.com/repos/techmuns/Sattva-Central-Research/dispatches \
      -d '{"event_type":"family-book-updated"}'
  env: { TOKEN: "${{ secrets.RESEARCH_REPO_TOKEN }}" }   # a token on THIS repo with Contents: write
```

### Resolution — `scripts/resolve-portfolio-companies.mjs`

Run it to rebuild the file from the fixture; `--net` lets it reach Yahoo's symbol search for the
leftovers. **Every hand-checked table in it is keyed by ISIN, never by name** — the custodian's names
are cut at twenty characters and spelt differently across entities, and a table keyed on one spelling
would silently detach the day their file carried another. `DISPLAY_NAMES` is the one table that
carries a name: the reader-facing wording for each known ISIN. A new ISIN that is not in it yet is
shown under the name the feed it resolved on prints, or the custodian's wording title-cased, and the
run reports it under *NEW LINES* so someone can add the entry — never dropped, never guessed.

It matches against the feeds already in the repo (StockScans' con-call index, the Moneycontrol
ticker map, the screener export) before going out to the network, exact match first, then a
`squash()`ed prefix match — Moneycontrol truncates names to about fifteen characters, so *"Mangalore
Petrochemicals and Refinery"* has to reach *"MANGALORE REFINERY & PETRO…"* somehow. Ten symbols that
prefix-matching would have got wrong or missed are pinned in a `CONFIRMED` table, each checked
against Yahoo by hand, and the not-listed lines are pinned in `NOT_LISTED_EQUITY` so a future run
cannot quietly "resolve" a private company to a same-named listed one. Eight more that Yahoo's search
placed on an earlier `--net` run are pinned there too, so the scheduled sync resolves the whole book
from the files on disk and never depends on somebody else's search box being reachable.

**A collision guard fails the run rather than shipping a silent merge.** Two book lines that resolve
to one symbol means one of them is wrong, and the pair that proved it is *Allcargo Global* and
*Allcargo Logistics* — genuinely two companies, `AGL` and `ALLCARGO`. Without the guard one would
have inherited the other's rows and the reader would have seen a holding they do not own.

**Refresh cadence** — whenever the family repository's book changes, through the sync above; the
resolver is re-run by the same job.
**Real source** — `techmuns/Sattva-Family`, `src/data/sattvaData.ts`, generated there from the custody workbooks.
**Consumed by** — `js/data/coverage.js`, and through it every tab's `forScope()` and the header search.

---

## `public/data/portfolio.json` and `public/data/portfolio-history.json` — DELETED

Both are gone, with `public/data/mock/transactions.json`, `js/data/portfolio.js`,
`js/portfolio/*`, `scripts/gen-mock-transactions.mjs` and `scripts/scrape-portfolio-history.mjs`.

`portfolio.json` was the tracked-holdings config — twelve positions whose `qty` and `avgPrice` were
derived from a FIFO replay of the mock ledger. `portfolio-history.json` was three years of real
daily closes (~290KB) behind the equity curve, the two drawdown series and the Nifty 500
comparison. Together with the ledger they were the Portfolio Analytics workspace, which is deleted:
see *Portfolio means a list of names* in `CLAUDE.md` for why, and `d3bba30` in git history for the
code. Nothing in the dashboard fetches any of them, and `scripts/verify-ui.mjs` asserts that each
one 404s on the served site so a stale import cannot quietly bring the feature back.

**The only portfolio file left is `portfolio-companies.json`** — the book, above.

## `public/data/universe.json`

The coverage universe: **535 companies, the real NSE-500 Screener export**. Root is an **array**,
with Screener.in's own column names and display-formatted values — kept verbatim so the scraper
reads exactly what the export provides.

```jsonc
[
  {
    "Company": "P & G Hygiene",
    "Screener URL": "https://www.screener.in/company/PGHH/",
    "Market Cap": "27,582 Cr.",
    "Broad Sector": "Fast Moving Consumer Goods",
    "Sector": "Fast Moving Consumer Goods",
    "Broad Industry": "Personal Products",
    "Industry": "Personal Care",
    "Chg in FII Hold": "0.01 %",
    "Chg in DII Hold": "-0.38 %"
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `Company` | string | — | Display name. |
| `Screener URL` | string | — | **The ticker source.** `/company/<TICKER>/` is parsed out; that slug is the join key across every other file. A numeric slug (3 rows) is a BSE code for a company with no NSE listing — the scraper goes straight to `.BO` for those. |
| `Market Cap` | string | display text | e.g. `"27,582 Cr."`. Parsed to a number by `parseMarketCapCr()`. |
| `Broad Sector`, `Sector` | string | — | Coarse and standard sector. |
| `Broad Industry`, `Industry` | string | — | Coarse and fine industry. |
| `Chg in FII Hold` | string | percent text | e.g. `"-0.25 %"`. Parsed by `parsePercentValue()` → `chg_fii_hold`. |
| `Chg in DII Hold` | string | percent text | → `chg_dii_hold`. |

The upstream Screener export carries ~50 columns (ratios, quarterly series, shareholding series).
Only the nine above are kept — they are everything the scraper and this dashboard read, and
trimming takes the file from ~1MB to ~163KB on a static site with no build step.

**Adapter.** `js/data/universe.js` converts these rows into the simpler
`{ ticker, name, marketCap, sector, industry, screenerUrl, chgFiiHold, chgDiiHold }` shape that the
eight mock tabs already consume, so swapping in the real export required no changes to them.
Read `ctx.data.universeRaw` if you need a screener column the adapter doesn't expose.

**Refresh cadence** — manual re-export. NSE 500 constituents change quarterly; the FII/DII columns
change with each shareholding filing.
**Real source** — Screener.in screen export over the NSE 500.
**Consumed by** — the technicals scraper (its input list), global search, and every tab's Universe
scope.

---

## `GET /api/earnings` — LIVE, the Earnings Hub feed

**The dashboard's second genuinely live surface, and the only one that is live per-request rather
than per-schedule.** Served by `worker/index.js`, which proxies Moneycontrol's Rapid Results API
through `worker/mc.mjs` and caches the normalised result at the edge for 30 seconds.

```
GET /api/earnings?subType=yoy|qoq&category=all|std|con
```

```jsonc
{
  "ok": true,
  "degraded": null,                       // a string when serving the fallback — see below
  "latestResultDate": "2026-08-10",
  "count": 1319,
  "meta": { "quarter": "Q1 FY26-27", "currentPeriod": "Jun 26", "priorPeriod": "Jun 25",
            "source": "Moneycontrol — Rapid Results", "fetchedAt": "2026-08-11T…Z",
            "contentTag": "d04fdba9b88b5439",     // == the ETag; see "Conditional delivery"
            "structureTag": "8c514c34cec2ebfb" }, // identity + reported figures, price EXCLUDED
  "rows": [
    { "scId": "IC8", "name": "Vodafone Idea", "ticker": "IDEA",
      "resultDate": "2026-08-10", "ltp": 13.26, "changePct": 2.63,
      "exchange": "N", "basis": "Consolidated", "sectorSlug": "telecommunication-service-provider",
      "revenue":    { "current": 11689, "prior": 11023, "reportedPct": 6,  "kind": "normal",        "pct": 6 },
      "netProfit":  { "current": -3754, "prior": -6608, "reportedPct": 43, "kind": "loss-narrowed", "pct": 43 } }
  ]
}
```

### `kind` — the field that stops the table lying

Moneycontrol reports growth as a plain percentage even when the sign flips between periods. In a
full quarter that is **169 of 1,319 companies (13%)**, and the number does not mean what it looks
like. Every metric is therefore classified:

| `kind` | Meaning | `pct` |
| --- | --- | --- |
| `normal` | Profit in both periods. The only case where a growth rate is meaningful. | the percentage |
| `loss-narrowed` / `loss-widened` | Loss in both periods. "+43%" describes the size of the loss, not profit growth. | reported, but labelled |
| `turnaround` | Loss → profit. A change across zero is not a growth rate. | **null** |
| `slipped-to-loss` | Profit → loss. Same. | **null** |
| `from-zero`, `flat`, `na` | No prior base, or nothing to compare. | **null** |

The UI renders a signed percentage only for `normal`; everything else is a labelled pill. Getting
this wrong would paint Wockhardt's loss-to-profit recovery as a green "+199%" growth rate.

**Identity is resolved on the fly for companies the map has never seen.** A company that reports
today is by definition not in a map built yesterday — and those are exactly the rows at the top of
a live results table. The Worker resolves up to 40 unknown codes per cache window against the price
feed and merges them in, so the freshest rows arrive with a ticker, an industry and a share count
rather than three dashes. `meta.resolvedOnTheFly` reports how many. The scheduled job still
maintains the durable map; this only covers the gap between filings and the next run.

**Degraded mode** — if the upstream fails or changes shape, the Worker serves the committed
snapshot with `degraded` set to a human-readable reason, and the tab swaps its green "Live" ribbon
for an amber "Showing the last snapshot" one. An empty feed is never served as success, because
"no results" and "we could not reach the source" are different claims.

### `seq` — the upstream's own order, and why it is data

Every row carries `seq`, the index Moneycontrol returned it at. `resultDate` is a **date**, but
filings arrive through the day and the upstream is sorted latest-first at that finer granularity.
Sorting our copy by `resultDate` alone therefore needs a tie-break, and any tie-break we invent is
a different list from the one Moneycontrol shows — an early version broke ties on the size of the
profit move, so "Latest Results" opened on neither the latest filings nor the same order as the
source. `seq` is stamped in `worker/mc.mjs` so the live route, the committed snapshot and the
browser all agree, and `dateSortValue()` in `js/data/earnings-live.js` encodes
`(resultDate desc, seq asc)` into the Date column's single sort key.

### `subType` — one filing, two questions

`subType=yoy` compares the quarter against the same quarter a year earlier; `subType=qoq` compares
it against the quarter before. **The current-period figures are byte-identical between the two** —
only `prior`, `reportedPct`, `pct` and `kind` change. The Earnings Hub exposes this as a YoY/QoQ
toggle and mirrors it into the URL as `?period=`.

Three rules follow from that, and all three exist because the two payloads look the same:

1. **The response's `meta.subType` is authoritative, not the request.** `setSubType()` in
   `js/data/earnings-live.js` refuses a payload whose `meta.subType` is not what it asked for.
   Serving YoY under QoQ headers is the one error nothing downstream could catch — the visible
   current-period column would be correct.
2. **The change fingerprint covers `prior` as well as `current`**, for the same reason: a checksum
   over the current period alone cannot tell the two sub-types apart.
3. **There is no QoQ snapshot, deliberately.** `earnings-live.json` is YoY. A committed QoQ file
   would be indistinguishable from a live one while comparing against a stale quarter, so when the
   live route is unreachable the tab says QoQ is unavailable rather than falling back.

A `kind` can differ between the two for the same company — Unichem Labs' Q1 is a `turnaround`
YoY (−10 → 41) and a plain `normal` +272% QoQ (11 → 41). That is not an inconsistency; it is the
two questions having different answers.

**Consumed by** — `js/data/earnings-live.js` → the Earnings Hub.

---

## `GET /api/earnings?fields=prices` — the polling projection

The same feed with everything that does not move stripped out: **~30KB against 1.1MB.**

```jsonc
{
  "ok": true,
  "fields": "prices",
  "structureTag": "8c514c34cec2ebfb",   // the full feed's identity + reported figures
  "latestResultDate": "2026-08-11",
  "count": 1488,
  "degraded": null,
  "prices": { "CHC": [1191, 6.43], "IC8": [13.26, 2.63] },   // scId -> [ltp, changePct]
  "meta": { "subType": "yoy", "category": "all", "quarter": "Q1 FY26-27",
            "currentPeriod": "Jun 26", "priorPeriod": "Jun 25",
            "source": "…", "fetchedAt": "…", "contentTag": "579cfa7abe7ebfb8" }
}
```

Two-element arrays rather than objects on purpose: `"CHC":[1191,6.43]` is 20 bytes where
`{"ltp":1191,"changePct":6.43}` is 44, and there are ~1,500 of them.

**Why this exists when every route is already conditional.** The results feed is the one place a
304 buys nothing: `ltp` moves on every tick during market hours, so the full representation
genuinely changes every 30 seconds even when not one reported figure has. Splitting the volatile
field out means the poll carries only what actually moved.

`structureTag` is a tag over identity and the reported figures with the **traded price
deliberately excluded** (`structureTagOf` in `worker/index.js`). The client re-fetches the full
feed exactly when it moves, which is when a company has filed or revised — so a filing still
reaches the screen on the very next tick. `js/data/earnings-live.js` folds the prices onto the
payload it holds and re-ingests through the same `joinRow`, because market cap is `shares × price`
and return-since-result is measured against the result-day close: both move with the price, and
recomputing them anywhere else is how the two would drift.

**The con-call route deliberately has no equivalent.** Nothing on a con-call row moves on a tick,
so the conditional GET does the whole job there; a merge path that could drift from the server's
truth would be complexity bought for nothing.

---

## Conditional delivery and the device store

Every `GET /api/*` route answers with a content-derived `ETag` and answers a matching
`If-None-Match` with a **bodyless 304** (`worker/http.mjs`, shared by the Worker and any local
stand-in so the two cannot drift). The dashboard keeps the last payload it received in IndexedDB
and paints from it before touching the network.

Measured in Chromium, Earnings Hub: **cold 2,388KB → reload 5KB → one unchanged poll 0.3KB.**
Before this, one open tab pulled 1,135KB per tick — about 136MB an hour — to be told nothing
had changed.

| Field / key | Where | Meaning |
| --- | --- | --- |
| `ETag` / `meta.contentTag` | every `/api/*` response | the payload's content tag. Identical values, so a caller that cannot read the header (cross-origin without `expose-headers`) finds it in the body. |
| `meta.structureTag` | `/api/earnings`, both representations | identity + reported figures, price excluded. |
| `x-sattva-cache` | every `/api/*` response | `miss` / `hit` / `derived` / `fallback`, and `…-304` when the body was withheld. |
| `sattva-cache` → `payloads` | IndexedDB | `{ tag, savedAt, value }` under `earnings:<subType>`, `earnings:<subType>:prices`, `concalls`, `calendar:<date>`. |

The rules that make it safe to trust:

- **The tag covers content, never delivery.** `VOLATILE_KEYS` in `worker/http.mjs` drops
  `fetchedAt`, `servedAt`, `resolvedOnTheFly`, `unresolved`, `headFresh` and `contentTag` itself
  before hashing. Include any of them and the tag changes on every request while the payload does
  not, so the 304 never fires and the whole scheme silently does nothing. The test that catches
  this is a tag that survives an **edge-cache expiry**, where the Worker really has gone back
  upstream and re-stamped the timestamps.
- **The store holds the server's own bytes under the server's own tag.** Price updates from the
  projection are folded into memory and never written back. A locally patched value under a tag
  that no longer describes it would make the next 304 a lie.
- **Two freshness facts, never merged.** `meta.fetchedAt` is when the upstream was read;
  `meta.checkedAt` is when we last confirmed that reading was still current. A 304 moves the
  second and not the first. `meta.origin` (`live` / `store` / `snapshot`) says where the paint on
  screen came from, and `deliveryNote()` in `js/ui/sources.js` retains all three for the source
  registry. Live status labels themselves are passive and open no delivery popup.
- **The client must not send `If-None-Match` itself.** Chromium aborts a hand-rolled conditional
  fetch whose response is a 304 with `net::ERR_ABORTED`; because pollers swallow optional errors,
  the symptom is a feed that quietly stops updating rather than an error. `conditionalJson` uses
  `cache: 'no-cache'` and lets the browser send the validator, then compares the response ETag
  against the stored one before reading the body so an unchanged tick still skips the parse.
- **A store miss is not an error** — it means "fetch it". Private windows and disabled storage
  fall back to an in-memory Map; `isPersistent()` reports which, and the UI says so.

---

## `GET /api/concalls` — LIVE, the con-call scan (StockScans)

```jsonc
{
  "ok": true, "degraded": null,
  "rows": [{ "companyKey": "164", "companyId": "NSE:EPL", "ticker": "EPL", "name": "EPL Ltd",
             "industry": "Packaging - FMCG/Consumers", "when": "2026-08-11T18:00:00+05:30",
             "date": "2026-08-11", "resultScore": 61.7, "sentimentTier": 3, "notesReady": true,
             "tags": ["▲ Revenue guidance raised to high teens", "…"],
             "ssUrl": "as-…pdf", "pptSsUrl": "…pdf" }],
  "upcoming": [{ "ticker": "LANDMARK", "name": "Landmark Cars Ltd", "when": "2026-08-12T09:00:00+05:30" }],
  "today":    { "day": "2026-08-12", "rows": [ … ] },
  "meta": { "quarter": 202606, "total": 877, "headRows": 50, "tailRows": 827, "truncated": false,
            "fetchedAt": "2026-08-11T…Z", "contentTag": "2a4926653eb47e5e" }
}
```

`upcoming` retains every call StockScans have listed but not yet seen held. It is no longer exposed
as a Con-call header control or overlay. `today` is a
strict SUBSET of `upcoming`'s entries for the current date — the ones still ahead of now (43 of
today's 64, in the pull above). Consumers must not merge it back into `upcoming`; that would
double-count and then need de-duplicating for nothing.

The body carries **no "served at" stamp**, deliberately: it would differ on every request while
the content did not, so the ETag would never match and the 304 this route depends on would never
fire. `meta.fetchedAt` — when StockScans was actually read — is the honest freshness signal, and
the client stamps its own `checkedAt` on every poll, 304s included.

**The scores are StockScans', not ours.** `resultScore` (0–100), `sentimentTier` (0–4) and the
`tags` bullets are their analysis of each call, reproduced unchanged. The tier bands in
`public/js/data/stockscans-shared.js` — 80 Excellent / 60 Strong / 40 Average / 20 Weak / Poor,
and 4 Bullish → 0 Bearish — are lifted from their own client so a label we print is a label they
print. See *Reproducing someone else's analysis* in CLAUDE.md before touching any of it.

**The UI does not print their brand, and that is not the same as not attributing it.** Every
customer-facing surface — the sub-view description, the Live pill's modal, the drill's Provenance
group, the alert stack and row 1 of the exported sheet — says the scores are a *third-party research
provider's* and that this dashboard adds no scoring of its own; none of them names the provider. The
name lives in the code, in this file, and in the link every row carries to their own page for that
call. The honesty obligation is the disclaimer, which is stated in full; the trade name is a
commercial choice. Do not drop the first while dropping the second.

### `ssUrl` is a document key, and only one of their two routes accepts it alone

`ssUrl` / `pptSsUrl` are pointers into their reader, not files we can serve. There are two ways in
and **they are not interchangeable**:

| Route | Needs | Use it? |
| --- | --- | --- |
| `/company/<companyId>/<type>/<period>/<file>` | companyId **and a period** | **No.** The payload has no period. |
| `/document/<file>` | the document key alone | **Yes** — `docUrl()` builds this. |

`docUrl()` used to build the first with the period segment treated as optional, and no caller ever
had a period to pass, because the scan payload does not carry one. So every row's link was one
segment short and **every "open the full summary" click landed on a 404** — for the whole life of
the tab. It looked like a link and behaved like a link and had never resolved. The failure surfaced
as *their* 404 page, which reads as "their document is gone" rather than "our URL was wrong", so the
artefact pointed away from the bug. Verify a constructed deep link against the upstream —
`curl -o /dev/null -w '%{http_code}'` on one real row — before shipping it.

### Two caches on one route, because the feed is newest-first

A quarter is ~880 calls over 18 pages of 50. Re-pulling all eighteen every 30 seconds to catch one
new row would be slow and rude. But `when` descends monotonically from offset 0 — verified across
a full quarter — so **a call that has just been analysed can only appear on page one**:

| Part | Offsets | TTL | Why |
| --- | --- | --- | --- |
| head | 0–49 | 30s | the freshness path; everything new lands here |
| tail | 50+ | 10 min | it cannot change |
| schedule | — | 2 min | today + upcoming, two small calls |

The head is merged **over** the tail (`mergeScans`), keyed on `companyKey|when`, so a row whose
analysis landed between the two fetches is taken from the head with its score rather than from the
tail without one. Steady state is one upstream request per 30 seconds instead of eighteen.

### The change worth repainting for is not a new row

A call joins the feed when it is **held** and gains its score some minutes later. So the client's
fingerprint covers `resultScore`, `sentimentTier`, `notesReady` and the tag count as well as
identity, and `newArrivals()` counts *newly analysed* as an arrival alongside *newly listed*.
`resultScore: null` renders **pending**, never zero — a zero would claim StockScans had assessed
the call and found it worthless.

**Upstream**: `POST /api/company/concall-scan` (body `{offset}`), `POST …/upcoming`, `GET …/today`
on `www.stockscans.in`. No auth, no bot wall, `robots.txt: Allow: /` — it answers a Cloudflare
Worker the same way it answers a laptop, unlike the Moneycontrol calendar page.

**Consumed by** — `js/data/concall-scans.js` → the Con-call scan table. `upcoming` remains in the
feed contract but is not rendered in the tab chrome.

---

## `public/data/concall-scans.json` — the con-call snapshot

Same payload shape as the route above, committed by `scripts/scrape-concalls.mjs` (~460 KB). First
paint and the Worker's fallback, exactly like the earnings snapshot — not what makes the tab
fresh. The script refuses to write an empty file.

---

## Concall Deep Dive — a SEPARATE dashboard, called on demand

The **Deep Dive** column on the scan table hands one company to a different Cloudflare Worker,
which runs its own LLM pipeline over that company's call and publishes a report. This dashboard
triggers it, mirrors its progress, and lays out what it returns. **Nothing here goes through our
Worker, nothing is cached in `public/data/`, and nothing is committed.**

**Client** — `public/js/data/deep-dive.js` (transport) and `public/js/concall/deep-dive.js` (panel).

### Where the base URL lives

`https://concall-sattva.tech-441.workers.dev`, set as `window.SATTVA_DEEPDIVE_URL` in
`public/index.html`. That Worker has no custom domain, so the address is whatever Cloudflare
assigned it and nothing can derive it — which is why it is written down rather than constructed.

`baseUrl()` reads `localStorage['sattva:deepdive-base']` **first** and falls back to the global, so
a reader (or the verification suite) can point the column somewhere else without touching the
page. If neither is set the column renders a *Connect* step instead of a broken button.

### The three routes it uses — and only one of them costs anything

| Call | Sends | Returns | Cost |
| --- | --- | --- | --- |
| `GET /api/summary` | — | `{ ok, version, count, summaries[] }` — every report they already hold, with `slug`, `ticker`, `company`, `quarter`, `verdict`, `generated_at` | free |
| `GET /api/report?slug=` | — | `{ ok, slug, status, stage?, message?, report?, partial? }` | free |
| `POST /api/analyze` | `{ company, ticker?, force? }` | `{ ok, slug, status }` — `status: "done"` means a cached report was reused and no run started | **a real LLM + compute run** |

`status` is one of `queued` \| `running` \| `done` \| `error` \| `unknown`. **`unknown` is not a
failure** right after a dispatch — it is KV propagation lag, and the panel shows it as the first
step of the checklist. Polling is every 4s with a 25-minute ceiling, just past their own ~20.

**A running response carries a bare stage key and nothing else** — `{ ok, slug, status: "running",
stage: "research" }`. There is no `message` field, so anything that looks like one on screen would
have been written here. `STAGES` in `public/js/data/deep-dive.js` is their own key → label →
percentage table, copied from their frontend, and the panel renders their screen from it: label,
percentage, bar and a seven-step checklist. An unrecognised key resolves to the first stage rather
than blanking the panel.

**Reopening reattaches by itself.** `resume(slug)` polls and never dispatches, so it is safe to run
unprompted: closing the panel leaves the run alone upstream, and opening it again lands on live
progress, or on the finished report, or on this device's copy of it.

**A reattach must not look like a run.** The panel opens on an `opening` state — one line saying no
run is being started — and only a status their API actually reports as in flight promotes it to the
stage checklist. It used to open on the run screen for both, so returning to a report finished an
hour ago showed *"Starting the analysis… 5%"* and the seven steps while a free GET was in flight.
Nothing was being spent, and the screen said otherwise; a reader has no way to tell that screen from
the metered one. `run()` derives both the screen and the request branch from a single resolved
`resumeSlug`, so the sentence and the behaviour cannot drift apart.

### Finished reports are kept on this device

A report is the output of a **metered LLM run**, and their store drops one after about a fortnight.
Once it is gone the only way back to an analysis already read was to pay for it again — so every
finished report is written to IndexedDB and reopening paints from there before any request is made.

| Where | What |
| --- | --- |
| IndexedDB, `deepdive:<slug>` (`KEYS.deepDiveReport`) | the report **body**, exactly as they returned it |
| `localStorage['sattva:deepdive-reports']` | a small index — `slug -> { ticker, company, quarter, savedAt }` — read synchronously on every table paint so the rows that open for free are marked without an async read. Capped at `MAX_SAVED` (60), oldest out, body and index together |

This is the only entry in `KEYS` that is **not** fetched through `conditionalJson`: their
`GET /api/report` sends no ETag and wraps the body in a status envelope, so there is no validator to
send and nothing to 304. The reason to keep it is different too — not bytes, but money.

Opening a slug we already have is device-first, the same shape as the Superstar Investors books:

1. **Pass one** paints the stored report with **zero requests**, and `load` resolves there.
2. **Pass two** re-checks against them in the background. Unchanged — the common case — repaints
   nothing but the ribbon, so a reader mid-paragraph is not sent back to the top. A newer report
   replaces it in place. A failure changes nothing.

Three rules make that safe, and they are the store's usual ones:

- **What is kept is their bytes under their slug.** Nothing is patched, trimmed or recomputed.
- **A failed re-check never deletes a report we hold.** `unknown` means their store has dropped it,
  which is precisely when this device's copy is the only one left; a network error means we could
  not ask. Neither is a reason to show a confirm step that asks the reader to buy back an analysis
  they have already read. Only a slug with **no** saved copy falls through to that step.
- **A stored paint may not claim a freshness it has not confirmed.** `origin` (`store` / `live`) is
  where the bytes on screen came from and `checkedAt` is when the dashboard last confirmed them —
  the same two facts `deliveryNote()` prints for the polled feeds. A re-check moves the second, not
  the first, so an unchanged report still reads *"shown from the copy saved on this device"*. When
  their copy is gone the ribbon says so outright.
- **A report that contradicts the row is never filed under that row's ticker.** It still renders,
  under the rose banner below, but writing it to the store would make every later open of that row
  serve another company's analysis from disk with no upstream left to correct it.

`slug` is **always theirs**, derived server-side. Never construct one here. It is remembered per
ticker in `localStorage` under `sattva:deepdive-slugs` so closing the panel and reopening
reattaches to a run in flight rather than dispatching a second one, and `<BASE>/#/report/<slug>`
deep-links to their own rendering.

### A DISPATCH COSTS MONEY; A READ DOES NOT. The integration is built on that line

Their `POST /api/analyze` is **unauthenticated** and every accepted call dispatches a real LLM +
compute run. The reads are plain GETs with no pipeline behind them. So:

- **Nothing that costs a run ever fires on its own.** No poller registers this, no row triggers it
  on render, the cell is a button and nothing else, and the first click opens a **confirm** step
  that says a run costs compute before anything is sent. "Re-run from scratch" on a finished report
  returns to that same confirm step rather than dispatching on the click.
- **The free index IS fetched unprompted**, once per page load — never polled, never per row. It
  is what lets a row say *"report ready"* instead of making the reader pay to find out. Rows it
  names get a filled button and open through `resume(slug)`, which only polls.
- Reopening a panel uses `resume(slug)` too. Their API would dedup a second `POST` anyway, but not
  asking at all is the version that cannot cost a run through a bug of ours.
- The dot on an outlined button means *this browser* has dispatched a run for that ticker; the
  filled button means a finished report opens for free. Different facts, different marks. The
  filled state is reached two ways — their index says they hold a report, or this device does — and
  the second is stronger, because it needs no network at all and is known synchronously, so those
  rows are filled on first paint rather than upgraded when `/api/summary` lands.

### The report is theirs, and the renderer never pretends otherwise

Same rule as the StockScans scores above and the Trendlyne holding values below: we reproduce, we
do not recompute. The panel adds no scoring, no re-banding and no judgement, says whose analysis it
is at the top of every finished report, and links to their own rendering of it.

**The renderer is shape-driven, not field-driven.** `report`'s schema lives in *their* repo and is
expected to grow, so sections render **in their own key order** — reordering them would be this
dashboard editing their report — and each is drawn from its *shape*: a uniform array of short
scalars becomes a table, an array carrying prose becomes cards titled by their first field, a flat
object becomes a definition grid. Nothing keys off a field name except `meta`, which is provenance
and gets a purpose-built strip, and two cosmetic hints (`*_url` renders as a link, `quote` renders
as a blockquote). A section they add next month arrives laid out rather than dropped or dumped as
JSON. Today's payload is `meta`, `about`, `concall`, `key_takeaways`, `thesis`, `anti_thesis`,
`financials`, `valuation`, `next_steps`, `earnings`, `call_over_call` — **none of that list is
hard-coded anywhere.**

Every string is escaped and only `http(s)` values ever become anchors — this is external content
and none of it reaches the DOM as markup.

**Quoted speech is real speech.** A report carries transcript quotes attributed to named
executives and named sell-side analysts. That is the opposite of the synthetic-speech case
CLAUDE.md forbids: the words are lifted from a filed transcript by their pipeline, not invented,
nothing here edits them, and `meta.sources.transcript_url` links the filing they came from. If
that ever stopped being true, this panel would have to stop rendering quotes rather than caveat
them.

**The panel is titled from our row; the report is titled from theirs.** If `report.meta.ticker`
contradicts the row's ticker, the panel says so in a rose banner instead of quietly presenting one
company's analysis under another's name. That is the worst failure this feature could have, and a
slug is resolved in two places (their index, and this browser's memory of a dispatch), so it is
checked rather than assumed.

`partial: true` means they could not fill every field; the panel says so in amber rather than
rendering the gaps as if complete.

---

## `GET /api/earnings-calendar` — LIVE, who is *scheduled* to report

```
GET /api/earnings-calendar?date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD[&list=none]
```

```jsonc
{
  "ok": true,
  "date": "2026-08-13",
  "from": "2026-08-06", "to": "2026-08-27",   // strip window; defaults to date-7 .. date+14
  "asOnDate": "11/08/2026",                    // Moneycontrol's own "schedule as on"
  "scheduledCount": 585,                       // complete All-exchange count for `date`
  "listRequested": true,                       // false => `rows` is empty because nobody asked
  "pageSize": 20, "pagesFetched": 30, "requestsMade": 31, // includes bounded retries
  "complete": true,                            // every published pagination page was read
  "days": [{ "date": "2026-08-13", "displayDate": "13 Aug", "count": 585 }],
  "rows": [{ "scId": "SE20", "name": "Solar Industries India", "ticker": "SOLARINDS",
             "industry": "Commodity Chemicals", "resultDate": "2026-08-13",
             "quarter": "Q1 FY26-27", "time": null, "ltp": 18770, "changePct": -1.2,
             "marketCap": 169849.83, "mcUrl": "https://…" }]
}
```

### `list=none` — the strip without the company list

The dashboard asks for `list=full` on every selected date. `list=none` remains available to
diagnostic and strip-only consumers; it skips the HTML pages, ticker-map asset read and identity
look-ups.

It is a **different representation, not a cheaper one**, and it is treated as such throughout: its
own edge-cache key, its own device-store key (`calendar:<date>:none`), `x-sattva-list-source:
not-requested`, and `listRequested: false` in the body. An empty `rows` that did not say why would
read as *"nobody reports on this date"* — the one thing this route must never imply. Any consumer
reading `rows` must check `listRequested` first.

`degraded` is null in this mode. Nothing failed; nothing was asked.

**Two endpoints, one All-exchange population.**

| What | Where from | Complete? |
| --- | --- | --- |
| The count on each date | `api.moneycontrol.com/mcapi/v1/earnings/result-calendar?fromDate&toDate&indexId=All` | **Yes** — clean JSON and unpaginated |
| First company-list page | `www.moneycontrol.com/earnings-widget?...&indexId=All&page=1` | Up to 20 rows |
| Remaining company-list pages | `www.moneycontrol.com/pagination/earnings-pagination?...&indexId=All&page=N` | **Yes** — followed until the complete count is reached |

The public page's current JavaScript names both HTML routes. `fetchCalendarDay()` requests the
first widget and every required pagination page, deduplicates by date plus `scId`, and rejects a
response that names fewer companies than the count. `scheduledCount` and `rows.length` therefore
match for a complete same-time read. A live-count/captured-list race may still disagree; in that
case `believableCount()` omits the total rather than presenting two observations as one fact.

**Identity is resolved live, always.** A company that has not reported yet is by definition absent
from a map built from companies that have, so almost every calendar row would arrive with no ticker.
The Worker resolves unknown identities within the external-subrequest budget left after pagination.
Rows that cannot be resolved remain visible with a null ticker; they are never dropped.

### It opens on today, in IST

`defaultCalendarDate()` returns **today**. It used to return the results feed's most recent filing
date — which lands on a date that has rows on it, and is wrong for the same reason a clock showing
the last time anyone looked is wrong: four days into a quiet stretch the tab opened on Friday the
14th with today's chip four places to the right, and nothing on screen said the selection was not
the current date. It reads as a dashboard whose data stopped.

`?date=` in the URL and the reader's own click both win over it, so a shared link and a session's
navigation survive; this is only the answer to *"no date chosen yet"*.

**Today is today in IST**, not in UTC. Every date on this tab is an Indian trading date, and
`toISOString()` alone names *yesterday* between 18:30 IST and midnight.

### Scheduled and filed results are separate views

The **Earnings Calendar** always renders this route's schedule, whether the selected date is past,
present or future. The adjacent **Earnings Reported** view always renders published filings from
the Rapid Results feed. Switching the meaning of the calendar according to the date caused the
screen to disagree with the linked source: on 2 Sep 2026 Moneycontrol scheduled Technocraft
Ventures and BSE-only Vivanta Industries, while only Technocraft had filed at the time. The old UI
therefore showed one row under “Earnings Calendar” where the source showed two.

The two sources are never merged or subtracted. A schedule is an announced expectation; a filing
is a published result, and companies can file a day either side of an announced date.

### The Akamai wall — why the list is usually a capture

`api.moneycontrol.com` is open. The widget and pagination routes on `www.moneycontrol.com` are
behind Akamai Bot Manager and can answer an ordinary client and a Cloudflare Worker differently.
If an expected non-empty page returns HTML with no company rows, it is a blocked response, not an
empty calendar.

So the list has two possible origins, and the payload names which one it used:

| `listSource` | Where from | UI |
| --- | --- | --- |
| `live` | the widget plus every pagination page, read at request time | green **Live** pill |
| `snapshot` | `public/data/earnings-calendar.json`, captured by the scheduled job | sky **Captured** pill |

`fetchCalendarDay()` throws a typed `CalendarPageBlocked` for "expected rows, received none" and a
plain `Error` when the parsed row count is below the published total. Both prefer the dated capture
over presenting a partial live list as complete.

**The counts and the list fail independently, so each names its own origin** — `countSource`
alongside `listSource`. Where the counts are live and the list is a capture (the usual state), a
schedule that has moved since the capture shows up as the two disagreeing in front of the reader,
rather than as two figures agreeing with each other and being wrong together. Cached 5 minutes at
the edge — a schedule moves in hours, not ticks.

### Pagination coverage and Worker request bounds

Each HTML page carries at most 20 companies. The all-exchange count determines how many pages are
required; `fetchCalendarDay()` requests them in batches of at most six concurrent connections and
deduplicates their rows. The 45-page guard keeps the request below the Workers Free-plan external-
subrequest ceiling after the count request. Identity resolution spends only the remaining budget,
so a busy calendar can never be truncated merely to preserve ticker enrichment.

This was verified against 13 Aug 2026: the all-exchange count was 585, pages 1–29 each carried 20
rows and page 30 carried five. The integration returned all 585 rather than the first page's 20.

### When the count endpoint goes flat — a zero that is not a measurement

The count endpoint has returned a structurally valid all-zero window while the calendar HTML and a
recent capture named companies on those same dates. The Worker substitutes captured counts only
when **the live strip carries no non-zero count anywhere and an overlapping capture does**, and
sets `countSource: 'snapshot'`. The test is evidence, not a threshold: a genuinely empty window
fails it because the capture is empty too.

It never switches to a different exchange population as a fallback. Counts and rows remain
`indexId=All`, or the response says that the requested measurement could not be read.

> An earlier version of this file said there was deliberately no snapshot, on the grounds that a
> stale schedule looks exactly like a fresh one. That was right about the danger and wrong about the
> remedy: the fix for "you cannot tell how old this is" is to stamp it, not to have no fallback.

---

## `public/data/earnings-calendar.json` — the calendar capture

Written by `scripts/scrape-calendar.mjs`, which runs on the GitHub runner where the calendar page
answers normally. Default window is today−3 to today+21; only dates with a non-zero count are
fetched, and every twenty-row pagination page for those dates is followed.

```jsonc
{
  "capturedAt": "2026-08-11T17:33:56.533Z",   // the UI prints this as a relative age
  "from": "2026-08-08", "to": "2026-09-01",
  "pageSize": 20,
  "days":   [{ "date": "2026-08-13", "displayDate": "13 Aug", "count": 585 }],
  "byDate": { "2026-08-13": { "rows": [...], "scheduledCount": 585,
                  "pagesFetched": 30, "complete": true, "asOnDate": "11/08/2026" } }
}
```

**A run that captured nothing leaves the previous file alone** and exits non-zero. Overwriting a
good capture with an empty one would make the tab say "nobody reports" rather than "we did not
manage" — the same class of error as serving an empty live feed as success.

**`time` is null, not "Time Not Available".** That is the upstream's string for "unknown"; carrying
it into a Time column would render a sentence where a clock belongs. Null renders as a dash, which
already means *not known* everywhere else here.

**Consumed by** — `js/data/earnings-calendar.js` → the Earnings Hub's Calendar view.

---

## `public/data/earnings-live.json` — the snapshot

The same payload shape as the route above, committed by `scripts/scrape-earnings.mjs`. Two jobs:
**first paint** (so the table is populated before any network round-trip, and works on a plain
`python3 -m http.server`) and the **Worker's fallback**. The live poll replaces it within seconds.

YoY only — see the `subType` rules above for why there is no QoQ counterpart.

Refreshing it more often would not make the tab fresher — the tab is live off the route. It only
bounds how stale the fallback can be. ~900 KB.

---

## `public/data/mc-ticker-map.json` — the join

`scID → { ticker, bseId, fullName, industry, shares, mktCapAtBuild }`, resolved from
`priceapi.moneycontrol.com`. **This file is the whole integration.** Moneycontrol identifies
companies by its own code and truncates display names to 15 characters — "Jubilant Pharmo",
"Embassy Develop" — so neither is usable as a join key without silently mis-joining look-alikes.

Two things worth knowing:

- **It is incremental.** Entries are written once; a rerun costs one request per never-before-seen
  company. A full build of 1,319 took about six minutes; a daily run costs a handful.
- **`shares` is stored, market cap is not.** The browser computes `shares × live price` on every
  poll, so the MCap column is current rather than as-of the last refresh. Verified against
  Moneycontrol's own figure: 887,786,160 × ₹5,131.70 = ₹455,585 Cr, exactly what they publish.
  `REFRESH_ALL=1` re-resolves everything, which is how share counts pick up a buyback or an issue.

Anything with no NSEID lands in `unresolved` and renders without a ticker. Current coverage:
**1,319 of 1,319 resolved, 0 unresolved.** ~190 KB.

---

## `public/data/result-returns.json` — the base of the return column

`TICKER@YYYY-MM-DD → { close, pricedOn }`, from Yahoo, written by
`scripts/scrape-result-returns.mjs`.

"Return since result" is `(price now − close on the result date) / close on the result date`. The
second half arrives live with every poll; the first half is a closing price on a date already past
and **will never change again**. So it is cached once and never recomputed, and the column is live
without anyone refetching a single historical price.

**Convention:** the base is the **close on the result date** — the last price at which the market
could trade without knowing the numbers, since Indian results are usually announced after the
close. If that day was not a trading day the previous close is used, and `pricedOn` records which.
Keys in `failures` render as "—", never 0%. Current coverage: **1,312 of 1,319**. ~80 KB.

---

## `public/data/mock/earnings.json` — MOCK, real-shaped

Eight quarters of results per company: everything the 15-rule Result Quality & Growth model in
`js/scoring/earnings-scoring.js` scores. Root is an **object** with a metadata envelope and a
`companies[]` array.

> **Illustrative data.** The 120 company names, tickers, sectors, industries and market caps are
> real — stride-sampled from `universe.json`. **Every financial figure is synthetic**, produced by
> `scripts/gen-mock-earnings.mjs` from a seeded PRNG (`SEED = 20260810`, so the file regenerates
> byte-identically). No number in this file is a reported figure. The UI is required to say so —
> see *Provenance surface* below.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. Company names, tickers, sectors and market caps are real …",
  "generated_at": "2026-08-10T10:41:45.675Z",
  "generator": "scripts/gen-mock-earnings.mjs",
  "seed": 20260810,
  "source": "Mock data",              // the flag the UI keys every honesty marker off
  "quarter": "Q1FY27",
  "season_start": "2026-07-10",
  "season_end": "2026-08-08",
  "company_count": 120,
  "companies": [
    {
      "ticker": "PGHH", "name": "P & G Hygiene",
      "sector": "Fast Moving Consumer Goods", "industry": "Personal Products",
      "marketCap": 27582, "screenerUrl": "https://www.screener.in/company/PGHH/",
      "quarter": "Q1FY27", "reportedOn": "2026-07-31",
      "archetype": "decelerating",
      "quarters": [                    // exactly 8, OLDEST FIRST; index -1 is the latest
        {
          "quarter": "Q2FY25",
          "revenue": 718.7, "operatingProfit": 120.9, "opm": 16.82,
          "netProfit": 76.3, "npm": 10.61, "eps": 2.3,
          "otherIncome": 10.8, "pbt": 103.2, "taxExpense": 26.9, "exceptionalItems": 0
        }
        // … 7 more
      ],
      "consensus": { "eps": 2.36, "revenue": 786.5 },
      "segments": [{ "name": "Home care", "revenue": 279.6, "share": 37.3 }]
    }
  ]
}
```

### Envelope

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `_provenance` | string | — | Plain-English statement of what is real and what is not. Shown verbatim nowhere; it exists so the file is self-describing on disk. |
| `generated_at` | string | ISO 8601 UTC | Generation time. **Not a filing time** — the freshness card must say so while `source` is mock. |
| `generator` | string | repo path | Named in the Sources modal. Omit on a real feed. |
| `seed` | number | — | PRNG seed. Omit on a real feed. |
| `source` | string | free text | **The honesty switch.** `js/data/earnings.js` sets `meta().isMock = source.toLowerCase().includes('mock')`. Every ribbon, badge and export banner keys off it. A real feed sets e.g. `"BSE/NSE corporate filings"` and all mock markers disappear on their own. |
| `quarter` | string | `Q<n>FY<yy>` | The season being reported, e.g. `Q1FY27` = Apr–Jun 2026. |
| `season_start` / `season_end` | string | `YYYY-MM-DD` | Range the `reportedOn` dates fall in. |
| `company_count` | number | — | Must equal `companies.length`. |

### `companies[]`

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` | string | NSE symbol | Join key against `universe.json` and `technicals.json`. Uppercased for lookup. |
| `name` / `sector` / `industry` | string | — | Real, from `universe.json`. |
| `marketCap` | number | ₹ crore | Real. Drives the Quality & Growth scatter's x-axis. |
| `screenerUrl` | string | URL | Deep link in the drill panel header. |
| `quarter` | string | `Q<n>FY<yy>` | The quarter this company just reported. |
| `reportedOn` | string | `YYYY-MM-DD` | Declaration date. Orders the Latest Results table. |
| `archetype` | string | see below | **Generator artefact.** Records which behaviour profile produced the numbers. A real feed omits it; nothing in the UI scores off it. |
| `quarters[]` | array | exactly 8 | **Oldest first.** The model reads `at(-1)` = latest, `at(-2)` = previous, `at(-5)` = year-ago. Fewer than 5 entries makes every YoY rule return `na`. |
| `consensus` | object | — | `{ eps, revenue }`. Street estimates for the latest quarter. Absent ⇒ both Surprise rules return `na`. |
| `segments[]` | array | — | `{ name, revenue, share }`. Revenue split for the latest quarter, rendered as the drill panel's share bar. Optional; the bar is skipped when absent. |

### `companies[].quarters[]`

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| `quarter` | string | `Q<n>FY<yy>` | Label for the mini-table column. |
| `revenue` | number | ₹ crore | Consolidated. |
| `operatingProfit` | number | ₹ crore | EBITDA less depreciation — the operating line. May be negative. |
| `opm` | number | percent | `operatingProfit ÷ revenue × 100`, pre-rounded to 2dp. The margin rules read this field rather than recomputing, so a real feed must supply it (or the loader must derive it). |
| `netProfit` | number | ₹ crore | PAT. Negative ⇒ `pat_yoy` hard-fails and the row carries a red flag. |
| `npm` | number | percent | `netProfit ÷ revenue × 100`, 2dp. |
| `eps` | number | ₹ per share | Reported EPS. |
| `otherIncome` | number | ₹ crore | Non-operating income. |
| `pbt` | number | ₹ crore | Profit before tax. `other_inc` and `tax_rate` return `na` when this is ≤ 0. |
| `taxExpense` | number | ₹ crore | Current + deferred. |
| `exceptionalItems` | number | ₹ crore | `0` means a clean quarter. Any non-zero value fails `exceptional`, gain or charge. |

`archetype` is one of `compounder`, `steady`, `accelerating`, `decelerating`, `cyclical`,
`pressured`, `lossmaker`, `turnaround`.

### Provenance surface

While `source` contains "mock", four things are contractually required to say so — §6 of the
brief. All four read `meta().isMock`; none needs touching when the real feed lands:

1. a persistent amber ribbon at the top of every Earnings Hub sub-view;
2. the gradient freshness card reading **"Mock data · Generated `<date>` · not a filing time"**;
3. the Sources modal listing all three earnings rows as `mock` and naming the generator script;
4. an amber banner as row 1 of **every sheet** in the Excel export.

The drill panel adds a fifth: an amber "Illustrative figures" note above the quarterly series.

### Wiring the real feed

Swapping in real filings is a **one-file change plus one path**:

1. Write the real payload to `public/data/earnings.json` in exactly the shape above, with
   `source` set to something that does not contain "mock" (e.g. `"BSE/NSE corporate filings"`),
   and drop `generator`, `seed` and `archetype`.
2. Point `EARNINGS_PATH` in `js/data/earnings.js` and the `earnings` entry in `DATA_SOURCES`
   (`js/app.js`) at the new path.
3. Flip the three `status: 'mock'` entries in `js/ui/sources.js` to `live`.

Nothing else changes: the scoring model, all three sub-views, the drill, the scans, the export
and the poller already read this shape. To poll a live endpoint instead of a file, swap
`live.mockFetcher(EARNINGS_PATH, …)` for `live.realFetcher('/api/earnings')` in `registerPoller`.

**Refresh cadence** — event-driven during results season (Jan/Apr/Jul/Oct), then idle. The
in-page poller re-reads and **re-scores** every 45s while the tab is open and visible.
**Real source** — BSE/NSE corporate filings for the reported figures; Screener.in or Trendlyne
for consensus estimates.
**Consumed by** — Earnings Hub (all three sub-views), Breakouts → Earnings Surprise.

> **Legacy adapter.** Breakouts → Earnings Surprise predates this shape and reads a flat
> one-row-per-company summary (`ticker`, `revenueCr`, `revenueYoyPct`, `netProfitCr`,
> `epsActual`, `epsEstimate`, `surprisePct`, `resultTag`, …). `adaptLegacySummary()` in
> `js/data/earnings.js` derives it, and `app.js` hands the result to `ctx.data.earnings` — so
> that view needed no changes and needs none when the real feed lands. `ctx.data.earningsRaw`
> carries the full payload. Same pattern as `js/data/universe.js`.

---

## `public/data/mock/earnings-calendar.json` — MOCK

Companies **yet to report** this season. Drives the Earnings Hub's upcoming-results strip only;
nothing is scored off it.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. Company names and tickers are real; the scheduled dates are synthetic …",
  "generated_at": "2026-08-10T10:41:45.693Z",
  "generator": "scripts/gen-mock-earnings.mjs",
  "seed": 20260810,
  "source": "Mock data",
  "from": "2026-08-11",
  "to": "2026-09-09",
  "quarter": "Q1FY27",
  "event_count": 52,
  "events": [
    {
      "ticker": "IRCTC", "name": "I R C T C", "sector": "Consumer Services",
      "marketCap": 41596, "date": "2026-08-11", "quarter": "Q1FY27", "confirmed": true
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `from` / `to` | string | `YYYY-MM-DD` | Window the events span. |
| `event_count` | number | — | Must equal `events.length`. |
| `events[].ticker` / `name` / `sector` | string | — | Real, from `universe.json`. |
| `events[].marketCap` | number | ₹ crore | Real. Orders the strip — biggest first within a day. |
| `events[].date` | string | `YYYY-MM-DD` | **Synthetic.** Board-meeting date. |
| `events[].confirmed` | boolean | — | `true` = exchange-confirmed, `false` = expected. Rendered as a dashed vs solid chip. |

The file is **optional**: `js/data/earnings.js` catches a failed fetch and falls back to
`{ events: [] }`, which hides the strip rather than breaking the tab.

**Refresh cadence** — daily during results season.
**Real source** — NSE/BSE board-meeting filings.
**Consumed by** — Earnings Hub → Latest Results (the upcoming strip).

---

## Retired: the synthetic transcript corpus

`concall-calls.json` (2.0MB of generated transcripts), `concall-keywords.json` and
`catalysts.json` are **gone**, along with `js/data/concalls.js`, the keyword engine, the keyword
editor, the Con-call Deep Dive workspace and `scripts/gen-mock-concalls.mjs`.

They powered four sub-views of the Con-call tab — Live Feed, Keyword Scan, Catalysts, Deep Dive —
on invented speech attributed to fictional speakers, because no open source publishes full
transcript text. That put a synthetic half and a live half in one tab, held apart by an amber
ribbon. The tab is now one live table off StockScans, with no schedule/status header chips and no
ribbon.

**If a real transcript feed is ever wired**, BSE's filed transcript PDFs are the source, and the
engine and workspace are recoverable from git history — pointed at real text rather than
generated text, which is the only version worth having. Their contracts are in that history too.

## `public/data/mock/chatter-valuepickr.json` — MOCK

40 forum threads, one per company. Root is an object with a metadata envelope and `threads[]`.

> **Illustrative data.** Company names, tickers and sectors are real. Every thread, post, count
> and sentiment reading is synthetic, from `scripts/gen-mock-chatter.mjs` (`SEED = 20260812`).
> **Every handle is fictional** and the thread URLs do not resolve — the same rule the con-call
> analysts follow, for the same reason: a forum handle belongs to a real person, and attaching
> invented opinions to one misattributes speech.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA … ALL HANDLES ARE FICTIONAL …",
  "generated_at": "2026-08-11T04:00:00.000Z",
  "generator": "scripts/gen-mock-chatter.mjs",
  "seed": 20260812,
  "source": "Mock data",            // the flag the UI keys every honesty marker off
  "as_of": "2026-08-11",
  "thread_count": 40,
  "threads": [
    {
      "threadId": "vp-001", "ticker": "PGHH", "name": "P & G Hygiene",
      "sector": "Fast Moving Consumer Goods",
      "title": "P & G Hygiene — what the market is missing",
      "url": "https://forum.valuepickr.com/t/p-g-hygiene/48221",
      "category": "Company analysis",
      "createdAt": "2024-03-18T12:04:00+05:30",
      "lastPostAt": "2026-08-10T19:41:00+05:30",
      "postCount": 412, "participantCount": 37,
      "posts7d": 24, "postsPrior7d": 11,
      "weeklyPosts12w": [9, 14, 7, 12, 18, 11, 6, 15, 9, 13, 11, 24],
      "sentiment": 0.42,
      "topContributors": [{ "handle": "value_ledger", "posts": 9 }],
      "recentPosts": [
        { "handle": "moat_diary", "at": "2026-08-10T19:41:00+05:30",
          "text": "Added a tracking position…", "sentiment": 0.35, "likes": 12 }
      ],
      "claims": [
        { "text": "Capacity expansion announced in the last exchange filing.",
          "kind": "fact", "at": "2026-08-02T11:12:00+05:30" }
      ]
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `threadId` | string | `vp-NNN` | Stable key; used in the URL and the drill. |
| `ticker` / `name` / `sector` | string | — | Real. `ticker` is the join key to technicals. |
| `title` / `url` / `category` | string | — | **Synthetic.** The URL does not resolve. |
| `createdAt` / `lastPostAt` | string | ISO 8601 +05:30 | `createdAt` drives "first mention" on Trending. |
| `postCount` | number | count | Lifetime posts. |
| `participantCount` | number | count | Distinct posters over the window — **reach**, which is a different question from post volume. |
| `posts7d` / `postsPrior7d` | number | count | **The raw inputs momentum is derived from.** No momentum field is stored. |
| `weeklyPosts12w` | number[] | 12 counts | Oldest first; the drill's sparkline. Last element equals `posts7d`. |
| `sentiment` | number | −1 … +1 | Thread-level mean. |
| `topContributors[]` | array | `{ handle, posts }` | **Fictional handles.** |
| `recentPosts[]` | array | `{ handle, at, text, sentiment, likes }` | **Fictional handles, invented text.** |
| `claims[]` | array | `{ text, kind, at }` | `kind` is `fact` \| `speculation` \| `question`. Kept separate in the UI: a post asserting something is not the same as one wondering about it, and flattening the three would make speculation look like research. |

**Refresh cadence** — every 15 minutes. **Real source** — a ValuePickr crawler.
**Consumed by** — Public Chatter → ValuePickr and Trending.

---

## `public/data/mock/chatter-telegram.json` — MOCK

25 public groups. Same envelope, `groups[]`.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA … ALL HANDLES AND GROUP NAMES ARE FICTIONAL …",
  "generated_at": "2026-08-11T04:00:00.000Z",
  "generator": "scripts/gen-mock-chatter.mjs",
  "seed": 20260812,
  "source": "Mock data",
  "group_count": 25,
  "groups": [
    {
      "groupId": "tg-001", "name": "Momentum Signals", "memberCount": 41200,
      "ticker": "ULTRACEMCO", "companyName": "UltraTech Cem.", "sector": "Construction Materials",
      "messages24h": 723, "messagesPrior24h": 189,
      "uniqueSenders24h": 8, "sentiment": 0.71, "forwardRatio": 0.76,
      "profile": "pumpy",
      "recentMessages": [
        { "handle": "swing_desk", "at": "2026-08-11T14:02:00+05:30",
          "text": "Breakout on the daily…", "sentiment": 0.68 }
      ]
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `groupId` | string | `tg-NNN` | Stable key. |
| `name` | string | — | **Fictional group name.** |
| `memberCount` | number | count | |
| `ticker` / `companyName` / `sector` | string | — | Real company. |
| `messages24h` / `messagesPrior24h` | number | count | Volume and the prior day, for the spike ratio. |
| `uniqueSenders24h` | number | count | **Load-bearing.** Volume ÷ senders is what separates a discussion from a wall. |
| `forwardRatio` | number | 0 … 1 | Share of messages that are forwards rather than original posts. |
| `sentiment` | number | −1 … +1 | Mean across the window. |
| `profile` | string | see below | **Generator artefact** — which shape the group was built to have, kept so a reviewer can see whether the flag agrees. A real feed omits it, and nothing scores off it. |
| `recentMessages[]` | array | `{ handle, at, text, sentiment }` | **Fictional handles.** |

`profile` is one of `pumpy`, `borderline`, `normal`, `quiet`. Borderline groups exist on purpose:
a heuristic that only ever returns 0 or 3 is recognising two hand-built clusters, not
discriminating. The shipped set spans all four risk levels.

### The pump-risk heuristic — `js/chatter/pump-risk.js`

**No risk level is stored in the file.** It is computed at render time from the fields above, and
recomputed on every live tick, because another burst can tip a group over.

A group must first clear a **volume gate**: at least `MIN_MESSAGES_24H` (120) messages in 24h
*and* at least `MIN_VOLUME_SPIKE` (1.8×) the previous day. Without the gate the level is 0
whatever the other ratios say — sender ratios on a quiet group are noise.

Past the gate, each of three signals adds one level:

| Signal | Threshold | What it means |
| --- | --- | --- |
| Few senders, many messages | ≥ 12 messages per distinct sender | Real discussion converges near 2–4 per person. |
| Mostly forwarded | ≥ 50% forwards | Circulated, not written. |
| Uniformly bullish | mean sentiment ≥ +0.55 | Genuine discussion contains disagreement. |

`pumpRisk(group)` returns `{ level, label, gate, reasons[], firedCount, msgsPerSender, spike }`.
`reasons` carries **every** criterion, fired or not, with its measured value — the UI is required
to show them, because a risk number nobody can check is just a verdict. Thresholds are exported
as `THRESHOLDS` so the help modal quotes the same constants the code uses.

It is a **heuristic, not a finding**: it says a posting pattern is consistent with coordination,
never that a pump is happening.

**Refresh cadence** — near real-time. **Real source** — Telegram Bot API over subscribed groups.
**Consumed by** — Public Chatter → Telegram and Trending.

### The chatter live tick

`js/data/chatter.js` registers an 8s poller. Like the con-call ticker it does **not** re-fetch
either file: it picks the busiest threads and groups, increments their counters, recomputes
momentum and pump risk, and returns `{ at, events[], total }`. `live.mockFetcher` would
re-download both files every tick and jitter their numbers — and a jittered post count sitting
beside the quoted post text would simply disagree with it.

---

## `public/data/institution-holdings.json` — REAL, and TWO DIFFERENT DISCLOSURES

Fund holdings, from two sources that measure opposite things. Every entry carries a `disclosure`
tag, and **every consumer must branch on it before writing a heading.**

| `disclosure` | Written by | Who discloses | The percentage means | The ₹ value is |
| --- | --- | --- | --- | --- |
| `shareholding` | `scripts/scrape-institution-holdings.mjs` (Trendlyne) | the **company**, quarterly | how much **of the company** the fund owns | Trendlyne's **derivation** (pct × mcap) |
| `portfolio` | `scripts/import-amc-portfolio.mjs` (AMC workbook) | the **fund**, monthly | **% to NAV** — how much **of the fund** is in the company | the AMC's **own published** figure |

A 2.5 under one is a large stake in a business; a 2.5 under the other is a small slice of a fund.
They are never summed, averaged or ranked against each other, and there is no combined-book figure
anywhere on the Institutions view. A shareholding filing only names holders **above 1%**, so that
list is the fund's large positions; an AMC portfolio lists **everything**, down to 0.01%.

What the two DO share is a shape — a series of percentages over time — so `js/data/institution-
holdings.js` aliases both into one vocabulary (`periods`, `periodLabels`, `periodNoun`,
`pctByPeriod`, `pct`) and the view lays them out with one set of components. The shared names
describe the shape; `disclosure` is what says what they measure.

`quarterlySummary()` is that branching rule made executable for the Institutions cross-book view:
it reads only `disclosure: 'shareholding'` books, compares each book's two latest quarters, and
groups the same six move categories used by Superstar Investors. `quarterlyCompany(key)` returns
the full set behind a clicked company, including unchanged and filing-awaited rows. New and
no-longer-disclosed positions carry no invented delta, `Filing Awaited` is not classified as an
exit, and Trendlyne's current value is never presented as a traded amount. Monthly AMC portfolio
weights are absent from both functions by construction.

### `disclosure: 'shareholding'` — filed with the exchanges

```jsonc
{
  "source": "Trendlyne — Superstar Shareholders (…)",
  "generator": "scripts/scrape-institution-holdings.mjs",
  "generated_at": "2026-08-12T…Z",
  "quarter": "Q1FY27", "quarterLabel": "Jun 2026",
  "institutions": [{
    "investorId": "smallcap-world-fund-inc",
    "name": "Smallcap World Fund Inc", "house": "Capital Group", "category": "FII",
    "trendlyneId": 54015,
    "sourceUrl": "https://trendlyne.com/portfolio/superstar-shareholders/54015/latest/…/",
    "latestQuarter": "Q1FY27", "latestQuarterLabel": "Jun 2026",
    "quarters":      ["Q1FY27", "Q4FY26", … 9 deep],
    "quarterLabels": ["Jun 2026", "Mar 2026", …],
    "stocksHeld": 37,            // holdings carrying a value — the portfolio
    "portfolioValueCr": 35818,   // their sum; cross-checked against Trendlyne's own figure
    "filedThisQuarter": 36,      // how many have actually filed for Jun 2026
    "awaitingFiling": ["JBCHEPHARM"],
    "holdings": [{
      "ticker": "AEGISLOG", "name": "Aegis Logistics",
      "sector": "Oil, Gas & Consumable Fuels", "industry": "Trading - Gas", "inUniverse": true,
      "qty": 8732412,            // FILED
      "holdingPct": 2.5,         // FILED — null where the company has not filed this quarter
      "valueCr": 1104.2,         // TRENDLYNE'S DERIVATION, not ours
      "changePp": 0.2,           // Trendlyne's published change for the quarter
      "changeNote": null,        // their label where no number applies — see below
      "pctDelta": 0.2,           // ours: this quarter's filed % minus last quarter's
      "pctByQuarter": { "Q1FY27": 2.5, "Q4FY26": 2.3, … },
      "url": "https://trendlyne.com/equity/share-holding/35/AEGISLOG/latest/…/"
    }],
    "former": [ … same shape, companies with history but no current position … ]
  }]
}
```

### Which numbers are filings, and which one is not

A shareholding filing discloses a **share count and a percentage of the company**. It never
discloses a rupee amount. So `qty` and `holdingPct` are the filing itself; `valueCr` is
**Trendlyne's derivation** — holding % × market cap — reproduced unchanged and labelled as theirs
on every surface it reaches, including the column header (`Value (Trendlyne)`), the stat card, the
drill's Provenance group and row 1 of the exported sheet. The same rule as the StockScans con-call
scores: reproduce, attribute, never re-derive.

`pctDelta` **is** ours, and it is only the difference between two filed percentages — never a
stand-in for `changePp`. On the Jun 2026 pull the two agree on every row, which is a useful check
that the history columns are being read in the right order.

### A blank percentage means NOT FILED, not sold

Companies file within weeks of a quarter closing, and not all at once. A holding can carry a share
count and a value while its percentage for the newest quarter is still outstanding — Trendlyne
label that row **Filing Awaited**, and one of the 37 Jun-2026 holdings is in exactly that state.
`holdingPct: null` renders as *not filed yet*; a zero there would report a live position as exited.

`changeNote` carries their label wherever a number does not apply. Three seen in the wild:
**New**, **Below 1% first time**, **Filing Awaited**. A filing only names holders above 1%, so
crossing that line in either direction is a disclosure event, not necessarily a trade.

### The run fails rather than shipping a wrong total

Trendlyne state the holding count and the portfolio value in prose on the page. The scraper
computes both from the rows it parsed and **refuses to write the file if they disagree** — the
parse dropping or double-counting a row is the failure mode that would otherwise look like a
clean run. They agree to the rupee on the Jun 2026 pull: 37 holdings, ₹35,818.0 Cr.

Two traps the parser is built around, both of which produce a *plausible* wrong answer:

- **Balance the `<table>` tags.** Each row has an expandable child table, so cutting at the first
  `</table>` yields three rows out of seventy-two and looks like it worked. Check the row count.
- **Key on the per-row equity link, not the visible name.** The child rows repeat the same figures
  shifted by one column and would double every holding; the link is also where the NSE ticker
  comes from, which the truncated display name cannot give.

### Adding a fund

One entry in `FUNDS` in `scripts/scrape-institution-holdings.mjs` — the `id` and `slug` come
straight out of the Trendlyne URL — then re-run it. No UI change: the Institutions view renders a
fund picker as soon as there is more than one.

### `disclosure: 'portfolio'` — the AMC's own monthly book

```jsonc
{
  "investorId": "bandhan-small-cap-fund",
  "name": "Bandhan Small Cap Fund", "house": "Bandhan Mutual Fund", "category": "Equity : Small Cap",
  "disclosure": "portfolio",
  "source": "Bandhan Mutual Fund — monthly portfolio disclosure",
  "sourceFile": "scripts/fixtures/bandhan-small-cap-fund.xlsx",
  "generator": "scripts/import-amc-portfolio.mjs",
  "periods":      ["2026-07", "2026-06", … 7 deep],
  "periodLabels": ["Jul 26", "Jun 26", …],
  "periodNoun": "month",
  "latestPeriod": "2026-07", "latestPeriodLabel": "Jul 26",
  "statedAumCr": 28019,           // the AMC's own summary line — NOT the sum below
  "navAsOf": "03-Aug-2026",
  "summaryLine": "AUM ₹28,019 Cr   ·   NAV as of 03-Aug-2026   ·   …",
  "assetMix": [{ "label": "Equity", "pct": 88.4 }, … ],
  "stocksHeld": 258,              // lines held in the latest month
  "equityCount": 255,             // the rest are gold / debt lines
  "resolvedCount": 218,           // lines we could match to an NSE symbol
  "reboughtCount": 4,             // companies re-entered after an exit in this window
  "portfolioValueCr": 28016.99,   // the sum of the AMC's own position values
  "valuedCount": 258,
  "holdings": [{
    "name": "REC Limited",        // AMC DISCLOSED
    "ticker": "RECLTD",           // OURS — resolved, and nullable; see below
    "resolvedBy": "moneycontrol", // which feed matched it, or "checked by hand"
    "unresolvedReason": null,     // why there is no ticker, when there is none
    "assetClass": "Equity",       // AMC DISCLOSED
    "industry": "Finance",        // AMC DISCLOSED
    "weightPct": 3.03,            // AMC DISCLOSED — % TO NAV, not % of the company
    "valueCr": 942.49,            // AMC DISCLOSED — a portfolio disclosure DOES state a value
    "changePp": -0.16,            // OURS — this month's weight minus last month's
    "changeNote": null,           // "New" where there is no previous month to subtract
    "spells": 1,                  // how many separate lines were folded into this row
    "pctByPeriod":   { "2026-07": 3.03, "2026-06": 3.19, … },
    "valueByPeriod": { "2026-07": 942.49, "2026-06": 908.73, … }
  }],
  "former": [ … same shape, lines in the history but out of the book this month … ]
}
```

**The totals do not tie to `statedAumCr`, and that is correct.** The 258 held lines sum to
₹28,017 Cr and to 88.4% of NAV — the rest is cash, which the disclosure reports as an asset-mix
line rather than a holding. `statedAumCr` is the AMC's own headline figure and is carried verbatim
rather than reconciled; the implied NAV from `valueCr ÷ weightPct` is a third number again. Nothing
here computes one from another.

**A blank month means the fund did not hold the line**, never a weight of zero — the same rule as
everywhere else in this dashboard. Lines with no weight in the latest month move to `former` and
are not listed in the table.

**One company can arrive on several lines.** The export starts a new line each time the fund exits
a position and later buys it back — Angel One is on two lines in both funds. Those lines are
**disjoint in time**, so they are folded into one row and `spells` records how many; a pair whose
months **overlapped** would have to be summed or chosen between, so the importer refuses to merge
those, keeps them apart and prints them at the end of the run.

**The ticker is ours and is nullable.** The disclosure names instruments the way the AMC writes
them, so a symbol is resolved by `scripts/lib/company-index.mjs` from `mc-ticker-map.json`,
`technicals.json` and the book. 37 of the Small Cap fund's 255 equity lines do not resolve; they
keep their row with an `unresolvedReason` and are simply absent under the Portfolio scope, which
joins on ticker. A wrong symbol would hand one company another's weights, so a name that fits two
companies equally well is left unresolved rather than guessed.

The matcher is token-wise, because Moneycontrol truncate names at about sixteen characters
("Prestige Estate") and Screener abbreviate them ("Grasim Inds"). Each index token must prefix the
query token in the same position, or be a tight abbreviation of it. An index name with **fewer**
tokens than the query needs evidence that it was truncated — otherwise "Arvind" would match
"Arvind Fashions Limited", which is a different listed company. Names no rule should reach live in
`CONFIRMED` in the importer, checked by hand.

### Adding an AMC fund

Drop the workbook in `scripts/fixtures/`, add one entry to `FUNDS` in
`scripts/import-amc-portfolio.mjs`, and re-run it. It merges into the JSON without touching the
Trendlyne funds, which are scraped on their own schedule. A new month is the same: replace the
workbook, re-run. The workbooks are committed so the import reproduces from the same bytes.

`scripts/lib/xlsx-read.mjs` reads them with nothing but the Node standard library — an .xlsx is a
ZIP of XML, both of which `node:zlib` and a tag scanner already handle. This repo has no
`package.json` and a one-off data import is not the thing that should introduce one.

---

## SentimentDash — LIVE, retail chatter, called STRAIGHT FROM THE BROWSER

Companies and topics trending across ValuePickr, TradingQnA and Google News over a rolling 30 days,
ranked by mention count and keyword-scored for sentiment. Public, unauthenticated, CORS-open.
Re-scraped twice daily at **01:30 and 13:30 UTC**, so polling faster than hourly asks a question
whose answer cannot have changed.

`GET {base}/dashboard?limit=all` + `GET {base}/health`, where `base` is
`window.SATTVA_CHATTER_URL` in `public/index.html`, overridable with
`localStorage['sattva:chatter-base']`. Consumed by `js/data/chatter-live.js`.

### THERE IS NO `/api/chatter`, AND THERE CANNOT BE

This upstream *was* proxied through our Worker, like every other one, for the same two reasons: one
fetch per cache window instead of one per reader, and somewhere to name a failure. That route was
written, deployed, and **returned 404 in production while `curl` returned 200 from the identical
URL**.

The cause is a platform rule, not our code. The upstream is another Cloudflare Worker on the *same
account*, and **Cloudflare refuses a subrequest from one Worker to another Worker's
`*.workers.dev` hostname within one zone** — error 1042, *"Worker tried to fetch from another
Worker on the same zone, which is not allowed"* — surfacing it as a **404**, which is
indistinguishable from the route being absent. That is exactly how it was first misdiagnosed: the
tab said "check that the API is deployed", and the API was deployed and healthy the whole time.

Two pieces of evidence pin it, and the second is the one that settles it:

- **The natural experiment already in the routes.** Every other upstream is off-zone —
  moneycontrol.com, stockscans.in, devde.muns.io — and every one works. The only `*.workers.dev`
  upstream was the only failure.
- **`wrangler dev` succeeds where the deployment fails.** The identical code, the identical
  `SENTIMENT_BASE`, the identical URL: run locally it returned `ok: true` with all 219 entries;
  deployed to the edge it returned `not-found`. That rules out URL construction, a wrong variable
  and the upstream itself — everything except where the request is made from. Run that comparison
  first the next time an upstream behaves differently in production.

If it ever *must* be proxied (to hold a credential, say), the supported options are a Cloudflare
**service binding** (`"services"` in `wrangler.jsonc`) or giving that Worker a **custom domain** so
it leaves the workers.dev zone. Another `fetch()` will not work, whatever the URL.

**Nothing was lost by moving it to the browser**, which is why this is the fix rather than a
retreat. Verified against the live endpoint with `curl -D-`:

| Header | Value |
| --- | --- |
| `access-control-allow-origin` | `*` |
| `access-control-allow-headers` | `Content-Type, If-None-Match` |
| `access-control-expose-headers` | `ETag, X-Data-Generated-At` |
| `cache-control` | `public, max-age=60, stale-while-revalidate=300` |

So `conditionalJson` revalidates against **their** ETag exactly as it did against ours — a repeat
fetch answers **304 with no body** — and the device store still means a return visit costs headers.
Their own `max-age` does the politeness work the edge cache was there for, over data that moves
twice a day. A side-benefit: Public Chatter is now the one live feed that works when the site is
served as **plain static files**, with no Worker at all.

The UI does not render these aggregate facts as a KPI strip. Coverage, total posts and source
split, market mood and scrape timing are printed as one footnote beneath the active in-page tab.
Coverage is the default; Not in coverage replaces it with the unresolved-entry table.

### Four traps, and what this repo does about each

1. **`changePct` is a change in MENTION COUNT, not a price move.** There is no price, market cap
   or return anywhere in that API. It is renamed `mentionsChangePct` in `normaliseEntry`, and no
   field called `changePct` survives onto our entry — so nothing downstream can render it as a
   return by reading the field name. It must never be coloured like a P&L or given a ₹.
2. **Their `ticker` is a forum-topic slug, not an exchange symbol** — `zomato`, `fiis`,
   `3b-blackbio-dx` — and their `exchange` / `sector` are empty strings on essentially every
   entry. It travels as `slug`. Our `ticker` is null unless the resolver found a real NSE symbol.
3. **About a third of entries are not companies.** Entries are discovered bottom-up from forum
   topics, so the list carries brokers (`guggenheim`, `td-cowen`), themes (`nuclear-energy`,
   `defence`) and bare words (`value`, `growth`, `income`). In one of their runs the "top mover"
   was a broker and the "most bullish" was the word *Growth*. `overview.mostBullish` and
   `overview.topMover` are reproduced under their own names, and any surface showing them has to
   survive that or not show them.
4. **Sentiment skews ~80% neutral** (14% bullish, 6% bearish) and is keyword-scored, not
   model-scored. A design assuming a balanced bull/bear split will look broken. `reddit` is a
   valid source key that is currently 0 everywhere — it stays in the vocabulary because their
   schema has it.

Also: `sparkline` is a per-**run** series (up to 12 points, oldest first), not a per-day one. Points
are scrape runs, so nothing may put a time axis under it.

### The resolver — how "is this a company?" is decided

`buildResolverIndex()` + `resolveEntry()` in `sentiment-shared.js`. An entry is a company **when
its slug or name resolves to a symbol we already cover** — `universe.json` or the book. Everything
else is not rejected: it carries `ticker: null` and a stated reason, exactly as a book line with no
NSE symbol does in `coverage.js`.

Deliberately **not** a hand-kept list of brokers and themes to exclude — such a list is
unfalsifiable, rots silently, and makes the answer depend on what someone remembered to type.

Matching is **exact only**, unlike `resolve-portfolio-companies.mjs`, which prefix-matches. The
book is 142 lines checked by hand against a statement; this is an open-ended stream of forum topics
where `value`, `growth` and `defence` are real entries. A wrong symbol here does not fail loudly —
it files someone else's forum posts under a company you hold. An unresolved entry costs a row in
the second section; a mis-resolved one corrupts the first.

Verified against the real `universe.json` + book: `tata-motors`→`TMCV`, `hind-aeronautics`→`HAL`,
`infosys`→`INFY`, `crizac`→`CRIZAC`, `allcargo-logistics`→`ALLCARGO`, while `guggenheim`,
`td-cowen`, `nuclear-energy`, `defence`, `value`, `growth` and `fiis` all correctly resolve to
nothing.

### Response

```jsonc
{
  "ok": true, "reason": null,
  "generatedAt": "2026-08-13T14:35:02.862Z", "window": "30d",
  "overview": { "totalPosts": 603, "totalEntries": 219, "marketMood": { … },
                "mostBullish": { … }, "topMover": { … }, "sourceTotals": { … } },
  "total": 219,
  "entries": [ { "slug": "fiis", "name": "FIIs", "rank": 1, "mentions": 22,
                 "mentionsPrev": 21, "mentionsChangePct": 4.8, "direction": "up",
                 "sentiment": { … }, "sources": { … }, "activeSources": [ … ],
                 "sourceLabel": "Google News · TradingQnA", "sparkline": [ … ] } ],
  "health": { "status": "ok", "ageSeconds": 4211 }
}
```

`health.ageSeconds` is **their** figure, from their `/health` route — how stale the scrape is
according to the only clock that is authoritative about it, rather than a subtraction between
their `generatedAt` and ours.

### Failure is reported by kind, and a failed read is never an empty one

`entries: []` only ever travels with `ok: false` and a `reason`, and the tab renders a named panel
rather than an empty table.

| `reason` | Means | What to do |
| --- | --- | --- |
| `no-url` | no base configured | set `window.SATTVA_CHATTER_URL` in `public/index.html` |
| `not-found` | 404 from the host | check the base ends in `/v1` — **and see the 1042 note above if the caller is a Worker** |
| `unreachable` | the request never completed — DNS, offline, or a refused CORS preflight | wait; the poll retries |
| `upstream` | it answered with an error status | wait; the poll retries |
| `shape` | answered, but not in the documented shape | their contract changed |

The `not-found` wording is the one that had to be rewritten. It used to read *"check that it ends
in /v1 and that the API is deployed"*, which pointed at the one thing that was fine. **A named
state that names the wrong thing is worse than an unnamed one.**

### Verifying without egress — `scripts/stub-chatter.mjs`

Because the browser calls this feed directly, a verification run would otherwise depend on the
machine's outbound network and would hit somebody else's API on every execution. So:

```bash
node scripts/stub-chatter.mjs 8903 &
CHATTER_STUB=http://127.0.0.1:8903/v1 node scripts/verify-ui.mjs
```

It replays `scripts/fixtures/chatter-dashboard.json` — a **verbatim capture** of
`/v1/dashboard?limit=all`, 219 real entries — with the live API's exact header set, so the
conditional-fetch path is exercised for real rather than stubbed out. It also nests `ageSeconds`
under `data` the way the real API does, so *that* bug cannot come back unnoticed.

### What the tab does with it

One view, two sections, `subviews: []`. **Covered companies** — the resolved half, scope-aware,
rows opening the technicals drill. **Not in our coverage** — everything else, whole in both scopes,
because a list with no tickers cannot be filtered by one.

Measured on a real 219-entry run: **45 covered, 174 not, 8 of them in the book.**

The synthetic corpus this tab used to render is deleted, not parked under a ribbon — the same
resolution the Con-call tab reached. Gone with it:

- **The Telegram sub-view**, because no live Telegram source exists.
- **The pump-risk heuristic**, because its gate is `MIN_MESSAGES_24H = 120` and this feed carries
  ~600 posts per scrape across 219 entries — the busiest entry in a real run had 22 mentions in
  *thirty days*. Every row would score "Clear", which is not a clean bill of health but a
  fabricated one. `pump-risk.js`, `chatter.js`, `gen-mock-chatter.mjs` and the two mock JSON files
  are in git history at `ce2aa18..`.

**Alerts fire only for book holdings, and only on first appearance.** The other two feeds announce
every arrival; chatter would otherwise fill the stack with brokers and themes and train the reader
to dismiss the component, results alerts included. The alert text carries the mention count and
their sentiment word, never `mentionsChangePct` — a percentage in a one-line notification is
exactly where it would be read as a price move.

---

## News, Corporate Announcements and Insider Trades — LIVE, behind a credential

Three feeds and company search from the Muns API, behind Worker routes. All need
`Authorization: Bearer …`, so all are proxied — the token lives in `env.MUNS_TOKEN` and never
reaches the browser, exactly as the Finology feed does on the same host.

| Route | Upstream | Cache | Window |
| --- | --- | --- | --- |
| `GET /api/news?q=&from=&to=&country=` | `POST fastapi.muns.io/tools/news-search` | 180s | 30 days |
| `GET /api/announcements/{ticker}?from=&to=` | `GET devde.muns.io/filings/corp/announcements/{ticker}` | 900s | 365 days |
| `GET /api/insider-trades/{ticker}?from=&to=` | `POST devde.muns.io/filings/data/insider_trades` | 900s | 365 days |
| `GET /api/stock-search?q=` | `POST birdnest.muns.io/stock/search` | 300s | Query body fixes `user_index` at `124` |

On Insider Trades, the toolbar count is a count of **trade-disclosure rows**, not companies: one
company can contribute many rows. It therefore reads *"1,295 of 1,295 trades shown"*. Company
coverage is reported separately in the scope/provenance text, so a Portfolio view never implies
that the portfolio contains 1,295 companies.

The upstream insider table currently carries a `Source` label but no filing id or document URL.
The UI does not repeat those provider names or render a dead `#` arrow. Its single **Source** cell
prefers an explicit HTTP(S) URL whenever one arrives; otherwise it opens Trendlyne's public
insider-disclosure results filtered by that row's exact insider/person name. The export follows the
same rule and writes the URL, not the provider label.

**Modules** — `worker/muns.mjs` (clients) · `public/js/data/filings-shared.js` (pure parsers, shared
with the Worker) · `public/js/data/filings.js` (browser feed) · `public/js/tabs/filings-tab.js` (the
one renderer) · `scripts/scrape-filings.mjs` (the scheduled walk).

### The shapes, now observed

Wired blind (no working token locally), then corrected against the deployed Worker's own responses.
Two things the written contract did not say, and both broke a whole tab:

**Announcements is an array of GROUPS, not of records.**

```jsonc
[ { "source": "BSE",  "data": [ { "symbol": "500325", "title": "…", "desc": "…",
                                  "date": "2026-08-13T19:40:26.91",
                                  "attachment": "https://www.bseindia.com/…pdf" } ] },
  { "source": "NSE",  "data": [ … ] },
  { "source": "DRHP", "data": [ … ] } ]
```

`collectRecords` returned those two wrappers *as* the records, so the tab rendered one row per
exchange reading "(no subject)" with no date — **a table that looked populated and contained
nothing**, which is worse than an empty one. It now descends into a nested array under a known key
when the wrapper has no more than a couple of fields beside it, and carries `source` down onto every
record. RELIANCE went from 1 empty row to 38 complete ones. The PDF is under `attachment`.

**News nests the outlet and dates it under `page_age`.**

```jsonc
{ "title": "…", "url": "…", "description": "…",
  "age": "2 days ago", "page_age": "2026-08-12T20:56:32",
  "profile": { "name": "The Economic Times", "url": "…" } }
```

There is no flat publisher field at all, so a top-level lookup found nothing and every row read as
sourceless and undated. `profile.name` is the outlet; `page_age` is the timestamp. **`age` is tried
last on purpose** — "2 days ago" parses to nothing, so it can only ever confirm there is no date
rather than invent one.

**News is searched by COMPANY NAME, and the URL has to be built as a URL.**

The browser sent `api/news?q=RELIANCE` and then appended a date range built as one string with a
`?` patched onto the front of it — right for the two path-parameter routes, wrong for this one. The
result carried **two question marks**, which parses without complaint into

```
q    = "RELIANCE?from=2026-07-18"     ← the search term the upstream actually received
to   = "2026-08-17"
from = absent
```

so every company was searched for as that literal string, the date filter was silently dropped, and
the tab filled with the same generic market news for all forty of them — a CSIR-NET exam story
filed under JAYNECOIND, the same headline repeating down the page. **It returned HTTP 200 the whole
time.** Each route now appends its own range, because only the route knows whether it already has a
query string.

And the term itself matters. Measured on one book line:

| Query | Results | What they were |
| --- | --- | --- |
| `JAYNECOIND` | 3 | mostly price-quote widgets |
| `Jayaswal Neco Industries` | 20 | the company's own news |
| `Jayaswal Neco Industries share price results` | 20 | ranked an unrelated IPO story second |

So the query is the **company name, with nothing appended** — the extra words are themselves terms
the engine ranks on. `scripts/scrape-filings.mjs` and the browser walk send the same query, so the
snapshot and the live walk cannot disagree about what a company's news is. The name travels with
the ticker into `feed.load([{ ticker, name }])`; the ticker is still what a row is filed under and
what the device cache is keyed by.

**Duplicate stories are dropped within a company, never across companies.** The comparison is the
canonical URL — host without its `www.`/`m.`/`amp.` prefix, path without a trailing `/amp`, because
`moneycontrol.com/news/…-13990522.html` and `…/amp` are one article — plus, separately, an exact
match on publisher *and* headline. It does **not** merge two publishers running the same story
(Hindustan Times and the Economic Times both ran "Prestige Group launches 3 housing projects in
Q1" — two outlets reporting, not one row twice), and it does not merge across companies: a story
that genuinely mentions two companies in scope appears under each, because the ticker a row is
filed under is our search term, which the provenance modal says in those words. Measured over 741
rows: six headlines repeated, every one of them under two different tickers.

**And the duplication the reader saw was not in the data at all.** 741 rows carried zero repeated
(ticker, headline) pairs while **160** pairs repeated on screen — the same headline two and three
times, others missing, and the row count still exactly right. `scoreTable` caches a row's markup by
its key and moves the existing `<tr>` nodes on a repaint, which is correct only while a key
identifies a row; the key was `` `${ticker}-${date}-${i}` `` on a table that grows as the walk
lands, so every arrival shifted the indices and a cached row was moved under a key that now meant a
different article. Row keys here are content-derived, and `verify-ui.mjs` **compares** the rendered
rows against the feed's rather than counting them.

**Insider trades was right first time.** Fifteen columns, straight off the markdown table:
`Company, Insider, Category, Security Type, Transaction, Trade Shares, Trade %, Trade Value,
Post Holding Shares, Post Holding %, Mode, From Date, To Date, Broadcast Date, Source`. Rows that
look duplicated in the visible columns are genuinely distinct filings — same day, same size,
different insider, sometimes the opposite direction — which is why nothing here dedupes them.

**Insider responses now add to retained disclosures.** The supplied
`POST https://devde.muns.io/filings/data/insider_trades` source is already the feed's upstream;
it is called once per company, with `country: india` and explicit `fromDate` / `toDate` filters
to avoid the unfiltered India path's 100-record cap. No second copy of the same source is fetched.
The client also supports `country: USA` for Finviz, but this dashboard's universe remains Indian.

Scheduled captures and browser refreshes share `public/js/data/insider-history.js`. A successful
empty or smaller response adds what it returned without deleting earlier events inside the
365-day window. A narrower capture retains previously covered companies; failed/unreached
companies retain their prior capture timestamps through the existing fallback metadata. The
news collapse guard does not discard a partial insider capture, and `FILINGS_FORCE` does not
disable insider retention. Readable dates outside the requested window expire; undated rows stay.

Overlap is matched using every row field except the redundant `raw` copy, with object keys sorted
for comparison. Source labels, insider names, direction, quantities and document URLs all remain
part of the match. The merge keeps the greatest observed multiplicity of identical rows, so
repeated responses do not inflate counts and identical rows already present in one response are
not collapsed. Without a stable filing ID, a corrected record is retained as a distinct variant.
Headings are unioned in source order so columns from earlier responses remain visible/exportable.

Browser history uses `insider-history:{ticker}` separately from the exact HTTP payload and ETag
under `filings:insider:{ticker}`. Reloading after an empty or failed response therefore keeps prior
live additions without assigning their merged bytes the upstream response's validator. Cache-write
time is not used as a server confirmation. The UI's capture/check times describe when the source
was queried, not a guarantee that every retained row was returned again. News and announcements
keep their existing replacement semantics. `node scripts/verify-insider-trades.mjs` exercises the
request contract, overlap handling, retention boundary, snapshot/live merges and device history.

### THE PARSING STAYS LOOSE ANYWAY

None of the three could be probed when they were wired: the only token available locally was a
ten-character placeholder and all three answer 401/403 without a real one. The written contract
gives field *names* for almost nothing — announcements is documented as "results grouped by source"
and insider trades as "returns markdown table string".

So nothing reads a guessed field name directly. `filings-shared.js` tries a list of candidate keys
per field, keeps the untouched record beside the normalised one, and leaves anything it cannot find
as `null` — which renders as an em dash saying the source did not carry it. **A date that will not
parse stays blank and sorts last**; it is never given today's.

**Insider trades is markdown, not JSON.** Its columns are unknown until a response arrives, so the
table is built from `headers` at render time, in the source's order, under the source's headings.
Nothing is renamed. Nothing is summed — a quantity written `1,20,000 (pledged)` is not a number.

### Market news: the Universe half of the News tab

**FIVE PUBLISHERS, ONE LIST, AND EVERY ROW SAYS WHOSE REPORTING IT IS.** Moneycontrol's listing page
plus Business Standard, Mint, Economic Times and Investing.com read from their own RSS. An
unattributed headline in a mixed feed attributes itself to whichever masthead the reader assumes, so
the byline leads every card, the export carries a Publisher column, and the provenance panel names
each publisher with when it was last read and whether that read worked.

**IT IS A CAPTURE, NOT A LIVE ROUTE, AND THAT IS FORCED RATHER THAN CHOSEN.** Three of the five
refuse a server by TLS fingerprint rather than by headers. Measured with node's `fetch` — which is
what a Cloudflare Worker uses — against `curl` with a browser user-agent:

| publisher | curl | node `fetch` / Worker |
| --- | --- | --- |
| Business Standard | 200 | **200**, 190 KB, 98 items |
| Investing.com | 200 | **200**, 4.8 KB, 10 items |
| Mint | 200 | **403, 24-byte body** |
| Economic Times | 200 | **403, 24-byte body** |
| Moneycontrol (listing page) | 200, 598 KB | **403, 24-byte body** |

That 24-byte 403 is byte-for-byte identical across the three, so no header set fixes it and there is
no proxy route to build. A scheduled Action on a normal runner reads all five with `curl`.

**RSS IS A TRAP ONLY IF YOU DO NOT CHECK.** `moneycontrol.com/rss/*.xml` answer 200 with well-formed
`<item>` blocks whose newest entry is from **April 2024** — which is why that publisher is read from
its listing page. The rule is not "RSS is dead", it is **a 200 with valid XML is not evidence a feed
is live, so read the newest item's date**. All twelve feeds in `worker/rss-news.mjs` were checked
that way on 2026-09-03 at 17:07 IST and every one carried an item from that same day. Re-run that
check before adding a feed, and drop one whose newest item has gone stale.

**NOTHING IS EVER DISCARDED — the capture is a bounded HEAD plus a shard per MONTH.** It used to be
one file trimmed to 600 stories, so every run deleted whatever had fallen past the six-hundredth:
about thirteen days of history, gone for good, and unrecoverable because a publisher's own feed only
reaches back so far. On screen that was a scroll that stopped, and "600 of 600 stories" is every
story we *held*, not every story there was. The cap was a ceiling on bytes pointed at the wrong file.

```
public/data/market-news.json          the HEAD — the only file a visitor downloads on arrival
{
  "capturedAt": "2026-09-03T…Z",   // when ANY publisher was last read
  "sources": [ {                   // per publisher, so an outage is never inferred from a count
    "id": "mint", "publisher": "Mint", "feeds": 3, "feedsOk": 3,
    "capturedAt": "2026-09-03T…Z", "ok": true, "stories": 105
    // "reason": "blocked"         // present only when a read failed
  } ],
  "newestId": "14021956",          // the newest MONEYCONTROL id — what their top-up walk stops at.
                                   // Not the newest story overall, which is usually somebody else's
                                   // and would stop that walk immediately.
  "articleCount": 600, "keep": 600,   // the head
  "archivedCount": 1033,              // head + archive: what the reader is scrolling through
  "archive": [ {                      // newest month first; the browser walks this to scroll back
    "month": "2026-08", "file": "market-news/2026-08.json",
    "count": 491,                     // stories in that shard
    "inHead": 65,                     // how many the head already carries — see below
    "from": "2026-08-21T…Z", "to": "2026-08-31T…Z"
  } ],
  "withPublishedAt": 573,          // carry their PUBLISHER'S time
  "withoutPublishedAt": 27,        // the card reads "time not published" — never `firstSeenAt`
  "listingRequests": 25, "stoppedAtKnown": false,   // Moneycontrol walk only
  "articles": [ {
    "id": "14021956",              // Moneycontrol: their bare article number
                                   // everyone else: "<feed-id>:<url without scheme>"
    "url": "https://www.moneycontrol.com/news/business/markets/…-14021956.html",
    "title": "…",  "summary": "…",  "image": "…",
    "publisher": "Moneycontrol",   // named on every row; the byline leads the card
    "section": "markets",          // OURS, not theirs — which of a publisher's feed URLs it
                                   // arrived on, never a tag they applied to the story
    "premium": false,              // their crown marker, reproduced
    "publishedAt": "2026-09-03T11:16:15.000Z",  // or null
    "firstSeenAt": "2026-09-03T…Z" // when THIS SCRAPER saw it. A fact about us.
  } ]
}

public/data/market-news/<YYYY-MM>.json   the ARCHIVE — every story ever captured for that month
{ "month": "2026-08", "articleCount": 491, "from": …, "to": …, "articles": [ … ] }
```

**`inHead` is what stops a pointless download.** It is how much of a month the head already carries,
counted by the writer because that is the only place holding both sets. Without it the browser
cannot tell a month it already has in full from one it has never seen, so a reader's first scroll to
the end would fetch every shard to learn nothing — and on a young archive the head is a window onto
every month there is, making that 400 KB for zero stories. A shard where `inHead === count` is
skipped. A capture written before this field existed reports `undefined`, which is not equal to
`count`, so it is fetched: the safe direction.

**A story is filed under a month by the publisher's date where they gave one, and otherwise by when
this dashboard first saw it.** That fallback decides which FILE a story lives in and nothing else —
its own `publishedAt` stays null and still renders as *time not published*. Each shard says so in
its own `_provenance`.

**Both scrapers merge; neither replaces.** `scrape-mc-news.mjs` and `scrape-rss-news.mjs` write
through `scripts/lib/news-store.mjs`, which reads the head *and* every shard before writing. A
scraper that merged into the head alone would write the head back as the whole capture and delete
the other publishers' stories along with the older months. The two workflows share the
`market-news-capture` concurrency group so they queue rather than race.

**Ordering is by publication time, not by id.** Moneycontrol's article id was the sort key while
they were the only publisher, and it does not compare with `business-standard:www.…`. It was also
never as reliable as it looked: measured on the shipped capture, among the 296 stories carrying
their own time, **id order disagrees with publication order 76 times** — a quarter — by a median of
48 minutes and as much as 2.7 days. So a real time decides where a story sits, and the id is used
only to anchor an undated Moneycontrol story to its dated neighbours and to break exact ties.
`firstSeenAt` is **not** used for ordering: all 303 undated stories in the first capture carry one of
two values from a single backfill run, so ordering by it would collapse half the archive into one
instant.

**Two times, never one.** `capturedAt` is when Moneycontrol was read; `meta().checkedAt` in
`js/data/market-news.js` is when this browser last confirmed it holds the newest capture. A 304
moves the second and not the first, and the tab prints both. The refresh button asks for a newer
capture — **it cannot fetch Moneycontrol** — and says so.

**No date on the listing page.** Verified: not one date, time or timestamp element on it. The
publisher's time comes from each story's own page at one request each, so it is budgeted
(`MCNEWS_DATE_LIMIT`, default 40) and the newest are done first. Ordering never depends on it:
their article id is in every URL and increases with publication.

**A top-up run stops at the first story already held**, because the listing is in publication order.
A normal run is one or two page reads. `MCNEWS_FULL=1` walks regardless, for the first fill.

```bash
node scripts/scrape-mc-news.mjs                                  # Moneycontrol top-up
MCNEWS_FULL=1 MCNEWS_PAGES=25 node scripts/scrape-mc-news.mjs    # Moneycontrol deep fill
MCNEWS_RESHARD=1 node scripts/scrape-mc-news.mjs                 # re-file what is committed; no request
node scripts/scrape-rss-news.mjs                                 # all four RSS publishers
RSS_ONLY=mint,economic-times node scripts/scrape-rss-news.mjs    # just these
```

**`MCNEWS_RESHARD=1` reads the head *and* every shard**, not the head alone. The head is a window,
so re-filing from it would rebuild the head out of the window and drop the rest — measured the hard
way when a reshard after a test at `MCNEWS_HEAD=200` cut a 600-story head to 200 while all 600 sat
safely in the shards beside it. The repair path is the last thing that should be able to lose data.

**Adding a publisher** is one entry in `FEEDS` in `worker/rss-news.mjs` — check its newest item is
recent first — plus a row in `js/ui/sources.js` and this file. Nothing else is special-cased by
publisher; the parser reads by shape, because Business Standard sends `<link>` bare, Mint wraps every
field including `<pubDate>` in CDATA, and Economic Times leaves a trailing space inside the CDATA.
All three are valid RSS, and a parser written against whichever one was opened first fails silently
on the other two by returning null and rendering a story with no date.
### NSE live announcements: the one exchange feed that narrows to your companies

**THE ANSWER TO "WHAT DID MY COMPANIES JUST FILE", LIVE.** The publisher news feeds are market-wide
and carry no company, so they cannot be scoped. NSE publishes an announcements RSS
(`nsearchives.nseindia.com/content/RSS/Online_announcements.xml`) that is rebuilt every few minutes,
and every item names the filing company — so each row is resolved to an NSE symbol and the scope
toggle shows just Portfolio, just Watchlist, or the whole exchange.

**THE BROWSER CANNOT READ IT (CORS `null`), so it is proxied through our Worker.** Unlike
Moneycontrol, NSE does not TLS-fingerprint the reader: node's `fetch` and a Cloudflare Worker read it
reliably (5/5 measured) **with a full desktop user-agent** — a weak or blank one gets a 430-byte
Akamai "Access Denied". So `GET /api/nse-announcements` fetches, resolves and returns JSON, edge-cached
90s with a content ETag; the browser polls it. `public/data/nse-announcements.json` is the committed
floor beneath it (first paint, static origins, and the Worker's own fallback when NSE refuses).

**THE FILENAME PREFIX IS NOT A RELIABLE SYMBOL — resolve by NAME.** Every item links to a PDF whose
name usually starts with the filer's symbol, but measured on a live pull only **31%** of prefixes were
a symbol this dashboard knows: the rest are truncations (`LAXMI` for LAXDENTAL), a different entity's
code (`SAIIM` on a Bank of Maharashtra filing), or an XBRL filename with no clean prefix. So the
company name in `<title>` is the identity, resolved against the universe (`worker/nse-ann.mjs`'s
`buildResolver` — book names first, then mc-ticker-map full names, then technicals), and the prefix is
a last resort only when it equals a symbol already known. Measured: **~55% of items resolve**, and
**37 of 123 book companies** had a filing on the day tested — the unresolved remainder are SMEs
outside our ~2,400-name universe and show only under Universe.

```
public/data/nse-announcements.json          written by scripts/scrape-nse-announcements.mjs
{
  "capturedAt": "2026-09-03T…Z",
  "count": 1737, "resolved": 787, "unresolved": 950,
  "rows": [ {
    "company": "NLC India Limited",      // NSE's own <title> — the identity
    "url": "https://nsearchives.nseindia.com/corporate/NLCINDIA_…pdf",  // or null
    "subject": "General Updates",        // the SUBJECT after "|SUBJECT:" — NSE's own, verbatim
    "description": "NLC India Limited has informed the Exchange about …",
    "publishedAt": "2026-09-03T15:59:59.000Z",  // NSE's IST stamp, read as IST
    "symbolHint": "NLCINDIA",            // filename prefix — a candidate, not trusted
    "ticker": "NLCINDIA",                // OUR resolution, or null
    "resolvedBy": "name"                 // "name" | "filename" | null
  } ]
}
```

**A row with no URL is kept, not dropped.** 214 of 1,728 items on a measured pull were exchange
surveillance notices ("Significant movement in price has been observed in <company>") filed with an
empty `<link/>`. Those are real announcements about the company — the rows a reader most wants on
their holdings — so they render without an "open filing" action rather than vanishing, the same way
the market-news list keeps a story whose URL it cannot use.

**A row with `ticker: null` shows only under Universe**, never under a narrowed scope, because nothing
on it says whose it is — the honesty rule every feed here follows. The `worker/nse-ann.mjs` parser and
resolver are pure and shared by the Worker route and the scraper, so the live feed and the snapshot can
never disagree about shape or about how a name becomes a ticker.

### Keeping captures fresh — scheduled first, demand-driven recovery second

**A schedule alone is not treated as proof of freshness.** The measured scheduler behaviour is:

| route | status |
| --- | --- |
| GitHub `schedule:` | fired **12 times against 124** over 41 hours; after being relaxed, **0 against ~11** in 5.7 hours |
| Cloudflare Cron Trigger | **cannot be registered** — Workers Free allows 5 cron triggers *per account* and the account's five are already used by other Workers |
| `workflow_dispatch` | **never late** — six dispatches in a day, each starting a run within seconds |

`workflow_dispatch` is therefore the reliable actuator. GitHub schedules remain the normal first
attempt, while `public/js/data/capture-watchdog.js` checks the committed timestamps after first
paint and dispatches only an overdue source. `GET /api/capture-status` reads five small metadata
records from the deployed assets; the browser never downloads every feed merely to inspect age.
The Worker declines in-flight runs and holds a per-source edge cooldown. The browser checks every
15 minutes while the SPA is open and retries a due source no more than once per 30 minutes, so a
dashboard opened before the 19:00 Insider Trades boundary still notices when that source becomes
due without a broken credential creating a busy loop.

For market news, an external clock can still keep the capture warm when nobody has the dashboard
open. Any of these supplies one:

1. **Free one of the account's five cron slots**, then add `"triggers": { "crons": ["*/20 * * * *"] }`
   back to `wrangler.jsonc` (or add it in the Cloudflare dashboard). No code change.
2. **Workers Paid** raises the limit.
3. **Any external cron service** doing `POST /api/market-news/refresh?source=cron` every 20 minutes.
   **This is the route in use.** Settings, in full:

   ```
   URL      https://sattva-central-research.tech-441.workers.dev/api/market-news/refresh?source=cron
   Method   POST          (a GET is refused with 405 — see below)
   Body     none          no headers, no auth
   Every    20 minutes
   ```

   Safe to call from anywhere, because nothing about the request chooses what runs: the repository,
   the workflow and the ref are fixed on the Worker, a run already in flight is declined, and a
   `DISPATCH_COOLDOWN_S` window at the edge absorbs a stuck pinger. The worst a hostile caller can
   do is cause the same scrape that a reader's button causes.

   `?source=` is an **allowlist of three words**, anything else becomes `button`. It reaches the
   workflow's `run-name`, which GitHub renders and which `lastAutomatic` matches on, so an arbitrary
   string would be somebody else's text in the run list. It is self-reported and that is fine for a
   label: a lie costs one wrong word in a run name and nothing else.

   | `source` | what started the run | counted by `lastAutomatic` |
   | --- | --- | --- |
   | `cron` | an external scheduler pinged the route | yes |
   | `auto` | a reader opened the News tab on a stale capture and it fetched unprompted | yes |
   | `button` | a person pressed Fetch, having noticed the staleness themselves | no |

   **The split is the whole point of the field.** `lastAutomatic` answers *is this refreshing
   without anybody having to notice*, and only the third of those is the page failing at that. An
   auto-fetch filed under `button` would make every unattended refresh invisible to the one thing
   that measures them — the same measurement gap, one layer down, that `?source=` was added to
   close. GitHub's own schedule appears as `github-cron` and counts too.

**The page does not depend on an exact cron.** Opening the dashboard on an overdue capture starts
one fetch after first paint — gated by the capture's real age, declined at the edge if a run is in
flight, and never repeated in the same page. Market news is due after 45 minutes during the hours
the publisher answers; company news after three hours; announcements after 75 minutes on weekdays;
technicals after 07:15 IST on weekdays if today's capture is missing; insider trades at 19:00 IST
on weekdays if today's capture is missing. An external scheduler is still useful to keep files warm
when nobody is reading, but it is no longer the only recovery mechanism.

**`GET /api/market-news/run` answers whether any of it is working**, via `lastAutomatic`: the most
recent run that something other than a person started. It reads `null` while nothing schedules.

**It searches a WINDOW of runs, not the latest one.** With `per_page=1` the field could only be
non-null when the newest run happened to be automatic, so a single button press hid a cron that had
fired minutes earlier and the answer read as though nothing unattended had ever run — a field that
measures a cadence cannot be computed from one sample. `RUN_WINDOW` is 10, about a day at the
schedule's own cadence.

**The cadence WAS to be driven by a Cloudflare Cron Trigger.** `triggers.crons`
in `wrangler.jsonc` would wake the Worker every 20 minutes and `scheduled()` dispatch the workflow —
every 20 minutes across 03:00-14:59 UTC (08:30-20:29 IST, the window the publisher answers in) and
hourly outside it: **48 dispatches a day**. That indirection exists because GitHub's `schedule:`
trigger measurably does not fire on this repository: `*/20` managed 12 runs against 124 scheduled
over 41 hours, and relaxing it to `*/30` produced **zero against ~11** in the following 5.7 hours.
`workflow_dispatch` has never been late — six dispatches in one day each started within seconds.
The dispatch declines when a run is already in flight, so a tick landing on a reader's click costs
no second run.

The `schedule:` block below remains as a fallback for a deployment with no Worker, and is not what
the cadence should be read from — **every 30 minutes across 03:00-14:59 UTC
(08:30-20:29 IST) and hourly outside it**, and both windows are measured rather than chosen. Over 41
hours a `*/20 * * * *` cron fired **12 times against 124 scheduled (10%)**: GitHub sheds the densest
schedules first. Of those 12, **7 were answered HTTP 403** on the listing page, and every refusal
fell between 20:28 and 05:29 IST while every success fell between 10:27 and 21:14 IST — the
publisher's bot defence is tighter outside Indian hours. A 403 now gets a jittered backoff and, if
it still fails, **exits 2**: the workflow reports that as a warning and skips the commit, because a
refused runner is not a broken scraper and the capture on disk is untouched. **A refusal can also
arrive as a 200** — measured, a body over 5 KB with no article list, returned in 0.6 seconds — so
`assertShape` separates the two by positive evidence: no `-<id>.html` article links anywhere means
it is not a listing page in any form (`blocked`, exit 2), while article links present without
`newslist` blocks is a genuine redesign (`shape`, exit 1) and still fails loudly. **So the cadence is
never stated as a promise in the UI** — the page prints when the publisher was actually last read,
and the Fetch button is the path that does not wait for a schedule. It only reaches readers
once `.github/workflows/deploy.yml` runs** — `public/` is served through the Worker's `assets`
binding, so a commit alone changes nothing on the live site. That workflow needs
`CLOUDFLARE_API_TOKEN`; without it the job renders as *Skipped*.

**`image` is the publisher's own thumbnail URL, hot-linked, never copied.** It comes off
`images.moneycontrol.com` with their sizing query string intact (`?impolicy=website&width=400…`), so
the bytes stay on their CDN and the capture stays at ~400 KB rather than becoming an image archive.
The card carries `loading="lazy"` and an `onerror` that hides the `<img>`, leaving the placeholder
block — a reader offline, or a verification run with no egress, gets a clean card rather than a grid
of broken-image icons. Every story in the current capture carries one (600/600).

**The tab renders these as the publisher's cards, not as a table** — thumbnail, headline, standfirst,
and the whole card is a link to their page. See *The one hand-rolled list* in `CLAUDE.md` for why
this is the single feed here that does not use the screener kit, and what the kit's discipline still
buys that is kept by hand.

### The Refresh button can start a scrape — `POST /api/market-news/refresh`

**Everywhere else here "refresh" means "ask the upstream again". For this feed it could not**, and
that gap is what this route closes. Neither the browser nor the Worker can read
`www.moneycontrol.com` (403 by TLS fingerprint, measured both ways), so the free button on the page
can only ask whether a newer *capture* has been published. The button beside it asks the **GitHub
runner** — the one reader that works — to run the scrape now.

```
POST /api/market-news/refresh     starts a run. THE ONLY CALL HERE THAT COSTS ANYTHING.
GET  /api/market-news/run         how it is going. Free, and therefore the half that may be polled.
```

**The tab's chrome is one passive chip.** The heading carries a small `● Live` in green — and only while the
capture is younger than 90 minutes, the schedule's own worst case. Past that it is amber with the
age; with no capture it says so. The chip does not open a provenance popup. Scheduled polling and
the global refresh path remain responsible for acquiring newer captures.

**One button in that modal, not two.** A free *Check for new stories* used to sit beside it; it was
removed because it did nothing a reader was not already getting for nothing — the 20-minute poll
makes that check unprompted, and the fetch ends by making it too. The free read now happens *inside*
the fetch: it reads the capture first and, if a scheduled run has already published one this browser
lacks, reports that and dispatches nothing.

`worker/github-actions.mjs` is the client: pure, `fetch` a parameter, exactly as `worker/mc.mjs` and
`worker/finology.mjs` are.

**Setting it up.** One fine-grained personal access token, scoped to **this repository only**, with
a single permission — **Actions: read and write**. Nothing else: it does not need `contents`, and a
token that can write code is not the token to put behind an unauthenticated route.

```bash
npx wrangler secret put GH_DISPATCH_TOKEN        # production
echo 'GH_DISPATCH_TOKEN=github_pat_…' >> .dev.vars   # local, gitignored
```

`GH_REPO` (`owner/name`) and `GH_REF` are plain `vars` in `wrangler.jsonc` — they are the public
name of a repository, and they live there **rather than in the request** so that nobody who finds
the route can point it at another workflow or another repository. `GH_API_BASE` redirects the API,
the way `MUNS_BASE` redirects Finology, so a verification run never dispatches against the real one.

**Without the token nothing breaks.** The route answers `200` with `ok: false, reason: 'no-token'`
and the command that fixes it; the page says so and adds that the scheduled job is unaffected. That
is true — the Action's own cron does not go through this route at all.

**Named failures, because the fixes differ** (the Finology rule):

| `reason` | What it means | Who fixes it |
| --- | --- | --- |
| `no-worker` | this origin serves static files — there is no Worker. **Measured: `python3 -m http.server` answers a POST with 501, not 404**, so all of 404/405/501 and any non-JSON reply are read this way | nobody; it is a sandbox, not a fault |
| `no-token` / `no-repo` | not configured | an operator, with the command above |
| `unauthorised` | GitHub rejected the token — expired or revoked | reissue it |
| `forbidden` | the token lacks *Actions: read and write* | widen the token |
| `rate-limited` | GitHub's hourly limit for the token is spent | wait; it resets on the hour |
| `not-found` | **ambiguous, and says so.** GitHub answers **404 rather than 403** when a token cannot see a private repository — identical to a missing workflow file. Both readings are printed, with the URL that was asked for | check the file name *and* the token's repository access |
| `refused` | 422 — workflow disabled, or the ref does not exist | GitHub's own message is carried through |

**A finished run is not new stories on screen, and the outcomes keep that straight.** The scrape
commits only if it found something, and `public/` reaches readers only after a deploy then runs.
So `watchScrape()` in `js/data/market-news.js` resolves to one of six, and each is a *statement
about what was observed* rather than an inference:

| Outcome | What was observed |
| --- | --- |
| `landed` | new article ids arrived — `added` counts them **by identity, never by length**. The capture is trimmed to `KEEP` and in production is always full, so an arrival drops the oldest story and the count does not move: measured, 10:24 → 10:41 gained `14019028`, dropped one, 600 both times |
| `nothing-new` | **this run's own capture reached the browser** and carried no id we did not already hold. Gated on `capturedAt` moving, not on a deploy: the scrape restamps `capturedAt` and therefore commits on *every* run, so a following deploy is evidence of nothing. This is the one place on the tab that can honestly say the publisher was just read and had nothing new — the 20-minute poll never can, because it has no index to ask |
| `publishing` | a deploy started after the run finished, so stories were captured and are on their way |
| `published` | the run finished and its capture has not reached this browser inside the grace — neither "nothing new" (nothing measured it) nor "landed" (nothing arrived) |
| `publish-failed` | stories were captured but the deploy failed, so they are not on the site |
| `failed` / `timed-out` | GitHub reports the run as failed / the watch budget ran out with it still going. **These are different**, and a run still going is never reported as a failure |

**Nothing dispatches on its own.** No poller calls it, nothing calls it on render, and the route is
POST-only so a prefetcher or a link preview cannot trip it. A dispatch also reads the latest run
first and returns `dispatched: false` when one is already going — the workflow's `concurrency` group
would queue a duplicate harmlessly, so this is not about correctness upstream but about this
dashboard never being the thing that started a run nobody needed. A `DISPATCH_COOLDOWN_S` at the
edge is the second line of defence, and is per-colo and therefore best-effort by construction.

**A story arriving while the reader is on the page raises an alert**, through the same stack as the
results feed and the con-call scan (`js/core/watch.js` → `js/ui/notifications.js`, `kind: 'news'`).
The poll is `POLL_MS = 20 minutes`, matching the Action's cadence rather than guessing at tolerable
staleness — polling faster cannot surface a story sooner, only spend requests confirming the same
capture. The paint that first loads a capture announces **nothing**: everything in it predates the
reader's arrival, and replaying it would make every later alert worth less.

### X/Twitter posts — another source in the same News list

**`public/data/twitter-posts.json` and `public/data/twitter-handles.json`** — committed captures,
written by `scripts/scrape-twitter.py` on `.github/workflows/twitter-refresh.yml` (every 30
minutes, plus a `workflow_dispatch` the dashboard sends when a reader adds an account).

```jsonc
// twitter-handles.json — the accounts the collector reads. The UI reads it back to tell an
// account it is actually collecting from one this browser has merely been told about.
{
  "updatedAt": "2026-09-03T12:30:00Z",
  "handles": [{ "handle": "Reuters", "addedAt": "2026-09-03T12:29:00Z" }]
}

// twitter-posts.json — capped at TWITTER_KEEP (600) posts, newest first.
{
  "capturedAt": "2026-09-03T12:30:00Z",   // when X was last read
  "handles": ["Reuters"],                  // what the run covered
  "posts": [
    {
      "tweet_id": "1234567890",            // THE deduplication key, upstream's own
      "handle": "Reuters",
      "display_name": "Reuters",
      "text": "…",                         // the post, verbatim
      "created_at": "2026-09-03T12:12:00Z",
      "url": "https://x.com/Reuters/status/1234567890",
      "image": null,                       // first photo, or null — video is not linked
      "source_url": "https://x.com/Reuters"
    }
  ],
  // A handle that could not be read. ABSENT from `posts`, never written as an account with none.
  "failed": [{ "handle": "wrongname", "reason": "account not found" }]
}
```

**It is not a second news system.** `js/data/twitter-news.js` converts each post into the article
shape `market-news.json` already produces — `id`, `title`, `summary`, `url`, `image`,
`publishedAt`, `section` — and the Universe half of the News tab merges the two arrays. One list,
one sort, one search, one export, one card renderer with a single branch on `kind === 'twitter'`.
The publisher feed is untouched: with no handles monitored, nothing about that tab differs.

Five things it deliberately does not do, and each is a rule this codebase already holds:

1. **Nothing is scored, ranked, summarised, sentiment-tagged or mapped to a company.** A post is
   somebody's own words and is reproduced; `title` is the post's text unedited, because a tweet has
   no headline and writing one would put this dashboard's words on somebody's post. `line-clamp`
   shortens what is DRAWN, so search and export still see every word.
2. **Posts carry no ticker, so they are not filtered by one.** They appear under Universe scope
   alongside the market-wide publisher feed and are absent from the narrowed scopes, for exactly
   the reason market-wide news is: filtering rows that have no company BY company would report
   *"your companies are not in the news"* when nothing on the row says whose it is.
3. **Deduplication is by the tweet id, in the scraper and in the browser, and `id` is namespaced
   `tw:<tweet_id>`** so it cannot collide with a Moneycontrol article id in the merged list. The
   capture is capped, so a new post pushes the oldest off the end and the LENGTH DOES NOT MOVE —
   "did anything arrive" is answered by comparing id sets, never by counting.
4. **The merged sort is by time.** `market-news.js` orders by Moneycontrol's own article id, which
   is correct within one publisher and meaningless across two; a story with no readable time keeps
   the publisher's own relative order rather than being dated with something invented.
5. **A removed handle's posts vanish at once**, because the browser filters the capture by the list
   that is monitored right now. The capture is only rewritten when the collector next runs, and a
   control that appeared not to work until then would be worse than no control.

**The handle list has two halves, like the Portfolio scope's.** The committed file is what the
collector reads; a reader's own edits are a device-local overlay in
`localStorage['sattva:twitter-handles:v1']`, so adding an account takes effect on screen at once and
survives a reload. **That makes `Adding…` and `Active` different claims**: an account this browser
monitors is `adding` until a collection run's own capture names it, and it may never be dressed up
as `active` before then — the same distinction as a cached paint that has not been confirmed.
`Account not found` is the collector's answer from `failed[]`, not a guess made in the browser.

**Normalisation is the whole of the input validation, and it is strict.** `@Reuters`, `Reuters`,
`x.com/Reuters` and `https://x.com/Reuters?s=20` all become `Reuters`; anything that is not 1–15
characters of `[A-Za-z0-9_]` — X's own rule — is refused with a reason. The identical rule is
enforced in three places that cannot be allowed to disagree: `js/core/twitter-handles.js`,
`worker/index.js` (because the value reaches a `workflow_dispatch` input and from there a runner's
shell) and `scripts/scrape-twitter.py`. A link to any other host is refused rather than having its
last path segment taken as a handle.

**`POST /api/twitter/refresh?source=button&handle=<h>`** starts a collection, through the same
`worker/github-actions.mjs` client and the same duplicate-run guard as the market-news Fetch
button; **`GET /api/twitter/run`** watches it, free. POST-only, so a prefetcher cannot trip it. Its
failures are never shown as the handle's failures: a deployment with no Worker or no
`GH_DISPATCH_TOKEN` cannot start a run, and that is a fact about the deployment — the account stays
on the list reading `Adding…`, which is exactly what is true.

**Setting it up on a deployment.** `twscrape` drives X as a signed-in user, so it needs at least one
account: add a repository secret named **`X_ACCOUNTS`** (*Settings → Secrets and variables →
Actions*), one per line as `username:password:email:email_password`. With none configured the job
exits **3**, writes nothing and posts a warning rather than failing — no capture is damaged and the
dashboard goes on saying the accounts are being added. Exit **2** means every account failed while a
good capture exists, so the file is left alone. Exit **1** still means a real fault.

**`scripts/scrape-twitter.py` is the one Python script in this repository**, and the rule it breaks
is narrow: the retrieval library asked for is Python, it runs on a GitHub runner only, and nothing
in `public/`, the Worker or the Node scripts depends on it. What it produces is an ordinary
committed capture. `TWITTER_LIMIT` (20) bounds the posts read per account per run; `TWITTER_KEEP`
(600) is the capture's ceiling and is a bytes limit, not an editorial one.

### Corporate announcements are read by DATE, from BSE — a different shape entirely

**`corp-announcements.json` no longer comes from the Muns filings API and must not go back to it.**
The per-company route reached 118 of 603 companies because it costs one request each against a
~60/minute cap. BSE publish the same filings indexed by date, so the whole exchange arrives in about
twenty requests, with no credential.

```
public/data/corp-announcements.json          written by scripts/scrape-bse-announcements.mjs
{
  "kind": "announcements",
  "source": "BSE — api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData",
  "capturedAt": "2026-08-24T…Z", "from": "2026-08-22", "to": "2026-08-24", "windowDays": 3,
  "coversUniverse": true,        // THE FIELD THAT SWITCHES THE PER-COMPANY WALK OFF
  "exchangeCompanies": 5122,     // active equity listings the date index spans
  "companies": 526, "namedCompanies": 515, "unnamedRows": 11,
  "rowCount": 722, "keepDays": 3, "prunedRows": 0, "requests": 19,
  "byCategory": { "Company Update": { "declared": 482, "collected": 482, "pages": 10 }, … },
  "unknownCategories": {},       // a category BSE added that we did not ask for — a tripwire
  "shortfall": [],               // collected < declared, per category
  "failed": [],
  "byTicker": { "LAURUSLABS": [ {
      "scripCode": "540222", "company": "Laurus Labs Ltd",
      "headline": "…",           // BSE's own words
      "category": "Result", "subCategory": "Financial Results",
      "date": "2026-08-24", "time": "15:39:32",
      "url": "https://www.bseindia.com/xml-data/corpfiling/AttachLive/<file>.pdf",
      "newsId": "…",             // BSE's own id — the merge key, never a position
      "critical": true,          // BSE's flag, reproduced; omitted when false
      "tickerSource": "confirmed" // 'confirmed' = mc-ticker-map bseId->ticker; 'bse' = BSE's scrip_id
  } ] }
}
```

**`coversUniverse` is the whole point and it may only come from the file.** A date-indexed capture
asks *what was filed on these dates*, so a company with no rows filed nothing — and the per-company
walk becomes wrong rather than merely redundant. `js/data/filings.js` switches the walk off on this
flag alone. **Never infer it from a row count**: a count cannot distinguish "nobody filed" from "we
ran out of request budget", which is the confusion the change exists to end.

**The window is a bytes ceiling, not an editorial one.** A weekday carries ~900 filings across the
exchange, so a month would be ~22,000 rows and ~16 MB that every visitor downloads. `ANN_KEEP_DAYS`
defaults to **3** — today's filings plus a weekend's grace so a Monday morning is not blank. Rows are
written without their nulls, without `false`, without the ticker that `byTicker`'s key already
carries, and without BSE's `subject` field (which is `<company> - <scrip code> - <title-cased
headline>`, every part of which is already a column). Widening it is one variable and one re-run;
BSE still hold the history.

**Two 200s that are not answers.** `strCat=-1` returns the string `"No Record Found!"`; an empty
`strCat` returns zero rows. Both mean the request was wrong, not that the exchange was quiet, so
`assertShape` in `worker/bse-ann.mjs` rejects them and a run collecting nothing exits non-zero
rather than writing an empty file over a good one.

```bash
node scripts/scrape-bse-announcements.mjs                    # today, merged into the window
ANN_DAYS=7 ANN_MERGE=0 node scripts/scrape-bse-announcements.mjs   # rebuild a week
```
Scheduled by `.github/workflows/announcements-refresh.yml` at 20:00 IST on weekdays — after filing
stops for the day, which is why it is not a step in the 07:00 data refresh.

### News and insider trades: snapshot first, live walk second

These two are still per-ticker, capped at ~60 requests a minute. They now have separate workflows:
company news at 09:00 and 19:00 IST, and insider trades at 19:00 IST on weekdays. Keeping them out
of the 07:00 technicals job prevents two long walks from racing over the same files. If GitHub's
best-effort schedule misses, the capture watchdog dispatches the same dedicated workflow once; the
Worker declines duplicates and the browser watches the committed file.

**News is a search endpoint** — there is no "everything published today" request to make — so there
is no axis to switch to the way announcements had one. It used to make the reader name companies
before it would show anything, on the reasoning that a live walk of the universe is 603 searches
against a sixty-a-minute cap.

That is still true of the *walk*, and irrelevant to what a scoped view paints: `scrape-filings.mjs`
walks **the book first** and commits the result, so those rows are in `news.json` and cost one
conditional GET. Measured on the shipped capture — 123 book tickers, 1,217 articles, no failures. So
News loads like the other two feeds and the walk stays behind Refresh.

**On-open freshness re-reads the FILE; it never performs the forty-company walk.**
`js/data/capture-watchdog.js` compares the capture timestamps with source-specific windows,
dispatches only the workflow that is behind, and calls `refreshSnapshot()` when the new deployment
lands. A replacement snapshot replaces yesterday's
snapshot-derived company rows — including companies that became empty — while preserving any
company this session read live. Additive merging here would leave expired stories on screen until
a reload and is therefore not a refresh.

**A universe walk is merged per company, never accepted or rejected as one indivisible file.** A
fresh row or a fresh empty answer wins. A company that timed out or was never reached retains only
its own last successful answer, with the original capture time in `fallback`; a company with no
last-good answer remains explicitly failed. This closes the failure where 584 fresh answers were
discarded because the previous file covered 585 companies, freezing every Insider Trades row on
the older snapshot. A total outage and a collapse to less than half the prior with-rows count still
fail closed and do not write.

**A company that answered "nothing" is listed in `empty`, and that is what makes it COVERED.**
The scrape used to write only companies that had something, so one with no trades vanished from the
file — indistinguishable from one the run never reached. The browser counted those outstanding for
ever: measured on the shipped insider capture, the tab reported **51 companies "have not been
checked since"** that had all been checked and genuinely have no trades, and the strip kept offering
to re-search them. `empty` closes that, `outstanding()` excludes it, and the four answers are now
distinct in the file: **in `byTicker`** had something, **in `empty`** was asked and had nothing,
**in `failed`** could not be read, **in none of the three** was never reached.

**So `covered` counts companies that ANSWERED, not companies that had something to say** —
`withRows` is the second number and sits beside it, so neither has to be derived by subtraction.
The regression guard that refuses to overwrite a good snapshot compares `covered`, which is the
measure of the run rather than of the news.

**An all-null row is not an article.** The news route answers a company it found nothing for with a
single row carrying only the query. Those are no longer written — the company goes to `empty`
instead — but `keepRow` still drops them on the way to the table, because a capture taken before
this change is still a valid file and still holds 62 of them.

```
public/data/news.json · insider-trades.json
{
  "kind": "announcements",
  "capturedAt": "2026-08-14T…Z", "from": "2025-08-14", "to": "2026-08-14", "windowDays": 365,
  "scope": "universe", "asked": 603, "covered": 561, "rowCount": 18422, "failedCount": 42,
  // `scope` MUST match the widest scope the tab offers. It was pinned to "book" in the scheduled
  // workflow, so the capture held 123 companies while Universe offered 603 and Insider Trades read
  // as a feed that had stopped working. Measured after: 603 asked, 226 with trades, 359 with none.
  "withRows": 519, "emptyCount": 42,   // covered = withRows + emptyCount; never derive by subtraction
  "headers": [],                       // insider trades only: the source's own column headings
  "byTicker": { "RELIANCE": [ … ] },   // had something in the window
  "empty":    [ "SKYGOLD", "OFSS" ],   // ASKED, and answered nothing — covered, and never re-walked
  // news only: the article's own instant where the upstream gave one, null where it gave a day.
  // A FIRST-CLASS FIELD because `raw` is stripped before writing — Daily Alerts read the time off
  // `raw.page_age` and got undefined for every committed row, so the TIME column was an em dash for
  // every company story while market-wide news showed times beside it.
  "failed":   { "XYZ": { "reason": "timeout", "message": "…" } }
}
```

**The three files are committed as empty placeholders** until the first scheduled run. They carry
`capturedAt: null`, `covered: 0` and an empty `byTicker`, and they exist for two reasons: the shape
is then documented in the repo, and the tabs fetch a 200 rather than a 404 — which otherwise breaks
the zero-console-errors bar on every page load. **An empty placeholder is not a claim that these
companies have no news**: with no rows the feed falls back to the bounded live walk and the pill
says where the paint came from.

`js/data/filings.js` reads the snapshot, paints, then walks live for whatever it is missing, bounded
at 40 companies and 4 at a time. **The shortfall is printed on screen** rather than left to look
like completeness.

**A company absent from `byTicker` is not a company with nothing.** `empty` and `failed` are what
distinguish "asked, and there were none in this window" from "we could not read it" from "never
reached", the strip counts them separately, and they must never be conflated — the same error class
as a count of zero from a failing endpoint.

**One definition of "still needs asking about", used by the queue and by the request.** There were
two and they disagreed: `load()` queued every company whose rows were older than the feed's window,
and `loadOne()` then returned early for any company that had rows at all. So the walk counted down
through forty companies **without sending a single request**, the strip said "reading 40 more
companies" throughout, and nothing was ever revalidated once its window expired. A company the
committed snapshot covers is now excluded from the queue outright — that file is the bulk source and
its age is reported as `capturedAt`, not hidden behind 603 live requests.

**`meta().origin` is derived, never assigned.** It was a field four places wrote to, and it read
`null` for the whole of a live walk — which the pill renders as **"Live"** over rows that had come
off the device. It is now computed from the two facts that decide it: what is painted, and what the
server confirmed *in this session*.

| `origin` | Means |
| --- | --- |
| `live` | every painted company was confirmed by the server this session |
| `mixed` | some were |
| `snapshot` | none were, and every painted company came from the committed file |
| `store` | none were, and at least one came off this device's cache |

Bytes this device kept from an earlier visit have a real `checkedAt` and have **not** been checked
now, so they read *Cached*, not *Live*.

### Nothing walks on a page load

`js/data/filings.js` `load()` paints from the committed snapshot and this device and **sends no
per-company request at all**. The walk is `refresh()`, registered with `js/core/refresh.js` and
called only by the Refresh button — the header's, or the *Check for new* control on the tab.

Three measurements from the day all three upstreams went down, each a different consequence of the
walk running automatically:

| | |
| --- | --- |
| a company that could not be read | **93.5s** — the Worker's own retry budget, 30s × 3 with backoff |
| a landing, forty companies four at a time | **~15½ minutes**, painting nothing throughout |
| the rest of the page | starved — four of a browser's six connections to the origin were held open, and the Superstar Investors grid could not fetch its own **static** snapshot file for 44s |

`worker/muns.mjs` now runs under an absolute `DEADLINE_MS` (20s), and the browser bounds its own
request at `REQUEST_TIMEOUT_MS` (25s) so a hung Worker cannot hold a connection.

**What the tab may say, and what it may not.** These routes answer one company at a time and have
no index, so *"nothing is new"* is not a statement anyone can make without asking about every
company. The strip therefore reports **our** state — *"Showing the filings captured 11 minutes ago.
63 companies have not been checked since."* — and leaves the decision to the reader. The committed
snapshot is the channel by which new rows arrive without being asked for; it is revalidated with one
conditional GET per load, and a newer capture wins over anything nobody has confirmed this session.

An empty cache is the one exception: with nothing to paint, `load()` walks once and says so.

### Refreshing it

```bash
node scripts/scrape-filings.mjs                                       # news + insider, 603 companies
node scripts/scrape-filings.mjs news                                  # one feed
MUNS_TOKEN=…  node scripts/scrape-filings.mjs                         # straight at the upstream
FILINGS_LIMIT=20 FILINGS_SCOPE=book node scripts/scrape-filings.mjs   # a smoke run
FILINGS_BASE=http://127.0.0.1:8787 node scripts/scrape-filings.mjs    # against wrangler dev
MUNS_TOKEN=… node scripts/scrape-filings.mjs                          # straight at the upstream
```

**It reads our own Worker by default and therefore needs no secret**, the same arrangement as the
super-investor snapshot: the bearer token lives on the Worker and a script that held it would put it
in a shell history and a CI log. That is what lets the scheduled workflow run it.

It walks **the book first**, so a run cut short by the rate limit or the Action's time budget has
covered the holdings rather than whatever starts with A. It stops the whole feed on `no-token` /
`unauthorised` rather than collecting six hundred identical 401s.

**And it will not replace a good snapshot with a bad run.** A run that covered nobody is not
written at all, and a run covering less than the committed file leaves that file in place —
measured on 19 Aug 2026, when `fastapi.muns.io` answered 502 to every news query and
`devde.muns.io` did not answer at all, a run would otherwise have committed a file saying those 123
companies have no news. An outage is not an absence of events. `FILINGS_FORCE=1` overrides both.

### The credential expires

The registry types this `bearer_jwt`. Unlike a static API key, **a deployment that worked yesterday
can 401 today with no change on our side**, so `unauthorised` is a named state all the way to the
screen and says so in those words. Renew with `npx wrangler secret put MUNS_TOKEN`. If
`fastapi.muns.io` ever needs its own credential, set `MUNS_NEWS_TOKEN`; it falls back to
`MUNS_TOKEN` so one secret works when one is enough.

---

## `GET /api/super-investors` and `/api/super-investors/{slug}` — LIVE, filed holdings (Finology)

The whole **Superstar Investors** view. Two routes on this Worker, proxying the Ticker Finology
super-investor API at `https://devde.muns.io` — the one upstream in this dashboard that needs a
credential.

**Modules** — `worker/finology.mjs` (HTTP client) · `public/js/data/finology-shared.js` (pure shape
guards, imported by both sides) · `public/js/data/super-investors.js` (browser feed) ·
`public/js/investors/live.js` (the view) · `scripts/scrape-super-investors.mjs` (the snapshot).

### The committed snapshot — `public/data/super-investors.json`

The view is **one request per investor**, because each book is a separate scrape upstream. Ninety
investors is ninety-one round trips, four at a time, and that is most of a minute of the grid
filling in on any device that has not been here before. Conditional fetching cannot help: the wait
is latency, not bytes.

```jsonc
{
  "capturedAt": "2026-08-18T08:58:59Z",
  "source": "Ticker Finology, read through this dashboard's Worker",
  "count": 90, "covered": 89, "positions": 2010, "failedCount": 1,
  "investors": [ { "name": "…", "slug": "…", "bio": "…", "imageUrl": "…" } ],
  "books":  { "<slug>": { …the Worker's own response, unedited… } },
  "failed": { "<slug>": { "reason": "timeout", "message": "…" } }
}
```

Measured: **414KB, 69KB over the wire, one conditional GET, grid complete in ~1.1s** on a cold
device with no `/api/` route reachable at all — against ninety-one requests before.

```bash
node scripts/scrape-super-investors.mjs              # all 90, ~2 minutes
SI_LIMIT=5 node scripts/scrape-super-investors.mjs   # a smoke run
SI_BASE=http://127.0.0.1:8787 node scripts/…         # against wrangler dev
```

**It reads OUR Worker, not Finology.** The upstream needs a bearer token and that token lives on the
Worker and nowhere else; a script that held it would put it in a shell history and a CI log. The
Worker's own routes are open, already normalise the payload, and hold each book in a six-hour edge
cache, so a run is mostly cache reads.

Three rules, and they are the filings snapshot's rules:

- **A book the capture could not read is absent, never empty.** It goes under `failed` with a reason
  and the browser fetches it live; writing it as a book holding nothing would report an outage as a
  fund that sold everything. The script **refuses to write below 80% coverage** at all, because a
  snapshot that is mostly missing gets painted and its gaps read as the whole book.
- **A last-good copy is never captured.** `stale: true` from the Worker means it served its own
  fallback during an outage; freezing that into a committed file would preserve somebody else's
  outage for a week.
- **The device's copy always wins over the file**, because those bytes were confirmed later. The
  snapshot only ever fills gaps, and `meta().origin` reads `snapshot` for anything nobody has
  confirmed in this session. That value remains available to stale handling, exports and tests;
  Superstar Investors does not render a second cache/status tag beside the global header control.

### How often a book is worth asking about again

A book is assembled from shareholding patterns companies file **once a quarter**, so the
revalidation window is derived from the filing calendar rather than from a flat number of hours:

| Where the calendar is | Window |
| --- | --- |
| within 60 days of a quarter end — companies are still filing | 24 hours |
| outside that — nothing can change until the next quarter end | 30 days |

Above both: **a confirmation older than the most recent quarter end is always re-asked**, whatever
the elapsed time says. Without that a long hold could straddle a quarter boundary and keep serving
last quarter's book into the new one.

**And no book is re-read on a page load at all.** `load()` paints from the device and the snapshot
and makes exactly **one** request — a conditional GET of the investor LIST, which is the one thing
a snapshot cannot answer (an investor added or dropped). Confirming ninety books is ninety round
trips, and it is work the reader asks for: `refresh()` is registered with `js/core/refresh.js`, so
the header's Refresh button drives it. It ignores the window deliberately — a refresh that silently
skipped every book because the capture was recent would be a button that does nothing on the one
occasion the reader was sure something had changed.

### The Worker exists to hold the token

`Authorization: Bearer …` is required upstream. A token in front-end code is a token published, so
the browser calls this Worker and the Worker adds the header from `env.MUNS_TOKEN`. Nothing under
`public/` has ever seen it — the same arrangement as `/api/live-prices`.

```bash
npx wrangler secret put MUNS_TOKEN     # production
echo 'MUNS_TOKEN="…"' >> .dev.vars     # local; .dev.vars is gitignored
```

`env.MUNS_BASE` overrides the upstream host, which is how local development and `verify-ui.mjs`
point at a stand-in instead of scraping somebody else's production on every run.

### Shapes

`GET /api/super-investors` → `{ ok, source, fetchedAt, count, dropped, investors[] }`, each
investor `{ name, slug, bio, imageUrl }`. `dropped` counts rows the upstream returned without a
usable slug — the slug is the only way to fetch a book, so a card without one is a dead end and is
not rendered. Reporting the count keeps `count` and what is on screen from disagreeing silently.

`GET /api/super-investors/{slug}` → `{ ok, source, fetchedAt, name, slug, netWorthCr, activeStocks,
totalStocks, quarters[], holdings[] }`, each holding `{ company, companySlug, quarterlyHoldings,
valueCr }`. `quarters` is the ordered column set, newest first, and keys `quarterlyHoldings`.

Slugs are `[a-z0-9-]` only — anything else is a 400 here rather than a 400 upstream. An unknown
investor is a 404.

### A BLANK QUARTER MEANS NOT DISCLOSED, NEVER ZERO

Finology print `-` where a holder is absent from that quarter's shareholding pattern. Indian
companies only name holders above a threshold, so a real position below it is **invisible in the
filing**. `null` therefore travels unchanged all the way to the cell, which renders an em dash and
is excluded from every total.

Two consequences that are easy to get wrong:

- A position disappearing is **"no longer disclosed"**, not "sold". The UI says exactly that.
- `deriveMoves` classifies an appearance as `new` and a disappearance as `exited` but gives
  **neither a percentage-point figure**. Printing ±the whole holding would invent a trade size.

### A COLUMN IS NOT A QUARTER — what `filedQuarters`, `awaiting` and `quarterlyNotes` are for

Finology open a column for the **current** period as soon as the first company files into it, and
print **"Filing Due"** against every holder who has not. So the newest column is routinely not a
quarter anybody can be compared across, and reading it as one reported a mass liquidation that
never happened — see *And a quarter that has not closed is not a quarter* in `CLAUDE.md` for the
measurements and the four independent fixes.

| field | on | meaning |
| --- | --- | --- |
| `filedQuarters` | portfolio | `quarters` minus every open period — the only columns a comparison may use. A quarter closes in **March, June, September or December**; a label parsing to any other month is the current, open period. A label that does not parse as a date at all is treated as filed. |
| `openQuarters` | portfolio | the rest, rendered in the table and reported as `pending` by `deriveMoves`, never dropped |
| `quarterlyNotes` | holding | the source's own non-numeric cell text, kept where they gave one (`"Filing Due"`). Empty on a normal book. Same purpose as `parseChange`'s `note` on Trendlyne. |
| `awaiting` | move action | no filed percentage for the latest **filed** quarter, and either their note says the filing is outstanding or `valueCr > 0` says the position is still worth something. **Not a move**, never an alert, never worded as a sale. |

`isMove(action)` is the one definition of what counts as a change (`new`, `exited`, `added`,
`trimmed`). `classifyHolding(h, latest, prior)` is the one classifier — `js/investors/live.js` used
to carry a second copy and would have gone on printing *Undisclosed* after this was fixed
everywhere else. `filedPair(quarters)` is the one place the comparison pair is chosen.

**An exit requires the source's own zero.** A missing percentage plus `valueCr > 0` is a filing
that has not landed; a missing percentage plus `valueCr === 0` is a position that has gone. On the
shipped capture that split is 40 against 142, and the 40 include Life Insurance Corporation
"leaving" Reliance Communications after two identical quarters at 4.13%, still valued at ₹9.01 Cr.

### One derived figure, and it is labelled

`deriveMoves()` subtracts the prior quarter's disclosed percentage from the latest, per company.
That is the only computation this dashboard performs on the feed; everything else is reproduced.
It appears under the heading **Change (derived)**, and the stat card and help modal say so. An
investor with only one published quarter is not comparable and contributes nothing, rather than
counting as entirely new.

`valueCr` is **Finology's** derivation from a percentage and a market cap — a shareholding filing
never states a rupee amount. Same relation as Trendlyne's value column on Institutions: reproduced,
headed **Value (Finology)**, never recomputed.

The combined-book total sums only positions **still disclosed in the latest quarter**, and only
those carrying a value, and says how many of each. Summing all history produced a card reading
`0 holdings` beside `₹793 Cr book`; the count and the total now use the same set.

Clicking a company in the cross-book Quarterly Changes summary reads `allHoldings()` for that exact
company and keeps each investor row whose own latest/prior pair contains a disclosure. The popup
therefore includes unchanged current holders as well as movers, and prints investor, action, prior
stake, latest stake, derived change and current `valueCr`. A row absent from both compared quarters
is historical rather than part of this quarter and is excluded; a one-quarter current row remains
with no fabricated comparison.

The complete `allHoldings()` result renders in the separate **Data Table** tab, positioned after
Quarterly Changes. **All Investors** contains the investor-card directory only. Search, investor
and change filters, watchlist state, table sort and Excel export belong to Data Table and persist
through live-book repaints in the same `liveView` state as before the visual split.

### Caching, and why the fan-out is on the client

Each upstream call is a live scrape of finology.in, and shareholding data moves once a quarter. So
the edge holds each response for **six hours** — `caches.default`, keyed through `edgeKey()`, the
same mechanism `/api/earnings` and `/api/concalls` use — and the browser revalidates against our
ETag for a bodyless 304. Each book is stored on the device under its own key (`investor:<slug>`),
so a quarter landing for one investor does not invalidate the other fifty.

`x-sattva-cache` on the response says which happened: `live` (read upstream), `hit` (edge),
`stale` (last-good copy), or the failure reason. **Check it after touching either route** — the
edge cache was documented here for months while nothing implemented it, and the only visible symptom
was that the view took a long time to fill.

The list is one request and each book is another; the client walks them **four at a time**,
painting as they land. There is deliberately no `?full=1` that would fetch every book in one
request — a cold cache would become sixty simultaneous page reads on their service.

**The client does not re-ask for a book the server confirmed less than six hours ago.** That is the
edge window, so the same bytes would come back; `REVALIDATE_AFTER_MS` in
`public/js/data/super-investors.js` is set from `INVESTOR_TTL_S` for that reason and not as a
judgement about tolerable staleness. A book never read, and a book carrying `stale: true`, are
always asked for. `meta().origin` stays `store` while any painted book is unconfirmed and
`meta().checkedAt` reports the **oldest** confirmation on screen, so the skip cannot be mistaken for
freshness; `refresh()` (the global header's Refresh button) discards every confirmation.

### `stale: true` — the last good read, when the upstream is down

Both routes keep a long-lived `last-good` entry beside the six-hour one. When a live read fails and
such an entry exists, the route answers **200 with the previous payload plus**:

| Field | Meaning |
| --- | --- |
| `stale` | `true`. Absent or `false` on every healthy response. |
| `fetchedAt` | **The original read time, unchanged.** Restamping it would be the cache claiming a freshness it does not have. |
| `staleReason` | The failure that caused the fallback, verbatim. |
| `reason` | The failure's code, as in the `ok: false` shape below. |

Cached for **30 seconds**, not six hours, so recovery reaches the screen quickly. The view renders
an amber strip reading *"Showing the last good read, from &lt;when&gt;"* — real filed holdings of a
stated age. **This is not the mock ribbon and must not be worded like one**: nothing here is
invented, and the only thing wrong with it is that it is not this moment's figure.

A hard failure (no last-good copy) is cached for **15 seconds**. Caching failures at all matters
because ninety-one requests sit behind one outage: uncached, every book pays its own full timeout.

### Failure is reported by kind

An upstream or credential failure returns **200 with `ok: false` and a `reason`** — the same shape
`/api/concalls` uses for `degraded`, because the request to *this* Worker succeeded and the body is
what explains the rest. `reason` is one of `no-token`, `unauthorised`, `route-missing`, `timeout`, `unreachable`,
`upstream`, `shape`; the view renders a named explanation for each, and `no-token` /
`unauthorised` name the `wrangler secret put` that fixes them.

**`route-missing` versus `not-found`.** A 404 means different things on the two routes, so they are
not one reason. On `/super-investors/{slug}` it means no such investor. On the bare list route
there is no investor being looked up, so the only thing it can mean is that **the endpoint is not
deployed on the host being called** — which is exactly what happened in production: the token was
correct, and `devde.muns.io` returned 404 because it has no such route. Conflating the two made the
panel say *"No such investor"* about a missing deployment.

**Transient failures are retried, under an absolute deadline.** The upstream is a live scrape and
visibly flaps — observed returning 502, then timing out, then 200, within a minute. `call()` makes
up to `ATTEMPTS` (2) attempts with a `REQ_TIMEOUT_MS` (6s) ceiling each and 400ms backoff, retrying
only `unreachable`, `timeout` and 502/503/504. A 401 or a 404 is an answer, not a blip, and is never
retried.

`DEADLINE_MS` (13s) bounds the whole call, and each attempt gets whatever is **left** of it rather
than a fresh ceiling. That is the guarantee the route rests on. The previous settings — 15s across
three attempts — added up to **46.6 seconds** before the panel could say the upstream had not
answered, under a comment claiming "the common bad case costs a couple of seconds rather than
twenty". Measured after the change: 12.4s for the first request into a hung upstream, 15ms for the
next, because the failure is cached.

`holdings: []` never travels without `ok: false` beside it — a book that failed to load must not be
able to read as an investor who holds nothing. The card says "could not be read" instead.

---

## The synthetic investor set — REMOVED

`public/data/mock/superinvestors.json`, `institutions.json` and `fund-flows.json` are gone, with
`scripts/gen-mock-investors.mjs`, `public/js/data/investors.js` and
`public/js/investors/deep-dive.js`. So is the **Fund Flows** sub-view they backed.

They held real investor and fund names against generated positions, under an amber ribbon. That was
defensible while the Super Investors tab had nothing real on it. It stopped being defensible once
both other sub-views went live: the tab then had one synthetic surface sharing a rail with two
genuine ones, which is exactly the situation the Con-call tab already resolved — see *One tab, one
provenance* in `CLAUDE.md`. **The preferred resolution is removing the synthetic half, not writing a
better ribbon**, so that is what happened rather than a deprecation.

Every number under Super Investors is now somebody's disclosure. The tab has two sub-views, no
ribbon anywhere, and `verify-ui.mjs` asserts both — including that the deleted modules 404 on the
served site, so a stale import cannot quietly come back.

**If aggregate flow data is wanted later**, AMFI publish the real monthly FII/DII and category
figures and it comes back pointed at those. The real FII/DII holding *changes* already reach the
dashboard through the technicals scrape (`chg_fii_hold`, `chg_dii_hold`) and are used on Breakouts.
The removed view is in git history at `HEAD~1`.


## `public/data/mock/transactions.json` — DELETED

The synthetic buy/sell/dividend/corporate-action ledger: 113 rows across three financial years,
seeded, with **real Yahoo closes as execution prices** so the equity curve never stepped at a
trade. It fed `js/portfolio/lots.js`'s FIFO replay, which produced the open lots, the realised rows
with per-lot holding periods and tax terms, and the two reconciliation identities the suite used to
assert numerically.

It is deleted with the rest of Portfolio Analytics — see *Portfolio means a list of names* in
`CLAUDE.md`. **There is no "wiring the real ledger" path here any more**, deliberately: a real
ledger is a different product decision from restoring a mock one, and the code to build on is in
git history at `d3bba30` (the engine, the charges-in-the-basis and dividends-as-income rules, and
the back-adjustment trap that governs corporate actions against a split-adjusted price series).

---

## Browser-local state — editable scope lists, the watchlist, and the active scope

Three things the reader owns are not files and never travel to a server. They are documented here
because a scope filter is a data contract even when its storage is `localStorage`.

### `sattva:scope-lists:v1` — Portfolio and Universe edits on this device

```jsonc
{
  "version": 1,
  "portfolio": {
    "added": [{ "ticker": "RELIANCE", "name": "Reliance Industries Ltd", "addedAt": "2026-09-01T14:22:00.000Z" }],
    "removed": [{ "ticker": "TCS", "name": "Tata Consultancy Services Ltd" }]
  },
  "universe": {
    "added": [{ "ticker": "NEWCO", "name": "New Company Ltd", "addedAt": "2026-09-01T14:23:00.000Z" }],
    "removed": [{ "ticker": "SBIN", "name": "State Bank of India" }]
  }
}
```

The committed book and technicals universe remain the defaults. `added` overlays a named NSE
company; `removed` records the excluded default entry (including its upper-case ticker). Keeping
the name lets the name-only super-investor feed honour the exclusion too. Adding a default company
again clears its exclusion, and **Restore default** clears both arrays for that scope. Watchlist is
not duplicated here: its editor calls the existing `sattva:watchlist` store, so stars and the
header editor cannot disagree. All edits are device-local, and a Portfolio edit affects research
scope and denominators only — there are no quantities or costs anywhere for it to touch.

The browser calls `GET /api/stock-search?q=` after two characters. The Worker sends the exact Muns
body `{ query, user_index: 124 }`, keeps `MUNS_TOKEN` out of the browser, and normalises the
ticker-keyed upstream object to `{ ticker, country, name, industry, validTicker }[]`. The editor
offers only Indian results with valid NSE-shaped tickers.

### `sattva:watchlist` — the companies the reader is tracking

```jsonc
[
  { "ticker": "RELIANCE", "name": "Reliance Industries", "addedAt": "2026-08-31T09:14:22.001Z" }
]
```

| Field | Meaning |
| --- | --- |
| `ticker` | **NSE symbol, upper case.** The join key, same as every file in this document. |
| `name` | The display name of the row it was starred from, or `null` for a pre-v2 entry. It exists so a watched company can be *named* on a feed that does not carry it — printing the symbol back as though it were a name would be inventing one. |
| `addedAt` | ISO timestamp. Drives the ordering: a watchlist is a working set, so newest first. |

**It is a list of COMPANIES, and it did not used to be.** The star lived entirely inside
`scoreTable` and stored whatever that table used as a row key — which is a different vocabulary on
every tab: the ticker on Breakouts, Moneycontrol's `scID` on the Earnings Hub,
`company|time|document` on Con-call, a composite of the cells on the three filings tabs. Four
vocabularies in one set, which could not answer the one question a watchlist exists to answer.

So `scoreTable` now takes **`watchKey(row)` beside `key(row)`**: `key` identifies the row, `watchKey`
the company, and they are allowed to differ. Three announcements from one filer are three rows and
one watched company, and starring any of them fills the star on all three — the click handler marks
every row sharing the watch key stale, not just the one that was clicked, or the other two would
show the opposite of what is stored.

**A row with no company gets no star at all.** Superstar Investors (Finology discloses a company
name and no symbol) and Public Chatter's unresolved half both pass `watchKey: () => null`. A star
that stored a name where a symbol is expected would match nothing for ever; a star that silently
did nothing is worse than a control that is not offered.

**The legacy set is pruned, not reinterpreted.** An upgrading reader has an array of old row keys
under this same key. Reading them all back as tickers would file `RELIANCE|2026-08-12|3` as a
company — a value that meant something else, read as a measurement. The migration keeps only
entries *shaped like* an NSE symbol (`/^[A-Z][A-Z0-9&.\-]{0,19}$/`) and drops the rest, once,
recording that it ran under `sattva:watchlist:shape`. A dropped entry was never a company; it was
a row.

### `sattva:scope` — which of the three scopes is active

`"portfolio" | "watchlist" | "universe"`, defaulting to **`portfolio`**. The vocabulary lives in
`public/js/data/scope.js` and `core/state.js` and `core/router.js` import it, so the list exists
once. `?scope=` in the URL wins over the stored value; an unrecognised value falls back to the
stored one rather than letting a typo redefine what is on screen.

| Scope | Filters by | Denominator the pill prints |
| --- | --- | --- |
| `portfolio` | `portfolio-companies.json` via `js/data/coverage.js`, overlaid by `sattva:scope-lists:v1` | *"123 of 142 book companies"* before edits. Unresolved book lines stay in the denominator; device additions and exclusions update it. |
| `watchlist` | `sattva:watchlist` above | *"12 of 20 watched companies"*. This gap is only ever *this feed does not carry it* — a watchlist entry came **from** a feed. |
| `universe` | the feed's full rows, minus local exclusions; local additions appear wherever that feed has data for their ticker | plain count |

`scopeTickers(scope, holdings)` returns the `Set` to filter by, or **`null` for universe**. `null`
and an empty `Set` are deliberately different: an empty `Set` is a real, correct answer (nothing is
watched yet) and must narrow the feed to nothing, while `null` means *this scope does not narrow*.
Collapsing the two would make an empty watchlist show the whole universe — a scope silently meaning
its own opposite. `null` is retained for call-site compatibility; editable-aware consumers use
`scopeAllowsTicker()` or `filterByScope()`, which apply Universe exclusions as well.

**An empty watchlist is answered by the shell, once, for every tab.** `watchlistEmptyPanel()` says
there are zero watchlist companies and offers **Add companies to watchlist**; the shell opens the
same Watchlist editor as the header pencil without changing tab or scope. The tab is not mounted at
all, and the shell decides teardown against what it will actually mount so the un-mounted module is
destroyed rather than left painting into the content host.

---

## AI Alerts priority — DERIVED, no file and no route of its own

`js/data/ai-alerts.js` consumes the retained report below and writes nothing. It takes company events
from the latest seven Indian trading dates, deduplicates the same normalized headline within a feed,
groups by ticker and emits only companies scoring at least `MIN_SCORE` (64). `MUST_SEE_SCORE` (82)
splits the surfaced queue into Must see and Important. Tickerless market stories stay in General
Alerts: attaching them to an individual company would be an unsupported inference.

The score begins with the strongest event and then adds smaller company-level context:

- event importance, source materiality, recency and explicit Positive / Negative direction;
- membership in `coverage.js`'s real Portfolio list (not the illustrative Analytics ledger);
- **named cross-feed patterns** (see below), capped in total at `CONFLUENCE_MAX` (18);
- independent feed corroboration, repeated high-importance events and directional conflict;
- a small negative-sector-cluster adjustment where multiple real portfolio companies carry
  high-importance negative evidence (routine small activity cannot create the cluster);
- a penalty where the source is stale, failed, incomplete or unread.

Every contribution is returned as `{ label, points }` in `scoreBreakdown` for deterministic ordering and verification, but the score arithmetic is not rendered on the card.
The derived `insight`, `metrics` and `badge` values are templates over those structured facts, not
generated claims — see *The card's reading layer* below. `rankReport(report, { holdings })` is pure and exported so every product-rule branch can be
verified with fixtures independently of what happens to be in today's capture.

### Cross-feed patterns — `confluenceOf(events, { feedById })`

Pure and exported. Returns `[{ id, label, points, detail }]`, strongest first, for the patterns a
company's recent events satisfy. `detail` is written out of the matched events themselves, so every
clause traces back to a row that is already on the card and already links to its own source.

| id | fires when | points |
| --- | --- | --- |
| `accumulation` | participation on the tape (volume or a base break) or a positive price move, **and** a high-importance investor increase / new disclosure or insider purchase | 10 |
| `distribution` | participation or a negative price move, **and** a high-importance investor reduction / non-disclosure or insider disposal | 10 |
| `risk-cluster` | high-importance negative readings on two or more independent feeds | 10 |
| `insider-and-investor` | a high-importance insider trade and a high-importance investor change in the **same** direction | 8 |
| `news-behind-the-move` | any technicals event, **and** a tracked-keyword news story or a high-importance BSE filing | 8 |
| `results-reaction` | an earnings or con-call event, **and** any technicals event | 8 |
| `unexplained-move` | a high-importance technicals event with **no** tracked story, material filing or result in the window — **and only when news, announcements and earnings were all read and reach the day** | 6 |

Three constraints are contractual rather than stylistic:

1. **Co-occurrence, never causation.** A filed shareholding is a quarterly disclosure and the trade
   behind it may be months old, so the wording is *"a tracked investor's latest book shows buying"*
   and never *"bought today"*.
2. **Each leg keys on the owning feed's own published threshold** (`importance === 'high'`), not on a
   second threshold defined here.
3. **`unexplained-move` reports an absence**, so it is withheld whenever any feed whose silence it
   would be reporting is stale, failed or unread.

### The card's reading layer — `plainInsight` / `cardMetrics` / `plainHeadline` / `topEvidence`

All four are pure and exported. They decide how fast the ranked result can be READ, and they add no
fact: every phrase rewords an event already on the card and every figure is read from a field the
collector wrote — `volumeX`, `movePct`, `deltaPp`, `action`, `investor` on the events themselves —
never parsed back out of a sentence.

| | what it returns | rule |
| --- | --- | --- |
| `plainInsight(card)` | the card's whole finding as one short sentence | The leading cross-feed pattern in ordinary English, then its figures. Co-occurrence stays co-occurrence: *"Heavy trading, and a big holder has been selling"*, never *"sold into the tape"*. |
| `cardMetrics(card)` | **exactly four** `{ id, label, value, tone, title }` cells | Up to two facts the company actually has (volume ratio, day move, book change), then `Sources` and `Events`. Fewer than two facts fills from `Direction` and `Flagged high`. **Volume carries no tone**: participation has no sign, so colouring it would assert a direction the technicals feed refuses to assert. |
| `plainHeadline(event)` | one event's claim, plainly | Only rewrites sentences this dashboard composed. A filing's subject, a con-call title and a publisher's headline are somebody else's words and are returned untouched. |
| `topEvidence(card, 3)` | the rows the card shows | The strongest event from each **different** feed first, then the rest. A card claiming four sources may not spend all three rows on one of them. |

`cardBadge(card)` names the action rather than the band: a directional disagreement reads
`Reconcile`, because that changes what the reader does next and `Important` does not. The band
itself stays on the card as `data-priority` and in the filter chips.

### `sattva:ai-muted:v1` — the archive, device-local

`js/core/ai-mute.js`. `{ "<TICKER>": { at: ISO, seen: "<event id>" } }`, written by the card's
**Archive** button and read by the tab's Archived view.

**A record is tied to the evidence it was given for, not just to the company.** A card stays
archived while `seen` is still its strongest event, and returns by itself the moment something
stronger arrives — otherwise a reader who archived a company on Monday's evidence would stop being
told about Friday's, with nothing on screen saying so. Entries lapse after seven days, because
beyond the alert window the events they refer to have left it. Nothing is ever deleted: the
`Archived · n` chip is always on screen and `Restore` is one click.

## Tracked news keywords — DERIVED, no file and no route of its own

`js/data/news-keywords.js` is pure, has no dependencies and writes nothing. It exports `KEYWORDS`
(30 entries, `{ id, label, group, test, note? }` in the desk's own order), `GROUPS`,
`matchKeywords(title, summary)`, `namesCompany(row)`, `classifyStory(row)`, and the filter vocabulary
`topicFilterOptions(count?)` / `matchesTopic(reading, value)` / `topicLabel(value)`.

`classifyStory(row)` returns:

| field | meaning |
| --- | --- |
| `keywords` | `[{ id, label, group, note, where }]` — `where` is `'title'` or `'summary'` |
| `ids` / `labels` / `groups` | the same, flattened |
| `inTitle` | at least one match was in the headline |
| `namesCompany` | `true` / `false` / **`null` when there is no search term to check against** |
| `tracked` | at least one keyword matched |
| `targeted` | `tracked` **and** `namesCompany !== false` — an unverifiable name is not a failed one |

Consumers: the Topic column and filter on both News surfaces **and on Corp Announcements**,
`newsSignal()` and `announcementSignal()` in `js/data/daily-alerts.js`, the market-news collector's
`keywords` tag, and the `news-behind-the-move` confluence pattern (whose sentence names topics from
either feed).

`newsSignal(row)` returns a normal signal plus `keywords` / `keywordIds` / `keywordGroups` /
`namesCompany`. It raises **importance only** — direction is always `neutral` — and `high` requires
**both halves of "company name + keyword", in the headline**:

- `inTitle` must be true. A standfirst-only match stays `low`: several outlets fill that field with
  a related-links strip rather than the story's own summary.
- `namesCompany` must not be `false`. `null` still counts — an unverifiable name is not a failed one.

A story that fails either test **keeps its tags and stays in the timeline** at low importance, and
the reason says which test it failed. Measured on the shipped capture: 3,278 stories tracked, 1,990
with a headline match, 1,914 with a headline match that also names the company.

Measured on the shipped `news.json` (11,060 stories, 559 companies): 3,278 tracked (29.6%), 3,130
targeted, and **every one of the 30 keywords matches at least once** — the vocabulary carries no dead
entry. A keyword is a **topic**, never a direction: no story is scored positive or negative anywhere.

### Announcements — `announcementSignal(row)`

Returns a normal signal plus `keywords` / `keywordIds` / `keywordGroups` / `critical`.

- **Direction** is unchanged: the narrow negative/positive rules over the filing's own text.
- **Importance** is one predicate with stated inputs: `high` when a tracked keyword matched **or**
  the directional rule matched. The keyword reading classifies the filing's subject plus BSE's
  sub-category; there is no `inTitle` gate (a filing has no standfirst to be unreliable) and no
  `namesCompany` question (a filing is the company's own statement).
- **`BSE_CRITICAL_IS_MATERIAL` is `false`.** BSE's `CRITICALNEWS` flag stays on every row and in the
  export, but does not gate importance. Measured on the retained capture: it marks 1,147 of 3,942
  filings (29%), 1,074 of which match nothing else and 881 of which are AGM notices. High importance
  on this feed fell from 1,271 (32%) to 446 (11%). Set the constant to `true` to restore the old rule.

## Technicals participation events — part of the `technicals` feed

Alongside the ±`MOVE_PCT` price move, `fromTechnicals` emits one event per company whose
`volume_ratio_today` reaches `VOLUME_X` (2 — today's volume against its own 20-day average) or whose
`consolidation_breakout` reports a completed break (`breaks_out === true` with quality `strong` or
`weak_base`). Carries `kind: 'volume' | 'breakout'`; the price-move event carries `kind: 'move'`.

**Volume events are `neutral`**, because volume is participation and the tape does not say whether
heavy trading was accumulation or distribution. Only a confirmed base break is `positive`. On the
shipped capture, 40 of 603 companies clear 2x and 16 clear 3x.

## General Alerts history — DERIVED, no file and no route of its own

`js/data/daily-alerts.js` writes nothing and introduces no route of its own. It calls the loaders of
all eight research tabs and returns readings in one of two modes: the default one-day report, or `includeHistory: true`
for every retained row through the requested **Indian trading date**. General Alerts and AI Alerts use history
mode; its table progressively paints the rows inside one fixed-height scroller, newest first.

| Feed id | Tab | Contributes |
| --- | --- | --- |
| `technicals` | Breakouts / Technical | companies that moved more than `MOVE_PCT` at the retained snapshot's close; this source has one day only |
| `earnings` | Earnings Hub | filed quarterly results; direction from the revenue/net-profit comparison |
| `concalls` | Con-call | held calls using StockScans' own result/sentiment bands |
| `chatter` | Public Chatter | one event per covered company in the rolling source snapshot; not individual posts |
| `investors` | Super Investors | quarter-over-quarter disclosed holding changes; dated to each current investor book confirmation |
| `announcements` | Corp Announcements | every BSE filing retained by the exchange-wide capture |
| `insider` | Insider Trades | retained insider and promoter disclosures (up to 365 days in the current source contract) |
| `news` | News | retained stories about a company in scope (30-day source window) |
| `market-news` | News | retained market-wide stories — no company, so Universe only; bounded by the capture's keep limit |

News appears twice because that tab owns company and market-wide feeds. Adding a source is an entry
in `FEEDS` plus a collector — nothing else in the module is special-cased by feed id.

```jsonc
{
  "day": "2026-09-01",
  "scope": "universe",
  "includeHistory": true,
  "pending": 0,                       // feeds that have not answered YET — never "nothing today"
  "events": [{
    "id": "tech:PRAXIS:2026-09-01",   // content-derived and unique; never a position
    "feed": "technicals", "feedLabel": "Price moves", "tab": "breakouts",
    "direction": "negative",          // positive | negative | neutral
    "importance": "high",             // high | low, independent of direction
    "severity": "alert",              // compatibility alias for notifications
    "time": null,                     // HH:MM IST, or null where the feed dates to the day only
    "day": "2026-09-01",             // normalized Indian date used for ordering and filtering
    "at": "2026-09-01",
    "ticker": "PRAXIS", "company": "Praxis Home Retails",
    "headline": "Fell 5.2% at the close",
    "detail": "Close ₹4.70 · RSI 23.2 · below its 200-day average",
    "signalReason": "Down 5.2% on the day, past the 5% threshold this page states.",
    "importanceReason": "High: the absolute day move reached the stated 5% threshold.",
    "url": "https://…"
  }],
  "feeds": [{
    "id": "technicals", "label": "Price moves", "tab": "breakouts",
    "status": "ok",                   // ok | failed | pending
    "count": 13,                       // this one-snapshot feed has one retained day
    "todayCount": 13,                  // rows on report.day; freshness is still separate
    "oldestDay": "2026-09-01",
    "newestDay": "2026-09-01",
    "reachesToday": true,             // HAS THIS FEED LOOKED AT THIS DAY — null where it cannot know
    "asOf": "2026-09-01T07:13:59.909Z",
    "note": null
  }]
}
```

**`signalReason` and `importanceReason` are mandatory on every row.** Direction comes from source
figures/bands where carried, transaction direction for insider and investor activity, and the
exported conservative announcement rules. Importance uses the exported numeric thresholds and
BSE's own critical flag. Unmatched announcements and publisher news remain Neutral; neither is
forced into a directional claim the source does not support.

Earnings metric kinds survive consolidation: `turnaround`, `slipped-to-loss`, `loss-narrowed`,
`loss-widened` and `loss-flat` are written as words, not recomputed from `reportedPct`. Insider
`Transaction` is authoritative over a conflicting `Mode`, and the order-award rule requires
commercial context rather than treating a regulatory “order received” as business won.

`moveSeverity(pct)` remains **exported** as the price-move entry rule, and a rule that
only runs inside a collector can only be tested on days the data happens to contain a big faller.
It returns `'alert'` below `-MOVE_PCT`, `'update'` above `+MOVE_PCT`, and `null` in between or for a
missing value — so a company with no move is not an event at all rather than a neutral one.

**`reachesToday` is the half that makes an empty day readable**, and it is computed differently
depending on what the feed is:

| Feed | Test | Why |
| --- | --- | --- |
| Earnings, Con-calls, Announcements, Insider, News, Market news | `capturedDay >= day` | rows carry their own date, so a later capture still covers an earlier day |
| Price moves, Chatter | `snapshotDay === day`, **equals, not `>=`** | these are single capture views; chatter is a rolling snapshot |
| Investor activity | `bookConfirmationDay === day` | moves are quarterly disclosure comparisons; each row follows the confirmation represented by its current investor book, not an older seed snapshot |

A feed nobody has heard from yet is `pending`, which the panel draws as *reading…* and never as
*nothing today* — a half-finished read must not be allowed to give a finished answer.

Tickerless Super Investor moves are retained under Universe and excluded from Portfolio/Watchlist.
If any current investor book is missing, the feed is marked incomplete and `reachesToday` is false.
Stale last-good investor books have the same incomplete state. Likewise, a degraded earnings or
con-call response uses the retained snapshot's `fetchedAt`, carries failed status, and cannot turn
the failed confirmation attempt into a current coverage claim. A plain committed-snapshot fallback
also uses `fetchedAt`: reading the file today is not evidence that its upstream was read today.

**Nothing on this tab walks.** The three filings feeds are seeded with `feed.seed()` — the committed
snapshot and this device, no per-company request — which is deliberately separate from `load()`:
`load()` memoises its promise, so a seed arriving first would hand the tab that owns the feed the
seed's promise and silently discard its company list, and the Refresh button would then re-read an
empty set and ask about nothing. General Alerts Refresh uses the one-shot earnings, con-call and
chatter revalidators plus one conditional read of the bulk investor snapshot. It never performs
the Super Investors tab's ninety-one-book revalidation walk.

---

## Adding a new data file

1. Drop the JSON in `public/data/` (or `public/data/mock/` if it's placeholder data).
2. Add one line to `DATA_SOURCES` in `public/js/app.js` — the key becomes `ctx.data.<key>`.
3. Document it here: shape, field types, units, cadence, real source, consumers.

For anything that should update without a page reload, register a poller with
`live.register(id, { intervalMs, fetcher })` instead of adding it to `DATA_SOURCES`.
