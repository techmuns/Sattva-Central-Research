# Sattva Central Research — Product Spec

An Indian-equities research dashboard. Static runtime, no bundler,
no framework, no npm dependencies for the app itself. Tailwind is precompiled into a committed
same-origin stylesheet, so deployment still serves `public/` directly. Hosted as a Cloudflare
Worker that serves those assets and the live `/api/*` routes.

---

## 1. Navigation model

Three levels, so nothing important is ever more than two clicks away and the user never has
to scroll to find a section.

### (a) Workspace — one, and no switcher

Research Central is the only workspace, so there is nothing to pick and the control is gone from
the header.

| Workspace | id | Default |
| --- | --- | --- |
| Research Central | `research` | ✅ |

**Portfolio Analytics is deleted.** It was four modules over an illustrative ledger, kept
`hidden: true` — routable but not clickable — which is precisely what trapped a reader who
followed an Ask Research citation into it: with no switcher, nothing on the page led back, and
inside the host iframe there is no address bar. An unknown workspace now falls through to Research
Central and the URL is corrected. **Portfolio here means the book of company names and nothing
else.** The modules and the mock ledger are in git history at `d3bba30`.

### (b) Section — top tabs

A springy indigo→purple underline scales in under the active tab; active tab in indigo,
inactive slate with hover. Order is fixed:

**Research Central**
1. Ask Research *(the default landing tab)*
2. AI Alerts
3. All Alerts
4. Earnings Hub
5. Con-call
6. Public Chatter
7. Breakouts / Technical
8. Super Investors
9. News
10. Corp Announcements
11. NSE Filings
12. Insider Trades

### (c) Sub-view — one dropdown, at every width

A styled dropdown button (custom menu, not a bare `<select>`) above the content, kickered
*View*, showing the current sub-view and a chevron. There is no left rail: the content column
spans the full 1400px on every tab.

| Tab | Sub-views |
| --- | --- |
| AI Alerts | *(none — one ranked queue, so the picker is hidden)* |
| All Alerts | *(none — one stream, so the picker is hidden)* |
| Ask Research | *(none — one conversation workspace, so the picker is hidden)* |
| Earnings Hub | *(none — one table, so the picker is hidden)* |
| Con-call | *(no sub-views)* — one scan table, with no schedule or feed-status chips above it |
| Public Chatter | *(no shell sub-views)* — in-page **Coverage** and **Not in coverage** tabs, one table at a time |
| Breakouts / Technical | Strong Breakouts *(default)* · Technical Scanner · FII Accumulation · Earnings Surprise |
| Super Investors | Superstar Investors · Institutions |
| News · Corp Announcements · NSE Filings · Insider Trades | *(no sub-views)* — one table each, off the shared filings renderer |

Only Breakouts and Super Investors have sub-views; every other tab hides the picker entirely.

**Ask Research is first, and first is the default.** The shell falls back to `ws.tabs[0]` for an
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
- **The status pill is passive.** It reports freshness without opening a provenance or delivery
  explainer. Detailed source metadata remains in the source registry for audits and exports.
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
applies to every tab.

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
  142-company listed direct-equity book, synced from `techmuns/Sattva-Family` one line per equity
  ISIN and read through `js/data/coverage.js`. Names and sectors only — **no quantity, no cost, no
  valuation**, and this is the only portfolio data the dashboard holds. The universe is
  `public/data/universe.json`.
- The pencil beside the segmented control edits whichever scope is active. Portfolio and Universe
  keep device-local additions and exclusions over those committed defaults; Watchlist edits the
  same company list as the stars in the tables. The search box calls the Worker, which adds the
  Muns credential server-side and returns Indian company names and NSE tickers. A Portfolio-scope
  edit changes research filters and denominators only; there is no ledger for it to touch.
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
  saying there are zero watchlist companies and offering **Add companies to watchlist**, which opens
  the same Watchlist editor as the header pencil without leaving the current tab or scope. A table
  reading *"no results match your filters"* over a list nobody has added to would send the reader
  hunting for a filter to clear.
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
  a completely unknown route lands on `#/research/ask-research`.
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
- **Right** — the Portfolio/Universe segmented toggle, then the passive status pill (pulsing dot,
  `Live · updated <relative time>`), then the refresh button.
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

