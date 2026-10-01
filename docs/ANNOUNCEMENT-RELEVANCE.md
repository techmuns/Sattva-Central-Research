# Investor relevance: Corporate Announcements, News and All Alerts (October 2026)

The desk asked for Corporate Announcements, News and All Alerts to read the way a buy-side analyst
reads: everything stays visible, the newest day comes first, and within a day the item that matters
most to an investor comes first. This document is the contract for the pieces that do that. Every
rule below is generic — no company, filing or headline is special-cased.

| Piece | Module | Runs |
| --- | --- | --- |
| Category master list | `public/js/data/announcement-categories.js` | everywhere (pure) |
| Relevance reading and order | `public/js/data/relevance.js`, `sector-affinity.js` | everywhere (pure) |
| Company size and sector | `public/js/data/company-profile.js`, `company-profiles.js` | runner, Worker, browser |
| Event stitching | `public/js/data/event-stitching.js` | runner (index), browser fallback |
| Shared feedback | `public/js/data/relevance-feedback-shared.js`, `relevance-feedback.js`, `worker/relevance-feedback*.mjs` | Worker object + browser |
| Announcement index | `public/js/data/announcement-index-*.js`, `scripts/build-announcement-index.mjs`, `worker/announcement-index*.mjs` | runner → Actions artifact → Worker object |
| News / All Alerts ordering | `public/js/data/surface-relevance.js` | browser |
| AI Read | `public/js/data/announcement-read-shared.js`, `worker/announcement-read*.mjs`, `public/js/ui/announcement-read.js` | Worker object (on click) |

## 1. Categories — one editable master list

`ANNOUNCEMENT_CATEGORY_LIST` is the whole vocabulary: 32 categories in 9 groups (Earnings & business
updates; Business & operations; Deals & structure; Capital & shareholder returns; Ownership;
Governance & management; Legal & regulatory; Meetings & investor calendar; Routine & other). Editing
the list — adding a category, renaming a label, changing a rule — is the only change needed; every
surface, filter, export and the index read it. Bump `CATEGORY_VERSION` with any rule change so the
next index build re-tags.

- A filing reads its exchange label first (BSE sub-category / NSE subject), then its subject and
  description; a news story reads its headline, and its standfirst only when the headline names no
  category. `not` patterns cancel a match where the words mean something else (a court order is not
  an order win; an order cancellation is not an order win).
- **Several tags per item** (at most `MAX_TAGS` = 4). Weak matches count only where nothing in the
  same group matched strongly, and stay marked weak.
- **Routine & administrative is exclusive** and ranks low; it is never hidden. **Other updates**
  is the fallback, never a judgement.
- Tags are topics, never directions: a tag never says good or bad.

Tags are shown on Corporate Announcements (column, filterable), News (under the headline) and All
Alerts (under the feed label). Category filtering exists only on Corporate Announcements.

## 2. The relevance reading

`relevanceReading(item, ctx)` returns `{ base, parts, keys, facts }`:

- **category** — the strongest tag's prior (weak tags at half weight), multiplied by company size and
  damped when the filing only announces that something *will* be considered (`PROSPECTIVE`) or is an
  update inside a process already under way (`PROCESS_UPDATE`);
- **impact** — the largest ₹ amount the item states, against the company's market cap
  (`impactLevel`: ≥10% very high … <0.2% tiny); without a market cap only the absolute size counts,
  more softly;
- **size** — mega / large / mid / small / micro / unknown (`SIZE_SCORE`, `SIZE_MULTIPLIER`); an
  unknown market cap is read like the smallest band, never as zero;
- **sector** — whether the desk's sector KPI ontology (`kpi-impact.js` TRIGGERS, recomputed into
  `sector-affinity.js` and asserted equal to it) says this kind of event moves this company's sector;
- **direction** — negative governance/credit/legal events weigh more than positive ones;
- **source** — All Alerts' own High importance, a news story's company match, and source reliability
  (`SOURCE_RELIABILITY`: exchange filings above publishers, publishers above social posts);
- **duplicate / repeat** — a later exchange copy, and a company's second and third filing of a day in
  the same category, are damped so one company cannot fill a day.

`keys` are the feature keys the shared feedback learns on (category, size band, sector group, kind,
feed, impact, direction, flags). No label (High/Medium/Low) is ever produced or printed.

`rankKey(day, score, time)` is one string that sorts **newest day first, then relevance, then time,
undated last** under a plain descending comparison.

## 3. Where the order is applied

- **Corporate Announcements** — every day, server-side (the index stores each filing's base reading;
  the query adds the current shared adjustment).
- **News and All Alerts** — in the browser (`surface-relevance.js`), within each of the last
  `RECENT_RELEVANCE_DAYS` (7) IST days, today included; an older day keeps its plain time order.
  A sort makes at most 120 ms of new readings per synchronous run; the rest are made in slices behind
  the paint and `onRelevanceChange` fires once when they settle, so the table re-sorts in place. A
  retained history of a few hundred thousand events is therefore never read inside one task. Exports
  make every reading in slices before they write the Categories column.

## 4. Event stitching — "N related filings"

