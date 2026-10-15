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
While the first transfer is pending, legacy reads remain available. Once a GitHub
manifest exists, reader requests use the prepared GitHub assets, with no Durable
Object calls. Access failures do not fall back to a different dataset.

GitHub Release `mutual-funds-data` holds authenticated encrypted restart state and
prepared public/private views. The manifest is uploaded last; an interrupted
upload cannot replace the previous complete publication. At least two complete transport
generations remain, plus the generation preceding a ten-minute cache grace window. Each database retains ALL captured observation and correction
rows; pruning obsolete transport assets does not prune disclosure history.
Unchanged view parts reuse their existing assets. There are no database snapshots
in expiring Actions artifacts, caches, LFS or Git commits. Existing small aggregate
health reports remain diagnostic artifacts. No large or paid Actions runner is used.

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
rotation requires the next capture to regenerate private view envelopes.
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

Public release metadata is read anonymously by the Worker and cached for five minutes; the Actions-only dispatch token is never sent to a Contents endpoint. The runner uses its own Contents-authorized GITHUB_TOKEN. Private plaintext remains uncached. Empty GitHub upload placeholders and invalid JSON manifests cannot prevent recovery to the last complete publication. Transient download failures stop pruning rather than deleting unverified history.

The scanner limits its source walk to twenty minutes. Separate restore, capture and publication step limits leave time to upload progress even when a source is slow. Either fixed main-branch MF workflow can authenticate the one-time read-only history transfer. Monthly views use independently addressed, size-bounded pages: new history can add pages instead of enlarging one permanent hash bucket. Public manifests and indexes, and private ciphertext files, use an immutable asset cache keyed by GitHub asset ID; decrypted private views remain uncached.

Release uploads and pruning wait a full second between mutative requests, following GitHub REST API guidance; unchanged logical parts reuse immutable assets. A failed upload leaves the prior complete publication available.
