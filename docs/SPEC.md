# Sattva Central Research — Product Spec

An Indian-equities research and portfolio analytics dashboard. Static site, no build step,
no framework, no npm dependencies for the app itself. Hosted as a Cloudflare Worker that
serves `public/` and (later) a few `/api/*` routes.

---

## 1. Navigation model

Three levels, so nothing important is ever more than two clicks away and the user never has
to scroll to find a section.

### (a) Workspace — no switcher in the chrome

Only Research Central is offered, so there is nothing to pick; the control is gone from the
header. Portfolio Analytics still routes by URL (`WORKSPACES` marks it `hidden: true`).

| Workspace | id | Default |
| --- | --- | --- |
| Research Central | `research` | ✅ |
| Portfolio Analytics | `portfolio` | |

### (b) Section — top tabs

A springy indigo→purple underline scales in under the active tab; active tab in indigo,
inactive slate with hover. Order is fixed:

**Research Central**
1. Daily Alerts *(the default landing tab)*
2. Earnings Hub
3. Con-call
4. Public Chatter
5. Breakouts / Technical
6. Super Investors
7. News
8. Corp Announcements
9. Insider Trades

**Portfolio Analytics**
1. Overview
2. Position By
3. Transaction History
4. Drawdown

### (c) Sub-view — one dropdown, at every width

A styled dropdown button (custom menu, not a bare `<select>`) above the content, kickered
*View*, showing the current sub-view and a chevron. There is no left rail: the content column
spans the full 1400px on every tab.

| Tab | Sub-views |
| --- | --- |
| Daily Alerts | *(none — one stream, so the picker is hidden)* |
| Earnings Hub | *(none — one table, so the picker is hidden)* |
| Con-call | *(no sub-views)* — one live scan table, with the schedule behind an **Upcoming Concalls** overlay |
| Public Chatter | *(no sub-views)* — one live table of covered companies, then everything the feed carried that we do not cover |
| Breakouts / Technical | Strong Breakouts *(default)* · Technical Scanner · FII Accumulation · Earnings Surprise |
| Super Investors | Superstar Investors · Institutions |
| News · Corp Announcements · Insider Trades | *(no sub-views)* — one table each, off the shared filings renderer |
| Overview | Positions · Allocation |
| Position By | Sector · Market Cap · Conviction |
| Transaction History | All · Buys · Sells |
| Drawdown | Portfolio · Per Position |

Portfolio Analytics' four tabs are built and still route by URL, but the workspace switcher has been
removed from the chrome, so Research Central's tabs are the whole navigation for now.

**Daily Alerts is first, and first is the default.** The shell falls back to `ws.tabs[0]` for an
unknown or absent tab, so the order of the `WORKSPACES` array *is* the landing page — there is no
second place recording it that could disagree with the array.

The picker is the same control at every width. It used to be a 240px left rail above 1024px and
a dropdown below it — the rail cost the content 240px of its 1400px, permanently, to show at most
four short labels, while the tables beside it are the widest things in this dashboard and were
scrolling inside their own containers to fit what was left. Measured on removal: Breakouts goes
from a 248px inner scroll to **none**, Super Investors 380px → 116px, Portfolio Overview
453px → 189px.

A tab with `subviews: []` renders no picker at all.

---

## 1b. The header

Brand, the scope toggle, one status pill and a refresh button — nothing else.

- **One status pill**, `● Live · updated 4m ago`, on the last tick of a poller that actually
  reached a server. It replaced a green "Live · just now" chip and a white "Updated 52 minutes
  ago" chip, which claimed different things about the same subject; the green one tracked a
  heartbeat that asks nothing of any server, so it read "just now" regardless.
- **Clicking the pill opens the data-sources modal.** There is no separate Sources button; the
  provenance it opened has to stay reachable from every screen, and a freshness control is its
  natural home.
- **A refresh button** re-checks every live feed on demand and reports what it found — "Up to
  date" or "3 new" — rather than spinning and vanishing.
- **No global search box.** A company is reached from its own tab's table.

## 1c. Live alerts

New data announces itself in the lower-right corner: a company filing a result, a con-call gaining
its StockScans analysis, or a book holding appearing in the retail-chatter feed for the first time.
The alerts fire whatever tab is open, because those feeds are watched app-wide rather than only
while their tab is mounted.