### Source registry

`public/js/ui/sources.js` remains the canonical source registry, listing every source grouped by
the tabs it serves, with what it feeds, its refresh cadence, a link, and an honest status
(`live` / `static` / `mock` / `pending`). The registry is data for audits and export disclosures;
passive status labels do not open it in a popup. Adding a data source means updating
`docs/DATA-CONTRACTS.md`, `js/app.js` and `sources.js` together.

X/Twitter accounts appear in that registry as their own family, one row per monitored account with
the type **Twitter / X**, generated from `js/core/twitter-handles.js` rather than written down. The
family carries an **Edit Twitter Sources** control that opens `js/ui/twitter-sources.js` — add a
handle, see what is monitored, remove one, and nothing else. Their posts join the existing News list
rather than getting a view of their own; see `docs/DATA-CONTRACTS.md`.

`public/js/ui/source-beacon.js` renders that registry as the **source beacon** in the lower-left
corner: a small launcher opening a popover with every source as one vertical column beside a
diagram of them converging on a single Sattva square, one wire per source family. It is a view of
the registry and adds nothing to it — a new entry in `sources.js` appears there with no further
wiring. It does not reintroduce the header Sources button, whose removal stands; every count in it
is derived from the registry on each open, and its green pill counts wired feeds rather than
asserting that any one figure was confirmed just now.

---

## 6. Live update engine (`public/js/core/live.js`)

A small pub/sub polling store so tabs just subscribe.

```js
live.register(id, { intervalMs, fetcher });
live.subscribe(id, cb);   // returns an unsubscribe fn
live.unsubscribe(id, cb);
live.start(id);           // call from render(); immediate only when no freshness is known
live.start(id, { fresh: true }); // the module just completed its own initial load
live.stop(id);            // call from destroy()
live.onGlobalTick(cb);    // header Live pill
```

- Pollers run only while their tab is mounted **and** the document is visible. A tab switch or a
  brief `visibilitychange` resumes the remaining success/backoff cadence; only an actually overdue
  source refetches immediately.
- Exponential backoff on error, capped at 60s. Errors never throw into the UI — the last good
  data stays on screen.
- `mockFetcher(path)` reads a static JSON file and jitters numbers slightly so liveness is
  visible in development. `realFetcher(url)` has the same signature, so swapping a tab to a
  real endpoint is a one-line change at the call site.

---

## 7. Tabs and planned features

### Ask Research — `ask-research` (server-configured, single view)
A two-column conversation workspace and the default landing tab. Every question builds a bounded
runtime packet through the canonical data modules behind the other Research Central tabs.
**Every source is a tab the reader can open** — the mock ledger used to be the fifteenth and cited
itself as *Portfolio Analytics*, linking into a hidden workspace with no way back; both are
deleted, and `verify-research.mjs` now requires every source's route to start `#/research/`.
Every registered source contributes its status, coverage,
as-of metadata and provenance; question-matched rows are included within the Worker request bound,
so one slow or unavailable feed is reported rather than silently omitted.

