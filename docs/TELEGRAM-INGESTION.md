# Telegram ingestion

Public Chatter → Telegram reads `public/data/telegram-posts.json`. The archive keeps
original message IDs, Telegram publication dates, available text, attachment metadata
where exposed, and links to the originals. It does not score posts or infer a company.

The old implementation read only permalink Open Graph descriptions. It discarded
captionless/restricted messages, capped retention at 600 rows, recorded no source dates,
and only saved state when a new text post arrived. A quiet run could therefore lose
retry/backfill progress. Its statement that Telegram publishes no timestamps was wrong:
the public embed for `researchreportss/93384` reports `2026-05-13T10:57:05+00:00`.

The collector now combines Telegram's documented public message embed with available
permalink text. A matching `data-post` identity and valid `<time datetime>` are required.
A confirmed post whose content is hidden is kept with `text: null` and
`contentStatus: "telegram-only"`; no filename, quote or document type is guessed.
HTTP errors, unrecognised pages and rate limits remain retryable. Missing message IDs
are not counted as documents or deleted posts. Existing captured records are retained.

## Collection and retention

Every run checks known messages, walks the next 60 IDs, sweeps a separate forward window
to cross long gaps, retries failed IDs, and resumes older history (180 IDs by default).
The forward sweep cycles over the next 10,000 IDs; it is discovery, not proof that a
channel has no later posts. A verified `TELEGRAM_HEAD_HINT` can jump to a newer known
message and restart history from there. The old snapshot is upgraded from its newest
message downward, so missing dates and omitted posts are recovered before older history.

All captured rows are retained, with no 600-post cap. `historyNextId` and `retryIds` are
saved even when no new posts arrive. `lastCheckedAt` records a completed successful
forward check, `lastRun` reports failures/partial checks, and `capturedAt` changes when
archive content changes. `firstSeenAt` is preserved and never displayed as publication time.

A scan reaching ID 1 means the public ID range was examined; it does not claim to have
obtained content Telegram withholds. Full content and downloadable report files need an
authenticated Telegram user connection. No Telegram account is configured by this change.

## Local collection

These commands modify only a local artifact. Commit the result through a PR.

```sh
node scripts/scrape-telegram.mjs
TELEGRAM_OUT=/tmp/telegram-smoke.json TELEGRAM_HEAD_HINT=93384 TELEGRAM_BACKFILL=10 node scripts/scrape-telegram.mjs
TELEGRAM_BACKFILL=700 TELEGRAM_BUDGET_MS=840000 node scripts/scrape-telegram.mjs
```

`TELEGRAM_BACKFILL=0` disables older history for one run. `TELEGRAM_FORWARD`,
`TELEGRAM_DISCOVERY`, `TELEGRAM_DELAY_MS`, and `TELEGRAM_BUDGET_MS` bound each run.
A first capture requires a real message number as `TELEGRAM_HEAD_HINT`; an existing
archive is the normal starting point. Invalid settings and malformed existing archives
fail without overwriting the archive. Writes use atomic rename.

## Scheduled publication

`telegram-refresh.yml` requests runs at minutes 17 and 47. GitHub schedules are best
effort; the dashboard reports observed checks rather than promising a fixed cadence.

The job opens `codex/telegram-capture` as a PR, then explicitly dispatches `Verify` on
that PR's commit because PR events created with `GITHUB_TOKEN` do not start workflows.
It waits for that exact run and merges with a head-commit guard only after success.
Review comments or required review/protection gates leave the PR open; subsequent
collection runs preserve that pending PR. There is no direct push to main. Repository
Actions must allow PR creation; if not, the publish step fails visibly and needs the
repository owner to enable that permission. No admin bypass is used.

A failed source read retains prior posts and saves a failed health state through the same
PR path, then fails the collection workflow visibly. No manual production dispatch,
deployment or data write is required to test this change locally.

## Verification

- `node scripts/verify-telegram.mjs`: parsing, source dates, restricted posts, edits,
  resumable history, retention, source failures, retries and forward gap discovery.
- `node scripts/verify-telegram-publishing.mjs`: offline PR scope, check and review gates.
- `PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-telegram-ui.mjs`: browser
  dates, scopes, restricted content, search, modal, failed refresh retention and mobile.
