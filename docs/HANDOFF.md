# Handoff

Everything a new maintainer needs to run, extend and trust this dashboard. `CLAUDE.md` is the
working contract, `docs/SPEC.md` is the product, `docs/DATA-CONTRACTS.md` is every JSON shape.
This file is the map between them, plus the things that are only obvious once you have been bitten.

---

## 1. What this is

A static research and portfolio dashboard for Indian equities. Vanilla ES modules, no build step,
no bundler, no npm dependency for the app itself. You open `public/index.html` and it works.

```bash
python3 -m http.server 8080 -d public     # that is the whole dev setup
```

Two workspaces, thirteen tabs:

| Workspace | Tabs |
| --- | --- |
| Research Central | **Daily Alerts** · Earnings Hub · Con-call · Public Chatter · Breakouts / Technical · Super Investors · News · Corp Announcements · Insider Trades |
| Portfolio Analytics | Overview · Position By · Transaction History · Drawdown |

**Daily Alerts is the landing tab.** It has no data source of its own: it re-reads **four** of the
tabs above — Breakouts / Technical, News, Corp Announcements, Insider Trades — filters them to
today's Indian trading date, and prints one stream: red for a price fall past 5%, orange for
anything else that arrived. The Earnings Hub, Con-call, Public Chatter and Super Investors are
deliberately not folded in, and the page says so. See §4c.

**Three scopes, not two**: Portfolio (the book) · Watchlist (companies the reader starred) ·
Universe. Portfolio is the default. See §5a.

---

## 2. What is live and what is mock — the honest inventory

This is the first thing to check before quoting any number off a screen.

### Genuinely live — scraped on a schedule, from a real source

| Feed | File | Source | Cadence |
| --- | --- | --- | --- |
| Technicals: OHLCV, indicators, delivery %, FII/DII deltas for the NSE 500 | `public/data/technicals.json` (763 KB) | Yahoo Finance EOD + NSE delivery | Weekdays 07:00 IST |
| ATR history for the ATR-stability rule | `public/data/atr-history.json` (568 KB) | Same scrape | Weekdays 07:00 IST |
| **Three years of daily closes for every portfolio ticker + the Nifty 500** | `public/data/portfolio-history.json` (284 KB) | Yahoo Finance | Weekdays 07:00 IST |
| **Quarterly results for the whole listed universe** — 1,319 companies | `GET /api/earnings` (live) + `public/data/earnings-live.json` (snapshot) | Moneycontrol Rapid Results | **Live: 30s edge cache, 30s client poll** |
| **Every earnings call held this quarter** — 877, with StockScans' result score, sentiment tier and highlight bullets | `GET /api/concalls` (live) + `public/data/concall-scans.json` | StockScans | **Live: 30s edge cache, 30s client poll** |
| **Retail chatter** — mentions and sentiment across ValuePickr, TradingQnA and Google News, 219 entries over a rolling 30 days | called direct from the browser, **not** proxied — see §5e | SentimentDash | **Live: twice daily upstream (01:30 / 13:30 UTC), hourly client poll** |
| **Market-wide stocks news** — every story Moneycontrol publish to `/news/business/stocks/`, 600 held | `public/data/market-news.json` (406 KB) | Moneycontrol, read with `curl` from a GitHub runner — **neither the browser nor the Worker can fetch this host** | Every 30 min in Indian hours, hourly outside (measured — see `docs/DATA-CONTRACTS.md`), **and on demand from the tab's Fetch button** |
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
20-minute run is unaffected because its cron does not go through this route. The free *Check for new
stories* button beside it works either way. Full contract in `docs/DATA-CONTRACTS.md`.

**Known upstream fault, live now.** Moneycontrol's results-calendar count endpoint
(`indexId=N`) started answering `0` for every date on 14 Aug 2026 — a 200 with `success: 1` and
zeros throughout, not an error. The Worker now falls back to the committed capture's counts and
labels them, so the strip reads 171 / 225 / 258 / 235 rather than a row of em dashes. `indexId=B`
(BSE) is unaffected and is deliberately **not** substituted: it is a different universe. If the NSE
index recovers, the fallback stops firing on its own — nothing needs undoing. See *When the count
endpoint goes flat* in `docs/DATA-CONTRACTS.md`.

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

