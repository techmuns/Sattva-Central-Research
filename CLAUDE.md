# CLAUDE.md — working rules for this repo

Read this before touching anything. `docs/SPEC.md` has the product detail;
`docs/DATA-CONTRACTS.md` has every JSON shape.

---

## Hard rules

1. **Work on `main` only. Never create a branch.** Commit and push to `main` when done.
2. **No deployment build step, no bundler, no framework, no npm dependencies for the app itself.**
   Vanilla ES modules, served as static files. If you find yourself adding a `package.json`
   for the front-end, stop — that's out of contract.
   (Node 22 scripts under `scripts/` that refresh data are fine and expected.)
   **This binds `scripts/` too**: there is no `package.json` anywhere and no `node_modules`. When a
   script needs a capability, build the small version of it in `scripts/lib/` rather than reaching
   for a package — `xlsx-read.mjs` reads .xlsx workbooks with `node:zlib` and a tag scanner, because
   a one-off data import is not the thing that should introduce a dependency tree. `npx wrangler`
   and `npx playwright` are invoked on demand and installed nowhere.
3. **Everything must run by opening the static site.** Verify before pushing:
   `python3 -m http.server 8080 -d public`, then drive it with Playwright.
   Zero console errors is the bar.
4. Tailwind is precompiled into committed `public/css/tailwind.css`; never reintroduce the browser
   compiler. After changing utility classes, regenerate it with:
   `npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i scripts/tailwind-input.css -o public/css/tailwind.css --minify`.
   The source entry is `scripts/tailwind-input.css`; the content/font config is
   `tailwind.config.cjs`. Commit the generated stylesheet. The on-demand CLI is a maintenance
   tool, not an app dependency or a deployment step.
5. Light theme only.

---

## Stack

| Concern | Choice |
| --- | --- |
| Markup | `public/index.html`, single entry |
| CSS | Committed precompiled Tailwind + a small `:root` token block in `index.html` |
| Fonts | Inter 400–800 (body), Plus Jakarta Sans 600–800 (headings, `.font-display`) |
| JS | Vanilla ES modules, `<script type="module" src="js/app.js">` |
| Data | JSON in `public/data/`, refreshed by Node 22 scripts in `scripts/` via GitHub Actions |
| Hosting | Cloudflare Worker (`worker/index.js` + `wrangler.jsonc`) serving `env.ASSETS` |

---

## File layout

```
public/
  index.html                  design tokens, fonts, compiled CSS link, #app mount, overlay roots
                              (drill z-50 < workspace z-55 < modal z-60)
  css/tailwind.css            generated Tailwind utilities; committed and served as a static asset
  js/
    app.js                    bootstrap: load all JSON, then mount the shell
    core/
      state.js                global state + localStorage + pub/sub
      watchlist.js            THE WATCHLIST — a set of COMPANIES, not of rows. Backs the star in
                              every table AND the Watchlist scope; see the scope section below
      router.js               hash routing (#/ws/tab/subview?scope=)
      live.js                 live-update polling engine
      watch.js                app-wide feed watchers -> the alert stack
      store.js                IndexedDB payload cache + conditional fetch (see the caching section)
      sdk.js                  THE Munshot Dashboard SDK client — one, built at import time
      host-context.js         the host's session token + selected company, and `authHeaders()`,
                              the ALLOW-LIST that decides which requests may carry the token
      host-capture.js         the host's two requests: capture.visual (PNG Blob) + capture.snapshot
      format.js               number/date/currency/relative-time helpers
      dom.js                  $, $$, escapeHtml, el, empty
    ui/
      screener.js             THE SCREENER KIT — build tabs from this
      visual.js               avatars, tiers, status pills, signal dots, legend
      sources.js              data-source registry — the canonical list of every feed and its honest
                              status; read by the beacon below and by each tab's provenance surfaces
      twitter-sources.js      "Edit Twitter Sources" — add/remove the X accounts whose posts join
                              the News feed. Opened from the beacon's Twitter / X family
      source-beacon.js        "DATA FLOWING IN" — the lower-left beacon: one launcher, one popover,
                              every source in the registry as a vertical list beside a diagram of them
                              converging on the Sattva square. NOT the header's old Sources button;
                              see the section below
      host-ticker.js          the company the HOST has selected, as one header chip. Absent, not
                              empty-stated, when it has selected none — this app is not ticker-bound
      notifications.js        the live alert stack, lower-right
      export.js               generic exceljs-from-CDN "Export Excel" helper
      components.js           chrome primitives (tab bar, toggle, search…)
      shell.js                header + tabs + sub-view picker + content host + tab registry
    concall/
      scans.js                the WHOLE Con-call tab, live off StockScans (scores are THEIRS)
                              — the scan table, with no schedule or feed-status header chips
      deep-dive.js            the Deep Dive panel: trigger a run on the SEPARATE Concall Deep Dive
                              dashboard, mirror its progress, render its report (also THEIRS)
    investors/
      filed.js                the REAL half of Institutions — filed shareholdings off Trendlyne
      live.js                 the WHOLE Superstar Investors view — real filed books off Finology
    data/
      scope.js                THE THREE SCOPES in one place — portfolio / watchlist / universe,
                              and the one `filterByScope()` every forScope() is built on
      daily-alerts.js         RETAINED HISTORY across NINE feeds. Derived: no file, no route of its own
      ai-alerts.js            EXPLAINABLE seven-day company priority over Daily/General readings
      coverage.js             THE BOOK — the 142 companies the Portfolio toggle means, and the
                              19 it cannot cover. NOT the ledger; see the section below
      technicals.js           loads + scores the live feed once, caches it
      earnings.js             same, for the earnings feed (+ legacy-summary adapter)
      chatter-live.js         the live chatter feed: mention counts + sentiment, split by
                              whether the slug resolved to a symbol we cover
      institution-holdings.js real filed shareholdings, by institution (Trendlyne)
      finology-shared.js      pure shape guards + deriveMoves — imported by worker/finology.mjs
      sentiment-shared.js     pure shape guards + the slug->NSE resolver for the chatter feed
      super-investors.js      the live super-investor feed: list, then every book, four at a time
      deep-dive.js            transport for the Concall Deep Dive dashboard — a click costs a run,
                              so nothing in here fires on its own
      universe.js             screener-export -> legacy universe shape adapter
      twitter-news.js         X/Twitter posts, converted into the EXISTING news article shape so
                              they join the same News list — not a second feed
      filings.js              the News / Announcements / Insider feed: snapshot first, then a
                              bounded live walk for whatever it is missing
      nse-filings.js          THE NSE LIVE ANNOUNCEMENTS FEED, scoped per company — live off our
                              Worker proxy, committed snapshot beneath it, rows carry a resolved ticker
      filings-shared.js       markdown-table parser + shape-tolerant normalisers, shared with
                              worker/muns.mjs
    scoring/
      tech-scoring.js         16-rule / 24-point technicals model (ported verbatim)
      earnings-scoring.js     15-rule / 21-point result quality + growth model
      rule-meta.js            per-rule provenance, keyed META[tabId][ruleKey]
    research/
      estate.js               ASK RESEARCH'S EVIDENCE REGISTRY — fourteen adapters over the tabs' own
                              modules; loads, resolves the question, then reads; fits to the budget
      evidence-shared.js      the ONE provider-facing packet shape, imported by worker/research.mjs too
      renderer.js             the DOM-based markdown subset model prose is rendered through
    core/twitter-handles.js   THE X ACCOUNT LIST — normalisation, dedupe, and a device-local overlay
                              over the committed twitter-handles.json. `adding` and `active` are
                              different claims; see the section below
    tabs/                     ai-alerts, daily-alerts, ask-research, earnings-hub, concall, public-chatter, breakouts,
                              super-investors, news, corp-announcements, nse-filings, insider-trades
      ai-alerts.js            ranked company insight cards, strongest evidence first
      daily-alerts.js         GENERAL ALERTS — one newest-first historical stream across the research
                              feeds, with direction + importance reasons and feed freshness
      filings-tab.js          the shared body of the last three — one renderer, three column sets
  data/                       technicals.json, atr-history.json,
                              market-news.json + market-news/<YYYY-MM>.json (head + archive),
                              earnings-live.json, mc-ticker-map.json, result-returns.json,
                              earnings-calendar.json, universe.json,
                              portfolio-companies.json (THE BOOK — names and sectors, the only
                              portfolio data here), mock/*.json
scripts/
  sync-family-book.mjs        THE BOOK'S SOURCE — reads techmuns/Sattva-Family's positions file, one
                              line per equity ISIN, into fixtures/family-book.json, then re-resolves
  resolve-portfolio-companies.mjs  the fixture's ISINs -> NSE symbols, collision-guarded; every
                              hand-checked table keyed by ISIN
  fixtures/family-book.json   the committed copy of the family repository's book: isin, name, sector
  scrape-technicals.mjs       the live pipeline (Yahoo EOD + NSE delivery %)
  gen-mock-earnings.mjs       seeded generator for the synthetic earnings set
  import-amc-portfolio.mjs    AMC monthly portfolio workbooks -> institution-holdings.json
  lib/xlsx-read.mjs           .xlsx reader built on node:zlib alone, no npm dependency
  lib/company-index.mjs       company name -> NSE symbol, token-wise, collision-guarded
  scrape-filings.mjs          walks the universe for news and insider trades (NOT announcements)
  scrape-bse-announcements.mjs  the whole exchange's filings, read by DATE — ~20 requests
  scrape-mc-news.mjs          Moneycontrol's market-wide stocks news (curl, NOT fetch)
  scrape-rss-news.mjs         Business Standard, Mint, Economic Times, Investing.com — their own
                              RSS, merged into the SAME capture (curl: two of the four 403 on fetch)
  lib/news-store.mjs          THE MARKET-NEWS CAPTURE ON DISK — a bounded head plus a shard per
                              month. Both news scrapers write through it and both MERGE
  scrape-twitter.py           THE ONE PYTHON SCRIPT — posts from the monitored X accounts, via
                              twscrape, on a runner. Read the section below before touching it
  scrape-institution-holdings.mjs  REAL filed shareholdings, per fund, off Trendlyne
  lib/trendlyne.mjs           the Trendlyne page parser, pure and testable offline
  stub-chatter.mjs            replays a captured chatter payload, so a verify run needs no egress
  verify-ui.mjs               the pre-push checklist, driven with Playwright
  lib/                        indicators.mjs, liquidity-estimators.mjs
.github/workflows/technicals-refresh.yml   weekdays 07:00 IST; EOD prices and derived snapshots
.github/workflows/family-book-sync.yml     06:00 IST daily + repository_dispatch from the family repo;
                                           keeps the book in step with techmuns/Sattva-Family
.github/workflows/price-move-verify.yml    hourly through the Indian day; asks the Muns market-data
                                           endpoint about every flagged move the scrape could not verify
.github/workflows/screener-concalls-refresh.yml  every 15 min incremental + daily full authenticated
                                           Screener concall index; immutable Actions artifact, no commit
.github/workflows/company-news-refresh.yml weekdays 09:00 + 19:00 IST; company-news universe capture
.github/workflows/insider-trades-refresh.yml weekdays 19:00 IST; insider-trades universe capture
.github/workflows/announcements-refresh.yml weekdays 20:00 IST; BSE date-indexed filings
.github/workflows/nse-announcements-refresh.yml hourly in Indian hours; the NSE snapshot fallback
                                           (the live route /api/nse-announcements is the primary read)
.github/workflows/rss-news-refresh.yml     hourly; the four RSS publishers. Shares the
                                           `market-news-capture` concurrency group with
                                           market-news-refresh.yml — both merge into one file
.github/workflows/twitter-refresh.yml      every 30 min + workflow_dispatch from the dashboard when
                                           a reader adds an account; posts from the monitored handles
worker/index.js               asset serving + POST /api/live-prices + GET /api/earnings
                              (+ ?fields=prices) + /api/earnings-calendar + /api/concalls
                              + /api/super-investors (+ /{slug})
worker/research.mjs           Ask Research's provider bridge: holds the Muns LLM token, bounds the request on
                              public/js/research/evidence-shared.js and streams the answer back as NDJSON
worker/http.mjs               content ETags, 304s and CORS — shared with any local stand-in
worker/mc.mjs                 the Moneycontrol client + normaliser, shared with scripts/
worker/stockscans.mjs         the StockScans con-call client (vocabulary lives in public/js/data/)
worker/finology.mjs           the AUTHENTICATED Finology client — holds env.MUNS_TOKEN, never the browser
worker/muns.mjs               the AUTHENTICATED news / insider clients — same token
worker/bse-ann.mjs            BSE's DATE-indexed announcement feed — open, no credential
worker/nse-ann.mjs            NSE's LIVE announcements RSS — parser + name->symbol resolver, pure and
                              shared with the scraper. Browser can't read NSE (CORS null); Worker can
worker/mc-news.mjs            Moneycontrol's market-wide news listing — parser only; nothing on
                              the edge can fetch it, so only the Action ever calls this
worker/rss-news.mjs           the four RSS publishers behind the same tab — parser + feed list,
                              pure and offline-testable. Mint and Economic Times 403 a Worker
                              exactly as Moneycontrol does, so this is Action-only too
worker/github-actions.mjs     the AUTHENTICATED workflow_dispatch client — holds env.GH_DISPATCH_TOKEN,
                              never the browser. Lets the news button START the scrape it cannot do
wrangler.jsonc
docs/SPEC.md                  product spec + roadmap
docs/DATA-CONTRACTS.md        every JSON file's shape, units, source, cadence
docs/HANDOFF.md               live-vs-mock inventory, architecture map, deploy, known gaps
```

---

## Module interface contract

Every file in `js/tabs/` exports exactly this. The shell is generic and knows nothing about any
individual tab beyond this contract.

```js
export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'One line describing the tab.',
  subviews: [{ id: 'latest-results', label: 'Latest Results', badge: 12 /* optional */ }],
};

export function render(ctx) {}   // ctx = { scope, subview, root, live, data }
export function destroy() {}     // detach listeners/pollers; called on nav away
```

- `ctx.scope` is `'portfolio' | 'watchlist' | 'universe'` — **every tab must visibly reflect it.**
  Never write `scope !== 'portfolio'` to mean "everything": that was correct with two scopes and is
  silently wrong with three. Ask `js/data/scope.js` — `scopeTickers()` returns the Set to filter by
  or `null` for "this scope does not narrow".
- `ctx.root` is the content host, already cleared.
- `ctx.data` is the loaded data set, keyed as in `DATA_SOURCES` (see `app.js`).
- `ctx.live` is the live engine.
- `render()` is called on every route change within the tab (sub-view or scope change too),
  so it must be safe to call repeatedly.
- `destroy()` is called only when navigating to a *different* tab. Unsubscribe and
  `live.stop()` there.

**A subscription that outlives one `render()` may not be guarded by anything captured inside it.**
`render()` runs again on every scope and sub-view change — that is the contract above — so a handler
written as `const mine = token; feed.onChange(() => { if (mine !== token) return; paint(); })`, set
up once behind an `if (!unsub)`, is alive until the reader touches the scope toggle and dead
afterwards. It cost the three filings tabs exactly that: the feed went on to 40 companies and 4,583
rows while the screen stayed at 21 and the pill still read *21 companies*. **Nothing threw, nothing
failed, and no state was wrong** — only the paint stopped, which is the version of this bug that
looks like a broken API and gets diagnosed as one. Guard on the thing the lifecycle actually owns
(`ctxRef`, set by every render and cleared by `destroy()`), and re-read the current ctx inside the
handler rather than closing over the one that happened to be current at subscribe time.

**To add a tab:** create the module, then add it to the `WORKSPACES` array in
`js/ui/shell.js`. That's the only registration point.

**Ask Research is first, and first is the default landing page.** `handleRoute` falls back to
`ws.tabs[0]` for an unknown or absent tab, so the ORDER of the `WORKSPACES` array is the default —
there is no second place recording it that could disagree with the array. Reordering that array
moves the landing page, which is the intended way to move it.

**There is one workspace and no switcher.** Research Central's tabs are the whole nav.
Portfolio Analytics was the second and is deleted — it was `hidden: true` for a while, routable
but not clickable, and that is exactly what trapped a reader who followed an Ask Research citation
into it: no switcher meant nothing on the page led back. An unknown workspace now falls through to
`WORKSPACES[0]` and `router.replaceRoute` corrects the URL, so an old `#/portfolio/…` link lands on
a working page. **Never add a route the chrome cannot navigate away from** — see *Portfolio means a
list of names* below.

---

## Design tokens

Defined in `:root` in `public/index.html`. Use them; don't invent new colours.

**The brand ramp is indigo → purple → pink.** Emerald / amber / rose are *semantic only* —
they mean pass / partial / fail. Never use a semantic colour to mean "branded", and never use
indigo to mean "good".

| Token | Value | Meaning |
| --- | --- | --- |
| `--brand-500` | `#6366f1` | indigo — brand ramp start |
| `--brand-600` | `#4f46e5` | indigo-600 — links, actions, active nav |
| `--brand-mid` | `#a855f7` | purple — brand ramp middle |
| `--brand-end` | `#ec4899` | pink — brand ramp end |
| `--accent-600` | `#4f46e5` | indigo-600 — accent for links/actions |
| `--positive` | `#059669` | emerald — pass |
| `--caution` | `#d97706` | amber — partial |
| `--negative` | `#e11d48` | rose — fail |
| `--hard-fail` | `#be123c` | rose-700 — hard fail |
| `--neutral` | `#64748b` | slate — n/a |
| `--page-bg` | `#f8fafc` | page background |

The brand gradient, used on the logo mark, the scope toggle thumb and the freshness hero card:
`bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500`.

Conventions:
- Surfaces are white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Page background carries three radial gradients (violet TL, pink TR, sky BR), all ≤ 12%.
- Content column is `max-w-[1400px] mx-auto px-6`.
- `font-variant-numeric: tabular-nums` on every number-bearing cell.
- Tables scroll horizontally **inside their own container**; the page body must never scroll
  sideways. `overflow-x: hidden` on `html` *and* `body` is a backstop, not the mechanism —
  it's on `html` because the parked drill panel is `position: fixed` and `body` can't clip it.
- **Sub-views are one dropdown, at every width, and the content always spans the full column.**
  There used to be a 240px left rail above 1024px and a dropdown below it. The rail cost the
  content 240px of its 1400px, permanently, to show at most four short labels — while the tables
  beside it are the widest things here and were scrolling inside their own containers to fit what
  was left. Measured: removing it takes Breakouts from a 248px inner scroll to **none**, Super
  Investors from 380px to 116px, Portfolio Overview from 453px to 189px. Two presentations of one
  control was also two things to keep in step, and the narrow one was already doing the whole job
  on the width that needed it most. A tab with `subviews: []` renders **no picker at all** — the
  shell hides `#subview-mount` and skips wiring it. Its kicker reads *View*, not the tab's title,
  because the section head immediately below prints that title as the page heading.
  **The picker's menu is `position: absolute` below its card, so its wrapper must never carry
  `overflow-hidden`** — that clips the menu into invisibility while every click handler goes on
  working, which is a control that looks broken and tests as fine.
- Long-running lists get `.scrollbar-thin`; panels that mount fresh get `.fade-in`.

---

## The screener kit — `js/ui/screener.js` + `js/ui/visual.js`

**Build every tab out of these. Do not hand-roll a table, a stat row or a detail panel.**

`visual.js` is the shared vocabulary: `avatarFor(name)` (deterministic gradient + initials),
`scoreTier(pct)`, `scoreBadgeClass(pct)`, `tierLabel`, `tierColor`, `statusPill(status)`,
`signalDots(signals)`, `legendStrip()`, `STATUS_DOT`.

`screener.js` is the furniture:

| Component | Use |
| --- | --- |
| `statStrip(cards)` | the 4-up KPI row. Card 4 **must** be `{ hero: true, … }` — the gradient freshness card. Any card may carry `help: { title, body }` for a `?` explainer modal. **Not mandatory**: the Earnings Hub deliberately has none — see below. |
| `topCards({ title, items, valueFormat, onSelect })` | the Top-10 hero grid. `valueFormat: 'score'` renders `value/max` coloured by tier; `'metric'` renders one formatted number coloured by `tone`. |
| `scoreTable(config)` | the workhorse: search, filter select, watchlist, sort, export, sticky head, row click. |
| `openDrill(config)` | right-slide detail panel (singleton), 480px. For one row's detail. |
| `openWorkspace(config)` | full-screen overlay (singleton), `max-w-[1200px]`, with its own tab strip. For analysis that needs room — see below. |
| `openModal(html, { size })` | centred modal (singleton). `size`: `default` \| `wide` \| `magazine`. |
| `table.updateRows(keys)` | rebuild named rows **in place** after their data changed, leaving the row set — and so the reader's search, filters, watchlist and sort — untouched. For data landing on a mounted table: a live quote arriving over an EOD column is the reference case, and the watchlist star is the second. Not the same as a repaint: `repaint`'s fast path *moves* existing `<tr>` nodes, so invalidating the markup cache alone changes nothing on screen. |
| `rankedList(config)` | a compact ranked panel — heading, note, up to `limit` rows of `{ name, sub, value, tone, badge }`. The small sibling of `topCards`, for a page that needs several small rankings side by side rather than one hero grid. **`key` is required** where more than one is rendered, or `wire()` binds the first panel's handler to every panel's rows — a click that works and opens the wrong thing. |
| `sectionHead`, `pendingPanel` | title block and the honest "no data yet" panel. `sectionHead` takes **`meta`** (right of the title) and **`controls`** (a left-aligned row of its own beneath it) — see below. |

**There is no roadmap card.** A dashed *"Wiring roadmap · Not built. Listed so the gap is visible
rather than implied"* strip used to close most tabs. The gaps it listed are written down in
`docs/SPEC.md` under each tab's *Still to come*, which is where a roadmap belongs — a permanent
block of what a tab does **not** do, sitting under the thing it does, is chrome competing with
content. `roadmapStrip()` and the older `comingSoonStrip()` are both deleted; do not reintroduce
either. Listing a gap in the spec is the rule that survives.

**A tab may opt out of the stat strip, and out of sub-views.** The Earnings Hub is one dense table
and nothing else: no stat cards, no ribbon, no sub-view picker. Public Chatter also omits its four
summary cards; coverage, post count/source split, mood and scrape timing now sit in a muted footnote
after both tables. **General Alerts is the third**, and
it went furthest: no description, no cards, one pill. Three of its four cards counted rows the
table directly beneath them already lists — *Alerts 0*, *Updates 89* — and the fourth printed a
date; the paragraph above them restated per-feed facts the coverage panel states per feed, by name.
The pill carries the Indian trading date on its face, because this is the one tab defined by a DAY.
**Breakouts / Technical is the second, on all four
sub-views** — each opened with two or three counts plus the gradient freshness
hero, above the table those counts describe, and most of it was already on screen a few pixels
lower: *"Breakout candidates 21 of 586"* is the line under the chip bar and *"Strong breakouts 0"*
is the count on the Strong chip itself. The rule that survives is not
"every tab has a stat strip" — it is **status should be legible without another interaction**.
There it lives in a small passive Live label in the section head. It does not open a provenance
popup; full source metadata remains in the source registry and export disclosures. A tab with
`subviews: []` gets no sub-view picker — the shell hides that row and skips
wiring it.

The standard tab body, in order:

```js
ctx.root.innerHTML = `
  ${sectionHead({ title, description, meta: scopeSummary({ scope: ctx.scope, count, noun }) })}
  ${stats.html}          // statStrip — 4 cards, 4th is the gradient hero
  ${cards.html}          // topCards — omit where no ranking is meaningful
  ${table.html}          // scoreTable
  ${legendStrip()}       // only on tabs that render signal dots
`;
stats.wire(ctx.root); cards.wire(ctx.root); table.wire(ctx.root);
```

`scoreTable` essentials — `rows`, `key(row)` (the ROW's id), `watchKey(row)` (the COMPANY's, for
the star — defaults to `key`), `name(row)`, `sub(row)`, and
`columns: [{ label, get(row), html?, align?, sortable?, sortValue? }]`. `html: true` means
`get()` returns trusted markup, so **escape inside it yourself**. Optional: `showScore` +
`score(row) => { points, max, pct, redFlag? }`, `showSignals` + `signals(row) => [{ label, status }]`,
`filters`, `searchable`, `initialSort`, `onRowClick`, `link`, `exportName`.

Score and Signals are **opt-in**. A tab with no scoring model leaves `showScore` off rather
than rendering empty score furniture.

**Layout knobs, for wide numeric tables.** Defaults give the screener look; the Earnings Hub is
the only consumer that changes all four, because it carries ten numeric columns:

| Option | Default | Effect |
| --- | --- | --- |
| `showRank` | `true` | `false` drops the leading `#` column. The watchlist star does **not** go with it — it moves inside the identity cell, because the watchlist filter needs a per-row control. |
| `nameAfter` | `0` | How many of `columns` render *before* the identity column. `1` puts a date or ID column first. |
| `nameMaxPx` | `null` | Hard px cap on the identity column. `truncate` alone will not stop a long sub-line widening the table — a `<table>` in auto layout sizes to its widest content, so the cap on the inner block is what makes the ellipsis engage. |
| `dense` | `false` | `px-2` instead of `px-4`, and `tracking-normal` instead of `tracking-wider` on the headers. Worth ~110px across ten columns. |
| `wrapHeads` | `false` | Lets a heading stack onto two lines instead of forcing its column as wide as the label. On a wide numeric table **the headings, not the figures, are what overflows** — "Jun 26 Holding %" is far wider than "2.8%". Worth ~230px across thirteen columns. |
| `showAvatar` | `true` | The gradient mark in the identity cell. It costs ~46px, and on a table wide enough that company names would otherwise truncate, the name is what the reader is scanning for. |
| `filters` | `null` | One config, or an **array** of them. An array renders several `<select>`s that AND together — "PAT grew" and "Consolidated only" are different questions and folding both into one dropdown would make them mutually exclusive for no reason. |
| `initialView` | `null` | Seed search / filters / watchlist-only / sort from a previous instance's `view` (which the table now returns). A tab that rebuilds on live data must pass this, or the reader's state is discarded every time a row arrives. |
| `stickyHead` | `null` | A CSS length that makes the table body its own vertical scroller, e.g. `'max(320px, calc(100vh - 300px))'`. **This is what makes the sticky `<thead>` work.** `sticky` positions against the nearest *scrolling* ancestor, and `overflow-x: auto` on the wrapper makes that wrapper the scroll container in both axes — so without a height the head sticks to a box that never scrolls while the page scrolls underneath it. |

Reach for these only when the alternative is a horizontal scrollbar at 1440px. Measure before and
after — `[data-table-scroll]`'s `scrollWidth` vs `clientWidth` is the number that matters, and
`verify-ui.mjs` asserts it for the Earnings Hub (ten columns) and for Institutions (thirteen).

### `meta` versus `controls` — where a tab's chips go

`sectionHead` has two slots and they are not interchangeable.

- **`meta`** is the right-aligned block beside the title. Right for one small pill that is the
  same on every sub-view — a Live pill, a scope summary, both.
- **`controls`** is a **left-aligned row of its own**, under the heading block. Use it the moment
  the set of chips **differs between sub-views**.

The reason is that `meta` lives in a `justify-between` row, so whether it renders beside the title
or wraps under it depends on how wide the chips and the description happen to be — and both of
those change with the sub-view. On the Earnings Hub the chip row sat left, under the title, on
Latest Results and jumped right, beside the title, on Earnings Calendar, because the second view
drops the YoY/QoQ toggle and has a shorter description. Nothing was conditional; the wrap point
simply moved.

**Controls that move when you use them read as a different page rather than another view of one.**
A row of its own cannot wrap, so it cannot move. `verify-ui.mjs` measures the controls row's `x`
on both Earnings Hub sub-views and asserts they are equal and aligned to the title.

### The star marks a COMPANY, and `key` is not `watchKey`

`key(row)` identifies a **row**. `watchKey(row)` identifies the **company** on it, and defaults to
`key` because on a screener the two are the same ticker.

They are not the same everywhere, and pretending they were is what the watchlist used to store: the
ticker on Breakouts, Moneycontrol's `scID` on the Earnings Hub, `company|time|document` on Con-call,
a composite of the cells on the three filings tabs. **Four vocabularies in one set**, which could not
answer the one question a watchlist exists to answer — which companies — and which is exactly what
the Watchlist scope needs.

Three consequences, and all three are load-bearing:

1. **A table whose rows are events must pass `watchKey`.** Three announcements from one filer are
   three rows and one watched company.
2. **Starring one row restains every row of that company.** The click handler marks every row
   sharing the watch key stale, not just the one clicked — otherwise the other two would show the
   opposite of what is stored, which is the same control-disagrees-with-its-state failure that
   `staleKeys` exists to close, arrived at from the other side.
