# Dashboard-wide performance, 6 September 2026

## Diagnosis and changes

The bottleneck was not the number of retained records alone. It was rendering all of them and
recomputing unchanged derived data on the browser's main thread.

1. **High impact — unbounded DOM.** News, Earnings, Con-call, NSE and Insider tables continued
   adding thousands of rows during idle time. Other tables appended indefinitely while scrolling.
   The shared screener now automatically windows tables above 160 records; smaller lists remain
   ordinary tables. Market-wide News uses the same measured-window engine for cards/images.
2. **High impact — repeated complete News unions.** A CPU profile of a repeat News visit found
   most of 4.6 seconds in TradingView/base merging, URL canonicalization and deduplication, invoked
   repeatedly by coverage/per-company reads. The complete union is now reused until either source
   or its retention day changes. Source row and company-identity stability also preserves topic
   and attribution caches. The retention and attribution rules themselves are unchanged.
3. **High impact — repeated announcement merges and UI replacement.** Shared/company/NSE unions
   now reuse unchanged inputs. Equal source arrivals preserve the retained row objects; status-only
   notifications do not replace the active search field. Exact content comparison happens on a
   changed source batch, not on every table paint.
4. **Medium impact — repeated work during interactions.** Sort accessors run once per record;
   searchable text warms in short idle slices. Live row patches invalidate their search entries.
   AI context enrichment indexes the complete pool by ticker once per ranking operation instead
   of scanning the whole pool once per company. All Alerts yields to browser input before and
   between feed-normalization batches. No context or ranking rule is removed.
5. **Lifecycle and usability.** Table observers/listeners are disposed on navigation/repaint.
   Stars preserve scroll position, variable-height content is measured rather than clipped,
   and the search control has an accessible name and a usable minimum width. The service-worker
   version is bumped so returning browsers receive the new module graph.

## Local measurements

Chrome on macOS, 1440 × 900, dashboard inside a single iframe, committed captures at base commit
`68ebca4`, local API fixtures and external traffic blocked. These are lab observations, not field
INP or guarantees for every device. Route-ready timing includes synchronous work before the panel
is available, but is **not** a promise that every optional/background feed has finished loading.
Background DOM growth was sampled after 1.5 seconds.

| View | Before mounted rows/cards | After mounted | Full retained/view records |
| --- | ---: | ---: | ---: |
| Portfolio News | 3,840 and still growing | 40 | 6,514 |
| Earnings reported | 2,360 | 40 | 2,360 |
| Con-call library | 1,239 | 40 | 1,239 |
| Technical scanner | 400 and still growing | 40 | 603 |
| FII accumulation | 222 | 40 | 222 |
| NSE filings | 2,930 | 40 | 2,930 |
| Insider trades | 2,480 and still growing | 40 | 13,244 |
| Market News cards | 600 | 40 | 600 initially loaded |

IPO filings (6,494), Corporate Announcements (11,250), Corporate Actions (8,846), uncovered
Chatter (168), and Telegram's default dated view (252) also remain at 40 mounted records.
All Alerts retains its existing separate 24-row, fixed-stride implementation.

Portfolio News repeat-open improved from **4,663 ms in the CPU profile to 64–93 ms**, including
72 ms in the final 25-view sweep. Its page DOM fell from over 50,000 elements while still filling
to about 750. Most sampled table searches/sorts were 16–34 ms after warm-up.

### Core Web Vitals and limits

| Metric | Initial local trace | Interpretation |
| --- | ---: | --- |
| LCP | 399 ms | Good in this local trace; the candidate was introductory text, not data readiness |
| CLS | 0.01 | Good in this trace |
| TTFB | 3 ms | Local static server only; not production latency |
| INP | Not established | No production field percentile; scripted interaction times are not INP |
| Render-blocking/cache insight savings | 0 ms | Not the measured bottleneck; no speculative resource removal |

