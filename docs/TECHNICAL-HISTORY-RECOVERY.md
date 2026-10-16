# Technical history recovery

Live prices and indicator history are separate inputs. The minute collector owns Upstox quotes;
Yahoo completed daily bars supply RSI, MACD and averages. A fresh quote remains visible in the
scanner, scan coverage and exports even while its history is pending. A pending filter never passes.

`technical-history-recovery.yml` runs on standard public-repository GitHub Actions runners. It
follows daily refresh and quote-run completion, has a half-hour weekday schedule, and starts after
recovery-code changes merge. It calls public Yahoo charts only: no broker token, paid provider,
Cloudflare collection job or new Cloudflare storage. Existing repository-pinned daily delivery
publishes repaired rows without requiring a deployment for each history update.

Only outdated, failed, legacy or exchange-mismatched rows are fetched. Each request is at least two
seconds apart; one walk uses at most 300 requests or ten minutes. Current rows are reused, and an
unfinished walk resumes from per-company receipts. The durable public
`technical-history-recovery.json` records retry times and provider cooldowns across runner restarts.
403/429 ends a walk immediately and honors Retry-After with at least an hour's cooldown. Ordinary
failures back off from 15 minutes to six hours; short listing histories are checked on the next
completed session. The full daily scrape also respects the saved provider cooldown, paces requests
and retains previous rows on failure. The three technicals writers share workflow concurrency.

Recovery reuses the daily scraper's indicator functions and full long-history query rather than
splicing new prices into rounded RSI state. Today's unfinished bar is excluded until 16:00 IST.
Calendar holidays, source symbols, ordered unique dates, exchange identity and the required last
session are checked. Old move-verification receipts cannot confirm a newly recovered close.
An index outage does not block momentum; prior index-relative evidence remains separately dated
while unavailable current index-dependent inputs stay null.

No scheduler, unofficial source or broker can guarantee uninterrupted data. Failed and incomplete
rows retain their actual source dates and explicit coverage. New listings may genuinely lack
200 daily or 15 monthly closes; suspended listings may have no tradable live quote. The existing
120-session adjusted-close snapshot is a bounded research window, not an exhaustive price archive.
Recovery can retrieve still-available source history; it does not reconstruct missed minute ticks.

Verification: `verify-technical-recovery.mjs`, `verify-momentum-reliability.mjs`,
`verify-momentum-scanner-ui.mjs` and `verify-momentum-upgrade-ui.mjs` cover repair, refusal cooldowns,
interruption/resumption, saved evidence, accurate live display, exports and a warm service-worker
upgrade. Production verification remains read-only; do not dispatch a production run manually
without the user's authorization for that action.
