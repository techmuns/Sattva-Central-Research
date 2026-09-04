# Sattva Central Research

An Indian-equities research dashboard: twelve tabs — Ask Research, AI and general alerts,
earnings, con-calls, public chatter, technical breakouts, superstar investors, news, corporate
announcements, NSE filings and insider trades — under a global **Portfolio · Watchlist · Universe**
scope toggle that applies to every one of them.

**The public Portfolio snapshot is a list of company names, not a ledger.** The Portfolio scope filters the
research tabs by Family Office's active shared workbook, through a protected names-only export.
It refreshes on load, every minute while visible, and on Refresh; failed reads retain the saved
book. Sources shows the portfolio connection as Connected or Not connected. See [active holdings setup](docs/ACTIVE-FAMILY-HOLDINGS.md).
There are no quantities, costs or valuations in this public snapshot.
A Portfolio Analytics workspace over an illustrative ledger used to exist and was
deleted; it is in git history at `d3bba30` if a real ledger is ever wired.

**Portfolio-aware Ask Research** stays in Central Research. An authenticated,
hidden Family connector revalidates the uploaded book and refreshes quotes for
every question. All held listed ISINs, sectors and listed-market-value weights
accompany the dated question-specific reading, including fund units and unresolved
symbols. An expired session can be unlocked inside Research; no second dashboard
is needed. Missing access or a failed archive recheck stops the answer. Existing
public conversation history remains visible; portfolio-connected conversations
stay in memory only, with no private data in public assets or localStorage.
See [the integration contract](docs/PORTFOLIO-INTEGRATION.md).

**Ask Research** is the landing tab. **AI Alerts** is an explainable seven-day priority queue that groups events by
portfolio company and surfaces the highest-signal evidence first. Materiality, recency, direction,
real Portfolio membership, independent-feed corroboration, conflicts and sector clusters determine
its internal ordering; cards show evidence and a next action without exposing score arithmetic.
Search covers company names, symbols, summaries and all underlying events, including evidence
beyond the first page, within the selected scope and priority/archive filter. Each card shows its
latest source signal date (not an AI generation timestamp, which is not recorded). Source times
appear only when the newest day has complete time precision. Relative ages follow the current
IST calendar and the seven-day window re-ranks at midnight or when a sleeping tab returns.
Inside Sattva Family, AI Alerts reads the refreshed active book and orders surfaced alerts by
holding size within the selected filter. Cards show each stock's share of listed portfolio market
value, aggregated across entities. The book date and quote limitations remain visible. Standalone
Research has no private sizes and retains evidence-priority ordering; no portfolio values are
copied into public files or browser storage.
Alert evidence loads alongside holding-size checks. Completed AI Alerts remain visible during
background refreshes and return visits, with search and pagination preserved; a completed refresh
replaces the view together. All Alerts retains each source's existing records while it rechecks.
Temporary Family Office failures retain the last verified company list with an unavailable status;
expired access clears the private session. Private holding sizes remain in memory only.
Stale feeds are penalised and named in a compact header warning. **All Alerts** keeps the complete
newest-first, internally scrollable history from Earnings, Con-calls, Public Chatter, Breakouts /
Technical, Super Investors, News, Corporate Announcements and Insider Trades, with date, direction,
importance and feed filters. Both views reuse the same feeds and add no source of their own.

**Ask Research** is a conversational workspace that assembles a bounded evidence
packet from every dashboard data module, reports source coverage and provenance, and keeps its
conversation library on the reader's device. The Worker sends the bounded packet to Muns' hosted
LLM router and forwards each NDJSON text chunk immediately, so answers render progressively without
exposing the session token or waiting for the complete model response.

Static runtime, no bundler, no framework, no npm dependencies for the app itself.
Vanilla ES modules and a committed, precompiled Tailwind stylesheet. Hosted as a Cloudflare Worker.

![Earnings Hub](docs/screenshots/earnings-hub.png)

---

## Status

**All fifteen tabs across both workspaces are built.** See
[`docs/HANDOFF.md`](docs/HANDOFF.md) for the full live-vs-mock inventory, the architecture map,
deploy notes and the known gaps.

**Public Chatter is live too**, off the SentimentDash API — mention counts and sentiment across ValuePickr, TradingQnA and Google News. The synthetic forum/Telegram corpus that used to fill it is deleted rather than relabelled.

**Two more surfaces are genuinely live.**

*Breakouts / Technical* scores 535 NSE-500 companies against a 16-rule, 24-point model from a
daily Yahoo Finance EOD scrape plus NSE delivery data, refreshed weekdays at 07:00 IST by
[a GitHub Action](.github/workflows/technicals-refresh.yml).

