# Catalyst research models and forward outcome testing

The three models are fixed, deterministic research hypotheses: **improving earnings**, **material
new business**, and **productive new capacity**. No LLM, paid provider or broker endpoint is used.
Scores are evidence points, never probabilities, expected returns, analyst consensus or targets.
The first model version is `catalysts-1`. Its rules must not be tuned against the outcomes it is
evaluated on. A future policy change needs a new version and a new forward evaluation cohort.

## Processing and publication

The existing public `recommendation-foundation.yml` runs every six hours on standard free
`ubuntu-latest` runners. It restores the permanent SQLite archive, collects original financial
and event evidence, captures official market reports, extracts bounded public annexures, scores
the three hypotheses and records outcomes. The job is bounded to thirty minutes. Market work
uses at most 100 requests/six minutes, at least two seconds apart and at most 42 calendar dates.
Financial collection retains its existing independent 200-request/ten-minute ceiling. Access
refusals retain the existing host cooldown; there is no proxy/cookie/provider fallback.

All original source versions, observations, extraction quotes, decisions, reviews and outcome
versions remain on GitHub Releases inside the financial-history archive. Collection does not
commit data directly to main. Only after SQLite upload acknowledgement may the runner publish
`recommendations-RUN-ATTEMPT-SHA256.json` in the same monthly release. It names its exact archived
ledger asset and source revision. An analysis failure cannot produce a new reader file.

The existing automatic deployment installs that hash-checked public JSON as a static file.
Cloudflare only serves the prepared website; no scoring, collection, model call or retained
background-job state runs there. No Actions artifacts/caches, larger/private runner, database
subscription, paid search or external credits are introduced. Existing provider terms may change;
there is no paid fallback. Private holdings and private summaries are not included in public output.

## Financial evidence and common eligibility

Use only original supported INR XBRL facts observed before the decision time. Reconcile a filing's
known revisions; conflicting independent filings remain unavailable. Never mix standalone and
consolidated figures, segment totals, quarterly and YTD periods, nil values or units. A TTM needs
four actual adjacent quarters. Otherwise a verified annual baseline is labelled with its period.
An annual EPS is not presented as a TTM. No annualisation or missing cash flow is invented.

A candidate additionally requires:

- A verified issuer, unambiguous document date and original exchange publication clock. Documents
  with replayed dates, conflicting identities or dates over 45 days old cannot establish a new case.
- A quarterly financial period ending within 150 days and same-basis positive reported cash flow
  from an actual half-year/annual statement. Cash evidence older than 400 days before the latest
  quarterly end cannot satisfy this gate.
- Twenty recent observed benchmark sessions, with one unambiguous equity price per session and
  median daily traded value of at least ₹1 crore. Missing/zero-volume sessions do not disappear
  from the liquidity calculation. This threshold does not establish capacity for a particular order.
- A positive, actually traded official close within five calendar days. CMP is labelled as an
  end-of-day close with its session date; there is no claim of streaming/live quotes.
- Positive verified TTM/annual diluted EPS and price/EPS no greater than 40. Official corporate-action
  coverage must span the EPS baseline to the quote; splits, bonuses, rights and capital reorganisations
  require verified adjustments before this valuation may qualify.
- A verified pre-disclosure close; a rise of more than 20% to the latest captured quote blocks
  inclusion. This safety filter does not establish that the remaining price offers upside.
- Any parsed, date-verified auditor resignation, debt-payment default, admitted insolvency or
  fraudulent-transaction disclosure vetoes inclusion pending research. Unsupported/unread documents
  remain a risk-coverage gap; absence of this narrow pattern is not a clean governance opinion.

These are conservative initial filters, not a valuation model or a complete risk assessment.
Sector-specific risks, promoter/auditor issues, full contract economics, financing, leverage,
working capital, acquisition effects and an investable upside/downside scenario still need research.

## Fixed scoring rules

| Model | Evidence points | Required catalyst evidence |
| --- | --- | --- |
| Improving earnings | Revenue YoY ≥15%: 25; pre-exceptional PBT and reported profit YoY ≥20%: 25; diluted EPS YoY ≥15%: 20; pre-exceptional margin improvement ≥0.5 pp: 10; limited other income/exceptionals: 10; positive cash flow: 10 | Positive, comparable year-earlier revenue/profit/PBT/EPS; required growth thresholds; other income ≤25% of pre-exceptional PBT; absolute exceptional items ≤10% of it |
| Material new business | Firm order: 30; order ≥10% of verified TTM/annual revenue: 30; execution within 1–12 months: 20; positive cash flow: 10 | Exact INR value, firm purchase order/signed contract and disclosed execution months; no LOI/framework/bid status, cancellation, unallocated JV/consortium share or tax-inclusive amount |
| Productive new capacity | Production commenced: 25; explicitly funded: 20; firm demand/offtake: 20; existing utilisation ≥70%: 15; comparable capacity addition ≥10%: 10; positive cash flow: 10 | All these fields must be supported; planned production, expected demand and financing to be arranged do not qualify |

