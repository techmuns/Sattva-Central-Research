# Hot-path caches: the remaining tab-open stalls after PRs #220 and #222

Baseline: `b7a4bd129e862b36a738bda33185f515b34e3661` (main after PR #222). Same machine, same
shipped captures, headless Chromium 141 through Playwright, one browser at a time, CPU profile
started before navigation. Nothing here changes what is collected, retained, matched or shown; every
change is a cache on a pure function, and `scripts/verify-hot-path-memo.mjs` asserts each one is
invisible.

## What the profiles found

After #222, memory was bounded but three tab opens still froze the page:

| Path | Longest main-thread task | Where the time went |
| --- | ---: | --- |
| Insider Trades, Universe, cold | 1,866 ms (three tasks over 1.3 s) | `pickField` rebuilt a flattened key map on every call: 1,920 ms self time; `folded` 628 ms; `newsDay` 523 ms via `newsPeriodBounds` per row |
| AI Alerts, then All Alerts (Portfolio, Today) | 4,242 ms | the whole news history re-read: `canonicalArticleUrl` 1,635 ms + `URL` 868 ms (16,384-entry text cache against 81,921 rows), `matchKeywords` 1,835 ms (65,536-entry cache, same thrash), `normalizeNewsText` 1,820 ms (four attribution reads per story, none cached), plus 1.5 s of `TextEncoder.encode` measuring one event at a time |
| All Alerts, Universe, cold | 681 ms | verified part decoding, the IndexedDB put of the pool and the archive merge — inherent to a first read and left alone here |

The second row did not respond to per-row caches at first, and the reason is the rule this change
records: the publisher projection built every projected story as a fresh object on every rebuild,
and `attributeNewsRow` remembered only the last identity a story was attributed under, so every
rebuild produced new row objects and every cache keyed on them missed at once.

## What changed

- `filings-shared.js`: `pickField` caches the object's key shape and reads values live;
  `articleUrlKey` remembers a row's canonical address on the row; `dedupeArticles` reads it.
- `insider-history.js`: `folded` is a bounded text cache; the field lists are module constants; a
  row that already carries its category is returned unchanged; `insiderTradeIdentity` is one string
  per row object.
- `news-window.js`: `newsDay` remembers the current minute and recent timestamp strings;
  `newsPublicationDay` is one reading per row; `newsPeriodBounds` is one frozen object per period
  and day.
- `company-news-attribution.js`: `attributionFor` is one reading per row; `attributeNewsRow` is one
  decorated row per (row, identity).
- `news-keywords.js`, `portfolio-news-matching.js`: `classifyStory` and `newsEventTopics` are one
  reading per row. `portfolio-publisher-news.js`: one projected row per (match, publisher row).
- `news-history.js`: the observation instant is parsed once per row rather than per comparison.
- `daily-alerts.js`: `istDay` caches timestamp strings; the query candidate set reads the row's
  own canonical address; before the synchronous news collectors run, `warmNewsReadings` walks the
  reader chain's `warm()` and then every candidate row's story reading in ~12ms slices with a
  yield between each, so a cold full-history pass no longer lands as one multi-second task.
- `filings.js`, `portfolio-publisher-news.js`, `tradingview-news.js`, `news-history.js`: each
  reader exposes `warm(yieldForInput)`, which touches the attribution or portfolio match its own
  `rows()` rebuild will hit, in slices, under the same identity objects the rebuild uses.
- `alert-window-cache.js`: `utf8Length` measures an event without allocating; the per-part byte
  count the integrity check reads is still the encoder's.
- `tabs/insider-trades.js`: the content-derived row key and the five filter cells are read once
  per row.

## Measured after

Same harness as the baseline; longest main-thread task while the route opened and settled, CPU
profiler attached (which inflates every figure a little, before and after alike):

| Path | Before | After |
| --- | ---: | ---: |
| Insider Trades, Universe, cold open — longest task | 1,866 ms | 749 ms |
| Insider Trades — `pickField` self time on that open | 1,920 ms | 77 ms |
| AI Alerts, then All Alerts (Portfolio, Today) — longest task | 4,242 ms | 1,536 ms |
| All Alerts (Portfolio, Today) re-entered after AI Alerts — longest task | 4,278 ms | 588 ms |
| News (Portfolio), then All Alerts (Universe) — longest task | 640 ms | 667 ms |
| All Alerts, Universe, cold open — longest task | 681 ms | 573 ms |

What moved and why: Insider Trades no longer rebuilds a key map or reparses dates per row; the
switch from AI Alerts still performs the full-history read AI Alerts asked for, but the
attribution, classification and event construction now run in ~12ms slices with a yield between
each, so the one remaining synchronous block is the report assembly and sort. Total CPU for that
read is unchanged — it is the same work, spread — which is why the settled time of the route is
similar and its longest task is a third of what it was. Memory is not changed by this work: every
cache is keyed on a row object that is already retained, or bounded.

`verify-tab-performance-ui.mjs` now asserts a main-thread budget on Insider Trades under Universe,
with headroom for a CI runner at half local speed. All Alerts under Universe is not budgeted: in
that sweep it follows AI Alerts, whose full-history ranking still lands a task of two to three
seconds under whichever tab follows it (see below).

## Round two, same day: sliced rankings, prepared readers, a sliced assembly

Round one made a repeat read cheap and left the first one alone. Profiled on the corrected tree
with the same harness (per-long-task attribution, CPU profiler attached), the remaining stalls were
five one-second tasks while AI Alerts ranked its partial reports over the Universe, a 1.6-second
block where a sliced rebuild stopped yielding, a 1.0-second block at start-up classifying every
market-wide story in one pass, a 2.7-second final assembly of the full-history collection landing
under whichever tab the reader had moved to, and 400–600ms blocks in the NSE, announcement and
insider collectors classifying every row again after a warm-up that had touched different objects.

### What changed

- **One implementation, two drivers** (`public/js/core/slices.js`). A rebuild or a ranking is a
  generator that yields once per unit of work; `runSteps` drives it to completion now and
  `runStepsInSlices` drives the same generator in ~12ms slices with a yield to input between them,
  stopping — and resolving to `undefined`, never a partial — once `keepGoing()` says nobody is
  waiting. `rankReport` and `rankReportAsync` are the two drives of one `rankSteps`; the three news
  readers' `buildRows` / `buildCombined` and the alerts `assembleSteps` are driven the same way;
  `sortSteps` is a stable merge sort as a generator, ordering exactly as the native stable sort.
- **AI Alerts ranks in slices**, partial reports through a latest-wins queue that closes before
  the final report, and keeps a finished ranking so a return visit paints it rather than redoing it.
- **Readers prepare before they announce.** A reader builds its combined rows in slices before it
  emits — on a publisher change, a snapshot change and, from this round, a base or book change
  too — so the first synchronous `rows()` a subscriber makes is a hit. One preparation is shared
  by concurrent callers, and one the source churn abandoned is tried again against the newer state
  rather than leaving the next synchronous read to rebuild in one task.
- **Collectors warm what the assembly reads, on the objects it reads.** Every per-event reading the
  synchronous collectors and the assembly make — the event itself, its sort day, its canonical
  address, the portfolio discovery reading and the story reading of each match — is kept on the
  source row and touched in slices first, through one `touch(event, feedId)` for every warmed
  feed (company and market-wide news, announcements, insider, NSE, X and IPO rows). What made the
  first version of that warm-up worthless was object identity: `rows()` handed the read a fresh copy
  of every row after any invalidation, `fromMarketNews` and the X / IPO adapters built a fresh event
  per read, and `portfolioNewsEntities` built fresh identity objects per assembly while attribution
  is cached per (row, identity object). The projection, the promoted insider row, the events, the
  discovery reading and the identity objects are all kept while their inputs are unchanged now.
- **The assembly is sliced.** The seed publication, every partial (one at a time, coalesced) and
  the final report are built through `assembleInSlices`, including the sort and the counts, and the
  cached All Alerts window is restored the same way. The final report is never published beneath a
  partial: a partial still building finishes first with its publication withheld.
- **The source beacon reads the estate off the poller tick**, half a second after it while open and
  three seconds after it while closed, instead of inside it — where it found the news readers'
  unions invalidated and not yet prepared and rebuilt them synchronously.
- **Contracts.** `verify-ai-alerts.mjs` asserts the sliced ranking and merge `deepEqual` their
  synchronous references (fixture and a 3,000-company synthetic Universe, ten yields, longest
  stretch 13ms) and the sliced sort against the native sort; `verify-general-alerts.mjs` asserts
  the sliced assembly equals the synchronous one; `verify-hot-path-memo.mjs` asserts one event per
  source row, that a warm-up's objects are the read's, and the discovery reading per record; the
  reader suites assert a sliced preparation reads what a synchronous read reads.
  `verify-tab-performance-ui.mjs` budgets AI Alerts and All Alerts under Universe.

### Measured after

Longest main-thread task while the route opened and settled, profiler attached, shipped captures:

| Path | Round one | Round two |
| --- | ---: | ---: |
| AI Alerts, Universe, cold open — longest task | ~2,400 ms (the ranking) | 131 ms |
| AI Alerts, Universe, returning session — longest task | 5 × ~1,000 ms (partial rankings) | 431 ms (garbage collection and an IndexedDB completion; no app frame above 30ms) |
| AI Alerts, then All Alerts (Portfolio, Today) — longest task | 1,536 ms | 866 ms (a source-beacon estate read during the cold load, removed after this profile — see below), then 589 ms (a reader rebuilt during source churn) |
| All Alerts, Universe, returning session — longest task | 568 ms | 305 ms (the insider seed merge) |

On the AI Alerts → All Alerts transition the final assembly no longer appears in the profile at
all (it was 2,713, 2,293 and 1,599 ms across this round as each cause was removed). What remains
on that cold path is source churn: twenty feeds land over half a minute, each announcement
invalidates the news readers' unions, and a reader asked for its rows before its preparation has
caught up rebuilds in one task — 589ms for the TradingView union here, and 866ms when the closed
source beacon read every source's `meta()` three seconds after a tick. The beacon no longer reads
the estate on a tick while closed (its minute clock still does), which removes the second; the
first is bounded by the retry in `prepareOnce` and is listed below. Total CPU is not lower — the
same work is spread — and the heap figures the harness samples are single readings taken
mid-collection, not a steady state.

## Still open

- Garbage collection is now the largest single item inside the longest tasks on the returning
  paths (200–350ms of each): the readers' seed merges and the sliced warm-ups allocate freely. A
  lower-allocation merge for the insider and news seeds is the next measurable step.
- Total CPU per collection is unchanged by this work, and the 2.0 GB tab figure was recorded
  before PR #222 reached that browser; memory is bounded by the same rows the caches key on, and a
  steady-state heap measurement on a real machine is still owed.
- `verify-news-working-set.mjs` fails on unmodified `main` with the captures committed on
  17 September: a story with two publisher twins (a TradingView mirror with an IST publication day
  inside a 3-day window and a Mint original dated the day before it) is folded by title in the
  full-history reader, which keeps the out-of-window twin, and kept in the bounded reader, whose
  publisher window is applied before the fold. Which twin represents a story at a window edge is a
  reader-design question, not this change's, and is left as is.
- These are sandbox measurements on the shipped captures, not the customer's machine or the host
  iframe.
