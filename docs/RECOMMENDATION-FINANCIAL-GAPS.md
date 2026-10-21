# Financial history gap audit and targeted filling

Audit checked on 22 October 2026. Baseline: automatic run `39645928132`, immutable archive
asset `663321376`, model observation cutoff **21 October 2026, 23:18:20 IST**. Counts below
describe that saved observation, not complete exchange/universe coverage or investment quality.

| Financial history in that observation | Companies |
| --- | ---: |
| At least one eligible normalized financial fact | 169 |
| A supported INR quarter on one statement basis | 145 |
| A quarter ending within the unchanged 150-day limit | 126 |
| Missing a comparable year-earlier quarter among those 145 | 144 |
| Missing verified annual/TTM diluted EPS and revenue baselines among those 145 | 126 |
| Missing eligible annual/half-year cash-flow evidence among those 145 | 9 |
| Latest captured eligible cash flow was nonpositive among those 145 | 50 |

The quarter ends were 30 September 2026 (117), 30 June 2026 (9), 31 March 2026 (18),
and 30 September 2025 (1). A reported loss, negative cash flow or contradictory statement is
not an absent value. Capturing more history cannot turn such a failure into a positive fact.

## Cause and free source

The broad archive cursor had only moved backward a few weeks. Recent original NSE XBRL files
often supply the current quarter and current YTD; they do not necessarily contain the year-earlier
quarter or the last annual EPS. The scorer correctly refused to calculate growth or valuation
from missing inputs. Reading another recent weekly index could not close these older-period gaps.

NSE's own corporate-filings JavaScript uses `symbol` for company-specific financial indexes.
Its integrated and legacy financial endpoints were checked directly with LTTS, including a
two-year request returning only the requested company. Original September 2025 and March 2026
filings were retrieved and their issuer, reporting periods, units and facts verified. The annual
diluted EPS in that source is 120.53; it is an actually reported annual value, not annualised YTD.
The three original XML fixtures, their hashes and original URLs live in
`scripts/fixtures/recommendation-financial-gaps/`. They are offline tests, never production seeds.

## Background collection

Each existing Actions capture now:

1. Audits every retained company. Exact rows identify each current/year-earlier revenue, profit,
   pre-exceptional PBT and diluted EPS, quality fields, annual/TTM baselines, cash statements,
   statement basis, observed source versions and unresolved conflicts.
2. Separates missing fields, known nonpositive values, source conflicts, stale quarters and newer
   known filings still waiting to be read. It does not treat an older complete quarter as fresh.
3. Uses company-filtered, fixed two-year publication windows to discover required original filings.
   Current financials and recent dated catalysts receive collection priority; within that group,
   companies without already-known fundamental failures are checked first. This affects collection
   order only. Broad discovery and ordinary financial/event reads continue for the entire universe.
4. Reads all known relevant-period filings/revisions, newer quarters and recent audited annual
   candidates. Dates and values come from verified original XML, not filenames or index estimates.
   The queue recomputes requirements if a newer quarter becomes available.
5. Saves company windows, family order, pagination, retries and audit snapshots in the same permanent
   SQLite archive. Budget interruptions resume; verified empty index windows do not close data gaps.

Targeted work shares the existing 200-request/ten-minute source ceiling, using at most 100 requests
and four minutes within it. Index discovery keeps its 60-request slice; ordinary financial and
event reads each retain 20-request slots; unused targeted capacity returns to ordinary financial
reads, up to their original 100-request limit. All reads remain paced by two seconds. The six-hour
schedule, standard public GitHub runner, permanent Releases, source cooldowns and storage ceilings
are unchanged. No paid provider, LLM, search API, subscription, cloud background job or new runner
is introduced. No UI or scoring-policy file is changed.

## Remaining limitations

Unsupported BSE-only financial histories, ambiguous symbols, bank/insurance-specific formats,
unverified PDF financial tables, unavailable originals and conflicting facts remain explicit.
There is no paid fallback, guessed quarterly cash flow, mixed statement basis, invented EPS
adjustment or replacement of a known loss with an older profit. Backfill is ongoing; a successful
run is not an exhaustive history claim. Filling evidence can still leave every model ineligible.

Exact latest audit rows are in `financial_gap_state`; appended summary observations are in
`financial_gap_audits`; durable collection progress is in `financial_gap_walks`. The Actions job
summary and optional reader `coverage.financialHistory` expose compact counts without changing
the tab. Original source/history/decision tables are preserved.
Global source checks remain in the reader. Its `coverage.sourceCheckInventory` explicitly counts
per-company checks whose full details stay in the referenced archive; targeted failure/queue counts
remain in `financialHistory.targetedCollection`. A compact `sourceChecks` summary also shows company
failure counts and actual attempt times in the existing coverage view; any failed latest check
prevents an aggregate successful-read time. Expanding the company audit does not require
downloading every company's check detail into the browser.

Offline verification: `python3 scripts/verify-recommendation-financial-gaps.py`, plus the unchanged
financial-foundation and catalyst-model regression suites.