The common minimum is 70 points plus all required evidence and eligibility gates. The maximum is
100; the order model's stated maximum is 90. Missing data earns no points and leaves a named
requirement unmet. Gains across a loss/sign change do not become percentage growth. EPS growth
does not substitute for underlying PBT or reported profit growth.

The initial English PDF adapter reads at most twelve pages of already-retained original PDFs
using free local Poppler. Each accepted field retains a page and literal quote. Multiple conflicting
values remain ambiguous. It deliberately supports a narrow set of explicit annexure wording;
negated, conditional and future claims cannot establish firm orders, production, funding or demand.
Required contract/project terms must share a page and a bounded text span; explicit multiple-project
or contract documents require a separate verified linking adapter. Cross-page relationships are
not guessed, even when this leaves a real catalyst unqualified.
JV, consortium and subsidiary/associate attribution also require a verified ownership/allocation
adapter; their entire contract or project value cannot be assigned to the listed issuer by default.
Order amendments, reductions, extensions and renewals likewise stay unqualified until a verified
incremental-value/backlog adapter separates new business from an existing contract's total value.
unrecognised tables, units or compound projects require a verified adapter. Extraction is not proof
that every page, amendment, payment term, margin or project milestone was reviewed. No unreported
profit contribution, attributable share, commissioning date or contract margin is inferred.

## Permanent decisions and outcome accounting

Each company/model/catalyst/version has one immutable first qualifying signal. Additional catalysts
for the same company/model within 186 days update that evolving case instead of creating overlapping
independent bets. Every distinct assessment remains retained. Re-reading the same case cannot reset
its issue time or create daily independent bets. Subsequent reviews and source
versions are additional records. Newer adverse/failing assessments can withdraw or supersede a case;
original signals stay in the outcome ledger. The visible list contains one highest-ranked qualifying
case per company; every model's qualifying signals remain retained. There is no daily name quota.

The backtester starts from signals actually observed by this collector. A source's old publication
date never backdates a signal. Earlier historical recommendations cannot be reconstructed yet from
the archive captured today. This restriction prevents later documents, corrections and model knowledge
from leaking into a pretend historical result. Initial three/six-month results are therefore pending.

Entry is the first later captured exchange session's open, even when a signal arrived during the
previous session. Exit is the 63rd/126th observed session close. Complete weekday session/holiday
evidence is required; a missing file is never called a holiday. Official NSE holiday records can
explain ordinary closed dates. Special sessions and absent reports can leave calendar coverage
unverified. Horizons refer to captured benchmark sessions rather than a certified exhaustive calendar.
No missing stock price is forward-filled, and a missing/suspended/delisted or ambiguous security
stays unpriced. All corporate actions within the holding interval block measurement until a certified
adjustment exists. Raw prices are preserved separately; dividends are not silently ignored in a
claim about total returns.

Measured **price returns** subtract a fixed 50 bps round-trip assumption and compare with the Nifty
500 **price index** over matching entry/exit dates. These costs are an initial assumption, not measured
brokerage/tax/market-impact costs. Maximum drawdown uses daily closes, not intraday lows. Reports
retain all signal counts, unresolved statuses, measured sample size, mean/median/worst net return,
excess return and a descriptive Wilson interval for win rate. Measured-only statistics can be
selection-biased; unresolved outcomes must stay visible. Overlapping observations are dependent.
Thirty measured outcomes change the label to forward observations; they do not certify an edge.
There is no portfolio simulation, guaranteed fill, fitted probability or claim of profitable stock picking.

## Sources, gaps and reader

Original free reports: [NSE reports](https://www.nseindia.com/all-reports), the official NSE CM UDiFF
bhavcopy, daily `ind_close_all` Nifty 500 reports, and NSE corporate-action/trading-holiday endpoints.
Actual 19 October 2026 source excerpts are offline contract fixtures only, never production seeds.
All raw report hashes and revisions are retained. Recent files reconcile, older dates backfill and
failed dates retry independently. The initial market boundary is 100 days before activation; market
date discovery uses the permanent per-file check inventory, so an outage longer than the recent
overlap cannot strand unattempted dates behind an already completed backfill cursor. Financial
history keeps its earlier fixed boundary. BSE-only prices and unsupported sources remain gaps.

AI Recommendations sits between AI Alerts and All Alerts. It has Company, Current market price and
Catalyst columns. Evidence/outcomes are available on demand. The reader respects Portfolio, Watchlist
and Universe, checks prepared output on opening/return and every five minutes while visible, preserves
search/scroll and retains the last valid publication through outages and reloads. Missing, stale,
partial and verified-empty states differ. The service-worker revision delivers it to returning readers.

Verification: `python3 scripts/verify-recommendation-models.py`,
`node scripts/verify-recommendation-reader.mjs`, and the real-browser
`node scripts/verify-recommendations-ui.mjs`, plus the existing foundation contracts and required CI.
