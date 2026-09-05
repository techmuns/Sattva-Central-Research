# Portfolio news discovery

This is additive enrichment of existing feeds, not a promise that every published story is
discoverable. Collection retains candidates before ranking. A zero result is a successful source
response, not evidence that nothing happened; failed, stale or capped searches remain visible.

## Identity and evidence

`public/js/data/company-news-reviewed.js` contains shared, primary-source-reviewed enrichment.
The four pre-existing ISIN-specific overrides moved unchanged into that shared registry;
`scripts/company-news-identity-overrides.json` remains an optional collector/test override input.
Every active holding is searched, including tickerless lines. Warrants sharing an
underlying company keep all portfolio ISINs on one stable entity. Position sizes never enter public
capture files or identity search plans.

Names, former names and reviewed aliases are company identifiers. `searchAliases` only broaden
retrieval (e.g. bare Jayaswal Neco or Sterlite analyst day); they do not prove attribution. Typed
`relatedEntities` require an evidence URL and an exposure caveat. Unknown subsidiaries/relationships
must not be invented to populate the registry. The initial reviewed additions address the three
reported misses; domains and corporate relationships for the rest of the portfolio still need
ongoing primary-source review.

The 4 September JNIL clarification says Neco Defence and Datasel are not its subsidiaries,
associates or joint ventures. Shared promoters/director are different from ownership. Its denial
of transactions/financial impact is the company's statement, not our independent conclusion:
[company clarification](https://www.necoindia.com/wp-content/uploads/2025/02/pressrelease04092026_Datasel-SRL.pdf).
EAAA's IPO documents concern the related issuer, not an IPO of Edelweiss Financial Services:
[Edelweiss exchange disclosure](https://cdn1.edelweissfin.com/wp-content/uploads/2026/01/EFSLExchangeIntimation.pdf).
SterliteTech's [official investor page](https://stl.tech/investor/) supplies the reviewed identity;
bare STL/Sterlite mentions do not automatically identify this listed company.

## Scheduled enrichment

The company-news workflow first completes its existing India search capture. An independent,
six-minute-budget enrichment stage then:

1. Maps exact reviewed portfolio/related-entity mentions from every retained publisher-feed shard
   into the permanent company archive. Nonmatches remain in the broad news archive.
2. Reads the reviewed IR index pages and retains every linked PDF's title and URL, even when
   undated. A bounded fair queue reads at most eight documents per run (first three pages, 6000
   text characters). No arbitrary authenticated crawling, paywall bypass, or invented dates from
   upload folders. Failed extraction retains the source link for recovery.
3. Searches all active entities/aliases without a country restriction, separately from India
   results. The proxy validates country and includes it in its cache identity. An older Worker
   response without an explicit global-search marker cannot be marked successful during rollout.
4. Uses 48-hour overlapping global polls plus weekly 30-day reconciliation. Crowded ranges are
   split by date; unfinished partitions survive in `company-news/discovery.json`. Twenty results
   is a conservative saturation heuristic, not a documented provider limit. A still-crowded
   single day is flagged, not called complete. There is no undocumented upstream pagination.

Jobs rotate by last attempt, so one broken/high-volume company cannot permanently starve others.
Only completed partitions advance success/reconciliation checkpoints. Every usable result is
archived even if later considered uncertain, low-materiality or unrelated. IR/global failures
cannot replace core last-good capture dates with an apparent successful refresh.

The existing source-details UI carries enrichment coverage counts and last-check time. The
workflow warns about incomplete coverage. Core news has its separate required health check;
enrichment is best-effort and must not block publishing good core observations.

## X discovery and limitations

Scheduled collection supports an existing own-account `X_COOKIES` session (Cookie header, JSON
cookie dictionary, or browser cookie list with `auth_token` and `ct0`), falling back to the first
configured `X_ACCOUNTS` account only when no cookie session is supplied. A rejected cookie session
never triggers alternative-account/proxy rotation. `X_CAPTURE_ENABLED=false` opts out. No paid API,
new account, secrets change, or manual production run is part of this change.

`prepare-twitter-search.mjs` resolves the current active portfolio and prepares separate company,
alias and related-entity terms, including tickerless companies. Search is across authors, not just
a fixed handle list. The default search order is Latest. Per-query date windows, result ceilings,
timeouts and outstanding partitions are recorded in `twitter-search.json`. A cap or source refusal
does not advance a successful checkpoint. Blocked/unknown authentication stops before attributing
failures to monitored handles. Previously seen pinned posts no longer truncate the timeline walk.

All captured posts are deduplicated by ID into permanent monthly `twitter-archive` shards before
the fast head is bounded. Both monitored authors and search-discovered posts remain readable;
history survives falling out of the 600-post head. Social matches are unverified discovery leads
in All Alerts, never independent factual AI corroboration. The status file explicitly reports
disabled/unavailable/partial coverage. Library/session/provider access can still fail; a merged
code change is not proof of a successful production X collection.

## Ranking and search

Exact reviewed matching makes existing publisher news and IPO records portfolio-scopable. The
original issuer, headline, source and relationship evidence are retained. Headline or bounded
official body event patterns add legal disputes, clarifications, analyst/investor days, IPOs and
business outlook. Search snippets and sidebars cannot independently promote an event.

AI cards can use a stable entity ID without manufacturing a ticker. Related-entity reports have
a distinct review label and caveat; they never supply direct-company confluence or independent
feed bonuses. A syndicated publisher link in broad/company feeds is one news observation, not
two independent confirmations. Search checks all eligible retained cards, including those below
the default priority threshold. Uncertain matches stay in News/All Alerts, not AI evidence.

The shared AI review window from `core/alert-window.js` remains authoritative. Publication time is
converted to IST; observation time is not substituted for an unknown publication date. Dismissal
uses stable company/entity identity plus the material evidence already read.

## Verification and acceptance

`verify-portfolio-news-discovery.mjs` replays the Neco relationship, EAAA IPO, Sterlite analyst-day,
tickerless and source-failure scenarios with local fixtures, plus the real enrichment stage in a
temporary directory. `verify-news-country.mjs` verifies actual Worker country/cache isolation.
`verify-twitter-search.py` and `verify-twitter-collection.py` use fake API generators only, testing
cookies, all-author search, caps, outstanding windows, refusal, pinned posts and permanent storage.
Existing attribution, archive, scope/privacy and browser suites must also pass.

After merge, inspect the next normally scheduled capture read-only. Live acceptance requires new
successful query checkpoints, captured source links, accurate partial-failure counts, and the
expected company mapping. Never report “we will never miss anything”; track actual source
coverage and turn each customer-reported miss into another regression fixture.
