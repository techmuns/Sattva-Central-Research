# X Chatter: company searches for the portfolio

The **Public Chatter → Coverage | X Chatter | Not in coverage** navigation adds a company-search
feed alongside the forum coverage views. Publisher accounts in News remain a separate use case.
Every card identifies **X / Twitter**, the author and handle, the post date (including year, IST),
the company query it matched, attached media and the original post. These are unverified social
posts, not company disclosures or dashboard-written summaries. Images are shown as attachments;
the system does not invent a verified fact from an image or automatically OCR/summarise it.

The feature ships **disabled**, with a zero read allowance and no selected companies. There are
no sample posts in the shipped data and no paid X requests on page load, refresh, search or paging.
Until configured, the tab shows every holding and links to date-bounded manual Latest/Top searches.

## Recommended workflow

- Use the official X API with the application's customer-facing use case declared to X and the
  appropriate access/licence. A provider is an alternative only if its licence expressly permits
  this use and display; “scraping API” is not evidence of permission.
- Start with 5–10 representative companies. After inspecting relevance, coverage gaps and the
  developer console's actual spend, extend the allowlist to the full portfolio.
- The starting collection is up to **20 recent results per company, every 12 hours**, from a
  rolling seven-day search. Show the latest 24 hours first, with three-day/seven-day filters.
  A selected company starts with ten visible posts and a second page; the portfolio feed pages 50.
- Search company names, known aliases and explicit ticker hashtags/cashtags. Do not require the
  word “news”: posts about capacity, orders or filings may omit it. Exclude retweets and deduplicate
  by post ID. Search matches still need human checking, especially short or common company names.
- Treat the sample as a triage list. High-volume/event-driven companies can exceed 20 results;
  the UI flags the API's next-page token and partial responses. Broader capture, faster checks or
  archive searches need a separately budgeted change. No finite top-ten sample is exhaustive.
- Review the original and company/exchange filings before promoting a social claim into research.
  A recent post can refer to an old event. API relevance ordering is not the same promise as the
  personalised “Top” tab on the X website.

The supplied Jayaswal Neco screenshot illustrates why dates matter: its Top result is dated
29 March 2022. That result would not enter this seven-day feed. Sterlite Technologies was an
example search in the screenshots, not an entry in the 142-line committed portfolio inspected
on 4 September 2026; it is not silently added as a holding.

## Cost assumptions, checked 4 September 2026

X lists post reads at **USD 0.005 per resource**. Author/user reads (USD 0.010) and media reads
(USD 0.005) are additional; this implementation requests author and media expansions. The
developer console is authoritative for charges and access. Daily deduplication can reduce cost,
but X describes it as a soft guarantee and its window resets at UTC midnight.

| Collection ceiling | Post-only arithmetic over 30 days | Post-only estimate |
| --- | --- | ---: |
| 10-company pilot, 20 posts, twice daily | 10 × 20 × 2 × 30 × $0.005 | $60/month |
| 142 holdings, 10 posts, once daily | 142 × 10 × 1 × 30 × $0.005 | $213/month |
| 142 holdings, 20 posts, twice daily | 142 × 20 × 2 × 30 × $0.005 | $852/month |

These are not all-in bills or guaranteed limits. Sparse companies return fewer posts, duplicate
issuer lines can share a query, daily deduplication can help, and author/media resources increase
the bill. Set **both** the X console's currency spending limit and this collector's daily post-slot
limit. The latter reserves the maximum results *before* each request, including failed/uncertain
requests, so it is deliberately conservative; it is not dollar accounting.

## Setup after an explicitly approved deployment

No browser password or login cookie is needed for this collector. Being signed in at x.com does
not itself create API access. The earlier cookie-based News collector is a prototype and is not
recommended as the production route for customer monitoring. This feature neither starts it nor
reuses its credentials.

