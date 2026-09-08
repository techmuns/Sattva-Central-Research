# BSE portfolio delivery audit — 8 September 2026

Read-only production inspection at approximately 10:30–10:45 IST. No capture was dispatched,
restarted or manually published. Counts below describe the inspected snapshot, not a permanent
completeness guarantee.

## Measured delivery

- The most recently verified active portfolio contained 118 holding lines, checked at
  `2026-09-07T22:58:13.678Z`. Two warrant lines refer to equity issuers already in the portfolio.
  A read-only live Family check at `2026-09-08T05:27:29.025Z` confirmed the same revision and
  holding membership, with no additions or removals.
- The deployed identity directory mapped 110 distinct portfolio issuers to BSE codes.
- Direct, fully paginated BSE company queries for **every one of those 110 issuers** covered
  **6–7 September 2026**. All queries succeeded: 35 filings across 23 issuers, with 87 verified
  empty results. All 35 filings were present in published dashboard data.
- A separate Chromium check loaded the **deployed corporate-announcement modules and static
  captures**, applied the active portfolio, and waited for retained history. It found 11,044
  portfolio announcements, including **223 BSE rows across 73 issuers** and 11 combined BSE/NSE
  rows. All 35 comparison filings survived the actual browser scope filter. Archive loading
  completed without errors; there were no browser runtime errors. APIs, external requests and
  writes were blocked, so this measures public captured delivery rather than live NSE availability.
- The market-wide BSE capture was checked at `2026-09-08T04:41:21.717Z`, with no failed categories
  or pagination shortfalls. Its configured category inventory is still explicitly unverified.

A count of companies with rows is not the capture denominator: an issuer with a successful empty
source response should not acquire an invented announcement just to appear in the table count.

## Gaps and corrections

**Company-history recovery was skipped.** The last company capture completed at
`2026-09-07T23:18:12.452Z`, before the direct-BSE change was merged. Only the previously verified
KISSHT seed had a BSE checkpoint. The later green trade workflow runs skipped company capture
because eligibility required one exact cron expression; watchdog dispatches could never recover it.
`GET /api/filings-health` correctly reported overdue company capture, registration and portfolio
checks. The workflow now checks the latest branch checkpoint on every run, regardless of trigger,
and collects when its two-hour interval is due or the checkpoint is missing/invalid/interrupted.

**Suspended issuers were excluded from identity discovery.** The directory request selected only
active securities. BSE's [official company directory](https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=533400&industry=&segment=Equity&status=)
identifies Future Consumer as `INE220J01025`, code `533400`, status `Suspended`. A direct read for
9 August–8 September returned four filings, dated 14, 18, 20 and 26 August; its published company
archive was unavailable and the authenticated provider checkpoint reported HTTP 404.

The directory now includes all trading statuses. Applying the complete official response locally
resolved **111 distinct BSE issuers** in the active portfolio, adding Future Consumer without
changing any previously resolved portfolio BSE code. Five other issuers have no BSE code in this
directory; their existing NSE/company-source identities remain registered. Older BSE codes and
symbols sharing the same ISIN remain aliases, while active codes take precedence for collection.

Directory validation rejects missing trading-status groups and loss of previously verified codes
before publication. Historical filing codes remain unchanged on the source rows. A local comparison
against the real saved TradingView checkpoints found no target losses after applying the expanded
directory: Future Consumer retains its successful NSE target while adding BSE coverage. Company
eligibility is evaluated after the trade lane so elapsed collection time or a trade failure cannot
silently suppress due company work.

**A less-specific duplicate could erase a portfolio checkpoint.** A read-only follow-up at
`2026-09-08T06:27:18.439Z` found that normal collection had published a run completed at
`2026-09-08T05:25:40.689Z`. All 110 mapped portfolio issuers now had BSE checkpoints, 109 had
successful BSE checks and 108 had recent-period checks in that run. KISSHT retained its earlier
successful checkpoint; Ashika had not been attempted. Ashika's portfolio ISIN resolved to
`ASHIKAG` / `543766`, but an unresolved universe row reused the storage ticker `ASHIKA` under
a different identity key. That later row reset the query ticker and priority every run. Scope
construction now retains the verified portfolio identity for such less-specific duplicates;
explicitly conflicting issuers sharing a storage ticker fail before capture. A local check of
the real scope returned 599 companies with no duplicate storage tickers. The regression also
checks that the resolved source symbol, BSE code, priority and successful watermark survive
a subsequent run. This correction still awaits normal production collection.

## Verification and remaining limits

Local regressions cover overdue dispatch recovery, interrupted/corrupt/future checkpoints,
suspended issuers, current-versus-historical codes, portfolio additions, registration, archive
retention, browser source merging and automatic refresh behavior. The recovery fix does not
advance any source watermark or manufacture successful checks.

Normal future directory/capture runs must adopt the new identities and populate their BSE
checkpoints. The four older Future Consumer filings and the broader company backfill remain
pending until successfully captured and published. The two-day comparison does not establish
an exhaustive historical archive, and upstream omissions or unavailable sources remain possible.
