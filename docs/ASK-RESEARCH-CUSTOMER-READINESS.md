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
- Latest-company questions retain the newest dated, confirmed development, when
  available (119 of the saved portfolio names had such evidence in this run).
- A named-company question excludes unrelated fallback rows; related coverage
  retains its label and cannot become confirmed company evidence.
- The packet fits the Worker's real validation budget; browser code throws no errors.

The sweep exposed and drove fixes for shared-word matches (Aditya Birla Capital
versus Birla Corporation), symbols embedded in names (PNB Housing versus PNB),
duplicate/old feed identities, tickerless holdings, and uncertain search results
displacing confirmed company evidence. Matching keywords no longer makes a row
company-attributed. An explicit different ticker cannot be overridden by a name
in the text. All Alerts retains news-attribution status in its research rows.
The final local sweep passed all 426 packets with zero browser exceptions;
packet construction p95 was 679 ms on the development machine (warm saved data,
excluding the initial source preparation, Family and model).

The exact question "any new updates on jayaswal neco?" previously ranked a
generic stock-price reference page ahead of the September 4 company statement
about financial impact from Datasel. Generic update vocabulary no longer scores
as a topic hit, and dated developments precede reference pages. The statement
now survives into the packet and appears in the real answer. Tickerless Vedanta
questions also no longer receive unrelated RBL Bank default alert rows.

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
sample is an investigation result, not a readiness pass. The small provider rejected a 9,069-token
full-portfolio prompt against its 8,192-token context limit; full context must
continue to use the hosted route.

### Measured failures, not a customer-readiness pass

The first 50 controlled hosted requests returned 49 complete streams and one
incomplete response. First-answer p95 was 15.57 seconds; request-duration p95 was
20.25 seconds. Five automated checks flagged answers: four were wording false
positives (correct denials mentioning NAV or a sale), and one was an incomplete
answer. Factual review separately found wrong dates, wrong owning-page citations,
and unnecessary unrelated material even among answers that passed phrase checks.

The second 50-question hosted run completed all 50 streams. First-answer p50
was 7.61 seconds, p95 20.64 seconds; request-duration p95 was 21.46 seconds.
Four original phrase checks flagged correct denials of company ownership/NAV or
sales. Factual review still found an IIFL order disclosure dated September 4
instead of September 5, a news claim cited to Ask Sattva, and an Alankit chatter
claim cited to a nonexistent combined News/Public Chatter page. The revised
citation validator identifies the last case on replay without new model calls.
Thus 50 completed streams must not be described as 50 accurate answers.
Answers above 250 words (counting citation text) fell from 23/50 to 5/50;
that is a concision improvement, not a factual-accuracy score.

Seven real saved-dashboard questions were tested before and after the final
retrieval changes, using all 142 public portfolio identities with unknown weights.
All seven final hosted streams completed; first-answer p50 was 17.64 seconds,
p95 27.68 seconds, and request-duration p95 27.94 seconds. A controlled-fixture run
was active concurrently against the same provider, so these are not single-user
idle-service latency measurements. They still fail the proposed responsiveness
gate. Neither run used authenticated customer allocations.

The final saved-data review found these release blockers:

| Scenario | Material problem still observed |
| --- | --- |
| Jayaswal latest / conflicting sources | The answer retrieved the direct company statement, but incorrectly called that statement and related-entity coverage contradictory. It also invented a combined citation page in the latest answer. |
| IIFL latest | A paragraph combined AI Alerts priority/volume with investor data under a Super Investors citation. |
| Alankit latest | The model described a one-day price-change field as a return since result day, while also giving the actual result-day return separately. |
| Ashika latest | Identity uncertainty was preserved, but the answer overstated absence of an eligible alert from a missing company match. The test also exposed a stale seven-day source description, now derived from the actual alert window. |
| Vedanta Iron and Steel | Multiple dated notices were described as distinct disputes without evidence establishing whether some concern the same matter. |
| PNB Housing earnings | A normalized copy in All Alerts was called independent corroboration, and a result-day return was attributed to Technicals rather than its owning Earnings Hub row. |

These are factual/synthesis failures, not just formatting preferences. Strengthening
instructions reduced some errors but did not eliminate them. The evaluation runner
now also rejects citations to nonexistent/combined page names; semantic citation
correctness still needs factual review. No overall accuracy percentage is claimed.

Three additional controlled requests tested the actual small-model route after
the hosted runs. All completed, with first-answer times of 1.74, 1.13 and 8.60
seconds; request-duration p95 was 13.04 seconds. Factual review rejected them:
the small model described conflicting order amounts as aligned, confused a
third-party disclosure with the user's holding, and invented a citation page.
Its faster first tokens are not grounds for declaring it customer-ready.

The [recorded run manifest](ASK-RESEARCH-EVALUATION-2026-09-06.json) contains the
117 request results, exact answer hashes, timings, original automated signals,
citation-validation replay and known factual failures across the five runs.
Raw packets and answers are kept privately under
`.research-evaluation/2026-09-06/`, not committed. Runs span different revisions
and must not be combined into a single release completion-rate claim.

The public query-router schema exposes route selection, streaming, temperature
and output length; it does not expose a model name, reasoning control, separate
final-answer channel, or completion reason. The backend repository is not among
the available local projects. The next provider work is to expose a fast model
with an adequate full-book context, a separate final-answer stream, explicit
completion/truncation metadata and latency telemetry, then rerun these fixtures
without weakening the release gates. The consumer must not silently invent an
unsupported model parameter or drop holdings to fit the small context.

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
integration remain unverified. Measured inference latency and factual failures
keep readiness closed. No production research queries, manual production deployments,
scrapes or capture retries are part of these tests. The existing merge pipeline
may deploy the reviewed changes.

Even after the gates pass, call the feature ready for the evaluated use cases;
do not promise that every answer will be correct or that all market information
is present.
