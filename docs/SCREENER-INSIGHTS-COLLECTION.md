# Gentle, resumable Insights collection

This change is limited to company Insights. It does not alter watchlist synchronization,
Con-call collection, portfolio membership, credentials, UI layout or collection schedules.

## Read policy

- Restore the newest trusted data checkpoint and operational state before starting a browser.
- During cooldown, make zero Screener requests. Copy the existing artifacts unchanged; do not
  advance the source check time or extend the cooldown simply because another job was invoked.
- Reconcile the complete watchlist/universe inventory, then read missing or due companies only.
  Portfolio records become due after 24 hours; other universe records after seven days. These
  are collection targets, not a freshness guarantee under an upstream outage or backlog.
- Never-read gaps lead, portfolio first on ties, then oldest due dates. Failed targets retain
  individual eligibility times, so one problematic company cannot monopolize every run.
- One company at a time; three seconds before each company, one second before its quarterly
  request; one attempt per run. No proxy, account rotation, saved browser session or login loop.
- Limit each run to 120 companies / ten minutes. Unstarted work remains deferred, not checked.
  `full=true` reconciles the inventory but does not override freshness or any cooldown.

## Failure behavior

| Diagnostic | Behavior |
| --- | --- |
| `rate-limited` (429) | Stop; default six-hour cooldown, increasing to at most 48 hours on repeated blocks. |
| `access-denied` (403) | Stop; default 24-hour cooldown, then up to 48 hours. |
| `session-expired` (401 / login redirect / missing authenticated marker) | Stop; default 24-hour cooldown, then up to 48 hours. No same-run re-login. |
| `source-unavailable` (5xx) | Stop; default one hour, exponentially increasing to at most 48 hours. |
| `structure-changed` / `identity` | Preserve old rows; individual target waits 24 hours. Three consecutive failures stop the run. |
| `timeout` | Stop with a one-hour pause; do not overlap an aborting page with another read. |
| `navigation`, `inventory`, `oversized`, `configuration`, `internal` | Controlled codes only, without exception text. Transient individual failures wait one hour; run failures pause one hour. |

A valid `Retry-After` is a lower bound: a later provider date wins even if it exceeds our default
48-hour cap. Invalid headers use the conservative default. Delays are persisted as absolute UTC
times, not sleeps that keep a runner occupied. Both company HTML and the lazy quarterly request
are checked; a refused quarterly request is not mislabeled as an absent table.

## Persistence and evidence

After each settled company, operational state and validated data are atomically written to local
gzip checkpoint files. State is written first so a subsequent data-write failure cannot erase a
rate-limit instruction. Workflow upload steps run even after ordinary collection failure. The
reader accepts digest-verified checkpoints from completed failed/cancelled runs, not just green
runs. A failure before the first company publishes state only; research remains unavailable.

The two immutable artifact names are `screener-insights-v1.json.gz` and
`screener-insights-state-v1.json.gz`, each retained for 30 days. A runner destroyed before upload
can still lose that run's unpublished work; the prior published checkpoint survives. Expired or
corrupt control artifacts fail closed rather than silently resetting a cooldown. No account HTML,
CSV exports, cookies, credentials, raw exception bodies or private holding values are published.

No-read runs retain the prior source timestamp. Each company's own check time remains distinct
from the operational attempt time. Failed company records remain failed until successfully
replaced; unvisited records retain their actual age. Existing Ask Research coverage carries the
collection reason and cooldown. Insights remains context-only, and no UI is added.

## Verification

`node scripts/verify-screener-insights.mjs` includes the actual restore/cooldown/login orchestration
with injected offline readers, multi-run resume, no-read cooldowns, exact Retry-After handling,
first-read failure, checkpoint retention, and failed-run artifact integrity tests.

`scripts/verify-screener-insights-ui.mjs` uses intercepted browser fixtures for export, company
HTML, quarterly 429/403/401/5xx, changed structure, closing timed-out pages and last-good cache
recovery. Existing AI Alerts, Ask Research and Con-call suites protect downstream behavior.

These tests establish failure handling, not live Screener throughput or complete company coverage.
No manual production collection or schedule change is part of this implementation.