`stitchEvents` joins filings of **one company** about **one underlying event**: same category family
(results cycle, capital raise, deal, management change, legal/regulatory, distress, ownership,
meeting, …), within the family's window between consecutive filings and its overall ceiling, and —
except for one-per-period families such as a quarter's results — sharing salient words. Routine
filings never join. Every filing stays its own row; the stitch only adds `event: { id, size, pos,
first, last }`. The Corporate Announcements row shows "N related filings" (expands inline); the AI
Read popup lists the whole event history.

## 5. The announcement index (Corporate Announcements' server path)

`scripts/build-announcement-index.mjs` loads the stream exactly as the tab used to (the browser's
own `corporate-announcements.js`, answered offline from the committed captures), tags, scores and
stitches every filing, and writes the `announcement-index` Actions artifact
(`.github/workflows/announcement-index-refresh.yml`, after each capture, on a schedule, on demand):

- `index.json` — `{ version: 1, contract: 'announcement-index-v1', builtAt, versions, counts, range,
  companies, dict, days: [{ day, rows, member, offset, length, hash, facets }], packs, captures, meta }`;
- `companies.json.gz` — one entry per company: identity, name, market cap and band, sector group;
- `packs/<YYYY-MM>.bin` (and `packs/undated.bin`) — one gzip segment per day, read by byte range.
  A row is a positional array (`ROW` in `announcement-index-shared.js`): id, time, company index,
  **the exchange's own subject, unchanged**, sub-category, category, sources, URLs, category masks,
  base relevance, impact, direction, flags, event fields, providers, summary, reference URL.

The Worker's `announcement-index:v1` object (`CaptureRegistry`, `ANNOUNCEMENT_INDEX_LIMITER`) reads the
newest artifact by byte range, keeps decoded days in a bounded LRU (48 MB), overlays NSE's live feed
every 2 minutes, and answers:

| Route | Answer |
| --- | --- |
| `POST /api/announcement-index/query` (same origin, ≤ 256 KB) | `{ ok, rows, total, companies, facets: { categories, bands }, offset, limit, nextOffset, index }` |
| `GET /api/announcement-index/event?id=&first=&last=` | every filing of one stitched event, oldest first (conditional, 5 min) |
| `GET /api/announcement-index/profiles` | company sizes and sectors for News and All Alerts (15 min) |
| `GET /api/announcement-index/status` | build time, contract, captures, live overlay state |

A query names `{ period, scope, companies[], categories[], mcap, q, company, offset, limit, sort }`.
`mcap` is a band id, `unknown`, or a custom `min-max` in ₹ crore. Per-day facet counts let a
Universe query with no search, no company, at most one category and a band (or no) market-cap filter
skip-scan to its page and decode only the days it returns; every other query scans the period's days.
Failures are named (`index-unavailable`, `rate-limited`, `invalid-request`), never an empty list.

**Fallback.** Where the index cannot be read (a static copy, a first build not yet run), the tab
answers the same question in the browser with the same code (`announcement-query-local.js`: the
runner's build in slices over the period on screen, the index's own selection one day per slice).
Related filings are then linked within the selected period only, and the provenance says so.

## 6. Shared feedback — one preference for the whole desk

Corporate Announcements and All Alerts ask **Important / Not important** (with an optional
**Why?**) after an item is opened; News keeps its click-to-article behaviour and offers the same
controls behind a small ⋯ beside each story. Every vote goes to the `relevance-feedback:v1` object:

| Route | |
| --- | --- |
| `POST /api/relevance/feedback` (same origin, ≤ 16 KB, `RELEVANCE_FEEDBACK_LIMITER`) | `{ surface, vote: important \| not-important \| clear, itemKey, eventKey?, device, features[], why?, label?, company?, categories[] }` |
| `GET /api/relevance/model` | the aggregated model, ETag = its revision |
| `GET /api/relevance/mine?device=` | this browser's own votes, so the controls show what it chose |

One vote per browser per item (a later vote replaces it; `clear` withdraws it); `device` is a random
id, and no name, address or account travels. The model is smoothed log-odds per feature key, global
and per surface (`RATE`, `KEY_CAP`, `SHRINK`), plus a capped direct nudge for the item voted on and
half of it for the rest of its stitched event. It adjusts the order within a day on all three
surfaces; it never hides an item. A vote that cannot reach the server waits in this browser's outbox
(and already moves the item here) until it can be sent. The store holds at most 50,000 votes.

## 7. AI Read — Corporate Announcements only, on request

Nothing is summarised in the list. Clicking a filing opens the AI Read popup: the Worker's
`announcement-read:v1` object fetches the filing **from the exchange only** (BSE/NSE hosts), reads
the whole document (PDF pages as a document block, XBRL facts, or the HTML text) with Claude on
Bedrock (`CLAUDE_KEY`), and stores the reading per document identity so the next reader pays
nothing. Concurrent requests for one document share one read. The popup always has the same five
sections — **What happened**, **Key details**, **Why it matters**, **Investment impact**, **Related
event history** — then **Source** and **Open Original Filing**. Limits: 150 new readings a day
across all readers, 3 attempts per document with backoff, no investment advice, figures only as the
filing states them. A failure is named in words and the original filing link always remains.
