# Momentum Scanner

A live, universe-wide technical screener, the **Momentum Scanner** sub-view of
**Breakouts / Technical**. It ranks every listed company against a small set of momentum
**filters** — price above its moving averages, multi-timeframe RSI strength, a volume surge
with a bullish MACD — and recomputes every figure **on the in-progress candle from the current
price**, so the answer is current to the quote rather than to the last end-of-day scrape.

It adds no data source of its own. It reads the daily technicals feed every other Breakouts
sub-view reads, plus the live quote feed `render()` already subscribes to, and does all of its
work in the browser.

## Three layers, three jobs

The feature is deliberately split so the accurate-but-heavy part is done once a day and only the
cheap part runs live. Nothing below recomputes the history intraday.

| Layer | Where | Job |
| --- | --- | --- |
| **Data** | `scripts/scrape-technicals.mjs` → `public/data/technicals.json` | Once a weekday, compute and store the indicator **state** each stock needs (SMA20/50/100/200, the 10-day average volume, and the running Wilder/EMA state for RSI and MACD). |
| **Engine** | `public/js/scoring/momentum-live.js` | Pure, dependency-free. Advance that stored state **one step** with the live price, and hold the filter definitions as data. |
| **UI** | `renderMomentumScanner()` in `public/js/tabs/breakouts.js` | Draw the ranked table, the summary strip and sector bar, and the gate/threshold controls. Re-paints on every live tick. |

The engine is imported by both the browser and `scripts/verify-momentum-scanner.mjs`, so the
math the dashboard runs and the math the test checks are the same code.

## The live engine — `momentum-live.js`

Intraday the only things that move are the **current price** and **today's cumulative volume**;
the rest of the history is fixed until the next daily scrape. So each figure is the stored
end-of-day state advanced by one step, as if today's (or this week's, or this month's) candle
closed at the current price.

- **RSI (daily / weekly / monthly).** `advanceWilderRsi(state, livePrice)` performs the identical
  Wilder step `scripts/lib/momentum.mjs` performs in the pipeline:
  `avgGain' = (avgGain·13 + max(0, Δ)) / 14`, `avgLoss' = (avgLoss·13 + max(0, −Δ)) / 14`,
  where `Δ = livePrice − lastClose`. The verifier asserts the browser and the pipeline agree to
  `1e-9`, so the two can never drift.
- **MACD.** `advanceMacd(state, livePrice)` advances EMA12 (`K = 2/13`) and EMA26 (`K = 2/27`)
  one step, takes `line = ema12 − ema26`, and advances the signal (`K = 2/10`). `bullish` is
  `line > signal`; `freshCross` is bullish **now** but not at the last completed bar — a new
  signal, not a standing one.
- **DMAs.** The live price compared directly to the stored SMA20/50/100/200.
- **Volume.** Today's cumulative volume so far ÷ the stored 10-day average. It reads low early in
  the session, by design — it is a running total, not an end-of-day one.

`liveIndicators(company, livePrice, liveVolume, prevClose)` rolls all of this into one flat
object the filters test (`rsiDaily`, `macdBullish`, `above20dma`, `volRatio10d`, …).

### Evaluable vs pending — the honesty rule

A stock is **evaluable** only when it carries the whole Step-1 field set (RSI state **and** MACD
EMAs **and** SMA20/50/200) and there is a finite live price. Any one field present is not enough:
the daily refresh writes them together, so their joint absence is the "pending" signal — the file
has not been refreshed with the Step-1 fields yet. A pending row is never shown as passing; it is
counted apart and the table says so.

Every field is `null` (never a fabricated number) when its input is missing. A young stock with no
100-day history has a real `null` SMA100 — handled per condition — which is different from a
pending row. A `null` never renders as a zero.

### Live / provisional vs end-of-day

A figure recomputed on a fresh live quote is **live / provisional**; otherwise it is advanced from
the **last completed daily close**. Each cell says which in its tooltip, so an intraday number is
never mistaken for a settled one, and the price cell shows either the live quote label or
`Daily close · <date>`.

## Filters are data

Each filter is an entry in `MOMENTUM_FILTERS` — `{ id, label, short, description, conditions }` —
and a stock passes when **every** condition is true and the row is evaluable. The set is built to
grow toward ~40 filters; adding one is data, not new control flow (see below).

Two ship today:

- **Filter 1 · Strong Momentum** (`strong-momentum`): price above all four DMAs, with daily,
  weekly and monthly RSI each above its threshold.
- **Filter 2 · Volume + Momentum** (`volume-momentum`): a volume surge on a rising price that is
  holding its 20 DMA, with daily RSI firm and MACD bullish.

A condition is `{ key, label(t), test(v, t), live(v) }`: `label(t)` is the human rule with the
current threshold interpolated, `test(v, t)` is true only when it holds and **must be false, never
throw, on a null input**, and `live(v)` is a short string of the live value behind it, for the
tooltip.

