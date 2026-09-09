# Private Screener summaries

The Con-call library has one inline Summary action per call, joining only the exact Screener
summary IDs already attached to that call. Different transcript/recording notes are versions in
one reader. The reader fetches saved text from the dashboard; it never navigates to Screener,
embeds its page, generates analysis, or initiates a source request. Buttons remain hidden until
private collection is enabled or the authorised reader has saved notes for that exact call.
When collection is disabled, unsaved calls stay hidden even after table filtering or pagination.

## Current activation state

**Enabled on 8 September 2026.** The user confirmed the permitted private caching/display
arrangement, authorized production activation and automatic start after cooldown, and requested
that this same authorization not be asked again. The standing instruction is also in `AGENTS.md`.

The [initial activation run](https://github.com/techmuns/Sattva-Central-Research/actions/runs/34232669785)
and [subsequent automatic run](https://github.com/techmuns/Sattva-Central-Research/actions/runs/34234674937)
succeeded with zero source requests during cooldown. The live embedded dashboard verified the
private reader, coverage for all 118 then-current holdings, 145 queued notes and the persisted next
timer check. Anonymous and invalid-token requests were denied. These counts are observations,
not fixed membership or completeness guarantees.

The source's 8 September daily-limit refusal remains recorded until 9 September at 06:48 UTC
(12:18 pm IST). The existing schedule starts eligible collection automatically after that time.
Successful paid-body capture still needs verification: local parser fixtures do not establish
compatibility with an unseen successful source page. Unrecognised/incomplete templates fail closed.

Production configuration and verification:

1. Worker secret `SCREENER_SUMMARIES_ENABLED=true` and repository Actions variable
   `SCREENER_SUMMARIES_ENABLED=true` are both enabled and required.
2. Keep existing repository secrets `SCREENER_USERNAME` / `SCREENER_PASSWORD`, and Worker
   `GH_DISPATCH_TOKEN`, `GH_REPO=techmuns/Sattva-Central-Research`, `GH_REF=main` configured.
   No new long-lived collector credential is needed. GitHub's signed OIDC token is restricted
   to this repository's immutable IDs, main ref and exact collector workflow.
3. Worker secret `SCREENER_SUMMARY_READER_EMAILS` restricts the reader to the user's verified
   signed-in dashboard account. The default deployment-owner check through `MUNS_TOKEN` is
   available when no explicit private reader is configured. Every reader token is
   verified through Munshot's official `/auth/me`; no browser-provided email or decoded JWT
   claim grants access. Authenticated reading and unauthenticated/invalid-token denial were verified live.
4. Let the enabled half-hour schedule make its first eligible run after the recorded cooldown.
   Check the source body against the inline rendering, actual portfolio/source check times,
   the successful saved count and per-holding coverage. Do not claim live capture until this
   succeeds. Inspect a refusal without retrying around it. A source template change needs a
   fixture and reviewed parser fix before another eligible attempt.

Setting the Worker gate false stops new writes and the next alarm. Disabling the Actions variable
also avoids runner setup. Existing private saved bodies remain readable. Neither switch deletes
history. A deployment or workflow edit must never reset the private account object or its budget.

An empty summary popup contains only “Please check back” and the next eligible day/time in IST.
It combines the requested records' actual retry eligibility with the known cooldown and budget
availability, then allows both the next durable-timer and independent workflow slots to reach
eligibility. A recent pre-eligibility workflow run can defer the durable timer, so the later slot
is the conservative check-back time. Inactive/untracked reports and unknown dates say “Please check
back later” without inventing a time. The open popup rereads private saved state when coverage
updates and shows a report automatically once saved; these reads never request source summaries. This is a time
to check again, not a guarantee that a particular queued report will be ready. Source attribution
remains with saved reports; detailed source health and gaps remain in the separate coverage view.

## Membership, queue and history

Every collection first reads the **live Family Office portfolio**, validates the complete response,
then reads the latest digest-verified complete Screener document-index checkpoint. It does not depend
on a committed portfolio snapshot or Screener's mirrored watchlist catching up. The portfolio must
be checked within 90 seconds and the source catalogue within 30 minutes when an upload begins; a newer failed document
check blocks discovery. Failed discovery preserves the previous membership and all saved records,
marks coverage failed and pauses source claims until a successful check.

### Independent document recovery

The 9 September incident exposed a dependency error: successfully read documents were discarded
when a later, unrelated portfolio calendar could not be parsed. The collector now atomically
writes `screener-concalls-v1.json.gz.documents.gz` before reading either calendar. Its upload runs even
after a calendar failure. It contains public document metadata only, with no paid notes or account
state; the existing combined calendar artifact still requires all its own reads to succeed.

A checkpoint begins `pending`, so interrupted work cannot authorise paid requests. A completed
document capture may be used after a confirmed calendar `shape` error, with authentication,
positive calendar structure and refusal checks still required. Unknown/interstitial/partial pages
remain blocked. Source refusals, session/identity failures, transport errors and
unknown failures remain blocked. Temporary server failures retain bounded retries; unchanged malformed calendar pages are not retried in the same
run. Fixed diagnostic categories identify the rejected calendar stage without publishing its HTML.

The private collector validates the artifact's digest, origin, owning workflow/run, full-history
counts and explicit outcome. A newer completed run without a valid document checkpoint blocks new
requests; an older checkpoint may only restore the history baseline. Legacy successful artifacts
remain readable during rollout. Expired/corrupt artifacts and stale document checks fail closed.
Calendar failure remains visible as calendar failure and cannot claim fresh calendar coverage.
The public Con-call library also adopts newer validated document metadata independently, so
new calls remain visible. Previously confirmed calendar rows retain their own check time and
failure state; document arrival cannot make a retained calendar look freshly checked.
Earnings Calendar keeps its original calendar-only reader and request budget; it never spends
company-identity requests on document recovery.
No schedule, private storage identity, quota, reservation, cooldown or paid-body reader is reset.

This isolates calendar defects from summary discovery; it does not guarantee source availability
or successful paid-body parsing. The normal schedule must still verify the first saved report.
The shared Family Office loader's existing reconciliation guard still applies to a fall of more
than 20% against its reviewed baseline. Such a change is shown as unavailable until reconciled;
it is never silently accepted as a partial book. Older workbook dates/uploads cannot replace a
newer revision already seen by the private store, even when the network check itself is recent.

Inventory uploads use an owned manifest and batches of at most 250 targets, each at most 4 KiB.
All 25,000 supported targets can be uploaded without a single large request. An 8 MiB transport
bound also accommodates the maximum projected 5,000-holding manifest and coverage response.
Only a complete, unique, identity-checked staging inventory is published, in one SQL transaction.
Repeated batches/completions are idempotent; missing or conflicting batches cannot retire records.
Staging survives a Worker restart and expires after 15 minutes. An interrupted upload remains
visibly incomplete; the next run can replace expired staging while retaining the previous archive.

Each current holding has a coverage record. Matching uses its exchange ticker, exact ISIN registry
identity (including BSE codes), or a unique exact normalised name for tickerless holdings. Conflicts
stay unresolved. Holdings without a matched source company or published summary remain visible as
gaps; membership never implies source coverage. Legitimate additions and reductions are accepted
from the validated complete portfolio. Exits stop new collection for that company but retain its
saved history. Returning holdings reuse their exact-ID copies.

Queue order gives every company its newest available note before collecting older notes. New
summary IDs from future catalogue checks enter automatically. Repeated IDs do not consume slots.
All discovered history remains queued within the provider allowance. There is no promise of
immediate complete backfill, nor of a summary for every company: source availability and successful
identity resolution still determine coverage.

## Quota, failures and cadence

- Scheduled every 30 minutes and on `family-book-updated`; at most 10 source attempts per run.
- A private Durable Object reserves each attempt **before** opening the source, serialises account
  access and enforces at least 15 seconds between attempts, with at most **60 in rolling 24 hours**.
  This leaves nominal room beneath the reported 80/day allowance. Manual usage cannot be observed
  by this ledger; the source's own refusal always overrides remaining local allowance.
- Each reservation permits one exact main-frame summary request. Source redirects, automatic
  reloads, subframes and stylesheet imports cannot make extra uncounted summary requests.
- Reservation loss, runner crash and login failure count conservatively. An interrupted record
  waits 24 hours. Neither a restart, new run nor midnight clears the ledger. Repeating a completion
  after a lost response is idempotent; repeating a reservation never issues its source request again.
- Rate limits (including HTTP 200 limit pages), access/session failures, network errors, company
  identity mismatches and incomplete templates pause the account for at least 24 hours. A longer
  Retry-After is respected without shortening it. A missing publication
  waits seven days for that ID. The initial object also retains the observed 8 September refusal.
- A separate durable half-hour alarm is armed by an authorised discovery run. It can dispatch the
  fixed workflows if GitHub's schedule slips; it never cancels a running workflow. Before a due
  summary run, it checks the document catalogue's workflow. A missing run or one started more than
  15 minutes ago causes a normal incremental catalogue refresh. An active catalogue is checked
  again in two minutes, without another dispatch. The timer durably reserves a 15-minute dispatch
  window before network I/O, so delayed run listings cannot create a two-minute source cadence.
  A run overdue by 45 minutes remains visible and
  uses the ordinary half-hour recovery interval. Once a recent catalogue completes, the summary
  workflow validates its actual document checkpoint before any paid request. A completed calendar
  failure alone neither authorises nor blocks that checkpoint. This dependency recovery works
  without an open dashboard or GitHub cron delivery. Recent summary runs schedule the next check
  from their actual creation time, avoiding an accidental extra half-hour delay. The next alarm
  is saved before network I/O. Without an initial successful workflow checkpoint only GitHub's
  schedule is available; a read-only dashboard request cannot arm or dispatch collection.
- Browser coverage refreshes every minute while visible and on return/reconnection. Saved copies
  are readable during source pauses. Source/portfolio check times and stale/failed coverage are
  explicit; a successful timer dispatch is not a successful source check. Failed, overdue or missing
  timer checks appear immediately in the footer and live coverage view, with the actual last and
  next timer check times, independently of the source catalogue's freshness. A source cooldown
  is shown alongside failed or stale portfolio discovery; it cannot conceal unchecked holdings.

The archive uses a distinct fixed Durable Object name in the existing SQLite namespace. Bodies have
no automatic expiry; they never enter Git, public Actions artifacts, public static snapshots,
localStorage or IndexedDB. A session-only cache holds at most 100 bodies and clears on account
change, including while another tab is open. Reader responses are private/no-store and HTML is
never accepted as executable markup. Source scripts and third-party resources are blocked during
collection; only plain structured text, provenance and exact source IDs are retained.

Operational bounds are explicit: 50,000 retained IDs, 128 KiB per summary, 25,000 catalogue targets
per discovery and 5,000 holdings. Reaching a bound stops progress with unavailable coverage; it does
not evict older notes. Source edits under the same summary ID are not automatically re-fetched.
There is no separate off-provider backup/export in this change; storage loss outside the Durable
Object retention guarantees would require recovery or recollection within the same quota.

## Verification

`verify-concall-summaries.mjs` exercises portfolio transitions, tickerless matches/conflicts, exact
source IDs, crash/rolling-budget behaviour, fairness, retention, source refusals, reader privacy,
real RSA-signed OIDC claim verification and timer recovery. `verify-concall-summaries-runtime.mjs`
uses local workerd for real SQL/RPC, concurrent leases, and body/budget/alarm persistence across
restart, including finishing a staged upload after restart. The 25,000-target transport boundary,
partial/replayed uploads and scheduler failures are also verified. `verify-concall-summaries-ui.mjs` covers one inline action, source versions, pending recovery,
inert source text, logout and delayed responses, disabled state, portfolio gaps, light/dark contrast,
narrow layout and offline parser failures. All three are CI checks; none reads production summaries.

`verify-screener-concalls.mjs` also runs the real collection CLI against an offline browser
transport: portfolio/market calendar changes and empty market schedules preserve complete documents,
refusals block paid eligibility, document failures produce no usable checkpoint,
and recovery publishes the complete calendar again. Artifact tests cover pending/crashed writes,
newer failed runs, legacy rollout, corruption, expiry and atomic preservation after invalid input.

The independent checkpoint is published as `screener-concalls-v1.json.gz.documents.gz`. With
[upload-artifact's unarchived mode](https://github.com/actions/upload-artifact#inputs), GitHub uses
the actual file basename and ignores the configured artifact label. The reader and workflow path
are checked together to prevent a successfully uploaded checkpoint becoming undiscoverable.
Calendar date parsing supports Today and Tomorrow across month/year boundaries. Failed portfolio
parses report only fixed structure flags and counts; source HTML, text and account values stay out
of public logs. Recovery recognises an explicit Upcoming tab label as well as a heading; it still requires a complete dated company list and current authentication. Unknown responses still block paid requests.
