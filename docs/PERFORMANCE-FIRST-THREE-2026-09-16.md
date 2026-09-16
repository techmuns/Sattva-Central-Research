# First three performance fixes: validation

Baseline: `7ddfaeb86c771a0bd52858b8bec015f30acb9a66`. All experiments used local fixtures;
no production source records or collection jobs were changed.

1. Earnings Reported and Calendar own one current table. Ordinary source updates reuse it;
   changing the panel disposes it before replacement. Tab subscriptions remain independent,
   and exports read current source metadata.
2. The existing measured window reuses unchanged row content and parses entering/changed rows.
   Its node cache contains only mounted rows, and markup reuse is bounded to 160 rows. A height
   correction checks viewport coverage again without waiting for another user scroll.
3. All Alerts prepares its selected period before costly news interpretation and the table model.
   Original source history is still read and validated; cross-date duplicate provenance is
   preserved. This is not a complete raw-cache memory redesign.

## Controlled browser observations

Using `scripts/verify-performance-ownership-ui.mjs` with the same fixture and Chrome:

| Experiment | Baseline | Fixed |
| --- | ---: | ---: |
| Active Earnings tables after initial mount plus 100 updates | 101 | 1 |
| DOM nodes after those updates, including detached nodes | 248,726 | 2,528 |
| Event listeners after those updates | 939 | 39 |
| Row cells rebuilt during 30 scroll steps over 50,000 records | 200 | 98 |
| Row markup parsed during those scroll steps | 200 | 98 |

The fixed Earnings node/listener counts did not grow during the 100 updates. Forced-GC JS heap
grew by roughly 0.36 MB, versus 10.26 MB on the baseline. These are isolated renderer measurements,
not a measurement or explanation of the customer's reported 3.4 GB browser footprint.

## Data and behaviour checks

- Compare complete event objects for 1/3/7/14/30-day queries against the full retained pool;
  the local fixture contains over 100,000 events. Preserve IDs, corrected fields and source records.
- Preserve cross-date duplicate provenance, full-cache isolation, older/undated/upcoming records,
  current membership, private revocation, failed-source retention and confirmed empty results.
- Exercise all 24 dashboard route/view combinations and native iframe scrolling, deep/end jumps,
  variable heights, reader anchors, resize, full/filtered exports and off-screen search.
- Exercise automatic Calendar outage recovery and current-date polling in Portfolio and Universe.
- Verify an already open browser upgrades its immutable module cache automatically and retains
  preferences, using `verify-dashboard-performance-ui.mjs`.

Prior changes reviewed include PRs #114, #132, #134, #147, #152, #172–173, #176, #178–180,
#182, #189, #191, #193, #195, #200–201, #204, #207–208, #215 and #217–218. This patch preserves
the measured-height window, current arrivals presentation, independent full-history cache,
source-by-source recovery and AI card/ranking changes. It does not restore the reverted pointer
workaround or fixed-height clipping.
