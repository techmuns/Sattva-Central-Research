# Bounded news working sets and reusable public data

This continues PR #220's view/scroll ownership fixes. It changes browser ownership and lossless
public transport, not collection scope, retention, company matching, or AI evidence policy.

## What changes

- News and selected-period All Alerts locate dates using compact, integrity-checked part indexes.
  They load matching raw parts and every connected URL/TradingView identity's correction/provenance companions before
  applying the existing canonicalizers. A fingerprint collision can only overfetch; record
  identity continues to use the original full URL and company identity. Index version 4 adds the
  story key `dedupeArticles` folds on (outlet, headline and date), because a TradingView copy shares
  nothing else with its original, and past midnight IST it lands on the next day.
- Large captures use transport version 2: records are grouped by date, with a validated complete
  permutation back to their original positions. Full hydration must equal the original object,
  including record order, fields, source timestamps, tickerless rows and empty buckets. Version 1
  remains readable. Optional indexes bind to the original part hash; missing/corrupt indexes are
  rebuilt from verified source bytes. Publication also validates their actual dates/identities.
- The public cache has an approximately 24 MiB optional RAM tier, backed by its existing IndexedDB
  records. The verified-part decoder has a separate 24 MiB estimated tier. These are accounting
  budgets, not a global browser heap limit. Unknown/user-authored keys and failed/unfinished disk
  writes stay pinned. No durable record is evicted to meet a RAM budget.
- A saved-alert writer keeps only its active complete snapshot and newest waiting complete
  snapshot. Superseded callers are told that their exact revision was not saved. Inputs are
  already-merged complete views, never deltas. The newest view preserves all arrivals/corrections;
  transactional publication, reader pins and integrity checks protect the previous disk revision.
- Verified unchanged parts share fetches, decoding and immutable row objects. Consumer cancellation
  is independent; the underlying request stops only when its final consumer leaves. Response
  allocation is bounded by the declared part size.
- Inactive alert query readers, complete-history alert reports and AI ranking intermediates release
  their extra references. Research's prepared shared sources retain independent ownership. The alert
  tabs' existing 90-second/resume checks own their cached periods, which do not start additional
  independent pollers. AI's existing 180-day historical context and 45-day upcoming context are
  unchanged. Publisher history
  remains shared for cross-route reconciliation; this is not a claim that every source is bounded.

## Compatibility and data protection

PRs #132/#134 established lossless parts and alert capacity; #147 established recent News windows;
#200 preserved table geometry; #217 established saved All Alerts restoration; #220 bounded view
ownership. This change preserves those contracts and their existing tests. Recent and full readers
no longer share one projected head, so explicit live-news arrivals have a separate shared ledger
and retain the existing per-company durable cache. Releasing a window cannot discard its only copy.

A reading operation uses one stable period. Failed widening keeps overlapping last-good stories visible.
Publisher date corrections invalidate projections even when the company capture timestamp is unchanged. The latest picker wins the next operation, and Today
is reevaluated by the visible/resume poller at IST midnight, with the next recheck rearmed. An empty selected day does not dispatch unsolicited company walks.
Verified bucket counts preserve checked companies when all their stories fall outside the selected period;
legacy parts are verified directly if this optional summary is absent. Empty-period wording names the
selected period, while unchecked buckets and source failures remain distinct. Source check times and
partial/failed coverage remain source facts, not conclusions from row counts.

The service-worker release advances with the module graph. Old clients reject transport version 2
until upgraded and retain their last-good data. Verify a returning controlled session actually
activates the new worker and reloads, rather than checking only a fresh asset URL.

## Validation

- `verify-news-working-set.mjs`: shipped full-history events versus 1/3/14/30-day queries, comparing
  exact identities and complete event objects/provenance. Initial fixed captures: 185,691 full
  events, with 4,682 / 22,501 / 94,782 / 115,134 selected events respectively. Counts may grow with
  normal capture updates; equivalence is the assertion.
- `verify-news-query-boundaries.mjs`: real date grouping and skipped old text, original order,
  index semantic corruption and missing/corrupt-index fallback, date-correction companions, rapid
  switching, automatic IST-midnight rechecks, failed wider reads, stable-timestamp publisher corrections,
  valid empty dates and explicit manual-arrival retention.
- `verify-memory-primitives.mjs`: durable-before-eviction, pinned unsaved data, bounded write backlog,
  every arrival/correction, cancellation isolation and one decode for unchanged shared parts.
- Existing publication, capacity/quota/corruption, recent-window, publisher delivery, alert restore,
  privacy/scope, browser interaction and service-worker upgrade suites remain required.
- `verify-memory-session-ui.mjs`: opt-in 30-minute full-data local iframe session cycling News,
  All Alerts, Earnings and AI Alerts, exercising search/sort/scroll and recording forced-GC JS heap,
  DOM/listeners, counts and long tasks. All external requests and mutations are blocked. Use
  `PERF_CLOCK` to hold the reading date constant, `PERF_SESSION_OUTPUT` for JSON results, and
  `PERF_BASE_REF` for an older module graph (with a compatible source representation).

JS heap after forced GC is not Chrome's total tab/process memory. The reported 3.4 GB hover value
has not been reproduced by this harness, and these tests cannot certify all production devices.
