# Automatic breakout capture

The daily technical score and the current price are separate measurements. The
16-rule score still uses the completed daily series. Strong Breakouts recomputes
its 30-session base breakout and volume classification from captured price and
cumulative session volume. Table and popup share the same price and source time.
Upstox supplies one shared price/volume snapshot per minute in market hours.
The existing 15-minute GitHub capture is the fallback and supplies daily bases
and candle recovery. These are periodic snapshots, not a trade-by-trade stream.

## Primary minute feed (20 September 2026)

- The `breakout-upstox:v1` object has its own one-minute alarm; it does not dispatch
  GitHub jobs. It runs without open dashboards, within 09:15–16:15 IST collection
  hours, with the same holiday calendar. Its alarm is persisted before external I/O;
  failures keep the next attempt armed and duplicate wakes do not collect twice.
- Upstox full quotes are batched at 500 instruments. Approximately 592 mapped
  targets need two quote requests per minute, shared by all readers. Exact NSE/BSE
  identities are cached daily, with failed instrument lists retried after 15 minutes.
  The large official gzip lists are streamed and only cash identities are retained.
  Native Worker requests explicitly identify `SattvaCentralResearch/1.0`; unlike
  Node fetch, Workers supplies no default User-Agent. On 21 September the missing
  header reproduced a CDN 403 for both lists, while the identified request loaded
  them successfully. The client version invalidates the prior failed list cache once,
  so the next normal minute alarm retries after this transport correction is published.
- Authenticated fallback runs publish the complete discovered inventory, including
  portfolio ISINs, names and explicit symbol aliases. Bases come from the current
  session's fallback history. Missing bases remain partial until that history arrives;
  yesterday's breakout base is never silently relabelled as today's.
  Inventory is published before an after-hours quote skip; newly added targets still
  require a closing seed. Partial discovery preserves earlier identities and targets,
  so a temporarily unavailable portfolio/watchlist cannot erase a renamed stock's ISIN.
  An inventory check older than 20 minutes remains partial even if its known stocks
  still have fresh quotes; primary collection continues through that discovery outage.
- A successfully checked Upstox quote takes priority. After two minutes without a
  successful primary check, a fresh fallback quote can take over. Last good prices
  survive failures and still show their actual source/trade time. An old last trade
  is never stamped with the time the dashboard was opened.
- Visible readers check saved data every 15 seconds and immediately on opening,
  focus, visibility return and reconnect. The shared edge cache lasts five seconds.
  Opening a dashboard never exposes the token or starts another provider request.
- Detailed minute observations expire after **four calendar days**, as approved by
  the user on 20 September 2026. They stay in Cloudflare SQLite, not GitHub files or
  the dashboard's browser cache. The latest-price index is separate; an outage can
  retain the last known price with its true date after the detailed archive expires.
  Cleanup runs every 15 minutes through the minute timer even on holidays, without
  credentials, or during provider outages; a save also checks cleanup before writing.
  A delayed alarm may delay physical cleanup. History reads enforce the four-day window.
- Minute history stores only price, volume and source/check times alongside a compact
  key. Company identity and breakout base are deduplicated in a daily dictionary;
  complete payload comparison prevents hash collisions from mixing identities.
  Sixteen indexed buckets per minute keep write counts down. Dictionary cleanup retains
  the cutoff day until all of its possible observations have expired.
- Observed breakout entries, exits and quality changes retain their complete supporting
  quote separately after minute expiry. The first non-breakout establishes a baseline;
  missing bases and regressed source times cannot invent a transition. Existing daily
  and 15-minute history retain their previous policy. Failure-interval detail uses the same four-day
  window, then compacts into durable per-company/reason counts with first/last bounds.
  Lifetime missed-minute and missing-quote totals survive cleanup. Current-price reads
  load a single summary record, never scan the growing failure journal.
- Normal dashboard opening/polling reads only the latest-price index and coverage
  summary. It never queries or downloads the minute/event archives. History is a separate
  company-specific, 100-row paginated endpoint. Minute captures order by capture time;
  source quote times remain unchanged. Breakout changes appear once, whether their
  minute snapshot is still retained or has expired. Storage remains finite.
