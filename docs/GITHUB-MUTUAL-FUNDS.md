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
publish prepared reader views. A shared concurrency group prevents one collector
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
While the first transfer is pending, legacy reads remain available. Once a GitHub
manifest exists, reader requests use the prepared GitHub assets, with no Durable
Object calls. Access failures do not fall back to a different dataset.

GitHub Release `mutual-funds-data` holds authenticated encrypted restart state and
prepared public/private views. The manifest is uploaded last; an interrupted
upload cannot replace the previous complete publication. Two complete transport
generations remain. Each database retains ALL captured observation and correction
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
