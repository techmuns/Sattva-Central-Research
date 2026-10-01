# BSE collection and independent announcement recovery

BSE collection separates closed historical dates from the live Indian calendar day.
Only an affected category/date or company/date walk restarts when the source changes
its declared page total. Each walk permits at most three attempts, one second apart;
access denials and malformed records are failures, not reasons for repeated requests.
Every BSE read shares one request profile, `bseRequestHeaders()`; see below.

The exchange collector preserves fully validated pages and successful categories
when another window fails. `failedWindows` names incomplete intervals; only a
contiguous sequence of complete windows advances `lastCompleteTo`. Successful,
validated zero counts represent a quiet interval. Failures retain saved rows and
successful timestamps and record the failed attempt. Monthly archives never expire.

A long outage leaves a backlog that one walk cannot finish inside the collection
step's 12-minute limit, and a stopped run writes nothing. On 1 October 2026 the
first Sattva run after the header fix read every page it asked for, but its
twelve-day backlog (21 September to 2 October) outlasted the step, so every later
run would have restarted the same walk. The collector now reads closed history in
windows of `ANN_CHUNK_DAYS` days (default 3), oldest first, and starts no new walk
once `ANN_BUDGET_MS` (default 8 minutes) is spent. It writes what it completed,
names each unread window as a `budget` failure (so the capture stays visibly
partial and the run stays red), and moves the watermark only past complete
windows. A window that would end exactly on the previous watermark also reads the
next day, so the days each run re-reads for late filings never use up a window
without progress. The next run resumes there, so any backlog shrinks on every run.
`verify-bse-collection.mjs` covers the split, the stop, the watermark and the resume.

Sattva's existing company-directory validation remains authoritative. A refused or
incomplete directory retains its verified timestamp, explicitly reports partial
identity coverage and keeps unknown issuers under their BSE code. It never prevents
source filings from being retained. Company-history reads still require a complete
walk and use their existing retry schedule and durable coverage ranges.

## What BSE refuses (measured 1 October 2026)

`api.bseindia.com` sits behind an Akamai bot filter that answers with an HTML
"Access Denied" 403. It tightened twice in a week: on 23 September 2026, when a public
BSE client restored access with a current browser User-Agent and `Sec-Fetch-Site:
same-site`, and again during 29 September, when Glow's identical collector, which had
read every category from a GitHub runner that morning, was refused that evening. This
repository's read-only access check has been refused on every run since. Announcements,
the company directory, bulk/block deals and the shareholding index all failed.

The 1 October investigation changed one header at a time, from a cloud host, with
both `curl` and Node's `fetch` (the collectors' client):

| Request change | curl | Node `fetch` |
|---|---|---|
| Full current-browser profile (`bseRequestHeaders()`) | accepted | accepted |
| Referer `https://www.bseindia.com/corporates/ann.html` | **refused** | **refused** |
| No Referer | redirected (301) | redirected (301) |
| No Accept-Language | refused | accepted (Node sends `*`) |
| No `sec-ch-ua` client hints | refused | accepted |
| Chrome 138 or older | refused | accepted |

The rule that broke collection is the Referer. `/corporates/ann.html` is the page BSE
retired when it rebuilt its site (it now redirects to `/corporates/ann`), so only
scripts still send it. Under the site's referrer policy a browser on any BSE page sends
just the origin, `https://www.bseindia.com/`, to the API host, so that is the value now
sent: the faithful one, and the one a site rebuild cannot retire. The other rows show
the filter also scores how browser-like a request is, so the profile is what a current
desktop Chrome sends from BSE's own page, with Accept-Language, client hints and fetch
metadata. Its Chrome version is **derived from the date** (one release behind Chrome's
four-week schedule), so it cannot age into the "old browser" range. GitHub's network
was never shown to be banned: the refusals follow the request, not the host.

