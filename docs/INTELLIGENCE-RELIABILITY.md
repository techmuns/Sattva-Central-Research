# Research data reliability

## Standing product requirement: current on opening, no silent data loss

On 6 September 2026 the user established this requirement for the entire dashboard:
opening the app should show up-to-date information, and data must not be silently
missed as time advances. The user explicitly included both **NSE Filings** and
**Insider Trades**, covering bulk deals, block deals, SAST and insider disclosures.
It applies to all tabs and to Portfolio, Watchlist and Universe.

This is an acceptance requirement for ongoing work, not a statement that every
existing feed already satisfies it. Cached data may paint immediately while the
app checks for updates, but its age and incomplete checks must remain truthful.
“Current” means checked against the configured source within its documented
publication and collection cadence; end-of-day and periodic feeds retain their
actual as-of dates. A new publication is not required for a successful check.

Future data and UI changes must preserve these criteria:

| Area | Required behavior and evidence |
| --- | --- |
| Opening and returning | Revalidate relevant feeds automatically on first open, revisiting a stale view, resuming after sleep and reconnecting. Continue checks while visible at the source's documented cadence; preserve usable rows, searches and filters while updating. |
| Collection without readers | Scheduled or durable collection continues with no dashboard open. A browser poll or demand-triggered watchdog alone cannot establish continuous coverage. Verify successful source reads and that captured data reaches the reader-facing endpoint. |
| Coverage | Track successful reads separately for required sources, companies, categories and pages. All four Insider Trades categories must be accounted for. Distinguish a verified empty result from an unchecked, failed or partial result; retain unresolved identities for reconciliation. |
| Recovery | Persist progress and retained records across interrupted runs. Re-read an overlapping interval or resume pagination to reconcile missed and late-arriving records wherever upstream history allows. Mark an unrecoverable interval as a gap. |
| History | Merge and deduplicate without losing distinct events or later corrections. Navigation, date rollover, filtering, a bounded first page and refresh failures must not delete retained shared history. Make archive coverage and any retention limits explicit. |
| Honest status | Keep connection, last successful source check, source publication time and archive coverage distinct. A cache read, deployment, job start or successful subset must not advance the source's success timestamp or hide a newer failed attempt. “Up to date” requires successful, sufficiently recent checks of the relevant coverage. |
| Failure handling | Keep the last good rows during an outage, indicate stale/partial/unavailable coverage accurately, and retry through the configured collection policy. Detect overdue or incomplete collection independently of a user's visit. |

When implementing or changing these paths, verify locally or in staging the
relevant cases: a new record after initial load, reopening after inactivity, an
interrupted collection followed by recovery, a failed source/category/page,
source responses with zero new rows, date rollover and records outside the initial
display window. Successful checks must retain old evidence and expose new records;
partial checks must remain visibly partial. Repository CI and a healthy connection
alone do not prove complete upstream coverage.

The known limits in [Filings operations](FILINGS-OPERATIONS.md) still apply. NSE's
latest-window feed and best-effort scheduled captures do not establish a complete
exchange archive. Finite retained windows and upstream availability must remain
explicit until a verified collection/backfill path closes the gap. This rule does
not itself change production schedules, start captures, provision monitors or
certify that no records have been missed.

## Alert evidence retention

Material, company-attributed portfolio news and linked exchange disclosures remain eligible for
AI Alerts throughout the existing 14-day window. Recency still reduces their ranking score;
retention alone cannot create a Must see priority. A failed refresh does not retract known evidence.
Routine news, unresolved identities, undated rows and context-only records have no retention bypass.

The public 14-day alert window persists in IndexedDB and is re-scoped and re-aged on reload.
First useful evidence can paint while remaining feeds, operating context and private holding
sizes are still being checked. An early empty partial cannot block later cards or a delayed cache
read. Partial refreshes add new material arrivals while retaining previously visible companies and
evidence the unfinished sources have not revalidated yet. Source-change notifications update the
open view from loaded data without another network fan-out. Portfolio invalidation cancels
outstanding cache adoption, and a verified position snapshot removes exited companies immediately.
Private sizes and document records never enter the public alert cache. If browser storage is
unavailable or cleared, the first visit must read the sources again.

