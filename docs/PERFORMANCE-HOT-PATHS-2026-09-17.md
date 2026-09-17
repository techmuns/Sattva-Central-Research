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
  own canonical address.
- `alert-window-cache.js`: `utf8Length` measures an event without allocating; the per-part byte
  count the integrity check reads is still the encoder's.
- `tabs/insider-trades.js`: the content-derived row key and the five filter cells are read once
  per row.

## Measured after

AFTER_TABLE_PLACEHOLDER

## Still open

- The cold first read of All Alerts still decodes verified parts and merges the archive on the main
  thread (tasks of roughly 600 ms). Moving that work to a worker is the audit's item C and is not
  attempted here.
- These are sandbox measurements on the shipped captures, not the customer's machine or the host
  iframe; the 2.0 GB tab figure was recorded before PR #222 reached that browser.
