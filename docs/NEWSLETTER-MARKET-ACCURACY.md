# Newsletter market accuracy — 24 September 2026

The upstream Glow investigation and Sattva parity audit identified correct index levels with incorrect daily
changes. `readMarkets` requested five daily bars but subtracted Yahoo's
`meta.chartPreviousClose`, the reference at the beginning of that range. That also
affected global indices, currencies, commodities and yields.

Captured public-source fixtures from Glow supply these regression cases:

| Index | Level | NSE previous close | Daily points | Daily percent |
| --- | ---: | ---: | ---: | ---: |
| Nifty 50 | 23,446.80 | 23,329.00 | +117.80 | +0.50% |
| Nifty Bank | 56,548.90 | 56,215.55 | +333.35 | +0.59% |
| Nifty 500 | 22,935.10 | 22,794.20 | +140.90 | +0.62% |

## Source and comparison rules

`worker/newsletter-markets.mjs` owns quote validation. Yahoo comparisons require
the immediately preceding dated unadjusted daily bar in an ordered daily series.
The quote's session must be represented in that series. A null prior bar, missing
session, invalid value or conflicting explicit previous close withholds the
daily change. For Indian indices, the existing known exchange calendar also
checks the predecessor date. Unknown calendars are not certified. No range
reference, older non-null bar, opening price or adjusted close substitutes for it.

The captured `yahoo-nifty-missing-close.json` is an actual public-source response
retained by the upstream Glow investigation. Its 22 and 23 September daily closes are null.
A separate one-day/minute request returned `previousClose: 23414.3`, also different
from the captured NSE previous close. Switching to that field alone would not
establish accuracy. The fixture retains these missing bars; its expected result is
a dated level with no daily change until another valid source supplies one.

Indian indices also use the existing `UPSTOX_ACCESS_TOKEN` Worker secret. One bounded
V3 full-quote request reads all eight exact cash-index instrument keys, checked
against the public NSE/BSE instrument masters. The response must match both key
and its master trading symbol or index name. `prev_close_price` explicitly supplies
the previous trading session's close and must agree with last price minus
`net_change`. OHLC close may be the current session's close and is never used
as the previous-session reference. A valid last-trade time is required;
request/feed time alone cannot date an old index level. No browser credential,
new subscription, credential change or extra collection schedule is introduced.

The official NSE `allIndices` snapshot supplies seven NSE indices in one bounded,
unauthenticated request; Sensex is never substituted with an NSE instrument. Its
own timestamp, previous close, point change and percentage are validated. The
published percentage is retained only when consistent with the rounding interval
of its two-decimal levels (material for India VIX). The retained 23 September
snapshot records Nifty IT −0.87% and India VIX 10.29 / −6.41%, additional Yahoo
errors beyond the three screenshot comparisons. Both source fixtures are retained.
Blocked/unavailable exchange reads fall back without access-control workarounds.

A usable exchange row is preferred. If either independent provider corroborates
it, a third-provider outlier is recorded without hiding the corroborated exchange
figure. With no agreement, conflicting figures are withheld; an exchange-only row
is explicitly single source. Each usable primary row is compared with Yahoo's same-session row. Preceding
closes must agree within floating-point/quote-rounding tolerance: max(0.011,
0.0001% of the reference). Closing levels use the same tolerance; intraday prices
from different seconds are not compared. A prior-close disagreement withholds the
change; a closing-level disagreement withholds the level and changes. Never
average providers or combine one's level with the other's previous close.
Missing/invalid/stale primary rows fall back individually and say single source.
An unavailable cross-check does not claim verification. Provider authentication,
partial reads and failures appear in source coverage.

Every HTML, text and PDF row retains its full source date/time and provider, plus
single-source/cross-check status and any withheld-change reason. Earlier and
delayed observations stay labelled. Global quotes older than four days or still
preceding a provider session that opened more than 20 minutes ago are earlier
quotes, excluded from the headline summary; an intraday observation cannot become
a close just because the market shut. Section headings do not promise today's
close. Sattva has no macro-series store; an unavailable source cannot acquire a stored fallback. Stale or unverified rows are excluded from the headline glance.
Delivery summaries retain unavailable, unverified and conflict identities.

## Verification and limits

