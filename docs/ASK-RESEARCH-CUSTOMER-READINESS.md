# Ask Research: portfolio customer-readiness evaluation

Status on 6 September 2026: **not yet certified for customer use**. Retrieval and
application tests are separate from real-model quality, live data completeness,
and the authenticated customer's book. An unavailable test is not a pass.

## Portfolio scenarios

The existing [question bank](ASK-RESEARCH-QUESTIONS.md) contains 14 categories for
each of the 142 saved portfolio names plus 28 portfolio questions. The identity
suite now checks **all 1,988 company questions**, including 18 tickerless holdings.
It also tests follow-ups, issuer switches, comparisons and synthetic largest and
smallest allocations. The saved public book contains no actual allocation sizes.

`verify-research-portfolio.mjs` builds **426 real browser evidence packets**:
latest information, earnings and filings for every saved portfolio name. It loads
the dashboard's actual adapters and committed snapshots with external requests
and APIs blocked. For each packet it checks:

- The requested company is selected without an unintended second company.
- Companies without an NSE ticker retain their ISIN and portfolio membership.
- A source with matching company rows contributes that company's evidence.
- Confirmed company news in the independently inspected source store survives
  selection, even if the adapter incorrectly reports no matching rows.
- The packet fits the Worker's real validation budget; browser code throws no errors.

The sweep exposed and drove fixes for shared-word matches (Aditya Birla Capital
versus Birla Corporation), symbols embedded in names (PNB Housing versus PNB),
duplicate/old feed identities, tickerless holdings, and uncertain search results
displacing confirmed company evidence. Matching keywords no longer makes a row
company-attributed. An explicit different ticker cannot be overridden by a name
in the text. All Alerts retains news-attribution status in its research rows.
The final local sweep passed all 426 packets with zero browser exceptions;
packet construction p95 was 624 ms on the development machine (warm saved data,
excluding the initial source preparation, Family and model).

A news-attribution regression also caught a person sharing a ticker word:
an article about Ashika Ranganath had been labelled Ashika Credit Capital news.
An unqualified ticker now requires its explicit uppercase spelling; reviewed
company names and brands still match normally. Old attribution version 1 is
re-evaluated, so cached false matches cannot retain their former confirmation.

The streaming browser regression separately covers the exact Jayaswal question,
incremental painting before completion, follow-up retrieval, issuer switching,
an unavailable Family book, workbook invalidation, cancellation, partial-answer
recovery, private storage and mobile layout. Its model text and Family allocations
are fixtures. Its timings are **not real-model or customer-book benchmarks**.
The customer's subsequent "answer ended before a complete response arrived"
screenshot is reproduced as an empty HTTP 200 stream. The browser reconnects
once before any answer text; a repeated closure stops and preserves the question.
Partial answers, explicit provider errors, authentication failures and cancellations
are never silently replayed.

## Actual model evaluation

`evaluate-research-model.mjs` runs **50 controlled scenarios** through the real
Worker handler and configured Muns provider. No mock inference mode is provided.
Company identities come from the portfolio; all financial facts and allocation
weights in these probes are explicitly synthetic. Jayaswal Neco, IIFL Finance,
Alankit and tickerless Ashika Credit Capital exercise different allocations and
coverage states. They do not represent the customer's largest or smallest holdings.

The scenarios cover latest developments, revenue versus profit, loss-to-profit
comparisons, unread filing contents, unavailable guidance and consensus, technical
dates, chatter versus share-price returns, disclosure thresholds versus sales,
operating units, conflicting amounts, future meetings, ownership basis, injected
article instructions, follow-ups, stale-only evidence, failed feeds, unknown
weights, genuine zero values, sampled archives and unresolved symbols.

