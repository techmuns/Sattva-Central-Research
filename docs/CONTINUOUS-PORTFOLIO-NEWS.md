# Continuous portfolio news

TradingView is additive public-headline discovery, not an exhaustive or guaranteed real-time stream.

- `tradingview-news-refresh.yml` targets minute 7, 22, 37 and 52 of every hour, seven days a week. An eight-minute collector budget and independent concurrency keep slow core/global searches out of its path. It starts from current `main`, not an older queued event SHA.
- Every run resolves the active portfolio. Newly verified exchange symbols enter the fair queue; exited holdings stop polling while their history remains archived. Failed portfolio verification retains the last known book and reports that new additions may be unknown.
- Requests are serial and spaced. A 401/403/429 stops the source-wide walk and persists backoff before reporting failure. No alternate accounts, regions, endpoints or subscription bypasses are used.
- Only `public/data/tradingview-news/` is published by this workflow. The portfolio checkpoint, monthly append-only archive, source checkpoints and recent `latest.json` share that isolated write set. The slower news workflow owns its original files. This avoids cross-workflow overwrites and serial queues behind long search walks. Initial migration copies previously archived TradingView observations without deleting the old archive.
- News, All Alerts and AI Alerts consume the same merged feed. One extra first-party snapshot is read alongside the original `news.json`. Open visible consumers revalidate the two snapshots every two minutes; there is no client-side company fan-out or automatic workflow dispatch. Hidden/unmounted readers stop polling, but server capture continues independently.
- Empty or failed reads preserve retained news. Source story IDs, canonical URLs and same-publisher headlines deduplicate within each company. Source timestamps and core-search timestamps remain distinct; a fresh TradingView capture cannot make a stale core search appear fresh.
- Capture and oldest successful symbol sweep become critical after 45 minutes. Failed/blocked reads, unavailable publication and unverified portfolio membership also need attention. Missing mappings, restricted headlines and possible bounded-window gaps remain explicit limitations.
- The collection workflow publishes partial progress before its health gate. The existing read-only `filings-health.yml` watchdog independently checks the deployed TradingView snapshot every half hour, even when another source-health step fails. GitHub failure notifications depend on operators' notification settings; no new email/Slack delivery is claimed.

## Limits and operations

GitHub's scheduler and the existing deployment pipeline can delay publication. The public source has a bounded latest-news window and no observed public pagination cursor; rapid news bursts or upstream omissions can still create gaps. Detected gaps stay recorded, not cleared by the next quiet poll. More frequent collection is risk reduction, not a promise that every story has been seen.

Read `data/tradingview-news/latest.json` for published coverage and `data/tradingview-news/tradingview.json` for per-symbol checkpoints, errors and backoff. `node scripts/check-tradingview-news-health.mjs` checks a local snapshot; setting `FILINGS_HEALTH_BASE` reads a deployed snapshot without dispatching anything. A production retry/manual dispatch still requires explicit authorization. Scheduled recovery is automatic.

Tests: `node scripts/verify-tradingview-news.mjs` and `node scripts/verify-continuous-news.mjs`. Both use synthetic upstream responses and temporary local data only.
