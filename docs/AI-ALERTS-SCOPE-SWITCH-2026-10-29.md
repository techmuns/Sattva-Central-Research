# AI Alerts: Universe → Portfolio in under a second (29 October 2026)

The Glow desk reported that switching the scope from Universe to Portfolio on AI Alerts took a long
time — the "Reading and ranking the alert feeds…" panel, then a frozen page. The collector, ranking,
window cache and tab code involved are shared with this dashboard, and the same defects are present
here (including the `warm` leak below). The figures were measured on the Glow deployment
(production captures and APIs, Chromium, a Mac's CPU unless stated); this port applies the identical
change to the shared files:

| | Before | After |
| --- | ---: | ---: |
| First complete view after a scope switch | 3.5 – 11.4 s | **0.05 – 0.25 s** |
| Same, at 4x CPU throttle | 0.6 s, then 5–12 s frozen tasks | **0.27 – 0.73 s** |
| Worst single main-thread task during the switch | 5.7 s (12.3 s at 4x) | ~0.3 s (GC pauses up to ~0.75 s) |
| Background revalidation settled | 13 – 61 s | 1 – 15 s |
| Reload in Portfolio: tab render → full list | ~6.1 s | ~1.4 s |
| Offline copy of the alert window on the device | **never written** | written every completed read |

The comparison serves identical production data to both; only `/js/` and `/css/` differ (the
deployed modules versus this branch). These are lab measurements, not field data.

## What was wrong

1. **No offline copy had been saved since 21 October.** The NSE, X and IPO sources gained a `warm()`
   function; `FEEDS` stripped `load`/`read` from the source definitions but not `warm`, so every
   feed row carried a function. IndexedDB structured-clones what it stores, so every AI Alerts
   window save and every All Alerts pool save threw `DataCloneError` after ~8 s of preparation. With
   no saved window, a scope switch and a reload both waited for the whole live read.
2. **"Sliced" work that did not yield.** The assembly generator ran several whole-history loops as
   single steps: the unique-id pass (one 9 s task at 4x), the publisher-news discovery mapping
   (4.7 s), the publisher dedupe and its address parsing (2.5–3.2 s), the saved-window copy (1.7 s),
   the story-grouping review's record walk, and the ranking's up-front filters. A slice driver can
   only stop between steps, so each of these froze the page for its whole length.
3. **Copies rebuilt on every assembly.** The discovery mapping, the dedupe winner and the unique-id
   suffix each made a fresh copy of their rows on every assembly, so every per-row cache below them
   (canonical address, sort day, the ranking's row comparison) missed every time.
4. **A narrowed read assembled the Universe again.** After every Portfolio/Watchlist read the
   collector re-assembled and sorted the whole Universe just to save it, evicting the narrowed
   assembly the next update would have reused.
5. **The view on screen was dropped on a scope switch**, and nothing painted until the narrowed
   collection had read, assembled and ranked again.

## What changed

- `FEEDS` strips `warm`; the window cache writes its manifest metadata in JSON form, so a stray
  non-data field is dropped instead of failing the save. `verify-alert-capacity.mjs` clones every
  feed row and saved window the way IndexedDB does (it fails on the old code with the same error).
- The discovery mapping, publisher dedupe, unique-id pass, saved-window copy, context index, ranking
  pre-pass, per-company story projection and review record walk are generator steps that yield;
  synchronous wrappers remain for callers that must answer now. Same rows, same order.
- Mapped discovery copies, dedupe winners and unique-id copies are kept per source row, so an
  unchanged row is the same object in every assembly.
- A Portfolio or Watchlist read saves its own scoped window; Universe saves the Universe window.
  Restoring reads both small manifests and loads only the newest usable window.
- The AI Alerts tab keeps each scope's last completed view in memory (same IST day, same scope
  membership, same signed-in session; cleared by any private-book invalidation). The first switch to
  a narrower scope in a page paints that scope's cards narrowed off the Universe view already ranked
  (`narrowReport`): provisional, replaced — never merged — by the narrowed collection's own ranking.
  `verify-ai-alerts.mjs` asserts the narrowed view holds the same companies, evidence and readings
  as a Portfolio ranking of the same records.

Glow additionally put an archive ✕ on its Compact rows; that layout is Glow-owned and is not part of
this port. Nothing about collection, retention, scope rules or what is shown changed. A reader holding an
older cached collector module (mid-upgrade) gets the previous behaviour: nothing is held or narrowed.

## Remaining

Garbage-collection pauses during background revalidation still reach ~0.3–0.75 s at 1x, and the
company-news history rebuild (`news-history.js` → `dedupeArticles`) still runs one ~0.2–0.35 s
synchronous pass; neither blocks the switch itself.