Chatter alerts are limited to book holdings, unlike the other two. The feed carries brokers and
themes as well as companies, and a stack of "Guggenheim was mentioned" cards would teach the reader
to dismiss the component — results alerts included.

They never announce the same event twice, they cap the visible stack, they sit **behind** the drill
panel, the workspace and modals, and they inherit the tables' honesty rules — a swing across zero
is described in words rather than as a percentage that does not exist, and a con-call awaiting
analysis says so rather than showing a score of nil.

---

## 2. Global scope toggle — Portfolio · Watchlist · Universe

A segmented control in the header (right side, before the Live pill). It is **global**: it
applies to every tab in both workspaces.

**Three scopes, in priority order, widest last.** That order reads left to right as *mine, watched,
everything*, and **Portfolio is the default** — the first question on opening a dashboard about your
own money is what your own money did, and "every listed company" is the widest possible answer to
that. The vocabulary lives in one place, `js/data/scope.js`; `state.js` and `router.js` import it
rather than repeating the string pair, so a fourth scope is a change in one file.

- Stored as `state.scope` (`"portfolio" | "watchlist" | "universe"`), persisted to `localStorage`,
  and carried in the URL as `?scope=`. An unrecognised value in a shared link falls back to the
  reader's own saved scope rather than silently redefining what is on screen.
- Every tab module reads `ctx.scope` and must visibly reflect it — the scope chip in each
  panel header states which scope is active and how many rows it covers.
- **Portfolio means the book**: `public/data/portfolio-companies.json`, the family office's
  142-company direct-equity statement, read through `js/data/coverage.js`. The universe is
  `public/data/universe.json`. `portfolio.json` is the *ledger* — twelve positions with quantities
  and costs — and drives Portfolio Analytics only; the scope filter does not read it.
- **The chip states the denominator, because no feed covers the whole book** — *"Portfolio · 96 of
  142 reported"*. Nineteen lines carry no NSE symbol (unlisted, warrants, the Vedanta demerger
  entities, BSE-only, unresolved); they are kept with a stated reason and shown as held-but-not-
  covered rather than dropped.
- **Watchlist means the companies the reader starred**, read through `js/core/watchlist.js`. The
  star in every `scoreTable` marks a **company**, not a row: `key(row)` identifies the row and
  `watchKey(row)` the company, and the two are allowed to differ, so three announcements from one
  filer are three rows and one watched company and starring any of them fills the star on all three.
  Entries are `{ ticker, name, addedAt }`, so a watched company can be named even where the feed in
  front of you does not carry it.
- **An empty watchlist is answered by the shell, once, for every tab** — `watchlistEmptyPanel()`,
  saying there are zero watchlist companies and how to add one. A table reading *"no results match
  your filters"* over a list nobody has added to would send the reader hunting for a filter to clear.
  The shell decides teardown against what it will actually mount, so the un-mounted tab is destroyed
  rather than left painting into the content host.
- A row with no company carries **no star at all** rather than one that files a row id, or a company
  name, as though it were a symbol: Superstar Investors (whose upstream discloses names and no
  symbols) and Public Chatter's unresolved half both opt out.
- Changing scope never loses the current tab or sub-view.

---

## 3. Routing

Hash-based and shareable:

```
#/<workspace>/<tab>/<subview>?scope=<portfolio|watchlist|universe>
#/research/breakouts/strong-breakouts?scope=portfolio
```

- Unknown workspace / tab / sub-view falls back to the first valid option at that level;
  a completely unknown route lands on `#/research/daily-alerts`.
- With no hash present, the last route is restored from `localStorage`.
- Browser back/forward work; scope changes and route normalisation use `replaceState` so they
  don't pollute history.
- A tab may add its own query params for filter state (`?bo=strong&vol=1.5`), which makes a
  filtered view shareable. The shell preserves them across a scope change and clears them when
  the tab or sub-view changes; `ctx.setParams()` writes them without a history entry.

---

## 4. Header — the detail

Sticky, full-width, on a glass/blur background. See §1b for what it carries and why; this is the
layout.

- **Left** — 48px rounded-xl indigo→purple→pink gradient mark reading "SC", then
  "Sattva Central Research" (`font-display`, extrabold) with a workspace-aware subtitle.
