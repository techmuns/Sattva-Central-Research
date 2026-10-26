# Investor newsletter: inbox reading and complete evidence

Implemented for the 26 October 2026 request to make the portfolio newsletter concise,
actionable and sustainable without losing information. This supersedes volume-driven
inline packing and the counts-only report fallback for **new GitHub-prepared editions**.
It preserves the strict publication window, existing schedules, providers and budgets.

## Reading contract

`newsletter-editorial.mjs` derives a reading layer from the complete brief; it never deletes
source rows. Corporate announcements, ownership disclosures, business developments and
large price moves appear as distinct events. Explicit reference pages without an estimate
revision, option chains, generic IPO guides/roundups, known wrong-entity matches and broker
authorship of research on other issuers stay in the complete report. Calendar-only notices
join the scheduled-calendar context. Unknown announcements stay eligible: an unread generic
filing must not disappear merely because its materiality cannot yet be assessed.

The explicit regression cases are Indian Bank versus South Indian Bank/HDFC's generic
"Indian bank" description; Lupin versus the Netflix title; City Union versus a civic union;
and Motilal Oswal as research author rather than researched issuer. A source reading that
cannot establish its issuer's connection cannot supply an investor summary. These guards
are not a universal entity-understanding guarantee; other unverified reporting remains
labelled. Related-entity reports explicitly leave parent exposure unconfirmed.

Risk/regulatory disclosures and consequential operating/capital developments lead; volume
of reporting does not raise priority. Importance is not positive/negative sentiment. In
particular, a meeting to consider a dividend is not a declaration or an automatic "Good".

The email gives a short factual description, an existing grounded AI note where available,
supported potential impact and material unknowns. Without an AI note, read document facts
can be shown as source facts. Unread headlines remain unverified leads. Existing grounded
news notes can appear in previews without another model request. Price context retains its
supported reason or explicit unknown state. All markets, upcoming calendar entries and
corporate-action dates fit with the first email where possible; an explicit count and link
to the complete tables replaces those supplements when necessary.

Saved NSE board-meeting XBRL fields supply a short factual notice when no grounded AI note
exists: meeting date, stated agenda, results period and dividend type where present. The
date comes from the read document, and consideration remains prospective. Revised notices
keep that status; cancelled notices, conflicting contexts or invalid dates cannot supply
this note. Administrative identifiers, enum dumps and trading-window flags are not investor
prose. Other source facts retain their semantic field labels where necessary, including
Yes/No conditions. This presentation change preserves the full saved extraction, version
identity and reading queue; it neither re-reads sources nor requests another model summary.
The email and PDF investment briefing use the same source note.