The Worker sends the packet to Muns' `/query-router` with `llm_type: local_llm` and `stream: true`
for the shortest first-token delay. Operators can explicitly select `hosted_llm` with
`MUNS_LLM_TYPE` when answer quality matters more than latency.
It forwards each upstream NDJSON text chunk immediately, while the answer cites material dashboard
claims by page. A Muns session token is a Worker secret; the browser never receives it, and the paid
route is same-origin, size-bounded and rate-limited. Conversation history stays in device
`localStorage`; the provider has no web-search contract, so the workspace makes no web-research
claim or control. An answer in flight is not tied to the tab being on screen: leaving Ask Research
lets it finish, saves it to the conversation and announces it in the alert stack, while a scope or
scope-membership change still cancels it so an answer cannot land under a scope it was not built
for. Unsent drafts persist; a question interrupted by a reload is returned to the composer and never
re-sent automatically. Every source retains status, coverage and provenance inside a 13,000-character
evidence budget measured on what the model receives; the skeleton may take at most 60% of it, and
the rest is spent on rows — the companies the question names first, from every source that carries
them — so the request stays within the local model's 8K-token context. UI-only routes and the
duplicate catalog are omitted from the model prompt, but remain in the browser for source chips.
The dashboard's own AI Alerts ranking is one of the fourteen sources, so a question about the
strongest evidence across tabs is answered by the same deterministic model the tab shows.

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
A date strip carries the complete all-exchange count per date; the table follows every 20-row page
published by Moneycontrol for the selected date. Past dates remain schedules here; filed results
remain in **Earnings Reported**.
- Auto-parsed result PDFs (revenue, PAT, margin extraction)
- Beat/miss scoring vs Street estimates
- Segment-wise revenue break-up
- Quality & growth composite score (ROE, ROCE, consistency)
- Saved scans and custom result alerts
- Historical per-company result trend charts

### Con-call — `concall`
One screen, live off StockScans: every earnings call held this quarter with their result score,
sentiment tier and highlight bullets, reproduced unchanged and attributed. The section heading has
no Upcoming Concalls or Live/call-count chips; the table is the view.

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
- Simple in-page tabs: **Coverage** (default) and **Not in coverage**, each owning its table and its own sentiment selector
- Clicking a company or its mention count opens the underlying mentions, newest first, with a direct link to every source item
- No summary-card row; coverage, posts, market mood and scrape timing appear as footnotes below the tables
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
became one small passive **Live** pill in the section head. The pill is green only while the capture is inside the
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

**Superstar Investors has three in-page tabs.** *All Investors* opens first with only the investor
cards. *Quarterly Changes* follows with the cross-book roll-up, so a reader can see companies bought
or sold down by more than one tracked investor, new entrants, the largest increases and reductions,
and positions no longer disclosed without opening ninety books one at a time. *Data Table* sits
after Quarterly Changes and owns the complete all-disclosed-positions grid, including search,
investor/change filters, watchlist control and Excel export. The chosen in-page tab survives scope
changes and live-data repaints until the reader leaves Super Investors.

The view stays intentionally quiet around that content: it renders no per-view cache/status pill,
scope-count tag, progressive-reading strip, or source/action badge in an investor workspace. Scope
and refresh already live in the global header; the workspace header is the investor name and tabs.

Every company in Quarterly Changes is clickable. Its popup names every relevant superstar
investor across the full book set and shows status, previous stake, current stake, derived change
and current Finology position value, so abbreviated labels such as `+1` never hide the answer.
The value is current position value, not a claim about how much was bought or sold.

**Institutions mirrors the same in-page pattern.** *All Institutions* keeps the fund picker and
full history table; *Quarterly Changes* rolls up new, increased, reduced and no-longer-disclosed
positions across the tracked quarterly shareholding books. Monthly AMC portfolios do not enter
that roll-up: their `% to NAV` is a weight in a fund, not a stake in the company. Clicking any
company opens every relevant quarterly institution book with its status, prior/current filed
stake, derived percentage-point change, Trendlyne value and filed share count.

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
| 7 | Portfolio Analytics + polish and QA | Built, then **deleted** — see prompt 9. A FIFO lot engine over an illustrative ledger, live marks, an equity curve over 735 real closes, XIRR and TWR, four sub-views and a CSV import, plus the QA pass that remains: error states, a11y focus traps, `scope="col"` on every header and the assertion suite in `scripts/verify-ui.mjs`. The ledger was synthetic and every price in it real; that mixture is why the workspace is gone. In git history at `d3bba30`. ✅ |

