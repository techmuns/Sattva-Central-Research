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
coverage. The MF ownership column equals those shares ÷ company shares outstanding × 100.
NSE issued shares are preferred, then Moneycontrol's directly supplied `SHRS` field. Both
require an exact live ISIN match, a positive safe integer and a source quote no older than seven
days. A refusal stops further reads to that source for the run. The Moneycontrol map discovers
codes (including BSE-only identities); its stored counts and file timestamp are never used as a
fresh denominator. AmfiBeas's market-cap/price estimates are the last resort, labelled `≈`.
A newer estimate cannot displace a fresh directly supplied count. Missing/invalid quantities,
share counts or source dates, counts older than seven days and ratios over 100% withhold the
percentage. Saved browser rows also expire during outages.

The tooltip and company detail expose the formula, count, provider, actual successful check,
source quote date and a failed latest attempt separately. Providers do not supply the count's
own effective date; the quote timestamp is not represented as one. Historical MF months use the
latest available denominator, not a reconstructed historical capital structure. The numerator
remains subject to disclosed scheme coverage; this is not a claim of total industry ownership.

The existing automatic collector checks share counts daily, prioritizing the live portfolio
(including new holdings) and continuing across every captured Universe company. Each pass is
bounded to 200 companies/four minutes. Persisted per-company attempt checkpoints resume the
oldest unchecked company on later runs; failures preserve the last good value and its date.
Unavailable identities remain explicit. No manual refresh or new browser collection is needed.
Fund AUM % is the AMC-disclosed position weight. The screenshot-compatible AUM (Cr) column means
**the stock position's market value**, not the fund's total assets; its tooltip states this.

## Collection, delivery and retention

The normal merge pipeline starts the independent `mutual-funds:v1` durable timer. It requests the
fixed `mutual-funds-refresh.yml` workflow with a 15-minute target. A GitHub schedule is a fallback.
An in-progress job is never duplicated; source download duration, GitHub queueing and unavailable
endpoints can extend this interval. The existing read-only health workflow checks source coverage
and the durable timer. `/api/mutual-funds/health` returns 503 for stale, partial, unavailable or
unfinished capture. Browser reads never start a collector.

AmfiBeas owns source collection. Its shared collector runs throughout the month
with a 15-minute target, retains completed files and source continuation checkpoints,
and publishes raw snapshots before rebuilding its own dashboard. GitHub queueing,
source response times and the downstream import interval can add delivery delay.
There is no claim of zero publication lag or complete Trendlyne parity.

The Sattva runner reads the latest AmfiBeas repository data from one coherent commit.
It requires the versioned `public/amc-holdings/coverage.json` manifest and verifies
the source inventory, exact file sizes and SHA-256 checksums before import. It does
not install AmfiBeas dependencies, execute its code or download AMC workbooks.
Missing or mismatched files fail the import and retain the already published book.
Unavailable sources remain in coverage while verified files from other AMCs import.
Source check times pass through unchanged; a new Git commit is not a fresh source check.

The shared manifest includes AMFI directory discovery, newly listed fund houses,
last complete checks, partial attempts and historical continuation state. Current
source validation runs upstream, and Sattva retains its own equity/quantity checks
before projecting company ownership. Shares-outstanding estimates still come from
AmfiBeas, with Sattva's bounded NSE/Moneycontrol reads providing direct counts first.

Publication uses ordered, idempotent fragments and retains every captured monthly
observation and correction. An interrupted upload remains incomplete until all
companies are acknowledged; successful company checkpoints survive other failures.
The durable timer and visible-tab revalidation remain automatic. No source parsing
or new processing is added to the browser.

All captured months and distinct corrections are retained in shared storage, including companies
that leave the portfolio. Initial history varies by AMC; months absent from the upstream snapshot
cannot be claimed recovered. Storage is finite and no exhaustive industry archive is promised.
The committed portfolio seed is a dated fallback for static/local operation and initial rollout;
its source observations also join durable capture, so a failed first download cannot discard
already captured disclosures. Newer verified observations and confirmed removals take precedence;
the seed is not the collection clock. All current companies, including future holdings, are matched
against the complete captured stock universe on each collection.

The visible tab revalidates on opening, every minute while visible, on return after inactivity,
and on reconnection. Public summaries restore from the device cache before network revalidation;
the table updates as soon as primary summaries arrive, without waiting for the private supplement.
A changed primary row invalidates its older supplemental overlay. Source timestamps do not
advance on a cache read. “No disclosure” means no matched report in captured sources, not zero
ownership; “Comparison unavailable” identifies missing adjacent-month quantities. Neither is a
running calculation. Comparisons are already computed and saved during collection.
It retains rows and filters during failures, restoring persisted last-good summaries and detail
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

## Shared source implementation

The source readers and their catalogue, workbook, timeout and recovery tests now
live in [AmfiBeas](https://github.com/techmuns/AmfiBeas/tree/main/scripts/ingest/amc-factsheets/shared).
See its [shared feed contract](https://github.com/techmuns/AmfiBeas/blob/main/docs/SHARED-HOLDINGS.md).
Sattva's tests cover checksum/inventory failures, unsupported feed versions,
source-clock preservation, interrupted upstream capture, partial source coverage,
retained history, ownership arithmetic and delivery to all portfolio companies.
The earlier source findings above remain historical evidence, not current coverage.
