# Full exchange universe: responsiveness audit

The requirement is to preserve normal product use as Universe expands from about 600 companies
to all BSE/NSE company equities. Collection runs on scheduled servers, but matching, filtering,
sorting and drawing the interface also run in the browser.

## Measured comparison

The comparison used Chromium, identical repository captures, three interleaved runs per version,
desktop and a 390px viewport with 4x CPU slowdown. External services and writes were blocked.
The expansion comparison used pre-expansion `8f87f7597` and PR #343's modules. The optimization
comparison used the deployed expanded modules and the changes accompanying this document.
These are local lab results, not field latency or a guarantee for every device/network.

| Check | Before expansion | Expanded |
| --- | ---: | ---: |
| Median cold dashboard navigation visible | 168ms | 176ms |
| Median warm navigation visible, service worker disabled for comparison | 292ms | 209ms |
| Directory requests during startup | 0 | 0 |
| Initial company-editor rows mounted | 603 | 40 |
| Median search through next painted frames, 4x CPU | 32.7ms | 32.7ms |

The startup module graph grew by 11,196 uncompressed bytes. The two directory snapshots are
1,524,533 bytes raw / 315,016 bytes gzip and are read when the company editor opens. Their transfer
time can delay a first directory opening on a slow network, independently of dashboard startup.
Production serves validators and `public, max-age=0, must-revalidate` for these files.

The expansion introduced avoidable repeat processing: the editor rebuilt three validated source
directories plus their union even after HTTP 304 responses. On the 4x CPU comparison this produced
a 131ms worst initial task and a median repeat opening of 166.5ms.

| Expanded directory, 4x CPU | Before optimization | After optimization |
| --- | ---: | ---: |
| Median repeat opening through paint | 166.5ms | 48.9ms |
| Median search handler work | 27.9ms | 15.5ms |
| Worst initial main-thread long task | 131ms | No task >=50ms observed |

The first complete-directory preparation takes somewhat longer in elapsed time when yielded
(about 360.9ms versus 265.8ms in this comparison), while leaving the main thread free between
short slices. It does not block the dashboard's initial display. Repeat source checks preserve
the same company objects and require no derived rebuild; the measured recheck plus a painted
frame was 16.8ms at 4x CPU. The new changes add about 2.2KB of uncompressed modules.

## What changed

- Exchange merging and directory construction have one generator implementation. Server callers
  drive it synchronously; the browser drives it in the existing short input-yielding slices.
- Every editor opening and visible poll still revalidates both files. Unchanged verified source
  objects reuse the complete derived company array. Errors, source check times and overdue states
  are refreshed even when the array is reused.
- Search prepares words once and caches immutable row text weakly. Each keystroke shares one
  complete membership snapshot between the list and the restore/add results.
- The release cache revision advances so returning browsers install the new modules.

## Broader checks and limits

Both pre-expansion and expanded versions passed all 28 route/view visits with the same full
captures, bounded table/card DOM and no application exceptions. Native iframe scrolling, deep/end
scrolling, variable-height rows, resize, full/filtered export, offscreen search and live updates
passed. The cached-dashboard suite passed offline opening, tab/popup interactions, private-cache
boundaries, poll ownership and automatic warm-session upgrades.

The news Universe view already had a roughly 1.2-second initialization task before expansion
(1,161ms before / 1,183ms expanded); All Alerts' complete-source startup with the local failure
fixtures took several seconds in both versions. The shell also had pre-existing cumulative layout
shift in this fixture (approximately 0.24 in both). These are not an expansion regression, and this
audit does not certify all existing product interactions as optimal. Core Web Vitals require field
measurement for a product-wide claim: https://web.dev/articles/vitals.

The company registry build took approximately 80ms for all 6,022 announcement identities on the
local server runtime. Portfolio/registered companies retain collection priority; collection
concurrency, pacing, request ceilings, schedules, retention and the news gate are unchanged.
The browser reads snapshots; opening Universe does not issue a live search for each listed company.
Additional company histories are requested with three readers only for populated/changed files.
Larger future captures still need the existing sharded, sliced, windowed and cached-reader contracts;
this audit does not claim exhaustive fresh news for every company within the bounded Sunday walk.

## Regression coverage

`verify-exchange-universe.mjs` compares synchronous and sliced output, including every field and
sorted position; verifies actual yielding; preserves object identity on unchanged revalidation;
and verifies new listings, source failure/truncation retention and original source check times.

`verify-exchange-universe-ui.mjs` uses real HTTP validators and service-worker upgrading. It checks
the complete 6,010-company list, name/ISIN/BSE-code search at 4x CPU, exclusions/restoration,
automatic additions, first-load and later outages, mobile/light/dark layouts, no hidden-editor
polling and removal of polling/listeners on close. Data-integrity requirements remain release gates.