- A local 600-company, 30-minute fixture stored 1,421,230 bytes versus 6,205,200 bytes
  for full quote copies (77% smaller). Its current response was 211,981 bytes raw and
  20,169 bytes gzip. These are synthetic measurements, not production transfer or
  database-size guarantees; company names, values and breakout activity vary.
- Missed minute intervals are counted separately in `primary.gaps`. The existing
  15-minute candle recovery remains available; it does not reconstruct every missed
  one-minute observation. Provider outages, absent symbols and shorter listing histories
  remain explicit partial coverage. Consecutive failures with the same target/reason
  set are retained as intervals, including the number of missing target-minute quotes;
  successful recovery does not erase their missing-quote counts. `primary.captureStartedAt`
  identifies when minute collection began, separately from older fallback history.
- A usable fallback quote does not make a failed primary feed healthy. Missing server
  credentials, instrument-list failures, failed quote batches, overdue checks and primary
  storage failures remain partial in Sources and return 503 from the health endpoint.
  Saved prices remain readable while either collector is impaired.

### Server token setup

The GitHub secret is available only inside GitHub jobs. Add the **same** Analytics
Token as an encrypted Cloudflare Worker secret named `UPSTOX_ACCESS_TOKEN` on
`sattva-central-research`. Do not add it as a plain-text variable. The Worker reads
this secret only on the server; public status exposes only whether it is configured.
The existing post-merge bootstrap arms both independent timers after publishing.
Without the Worker secret, the 15-minute fallback remains active and Sources says
that the primary feed awaits its server token. Saving the secret is a production
configuration action and requires the user's authorization; tests use local fixtures.

Renew this secret **and** the GitHub secret when the one-year token is replaced.
No additional paid Upstox subscription is introduced. Existing Cloudflare storage,
request and execution allowances still apply.

## Fallback collection and delivery

- `breakouts-refresh.yml` requests a run every 15 minutes. The collector only
  requests market data during regular-session collection hours (09:15–16:15 IST),
  with the published 2026 NSE holidays excluded. The first scheduled run also
  seeds the latest closing observations outside market hours and retries incomplete
  seed manifests. Successful closing observations are reused with their original
  source/check times; only missing/stale quotes or missing breakout bases spend
  more provider requests. A fresh closing price alone cannot complete the seed.
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
  queued/running or a collection run was recently created. Timer-originated runs
  carry the fixed `Breakout capture · durable-timer` run name and use the stored
  dispatch time for their next interval, so GitHub's creation delay cannot drift
  the cadence. Independent scheduled/manual runs defer the alarm only for the
  remainder of their 15-minute interval. GitHub's creation delay must not turn
  each timer interval into a 30-minute capture gap.
  Queued/running captures suppress duplicate dispatches and recheck after one
  minute, including a run that starts between the timer's two GitHub checks.
  Successful push-only
  bootstrap jobs are not counted as price collection. This uses the existing `GH_DISPATCH_TOKEN`
  and requires no additional Cloudflare cron slot. Reads never activate it.
- GitHub OIDC permits writes only from the fixed repository, main branch and
  this workflow. No browser credential or long-lived upload secret is needed.
- Yahoo Finance is the fallback quote/history source. Eight requests run at once;
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
- Visible dashboards read the saved capture every 15 seconds and on focus/return or
  reconnect. Daily data revalidates every 15 minutes and on return when due.
  Public capture responses share a five-second edge cache to reduce database reads;
  the health endpoint remains uncached. Browser reads do not spend Muns quote requests. An already-open popup updates
  with the table. Search, selected chips, sorting and scroll are retained during
  capture refresh. The service-worker release is advanced for returning readers.
  A completed daily close takes precedence over an older intraday observation of
  the same date. Extra captured targets appear only in their selected scope;
  watchlist-only additions do not silently join Universe.

## Upstox token and fallback-job backup

Upstox documents its [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/)
as free, read-only and valid for one year. No static IP is required for market
quotes/history. Configure the token as the GitHub Actions secret
`UPSTOX_ACCESS_TOKEN`; set the repository variable `UPSTOX_BACKUP_ENABLED=true`
only after the account and permitted customer-data use are confirmed. This controls the optional backup inside GitHub jobs; the primary minute feed
uses the separate Worker secret described above. No paid subscription is requested by this change.
Do not paste the token into issues, PRs, chat, browser storage or committed files.

