# Private Markets Intelligence

A separate weekly newsletter, requested 21 October 2026. The fixed clock is
Monday **09:00 Asia/Kolkata** (03:30 UTC). It uses each desk's existing active
newsletter recipient list, including later additions/removals, without altering
morning/evening settings, claims, reported items or saved PDFs. Unsubscribing
from the shared list stops both newsletters. No immediate production test send
is part of activation.

The existing GitHub newsletter processor and serialized account mutex own this
edition. A dedicated Monday 03:30 UTC wake targets 09:00 IST; the five-minute wake
and independent collector-completion recovery are retained. A newly due Monday boundary bypasses recent-check coalescing.
GitHub schedules are best effort; delays beyond three hours are recorded as
missed, with pending late arrivals/corrections retained for a later edition.
No browser visit is required. Launching midweek does not resend an earlier Monday.

The whole-universe section covers the prior Monday 09:00 through this Monday
09:00, plus captured late arrivals/corrections. Initial old history is a baseline,
not a mass email. Original dates, round, amount, sector, business model, investors,
lead investor, footnotes and links survive. Only identical complete sets of
reported fields share a row, retaining all source links/observation identities;
these are not verified transaction totals. No currency aggregation or AI is used.
Source check, capture and publication times remain separate, with stale, partial,
failed and cooldown states explicit. Inc42 public table coverage is not an
exhaustive VC/PE universe. Funding collection pacing/budgets are unchanged.

The invested-funds section matches the desk's own My Managers roster. Full-name
or curated public house-name spellings use word boundaries, never fuzzy issuer
matching. A house match explicitly leaves the specific vehicle unconfirmed.
Unnamed investors and unrecognized aliases can prevent matches. A failed roster
read says unavailable rather than zero investments. Fund names/relationships,
recipient bodies, frozen plans and claims remain in the existing encrypted GitHub
newsletter checkpoint, never plaintext public artifacts. Preview requires the
reader's verified Munshot identity and current active subscription; no send API
or model call is exposed for the weekly edition.

Each complete email stays below 90,000 UTF-8 HTML bytes, split at whole funding
observations with both sections and source coverage. Preview loads all parts.
Delivery is sequential and paced one second apart. Frozen claims are published
and acknowledged before each external request, and recipient membership is checked
again immediately before sending. Confirmed 429 responses wait 30/60 minutes
and have at most three attempts; uncertain acceptance/interruption never resends
automatically. Later parts require acknowledgement of the root and share its thread.
Uncertain observations are quarantined by identity and content hash across future
editions, with the frozen claim retained for reconciliation. A roster outage keeps
separate matching work after the universe section is delivered; recovered matches
appear in a later fund section with a recovery label. Provider holds also pause
the public newsletter timer/retry paths sharing that sender; checks and retained
history continue. Future source clocks over ten minutes ahead are flagged stale.
The sender's existing credential/provider is reused; no additional paid search,
model service, runner or Cloudflare background work is introduced.

Offline checks: `node scripts/verify-private-markets-intelligence.mjs`, existing
newsletter GitHub/scheduling/reading/delivery suites, funding capture tests and the
navigation/returning-session UI checks. Production activation is through normal
PR merges and automatic deployment; a prepared preview/status does not prove a
scheduled provider acceptance or inbox receipt.

Sattva reads names-only funds from the authenticated Family holdings export
(`?include=funds`), using the same complete private-workbook parser and source
precedence as My Managers. No capital figures or raw sheets cross this interface.