**Earnings and con-call scans use real feeds.** Earnings Reported uses Moneycontrol and Con-call
uses StockScans. Earnings Hub → Company Filings adds on-demand annual reports, earnings reports
and transcripts from Screener.in through Muns. The old synthetic earnings corpus is no longer
served or loaded. Analyst consensus estimates remain **not connected**, so Earnings Surprise
shows an unavailable state instead of invented beat/miss figures.

The Sources modal in the header lists every feed with an honest live / real / mock / pending
status. What each tab does *not* do is recorded in `docs/SPEC.md` under its "Still to come" —
a dashed **Wiring roadmap** card used to carry that under every table, and it was chrome competing
with the content it sat beneath.

---

## Run it locally

No install step. Serve `public/` over HTTP with anything:

```bash
python3 -m http.server 8080 -d public
# then open http://localhost:8080
```

Opening `public/index.html` directly from the filesystem will **not** work — `fetch()` of the
JSON data files is blocked on `file://`. The app detects this and says so.

Optionally, run it through the real Worker runtime:

```bash
npx wrangler dev
```

Ask Research is intentionally disabled until a server-side Muns session token is present. It prefers
`MUNS_LLM_TOKEN`, then falls back to the existing `MUNS_NEWS_TOKEN` or `MUNS_TOKEN`. The former
`ANTHROPIC_API_KEY` binding is read only while `MUNS_LLM_LEGACY_ANTHROPIC_BINDING` explicitly confirms
that it now contains a Muns token; this prevents a genuine Anthropic credential from being sent to
another service. For local Worker
development, put the token in the gitignored `.dev.vars`; for production, configure the dedicated
secret with `npx wrangler secret put MUNS_LLM_TOKEN`. Do not put it in `public/` or browser storage.
Conversation history is stored locally, while each submitted question and its bounded dashboard
evidence packet are streamed through `https://fastapi.muns.io/query-router` using the low-latency
`local_llm` route. `MUNS_LLM_TYPE=hosted_llm` remains available as an explicit operator override.
Every dashboard source keeps its status and provenance while ranked row samples share a
13,000-character budget measured on the packet the model receives (`public/js/research/evidence-shared.js`,
shared with the Worker) and sized for the local model's context window; a company named in the
question is resolved to its ticker and leads every source that carries it. The compact catalog
carries only identity and status because the source packets already hold the tab, route, dates and
provider; UI-only routes and that duplicate catalog stay out of the model prompt and out of the budget.

The browser never compiles Tailwind. If a change adds or removes utility classes, regenerate the
committed stylesheet with the pinned on-demand CLI (it installs nothing in this repository):

```bash
npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs \
  -i scripts/tailwind-input.css -o public/css/tailwind.css --minify
```

---

## Deploy

Cloudflare Workers, with the static site served through the `ASSETS` binding:

```bash
npx wrangler deploy
```

Config lives in [`wrangler.jsonc`](wrangler.jsonc); the Worker itself is
[`worker/index.js`](worker/index.js), which serves assets for everything and has a clearly
marked slot for future `/api/*` routes.

---

## Layout

```
public/
  index.html          design tokens, fonts, committed Tailwind stylesheet
  css/tailwind.css    generated utility CSS; served directly, never compiled in the browser
  js/
    app.js            bootstrap: load JSON, mount the shell
    core/             state, router, live engine, format, dom helpers
                      watchlist.js — the companies the reader stars, and the Watchlist scope
    ui/               components.js (primitives), shell.js (chrome + tab registry)
    concall/          keyword-engine.js (runtime scanner), keyword-editor, deep-dive
    data/             per-feed loaders: technicals, earnings, concalls, chatter, universe
                      coverage.js — the 142-company book the Portfolio scope filters by
                      scope.js — the three scopes; every forScope() is built on it
                      daily-alerts.js — retained chronological readings across the research feeds
                      ai-alerts.js — explainable seven-day company ranking over those readings
                      sentiment-shared.js — slug→NSE resolver, shared with the Worker
    scoring/          tech-scoring (24 pt), earnings-scoring (21 pt), rule-meta
    research/         bounded cross-dashboard evidence catalog + safe answer renderer
    tabs/             ai-alerts, daily-alerts, ask-research, earnings-hub, concall, public-chatter, breakouts,
                      super-investors, news, corp-announcements, insider-trades
  data/               portfolio-companies.json (the book, synced from techmuns/Sattva-Family — names
                      and sectors only, the ONLY portfolio data here), universe.json, technicals.json
worker/index.js       asset serving + live read-through APIs + the Ask Research stream
worker/research.mjs   server-only streaming Muns LLM bridge and request limits
docs/SPEC.md          product spec, nav model, per-tab features, roadmap
docs/HANDOFF.md       live-vs-mock inventory, architecture, deploy, known gaps
docs/DATA-CONTRACTS.md  every JSON file: shape, types, units, cadence, real source
CLAUDE.md             working rules, module contract, design tokens, where-to-look index
```

