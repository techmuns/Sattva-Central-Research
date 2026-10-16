# Background processing on GitHub

The 15 October 2026 budget instruction keeps Cloudflare as the website delivery layer. Collection, scheduled calculations and retained job state belong on standard GitHub Actions runners and GitHub storage. Request-time authentication and delivery of prepared private files must preserve existing access rules.

The unused legacy Cloudflare news-cron handler is retired as well; the existing
GitHub market-news workflow keeps its configured source cadence.

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

Read-only history transfer also runs when collection is disabled; it never signs
in or opens a source page in that case. Both the repository and Worker opt-ins
are required before source collection. A merge's runner waits for the read-only
configuration API while its independent static deployment finishes.

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

## Breakout quotes and history

The existing GitHub workflow owns both the minute Upstox sampler and the independent
fifteen-minute fallback walk. During the exchange window one standard runner keeps
sampling for up to forty-five minutes; a slower fallback request does not suspend
the minute loop. The existing workflow concurrency prevents overlapping owners.
GitHub scheduling and runner handovers remain best effort. Source quote times,
missing intervals, partial inventories and overdue checks remain visible; deployment
or archive publication never advances a source's successful check time.

The 16 October repair queues one successor when an owner starts. Deployment
completion also checks for an absent market-hours owner; this step runs inside
the existing deployment job, outside the collection mutex, and cannot start a
duplicate owner. Closed markets do not chain source jobs. No extra workflow-run
trigger is added, avoiding a deployment/recovery feedback loop. Existing cron starts remain a
fallback to these automatic handovers. No manual production retry is required.

Current quotes now use the separate encrypted `breakout-live-data` release. Each
acknowledged generation includes the **complete** restart database and one small
current-price reader file. The Worker caches release metadata for 15 seconds and
uses verified byte ranges to fetch only the encrypted reader file, skipping the
restart database entirely. Readers never call Upstox or start work. A missing
initial live release can use static prepared data; failed/corrupt delivery keeps
saved data visible with an explicit unhealthy primary state. Original quote and
check times still determine freshness. A cached file never becomes a fresh check.

Historical page construction runs in a separate Node thread, at most once per
15-minute interval, and retains the existing static-history publication path.
SQLite's online backup copies each quote checkpoint in small asynchronous steps,
preserving rowids and allowing the owner to keep sampling while history is copied.
It cannot block minute network timeouts, quote sampling or current-price delivery.
Every minute's complete encrypted restart checkpoint retains those observations
even if the less frequent historical-reader publication is delayed. Restart
prefers the latest verified live checkpoint, with the original archive as the
one-time transition source. Two recent complete generations remain available.

One persisted Upstox budget is shared by minute quotes, backup history and private
price-level checks: 200 ms spacing, at most 60 requests/minute and 900/30 minutes.
Historical backfill uses lower ceilings, reserving capacity for live quote batches.
The roughly 600-company quote inventory still needs two requests per minute, not
one per company or reader. HTTP 429 honors Retry-After and increasing cooldowns;
authentication refusal pauses that token for an hour and a deliberately replaced
token can recover. The ledger stores a fingerprint, never the raw token, and is
retained in restart checkpoints. The source's per-user limits may also be consumed
by other applications. Source outages, missing/suspended identities and incomplete
history remain partial coverage, never invented prices or successful live filters.

Before source work, the first runner copies and verifies every capture table,
original rowid, instrument configuration and timer metadata through the fixed
main-workflow read-only export. It publishes an acknowledged encrypted restart
bundle. Subsequent runs restore that bundle rather than re-importing Cloudflare.
The old Cloudflare collector writes are rejected and both old quote alarms retire.
Saved Cloudflare history remains available as the original migration source.

The runner keeps the original quote providers, exact exchange/ISIN matching,
oldest-first walk, retry ceilings and recovery rules. Each discovery refresh pins
all public inputs to one current main revision. Failed input refreshes preserve
prior targets and report partial discovery. Live portfolio and watchlist reads
remain inputs; their request-time services do not perform collection.

The encrypted `breakout-data` bundle contains the complete restart database and
prepared reader files. Static hosting receives only encrypted reader envelopes.
Four days of minute quotes, older detected changes, retained fallback observations,
recovered rows and archived gap totals preserve the original retention rules.
Prepared history preserves exact `(at, run)` ordering and older pagination cursors,
including after new captures. Current quote selection uses the original freshness
rules at read time, so a delayed minute publication can use a fresher fallback.
Reader requests perform no Cloudflare SQL or GitHub metadata requests after the
first prepared publication. Failed or corrupt prepared data fails visibly.

The runner requests the existing static deployment after each historical generation;
the existing deployment schedule also catches up. A queued deployment may coalesce
several generations, while the full acknowledged quote history remains on GitHub.
Source timestamps and the original two-minute freshness assessment expose delivery
lags. Publication failures retain the last acknowledged archive and fail the job.

## Private price-level checks

Interactive edits and deletion tombstones retain their immediate service-only input
store. The GitHub quote runner reads a bounded authenticated input snapshot and
owns quote checks, calculations and new hit history. It imports all existing hit
rows once, encrypts the complete restart database on GitHub, and prepares lossless
200-hit pages. Cloudflare no longer arms or runs the price-level alarm.