- **Right** — the Portfolio/Universe segmented toggle, then the status pill (pulsing dot,
  `Live · updated <relative time>`, opens the data-sources modal on click), then the refresh
  button.
- **Centre** — nothing. The global search box, the separate Sources button and the second
  "Updated …" chip were removed; the middle of the header is deliberately empty so the brand and
  the two live controls are the only things competing for attention.

Live alerts are **not** in the header — they are a stack in the lower-right corner, so an arriving
result never reflows the chrome or shifts what the reader is pointing at. See §1c.

---

## 5. Design system

Aligned to the LKP Stock Screener's visual language. Tokens live in `:root` in
`public/index.html`.

**Brand ramp: indigo → purple → pink.** Emerald / amber / rose are reserved strictly for
semantic rule states (pass / partial / fail) and are never used as brand colours.

| Token | Value | Use |
| --- | --- | --- |
| `--brand-500` | `#6366f1` | indigo, brand ramp start |
| `--brand-600` | `#4f46e5` | indigo-600, links and actions |
| `--brand-mid` | `#a855f7` | purple, brand ramp middle |
| `--brand-end` | `#ec4899` | pink, brand ramp end |
| `--accent-600` | `#4f46e5` | accent for links/actions |
| `--positive` | `#059669` | emerald — pass |
| `--caution` | `#d97706` | amber — partial |
| `--negative` | `#e11d48` | rose — fail |
| `--hard-fail` | `#be123c` | rose-700 — hard fail |
| `--neutral` | `#64748b` | slate — n/a |
| `--page-bg` | `#f8fafc` | page background |

- Page background carries three radial gradients, all ≤ 12% opacity: violet top-left, pink
  top-right, sky bottom-right.
- Surfaces: white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Content column is `max-w-[1400px] mx-auto px-6`.
- Top-tab indicator: a 3px indigo→purple bar that scales in with a springy
  `cubic-bezier(0.34, 1.56, 0.64, 1)` transition.
- `font-variant-numeric: tabular-nums` on every number-bearing cell.
- Light theme only. Fully responsive; tables scroll horizontally inside their own container so
  the page body never scrolls sideways.
- Fonts: Inter (400–800) for body, Plus Jakarta Sans (600–800) for headings via `.font-display`.

### The screener kit (`public/js/ui/screener.js`, `visual.js`)

Every tab is assembled from five components rather than hand-rolled:

- `statStrip(cards)` — 4-up KPI row; card 4 is always the gradient freshness hero. Cards may
  carry a `?` help modal explaining the metric.
- `topCards({ title, items, valueFormat, onSelect })` — the Top-10 hero grid, click-through to
  the drill panel. `valueFormat` is `'score'` (value/max, tier-coloured) or `'metric'`.
- `scoreTable(config)` — search, filter select, watchlist, sortable sticky head, export,
  optional Score and Signals columns, row click-through.
- `openDrill(config)` — right-slide detail panel with grouped rule/detail cards.
- `openModal(html, { size })` — centred modal.

Plus `sectionHead`, `pendingPanel`, and the shared visual vocabulary in
`visual.js`: `avatarFor`, `scoreTier`, `scoreBadgeClass`, `tierLabel`, `tierColor`,
`statusPill`, `signalDots`, `legendStrip`.

Chrome primitives (tab bar, scope toggle, search, live badge) remain in
`public/js/ui/components.js`.

### Honesty rules

Presentation must never imply data the dashboard does not have:

1. No fabricated numbers to fill a component — an un-landed feed gets `pendingPanel()` and no
   ranking grid.
2. Signal dots are direct readings of reported figures, not modelled judgements. A
   points-based score only appears once its model exists and is documented.
3. Derived figures say they are derived, and say how.
4. Help modals state what is mock, what is live, and which prompt wires it.

### The Sources modal

The header's "Sources" button opens a modal generated from `public/js/ui/sources.js`, listing
every source grouped by the tabs it serves, with what it feeds, its refresh cadence, a link,
and an honest status (`live` / `static` / `mock` / `pending`). Adding a data source means updating
`docs/DATA-CONTRACTS.md`, `js/app.js` and `sources.js` together.

