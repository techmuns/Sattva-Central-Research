# Newsletter source evidence and expanded brief

Updated 24 September 2026. These are Sattva's contracts after adapting Glow's source-reading
and email improvements. The scope is the direct listed companies in `portfolio-companies.json`.
The public brief never reads private Family Office quantities or a donor `/data/book.json`.

## What the reader receives

The 08:00 and 16:00 IST weekday editions retain source headlines and links, with distinct filings,
company-specific source particulars and separately labelled AI notes. The brief also includes
captured insider/bulk/block/SAST disclosures, the next seven days of earnings/calls/meetings and
corporate actions, Indian/global markets and a session-price table. Date-only disclosures say
that they have no broadcast time. The price table reports company returns, coverage and an
unweighted median; it is not portfolio profit or a quantity-weighted return.

Routine announcement categories are omitted from the short email with a count and remain on
the dashboard. Distinct filing documents cannot be merged merely because the exchange category
and filing time resemble each other. Document identity or complete source facts establish twins.
TradingView tags alone cannot establish company attribution: Sattva's reviewed identity gate
still applies. Equivalent news groups conserve every source, caveat and delivery key; materially
different amounts, stages, issuers and time windows remain separate. No grouping changes the
underlying dashboard archive or its semantic alert history.

A labelled “Why it moved” note can use the edition's captured company evidence. The model must
state uncertainty when the evidence does not explain the move, distinguish inference from a
reported catalyst, and retain dates and source links. This is neither a causal finding nor an
investment recommendation. All model checks in CI use stubs; they do not establish live accuracy.

## Source reading independent of sends

`NewsletterContentStore` uses the existing newsletter Durable Object (`team-brief:v1`) and SQLite.
With subscribers, an enabled edition and a configured reader, its existing alarm discovers source
jobs hourly even with no browser open. Initial discovery begins seven days before first activation;
this is a capture start, not an exhaustive backfill. Each completed interval overlaps two days;
catch-up walks seven-day intervals and also checks the recent two days. Required capture failures
hold the completed watermark back. Retained source files and their own collection limits still
bound what can be discovered. The reader does not repair an unavailable exchange history.

Jobs are keyed by policy, issuer, document identity and source content. They survive restarts,
send acknowledgements and date changes. Each wake claims at most six jobs, reads two concurrently,
and retains a five-minute lease before I/O. An abandoned lease becomes eligible again. Pending
or failed reads remain stored; retries back off to six hours, or one day for access/format/budget
restrictions. Full publisher articles, subscriber data, credentials and PDF bytes are not stored
in this queue; retained facts include their literal supporting passages and source locations.

Only allowlisted HTTPS exchange/publisher hosts are fetched. Every redirect is checked again;
credentials are never sent to sources. Documents are bounded at 8 MiB and text at 80,000 characters.
An inaccessible, truncated, oversized or unreadable document keeps its original source link and
an explicit reading state. XBRL uses the existing parser; PDF reading submits the complete bounded
document. Publisher text must be an identified article body. A headline alone cannot produce a
source-grounded note. Source facts, missing readings and partial AI coverage remain distinct.

Public previews read already-saved facts without enqueuing jobs, processing readers, calling a
model, sending email or saving an edition PDF. They remain useful before the initial queue fills.
The new queue starts through the application's existing alarm; a deployment is not evidence that
all sources have been read. Read-only deployment verification must not manually resume/retry it.

## News grounding and spending

`NEWSLETTER_NEWS_AI_PROVIDER=openai` selects the news reader and fails closed if its existing
`OPENAI_API_KEY` is unavailable; it does not silently switch to an unbudgeted provider. News uses
`gpt-6-luna`, with `gpt-6-sol` review for uncertain attribution, multi-event articles, investigations,
possible implications or a failed draft. Responses use strict JSON, no external tools and
`store:false`. Literal company/product/role evidence is mandatory. The DCW regression distinguishes
an applicant seeking a CPVC investigation from another business or product being investigated.
Validated, policy-versioned results and within-edition grouping decisions are cached.

The durable news ledger admits at most **USD 1 per Indian calendar day and USD 25 per calendar
month** for news reading, review and grouping. It reserves a conservative maximum before each
request, includes cache-write pricing, settles only with measured usage and retains uncertain
reservations. Each job has at most three attempts per day. Rates in `newsletter-openai.mjs` were
checked against the official model pricing on 24 September 2026 and must be reviewed if changed.
The reservation day is the actual admission day, including a call spanning midnight.

**This is not a system-wide AI spending cap.** Filing/PDF extraction, non-news briefing notes,
price explanations, AI Alerts and Ask Research use their separate existing bounded paths. This
change adds no financial ceiling to those paths. Limits and source coverage are available in the
brief's operational coverage; missing budgets or credentials preserve source-only reporting.

## History, migration and sending

`newsletter_reported` retains acknowledged item identities for ten days independently of the
pruned delivery log. The brief checks two previous edition windows for late captures, bounded by
the ledger's known start and retention. This does not claim indefinite send suppression or complete
source capture. Test copies and previews never mark an item reported. Each confirmed multipart
acknowledgement updates the ledger atomically; a rejected or uncertain part cannot suppress its
unconfirmed items. An already-claimed edition is never automatically replayed.

On first use, the in-place migration imports retained acknowledged legacy `stories` keys from
non-test deliveries, including interrupted partial deliveries. Legacy URL identities remain aliases.
Subscribers, settings, edition claims, manual-attempt reservations and immutable PDFs are preserved.
No data reset, namespace change or manual production action is required.

HTML is measured after escaping, personalisation and links. Each part stays within 90,000 UTF-8
bytes; whole companies stay together when possible. Complete updates and supplementary-section
rows form additional boundaries. All sources and AI notes survive splitting. A single unfit item
fails before a PDF is saved or an email sent. The final part carries markets; every part links the
same complete immutable PDF. Delivery progress persists before and after each send. Unknown
outcomes keep their PDF and claim, and are not automatically retried. Confirmed rejected editions
remove only their provisional PDF. The manual limit remains four attempts per rolling 24 hours;
scheduled editions retain independent once-per-edition claims and a three-hour lateness cutoff.

The subscriber panel accepts comma, semicolon or whitespace-separated addresses. Invalid batches
are shown for correction; valid addresses are deduplicated and submitted in bounded intent batches.
No subscriber is added merely by installing this release. All existing access boundaries remain.
The public module cache version advances and a browser test verifies an already-controlled session
reloads and receives the new newsletter module without losing semantic alert history.

## Verification

The existing market, newsletter, reading, multipart delivery, event and panel suites remain, plus
`verify-newsletter-content.mjs`, `verify-newsletter-openai.mjs`,
`verify-newsletter-price-reasons.mjs`, `verify-newsletter-upgrade.mjs` and
`verify-announcement-types.mjs`. They cover restart/leases, partial source discovery, complete
bytes, issuer/product confusion, budget admission, legacy schema migration, confirmed-part history,
private-book separation, source/AI completeness and immutable PDF links. A source-only smoke test
also builds from the current committed captures without asserting changing company counts.

Layout tests use long names, calendar sources and multiple action dates at 1440, 760, 390 and
320 pixels. `verify-alert-stories-ui.mjs` exercises the real service-worker upgrade from a cached
old newsletter module alongside Sattva's archive/resurfacing behavior. External model replies
and email delivery are stubbed: no live send or private-data collection is part of these tests.