The original exact NSE ticker/ISIN, current-session and quote-after-set-time rules
remain. The runner refreshes inputs again after receiving quotes, before recording
hits, so edits during a request invalidate completeness. A prepared hit applies to
an interactive level only when its value, set time and company identity still
match. Cleared levels cannot return from a delayed publication. A changed input
revision shows Waiting until GitHub checks that revision. Minute sampling, source
outages and GitHub scheduling/delivery gaps remain visible; saved hits are observed
history and cannot reconstruct every trade between checks.

Every private API response still requires the separate service token before either
input or encrypted static access and remains private, no-store. No new long-lived
service credential is copied into GitHub: the fixed quote workflow uses its
short-lived OIDC identity for read-only input/history transfer.

## Newsletter migration (prepared; cutover requires setup)

The GitHub implementation keeps existing recipients, settings, content jobs,
reported-story ledger, model reservations, edition claims and immutable PDF
history. Read-only transfer preserves original rowids. PDF BLOBs use bounded
base64 pages with byte counts and SHA-256 verification; JSON must never turn a
saved binary PDF into an empty object. The source must report the GitHub runtime
before import, and changes in its input revision or inventory block publication.

The existing providers, models, content limits, news dollar budget, rolling manual
send budget and three-hour scheduled catch-up rule remain. The runner acknowledges
an encrypted restart bundle before each model or email request. Publication failure
latches external I/O off. Unknown/interrupted delivery claims remain claimed,
including after restart; a failed job cannot automatically resend that edition.
PDF bytes are acknowledged on GitHub and their exact hash is verified at the live
opaque download URL before an email containing that link may leave the runner.
No model or email request is made by the website after cutover.
The runner reads the committed JSON source captures from its fixed workflow checkout through a data-only local assets binding. Missing inputs remain unavailable. Prepared HTML previews use numeric parts starting at 1, matching their download URLs.

Subscribers and schedule edits remain immediate interactive inputs. The runner
refreshes them before metered work and before email, and refuses removed recipients.
The website serves encrypted prepared delivery status, previews and saved PDF
bytes. Unchanged reader ciphertext is reused so a new claim does not reupload all
historical PDFs. Restart state and credentials are never static assets.

Manual send requests return HTTP 202 with a request ID and status URL. Their
address, edition and optional caller token are encrypted to a public key derived
from the runner's existing background secret before GitHub receives them. A fixed
main-branch workflow queues each distinct request; request IDs prevent replay from
spending the manual budget or sending twice. Claimed/unknown requests are never
reported as confirmed sends. The original request-time origin and rate limits
remain. GitHub scheduling, runner queues and static delivery are best effort: the
five-minute schedule can delay an edition or preview; actual check/build times and
missed deliveries remain visible. Original captured source history is retained.

Before production cutover, separately authorize the existing newsletter mail,
OpenAI and (where already configured) Bedrock credentials as dedicated encrypted
GitHub secrets `NEWSLETTER_MAIL_TOKEN`, `NEWSLETTER_OPENAI_KEY` and
`NEWSLETTER_BEDROCK_KEY` in each owning repository. These are the same providers
and existing budgets, with no paid test or new provider. Do not create a repository
`MUNS_TOKEN` secret: the deployment secret-sync step uses that name for the Worker
and could otherwise overwrite its existing credential.

After that authorization, set the Worker secret `NEWSLETTER_RUNTIME=github` and
run the explicit `bootstrap` workflow input for read-only history transfer and
source-only previews. Keep `NEWSLETTER_GITHUB_ENABLED` disabled until credentials
and retained history are verified; this bootstrap cannot call a model or send an
email. Then enable that repository variable and resume the ordinary GitHub job.
The old newsletter alarm then retires; legacy send and preview RPCs are blocked.
Until explicit setup approval, both flags remain unset, the new workflow skips,
and the existing newsletter remains operational. Do not claim this cutover is done.

## Remaining transfer work

Mutual Funds has its separate encrypted retained-state transfer and prepared reader snapshots documented in `GITHUB-MUTUAL-FUNDS.md`. Telegram's small scheduling change must not be presented as migrating the remaining engines:

- Newsletter production credential setup and runtime cutover, followed by retained-history and live-reader verification.

Each transfer needs read-only verified history import, encrypted public-repository storage where applicable, local/staging failure tests, live reader verification, and retirement of its old recurrence. A source or credential failure must remain visible instead of turning into empty successful data. Existing Cloudflare history must not be deleted as part of migration. No paid runner, new provider or external API spending is a fallback for unavailable free tooling.

## Retained SQL cursor contract

A rowid of zero (including quote bucket zero and staged inventory sequence zero)
is a valid saved row. A null cursor means the first page; subsequent pages accept
zero and negative safe integer rowids. Only a null returned cursor ends paging.
The source advertises `rowidCursor: 2`; the runner waits for this read-only API
before transfer and refuses an incompatible source. Exact count checks remain,
so an interrupted or mismatched transfer cannot replace retained history.
Transfer progress logs contain only fixed table names and aggregate row counts.

Newsletter provider request deadlines start after encrypted checkpoint acknowledgement and live PDF verification. The original HTTP timeout limits and budget claims stay unchanged; explicit caller cancellation remains effective during preparation. An old timed-out delivery claim is not cleared or replayed by this change.

The newsletter runner reads public company quotes from its fixed `/api/breakouts` prepared reader using a credential-free GET. It requires `github-actions` delivery and validates each observation before the existing session/freshness checks; it never calls the former capture database. Unavailable or stale quotes retain the original daily fallback and unavailable states.