---

## 6. Live update engine (`public/js/core/live.js`)

A small pub/sub polling store so tabs just subscribe.

```js
live.register(id, { intervalMs, fetcher });
live.subscribe(id, cb);   // returns an unsubscribe fn
live.unsubscribe(id, cb);
live.start(id);           // call from render()
live.stop(id);            // call from destroy()
live.onGlobalTick(cb);    // header Live pill
```

- Pollers run only while their tab is mounted **and** the document is visible; they pause on
  `visibilitychange` and refetch immediately on return.
- Exponential backoff on error, capped at 60s. Errors never throw into the UI — the last good
  data stays on screen.
- `mockFetcher(path)` reads a static JSON file and jitters numbers slightly so liveness is
  visible in development. `realFetcher(url)` has the same signature, so swapping a tab to a
  real endpoint is a one-line change at the call site.

---

## 7. Tabs and planned features

### Earnings Hub — `earnings-hub` (LIVE, single view)
One table: every company that has reported this quarter, newest first. Ten columns —
`Date · Company · Rev cur · Rev prior · Rev % · PAT cur · PAT prior · PAT % · MCap · Basis` —
because a growth percentage without the two figures it came from hides both the scale and the
sign. Ticker and industry sit on the second line of the company cell; gross profit stays in the
feed and the Excel export but is not a column. A YoY/QoQ toggle repoints the comparison, and a
second dropdown filters consolidated vs standalone. Rows are not clickable — there is no drill,
because the figures it held are now columns. Live off Moneycontrol Rapid Results, polled every
30s.

A second view, **Earnings Calendar**, answers the opposite question: who is *scheduled* to report.
A date strip carries the complete count per date; the table names the 20 largest by market cap for
the selected date, because that is all Moneycontrol publishes — and says so under itself.
- Auto-parsed result PDFs (revenue, PAT, margin extraction)
- Beat/miss scoring vs Street estimates
- Segment-wise revenue break-up
- Quality & growth composite score (ROE, ROCE, consistency)
- Saved scans and custom result alerts
- Historical per-company result trend charts

### Con-call — `concall`
One screen, live off StockScans: every earnings call held this quarter with their result score,
sentiment tier and highlight bullets, reproduced unchanged and attributed. The schedule of calls
not yet held sits behind an **Upcoming Concalls** button that opens an overlay grouped by date.

Four sub-views that ran on a synthetic transcript corpus — Live Feed, Keyword Scan, Catalysts and
Deep Dive — were removed rather than kept behind a ribbon; see `docs/HANDOFF.md` §5c.
- Live transcript ingestion from BSE's filed transcript PDFs — the prerequisite for everything below
- Custom keyword sets scanned against real transcript text
- Sentiment scoring per management commentary line
- Catalyst tagging (guidance raise/cut, capex, M&A)
- Deep Dive: full transcript + quarter-over-quarter diff
- Management tone/consistency scoring over time

### Public Chatter — `public-chatter`
Community sentiment.
- Real-time ValuePickr thread crawler with dedup
- Telegram channel ingestion via bot API
- NLP sentiment scoring per post
- Ticker-level chatter velocity alerts
- Spam / promotional post filtering
- Cross-source mention aggregation

### Breakouts / Technical — `breakouts`
Technical scans across coverage. **This is the one genuinely live feed — shipped in prompt 3.**

Sixteen rules, 24 points, five categories, scored by `js/scoring/tech-scoring.js` from a daily
Yahoo Finance EOD scrape of the NSE 500 plus NSE bhavcopy delivery data. A close below the
200 DMA is the model's only hard fail.

| Category | Rules (points) |
| --- | --- |
| Trend Strength | Price Above 50 EMA (2) · Price Above 200 DMA (2, **hard fail** below) · Golden Cross (1) · Higher Highs–Higher Lows (1) |
| Momentum | RSI 14 (2) · MACD (2) · ADX 14 (1) · Relative Strength vs Nifty 500 (2) |
| Volume | Volume Breakout (2) · Delivery Percentage (1) · Institutional Activity (1) |
| Breakout | 52-Week High Proximity (2) · Breakout from Consolidation (2) · Base Formation (1) |
| Risk | Beta (1) · ATR Stability (1) |