**The synthetic institutions and Fund Flows are gone**, along with `js/data/investors.js`,
`js/investors/deep-dive.js` and `gen-mock-investors.mjs` — see *The synthetic investor set* in
`docs/DATA-CONTRACTS.md`. Every number on the Super Investors tab is now somebody's disclosure.

### Real, but refreshed by hand

| Feed | File | Notes |
| --- | --- | --- |
| The coverage universe | `public/data/universe.json` | The actual NSE-500 Screener export, 535 companies. Names, tickers, sectors and market caps everywhere else in the app come from here. |
| **The book** — what the Portfolio toggle means | `public/data/portfolio-companies.json` | The family office's direct-equity statement as at 30 Jun 2026: **142 companies, names and sectors only**, resolved to NSE symbols by `scripts/resolve-portfolio-companies.mjs`. This is what every research tab's Portfolio scope filters by. It is **not** the ledger — see §5a. |

### Real, but produced only when the reader asks for it

| Feed | Where | Notes |
| --- | --- | --- |
| **Concall Deep Dive** — a per-company report on one call | The **Deep Dive** column on the Con-call tab | A separate Cloudflare Worker runs its own LLM pipeline and returns the report; this dashboard triggers it, mirrors its progress and lays out the result. Nothing is stored in `public/data/` and nothing is committed. Reading the reports they already hold is free and happens once per visit; **starting a new run costs real compute**, so that never fires without a click and a confirm. See §5c. |

### Mock — placeholder data shipped so the shell has something to render

`public/data/mock/`: earnings, the earnings calendar, super-investor and institutional holdings,
fund flows, and the transaction ledger. (The synthetic ValuePickr and Telegram chatter is gone —
Public Chatter is live; see §5e.) All generated by seeded scripts in `scripts/`, so regenerating produces a byte-identical
file and a diff means a real change.

### The one surface that mixes both inside a single number

**Portfolio Analytics.** The ledger is synthetic — *which* trades were made and *when*. Everything
priced in it is real:

- every execution price is an actual Yahoo close for that ticker on that trading day;
- every position is marked to market from the live technicals feed (`cmp`);
- the equity curve is 735 trading days of real closes, and the drawdown is computed from it.

A flat "mock data" ribbon would understate those numbers and a "live" badge would overstate them,
so the disclosure is split — the ledger is illustrative, the marks are live — and every sub-view
carries it as a pill in its section head reading *Illustrative ledger · live marks*, amber, with the
full explanation in the modal one click behind. With no mark the same pill turns rose and reads
*Marks unavailable · shown at cost*, because a P&L of zero for want of a price must not look like a
P&L of zero for want of a move. `provenancePill()` / `headMeta()` in `js/portfolio/chrome.js` render
it; `exportBanner()` still puts the whole disclosure in row 1 of every workbook.

This replaced a four-line amber ribbon at the top of all four sub-views. It was accurate and it was
the first thing anyone saw on the workspace, above the money, every view — at which size a caveat
stops qualifying the content and starts warning about it.

---

## 3. Running and refreshing

```bash
# serve
python3 -m http.server 8080 -d public

# verify (Chromium is preinstalled — never run `playwright install`)
node scripts/verify-ui.mjs                      # ~180 checks, exits non-zero on the first failure

# refresh the live feeds
node scripts/scrape-technicals.mjs              # TECH_LIMIT=15 for a smoke run
node scripts/scrape-portfolio-history.mjs       # HISTORY_YEARS=5 to widen the window

# re-import the AMC portfolio workbooks (committed under scripts/fixtures/)
node scripts/import-amc-portfolio.mjs           # merges in; leaves the Trendlyne funds alone

# regenerate the seeded mock sets (all deterministic)
node scripts/gen-mock-earnings.mjs
node scripts/gen-mock-transactions.mjs          # also rewrites portfolio.json's derived fields
```

### The one bootstrap deadlock

`scrape-portfolio-history.mjs` derives its ticker list from `portfolio.json` **and** the ledger.
`gen-mock-transactions.mjs` prices its trades from the history file. So a ticker about to enter the
ledger is in neither yet, and the two scripts wait for each other. Break it once:

