# Shared portfolio research

## Contract and implementation plan

1. Run portfolio-connected Research inside the authenticated Sattva Family app.
   Its parent supplies the same active PortfolioContext and Ask Sattva tool loop;
   no ledger is copied to Research's public assets or repository.
2. Use a versioned, request-correlated postMessage channel, exact origin and
   source-window checks on both ends, bounded requests/replies, and timeouts.
   Standalone Research is explicitly disconnected and links to the Family view.
3. Revalidate the uploaded-workbook archive before each portfolio question. Wait
   for the Family context to adopt that archive version. Reject replies if the
   book changes during the read. Preserve workbook date, quote timestamp, partial
   quote coverage and source failures; a recent check is not a current book date.
4. Reuse Ask Sattva's existing query/read tools and answer verification without
   creating a second conversation in its library. Include the resulting dated
   portfolio reading alongside the research evidence, with explicit size limits.
5. Use the active book's ISINs for Research's portfolio filter, preserving unknown
   symbols and fund holdings. Never infer ownership from a sampled research feed.
6. Test transport isolation, stale/changed/failed reads, evidence budgets and
   source parity. Open coordinated PRs in both repositories, wait for CI/review,
   and leave both unmerged. Deployment requires separate user authorization.

## What this does not promise

No model can guarantee perfect answers. Available source records may themselves
be old or incomplete. Research must identify that limitation, never describe
freshly checked June statements as September holdings, never fill missing data
with zero, and never treat an omitted row as evidence that a holding is absent.
Quote-batch timestamps do not certify per-symbol freshness: the Family quote
feed can retain prices from previous batches, so Research labels that unverified.
The Family app's authentication remains the boundary for full-book access.

## AI alert holding sizes

The Family handshake advertises `position-sizes`. A direct `positions` request revalidates the
active uploaded book and returns ISIN identities and percentages of listed market value, with
the book date, check time, archive version and quote coverage. It does not call a model or share
account rows, quantities or rupee values. Research validates freshness, unique identities, bounds
and a complete 100% denominator before using sizes. Percentages include held equities, ETFs and
liquid positions; unpriced source values withhold size ordering instead of becoming zeros.

Only Portfolio scope uses size ordering, after the normal alert materiality threshold. Priority
filters remain available, with evidence priority breaking equal-size ties. Missing symbols stay
in the portfolio denominator even when no research feed can match them. Archive invalidations
clear private cards before a new read, and tab cleanup cancels in-flight requests. Standalone
Research retains priority ordering with a link to the authenticated Family view.