3. **A row with no company gets NO STAR**, not a dead one. Superstar Investors (Finology discloses a
   company name and no symbol) and Public Chatter's unresolved half both pass `watchKey: () => null`.
   A star that filed a name where a symbol is expected would match nothing for ever, and a star that
   silently does nothing is worse than a control that is not offered.

### Honesty rules for the kit

These are not style preferences — they are why the dashboard can be trusted:

1. **Never fabricate a number to fill a component.** If a feed hasn't landed, render
   `pendingPanel()` and drop the ranking grid.
2. **Signals must be direct readings**, e.g. "revenue YoY > 0", not a modelled judgement. A
   real points-based score only appears once its model is built and documented.
3. **Label derived figures as derived.** Super Investors' holding value is
   `holding % × market cap` and says so in the drill panel — filings disclose a percentage,
   never a rupee amount.
4. **Every `?` help modal states what is mock and what is live**, and which prompt wires it.
5. **Never attribute invented words to a real person.** This is a harder line than the mock-data
   rule and it is not negotiable by labelling. Synthetic *numbers* about a real subject are fine
   when marked: the earnings figures sit against real companies, and the Super Investors holdings
   sit against real, named investors, both under an unmissable ribbon. Synthetic *speech, views or
   rationale* attributed to a named real person are not fine at any labelling level, because a
   screenshot travels without the ribbon and the quote survives as something they said. So:
   con-call speakers and analysts are fictional, forum and Telegram handles are fictional, and
   `superinvestors.json` carries positions with **no** `rationale` / `quote` / `thesis` field —
   deliberately, so there is nothing to render. If a field would read as something a real person
   said or thought, drop the field.
6. **Synthetic numbers must be unmistakable wherever they surface.** Earnings Hub is the
   reference: an amber ribbon on every sub-view, a freshness card reading "Mock data · generated
   `<date>` · not a filing time" rather than a fake filing time, an amber note in the drill, an
   amber banner as row 1 of every exported sheet, and a `mock` row in the Sources modal naming
   the generator script. All five read one flag derived from the payload — see *Mock data that
   has to behave like real data* below. **A number that leaves the dashboard must carry its
   provenance with it**: an exported workbook is the one artefact nobody can see a ribbon on.

`wire()` returns a disposer when it registers anything global. Call it in `destroy()`.
**Always escape data-sourced strings** with `escapeHtml` from `core/dom.js`.

### The workspace overlay — `openWorkspace`

When one row's detail needs more than the 480px drill panel — several views over the same
entity, a transcript, charts side by side — use the workspace. The Con-call Deep Dive is the
reference consumer.

```js
openWorkspace({
  title: company.name,
  subtitle: `${ticker} · ${sector} · ${quarter}`,
  avatarName: company.name,          // drives the gradient avatar
  badges: [statusBadge, mockBadge],  // trusted markup, rendered beside the title
  actionsHtml: '',                   // trusted markup, top-right
  tabs: [{ id, label, badge?, render: () => html, wire?: (panel) => {} }],
  activeTab: 'summary',
  onTabChange: (id) => ctx.setParamsQuiet({ ...ctx.params, view: id }),
  onClose: () => ctx.setParamsQuiet(withoutDeepDiveParams),
});
```

Rules that make it behave:

- **`render()` is lazy and repeated.** A tab's `render()` runs when it is first shown and again
  on every return to it, so it must be cheap and side-effect-free. `wire()` gets the freshly
  rendered panel.
- **ESC and × close it; a backdrop click does not.** A workspace holds real state — a scrolled
  transcript, a search term — and a stray click outside should not discard it.
- **Scroll is locked** on `<body>` (`.workspace-open`) while it is open.
- **Stacking is drill (z-50) < workspace (z-55) < modal (z-60)**, so a modal opened from inside
  a workspace lands on top. The ESC handler checks for an open modal and defers to it.
- **`closeWorkspace({ silent: true })`** skips the `onClose` callback. The shell uses it on route
  change, where the URL is already being rewritten by the navigation.
- **Mirror its state into the URL with `ctx.setParamsQuiet()`, never `ctx.setParams()`.**
  `setParams` re-mounts the tab body, which would tear down the very overlay doing the writing.
  `setParamsQuiet` writes the URL and saves the route without re-mounting. Because the shell
  closes every overlay on mount, the owning tab is responsible for **reopening from the URL**
  after each paint — that is what makes `?deepdive=TICKER&view=comparison` survive a reload and
  work as a shared link.
- `refreshWorkspace()` re-renders the current panel in place, for when the data behind it
  changes (a keyword edit).

### Chrome primitives — `js/ui/components.js`

Navigation furniture only: `tabBar`, `railNav`, `segmentedToggle`, `searchInput`, `liveBadge`,
`scopeSummary`, `pill`, `badge`, `scorePill`, `filterChips`, `toolbar`, `emptyState`,
`skeleton`, `spark`, `tooltip`, plus the legacy `statCard` / `sectionHeader` / `dataTable`.
Prefer the screener kit for anything inside a tab panel.

### Adding a scoring model — the pattern prompts 5–7 should follow

**Two models now sit on this contract:** `tech-scoring.js` (16 rules / 24 points, ported verbatim
from LKP) and `earnings-scoring.js` (15 rules / 21 points, built here). They share every shape, so
the screener kit consumes both with zero special-casing. Copy their shape rather than inventing a
new one — earnings is the cleaner reference for a model written from scratch.

1. **The model lives in `js/scoring/<pillar>-scoring.js`** and exports:
   - `ACTIVE_RULES` — `[{ key, label, category, criteria, fn }]`
   - `scoreCompany(c)` → `{ company, breakdown, totalPoints, totalMax, scorePct, hardFails, naCount, tickerError? }`
   - `TOTAL_MAX` — the model's declared maximum, computed as `ACTIVE_RULES.reduce(… r.fn({}).max)`
     so it can never drift from the rules themselves.

   Each rule `fn(c)` returns `{ points, max, status, value, note }` where `status` is one of
   `pass | partial | fail | hard_fail | na`. **Missing input must return `na` with the rule's
   `max`** — never a zero that reads like a real measurement. A rule with no data costs the
   company those points and says so in the drill.

   `na` is also the right answer for input that is *present but meaningless*: earnings returns it
   for the other-income and tax-rate ratios when PBT ≤ 0, and for operating-profit-vs-PAT growth
   when either side is an operating loss. Taken literally that last rule rewards a collapse —
   operating profit falling from +466 Cr to −268 Cr scores −157%, which "beats" a PAT down −208%
   and would hand an operating-loss quarter full marks for earnings quality. **Check every
   ratio-of-growth-rates rule for that failure mode**, and give the `na` branch a `value` string
   showing the raw numbers so the drill still explains itself.

2. **Provenance lives in `rule-meta.js` under `META[tabId][ruleKey]`**:
   `{ source(company), calculation, clientLogic, ourLogic }`. One file, one entry per model —
   `META.technicals`, `META.earnings`. (`RULE_META` remains exported as an alias of
   `META.technicals` so the technicals drill needed no change.) A non-null `ourLogic` is what
   turns the drill panel's Implementation chip amber — set it whenever the implementation
   deviates from the stated logic, and explain how. Four earnings rules carry one.

3. **The data layer lives in `js/data/<feed>.js`**: fetch once, score once, cache, and expose
   `load() / all() / byTicker() / meta() / forScope()`. Tabs must never rescore on a sub-view or
   scope change — filter the cached list. If `app.js` already loads the payload at bootstrap,
   export a `prime(payload)` so the module seeds its cache instead of refetching.

4. **The tab turns scoring on** by passing `showScore` + `score(row)` and `showSignals` +
   `signals(row)` to `scoreTable`, and adds `legendStrip()`. Until a real model exists, leave both
   off — see the honesty rules above.

Score points may be fractional (ADX 20–25 scores 0.5; the earnings tax-rate rule scores 0.5).
Format with a helper, don't assume integers.

A gap between two percentages is measured in **percentage points**. Use a `pp` formatter —
`fmtSigned(gap) + ' pp'` renders the doubled unit "+2.0% pp".

### Reproducing someone else's analysis — the StockScans rule

The Con-call tab's live half shows a **result score**, a **sentiment tier** and **highlight
bullets** that StockScans computed, not us. That is allowed, and it is the user's explicit choice.
What makes it honest is that the boundary never blurs:

1. **Do not re-band, re-scale or recompute.** `resultTierOf()` in `js/data/stockscans-shared.js`
   uses StockScans' own cut-points (80 / 60 / 40 / 20), lifted from their client. A band of our
   invention under their score would read as their judgement and be ours.
2. **Say it is not ours on every surface — the claim, not the brand.** The sub-view description,
   the Live pill's modal, the drill's Provenance group and row 1 of the exported sheet all say the
   scores are a third-party research provider's and that this dashboard adds no scoring of its own.
   The export banner matters most — a workbook leaves the page without its chrome.

   **The provider's brand is deliberately not printed on any customer-facing surface.** It is named
   in the code, in `docs/DATA-CONTRACTS.md` and in the module names, and every row links straight to
   their own page for that call — but the UI says "the research provider", not the trade name. These
   are two different obligations and only one of them is about honesty: the reader is owed the fact
   that the judgement on screen is not this dashboard's, which is stated in full everywhere. Which
   supplier produced it is a commercial matter and the owner's call. **Never trade the first away
   for the second** — dropping the name is fine, dropping "not ours" is not, and `verify-ui.mjs`
   asserts the pair together on the panel and in the drill: no brand anywhere, the disclaimer
   everywhere.
3. **`pending` is not zero.** A call joins the feed when it is *held* and gains its analysis some
   minutes later. Until then the score is null and renders `pending`, exactly as it does upstream.
   A zero would claim they assessed it and found it worthless.
4. **Link, do not reproduce — and check that the link resolves.** Full summaries and transcripts
   stay on StockScans; rows deep-link to their reader. We surface their index, not their content.
   **This is also why the con-call rows are inert.** They used to open a drill panel restating the
   score, the tier and the highlights already in the columns beside them — all of it theirs — so its
   only unique content was the link out, which is now a column. A per-company panel about somebody
   else's analysis, under our chrome, is the one place that line blurs. The attribution it carried
   moved to the Live pill, which is the same resolution the Earnings Hub took.

   **A constructed deep link must be verified against the upstream before it ships.** `docUrl()`
   built their *company* route, `/company/<id>/<type>/<period>/<file>`, in which every segment is
   required — and the scan payload carries no period at all, so the segment was always missing and
   **every link on the tab 404'd**. It looked like a link, it behaved like a link, and it had never
   once resolved. Worse, the artefact of the failure was *their* 404 page, which reads as "their
   document is gone" when the document was fine and the URL was ours. Their reader has a second
   entrance that takes only the document key — `/document/<file>` — which is what their own
   transcript button uses and what we use now, because it cannot be built short. `curl -o /dev/null
   -w '%{http_code}'` on one real row is the whole test; the suite asserts the route shape.
5. **One definition of the vocabulary.** `public/js/data/stockscans-shared.js` is pure and is
   imported by `worker/stockscans.mjs`, so the browser and the Worker cannot drift about what
   "Strong" means.

The same rules apply to any feed where the *analysis* is someone else's rather than the
*measurement*. **Institutions is the second consumer**: a shareholding filing discloses a share
count and a percentage of the company and never a rupee amount, so the ₹ value beside every
holding is Trendlyne's derivation — reproduced unchanged, headed "Value (Trendlyne)", and split
from the filings in the drill's Provenance group. `scrape-institution-holdings.mjs` refuses to
write the file unless its own total matches the one Trendlyne print on the page, which is how a
parse that silently dropped a row would be caught rather than shipped.

**Concall Deep Dive is the third**, and the strongest case: the whole artefact is theirs, not one
column of it. See below.

**Superstar Investors is the fourth**: the holding percentages are the companies' own filings, and
the ₹ value beside each one is Ticker Finology's derivation from a percentage and a market cap —
headed *Value (Finology)*, reproduced, never recomputed. The single figure this dashboard computes
on that feed is the quarter-over-quarter change, and it is headed *Change (derived)*.

### Rolling ninety books up into one screen — `quarterSummary()`

The Quarterly Changes in-page tab exists so a reader does not open ninety books one at a time. It
is a cross-book roll-up: who bought what, who sold what, and where more than one tracked investor
moved on the same company. *All Investors* is the default before it and contains only the investor
cards. *Data Table* follows Quarterly Changes and contains the full disclosed-positions table with
its search, filters, watchlist control and export. Keeping those three jobs in separate tabs avoids
making the investor directory a long preamble to a wide table. The roll-up replaced three stat
cards, two of which described the *feed* (how many books loaded, what they total) rather than
answering anything, and a third that was a pair of counts with no names attached — so the only way
to act on it was to open the books.

`quarterSummary({ include, limit })` in `js/data/super-investors.js` is the whole of it, and it is
a roll-up of `deriveMoves` rather than a new model. **Four numbers it refuses to invent**, each of
which is the obvious feature request:

1. **No rupee size on any move.** `valueCr` is Finology's derivation of what a position is worth
   *now*, not what was traded. Ranking "largest buys" by it answers *"who holds the biggest
   position that also grew"* and prints a rupee figure for a trade nobody disclosed. Increases and
   reductions are ranked in **percentage points of the company**, which is the only size the filing
   states.
2. **No size at all on a new or exited position.** `deriveMoves` leaves `deltaPp` null for both on
   purpose. New entrants are ranked by the stake they now disclose; exits carry the stake last
   disclosed, worded *"was 4.02%"*, never a delta.
3. **"Exited" is not "sold".** Below the disclosure threshold a real holding vanishes from the
   pattern, so every surface says *no longer disclosed*.
4. **Consensus is a COUNT, not a signal.** *"Bought by more than one investor"* says how many
   tracked investors added or newly disclosed the same company. Not weighted, not scored, not a
   recommendation.

**The books are not all on the same quarter**, because each is compared against its own two most
recent published ones. `pairs` reports how many (latest, prior) pairs the roll-up spans so the head
can say so instead of implying one clean boundary, and a book publishing a single quarter is
counted as not comparable rather than reading as an investor who did nothing.

**The head prints how many books CONTRIBUTED, out of how many are comparable.** Under a narrowed
scope "5 new across 87 comparable books" is true and sounds like 87 investors moved on five
companies; *"across 33 of 87"* cannot be read that way.

**Every company row opens the complete cross-investor detail.** The five-row cards abbreviate
three names to `+1` and a largest-move row necessarily names only the investor who produced that
move; neither is enough to answer who else holds the company. The popup reads `allHoldings()` and
lists every tracked investor whose own latest/prior pair contains it, including unchanged holders,
with the two filed stakes, derived change and current Finology value. A position absent from both
comparison quarters is old history and stays out; a current one-quarter disclosure stays in and is
labelled not comparable.

**`scopeFilter(ctx)` is one predicate, used by the summary AND the table under it.** Two predicates
over the same question is what had the filings tabs reporting different sets in two places on one
screen.

### Finology's two endpoints disagree about a name

The list says *"Abakkus Fund - Sunil Singhania"*; the book says *"Abakkus Fund - Sunil Singhania
Portfolio, Shareholdings & Investments."* — their page title, SEO suffix and all. The cards always
read the list, so the table beneath them and its investor filter were showing a different string
for the same person, and three of those suffixes in one summary row is unreadable. `displayName()`
resolves it from the list for every derived view, so one person is one string on the page. It is
**not** a regex that strips the suffix: the list is the authoritative display name, and a pattern
match would quietly fail the day they reword it.

### Two disclosures that look identical — the Institutions rule

Institutions is also where a subtler failure lives, and it is not about *whose* number it is but
about *what it measures*. Two kinds of fund sit behind one picker:

| `disclosure` | Who discloses | The percentage is | The ₹ value is |
| --- | --- | --- | --- |
| `shareholding` | the **company**, quarterly, to the exchanges | how much **of the company** the fund owns | Trendlyne's **derivation** |
| `portfolio` | the **fund**, monthly, by the AMC | **% to NAV** — how much **of the fund** is in the company | the AMC's **own published figure** |

Both render as "2.5" against a company name. One is a large stake in a business; the other is a
small slice of a fund. **They are inverse measurements and there is no arithmetic that relates
them** — so nothing sums, averages or ranks across the two, and the view has no combined-book
figure at all. The suite asserts that no number on the page equals the sum across both.

What makes this survivable is that the difference is stated on every surface a figure reaches:
the column heading (`% to NAV` versus `Holding %`), the pill (*Disclosed* versus *Filed*), the
provenance modal, the drill's Provenance group, and row 1 of the exported sheet — which matters
most, because a workbook leaves the page without its chrome and a reader who merges two exports in
Excel has nothing else to go on.

Two things follow that are easy to get wrong the other way:

- **Do not give one kind the other's furniture.** A monthly portfolio disclosure states a weight and
  a value and no share count, so the AMC funds have **no Qty column** rather than one holding 258
  em dashes. A column of dashes says "we asked and were refused"; the honest statement is that this
  disclosure does not answer that question.
- **A blank means different things and must say which.** In a filing it is *not filed yet* — the
  company files weeks after the quarter closes and the position is still held. In a portfolio it is
  *not held* — the fund was out of the line that month. Same em dash, two tooltips, and `former[]`
  keeps a line that left the book out of the table rather than showing it at nil.

`js/data/institution-holdings.js` aliases both shapes into one vocabulary (`periods`,
`periodLabels`, `periodNoun`, `pctByPeriod`, `pct`) so the screener kit consumes them unchanged.
**Those shared names describe the shape, not the meaning** — `columnsFor()` in `js/investors/filed.js`
is the single place that decides what a percentage is called, and every consumer must branch on
`disclosure` before writing a heading.

**The Institutions Quarterly Changes tab branches before it aggregates.** It mirrors Superstar
Investors' six-panel cross-book view, but `quarterlySummary()` admits only shareholding books; AMC
portfolio weights stay under All Institutions. Every company button opens
`quarterlyCompany(key)`, which includes all relevant quarterly institution books with prior/current
stake, status, derived pp change, Trendlyne value and shares held. `Filing Awaited` is retained as a
current pending disclosure and excluded from move counts — never turned into no longer disclosed.

### An upstream you CANNOT proxy — the same-zone Worker rule

Every other upstream here is proxied through our Worker, for politeness and for somewhere to stand
when it fails. The chatter API is not, and the reason is a platform rule rather than a preference.

**Cloudflare refuses a subrequest from one Worker to another Worker's `*.workers.dev` hostname on
the same account** — error 1042, *"Worker tried to fetch from another Worker on the same zone,
which is not allowed"* — and surfaces the refusal as a **404**. A `/api/chatter` route was written,
deployed, and returned 404 in production while `curl` returned 200 from the identical URL.

Three things to take from it:

1. **A 404 from an upstream is not proof the upstream is missing.** The tab said *"check that the
   API is deployed"* and the API was deployed, healthy, and answering. Diagnosis went to the one
   place with nothing wrong. When a named failure state can be produced by two very different
   causes, the message has to admit both — see `unavailablePanel` in `js/tabs/public-chatter.js`.
2. **`wrangler dev` versus the deployment is the test that settles it.** Identical code, variable
   and URL: locally it returned all 219 entries, deployed it returned a 404. That eliminates path
   construction, configuration and the upstream in one comparison, and leaves only *where the
   request is made from*. Run it first whenever an upstream behaves differently in production.
   The natural experiment was in the code too — moneycontrol.com, stockscans.in and devde.muns.io
   all worked, and the single `*.workers.dev` upstream was the single failure.
3. **The fix is where the call is made from, not what it sends.** The browser calls it directly, as
   it already does the Concall Deep Dive Worker. If a future upstream on this account genuinely
   needs proxying — to hold a credential — use a **service binding** (`"services"` in
   `wrangler.jsonc`) or give it a **custom domain**. Another `fetch()` cannot work.

**Carry the requested URL into the failure.** The first version recorded only a status code, and a
bare "404" is unfalsifiable: it cost a long investigation during which the upstream was healthy and
answering 200 to `curl` the whole time, while nothing on screen said which address had been asked
for. A failure state that cannot be diagnosed from its own artefact is half a failure state.

Calling from the browser cost nothing here, and that is a fact that was checked rather than
assumed: the API sends `access-control-allow-origin: *`, exposes `ETag` via
`access-control-expose-headers`, and answers `If-None-Match` with a bodyless 304 — so
`conditionalJson` and the device store behave exactly as they did against our own route. **Verify
those three headers with `curl -D-` before moving any feed to the browser**; without an exposed
ETag the client cannot revalidate and every poll becomes a full download.

### Three feeds whose SHAPE is not ours to pin — the filings rule

News, Corporate Announcements and Insider Trades all come from the Muns API, and when they were
wired **not one of them could be probed**: the only token available locally was a ten-character
placeholder, and all three answer 401/403 without a real one. So they were built against a written
contract rather than an observed response, and everything about them assumes that contract is
approximately right rather than exactly right.

That is survivable, and this is what makes it survivable:

1. **Read by shape and by candidate key, never by one guessed field name.**
   `js/data/filings-shared.js` tries a list of plausible keys for each field and keeps the untouched
   record beside the normalised one. A rename upstream costs one column, not the tab. This is the
   Deep Dive rule (*render by shape, not by field name*) applied to a payload nobody has seen.
2. **A field that is absent stays null.** It renders as an em dash with a title saying the source
   did not carry it. Nothing is defaulted, and a date that cannot be parsed is **not** today's — it
   is blank, and the row sorts last rather than first.
3. **Insider trades answers with MARKDOWN, not JSON** — the only upstream here that does. Its
   columns are therefore *unknown at build time*, so the table is built from whatever headers the
   markdown declared, in their order, under **their headings**. Renaming "Acq/Disp" to "Action"
   would put our word on their data and would hide a column the day they add one.
4. **Nothing is summed and nothing is scored.** No total quantity, no total value, no sentiment, no
   materiality flag. A quantity written `1,20,000 (pledged)` is not a number; adding those up either
   throws or, worse, quietly produces one. These tabs have no model behind them, so `showScore` and
   `showSignals` stay off rather than rendering empty score furniture.
5. **The credential is a session JWT, so it EXPIRES.** Unlike a static key, a working deployment
   starts returning 401 on a day nobody changed anything. `unauthorised` is its own named state all
   the way to the screen and says so in those words, because the first instinct on a sudden 401 is
   to look for a bug in the request.
6. **A route builds its own query string; a caller must never patch a `?` onto one.** The date range
   was built once as `` `&from=…&to=…`.replace('&', '?') `` and appended to all three routes. Correct
   for the two path-parameter routes and wrong for `api/news?q=…`, which then carried **two question
   marks** — and that parses, fetches and returns **HTTP 200**. The Worker read `q` as
   `"RELIANCE?from=2026-07-18"` and `from` as absent, so every company was searched for as that
   literal string and the tab filled with the same generic market news for all forty of them. Only
   the route knows whether it already has a query string, so only the route may append to it.
7. **Search by the company NAME, and append nothing to it.** `?q=JAYNECOIND` returns three results,
   mostly price widgets; `?q=Jayaswal Neco Industries` returns twenty about the company; adding
   "share price results" ranks an unrelated IPO story second, because the extra words are themselves
   terms the engine ranks on. The scrape and the browser walk send the identical query so the
   snapshot and the live walk cannot disagree about what a company's news is. The ticker remains
   what a row is filed under and what the device cache is keyed by — only the search term changes.
8. **One definition of "still needs asking about", used by the queue AND by the request.** There
   were two: the queue took every company whose rows were stale, and the request then returned early
   for any company that had rows at all. So the walk counted down through forty companies **without
   sending a request**, the strip said "reading 40 more companies" throughout, and nothing was ever
   revalidated once its window expired. Two disagreeing predicates over the same question is the
   shape to look for; the fix is that there is only one.
9. **`origin` is derived, never assigned.** Four places wrote to it and it read `null` for the whole
   of a live walk — which the pill renders as *"Live"* over rows that came off the device. It is now
   computed from what is painted and what the server confirmed **in this session**, so it cannot
   drift from them. Bytes this device kept from an earlier visit read *Cached*: they have a real
   `checkedAt` and they have not been checked now, and those are different claims.

**Nothing here walks on a page load.** See *Work the reader has to ask for* above: these are the
reference consumers of that rule, and the three measurements in it are all from these feeds.

**The universe is served from a committed snapshot, not from a live fan-out.** These upstreams are
per-ticker and capped at ~60 requests a minute, so 603 companies live is ten minutes of somebody
else's service on every visit. `scripts/scrape-filings.mjs` pays that once on a schedule and commits
the result; the live routes remain for companies the snapshot misses and for refreshing one on
demand, bounded at `LIVE_LIMIT` with the shortfall printed on screen. The scrape walks **the book
first**, so a run cut short by the rate limit or an expiring token has covered the holdings rather
than whatever starts with A.

### A BORROWED FLAG IS NOT A MATERIALITY RULE — what the keywords replaced on announcements

The tracked keywords reach Corp Announcements too, matched against the filing's own subject and
BSE's own sub-category (*"Award of Order / Receipt of Order"*, *"Resignation of Director"*, *"Credit
Rating"* are the exchange's words for exactly what this desk tracks). Two things about how, and the
second is the point.

**It REPLACED a gate rather than sitting beside one.** `announcementSignal()` already had a
materiality rule and `js/data/news-keywords.js` is not allowed to become a second one over the same
question — that is the pattern this codebase keeps having to un-write. So there is one predicate
with stated inputs: a tracked keyword, **or** the directional rule matched. The directional rule
keeps its own materiality, because a dividend record date and a credit-rating upgrade carry no
tracked keyword and must not quietly stop mattering.

**And BSE's own `critical` flag came out of it.** It is still reproduced on every row and in the
export — it is theirs and a reader is owed it — but it no longer decides what General Alerts calls
important. Measured on the retained capture: it marks **1,147 of 3,942 filings (29%)**, of which
1,074 match nothing else, and **881 of those are AGM notices**; the rest are board-meeting
intimations and new listings. It is a *calendar* flag. Borrowing it as our gate made **a third of
the whole exchange** high-importance, which is the same noise the keywords were brought in to
remove, one tab over. High importance on this feed went from **32% of filings to 11%**.

`BSE_CRITICAL_IS_MATERIAL` exists so that decision is one visible, reversible constant rather than
an expression — flipping it to `true` restores the old behaviour exactly. **Direction is untouched**:
the narrow negative/positive rules over the filing text are unchanged, and the suite asserts a
downgrade is still negative, a dividend still positive and an AGM still neutral.

**The Topic column took the Sub-category column's place**, exactly as News' took the Outlet
column's: `rowSub` already prints the sub-category under every subject, so the column was a second
copy of it. The sub-category keeps its own filter and its place in the export. **The strict
"names the company" filter option is dropped here** — a BSE filing *is* the company's own
statement, so the question does not arise.

### AN EXPLANATION WITH NO DOOR IS WORSE THAN NO EXPLANATION — where provenance is reached from

`cfg.provenance` was built by all three filings tabs, `openProvenanceFactory` built a handler, and
**nothing ever called it**. `sourcesModalHtml()` was exported and imported by nobody;
`sourceGroups()` was named only in a comment. All of it was correct, maintained, and unreachable.

That is a worse state than absent, because unreachable content **reads as documentation of a working
feature**: the registry looked like the canonical home for provenance, and this file said so — *"the
Sources button and its popup are gone from the chrome… canonical provenance remains in the source
registry"* — while the registry had no way in at all. The second half of that sentence was a promise
the app did not keep.

**The fix is a door, not the old chrome back.** Both decisions that removed the chrome stand
unchanged: the header carries no Sources button, and every status pill is a passive `<span>` that
opens nothing. What was wrong was never that the pill stopped opening a modal — it was that nothing
else opened one either.

- **The source registry** is reached from a **footer**, one muted line under the content column, on
  every tab. A footer is the one position that cannot compete with the table it qualifies, which was
  the entire reason the chrome was removed; it is also where a reader already looks for provenance.
- **Each filings tab's own provenance** is reached from one muted line **under its table**. It is
  wired rather than pruned because it carries what no static registry can: the **measured coverage
  for the rows on screen** — how many companies answered, how many had nothing, how many could not be
  read. The denominator rule says that number stays REACHABLE, not that it stays on the page.
- **`sourcesModalHtml()` is a function called on open**, which is what lets a static footer reach
  live figures without going stale. That is the same rule that killed the old hand-typed source
  array; see *Data sources* above.

**The footer lives inside a template literal in `shell.js`, so it may contain no backticks.** The
comment beside it says so because writing one there terminates the literal and takes the whole page
down — which is exactly how this footer broke on its first attempt.

### ASK THE AXIS THE DATA IS PUBLISHED ON — the rule that fixed announcements

The paragraph above is what these three tabs were built on, and for two of them it is still true.
For corporate announcements it was solving the wrong problem, and the way it looked wrong is worth
keeping.