No sub-view here carries a stat strip: the two or three counts and the gradient freshness hero
became one small **Live** pill in the section head, whose modal carries the capture time, the
source and every figure the cards printed. The pill is green only while the capture is inside the
schedule's worst case (72 hours — Friday's capture is still current on Monday); past that it is
amber and prints the age, and on Earnings Surprise it is amber regardless, reading *Mock earnings ·
live technicals*.

Sub-views: **Strong Breakouts** (6-week base breakouts, URL-reflected filter chips) — first in the
picker and so the view the tab opens on — then **Technical Scanner** (the full scored universe),
**FII Accumulation** (shareholding changes joined to the score), **Earnings Surprise** (mock
earnings beside the live score, deliberately not blended).

Every Strong Breakouts filter group leads with **All** and defaults to it, so the sub-view opens on
the widest answer it can give. The trend filter used to ship on *Above 200 DMA only*, which meant a
breakout below the primary trend line was absent from a table that gave no sign it was withholding
anything; it is now one click away instead of the default. **All** under Breakout strength is every
breakout grade — a company whose base has not broken out is not a fourth grade, and the line under
the chips prints the matched count over every company with a detectable base.

Still to come — this list is now the only place the gap is recorded, since the dashed *Wiring
roadmap* card that used to close each tab has been removed from the UI:
- Intraday refresh via the live-quote endpoint
- Sector-relative strength ranking
- Saved scans and threshold alerts
- Historical score trend per company
- TradingView indicator overlay (`technicals-source.json`)

### Super Investors — `super-investors`
Superstar holdings and institutional ownership.

**Superstar Investors has two in-page tabs.** *All Investors* opens first with the investor cards
and the full holdings table. *Quarterly Changes* holds the cross-book roll-up, so a reader can see
companies bought or sold down by more than one tracked investor, new entrants, the largest
increases and reductions, and the positions no longer disclosed without opening ninety books one
at a time. The chosen in-page tab survives scope changes and live-data repaints until the reader
leaves Super Investors.

Increases and reductions are in **percentage points of the company** — the only size a filing
states. A new or exited position carries **no size at all**, because a position appearing or
vanishing is a change of disclosure rather than a move of the whole holding, and "exited" is
always worded *no longer disclosed*. "Bought by more than one investor" is a **count of who
moved**, never a signal or a score. See *Rolling ninety books up into one screen* in `CLAUDE.md`.

Still to come — this list is now the only place the gap is recorded, since the dashed *Wiring
roadmap* card that used to close each tab has been removed from the UI:
- AMFI + Trendlyne mutual fund flow overlay
- Investor conviction scoring vs position size
- Cross-investor overlap heatmap

### Overview — `overview`
Sub-views: **Positions · Allocation · Realised P&L**
- Live mark-to-market from the technicals feed; a position missing from it is marked *at cost*, tagged, and excluded from the curve — never marked at zero
- FIFO cost basis with charges folded in, and the open-lot table in every position drill
- A reconciliation strip showing the measured residual of both identities, not a claim that they hold
- Realised P&L as one row per FIFO lot match, each with its own buy date, holding period and short/long term
- Allocation by sector and conviction, plus a top-5 concentration bar
- *Not built:* broker import, target weights and drift alerts, tax-lot harvesting, intraday marks

### Position By — `position-by`
Sub-views: **By Sector · By Conviction · By Holding Period · By P&L Band**
- One grouping engine, four keys; each cut carries the aggregate that cut is actually about
- Holding period groups **lots, not positions** — a position built over three years sits in several bands at once, and the tax term follows the lot consumed
- Stacked weight bar, per-group drill, and an expandable ungrouped table showing the working
- *Not built:* market-cap/factor buckets, target-vs-actual weights, group-level benchmarking

### Transaction History — `transactions`
Sub-views: **Trades · Dividends & Actions · Import / Export**
- Every sell expands to the lots it consumed, with charges apportioned across them
- Dividends tracked as income, never folded into the cost basis
- Bonus/split adjust lots in place — quantity multiplied, cost per share divided, acquisition date preserved
- CSV import parses in-browser, previews, trial-replays, and names every rejected row with its line and reason; an applied import is **session-only** and says so, because a static site has no server to write the file
- *Not built:* contract-note parsing, server-side persistence, duplicate detection

