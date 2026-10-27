# Shared newsletter logic — Glow and Sattva

The 27 October 2026 Sattva port includes Glow's complete concise-newsletter changes through
PR #1464, not only its final correction. Shared code follows the same document-first and
issuer/event/date/period matching rules, one final reading, immutable exact source shortcuts,
three-part inbox packing, source-register preservation and correction safeguards.
The original 36 PDF examples and the later native investment/notice fixtures are mandatory CI
checks in both repositories. Fixtures are public-source evidence, not either family's portfolio.

`NEWSLETTER-SHARED-SOURCE.json` locks normalized shared modules and fixtures. CI refuses a local
source/lock mismatch. `node scripts/verify-newsletter-parity.mjs` checks the local contract;
setting `NEWSLETTER_PEER_ROOT` to the other checkout verifies the same lock against both.
Normalization permits only known deployment names, origins, filename prefixes and bot names.
It does not normalize event logic, source URLs, amounts, collection limits or portfolio data.

For future shared newsletter fixes, implement in **Sattva first**, run the common regressions,
update the lock and port that same source/lock to Glow. Glow's existing `Sync from Sattva`
workflow checks every six hours and opens a three-way template PR, preserving Glow-owned paths.
Those PRs still require CI and review before merge. The workflow does not auto-merge, and this
lock is not a claim that future cross-repository changes are instantly synchronized. A Glow-first
emergency fix must include the Sattva counterpart before the work is considered finished.

Keep deployment identity, branding, portfolios, quantities, subscriptions, credentials, saved
state and production schedules separate. Sattva's reviewed attribution and private-book isolation
remain tested. No new lookup provider, spending allowance, manual production run or email send
is introduced by this port. Follow the existing automatic deployment and processing pipeline,
then verify the published prepared editions and exact link destinations read-only.
