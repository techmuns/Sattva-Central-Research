# Mutual Fund ownership

The Mutual Funds tab shows every active portfolio company, including companies with no matching
fund disclosure. Largest holdings uses only the authenticated, complete Family position weights,
in memory. Without those weights the screen explicitly falls back to Newest. Newest orders by
actual disclosure month and source check time; a check is not a new trade date. Watchlist and
Universe use the existing exact-identity scope rules. The detail popup uses Trendlyne's grouped
month columns: stock position value in crores, percentage of scheme NAV, shares, absolute change
and percentage change for the current month; shares and percentage change for earlier months. A month selector reads any retained period; each
response contains three displayed months and the previous observation needed for percentage math.
No charts or extra summary cards are added to the main table.

## Calculation and source contract

`worker/mutual-funds-model.mjs` and `scripts/lib/mutual-funds-build.mjs` own the arithmetic. The
browser receives small summaries and fetches a company's precomputed detail only on opening it.
Company identity is an exact ISIN join, with the existing exchange security master supplying
symbols; the active Family book overrides display names. Scheme identity uses AMC plus the
normalized disclosed scheme name, never sheet order. Renamed schemes are separate until a reviewed
crosswalk establishes continuity. Explicit derivative contracts and short positions are excluded from share ownership, even when
they carry the underlying equity ISIN. Instruments whose cash/derivative section is unresolved
remain withheld. Duplicate scheme/ISIN observations and inconsistent historical
month labels are recorded as validation findings rather than guessed.

Net change is additions minus reductions **only for schemes reporting both adjacent calendar
months**. A missing scheme report or missing quantity is unknown, not zero. A stock absent from a
captured scheme can be represented as zero only where the scheme's parsed NAV weights reconcile
within 95–105%; otherwise its absence is unverified. This is a parsing safeguard, not independent
certification that the AMC's report is exhaustive. Corporate actions can change share counts without
cash trading. New positions show “New”, not a percentage calculated by dividing by zero.

“MF shares held” sums quantities reported for the displayed month and is explicitly subject to
coverage. Company ownership equals those shares / company shares outstanding. NSE issued shares
are accepted only on an exact ISIN match; a refused session stops further NSE reads. AmfiBeas's
market-cap/price estimates remain separately labelled with `≈` and source/date/method. Denominators
older than seven days, invalid values, and ratios over 100% produce an unavailable percentage.
Fund AUM % is the AMC-disclosed position weight. The screenshot-compatible AUM (Cr) column means
**the stock position's market value**, not the fund's total assets; its tooltip states this.

## Collection, delivery and retention

The normal merge pipeline starts the independent `mutual-funds:v1` durable timer. It requests the
fixed `mutual-funds-refresh.yml` workflow with a 15-minute target. A GitHub schedule is a fallback.
An in-progress job is never duplicated; source download duration, GitHub queueing and unavailable
endpoints can extend this interval. The existing read-only health workflow checks source coverage
and the durable timer. `/api/mutual-funds/health` returns 503 for stale, partial, unavailable or
unfinished capture. Browser reads never start a collector.

The runner checks out current AmfiBeas **data** and pins its public AMC HTTP parsers and dependency
lock to the reviewed revision in the workflow. Those dependencies live in a separate temporary
checkout; the dashboard keeps its no-dependency, no-build application contract. Supported AMC
public page/API/file adapters run server-side; no browser challenge, proxy rotation, Trendlyne
scrape or licensed Trendlyne API is introduced. There is no claim of contractual Trendlyne parity.

Four isolated source processes run at a time, each with a two-minute budget. A blocked AMC cannot
hold up all later AMCs. Only the coordinator writes the shared coverage checkpoint, while each
child atomically replaces its own AMC file. Timeouts retain prior data and record an unavailable
check. Company-denominator reads have a separate five-minute limit and save each verified result
as it arrives, so that endpoint cannot indefinitely delay publication of fund disclosures.
Each source finishes to a local checkpoint. A timed-out or failed source stage still runs the
publication stage, marking unattempted AMCs unchecked and retaining good company data. A new run
reconciles the overlapping months in the current source data. Bounded fragments carry individual fund/month observations, with all parts acknowledged before
a company is complete. SQLite stores one observation per row and immutable corrections plus
revision references; no upload or database cell grows with the complete history. Newer complete
scheme inventories can correct removed holdings to nil; partial reports cannot. Source rechecks
do not copy identical historical books. Upload receipts retain only the three newest runs;
this does not remove observations, correction chains or the original capture start time. An
initial universe upload keeps at most four companies in flight, with fragments ordered within
each company and all acknowledgements awaited before completion. A failed company leaves the
run partial while other successful company checkpoints survive. Temporary server errors or lost
acknowledgements retry the exact idempotent request up to three times before the run remains partial. An
interrupted publish stays `collecting` until every manifest company is acknowledged. A later run
reconciles it, while older data remains readable. Signed GitHub OIDC claims restrict writes to this
repository's main-branch collector workflow. Reader routes are read-only and ETagged.
Scoped summary reads bind the validated ISIN list as one JSON array, preserving
the full 250-company response below Cloudflare's 100 SQL-parameter limit. The local
Worker regression covers 100, 101, 118 and 250 requested companies and universe paging.

