# Research data reliability

Material, company-attributed portfolio news and linked exchange disclosures remain eligible for
AI Alerts throughout the existing 14-day window. Recency still reduces their ranking score;
retention alone cannot create a Must see priority. A failed refresh does not retract known evidence.
Routine news, unresolved identities, undated rows and context-only records have no retention bypass.

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
