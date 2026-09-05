# Handoff

Everything a new maintainer needs to run, extend and trust this dashboard. `CLAUDE.md` is the
working contract, `docs/SPEC.md` is the product, `docs/DATA-CONTRACTS.md` is every JSON shape.
This file is the map between them, plus the things that are only obvious once you have been bitten.

---

## 1. What this is

A static research and portfolio dashboard for Indian equities. Vanilla ES modules, no deployment
build step, no bundler, no npm dependency for the app itself. The generated Tailwind stylesheet is
committed, so serving `public/` is still the whole runtime setup.

```bash
python3 -m http.server 8080 -d public     # that is the whole dev setup
```

One workspace, twelve tabs:

| Workspace | Tabs |
| --- | --- |
| Research Central | **Ask Research** · AI Alerts · All Alerts · Earnings Hub · Con-call · Public Chatter · Breakouts / Technical · Super Investors · News · Corp Announcements · NSE Filings · Insider Trades |

**There was a second workspace and it is deleted.** Portfolio Analytics was four modules over an
illustrative ledger, kept `hidden: true` so old links still resolved — routable but not clickable,
which is exactly how a reader following an Ask Research citation ended up on a screen of invented
money with nothing on the page that led back. **Portfolio here means the book of 142 company names
and nothing else.** See §2 and `d3bba30` in git history.

**Ask Research is the landing tab.** AI Alerts ranks the last seven days of company-specific material events from the
complete twenty-category All Alerts pool into a concise portfolio priority queue. **All Alerts** keeps the complete
newest-first stream (News contributes company and market-wide feeds). Direction and importance stay
separate, every General row states both reasons, and AI cards show the strongest evidence and next
action without exposing score arithmetic. Both are derived views with no data source of their own.
See §4c and §4e.

**Ask Research** builds one bounded evidence packet from the runtime data modules behind every
other research tab — sixteen sources, each one a tab the reader can actually open — recording a
status for each so an unavailable feed cannot disappear silently. The Worker streams that packet through Muns'
hosted LLM router and forwards each NDJSON text chunk as it arrives. The browser holds no provider
credential; configure a Muns session-token secret. Conversation history is device-local, but each
submitted question and evidence packet are sent to the hosted model. See §4d.

**Three scopes, not two**: Portfolio (the book) · Watchlist (companies the reader starred) ·
Universe. Portfolio is the default. The pencil beside the toggle edits the active list on this
device: Watchlist uses the existing starred-company store, while Portfolio and Universe keep a
local overlay over their committed defaults. Company lookup is proxied through the Worker to Muns,
so `MUNS_TOKEN` never reaches the browser. Portfolio scope edits do not change the Analytics
ledger. When Watchlist is empty, **Add companies to watchlist** opens this same editor directly in
Watchlist mode without changing the current tab or scope. See §5a.

---

## 2. What is live and what is mock — the honest inventory

This is the first thing to check before quoting any number off a screen.

### Genuinely live — scraped on a schedule, from a real source

| Feed | File | Source | Cadence |
| --- | --- | --- | --- |
| Technicals: OHLCV, indicators, delivery %, FII/DII deltas for the NSE 500 | `public/data/technicals.json` (763 KB) | Yahoo Finance EOD + NSE delivery | Weekdays 07:00 IST |
| ATR history for the ATR-stability rule | `public/data/atr-history.json` (568 KB) | Same scrape | Weekdays 07:00 IST |
| **Quarterly results for the whole listed universe** — 1,319 companies | `GET /api/earnings` (live) + `public/data/earnings-live.json` (snapshot) | Moneycontrol Rapid Results | **Live: 30s edge cache, 30s client poll** |
| **Every earnings call held this quarter** — 877, with StockScans' result score, sentiment tier and highlight bullets | `GET /api/concalls` (live) + `public/data/concall-scans.json` | StockScans | **Live: 30s edge cache, 30s client poll** |
| **Retail chatter** — mentions and sentiment across ValuePickr, TradingQnA and Google News, 219 entries over a rolling 30 days | called direct from the browser, **not** proxied — see §5e | SentimentDash | **Live: twice daily upstream (01:30 / 13:30 UTC), hourly client poll** |
| **NSE live announcements** — the exchange's own filings RSS, rebuilt every few minutes, resolved to a ticker so it can be **scoped to your Portfolio / Watchlist**. The one company-scoped live feed | `public/data/nse-announcements.json` (fallback) + live `/api/nse-announcements` | NSE, read by our **Worker** (the browser can't — CORS null); a full desktop user-agent or Akamai 430s it | Live off the exchange, edge-cached 90s; the snapshot refreshes hourly in Indian hours |
| **Market-wide news** — five publishers in one list, every row bylined. A bounded head plus a shard per month, and **nothing is ever discarded** | `public/data/market-news.json` (head, ~430 KB) + `public/data/market-news/<YYYY-MM>.json` (archive, fetched only when a reader scrolls past the head) | Moneycontrol's listing page plus Business Standard, Mint, Economic Times and Investing.com RSS — all read with `curl` from a GitHub runner, because **three of the five answer a Worker with the same 24-byte 403** | Moneycontrol every 30 min in Indian hours and hourly outside (measured — see `docs/DATA-CONTRACTS.md`), **and on demand from the tab's Fetch button**; the RSS publishers hourly. Both jobs share one concurrency group because they merge into one file |
| **Company news** | `public/data/news.json` (bounded 30-day head) + `public/data/company-news/<YYYY-MM>.json` (permanent portfolio archive) | Muns company-name and reviewed-alias searches through the Worker; every active book line resolves to a stable company identity, including companies without NSE symbols | Portfolio every 3h, every day, with a 48h overlap; universe 09:00 + 19:00 IST weekdays; watchdog recovery after 3h |
| **Bulk, Block, SAST and Insider trades** | `public/data/insider-trades.json` | Authenticated Screener.in market-wide lists; retained Muns rows add exchange detail | Every 30 minutes; watchdog recovery after 75m |
| **Corporate announcements** | `public/data/corp-announcements.json` | BSE date index, no credential | 20:00 IST weekdays; watchdog recovery after 75m |
| scID → NSE ticker, industry, share count | `public/data/mc-ticker-map.json` (190 KB) | Moneycontrol price feed | Incremental, daily |
| Close on each result date | `public/data/result-returns.json` (80 KB) | Yahoo Finance | Incremental, daily |

Both scrapes run from `.github/workflows/technicals-refresh.yml` and share one fetch helper,
`scripts/lib/yahoo.mjs`, so the two feeds cannot drift about what a close price is.

**Superstar investor books — Ticker Finology, behind a credential.** Every tracked individual
investor Finology carry, and for each the full book they publish: company by company, one column
per quarter of disclosed holding percentage, plus net worth, active/total stock counts and any
biography. Read live through `/api/super-investors` and `/api/super-investors/{slug}`. This is the
one upstream that needs `Authorization: Bearer …`, so the Worker holds the token in
`env.MUNS_TOKEN` and the browser never sees it. Percentages are the filings; the ₹ value is
**Finology's** derivation and is headed as such. The only computed figure is the
quarter-over-quarter change, headed *Change (derived)*. See §5d.

**The news tab can start its own scrape, and that needs one secret.** `www.moneycontrol.com` cannot
be read from a browser or from the edge, so the tab's *Fetch from Moneycontrol* button dispatches
`market-news-refresh.yml` on GitHub and watches it. Set it up with a fine-grained personal access
token scoped to **this repository only**, with the single permission **Actions: read and write**:

Add a Secret named **`GH_DISPATCH_TOKEN`** in the **Cloudflare dashboard** — *Workers & Pages →
this Worker → Settings → Variables and Secrets*. That is the route on this deployment, which
publishes through **Cloudflare's Git integration** rather than through `.github/workflows/deploy.yml`
(whose deploy job is skipped here: `CLOUDFLARE_API_TOKEN` is not set as a repository secret).
`npx wrangler secret put GH_DISPATCH_TOKEN` does the same thing from a terminal.

`GH_REPO` and `GH_REF` are plain vars in `wrangler.jsonc` — fixed there, not read from the request,
so the unauthenticated route cannot be pointed at another workflow. **Without the secret nothing
breaks**: the button says the deployment has no token and names that command, and the scheduled
scheduled files remain readable. Automatic recovery and the Fetch button require the token because
both dispatch a fixed GitHub workflow. Full contract in `docs/DATA-CONTRACTS.md`.

**Calendar zero-feed guard.** Moneycontrol's results-calendar count endpoint has answered a valid
all-zero window while the HTML calendar and recent capture named companies. The Worker substitutes
captured counts only when an overlapping capture contradicts the flat feed, labels that origin,
and never changes exchange populations. See *When the count endpoint goes flat* in
`docs/DATA-CONTRACTS.md`.

**Institutions — three funds, and TWO DIFFERENT DISCLOSURES behind a fund picker.** This is the one
view where the same-looking number means two different things, so read the header of
`js/investors/filed.js` before touching it.

