# Company market-cap coverage

The technicals capture covers its scored companies; the Moneycontrol ticker map covers companies
encountered through earnings. Neither is a listed-company market-cap directory. PRIZOR and BSE-only
Simplex Castings exposed this gap in October 2026.

`scripts/collect-market-caps.mjs` captures public Screener market capitalisation in **₹ crore** for
the complete verified NSE main-board/SME and BSE active/suspended company directory. The public
screen is an efficient bulk input, not a claim of exhaustive coverage: its predicate is explicitly
market capitalisation greater than ₹1 Cr and includes some companies outside our exchange directory.
The collector validates the predicate, units, pagination, row counts and duplicate identities. It
matches exact NSE symbols and BSE numeric codes into the exchange directory's ISINs. Provider-only
company IDs and unverified names never identify listed issuers.

Every directory company missing from that screen is checked through its exact public company page.
That fallback must contain the same NSE symbol or BSE code in its exchange links. No name matching,
sector market cap, free-float cap, holdings-based share count or inferred valuation fills a blank.
The documented Upstox company-profile endpoint supplies **sector** market cap; it is not a source
of this company value: https://upstox.com/developer/api-documentation/get-company-profile/.

Verified main-board/SME directory check times and errors remain separate from request attempts.
Coverage refers to that saved directory; a failed segment check makes it partial even if every
saved company was checked for market cap.

The existing weekday Data refresh runs this collector in a parallel job so its directory walk
does not consume the technicals job's runtime or delay publishing other feeds. No additional schedule or paid search is
introduced. Requests are two seconds apart, with a thirty-minute run budget and atomic checkpoints
every 25 screen pages / 50 company pages. A rate limit respects Retry-After with at least a minute's
wait and one retry; another refusal stops the attempt. Stored cooldowns apply across runs. Stalest
individual attempts run first next time, and previously captured/delisted entries remain saved.
The initial local capture can use a longer budget to audit the whole directory.

`public/data/market-caps.json` keeps each figure's source URL, exact identities, `checkedAt` and
unmodified source price-date label, plus latest-attempt errors. `generated_at` dates the collection
attempt; it never makes a retained figure newly checked. A screen without a price date remains
undated. Full day/month/year price labels supply `priceAsOf` and take precedence by their source
date, rather than collection time. A company page displaying only day/month does not establish an exact year/date. Source
failures retain the previous figure and its original check time; companies without a trustworthy
figure retain a dash, remain visible and stay in the Not available filter.

The shared company-profile lookup uses these figures across the announcement index and static
fallback, preserving a newer explicitly dated market-cap observation when there is one. Yahoo
bar dates and ticker-map file regeneration never re-date a cached Screener/Moneycontrol cap. Source/check details
appear in the cell tooltip, collection details in Sources, and the unrounded figure and provenance
in the export. News/All Alerts obtain the same lookup through the index or committed reference
files. A successful index lookup is supplemented by the directory, because non-filing companies
are absent from its compact table. Exact ISIN and then BSE code precede symbols, and colliding
unqualified symbols remain unknown. Long-lived readers revalidate profiles when used after fifteen
minutes; local feed refreshes revalidate their lookup, and failures retain each saved index/directory
component and each independent reference input. A shared watcher checks the cadence while
ranking subscribers remain mounted and visible, checks again on return, and stops after their
subscriptions are removed. Sector SHA/classification metadata advances the lookup independently.
Completed company-page walks remain partial when transport or identity/shape checks fail;
verified pages with no figure are counted separately. Fresh reference reads bypass held service-worker data in the same request while
allowing unchanged HTTP bytes to be reused. Announcement-index input identity includes the market-cap capture, and the
existing Data refresh completion rebuilds the index.

Run `node scripts/verify-market-caps.mjs`, `node scripts/verify-relevance.mjs` and the announcement
browser/runtime checks. Verify a returning cached session upgrades before considering a JS release
complete. A successful pipeline does not prove that an unpriced/suspended issuer has a market cap;
the captured coverage and per-company errors remain authoritative.