```bash
EXTRA_TICKERS=ASIANPAINT node scripts/scrape-portfolio-history.mjs
```

After that the ledger names the ticker and a plain run picks it up.

---

## 4. Architecture in one page

```
public/index.html          design tokens, fonts, Tailwind CDN, #app, three overlay roots
                           (drill z-50 < workspace z-55 < modal z-60)
public/js/
  app.js                   bootstrap: fetch the small JSON set once, prime the data modules, mount
  core/                    state · router (hash) · live (polling) · store (IndexedDB cache) · format · dom
                           watch.js — app-wide feed watchers behind the alert stack (§4b)
  ui/
    screener.js            THE KIT: statStrip · topCards · scoreTable · openDrill · openWorkspace
                           · openModal · sectionHead · pendingPanel · trapFocus
    visual.js              avatars, tiers, status pills, signal dots, legend
    sources.js             the Sources-modal registry — the honest status of every feed
    notifications.js       the lower-right live alert stack (§4b)
    export.js              exceljs-from-CDN "Export Excel"
    shell.js               header, tab bar, sub-view picker, the WORKSPACES registry
  data/                    one module per feed: load once, compute once, cache, expose accessors
                           coverage.js — THE BOOK: what the Portfolio scope filters by (§5a)
                           scope.js — the three scopes in one place; every forScope() asks it
                           daily-alerts.js — today's readings, taken across four tabs (§4c)
                           chatter-live.js + sentiment-shared.js — retail chatter (§5e)
  scoring/                 tech-scoring (16 rules / 24 pts) · earnings-scoring (15 / 21) · rule-meta
  concall/                 scans.js — the whole Con-call tab: the live scan table and the
                           "Upcoming Concalls" schedule overlay
                           deep-dive.js — the panel behind the Deep Dive column (a SEPARATE
                           dashboard's pipeline and a SEPARATE dashboard's report)
  portfolio/               lots (FIFO) · chrome (shared furniture) · the four sub-view modules
  tabs/                    the Research Central tabs
                           daily-alerts.js — the landing tab: today, consolidated (§4c)
worker/
  index.js                 asset serving + the four /api routes
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

---

## 4c. Daily Alerts — the landing tab

Every other tab here is organised by SOURCE: this is what the results feed holds, this is what BSE
filed, this is what the technicals scrape measured. That is right for research and wrong for the
first thirty seconds of a morning, when the question is not *what does Moneycontrol have* but *what
happened, and does any of it need me*. Daily Alerts is organised by DAY.

`js/data/daily-alerts.js` takes the readings; `js/tabs/daily-alerts.js` draws them. **It adds no
data source** — every row comes from a feed that already has its own tab, filtered to today's
**Indian trading date** (a UTC date names yesterday for the five and a half hours after 18:30 IST,
which is exactly when someone opens an alerts page).

**Four tabs, and it names the ones it leaves out.** Breakouts / Technical, News, Corp Announcements,
Insider Trades — News twice, because that tab is two feeds behind one name. The Earnings Hub,
Con-call, Public Chatter and Super Investors are deliberately not consolidated, and the description,
both modals and the Sources entry say so: an absent earnings row has to read as a decision, not as a
fault. Adding one back is an entry in `FEEDS` plus a collector.

**The two colours are measurements, not opinions.**

| | Means | Set by |
| --- | --- | --- |
| **RED — alert** | a direct negative reading on the row itself | across these four tabs there is exactly one: **the price fell more than 5% at today's close**, from the end-of-day scrape behind Breakouts |
| **ORANGE — update** | something arrived today | everything else |

Every red row prints the reading that made it red. A colour whose cause is not on screen beside it
is a judgement, and this dashboard does not make those.

**The other three tabs are never red**, and it is the same rule from the other side. *Insider
trades* carries no model at all — "no sentiment, no materiality flag" — because its columns are the
upstream's own and unknown at build time, and deciding that "Pledge" is red *is* a materiality flag
however obvious it looks. *Corporate announcements* are BSE's filing taxonomy, not a verdict. A
*news* headline is editorial, and reading a sentiment off it would put a model this dashboard does
not have over somebody else's words. All three print the upstream's own wording instead.

So **a quiet day is a page of orange**, which is the honest rendering rather than a page with
something missing — and the alert card's explainer says where the model-bearing feeds went. The
threshold is the whole rule, so it is exported as `moveSeverity(pct)` and asserted directly by the
suite: the shipped 31 Aug snapshot has seven moves past 5% and not one of them down, so a test that
waited for a red row would never run.

**The coverage panel is the half that makes an empty day readable.** Most of these feeds are
captures committed on a best-effort schedule, so a bucket with nothing in it has two completely
different meanings — *nobody filed*, and *nothing has looked at today yet*. `Feeds read for this
day` states, per feed, when it last looked and whether that reaches today, and a feed nobody has
heard from yet reads **pending**, never "nothing today". Same rule as the filings tabs' *"63
companies have not been checked since"*: never claim nothing is new.

**Nothing on it walks.** The three filings feeds are seeded through `feed.seed()` — the committed
snapshot and this device, no per-company request — which is deliberately separate from `load()` so
that seeding here cannot discard the company list the Corporate Announcements tab will later
refresh with. The header Refresh button re-reads the same files and reports what changed by
**comparing event ids, never counts**: the day rolls over, captures land, stories drop off the end
of a bounded cache, and a count cannot answer "did anything change" for a collection like that.

**Feeds land one at a time and the page follows them.** The first version awaited all eight
together and the landing page sat blank for as long as the slowest — measured at 10–15 seconds on a
static origin, because the chatter API is a direct call to somebody else's service and an
unreachable host takes its own time to say so. Seven feeds that had already answered were held
hostage by the one that had not. Now each settles independently and paints as it lands, coalesced
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
- **The Sources button is gone from the chrome, not from the app** — the pill opens it. Provenance
  has to stay reachable from every screen, and *how current is this* / *where did it come from* are
  one question. `verify-ui.mjs` still opens the modal, now via the pill.
- The refresh button calls `live.refreshAll()` and **reports a result** — `Up to date` or `3 new`.
  A spinner that simply vanishes leaves the reader unsure anything was checked.
- **The global search is gone with the box.** Nothing else used it; a company is reached from its
  tab's own table. If it comes back, `buildSearchOptions()` is in git history at `9c8c911..`.

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

**The tab is one view with two sections**, because their `ticker` is a forum-topic slug
(`tata-motors`, `fiis`, `3b-blackbio-dx`) and entries are discovered bottom-up, so about four
fifths of the list is not something we cover. An entry lands in the first section when its slug
resolves to a symbol in `universe.json`, the book, or `mc-ticker-map.json`. On a real 219-entry
run: **45 covered, 174 not, 8 of them in the book.**

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

## 5a. Two portfolio files, and why they are not one file

The word "portfolio" means two different things here and they are deliberately kept apart.

| | `portfolio-companies.json` — **the book** | `portfolio.json` — **the ledger** |
| --- | --- | --- |
| Answers | *is this company one of ours?* | *how much of it, at what cost?* |
| Lines | 142 | 12 |
| Fields | name, ticker, sector | + qty, avgPrice, conviction tier |
| Read by | `js/data/coverage.js` → every research tab's `forScope()` and the header search | `js/data/portfolio.js` → Portfolio Analytics, the FIFO replay, the equity curve |
| Provenance | real, from the statement | holdings list real; qty/avgPrice derived from a synthetic ledger |

Merging them would break something real. The FIFO replay reconciles against `portfolio.json` and the
suite asserts two identities numerically; widening that file to 142 lines would break both and
invent quantities nobody supplied — the statement was given as names only, with value and weight
explicitly out of scope.

**Nineteen of the 142 carry `ticker: null`, and they are kept.** Five unlisted private companies,
the four Vedanta demerger entities, two warrant lines, five BSE-only companies (every feed wired
here is keyed by NSE symbol) and three whose symbol could not be found at all — String Metaverse,
Nisus Finance Services (an SME line) and Future Supply Chain Solutions (delisted after insolvency).
Each carries the reason it has no symbol and the UI shows it as *held but not covered*. Dropping
them would have made "Portfolio" quietly mean *"the 123 we happen to have a feed for"*, with nothing
on screen saying so.

**Every scoped pill prints the denominator** — *"Portfolio · 123 of 142 companies"*, and
*"Watchlist · 12 of 20 companies"* — because no feed covers the whole of either list and a bare
count invites the reading that it does. The two denominators mean different things and are worded
differently: the book's gap is partly permanent (nineteen lines carry no NSE symbol, so no feed
here can ever show them), while a watchlist entry came *from* a feed, so its gap is only ever
"this particular feed does not carry it". Measured against the
shipped data: **Breakouts 123** (every listed line; 121 score, and the two that do not are recent
listings with too little history), Earnings Hub 103, Con-call 77 held calls plus scheduled, Public
Chatter 4. `coverageNote()` in `js/data/coverage.js` is the one place that sentence is written.

Breakouts is the only one at full coverage, and that is not a coincidence: **it is the one feed
whose input list we choose.** It used to reach 55, because the scrape read the NSE-500 screener
export and nothing else — see §5b. Everywhere else the gap belongs to the upstream: a company is on
the Earnings Hub when it has filed, and on Con-call when StockScans has covered its call. That gap
is theirs to close, and the denominator is how the reader can tell which kind of gap they are
looking at.

To change the book: edit `BOOK` in `scripts/resolve-portfolio-companies.mjs`, re-run it (`--net`
lets it reach Yahoo's symbol search for anything the in-repo feeds cannot match), and commit the
regenerated JSON. It matches exact-then-prefix against feeds already in the repo before going out to
the network, pins ten hand-checked symbols in `CONFIRMED`, pins the not-listed lines in
`NOT_LISTED_EQUITY`, and **fails the run if two book lines resolve to one symbol** — which is how
*Allcargo Global* (`AGL`) and *Allcargo Logistics* (`ALLCARGO`) were caught before one inherited the
other's rows.

---

## 5b. The technicals scrape covers the book, not just the index

`scripts/scrape-technicals.mjs` scrapes the **union** of `universe.json` (the NSE-500 screener
export) and every listed line in the book — 603 companies, `535 + 68`.

It used to scrape the export alone. That made `technicals.json` *the Nifty 500 and nothing else*,
which capped the whole dashboard: a holding outside the index had no price series, so no score, no
Breakouts row and nothing in the global search — and **nothing on screen said the index was the
reason**. Only 55 of the book's 123 listed companies are constituents. The rule this is an instance
of: *a filter nobody chose is still a filter, and an invisible one is the worst kind.*

Three things fall out of it, and each is a trap worth knowing:

- **A book row has no market cap and no FII/DII change**, because there is no screener row behind
  it. They stay null: the market cap is an em dash and the institutional-activity rule scores `na`
  with its full max. A zero there would read as *"no institutional buying"*, which is a claim, not
  an absence.
- **Market breadth is computed over the NSE-500 rows only.** Breadth is a statement about the
  index; folding 68 small- and mid-caps into an advance/decline ratio still labelled "Nifty 500"
  would leave the label true-looking and the number wrong.
- **`TECH_FILL_GAPS=1` scrapes only what is missing** and merges, so adding a name to the book does
  not cost a 600-company re-fetch. It retries `error` rows too (a failure is a gap), drops the row
  it is retrying from the carry-over so a success cannot land beside the stale failure, and carries
  everything else byte-for-byte — including the NSE delivery %, which a gap-fill cannot recollect.
  `partial_refresh` in the payload records that `generated_at` describes the write, not the pricing.

One symbol trap it exposed: **NSE suffixes SME symbols `-SM` and Yahoo does not.** `ALPEXSOLAR-SM.NS`
returns a one-bar stub that looks exactly like a delisting; `ALPEXSOLAR.NS` has 270 bars. The scrape
strips the suffix as a fallback.

Two holdings still carry an `error` rather than a score, honestly: `JAYBEE-SM` is not on Yahoo under
any variant, and `AGL` (Allcargo Global) has 28 trading days of history because it listed on the
demerger — the model needs 60 for its indicators and 200 for the DMA. Both render as flagged rows,
not as zero-scored ones.

---

## 5. The FIFO engine — read this before touching Portfolio Analytics

`js/portfolio/lots.js` replays the ledger once per page load. Two identities must hold exactly, and
`scripts/verify-ui.mjs` asserts both numerically against the shipped data:

1. **`sum(open lot quantities) === position quantity`**, per ticker — and `portfolio.json` agrees.
2. **`realised + unrealised + dividends === total P&L`**, per position, not merely in aggregate.

If either drifts, the position table and the ledger are telling different stories about the same
money and neither can be trusted. The Overview shows the measured residual in a strip rather than
claiming correctness in prose.

Four rules that are easy to break:

- **Charges belong in the basis.** A buy's charges are folded into cost per share; a sell's are
  apportioned across the lots it consumed. The average price you see is what the shares cost.
- **Dividends are income, never a discount on the purchase.** Folding them into the basis would
  quietly improve the average cost and flatter the entry.
- **Corporate actions adjust lots in place** — quantity multiplied, cost per share divided, total
  cost unchanged, **acquisition date preserved**. A zero-price "buy" for bonus shares would reset
  the holding-period clock and misclassify a later sale as short term.
- **Missing input is not zero.** A sell larger than the holding, or an unknown type, goes to
  `book.errors[]`. A position with no live price is marked *at cost*, tagged "at cost", and excluded
  from the curve — marking it at zero would invent a −100% position.

### The back-adjustment trap

**Yahoo's `close` series is back-adjusted for splits and bonuses** — a 2024 price is restated in
today's share terms. Two consequences, and getting either wrong bends the equity curve on a day
nothing happened:

1. A ledger may carry a corporate-action row **only** for an action the price series was adjusted
   for. An invented split on a real ticker doubles the quantity while the series stays put, and the
   curve jumps 100%. This is why both synthetic actions in the mock ledger sit on `TATAMOTORS`, the
   one holding with no price series at all.
2. Where an action row does exist, `dailyPositions()` returns `valuationQtyByDate` — the holding in
   **current share terms** — and the curve values against that. The two corrections cancel exactly.

An earlier draft mirrored a "real" CDSL bonus and would have double-counted it. Checking the series
rather than trusting the recollection killed it: CDSL closes ₹1,718 → ₹1,948 across the supposed
ex-date with no step and no restatement, so no such action is in the window. **Check the data.**

### Two return figures, deliberately

The raw curve rises from ~₹92,000 to ~₹42.6 lakh. That is not a 4,500% return — most of it is money
paid in over three years. So:

- **XIRR** (money-weighted) — what this investor earned, contribution timing included.
- **TWR** (time-weighted) — what the strategy returned, contributions stripped out. **The only one
  of the two comparable to an index**, and the one shown against the Nifty 500.

Likewise there are two drawdowns. Retained cash dampens the total-portfolio figure — correctly, the
cash really is there — but "how far did the stocks fall" is the other question a risk view is asked.
Both are computed, both are labelled, neither is presented as *the* drawdown.

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
clicked. Rows are not clickable. The provenance it carried moved behind the Live pill, which is one
click from anywhere on the page rather than one click per row. If a number wants to be in a drill,
make it a column instead.

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

**The calendar's company list is usually a CAPTURE, and the pill says so.** `api.moneycontrol.com`
is open; `www.moneycontrol.com` is behind Akamai and answers a Cloudflare Worker with a 200 whose
body has no app payload, while answering a laptop or a GitHub runner normally. The list only exists
inside that page. So `scripts/scrape-calendar.mjs` captures it where it works, the Worker prefers a
live read and falls back to the capture, and the tab shows a sky **Captured** pill with the age
instead of a green Live one. The per-date counts stay live in both cases — that is the safeguard:
a schedule that has moved since the capture makes the count and the list disagree on screen.

**The Calendar view is deliberately allowed to be incomplete, and to say so.** Moneycontrol
publishes the per-date COUNT through a clean JSON API (complete) and the company LIST through the
calendar page (the 20 largest by market cap, un-pageable — the route its own "load more" uses is
Akamai-blocked to non-browser clients). Both numbers travel in the payload and both are printed:
"170 companies report on this date… 20 are named here". Full rules in `docs/DATA-CONTRACTS.md`.

**But only for a date still to come.** All of the above is about a *schedule*, and it was being used
to answer questions about the past as well — so walking back through the strip showed twenty names
on the handful of dates the capture reached and an amber "counts only for this date" note on every
other, while the results feed in the very same tab held every filing on those dates with its figures
attached. A date that has already happened is now read from `feed.reportedOn()`: every company that
filed, no cap, no capture age, and no request at all. `modeFor()` picks by the date, bounded by
`feed.dateRange()` so a date *before* the feed's window falls back to the schedule rather than
rendering an empty table that would read as "nobody filed".

The two are never mixed and never subtracted. Companies file a day either side of their announced
date, so "234 due, 210 filed" is not "24 missing", and the pill, the note, the modal and the export
banner each say which of the two questions the rows under them answer.

**A count SMALLER than the rows beneath it is not always a fault.** The strip is `indexId=N` (NSE);
the list is `indexId=All`. On 17 Aug 2026 the count read 1 above three named companies — one NSE and
two BSE-only — and every number was right. The UI declines to print a total it cannot stand behind
(`believableCount()`), prints "schedule" instead, and explains the two exchanges in the modal. Do not
"fix" this by aligning the two `indexId` values: that restates every count in the strip as a
different universe under the same label, which is the move we already refuse for `indexId=B`.

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
would have been worse than not scoring at all. `js/scoring/earnings-scoring.js` and the mock set
remain for Breakouts → Earnings Surprise, which still labels itself mock. **Moving that join onto
this live feed is the obvious next piece of work.**

---

## 5c. The Con-call tab: one screen, someone else's analysis

The tab is the StockScans con-call scan — every earnings call held this quarter with **their**
result score (0–100), **their** sentiment tier and **their** highlight bullets — plus the schedule
of calls not yet held, behind an **Upcoming Concalls** button that opens an overlay grouped by
date, the same shape StockScans give it.

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

**Three things about the data that are easy to get wrong:**

- **A blank quarter is not a zero.** Indian companies name only holders above a threshold, so a
  real position below it is invisible in the filing. `null` travels to the cell, renders as a dash
  and stays out of every total. A position disappearing is *"no longer disclosed"*, not *"sold"*.
- **`valueCr` is Finology's, not ours.** A filing states a percentage, never a rupee amount. The
  column is headed *Value (Finology)* — same relation Institutions has with Trendlyne's value.
- **One figure is computed here**: the quarter-over-quarter change, headed *Change (derived)*.
  Neither a new position nor a vanished one carries a percentage-point figure, because printing
  ±the whole holding would invent a trade size.

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
only honest because `meta().origin` distinguishes `snapshot` / `store` / `live` and the pill says
*Captured* / *Cached* / *Live* to match, `meta().checkedAt` reports the **oldest** confirmation on
screen rather than the newest, and *Re-read everything now* in the Live pill's modal discards every
confirmation. `verify-ui.mjs` asserts all of it — and the snapshot half needs no Worker to check,
because it is a committed file.

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

- **No SPA fallback is required.** Routing is hash-based (`/#/portfolio/drawdown/curve`), so every
  deep link is served as `/` and there is nothing to rewrite.