The committed snapshot reached **118 companies** and the tab said so honestly — the pill printed the
denominator, the shortfall was on screen, `failed` was populated. Everything was accurate and the
coverage was still a fifth of what it should be. The obvious remedy is to shrink the window: show
one day instead of a year. **That buys nothing.** The date range is a *parameter* on a per-company
request — `?fromDate=…&toDate=…` — so one day for 603 companies is still 603 requests, the same ten
minutes and the same truncation, with a year of history thrown away for it.

**What was actually wrong was the axis.** The upstream is indexed by *company*: "what did this
company file". BSE publish the identical filings indexed by *date*: "what was filed on this day",
across every listed company, in one paginated feed. Measured: **886 announcements for the whole
exchange in about two dozen requests**, against 603 requests that reached 118 companies. No
credential either, so it cannot fail the way a session JWT fails.

So: **when a feed is rate-capped per request and you need breadth, do not tune the request — check
whether the upstream publishes the same facts under a different key.** Narrowing a window on an
entity-indexed route is optimising a parameter that was never the cost. Changing the index is the
whole win. The tell is that the thing you want is *n × m* and the endpoint charges you for *n*: ask
whether anyone charges for *m* instead.

Three things follow, and each is load-bearing:

1. **`coversUniverse` in the snapshot is what switches the walk off, and only that.** A date-indexed
   capture makes an absence meaningful — a company with no rows filed nothing — so the per-company
   walk becomes not merely unnecessary but wrong, since it would spend the rate limit rediscovering
   that. **It must never be inferred from a row count**: a count cannot tell "nobody filed" from "we
   ran out of budget", which is the exact confusion this change exists to end. The snapshot declares
   it or the walk runs.
2. **`strCat=-1` is a 200 that means the request was wrong.** The obvious "all categories" value
   answers HTTP 200 with the bare string `"No Record Found!"`, and an empty `strCat` answers 200
   with zero rows. Neither is an error and neither is an empty day. So the categories are named
   explicitly, `assertShape` rejects the string form outright, and a run that collects nothing across
   every category exits non-zero rather than committing an empty file over a good one. Naming them
   costs a tripwire: `unknownCategories` checks every row's own `CATEGORYNAME` against what we asked
   for, so a category BSE adds later shows up in the run report instead of silently vanishing.
3. **The window is a SIZE limit, not an editorial one.** A weekday carries ~900 filings across the
   exchange, so a month is ~22,000 rows and roughly 16 MB of committed JSON that every visitor
   downloads. `ANN_KEEP_DAYS` (default 3) is a ceiling on bytes, and the file says so. Older filings
   are not less true; BSE still hold them, and widening it is one variable and one re-run.

### AN UPSTREAM NEITHER THE BROWSER NOR THE WORKER CAN READ — the market-news rule

Every other upstream here is reachable from somewhere we control: the browser calls the chatter API
directly, the Worker proxies Moneycontrol's *API* and StockScans and Finology. `www.moneycontrol.com`
is the first one that is reachable from **neither**, and the way that was established is the point.

| Reader | Result |
| --- | --- |
| `curl` + a browser user-agent | **200**, 598 KB, articles present |
| node `fetch`, bare user-agent | **403**, 24-byte body |
| node `fetch`, user-agent + accept | **403**, 24-byte body |
| node `fetch`, the full sixteen-header browser set (`sec-fetch-*`, `sec-ch-ua`, …) | **403**, 24-byte body |
| **a Cloudflare Worker under `wrangler dev`** | **403**, 24-byte body |

**It is TLS/HTTP2 fingerprinting, not headers**, so tuning headers is time spent on the wrong thing —
and the Worker result is what settles the architecture, because it removes the proxy route that every
other credentialed or awkward upstream here uses. Note that `api.moneycontrol.com`, which
`worker/mc.mjs` uses for the earnings feed, does **not** do this: it is the `www` host only, so "we
already read Moneycontrol" is not evidence that this will work.

Three consequences, and the third is the one that matters to the reader:

1. **A GitHub Action on a normal runner is the only thing that can read it**, so the feed is a
   committed capture and `scripts/scrape-mc-news.mjs` shells out to `curl`. `worker/mc-news.mjs`
   stays pure and takes `fetchImpl` as a parameter, which is what lets the parser be tested offline
   without knowing anything about that.
2. **A committed capture is worth nothing until it is deployed** — and **finding out WHICH path
   deploys it is part of the check.** `wrangler.jsonc` serves `public/` through the Worker's
   `assets` binding, so a committed JSON file reaches readers only when a deploy runs.
   `.github/workflows/deploy.yml` was written for that, and on this repository it **has never run**:
   measured, every one of its runs completed in six or seven seconds with the deploy job *skipped*,
   because `CLOUDFLARE_API_TOKEN` is not set. The site is nonetheless current to the minute — a
   commit pushed at 07:58 was serving at 08:0x — because **Cloudflare's own Git integration**
   watches the branch and deploys without any of it.
   So the rule has two halves. *Check that a scheduled capture has a path to the live site before
   believing its cadence* — and then **check which path**, because a workflow reporting success
   while skipping its only real job is indistinguishable from one that works, and the docs went on
   naming the wrong publisher for days. It now prints which mode it is in on every run.
3. **The refresh button must not claim what it cannot do.** It checks whether a *newer capture*
   exists — one conditional GET, usually a bodyless 304 — and says so in those words. So two times
   are printed and never combined: *when Moneycontrol was last read* (how fresh the news is) and
   *when this browser last checked* (whether we hold the newest capture). A twenty-minute-old capture
   confirmed one second ago is fresh in one sense and stale in the other, and one "updated just now"
   would let the second stand in for the first — the same failure as the header's two competing chips.

**And the listing page carries no date on any story.** Verified: no date, time or timestamp element
anywhere on it. The publisher's time lives on each story's own page, so it costs one request per
story, is budgeted (`MCNEWS_DATE_LIMIT`), and the newest are done first. A story the budget did not
reach keeps `publishedAt: null` and the card says *time not published* in those words — an em dash
is right in a date column where the heading supplies the noun, and wrong on an editorial card where
nothing else on the row says what the missing thing was. **It is never stamped with `firstSeenAt`** —
that is when the *scraper* saw the story, it is a fact about us rather than about the story, and it
is kept in its own field so the two cannot be confused. Ordering does not depend on it either way:
Moneycontrol's own article id is in every URL and increases with publication, which is also why it is
the merge key — a headline gets edited after publication and a title-derived key would then read as a
second story.

**SO "REFRESH" HAS TO MEAN SOMETHING ELSE, AND THE HONEST VERSION IS TO ASK THE RUNNER TO RUN.**
The first version of the button could only check whether a newer *capture* had been published, and
it said so — correct, and still not what a reader means by refresh. The runner is the only reader
that works, so the button now dispatches `market-news-refresh.yml` through
`worker/github-actions.mjs` (`POST /api/market-news/refresh`) and watches it (`GET
/api/market-news/run`, free).

**AND THEN IT WAS NO BUTTONS ON THE PAGE AT ALL.** The freshness card — control, a sentence about
the scheduled job, a result line — was a full-width white block above a list whose headlines are the
whole point, and it went the way the Earnings Hub's ribbon and Portfolio's four-line block went:
**move the explanation behind a control that still states the claim, and never delete the claim.**
What is left in the heading is one chip. The provenance modal behind it carries every word, and the
Fetch button now lives inside that modal — removed from the chrome, not from the app.

**A GREEN "LIVE" IS A CLAIM ABOUT DATA AND MAY NOT BE PAINTED UNCONDITIONALLY.** That is precisely
what the header's old green chip did: it tracked a heartbeat that asked no server anything and read
*"just now"* whether or not a byte had been confirmed in an hour. So this chip is green and reads
`Live` only while the capture is younger than the schedule's own worst case (90 minutes — the job
runs half-hourly in the window that works and hourly outside it); past that it turns amber and
prints the age instead, and with no capture it says so. The suite asserts the colour against the
measured age, in both directions.

**IT WAS TWO BUTTONS FOR A WHILE, AND THAT WAS THE WRONG READING OF THE DEEP DIVE RULE.** A free
*Check for new stories* sat beside the metered *Fetch*, on the reasoning that what costs and what
does not must be separate controls. But that rule exists so a reader is never *forced to spend* to
get a free answer — and here they never were: the twenty-minute poll already makes that cheap check
unprompted, and the fetch has always ended by making it too. So the free button bought nothing a
reader was not already getting for nothing, and cost two controls that looked like they did the
same job. **Separating cost is not the same as surfacing it twice.**

The free read is not gone, it is **folded in**: the one button reads the capture first and, if a
scheduled run has already published one this browser lacks, reports that and starts nothing. Only
then does it dispatch. Strictly better than either button alone, and the failure states are
unchanged — which is the part that had to survive the simplification.

That makes this the second consumer of the Deep Dive rules, and they arrive unchanged:

1. **What costs and what does not are separate routes, and only one of them is POST.** Nothing
   dispatches on a page load, on a render, or on a poll — a GET that started a scrape could be
   fired by a prefetcher or a link preview. A dispatch also reads the latest run first and does
   nothing if one is going: their concurrency group would queue a duplicate harmlessly, so this is
   about never being the thing that started a run nobody needed.
2. **Reproduce their vocabulary — where you show it at all.** `queued` / `in_progress` /
   `completed` and the `conclusion` are GitHub's words, and nothing here paraphrases them. But the
   panel no longer narrates them: a reader who pressed one button wants one answer, and a running
   commentary plus a link out to the run is a lot of small text for *"how many stories did I get"*.
   The button reads `Fetching…` and the strip then says how many arrived. **A failure still gets a
   sentence** — `no-token` names a command an operator needs — because that is the one state where
   the detail is the whole value.
3. **The token lives on the Worker**, and the repository, workflow and ref are fixed *server-side*
   so the route cannot be pointed elsewhere by anyone who finds it. One fine-grained token, one
   repository, one permission — *Actions: read and write*.

**And the outcome must never confuse a finished RUN with new stories on the SCREEN.** The scrape
commits only if it found something, and `public/` reaches readers only after a deploy then runs.
So a completed run is not an answer on its own, and a deploy that *started after* the run finished
is the evidence that something was committed — its absence is the evidence that nothing was. That
one extra read is what lets the button say **"Moneycontrol was read just now — nothing new to
publish"**, which is the one honest version of a sentence this tab could never say before (see
*Never claim "nothing is new"* above: the 20-minute poll has no index to ask, and still cannot).
`landed`, `nothing-new`, `publishing`, `published`, `publish-failed`, `failed` and `timed-out` are
seven different statements and the note makes exactly one of them — with `timed-out` never worded
as a failure, because a run outlasting our patience has not failed.

**A static origin is not a broken deployment, and the status that proves it is not the obvious one.**
`python3 -m http.server` answers a POST with **501 Unsupported method**, not 404 — measured, after
the first version of the check looked for 404/405 and reported the sandbox as an upstream failure.
So 404, 405, 501 *and any non-JSON reply* all read as `no-worker`, which says the scheduled run
every 20 minutes is unaffected rather than sending an operator after a token that was never missing.

**AND IN THE END GITHUB'S SCHEDULER HAD TO BE TAKEN OFF THE CRITICAL PATH ENTIRELY.** Relaxing the
cron was the obvious remedy and it is the one the measurements refuted: `*/20 * * * *` fired **12
times against 124** over 41 hours (10%), and after being relaxed to `*/30` across a 12-hour window
it fired **zero times against ~11** in the next 5.7 hours. Tuning a schedule that is not being
honoured is tuning the wrong thing.

**`workflow_dispatch` is not throttled at all** — six dispatches in one day each started a run
within *seconds* of the POST. So the cadence should come from **a scheduler that works driving the
trigger that works**: `scheduled()` in `worker/index.js` dispatches the workflow through the same
`dispatchWorkflow` the button uses, which already declines when a run is in flight.

**AND THE CLOUDFLARE CRON THAT WAS MEANT TO DRIVE IT COULD NOT BE REGISTERED — AN ACCOUNT LIMIT,
NOT A PER-WORKER ONE.** `triggers.crons` was added and the build said:

```
✗ Trigger configuration for "sattva-central-research" was only partially updated:
    Cron schedules:
      - This account has reached the Workers Free limit of 5 cron triggers per ACCOUNT.
```

Five slots, shared across every Worker on the account, already spent. So the trigger never existed
and the handler was never called — three ticks passed with `lastAutomatic: NONE`.

**Two things in that failure are worth keeping.** First, the limit is per *account*: a Worker with
no crons of its own can still be refused, so "this Worker has none" is not a reason to expect one to
register. Second, **a red build here does not mean the site is stale.** `wrangler deploy` uploads
the script and *then* configures triggers, so the code went live on a build that reported failure —
the log even says "Successful trigger changes were not rolled back". The inverse holds too: a green
build is not what proves a trigger registered. Check the thing itself (`lastAutomatic`), never the
build's colour.

`scheduled()` stays in place: it costs nothing without a trigger and starts working the moment a
slot is freed or the plan is upgraded, with no code change.

**AND THE PAGE NO LONGER DEPENDS ON A CLOCK EXISTING AT ALL.** For a stretch the only thing that
refreshed the news was a reader pressing a button to fix a staleness they had already had to notice
— the page failing at its job and asking the reader to compensate. So opening the News tab on a
capture older than twenty minutes now starts one fetch by itself.

**That is a deliberate narrowing of "nothing dispatches on its own", not an abandonment of it**, and
the two reasons behind that rule are why it is safe here. The rule protects against *spending a
metered resource unprompted* — the Deep Dive's paid LLM runs — and against *hammering a rate-limited
service on a page load* — the forty-round-trip filings walk. This is one request to a public listing
page, on our own free runner, gated by the capture's own age and declined at the edge when a run is
already going. **A reader opening the tab is the demand signal**, and acting on it beats a blind
clock: fresh exactly when somebody is reading, nothing when nobody is. The suite asserts the gate in
both directions — a stale capture dispatches, a fresh one does not, and a second open inside the
window never dispatches again, because a failing dispatch that retried on every navigation would be
the page-load walk all over again.

**SO THE CLOCK STILL COMES FROM OUTSIDE, AS A SAFETY NET RATHER THAN THE MECHANISM.** An external cron service posts to
`/api/market-news/refresh?source=cron` every 20 minutes — the settings are in
`docs/DATA-CONTRACTS.md`. That is safe to expose because nothing in the request chooses what runs:
repository, workflow and ref are fixed on the Worker, a run in flight is declined, and the edge
cooldown absorbs a stuck pinger. `?source=` is an **allowlist of three words**, because it reaches
the workflow's `run-name` and an arbitrary string would be somebody else's text in our run list —
and because `lastAutomatic` matches on it, which is the field that answers *is the cadence holding*.

**AND A REFRESH NOBODY PRESSED HAS TO BE FILED AS ONE, OR THE FIELD MEASURING THEM CANNOT SEE IT.**
The three words are `cron` (an external scheduler), `auto` (the tab fetching for a reader who opened
it on a stale capture) and `button` (a person who had to notice the staleness first).
`lastAutomatic` counts the first two, because only the third is the page failing at its job. Filing
an auto-fetch under `button` — which is what it did for one commit — would make every unattended
refresh invisible to the one field that measures them: the same measurement gap, one layer down,
that `?source=` was added to close.

**And a cadence cannot be computed from one sample.** `lastAutomatic` searched a list of *one* run,
so it could only ever be non-null when the newest run happened to be automatic — a single button
press hid a cron that had fired minutes earlier, and the field read as though nothing unattended had
ever run. It searches `RUN_WINDOW` (10) now, about a day at the schedule's own cadence.

**The rule generalises: when a scheduler is not honouring you, stop negotiating with it.** Two
rounds were spent on the cron expression before checking whether the expression was the variable at
all. The tell was in the data the whole time — every *dispatched* run started instantly while every
*scheduled* one was late or absent, which is a fact about the trigger, not about the workload.

**AND THE SCHEDULE IS BEST-EFFORT TWICE OVER, WHICH THE PAGE USED TO OVERSTATE.** The tab said
*"refreshed automatically every 20 minutes"*, and 41 hours of run history says it was wrong on two
independent counts:

1. **GitHub sheds most of a dense cron.** `*/20 * * * *` fired **12 times against 124 scheduled —
   10%** — averaging one run every 3.8 hours. Their scheduler is best-effort on shared
   infrastructure and drops the densest schedules first, so asking for 72 runs a day is how you get
   six. **Never write a cadence into the UI from the cron expression**: the expression is a request,
   not a promise, and the only honest number on screen is when the upstream was *actually* last read.
2. **The publisher refuses the runner outside Indian hours.** Of those 12 runs, **7 were answered
   403** on the listing page, and the split by clock is total — every success fell between 10:27 and
   21:14 IST, every refusal between 20:28 and 05:29 IST. `curl --retry-delay 2` cannot help with
   that: it re-asks the same blocked address two seconds later, which is why every failing run took
   about seven seconds and produced one outcome three times.

So the cron runs every 30 minutes across the window that works and hourly outside it, a 403 gets a
real jittered backoff, and — the part that matters most — **a refusal is not a failed build.** The
scraper exits **2** for it, the workflow turns that into a warning and skips the commit, and exit 1
still means what it always meant: the markup changed, or this code is broken. Reporting a blocked
runner as a broken scraper sends somebody to read working code, and makes the failure notification
worthless when more than half of them are that.

**AND A REFUSAL WEARS TWO COSTUMES, THE SECOND OF WHICH LOOKS EXACTLY LIKE YOUR BUG.** The plain one
is a 403. The other is a **200 with an interstitial**: measured on a dispatched run, a body over
5 KB carrying no article list at all, answered in **0.6 seconds**, while `curl` from elsewhere was
getting the full 600 KB page at that same moment. `assertShape` called that *"the markup has
changed"* — the loudest thing it could say, and wrong, sending somebody to rewrite a working parser.
Same trap as BSE's `strCat=-1`: **a 200 that is not the page you asked for is not evidence about
that page.**

The discriminator has to be positive evidence rather than a guess about their challenge markup. A
Moneycontrol article URL ends `-<id>.html`, so a real listing page — however they restyle it —
carries dozens. **None at all means it is not a listing page in any form**, so it is a refusal
(`blocked`, exit 2). **Article links but no `newslist` blocks IS a redesign** (`shape`, exit 1) and
must still fail loudly, because that is the case a human has to look at. Both carry the status, the
byte count and the link count into the message, so the next one is diagnosable from its own artefact.

**A SECRET THE OPERATOR CANNOT INSTALL IS A FEATURE THAT DOES NOT SHIP, AND THE INSTRUCTION HAS TO
NAME A ROUTE THEY ACTUALLY HAVE.** The Fetch button sat in `no-token` on a live deployment, and the
only thing the page could tell them was `npx wrangler secret put …` — which wants a terminal logged
in to Cloudflare. This deployment does not publish from a terminal *or* from `deploy.yml`; it
publishes from Cloudflare's Git integration, so the honest instruction is the **Cloudflare dashboard
→ Workers & Pages → this Worker → Settings → Variables and Secrets**, which is a web form. The
command is still offered for anyone who has the terminal. **A named fix that the reader cannot carry
out is the same failure as an unnamed one** — it just looks helpful.

`deploy.yml` also syncs `GH_DISPATCH_TOKEN` and `MUNS_TOKEN` from GitHub's secret store when it is
the publish path, which it is not here. Two rules if you touch that: the presence test is **shell,
not a step-level `if:`** — the `secrets` context is not dependable there, which is why the job above
it turns one into an output first — and an unset secret must **skip rather than push an empty
string**, because a blank secret reads as configured and turns `no-token`, which names the fix, into
`unauthorised`, which describes the same state and sends the reader to reissue a token that was
never created.

**RSS looks like the easy answer and is a trap.** `moneycontrol.com/rss/*.xml` still resolve with
HTTP 200 and well-formed `<item>` blocks — `buzzingstocks.xml`, `marketreports.xml`,
`latestnews.xml` — and every one is abandoned: the newest item in each is from **April 2024**, and
`MCtopnews.xml`'s is from **2016**. A 200 with valid XML and plausible `pubDate`s is not a live feed.

**AND THE LESSON IS THE CHECK, NOT THE VERDICT — four other publishers' RSS passed it.** Read as
"RSS is dead" that finding would have cost this tab four live sources. What it actually says is
**a 200 with valid XML is not evidence a feed is live, so read the newest item's date** — and
Business Standard, Mint, Economic Times and Investing.com were each checked that way before being
wired, every one carrying an item from the same hour the check ran. They are in `FEEDS` in
`worker/rss-news.mjs`; do the same before adding a fifth, and drop one whose newest item goes stale,
because a publisher abandoning a feed does not take it down — they stop writing to it, and nothing
in the response says so.

**They are Action-only for the same reason Moneycontrol is, and the measurement is what says so.**
With node's `fetch` — the Worker's reader — Business Standard and Investing.com answer 200 while
**Mint and Economic Times answer 403 with a 24-byte body**, byte-for-byte what `www.moneycontrol.com`
returns, while `curl` with a browser user-agent gets all of them at 200. Two working upstreams are
not a reason to add a Worker route the other two would 403 through.

**And the third feed did not get this treatment, because it cannot.** News is a *search* endpoint —
there is no "everything published today" request to make, only "what has been written about this
company". No axis to switch to.

**It once made the reader name the companies before it would show anything, and that was solving
the wrong half.** The reasoning was sound as far as it went — a live walk of the universe is 603
searches against a sixty-a-minute cap, so a tab that asks before it acts beats one that spends the
budget on forty companies chosen for the reader. What it missed is that the rows for a *scoped* view
are not a live walk at all: `scrape-filings.mjs` walks **the book first** on a schedule and commits
the result, so they are already in `news.json` and cost one conditional GET. Measured on the shipped
capture: **all 123 book tickers, 1,217 articles, no failures.** The picker was charging the reader
attention to avoid a cost that had already been paid.

The 07:00 IST data refresh no longer captures company news or insider trades. Company news has its
own `company-news-refresh.yml` at 09:00 and 19:00 IST; Insider Trades has
`insider-trades-refresh.yml` at 19:00 IST. This keeps long per-company walks from racing with EOD
technicals or each other. GitHub schedules are best-effort, so a single post-paint watchdog checks
the committed capture timestamps and dispatches only an overdue workflow. It never falls back to a
forty-company page-load walk.

So News now loads like the other two — snapshot on mount, nothing per company — and the walk is
still the Refresh button's. **The rule that survives is the one that was always doing the work: a
landing sends no per-company request.** Asking the reader first is the answer when there is nothing
to paint, not when there is.

**An empty search result is not an article.** The scrape records a company it searched and found
nothing for as a single all-null row — 62 of them in the shipped capture — and rendering those put
62 "(untitled)" articles on screen that no upstream ever published. The company is still *covered*,
which is a different fact and one the coverage note still counts: **searched-and-empty, never-asked,
and could-not-be-read are three different answers** and none of them is an article. `keepRow` on the
shared renderer is where a tab says what a row of its own has to carry.

**AND A COMPANY THAT ANSWERED "NOTHING" HAS TO BE WRITTEN DOWN, OR IT READS AS ONE YOU NEVER
ASKED.** The scrape wrote only companies that had something — `if (rows.length) byTicker[t] = …` —
so a company with no trades vanished from the file entirely, indistinguishable from one the run
never reached. `outstanding()` then counted it unchecked for ever. Measured on the shipped insider
capture: the tab said **"51 companies have not been checked since"** about 51 companies that had
all been checked and genuinely have no trades, and offered to re-search them on every visit. It is
the *third* answer going missing, and the honest fix is to record it: `empty: [tickers]` in the
snapshot, excluded from `outstanding()`, so the four states are distinct in the file — **in
`byTicker`** had something, **in `empty`** was asked and had nothing, **in `failed`** could not be
read, **in none of the three** was never reached. Insider's outstanding fell 51 → 3, and the 3 are
real failures.

Two things follow that are easy to get wrong:

- **`covered` counts companies that ANSWERED, not companies that had something to say.** Those are
  different numbers, `withRows` is the second, and both are written so neither has to be reached by
  subtraction. The guard that stops a bad run overwriting a good snapshot compares `covered`,
  because that measures the run rather than the news.
- **Strip the upstream's `raw` field BEFORE asking whether a row carries anything.** `raw` is the
  whole record again, it is never committed and it is never null, so a predicate written to catch
  all-null placeholders passes every row when it runs first. Measured: 46 placeholders went
  straight back into the file under the predicate added to remove them, and the run reported
  "123 of 123 companies" — a number that looked like the fix working.

**THE FILINGS HEAD IS ONE QUIET FRESHNESS LABEL.** Recent captures say `Up to date`; older captures
print their measured age, and a missing timestamp says `Updating`. Internal retry states and words
such as `Partial` do not appear in customer chrome. Coverage, failures and per-company last-good
retention remain in the provenance panel, and the watchdog starts recovery automatically.

**The denominator moved into that chip; it was not dropped.** `scopeSummary`'s sentence is
reproduced whole in the chip's `title` and again in its modal, because the rule was always that the
number stays REACHABLE — 23 rows look complete until you know the book is 142 — and never that it
occupies the top of the page. `scopeTitle()` is the one place that wording lives now, and it still
compares companies with companies.

**AND `covered` COUNTING ANSWERS RE-OPENED THE HOLE THE GUARD WAS THERE TO CLOSE.** Once it meant
"companies that answered" rather than "companies with rows", an upstream timing out stopped looking
like a bad run: every company answers *nothing*, `empty` absorbs them all, `covered` stays at the
full list, and the guard waves the snapshot through. Measured on one scheduled news run against a
healthy one an hour earlier — **77 companies with news → 23, 1,536 rows → 450, and `covered` was
123 both times.** So `withRows` is guarded too, proportionally (half) rather than absolutely,
because that number legitimately drifts — a company has news this week and none next — and a strict
"never fewer" would block almost every honest run. **Widening what a number means widens what it
can hide**; check every guard that reads it.

**A coverage gap the reader cannot account for reads as a broken fetch.** "Portfolio · 61 of 142
companies with articles" is true and says nothing about whether the other 81 were searched — and
they were. The strip states the account instead: *"123 of 123 companies in scope were searched, 46
of them had no articles in the last 30 days. A further 19 book lines carry no NSE symbol."* Every
clause drops out when its number is zero rather than printing a nil, and a date-indexed capture
says something different in its own words, because it asked the exchange rather than the companies
and "searched" is the wrong verb for it.

**A company that could not be read is not a company with nothing.** Failures are kept per ticker,
counted in the pill, and written into the snapshot under `failed`. Rendering them as zero rows would
report an outage as an absence of events — the same error class as a count of zero from a failing
endpoint (see *And a count of zero is not always a count*).

### THIRTY WORDS THAT MAKE A SEARCH FEED USABLE — the tracked-keyword rule

`public/js/data/news-keywords.js` is the desk's own vocabulary and the only definition of it. Both
News surfaces filter by it, and General Alerts uses it as the materiality rule for company news.

**It exists because the news upstream is a SEARCH BY COMPANY NAME, and names collide.** Measured on
the shipped capture: 11,060 stories across 559 companies, of which a company called *iDream Film*
collects Bollywood reunion coverage and *GOCL* collects "stock on fire". Filtering by the thirty
keywords leaves **2,889 rows — a 74% cut** — and every one of the thirty fires at least twice, so no
entry in the vocabulary is dead weight. That is the whole feature: the upstream supplied the company
name, and this supplies the "+ keyword" half of what the desk actually tracks.

**Do NOT read "company name + keyword" as a query to send.** 559 companies × 30 keywords is 16,770
requests against a sixty-a-minute cap — four and a half hours for one pass, on a feed the scrape
already covers in one request per company. This is *Ask the axis the data is published on* arrived
at from the other side: a search endpoint has no cheaper axis, so the answer is to spend nothing
extra and classify the capture that is already paid for.

Five rules, and the first is the one that could have been got wrong quietly:

0. **A headline match, not a standfirst one, is what promotes a story.** The publisher chose the
   headline; a standfirst is a paragraph that happened to contain the word — and several outlets
   fill that field with a **related-links strip**, so one Business Today sidebar mentioning *"CEO
   steps down"* was tagging unrelated stories about MCX and aircraft leasing as *Resignation*.
   Nothing was wrong with the pattern; the field it read was not that story's summary. Measured:
   3,278 stories carry a tracked keyword somewhere, 1,990 carry one in the headline. **The FILTER
   still matches both** and the chip is muted when the match was standfirst-only — exploring a feed
   and asserting a company needs attention are different jobs, and only the second is a claim.
