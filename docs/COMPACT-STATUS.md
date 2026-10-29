# Compact capture status and operational health

GitHub Actions prepares `public/data/capture-status.json` and
`public/data/filings-health-plan.json` after installing prepared reader files and
before validating/uploading the exact site. These are ignored deployment products,
not captured records or a second archive. Every changed publication regenerates
them; changing the generator itself also invalidates the deployment input signature.
A preparation failure fails publication and cannot advance the successful baseline.

`/api/capture-status` reads only the compact manifest. Its source timestamps,
coverage, failures, fallbacks and alert-pool revisions retain their previous meaning.
Preparation and request times are separate fields. The exchange artifact's small
identity check remains live because that artifact can advance without a site upload.
The browser's visible/focus/reconnect checks, watchdog, dispatch cooldowns and
collection schedules are unchanged. No history file is rewritten or shortened.

`/api/filings-health` also avoids reading the full captures. The runner evaluates
the existing `assessFilingsHealth` at its future timestamp/age boundaries and stores
only changes to its findings, separately for each source. The route selects the
current findings with a binary search and reports the current assessment time.
Thus a stopped publisher still becomes stale, initial grace still expires, future
timestamps are rejected until the existing tolerance allows them, and source/auth,
pagination, identity, coverage and recovery findings retain their exact meaning.
This plan remains valid as time advances; there is no blanket "healthy" snapshot
or new retention window. Changes to assessor clock rules must update the compiler's
boundaries and its differential regression tests together.

Missing, corrupt or oversized prepared products return HTTP 503. There is no
request-time fallback that parses the historical captures or labels unavailable
preparation current. Missing source inputs are represented as unavailable while
other independent sources remain readable. Private credentials are never sent to
the internal asset binding or written into these products. Public health findings
keep the existing controlled codes and capped affected-identity examples.

## Other API routes reviewed

- Bulk/block history and alert-pool members already deliver prepared gzip bytes;
  artifact range reads, identity checks, historical paging and conditional responses
  remain intact. Tests cover the archive, corrections and incomplete source reads.
- Technicals stream prepared daily files; Momentum uses prepared quote delivery.
  Their source clocks, live publication and fallback semantics remain intact.
- Private prepared views retain authentication, encryption and bounded decoding.
  Public status preparation never opens or publishes those records.
- Live earnings, calendar, NSE and con-call proxies still normalize their upstream
  reads and use their existing short caches. Replacing those with older deployment
  snapshots would change freshness; this change does not do so. This review is not
  proof that every possible request fits the free CPU allowance. Production passive
  tail observations and aggregate resource-limit metrics remain the way to locate
  additional expensive paths without generating collection or paid research calls.

## Verification

`verify-prepared-capture-status.mjs` compares source metadata, checks byte-identical
history, missing/corrupt manifests, new publication/restart adoption, live exchange
identity and exact health findings before/at/after expiry boundaries and long after
publication. `verify-filings-health.mjs` additionally compares its existing source
failure fixtures with the compiled assessor. `verify-prepared-status-runtime.mjs`
exercises the real workerd service binding, restart and failure behavior. Deployment
tracking and the existing watchdog/refresh/history suites remain release checks.