- **Adding a header or a cache rule means editing `worker/index.js`**, not dropping a `_headers`
  file — that file would simply be served as a static asset and do nothing.

**Three CDN hosts must be reachable from the browser**: `cdn.tailwindcss.com`, Google Fonts, and
`cdn.jsdelivr.net` (exceljs, loaded on demand only when someone exports). If a deployment target
blocks them, vendor them and repoint `index.html` — see the sandbox note at the bottom of
`CLAUDE.md` for the exact procedure, and never commit that rewrite.

Every `data/*.json` path the app fetches at runtime resolves to a file that exists in `public/`;
that is worth re-checking after any data change, because a 404 there is invisible until a tab mounts.

---

## 8. Performance — measured, not asserted

Measured with Playwright on the vendored local copy, medians of 7 runs.

| View | Warm in-app render | Cold mount (fetch + compute) |
| --- | --- | --- |
| Breakouts scanner — 535 scored rows painted | **119 ms** | 4.1 s (763 KB + 568 KB + 535 × 16 rules) |
| Drawdown curve — 735-day SVG, 3 series | **13 ms** | 665 ms (284 KB + FIFO replay + curve) |
| Portfolio positions — FIFO book, 13 rows | **30 ms** | — |
| Underwater plot — 3 series × 735 points | 30 ms | — |

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