One profile serves every BSE read: `bseRequestHeaders()` in `worker/bse-ann.mjs`, used
by the directory, the exchange-wide and company-history announcement walks, bulk/block
deals and the shareholding index (`exchangeRequestHeaders()` in
`scripts/lib/exchange-deals.mjs`). Filing documents on `www.bseindia.com` were accepted
with either the old or the new headers. Offline coverage:
`node scripts/verify-bse-request-profile.mjs`.

## When BSE refuses again

No request profile is permanent: BSE can add a rule on any day, and did twice in one week.

1. Run the **BSE read-only access check** workflow (manual dispatch), or locally
   `node scripts/check-bse-request-profile.mjs`. Its first output is a diagnosis: the
   current profile, then the same profile with each header and each header group
   removed, the retired Referer and a Chrome a year old, one request each, with
   `required` naming what a refusal turns on. A redirect is never followed and a 200
   challenge page is never read as access.
2. If one header or value explains it, change `bseRequestHeaders()` to what a current
   Chrome sends from BSE's own page, and let the check and the scheduled jobs confirm it.
3. If the current profile is refused and no single header explains it (`required:
   null`), the cause is outside the headers: cookies, network or a new policy. Do not
   rotate disguises to get past a deliberate block. Rely on the independent recovery
   below and decide on licensed access.

A public website's bot filter is BSE's to change, so direct collection is kept faithful
to a real browser, self-updating and quick to diagnose, never guaranteed. A contractual
guarantee needs licensed access to BSE's announcement data, directly or through a data
vendor; that is a cost decision for the owners, not a code change.

## Independent publisher index

The existing two-hour announcements workflow separately reads Screener's authenticated
**All announcements** index using the repository's existing Screener credentials.
This does not change a watchlist. Original filing titles, timestamps and BSE/NSE links
join the normal announcement stream; generated publisher summaries are excluded.
Notices without documents retain a labelled reference page, never a fabricated PDF.
Missing source times stay missing; date headings use the publisher response clock.

Recovery saves fixed timestamp windows and same-timestamp pagination offsets. It
archives records before committing the corresponding cursor, so interrupted writes
replay safely. New arrivals are prioritized before rotating unfinished windows.
Collection overlaps two hours and reconciles the past seven days daily. Initial
history begins seven days back or two days before BSE's older successful watermark.
A twelve-minute/600-page budget keeps unfinished intervals explicit for future runs.
Requests are at least 2.5 seconds apart. Refusals stop the run; Retry-After persists,
and a rate limit without that header waits at least thirty minutes.

`public/data/screener-announcements.json` holds an explicitly unavailable bootstrap
until actual capture, then source status, verified intervals, unfinished cursors and
a seven-day head. All recovered history is also stored in `announcements-archive/`.
Large months use verified, content-addressed JSON parts without dropping records.
Both readers and subsequent captures reconstruct all parts and reject corruption.

A failure in one collector does not discard the other's saved progress. Health checks
run after publication and report each source's failures, stale checks and historical
gaps independently. A working backup never certifies exhaustive BSE/NSE coverage.
The screen and export distinguish original documents from source reference pages.
Late omissions older than the seven-day reconciliation window can remain unavailable.

## Validation and operations

Local fixtures cover page drift, interruption, cursor ties, late additions, cooldowns,
failed writes, unknown issuers, archive integrity, source health and reader upgrades:
`verify-bse-collection.mjs`, `verify-announcement-recovery.mjs`,
`verify-announcement-directory-fallback.mjs`, `verify-filings-health.mjs` and
`verify-corporate-stream-ui.mjs`.

`check-bse-access.mjs` and the BSE read-only access-check workflow validate the public
directory, configured categories and multi-page company history. They write no
capture data and dispatch no production collection. Keep the standard runner unless
an explicitly selected alternative passes this qualification. A successful probe
establishes access at that time, not continuous production recovery.

After release, inspect the normal scheduled publications and actual source watermarks.
Do not clear checkpoints or label recovery complete based only on CI. Manual production
backfills, retries, resumptions, deployments or restarts need authorization for that
exact action. The existing schedule continues without an open dashboard.
