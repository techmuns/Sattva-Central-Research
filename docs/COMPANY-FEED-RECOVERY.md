# Sattva company feed recovery — 3 October 2026

The published Sattva checkpoint at 2026-10-03 13:53 UTC reported `not-found` for
sixteen document and twelve company-announcement feeds. It reported no unresolved
holdings. The direct BSE source is separate: its 584 coded companies were checked
without failures, with one historical backfill remaining. This port carries the
shared recovery and publication fixes from [Glow #1340](https://github.com/techmuns/Glow-Central-Research/pull/1340)
and [Glow #1352](https://github.com/techmuns/Glow-Central-Research/pull/1352); Sattva keeps
its own portfolio, captured records, credentials, collection cadence and UI.

## Verified repairs

- HEG's current NSE symbol is HEGAM (ISIN INE545A01024). Use the verified current
  symbol for documents as well as announcements; retain files under the original
  portfolio ticker so previously captured documents remain accessible.
- Dhoot's Screener URL `/company/id/1286088/consolidated/` identifies DHOOTTRANS,
  BSE 544867. Reuse the shared reviewed URL parser instead of collecting `ID`.
- The public company pages were read successfully for HEGAM, DHOOTTRANS,
  JBCHEPHARM, BAGMANE, VERTIS, 543225 (Altius), INDIGRID, MINDSPACE, EMBASSY,
  BIRET and NHIT. Sattva also needs ALPEXSOLAR-SM → ALPEXSOLAR,
  ASHIKA → ASHIKAG and JAYBEE-SM → JAYBEE for document requests, using the same
  verified exchange identities already used for announcements. Public pages for
  these three, FCONSUMER and FSC are also readable. They expose original annual reports, concall transcripts,
  quarterly-result links and recent exchange notices without a paid API.

On a primary-provider `not-found` result, scheduled capture reads that company's
public Screener page. Exact NSE-symbol or BSE-code links must verify its identity.
Both source kinds share one bounded page request. Parsing failures cannot become
successful empty collections. Historical documents and notices are merged into
their existing durable files. A symbol correction does not purge domestic history.
Primary authentication failures remain failures; the fallback does not conceal them.
An immediate browser check may use fresh scheduled documents after an explicit
`not-found`; authentication, server, network and malformed-response failures remain
visible with the retained rows. Document tables and exports use each row's provider.
Missing or unexplained empty concall and quarterly sections fail instead of certifying no
documents. JAYBEE's verified quarterly layout has no period columns and an empty Raw PDF row;
it is accepted as an explicit empty result. A populated table with changed link markup fails.
Malformed recent-notice entries leave validated neighbours retained with a skipped count
and limited coverage. A corrected upstream company identity removes primary/fallback-only
notice attribution and resets its coverage while independently captured BSE evidence survives.

The page's recent announcements are **not a complete date-window response**.
They are saved with independent provider attribution, primary-provider error and
actual check time. The checkpoint leaves historical ranges open and polls again
on the ordinary two-hour cadence. Sources shows partial recovery, not “Up to date”.
The existing paginated ALL-announcement collector remains the broader continuous
backup; direct BSE availability and historical gaps stay separately visible.
Public report-page availability likewise does not certify an exhaustive issuer archive.
FSC explicitly displays “No data available” inside its recent-announcements section.
That verifies an empty recent list only; it retains old notices and incomplete-history
status. A missing or unexplained empty section remains a source-read failure.

## Three shared reviewed security identities

These exact-ISIN mappings apply only when the corresponding security is in the
active scope. None of the three appears in Sattva's checked live capture universe;
this change does not add Glow holdings to Sattva or alter holdings and valuations.

- INE666D13019 is the Borosil Renewables warrant line. Its issuer equity is
  INE666D01022 / BORORENEW / BSE 502219. Only the
  announcement relationship changes; the holding's security and valuation do not.
- INE0LTR01029 is Everest Fleet Private Limited equity.
- INE0LTR03090 is Everest Fleet Private Limited's Series B preference security,
  dated 18 April 2043, also labelled “Efpl Pref 18042043”.

The exact security descriptions were checked in the NSDL-derived `ISIN.csv` in
the [archived ISIN dataset](https://zenodo.org/records/15121981). This is historical
identity evidence, not proof of current listing or security status. Everest's
[official site](https://everestfleet.com/) and
[shareholder notices](https://everestfleet.com/newsroom/) identify the private
issuer. The two Everest securities therefore receive reviewed issuer-name news
searches and official-page links, with explicit unavailable listed-equity filing
coverage. Company Filings and Corporate Announcements coverage panels count these
securities separately and warn in the relevant scope, matching exact portfolio ISINs;
unrelated watchlists do not inherit portfolio warnings. No exchange ticker is invented. Existing news entity IDs and archives
are retained. These mappings do not claim access to nonpublic shareholder notices.

## Validation and operation

`node scripts/verify-company-feed-recovery.mjs` checks exact identities, malformed
pages, unsafe URLs, source dates, no AI-summary ingestion, free fallback request
coalescing, preserved documents, incomplete-history reporting and outage retention.
It also checks that FSC's explicit empty recent list remains partial and cannot erase
saved notices or close historical gaps. `verify-company-feed-upgrade-ui.mjs` verifies
that a warm browser receives the new coverage module through the shipped service worker.
Existing capture, domestic-reader, health, news and portfolio checks also apply.
The `Company feed access check` (manual or on changes to the fallback) runs the same public-page
reader on GitHub with read-only repository permissions, no secrets and no data
publication. `node scripts/check-company-feed-access.mjs` runs that probe locally.

No paid service, credential, collection schedule or manual production operation is
introduced. At its next normal run, capture gives existing 404 failures one attempt
with the newly available fallback instead of waiting out the obsolete backoff.
That attempt records real source results; deployment alone never certifies recovery.

## Publication after concurrent changes

The scheduled capture uploads its recoverable artifact before publishing. If another
writer advances main, the retry fetches only the latest tip and reapplies this run's
single capture commit onto it. An ordinary fetch from the shallow Actions checkout
can follow a recently merged PR's older ancestry and download data history that the
publisher does not need. The bounded retry preserves the latest code and other feeds,
uses only normal fast-forward pushes, and stops with the capture intact on a conflict.
An identical capture already published by another writer finishes without a new commit.

`verify-company-capture-publish.mjs` executes the actual workflow shell against local
shallow clones and a bare remote. It covers a concurrent merge, retained records and
code, bounded history, identical publication and a conflicting capture. It performs
no production operations.
