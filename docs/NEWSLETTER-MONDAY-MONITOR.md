# Monday 19 October 2026 newsletter monitoring

`newsletter-monitor.yml` runs on standard free public-repository GitHub Actions
runners. One Sattva workflow reads **both** Sattva and Glow `/api/newsletter`
prepared readers; the Mac and an open dashboard are not needed for this audit.
It has no mail, model, dashboard-edit or private-state decryption credentials.
Its GitHub token can retain reports and disable this monitor after the episode.
It never starts/retries the sender, sends mail, edits subscriptions or deploys.

The target is the automatic `2026-10-19:morning` edition, scheduled at **08:00
IST (02:30 UTC)**. Every 15 minutes on 19–20 October, and after Sattva newsletter
processing/deployment completes, the monitor checks the actual edition's planned
recipient count and part count. Glow is polled independently. Scheduled Actions
can be delayed or dropped; these checks do not promise an exact execution time.
Push activation also saves a readiness report before Monday. Outside the dated
episode, scheduled/workflow completion triggers do no work.

The monitor verifies all planned outcomes, successful provider acknowledgements,
part sequence and sizes, stable unique message IDs, identical edition subjects,
and each reply's submitted `In-Reply-To` and `References` pointing to that
recipient's accepted root. Both senders retain these request receipts with body
digests in their existing encrypted checkpoints. An empty queue, a green sender
workflow or `nothing-due` does not establish success. Removed recipients,
cancelled parts, late subscriptions, retries and missing outcomes are counted or
flagged. New subscribers after the edition was claimed are outside that edition's
frozen plan and are explicitly counted separately. Missing earlier subscribers
prevent a successful audit.

**Evidence boundary:** `sender-accepted-and-headers-verified` establishes sender
acceptance and submitted thread headers. It does not establish receipt, bounce
status, SMTP downstream delivery or actual thread placement in any recipient's
mailbox. Existing sender credentials have no inbox or Sent reconciliation API.
The report always sets `inboxDeliveryVerified` and
`inboxThreadMembershipVerified` to `false`. Extra attempts are disclosed because
stable request IDs alone cannot prove the provider deduplicated an uncertain send.

Each run retains only aggregate counts, fixed issue codes and timestamps in the
Sattva release `newsletter-monitor-2026-10-19`, plus its Actions job summary. No
addresses, names, message IDs, bodies, PDF bearer URLs, raw API responses or raw
errors are published. Reports have timestamp/run/attempt names and are never
overwritten. An actionable exception fails the monitor run after retaining the
report; subsequent observations continue. After both editions pass, or at the end
of the 24-hour observation window, it disables **only itself**, after saving the
final report. Sender recovery is independent and continues normally.

The existing local Codex heartbeat is a report reader, not the monitor. GitHub
cannot post into an offline local Codex chat through a supported callback. When
Codex is online, that follow-up reads the retained cloud report and can inspect
the connected user inbox and sender Sent session if available. It must report
the scope actually verified and must not claim access to other subscriber
mailboxes. The GitHub report remains available while the Mac is asleep.

Validation: `node scripts/verify-newsletter-monitor.mjs` covers changing counts,
single/multipart editions, wrong dates/manual sends, missing/cancelled outcomes,
wrong reply roots/references/subjects, cross-product ID reuse, delayed/missing
editions, subscriber changes, private error redaction and bounded UTF-8 streaming.
`verify-newsletter-multipart.mjs` checks that request receipts survive encrypted
checkpoint recovery and match actual mocked sender payloads, including retries.