*Filed shareholdings (`disclosure: 'shareholding'`).* **Smallcap World Fund Inc** — every Indian
company the fund appears in, with the share count and percentage the **company** filed with the
exchanges, nine quarters deep, scraped from Trendlyne. 37 holdings, ₹35,818 Cr as of Jun 2026,
cross-checked to the rupee against Trendlyne's own stated total before the file is written. The
percentage is **how much of the company the fund owns**; only holders above 1% are named at all.
The rupee value is *their* derivation and says so everywhere.

*AMC portfolios (`disclosure: 'portfolio'`).* **Bandhan Focused Fund** (27 holdings, ₹2,008 Cr) and
**Bandhan Small Cap Fund** (258 holdings, ₹28,017 Cr), seven months deep to Jul 2026, imported from
the AMC's own monthly disclosure workbooks by `scripts/import-amc-portfolio.mjs`. The percentage is
**% to NAV — how much of the fund is in the company**, the opposite measurement; every position
appears however small, and the rupee value is the AMC's **own published figure** rather than a
derivation. The columns say `% to NAV`, the pill says *Disclosed*, and nothing on the page sums
across the two kinds. The NSE symbol is *ours*, resolved by `scripts/lib/company-index.mjs`; 37 of
the Small Cap fund's 255 equity lines do not resolve and keep their row with a stated reason.

Institutions has **All Institutions · Quarterly Changes** inside the sub-view. The second tab uses
only `disclosure: 'shareholding'` books and mirrors the superstar cross-book roll-up; the AMC books
stay in All Institutions because monthly `% to NAV` cannot be compared with a quarterly stake in
a company. Every summary company is clickable and opens all relevant quarterly institution books
with status, both filed stakes, derived pp change, Trendlyne value and shares held. A `Filing
Awaited` row is excluded from moves and is never misreported as an exit.

**The synthetic institutions and Fund Flows are gone**, along with `js/data/investors.js`,
`js/investors/deep-dive.js` and `gen-mock-investors.mjs` — see *The synthetic investor set* in
`docs/DATA-CONTRACTS.md`. Every number on the Super Investors tab is now somebody's disclosure.

### Real, but refreshed by hand

| Feed | File | Notes |
| --- | --- | --- |
| The coverage universe | `public/data/universe.json` | The actual NSE-500 Screener export, 535 companies. Names, tickers, sectors and market caps everywhere else in the app come from here. |
| **The book** — what the Portfolio toggle means | `public/data/portfolio-companies.json` | The family office's listed direct-equity book, **read from `techmuns/Sattva-Family`** (`src/data/sattvaData.ts`) by `scripts/sync-family-book.mjs` — **142 companies, one per equity ISIN, names and sectors only** — and resolved to NSE symbols by `scripts/resolve-portfolio-companies.mjs`. `family-book-sync.yml` keeps it in step (needs `FAMILY_REPO_TOKEN`). This is what every research tab's Portfolio scope filters by. It is **not** the ledger — see §5a. |

### Additional document and research sources

| Feed | Where | Notes |
| --- | --- | --- |
| **Additional corporate announcements** | Corp Announcements continuous feed | Scheduled Muns BSE/NSE/DRHP captures join BSE and live NSE announcements. Exchange ISIN/BSE-code identities now include BSE-only, renamed and newly listed holdings, with NSE SME aliases translated for company requests. History loads automatically and portfolio backfill has priority within the paced job. The counter reports companies with filings, not complete coverage. See `docs/DATA-CONTRACTS.md` → Corporate announcements are read by DATE. |
| **Company filings** — annual reports, earnings reports and transcripts | Earnings Hub → Company Filings; Reports/Transcripts links in results and con-call scans | Authenticated Muns `/filings/domestic` proxy to Screener.in; scheduled company capture, 15-minute edge cache, shared/device history and original document links. No PDF extraction or analyst estimates. See `docs/DATA-CONTRACTS.md` → Domestic company filings. |
| **Concall Deep Dive** — a per-company report on one call | The **Deep Dive** column on the Con-call tab | A separate Cloudflare Worker runs its own LLM pipeline and returns the report; this dashboard triggers it, mirrors its progress and lays out the result. Nothing is stored in `public/data/` and nothing is committed. Reading the reports they already hold is free and happens once per visit; **starting a new run costs real compute**, so that never fires without a click and a confirm. See §5c. |

### Synthetic earnings data is test-only

The last served synthetic earnings and calendar files moved to `scripts/fixtures/`. Bootstrap
no longer requests them, and legacy earnings accessors reject mock/synthetic payloads. Analyst
consensus is explicitly **Not connected**. The supplied domestic-filings endpoint adds original
documents; it cannot supply the missing estimates or structured financial history.

### The surface that mixed both inside a single number, and what happened to it

**Portfolio Analytics did**, and it is deleted. Its ledger was synthetic — *which* trades were made
and *when* — while everything priced in it was real: execution prices were actual Yahoo closes,
positions were marked from the live technicals feed, and the equity curve was 735 trading days of
real closes. The disclosure was split accordingly and honestly: an amber *Illustrative ledger · live
marks* pill in every sub-view's section head, turning rose and reading *Marks unavailable · shown at
cost* when a price was missing, with the whole statement in row 1 of every exported workbook.

**It was still the wrong answer.** A pill does not survive a screenshot, and an invented ₹30.7L
market value under this dashboard's chrome reads as the family's money. So the workspace went the
way the four synthetic con-call views and the Fund Flows sub-view went — *prefer deletion to
labelling* — and the rule that came out of it is in `CLAUDE.md` under *Portfolio means a list of
names*: **a surface that is not offered must not be reachable, and an evidence source must be a tab
the reader can open.**

---

## 3. Running and refreshing

```bash
# serve
python3 -m http.server 8080 -d public

# verify (Chromium is preinstalled — never run `playwright install`)
node scripts/verify-calendar.mjs                # Moneycontrol calendar parser + pagination contract
node scripts/verify-research.mjs                # Ask Research evidence + Worker contract
node scripts/verify-company-news-archive.mjs    # identity coverage, append-only archive and overlap
node scripts/verify-company-news-capture.mjs    # scheduled capture against a local news fixture
node scripts/verify-ui.mjs                      # ~180 checks, exits non-zero on the first failure

# refresh the live feeds
node scripts/scrape-technicals.mjs              # TECH_LIMIT=15 for a smoke run

# re-import the AMC portfolio workbooks (committed under scripts/fixtures/)
node scripts/import-amc-portfolio.mjs           # merges in; leaves the Trendlyne funds alone

# regenerate the seeded mock sets (all deterministic)
node scripts/gen-mock-earnings.mjs

# sync the book from the family office repository
node scripts/sync-family-book.mjs               # FAMILY_REPO_TOKEN=… or FAMILY_BOOK_PATH=a local clone
```

---

## 4. Architecture in one page

```
public/index.html          design tokens, fonts, compiled CSS link, #app, three overlay roots
                           (drill z-50 < workspace z-55 < modal z-60)
public/sw.js               repeat-visit app shell: full ES-module graph + public-data SWR;
                           never caches /api, Authorization or no-store requests
public/css/tailwind.css    generated Tailwind utilities; committed and served directly
public/js/
  app.js                   bootstrap: fetch the small JSON set once, prime the data modules, mount
  core/                    state · router (hash) · live (polling) · store (IndexedDB cache) · format · dom
                           watch.js — app-wide feed watchers behind the alert stack (§4b)
  ui/
    screener.js            THE KIT: statStrip · topCards · scoreTable · openDrill · openWorkspace
                           · openModal · sectionHead · pendingPanel · trapFocus
    visual.js              avatars, tiers, status pills, signal dots, legend
    sources.js             the source registry — the honest status of every feed
    source-beacon.js       the lower-left "Data flowing in" beacon over that registry (§4b)
    twitter-sources.js     "Edit Twitter Sources" — the X accounts whose posts join News
    notifications.js       the lower-right live alert stack (§4b)
    export.js              exceljs-from-CDN "Export Excel"
    shell.js               header, tab bar, sub-view picker, the WORKSPACES registry
  data/                    one module per feed: load once, compute once, cache, expose accessors
                           coverage.js — THE BOOK: what the Portfolio scope filters by (§5a)
                           scope.js — the three scopes in one place; every forScope() asks it
                           daily-alerts.js — retained chronological readings across the research feeds (§4e)
                           chatter-live.js + sentiment-shared.js — retail chatter (§5e)
  scoring/                 tech-scoring (16 rules / 24 pts) · earnings-scoring (15 / 21) · rule-meta
  concall/                 scans.js — the whole Con-call tab: the live scan table, without
                           schedule or feed-status header chips
                           deep-dive.js — the panel behind the Deep Dive column (a SEPARATE
                           dashboard's pipeline and a SEPARATE dashboard's report)
  research/                bounded dashboard evidence catalog + safe answer renderer (§4d)
  tabs/                    the Research Central tabs
                           ask-research.js — the conversation workspace (§4d)
                           ai-alerts.js — the default explainable priority queue (§4c)
                           daily-alerts.js — retained history, newest first (§4e)
worker/
  index.js                 asset serving + live /api routes, including /api/research
  research.mjs             server-only streaming Muns LLM bridge and request limits (§4d)
  http.mjs                 content ETags, 304s, CORS — imported by the Worker AND by any local
                           stand-in, so the caching semantics under test are the shipped ones
  mc.mjs                   Moneycontrol client + normaliser, shared with scripts/
  stockscans.mjs           StockScans client; the vocabulary lives in public/js/data/
  sentiment.mjs            SentimentDash chatter client; base URL is env.SENTIMENT_BASE
```