0. **Both halves, or it is not an alert.** A keyword on its own is half the desk's rule: the search
   returns a *name* match, so a story carrying a tracked word that does **not** carry the company is
   a story about somebody else, and promoting it puts another company's order win at the top of this
   company's card — the exact noise the keywords were brought in to remove, re-introduced one layer
   up. Such a row is **not dropped and keeps its tags**; it stays in the timeline at low importance
   and the reason says which half failed. `null` still counts: an unverifiable name is not a failed
   one. The heuristic's known limit is a **generic industry word** — a story about *Indo Tech
   Transformers* reads as naming *Transformers & Rectifiers* — so this narrows the noise, it does
   not end it.
1. **A keyword is a TOPIC, never a direction.** `tabs/news.js` carries no sentiment of ours over
   somebody else's reporting and that is untouched: *Lawsuit* is something a company can be on
   either side of, *Approval* can be somebody else's. So every company-news event in General Alerts
   stays **directionally neutral exactly as it was**, and what a match changes is **importance** —
   which is the question the desk's list was written to answer. The suite asserts the direction is
   still neutral on *Fraud* and on *Sued*, in those words.
2. **A match is a word in a headline, not a verified event.** Every reason string says "matched the
   tracked keyword X" and never "the company won an order".
3. **The desk's words are reproduced; the patterns are ours and are narrower.** `label` is the term
   as given and is what every surface prints; `test` is what matches, and a `note` says where the
   two differ — a bare `\btrials?\b` matched 26 stories, mostly free-trial boilerplate and one
   album release; a bare `\bfire\b` matched "Under Fire", "stock on fire" and a wrestling billing;
   `\bquits?\b` matched "quit California". Each narrowing is asserted as a narrowing rather than
   described.
4. **The filter always offers "No tracked keyword".** A filter that can only narrow to what it
   recognises can never be checked, and a pattern that is quietly too narrow looks exactly like a
   quiet week. That option is how a miss gets found, and the suite asserts tracked + untracked is
   the whole set.
5. **`namesCompany` marks a row and never drops one.** It is the other half of "company name +
   keyword" and it is a heuristic: it reads `false` for a company known by a brand its search term
   omits (GOCL trading as Gulf Oil is the case in the shipped data), so silently excluding on it
   would discard real coverage on a guess — measured, 332 of 3,221 matches. It is **three answers,
   not two**: `null` where there is no search term to check against, because "we cannot tell" and
   "it does not" are different claims. The strict reading is offered as its own labelled filter
   option and is never applied behind the reader's back.

**The Topic column took the Outlet column's place rather than being added beside it.** The outlet
was already in every row's sub-line, so the column was a second copy of it, and the headline is
capped at 780px precisely because two stories truncate to the same string below that. The outlet is
still in the sub-line, still its own filter and still a column in the export.

**Every filter option carries a MEASURED count**, computed from the rows in scope — the same rule
`sourceGroups()` follows. A reader can see that *Order* is twelve rows before spending a click, and
can see a keyword matching nothing today.

**The market-wide half gets the same filter minus the strict option**, because "names the company"
is unanswerable on rows that carry no company, and a control that silently means something else on
one half of a tab is worse than an absent one.

### The one hand-rolled list — when a row is editorial rather than a record

`js/tabs/market-news-view.js` is the single place in this dashboard that does not build its rows out
of `scoreTable`, and the exception is narrow enough to state exactly.

**The kit models a record with columns.** Every other feed here is one: a company, a score, a date, a
percentage — cells the reader compares down the column. A news story is not that shape. Its row is a
thumbnail, a headline and a standfirst, and the headline **is** the row; forcing it into a table made
a headline share its width with a date column and a section chip, which is the ranking exactly
backwards. So this tab reproduces the publisher's own card — image left, headline, standfirst, then a
muted line of time / section / premium — and **the whole card is the anchor**, because a news list
where only a small arrow is clickable makes the reader hunt for the one live pixel. `target="_blank"`
with `rel="noopener noreferrer"`, since the destination is not ours.

Opting out of the kit does **not** opt out of what the kit was protecting, and all four are kept by
hand here:

1. **A screenful first, then the rest under `requestIdleCallback`.** 600 cards is far more DOM than
   600 table rows, so mounting it all up front would block the main thread on every visit.
   `data-rows-pending` on the section is the honest signal that stories are outstanding, and the
   suite waits on that attribute rather than sleeping.
2. **Keys derived from content** — the publisher's article id — never from a position. Same rule, and
   the same failure it prevents, as *Performance on large tables*.
3. **The count and the export read the ARRAY, never the DOM.** A fill still in flight must not be
   able to truncate a workbook or under-report the result of a search.
4. **Every string escaped.** These are somebody else's headlines arriving over the network.

Two things it must do that a `scoreTable` would have done for free, so they are easy to forget:
**rebuild only the list when the reader types** (a full repaint takes the focus and the caret out of
the search box they are typing into), and **own the scroll position** — a capture landing must not
throw the reader back to the top, and a *new filter* must, because a new filter is a new list.

**Do not read this as licence to hand-roll the next table.** The test is whether the row is a record
with columns or a piece of editorial. Everything else in this dashboard is the first.

**And the third time it bit, nothing was being drawn at all — it was a BUTTON counting.** The news
Fetch button reports how many stories a run brought in, and measured it as
`articles.length - before`. The capture is trimmed to `KEEP` (600) and in production it is always
full, so **a story arriving pushes the oldest off the end and the length does not move**: live,
capture 10:24 → 10:41 gained id `14019028`, dropped one, count 600 both times, and the button
announced *"Moneycontrol was read just now — nothing new to publish"* over a story that had
genuinely arrived. The one case the control exists for was the one case it could never report.

So the rule generalises past tables: **wherever "did anything change" is asked of a bounded
collection, compare identities — never sizes.** A cache with a ceiling makes the count a constant,
and a constant cannot answer the question. The fixture must model the full cache too, or the test
passes for the same wrong reason the code did: the suite now swaps three stories in and three out,
asserts the count is unchanged, and would have failed the old logic.

### Work the reader has to ask for — the on-demand rule

**A feed that costs one request PER COMPANY may not run on a page load.** News, Corporate
Announcements, Insider Trades and Superstar Investors are all of that shape: forty companies is
forty round trips against somebody else's rate-limited service, and ninety-one for the investor
books. There is no cheap tick — no index endpoint, nothing to 304 — so the pattern that works for
the results feed and the con-call scan does not transfer, and applying it anyway is what made these
tabs feel broken rather than slow.

Three measurements, all from the same afternoon, and each is a different consequence of the same
mistake:

1. **A dead upstream turned a slow tab into a stopped one.** With `devde.muns.io` not answering at
   all, the Worker spent its full retry budget on every company — 93.5 seconds each, measured — so
   a landing counted forty companies down over a **quarter of an hour** and painted nothing.
2. **And it starved the rest of the page.** A browser allows about six connections per origin; four
   held open by a hung walk is two thirds of the budget. The Superstar Investors grid could not
   fetch its own committed snapshot — a **static file** — for forty-four seconds.
3. **The walk was work nobody asked for.** Every visit re-read forty companies to discover, almost
   always, that nothing had changed.

So the split is:

| | Runs | Costs |
| --- | --- | --- |
| the committed snapshot | on a schedule, committed to the repo | one conditional GET per visit, 304 when unmoved |
| the live walk | **only when the reader presses Refresh** | one request per company, bounded by `LIVE_LIMIT` |

`js/core/refresh.js` is the registry, deliberately separate from `js/core/live.js`: that one is a
poller and this one is explicitly not. A tab registers on mount and unregisters on destroy, so the
button re-reads **what is on screen** rather than everything the dashboard can reach.

Four rules, and the honesty ones matter most:

- **Never claim "nothing is new".** These routes have no index, so whether anything has been filed
  cannot be known without asking every company. What the strip prints is a statement about *us* —
  *"Showing the filings captured 11 minutes ago. 63 companies have not been checked since."* — and
  the reader decides whether to spend the requests. A page that said "you are up to date" would be
  asserting something nobody measured.
- **The result must reach the screen, and it must survive its own repaints.** Rows land while the
  walk runs and every arrival repaints the panel, so the button the click handler is bound to is
  gone by the time there is anything to report. The label lives in the module and the next paint
  renders it; holding it on the node meant the control vanished mid-walk and came back reading
  *"Check for new"* — the one thing it could not truthfully say.
- **"Still reading…" is a fourth outcome, and not a failure.** A walk can outlast the header
  button's patience while proceeding perfectly well. Reporting that as *Couldn't check* is a
  failure claim about work that has not failed; reporting it as *Up to date* is a freshness claim
  about a check that has not finished.
- **An empty cache still walks, once.** A deployment whose scheduled capture has not run has
  nothing to paint, and a table saying "press Refresh" is worse than a slow one. The strip says the
  read is automatic, so the reader knows it was not theirs.

**Bound every hop.** The Worker's Muns client had the registry's numbers — 30s × 3 attempts with
backoff — which is 93 seconds before a failing company can say so; it now runs under an absolute
`DEADLINE_MS`, exactly as `worker/finology.mjs` does. The browser bounds its own request too, at
`REQUEST_TIMEOUT_MS`, because a connection held past the Worker's own budget is worth more than the
answer.

### An upstream that needs a credential — the Finology rule

Every other source here is open. The super-investor API is not: it wants
`Authorization: Bearer …`. That changes three things.

1. **The token lives on the Worker and the browser never sees it.** `env.MUNS_TOKEN`, injected in
   `worker/finology.mjs`, exactly as `/api/live-prices` proxies Munshot. A token shipped to the
   client is a token published — there is no "obfuscated" version of this that is not that.
   `npx wrangler secret put MUNS_TOKEN` in production, `.dev.vars` locally (gitignored).
   `env.MUNS_BASE` redirects the upstream so a verification run never scrapes their production.
2. **A missing or rejected token is its own state, named on screen.** `no-token` and
   `unauthorised` are things an operator fixes, and the view says which command fixes them;
   `unreachable` / `upstream` are things to wait for. Collapsing them into one "could not load"
   wastes the only information that makes the failure actionable. Upstream failures come back as
   **200 with `ok: false` and a `reason`** — the request to our Worker succeeded — cached for 15
   seconds rather than the six hours a success gets, so a corrected token takes effect at once.
3. **A failed read is never an empty result.** `holdings: []` only ever travels with `ok: false`
   beside it, and the card says "could not be read". An investor who holds nothing and an investor
   whose book 500'd must never render the same.

And two that come from the upstream being a live scrape rather than an API over a database:

- **Cache hard and fan out on the client.** Shareholding data moves once a quarter, so the edge
  holds six hours and each book is stored on the device under its own tag. The list is one request
  and each book is another, walked **four at a time** with the view painting as they land. A
  `?full=1` that fetched every book in one request would turn a cold cache into sixty simultaneous
  page reads on their service.

  **"The edge holds six hours" was a comment and not a mechanism for a long time, and that is the
  most expensive kind of bug in this file.** `caches.default` was consulted by `/api/earnings`,
  `/api/earnings-calendar` and `/api/concalls` and by neither investor route; all they carried was
  a `cache-control: max-age=21600` header, and the client fetches with `cache: 'no-cache'`, which
  revalidates unconditionally and so never reuses it. Every reader with a cold device store made
  the upstream scrape finology.in ninety-one times. **A caching claim in a comment is worth
  nothing — check that a route actually reads and writes the cache**, and `x-sattva-cache` on the
  response is how you check it: `live` on the first request and `hit` on the second, or it is not
  cached.
- **An outage is not a reason to show nothing.** Every other upstream here degrades to a snapshot
  and says so; this one had no fallback at all, so a restarting API replaced a perfectly good
  twenty-minute-old copy with a wall of prose. Each success is now also written to a long-lived
  `last-good` entry, and a failure serves that as a **200 with `stale: true`**, its **original**
  `fetchedAt` (restamping it would be the cache claiming freshness it does not have), a
  `staleReason` naming the failure, and a 30-second TTL so recovery reaches the screen quickly.
  The view carries an amber strip saying exactly that — *real filed holdings of this age*, which is
  a different statement from the mock ribbon and must not be worded like one.
- **Cache the failure too, briefly.** With ninety-one requests behind one outage, a failure that is
  not cached costs every one of them its own full timeout. Both the stale answer and the hard
  failure go into the fresh key for a few seconds, so one reader pays the timeout once instead of
  ninety-one times. Measured: 12.4s for the first, 15ms for the next.
- **A retry ceiling has to match its own rationale.** The comment in `worker/finology.mjs` said "a
  short ceiling plus retries beats one long wait: the common bad case costs a couple of seconds
  rather than twenty" — above `REQ_TIMEOUT_MS = 15000` and `ATTEMPTS = 3`, which with the backoff is
  **46.6 seconds** of blank screen. It is now 6s × 2 under an absolute `DEADLINE_MS`, and the
  deadline is the guarantee that matters: each attempt gets what is *left* of it, so a slow first
  attempt shortens the second instead of being added to it. Retrying hard into a struggling
  upstream also makes the struggle worse, ninety-one times over.
- **A blank quarter is not a zero.** Below the disclosure threshold a real holding is invisible in
  the filing, so `null` travels to the cell, renders as an em dash, and is excluded from totals. A
  position disappearing is *"no longer disclosed"*, not *"sold"* — and neither `new` nor `exited`
  carries a percentage-point figure, because printing ±the whole holding would invent a trade size.
  This is the same class of error as `classifyChange()` and the `op_vs_pat` rule: **check every
  place a missing value could be read as a measured one.**

### AND A QUARTER THAT HAS NOT CLOSED IS NOT A QUARTER — the worst bug this dashboard has shipped

The rule above says a blank is not a zero. It was obeyed, and the feed still told a reader that
**Madhusudan Kela had sold out of Kopran**, which was false, in a named real person's name.

Finology open a column for the **current** period as soon as the first company files into it, and
print *"Filing Due"* against every holder who has not. `num()` turns that into a `null`,
`deriveMoves` compared `quarters[0]` against `quarters[1]`, and a `null` in the newest column
became `exited` — which reaches the screen as *"X is no longer disclosed"*. Measured on the shipped
capture: Kela's **Aug 2026** column carried a figure for **1 of his 18 holdings**, so fourteen of
his positions were reported gone while his page showed Kopran at 1.72% in both March and June.
Across ninety books, **362 of 1,696 derived moves (21%) were exits** and most had never happened.

**Nothing threw, no count was wrong, and every honesty rule above was being followed.** The dashboard
reported a mass liquidation of the Indian market, confidently, with sources attached.

Four things close it, and they are deliberately independent:

1. **A filing period that has not closed is never a comparison baseline.** `isFiledQuarter()` — an
   Indian shareholding quarter ends in March, June, September or December and nothing else does.
   Measured across ninety books: columns labelled with a quarter-end month are a median **87%**
   filled, columns labelled with any other month a median **6%** and never above 33%. Those are two
   populations, not one noisy one. `filedQuarters` is computed once in `normalisePortfolio` so every
   consumer asks the same question, and the open column is still rendered — it is carried as
   `pending`, not dropped.
2. **Their own word wins where they give one.** A cell noted *Filing Due* is `awaiting`, whatever
   the calendar says. `num()` erased that string; `cellNote()` keeps it, exactly as `parseChange`
   keeps Trendlyne's *Filing Awaited*.
3. **An exit needs the source's own corroboration, per row.** Finology publish a current value
   beside every holding and it is their answer to this exact question: Kopran reads *Filing Due*
   and **₹19.71 Cr**, while Choice International — which he really has left — reads **0.00**. So a
   missing percentage is only called an exit when the value agrees. Of the exits surviving fix 1,
   142 carry a zero value and 40 a real one — and those 40 include LIC "leaving" Reliance
   Communications after two identical quarters at 4.13%, still valued at ₹9.01 Cr.
4. **`awaiting` is not a move.** `daily-alerts.js` filtered `action !== 'held'`, which was the right
   spelling of "something happened" while `held` was the only non-event and became silently wrong
   the moment a fourth state existed — an outstanding filing would have been raised as a *negative*
   alert reading *"X's holding was awaiting…"*. `isMove()` names what IS a move, in one place. Same
   shape, same fix, as `scope !== 'portfolio'`.

**A STATISTICAL GUARD WAS TRIED FIRST AND WAS WORSE.** Refusing any book where more than half the
positions exit at once catches a bad column — and refused Dolly Khanna, whose book sits on the 1%
disclosure threshold, so several positions dropping off in a quarter is her normal pattern, visible
in every quarter of her history. **A threshold over a real distribution silences a real answer.** The
value rule is the source's own statement about the same row, so it never has to guess.

**AND THERE WERE TWO CLASSIFIERS.** `changeOf()` in `js/investors/live.js` held its own copy of the
five branches over `quarters[0]` and `[1]`, so the Data Table would have gone on printing
*Undisclosed* against a company whose drill panel and alert had both been corrected. One fix, three
correct surfaces, one still visibly wrong. `classifyHolding()` is now the only one, and
`filedPair()` the only place the pair is chosen.

**The general rule: a column is not a period, and the newest column is not the current one.** Before
comparing two columns of anybody's data, ask what has to be true for both to be complete — and
where the source itself answers that question, in words or in a figure, read its answer instead of
inferring one.

### Triggering someone else's pipeline — the Deep Dive rule

The Con-call table's last column dispatches a run on a **separate** dashboard, watches it, and
renders the report it produces. Everything in *Reproducing someone else's analysis* applies —
reproduce, never recompute; say whose it is on every surface; link to their own rendering — plus
three that only arise when you can make another service *do work*:

1. **Separate what costs money from what does not, and hold that line everywhere.** `POST
   /api/analyze` is unauthenticated and every accepted call starts a real LLM run; `GET
   /api/summary` and `GET /api/report` are free. So **nothing that costs a run ever fires on its
   own** — no poller, no peek on render, the cell is a button, the first click confirms, and
   "Re-run from scratch" returns to that confirm step rather than dispatching on the click.
   Reopening calls `resume(slug)`, which only polls; their API would dedup a second `POST` anyway,
   but not asking at all is the version that cannot cost a run through a bug of ours.
   **The free index, by contrast, IS fetched unprompted** — once per page load, never polled — so
   a row can say *"report ready"* instead of making the reader pay to discover it exists. Getting
   that backwards in either direction is the bug: polling their trigger, or charging for an answer
   already sitting there.
2. **The loading window is their screen, not one of ours.** A run takes minutes, and their API
   sends exactly one field while it runs: a bare `stage` key. Their own dashboard turns that into a
   sentence, a percentage and a seven-step checklist using the table in `js/analyze.js`; that table
   is copied into `js/data/deep-dive.js` and this panel draws the same screen. Reproducing their
   vocabulary is the rule (same as the StockScans tiers) — writing our own wording for "extract"
   would be describing their pipeline in our words and would drift the moment they changed it.

   Two failure modes, both of which happened here. Rendering the raw key shows the reader
   "EXTRACT". And **inventing a message where the payload has none** is worse: the panel printed
   "Waiting for the pipeline to report in…" because `message` does not exist in their response, so
   it implied nothing was happening while the stage beside it said the transcript was being read.
   The stage IS the information. `unknown` right after dispatch is KV lag, not failure — it is
   simply the first step of their checklist, never an error and never an empty report.

   The panel also carries nothing their screen does not: no elapsed clock, no trail of stages, no
   slug, no paragraph about how long runs take.
3. **Render by shape, not by field name, because the schema is not ours to pin.** `report`'s shape
   lives in their repo. Sections render **in their own key order** — reordering is editing their
   report — and each is drawn from what it *is*: uniform short scalars become a table, prose-
   carrying arrays become cards, flat objects become definition grids. Only `meta` is special-
   cased (provenance), plus two cosmetic hints (`*_url` links, `quote` blockquotes). A section they
   add next month arrives laid out rather than dropped. Escape every string and only ever make an
   anchor from an `http(s)` value — this is external content and none of it may reach the DOM as
   markup.
4. **Never show one company's report under another's name.** The panel is titled from our row and
   the report from theirs; a slug is resolved from three places — their index, this browser's memory
   of a dispatch, this device's saved reports — so if `report.meta.ticker` contradicts the row, say
   so loudly rather than retitling it. Nothing that fails that check is ever written to the store:
   rendering it under a banner is recoverable, filing it under our ticker would serve another
   company's analysis from disk with no upstream left to correct it.
5. **What cost money to produce is kept, and a failed re-check never deletes it.** Everywhere else
   here a cache saves bytes; this one saves a metered run. Their store drops a report after about a
   fortnight, and before this that expiry took ours with it — reopening a company analysed last
   month landed on the confirm step, so the only way back to an analysis already read was to pay for
   it again. Now every finished report goes to IndexedDB under their slug, reopening paints from
   there with **no request at all**, and the re-check happens behind it. `unknown` from that check
   means their copy is gone, which is exactly when ours is the only one left; a network error means
   we could not ask. Neither may drop the reader onto a confirm step — only a slug with **no** saved
   copy falls through to one.
6. **A free read must not wear a metered read's clothes.** Reattaching used to open on the run
   screen — *"Starting the analysis… 5%"* and the seven-step checklist — over a plain GET on a
   report finished an hour earlier. Nothing was being spent and the screen said otherwise, and a
   reader cannot tell those two apart by looking. So a reattach opens on a state that says no run is
   being started, and only a status their API reports as in flight promotes it. Derive the screen
   and the request branch from **one** resolved value, so the sentence and the behaviour cannot
   drift apart.

The base URL is `window.SATTVA_DEEPDIVE_URL` in `index.html`; `localStorage['sattva:deepdive-base']`
overrides it, which is how `verify-ui.mjs` points the whole run at a stub so a verification never
touches — or spends against — the real dashboard.

### One tab, one provenance — and how it got that way

The Con-call tab used to carry six sub-views behind a left rail. Two were live off StockScans; the
other four ran on a **synthetic transcript corpus with fictional speakers**, because no open source
gives us full transcript text. Holding that line took an amber ribbon on one half, a green Live
pill on the other, `LIVE_SUBVIEWS` routing the two through separate code paths, and a rule that
neither half's poller could repaint the other.

The four synthetic views are gone, and so is the machinery: the tab is one live table,
`subviews: []`, no picker, no ribbon, and no schedule/status chips. **That is the preferred resolution whenever
a tab acquires two provenances** — not a better ribbon. If the real transcript feed is ever wired
(BSE publishes filed transcript PDFs), the keyword engine and the Deep Dive workspace are in git
history at `8e31eec..` and would come back pointed at real text.

**The Super Investors tab is the second application, and it went the same way.** Fund Flows ran on
`superinvestors.json` / `institutions.json` — real investor and fund names against generated
positions, under an amber ribbon — and that was defensible while nothing else on the tab was real.
Once Superstar Investors went live off Finology and Institutions went live off Trendlyne and the AMC
workbooks, the tab had one synthetic surface sharing a rail with two genuine ones. So the sub-view
went, and with it `js/data/investors.js`, `js/investors/deep-dive.js`, `gen-mock-investors.mjs` and
three mock payloads. Every number under Super Investors is now somebody's disclosure, the tab has no
ribbon anywhere, and the suite asserts the deleted modules 404 on the served site so a stale import
cannot quietly come back. AMFI publish the real monthly flow figures if that view is ever wanted
back.

The rule that survives: **never put a live number and a synthetic one in the same panel**, and
prefer removing the synthetic one to labelling it. Twice now the right move has been deletion, and
both times the tab got simpler rather than poorer.

### Mock data that has to behave like real data

`earnings.json` is synthetic but built to the exact contract of the real feed, and the tab is
wired as if it were live. The pattern for any feed in that state:

- Put the honesty switch **in the data**, not in the code. `meta().isMock` is derived from the
  payload's `source` field containing "mock". Every marker — the amber ribbon, the freshness card,
  the drill note, the export banner — reads that one flag, so swapping the file in flips all of
  them at once and no marker can be left behind.
- Generate it from a **seeded** script committed to `scripts/`, so the file regenerates
  byte-identically and a diff means a real change.
- Keep real what can be real. Names, tickers, sectors and market caps come from `universe.json`;
  only the financials are invented, and the ribbon says exactly that.
- Document the swap in `docs/DATA-CONTRACTS.md` under a "Wiring the real feed" heading — the list
  of files to touch, in order.

### Performance on large tables

`scoreTable` handles 1,700+ rows because of four things — keep them if you touch it:
- listeners are **delegated** on `<thead>` / `<tbody>`, never per row;
- row markup is **position-independent** (rank comes from a CSS counter, the click target carries
  the row key) and cached by key, so it is built once;
- a repaint whose row set the DOM already contains **moves existing `<tr>` nodes** instead of
  re-parsing HTML. That is what keeps a 535-row sort at ~30ms instead of ~150ms;
- **the first paint carries a screenful and the rest streams in.**

That last one is the big one, and the profile that found it is worth repeating. Mounting the
Earnings Hub blocked the main thread for **866–1,536ms** on every visit. A CPU profile blamed
`segmentedToggle`'s `position()` — the scope toggle — for 606ms of it, which is nonsense on its
face: it reads `offsetLeft` for a sliding thumb. That read is a **forced synchronous layout**, and
the layout it forced was the 1,722-row table underneath. Add ~350ms of string building and the
whole cost was the table, charged to whoever touched the DOM next. Every millisecond of it was
spent on rows nobody could see; the viewport holds about thirteen.

So `bodyHtml(list, from, to)` takes a range, the initial markup carries `FIRST_PAINT_ROWS` (40), and
`wire()` appends the rest in adaptive slices of at most 80 rows under `requestIdleCallback` (with a
timeout, so a backgrounded tab still finishes). Measured tab-to-tab: **~900ms of blocked main
thread → 36–75ms.**

A later Chrome DevTools interaction trace found two remaining costs. The Tailwind browser compiler
spent **285ms** rescanning newly inserted tab markup, and the scope thumb's `offsetWidth` /
`offsetLeft` reads forced another **114ms** layout. Tailwind is now a committed 50.7KB stylesheet
(about 9KB gzip), and the three equal-width scope segments place the thumb by index with a CSS
transform. On the same localhost trace, cold LCP moved **237ms → 159ms**, tab INP **77ms → 39ms**,
and Public Chatter's route LCP **690ms → 89ms**; CLS remained good (0.00 before, 0.02 after). These
are lab measurements, not field data.

Four rules if you touch it:

1. **This is not virtualisation and must not become it by accident.** Every visible row ends up in
   the DOM. Ctrl-F, screenshots, `scrollHeight` and the accessibility tree all behave as before.
2. **Anything that reads the row set reads `current`, the array — never the DOM.** The export does,
   which is why a fill still in flight cannot truncate a workbook. A row count taken off `<tbody>`
   would be a lie for a few hundred milliseconds.
3. **`data-rows-pending` on the section is the honest signal that rows are outstanding**, and it is
   removed when none are. `verify-ui.mjs` waits on it rather than racing the fill. If you add a
   consumer that needs the settled table, wait for that attribute — do not sleep.
4. **The reorder fast path needs every row present**, so it only engages once the fill has
   finished; mid-fill a repaint rebuilds. That is fine, because a rebuild is now a screenful.

The scroll listener that flushes the remainder when the reader reaches the end of the painted rows
attaches only while a fill is outstanding and removes itself when it finishes — so a caller that
drops `wire()`'s disposer still leaks nothing.

**The third one has a trap, and it cost the watchlist star.** Invalidating a row's cached markup
does nothing on the fast path, because the fast path re-parses no HTML at all — it moves nodes
that are already there. Starring a row leaves the row *set* unchanged, so `rowHtmlCache.delete()`
dropped the string and the `<tr>` in the DOM kept its hollow `☆` for ever. The state was real —
the watchlist filter counted the row, the export carried it, a reload drew it starred — and the
only thing that disagreed was the control you had just clicked.

So **per-row state now goes through `staleKeys`**, and `replaceStaleRows()` swaps those `<tr>`
nodes in place on the reorder branch (the full-rebuild branch clears the set, since it reads the
watchlist fresh). If you add any other per-row state to the markup, mark it stale the same way —
dropping the cache entry is only half of it.

**And `key(row)` must be derived from the row's CONTENT, never from its position.** The whole fast
path rests on a key meaning the same row from one paint to the next; an index in the key breaks that
the moment the row set changes. It broke News: the key was `` `${ticker}-${date}-${i}` `` on a table
that grows while the live walk runs, so every arrival shifted the indices, `RELIANCE-2026-08-12-7`
came to mean a different article, and the `<tr>` cached for the old one was moved into its place.
Measured: **741 rows, zero repeated (ticker, headline) pairs in the data, 160 repeated pairs on
screen** — the same headline two and three times while others were missing, with the row count still
exactly right. It reads as a duplicating API and the API is innocent, and **counting rows will never
catch it** — the suite compares them instead. Where rows have no natural id, key on the fields that
identify one (URL, or the joined cells) and suffix a counter for genuine content duplicates: the
failure to close is one key meaning two different rows, never two keys meaning one row.