### Drawdown — `drawdown`
Sub-views: **Equity Curve · Underwater Plot · Drawdown Episodes**
- Curve from real closes, with the cash line separated and the y-axis anchored at zero
- **Two** drawdowns — total portfolio and holdings-only — because retained cash dampens one and not the other
- **XIRR and TWR**, labelled money-weighted and time-weighted; only TWR is shown against the Nifty 500
- Every peak-to-trough episode with decline and recovery durations; an open drawdown reports "ongoing" rather than being closed at the last day
- Coverage is stated: excluded tickers are named, never silently dropped
- *Not built:* rolling volatility/Sharpe, per-position drawdown contribution, custom windowing

---

## 8. Roadmap

| # | Prompt | Scope |
| --- | --- | --- |
| 1 | Foundation + shell | File layout, nav model, scope toggle, routing, design system, UI primitives, live engine, mock data, placeholder panels, docs. ✅ *this prompt* |
| 2 | Technicals/breakouts data pipeline | Live Yahoo Finance EOD across NSE 500, Node 22 scripts in `scripts/`, GitHub Actions refresh, produces `public/data/technicals.json`. ✅ |
| 3 | Breakouts / Technical tab UI | 16-rule scoring model, four live sub-views, drill panel with per-rule provenance, Excel export. ✅ |
| 4 | Earnings Hub | 15-rule / 21-point Result Quality & Growth model, three sub-views (Latest Results, Result Scans, Quality & Growth), 8 built-in scans + a custom scan builder, drill panel with 8-quarter series and per-rule provenance, two-sheet Excel export. Earnings data is **synthetic but real-shaped** — generated by `scripts/gen-mock-earnings.mjs` and labelled as illustrative on every surface; wiring the real filings feed is a three-file change documented in `docs/DATA-CONTRACTS.md`. ✅ |
| 5 | Con-call + Deep Dive | Runtime keyword engine (scans transcript text in the browser — no stored counts), a full keyword-set editor persisted to localStorage, a 5s live-call ticker, a companies × keywords matrix with quarter-on-quarter deltas, catalyst tracking, and the six-view Deep Dive in a new full-screen `openWorkspace` overlay. Transcripts are **synthetic but real-shaped** — and unlike the earnings set, every person and brokerage named in them is fictional. ✅ |
| 6 | Public Chatter + Super Investors | Chatter: forum threads with claim extraction, Telegram groups with a transparent 0–3 pump-risk heuristic, and a cross-source Trending view joined to the **real** technicals feed with a chatter-vs-price quadrant. Investors: investor-first cards, a four-view per-investor workspace, a mandate view for funds, FII/DII and MF category flow charts, and an overlap heatmap. Both data sets are **synthetic** — and the investor names are **real people**, so their positions carry an attribution ribbon on every surface and the data set holds numbers only, never a quote or rationale. ✅ |
| 7 | Portfolio Analytics + polish and QA | A FIFO lot engine (`js/portfolio/lots.js`) replaying the ledger into open lots and realised rows with per-lot holding periods and tax terms; positions marked to market from the **live** technicals feed; an equity curve, two drawdown series and a Nifty 500 comparison built from **735 trading days of real Yahoo closes** (`scripts/scrape-portfolio-history.mjs`); XIRR *and* time-weighted return, because only one of them is comparable to an index; four sub-views over four cuts each; CSV import with preview-and-reject; and a QA pass covering error states, a11y focus traps, `scope="col"` on every header, and ~190 assertions in `scripts/verify-ui.mjs` including both reconciliation identities and an independent max-drawdown recompute. The ledger is **synthetic**; every price in it is real. ✅ |

---

## 9. Module interface contract

Every tab and portfolio module exports exactly this, so the shell stays generic:

```js
export const meta = { id, title, subtitle, subviews: [{ id, label, badge? }] };
export function render(ctx);   // ctx = { scope, subview, root, live, data }
export function destroy();     // detach listeners/pollers; called on nav away
```

`ctx.root` is the content host element, already emptied by the previous tab's teardown.
`ctx.data` is the fully-loaded data set (see `docs/DATA-CONTRACTS.md`).
`ctx.live` is the live engine module.