**To add a tab:** write a module exporting `meta` / `render(ctx)` / `destroy()`, then add it to
`WORKSPACES` in `js/ui/shell.js`. That is the only registration point. Every tab renders
full-width; sub-views are one dropdown above the content, and `subviews: []` renders no picker at
all.

**To add a data source:** three files, together — `docs/DATA-CONTRACTS.md`, the loader in
`js/app.js` (or a lazy `js/data/*.js`), and the entry in `js/ui/sources.js` with an honest `status`.

**To change shipped JavaScript or CSS:** bump `CACHE_NAME` in `public/sw.js`. The install step
follows static imports from `js/app.js` and warms the whole graph, so there is no second asset list
to maintain. Code is cache-first within that named version; the browser's service-worker update
check installs the next graph atomically. Navigation HTML and public `/data/*` assets are
stale-while-revalidate. `/api/*`, requests with `Authorization`, explicit `no-store` requests and
private Family replies stay outside CacheStorage.

---

## 4c. AI Alerts

**AI Alerts is the prioritised reading list.** `js/data/ai-alerts.js` groups the last seven
days of company-specific All Alerts by ticker. It ranks materiality, recency, direction, real
Portfolio membership, independent-feed corroboration, repeated high-importance events,
directional conflict and high-importance negative clusters inside a portfolio sector. A stale, failed
or unread feed subtracts points. Cards are sorted by score internally, show the strongest three source
events and next action, and keep the score arithmetic out of the UI. They link to All Alerts
pre-filtered for that company. A compact header status still names stale or unread feeds so a partial
queue cannot look fully current.

`js/data/intelligence-graph.js` then reads **all** company-linked rows in the normalized pool,
including `aiEligible: false` filings, documents, snapshots and schedules. It attaches at most three
related context records by company, source health, time and topic, plus the next known milestones.
This layer contributes zero points: a routine row can explain a material trigger but can never
create a card. Unsupported company-news attribution is excluded. One small linked context sentence
is the only added card UI.

The completed public seven-day event window is materialised under
`ai-alerts:public-window:v1` in the existing IndexedDB store. A hard reload can rank and paint that
window before the live collectors settle, then swap in one complete refreshed report. The stored
window is universe-wide so Portfolio and Watchlist are applied only against the current in-memory
book on read. Its serializer drops private events, the private document feeds, source records and
all holding-weight fields. Authenticated position sizes are reusable for 55 seconds only in the
current page process; explicit Refresh bypasses that reuse and no private reply reaches storage.

The model is deliberately deterministic rather than generative: the feeds already carry the
structured facts needed to prioritise them, so a repeatable rule cannot invent a filing or silently
change its mind. Single-feed neutral news noise stays below the threshold, and tickerless market
news stays in All Alerts because it cannot honestly be attributed to a portfolio company.
Inside the authenticated Family host, complete position weights order surfaced portfolio cards and
appear as `% of listed portfolio`; they do not alter the score, priority, direction or certainty.
The ranker reads them from `positionSizes.holdings`—never the public names-only coverage list—and
falls back to evidence priority when the complete checked set is unavailable. `coverage.js`
supplies membership and sector context only.

---

## 4d. Ask Research

`js/tabs/ask-research.js` owns the conversation UI and device-local library. **An answer keeps being
written after the reader leaves the tab** — `destroy()` deliberately does not cancel it; it lands in
the conversation and raises an alert-stack card when it finishes off screen. A scope change, a
watchlist edit or a Portfolio/Universe edit still cancels it, because the evidence packet was built
under the scope recorded on the generation, and those watchers sit at module level so they work
while the tab is unmounted. An unsent draft is persisted with the conversation; a question
interrupted by a page reload is handed back to the composer rather than re-sent, because a re-ask
costs a model run.
`js/research/estate.js` is the registry: sixteen adapters read the same modules as AI Alerts,
All Alerts, Earnings Hub, Con-call, Public Chatter, Breakouts, both Super Investor disclosures,
both News feeds, exchange filings, Insider Trades and Screener's source-backed Insights series. **Every source is a tab the reader can open**
— the mock ledger was the fifteenth and cited itself as *Portfolio Analytics*, linking into a hidden
workspace with no way back; `verify-research.mjs` now requires every route to start `#/research/`.
Every adapter loads first
(in parallel, each under its own deadline); the question is then resolved against everything that
loaded — a symbol, a company name or a distinctive lead word becomes a ticker — and only then does
each adapter read its rows, named companies first. Each adapter contributes coverage, as-of
metadata, units and a ranked row sample; the catalog and a ready/unavailable status always include
every source. The packet is fitted to a 13,000-character budget measured on the provider-facing
shape in `js/research/evidence-shared.js` (the Worker imports the same module to build the prompt
and to bound the request): every source keeps its status, coverage and provenance first, the
skeleton may take at most 60% of the budget (summaries, then coverages, are trimmed from the
largest sources and marked `trimmed` before any row is refused), and rows are admitted tier by tier
across sources. The compact catalog carries only source identity and status because each source
packet already holds the tab, UI route, dates, provider and coverage. Those UI-only fields stay in
the browser for source chips and are not charged against the budget.

`POST /api/research` in `worker/research.mjs` is the only provider boundary. It keeps
a Muns session token server-side, rejects cross-origin and oversized requests, rate-limits the paid
upstream, and streams normalized NDJSON back to the browser. It calls `fastapi.muns.io/query-router`
with `llm_type: local_llm` and `stream: true` for low first-token latency; the upstream contract has
no web-search mode, so the UI makes no such claim. Model text is rendered through a small DOM-based Markdown subset and never
reaches `innerHTML`.

An empty Watchlist does not replace this tab with the shell's generic empty panel. The source
catalog and its zero-row coverage are still useful evidence, so this module declares
`meta.allowEmptyScope`; every other tab retains the shared empty-Watchlist behavior.

Local static serving shows the complete workspace but disables the composer. To exercise answers,
run `npx wrangler dev` with `MUNS_LLM_TOKEN=…` in the gitignored `.dev.vars`. Production prefers
`npx wrangler secret put MUNS_LLM_TOKEN` and falls back to `MUNS_NEWS_TOKEN` or `MUNS_TOKEN`. The
former `ANTHROPIC_API_KEY` name is read only when `MUNS_LLM_LEGACY_ANTHROPIC_BINDING` equals
`confirmed-muns-token`; remove that migration opt-in after installing the correctly named secret.
Never put that value in `public/`, `wrangler.jsonc` or browser storage.

---

## 4e. All Alerts — the complete timeline

Its route id remains `daily-alerts` so saved links keep working; only the user-facing name changed.

Every other tab here is organised by SOURCE: this is what the results feed holds, this is what BSE
filed, this is what the technicals scrape measured. That is right for research and wrong for the
first thirty seconds of a morning, when the question is not *what does Moneycontrol have* but *what
happened, and does any of it need me*. All Alerts is organised as one chronological timeline.

`js/data/daily-alerts.js` takes the General readings; `js/tabs/daily-alerts.js` draws them. Every row
comes from a registered feed. The one portfolio-only addition is the authenticated S Screen forward
calendar carried on the existing `/api/concalls` capture; it is never exposed in Universe or a
personal Watchlist. **Till Today** orders retained history newest-first by **Indian trading date and
time**. **Upcoming** shows scheduled rows from today forward, nearest-first, and collapses the same
company/date/type when two calendars discover it. Both use the table kit's progressive body fill;
their date filters only narrow loaded records and issue no new request.

**All twenty registered feed categories are represented.** They include the material readings plus
raw NSE/IPO filings, earnings and call schedules, the portfolio calendar, investor/institutional
snapshots, captured posts and session-only document lookups. Adding a source remains an entry in
`FEEDS` plus a collector; no rendering behaviour is special-cased by feed id.

**Direction and importance are independent readings.**

| Reading | Values | Set by |
| --- | --- | --- |
| Direction | Positive / Negative / Neutral | source sentiment or figures where carried; transaction direction for insider/investor activity; a narrow announcement rule; Neutral for news |
| Importance | High / Low | stated objective thresholds printed in the row and source registry |

Every row prints `signalReason` and `importanceReason`; a badge whose cause cannot be inspected would
be an unexplained judgement.

Earnings direction uses the revenue/net-profit comparison; con-calls and chatter reproduce their
source's sentiment bands. Insider direction comes from acquisition/disposal and pledge wording;
investor direction comes from newly disclosed/added versus trimmed/no-longer-disclosed positions.
Announcements match a small exported policy: downgrade/default/enforcement/cancellation/suspension/
auditor resignation are Negative, while upgrade/distribution/order award/regulatory approval/patent/
production start are Positive. Unmatched announcements and publisher news stay Neutral.
Earnings sign changes are labelled *to profit*, *to loss* or *loss narrowed/widened*, never restored
as a percentage across zero. Explicit insider Transaction wording outranks Mode, and commercial
context is required before “order received” is treated as an award. Approval requires regulatory or
exchange context; noun-first BSE wording such as “Receipt of … Approval” and “Commencement of
Commercial Production” remains covered.

