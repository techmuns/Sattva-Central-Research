# Mutual Funds on GitHub Actions

The 15 October 2026 invoice exposed repeated Cloudflare SQLite reads/writes from
`mutual-funds:v1`. Collection already ran in Actions, but its transport wrote back
to that object. PR #239 introduced the retained store on 20 September and PR #249
added the private supplement on 21 September in the Sattva template. Both were
authored/merged through `ceekay-munshot`; account attribution does not identify
which person or coding agent used it.

## Runtime and data

Both existing 15-minute workflows now restore a local SQLite database, execute the
existing reconciliation and source-cooldown rules on a standard GitHub runner, and
publish prepared reader views. A shared concurrency group with the 100-run FIFO queue prevents one collector
from overwriting the other's state. Capture duration and GitHub scheduling delays
can make checks late; source timestamps and partial/failure states remain truthful.
The upstream AmfiBeas source keeps its own independent 15-minute GitHub schedule.
No Cloudflare timer, collector write or database-side MF calculation is allowed.
Old MF alarms retire on their next invocation and cannot be re-armed by a request
or a missing configuration variable. Existing Cloudflare data is not deleted.

The first main-branch Actions run copies every row of the named MF tables through
a bounded, authenticated, read-only export. Source rowids, corrections, private
observations and refusal cooldowns survive. Any unavailable table/page or count
mismatch blocks publication instead of replacing history with an empty store.
The one-time export streams up to 2,000 rows per response and stops below 2 MiB,
so small observations do not require thousands of tiny requests. Wide revisions
retain the same byte ceiling. Transfer logs show aggregate row counts only.
The original `mutual-funds-data` publication remains a migration backup. The next
runner restores that verified encrypted archive before creating the new delivery
format; it does not repeat the Cloudflare history export. During rollout the old
reader path remains until the first static head exists. Once a static head exists,
missing, corrupt or inaccessible parts fail visibly instead of selecting old SQL
or another dataset.

GitHub Release `mutual-funds-runner-data` holds one bundle per publication: the
AES-GCM encrypted restart database plus a compressed package of individually
encrypted reader files. A completed single upload is the generation marker. The
runner authenticates the restart archive before uploading; GitHub acknowledges its
size and digest before it becomes current. The two newest complete bundles and
the generation preceding a ten-minute grace window are retained. Every restart
database retains all observation, correction and scanner history. Pruning old
transport bundles never deletes source history. A previously initialized release
with missing state fails instead of silently resetting from an older source.

The existing automatic GitHub deployment reads the latest generation ID alongside
the code tree IDs. A new data generation triggers deployment even if the source
commit is unchanged. Only individually encrypted reader JSON files are installed
under `public/generated-views/mutual-funds/`; the restart database stays in runner
scratch and on GitHub. This generated directory is Git-ignored. Website requests
use the ASSETS binding to read prepared files without GitHub API calls or
Cloudflare database access. Cloudflare performs request-time authentication and
bounded decryption only. Unchanged ciphertext is cached inside the encrypted
restart database, so it survives independent runners and avoids re-encrypting all
historical files. Reader-key rotation regenerates both public and private files.

No retained state relies on expiring Actions artifacts, caches, LFS or Git
commits. Existing small aggregate health reports remain diagnostic artifacts.
No large or paid Actions runner is used.

## Private records

The public GitHub repository never receives plaintext supplemental holdings or
portfolio identities. Private views use X25519/HKDF/AES-GCM authenticated envelopes
for the existing Worker reader. Only its derived public publishing key is sent to
the runner. The Worker credential is never sent to GitHub. The Worker authenticates
the existing reader before downloading/decrypting a private view and returns
`private, no-store`; the existing browser session/cache boundary remains intact.
This is request-time delivery of a prepared file, not scheduled processing.