AI Alerts defaults to **Newest first**, using the latest noteworthy source event's IST date/time.
Routine observations and refresh timestamps cannot make an older material event new. That event
leads the evidence preview even when older evidence has a higher score. **Largest holdings** and
**Highest priority** are explicit local sort choices; only the choice persists, never private sizes.
Receiving holding weights cannot silently switch the selected ordering. Size sorting falls back to
newest evidence when complete valuations are unavailable. Period-only source dates remain period-only.

Family's position reader revalidates the shared workbook catalog and reuses the adopted book when
its revision is unchanged. Changed revisions must be adopted before a positions reply. Workbook
weights do not wait for live quotes, historical archive reconstruction or a model; the existing
question-answer path still verifies its quote batch. Replies retain the workbook period, check time,
valuation basis and source revision. A checked workbook is not a live broker connection.

An archived card represents the material evidence already read. New material evidence or a changed
headline/direction restores it even if an older event remains strongest. Reordering, routine arrivals
and old events leaving the window do not restore it. Mutes expire after 14 days even in an open
tab. Old single-event mutes cannot suppress the new evidence-set representation.

`filing-signals.js` applies the same materiality rules to BSE and NSE. Explicit investor/analyst day
and presentation disclosures are neutral research events; a notice never claims the event occurred.
Generic meeting intimations and AGM notices remain routine. Only NSE rows with a company ticker,
date and source link can initiate an alert. BSE/NSE use one exchange-disclosure source family for
corroboration, and duplicate links/subjects are counted once.

## Operational checks

The existing read-only `/api/filings-health` endpoint and half-hourly health workflow now inspect
the permanent company-news index. Every active legal-name and alias query is checked, including
companies without NSE tickers. Missing checks, failed authentication, failed/newer unfinished
attempts and checks older than four hours are critical. An empty successful result is valid;
an updated index or retained archive cannot conceal missing queries. Historical archive size is
not treated as proof of current coverage.

The company-news workflow saves captured progress before running its health gate. An incomplete
capture consequently retains its useful history and fails the operational check. Reports contain
controlled diagnostic codes and identity keys, never upstream credential/error bodies. The health
endpoint reads static assets only and returns HTTP 503 for critical core-source findings. GitHub
notification delivery still depends on the operator's notification settings and scheduler; there
is no new customer notification channel or guaranteed delivery SLA.

## Optional X coverage

Scheduled X sign-in is disabled unless repository variable `X_CAPTURE_ENABLED` equals `true`.
Disabled runs skip Python installation and login. The existing handle list and posts are retained.
This is an explicit operational opt-in, not a connection claim. No paid API, proxy or account
rotation is provisioned. An official authorized API can be integrated separately if required.

`record-twitter-status.mjs` writes optional collection status separately from `capturedAt` and the
posts. Failed sign-ins do not refresh the data timestamp, erase posts, or mark monitored accounts
as nonexistent. Repeated disabled runs do not churn timestamps. The existing source metadata
reports the unavailable connection; the dashboard layout is unchanged. X findings are warnings
and cannot make the core health endpoint fail. Coverage is limited to captured monitored accounts;
it is never represented as all discussion about portfolio companies.

## Local regression checks

Run `node scripts/verify-alert-reliability.mjs`, `node scripts/verify-filings-health.mjs`,
`node scripts/verify-ai-alerts.mjs` and the existing General Alerts tests. The browser suite
`scripts/verify-ai-alerts-ui.mjs` checks new-evidence restoration, loading, failed refreshes,
navigation, date rollover and portfolio synchronization using local fixtures.

These checks test data handling and failure detection. They do not prove exhaustive upstream news
coverage or delivery to any separate Morning CIO product.