High thresholds are: ±5% price move; an earnings filing; non-neutral/extreme con-call analysis;
10 public-chatter mentions or 100% absolute mention change; insider activity of at least 1% or ₹10
crore; investor position appearance/disappearance or a one-percentage-point change; a BSE critical
announcement or a material announcement-rule match. Directional activity is not an investment
recommendation, and “no longer disclosed” does not prove a complete sale.

**The coverage panel is the half that makes today readable beside history.** Most of these feeds are
captures committed on a best-effort schedule, so a bucket with nothing in it has two completely
different meanings — *nobody filed*, and *nothing has looked at today yet*. `Feeds read for this
day` states, per feed, when it last looked and whether that reaches today, while older rows remain
under their actual dates. A feed nobody has heard from yet reads **pending**, never "nothing
today". Same rule as the filings tabs' *"63
companies have not been checked since"*: never claim nothing is new.

Universe retains investor rows whose upstream identifier cannot be resolved to a ticker; Portfolio
and Watchlist cannot match them and exclude them. A missing investor book, or a degraded
earnings/con-call fallback, is named as incomplete rather than presented as a current all-clear;
last-good investor books are incomplete too. A committed file read retains the source's
`fetchedAt` rather than turning the browser's file-read time into upstream freshness.

**Nothing on either alerts view walks.** The three filings feeds are seeded through `feed.seed()` — the committed
snapshot and this device, no per-company request — which is deliberately separate from `load()` so
that seeding here cannot discard the company list the Corporate Announcements tab will later
refresh with. The header Refresh button performs bounded revalidation for earnings, con-calls and
chatter plus one conditional request for the bulk investor snapshot; the ninety-one-book investor
walk remains behind its owning tab's explicit control. It reports what changed by **comparing event
ids, never counts**: the day rolls over, captures land, stories drop off the end of a bounded cache,
and a count cannot answer "did anything change" for a collection like that.

**Feeds land one at a time and the page follows them.** The first version awaited every feed
together and the timeline sat blank for as long as the slowest — measured at 10–15 seconds on a
static origin, because the chatter API is a direct call to somebody else's service and an
unreachable host takes its own time to say so. Feeds that had already answered were held hostage
by the one that had not. Now each settles independently and paints as it lands, coalesced
into at most one repaint per 250 ms (a trailing throttle, not a debounce — a debounce would keep
deferring while feeds kept landing). Measured after the change: first paint at **~250 ms**,
everything settled by 3 s.

---

## 4b. The header and the live alert stack

The header is the brand, the scope toggle, **one** status pill and a refresh button.

It used to also carry a global search box, a Sources button, a green *"Live · just now"* chip and a
white *"Updated 52 minutes ago"* chip. The two chips are the part worth understanding: they made
competing claims about the same subject, and the green one was measuring the 20-second heartbeat —
a poller whose fetcher returns `Date.now()` and asks no server anything — so it said *"just now"*
whether or not a byte of data had been confirmed in an hour.

- One pill now, `● Live · updated 4m ago`, reading `live.getLastDataTick()`: the last tick of a
  poller that actually talked to a server. `live.register(id, { synthetic: true })` is what keeps
  the heartbeat out of that clock.
- **The Sources button and its popup are gone from the chrome.** The status pill is a passive
  freshness label. The canonical source registry remains available to audits and export paths,
  and `verify-ui.mjs` asserts that clicking status labels opens no modal.
- The refresh button calls `live.refreshAll()` and **reports a result** — `Up to date` or `3 new`.
  A spinner that simply vanishes leaves the reader unsure anything was checked.
- **The global search is gone with the box.** Nothing else used it; a company is reached from its
  tab's own table. If it comes back, `buildSearchOptions()` is in git history at `9c8c911..`.