| 8b | Tracked keywords on Corp Announcements | The same vocabulary on the widest feed in the dashboard, matched against the filing's subject and BSE's own sub-category. Topic column and filter (replacing the Sub-category column, which duplicated the sub-line). It **replaced** `announcementSignal()`'s borrowed materiality gate rather than sitting beside it: BSE's `critical` flag marks 29% of filings, 881 of them AGM notices, so it is reproduced on the row and no longer decides importance — which fell from 32% of filings to 11%. Direction untouched. ✅ |
| 8 | Tracked news keywords + cross-feed correlation | The desk's thirty keywords as one shared vocabulary (`public/js/data/news-keywords.js`), driving a counted Topic filter and column on both News surfaces, the materiality rule for company news in All Alerts, and a participation event (volume ≥ `VOLUME_X`, or a confirmed base break) on the technicals feed. AI Alerts gains `confluenceOf()` — seven **named** cross-feed patterns that say *"volume 3.2x its average, and a tracked investor's latest book shows buying"* instead of *"three feeds"*. A keyword is a **topic and never a direction**, so no story anywhere gains a sentiment of ours. Measured: 11,060 captured stories → 3,278 tracked. ✅ |
| 9 | Provenance reachable again | The filings tabs' provenance and the source registry were both built and had no caller — correct, maintained and unreachable, which reads as documentation of a working feature. Each now has a door placed **after** the content it qualifies: a footer line for the registry, one muted line under each filings table for that tab's measured coverage. The chrome that was deliberately removed stays removed — no Sources button in the header, every status pill still a passive `<span>` that opens nothing. Also fixes two defects found alongside: `earnings-calendar` had no `load()` and threw on every Ask Research question, so that source had never once been read; and a `[Dashboard: …]` citation resolved by first-match across four shared tab names, sending a question about strong breakouts to the Technical Scanner. ✅ |
| 10 | Portfolio means a list of names | **Portfolio Analytics deleted.** Four modules, the FIFO engine, `js/data/portfolio.js`, the illustrative ledger, the mock transactions and 290KB of equity-curve history are gone, and the Ask Research evidence registry drops from fifteen sources to fourteen. It was `hidden: true` — routable but not clickable — and an Ask Research citation linked straight into it, so a reader landed on a screen of invented money with nothing on the page that led back and no address bar inside the host iframe. The only portfolio information left is the synced book of 142 company names. The rules that survive: *a surface that is not offered must not be reachable*, *an evidence source must be a tab the reader can open*, and *prefer deletion to labelling* — for the third time. ✅ |
| 11 | AI Alerts cards built for time to insight | The ranking was already honest and the card still took twenty seconds to read: the leading pattern's sentence was printed as the insight AND again, verbatim, in a *Signals lining up* panel below it, in the feeds' own wording, above evidence rows carrying full timestamps, direction pills, importance pills and each rule's reason. It is now one short sentence in ordinary English, the numbers behind it as four figures, and three evidence lines — with an **Archive** that is a place rather than a deletion. Every phrase rewords an event already on the card and every figure reads a field the collector writes (`volumeX`, `movePct`, `deltaPp`), never a regex over prose. Volume takes no colour, because participation has no sign. Three evidence rows mean three different sources where the card has them: taking the top three by score put three near-identical fund rows on a card whose strip announced four sources. ✅ |

**Still to come**

- **No keyword-targeted search.** "Company name + keyword" is answered by classifying the committed
  capture, not by sending 559 × 30 queries against a sixty-a-minute cap. If the upstream ever grows
  a topic axis, that becomes the cheaper question to ask.
- **Patterns are tuned against one capture.** Thirty of thirty fire on the shipped file, but *Fire*
  reaches one row and *Receipt of Order* two. Those are the two to re-measure once more history has
  accumulated; the Topic filter's **No tracked keyword** option is what makes a too-narrow pattern
  findable in the meantime.

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
