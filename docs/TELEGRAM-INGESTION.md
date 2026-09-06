# Telegram ingestion

Public Chatter reads retained posts from **@researchreportss**. Publication dates come
from Telegram. The source-check time is separate; September 4 publications may still be
the newest on September 6. Public-page probing cannot establish that they are the newest.

## Delivery

`telegram-refresh.yml` collects into an immutable `telegram-posts-v1.json.gz` Actions
artifact. `/api/telegram/posts` reads that artifact with the existing Worker
`GH_DISPATCH_TOKEN`. It validates the source repository, workflow, branch, artifact
SHA-256, download host and public-data schema. No Telegram credentials reach the Worker
or browser. One-minute edge caching and ETags bound repeated reads.

The static `public/data/telegram-posts.json` paints first. Public Chatter polls the artifact
once a minute while mounted and visible, retaining newer data if an older static file or
failed response arrives. Ten-minute GitHub checks are requested; active readers also
request an overdue check via the existing POST-only, ten-minute-cooled-down dispatch
route. Quiet checks use `lastRun.at` rather than content-change time, avoiding needless
runs when the channel has not posted. This is polling, **not instantaneous streaming**.
GitHub schedules are best effort. The Cloudflare account currently has no spare cron
trigger; no always-on timing guarantee is claimed.

Collection no longer waits for an archive PR, CI or a site deployment. A separate daily
`telegram-archive.yml` backs the artifact up through `codex/telegram-capture`, verifies
its exact commit, and merges only through the existing review/check gates. A conflicted
backup PR cannot stop fresh collection. Artifacts retain the whole preceding capture,
expire after 90 days, and are renewed by each successful workflow. A prolonged outage
beyond retention falls back to the committed backup. Payload size limits fail visibly
without truncation. Resolve an unattended backup PR before relying on it as permanent
storage.

## Source modes

Without `TELEGRAM_CREDENTIALS`, the dependency-free Node collector combines documented
public embeds with permalink Open Graph text. A matching message identity and source
timestamp are required. Missing IDs are not interpreted as documents or deletions.
Forward sampling and resumable historical scans help discovery but cannot prove the
latest channel message has been found. The UI explicitly says it has not been verified.

With `TELEGRAM_CREDENTIALS`, `collect-telegram.py` uses Telethon 1.44.0 and the official
MTProto API. It asks for the newest 100 messages directly, re-reads recent edits, catches
up oldest-first after its last confirmed position, and resumes older history separately.
Large bursts and interrupted requests preserve their position. `latestVerifiedAt` is set
only when the capture has caught up to the observed API head. History can remain incomplete
while the newest messages are current. A failed source check preserves prior posts and
is published as failed health, even though uploading that health artifact succeeds.

The integration reads only the configured public broadcast channel, with no joins,
sending, contact access, read receipts, private-group export or file downloads. Text,
publication dates, document filenames/sizes and original links are retained. Captionless
messages are archived; rows appear when captured text or a named document is available.

### Account safeguards

Telegram can restrict unofficial API clients; read-only collection cannot guarantee an
account will never be banned. If protecting a primary account requires avoiding that
residual risk, leave it disconnected and use public-page collection. A separate account
isolates the primary account's session but does not remove Telegram's restrictions.
The session is an account credential with broader capabilities than this collector uses;
it is **not a read-only-scoped token**.

API runs are restricted to `main` and share one concurrency group. Each run reads at most
100 recent messages, 300 catch-up messages and 200 historical messages (180 by default).
History waits until head catch-up is complete. Additional history pages are spaced by two
seconds. There is a persisted five-minute minimum between successful collection runs;
the requested scheduled interval is ten minutes. These are conservative implementation
limits, not a Telegram guarantee of account safety.

Automatic request retries and flood-wait sleeps are disabled. A Telegram flood wait is
saved in `apiSafety.nextAttemptAt` with 60 seconds of grace. Later runs check the saved
gate **before connecting or reading credentials**. Connection failures back off from
15 minutes up to six hours. Revoked, duplicated, unauthorized, restricted or invalid
sessions pause indefinitely for operator review. Existing posts and checkpoints survive;
the UI shows the pause. No automatic login or replacement session is created.

After diagnosing an account pause, an operator can explicitly authorize a production
workflow dispatch with `resume_api: true`. That input clears only an account-review pause;
it cannot bypass a pending flood wait. The dashboard cannot send this input. Never run
the same session concurrently on another machine. Missing or invalid published archives
fail closed rather than discarding the persisted pause.

## Connect the free official API

The API is free **but requires a Telegram user account**, your own API ID/hash and a
revocable account session. A bot token is not a substitute for channel-history access.

1. Sign in to [Telegram API development tools](https://my.telegram.org/apps) and create
   your own application. Do not paste credentials, login codes or passwords into chat.
2. Prepare a local runtime outside the repository:

   ```sh
   python3 -m venv "$HOME/.local/share/sattva-telegram-venv"
   "$HOME/.local/share/sattva-telegram-venv/bin/pip" install telethon==1.44.0
   "$HOME/.local/share/sattva-telegram-venv/bin/python" scripts/connect-telegram.py
   ```

   The helper hides credential/login input and saves
   `~/.config/sattva-telegram/credentials.json` with owner-only permissions. It does not
   upload anything or activate production. The session is sensitive and can be revoked
   under Telegram Settings → Devices.
3. Once the operator explicitly authorizes **activating this connection in production**,
   store the single bundle through stdin (never command-line argument values):

   ```sh
   gh secret set TELEGRAM_CREDENTIALS --repo techmuns/Sattva-Central-Research < "$HOME/.config/sattva-telegram/credentials.json"
   ```

   The next regular collection selects MTProto automatically. An immediate manual
   production dispatch is a separate authorized action. Never commit the bundle or
   upload a session as an Actions artifact.

No account has been connected by merely merging this implementation. Until that step,
public-page collection continues, with its limitations visible.

## Local verification

- `node scripts/verify-telegram.mjs`: public parsing, gaps, retention and checkpoints.
- `python3 scripts/verify-telegram-api.py`: API head/history, large bursts, quiet checks,
  interrupted catch-up, documents, the public-channel boundary and no-connection pause
  enforcement, including operator-resume flood-wait protection. No network/login.
- `node scripts/verify-telegram-artifact.mjs`: artifact trust/digest/host/size boundaries,
  credential stripping, persisted account waits, actual Worker route, conditional caching
  and failure handling.
- `node scripts/verify-telegram-publishing.mjs`: archive-only PR scope and review/check gates.
- `PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-telegram-ui.mjs`: static fallback,
  artifact arrival without deployment, dates, search/export, errors and mobile layout.

Official references: [Telegram API credentials](https://core.telegram.org/api/obtaining_api_id),
[Telegram API errors and required waits](https://core.telegram.org/api/errors),
[history API](https://core.telegram.org/method/messages.getHistory),
[Telethon sessions](https://docs.telethon.dev/en/stable/concepts/sessions.html).