**It happened a second time, from the other direction, and the symptom looked nothing like the
first.** The con-call table keyed on `(companyKey, when)` — which is unique right up until the
research provider holds **two analyses of one call**. Supriya Lifescience's 14 Aug 11:00 call is in
the feed twice, scoring 50.4 and 50.3 against two different documents; both are theirs and both are
real. One key, two rows. `repaint` holds the existing `<tr>` nodes in a `Map` keyed by row key, so
the second displaced the first, the removal loop never visited the first, and it **stayed in the DOM
for ever** — a scored call sitting at the top of *Awaiting analysis*, out of sort order, through
every filter and every sort. Measured: 28 rows under a filter matching 27.

Three things to take from it:

1. **Uniqueness is a property of the data, not of the field names.** `(company, time)` reads like an
   identity and is not one. Ask what the upstream can legitimately hold two of before trusting a
   composite key — the id here now includes the document, with a counter behind it.
2. **The failure is silent and the state is correct.** Nothing threw, no count was wrong, the feed
   held exactly the right rows, and only one `<tr>` disagreed with all of it. The same class as the
   subscription bug at the top of this file, and it is diagnosed the same way: **compare what is
   drawn against what the feed holds**, never count it.
3. **A `Map` keyed by something that might collide is the mechanism, so close that too.** `repaint`
   now falls through to the rebuild if it sees a duplicate key — in the DOM or in the incoming row
   set — instead of quietly painting the wrong thing. A caller with a bad key gets a slower paint,
   never a lie.

### Data sources

The header "Sources" modal is generated from `js/ui/sources.js`. **Adding a data source means
updating three things together**: the contract in `docs/DATA-CONTRACTS.md`, the loader in
`js/app.js`, and the entry in `sources.js` (including its honest `status`: `live` / `mock` /
`pending`).

**No figure in that registry may be typed by hand.** It is `sourceGroups()` — a function, called
when the modal opens — precisely so every count is read from the same module the tab reads. It
used to be a const array describing each feed with the numbers that were true the day the sentence
was written: *"1,319 companies in the current pull"*, *"877 in the current pull"*, *"142 companies
from the family office statement"*. Those are measurements with a date on them, printed as though
they were properties of the feed, and they read exactly like the live figures beside them — which
is what makes a stale number worse than no number.

Two rules follow, and the suite asserts both:

1. **Put the figure at the end of a sentence that survives without it.** `clause(n, '…<n>…')`
   drops the whole clause when a count is unknown, and half these feeds legitimately are — the
   Sources modal opens from every screen and most feeds load only when their tab mounts. A
   sentence built *around* a number reads as broken prose the moment it does not arrive.
2. **`num()` returns null, never 0.** A feed that has not loaded and a feed that is genuinely
   empty are different claims — the same rule as everywhere else in this codebase.

The same applies anywhere else prose meets data. The Transaction History financial-year filter had
its options typed out too, so a trade in a later year had no filter to find it; they are derived
from the ledger now.

### The source beacon — `js/ui/source-beacon.js`

The registry above has one reader-facing surface: a small launcher in the **lower-left corner**
that opens a popover listing every source, as one long vertical column, beside a diagram of those
sources converging on a single Sattva square. It exists because the most impressive true fact
about this dashboard is invisible from any one tab — that thirty-odd separate upstreams, on four
different mechanisms, feed eleven screens.

**It is not the header's Sources button coming back.** That button was removed deliberately and
stays removed: the chrome is one passive status pill and a Refresh, and provenance for a NUMBER
belongs beside that number — the owning tab's status label, its drill panel, its export banner.
None of that changed. This asks a different question (what is the whole estate?), in a different
place (out of the reading column entirely), and only for someone who went looking. `verify-ui.mjs`
still asserts the header carries no Sources button and that the status pill opens nothing.

Four rules, and the first two are the ones that keep it honest:

1. **No figure in it is typed.** Every count — sources, live feeds, families, tabs, the per-status
   legend — comes from `sourceGroups()`, called on each open and never hoisted. Same rule, same
   reason, as the registry itself.
2. **Green is a claim, so it is worded as a count.** The pill reads *"<n> live feeds"*, which is a
   statement about how many sources are WIRED to a self-refreshing feed — exactly what
   `status: 'live'` means in the registry, and a property of the plumbing. It is never a bare
   *Live*, which would read as *confirmed seconds ago* about data nobody checked. The freshness
   claim is separate, dated, and comes from `live.getLastDataTick()`; before any poller has ticked
   it says which committed captures it painted from rather than borrowing the page-load time.
   **Only live rows are green and only live rows go unlabelled** — mock, manual, on-demand and
   not-built each carry their word, because those are the four a reader must not mistake.
3. **The diagram may not invent a number either.** There is one wire per source GROUP, carrying
   that group's own icon, so the picture cannot drift from the registry; hovering a family in the
   list lights its wire and dims the rest, which is what makes the diagram answer a question
   rather than decorate one.
4. **It is a popover, not an overlay, and it animates only while open.** No backdrop, the page
   stays live behind it, so `trapFocus()` — which asserts `aria-modal="true"` — would describe
   something this is not; Escape, an outside click and focus restoration are implemented directly.
   z-30 puts it under every overlay, as the alert stack is. The panel's markup is torn down on
   close so the wires and the ~30 status dots cost nothing dismissed, every animation is
   transform/opacity, and `prefers-reduced-motion` stops the CSS ones — the SVG motes are SMIL,
   which CSS cannot reach, so those are dropped in JS instead.

Its styles are `.beacon-*` in `public/index.html`, not Tailwind utilities: it is one self-contained
component with a diagram in it, and the animations belong beside the geometry they animate. That
also means changing it needs no `tailwind.css` regeneration.

### X/Twitter is a SOURCE in the News feed, not a feature beside it

The whole of it: a reader keeps a list of X accounts, and their posts appear in the existing News
list marked *Twitter / X*. `js/data/twitter-news.js` converts each post into the article shape
`market-news.js` already produces, and the Universe half of the News tab merges the two arrays —
one list, one sort, one search, one export, **one card renderer with a single branch on
`kind === 'twitter'`**. With no accounts monitored, nothing about that tab differs from before.

**Do not build a parallel news system for it, and do not give it a tab.** The moment posts need
their own list, their own filter architecture or their own refresh control, the integration has
been lost. `docs/DATA-CONTRACTS.md` has the shapes; the rules that matter here:

1. **Nothing is scored, ranked, summarised, sentiment-tagged or mapped to a company.** A post is
   somebody's own words, reproduced. `title` is the post's text unedited — a tweet has no headline
   and writing one would put this dashboard's words on somebody's post. `line-clamp` shortens what
   is DRAWN; search and export see every word.
2. **`Adding…`, `Active` and `Account not found` are three different claims, and the second may
   never stand in for the first.** The committed `twitter-handles.json` is what the collector
   reads; a reader's edits are a device-local overlay over it. So an account this browser monitors
   is `adding` until a collection run's own capture names it — the same distinction as a cached
   paint that has not been confirmed. `Account not found` comes from the capture's `failed[]`, and
   is the collector's answer rather than a guess made in the browser. **A dispatch that fails
   because this deployment has no Worker or no token is never reported as the handle's failure**:
   that is a fact about the deployment, and turning it into "account not found" would send the
   reader to check a handle that was perfectly good.
   **Nor is being in the committed file evidence the account was read.** The collector writes a
   dispatched handle to the list BEFORE it tries to read it, so a run that added one and then
   could not sign in leaves it committed and unread — `collected` (does any capture exist at all)
   is what separates `Active` from `Adding…`, not membership of the file.
   **AND A SIGN-IN FAILURE IS NEVER SPENT ON A HANDLE.** Measured on this repository's own runner:
   X's Cloudflare answered the login with *403 — Sorry, you have been blocked. You are unable to
   access x.com*, twscrape logged *No active accounts*, and `user_by_login` then returned None for
   every handle — which the walk wrote into the capture as *account not found* against a perfectly
   good account, and committed. An outage reported as an absence, about somebody else's account.
   `active_accounts()` now stops the run before the walk when nothing signed in, and the suite
   asserts the browser half. **X sign-in from a CI runner is the hard part and is not a bug here**:
   datacentre address ranges are challenged where a home connection is not, and twscrape takes a
   proxy for exactly that.
3. **Deduplication is by the tweet id and `id` is namespaced `tw:<id>`.** The capture is capped, so
   a new post pushes the oldest off the end and the LENGTH DOES NOT MOVE — "did anything arrive" is
   answered by comparing id sets, never by counting. Same rule, same trap, as the news Fetch button.
4. **Posts carry no ticker, so they are not filtered by one** — Universe scope only, exactly as
   market-wide news is, and for the same reason.
