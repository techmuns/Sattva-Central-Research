# Ask Research performance and evaluation

The portfolio-focused release gates and executable quality scenarios are in
[Customer readiness](ASK-RESEARCH-CUSTOMER-READINESS.md). Retrieval tests alone
do not certify customer readiness.

The reported failure was a Jayaswal Neco news question waiting on Family's
question-specific model read until the 125-second bridge timeout, before any
research request started. The previous path then awaited up to 14 seconds for
source loading and separately collected the alert feeds twice.

## Current path

1. On opening Ask Research, warm the canonical source stores. Reuse concurrent
   preparation; recheck feed stores after a minute. No private evidence packet is cached.
2. On Send, check the authenticated workbook and refresh quotes through `positions`,
   alongside source preparation. News, ownership and weight questions need no
   preliminary model. Detailed ledger questions retain the existing Family tools.
3. Wait at most six seconds for source preparation, then use the available dated
   records. Unfinished/failed source reads remain labelled. Resolve companies after
   Family's complete holdings set has been adopted. Read the named issuers' retained
   document indexes with a separate 1.5-second bound. No scrape is started.
4. Collect the loaded alert records once; derive AI Alerts with its own `rankReport`.
   Select company-specific evidence across every source. Follow-ups retrieve the
   previous issuer; explicit issuer changes replace it. Comparisons interleave
   companies so one issuer's many records cannot crowd out another.
5. Validate private holdings separately from the 13,000-character research budget.
   A column schema preserves all ISINs, tickers (including null), names, sectors and
   exact weights without repeating field names. Prompts over 20,000 characters use
   Muns' existing hosted route; smaller prompts use the local route. This is a
   conservative character threshold, not a provider-token-count guarantee.
6. Forward NDJSON text immediately. Bound event and answer sizes, preserve fragmented
   UTF-8, and cancel upstream inference when the reader stops. Only the active answer
   repaints once per animation frame. Earlier messages and user scroll remain stable.
   Show click-to-first-text timing. Network failures preserve a labelled partial
   answer; scope/book invalidations discard it and restore the question.

These deadlines bound Research's waiting for dashboard sources, not remote Family
archive/quote latency or model inference. A failed authenticated book recheck still
stops personal research rather than silently presenting stale ownership. Source
publication dates, book dates and quote limitations remain authoritative.

## Automated checks

```bash
node scripts/verify-research.mjs
node scripts/verify-research-retrieval.mjs
node scripts/verify-portfolio-bridge.mjs
PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-research-stream-ui.mjs
```

The browser test blocks all external traffic, uses the repository's actual data
modules and committed public snapshots, and supplies synthetic authenticated
holding sizes. Its Family model read deliberately never answers, reproducing the
user's failure. Its research endpoint sends separate HTTP chunks over time.

Initial local results for the exact question: first text in **2.1 seconds cold**
and **1.1 seconds on a follow-up**. These are fixture transport/app measurements,
not live-model benchmarks or guarantees. They establish that the old timed-out
Family model no longer blocks this question and that text paints before completion.
The test also covers complete holdings, source inclusion, private storage, issuer
switching, failed archive checks, workbook invalidation and mobile layout.

The retrieval suite checks all 14 company question categories for all 124 resolved
names in the saved public book: **1,736 cases**. It also checks weight-based ranking,
unresolved funds in the denominator, comparison fairness, follow-ups, lossless prompt
compaction, model routing, stalled sources, upstream cancellation and UTF-8 splitting.
CI runs these tests along with the existing portfolio, source, alert and Worker checks.

## Question bank and answer-quality review

[ASK-RESEARCH-QUESTIONS.md](ASK-RESEARCH-QUESTIONS.md) contains 2,016 questions across
all 142 saved names, including the 18 without a resolved symbol. It includes 28
portfolio-wide cases and 14 research categories per company. Regenerate it with:

```bash
node scripts/research-questions.mjs > docs/ASK-RESEARCH-QUESTIONS.md
node scripts/research-questions.mjs --json
node scripts/research-questions.mjs --positions /private/current-positions.json --json
```

The last command requires a fresh authenticated `{sizes, holdings}` reply and
orders every holding largest to smallest when weights are complete. It prints
questions, never runs them, and emits no quantities, valuations or weights.
Do not commit private inputs or ranked outputs. The public list cannot establish
the user's actual current allocation or the rank of their largest/smallest holding.

For a staging model evaluation, use the largest, median and smallest five holdings
plus every unresolved identity. Review each category, the exact Jayaswal question,
two-turn follow-ups, and issuer switches against the packet actually submitted:

| Dimension | Passing answer |
| --- | --- |
| Relevance | Answers the requested issuer/question first; no generic company filler |
| Freshness | States event dates; never turns a recent retrieval into recent news |
| Grounding | Every material claim has a supporting source; no invented numbers |
| Exposure | Correct ownership and listed-market-value basis; unknown stays unknown |
| Recall | Includes the material retrieved evidence across relevant sources |
| Conflicts | Names disagreements; does not infer causation from correlation |
| Limitations | Distinguishes missing coverage from no activity; document titles from PDF contents |
| Responsiveness | Records click-to-first-text and completion separately, cold and warm |

The automated retrieval and transport tests do **not** establish live-model answer
quality. No live provider benchmark, private customer-book evaluation, or manual
production run was performed for these measurements.