The [full-quote endpoint](https://upstox.com/developer/api-documentation/get-full-market-quote/)
accepts batches of up to 500 mapped instruments. It supplies last
price, cumulative volume and last-trade time. The official NSE/BSE cash-market
instrument lists include SME shares, REITs and InvITs, not just the NSE EQ series.
NSE symbols use the existing exact SME/explicit symbol aliases; numeric BSE
tickers match the BSE exchange code. The returned symbol and instrument key must
both match the selected instrument. Verified portfolio ISINs take precedence over
symbols so an issuer rename can resolve without guessing from its name. A conflicting
ISIN never falls back to an unrelated symbol. Shared instruments preserve each
canonical target without duplicating the requested quote key.
Ambiguous mappings and cross-exchange guesses
are refused. A failed exchange list does not discard the other exchange's quotes.
The health artifact names each unavailable instrument list under
`upstoxInstrumentFailures`, separately from genuine unmapped identities. A later
quote-batch timeout retains successful earlier batches.
Previous close is
derived from `last_price - net_change`, rather than confusing today's OHLC close
with the previous close. Missing 30-session bases can be fetched from the
[historical daily candle endpoint](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/).
Provider failure, expiry, unmapped symbols and insufficient history remain visible
as incomplete coverage. A free source does not establish an uptime guarantee or
customer redistribution permission.

Fresh Yahoo quotes that lack a base also enter the backup history lookup. Their
price and volume are retained if that lookup fails; a supplied base enriches the
primary observation before its first checkpoint, without rewriting saved history.
This also applies to retained closing observations missing a base after hours;
their price, volume and original source/check times remain unchanged.
With no backup token, missing closing bases retry the primary history instead,
within the same budget and rate-limit guard. A failed history request retains the
usable closing observation and continues to report its missing base.

The user configured the Analytics token on 16 September 2026 with a one-year
validity. Renew before the expiry shown by Upstox (expected around 16 September
2027): generate a replacement in [Upstox Apps](https://account.upstox.com/developer/apps#analytics),
then replace `UPSTOX_ACCESS_TOKEN` in
[repository Actions secrets](https://github.com/techmuns/Sattva-Central-Research/settings/secrets/actions).
Keep `UPSTOX_BACKUP_ENABLED=true`. A saved secret alone does not verify the token;
check the next capture's backup result and actual saved Upstox observations.

## Freshness, completeness and history

Freshness uses the quote's own exchange-session date and source time. During the
session, observations older than 20 minutes are stale. Afterward, an earlier
intraday print is not accepted as a closing observation. A base, price and volume
must all be present for a company's breakout check to count as covered. The
latest run must complete its entire manifest; discovery failures and calendar
uncertainty prevent a complete-coverage claim.

Every acknowledged fallback quote is retained separately from the latest-quote index.
Detailed primary minute quotes use the four-day policy above; detected breakout
changes survive that expiry.
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
- `/api/breakouts/fallback`: the persisted fallback capture used by GitHub closing
  checks and recovery; healthy minute quotes cannot suppress fallback retries.
- `/api/breakouts/health`: 503 for missing/partial/stale current coverage or an
  overdue timer; this is distinct from historical recovery completeness.
  `archiveStatus: incomplete`, `archiveIncomplete` and the archive counters disclose
  known history gaps even after prices recover. Sources remains partial and explains
  those gaps separately from current-price freshness.
- `/api/breakouts/history?ticker=...&before=...`: retained minute observations, breakout changes and existing fallback history with
  keyset pagination (100 per page, follow `nextCursor`), including recovered candles.

The response states separate minute/fallback capture starts, `minuteRetentionDays: 4`,
retained breakout changes and finite storage. No exhaustive pre-capture
archive is claimed. Source records are retained in the existing durable database;
30-day GitHub health artifacts are diagnostics, not the market-data archive.
This change adds no paid product, but cannot promise infinite free storage or
ignore existing platform quotas. Storage failures surface as failed checkpoints.

## Validation and operations

Local tests cover dates/holidays, stale quotes, missing bases, failure retention,
large inventories, four-day expiry, retained breakout changes, dictionary collision
safety, current-reader isolation from history, rate-limit stopping, fallback mapping/history, signed OIDC,
replay, history pagination, interrupted recovery and delayed-run dispatch. A real
local workerd test restarts between checkpoints and verifies SQLite/history/alarm
persistence. Browser tests cover automatic updates, the open popup, future
holdings, filters/search, outage retention and a returning service-worker session.

Deploy through the repository's normal merge pipeline. Verify the actual
production API and asset release separately from GitHub's fallback Deploy status:
that workflow can succeed while its publishing job is skipped. This implementation
and its local tests do not certify production activation or Upstox credentials.
Manual deployment or production-run dispatch requires explicit authorization.

## Individual quote gaps: 21 September 2026

The follow-up audit of all ten failed identities found different causes:

| Company / stored identity | Finding and treatment |
| --- | --- |
| CHOLAFIN, MOTHERSON | Upstox's NSE cash master contains both EQ shares and D1 bonds under each symbol. Preserve `instrument_type` in the streamed master and index eligible share / SME / trust series only. Ambiguous equity identities still fail closed. |
| Dhoot Transmission (`ID`) | `/company/id/1286088/` is a Screener website ID, not an exchange symbol. Its page explicitly links NSE `DHOOTTRANS`, matching Upstox ISIN `INE01NH01023`. One reviewed URL resolver serves the universe adapter, daily scraper, reader and capture inventory. Unknown numeric website IDs never become `ID` targets. Existing daily error rows are resolved while the next scheduled daily scrape catches up. |
| BENGALASM | The observed NSE quote was old. Use verified BSE code `533095`, ISIN `INE083K01017`, consistently for quote requests and future history. Yahoo's corresponding symbol is `BENGALASM.BO` (its numeric-code URL returns 404). Never copy NSE volume/base history into a BSE quote. |
| VERTIS, NHIT, 543225 (Altius), 504375 (IDream) | These instrument identities exist. Keep the provider's feed-update timestamp separate from its last-trade timestamp. A fresh zero-volume session can have an older last trade; it must not manufacture today's breakout. A stale/missing provider timestamp or conflicting session volume remains a gap. Yahoo's verified BSE aliases `ALTIUSINVIT.BO` and `IDREAM.BO` restore available history for the numeric targets while Upstox retains exact BSE-code matching. Actual quote availability is verified after the automatic deployment, not inferred from successful mapping. |
| JBCHEPHARM, FCONSUMER | Both appear in Upstox's suspended-instrument master. Read that public file only when normal mapping leaves unresolved targets, cache it with the daily mappings, and report `suspended` rather than `unmapped`. The daily refresh automatically rechecks availability. Keep company/history rows; never substitute another company's price. |

Evidence: [Upstox instrument files](https://upstox.com/developer/api-documentation/instruments/),
[full-quote timestamp definitions](https://upstox.com/developer/api-documentation/get-full-market-quote/),
[Dhoot's Screener identity](https://www.screener.in/company/id/1286088/consolidated/).
All master-file observations above were read on 21 September 2026.

`feedAt` is optional for backwards compatibility. It is sourced only from Upstox,
never replaced with the request/check time. `quoteAt` always remains the original
last-trade time. Cross-session feed observations require zero current-session volume;
a newer completed daily close wins over an older trade. The compact minute archive
stores the changing feed timestamp in its tuple, keeping one shared metadata record
instead of duplicating it every minute. Returning sessions receive this change through
the service-worker release increment. No new main-page explanatory banner is added.

Production verification exposed a retained-store handover case: the last NSE trade
was later than BSE's last trade, so the old monotonic-trade guard rejected valid BSE
observations after the reviewed mapping changed. Both primary and fallback stores
now compare collection time when the exchange changes, while keeping the original
last-trade ordering within the same exchange. Delayed old-venue responses cannot
restore the previous exchange. Quote freshness still uses provider timestamps,
never collection time; both venues' original observations remain in history.
