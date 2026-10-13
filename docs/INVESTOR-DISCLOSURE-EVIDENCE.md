# Investor disclosures and changes

Superstar Investors opens on Changes, with My Managers / All Investors audiences. Public Changes combines two visibly separate
readings: dated public bulk/block trades matched to tracked investor names, and changes between
consecutive completed quarterly disclosures. A quarter-end observation is never a trade date.
Unknown, missing, conflicting and filing-due cells cannot establish purchases or sales. Only
explicit non-disclosure can establish a disappearance from a shareholding pattern. Positive
reported stakes with missing or zero valuations make the aggregate valuation unavailable.

Exact names allow punctuation and equivalent legal suffixes; ambiguous names stay unmatched.
An associated entity requires an explicitly reviewed relationship and a public evidence URL,
renewed within 90 days. No Glow private manager, statement, account or relationship dataset is
imported. Original NSE/BSE holdings show the named legal holder, security identifier, holding
date, filing time, check time and source links. Conflicting exchange figures stay separate and
enter the coverage review. Search and exports use the same disclosure predicate.

Finology books retain their existing daily capture and automatic reader revalidation. Failed
books and investors missing from the latest directory retain previous evidence and their real
source check time. Older quarterly columns survive rolling source windows. The public feed’s status and source age remain in Sources; the customer heading omits
the source-status chip and derivation button at the user’s request.

The new `investor-disclosures-refresh.yml` workflow is scheduled every six hours and runs after
changes to its implementation, tracked books or reviewed relationships. It reads the BSE and
NSE equities/SME indexes, starts with two completed quarters and later disclosed dates, and
retains every captured version. This is a capture starting window, not proof of an exhaustive
historical archive. Public source blocking, truncated indexes, unresolved identities, partial
parsing and pending filings remain explicit. The capture never claims complete public holdings.

A run attempts at most 600 filings and checkpoints before reads and every 25 outcomes. Unread
older filings survive calendar rollover; pending work rotates by last attempt. The next run
restores a trusted main-workflow checkpoint and an existing capture PR before collecting. Raw
archives and reconciled evidence publish only through a `codex/*` PR with exact-commit Verify,
required checks and review gates. An artifact is saved before publication so a blocked PR does
not lose collection progress. No production retry, account mutation or manual dispatch is
needed to test this implementation; tests use local public-source fixtures.

The general contract verifies archive shape, retained evidence and reader behavior. The capture
workflow additionally reproduces reconciliation against the exact books and relationships it
used before opening a PR. A later Finology capture can make an earlier comparison outdated;
per-source check dates disclose that, and a new scheduled reconciliation updates it.

Validation: `verify-super-investors.mjs`, `verify-holdings-integrity.mjs`,
`verify-investor-changes.mjs`, `verify-public-holdings.mjs`,
`verify-investor-publishing.mjs`, `verify-super-investors-ui.mjs`. The returning-session
service-worker check also imports the changed investor view before and after cache adoption.

Publication currently enforces a 24 MiB compressed static-asset ceiling and a 256 MiB expanded
restore limit. Exceeding a limit fails publication and retains the checkpoint; it never prunes
older disclosures to make the file fit. Storage must be expanded before further publication.

Before the first scheduled capture, `public-holdings.json` is an explicit `not-started` manifest with null source-check dates and no records. Readers expose that state without a missing asset request, and never adopt it as a successful empty disclosure capture or overwrite previously saved evidence.

## Sattva Family manager parity (12 October 2026)

My Managers uses the authenticated Sattva Family workbook, as requested by the owner.
It groups canonical held positions and retained ledger events by the existing custodian
classification, and lists private-fund investments and held fund units/ETFs. Units also
remain inside their custodian books; their directory is not additional NAV. Fund entries
remain separate workbook investments, including repeated names; no source rows are deleted.
Manager workspaces provide holdings/units, period-filtered and retained transactions,
capital amounts, available gain/capital-multiple measures, exchange evidence and profiles.
Fund identities include their name and source-entry identifier: reusing a workbook row
for another fund cannot transfer the previous fund's reviewed public relationships.

The bridge revalidates the adopted whole-family book and serializes this read with
positions/questions. Account/owner/counterparty identifiers and raw workbook rows are
excluded. The complete bounded projection stays in memory, never in static assets,
browser storage, bookmarks or model requests. Archive/auth invalidation clears private
cards and open evidence/workspaces; failed source checks withhold figures until recovery.
Private exports recheck the source revision after asynchronous workbook generation.

Workbook periods, valuation marks, source-check times and private workbook receipt dates
remain separate. Carried purchase dates are earliest ledger sightings, not execution dates;
family transfers remain labelled and all real repeated lots survive. Custodians are not
inferred to be discretionary PMS mandates. Private funds are not assigned regulatory AIF
status. The workbook does not supply paired PMS statements, manager NAV/flow return series,
dated private capital calls/distributions or AMC scheme look-through; these remain explicitly
unavailable. Existing public quarterly histories, official source coverage and exports stay
intact. My Managers cards cover the whole book; Watchlist narrows eligible workspace
securities/activity without changing the full-book weight denominator.


### Manager transport reliability (13 October 2026)

Family's `sourceRevision` is the complete serialized workbook catalogue plus its scope,
not a fixed-length hash. Retaining or uploading workbooks grows that identity. The manager
reader preserves it exactly and validates it inside the existing complete-message limit of
5,000,000 characters; a separate 1,000-character revision limit rejected legitimate books.
Nothing is truncated to make a reply fit. Required source fields, dates, record identity,
coverage counts and all row/number guards remain in force.

The shared contract is `public/js/data/managers-contract.js`. Source freshness is checked
when the serialized bridge request actually starts, after earlier private reads finish.
Validation failures identify only the contract section, with no private values in the error.
Failed checks still withhold figures; the visible 60-second/focus/reconnection checks recover
automatically. Auth/archive invalidation clears cards and workspaces immediately, and ready
notifications schedule a new generation even while the revoked read is settling. A revoked
result or its cleanup cannot replace/clear the new pending read.

`verify-managers.mjs`, `verify-manager-reader.mjs`, `verify-super-investors-ui.mjs` and
`verify-manager-upgrade-ui.mjs` cover catalogue-sized revisions, the full sharing bound,
queued freshness, invalidation races, private failure handling, automatic recovery, scopes,
workspaces and returning readers upgrading the immutable service-worker module graph.


Live validation also found the active FY27 workbook reports `bookAsOf: 2027-03-31`.
This is Family's workbook period label, including while that year remains open; rejecting
it because the period ends after today withheld a valid checked book. ISO calendar validity
remains required, while source freshness continues to use only the actual `checkedAt`.
Cards/workspaces identify a future workbook period as an open period. Valuation dates and
basis remain separate; no future period is presented as a completed statement, transaction
date, current mark or source check. Browser fixtures now exercise an open FY period together
with a catalogue-sized revision, including the returning-session upgrade from the rejected
period guard. Stale checks and invalid calendar dates still fail.