The fix is that `scoreTable` now paints 80 rows and appends the rest in adaptive slices under
`requestIdleCallback`. Nothing is unmounted — every visible row still reaches the DOM, so Ctrl-F,
screenshots and the accessibility tree are unaffected — and the section carries `data-rows-pending`
until the fill completes, which is what `verify-ui.mjs` waits on instead of racing it.

| Tab-to-tab switch | Before | After |
| --- | --- | --- |
| Earnings Hub (1,722 rows) | 866–1,536 ms | **36–90 ms** |
| Con-call (1,018 rows) | 393–950 ms | **69–126 ms** |
| Breakouts (603 rows) | 299–652 ms | **56–83 ms** |
| Longest task during a switch | 425 ms | **75 ms** |

The heavy feeds are **lazy**: technicals, the con-call corpus, the chatter files and the price
history load when their tab first mounts, not at bootstrap, so eight tabs never pay for data they
do not read.

### And the bootstrap only blocks on what the first paint needs

`app.js` used to await seven files — **~825 KB** — before the shell rendered anything, including a
347 KB shareholdings file read by one sub-view and a 232 KB mock corpus read by one other. It now
blocks on **one**: `portfolio-companies.json` (31 KB), the book, because `coverage` backs the scope
toggle and every research tab reads it synchronously. The rest start at the same moment and are
awaited by their own consumers — `whenDeferredData()` in Breakouts → Earnings Surprise,
`filed.load()` in Institutions, and `portfolio.js`'s `build()`, which now fetches its two files
itself if nothing primed it.

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