All captured months and distinct corrections are retained in shared storage, including companies
that leave the portfolio. Initial history varies by AMC; months absent from the upstream snapshot
cannot be claimed recovered. Storage is finite and no exhaustive industry archive is promised.
The committed portfolio seed is a dated fallback for static/local operation and initial rollout;
its source observations also join durable capture, so a failed first download cannot discard
already captured disclosures. Newer verified observations and confirmed removals take precedence;
the seed is not the collection clock. All current companies, including future holdings, are matched
against the complete captured stock universe on each collection.

The visible tab revalidates on opening, every minute while visible, on return after inactivity,
and on reconnection. It retains rows and filters during failures, restoring persisted last-good summaries and detail
even after a reload. The shared table kit windows
summary rows; detail pages show 50 schemes at a time while searching all schemes. Actual source
check timestamps stay separate from the displayed month. Private portfolio weights never enter
public snapshots, API payloads or browser persistence.

## Initial evidence and limits (20 September 2026)

The first direct source pass returned current August reports for 35 of 50 indexed AMCs.
Repairing published-file discovery for Abakkus and Old Bridge raised this to 37 of 50, with 33
passing all instrument/quantity checks. Their public pages had changed structure; the files were
already published. Eight primary adapters were unavailable and five returned an older month. Some retained AmfiBeas
historical buckets also contain date/identity parsing findings. Those limitations are exposed;
a current file timestamp cannot certify full industry coverage. NSE's denominator route refused
this local environment, so the seed has labelled estimates where a recent one exists, otherwise
a blank percentage. Closing these source gaps requires working AMC endpoints or an authorized
licensed feed. Neither a timer nor a successful deployment establishes zero publication lag.

Local verification covers arithmetic and source gaps, exact identities, month rollover, retained
history and corrections, interrupted/restarted SQLite collection, durable retry, OIDC boundaries,
large real-book RPC, conditional HTTP responses, portfolio weight sorting, grouped popup columns,
search beyond mounted rows, keyboard close, light/dark/mobile layouts and existing-session cache
upgrade. Ask Research receives all selected portfolio summary rows before other topic samples,
within its separately validated expanded evidence bound; source coverage remains explicit.

## Quantum monthly disclosure adapter

Quantum's public portfolio API is queried for the exact reporting year and month,
including every returned page. A download is accepted only from its official
FileCDN and only when each parsed scheme confirms the requested reporting month.
The unfiltered page can list a much older September workbook above the current
August report; link order is not evidence of freshness. FoF workbooks append a
labelled "Monthly Portfolio Statement of the Underlying Schemes" section. The
parser stops at that heading, preserving directly held fund units and excluding
the underlying funds' equity portfolios from direct company ownership. Previously
captured Quantum observations already exclude that appendix and remain retained.
If a changed FoF layout still yields company equity, the check fails and retains
the last good disclosure until its ownership context can be verified.

## Alternate public disclosure routes

The collector also reads the fund houses' own current catalogues for 360 ONE,
Axis, LIC, Quant, Mirae, Union, Sundaram and Angel One. These routes replace stale
filename templates and incomplete discovery in the pinned upstream adapters:

- 360 ONE pairs each file's displayed month with its filename, including the new
  `month: null` group; Axis recognizes the renamed consolidated monthly workbook.
- LIC discovers its current monthly category and requires both equity and debt
  consolidated reports. Quant reads the site's actual monthly list of fund files.
- Mirae traverses the complete paginated catalogue with stable counts and unique
  document IDs. It collects the current and three preceding months, current first,
  to recover missing comparison baselines. Union filters monthly portfolio titles
  at the source and follows every result page rather than searching its first
  100 recent notices. Missing or changing pages fail the check.
- Sundaram enumerates the current public fund-card list; Angel One reads the
  current monthly download links. No scheme universe is hard-coded.

Four files per AMC can download concurrently within the existing two-minute AMC
budget. Every completed file is checkpointed. A failed or interrupted file retains
the completed reports and older history, while the check remains partial with
expected, completed, failed and pending file counts. Only permitted disclosure
hosts are read; unexpected redirects and access refusals fail visibly. These
checks run independently of the dashboard and add no client-side processing.

Each file must confirm its reporting month. Overseas-only, bullion and overnight
reports with no tracked Indian shares/units require a recognized scheme type,
dated monthly header, an ISIN column, reconciled grand total, and only recognized
cash, bullion or foreign-ISIN positions. Indian shares/units or an unclassified
position prevent a verified-empty result. A valid empty report can establish an
exit without removing earlier ownership. Missing files cannot do so. Explicit
underlying-fund appendices remain excluded. Changed descriptive suffixes retain
an unambiguous existing scheme name; regular/direct plans and renamed funds are
never joined by fuzzy matching. Axis's two FoF titles are read from their explicit
code/name header instead of the generic "Mutual Fund Units" section heading.

Local September 20 checks recovered August reports for all eight routes with no
current ownership validation findings. This is evidence for those sources at that
time, not a guarantee of industry completeness or permanent availability. Trendlyne
is not connected: its public holdings endpoint refused the direct request. Screener's
public quarterly shareholding pattern is not a monthly scheme-level substitute.
Remaining source gaps continue to appear in coverage; there is no promise of zero
publication lag or an exhaustive history.

`verify-mutual-funds-public.mjs` covers catalogue pagination, period boundaries,
source refusals, safe file hosts, partial file recovery, verified empty reports,
scheme identity and comparison-history retention. It runs in the existing source
verification job. Source tests and publication use the normal pull-request and
merge-triggered pipeline; no manual production capture is required.
