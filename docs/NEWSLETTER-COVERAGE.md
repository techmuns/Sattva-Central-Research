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
edition window. Older reports are never emailed as historical catch-up, even when newly captured
or absent from the sent ledger. Unrelated,
uncertain, future and undated reports remain outside this dated brief. Routine filings remain
on the dashboard. Related coverage is grouped with its sources; it is not silently discarded.

No per-company or section alert cap applies to a built email. Multipart rendering must carry
every eligible source identity and supplemental row. A pre-send invariant refuses an incomplete
plan. Delivery refuses the entire edition before provider I/O if it requires more than six emails;
no eligible current report is silently cut to meet that limit. Frozen recovery plans containing
late reports or more than six parts are retired without further sends, preserving receipts,
accepted identities, PDF links and frozen bodies. Non-test delivery recovery expires three
hours after its original edition time; the original clock is never renewed by retries. Delivery summaries retain included source-item counts, cap omissions (must be zero),
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

Large recovery editions use a GitHub-only PDF budget of 64 MiB. Static delivery splits the
PDF into authenticated 256 KiB private records and streams the complete document; the legacy
Worker store/export limit stays unchanged. Frozen recipient bodies are individual encrypted
database rows, so queue recovery metadata does not inflate by subscribers × parts × HTML bytes.
Completed bodies follow the prior queue payload lifecycle; pending bodies and receipts survive
restarts. Edition grouping is calculated once per multipart plan and frozen recipient render.
Encrypted newsletter pages target 512 KiB rather than grouping up to 4 MiB of unrelated
records into every chunk read. Legacy individual records retain their existing absolute bound.
The static reader uses native byte/base64 conversion when available and a bounded two-page
request-local memo. Download verification compares complete PDF bytes and hash, not HTTP 200.

`verify-newsletter-retained.mjs` checks the real committed edition window with no mail,
network or model requests. It verifies archive descriptors/parts, all eligible identities across
all parts, exclusion of old unsent reports, and the complete PDF transport budget on free standard GitHub Actions.

`verify-newsletter-policy.mjs` checks refusal before any send, retirement of an interrupted
86-part historical plan across restart, preservation of accepted outcomes and archived evidence,
and normal bounded delivery. This supersedes the earlier ten-day email catch-up behaviour.

An explicitly requested test can use `sourceOnly: true` with `to: "me"`. The encrypted request
preserves that flag and disables model processing for the test, while exercising the same
source selection, prices, multipart planning, PDF, queue, transport and threading. Automatic
subscriber editions keep their configured enrichment and budgets.
These sealed, source-only single-recipient test requests remain valid for at most 24 hours
so a free-runner backlog does not silently expire the requested verification before it starts.
The durable request ID prevents replay; ordinary sends keep their one-hour validity window.
New requested source-only tests also retain a failed or uncertain part in the encrypted outbox.
Existing automatic wakes recover only pending parts with their frozen HTML, subject, Message-ID
and accepted root. The request status stays pending until delivery finishes or its original
24-hour deadline expires. Recovery neither reserves another manual attempt nor advances the
subscriber sent-item ledger. It keeps the original single test recipient even if subscriber
editions are disabled. Legacy test queues and already completed tests are never replayed by
this upgrade. SMTP I/O has a bounded 60-second allowance, after checkpoint/PDF work.

Automatic wake admission coalesces against GitHub's actual queued/running processing
jobs, instead of relying on a deployed status that can lag publication. The
check uses a read-only Actions token and bounded metadata reads; an incomplete queue
inventory cannot certify an idle sender. Explicit encrypted send requests and read-only
bootstrap requests retain their own queue. The sender checks its retained clock again
for every automatic trigger after obtaining the account mutex. Existing timers, source
cadences, retry state and delivery claims are preserved.

Requested source-only tests retain their sealed input in a private encrypted intent row until
the complete frozen outbox is acknowledged. A runner lost during preparation therefore resumes
from the intent; a runner lost after preparation resumes the identical parts. Caller-only mail
authorization stays inside encrypted state and is removed with the completed outbox, never placed
in prepared request views. The original 24-hour issuance deadline includes the accepted one-hour
future clock skew. Expiry preserves earlier provider outcomes; PDFs with no possible provider
submission are deleted, while genuinely uncertain links remain usable.
