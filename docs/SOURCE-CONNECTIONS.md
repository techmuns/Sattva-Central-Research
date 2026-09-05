# Research connections

The customer source panel and Sources modal share `public/js/ui/sources.js`. This registry is presentation metadata only: opening it never fans out to upstreams or dispatches capture jobs.

## Inventory

News has a dedicated family, with separate entries for Muns company search, TradingView portfolio headlines, global company/related-entity discovery, reviewed official IR pages/documents, Moneycontrol, Business Standard, Mint, Economic Times and Investing.com. The publisher entries replace the previous combined row. X portfolio-wide search is distinguished from followed accounts; Screener operating insights is listed in Earnings & filings.

Roadmap-only integrations and credential implementation details are not counted as connected data sources. Existing sources remain listed when a read fails. Derived calculations and manually refreshed reference data are not called automatic captures. The launcher, connection count and group counts are derived from the current registry, including changing X accounts.

## Connection presentation

`source-connections.js` keeps collection configuration separate from successful recent checks:

| Evidence | Customer label | Pulses |
| --- | --- | --- |
| Recent successful check, online | Connected | Yes |
| Configured automatic collector, no verified check | Scheduled / Ready to check | No |
| Expired source check | Refresh due | No |
| Retained copy not confirmed this visit, or offline | Saved copy | No |
| Failed source read | Connection paused | No |
| Incomplete source coverage | Partial coverage | No |
| Reader-triggered lookup / reference / calculation | On request / Reference data / Computed | No |

Labels do not rewrite source health, invent success timestamps, hide configured failing sources, or treat a successful file download as a complete portfolio sweep. Publication dates, source-check timestamps and collection times remain separate. Source details preserve coverage limitations, retry states and upstream evidence. A successful X account capture does not verify all company-name searches.

The panel refreshes connection age in place every 15 seconds; the closed launcher every minute. Online/offline and shared feed events update it too. Focus, scroll and expanded details survive status changes. Reduced-motion preferences are respected. These clocks read already-loaded metadata and do not add source requests.

## Operational checks

The existing half-hourly `Filings operational health` workflow now performs three independent read-only checks:

1. Published filing capture coverage and recovery state.
2. Independently published TradingView news, with the existing 45-minute freshness contract.
3. Scheduled GitHub workflows plus Verify and Deploy, using the workflow files currently present in the repository. Removed workflow catalog entries are excluded. Disabled workflows, failed latest completed runs, missing initial runs, long-running jobs and missing successful captures are reported.

The workflow checker interprets this repository's five-field UTC cron expressions, allowing two hours for GitHub queueing/collection and respecting weekday-only schedules. This grace is not a freshness guarantee and does not replace the tighter published-data checks. Unsupported schedules or an inaccessible GitHub API fail visibly instead of claiming health. The health workflow excludes itself from the run audit to avoid a self-referential failure loop. Reports are retained as job artifacts and summaries; notifications depend on GitHub notification settings. No production run is automatically dispatched, restarted, cancelled or retried by this watchdog.

The daily technicals publisher now stages and archives `price-move-checks.json`, which `scrape-technicals.mjs` already writes. Leaving it unstaged caused the otherwise successful collection to fail on rebase when main advanced. Its existing `data-refresh` concurrency group remains shared with price verification, and checkout starts from current main. A disposable-Git regression exercises the actual staging block and rebases over an unrelated source update without touching production.

## Verification and limits

Local contract tests cover registry inventory, publisher parity, unknown/stale/failed/offline states, scheduler gaps and API failures. Browser fixtures exercise actual feed loaders and production CSS, source recovery, retained evidence, keyboard focus, responsive layout and absence of presentation-triggered data reads. The existing IPO regression still tests failed sources and retained documents.

The read-only production audit on 5 September 2026 found older failed daily-data and Screener Insights runs, plus no initial independent TradingView run yet. The daily-data fix is in this change; the Insights fix had already merged separately. These are not declared recovered until an actual subsequent run and published-data check confirm them. Upstream Muns 404 coverage gaps and optional X access require genuine source recovery, not a presentation change. GitHub schedules are best-effort; this work does not promise every news item or continuous zero-latency publication.
