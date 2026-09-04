# Filings operations

Capture health must be checked without waiting for a customer to open a tab. This is an
operational signal for the three filing sources; it does not certify the entire dashboard or
guarantee exhaustive provider data.

## Detection

- Each BSE and company/insider capture workflow runs `scripts/check-filings-health.mjs` **after**
  its existing data-publication step. Critical findings fail the workflow while collected rows and
  retry checkpoints remain saved. Each run includes annotations, a summary and a JSON artifact.
- `filings-health.yml` checks the published captures every 30 minutes with read-only requests.
  It can detect a capture workflow that did not finish or whose data did not reach the site.
- `GET /api/filings-health` provides the same assessment for an external uptime monitor. It reads
  only committed assets, caches the report for 30 seconds, and never starts a capture or calls a
  provider. HTTP 503 means a critical incident; HTTP 200 may still include `status: degraded`
  warnings. The report includes bounded company samples; the capture manifest contains every
  affected company.

The endpoint and scheduled checks become available after the specific PR is approved for merge
and deployed. They have not been activated in production by this change.

## Current thresholds

| Signal | Classification |
| --- | --- |
| Expired/missing credentials, failed reads, partial parses, BSE pagination shortfalls | Critical immediately |
| BSE capture or company capture job older than 4 hours | Critical |
| Insider capture older than 36 hours, failed or unfinished company reads | Critical |
| A company source check older than 48 hours | Critical |
| Registered company still never checked after 24 hours | Critical; warning during the initial capture period |
| Missing or malformed capture, invalid/future timestamp, inconsistent row counts | Critical |
| Historical backfill pending, unresolved identity, source-null document link | Warning |

The 24-hour initial period is anchored to the company's registration or the capture's fixed
creation time. A newly finished run cannot reset it. An up-to-date job timestamp also cannot
hide a failed or overdue company read. Limits live in `public/js/data/filings-health-shared.js`.

These are the initial detection thresholds, not a promise that new filings appear within them.
The company sources are currently rechecked on a daily cycle within the resumable capture job;
BSE's date capture supplies the more frequent exchange-wide view.

## Responding to a critical incident

| Finding | First action |
| --- | --- |
| `authentication-failed` | Check the provider credential on the Worker; rotate it through the approved secret-management process. |
| `source-read-failed` or `partial-source-response` | Inspect the named source/company in capture logs and compare its response contract; retain earlier rows. |
| `capture-job-overdue` or `capture-overdue` | Check scheduler dispatch, run history and publication status. A successful local capture is not proof of publication. |
| `company-never-checked`, `company-check-overdue` or `company-reads-incomplete` | Inspect the queue, rate limits and company identity. Confirm a successful retry against the affected companies. |
| `pagination-shortfall`, `unknown-source-categories` or `row-count-mismatch` | Inspect parser/pagination behavior before claiming complete exchange coverage. |

Recovery requires a successful source read and a clean assessment of the affected signal. Do
not clear failures, remove affected companies or replace missing data with examples to turn the
monitor green. Production retries, configuration changes and deployments require the user's
specific authorization under the repository workflow.

## Alert delivery still required

GitHub workflow notifications depend on each operator's notification settings. No Slack, email
or on-call recipient is configured by this change. A named recipient and escalation owner must
be selected, and delivery verified, before claiming that the team will be notified.

GitHub's scheduler has previously stalled for this repository. The separate health workflow is
another detector on the same scheduling platform; it is not an independent availability
guarantee. An external monitor should check `/api/filings-health` on a separately configured
cadence, notify on critical status transitions and notify on recovery. Avoid repeated identical
pages for a persistent incident. No external monitor or message has been provisioned/sent here.

Document URLs are retained and source-null slots are reported, but remote PDF availability is
not probed by this health endpoint. A publisher deleting or restricting a previously valid PDF
therefore needs separate link monitoring. Source omissions, browser-only company additions,
unresolved identities and the unconnected consensus feed remain explicit coverage gaps.

## Verify locally or in staging

```sh
node scripts/verify-filings-health.mjs
node scripts/check-filings-health.mjs company insider
FILINGS_HEALTH_BASE=http://127.0.0.1:8787 node scripts/check-filings-health.mjs
```

The health command exits 1 for critical findings and 0 for healthy/degraded reports. Optional
`FILINGS_HEALTH_REPORT` writes JSON; `GITHUB_STEP_SUMMARY` receives a readable summary in Actions.
The command only reads captures and writes its report; it cannot retry or mutate a production run.
