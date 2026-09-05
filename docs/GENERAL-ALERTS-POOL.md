# All Alerts: source-record pool

All Alerts collects before it filters. Portfolio and Watchlist are exact ticker-matched views
of the same records as Universe. A missing ticker stays in Universe and is counted in each feed's
`unresolvedCount`; it is not guessed from an ambiguous company name. Universe exclusions still
apply to ticker-bearing records. Scope changes do not launch company requests.

This is **available retained source coverage**, not a claim to capture every market event. Upstream
retention, source outages, absent captures and private/on-demand lookups remain explicit limitations.
No production collection jobs are dispatched by opening this page.

## Included sources

| Source tab | All Alerts records |
| --- | --- |
| Earnings Hub | Filed results and every company/date in the captured calendar, enriched by the stable Moneycontrol ID-to-ticker map; loaded calendar dates also join |
| Con-call | Held-call analysis, full source tags and market-wide scheduled calls |
| Portfolio calendar | Upcoming AGMs, postal ballots, results, calls and other dated events from the authenticated S Screen dashboard; available only in Portfolio scope |
| Public Chatter | Every company/topic summary, including unresolved topics; individual posts already requested in the source tab |
| Breakouts / Technical | Every real technical snapshot, including unavailable-price rows and below-threshold price changes; material price/volume/breakout events retain existing labels |
| Super Investors | Disclosed changes, every retained holding (including unchanged/filing-due states), and institutional/AMC disclosures |
| News | Retained company stories, all available market-news archive shards, and captured posts from currently monitored X accounts |
| Corp Announcements | Every retained BSE announcement |
| NSE Filings | Latest/retained filings and available archives up to 90 days, without changing that tab's selected window |
| IPOs | Every available published IPO history capture; filing records, dated market observations and labelled tracked-issuer supplements such as EAAA |
| Company/DRHP document views | All normalized records from successful lookups in the current session, before source-specific view filters |

Synthetic Earnings Surprise examples are deliberately excluded from the real event pool. Source
documents and post bodies that have not been requested are **not** described as loaded: those
categories say `on-demand`, including returned-limit/unmapped-record warnings. An on-demand
lookup is not a whole-universe scan. Private records are in-memory only, never persisted or sent
in a new network request, and clear on host session changes/logout.

## Record and date contract

Every event keeps `sourceRecord` (the complete normalized source row), source link, stable source
identity, company identity if resolved, independent direction/importance labels and their reasons.
Collection does not truncate the evidence. Exact duplicates within a source are removed;
cross-source evidence is kept separately.

Company news is produced by a search endpoint. `company-news-attribution.js` separates searched
identity (`queryTicker`, `queryCompany`, `queryEntityId`) from article-supported identity
(`companyTicker`, `companyName`) and carries evidence and a versioned `confirmed | uncertain |
unrelated` status. Names use Unicode/accent normalization and whole phrases, including reviewed
brands, aliases and former names from capture identity metadata. Short symbols need an exchange
qualifier. Subsidiary-only and snippet-only mentions remain uncertain: snippets can contain related
links, and a subsidiary event is not automatically a parent event. Only explicitly bounded
`articleBody: {provenance: 'publisher-article-body', text}` is eligible as body evidence; raw HTML
and arbitrary upstream content are never scanned as article bodies. This change adds no article
fetches and does not claim to have verified article bodies in existing captures.

Confirmed AND uncertain rows remain searchable by company/ticker in News and All Alerts. Possible
matches are labelled, and News provides a counted optional relationship filter. Missing names never
silently exclude coverage. Only an explicit reviewed article–company mismatch detaches the display
identity; its raw archive remains untouched and the retained row remains searchable by headline in
All Alerts / Universe. The initial reviewed mismatch is the user's exact Lululemon URL, title and
summary against JAYNECOIND. Changed text invalidates that exclusion. There is no publisher blacklist,
generic other-company rejection, or guarantee that every unverified search result is relevant.