`newsletter-investor-email.mjs` preserves the original 640px paper, serif masthead and company
headings, double rules, indigo accents, lavender background and dark footer. Shared style
tokens prevent the compact view from drifting from the established newsletter. Each event
has one short description, supported impact and next unknown when available, and a direct
source link labelled Announcement or News report. Source URL length never changes that
destination to the newsletter PDF. Prefer an exact captured publisher alias over its Google
discovery wrapper; unresolved wrappers retain their specific captured report link, and missing
source links are explicit. Never substitute a publisher homepage or construct an article URL.
A grounded summary replaces the repeated headline. A short coverage note links to
the full diagnostics; reference and reading counters do not clutter every event.
`renderInvestorEmails` first packs detailed event descriptions, then, if necessary,
abbreviated descriptions. Long source URLs use stable short links on the newsletter origin,
as requested by the user on 26 October. Each opens the exact original article or filing with
one redirect; it never opens the newsletter PDF. Short original URLs remain direct. The
immutable mapping is inserted once in retained `newsletter_views` records (`source-<uuid>`),
survives preview replacement and encrypted master restarts, and is published with the edition.
The original full URL remains in source history and the full report. Before any provider
submission, verify every shortcut in that specific email against the deployed lookup endpoint
and its exact saved destination; a missing route, missing mapping or different target blocks
the send even if the PDF is available. This uses existing storage and no paid URL service.
Source reads use dedicated encrypted pages, independent of the report/PDF record pages.
The dedicated 16 KiB source head names at most 64 source directories; each selects a normally 12 KiB
source-only page. A single exceptional source record is capped at 32 KiB, never truncated.
Directory pages are bounded too. Identifiers and exact destinations remain in the retained
master and legacy record views, so existing emailed links and earlier prepared snapshots
keep working. Publication checks and the lookup API cap each request at five sources, with
a per-run cache of already verified immutable destinations. The sender also requires the
bounded-index format marker, so the older resource-heavy lookup cannot certify a send.
New source clicks and bulk checks never read the full report head or inflate a PDF page after
the indexed view publishes. Growing report history cannot increase the lookup header size.
If 220-character excerpts cannot fit, 140- and 100-character readings preserve every event,
company, exact source destination and original record within the same three-part limit.
Structured meeting notes retain every agenda, including later dividend proposals, without
character truncation. Nothing is
removed from the complete report to achieve this packing.
Compact rows share standard email CSS classes rather than repeating identical inline
styles; the colours, serif company names, rules and spacing remain unchanged. This leaves
room for source links and investor readings within the existing byte limits. See Gmail's
[CSS support](https://developers.google.com/workspace/gmail/design/css).
Automated daily "slides/climbs ... outperforms/underperforms competitors" templates remain
in the full report rather than becoming business developments. Explicit reasons, guidance
changes and other substantive price-related reports remain eligible.
Every distinct eligible event remains represented. The maximum is three bodies of
90,000 UTF-8 bytes; an unrepresentable edition fails before provider I/O rather than
returning a partial plan. The ordinary target is one email per morning/evening edition.

Every part links the same immutable PDF. Its cover counts developments and retained sources,
its investment briefing leads with the investor reading, and its complete source register
preserves original headlines, captured snippets, all links, available notes, reference records, prices,
tables and actual source checks. Old saved PDFs are not rewritten. Retained records outside
the printed publication window remain in history, not newly emailed as catch-up.

## Grouping, versions and acknowledgements

Exact document identity takes precedence over paraphrases produced by separate extractions.
The Bharat Parenteral voting-results, EGM-approval and earnings-call copies exposed this
ordering defect on 26 October. Matching ready document hashes cannot be vetoed by differently
worded extracted facts. Different ready hashes at a reused filing-document URL remain
separate versions. News retains its existing figure, stage and fact-conflict checks;
raw HTML changes alone can reflect page chrome and do not create an investor development.
Shared supporting attachments alone do not identify a filing copy.
An unread filing's own exact document URL can establish its copy within the existing one-hour
window; generic wording and a nearby timestamp alone cannot.

Explicit future board-meeting notices normalize the meeting date separately from publication
time. The Aurobindo 4 November NSE/BSE notices share one update despite 04-Nov and 04/11
formatting and one generic exchange wrapper. Different dates, financial periods, explicit
agendas, revised/cancelled notices and board outcomes remain separate without stronger evidence.
The detailed/read notice leads; a factual short meeting description preserves consideration
of results/dividend rather than implying approval or declaration. These are bounded event
rules, not a guarantee that every unread paraphrase is understood.

Exact same-publisher headlines are treated as copies only with matching article URLs or
matching captured article aliases,
subject to the existing time, figure, issuer, relationship and stage guards. Tracking-only
URL differences do not create new articles. A matching headline on a different unread source
cannot establish a copy. Semantic review or matching read document bytes can establish
copies across exchange timestamps. Generic subjects and time proximity alone cannot.
Changed amount, counterparty, date, status, conditions or ownership prevent unsafe merging.
Distinct CEAT loan-conversion/investment fixtures remain separate.

Semantic news checking runs after source attachment, packing whole companies into bounded
batches rather than admitting only the first 80 reports of an edition or wasting a request
on each small company. Each request retains its existing
80-report/96KB input limits. The old 24KB escaped source-register guard no longer applies:
long archived URLs and read facts do not consume the grouping prompt or compact inbox.
Complete headline/summary inputs still fit as a whole company or remain explicitly unchecked.
At most four batches are attempted per build, with the existing
configured news provider, cache and dollar admission control; no new service or fallback is
introduced. Partial/failed grouping retains all reports and its actual coverage count.

Document hashes or structured facts supply version
aliases in the existing acknowledged-item ledger. All participating versions must be known
before an event is treated as previously covered; unknown new evidence cannot be hidden by
an older member. Changed source bytes/facts create a new version. Headlines alone never
establish a previously delivered version: separate approvals or orders can share an identical
long title. The existing
ledger retains ordinary transport identities for ten days and event-version hashes durably,
independently of permanent source history and delivery-log pruning.
This is conservative copy suppression, not a claim that all paraphrases are understood.

The first accepted report-linked email acknowledges the complete verified report's source
identities. Later emails continue its reading layer. Before any provider submission the
GitHub outbox still verifies the exact PDF publication. A failed publication acknowledges
nothing. Frozen recovery bodies, RFC Message-IDs, recipients, confirmations and uncertain
outcomes remain unchanged. The six-part legacy gate, three-hour scheduled expiry and
historical-backlog refusal remain in force; no old incident is enrolled for replay.

## Source reading and cost

The existing encrypted GitHub SQLite queue gains a priority column in place, preserving
completed results and pending jobs. Publications in the last 72 hours lead background reads,
then importance and actual publication time set their order; late discovery does not make
an old risk disclosure current. The three-day reading priority accommodates ordinary weekends
without changing any newsletter eligibility window. Current consequential filings lead,
with one slot per bounded six-job batch reserved for the oldest due job. Foreground reads
prioritise the current edition. The batch size and provider allowances do not increase.
Read filing-document hashes reuse completed same-issuer/same-kind results with matching
policy versions; news keeps its existing article/headline/model/policy cache. Summary admission
checks readable evidence before spending its 40-item allowance,
so pending leaders cannot exclude a readable item later in the edition.

Known direct source links are preferred to publisher homepages. Legacy Google RSS addresses
can resolve locally from their encoded publisher address; opaque addresses may use at most
two explicit redirects. Google 429/503 refusals retain the normal transient retry backoff,
rather than the day-long unresolved-link delay. Every destination must pass the existing HTTPS publisher allow-list;
private addresses, credentials, unsupported destinations and Google interstitial bodies
cannot become article content. Unresolved or restricted links remain explicit pending states
with backoff. No paid crawler/search provider, new credential, paywall bypass, expanded news
search schedule or new Cloudflare processing/storage binding is introduced.
An in-place link-policy upgrade gives formerly unsupported pending links one ordinary retry;
later discoveries preserve their backoff and never reset a reading lease or completed job.

Source capture, document reading, grouping and answer availability remain distinct. The email
opens with partial source coverage, unread counts and unavailable AI notes where applicable.
A new render time cannot make an old or incomplete capture current. This change does not
certify exhaustive upstream collection, live OCR quality or statistical model accuracy.

## Validation

`verify-newsletter-investor.mjs` replays the customer's attribution/noise examples, exact
copies, corrected versions, acknowledged restarts, the forty-pending-before-readable case,
queue migration/priority/fairness, free wrapper resolution and private-target rejection.
It replays the actual Aurobindo/Bharat defects, long source links in both email modes, article
aliases, reused-URL corrections, unsafe/missing links and automated market templates.
The saved Aurobindo XBRL fixture also verifies readable date/agenda/period/dividend notes,
changed dates, cancelled/conflicting notices and preservation of the original extraction.
Retained-data verification checks both scheduled morning eligibility and the denser current
morning/evening preview windows. A 500-disclosure fixture exercises the shortest excerpts
with all source identities and full URLs retained. Backend preview failures log a bounded
error code so an inbox-budget failure can be distinguished from a source build failure.
It checks that 180 distinct material disclosures fit a few bounded emails with every event
and every report source identity retained. The existing content, event, market, price-reason,
PDF, source-link, delivery, encrypted GitHub and runtime checks remain required.

`verify-newsletter-multipart.mjs` explicitly freezes legacy multipart fixture bodies for its
SMTP/recovery regressions, while current-edition cases exercise the investor planner and
publication guard. Preview generation uses the same current reading layer with no email
or paid model calls. Local rendered HTML and PDF examples are retained under `.cache/` for
desktop/mobile and pagination inspection. Fixture replies prove contracts, not live model
accuracy. Normal merge-triggered deployment and scheduled preparation deliver the update;
manual production sends or recovery runs require separate explicit authorization.

## Document-first event consolidation — 26 October follow-up

See [the full-output audit](NEWSLETTER-OUTPUT-AUDIT-2026-10-26.md). Verified copies form
source documents before event grouping or summary generation. Normalized issuer/event/date/
period identity joins supported disclosures. Each writer item includes a document once,
with original versions and report links retained. Dated EGM corrections lead the original;
unordered changed versions remain explicitly unresolved. Source readings replace raw field
concatenation in the briefing; the full source register preserves the saved fields. The
original design and provider budgets are unchanged. Required CI replays 36 exact readings
from the customer's 202-page PDF through `verify-newsletter-output.mjs`.
