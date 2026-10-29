# CMP and market cap in company tables

Ported from Glow Central Research on 29 October 2026. Glow's Portfolio and Watchlist sheets and
Family Book rows below have no Sattva counterpart; every other surface applies here.

The October 2026 table audit covers every registered tab and its company tables:

| Surface | Company tables |
| --- | --- |
| All Alerts | Timeline and upcoming events |
| Announcements | Corporate Announcements, Corporate Actions, Bulk/Block Deal, IPO filings and issuer directory |
| Earnings | Results, Calendar, Concall and summary coverage |
| Screens | Momentum, Strong Breakouts, Technical Scanner, FII Accumulation and scan exceptions |
| Mutual Funds | Company ownership table (fund schemes and source cohorts retain their own NAV/return measurements) |
| Public Chatter | Company coverage and retained company/topic catalogue |
| Private Market | Funding records and exports retain their source fields; listed-equity CMP and market-cap columns are excluded |
| Super Investors / Capital | Company holdings, quarterly comparisons, public deals, manager securities and exchange-disclosure tables |
| NSE Filings | Retained company filing table, including old direct routes |

AI Alerts, News, Bookmarks and Ask Research use cards or retained source documents rather than company tables. Investor/fund directories, source-health tables and financial metric/quarter series are not company lists. Source-document tables are preserved as published.

`scoreTable({companyMarket: true})` adds missing CMP and market-cap fields as a pair. A source-specific CMP/cap renderer is retained. `cmpLabel` explicitly identifies an existing current-price column; an unrelated deal price is never adopted. New fields join their counterpart in older saved column orders; subsequent user ordering wins.

Screens already owns a visible quote poller. Its `companyMarket.watchPrices: false` subscribes to that poller without starting another price check when thresholds or views repaint.

`company-market.js` shares the saved intraday capture and `company-quotes.json`, a small projection of the existing completed-session technicals. Both technicals writers merge the previous dated quote when a company fails or disappears, retaining failure/attempt provenance across reloads and deployments. The read-only route streams a fixed repository revision. No browser visit starts provider collection. Mounted tables check saved quotes on the existing 15-second cadence; the compact daily snapshot revalidates once a minute while visible and on returning after that interval, and healthy public cap/share references revalidate every fifteen minutes. Failed components retry at the minute cadence. Static/deployed fallbacks retain the repository-check failure; cap/share input failures are independent and remain labelled until their own successful read.

The existing daily public market-cap collector also saves the CMP already present in its screen/company-page responses, without more requests. These observations retain their own check time and publisher price label. Existing entries without a saved CMP remain unavailable until a normal scheduled capture supplies one. A source check time is never presented as a trade time, and a partial day/month label never supplies an inferred year.

ISIN, NSE symbol and BSE code determine joins; contradictory supplied identifiers withhold both values. Names and Finology display slugs do not imply a ticker. An unresolved or unlisted issuer shows a dash with an explanation. Exact BSE codes use a separate quote namespace, including numeric daily rows; BSE-only display symbols cannot borrow NSE prices. New market caps use Moneycontrol shares × the displayed CMP only when the share count has an actual per-company observation time within 24 hours and the same IST session as the quote. Its count time and quote time are disclosed. Legacy undated, old or mismatched counts use the captured public cap. New Moneycontrol entries record the actual share-count observation; the file's generation time never dates unchanged entries. Announcement caps retain their source figure so range filters and values continue to agree.

Source-specific company exports await pending market inputs, opt into the same missing-column rule and include provenance for new fields. Private export eligibility is checked again after that wait. Missing numbers export as blanks, not zero. Investor workspace subscriptions are disposed on panel transitions and close.

Mutual Fund Company Holdings also values the comparable net monthly share change at the displayed CMP, divided by 1,00,00,000, in the adjacent Net Volume (Crores) column. This signed estimate is not executed cash flow; the quote source/time and corporate-action caveat remain available. Missing comparisons or CMP withhold the value, and exports retain numeric crores. The insight's bold first line names the largest adding/reducing fund houses. New captures retain the leaders' reported AMC identities; older captures use a unique published AMC prefix or keep the full scheme name. Fund-house names do not classify a scheme as active or passive; exact scheme names remain in the detail.
