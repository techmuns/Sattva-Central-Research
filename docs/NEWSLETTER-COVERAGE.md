# Automatic newsletter coverage

Morning portfolio prices use the preceding completed trading session for the edition's IST
calendar day, even if GitHub starts the job after today's market opens. The existing exchange
holiday calendar applies. Closing-quote fallback must describe that same completed session;
missing prices remain unavailable and are never rendered as a flat return.

The newsletter joins retained publisher, free company-news (Google News / Upstox), and
TradingView archives independently. It reads and verifies content-addressed JSON parts,
filters before retaining large decoded collections, and keeps usable independent-source
reports when a source/part fails. Existing collector cadence, free providers, query gate,
refusal backoff, AI budgets, private state encryption and subscriber consent remain in force.
Bajaj Auto's reviewed exact-ISIN TradingView alias is BAJAJ_AUTO, not BAJAJ-AUTO.
A later bounded public page must overlap the preceding successful poll; it does not need
to return another complete 48 hours on every read. Existing gap evidence is preserved.

Listed holdings without an NSE ticker are resolved by exact ISIN to verified NSE/BSE directory
identifiers. An unresolved exchange mapping retains the real ISIN and its available company-news
records; it never silently removes the holding or invents an exchange ticker.

An eligible alert is a dated, company-attributed news report, non-routine exchange filing,
trade disclosure, or qualifying price move on a listed direct portfolio holding, including BSE-only and suspended lines, inside the
edition window or not yet reported within the retained ten-day ledger interval. Unrelated,
uncertain, future and undated reports remain outside this dated brief. Routine filings remain
on the dashboard. Related coverage is grouped with its sources; it is not silently discarded.

No per-company or section alert cap applies to a built email. Multipart rendering must carry
every eligible source identity and supplemental row. A pre-send invariant refuses an incomplete
plan. Delivery summaries retain included source-item counts, cap omissions (must be zero),
company archive reads and source coverage. Only accepted parts advance the scheduled sent-item
ledger. A test copy never advances that ledger or sends to other subscribers.

This verifies inclusion of captured eligible evidence, not exhaustive upstream publication or
future inbox placement. Public TradingView pages are bounded; historical overlap gaps,
unsupported/unmapped symbols, stale/failed company queries, unavailable archive parts and
unread documents remain explicit. An alternative-source report does not certify that a
TradingView history gap was recovered. No login/paywall workaround or paid search is used.

Regression: `node scripts/verify-newsletter-coverage.mjs`, plus the existing newsletter,
quotes, multipart, GitHub runtime and TradingView suites. Covers a delayed post-holiday morning,
closing fallback, retained/sharded reports absent from the latest head, corrupt parts, source
outages, more than 80 filings/60 stories/eight per company, long-lag arrivals and complete parts.