5. **The handle rule is X's own — 1–15 of `[A-Za-z0-9_]` — and it is enforced in three places that
   may not disagree**: `js/core/twitter-handles.js`, `worker/index.js` (the value reaches a
   `workflow_dispatch` input and from there a runner's shell, so it is validated, never trusted)
   and `scripts/scrape-twitter.py`. A link to any other host is refused rather than having its last
   path segment taken as a handle.
6. **A removed account's posts leave the screen at once**, because the browser filters the capture
   by the list monitored right now rather than waiting for the next run to rewrite it.

`scripts/scrape-twitter.py` is **the one Python script in this repository** and the exception is
narrow: the retrieval library asked for (twscrape) is Python, it runs on a GitHub runner only, and
nothing in `public/`, the Worker or the Node scripts depends on it. What it produces is an ordinary
committed capture, like `scrape-mc-news.mjs` produces. It needs an `X_ACCOUNTS` repository secret;
without one it exits 3, writes nothing and warns rather than failing every half hour.

---

## What "Portfolio" means — `js/data/coverage.js`

**The scope toggle filters by the book, not by the ledger.** `public/data/portfolio-companies.json`
is the family office's listed direct-equity book — 142 companies, names and sectors only — **read from
the family's own repository** (`techmuns/Sattva-Family`, `src/data/sattvaData.ts`) by
`scripts/sync-family-book.mjs`, one line per equity ISIN, and resolved to NSE symbols by
`scripts/resolve-portfolio-companies.mjs`. It used to be a list of names typed into the resolver;
a second copy of a book that lives somewhere else can only drift, so the sync runs every morning and
on a `repository_dispatch` from that repository (`.github/workflows/family-book-sync.yml`), and
**the identity of a line is its ISIN** — every hand-checked table in the resolver is keyed by it,
because the custodian's names are cut at twenty characters and spelt differently across the family's
seventeen entities. `coverage.js` primes it at bootstrap and
exposes `holdings() / tracked() / uncovered() / has(ticker) / meta() / coverageNote()`. **Every
`forScope()` in every research tab reads it, and it is the ONLY portfolio input this dashboard
has.**

**It carries names and sectors, and it must never be widened.** The statement gave names only —
value and weight were explicitly out of scope — so a quantity, a cost or a valuation added to this
file would be invented. There used to be a second file, `portfolio.json`, an illustrative ledger
behind a Portfolio Analytics workspace; both are deleted. See *Portfolio means a list of names*
below and the table in `docs/DATA-CONTRACTS.md`.

The pencil beside the header scope toggle edits a **device-local overlay**, not either committed
file. Portfolio and Universe additions/exclusions live in `sattva:scope-lists:v1`; Watchlist edits
the same `sattva:watchlist` store as table stars. Search is a same-origin call through
`/api/stock-search`, and only the Worker reads `MUNS_TOKEN`. A Portfolio edit changes research
filters and denominators only; it must never create a ledger position, quantity or cost.

Three rules:

1. **A line with no ticker is still a holding.** Nineteen of the 142 have no NSE symbol: five
   unlisted private companies, the four Vedanta demerger entities, two warrant lines, five BSE-only
   companies and three whose symbol could not be found. They stay in the file with a `reason` and
   surface as *held but not covered*. Dropping them would silently redefine "Portfolio" as *"the
   123 we happen to have a feed for"* — the same class of error as rendering a missing value as
   zero.
2. **Always print the denominator.** `scopeSummary({ scope, count, noun, book })` renders
   *"Portfolio · 96 of 142 reported"*, and `coverageNote()` writes the long form. Ninety-six rows
   look complete until you know the book is 142, and no feed covers all of it: Breakouts reaches
   **123** — every listed line — Earnings Hub 103, Con-call 77 (plus scheduled), Public Chatter 4.
   Breakouts reaches all of them because it is the one feed whose input we control, and it only
   does since the scrape stopped reading the NSE-500 export alone (see *The universe is the index
   plus the book* in `docs/DATA-CONTRACTS.md`). Where a feed is someone else's index, the gap is
   theirs and the denominator is how the reader can tell.
3. **Resolve by script, never by hand, and let it fail on a collision.** Two book lines resolving to
   one symbol means one is wrong — *Allcargo Global* and *Allcargo Logistics* are `AGL` and
   `ALLCARGO`, and without the guard one would have inherited the other's rows. Names checked by
   hand live in the script's `CONFIRMED` table; not-listed lines live in `NOT_LISTED_EQUITY` so a
   later run cannot "resolve" a private company to a same-named listed one.

---

## Three scopes, not two — `js/data/scope.js` + `js/core/watchlist.js`

**Portfolio · Watchlist · Universe, widest last, and Portfolio is the default.** That order reads
left to right as *mine, watched, everything*. Universe was the default only because it was the
scope that needed no data loaded first, which is not a reason.

`js/data/scope.js` owns the vocabulary — `SCOPES`, `isScope`, `scopeLabel`, `scopeTickers`,
`filterByScope`, `scopeBook` — and `core/state.js` and `core/router.js` import it rather than
repeating the string pair. **A fourth scope is a change in that one file.**

### `scopeTickers()` returns a Set, or `null`, and those are not the same thing

```js
const wanted = scopeTickers(scope, holdings);   // null == "this scope does not narrow"
if (!wanted) return rows;
return rows.filter((r) => r.ticker && wanted.has(r.ticker.toUpperCase()));
```

An **empty Set is a real, correct answer** — nothing is watched yet — and must narrow the feed to
nothing. `null` means the scope does not narrow at all. Collapse the two and an empty watchlist
shows the whole universe: a scope silently meaning its own opposite.

**This is why `scope !== 'portfolio'` is now a bug wherever it appears.** It was the correct
spelling of "everything else" with two scopes and became "the book, or every listed company, but
never the watchlist" with three. Every `forScope()` in `js/data/` and every scope branch in a tab
now goes through `filterByScope`/`scopeTickers` instead, so the question is asked in one place.

### The watchlist is a list of COMPANIES

`sattva:watchlist` holds `{ ticker, name, addedAt }`. See *The star marks a COMPANY* above for what
that changed in `scoreTable`, and `docs/DATA-CONTRACTS.md` for the shape and the legacy prune.

`name` exists so a watched company can be **named** on a feed that does not carry it. Printing the
symbol back where a name belongs would be inventing one — the same class of error as rendering a
missing value as zero.

### Two denominators that are not the same claim

Both scopes print one, per the rule above: ninety-six rows look complete until you know the list is
a hundred and forty-two. But they mean different things and `scopeSummary` words them differently:

- **the book's gap is partly permanent** — nineteen lines carry no NSE symbol, so *no feed here can
  ever show them*;
- **a watchlist entry came FROM a feed**, so its gap is only ever *this particular feed does not
  carry it*, which is a smaller and more temporary claim.

### Two feeds where the scope means something else, and they are left alone deliberately

**Two feeds carry rows with no company on them at all**, and those rows are not filtered by one:
Public Chatter's unresolved half, and market-wide news. Filtering rows that have no ticker BY
ticker would report *"your companies are not in the news"* when the truth is that nothing on those
rows says whose they are. Both keep the section whole and say why.

### Every "nothing matched" sentence is built from `scopePossessive()`

`'your holdings'` / `'your watchlist companies'` / `null` for Universe. The failure this closes is
a message that still reads *"None of your holdings has reported"* to a reader looking at their
watchlist — a sentence quietly about a different list, on a page that is otherwise correct.

### An empty watchlist is answered by the SHELL, once, for every tab except Ask Research

`watchlistEmptyPanel()` says there are zero watchlist companies and offers **Add companies to
watchlist**. The shell wires that action to the same Watchlist editor as the header pencil, without
changing the current tab or scope. The panel lives in the shell rather than in nine tabs because an
empty scope is a property of the scope, not of any tab — and because a table reading *"no results
match your filters"* over a list nobody has added to sends the reader hunting for a filter to clear.

Ask Research declares `meta.allowEmptyScope` because its catalog, per-source status and zero-row
coverage remain useful even when the list is empty. Keep that exception explicit on the module;
do not turn it into a shell-wide weakening of the empty-state rule.

**The teardown is decided against what will actually be mounted, not against the tab the route
names.** Getting that wrong was invisible until two navigations later: landing on an alerts tab with
an empty watchlist took the short-circuit branch, so `currentTabModule !== tabModule` was false and
nothing was destroyed. The module's subscriptions stayed live, its in-flight collect finished, and
it painted its own table into `contentHost` — which by then belonged to Breakouts. **Nothing threw
and no state was wrong**; the reader simply saw one tab's chrome over another tab's rows. The same
lifecycle failure the module contract at the top of this file is about, from the one direction the
contract does not cover: a tab the shell decided not to mount.

---

## AI Alerts — the explainable priority layer

`js/data/ai-alerts.js` reads `daily-alerts.js` once in retained-history mode, then groups the last
seven Indian dates by ticker. It adds no source and generates no fact. The ranking is deliberately
deterministic: importance, source materiality, recency, explicit direction, real Portfolio
membership, independent-feed corroboration, repeated material events, directional conflict and a
small sector-cluster adjustment that requires high-importance negative evidence. Stale, incomplete
and unread feeds lose points. Every contribution is retained in `scoreBreakdown` for deterministic
verification, but the card does not render scores or their arithmetic. The reader gets the evidence
and next action without ranking implementation detail.

### TIME TO INSIGHT IS THE PRODUCT'S ONLY JOB — the card's reading layer

Everything above decides WHAT to surface. `plainInsight()`, `cardMetrics()`, `plainHeadline()` and
`topEvidence()` decide how fast a human can take it in, and that is a separate concern with its own
failure mode: a card can be perfectly honest and still take twenty seconds to read, at which point a
page whose whole promise is *here is what needs you this morning* has failed at the only thing it
does.

**The measured problem was repetition and register.** The card printed the leading pattern's full
sentence as its insight AND again, verbatim, inside a *"Signals lining up"* panel below it, in the
feeds' own technical wording — *"Volume 4.4x its 20-day average at the 2026-09-02 close, and a
tracked investor's latest book shows selling — President Of India: reduced by 2.00pp."* One finding,
said twice, in a vocabulary a reader has to decode, above three evidence rows carrying long
timestamps, direction pills, importance pills and each rule's own reason sentence.

What replaces it is: **one short sentence in ordinary English, the numbers behind it as numbers, and
three evidence lines.** Six rules hold it up, and every one of them is a rule this codebase already
had:

1. **No new fact, and no new number.** Every phrase rewords an event already on the card; every
   figure is read from a field the collector wrote — `volumeX`, `movePct`, `deltaPp`, `action`,
   `investor`, added to the technicals and investor events in `daily-alerts.js` for exactly this —
   never regexed back out of a sentence. A reworded headline must not silently become a missing
   number.
2. **Co-occurrence stays co-occurrence.** *"Heavy trading, and a big holder has been selling"* is
   two measurements inside one week joined by *and*. It is deliberately not *"sold into the tape"*,
   which reads as one causing the other and would be the invented-trade-date error the confluence
   rules already forbid, one layer up.
3. **Plain is not vague.** *"A big holder"* replaces *"a tracked investor's latest book"* — shorter,
   same claim. It does **not** replace the investor's NAME, which stays in the figures and in the
   evidence row beneath. Simplifying the register may never cost the reader a specific.
4. **Only rewrite sentences this dashboard wrote.** `plainHeadline()` turns our own *"Volume 2.0x
   its 20-day average at the 2026-09-02 close"* into *"Traded 2.0x its normal volume"*, and leaves a
   BSE filing's subject, a con-call title and a publisher's headline untouched. Putting our phrasing
   on a company's own statement is the error the filings rules exist to prevent.
5. **A sentence may not be more specific than its evidence.** `news-behind-the-move` and
   `results-reaction` both fire on ANY technicals reading, so neither may say *"the price moved"* —
   it read that way over a card whose only tape event was 2.0x volume on a barely-changed close.
   They say *"Unusual trading"*.
6. **Tone is a claim, so the volume cell has none.** The technicals feed states in its own words
   that volume is participation and the tape does not say whether it was buying or selling.
   Colouring `4.4x` rose because it is large would be this dashboard asserting a direction its own
   feed refuses to assert — a worse error than a dull cell. Day moves and book changes ARE
   directional and are toned.

Two shapes follow from the same reasoning and are asserted:

- **The figures arrive in the order the sentence names them.** Every plain sentence puts the tape
  first, but the events are in SCORE order, so a fund book outranking a volume row produced *"…has
  been selling — Cohesion MK Best Ideas is off the register, 2.0x its normal volume"*: both facts
  true, read backwards against the clause they belong to, costing a second pass over a card built
  to save one. `READ_ORDER` fixes the sequence for the sentence and the strip together.
- **Three evidence rows mean three DIFFERENT sources where the card has them.** Taking the top three
  by score put three rows of one feed on a card whose strip announced four sources — *"Cohesion MK
  Best Ideas: no longer disclosed"*, *"Life Insurance Corporation: no longer disclosed"*, *"Vanguard
  Fund: no longer disclosed"*. Every row was true and the card still showed a quarter of what it
  held, three times, while the reader's actual next question — *what do the OTHER sources say?* — is
  the one thing three identical lines cannot answer. `topEvidence()` takes the strongest event per
  feed first, then fills.

**`cardBadge()` names the action, not the band.** A directional disagreement reads `Reconcile`
rather than `Must see`, because that is what changes the reader's next move; the band itself stays
as `data-priority` and in the filter chips. And the pattern block is now a row of CHIPS naming every
pattern, not a panel restating their sentences — it still sits above the evidence, because the
finding is read before its workings, and it still prints no score.

### ARCHIVING IS A PLACE, NOT A DELETION — `js/core/ai-mute.js`

A card can be archived once it has been read. **A control that makes a card disappear with nothing
on screen saying where it went is indistinguishable from having lost it**, so the archive is a
fourth filter chip that always shows its count, every card in it carries `Restore`, and `Restore
all` is one click.

**And a record is tied to the evidence it was given for, not to the company.** A mute that simply
hid a ticker would keep hiding it through tomorrow's filing, tomorrow's block deal and tomorrow's
result — a reader would have silenced a company on Monday's evidence and stopped being told about
Friday's, with nothing saying so. That is the same failure as rendering a missing value as zero: an
absence produced by our own bookkeeping, presented as an absence of events. So the store records
WHICH evidence was dismissed (the card's strongest event id); the card returns by itself the moment
something stronger arrives, and the record lapses after the alert window it refers to.

### CORRELATION IS THE PRODUCT — the confluence layer

`confluenceOf()` is what answers *"there's a volume breakout and this superstar investor has bought
it"*. Everything else in `ai-alerts.js` ranks a company by its strongest single event and then adds
a flat bonus for having several feeds — real, and **anonymous**: it says *three feeds* and never
says which three or what their combination means. A reader cannot act on an arity.

So a small fixed set of patterns is checked **by name**: accumulation, distribution, insider and
institution agreeing, a move with a story behind it, a result and a reaction, a risk cluster, and a
move nothing explains. Each states which feeds must agree, carries its own points, and **writes its
sentence out of the events it matched** rather than from a template. Where a pattern fires it leads
the card's insight — in the plain wording above — and its name renders as a chip above the evidence,
because the finding should be read before its workings.

Four rules, and every one is a rule this codebase already had:

1. **It adds no fact.** Every clause is quoted from an event already on the card, already linked to
   its own source. A pattern that cannot describe itself out of its evidence does not fire.
2. **Co-occurrence is not causation and the wording may not smuggle it in.** A filed shareholding is
   a **quarterly** disclosure and the trade behind it may be months old, so the accumulation pattern
   says *"a tracked investor's latest book shows buying"* and never *"bought today"*. Getting that
   wrong would be the `deriveMoves` error — inventing a trade date — one layer up.
3. **The legs defer to each feed's OWN published threshold.** Reading direction alone made every one
   of those thresholds a dead letter: measured, four of eight surfaced cards led with *"Life
   Insurance Corporation reduced by 0.62–0.81pp"* — a holder present in nearly every book, moving
   less than the feed's own `INVESTOR_HIGH_PP` bar for mattering. Nothing was wrong with the reading
   and the correlation was still noise. So the predicate asks for `importance === 'high'` rather
   than inventing a second threshold beside a published one.
4. **An absence is a finding, but only where it can be measured.** *A move nothing explains* is the
   most useful thing this layer says, and it may say it **only** when news, announcements and
   earnings were all read and reach the day — "nothing explains it" and "we did not look" are the
   two answers this whole dashboard exists to keep apart. The suite asserts both directions.

**The points are capped** at `CONFLUENCE_MAX`: correlation reorders the list, it does not
manufacture urgency. And **no score is printed**, exactly as nowhere else on the card prints one.

**`VOLUME_X` gave the layer something to correlate WITH.** Before it the technicals feed emitted a
row only for a ±`MOVE_PCT` close, so a volume breakout with a flat close produced nothing at all —
which is precisely the case worth surfacing, volume arriving before the price does. A company at 2x
its own 20-day average volume, or with a confirmed break above its consolidation base, is now its
own event. It is **neutral**, because volume is participation and the tape does not say whether
heavy trading was accumulation or distribution; only a confirmed base break is called positive.
Measured: 40 of 603 companies clear 2x and 16 clear 3x, so it surfaces a readable handful.

**Company news went from `FEED_WEIGHT` 0 to 6, and the arithmetic is the reason.** It was zero
because every story on the feed was neutral and low-importance and nothing separated a fraud
investigation from a namesake's film release; the keyword rule supplies that separation. At 6, a
keyword-matched story on a book company published today scores 30 + 6 + 16 + 12 = **64, exactly
`MIN_SCORE`** — so one story surfaces a company on the day it breaks and falls below the line as it
ages, and anything older needs a second feed to agree with it. News opens the door; it does not
decide what is urgent.

`coverage.js` is the only portfolio input. Do **not** use `portfolio.js` weights or conviction here:
that ledger is explicitly illustrative, and an invented position weight must never decide what a
real reader is told is urgent. Tickerless market-wide news stays in General Alerts; it cannot be
honestly assigned to a company. Single-source neutral news stays below the surfaced threshold.

Cards show the strongest three events first, a templated insight and review action, source links,
and a link to General Alerts with the existing table search seeded for the ticker. `rankReport()` is
pure and exported; test its policy branches with fixtures rather than waiting for today's capture
to happen to contain every case.

## Ask Research — dashboard evidence, streamed immediately

`js/research/estate.js` is a runtime registry, not a second copy of the data. Every adapter reads
the same module as its owning tab and always returns a catalog/status entry, even when that source
cannot be read. Row samples are question-ranked and bounded, while coverage, units, periods, as-of
metadata and live/snapshot/mock provenance remain attached. Adding or removing a dashboard source
means changing this registry and the focused Ask Research checks together; a source may fail, but it
may not disappear. Fourteen sources are registered — one per research tab a reader can open, and
never a route outside `#/research/`: the dashboard's own AI Alerts ranking is one of
them, so "which companies have the strongest evidence across tabs" is answered by the same
deterministic model the tab shows rather than by whichever company topped each feed's default order.

**Every source LOADS, then the question is RESOLVED, then every source READS — in that order.** Loads
run in parallel, each under its own deadline. The question is then resolved once against everything
that loaded — `queryPlan()` maps a symbol as typed, a company name as a phrase, or a distinctive lead
word that only one company starts with, to a ticker — and only then does each source filter its rows.
Loading and reading in one step per source meant the name index depended on which tabs the reader
happened to have visited. Rows are ranked in three tiers: the named companies' rows first, in the
source's own order; then token hits; then the source's default ordering. Scope words and dashboard
vocabulary are stop words: "portfolio" used to be a ranking token, and every AMC row carrying
`disclosure: "portfolio"` was an exact hit for a question that merely said "my portfolio".

**THE BUDGET IS MEASURED ON WHAT THE MODEL RECEIVES, AND IT IS SPENT ON ROWS.** `evidence-shared.js`
is the one definition of the provider-facing packet, imported by the browser (which fits to it) and by
the Worker (which builds the prompt from it and bounds the request on it) — the same arrangement as
`finology-shared.js`. It matters because the wire packet carries chrome the model never sees: every
source's `route`, the duplicate `catalog`, the method prose. The budget used to be measured on the
wire packet, and on real data the rowless skeleton of fourteen sources alone came to 10,242
characters against a 10,000-character budget. Every row was pushed and immediately popped, the model
received fourteen sources with `includedRows: 0`, and it answered — accurately — that the dashboard
held no company data, while General Alerts showed four rows for the company asked about. **Nothing
threw, the packet was well-formed and under bound, and the suite asserted only its size.** So:

1. The skeleton is compact — nothing derivable travels (`omittedRows` is `rowCount - includedRows`,
   `inScope` is `rowCount`), as-of times are to the minute, and General Alerts' nine feeds are one
   line each — and it may take at most `1 - ROW_RESERVE_SHARE` of the budget. Past that, summaries
   and then coverages are dropped from the largest sources first, recorded on the source as
   `trimmed`, before a single row is refused. Status, source, as-of, definition and data quality are
   never trimmed: they are the honesty of the packet.
2. Rows are admitted tier by tier across every source — every source's company rows, then every
   source's token hits, then defaults — one row per source per pass, so a named company's fourth
   alert lands before another company's first result.
3. `verify-ui.mjs` asserts against the shipped data, not a fixture: every ready source with rows in
   scope lands at least one, nothing was trimmed to make room, and a book company asked about by name
   in lower case resolves to its ticker and leads every source that carries it. **Asserting the size
   of a packet says nothing about whether it carries evidence.**

`worker/research.mjs` is the provider boundary. A Muns session token is a Worker secret and must
never enter `public/`, browser storage, a request payload or a committed config file. The route is
same-origin, request-bounded and rate-limited. It calls `fastapi.muns.io/query-router` with
`llm_type: local_llm` and `stream: true`, then forwards every upstream NDJSON text chunk to the
browser immediately. That provider contract has no web-search option, so the UI must not offer or
claim one. The browser preserves every source's status, coverage and provenance, then shares the
remaining provider-facing budget (`RESEARCH_EVIDENCE_CHAR_BUDGET`, 13,000 characters — about 3,900
tokens of JSON, sized for the local model's 8K-token context beside the instruction, the bounded
history and a 768-token answer; the fourteen-source skeleton measures ~6,700 on the shipped data, so
roughly twenty rows fit) across question-ranked rows. UI-only routes and the duplicate catalog
stay in the browser rather than being repeated in the model prompt, and they are not charged against
the budget.

The former `ANTHROPIC_API_KEY` binding is never sent to Muns unless
`MUNS_LLM_LEGACY_ANTHROPIC_BINDING=confirmed-muns-token` explicitly records that an operator replaced
its value with a Muns token. Remove that migration opt-in after installing `MUNS_LLM_TOKEN`.

**AN ANSWER IN FLIGHT OUTLIVES THE TAB IT WAS ASKED FROM.** `destroy()` used to abort every running
generation, so pressing Send and then looking at another tab — the obvious thing to do while fifteen
sources are read and an answer is written — cancelled it. The abort path puts the question back in
the composer and takes the user message out of the transcript, so what the reader came back to was
their own question sitting unsent and nothing else: the work looked like it had never happened.

A generation is module state, not DOM state, and every paint in this tab is already guarded on
`ctxRef`, so it needs no mount to finish: it keeps running, writes the answer into the session and
the device, and announces itself in the alert stack (kind `research`) when it lands while the reader
is elsewhere — keeping it running silently would be a feature nobody can see. What still cancels one
is a change to the EVIDENCE UNIVERSE, which is why each generation records the scope it was built
under: an answer assembled from the book must never land in a workspace labelled Watchlist. **Those
watchers therefore live at module level, not in `wire()`** — its subscriptions die with the mount, so
a watchlist edit made from the header while Ask Research was off screen used to invalidate nothing at
all. The suite drives this the way a reader does, with a **same-document hash navigation**: `go()`
reloads the document, which genuinely does end the request, and would pass the check for the wrong
reason.

**A typed-but-unsent question is the reader's work too**, so `draft` is persisted with the
conversation and flushed when the tab unmounts. The one thing that cannot survive is a page reload
mid-answer — the stream dies with the page — and since the question is pushed into the transcript
before the answer starts, that would leave a user message with nothing under it, reading as though
the assistant ignored it. Re-asking costs a real model run, so it is never re-sent automatically:
`normaliseSession` gives the dangling question back to the composer, exactly as an abort does, and
the phase line says why it is there.

Conversation history is stored on the device, but each submitted question and bounded evidence
packet are sent to the Muns-hosted model. The UI says both halves. Model prose is
untrusted: render it through
`js/research/renderer.js`'s DOM-based subset, never by assigning it to `innerHTML`.

**A citation is a link into the dashboard.** The model cites `[Dashboard: Page name]`; the renderer
hands the name to a resolver the tab supplies (`citeResolver` in `js/tabs/ask-research.js`), which
matches it against the source registry's tab titles and returns that tab's route in the current
scope — with `&company=TICKER` when the question resolved to exactly one company, which the answer
stores on the message so a saved conversation's links still land. **An answer saved without its
companies is backfilled on first paint** (`backfillCompanies`, through `resolveQuestionCompanies()`
in `estate.js` — the same resolver a live question uses): every conversation from before this
shipped opened General Alerts on all 21,000 rows instead of the nineteen about the company asked
for, and the fix had to reach those answers too, not only new ones. A name that matches no registered
source stays as text: a link that goes nowhere is worse than none. `?company=` is the one URL
parameter every table tab honours, through `companySeededView()` in `js/ui/screener.js`: the first
paint after it appears opens the table searched for that company, later paints keep what the reader
has typed since. General Alerts had it first (for AI Alerts cards); the others now do the same, and
Super Investors switches to its Data Table section to do it. A scope change
aborts in-flight work so evidence assembled under one scope cannot land beneath another scope's
label.

---

## General Alerts — the complete view, and the only one organised as a TIMELINE

**Current pool contract:** [GENERAL-ALERTS-POOL.md](docs/GENERAL-ALERTS-POOL.md) supersedes the
historical nine-feed, threshold-entry and mount/Refresh-only descriptions below. General Alerts
now retains available source records, including undated records and future schedules; nineteen
categories cover the source tabs. Scope is applied after collection, private/on-demand coverage is
explicit, and raw observations do not implicitly change the AI priority policy.

Every other tab here is organised by SOURCE. That is right for research and wrong for the first
thirty seconds of a morning, when the question is not *what does Moneycontrol have* but *what
happened, and does any of it need me*.

`js/data/daily-alerts.js` takes the readings, `js/tabs/daily-alerts.js` draws them, and **the tab
adds no data source**: every row comes from a feed that already has its own tab. The default data
contract remains one Indian trading date; the timeline requests `includeHistory: true`, which
keeps every retained row through today, normalizes `day`, and sorts by date then available IST time.
The table kit progressively paints that finite retained set inside its own fixed-height scroller, so
scrolling reveals older dates without a per-company walk or a new API. Full shapes and retention
bounds are in `docs/DATA-CONTRACTS.md`.

**It reads every research tab.** Earnings Hub, Con-call, Public Chatter, Breakouts / Technical,
Super Investors, News, Corp Announcements and Insider Trades. News contributes twice because the
tab owns both company and market-wide feeds. Adding a source is an entry in `FEEDS` plus a collector;
nothing else is special-cased by feed id.

### Direction and importance are separate, inspectable readings

Every event carries `direction` (`positive | negative | neutral`) and `importance` (`high | low`),
plus `signalReason` and `importanceReason`. Direction is not importance: a large disposal can be
Negative and High; a small acquisition can be Positive and Low. A badge without its reason beside
it would be an unexplained judgement.

Source-provided readings win: earnings uses the filed revenue/net-profit comparison, con-calls and
chatter reproduce their source's own bands, and price moves use the stated ±`MOVE_PCT` threshold.
Insider/investor direction is derived from the upstream transaction or disclosed holding change.
Announcements use the small exported `announcementSignal()` keyword policy and BSE's own critical
flag. Publisher news stays Neutral because a headline is not structured sentiment data.
Earnings sign changes remain words — *to profit*, *to loss*, *loss narrowed/widened* — rather than
being turned back into a misleading growth percentage. An explicit insider Transaction outranks
conflicting Mode text, and a bare regulatory “order received” is not treated as commercial work won.
Approval needs a regulator or exchange on the filing; the BSE noun forms “Receipt of … Approval”
and “Commencement of Commercial Production” are recognized without broadening that rule.

High thresholds are stated in the source registry and export: ±5% price moves; every earnings
filing; non-neutral/extreme con-call analysis; 10 chatter mentions or 100% absolute mention change;
insider activity at 1% or ₹10 crore; investor appearance/disappearance or a 1pp change; a BSE
critical filing or material announcement-rule match. “No longer disclosed” is never renamed
“sold”; public chatter is dated to its rolling snapshot, not presented as individual posts.

**`moveSeverity(pct)` is exported because it is the price-move entry rule.** A rule that only runs inside a
collector can only be tested on days the data happens to contain a big faller, which is most days
not at all — the shipped 31 Aug snapshot has seven moves past the threshold and not one of them
down. The suite asserts the predicate directly instead of hoping for a red row.

### `reachesToday` is the half that makes an empty day readable

Most of these feeds are captures on a best-effort schedule, so an empty bucket has two completely
different meanings: *nobody filed*, and *nothing has looked at today yet*. The coverage panel states,
per feed, when it last looked and whether that reaches today. Same rule as the filings tabs' *"63
companies have not been checked since"*: **never claim nothing is new.**

It is computed differently depending on what the feed IS, and the distinction matters:

- feeds whose ROWS carry their own date (earnings, con-calls, announcements, insider, news, market news) use
  `capturedDay >= day` — a later capture still covers an earlier day;
- feeds that are ONE SNAPSHOT of one day (price moves and chatter) use **`snapshotDay === day`**,
  equals and not `>=`. `pct_change_today` is *that* day's move and no other, so reporting it under a
  different date would stamp one day's measurement with another day's label.
- investor activity is dated per investor book, using the confirmation represented by the current
  book rather than the older committed capture that may have seeded it.

Tickerless investor moves remain visible in Universe and are excluded from ticker-narrowed scopes.
Missing investor books and degraded earnings/con-call fallbacks are reported as incomplete/failed;
stale last-good investor books are treated the same way. None is allowed to make the coverage chip
claim the feed is current. Reading a committed earnings/con-call file dates freshness to the
upstream `fetchedAt`, not to the moment this browser read the file.

The General Alerts Refresh control runs bounded revalidation for earnings, con-calls and chatter, and
one conditional request for the bulk investor snapshot. It never turns the landing page into the
Super Investors tab's ninety-one-book upstream walk.

A feed nobody has heard from yet is **`pending`**, drawn as *reading…* and never as *nothing today*:
a half-finished read must not be allowed to give a finished answer.

**EVERY HISTORICAL ROW STATES ITS DATE RESOLUTION.** `Date / time` always leads the row. A feed that
publishes a clock shows `HH:MM IST`; a feed that publishes only a date says `Day only` rather than
rendering an em dash that could mean missing data. The default sort is the normalized day plus that
time, newest first. The date dropdown narrows the already-loaded stream to today, seven days,
thirty days or older rows; it never triggers a fetch.

**AND THE STREAM'S HEIGHT IS MEASURED AT RUNTIME, NOT WRITTEN INTO A `calc()`.** `calc(100vh -
558px)` encodes the height of everything above the table, and that is not a constant: the chip row
wraps with the window, there are eight feeds under a narrowed scope and nine under Universe, and the
reader's zoom moves it too. Measured against one window it was exact; on a wider one the table
stopped ~110px short. `fitStreamToViewport()` reads `[data-table-scroll]`'s own top after the paint
and re-applies on resize, with the listener in `unsubs` so it dies with the tab.

**Do NOT correct it against `document.scrollHeight`.** There is a permanent 16px page overflow in a
sandbox with no Tailwind — `body` keeps the browser's default 8px margin because preflight never
loads, over a `min-height: 100vh` — and shrinking the table by it changes the document height not at
all, because the floor is the min-height rather than the content. Compensating bakes a sandbox
artefact into the layout and costs every real reader 16px. Measure what the element needs; do not
chase the page.

**THE CHIPS ARE ALSO THE FILTER, and `All` is `null` rather than "every box ticked".** Ticking
narrows the stream to the ticked feeds; the two states look identical on screen and diverge the
moment a feed appears or disappears, which is the same distinction `scopeTickers()` draws between
`null` and a full Set, for the same reason. Two behaviours follow: ticking every feed individually
collapses back to `All` rather than leaving a filter that only looks like one, and **unticking the
last feed returns to `All` rather than emptying the stream** — a reader who has unticked their way
to a blank page has no control on screen saying why it is blank, and *nothing today* is a claim
this page may not make on the strength of a filter the reader set. The counts on the chips describe
the FEED, not the selection, so they never move when you tick.

**Market-wide news is not offered as a filter on a narrowed scope at all.** It carries no company,
so under Portfolio or Watchlist it contributes nothing — and a permanently dead tick box is worse
than an absent one. The reason it is absent stays in the source registry: *the exclusion must be
stated*, which was always the rule, and never that it must be stated in the body.

**There is no legend strip.** Direction and importance are named directly on every row, with both
reasons alongside them; thresholds and rule provenance remain in the source registry and export.

**THE PANEL IS ONE ROW OF CHIPS — a dot, a name, a number — and the number is the part that has to
be guarded.** In history mode the number is the retained row count used by the feed filter, while
the tooltip separately names how many are on today. It was five cards in a white block, each with a
sentence and a last-read time, and it
cost about 300px above the stream it describes; it is 19px now, identical across all three scopes.
What compressing it may NOT do is let a state print as a count: **a number is a finished answer and
"has not looked at today" is the absence of one**, so that state prints the word *not checked* and
`could not be read` prints *unread*, never `0`. `feedState()` returns `short()` beside `label` for
exactly this reason, and the two are read from one place so they cannot drift. The sentence each
card used to carry moved to the chip's `title`; full source descriptions and the market-wide feed's
*"carries no company, so it cannot be narrowed"* reason remain in the source registry. The suite
asserts that a behind feed's chip contains no digit at all.

### Nothing on it walks, and nothing on it blocks on the slowest feed

The three filings feeds are seeded with **`feed.seed()`** — the committed snapshot and this device,
no per-company request. That is deliberately separate from `load()`: `load()` memoises its promise,
so a seed arriving first would hand the tab that owns the feed the seed's promise and silently
discard its company list, and the Refresh button would then re-read an empty set and ask about
nothing. `seed()` never writes `wanted`.

**`Promise.all` over independent reads is head-of-line blocking with a tidy syntax.** The first
version awaited every feed together and the timeline sat blank for as long as the slowest —
measured at 10–15 seconds on a static origin, because the chatter API is a direct call to somebody
else's service and an unreachable host takes its own time to say so. Seven feeds that had already
answered were held hostage by the one that had not. Each feed now
settles independently and the page paints as it lands, coalesced at 250ms with a **trailing throttle,
not a debounce** — a debounce would keep deferring while feeds kept landing and the page would sit
still until the slowest finished, which is the thing this exists to stop. Measured after: first paint
**~250ms**, everything settled by 3s.

**The Refresh button compares event ids, never counts.** The day rolls over, captures land, stories
drop off the end of a bounded cache — a count cannot answer "did anything change" for a collection
like that. Same rule, and the same failure, as the news Fetch button.

---

## PORTFOLIO MEANS A LIST OF NAMES — and Portfolio Analytics is deleted

**The only portfolio information this dashboard holds is `public/data/portfolio-companies.json`:**
142 company lines, names and sectors, synced from the family office's own repository. No quantity,
no cost, no valuation, no P&L, no equity curve, anywhere. See *What "Portfolio" means* above.

There used to be a second thing. **Portfolio Analytics** was four modules over an **illustrative
ledger** — twelve positions with invented quantities and costs, marked to market with real prices —
a FIFO replay engine, an equity curve over 735 real trading days, XIRR, TWR and two drawdown
figures. It was honest about itself: an amber *Illustrative ledger · live marks* pill on every
sub-view, an export banner, a drill note. It is gone, and how it went is the rule worth keeping.

**1. Hiding a surface is not retiring it, and hiding it is what built the trap.** The workspace was
marked `hidden: true` so a saved `#/portfolio/...` link would still resolve to the page it named
rather than falling through to Research Central. That reasoning protected a bookmark and created
something worse: with no workspace switcher in the chrome there was **nothing on the page that led
back**, and inside the Munshot host iframe there is no address bar to edit. A reader who arrived was
stuck on a screen of made-up money with no exit. *A route with no way out of it is not a hidden
feature, it is a trap* — so a surface that is not offered must not be reachable either, and an old
link should land on a working page with the URL corrected.

**2. Something always finds an unoffered route.** Ask Research's evidence registry listed the
workspace as its fifteenth source and cited it as `[Dashboard: Portfolio Analytics]`, linking
straight in. So the ledger's invented quantities, costs, market values, XIRR, TWR and drawdown were
being **streamed to the model** and shown to the reader as dashboard evidence, and the citation was
the door into the trap. An evidence source must be a tab the reader can actually open — asserted in
`scripts/verify-research.mjs`, which requires every source's route to start `#/research/`.

**3. Prefer deletion to labelling, for the third time.** This is the same resolution the four
synthetic con-call views got and the Fund Flows sub-view got: *never put a live number and a
synthetic one in the same product, and prefer removing the synthetic one to labelling it.* A pill
cannot survive a screenshot, and a mock ₹30.7L market value under this dashboard's chrome reads as
the family's money to anyone who did not read the pill.

The four modules, `js/portfolio/lots.js`, `js/data/portfolio.js`, `portfolio.json`,
`mock/transactions.json`, `portfolio-history.json` and the two scripts behind them are in git
history at **d3bba30** — the whole FIFO engine, its two numeric identities and the back-adjustment
rules with it. If a **real** ledger is ever wired, that is where it comes back from, and the rules
that governed it (charges in the basis, dividends as income, corporate actions adjusting lots in
place, a missing mark carried at cost rather than zero) come back with it.

**Prefer a passive status label whenever a caveat is competing with the content it qualifies.**
The label must state the material condition on its face and must not open a provenance explainer.
Full source detail belongs in the registry and export disclosures. Progress on work the reader
just asked for may still appear in the body because it is feedback rather than permanent chrome;
failure panels keep their own retry control so recovery never depends on a hidden dialog.

### A close is a claim about a SESSION — the technicals feed's two dates

The price-move alert on General Alerts read *"Fell 6.7% at the close"* for Hero MotoCorp on a day it
ended down 4.6%, and *"Fell 5.7%"* for Macpower CNC on a day it ended down 1.5%. Neither number was
a close. GitHub's best-effort scheduler ran the 07:00 IST technicals scrape at **11:36 IST**, in the
middle of the session, and Yahoo's daily series includes the current session as a bar while the
market is open — so `close.at(-1)` was a mid-morning print. Worse, Yahoo had not yet published
Macpower's 1 September bar, so `close.at(-2)` was the **31 August** close and the "day move"
spanned two sessions. And the alert was dated by `generated_at`, the capture, which is the morning
AFTER the closes on the runs that happen on time.

Three rules, in `scripts/lib/yahoo.mjs`, `scripts/scrape-technicals.mjs` and `js/data/daily-alerts.js`:

1. **A bar dated today is not a close until the session has settled.** `fetchBars` drops it before
   16:00 IST (`completedBars`); every caller gets finished sessions only. The scrape now produces the
   same file whether it runs at 07:00 or at noon.
2. **A day move carries both of its dates.** `dayMove` returns `{ pct, date, prevDate, gapDays }`
   and refuses a gap wider than a holiday weekend; the file stamps `price_date` and per-row
   `bar_date` / `prev_bar_date`. General Alerts dates the move by `bar_date` and says *"at the
   2026-09-01 close"* — never by the capture, in either direction.
3. **Every move that reaches the check threshold is re-derived from the Muns market-data
   endpoint** (`scripts/lib/muns-market-data.mjs`) before the file is written. Its closes are the
   exchange's; Yahoo's are right almost always and wrong exactly where an alert looks. It rate-limits
   hard and answers a refusal as **HTTP 200 with an `Error:` body**, so the parser reads the body's
   shape, a refusal keeps Yahoo's figure and records `move_check: unavailable`, and the whole step is
   bounded to a dozen names. `node scripts/verify-bars.mjs` asserts all three.

**AND THE ENDPOINT'S QUOTA IS SMALLER THAN A DAY'S FLAGGED LIST, SO ONE RUN CANNOT BE THE WHOLE
ANSWER.** Measured: three anonymous requests answered, then every one of eighteen more — at one
every three seconds, then one every twenty, with a token, in a burst, for over ninety minutes — was
refused. Waiting inside the scrape would hold a 603-fetch run hostage to a dozen calls, and dropping
the check would put Yahoo's figure back where the alert looks. So the check is split across time and
remembered across runs:

- **`verifyMoves` asks the alert-producing names first**, paces itself, doubles its wait on every
  refusal, retries the SAME name rather than skipping it, and runs under a wall-clock budget. What is
  still unanswered when the budget ends says `unavailable` on the row — never a silent figure.
- **`public/data/price-move-checks.json` is every answer ever received**, keyed `TICKER@bar_date`.
  It is read before any request, so a name is asked about once per session, whichever job asks.
- **`scripts/verify-price-moves.mjs` comes back for the rest.** `price-move-verify.yml` runs it
  hourly through the Indian day under the scrape's concurrency group; each pass answers what it can,
  recomputes breadth and `price_date` through the shared `lib/technicals-file.mjs`, and commits only
  if a row changed. Every firing GitHub sheds costs nothing, because each pass resumes exactly where
  the last one stopped.
- **`MUNS_TOKEN` as a repository secret is the lever.** Both jobs send it as a Bearer token; an
  authenticated quota is what lets one pass answer the whole set. Without it the set is still
  answered — over the day rather than in a run — and the alert row says which figure it carries.

### A green "Live" is a claim about data — and its threshold comes from the DATA, not the cron

Breakouts' pill is the third consumer of that rule, and it got the threshold wrong first in a way
worth keeping. The scrape runs weekdays 07:00 IST (`30 1 * * 1-5`), so the obvious rule is "amber
once a scheduled run has not landed". Two things are wrong with it:

1. **A 22-hour-old END-OF-DAY capture is current.** Yesterday's close is the newest close there
   is; no scrape at any hour can produce a fresher one until the market closes again. Reporting it
   as stale describes the scraper's timetable, not the data.
2. **It keys the UI to a schedule that is not honoured** — the market-news measurements above are
   12 runs fired out of 124 scheduled. A chip that sits amber most of the week with nothing wrong
   teaches the reader to ignore it, and is then worth nothing on the day something *is* wrong.

So the threshold is the schedule's own **worst case**, the shape the market-news chip already
uses: Friday's capture is still the newest thing that exists on Monday morning, so three days is
the widest legitimate gap and `STALE_AFTER_MS` is 72 hours. `freshnessOf()` is **exported and
pure** so the suite can assert both sides of that boundary directly — the shipped snapshot only
ever has one age, so the stale branch cannot be produced by the fixture, exactly as `moveSeverity`
cannot be produced by a day with no big faller in it. A feed with **no** capture time is a third
state, `unknown`: never "live", never "stale".

**And a half-mock view may not wear a green Live.** Breakouts' Earnings Surprise sub-view is amber
and reads *Mock earnings · live technicals* on the face of the chip, because a screenshot travels
without the modal.

---

## Running inside the Munshot host — the SDK integration

This dashboard is embedded in the Munshot host as an iframe, and the host hands it the signed-in
reader's **session token** and **selected company** over a postMessage channel. `public/index.html`
loads the SDK bundle, `js/core/sdk.js` holds the one client, `js/core/host-context.js` is the state,
`js/core/host-capture.js` answers the host's two requests, and `js/ui/host-ticker.js` is the only
thing it draws. `scripts/verify-sdk.mjs` asserts the whole of it against the **real shipped
bundle**.

**None of it is required for the dashboard to work.** Served as a plain static site — which is how
`verify-ui.mjs` drives it — there is no host, the client falls back to a no-op, and every feed
paints from its committed snapshot exactly as before. That is a supported mode, not a degraded one,
and nothing may render an error state because of it.

### Four rules, and every one of them fails SILENTLY if broken

1. **The SDK is a classic `<script>` in `<head>`, before `js/app.js`** — never `type="module"`,
   never `async` or `defer`. The bundle is an IIFE: loaded this way the global carries
   `createDashboardClientSdk`; loaded as a module it carries `{ createClient, Client }` instead.
2. **One client, built at import time.** The SDK attaches its window listener in its constructor,
   and `host:init` — the only message that ever carries the channelId — routinely lands before any
   UI exists. A client built from a mount hook can miss it, and a dashboard that missed it renders
   perfectly and never receives a token.
3. **`autoReady` stays at its default, and nothing calls `sdk.ready()`.** The SDK sends
   `dashboard:ready` itself from inside its own `host:init` handler — verified in the bundle:
   `channelId = t.channelId … options.autoReady && this.ready()`, in that order, in one message. A
   manual ready fired from a mount effect races ahead of that, goes out with a placeholder channel
   the host cannot correlate, and the connection never completes.
4. **Context is read with `getContext()` and re-synced on every `onMessage`.** Never
   `await sdk.requestContext()` — it returns a **boolean**, and awaiting it is a TypeError that
   takes the page down.

`verify-sdk.mjs` asserts each of these from the host's side: nothing is sent before `host:init`,
**exactly one** `dashboard:ready` comes back on the host's own channel, and a later
`host:context:update` repoints the view without a reload.

### Where the token may be sent, and where it may NOT

A session JWT is the reader's identity, so this is a security boundary rather than a convenience.
`authHeaders(path)` in `js/core/host-context.js` is an **allow-list**, and the default is no header:

| Target | Header | Why |
| --- | --- | --- |
| our own `api/…` routes | **yes** | same origin; the Worker forwards it to the Munshot upstream it was issued for |
| `*.muns.io` | **yes** | the issuer |
| `data/*.json` | **no** | committed static files need no credential, and one would cost them their cache entry |
| the Concall Deep Dive Worker, the chatter API | **NO** | separate deployments on other origins. Sending a reader's Munshot JWT to a third party hands it a live credential on every poll, and there is no "it is only a read" version of that |

The predicate is asserted at all six boundaries, including a hostname that merely *ends* like
`muns.io`. Add a call site by spreading `...authHeaders(path)` into its headers — never by
remembering which paths are which.

### The Worker may use the forwarded token, but only where it has none of its own

`withCallerToken(env, request)` in `worker/muns.mjs` fills an **absent** `MUNS_TOKEN` from the
caller's bearer and changes nothing otherwise. A configured secret always wins, so a deployment
that has one behaves exactly as it did. What it buys is the `no-token` state — a hard failure on
screen today that needs an operator in the Cloudflare dashboard before News, Announcements, Insider
Trades, stock search, the investor books or Ask Research can show anything.

**Read the note above that function before giving this env to a new route.** These routes share
URL-keyed edge-cache entries, which is safe only because every upstream behind them returns MARKET
data — the same filings, the same books, whoever asks. A route whose response is specific to the
caller needs its own cache key, or no cache.

### The two host requests, and the rule that governs both

`dashboard.capture.visual` returns a PNG **Blob** of `#dashboard-main`; `dashboard.capture.snapshot`
returns `{ context, selection, data }`. **Neither may throw and neither may return something the
channel cannot carry** — those two failures are indistinguishable from the host's side, because both
produce no response and then a timeout. Every path in `host-capture.js` therefore ends at a plain
object, failures included.

The 512KB cap is measured with `JSON.stringify`, so a **Blob costs ~2 bytes** and is returned
directly — Base64 is measured in full and a screenshot of a wide table blows the cap. The state
snapshot is real JSON, so it carries the route, the scope and per-source **counts**, never rows: a
snapshot that tried to be the data would be dropped on exactly the tabs worth capturing. Tabs
contribute through `registerSnapshotSource(id, fn)` rather than this module importing eleven tabs.

### The host's ticker is a chip, not a fourth scope

Every tab here is a multi-company screener whose row set is decided by the scope toggle. A host
selection silently narrowing all eleven would be a scope the toggle does not show and the reader did
not set — and the scope is the most important fact about any number on this page. So the selection
is one chip in the header that opens General Alerts filtered to that company, on the route AI Alerts
already uses.

**So there is nothing here to gate on a null ticker.** The published pattern says a ticker-bound
widget shows an empty state and sends no ticker-dependent request when the host has selected
nothing; not one widget in this dashboard is ticker-bound and not one request takes a ticker from
the host, so the honest rendering of "no selection" is **no chip at all** — never eleven tabs of
*No stock selected* over feeds that are complete without one. A null token is the same: transient
on load, permanent off-host, and never a page-level error. Where a feed genuinely cannot be read
for want of a credential, the existing `no-token` / `unauthorised` states already say so by name.

---

## Overlays are modal to the keyboard too

`openDrill`, `openModal` and `openWorkspace` all call `trapFocus()` (in `js/ui/screener.js`), which
sets `role="dialog" aria-modal="true"`, moves focus in, keeps Tab inside, and restores focus on
close. If you add a fourth overlay, use it — without it a keyboard user is left tabbing through the
page behind a panel they cannot see, and closing it drops focus to `<body>`.

Every `<th>` carries `scope="col"`. The verification suite fails if one does not.

---

## The live earnings feed — the one per-request live surface

Everything else in this dashboard is live *on a schedule*: a GitHub Action scrapes, commits, and
the site serves a file. The Earnings Hub is live *per request*. `worker/index.js` proxies
Moneycontrol behind a 30-second edge cache and the browser polls it, so a company that files at
14:32 is on screen by about 14:33 with no Action run and no rebuild.

Four rules hold it together:

1. **One normaliser, two consumers.** `worker/mc.mjs` is pure and dependency-free (`fetch` is a
   parameter), imported by both the Worker and `scripts/scrape-earnings.mjs`. That is what stops
   the committed fallback from disagreeing with the live route about shape.
2. **The proxy exists for politeness and for the fallback, not for CORS.** Moneycontrol sends
   `access-control-allow-origin: *`, so the browser could call it directly. Going through the
   Worker means a thousand readers cost the upstream one fetch per cache window, and gives us
   somewhere to serve the last committed snapshot from when it breaks — labelled `degraded`, never
   as an empty "no results".
3. **Refresh the cache on every tick; repaint only on a STRUCTURAL change.** Prices move
   constantly. An early version fingerprinted the price too, so the 1,300-row table rebuilt every
   30 seconds and threw away whatever the user had sorted. The fingerprint now covers identity and
   the reported figures only.
4. **The fingerprint must be order-independent.** The payload arrives in Moneycontrol's sort order
   while the cache is held in ours; anything order-sensitive reports "changed" on every single
   tick. It sums per-row hashes for exactly this reason.

### A percentage across a sign change is not a growth rate

169 of 1,319 companies in a full quarter — **13%** — report a profit move where the sign flips.
Moneycontrol gives all of them a plain percentage. Rendered as a coloured number they lie:

- **Loss in both periods.** Vodafone Idea's "+43%" is a loss narrowing from ₹6,608 Cr to ₹3,754 Cr.
- **Loss → profit** and **profit → loss.** A change across zero has no percentage at all.

So `classifyChange()` tags every metric with a `kind`, `pct` is null wherever no honest percentage
exists, and the UI renders a labelled pill instead of a number. This is the same failure mode as
the `op_vs_pat` rule in the earnings model — **check every growth figure for it.**

### And a count of zero is not always a count

The same trap wearing different clothes. On 14 Aug 2026 Moneycontrol's results-calendar endpoint
began answering `0` for every date in a 25-day window — HTTP 200, `success: 1`, right columns,
twenty-five rows, every count zero. The date strip rendered as em dashes on a day 235 companies
were reporting, because zero is a value a count can legitimately take and nothing distinguished
"none report" from "we could not read it".

**An upstream that returns zero on failure makes every zero ambiguous**, so the resolution has to
come from evidence rather than from the number: the committed capture holds real counts for those
dates *and names twenty companies on each*, and a count of zero above twenty named companies is
self-contradictory. `handleCalendar` in `worker/index.js` substitutes the capture's counts when the
live strip carries no non-zero count anywhere and an overlapping capture does, and says so with
`countSource`. A genuinely empty window fails that test, which is the point.

What it does **not** do is fall back to `indexId=B`, which was healthy and returning 451 where NSE
returned 258 — that is the BSE universe, a different measurement, and serving it under the previous
label would be answering a question nobody asked. **Check every counter, total and length for this
before rendering it.**

### Market cap is computed, not stored

`mc-ticker-map.json` holds the **share count**, not the market cap. The browser multiplies it by
the price on the current tick, so the column is correct now rather than as-of the last refresh.
Verified against Moneycontrol's own figure to the rupee.

### Joins that can legitimately miss

scID → ticker (1,319/1,319), ticker → market cap and industry, and (ticker, result date) → the
result-day close (1,312/1,319). Every miss renders as an em dash and the coverage note under the
table counts them. **A dash means "not joined"; it never means zero.**

### The calendar has one meaning: scheduled results

The Earnings Hub keeps the two questions in separate views:

| View | Source | Meaning |
| --- | --- | --- |
| **Earnings Calendar** | `/api/earnings-calendar` | who was scheduled on the selected date, past or future |
| **Earnings Reported** | `/api/earnings` | who has filed this quarter and what they reported |

Do not select between them by date. On 2 Sep 2026 Moneycontrol's calendar listed Technocraft
Ventures and BSE-only Vivanta Industries, while the filings feed had only Technocraft. Switching a
today/past Calendar date to filings made a source-labelled screen display one row where the linked
source displayed two.

The calendar count and rows both use `indexId=All`. The first page comes from `/earnings-widget`
and the Worker follows every `/pagination/earnings-pagination` page, so a complete response has
`scheduledCount === rows.length`. A live-count/captured-list race can still disagree; omit the
rendered total in that state instead of presenting mixed observations as one fact.

The date strip has its own trap, and it is a UI one. It used to request a window around the
**selected** date, so every click merged new chips in and slid the existing ones along; then the
panel rebuild reset the scroll container to zero, its oldest date. Between them, picking a date near
the right-hand end left the reader staring at a fortnight ago with their selection off-screen. The
window is now anchored on **today** (`stripWindowFor`) and only ever grows to reach a date actually
asked for, and `keepActiveVisible()` restores the scroll offset — keeping the reader's own if the
selection is still visible in it, centring the selection otherwise. **If you rebuild a scrolling
container's innerHTML, you own restoring its scroll position.**

---

## The header, and the alert stack — `js/ui/notifications.js` + `js/core/watch.js`

The header carries the brand, the scope toggle, **one** status pill and a refresh button. There
used to also be a global search box, a Sources button, a green *"Live · just now"* chip and a white
*"Updated 52 minutes ago"* chip. The two chips are the instructive removal: they made competing
claims about the same subject, and the green one tracked the 20-second heartbeat — a poller whose
"fetcher" returns `Date.now()` without asking any server anything — so it read *"just now"* whether
or not a byte had been confirmed in an hour.

- `statusControl()` in `components.js` is the replacement: `● Live · updated 4m ago`, on
  `live.getLastDataTick()`, plus a refresh button that **says what it found** (`Up to date` /
  `3 new`) rather than spinning and vanishing.
- `live.register(id, { synthetic: true })` keeps a poller out of `getLastDataTick()`. The heartbeat
  is the only one. **Freshness has to be a claim about data**, so anything that does not talk to a
  server does not get to move that clock.
- **The Sources button and its popup are gone from the chrome.** The status pill is passive.
  Canonical provenance remains in the source registry and export disclosures — and the registry is
  reached from the **page footer**, not from the header. See *An explanation with no door is worse
  than no explanation*: removing the button was right, leaving the registry with no caller at all
  was not.
  **There are two doors to it now, and that is deliberate rather than a duplicate.** The footer
  link opens the full registry as prose — the reference, at the end of the page, where a reader
  who has finished reading goes looking. The lower-left beacon (see *The source beacon*) opens a
  compact view of the same data as one column beside a diagram of it converging on the dashboard —
  the estate at a glance, from anywhere, without leaving the tab. Neither is in the header, which
  is the rule that matters; if one of them ever has to go, it is because they read as the same
  control, not because two callers of one registry is wrong.
- `live.refreshAll()` ticks every **running, non-synthetic** poller and resolves when they settle.
  It deliberately does not start stopped ones: a stopped poller belongs to an unmounted tab.

### Alerts: what may interrupt, and what may not

`notifications.push({ key, kind, title, detail, href })` renders a card in the lower-right stack.
`core/watch.js` feeds it from the two live feeds' existing `onChange` + `newArrivals()`.

Five rules, and each is load-bearing:

1. **An alert is a fact that arrived**, never a summary of what is on screen. A repaint is not an
   event; a company filing a result and a con-call gaining its analysis are.
2. **`key` dedupes for the life of the page.** Both feeds re-hand their whole arrival list on every
   change, so without a stable key the same result re-announces itself on every tick.
3. **The backlog is suppressed, not replayed.** Arrivals accumulate from page load, so the
   watcher's first change event would otherwise dump rows the reader has been looking at for ten
   minutes. `notifications.suppress(keys)` marks them announced without showing them — a
   notification asserts *this just happened*, and replaying history through it devalues every alert
   after it.
4. **z-30: alerts sit under every overlay** (drill 50 < workspace 55 < modal 60). The reader opened
   those deliberately; a toast landing on top of one is the failure mode this component is one step
   from.
5. **The text obeys the same honesty rules as the tables.** `earningsDetail()` routes through
   `kind` from `classifyChange()`, so a loss-to-profit swing reads *"turned profitable"* rather
   than a percentage that does not exist; a con-call with no score reads *"analysis pending"*, not
   `0/100`. The suite asserts both.

**The watchers run app-wide, and that is the whole point.** `startLive` / `stopLive` are owned by
the tab that shows a feed — right for a table, useless for an alert, which is only worth having if
it fires while the reader is elsewhere. So `watch.start(live)` holds its own claim on both pollers
and `watch.ensureRunning()` re-asserts it after every route change, because the tab you just left
called `live.stop()` on the same id. This is affordable **only** because both feeds are conditional:
an unchanged con-call tick is a bodyless 304 and an unchanged results tick is the ~30KB prices
projection. Without the caching layer, watching two feeds app-wide would be indefensible.

---

## Live engine — `js/core/live.js`

```js
live.register('concall-live', { intervalMs: 5000, fetcher: myDeltaFetcher });
const off = live.subscribe('concall-live', (payload) => paint(payload));
live.start('concall-live');   // in render()
live.stop('concall-live');    // in destroy(), and call off()
```

- Pollers run only while started **and** the document is visible; they pause on hidden and
  refetch immediately on return.
- Exponential backoff on error, capped at 60s. Errors never reach the UI.
- Swap mock → real by changing one argument: `live.realFetcher('/api/technicals')`.
- **`live.mockFetcher(path)` re-reads `path` on every tick and jitters its numbers.** That is fine
  for a small file whose numbers are meant to breathe, and wrong for anything else — a feed with
  real figures must poll the real route, and jittering quoted speech would invent words nobody
  said.
- **A tick that early-returns from `tick()` never reschedules.** The `!running || hidden ||
  inFlight` guard has no `finally`, so a fetcher that never settles kills the poller silently —
  no error, no tick, just a feed that quietly stops. If you write a fetcher, make sure every path
  through it resolves.

---

## Never re-download what the reader already has — `js/core/store.js`

The two polled feeds are large: the results payload is **1.1MB** and the con-call scan **450KB**,
and both are polled every 30 seconds. Every loader used to fetch with `cache: 'no-store'`, which
forbids reuse outright, so a single open Earnings Hub tab pulled **1,135KB per tick — ~136MB an
hour** to discover that nothing had changed. Fixing that is what `core/store.js` and the ETag
layer in `worker/http.mjs` are for.

Measured, end to end in Chromium: cold visit **2,388KB** → reload **5KB** → one unchanged poll
**0.3KB**.

Three mechanisms, and each is load-bearing:

1. **A content ETag on every GET route** (`withTag` / `revalidate` in `worker/http.mjs`, shared by
   the Worker and any local stand-in). A matching `If-None-Match` gets a bodyless 304.
   The tag is computed over the payload **minus the volatile keys** — `fetchedAt`, `servedAt`,
   `resolvedOnTheFly`, `unresolved`, `contentTag` itself. Miss that and the tag changes on every
   request while the content does not, and the 304 never fires. `stableJson` drops them with a
   replacer rather than a field list, so a field added next month is covered automatically.
   **The test that matters is that the tag survives an edge-cache expiry**: the Worker re-fetches
   upstream, re-normalises, re-stamps the timestamps, and must still produce the same tag.
2. **A persistent store** (IndexedDB, `js/core/store.js`). First paint comes off the device with
   no network at all; the committed snapshot is fetched last and only when the store is empty or
   the live route is unreachable. **The store holds the server's own bytes under the server's own
   tag** — never a locally patched copy. That pairing is the entire basis for trusting "you
   already have this", and price updates are folded into memory only, never written back.
3. **A prices-only projection for the results feed**, `GET /api/earnings?fields=prices` — scID →
   `[ltp, changePct]` plus a `structureTag`, ~30KB against 1.1MB. This exists because the results
   feed is the one place a conditional GET alone buys nothing: `ltp` moves on every tick during
   market hours, so the full representation genuinely changes every 30 seconds even when not one
   reported figure has. The client re-fetches the full feed exactly when `structureTag` moves,
   which is when a company has filed or revised. **The con-call route deliberately has no
   projection** — nothing on a con-call row moves on a tick, so the 304 does the whole job there,
   and a merge path that could drift from the server's truth would be complexity for nothing.

Rules:

- **Do not hand-roll the conditional request.** `cache: 'no-store'` plus your own `If-None-Match`
  is the obvious implementation and Chromium kills it: the 304 response is aborted with
  `net::ERR_ABORTED` a couple of seconds later, the fetch rejects, and because pollers swallow
  optional errors the symptom is not an error — it is a feed that silently stops updating. Use
  `cache: 'no-cache'` and let the browser send the validator. `conditionalJson` then compares the
  response ETag against the stored one **before** reading the body, so an unchanged tick still
  skips the parse.
- **`no-cache` for committed static files, never `no-store`.** `no-store` forbids reuse; `no-cache`
  revalidates and reuses. That one word was ~800KB per visit.
- **Fetch committed files through `revalidatedJson`, never a bare `fetch`.** It shares the promise
  per path, and that is a different saving from the HTTP cache: two modules asking for
  `universe.json` in the same tick have nothing to revalidate against, so both download in full.
  Measured, twice each: 163KB for `universe.json`, 249KB for `mc-ticker-map.json`. Only the promise
  is shared, never the parsed value — a later call still revalidates, so this can never serve a
  stale file, only stop the same one being fetched twice at once.
- **The shell blocks on what the first paint needs and nothing else.** `app.js` splits
  `CRITICAL_SOURCES` (the book — `coverage` backs the scope toggle and every research tab reads it
  synchronously) from `DEFERRED_SOURCES`, which start immediately and are awaited by nobody. It was
  seven files and ~825KB in front of the first pixel, including a 347KB shareholdings file read by
  one sub-view and a 232KB mock corpus read by one other. Two rules if you add a file:
  **the deferred object is mutated in place**, because `ctx.data` is the same reference every
  mounted tab holds — replacing it would leave them all with the empty one; and **the consumer
  waits, rather than rendering early.** Breakouts → Earnings Surprise and Super Investors →
  Institutions both do, via `whenDeferredData()` and `filed.load()` respectively. An unprimed
  Institutions renders an empty book, and an empty book on screen is a claim that nobody holds
  anything.
- **Caching must never cost freshness, and it must never be able to claim freshness it lacks.**
  `meta.origin` says where this paint came from (`live` / `store` / `snapshot`) and
  `meta.checkedAt` when the server last confirmed it — a different fact from `meta.fetchedAt`,
  which is when the upstream was read. A 304 moves the second and not the first. `deliveryNote()`
  in `js/ui/sources.js` renders both, and both Live pills carry it.
- A store miss is never an error. It means "fetch it", which is what the code did before the store
  existed. Private windows and disabled storage fall back to an in-memory Map, and
  `isPersistent()` reports it so the UI can say so.

### When the wait is latency, not bandwidth — the Superstar Investors case

The layer above solves *bytes*. It does not solve *round trips*, and one feed here is bound by the
second: Superstar Investors is **ninety-one separate requests** — the list, then one page per book,
because each is a separate scrape upstream. Conditional fetching already made a return visit nearly
free in bytes (every unchanged book is a bodyless 304), and the view still took seconds to fill,
because ninety-one confirmations four at a time is twenty-three sequential waits.

So `js/data/super-investors.js` reads **everything it already has before it asks the network
anything**:

1. **Pass one** rebuilds the whole view out of IndexedDB, with zero requests, and paints. `load()`
   resolves here — the caller's `then` should fire on the paint it can already make.
2. **Pass one and a half** fills whatever the device did not have out of the **committed
   snapshot** — `public/data/super-investors.json`, every book in one file, written by
   `scripts/scrape-super-investors.mjs`.
3. **Pass two** revalidates in the background and repaints **only** the books whose bytes actually
   changed. `conditionalJson` reports a 304 as `fromStore`, so an unchanged book emits nothing at
   all — otherwise the grid would rebuild ninety times to display what was already on it.

**A DEVICE CACHE DOES NOTHING FOR A READER WHO HAS NEVER OPENED THE TAB, and that reader is the one
who waited.** The two-pass arrangement above made a *return* visit instant and left a first visit at
ninety-one requests — most of a minute of the grid filling in, and the state the tab was actually
found in, because a reader who navigates away mid-walk comes back to a half-warm cache and pays for
the rest. The snapshot is the half that was missing, and it is the same answer every other bulk feed
here already had. Measured, cold device, no `/api/` route reachable at all: **414KB (69KB over the
wire), one conditional GET, grid complete in ~1.1s.**

Two rules for it, and they are the filings snapshot's rules:

- **A book the capture could not read is ABSENT, never empty.** It goes under `failed` with a
  reason and is fetched live; writing it as a book holding nothing would report an outage as a fund
  that sold everything. The script refuses to write below 80% coverage at all.
- **The device's copy always wins over the file**, because those bytes were confirmed by the server
  later than the file was captured. The snapshot only ever fills gaps.

Three rules make that safe, and they are the same ones the store rests on generally:

- **`meta().origin` may never claim a freshness that has not been confirmed.** It distinguishes
  three: `snapshot` for the committed file, `store` for this device's cache, and `live` only once
  every painted book has been confirmed against the server **in this session**. A book the second
  pass deliberately skipped is *unconfirmed*, not confirmed — see below. The value remains the
  source of truth for stale handling, exports and verification, but Superstar Investors does not
  repeat it as a per-view status pill; refresh status and control already live in the global header.
- **A failed revalidation must not delete a book you already have.** The cached copy is a real read
  of a real filing; replacing it with "could not be read" because a later request timed out throws
  away good data to report a transient network event. Only a book with no cached copy becomes a
  failure. It must not be recorded as *confirmed* either: nothing vouched for those bytes.
- **Never replay a stored failure.** `ok: false` is cached for fifteen seconds upstream precisely so
  a corrected token takes effect at once; painting one from disk would undo that. Pass one refuses
  to seed from anything carrying `ok: false`.

**And pass two must not ask for what the server cannot answer differently.** It used to walk all
ninety-one books unconditionally, so a reader who opened the tab twice in a minute paid ninety-one
round trips to be told nothing had changed. So a book confirmed inside the current window is left
alone, and a return visit costs **one request instead of ninety-one**.

**That window comes from the filing calendar, not from a number of hours.** A super-investor's book
is assembled from the shareholding patterns companies file with the exchanges, and those are filed
once a quarter — nothing else moves it. So `revalidateWindowMs()` asks where the calendar is: inside
`FILING_SEASON_DAYS` of a quarter end companies are still filing and a book genuinely gains lines
day to day, and outside it the next thing that can change any book is the next quarter end. One hard
rule sits above both — **a confirmation older than the most recent quarter end is always re-asked**,
whatever the elapsed time says, or a long hold could straddle a quarter boundary and keep serving
last quarter's book into the new one. That is the failure this is meant to prevent, arrived at by
being too clever about avoiding requests.

Three things keep that from being a freshness claim bought on credit, and all three are asserted:

- a book **never read**, and a book carrying the server's `stale` flag, are always asked for;
- `origin` stays `store` and `checkedAt` reports the **oldest** confirmation behind what is on
  screen, not the newest — otherwise the list's own check would overstate every book beneath it;
- `refresh()` discards every confirmation and asks again, wired to a re-read control in the Live
  pill's modal. A cache that decides on the reader's behalf that a question is not worth asking
  needs a way for them to ask it anyway.

**A repaint is not free either, and per-arrival repainting is the other half of "slow".** The tab
rebuilds whichever of its investor cards, quarterly roll-up or disclosed-positions table is active
from one `onChange`, so ninety arrivals meant ninety rebuilds. Arrivals are coalesced into at most
one
repaint per `EMIT_COALESCE_MS` (a trailing throttle, **not** a debounce — a debounce would keep
deferring while books kept landing and the grid would sit still until the walk finished), and the
derived views are memoised behind a version counter so they are built once per change rather than
once per paint. The walk's final emit is immediate, so the settled state never waits on a timer.
Measured against a twelve-investor stand-in: 14 rebuilds → 2 cold, 13 requests → 1 on return.

Reach for this shape when a feed is **many small requests rather than one large one**. For a single
payload the conditional GET already does the whole job, and a second pass would be complexity for
nothing — which is exactly why the con-call route has no projection either.

---

## Where to look for what

| I need to… | Go to |
| --- | --- |
| Build a tab panel | `js/ui/screener.js` — assemble, don't hand-roll |
| Add or change a scoring model | `js/scoring/` + `js/data/` — see the pattern above |
| Change the technicals pipeline | `scripts/scrape-technicals.mjs` (`TECH_LIMIT=15` for a smoke run) — its universe is the NSE-500 export **plus the book**, deliberately; read *The universe is the index PLUS the book* in `docs/DATA-CONTRACTS.md` before narrowing it |
| Change what counts as a close, or the price-move check | `completedBars` / `dayMove` in `scripts/lib/yahoo.mjs` + `scripts/lib/muns-market-data.mjs` (`MUNS_VERIFY=0` skips the check) — read *A close is a claim about a SESSION* first; `node scripts/verify-bars.mjs` is the test |
| Finish verifying today's flagged moves, or change how often it is tried | `node scripts/verify-price-moves.mjs` (`MUNS_TOKEN=…` for the authenticated quota, `MUNS_VERIFY_BUDGET_MS` for patience) + the cron in `.github/workflows/price-move-verify.yml`; the answers live in `public/data/price-move-checks.json` |
| Price a company the technicals feed is missing | `TECH_FILL_GAPS=1 node scripts/scrape-technicals.mjs` — fetches only what is absent or errored and merges, so it costs one request per gap |
| Change the live-quote refresh | `handleLivePrices` in `worker/index.js` + the refresh bar in `js/tabs/breakouts.js` — read *The upstream is cache-backed* in `docs/DATA-CONTRACTS.md` first. `QUOTE_TTL_S` / `QUOTE_TIMEOUT_MS` / `QUOTE_POOL` / `QUOTE_BUDGET_MS` are **one setting, not four**; re-measure before changing any of them |
| Change the live earnings feed | `worker/mc.mjs` (client + normaliser) then `worker/index.js` (`/api/earnings`) |
| Change the results calendar | `fetchCalendarStrip()` / `fetchCalendarDay()` in `worker/mc.mjs`, then `/api/earnings-calendar` — preserve All-exchange count/list parity, complete pagination and the Akamai capture fallback in `docs/DATA-CONTRACTS.md` |
| Refresh the calendar capture | `node scripts/scrape-calendar.mjs` (`CAL_BACK`/`CAL_AHEAD` to widen) |
| Change the chatter feed | `js/data/chatter-live.js` + `js/data/sentiment-shared.js` — the browser calls it DIRECTLY and must; read *There is no `/api/chatter`* in `docs/DATA-CONTRACTS.md` before adding a proxy. `changePct` there is mention volume, not price |
| Change News or Insider | `worker/muns.mjs` + `js/data/filings-shared.js`, then the routes in `worker/index.js` — read *Three feeds whose SHAPE is not ours to pin* first |
| Change Corporate Announcements | Keep the exchange-wide base in `worker/bse-ann.mjs` + `scripts/scrape-bse-announcements.mjs`. Additional user-requested company/date lookups use `worker/muns.mjs` + `js/data/announcements-extra.js`; they merge with the table and never replace the base capture or claim universe coverage. |
| Change the NSE live announcements feed | `worker/nse-ann.mjs` (pure parser + name->symbol resolver, shared) + `handleNseAnnouncements` in `worker/index.js` (live route, edge-cached) + `js/data/nse-filings.js` (browser) + `js/tabs/nse-filings.js` (the scoped table). The browser CANNOT read NSE (CORS null), so it must proxy through the Worker; a full desktop user-agent is required or Akamai 430s it. Resolve by NAME — the filename prefix is only 31% reliable |
| Refresh the NSE snapshot fallback | `node scripts/scrape-nse-announcements.mjs` — reads NSE directly (no token), resolves, commits `public/data/nse-announcements.json`. The live route is the primary read; this is the floor beneath it |
| Change how many days of announcements are kept | `ANN_KEEP_DAYS` in `scripts/scrape-bse-announcements.mjs` — a bytes ceiling, ~900 filings a weekday |
| Change the tracked news keywords, or what a Topic filter offers | `public/js/data/news-keywords.js` — the whole vocabulary is one array; read *Thirty words that make a search feed usable* first. A keyword is a topic and must never become a direction, and `namesCompany` marks a row rather than dropping one |
| Change what makes a news story material to General Alerts / AI Alerts | `newsSignal()` in `js/data/daily-alerts.js` — it raises IMPORTANCE only, never direction, and the suite asserts that on a risk word |
| Change what makes a FILING material | `announcementSignal()` + `BSE_CRITICAL_IS_MATERIAL` in `js/data/daily-alerts.js` — read *A borrowed flag is not a materiality rule* first. One predicate, stated inputs; BSE's critical flag is reproduced and is not the gate |
| Change the volume/breakout alert, or its threshold | `VOLUME_X` and the participation branch of `fromTechnicals` in `js/data/daily-alerts.js` — volume is neutral because the tape does not say which side it was |
| Change which cross-feed patterns AI Alerts names | `CONFLUENCE` + `confluenceOf()` in `js/data/ai-alerts.js`, rendered by `confluenceMarkup()` in `js/tabs/ai-alerts.js` — read *Correlation is the product* first; a leg must key on the feed's own published threshold, not a new one |
| Change which companies News searches | `tickersFor()` in `js/tabs/filings-tab.js` — the scope decides, and the committed snapshot is what paints. The picker is gone: read *And the third feed did not get this treatment* first |
| Change the market-news feed | `worker/mc-news.mjs` + `worker/rss-news.mjs` (parsers) + the two scrapers + `js/tabs/market-news-view.js` — read *An upstream neither the browser nor the Worker can read* first. Do **not** add a Worker route; Moneycontrol, Mint and Economic Times all 403 it with the same 24-byte body |
| Add a news publisher | one entry in `FEEDS` in `worker/rss-news.mjs`, then a row in `js/ui/sources.js` and `docs/DATA-CONTRACTS.md`. **Check the newest item's date first** — Moneycontrol's own RSS answers 200 with well-formed XML whose newest item is from April 2024 |
| Refresh the market-news capture | `node scripts/scrape-mc-news.mjs` (`MCNEWS_FULL=1 MCNEWS_PAGES=25` for a deep fill, `MCNEWS_DATE_LIMIT=0` to skip the per-story timestamps) and `node scripts/scrape-rss-news.mjs` (`RSS_ONLY=mint,…` to narrow) |
| Change how much news history is kept, or repair the archive | `scripts/lib/news-store.mjs` — `MCNEWS_HEAD` is the FIRST-PAINT size only, never a limit on history; `MCNEWS_RESHARD=1 node scripts/scrape-mc-news.mjs` re-files everything on disk without asking any publisher for anything |
| Change what the news Fetch button does | `worker/github-actions.mjs` + `handleNewsDispatch` / `handleNewsRunStatus` in `worker/index.js` + `watchScrape()` in `js/data/market-news.js` — read *So "refresh" has to mean something else* first. It is POST-only and must stay that way |
| Set up the news Fetch button on a deployment | add a Secret named **`GH_DISPATCH_TOKEN`** in the **Cloudflare dashboard** (*Workers & Pages → this Worker → Settings → Variables and Secrets*) — a fine-grained GitHub token on this repo alone with **Actions: read and write**, nothing more. That is the route on this deployment, which publishes via Cloudflare's Git integration rather than `deploy.yml`. `npx wrangler secret put GH_DISPATCH_TOKEN` does the same from a terminal. `GH_REPO` / `GH_REF` are plain vars in `wrangler.jsonc` |
| Change what the news list orders by, or how far back it scrolls | `sortRows()` + `loadMore()` in `js/data/market-news.js` and the footer in `js/tabs/market-news-view.js` — read *The one hand-rolled list* first. `firstSeenAt` is never an ordering key |
| Change when the news scrape runs | **`triggers.crons` in `wrangler.jsonc` + `scheduled()` in `worker/index.js`** — that is what actually drives the cadence. The `schedule:` block in `.github/workflows/market-news-refresh.yml` is a fallback and is measurably not firing on this repo; read *And in the end GitHub's scheduler had to be taken off the critical path* first |
| Make a committed file reach the live site | **Cloudflare's Git integration deploys on push** — that is the live path, and `.github/workflows/deploy.yml` is a fallback whose deploy job is *skipped* here for want of `CLOUDFLARE_API_TOKEN`. Its run summary says which mode is in effect on every run; do not read a green tick as "deployed" |
| Change how those three tabs look | `js/tabs/filings-tab.js` is the shared renderer; the three modules beside it are columns and words |
| Refresh the news / insider snapshots | `node scripts/scrape-filings.mjs` — **universe scope is the default and the scheduled job now uses it**; `FILINGS_SCOPE=book` narrows to the holdings, `FILINGS_LIMIT=20` for a smoke run. It reads **our own Worker**, so it needs no token; `MUNS_TOKEN=…` switches it back to the upstream |
| Change which companies a filings snapshot covers | `FILINGS_SCOPE` in `.github/workflows/company-news-refresh.yml` and `.github/workflows/insider-trades-refresh.yml`. **The scope the tab offers and the scope the capture covers have to be the same scope**; `companies()` still walks the book first, so a truncated run has covered the holdings |
| Change automatic stale-capture recovery | `public/js/data/capture-watchdog.js` + `/api/capture-status` and the fixed workflow routes in `worker/index.js`; keep the browser's 15-minute check / 30-minute retry guard and the Worker's in-flight/cooldown guard together |
| Refresh the announcements snapshot | `node scripts/scrape-bse-announcements.mjs` — no token; `ANN_DAYS=7` to backfill, `ANN_MERGE=0` to replace |
| Change what the Refresh button drives | `js/core/refresh.js` (the registry) + `refreshNow()` in `js/core/watch.js` — read *Work the reader has to ask for* first; a per-company feed must never be registered with `live.js` |
| Change the super-investor feed | `worker/finology.mjs` + `public/js/data/finology-shared.js`, then `/api/super-investors` — read *An upstream that needs a credential* below first |
| Change how a filed-book change is classified | `classifyHolding()` / `isFiledQuarter()` / `filedPair()` / `isMove()` in `js/data/finology-shared.js` — the ONLY classifier; read *A quarter that has not closed is not a quarter* first. Never re-derive a move in a view, and never call a missing percentage an exit without the source's own zero value beside it |
| Change the Superstar Investors view | `js/investors/live.js` — the whole sub-view is that one file |
| Change the cross-book summary in Quarterly Changes | `quarterSummary()` in `js/data/super-investors.js` (the roll-up) + `quarterSummaryBlock()` in `js/investors/live.js` (the panels) — read *Rolling ninety books up into one screen* first; the four figures it refuses to invent are the point |
| Make the Superstar Investors view load faster | `js/data/super-investors.js` (the three passes, the quarter-aware revalidation skip, the coalesced repaint) + `investorRoute` in `worker/index.js` (the edge cache and the last-good fallback) — read *When the wait is latency, not bandwidth* first, and measure with `x-sattva-cache` rather than by eye |
| Refresh the super-investor snapshot | `node scripts/scrape-super-investors.mjs` (`SI_LIMIT=5` for a smoke run) — it reads **our own Worker**, not Finology, so it needs no token; commit `public/data/super-investors.json` |
| Change which date the Earnings Calendar opens on | `defaultCalendarDate()` in `js/tabs/earnings-hub.js` — it is today, in **IST**, and `?date=` and the reader's own click both win over it |
| Add or refresh an AMC portfolio | drop the workbook in `scripts/fixtures/`, add an entry to `FUNDS` in `scripts/import-amc-portfolio.mjs`, re-run it — read *Two disclosures that look identical* first |
| Change how a company name resolves to a ticker | `scripts/lib/company-index.mjs` — `node scripts/lib/company-index.mjs "Some Name Ltd"` explains one match |
| Change the live con-call feed | `worker/stockscans.mjs` + `public/js/data/stockscans-shared.js`, then `/api/concalls` — read *Reproducing someone else's analysis* below first |
| Change the Con-call tab | `js/concall/scans.js` — the whole tab is that one file |
| Change the Deep Dive column or panel | `js/concall/deep-dive.js` (panel) + `js/data/deep-dive.js` (transport) — read *Triggering someone else's pipeline* below first |
| Change what a Deep Dive report keeps on the device | the saved-report block in `js/data/deep-dive.js` + `KEYS.deepDiveReport` — a report costs a metered run, so read rule 5 there before shortening anything |
| Refresh the con-call snapshot | `node scripts/scrape-concalls.mjs` |
| Change how a growth figure is classified | `classifyChange()` in `worker/mc.mjs` — read the sign-change rules above first |
| Refresh the earnings snapshot / ticker map | `node scripts/scrape-earnings.mjs` (`REFRESH_ALL=1` to re-resolve share counts) |
| Add result-day base prices | `node scripts/scrape-result-returns.mjs` — incremental, one call per new result |
| Add or remove a company from the book | **In the family repository** — `techmuns/Sattva-Family`, `src/data/sattvaData.ts`; the sync brings it here. Then `node scripts/sync-family-book.mjs` (`FAMILY_REPO_TOKEN=…`, or `FAMILY_BOOK_PATH=` a local clone) and commit `scripts/fixtures/family-book.json` + `public/data/portfolio-companies.json`. A new ISIN gets its reader-facing name in `DISPLAY_NAMES` in `scripts/resolve-portfolio-companies.mjs`; a line no feed can place goes in `CONFIRMED` / `BSE_ONLY` / `NOT_LISTED_EQUITY` there, keyed by ISIN |
| Set up the automatic book sync on a deployment | add a Secret named **`FAMILY_REPO_TOKEN`** to this repository (*Settings → Secrets and variables → Actions*): a fine-grained token on `techmuns/Sattva-Family` alone with **Contents: read**. Optionally have that repository POST `repository_dispatch` (`family-book-updated`) here on push — the snippet is in `docs/DATA-CONTRACTS.md` |
| Change the device-local scope editor | `js/ui/scope-editor.js` (modal) + `js/core/scope-lists.js` (Portfolio/Universe overlay) + `js/core/watchlist.js` (Watchlist) + `/api/stock-search` in `worker/index.js` / `worker/muns.mjs` |
| Change what the Portfolio scope filters by | `js/data/coverage.js` — read *What "Portfolio" means* above first. It is the only portfolio data here: names and sectors, never a quantity or a value |
| Add or change a scope | `js/data/scope.js` — the whole vocabulary is there, and every `forScope()` asks it. Read *Three scopes, not two* first; never reintroduce `scope !== 'portfolio'` |
| Change what the Watchlist scope tracks | `js/core/watchlist.js` (the store) + `watchKey` on the table that stars it — read *The star marks a COMPANY* first |
| Change AI Alerts ranking or thresholds | `js/data/ai-alerts.js` — keep it deterministic, retain every contribution for verification without rendering the arithmetic, use the real `coverage.js` book, and test `rankReport()` directly |
| Change what an AI Alerts card SAYS, or the four figures on it | `plainInsight()` / `cardMetrics()` / `plainHeadline()` / `topEvidence()` in `js/data/ai-alerts.js` — all pure and exported. Read *Time to insight is the product's only job* first: no new number, only sentences we wrote may be reworded, the volume cell takes no tone, and the figures follow `READ_ORDER` rather than score order |
| Change archiving on AI Alerts | `js/core/ai-mute.js` (the store) + the `archived` filter and the Archive / Restore buttons in `js/tabs/ai-alerts.js` — a record is keyed to the evidence it was given for, so a card returns on its own when stronger evidence arrives |
| Change the General Alerts tab | `js/tabs/daily-alerts.js` (the view) + `js/data/daily-alerts.js` (the readings) — read *General Alerts* above first. It has **no feed of its own** and must never send a request per company |
| Change General Alerts direction or importance | the exported rules and per-feed collectors in `js/data/daily-alerts.js` — every row carries `signalReason` and `importanceReason`; keep thresholds visible in the source registry and export |
| Change a General Alerts threshold | the exported constants in `js/data/daily-alerts.js` — the source registry, export and tests read those constants rather than retyping them |
| Change which tabs General Alerts reads | `FEEDS` in `js/data/daily-alerts.js` — an entry plus a collector and matching provenance/docs; nothing is special-cased by feed id |
| Change Ask Research's workspace or conversation lifecycle | `js/tabs/ask-research.js`; history is device-local, but every submitted question and bounded evidence packet are streamed through Muns' hosted LLM router |
| Change what cancels an in-flight answer, or what survives leaving the tab | `abortGenerations` / `watchEvidenceInvalidation` / `destroy` in `js/tabs/ask-research.js` — read *An answer in flight outlives the tab* first; `destroy()` must not abort, and the invalidation watchers must stay at module level |
| Change where a `[Dashboard: …]` citation links, or make a tab honour `?company=` | `citeResolver()` in `js/tabs/ask-research.js` + `companySeededView()` in `js/ui/screener.js`; the tab's own render seeds its `initialView` from it |
| Change which dashboard evidence Ask Research reads | `js/research/estate.js` — every registered source must keep a catalog/status entry even when its read fails, `load` before `read`, and the packet must stay below the Worker bound **and still carry rows**; read *The budget is measured on what the model receives* first |
| Change what the model receives, or the evidence budget | `js/research/evidence-shared.js` (the provider shape — the Worker imports it too) + `RESEARCH_EVIDENCE_CHAR_BUDGET` / `ROW_RESERVE_SHARE` in `estate.js` — measure with `providerEvidenceChars`, never `JSON.stringify(packet).length` |
| Change how a question names a company | `queryPlan()` + `STOP_WORDS` / `WORD_TICKERS` in `js/research/estate.js` — pure, fixture-tested in `scripts/verify-research.mjs` |
| Change Ask Research's provider, prompt, web-search contract or limits | `worker/research.mjs` + `wrangler.jsonc` — the key stays server-side; the route stays same-origin, bounded and rate-limited |
| Change which tab the dashboard opens on | the order of `WORKSPACES[0].tabs` in `js/ui/shell.js` — the array **is** the default; `DEFAULT_ROUTE` in `router.js` should agree |
| Hand the project over | `docs/HANDOFF.md` |
| Regenerate the mock earnings set | `node scripts/gen-mock-earnings.mjs` — seeded, so output is stable |
| Wire the real earnings feed | `docs/DATA-CONTRACTS.md` → "Wiring the real feed" (3 files) |
| Add or change a result scan | `js/tabs/earnings-scans.js` — the definition string and the predicate live in the same object |
| Add or refresh an AMC fund's portfolio | drop the workbook in `scripts/fixtures/`, add an entry to `FUNDS` in `scripts/import-amc-portfolio.mjs`, re-run it |
| Wire another fund's real holdings | one entry in `FUNDS` in `scripts/scrape-institution-holdings.mjs`, then re-run it |
| Build a full-screen analysis view | `openWorkspace` in `js/ui/screener.js` — don't grow the drill panel |
| Run the pre-push checks | `node scripts/verify-ui.mjs` and `node scripts/verify-sdk.mjs` (serve `public/` on :8080 first); `node scripts/verify-research.mjs` and `node scripts/verify-bars.mjs` need no server |
| Change anything about the host handshake, the session token or the capture handlers | `js/core/sdk.js` + `js/core/host-context.js` + `js/core/host-capture.js`, then `node scripts/verify-sdk.mjs` — read *Running inside the Munshot host* first. Every way of getting the handshake wrong is SILENT |
| Change which requests carry the reader's token | `authHeaders()` / `isMunshotApi()` in `js/core/host-context.js` — it is an allow-list and the default is no header. A third-party origin must never be added to it |
| Change what the Worker does with a forwarded token | `withCallerToken()` in `worker/muns.mjs` + the one call in `worker/index.js` — a configured `MUNS_TOKEN` always wins, and these routes share a URL-keyed edge cache |
| Add a server route | the API block in `worker/index.js` — return through `withTag` + `revalidate` so it is conditional like the rest |
| Add/change a tab or sub-view | the module in `js/tabs/`, then `WORKSPACES` in `js/ui/shell.js` |
| Change avatar / tier / status-pill styling | `js/ui/visual.js` |
| Change the header, sub-view picker or tab bar | `js/ui/shell.js` |
| Add a row to the source registry | `js/ui/sources.js` (and `docs/DATA-CONTRACTS.md`) — both doors to it, the footer link and the lower-left beacon, pick it up with no further wiring |
| Change how a reader REACHES provenance | the footer in `layout()` + `wireStaticHeader()` in `js/ui/shell.js` (the registry), and `methodFooter()` + `wireMethod()` in `js/tabs/filings-tab.js` (a tab's own coverage) — read *An explanation with no door* first. The doors go BELOW the content; the header button and the active pill stay gone |
| Add an Ask Research source that fetches nothing | give its builder an explicit `load: null` in `js/research/estate.js` — a builder with neither a `load()` nor that declaration is raised as a registry error, because an omitted one used to throw and wear the upstream's clothes |
| Change what appears in the News feed from X | `js/data/twitter-news.js` (the conversion) + `feedRows()` / `postBody()` in `js/tabs/market-news-view.js` — read *X/Twitter is a SOURCE in the News feed* first; it must stay ONE list |
| Change the X account list, or how a handle is read | `js/core/twitter-handles.js` + `js/ui/twitter-sources.js` — the 1–15 `[A-Za-z0-9_]` rule is also in `worker/index.js` and `scripts/scrape-twitter.py` and the three may not disagree |
| Change how X posts are collected | `scripts/scrape-twitter.py` + `.github/workflows/twitter-refresh.yml` — the exit codes are the interface (0 wrote, 2 nothing readable, 3 no credential, 1 a real fault) |
| Set up X collection on a deployment | add an **`X_ACCOUNTS`** repository secret (*Settings → Secrets and variables → Actions*), one `username:password:email:email_password` per line. The dashboard's Add Handle control additionally needs `GH_DISPATCH_TOKEN` on the Worker, and says `Adding…` rather than failing without it |
| Change the lower-left source beacon | `js/ui/source-beacon.js` + the `.beacon-*` block in `public/index.html` — read *The source beacon* first; it may not reintroduce a header Sources button, and every count in it stays derived |
| Add a reusable chrome widget | `js/ui/components.js` |
| Change the header status pill or refresh button | `statusControl()` in `js/ui/components.js`, wired in `wireStaticHeader()` |
| Change what raises a live alert | `js/core/watch.js` (what counts as an event) + `js/ui/notifications.js` (how it looks) — read *The header, and the alert stack* first |
| Change routing or URL shape | `js/core/router.js` |
| Add persisted state | `js/core/state.js` |
| Add a polled/live data source | `js/core/live.js` + `live.register` in the owning tab |
| Stop a feed re-downloading itself | `js/core/store.js` (client) + `worker/http.mjs` (ETag/304) — read *Never re-download what the reader already has* first |
| Make tab switching faster | `scoreTable` streaming in `js/ui/screener.js`, the measurement-free scope toggle in `js/ui/components.js`, and committed `public/css/tailwind.css` — read *Performance on large tables* first and profile before changing them |
| Change what the shell waits for at boot | `CRITICAL_SOURCES` / `DEFERRED_SOURCES` in `js/app.js` — a deferred file needs a consumer that awaits it |
| Change what the Earnings Calendar shows for a date | `renderCalendar()` in `js/tabs/earnings-hub.js` plus `/api/earnings-calendar` — keep the Calendar scheduled and Earnings Reported filed |
| Change what counts as a content change | `withTag` / `VOLATILE_KEYS` in `worker/http.mjs`, and `structureTagOf` in `worker/index.js` |
| Add a cached feed to the device store | give it a key in `KEYS` (`js/core/store.js`) and fetch it with `conditionalJson` — unless the upstream sends no ETag, as the Deep Dive reports do, in which case `readEntry` / `writeEntry` directly and say why in a comment |
| Add a new JSON file | drop it in `public/data/`, add to `DATA_SOURCES` in `js/app.js`, document it in `docs/DATA-CONTRACTS.md` |
| Add a server route | the marked `/api/*` block in `worker/index.js` |
| Understand a JSON shape / unit / source | `docs/DATA-CONTRACTS.md` |
| Understand the roadmap | `docs/SPEC.md` §8 |

---

## Verification checklist before pushing

```bash
python3 -m http.server 8080 -d public
```

Then run the suite — ~410 Playwright assertions, exits non-zero at the end if any failed
(Chromium is preinstalled — never run `playwright install`):

```bash
node scripts/verify-calendar.mjs
node scripts/verify-research.mjs
node scripts/verify-ui.mjs
node scripts/verify-sdk.mjs
```

`verify-sdk.mjs` is separate because it needs a different fixture: the dashboard inside an
**iframe** with a host on the other end of the channel. It drives the **real** shipped SDK bundle —
fetched once and served to the page from memory, so it does not depend on the browser reaching S3 —
and asserts the handshake from the host's side:

- nothing is sent before `host:init`, then **exactly one** `dashboard:ready` on the host's own
  channel, naming this dashboard — which is what catches a manual `ready()` or `autoReady: false`
- session and market context reach the app through `getContext()`, and a later
  `host:context:update` repoints the view without a reload; a pushed **logout** clears the token
  rather than leaving a stale one, and the dashboard keeps rendering
- every Munshot API request carries `Authorization: Bearer …` and **no committed static file does**,
  driven through the real call sites rather than the helper alone; the allow-list is asserted at all
  six boundaries, including the two third-party origins this app calls from the browser and a
  hostname that merely *ends* like `muns.io`
- `dashboard.capture.snapshot` answers in the documented `{ context, selection, data }` shape,
  naming the scope and route; `dashboard.capture.visual` returns a real PNG **Blob**; an
  unregistered topic is refused **by name**, which is what proves the two real ones are registered;
  and a capture that cannot run answers with a structured error rather than timing out

It covers, beyond the checklist below:

- shell renders with **zero console errors**
- every Research Central tab renders its panel
- every tab that has a statStrip shows 4 cards with the gradient freshness hero as the 4th
  (the Earnings Hub and all four Breakouts sub-views have none by design; a Live pill carries the
  provenance instead, and the suite asserts the modal behind it still names the source, the
  capture time and every figure the cards printed)
- **the Breakouts Live pill is green only when the data earns it**: `freshnessOf` is asserted
  directly at 0h, 22h, 71h, 73h and a week, plus the no-capture-time case, because the shipped
  snapshot only ever has one age
- the sub-view picker switches content, its menu is not clipped by its own card, and the content
  column is full width with no left rail on any tab
- the Portfolio / Watchlist / Universe toggle changes what every tab reports, and the vocabulary
  is in that order — widest last
- **the dashboard opens on Ask Research, in Portfolio scope**; AI Alerts has no sub-view picker and
  its cards are unique by ticker, score-descending and above the surfaced threshold, while score arithmetic stays hidden
- **Portfolio Analytics is gone and cannot be reached**: an old `#/portfolio/...` link lands on
  Research Central with the URL corrected and the tab bar back, every deleted ledger module and
  payload 404s on the served site, and no Ask Research source carries a ledger figure or a route
  outside `#/research/`
- **an answer survives leaving Ask Research**: a same-document navigation away mid-answer really
  unmounts the tab, the answer still arrives and is saved, it announces itself in the alert stack,
  and it is in the conversation when the reader returns with the composer clear — and an unsent
  draft survives both a tab change and a reload
- **Ask Research keeps all fourteen evidence sources represented**, spends its budget on rows (every
  ready source with rows in scope lands at least one, nothing trimmed to make room), resolves a
  company named in lower case to its ticker and leads every carrying source with it, streams the
  dashboard answer,
  makes no unsupported web-search claim, and has no empty-Watchlist shell replacement
- **General Alerts reads exactly the nine feeds behind all eight research tabs** — asserted as an equality, not a floor,
  because a `>=` would not notice the page widening back to feeds it was narrowed away from
- **it reads all eight research tabs**, with company and market-wide News as separate feeds
- **its coverage panel accounts for every feed by name**, distinguishes *has not looked at today*
  from *nothing today* from *could not be read* from *reading…*
- **every General Alerts row carries valid direction and importance plus both reasons**;
  announcement and insider classifiers and `moveSeverity` are asserted directly at their
  boundaries; every event id is unique (compared, not counted); and mounting the tab sends
  **zero** per-company filings requests
- **General Alerts history is complete in the table model but paged in the DOM**: the suite asserts
  more than one retained date, stable unique ids, newest-first date/time order, an 80-row initial
  paint, the next chronological page on internal scroll, full-data counts under the Today filter,
  and an explicit date/time resolution on every painted row
- market-wide news is excluded from a narrowed scope **with the reason stated**, not filtered to
  nothing
- **an empty watchlist gets its own panel on every tab**, saying there are zero watchlist companies
  and opening the Watchlist editor directly from **Add companies to watchlist** — never an empty
  table under a filter the reader never set
- **the star marks a company, not the row it sits on**: on the Earnings Hub the row key is
  Moneycontrol's scID and the watch key is the ticker, starring one row of a company fills the star
  on its other rows, and a legacy composite row key is pruned rather than filed as a company
- the Watchlist scope narrows a feed to the starred companies, an EMPTY one narrows to nothing
  rather than to everything, and the pill prints its own denominator
- the URL hash updates; browser back/forward work
- a reload restores the same route and scope
- the top-tab underline scales in on the active tab only
- top cards and table rows open the drill panel; ESC and the backdrop close it
  (the Earnings Hub has no drill by design — its rows are inert and the suite asserts that)
- scoreTable search, header sort, filter select and watchlist toggle all work, and the
  watchlist survives a reload
- **the watchlist star fills when it is clicked** — on the click itself, under the watchlist-only
  filter, and after a reload — and the glyph agrees with what is stored
- **a sub-view's controls do not move when you change sub-view**: measured on both Earnings Hub
  views, same `x`, aligned to the title, below it rather than beside it
- every con-call row's summary link is built on the **document** route, never the company route
  that needs a period we do not have — the shape every link 404'd with
- the con-call panel and drill say the analysis is a third party's and **never print the
  provider's brand**
- **the source registry contains no hand-typed figure**: the book count, the uncovered-lines count
  and the reported-companies count each match what the modules report, and no source describes
  itself with a zero
- the status pill is passive and opens no modal; the source registry still lists every documented source
- the header carries no search box and no Sources button, exactly one status pill reading
  "Live · updated <when>", and a refresh button that reports a result
- an alert renders in the lower-right corner, never announces the same event twice, caps its stack,
  sits behind all three overlays, and never turns a sign change into a growth rate or an
  unanalysed con-call into a score of nil
- layout holds at 1440px, 1024px and 390px with no sideways page scroll
- the Earnings Hub's ten columns fit inside 1440px with no scrollbar of their own, and its
  reported-figure columns recompute to the growth percentage shown beside them
- its column headings stay put while the body scrolls, and its rows are in the upstream's own
  order within the newest date — not merely date-sorted
- the Earnings Hub's YoY/QoQ toggle repoints the comparison columns and the URL, survives a
  reload, and leaves the current-period figure for a given company **identical** under both
- its two filter dropdowns partition the set exactly (STD + CON = all) and combine rather than
  replace each other
- **the book is whole**: every line from the statement is present, each carries a ticker or a stated
  reason it has none, no two lines collapse onto one symbol, the counts add up, every Portfolio-
  scoped row on Earnings Hub / Con-call / Breakouts resolves to a book ticker, and each of those
  pills prints the denominator
- **a landing costs no per-company request**: with a committed snapshot present, mounting a filings
  tab sends **zero** `/api/` requests, registers itself with the Refresh button instead, says how
  current the data is and how many companies have not been checked — and never claims nothing is new
- **all three filings tabs paint themselves from the snapshot and send nothing per company doing
  it** — News included, which used to open on a picker and is now the same deal as the other two;
  its scope pill compares companies with companies rather than articles with companies, and a
  company the scrape searched and found nothing for is **not** rendered as an untitled article
- **the three filings tabs ask the right questions and keep painting the answers**: every news
  request carries exactly one query string, a readable date range and a `q` that is a company's
  **name** with no part of the URL folded into it; all three walks send one request per company
  rather than counting a queue down without asking anything; a repaint still reaches the screen
  **after a scope toggle**, which is the re-render that used to kill the subscription silently; and
  **every rendered row is a row the feed actually holds** — compared, not counted, because the
  position-keyed rows that made News look duplicated always counted correctly
- the CSV round trip parses every row back, and a malformed file names each rejection with its line
- every `<th>` carries `scope="col"`; the three overlays trap focus and restore it on close
- **the two polled feeds do not re-download themselves**: the payload is kept on the device under
  a tag that describes it, a repeat fetch of either transfers headers and no body, the prices
  projection is a fraction of the full feed, the Live pill says where the paint came from, and no
  static-file loader is still using `cache: 'no-store'`
- **a Deep Dive report survives the upstream forgetting it**: with the slug answering `unknown`,
  their index naming nothing and this browser's dispatch record cleared, the row is still marked
  free to open, the report still renders off the device, no confirm step appears, nothing is
  dispatched, the panel never shows the run screen on the way, and the ribbon says both that the
  copy is this device's and that theirs is gone
- **the super-investor feed does not re-ask for what it has**: the list route reports
  `x-sattva-cache: hit` on a repeat request, a genuine second visit (a real `reload()`, not a hash
  navigation — that would leave the module's memory intact and prove nothing) makes **fewer
  requests than there are investors** while still painting every book, and says `origin: store`
  with a real `checkedAt` rather than claiming to be live; and the panel is rebuilt **fewer times
  than there are books**
- **a first visit does not fetch ninety-one books either**: the committed snapshot carries one per
  investor with a capture time on it and **no unread book written as an empty one**, a cold device
  paints the whole grid from it with no request per investor — on a static origin with no `/api/`
  at all — while `origin` remains `snapshot` over bytes nobody confirmed this session and the view
  adds no duplicate cache, scope or loading tags
- **the Earnings Calendar opens on today**, in IST rather than UTC, with today's chip scrolled into
  view; the selected date remains a schedule rather than changing meaning according to the clock
- **switching tabs does not block on building a table**: the initial markup carries a screenful and
  says how many rows are outstanding, every row still arrives, the row count reports the whole
  visible set rather than what has been painted, and no switch blocks the main thread past 400ms
- **the shell blocks on one bootstrap file**, the book — and a deferred feed still reaches the view
  that needs it rather than that view rendering an empty answer
- **the Earnings Calendar remains the all-exchange schedule on past, present and future dates**;
  Earnings Reported remains the separate filed-results view
- **the date strip holds still**: the selected chip is in view after a click, and the chip set does
  not reshuffle around it
- **a complete Calendar payload has one row per scheduled company across every pagination page**;
  a mixed-time count/list mismatch is never printed as a verified total

> A **SKIP** is the honest answer where the sandbox, not the page, is the reason a check cannot
> run — no egress to the ExcelJS/font CDNs, no Worker on a static origin. Tailwind is local, so
> layout checks still run. The final `zero console errors` check filters those environment failures
> and **prints how many it dropped**,
> so a run that hid a real error behind the filter still shows the count.
>
> The caching checks need a Worker. Against a plain `python3 -m http.server` there is no
> `/api/*`, so they report **SKIP** — which is itself worth seeing, because it exercises the
> snapshot fallback. Verify a caching change against `npx wrangler dev`:
> `node scripts/verify-ui.mjs http://127.0.0.1:8787`. A SKIP there is not a pass.
>
> The super-investor checks additionally need a reachable upstream, and pointing them at the real
> one would scrape somebody else's production on every push. Put a stand-in behind `MUNS_BASE` in
> `.dev.vars` — the two routes it must speak are in `docs/DATA-CONTRACTS.md` — and the block runs
> instead of skipping. That is how the edge cache, the stale fallback and the timeout budget were
> measured, and a stand-in that can be told to 503 or hang is what makes the failure paths testable
> at all.

> Sandbox note: the agent proxy may not reach Google Fonts or ExcelJS. The committed Tailwind
> stylesheet still gives screenshots the shipped layout and colours; the browser falls back to
> system fonts when Google Fonts is unavailable. Export checks report SKIP when ExcelJS cannot load.

## Automatic filing coverage (September 2026)

The company announcement and domestic-filings integrations now share the scheduled
`insider-trades-refresh.yml` capture. See `docs/DATA-CONTRACTS.md` → Automatic company capture
and permanent filing history for the authoritative contract. Do not replace BSE's date feed
with company lookups, discard captured history on an empty/failing response, advance a date
checkpoint after a partial parse, or equate a successful source check with complete coverage.
`company-capture.mjs` owns resumable state; `filing-archive.mjs` preserves BSE/insider events
before recent display windows apply. The frontend exposes coverage gaps and archived rows.
Production activation remains subject to the user's PR-specific deployment authorization.