Interpretation follows the [Web Vitals definitions](https://web.dev/articles/vitals) and
[Chrome performance tooling documentation](https://developer.chrome.com/docs/devtools/performance).

The full-universe first AI build still took roughly 3–4 seconds after other feeds had loaded;
first Insider preparation roughly 1.2 seconds. Background announcement work also caused one
719 ms search sample. Bounded rendering fixes DOM/scroll pressure, but does **not** eliminate all
cold-start CPU work. A next profiling pass should target cooperative/off-main-thread preparation
of those complete datasets, with parity tests, rather than reducing coverage. No claim of
"every action is instant" or of a flawless production host is made.

## Verification and data guarantees

- `scripts/verify-tab-performance-ui.mjs`: 25 route/section visits in an iframe, full-data DOM
  bounds, zero application exceptions, native wheel input, deep/end scrolling, natural tall rows,
  star/reading position, global sorting, final off-screen record search, full/filtered export
  callback parity, live search invalidation, resizing and repeat mount/dispose.
- `scripts/verify-windowed-geometry.mjs`: exact offsets/boundaries for 100,000 variable-height rows.
- Existing cache/offline, source refresh, corporate stream/action, attribution, continuous News,
  All Alerts pool/privacy and AI evidence contracts remain in CI.
- Source archives, default filters, unverified/related labels, counts, record fields, source URLs
  and export inputs are not truncated by windowing. The application search covers the **whole**
  matching dataset; native browser Find and screenshots only see mounted content.
- Caches are in-memory derivations of existing data. No new persistent private cache or source
  request fanout was introduced. The existing service-worker private/API exclusions are tested.
- Unconnected consensus, calendar, issuer-directory or authenticated document/research states in
  the offline fixture are tested as honest unavailable/on-demand states, not certified as loaded
  production-data performance. Existing specialized fixture tests cover their data contracts.
- The surrounding Munshot page and other hidden host iframes are outside this change. No manual
  production deployment, restart or data mutation was performed.

The performance skill's trace/CPU evidence directed these changes. The app remains native ES
modules with precompiled CSS: no framework, bundler or runtime virtualization dependency added.

Reproduce with `PLAYWRIGHT_ROOT=/path/to/playwright CHROME_PATH=/path/to/chrome node
scripts/verify-tab-performance-ui.mjs`. Optional `TAB_PERF_PROFILE=1` prints CPU sample hotspots;
`TAB_PERF_ROUTES` selects comma-separated routes. CI runs the complete sweep without timing
thresholds tied to a particular machine, while enforcing structural/data correctness.

## Corporate Actions: cached data readiness (6 September 2026)

The next report identified a different bottleneck from table size: `load()` restored the device
cache but withheld `isLoaded` and its change notification until the network revalidation ended.
The request has a 20-second timeout. A repeat visit therefore waited even with every record on disk.
The committed exchange-wide file contains 8,846 rows (8.74 MB uncompressed); a cold device still
needs its first download. No source rows or fields have been reduced to achieve the following gains.

The feed now publishes valid saved rows immediately, with a visible checking/capture-age status.
Load, polling and manual refresh share one check. Successful new captures still replace the view;
unchanged 200/304 responses retain row identity, search focus and reading position. Invalid, empty
and older responses keep the last-good table and cannot overwrite its persistent cache. A failed
attempt does not advance the successful-check timestamp. Invalidation ignores late completions.
"Up to date" requires both source layers to report live, recent captures and a successful current
file check; a retained or failed layer remains explicitly unconfirmed.

Local Chrome results, not production measurements:

| Scenario | Before | After |
| --- | ---: | ---: |
| Cached reopen in iframe, deliberately delayed 8-second check | 8,423 ms | 82 ms |
| First Corporate Actions portfolio visit in the full local app | — | 146 ms |
| Switch to all 8,846 actions | — | 45 ms; 40 rows mounted |
| Full-universe search / sort | — | 28 / 24 ms |

The isolated post-fix DevTools trace showed LCP 148 ms and CLS 0.00 while the eight-second request
was **still pending**. Render-blocking savings were 0 ms. INP was not established by that trace.
The accessibility snapshot retained named search/filter/export/source controls and visible data.
This proves the cached-data handoff locally, not cold-download speed or surrounding-host latency.

`verify-corporate-actions-ui.mjs` now runs the slow-response iframe regression with the real live
engine, one-request assertion, retained focused controls, storage-poisoning and failure/recovery
checks. `verify-corporate-actions.mjs` additionally covers delayed reads, concurrent callers, new
records, identical responses, rollback rejection, invalidation races and unavailable storage.
The existing full-data window/search/export and app-shell offline/private-cache tests also pass.
