# Shared portfolio research

## Active contract

1. Keep Ask Research in Central Research. Its hidden Family `/research-bridge`
   frame supplies the active PortfolioContext and, when needed, the Ask Sattva tool loop;
   no ledger is copied to Research's public assets or repository.
2. Use a versioned, request-correlated postMessage channel, exact origin and
   source-window checks on both ends, bounded requests/replies, and timeouts.
   The frame stays hidden while authenticated. Only a user-initiated inline unlock
   dialog reveals the existing edge sign-in form; no credentials cross the channel.
3. Revalidate the uploaded-workbook archive and refresh quotes before every question. Wait
   for the Family context to adopt that archive version. Reject replies if the
   book changes during the read. Preserve workbook date, quote timestamp, partial
   quote coverage and source failures; a recent check is not a current book date.
4. Use a fresh `positions` request for news, research, ownership and weight questions,
   avoiding a redundant model analysis before Research can start. Preserve Ask Sattva's
   query/read tools and verification for costs, tax, quantities and account-level questions
   (including follow-ups), without creating a second conversation in its library.
   Include the resulting dated context alongside research evidence with explicit size limits.
   Every question also carries all held listed ISINs, sectors and weights, even when
   it does not say “my portfolio”. Supplemental analysis can be unavailable without
   suppressing verified holdings. A missing authenticated holdings read stops the answer.
   The full holdings packet has a separate 60,000-character limit, leaving the
   13,000-character research allowance intact. The Worker validates both.
5. Use the active book's ISINs for Research's portfolio filter, preserving unknown
   symbols and fund holdings. Never infer ownership from a sampled research feed.
6. Test transport isolation, stale/changed/failed reads, evidence budgets and
   source parity. Follow the current user repository workflow for PR review and merging.
   Manual production actions require explicit authorization; an authorized merge may
   trigger the repository's existing deployment pipeline.

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
clear private cards before a new read, and tab cleanup cancels in-flight requests.
Central Research automatically uses the same hidden connection for size ordering.
Without access, the queue retains explicitly labelled priority ordering and offers
inline unlock when sign-in is required.

## Local browser verification

Run Family on `localhost:5173` and Research on `localhost:8080`. Run
`scripts/verify-portfolio-ui.mjs` for the real reader/quote/evidence path and
`scripts/verify-portfolio-auth-ui.mjs` for edge sign-in with an isolated fixture
password. Both harnesses block external traffic and model calls. The auth harness
reads the companion Family repo from `FAMILY_REPO` (default `../Sattva-Family-alert-sizes`).
Deploy the companion Family connector before the Research consumer after approval.


## Portfolio window and background membership

The header's former Edit Portfolio control opens **View Portfolio** in the same
window. Family Office alone supplies ownership. The window searches actual
holdings by name, ticker and ISIN; missing research does not remove a holding.
Manual company selections remain in Watchlist. The hidden reader starts from
any tab and replaces the shared coverage set for every research feed. Positions
requests are coalesced/serialized with question reads, and background refreshes
pause while an answer is being prepared. See `ACTIVE-FAMILY-HOLDINGS.md` for the
names-only export, authoritative ISIN mapping and the #48 runtime correction.
