# Background processing on GitHub

The 15 October 2026 budget instruction keeps Cloudflare as the website delivery layer. Collection, scheduled calculations and retained job state belong on standard GitHub Actions runners and GitHub storage. Request-time authentication and delivery of prepared private files must preserve existing access rules.

## Telegram

The existing ten-minute GitHub schedule owns collection. Its verified Actions checkpoints carry source cooldowns and account safety pauses; the existing archive workflow retains history. This change neither resumes paused source access nor changes collection allowances.

Cloudflare no longer arms or runs the Telegram dispatch alarm. An alarm from an older deployment deletes its recurrence without dispatching, retaining its previous state. Status and refresh inspect the fixed main-branch GitHub workflow directly. Recent runs suppress an extra request; the existing execution concurrency group remains the source mutex. Requests from preview hosts cannot start production capture, and GET never starts work.

The edge caches short request acknowledgements. It does not hold the scheduler's durable state. GitHub scheduling is best effort: the API reports actual run times and stalled or failed runs rather than promising an exact next start. The health check still assesses source freshness, safety pauses and failed or delayed runs, but a GitHub schedule does not require a Cloudflare alarm.

## Remaining transfer work

Mutual Funds has its separate encrypted retained-state transfer and prepared reader snapshots documented in `GITHUB-MUTUAL-FUNDS.md`. Telegram's small scheduling change must not be presented as migrating the remaining engines:

- Breakouts: the minute Upstox collector, fallback history, recovery gaps and source identity mappings.
- Private Screener summaries: request reservations, paid-view allowance, refusals, cooldowns and private summary history. Reservations must survive a runner interruption before provider I/O.
- Family price levels: interactive edits, tombstones, live quote checks and the hit ledger. Moving the checker cannot overwrite new edits or lose previously recorded hits.
- Newsletter: private recipients and settings, content queue, provider budgets, edition claims, delivery acknowledgements and saved documents. An unknown delivery must not be retried as an unsent email.

Each transfer needs read-only verified history import, encrypted public-repository storage where applicable, local/staging failure tests, live reader verification, and retirement of its old recurrence. A source or credential failure must remain visible instead of turning into empty successful data. Existing Cloudflare history must not be deleted as part of migration. No paid runner, new provider or external API spending is a fallback for unavailable free tooling.