**The source beacon** (`js/ui/source-beacon.js`) sits in the opposite corner, lower-left: a small
launcher that opens a popover listing every source in the registry as one vertical column, beside a
diagram of them converging on a single Sattva square — one wire per source family, carrying that
family's icon, and hovering a family in the list lights its wire. It is **not** the header's old
Sources button returning; that removal stands and the suite still asserts it. This answers a
different question (the whole estate, rather than one figure's provenance), in a different place,
for a reader who went looking. Every count in it is read from `sourceGroups()` on each open, the
green pill is worded as a COUNT of wired feeds rather than a bare "Live", and only live rows go
unlabelled — mock, manual, on-demand and not-built each carry their word.

**Alerts** (`js/ui/notifications.js`, fed by `js/core/watch.js`) appear in the lower-right when a
company files a result or a con-call gains its analysis. Both feeds already tracked exactly that in
`newArrivals()`; the watcher only turns it into a card.

Four things hold it together, and all four are the difference between an alert and a nuisance:

- **The watchers run app-wide.** `startLive` / `stopLive` are owned by the tab that shows a feed,
  which is right for a table and useless for an alert — an alert is only worth having if it fires
  while the reader is elsewhere. `watch.ensureRunning()` re-asserts the claim after every route
  change, because the tab you just left called `live.stop()` on the same poller id.
- **It is affordable only because of the caching layer.** An unchanged con-call tick is a bodyless
  304; an unchanged results tick is the ~30KB prices projection. The 1.1MB payload is pulled only
  when a company has actually filed. Without that, watching two feeds app-wide would be
  indefensible.
- **The backlog is suppressed, not replayed.** Arrivals accumulate from page load, so the first
  change event would otherwise announce rows the reader has had on screen for ten minutes.
- **The text obeys the table's honesty rules.** A loss-to-profit swing reads *"turned profitable"*
  rather than a percentage that does not exist, and a con-call with no score reads *"analysis
  pending"* rather than `0/100`. The suite asserts both, because an alert is the one surface that
  travels to a phone notification shade without any of its context.

---

## 5e. Public Chatter: someone else's counts, our symbol

Live off **SentimentDash** through `/api/chatter`. It counts mentions of companies and topics
across ValuePickr, TradingQnA and Google News over a rolling 30 days and keyword-scores each post.
The counts and the sentiment are theirs, reproduced and never re-banded. The one thing derived here
is the NSE symbol — their payload has none.

**Two numbers that are not what they look like.** `changePct` upstream is a change in MENTION
COUNT, not a price: there is no price anywhere in that API. It is renamed `mentionsChangePct` in
`sentiment-shared.js` so nothing downstream can misread it from the field name, the column says
*Mentions Δ*, and the suite asserts it is never coloured like a P&L and never carries a currency
symbol. `sparkline` is a per-**scrape** series, not per-day, so nothing puts a time axis under it.

**The tab is one page with two simple in-page tabs**, because their `ticker` is a forum-topic slug
(`tata-motors`, `fiis`, `3b-blackbio-dx`) and entries are discovered bottom-up, so about four
fifths of the list is not something we cover. An entry lands in the first section when its slug
resolves to a symbol in `universe.json`, the book, or `mc-ticker-map.json`. On a real 219-entry
run: **45 covered, 174 not, 8 of them in the book.**

**Coverage** is the default and owns Most Discussed plus the resolved-company table. **Not in
coverage** replaces that content with the unresolved table; the two tables never stack on one page.
Each active table owns its own sentiment selector, so choosing Bullish, Bearish or Neutral filters
the rows immediately below it and each tab retains its own choice.

Every company row and mention count opens a lazy-loaded detail modal from SentimentDash's
`/stocks/{slug}/posts` route. It shows a short identifying excerpt, source, author, timestamp and
sentiment, with a direct link to the original item; the full post remains on its publisher's site.

The four summary cards are deliberately absent. Their coverage count, post/source totals, market
mood split and scrape timing are retained in one compact footnote below both tables.

That split is a statement about *our* coverage, never a taxonomy. The second section mixes Indian
companies we do not carry, foreign names (`cisco`, `spacex`, `ubs`) and bare themes (`fiis`,
`income`), and we do not guess which is which — the heading says so.

**The resolver matches exactly, never by prefix**, unlike `resolve-portfolio-companies.mjs`. The
book is 142 lines checked by hand; this is an open-ended stream where `value`, `growth` and
`defence` are real entries. A wrong symbol here does not fail loudly — it files a stranger's forum
posts under a company you hold. One live example of that trap, caught by the suite rather than by
reading the code: the noise list stripped `industries`, which collapsed *Value Industries* to
`value` and matched the bare forum topic. The fix is a length guard — a strip is used only if ≥8
characters survive — which keeps `walchandnagar-industries` → `WALCHANNAG` working against
Moneycontrol's truncated "Walchandnagar Inds" while `Value Industries` stays whole.

**What was deleted, and why it was not merely relabelled.** The synthetic ValuePickr/Telegram
corpus, the pump-risk heuristic and the generator are gone, per the Con-call precedent. There is no
live Telegram source; and pump-risk's gate is `MIN_MESSAGES_24H = 120` against a feed carrying ~600
posts per scrape across 219 entries, where the busiest entry had 22 mentions in *thirty days*.
Every row would have scored "Clear" — a fabricated all-clear, which is worse than no column. All of
it is in git history at `ce2aa18..`.

**Alerts fire only for book holdings, and only on first appearance**, unlike the other two feeds
which announce every arrival. Chatter would otherwise fill the stack with brokers and themes and
teach the reader to dismiss the component, results alerts included.

**IT IS NOT PROXIED, AND IT CANNOT BE — this is the thing to know before touching it.** A
`/api/chatter` route on our Worker was written, deployed, and returned 404 in production while
`curl` returned 200 from the identical URL. The upstream is another Cloudflare Worker on the same
account, and **Cloudflare refuses a Worker-to-Worker subrequest inside one zone** (error 1042,
*"Worker tried to fetch from another Worker on the same zone, which is not allowed"*), reporting it
as a 404 — indistinguishable from the route being absent, which is how it was first misread.

The tell was already in the routes: moneycontrol.com, stockscans.in and devde.muns.io are all
off-zone and all work; the one `*.workers.dev` upstream was the one failure.

So the browser calls it, exactly as it already calls the Concall Deep Dive Worker. `base` is
`window.SATTVA_CHATTER_URL` in `public/index.html`; `localStorage['sattva:chatter-base']` overrides
it. Nothing is lost: the API sends `access-control-allow-origin: *`, exposes its `ETag`, and
answers `If-None-Match` with a bodyless 304, so the conditional fetch and the device store work
unchanged. Public Chatter is now the one live feed that also works on a **plain static server**.

If a future upstream on this account must be proxied — to hold a credential — use a **service
binding** or a **custom domain**, not another `fetch()`.

To verify without egress: `node scripts/stub-chatter.mjs 8903 &` then
`CHATTER_STUB=http://127.0.0.1:8903/v1 node scripts/verify-ui.mjs`. It replays a verbatim 219-entry
capture with the live API's exact headers.

---

## 5a. One portfolio file, and what it may never carry

**`public/data/portfolio-companies.json` is the whole of what "portfolio" means here.**

| | `portfolio-companies.json` — **the book** |
| --- | --- |
| Answers | *is this company one of ours?* |
| Lines | 142 (19 with no NSE symbol, each with a stated reason) |
| Fields | name, ticker, sector — no quantity, no cost, no valuation |
| Read by | `js/data/coverage.js` → every research tab's `forScope()`, the scope denominators, the header search |
| Provenance | **real** — synced from `techmuns/Sattva-Family` daily and on `repository_dispatch` |

**It must never be widened.** The statement it came from was given as names only, with value and
weight explicitly out of scope, so a quantity or a cost added here would be invented rather than
supplied. There used to be a second file — `portfolio.json`, twelve positions with quantities and
costs behind a Portfolio Analytics workspace — and it is deleted along with the workspace, the FIFO
engine and the equity-curve history. §2 has why.

A Portfolio-scope edit in the pencil beside the toggle is device-local and changes research filters
and denominators only. There is nothing left for it to touch.

---

## 5. The FIFO engine — deleted, and what to bring back with it

`js/portfolio/lots.js` replayed the mock ledger into open lots and realised rows, and it is gone
with the rest of Portfolio Analytics (§2). If a **real** ledger is ever wired, take the engine out
of git history at `d3bba30` rather than rewriting it — and take these rules with it, because each
one was a bug first:

- **Two identities held exactly**, asserted numerically against the shipped data:
  `sum(open lot quantities) === position quantity` per ticker, and
  `realised + unrealised + dividends === total P&L` **per position**, not merely in aggregate. The
  Overview showed the measured residual rather than claiming correctness in prose.
- **Charges belong in the basis.** A buy's charges fold into cost per share; a sell's are
  apportioned across the lots it consumed.
- **Dividends are income, never a discount on the purchase.**
- **Corporate actions adjust lots in place** — quantity multiplied, cost per share divided, total
  cost unchanged, **acquisition date preserved**. A zero-price "buy" for bonus shares resets the
  holding-period clock and misclassifies a later sale as short term.
- **Missing input is not zero.** A position with no live price was marked *at cost* and excluded
  from the curve; marking it at zero invents a −100% position.
- **The back-adjustment trap.** Yahoo's `close` is back-adjusted for splits and bonuses, so a
  ledger may carry a corporate-action row **only** for an action the series was adjusted for — an
  invented split doubles the quantity while the series stays put and the curve jumps 100%. An
  earlier draft mirrored a "real" CDSL bonus that is not in the window; the closes ran ₹1,718 →
  ₹1,948 across the supposed ex-date with no step. **Check the data.**
- **Two return figures, deliberately.** XIRR is money-weighted (what the investor earned) and TWR
  time-weighted (what the strategy returned) — only TWR is comparable to an index. Likewise two
  drawdowns, total and holdings-only, both labelled, neither presented as *the* drawdown.

---

## 5b. The Earnings Hub is live per-request, not per-schedule

Every other feed here is live *on a schedule*: an Action scrapes, commits, the site serves a file.
The Earnings Hub is different and it is worth understanding why before changing anything in it.

```
browser ──poll 30s──▶ /api/earnings ──30s edge cache──▶ api.moneycontrol.com
                            │
                            └─ on failure ─▶ public/data/earnings-live.json (committed snapshot)
```

A company that files at 14:32 is on the table by about 14:33. No Action run, no rebuild, no reload.

**Why proxy at all** — Moneycontrol sends `access-control-allow-origin: *`, so the browser could
call them directly. Going through the Worker means a thousand readers cost the upstream one fetch
per cache window rather than a thousand, and it gives us somewhere to fall back to. When the
upstream fails the Worker serves the committed snapshot with a `degraded` reason and the tab swaps
its green "Live" ribbon for an amber "Showing the last snapshot" one. An empty feed is never served
as success.

**One normaliser, two consumers.** `worker/mc.mjs` is pure and dependency-free, imported by both the
Worker and the scraper, so the fallback can never disagree with the live route about shape.

**Repaint only on structural change.** The cache refreshes on every tick, but listeners fire only
when a company files or a figure is revised. An early version included the traded price in the
change fingerprint, which meant the 1,300-row table rebuilt every 30 seconds and discarded whatever
the user had sorted. Related: the fingerprint is **order-independent**, because the payload arrives
in Moneycontrol's sort order while the cache is held in ours — an order-sensitive hash reported
"changed" on literally every tick.

**A percentage across a sign change is not a growth rate.** 13% of companies in a full quarter have
one. Vodafone Idea's "+43%" is a loss narrowing from ₹6,608 Cr to ₹3,754 Cr; Wockhardt's "+199%" is
a loss becoming a profit. `classifyChange()` tags every metric, `pct` is null wherever no honest
percentage exists, and the UI renders a labelled pill. Same failure mode as the `op_vs_pat` rule —
check every growth figure for it.

**And a percentage on its own is a ratio with its inputs thrown away.** The table therefore carries
BOTH reported periods beside each growth figure — ten columns: `Date · Company · Rev cur · Rev
prior · Rev % · PAT cur · PAT prior · PAT % · MCap · Basis`. "+43%" is the same cell whether a
company earned ₹4 Cr or ₹4,000 Cr, and the pills only tell you a sign flipped, not how big the
loss was. Column headers name the actual periods ("REV JUN 26") so a screenshot of the table still
says what it is measuring against. `verify-ui.mjs` recomputes the percentage from the two figures
on screen for ~110 cells and fails if they disagree — the growth column and the figure columns are
three renderings of one fact and must never drift.

Fitting them in 1,352px needed four `scoreTable` layout options (`showRank: false`, `nameAfter: 1`,
`nameMaxPx: 210`, `dense: true`) — see CLAUDE.md. Ticker and industry are no longer columns; they
live on the second line of the company cell, still searchable, still in the export. Gross profit is
likewise in the feed and the export but not on screen.

**There is no drill panel, and re-adding one would be a regression.** There was one; six reported
figures were the bulk of what it said, so once those became columns it was restating the row you
clicked. Rows are not clickable. The status pill is passive and the source registry retains the
provenance previously carried by the drill. If a number wants to be in a drill, make it a column
instead.

**"Latest" means the upstream's order, not ours.** `resultDate` is a date; filings arrive through
the day. Rows carry `seq` (the upstream index) and sort `(date desc, seq asc)`, which is the only
way our top-of-table matches Moneycontrol's. A tie-break on the size of the profit move looked
reasonable and put a different set of companies at the top of a page whose entire job is "what just
happened".

**The column headings stay put because the table body is its own scroller.** `sticky` positions
against the nearest *scrolling* ancestor, and `overflow-x: auto` makes the wrapper that ancestor in
both axes — so the `sticky top-0` that had always been on the `<thead>` was sticking to a box that
never scrolled. `stickyHead` gives the wrapper a height; see CLAUDE.md.

**The Workspace dropdown and the scope toggle are different controls**, despite both
saying "Portfolio". Workspace picks *which tabs exist* (Research Central's nine, Portfolio
Analytics' four); scope picks *whose data* the open tab shows. Removing either strands the other.
Both carry a tooltip saying so, and the scope toggle now has a "Scope" kicker to match the
dropdown's "Workspace" one.

**The calendar's company list can be a CAPTURE, and the pill says so.** `api.moneycontrol.com` is
open; the widget and pagination routes on `www.moneycontrol.com` sit behind Akamai and can answer a
Cloudflare Worker differently from a laptop or GitHub runner. `scripts/scrape-calendar.mjs` follows
every page where it works, the Worker prefers a live read and falls back to that dated capture, and
the tab shows **Captured** rather than **Live** when it does.

**The Calendar is now complete and all-exchange.** Counts and rows both use `indexId=All`; the
first 20 rows come from `/earnings-widget` and every remaining page from
`/pagination/earnings-pagination`. On 13 Aug 2026 that means all 585 names across 30 pages, not the
first 20. `complete`, `pagesFetched` and independent count/list provenance travel in the payload.

**Calendar means schedule on every date.** It no longer turns today or a past date into the filed-
results feed. On 2 Sep 2026 the linked calendar listed Technocraft Ventures and BSE-only Vivanta
Industries while only Technocraft had filed; the old switch made the Calendar display one where its
source displayed two. **Earnings Reported** remains the separate filed-results view.

**The date strip is anchored on today, and restores its own scroll.** It used to request a window
around the *selected* date, so each click merged in new chips and slid the rest along; then the panel
rebuild reset the scroll container to its oldest date, leaving the selection off-screen to the right.
`stripWindowFor()` fixes the cause and `keepActiveVisible()` the symptom. If you rebuild a scrolling
container's `innerHTML`, you own restoring its scroll position.

**YoY / QoQ is one toggle over two payloads that look identical.** Both carry the same
current-period figures; only the comparison moves. That makes a mis-served payload the one error
nothing downstream could catch, so `setSubType()` refuses any response whose `meta.subType` is not
what it asked for, the change fingerprint covers `prior` as well as `current`, and there is no
committed QoQ snapshot to fall back to — the tab says QoQ is unavailable instead. Full rules in
`docs/DATA-CONTRACTS.md` under `subType`.

**Identity for brand-new filers is resolved live.** The committed map cannot know about a company
that reported an hour ago, and those rows sit at the top of the table. The Worker resolves unknown
codes against the price feed per cache window (bounded at 40) and merges them, so the newest rows
are not also the emptiest ones.

**Market cap is computed, not stored.** The ticker map holds the share count; the browser multiplies
by the current price, so the column is correct now rather than as-of the last refresh.

**What this feed does NOT give you:** only the latest quarter (no history), and only three figures
per company — revenue, gross profit, net profit. That is why the Earnings Hub no longer carries the
15-rule quality score: running a real model on three inputs, or on synthetic ones next to live data,
would have been worse than not scoring at all. `js/scoring/earnings-scoring.js` remains as code,
but the mock set is test-only. Breakouts → Earnings Surprise now explains the missing analyst
estimates and links to real results/documents. Connecting PDFs does not enable the score.

---

## 5c. The Con-call tab: one screen, someone else's analysis

The tab is the StockScans con-call scan — every earnings call held this quarter with **their**
result score (0–100), **their** sentiment tier and **their** highlight bullets — plus the schedule
data retained in the feed. The visible section heading deliberately omits both the Upcoming
Concalls control and the Live/call-count chip so the scan table starts cleanly.

**Reproducing someone else's analysis is allowed; blurring whose it is, is not.** The rules, in
full in CLAUDE.md: do not re-band or recompute their score, say whose it is on every surface
including the exported workbook, render `pending` rather than zero for a call they have not
analysed yet, and link to their reader rather than reproducing their summaries.

**It used to be six sub-views behind a left rail**, four of them running on a 2MB synthetic transcript
corpus with fictional speakers, because no open source publishes full transcript text. That put a
live half and a synthetic half in one tab, separated by an amber ribbon on one side and a green
pill on the other. The four are gone — the tab has one source, no picker and no ribbon. The keyword
engine and the old Deep Dive workspace live on in git history and would come back if BSE's filed
transcript PDFs were ever wired, pointed at real text.

### The Deep Dive column — a third party we can spend money on

The last column hands one company to **Concall Deep Dive**, a separate Cloudflare Worker running
its own LLM pipeline over that call. We dispatch, mirror its progress in its own words, and lay
out the report it returns. `js/data/deep-dive.js` is the transport, `js/concall/deep-dive.js` the
panel; full contract in `docs/DATA-CONTRACTS.md`.

Five things to know before touching it:

- **The URL is `window.SATTVA_DEEPDIVE_URL` in `public/index.html`**
  (`https://concall-sattva.tech-441.workers.dev`). That Worker has no custom domain, so the
  address is assigned rather than derivable. `localStorage['sattva:deepdive-base']` overrides it,
  which is how `verify-ui.mjs` runs the whole suite against a stub.
- **Their `POST /api/analyze` is unauthenticated and every accepted call costs a real run.** That
  is a known gap on their side, not something this dashboard can fix from the browser — an
  anonymous reader clicking through an 877-row table would be spending the owner's money, and the
  URL is now in the page source. **Put auth on that endpoint** — a shared secret, an allowlisted
  origin, a rate limit. Everything on this side (confirm step, no auto-dispatch, reattach instead
  of re-run) is courtesy, not a control.
- **Reads are free, and the column uses that.** `GET /api/summary` lists the reports they already
  hold; it is fetched once per page load and the rows it names get a filled *Deep Dive ✓* button
  that opens the report at no cost. Making a reader pay to discover an answer already exists would
  be the other half of getting this wrong.
- **A finished report is kept on this device, and that is about money rather than bytes.** Their
  store drops a report after about a fortnight; ours does not. Every finished report goes to
  IndexedDB under their slug (`KEYS.deepDiveReport`), with a small localStorage index so the table
  can mark the free rows synchronously. Reopening paints from there with **no request at all** and
  re-checks behind it, and a re-check that fails — including `unknown`, which is their expiry —
  leaves our copy exactly where it is. Before this, that expiry sent the reader to the confirm step,
  so the only way back to an analysis already read was to pay for it again. The ribbon says which
  copy is on screen and when it was last confirmed, because a stored paint may not claim a freshness
  it has not got.
- **The report is theirs end to end.** Nothing on that panel is computed or re-scored here; it
  renders sections in their own key order, lays each out by its shape rather than by a hard-coded
  field list, and links to their own rendering. It also carries real transcript quotes from named
  people — real speech, lifted by their pipeline, with the filed transcript linked in the
  provenance strip. And it checks that the report it received is about the company whose row was
  clicked, rather than assuming — a check that now also gates what may be written to the store, so
  a contradicting report can never be served from disk under our ticker.

---

## 5d. Superstar Investors: real books behind a credential

The whole sub-view is live off the Ticker Finology super-investor API, proxied by this Worker. It
replaced a synthetic set of the same shape — real names, invented positions — and the amber ribbon
went with it, because there is no longer anything on that panel to label.

**The token lives on the Worker.** That API is the only upstream here that needs
`Authorization: Bearer …`, and a token in front-end code is a token published. `worker/finology.mjs`
injects `env.MUNS_TOKEN`; nothing under `public/` has ever seen it, and `verify-ui.mjs` asserts both
halves — no credential in any served file, and no request from the browser to that host.

```bash
npx wrangler secret put MUNS_TOKEN     # production
echo 'MUNS_TOKEN="…"' >> .dev.vars     # local, gitignored
```

`env.MUNS_BASE` redirects the upstream, which is how a verification run drives the whole path
against a stand-in instead of scraping their production.

**And there is now a second way that credential can arrive — the reader's own.** This dashboard is
embedded in the Munshot host, which hands the browser the signed-in reader's session JWT over the
SDK channel; the browser sends it on our same-origin `api/…` routes, and `withCallerToken()` in
`worker/muns.mjs` uses it to fill an **absent** `MUNS_TOKEN`. A configured secret always wins, so
the block above is unchanged for any deployment that has one. What it removes is the case where the
secret was never installed: `no-token` is a hard failure on screen — News, Announcements, Insider
Trades, stock search, the investor books and Ask Research all show nothing — and clearing it needed
an operator in the Cloudflare dashboard. A signed-in reader now clears it for themselves.

Two things that follow, and neither is optional:

- **It does not replace the secret for anything unattended.** A GitHub Action has no host and no
  reader, so every scheduled scrape still needs `MUNS_TOKEN` in the repository's secret store. The
  same is true of the Worker's own `scheduled()` handler.
- **These routes share URL-keyed edge-cache entries**, which is safe only because every upstream
  behind them returns market data — the same filings and books whoever asks. A future route whose
  response is specific to the caller must not be given that env; read the note above
  `withCallerToken` before adding one.

The Superstar surface is split into three in-page tabs in this order: **All Investors** for the
card directory, **Quarterly Changes** for the six cross-book summaries, and **Data Table** for every
disclosed investor-company position. Data Table retains the wide quarter history, search,
investor/change filters, watchlist control and Excel export; do not put that table back underneath
the directory cards.

**Three things about the data that are easy to get wrong:**

- **A blank quarter is not a zero.** Indian companies name only holders above a threshold, so a
  real position below it is invisible in the filing. `null` travels to the cell, renders as a dash
  and stays out of every total. A position disappearing is *"no longer disclosed"*, not *"sold"*.
- **`valueCr` is Finology's, not ours.** A filing states a percentage, never a rupee amount. The
  column is headed *Value (Finology)* — same relation Institutions has with Trendlyne's value.
- **One figure is computed here**: the quarter-over-quarter change, headed *Change (derived)*.
  Neither a new position nor a vanished one carries a percentage-point figure, because printing
  ±the whole holding would invent a trade size.

Every company row in **Quarterly Changes** is a button. It opens a cross-investor popup containing
all tracked books that disclose that company in their own latest/prior comparison, not merely the
one or two abbreviated names on the card. The table shows status, both stakes, the derived change
and Finology's current position value; the value is explicitly not presented as a traded amount.

**A caught bug worth remembering.** The card count used the latest quarter and the book total used
all of history, so an investor with nothing currently disclosed rendered `0 holdings` beside
`₹793 Cr book`. Both now describe the same set — `summarise()` in `finology-shared.js` — and the
suite asserts the two can never diverge again.

**Failure states are named, not blank.** `no-token` and `unauthorised` are an operator's problem
and the panel prints the command that fixes them; `unreachable` / `upstream` are a service's. A
failed book shows "could not be read", never an empty one — those must never look the same.

**And a second caught bug, this one about speed.** The view is ninety-one requests: the list, then
one page per book. Four things were wrong at once, and the reader felt all of them as "this is
slow", or — when the upstream flapped — as a wall of prose where the grid should be:

| What | Was | Now |
| --- | --- | --- |
| Edge cache on the two routes | documented, never implemented — `caches.default` was untouched, so every reader made the upstream scrape finology.in 91 times | `investorRoute` in `worker/index.js` reads and writes it, 6h; `x-sattva-cache` reports which |
| Upstream down | nothing shown at all | a `last-good` copy served as `stale: true` with its original `fetchedAt`, under an amber strip that says so |
| Retry budget | 15s × 3 attempts = **46.6s** before the panel could speak, under a comment claiming "a couple of seconds" | 6s × 2 under an absolute 13s `DEADLINE_MS`; the failure is cached for 15s so the other 90 books do not each pay it |
| Return visit | re-asked all 91 books inside a window in which the server had nothing new to say, and rebuilt the whole panel once per arriving book | asks only for books unconfirmed inside the current window (**1 request**), repaints on a trailing throttle (**2 rebuilds, not 14**, on a 12-investor stand-in) |
| First visit | 91 requests, four at a time — most of a minute of the grid filling in, and no device cache can help a reader who has never opened the tab | a **committed snapshot** of every book, `public/data/super-investors.json`: 414KB, 69KB over the wire, one conditional GET, **grid complete in ~1.1s with zero per-investor requests** |
| Any visit | confirmed all 91 books in the background, whether or not anyone asked | **one** request — the investor list, which is the only thing a snapshot cannot answer. Re-reading the books is the Refresh button's job; see `js/core/refresh.js` |

The last two rows are the ones to be careful with: speed there is bought by *not asking*, so it is
only honest because `meta().origin` distinguishes `snapshot` / `store` / `live`,
`meta().checkedAt` reports the **oldest** confirmation on screen rather than the newest, and the
global header's Refresh button discards every confirmation. Superstar Investors deliberately adds
no duplicate cache, scope or loading tag. `verify-ui.mjs` asserts all of it — and the snapshot half
needs no Worker to check, because it is a committed file.

**How often a book is re-asked comes from the filing calendar, not from a number of hours.** A book
is assembled from shareholding patterns companies file once a quarter: within 60 days of a quarter
end the window is 24 hours, outside it 30 days, and a confirmation older than the most recent
quarter end is **always** re-asked whatever the elapsed time says — otherwise a long hold could
straddle a quarter boundary and serve last quarter's book into the new one.

Refresh the snapshot with `node scripts/scrape-super-investors.mjs`. It reads **this dashboard's own
Worker**, not Finology, so it needs no token, and it refuses to write below 80% coverage — a
snapshot that is mostly missing gets painted and its gaps read as the whole book.

Reproducing any of this needs a stand-in behind `MUNS_BASE` that can be told to 503 or hang —
without one the whole block skips, which is exactly why the missing edge cache survived so long.

---

## 6. The honesty rules

These are why the dashboard can be trusted, and they are not style preferences.

1. **Never fabricate a number to fill a component.** No feed → `pendingPanel()`, and drop the
   ranking grid rather than ranking nothing.
2. **Signals are direct readings**, not modelled judgements. A points-based score appears only once
   its model exists and is documented in `js/scoring/rule-meta.js`.
3. **Label derived figures as derived.** Super Investors' holding value is `holding % × market cap`
   and the drill says so — filings disclose a percentage, never a rupee amount.
4. **Every `?` modal states what is mock and what is live.**
5. **Synthetic numbers are unmistakable wherever they surface** — ribbon or pill, freshness card,
   drill note, Sources row, **and row 1 of every exported workbook**. A number that leaves the
   dashboard carries its provenance with it; a spreadsheet is the one artefact nobody can see a
   ribbon on. Decluttering may move the *explanation* behind a control; it may never move the
   *claim*, which stays on the face of whatever replaced the ribbon.
6. **Attribution.** Synthetic *numbers* about real subjects are fine when labelled. Synthetic
   *speech, views or rationale* attributed to a named real person never are, at any labelling level.
   So: con-call speakers, sell-side analysts and forum/Telegram handles are **fictional**; super
   investors are **real people with synthetic positions**, and those files carry numbers only — no
   `rationale`, `quote` or `thesis` field exists to be misread as something they said.
7. **A UI must not imply persistence it does not have.** CSV import applies to memory and says so —
   there is no server to write `transactions.json`, and letting a user's work vanish silently on
   reload would be worse than refusing the feature.

---

## 7. Deploy — and a mismatch worth naming

**This repo deploys as a Cloudflare *Worker with static assets*, not as Cloudflare Pages.**

```jsonc
// wrangler.jsonc
{ "name": "sattva-central-research", "compatibility_date": "2026-05-23",
  "main": "worker/index.js", "assets": { "directory": "./public", "binding": "ASSETS" } }
```

```bash
npx wrangler deploy
```

**The `name` must match the deployed Worker**, which is
`sattva-central-research.tech-441.workers.dev`. It read `sattva-central` for a long time while the
live Worker was `sattva-central-research`, and that is a quiet trap rather than a loud one: both
`wrangler deploy` and `wrangler secret put` would have addressed a *second*, empty Worker of that
name, succeeded, and left the real site untouched. A secret in particular looks perfectly set that
way — it is just set somewhere nothing reads it.

There is no `functions/` directory, no `_routes.json`, no `public/_headers`, no `_redirects` and no
`pages_build_output_dir` — none of the Pages conventions are present, and none are needed. If you
have been told this is a Pages project, that is the mismatch: it is a Worker. `worker/index.js`
serves `env.ASSETS` and adds one API route, `POST /api/live-prices`; anything else under `/api/`
returns 404 rather than falling through to an asset.

Two things that follow:

- **No SPA fallback is required.** Routing is hash-based (`/#/research/breakouts/strong-breakouts`), so every
  deep link is served as `/` and there is nothing to rewrite.
- **Adding a header or a cache rule means editing `worker/index.js`**, not dropping a `_headers`
  file — that file would simply be served as a static asset and do nothing.

**Two optional CDN hosts are used by the browser**: Google Fonts and `cdn.jsdelivr.net` (ExcelJS,
loaded on demand only when someone exports). If Google Fonts is unavailable the dashboard uses its
system fallbacks; if ExcelJS is unavailable export cannot start. Tailwind is a same-origin static
asset and must never depend on a runtime CDN compiler.

Every `data/*.json` path the app fetches at runtime resolves to a file that exists in `public/`;
that is worth re-checking after any data change, because a 404 there is invisible until a tab mounts.

---

## 8. Performance — measured, not asserted

Measured with Playwright on the vendored local copy, medians of 7 runs.

| View | Warm in-app render | Cold mount (fetch + compute) |
| --- | --- | --- |
| Breakouts scanner — 535 scored rows painted | **119 ms** | 4.1 s (763 KB + 568 KB + 535 × 16 rules) |

Also: header sort on 535 rows **30 ms**; search repaint **3 ms**; JS heap after visiting six tabs
**23 MB**.

Four things keep `scoreTable` fast at 500+ rows — keep them if you touch it:

- listeners are **delegated** on `<thead>` / `<tbody>`, never per row;
- row markup is **position-independent** (rank comes from a CSS counter) and cached by key;
- a repaint whose row set the DOM already contains **moves existing `<tr>` nodes** instead of
  re-parsing HTML;
- the first paint carries a **screenful**, and the rest streams in while the browser is idle.

### Switching tabs, and a profile that pointed at the wrong thing

The table above is the *warm render of a 535-row tab*. The Earnings Hub is 1,722 rows and it was a
different story: **866–1,536 ms of blocked main thread on every mount**, on a table the reader had
already seen. A CPU profile attributed 606 ms of it to `segmentedToggle`'s `position()` — the scope
toggle in the header — which reads `offsetLeft` to place a sliding thumb.

That is not where the cost was. Reading `offsetLeft` forces a **synchronous layout**, and the layout
it forced was the 1,722-row table that had just been written into the document. The toggle was
simply the first thing to touch the DOM afterwards. Add ~350 ms of string building for ten formatted
columns and the entire mount cost was the table, charged to an innocent bystander.

**When a profile blames a component that plainly cannot be doing that much work, look for what it
forced.** Layout, `getBoundingClientRect`, `offsetWidth`, `scrollHeight` and `getComputedStyle` all
flush pending work and get billed for it.

The fix is that `scoreTable` now paints 40 rows and appends the rest in adaptive slices capped at
80 rows under
`requestIdleCallback`. Nothing is unmounted — every visible row still reaches the DOM, so Ctrl-F,
screenshots and the accessibility tree are unaffected — and the section carries `data-rows-pending`
until the fill completes, which is what `verify-ui.mjs` waits on instead of racing it.

| Tab-to-tab switch | Before | After |
| --- | --- | --- |
| Earnings Hub (1,722 rows) | 866–1,536 ms | **36–90 ms** |
| Con-call (1,018 rows) | 393–950 ms | **69–126 ms** |
| Breakouts (603 rows) | 299–652 ms | **56–83 ms** |
| Longest task during a switch | 425 ms | **75 ms** |

A second Chrome DevTools trace found the browser-side Tailwind compiler consuming **285ms** on tab
markup and the scope toggle forcing **114ms** of layout through `offsetWidth` / `offsetLeft`.
Tailwind is now the committed `public/css/tailwind.css`, and the equal-width scope thumb moves by
index without measuring the document. On the same localhost trace: cold LCP **237ms → 159ms**, tab
INP **77ms → 39ms**, and Public Chatter route LCP **690ms → 89ms**; CLS stayed good at 0.02. Those
are controlled lab results, not field telemetry.

The heavy feeds are **lazy**: technicals, the con-call corpus, the chatter files and the price
history load when their tab first mounts, not at bootstrap, so eight tabs never pay for data they
do not read.

### And the bootstrap only blocks on what the first paint needs

`app.js` used to await seven files — **~825 KB** — before the shell rendered anything, including a
347 KB shareholdings file read by one sub-view and a 232 KB mock corpus read by one other. It now
blocks on **one**: `portfolio-companies.json` (31 KB), the book, because `coverage` backs the scope
toggle and every research tab reads it synchronously. The rest start at the same moment and are
awaited by their own consumers — `whenDeferredData()` in Breakouts → Earnings Surprise,
`filed.load()` in Institutions. The ledger and its 290 KB equity-curve history were part of that
deferred set and are now deleted outright, so nothing fetches them at all.

A related duplicate: `universe.json` and `mc-ticker-map.json` were each fetched twice per session by
two different modules. Concurrent requests cannot revalidate against each other, so both downloaded
in full — 163 KB and 249 KB, twice. `revalidatedJson` now shares the in-flight promise per path.
Measured on a cold visit: **3,605 KB → 3,035 KB**, and the blocking set went from 825 KB to 31 KB.

### Bytes, which were the real problem

Lazy loading fixed *when* the big files load. It did nothing about *how often*. Every loader used
`cache: 'no-store'`, which forbids reuse outright, and the two polled feeds — 1.1MB of results and
450KB of con-call scans — were re-fetched in full every 30 seconds to discover that nothing had
changed. One open Earnings Hub tab pulled **1,135KB per tick, about 136MB an hour.** Measured, not
estimated: the poller was traced ticking at t+4.5s, t+36.5s, t+69.1s, each a full download.

| | Before | After |
| --- | --- | --- |
| Earnings Hub — cold visit | 2,388 KB | 2,388 KB |
| Earnings Hub — reload | ~2,300 KB | **5 KB** |
| Earnings Hub — one poll, nothing changed | 1,135 KB | **0.3 KB** |
| Con-call scans — reload | ~3,400 KB | **5 KB** |
| Con-call scans — one poll, nothing changed | 452 KB | **0.3 KB** |

Three mechanisms, described in full in *Conditional delivery and the device store* in
`docs/DATA-CONTRACTS.md`: a content ETag on every route with a bodyless 304; an IndexedDB copy on
the device so first paint costs no network at all; and a prices-only projection for the results
feed, which is the one place a 304 buys nothing because the traded price really does change every
tick.

Two traps worth carrying forward:

- **Hash content, never delivery.** A tag that includes `fetchedAt` changes on every request while
  the payload does not, so the 304 never fires and the optimisation silently does nothing while
  appearing to be wired. The test that catches it is a tag that survives an edge-cache expiry.
- **Do not send `If-None-Match` by hand.** Chromium aborts the resulting 304 with
  `net::ERR_ABORTED`; pollers swallow optional errors, so the symptom is not an error but a feed
  that quietly stops updating. Use `cache: 'no-cache'` and let the browser send the validator.

---

## 9. Known gaps

These are recorded in `docs/SPEC.md` under each tab's "Still to come". They used to be listed in a
dashed **Wiring roadmap** card closing every tab; that card is gone from the UI, so the spec is now
the single place a gap is written down. The ones that matter most:

- **Analyst consensus and structured financial history are not connected.** Earnings Surprise is
  unavailable. Domestic company filings supply document links, not the missing scoring inputs.
- **Domestic filings can list periods without document links.** Preview reads verified all four
  forms against the authenticated service. Null source slots are shown as unavailable links;
  genuinely unfamiliar entries still trigger a partial-response warning. Source links can open
  report pages rather than direct PDFs; the dashboard does not extract their contents.
- **The live earnings feed is an undocumented third-party API.** It is stable-shaped, CORS-open, has
  no auth and no bot wall, and `worker/mc.mjs` validates the payload's own header block so a column
  insertion fails loudly rather than shifting every field. But it can change without notice; the
  snapshot fallback is what stops that from blanking the tab.
- **The super-investor token is a deployment secret with no rotation story.** `env.MUNS_TOKEN` is
  set by hand with `npx wrangler secret put MUNS_TOKEN`, and the API documents it as a *session*
  token. If it expires the view says so by name and names the command that fixes it — it does not
  fall back to stale or invented positions — but nothing renews it automatically. A long-lived
  service credential would be the better shape.
- **The Deep Dive endpoint is unauthenticated and metered.** `POST /api/analyze` on the Concall Deep
  Dive Worker has no auth and CORS is open, and every accepted call starts a real LLM run. This page
  therefore never dispatches without an explicit click and a confirm step — but that is a courtesy,
  not a control: anyone who learns the URL can spend against it from anywhere, with or without this
  dashboard. The fix belongs on that Worker (a shared secret, an allowlisted origin, a rate limit),
  and it should land before that URL goes anywhere public.
- **There is no ledger, by decision rather than omission.** Portfolio Analytics and its synthetic
  transactions are deleted (§2, §5); the only portfolio data here is the book of 142 company names.
  A real ledger would be a new product decision — quantities, costs and a source for both — and the
  FIFO engine to build it on is in git history at `d3bba30`.
- **Nineteen book lines can never appear on a feed here**, and three of them are a genuine loose
  end rather than a structural one: String Metaverse, Nisus Finance Services and Future Supply Chain
  Solutions resolved to no symbol on either exchange. The first two most likely trade under a
  changed name; the third was delisted after insolvency. The other sixteen are structural — unlisted
  companies, warrant lines, the Vedanta demerger entities and five BSE-only listings, and only a
  BSE-keyed feed would fix that last group.
- **`TATAMOTORS` has no price data at all** — Yahoo 404s the symbol, almost certainly because of the
  demerger. It is recorded in the technicals scrape's `failures[]` and shown as a flagged row rather
  than a zero-scored one. Fixing it means finding the right symbol, not hiding the company.
- **No test runner.** `scripts/verify-ui.mjs` is the suite: several hundred Playwright assertions
  including the book's completeness, the scope denominators, the overlay focus traps and the check
  that every deleted ledger module 404s on the served site. Run it before every push, with
  `verify-research.mjs`, `verify-sdk.mjs`, `verify-calendar.mjs` and `verify-bars.mjs`.
- **No CSP.** Adding one means allowing the Google Fonts and on-demand ExcelJS hosts, in
  `worker/index.js`; Tailwind is same-origin.

---

## 10. Before you push

```bash
python3 -m http.server 8080 -d public
node scripts/verify-calendar.mjs
node scripts/verify-research.mjs
node scripts/verify-ui.mjs
```

The bar is **zero console errors** and every check passing. Beyond what the script covers, eyeball:
the layout at 1440 / 1024 / 390 px with no sideways page scroll, the Portfolio/Universe toggle
visibly changing what every tab reports, and a reload restoring the same route and scope.

A plain `http.server` has no `/api/*`, so the caching checks report **SKIP** rather than passing
vacuously — which also proves the snapshot fallback still works with no Worker at all. To exercise
them, serve the site through the Worker (`npx wrangler dev`) and point the suite at it:
`node scripts/verify-ui.mjs http://127.0.0.1:8787`. **A SKIP on those lines is not a pass**; the
caching path has to be verified against a Worker before shipping a change to it.

And the rule that outranks the rest: **if a number cannot be traced to a source, it does not ship.**