### Thresholds and the gate

`THRESHOLD_DEFAULTS` holds the client's defaults (`rsiD1: 70, rsiW: 70, rsiM: 65, rsiD2: 50,
volMult: 1.5`); `THRESHOLD_FIELDS` describes each adjustable control (which filter it belongs to,
its min/max/step) and drives both the number inputs and the URL round-trip. `clampThresholds()`
keeps a pasted or bookmarked value within bounds.

`GATES` (`strong-momentum`, `volume-momentum`, `both`) is what the **Show** toggle switches
between; `passesGate(gate, v, thresholds)` decides membership, with `both` meaning Filter 1 ∩
Filter 2. The gate and every threshold live in the URL (params `mgate`, and `mrd1`/`mrw`/`mrm`/
`mrd2`/`mvm`), so a view is shareable and survives a reload; changing one re-filters instantly from
the cached daily data — **nothing re-fetches**.

## The UI — `renderMomentumScanner()`

In order down the page:

1. **Section head** — title, description, the live pill and the scope summary.
2. **Controls** (`momentumControls`) — the Show gate toggle and the threshold number inputs, which
   wrap cleanly on a phone. Committed on change (blur / Enter), not per keystroke.
3. **Stat strip** (`momentumStatStrip`, the kit's `statStrip`) — Scanned · Pass Filter 1 · Pass
   Filter 2 · Pass Both. The counts read straight off the pre-evaluated filter results, so they
   move with the quote and the thresholds; they describe **both** filters at once, which the
   gate-specific count line cannot. Card 4 is the gradient hero per the kit.
4. **Sector mini-bar** (`momentumSectorBar`) — a hand-built inline-SVG stacked bar of the current
   gate's passers by sector, with a legend and per-segment tooltips. **No chart library.** Segment
   colours walk the brand ramp (constant in both themes, like the hero gradient); the "Other"
   bucket uses the neutral token. It summarises the result set on screen; it never replaces or
   reorders the table, and it is absent when nothing passes.
5. **Count line** — "N of M evaluable stocks pass <gate>", plus the pending count and, off the
   universe scope, a hint to switch to Universe.
6. **The ranked table** (`scoreTable`) — the hero. Columns: Stock · Price · Filter 1 · Filter 2 ·
   Volume vs 10D Avg · RSI Daily · RSI Weekly · RSI Monthly · MACD · 20-DMA Status. Every condition
   pill carries the rule and the live figure in its tooltip. Sorting is on what the cell shows.
7. **How to read this** — the pill legend and a note that the figures are recomputed live.

The whole view re-paints on every live tick through the subscription `render()` already holds
(`liveOff = live.watch(() => paint(ctxRef))`), so the strip, the bar and the table never go stale
beside each other. The strip and bar are rebuilt each paint rather than patched.

### Empty and pending states

- **No passers at these thresholds** (data present): the table's own centred message reads
  "No stocks currently meet these conditions — try relaxing a threshold above." The controls, the
  strip and the search stay on screen so the reader can do exactly that.
- **All pending** (the daily file has no Step-1 fields): the table explains that the Data refresh
  has not run, and the strip reads `Scanned 0 · N pending data refresh`. Rows appear automatically
  once the refresh lands; nothing is invented in the meantime.

### Export

`runMomentumExport()` writes one row per visible company — identity, price, the quote source and
time, each filter's pass/fail, the live volume ratio and RSI/MACD/DMA readings, and the thresholds
in force — through the shared ExcelJS helper. A number that leaves the dashboard carries its
provenance (the threshold line) with it.

## Verification

Three checks, run in CI (`.github/workflows/verify.yml`):

- `scripts/verify-momentum-indicators.mjs` (contracts job) — the **data**: recompute the Step-1
  fields in `technicals.json` independently and assert the stored values match, with
  rounding-boundary tolerance on the DMA flags and the MACD line.
- `scripts/verify-momentum-scanner.mjs` (contracts job) — the **engine math**: `advanceWilderRsi`
  and `advanceMacd` match both the pipeline and a from-scratch EMA/MACD recompute to `1e-9`, and
  the filters pass/fail correctly on crafted rows, with null-field rows pending.
- `scripts/verify-momentum-scanner-ui.mjs` (browser job) — the **UI layout**: the stat strip, the
  sector mini-bar, the table columns, the gate toggle and threshold controls, the colourful pills,
  the empty state, and **no horizontal page overflow at 1440px and 390px**, with zero console
  errors.

Run the engine and UI checks locally with a static server on `:8080`
(`python3 -m http.server 8080 -d public`); the two contracts checks need no server.

---

## How to add the next filter

A new filter is **data plus wiring**, not new math — provided it tests fields `liveIndicators`
already computes. Do **not** change `advanceWilderRsi`, `advanceMacd`, `liveIndicators` or the data
pipeline to add a filter; those are verified and must stay byte-for-byte correct. If a filter needs
a brand-new indicator the stored state does not carry, that is a Step-1 data change first (a new
field in `technicals.json`, in `scrape-technicals.mjs`, asserted in `verify-momentum-indicators.mjs`,
and surfaced in `liveIndicators`) — a different, larger task.

### Worked example — "Filter 3 · Fresh Breakout"

Goal: a fresh bullish MACD crossover on the live candle, above the 50 DMA, with daily RSI firm —
all from fields the engine already exposes (`freshCross`, `above50dma`, `rsiDaily`), plus one new
threshold.

**1. Define the filter and its threshold — `public/js/scoring/momentum-live.js`.**

Add the new threshold's default:

```js
export const THRESHOLD_DEFAULTS = Object.freeze({ rsiD1: 70, rsiW: 70, rsiM: 65, rsiD2: 50, volMult: 1.5, rsiD3: 55 });
```

Add its adjustable field (this alone makes the number input appear — the controls are generated
from `THRESHOLD_FIELDS`):

```js
{ key: 'rsiD3', filter: 'fresh-breakout', label: 'RSI daily >', min: 0, max: 100, step: 1 },
```

Add the filter to `MOMENTUM_FILTERS`:

```js
'fresh-breakout': {
  id: 'fresh-breakout',
  label: 'Fresh Breakout',
  short: 'Filter 3',
  description: 'A fresh bullish MACD crossover on the live candle, above the 50 DMA, with daily RSI firm.',
  conditions: [
    { key: 'cross',  label: () => 'Fresh MACD bullish crossover', test: (v) => v.freshCross === true, live: (v) => (v.macdBullish == null ? '—' : v.freshCross ? 'fresh cross' : v.macdBullish ? 'already bullish' : 'bearish') },
    { key: 'above50', label: () => 'Price > 50 DMA',             test: (v) => v.above50dma === true,  live: (v) => (v.sma50 == null ? '—' : `50DMA ${v.sma50.toFixed(0)}`) },
    { key: 'rsiD',    label: (t) => `RSI daily > ${t.rsiD3}`,     test: (v, t) => v.rsiDaily != null && v.rsiDaily > t.rsiD3, live: (v) => `RSI(D) ${v.rsiDaily == null ? '—' : v.rsiDaily.toFixed(1)}` },
  ],
},
```

Make it selectable in the Show toggle, and give `passesGate` its branch:

```js
export const GATES = Object.freeze(['strong-momentum', 'volume-momentum', 'fresh-breakout', 'both']);
// inside passesGate, before the final return:
if (gate === 'fresh-breakout') return evaluateFilter('fresh-breakout', v, thresholds).pass;
```

Every condition's `test` must return `false` — never throw — on a null input, and `label`/`live`
must tolerate a null. That is the contract the pending rows rely on.

**2. Wire it into the view — `public/js/tabs/breakouts.js`.**

Map the new threshold to a short URL param (namespaced so it cannot collide with the other
sub-views):

```js
const MTHRESH_PARAM = { rsiD1: 'mrd1', rsiW: 'mrw', rsiM: 'mrm', rsiD2: 'mrd2', volMult: 'mvm', rsiD3: 'mrd3' };
```

Pre-evaluate it per row, beside `f1`/`f2`, in `momentumLiveFor`:

```js
v.f3 = momentum.evaluateFilter('fresh-breakout', v, thresholds);
```

Add its gate button in `momentumControls` (the `gates` array), and its table column (beside the
other two filter pills) in `renderMomentumScanner`:

```js
col('Filter 3', (v) => filterPill(v.f3), (v) => (v.f3.pass ? 1 : 0)),
```

Add it to the export in `runMomentumExport` (an F3 pass/fail column, and `rsiD3` in the thresholds
line). The sector bar and the count line need no change — they read the gate's `passers`, which
`passesGate` now covers.

A note on the **stat strip**: `statStrip` is a 4-up row (Scanned · Filter 1 · Filter 2 · Pass
Both). A third filter means deciding what the four cards show — e.g. Scanned · F1 · F2 · F3 with F3
as the hero, or keeping Pass Both and surfacing F3's count only in its column and the gate. Pick the
four that answer the reader's first question; do not grow the strip past four without rethinking it.

**3. Test it — `scripts/verify-momentum-scanner.mjs`.**

Add a crafted row that should pass Filter 3 and one that should fail each condition, and assert
`evaluateFilter('fresh-breakout', …)` and `passesGate('fresh-breakout', …)` agree. Test the policy
on fixtures — a fresh cross, a standing cross and a null-MACD row are properties you construct, not
ones today's capture is guaranteed to contain. Then re-run the UI check so the new column and gate
are asserted present and the layout still fits at 1440px and 390px.

**4. Housekeeping.** Bump `RELEASE_CACHE_KEY` in `public/sw.js`. Only regenerate
`public/css/tailwind.css` if the markup introduced a utility class not already compiled (the CLI is
in CLAUDE.md); the filter above adds none.