- **Con-call, chatter, super-investor and institutional data are mock.** Real feeds need transcript,
  forum and filing scrapers that do not exist. The shapes are the contract; swapping the files is the
  whole change. (Earnings is no longer in this list — the Earnings Hub is live.)
- **Breakouts → Earnings Surprise still runs on the mock earnings set** even though real results now
  flow into the Earnings Hub. It is labelled mock, but the incoherence is real and it should be
  repointed at `js/data/earnings-live.js`.
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
- **The transaction ledger is mock and CSV import does not persist.** Both need a server or a broker
  integration. `docs/DATA-CONTRACTS.md` → "Wiring the real ledger" lists the six steps in order.
  Note that the *book* (`portfolio-companies.json`, 142 real companies) and the *ledger*
  (`portfolio.json`, 12 synthetic positions) are still different files — see §5a. Wiring the real
  ledger is what would finally reconcile them.
- **Nineteen book lines can never appear on a feed here**, and three of them are a genuine loose
  end rather than a structural one: String Metaverse, Nisus Finance Services and Future Supply Chain
  Solutions resolved to no symbol on either exchange. The first two most likely trade under a
  changed name; the third was delisted after insolvency. The other sixteen are structural — unlisted
  companies, warrant lines, the Vedanta demerger entities and five BSE-only listings, and only a
  BSE-keyed feed would fix that last group.
- **`TATAMOTORS` has no price data at all** — Yahoo 404s the symbol, almost certainly because of the
  demerger. It is recorded in `portfolio-history.json` `failures[]`, marked at cost, tagged in the
  table, named in the provenance modal, and the Drawdown view reports 97.6% curve coverage rather than
  pretending to 100%. Fixing it means finding the right symbol, not hiding the position.
- **No test runner.** `scripts/verify-ui.mjs` is the suite: ~180 Playwright assertions including the
  two reconciliation identities, an independent max-drawdown recompute, the CSV round trip and the
  overlay focus traps. Run it before every push; it exits non-zero on the first failure.
- **No CSP.** Adding one means allowing the three CDN hosts, in `worker/index.js`.

---

## 10. Before you push

```bash
python3 -m http.server 8080 -d public
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
