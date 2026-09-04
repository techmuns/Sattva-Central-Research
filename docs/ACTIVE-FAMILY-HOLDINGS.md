# Active Family Office holdings

## Why this changes the connection

Family Office rebuilds its on-screen holdings from the newest eligible uploaded workbook.
`src/data/sattvaData.ts` is only its built-in baseline, not the updated portfolio. Research
Central must not read that file as a current sync source.

The Family Office companion change adds `GET /api/research-holdings`. It uses the same
workbook-selection and open-lot parser as the screen, deduplicates equity ISINs, and exports
only names, sectors and provenance. The response never carries quantities, values or accounts.

Research's `GET /api/family-portfolio` authenticates to that fixed route server-side and uses
the same resolver as the scheduled snapshot. The browser checks it on load, once per minute
while visible, on Refresh, and after focus, reconnect or a back/forward-cache restore.
A workbook replacement replaces membership: sold holdings are
not unioned back in from old periods. Missing ticker mappings remain held-but-uncovered.

The dashboard renders its saved list immediately and labels it as a snapshot while checking.
A failed read preserves the last good browser cache and displays an explicit warning. A check
expires after 90 seconds even if browser timers stopped; reads more than five seconds in the
future are refused. A pre-sleep request cannot overwrite a resumed request. Browser, Worker and
scheduled collectors share strict identity, count, provenance and freshness validation.

The shared source fetch must use `redirect: 'manual'`, not `'error'`: the latter
works in Node but is rejected by the Cloudflare runtime before any network request.
Every non-2xx response, including a redirect, is rejected before parsing; the
holdings credential must never follow a redirect. Contract tests pin the supported
mode and cover 301, 302, 303, 307 and 308 refusal. A bundle-only dry run does not
exercise edge HTTP behaviour; also check the authenticated path in a Cloudflare
preview when changing its request options.

The source workbook, stated period end, its age and last successful connection check are visible
beside the Portfolio controls. A future period end is flagged as not proving today's holdings.
Existing browser-local manual overrides remain local; an explicit warning identifies when the
device's list may differ from Family Office. Unmapped new ISINs remain visible as uncovered.

## Activation — requires approval of both PRs and the exact production actions

No production credentials, runs or deployments are changed by these PRs themselves.

1. Deploy the companion Family Office PR after approval. Keep its existing `AUDIT` KV binding.
2. Generate a dedicated random secret of at least 32 characters using a password manager.
   Store the same value as `RESEARCH_HOLDINGS_TOKEN` in Family Office's Pages secrets and
   `FAMILY_HOLDINGS_TOKEN` in Research Central's Worker secrets. Do not use the dashboard
   password, browser cookie, Muns token or broad Cloudflare/GitHub credential.
3. Add `FAMILY_HOLDINGS_TOKEN` to Research Central's Actions secrets for the snapshot job.
4. Deploy Research Central after approval. Its scheduled collectors now ask its live
   names-only endpoint for holdings instead of using the old snapshot. A built-in-only source
   is refused as a live sync, even on a brand-new device. Until the companion
   route/secret is available, they fail explicitly rather than silently use June's book.
5. Compare the export's ISIN set to Family Office's active Holdings view (equities only),
   including Sterlite `INE089C01029` → `STLTECH`. Then verify the same set in Research Central
   on two devices with no local portfolio overrides. Test additions/removals in staging,
   not by modifying the production workbook.

An uploaded workbook kept **only in a browser** cannot be a shared source. Family Office's
Data Audit panel identifies that case and offers publication to shared storage; it needs the
user's approval to publish. Do not silently upload local customer files as part of sync.

`asOf` is the source's declared workbook period, not a live trade timestamp. In particular,
the existing `FY27 till Q2 Aug.` period label is interpreted by Family Office as a full
financial year. This change preserves that interpretation, does not infer a different date,
and shows the workbook label plus actual check time. Correcting period metadata is separate.

## Snapshot workflow and review

`Family book sync` retains its daily/manual/dispatch triggers, but now opens or updates
`codex/family-book-snapshot` as a PR. It never pushes to main or merges. Live scope and
scheduled collectors do not wait for that fallback PR.

Allow Actions to create PRs. To trigger CI automatically on bot-created snapshot PRs, set
`FAMILY_SYNC_PR_TOKEN` to a repository-scoped GitHub App/PAT with Contents and Pull requests
write permissions. Without it, the default `GITHUB_TOKEN` creates the PR but does not trigger
another Actions workflow; required review/checks must still be obtained before any merge.

The schema, duplicate-ISIN/ticker checks and 80% retention guard reject corrupt/empty/partial data.
The guard compares each browser's last-good book as well as the committed server snapshot.
An older workbook/period cannot silently replace a newer known shared one. The exporter checks
sheet row count/name against the manifest, validates holding identities and rejects an index
change observed during its read. A missing index is not treated as an empty archive.
A genuine reduction beyond 20% needs explicit reconciliation and a reviewed update to the
fallback snapshot; do not bypass the guard merely to get a green run.

## Local verification

`node scripts/verify-family-sync.mjs` exercises the resolver, additions/removals, auth boundary,
failure retention, replay/rollback rejection and six-month reopen behaviour with synthetic/local
data. `scripts/verify-family-sync-ui.mjs` runs real Chromium/IndexedDB reload, offline, reconnect,
BFCache and manual-override checks; it runs in PR CI alongside contract tests.
`wrangler deploy --dry-run`
bundles without deployment. The Family Office PR has matching producer/auth tests and a
Pages Functions build check. No live collection jobs are executed in these tests.

For an offline snapshot import, set `FAMILY_BOOK_PATH` to a names-only JSON export and run
`node scripts/sync-family-book.mjs`. It no longer accepts a TypeScript portfolio file.

## Reliability boundary — do not promise an always-current portfolio

This is a workbook sync, not a broker feed. A successful check proves that the connection read
the selected shared workbook; it does not prove that every trade has been recorded. The expected
holdings-update cadence must be agreed before setting an overdue-workbook alarm.

The current Family Office archive uses eventually consistent KV. Different locations can
temporarily read different revisions. Row/index checks and rollback guards catch observed
inconsistency, but cannot prove that a previously unseen revision is the globally newest one.
Nor do they prevent concurrent writers from losing an index update, or same-row-count sheet
replacement under an existing key. An absolute single-version guarantee needs a separately
reviewed transactional/versioned publication design for the archive, not a cache flag. See
[Cloudflare's KV consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

Do not sign off production until the active August workbook is confirmed shared (not only
local), its ISIN set matches on both dashboards/two clean devices, the sync secrets are configured,
and deployment/rollback checks have been approved. No production activation or external ongoing
health monitor has been performed by this PR.
# Versioned producer prerequisite

The companion Family PR #38 now includes immutable D1 workbook publication.
Coordinate activation using its `docs/versioned-workbooks.md`: freeze legacy
writes, copy and verify all shared sheets, then enable `WORKBOOKS_MODE=d1` with
the `WORKBOOKS_DB` binding. Do not activate against a newly created empty database.
Creating the database is separate from migrating customer data or deploying code.
