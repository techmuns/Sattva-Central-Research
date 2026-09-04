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
| Con-call | Held-call analysis, full source tags and scheduled calls |
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

`includeHistory: true` means **all available records**, including undated items and future scheduled
dates. A date not supplied stays `day: null`, appears under "All available dates"/"Date not
supplied", and is never stamped with today. UTC instants are converted to IST. Calendar and
call schedules are labelled `kind: scheduled`; source snapshots are `kind: snapshot`, not trades.
A filing-due percentage is unknown, never zero, an exit or a sale. IPO stage observations name
their capture date and do not claim that an old "Open" label is current today.

The default one-day `collect()` contract still selects that exact IST date. Date/search/feed
filters and table pagination change only the view. Excel export includes the original normalized
source record as JSON alongside the readable columns.

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

This change expands collection, not priority policy. New raw record kinds carry `aiEligible: false`
so unchanged holdings, routine snapshots and schedules do not manufacture independent corroboration
or silently change existing AI rankings. AI still reads the All Alerts collector and applies
its existing policy to supported signals. Mapping the new evidence into ranking is the next phase.

## Verification

`node scripts/verify-general-alerts.mjs` uses real adapters and shipped captures with every fetch
replaced: registry parity, unresolved/undated/upcoming records, source preservation, exact scope
subsets, empty Watchlist, no per-company fanout, private-memory isolation, successful refresh,
last-good recovery and unchanged AI scores for newly added raw observations.

`scripts/verify-general-alerts-ui.mjs` runs a local browser with no external requests: source/search
rendering, updates while mounted, scope changes, host logout, responsive widths, application errors
and lifecycle disposal. It uses `PLAYWRIGHT_ROOT` and `CHROME_PATH` like the other focused UI tests.