Only confirmed news can score, corroborate or enrich AI Alerts; legacy cached news without current
attribution cannot bypass that rule. This is separate from All Alerts visibility and topic filters.
Ask Research and exports carry query provenance, status and reasons so a query label is not presented
as publisher-confirmed company evidence. Official filings and other feeds are unchanged. Stable
recall/precision fixtures are checked by `scripts/verify-company-news-attribution.mjs` and browser
coverage uses those same fixtures rather than relying on the day's changing captured headlines.

`includeHistory: true` means **all available records**, including undated items and future scheduled
dates. The UI partitions that single retained pool into mutually exclusive **Till Today** and
**Upcoming** views: an event dated after today is Upcoming, and a row dated today is Upcoming only
while its source still explicitly labels it `kind: scheduled`. A date not supplied stays
`day: null`, appears under "Date not supplied", and is never stamped with today. UTC instants are
converted to IST. Calendar and call schedules are labelled `kind: scheduled`; source snapshots are
`kind: snapshot`, not trades.
A filing-due percentage is unknown, never zero, an exit or a sale. IPO stage observations name
their capture date and do not claim that an old "Open" label is current today.

The default one-day `collect()` contract still selects that exact IST date. Date/search/feed
filters and table pagination change only the view. Excel export includes the original normalized
source record as JSON alongside the readable columns.

## Table-first reading layout

All Alerts opts into a wider, compact app frame. Source filters start collapsed behind **Sources**;
the control always states **All sources** or the number selected. The same source checkboxes open
in an overlaid panel, so using them does not reduce the table's height. Selection persists across
feed repaints. **Done**, Escape and an outside click close the panel; closing does not clear filters.

**Focus table** hides only this app's brand header and navigation, not the embedding host's controls.
**Exit focus** or Escape restores them. Search, filters, the current reading anchor, source counts,
date/scope metadata and the complete export model survive layout changes. Leaving All Alerts resets
focus mode. Other research tabs keep their existing layout. No source records, attribution rules,
row font sizes, row heights or retention policies change.

The table is sized from its actual position inside the host frame, including after window resizing
or control/status wrapping. Existing virtual scrolling keeps the DOM bounded without truncating
search or exports. On narrow screens the controls wrap and the table remains horizontally scrollable.

## Refresh and health

Opening All Alerts revalidates bounded source captures. While the tab is visible it rechecks
every 90 seconds, and Refresh uses the same path. Concurrent consumers share per-feed in-flight
reads. Source-tab updates reassemble loaded records without network requests; subscriptions and
timers are removed when leaving the tab.

Feeds settle independently. Failed refreshes keep last-good records and stay labelled incomplete
on cached repaints until successful revalidation. `on-demand`, `pending`, incomplete, stale/unknown
and confirmed-current are distinct. No green "all feeds current" claim is made while any registered
category is unread, stale, incomplete or on-demand. These states do not establish whole-market
coverage by the upstream.

## AI compatibility boundary

Raw record kinds carry `aiEligible: false`, so unchanged holdings, routine snapshots and schedules
do not manufacture urgency or change existing AI scores. `intelligence-graph.js` now uses those
records as a second, zero-score context pass after a supported material trigger already created a
candidate. Exact company identity is mandatory; source health, date distance and topic overlap rank
the context, independent feeds are preferred, unsupported query-assigned news identities are
excluded, and future schedules remain explicitly future. AI Alerts shows at most one linked context
sentence. Ask Research receives the same correlations. This is enrichment, not a second priority
policy.

## Verification

`node scripts/verify-general-alerts.mjs` uses real adapters and shipped captures with every fetch
replaced: registry parity, unresolved/undated/upcoming records, source preservation, exact scope
subsets, empty Watchlist, no per-company fanout, private-memory isolation, successful refresh,
last-good recovery and unchanged AI scores for newly added raw observations.

`scripts/verify-general-alerts-ui.mjs` runs a local browser with no external requests: time-horizon
switching, portfolio-calendar isolation, source/search rendering, updates while mounted, scope
changes, host logout, responsive widths, application errors and lifecycle disposal. It uses
`PLAYWRIGHT_ROOT` and `CHROME_PATH` like the other focused UI tests.