---

## Docs

- **[`docs/SPEC.md`](docs/SPEC.md)** — the product spec: navigation model, scope toggle, every
  tab and sub-view with its features, and the build roadmap.
- **[`docs/DATA-CONTRACTS.md`](docs/DATA-CONTRACTS.md)** — every data file's exact JSON shape,
  field types, units, refresh cadence and intended real source. Read this before wiring live data.
- **[`CLAUDE.md`](CLAUDE.md)** — stack rules, file layout, the module interface contract, design
  tokens, and the verification checklist.

## Refresh the technicals feed by hand

```bash
node scripts/scrape-technicals.mjs            # full run, ~10 min for 535 companies
TECH_LIMIT=15 node scripts/scrape-technicals.mjs   # smoke run -> technicals.smoke.json
```

A capped run writes to a sibling file and skips the ATR accumulator, so it can never truncate
the committed feed or poison the volatility-trend history.

## Regenerate the earnings test fixtures

```bash
node scripts/gen-mock-earnings.mjs
```

Seeded, so the output is byte-stable — a diff means a real change. Writes
`scripts/fixtures/mock-earnings.json` and `scripts/fixtures/mock-earnings-calendar.json`.
These synthetic figures are test inputs outside the served assets. The dashboard rejects them.
See [Domestic company filings](docs/DATA-CONTRACTS.md#domestic-company-filings) for the real
document endpoint; PDFs do not populate analyst estimates or structured financial history.

## Regenerate the mock con-calls

```bash
node scripts/gen-mock-concalls.mjs
```

Seeded, so the output is byte-stable. Writes `public/data/mock/concall-calls.json` (60 companies
× 2 calls, ~9,000 transcript segments), `concall-keywords.json` and `catalysts.json`.

Company names, tickers and sectors are real. **Every transcript line is synthetic, and every
person and brokerage firm named in these calls is fictional** — inventing a number for a real
company is one thing, putting invented words in a real person's mouth is another. The dashboard
says so on every surface that shows the data.

The keyword counts, though, are **not** mock: `public/js/concall/keyword-engine.js` scans that
text in the browser on every render, so editing a keyword's aliases genuinely changes what
matches. No count is stored in any file.

## Regenerate the mock investor set

```bash
node scripts/import-amc-portfolio.mjs # Bandhan Focused + Small Cap monthly portfolios, from scripts/fixtures/
```

Seeded, so output is byte-stable.

- **Investor names are real; their positions are not.** Ashish Kacholia, Dolly Khanna, Small Cap
  World Fund and the rest are real, and their genuine holdings are public. Everything shown here
  is synthetic, labelled on every surface — and the data set carries **numbers only**, with no
  `rationale`, `quote` or `thesis` field, deliberately, so there is nothing to render that would
  read as something a named person said.

## Verify before pushing

```bash
python3 -m http.server 8080 -d public &
node scripts/verify-calendar.mjs
node scripts/verify-research.mjs
node scripts/verify-ai-alerts.mjs
node scripts/verify-ai-alerts-ui.mjs
node scripts/verify-ui.mjs
node scripts/verify-navigation.mjs
```

Drives the site with Playwright and walks CLAUDE.md's checklist — every route in both scopes,
routing and history, table search/sort/filters, the drill panel, the provenance markers, the
Excel export and the responsive breakpoints. Exits non-zero if anything fails, so it can gate a
push. It uses a system Playwright install (`PLAYWRIGHT_ROOT` / `CHROME_PATH` to point it
elsewhere) rather than adding an npm dependency.

## Screenshots

| Technical Scanner | Rule breakdown |
| --- | --- |
| ![Technical Scanner](docs/screenshots/tech-scanner.png) | ![Drill panel](docs/screenshots/tech-drill.png) |

| Strong Breakouts | FII Accumulation |
| --- | --- |
| ![Strong Breakouts](docs/screenshots/strong-breakouts.png) | ![FII Accumulation](docs/screenshots/fii-accumulation.png) |