1. Open the [X Developer Console](https://console.x.com/). Create an application and accurately
   describe company monitoring, storage, display and customer access. Confirm the permitted use
   and access level with X; do not assume one app's plan permits unrestricted redistribution.
2. In the console, configure prepaid credits and a spending limit you have approved. Keep account
   balance alerts enabled. Do not purchase credits or enable collection merely to test the UI.
3. In the app's **Keys and tokens** area, obtain the app Bearer Token. Keep it out of chat, GitHub
   source files and browser code.
4. In Cloudflare: **Workers & Pages → sattva-central-research → Settings → Variables and Secrets**,
   add a secret named `X_BEARER_TOKEN`. Add a separate random 32+ character secret named
   `X_CHATTER_OPERATOR_TOKEN` for the operations endpoint. Use distinct values; the X token is
   never an operator token. The dashboard itself never needs either secret.
5. Protect the customer deployment and this feed with the application's approved access controls
   (for example Cloudflare Access), including alternate Worker/preview hostnames. This code's
   read endpoint is a same-origin UI endpoint, **not an authentication layer**. Do not make a paid
   licensed dataset publicly redistributable. Operator writes require their own secret even when
   a reader has a Munshot session; an arbitrary bearer token is not accepted as an operator.
6. Configure the non-secret values in `wrangler.jsonc` for the approved environment and review
   them in a PR. These checked-in defaults override ad-hoc dashboard values on later deploys:

   | Variable | Default | Operator choice |
   | --- | --- | --- |
   | `X_CHATTER_ENABLED` | `false` | `true` only after approval/setup |
   | `X_CHATTER_COMPANIES` | empty | Comma-separated portfolio ISINs/tickers for a pilot; `all` for the book |
   | `X_CHATTER_DAILY_POST_LIMIT` | `0` | A positive daily reservation cap; 400 permits two 20-post checks for 10 distinct company queries |
   | `X_CHATTER_POSTS_PER_COMPANY` | `20` | 10–20 |
   | `X_CHATTER_INTERVAL_HOURS` | `12` | 1–24; a shorter interval needs a revised spend calculation |

7. An authorised operator starts the collector using `POST /api/x-chatter/admin` with JSON
   `{"action":"start"}` and `Authorization: Bearer <operator secret>`, supplied securely from a
   secret manager. Do not put real values in shell arguments/history. The route loads the
   committed portfolio from the ASSETS binding; the browser cannot submit arbitrary paid queries.
8. Confirm the selected companies' capture times, gaps and actual console usage. Only then consider
   extending the pilot. Activation, merge and production deployment each require the user's
   explicit authorisation under this repository's workflow.

## Operations and data lifecycle

- One SQLite-backed Durable Object coordinates this deployed portfolio. It reserves slots before
  reads, serialises collection, persists the cursor and schedules one company query per alarm.
  There is no additional Cloudflare cron trigger. Multiple viewers share the same capture.
- `GET /api/x-chatter` filters and pages cached data only. Query parameters: `company`, `keys`
  (current device's portfolio keys), `q`, `hours` (up to 168), `offset`, `limit` (up to 50).
  Responses and browser fetches use `no-store`. X text is not added to IndexedDB, static JSON,
  public GitHub artifacts, bulk text exports, LLM context or a training corpus.
- Collection reads a fresh bounded seven-day sample each cycle instead of accumulating immutable
  copies using only `since_id`. Newly returned text replaces the previous company sample. This
  costs repeated reads but avoids retaining an older edited/deleted post indefinitely. It does
  **not** claim full pagination, continuous streaming or complete event coverage.
- Every successful company capture expires after 24 hours. Expired bodies are purged on reads
  and alarms, including while paused by an access failure. Failed reads preserve only an unexpired
  prior capture and retain the failure status. An unread search never becomes “no matches”.
- A removal notice is handled by the protected admin route with `{"action":"remove","ids":["…"]}`.
  This removes stored posts immediately and tombstones their IDs for eight days, beyond the recent
  search window. Known edit-history IDs are checked too. Operators must monitor and promptly act
  on X/rightsholder deletion or restriction notices; the cache TTL alone does not satisfy every
  possible obligation. Existing open views recheck the cache every minute.
- `{"action":"pause"}` stops collection and clears stored company bodies, including an in-flight
  result. Reservations already spent are retained. Resume with `start`. After a committed portfolio
  update, use an approved pause/start to reload the book; device-only additions remain visibly
  uncollected until they are in the configured server book. No browser action expands paid scope.
- 401/402/403 or rejected requests stop the walk for operator attention. 429 honours reset and
  Retry-After; temporary failures back off. Reservations are not refunded when delivery is uncertain.
  A failed company is retried on the next cycle, not through aggressive request loops. Long waits
  still schedule cache cleanup. Rate limits and service terms also apply to official API users.
- The collector is for a single configured portfolio. A future multi-customer service needs
  separate authenticated tenant routing and portfolio objects; accepting a browser-provided tenant
  ID or sharing this fixed object across unrelated customer books would be incorrect.

## Sources

- [X automation rules](https://help.x.com/en/rules-and-policies/x-automation): website scripting
  outside the API is prohibited; no route can promise immunity from account restrictions.
- [X Developer Policy](https://docs.x.com/developer-terms/policy): permitted use, attribution,
  content currency, removal and redistribution obligations.
- [X pricing](https://docs.x.com/x-api/getting-started/pricing) and
  [usage and billing](https://docs.x.com/x-api/fundamentals/post-cap): resource rates, credits,
  spending controls and daily deduplication.
- [Recent Search reference](https://docs.x.com/x-api/posts/search-recent-posts) and
  [Recent Search quickstart](https://docs.x.com/x-api/posts/search/quickstart/recent-search):
  endpoint, seven-day window, limits, query operators, fields and Bearer Token.
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) and
  [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Local verification

`node --test scripts/verify-x-chatter.mjs` exercises the API adapter and collection engine with
offline responses. `scripts/verify-x-chatter-ui.mjs` drives the actual UI against a local static
server, intercepting the portfolio and X endpoint with labelled fixtures and blocking all external
network calls. It accepts the same `PLAYWRIGHT_ROOT` and `CHROME_PATH` variables as the repository's
other browser checks. `npx wrangler@4 dev --local` exercises the real SQLite binding without remote
resources. Do not use a production collector run as a test.
