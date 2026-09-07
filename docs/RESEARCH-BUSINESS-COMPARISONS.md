# Portfolio business comparisons

Ask Research treats “Which other holdings could benefit after Sterlite news?” as
an evidence search across the supplied holdings. Sterlite is a reference business,
not an exclusive issuer filter. Ordinary single-company questions keep their
existing retrieval behavior. Follow-ups can inherit the reference issuer; an
explicit new issuer takes precedence.

The browser extracts shared activities from company-linked source passages,
con-call analysis tags and industry metadata before ordinary source sampling.
It does not maintain a hand-picked list of AI stocks. Exact ISIN/ticker/name
matching excludes related-issuer and uncertain query matches. Multi-company
roundups contribute only issuer-local clauses. Small holdings and unresolved
symbols with an exact ISIN remain eligible. Authenticated complete positions
establish holdings and weights; saved coverage alone cannot establish ownership.

The comparison prioritizes shared primary activities over broad themes such as
AI adoption. Industry-only candidates, unverified Telegram/chatter, source gaps
and contradictory exposure evidence remain labelled. A common activity suggests
a possible mechanism, not a customer relationship, exposure size or realised
benefit. The model is instructed to compare other holdings in a compact table,
with original dashboard citations. Literal peer source excerpts appear before
inference. Telegram searches include peer identities; public chatter still has
its existing six-topic limit, which remains a coverage gap.

Once candidates are known, source samples prioritize their original company rows.
The reference business development stays in the comparison context, so its
unrelated price/insider headlines do not displace the requested peer evidence.
No discovered peers keeps the existing reference sample and its missing-data
limitations. Missing valuations do not discard validated holding identities.

Comparison evidence uses at most 35% of the existing 18,000-character research
budget, with explicit omitted-candidate counts. All 21 source entries retain
status, provenance, data quality and row counts. Optional summaries, coverage
detail and temporal retrieval counters may be removed with a `trimmed` marker;
original source rows still receive the remaining shared budget. Complete private
positions retain their separate limit and are never persisted by this feature.

## Performance dates

A reference publication is explicitly selected from dated business-development
readings. This is a comparison anchor, not proof it caused a price move. Ambiguous
news references should be stated in the answer. Latest-session returns carry
both price dates and their verification state. They are never relabelled as
returns since the news, and a capture timestamp is never a price date.

The normal technicals capture now retains up to 120 completed daily adjusted
closes from the same Yahoo response it already downloads. Each series records
its source symbol, capture time, date range and retention limit. One adjustment
vintage replaces another; prices from different vintages are never spliced.
Missing/failed adjusted history retains the prior series marked as retained
after failure, which is ineligible for a new event-return calculation.

An event return requires an adjusted close before the publication day (within
four calendar days), a close after the publication day matching the technical
snapshot's date, and no duplicate dates. The return includes the publication
session; the publication time is not established. It is not portfolio P&L or
proof of causation. Missing endpoints remain unavailable. Existing deployed
snapshots will gain this optional history through normal scheduled captures;
this change does not run a production capture or backfill and does not certify
an exhaustive price archive.

## Regression scenarios

Run `node scripts/verify-research-business.mjs` and, with the pinned external
Playwright runtime, `node scripts/verify-research-business-ui.mjs`.

The suite covers the exact customer wording, natural comparable-business wording,
follow-up references, issuer switches, outside-scope references, watchlist/private
scope separation, complete versus incomplete holdings, smallest tickerless
holdings, AI substring false positives, multi-company roundups, conflicting
claims, unverified discussion, partial sources, tight context budgets, literal
peer previews, corrected price dates, missing prices, corporate-action adjusted
returns, failed refresh retention and finite price history.

The isolated saved-data browser checks HFCL and Tejas Networks reach the
provider-facing evidence for all three Sterlite peer questions, while unrelated
banking mentions do not. It uses all 142 saved coverage companies and blocks all
API/external requests. It does not certify the current authenticated user's
holdings, model answer quality, production latency or complete source coverage.
The broader per-company suite continues to test every saved portfolio company.
