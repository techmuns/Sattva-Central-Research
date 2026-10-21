# Public financial history and event-date evidence

This is background groundwork for future AI Recommendations. It changes no reader, tab,
alert ranking, source row or service-worker asset. It produces no recommendations, price targets,
return probabilities or AI summaries. No application request can start collection.

## Runtime and zero-spend boundary

`recommendation-foundation.yml` runs every six hours and after changes to its own collector.
It requires a public repository and the standard `ubuntu-latest` GitHub runner. Python's standard
library, SQLite, and free local Poppler PDF text extraction are the only processing dependencies.
There is no model call, paid search, broker API, external data subscription, cloud database,
larger runner, Actions cache, LFS, or permanent Actions artifact. The only credential is the
repository-scoped Actions token used for GitHub Releases. Website hosting is unaffected.

GitHub documents standard public-repository runners as free, and Release assets have no total
storage/bandwidth quota: https://docs.github.com/en/billing/concepts/product-billing/github-actions
and https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases .
These provider terms can change; no paid fallback or spending configuration is introduced.

## Sources and capture scope

The eight source families are NSE integrated financial filings for equity and SME, plus legacy
quarterly/half-yearly/annual results for both equity and SME. The source contracts were
checked against NSE's own `dist/js/sections/corporate-filings.js` and actual original XBRL files.
The integrated endpoint uses `type=Integrated Filing- Financials`, `page`, `size`, and `totalCount`.
Governance responses, malformed pages, duplicate records and changing totals never close a window.
Legacy responses at the safety ceiling are treated as potentially truncated. NSE's optional
`fo_sec` filter is never sent: it would silently restrict history to F&O securities. Legacy
publication uses the exchange's dissemination clock (`exchdisstime`) before broadcast time.

Public BSE/NSE identity directories and existing announcement/RSS/date-index snapshots supply
additional original document links and observations. The collector never calls Muns, Screener,
search services, a model endpoint or a source requiring payment. It does not import portfolio
membership, private summaries, holdings sizes or account data into the public release.

Each walk permits at most 200 source requests and ten minutes of source work, paced at least two
seconds apart. Access refusals retain a 24-hour host cooldown. Only allow-listed original exchange
documents and the two NSE financial-index endpoints can be requested. Redirects remain on the
original exchange allow-list; refusals are not bypassed with cookies, proxies or different readers.

The initial historical boundary is recorded once, approximately three years before first capture.
Recent overlapping windows resume missed intervals. Historical seven-day windows backfill
independently per family, followed by rotating historical reconciliation. Pagination checkpoints
and documents commit together. A partial window never advances its historical watermark.
Capture progresses over multiple runs; a completed job does not mean the universe is complete.
Recent, backfill and reconciliation checks retain separate outcomes. A successful historical
subset cannot clear a failed current window. Expired host refusals clear only after an actual
successful response. Failed document reads retry after their saved one-day delay; successful
reads keep their separate weekly recheck cadence.

## Durable store

Each runner restores the latest acknowledged compressed SQLite generation from monthly Releases
named `recommendation-foundation-YYYY-MM`. A SHA-256 in the immutable asset name authenticates the
entire downloaded archive. SQLite integrity and repository identity must pass before adoption.
Missing/corrupt retained state fails instead of initializing an empty replacement. A completed
upload with an acknowledged size/digest is the publication marker. An interrupted upload cannot
supersede the last usable generation. Source failure still runs the publication step after a
successful restore. Generations, raw documents, corrections and observations are not age-pruned.
The 4 GiB database / 1 GiB compressed-asset ceilings stop collection visibly rather than deleting
history or purchasing storage. Source reads stop with room for checkpoints before the database
ceiling; gzip download, restore and upload stream in bounded chunks on the standard runner.

Tables retain public companies, canonical document identities, source observations, compressed
original document versions, original XBRL facts/contexts/units, normalized financial facts,
per-document date assessments, source checks, cooldowns and backfill state. Duplicate observations
do not receive a new first-observed time. A changed document adds a version. Financial history
can be queried by actual observation cutoff; later corrections cannot leak into earlier tests.
All evidenced versions are returned: consumers must explicitly reconcile restatements/conflicts.
Shared attachments assigned to different securities retain every observation but quarantine the
document identity and its financial facts. A conflict never stops unrelated ingestion. The BSE
date-index adapter validates and flattens its actual `byTicker` groups against `rowCount`.

The job summary reports counts. Detailed coverage can be regenerated without network access:

```
python3 scripts/collect-recommendation-foundation.py inspect --state PATH_TO_RESTORED_SQLITE
```

## Financial interpretation and limitations

Financial amounts are exact decimal strings with source unit definitions, tags, contexts, dates
and statement basis. XBRL `decimals` is precision, not a scaling multiplier; a Crores display label
does not multiply a value already reported in INR. Segment contexts remain raw evidence and never
become company totals. Nil/absent values are not zero. Inconsistent contexts, ambiguous statement
basis, conflicting aliases, future periods and issuer mismatches are excluded from usable facts.
Actual quarterly durations are counted separately from annual/year-to-date/half-year periods.

The first adapters normalize original BSE-financial/SEBI financial XBRL taxonomies served by NSE.
Other fields remain in raw evidence. PDF financial-table extraction, general HTML/iXBRL tables,
specialist bank/insurance metrics and a direct BSE-only financial-history adapter are not certified.
An unavailable statement or field remains unavailable. Revenue history alone does not establish
earnings quality: cash flow, balance sheets, dilution and exceptional-item coverage need checking.
No quarterly cash flow, consensus estimate, underlying profit or EBITDA is invented.

## Date interpretation

Original row dates, actual first observation, original document dates, exchange-index publication
clocks and corrections are different facts. No filename supplies a verified event date. PDF dates
require an unambiguous first-page date/header and original issuer evidence. Unreadable scans remain
unavailable; no paid OCR is used. A board/letter date is never treated as publication time.
Missing or ambiguous document dates remain ineligible even with a verified exchange clock.

The same document reported under multiple dates is quarantined for future catalyst selection.
Date discrepancies, changed document dates and unverified publication remain explicit. Raw source
rows are not re-dated or removed. `eligibleForNewCatalyst` means date evidence passes these checks;
it does not establish novelty, investment suitability, remaining upside or source completeness.
The future model must still apply an age window and compare all known company developments.

The actual 14 January 2026 Alpex order replayed under October dates is an offline regression.
Real Reliance and Precision Wires source fixtures also guard original units, exact issuer matching
and an actual reporting-period/context disagreement. Fixtures are never production seed data.

## Verification

`python3 scripts/verify-recommendation-foundation.py` runs entirely offline in local/PR CI and
before the scheduled collector. It checks real original financial filings, rounding, segments,
missing values, old-document re-dating, original observation times, corrections, pagination,
interrupted recovery, cooldowns, retained failures and the no-cost/runtime boundary.
Only an actual main-branch automatic run and acknowledged retained generation establish activation.