The private page directory is inside the encrypted private index. Public manifests
contain no private ISIN/month hash ranges, and private filenames use keyed opaque
bucket labels. A plain hash alone would allow readers to enumerate likely ISINs
and infer private portfolio membership. Routing metadata follows the same privacy
boundary as the holdings it addresses.

Runner restart state is streamed through gzip and AES-GCM using `MF_STATE_KEY`,
or the existing repository-specific Family/Glow read secret supplied as that
workflow environment value. Keep this key stable. Before rotating it, preserve the
old key and re-encrypt the retained state; an unknown key fails closed. Reader-key
rotation requires the next capture to regenerate all prepared view envelopes.
GitHub and Cloudflare remain different recipients with different keys. Repository
identity, asset origin, hashes, plaintext size and authorization are validated.

## Builds and remaining platform work

This change removes MF capture writes, timers and data-processing work from
Cloudflare. It does not claim the account-wide build-minute overage is disabled:
Cloudflare Git build integrations must be disconnected only after a verified
GitHub Actions deployment path exists. The existing deploy.yml can publish from
GitHub when its deployment credential is available. Other features' timers and
interactive storage are separate from the MF transfer and must not be described
as migrated by this patch. Do not delete their namespaces or disable unrelated
features as a shortcut. Production setting changes require the user's exact
authorization under AGENTS.md.

## Verification

`verify-mutual-funds-github.mjs` covers local SQLite persistence, complete history
transfer, encrypted state restoration, wrong-key rejection, immutable part reuse,
public/private separation, authorization, and zero DO calls after publication.
`verify-mutual-funds-budget-runtime.mjs` checks Node-to-Worker crypto compatibility
and retirement of an existing MF alarm in the actual local Worker runtime. Existing
MF arithmetic, source, denominator, coverage, correction and scanner checks remain.


## Switching deployment off paid Workers Builds

`.github/workflows/deploy.yml` is ready to validate and upload the existing Worker and static files directly from the standard GitHub runner. It reports the actual deploy result and watches its own configuration. The Cloudflare account ID is public configuration; the deployment API token stays in the repository's encrypted Actions secrets.

The currently active Cloudflare Git build connection is separate from this code. Before disconnecting it, an operator must authorize and install a user API token scoped to this account with the minimum Worker deployment permissions, then verify a successful GitHub deployment. Do not reuse Wrangler's broad personal OAuth token. Disconnect the Cloudflare Git trigger only after that path works, and verify a subsequent normal main-branch push reaches the live site without a Workers Build. Creating the credential, changing the build connection, or manually starting a production deployment requires the user's specific authorization under AGENTS.md.

Collector commits made with GITHUB_TOKEN do not create another push-triggered Actions run. A five-minute best-effort GitHub schedule therefore checks the current main commit as well. The deployment record stores the exact successfully uploaded SHA; unchanged public/worker/configuration trees are skipped. Only an acknowledged Wrangler upload advances this baseline. The comparison uses Git tree IDs before downloading the full site, never data blobs or Cloudflare database work. Publication is serialized so one upload can finish while a newer main commit waits. GitHub scheduling delays remain possible.

The transitional old reader uses cached anonymous GitHub release metadata. The
static delivery path removes that dependency entirely. GitHub API calls and full
bundle downloads occur only on authenticated GitHub runners. The Actions-only
Worker dispatch token is never sent to a Contents endpoint. Private plaintext
remains uncached. An incomplete upload leaves the preceding publication intact.

The scanner limits its source walk to twenty minutes. Separate restore, capture and publication step limits leave time to upload progress even when a source is slow. Either fixed main-branch MF workflow can authenticate the one-time read-only history transfer. Monthly views use independently addressed, size-bounded pages: new history can add pages instead of enlarging one permanent hash bucket. Each prepared part has a manifest hash and authenticated document context; decrypted private views remain uncached.

Release uploads and pruning wait a full second between mutative requests, following GitHub REST API guidance; unchanged logical parts reuse encrypted files from the retained runner state. A failed upload leaves the prior complete publication available.
