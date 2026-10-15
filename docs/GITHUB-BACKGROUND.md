# Background processing on GitHub

The 15 October 2026 budget instruction keeps Cloudflare as the website delivery layer. Collection, scheduled calculations and retained job state belong on standard GitHub Actions runners and GitHub storage. Request-time authentication and delivery of prepared private files must preserve existing access rules.

## Telegram

The existing ten-minute GitHub schedule owns collection. Its verified Actions checkpoints carry source cooldowns and account safety pauses; the existing archive workflow retains history. This change neither resumes paused source access nor changes collection allowances.

Cloudflare no longer arms or runs the Telegram dispatch alarm. An alarm from an older deployment deletes its recurrence without dispatching, retaining its previous state. Status and refresh inspect the fixed main-branch GitHub workflow directly. Recent runs suppress an extra request; the existing execution concurrency group remains the source mutex. Requests from preview hosts cannot start production capture, and GET never starts work.

The edge caches short request acknowledgements. It does not hold the scheduler's durable state. GitHub scheduling is best effort: the API reports actual run times and stalled or failed runs rather than promising an exact next start. The health check still assesses source freshness, safety pauses and failed or delayed runs, but a GitHub schedule does not require a Cloudflare alarm.

## Private Screener summaries

The existing thirty-minute GitHub workflow owns portfolio discovery, catalogue
readiness and summary capture. It uses the existing account and opt-in settings;
the sixty-attempt rolling-day ceiling, fifteen-second source spacing, source
refusals and cooldowns are unchanged. The dependency check preserves the original
half-freshness dispatch window and records a dispatch intent on GitHub before
requesting the public catalogue workflow. An ambiguous dispatch is not retried
as a new source job on each status poll. Invalid, overdue or unverified catalogue
checkpoints cannot authorize a premium summary request.

The first runner copies all four summary tables, original rowids and the timer's
dispatch claim through the fixed-workflow OIDC read-only export. Existing ready
bodies, interrupted attempts, day-long retry holds and older inactive records
remain. A changed, incomplete or inaccessible inventory blocks publication.
Cloudflare summary collector writes are rejected and its old alarm deletes itself.
No manual production source request is used for migration validation.

Each reservation is recorded locally and acknowledged in an encrypted GitHub
restart bundle BEFORE the collector may sign in or open a metered summary page.
An interrupted runner therefore consumes its original attempt instead of resetting
the daily allowance. Failed publication stops all further source requests in that
process. Completion and refusal states are published before another reservation.
The `summary-data` release retains complete encrypted databases and individually
encrypted reader files. The existing static deployment installs reader envelopes
only. Plain source text, source IDs/routing and portfolio identities never enter
public repository files or diagnostic artifacts.

The private API still verifies the caller against its existing summary-reader
policy before reading static files. It returns `private, no-store`, preserves exact
source IDs and deferred eligibility, and re-ages saved discovery times. An absent
first publication may read the retained legacy source; corrupt existing prepared
files fail visibly. The coverage UI describes GitHub's best-effort schedule without
inventing a Cloudflare alarm. A warm service-worker fixture verifies the revised
modules reach an already-open session. Background state uses the same existing
repository secret supplied to MF, with a distinct feature/repository HKDF context.
Do not rotate that secret without preserving and re-encrypting retained state.

## Remaining transfer work

Mutual Funds has its separate encrypted retained-state transfer and prepared reader snapshots documented in `GITHUB-MUTUAL-FUNDS.md`. Telegram's small scheduling change must not be presented as migrating the remaining engines:

- Breakouts: the minute Upstox collector, fallback history, recovery gaps and source identity mappings.
- Family price levels: interactive edits, tombstones, live quote checks and the hit ledger. Moving the checker cannot overwrite new edits or lose previously recorded hits.
- Newsletter: private recipients and settings, content queue, provider budgets, edition claims, delivery acknowledgements and saved documents. An unknown delivery must not be retried as an unsent email.

Each transfer needs read-only verified history import, encrypted public-repository storage where applicable, local/staging failure tests, live reader verification, and retirement of its old recurrence. A source or credential failure must remain visible instead of turning into empty successful data. Existing Cloudflare history must not be deleted as part of migration. No paid runner, new provider or external API spending is a fallback for unavailable free tooling.
