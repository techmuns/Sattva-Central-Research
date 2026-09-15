# Automatic breakout capture

The daily technical score and the current price are separate measurements. The
16-rule score still uses the completed daily series. Strong Breakouts recomputes
its 30-session base breakout and volume classification from captured price and
cumulative session volume. Table and popup share the same price and source time.
A 15-minute capture is a periodic snapshot, not a streaming feed or a guarantee
that every brief breakout will be observed.

## Collection and delivery

- `breakouts-refresh.yml` requests a run every 15 minutes. The collector only
  requests market data during regular-session collection hours (09:15–16:15 IST),
  with the published 2026 NSE holidays excluded. The first scheduled run also
  seeds the latest closing observations outside market hours and retries incomplete
  seed manifests. Successful closing observations are reused with their original
  source/check times; only missing or stale quotes spend more provider requests.
  The November 8 special session
  has no confirmed time in the source calendar, so checks are attempted all day
  and calendar completeness is explicitly unknown. Future calendar years are
  also reported as unknown until the calendar is updated.
- A fixed `CaptureRegistry` object, `breakout-capture:v1`, holds SQLite records.
  A main-branch code push starts a separate authenticated bootstrap job, independent
  of scheduled Actions and source collection. It waits up to eight minutes for
  publishing and arms the durable alarm without needing an inventory or quote.
  Failed publishing leaves a visible failed bootstrap job. Each authenticated
  collector also ensures the alarm is armed. Every 15 minutes
  the alarm checks the fixed workflow and requests a missed run, unless one is
  queued/running or a collection run was recently created. Successful push-only
  bootstrap jobs are not counted as price collection. This uses the existing `GH_DISPATCH_TOKEN`
  and requires no additional Cloudflare cron slot. Reads never activate it.
- GitHub OIDC permits writes only from the fixed repository, main branch and
  this workflow. No browser credential or long-lived upload secret is needed.
- Yahoo Finance is the primary quote/history source. Eight requests run at once;
  a rate limit stops further primary requests. Numeric BSE codes and known SME
  suffix mappings follow the existing daily collector; the exchange is labelled. Each completed wave is checkpointed.
  All committed universe names, technical rows, live portfolio tickers and shared
  watchlist names are included. If live inventory discovery fails, prior targets
  remain included and the capture is explicitly partial. No top-60 limit applies.
- Current observations have an eight-minute primary budget; Upstox history has
  its own 90-second bound; recovery stops starting source requests after ten
  minutes. Failed or unchecked companies remain explicit. Oldest/unseen names go
  first on the next run, avoiding permanent starvation of the end of the list.
- Quotes are saved directly to the Worker, without a data commit or website build
  every 15 minutes. `/api/technicals` resolves the latest commit of the daily file
  on GitHub main (a shared 15-minute revision cache), then streams it and its ATR
  history/optional indicator overlay from that exact revision. Companion routes
  accept only a commit hash and their fixed file path. If any input is unavailable,
  the browser keeps its prior complete bundle or a labelled deployed fallback;
  it never mixes a new score file with old trend inputs. Publishing
  this new Worker and browser release still requires a successful deployment.
- Visible dashboards read the saved capture every minute and on focus/return or
  reconnect. Daily data revalidates every 15 minutes and on return when due.
  Public capture responses share a 30-second edge cache to reduce database reads;
  the health endpoint remains uncached. Browser reads do not spend Muns quote requests. An already-open popup updates
  with the table. Search, selected chips, sorting and scroll are retained during
  capture refresh. The service-worker release is advanced for returning readers.
  A completed daily close takes precedence over an older intraday observation of
  the same date. Extra captured targets appear only in their selected scope;
  watchlist-only additions do not silently join Universe.

## Optional free Upstox backup

Upstox documents its [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/)
as free, read-only and valid for one year. No static IP is required for market
quotes/history. Configure the token as the GitHub Actions secret
`UPSTOX_ACCESS_TOKEN`; set the repository variable `UPSTOX_BACKUP_ENABLED=true`
only after the account and permitted customer-data use are confirmed. Until then
this backup is **not active**. No paid subscription is requested by this change.
Do not paste the token into issues, PRs, chat, browser storage or committed files.

The [full-quote endpoint](https://upstox.com/developer/api-documentation/get-full-market-quote/)
accepts batches of up to 500 mapped NSE equity instruments. It supplies last
price, cumulative volume and last-trade time. Instruments are mapped by exact
symbol and instrument key; ambiguous mappings are refused. Previous close is
derived from `last_price - net_change`, rather than confusing today's OHLC close
with the previous close. Missing 30-session bases can be fetched from the
[historical daily candle endpoint](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/).
Provider failure, expiry, unmapped symbols and insufficient history remain visible
as incomplete coverage. A free source does not establish an uptime guarantee or
customer redistribution permission.

Fresh Yahoo quotes that lack a base also enter the backup history lookup. Their
price and volume are retained if that lookup fails; a supplied base enriches the
primary observation before its first checkpoint, without rewriting saved history.

## Freshness, completeness and history

Freshness uses the quote's own exchange-session date and source time. During the
session, observations older than 20 minutes are stale. Afterward, an earlier
intraday print is not accepted as a closing observation. A base, price and volume
must all be present for a company's breakout check to count as covered. The
latest run must complete its entire manifest; discovery failures and calendar
uncertainty prevent a complete-coverage claim.

Every acknowledged quote is retained separately from the latest-quote index.
A failed run keeps the old observation and adds the failure; it cannot make the
old quote appear newly checked. Completed runs are idempotent; conflicting
checkpoint replay is refused. No history is deleted when the date or scope changes.

When two or more expected 15-minute slots are missed, the next successful run
journals the gap and attempts available Yahoo 15-minute candles for the most
recent five calendar days. Only continuous sessions beginning at 09:15 can supply
cumulative volume. Corrections found during recovery retain both observations; unchanged candles
are deduplicated. Completed candle closes are labelled `recovered-candle` and
never replace the latest observed quote. Interrupted or failed recovery remains
eligible in the following runs. Gaps outside that horizon or unavailable upstream
remain disclosed. Recovery cannot reconstruct every trade or an intra-candle
breakout that reversed before the candle closed.

- `/api/breakouts`: current capture, per-ticker failures, recovery gaps and timer.
- `/api/breakouts/health`: 503 for missing/partial/stale current coverage or an
  overdue timer; this is distinct from historical recovery completeness.
- `/api/breakouts/history?ticker=...&before=...`: all saved observations with
  keyset pagination (100 per page, follow `nextCursor`), including recovered candles.

The response states capture start and finite storage. No exhaustive pre-capture
archive is claimed. Source records are retained in the existing durable database;
30-day GitHub health artifacts are diagnostics, not the market-data archive.
This change adds no paid product, but cannot promise infinite free storage or
ignore existing platform quotas. Storage failures surface as failed checkpoints.

## Validation and operations

Local tests cover dates/holidays, stale quotes, missing bases, failure retention,
large inventories, rate-limit stopping, fallback mapping/history, signed OIDC,
replay, history pagination, interrupted recovery and delayed-run dispatch. A real
local workerd test restarts between checkpoints and verifies SQLite/history/alarm
persistence. Browser tests cover automatic updates, the open popup, future
holdings, filters/search, outage retention and a returning service-worker session.

Deploy through the repository's normal merge pipeline. Verify the actual
production API and asset release separately from GitHub's fallback Deploy status:
that workflow can succeed while its publishing job is skipped. This implementation
and its local tests do not certify production activation or Upstox credentials.
Manual deployment or production-run dispatch requires explicit authorization.