```bash
node scripts/verify-research.mjs
node scripts/verify-research-retrieval.mjs
node scripts/verify-research-evaluation.mjs
node scripts/verify-portfolio-bridge.mjs
PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-research-portfolio.mjs
PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-research-stream-ui.mjs

# Existing local provider credentials only; never put credentials in a command.
node --env-file=.dev.vars scripts/evaluate-research-model.mjs

# Or an approved staging/loopback preview that already holds the credential:
RESEARCH_STAGING_URL=http://127.0.0.1:8794/api/research node scripts/evaluate-research-model.mjs
```

The model runner exits **2** when credentials are missing and records zero model
calls and `customerReady: false`. Reports and exact packets/answers are written
to the gitignored `.research-evaluation/` directory, with restrictive file modes.
Every answer has a hash so factual review can identify the precise output reviewed.
Progress logs contain scenario IDs, not private prompts, answers or credentials.
Automated phrase checks are conservative tripwires; passing them only means an
answer is ready for factual review. They do not certify its accuracy.

The initial credential blocker was resolved using Wrangler's temporary remote
development environment and its inherited encrypted bindings. The research-only
preview exposes no capture, data-mutation or production deployment routes. No
provider credential was extracted. Real tests exposed draft narration mixed into
the single text channel and output ending mid-sentence at the former token limit.
The Worker now requests a framed final answer, streams only that answer, and
requires its closing marker before reporting completion. The provider may join
the draft and final answer without a newline; every split of that transition is
covered by the parser regression. Output allowances are 2,048 tokens for the small
route and 3,072 for hosted, with the independent customer-answer character bound
unchanged. A missing final marker produces a labelled failure, never a false success.

Three initial real hosted probes (latest, conflicting sources and earnings)
produced complete, cited final answers after this change. Their first-answer p50
was 9.18 seconds and p95 10.94 seconds; completion p95 was 21.86 seconds. This tiny
sample is an investigation result, not a readiness pass. A full 50-scenario run
and manual review are required below. The small provider rejected a 9,069-token
full-portfolio prompt against its 8,192-token context limit; full context must
continue to use the hosted route.

## Release gates still required

| Gate | Acceptance evidence |
| --- | --- |
| Controlled model quality | Run all 50 probes. Review every material claim and citation against its exact packet; no invented figures, wrong issuer, unsupported ownership, false freshness, or followed source instructions. |
| Real portfolio answers | Review at least 100 real-model questions with current dashboard packets, covering the largest, middle and smallest five authenticated holdings and every tickerless holding. Include all 14 company categories, follow-ups and issuer switches. Missing actual weights prevent a size-stratified claim. |
| Material recall | Each answer covers the material requested developments available in its packet. Any critical omission blocks release; missing upstream evidence is recorded separately. |
| Relevance and synthesis | At least 95% of reviewed answers directly answer the question with supported significance, dated evidence and useful next milestones or explicit gaps. No generic filler substituting for company evidence. |
| Responsiveness | Measure click-to-first-text separately from completion on the actual staging Family/browser/provider path. Proposed targets: warm p95 ≤3 seconds, cold p95 ≤8 seconds, completion p95 ≤25 seconds, ≥99% successful completion over at least 100 requests. These are release targets, not measured guarantees. |
| Resilience and privacy | Local cancellation, partial recovery, stale book, issuer-switch and concurrent-stream tests pass. Repeat at least three concurrent sessions in staging; no cross-session context or output. |
| Current information | Read-only inspection confirms relevant scheduled source checks and coverage. Do not equate deployment timestamps with source freshness or guarantee exhaustive upstream history. |

The authenticated customer's actual weight ranking and full Family/browser
integration remain unverified. Initial measured provider latency exceeds the
proposed responsiveness gate, so readiness remains closed while the larger
evaluation runs. No production research queries, manual production deployments,
scrapes or capture retries are part of these tests. The existing merge pipeline
may deploy the reviewed changes.

Even after the gates pass, call the feature ready for the evaluated use cases;
do not promise that every answer will be correct or that all market information
is present.
