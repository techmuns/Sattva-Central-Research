# General portfolio reasoning

Ask Research must interpret unfamiliar portfolio questions using the supplied
business evidence. A missing theme/peer classification is not a reason to refuse.
The model can explain a conditional economic mechanism; it cannot invent company
activities, customer relationships, exposure percentages or realised benefits.

## Retrieval

`reasoning-context.js` builds a query-time view of the complete supplied holdings
list. It uses arbitrary words from the question and the reference company's own
analysis/industry to rank company-linked passages. Existing business concepts can
still accelerate known peer questions, but an unfamiliar business falls through
to this general path. Scenario, risk, dependency, exposure and follow-up questions
use it directly. Ordinary single-company questions keep the smaller packet.

The general packet includes:

- Every supplied holding's identity, name and available industry, with an explicit
  source index. A separate table carries one question-ranked Con-call analysis
  tag per company where available, with its publication date and source.
- Detailed question-relevant source excerpts, including contrary evidence from
  another source, before ordinary source-row sampling. These are relevance
  candidates, not certified peers or beneficiaries.
- Original source rows for numeric/period facts, all 21 source statuses and
  provenance, explicit missing/omitted counts and the separate authenticated book.

Identical passages assigned to several holdings remain available as shared
context, explicitly labelled, with lower ranking than issuer-specific passages.
An unsplit market roundup must not inherit individual business attribution from
each of its mentioned names.

No additional model-planning call, network source, embedding service or stored
private dossier is introduced. Matching happens against loaded dashboard records.
The general evidence ceiling is 30,000 provider-facing characters (Worker maximum
37,000), versus 18,000/19,000 for ordinary research. Full positions retain their
separate 60,000-character bound. At most 65% of the general allowance goes to the
business map and excerpts. Under smaller caller budgets, complete excerpts and
then identities are removed with omission counts; numbers/units are not cut to
make an excerpt fit. Text retrieval keeps up to 12 readings per holding per source,
after query ranking. No fixed list of products or sectors gates this path.

## Answer contract

Give the substantive conclusion first. Explain the connection from the actual
business evidence, including opposing effects or counter-evidence. Separate:

1. Documented company facts and reported outcomes.
2. Conditional interpretations of those facts under the question's scenario.
3. Measured price performance with the required dates and endpoints.

A scenario in the question is not a reported event. A financial amount expressed
in dollars is not proof of contractual FX exposure. Parent or affiliate debt is
not the held company's liability. Co-mentions, industry labels, source query names
and shared price direction do not establish customers, peers or causation.
Industry-only ideas must remain conditional research candidates. Citation page
names and analysis dates are separate; all profile analysis cites Con-call.
Before naming a beneficiary, the answer contract checks the direction from
revenue and expense changes to margins or cash flow. Unknown repricing speed,
fixed/floating terms, pass-through and hedges remain conditional premises.

## Validation and limits

Run `node scripts/verify-research-reasoning.mjs` and
`PLAYWRIGHT_ROOT=/path/to/playwright node scripts/verify-research-reasoning-ui.mjs`.
The first covers 12 scenarios including previously unlisted business vocabulary,
input costs, interest rates, currency, suppliers, reverse follow-ups, contradictory
social evidence and small/tickerless holdings. The browser suite checks six broad
questions against the whole saved public dashboard, complete business-map coverage,
source provenance and packet budgets. It includes the crude-oil/Oil India name
collision and the difference between a market-wrap list and issuer evidence.

The reusable question bank adds macro, value-chain, demand, second-order,
contradictory-evidence and falsification questions. These are a test inventory,
not evidence that every model response has passed a customer acceptance review.

Lexical relevance can miss synonyms, implicit links or misunderstood context.
The business map lets the model consider companies beyond exact word matches,
but analysis tags are bounded provider summaries, not full transcript reads.
Industry labels can be broad, outdated or unavailable. Missing matches cannot
prove no exposure. Source collection gaps, unread documents, limited discussion
topics and missing event-price endpoints remain material limitations.

A larger single inference is a quality/latency tradeoff. Deterministic retrieval
checks do not certify live model accuracy, current private holdings, source
completeness or customer-visible latency. Review real-model answers claim by claim;
never certify general customer readiness from keyword tripwires or a small batch.

To export reproducible saved-dashboard inputs without contacting production:

```sh
PLAYWRIGHT_ROOT=/path/to/playwright RESEARCH_EVAL_EXPORT=/tmp/portfolio-reasoning.json node scripts/verify-research-reasoning-ui.mjs
RESEARCH_STAGING_URL=http://127.0.0.1:8798/api/research RESEARCH_EVAL_INPUT=/tmp/portfolio-reasoning.json RESEARCH_EVAL_DIR=/tmp/portfolio-reasoning-review node scripts/evaluate-research-model.mjs
```

The second command requires an explicitly configured development/staging Worker.
It makes actual model calls. Exports use saved public identities and unknown weights,
never real customer allocations; outputs require manual factual review.
