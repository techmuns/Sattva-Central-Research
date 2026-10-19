# Newsletter scheduling and the 19 October 2026 missed morning edition

Both desks were enabled for 08:00 IST and the subscriber lists included the
reported recipient. Sattva's last processing wake was 07:10:38 IST and Glow's
07:08:54 IST. Neither repository received another scheduled newsletter run by
10:23 IST; their deployed logs had no `2026-10-19:morning` claim or pending
delivery. The independent Monday monitor flagged both missing editions. Mailbox
search, including Spam and Trash, found no current edition. This was a missing
processing wake, before any recorded sender attempt.

GitHub documents that scheduled events can be delayed or dropped under load:
<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>.
The five-minute cron was the only recurring automatic trigger after the GitHub cutover.
Changing cron minutes alone cannot establish timely delivery.

The ordinary five-minute schedule remains. Successful, same-repository main-branch
independent alert/index, announcements, market news, RSS, TradingView, Family book
and Data refresh workflow completions also wake processing,
without a browser or a separate paid scheduler. A credential-free preflight job
reads only the fixed desk's prepared status. It admits an overdue five-minute
check, a newly due weekday edition, a due saved retry or changed subscriber inputs.
Unavailable status fails this preflight visibly; original scheduled, code-push,
manual and read-only bootstrap triggers do not depend on that prepared reader.

The public input-change signal is `schedule.reason=waiting-for-inputs`; absence
of a private checkpoint revision does not count as a change. Retry metadata keeps
per-edition/source counts and deadlines, so current disabled-edition settings apply
in both gates. Older aggregate-only readers keep the five-minute check cadence.

The processing job retains the `newsletter-account` mutex and full request queue.
It restores the acknowledged encrypted GitHub checkpoint, refreshes the desk's
current inputs and rechecks the same clock under that mutex. Redundant completion
wakes exit before publishing, building previews or calling a model/sender. The
read-only collector identity accepts `workflow_run` only for the fixed newsletter
workflow, retaining the repository/owner IDs, main ref, audience and signature
checks; other collectors retain their previous event restrictions.

No job or state moves to Cloudflare. Existing source/model budgets, cooldowns,
saved PDFs, story history, delivery claims and multipart outbox remain authoritative.
The three-hour catch-up rule remains: an overdue edition outside that window is
recorded as missed, and this change does not clear or resend old claims.

Completion events provide an independent recovery path, not an exact execution
SLA. GitHub outages, all upstream workflows ceasing, runner queues and source or
static-publication failures can still delay delivery. A green wake is not evidence
of sender acceptance or inbox receipt; check the edition's retained outcomes and
the recipient's mailbox separately.

Offline validation: `verify-newsletter-scheduling.mjs` covers the actual missed
Monday clock, weekday/weekend and edited/disabled schedules, due retries, event
storms, reciprocal deployment loops, bounded credential-free reads and signed OIDC rejection boundaries.
`verify-newsletter-github.mjs` checks the restored checkpoint gate and real timer
claim while preserving unknown claims, PDFs and model reservations.