Run `node scripts/verify-newsletter-markets.mjs`, `verify-newsletter.mjs` and
`verify-newsletter-ui.mjs`. The first covers the customer figures, captured global
and incomplete Yahoo responses, session/date boundaries, identity validation,
partial/error/duplicate Upstox responses, credential isolation and HTML/text/PDF
output. It runs in the existing Verify workflow. The UI suite drives the real
newsletter routes, preview, PDF and delivery stubs locally.

Fixtures prove the validation behavior, not perpetual provider correctness or
production-token acceptance. Same-provider errors, exchange corrections and
missing upstream data remain possible. The correct failure mode is an explicit
gap, never a manufactured percentage. Existing delivered emails and saved PDFs
are historical records; this change does not resend or rewrite them. Normal
future builds receive the correction through the existing merge-triggered deploy.

References: [Upstox full quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
and [instrument identities](https://upstox.com/developer/api-documentation/instruments/).

## Additional source coverage

The public [BSE Indices Sensex page](https://www.bseindices.com/indices-details/code/16)
uses `AsiaIndicesGraphData` with index code 16 and the daily (`flag=1`) series.
The newsletter now reads this same public feed once, with an eight-second timeout,
a 256 KiB response cap and no credentials or redirects. Its `Scrip` must be exactly
`BSE SENSEX`. The chart's `PreClose` and `LatestVal` must be positive, and LatestVal
must agree with the last dated cash-session `value`. Pre-open `value1` observations
are never used. Dates must be ordered, unique and in one session; future points,
missing cash values and incoherent headers are rejected.

The captured 24 September response exposes why its header clock must not date a
quote: `LatestTime` still says 09:00:59 while the last cash point is 09:38:38.
The parser uses the point's full date/time in IST. At that point Sensex is 74,267.72
against 74,828.25, or −560.53 / −0.75%. BSE participates in the same exchange-first
reconciliation as NSE, including withholding unresolved disagreements. The upstream Glow PR reported all eight Indian indices during its own dated public-feed check; this port does not certify present source availability.

Upstox's [global instrument master](https://assets.upstox.com/market-quote/instruments/exchange/global.json.gz)
and [API announcement](https://upstox.com/developer/api-documentation/announcements/global-instruments/)
identify four exact additional cash benchmarks in this newsletter: `^GSPC`, `^DJI`,
`^N225` and `^HSI`. A separate four-key full-quote request prevents a global API
failure from invalidating the existing eight-key Indian request. No new token or
subscription is installed. The key, symbol, last-trade timestamp, previous close
and point-change arithmetic are checked for every row. Failed row identities and
reasons are retained in delivery summaries; customer outputs keep source coverage.

Global dates use the exchange timezone, including US daylight saving. The standard
cash-session close thresholds are 16:00 New York, 15:30 Tokyo and 16:10 Hong Kong
(after its closing auction). A preceding weekday quote becomes earlier once the
next ordinary session opens. This is conservative: unknown holidays and shortened
sessions are not certified as current closes. Upstox's documented 15-minute Nikkei
and Hang Seng delay stays visible. A delayed quote can fill an otherwise missing
comparison but never becomes a close or enters the headline glance.

`IXIX` in that master is US Tech 100, **not Nasdaq Composite**. Its Brent indicator
is also a different product from Yahoo's Brent futures contract. Neither is used
as a substitute. USD/INR feeds can have different daily fixing boundaries, so that
indicator is not silently interchanged either. Nasdaq Composite, Kospi, DXY,
USD/JPY, USD/INR and US 10-year yield therefore still depend on their existing
validated feeds. Broader coverage needs a source with those exact instruments,
dated previous closes and appropriate access; no source guarantees perfect data.

Session references: [NYSE](https://www.nyse.com/trade/trading-information),
[JPX](https://www.jpx.co.jp/english/equities/trading/domestic/01.html),
[HKEX](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market).

The market suite additionally exercises the actual BSE response, pre-open exclusion,
malformed and oversized replies, date rollover/DST, exact global identities,
independent batch failure, conflict handling and HTML/text/PDF provenance.
Indian close labels also require a known session calendar: unknown Muhurat hours
or future-year calendars cannot turn an intraday point into the next morning's
close merely because it occurred after the ordinary 15:30 cutoff.


Ported from Glow #1285 and #1291, retaining Sattva’s portfolio, branding, readable filing links, subscriber ledger and existing schedule. Validation is local with injected source responses; no production send or manual deployment is needed.
