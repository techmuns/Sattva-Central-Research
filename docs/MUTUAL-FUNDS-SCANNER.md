# Private MF Scanner supplement

MF Scanner stock pages supplement the primary AMC/AmfiBeas disclosures for the
live Family Office portfolio. A dedicated workflow and concurrency group prevent a slow or failed primary
import from holding up supplemental capture. The existing durable watchdog drives
both workflows independently; the backup also has its own GitHub schedule.
The target is a check every 15 minutes, subject to run duration and source access.
This is monthly disclosed ownership, not live trading or a guarantee of complete
industry coverage.

The source catalogue discovers stock URLs. A page must contain the portfolio's
exact ISIN, matching canonical URL, consecutive reporting months, all expected
active fund rows, unique scheme URLs, and consistent share arithmetic. Unknown
AMC codes are withheld and counted. Pending or omitted reports never establish
zero. Rounded position values are not used to infer quantities or AUM percentages.
Primary observations (including verified nil holdings) take precedence. Scheme
names are compared after formatting/share-class normalization; ambiguous matches
and possible renames are withheld, with counts retained in each stock's supplement
metadata. Source timestamps, per-page failures and unresolved identities are
separate from primary AMC coverage. A checked stock page is not proof that an
entire AMC or every portfolio company is covered.

The fixed Mutual Funds Durable Object stores private, normalized observations and
immutable corrections separately from public holdings. Capture prepares cached
summary rows; detail is assembled from bounded monthly rows on the server. Primary
captures recalculate affected private summaries. Saved observations survive failed
requests, interrupted workflows and source month rollovers. Initial backup history
is the two months exposed by a verified stock page; subsequent captured months are
retained. Older primary history remains available. There is no historical backfill
claim for months that MF Scanner's stock page did not expose.

Source requests have a persisted reservation and two-second host spacing. A page
is due again after 15 minutes, and abandoned reservations expire. HTTP 403 stops
requests for 24 hours; 429 respects Retry-After with a minimum one-hour cooldown.
Neither a process restart nor another workflow run bypasses that budget. Lost reservation acknowledgements replay the same unexpired lease, while completed leases cannot fetch twice. Source
redirects are refused. No browser impersonation, authentication bypass or proxy
rotation is used. A failed catalogue check can use the saved catalogue except when
the host has refused access. Counts alone enter public workflow logs; no provider
pages or observations are uploaded as public artifacts or committed snapshots. A failed or incomplete capture exits with a failed health gate after saving progress; it is never an all-green run with silently missing pages.

`/api/mutual-funds/private` and `/api/mutual-funds/private/company` require the same
verified account-owner/allowlisted Munshot session as private Screener summaries.
They reject cross-site readers and return `private, no-store`. Public MF endpoints
continue to serve only primary data. The dashboard keeps supplemental responses in
memory and clears them and open detail on a session change; IndexedDB and the
service worker never persist them. Standalone readers without a verified Munshot
session see primary data and a sign-in explanation. The existing table and popup
layout are retained; source links identify MF Scanner observations. Ask Research carries the backup source, month, check time and check state per contributing stock. Column-based provider encoding keeps the complete portfolio within the existing evidence budget.

Verification: `node scripts/verify-mutual-funds-scanner.mjs`,
`node scripts/verify-mutual-funds-runtime.mjs`, and the Mutual Funds browser test in
CI cover data integrity, primary precedence, private/public separation, restart,
source cooldown and browser persistence boundaries.
