# Catalyst engine — how AI Recommendations are found

AI Recommendations is a list of companies where the filings, the latest results and the money flows
point the same way, read in each sector's own terms, sized against the company, with every claim
linked to its source. It is built once per capture on the runner and published as
`public/data/ai-catalysts.json`; the browser only reads it.

| Piece | File |
| --- | --- |
| Engine (pure, shared by runner and browser tests) | `public/js/data/catalyst-engine.js` |
| Sector playbooks (one editable table) | `public/js/data/catalyst-playbooks.js` |
| Build (reads committed captures, writes the file) | `scripts/build-catalyst-ideas.mjs` |
| Schedule and commit | `.github/workflows/catalyst-ideas-refresh.yml` |
| Reader | `public/js/data/ai-recommendations.js` |
| Page | `public/js/tabs/ai-recommendations.js` + the `.rx-*` block in `public/css/theme.css` |
| Tests | `scripts/verify-catalyst-engine.mjs`, `scripts/verify-recommendation-reader.mjs`, `scripts/verify-recommendations-ui.mjs` |

## Inputs — only what this repository already captures

- **Exchange filings**: `filing-capture/announcements/*.json` (≈156k BSE/NSE filings over ~14 months,
  per company), the latest BSE day capture, NSE day files, and the publisher-indexed titles. One
  copy per document (BSE GUID or URL); a BSE filing and its NSE twin are folded in the engine.
- **Results**: `earnings-live.json` (latest quarter, YoY revenue and profit, sign changes as words).
- **Disclosures**: `insider-trades.json` — promoter and director market trades, pledges, preferential
  allotments; bulk/block deals only where the counterparty is an institution or a tracked investor
  (HFT and broking desks are excluded).
- **Tracked investors**: `super-investors.json`, read through `deriveMoves` (the one classifier).
- **Broker calls**: `broker-reports.json`, only where a rating word was printed; targets/upsides as printed.
- **Con-call highlights**: `concall-scans.json`, the provider's own ▲/▼ markers (third-party analysis).
- **Price and identity**: `technicals.json`, `company-quotes.json`, `market-caps.json`, `exchange-deals.json`
  (security map), `mc-ticker-map.json`, `portfolio-companies.json`.
- **Sector**: `sector-kpis.json` (the desk's ontology, 41 groups). Unclassified companies get a group
  inferred from their industry name and are marked `sectorInferred`.

No network read, no model call, no credential beyond the repository token that commits the file.

## What a filing becomes

`classifyFiling()` reuses the shared readers (`categorize`, `announcementSignal`, `statedAmountsCr`,
`sourceStatement`) and adds the catalyst vocabulary in `CATALYSTS`:

- **Growth**: order win (sized; L1/LOA weaker; a company's own size band such as L&T's "(Major*)" is
  read as its lower bound and marked as a band), capacity commissioned, capacity expansion, regulatory
  approval, clean inspection, launch, network expansion, strategic deal, value unlocking (demergers),
  legal win, operations restored, business update with stated growth.
- **Smart money**: promoter buying (net of promoter-group selling; equal two-way trades cancel),
  promoter infusion, tracked-investor/institutional buying, broker BUY as printed, credit upgrade,
  capital return (buyback, bonus, special dividend).
- **Risk**: legal/tax action (sized against market cap; routine pendency notices discounted),
  governance (statutory auditor exit, fraud, results delay, CEO/CFO exit), default/insolvency,
  downgrade, adverse inspection (warning letter, OAI, import alert), operational disruption, order
  cancelled, promoter selling, pledge, investor exit, broker SELL, earnings decline.

Traps closed and asserted in `verify-catalyst-engine.mjs`: the LODR citation is removed before any rule
reads the text (so "SEBI" in boilerplate is not a SEBI action); a court/tax "order" is never business
won; an order's own scope ("supply and commissioning of a 660 MW unit") is not the company's capacity;
"cable fire safety" is not a fire; a SEBI warning letter is not an FDA one; a subsidiary's voluntary
liquidation is not distress; ESG ratings are not credit ratings; buying a stake in its own subsidiary
is not a deal; winning an insolvent business is an acquisition; two orders with different stated
amounts are never merged as duplicates; newspaper copies, certificates and news clarifications are
not events.

## Scoring

Per item: `base × variant weight × materiality × sector weight × recency`.

- **Materiality**: against the latest quarter's revenue first, market cap second, absolute size last.
  Legal amounts are read against market cap (5% of the company is very material; 0.1% is noise).
- **Sector weight**: `catalyst-playbooks.js`. A bank wins no orders (weight 0); pharma lives on
  approvals and inspections; capital goods on orders; chemicals/metals/cement on capacity.
- **Recency**: a per-type half-life (orders 75 days, capacity plans 90, demergers 120). Nothing older
  than 180 days counts. Earnings decay over 120 days from the result date.
- **One event once**: exchange twins, repeated updates on one project (same wording, same amount,
  within 21 days) and process filings (daily buyback reports, CIRP updates) collapse to one item.
- **Diminishing returns** within a type (the second order counts 60%, the third 42% …).

Pillars: Earnings (0–30), Catalysts (0–40), Smart money (0–20), Price (0–10) → **conviction**.
Risk is scored separately (0–100). **Net = conviction − 0.55 × risk − priced-in penalty**, where the
penalty applies only when the stock has already risen more than 25% since the lead catalyst.

Stance: **Opportunity** (net ≥ 26 and earnings + catalysts ≥ 14 — price strength alone never
qualifies), **Mixed** (strong evidence beside material risk), **Risk alert** (material risk, or a
severe flag such as an auditor exit, default or warning letter), **Watch** (holdings with weak
evidence; shown only in Portfolio/Watchlist and under All).

Universe covers companies with a verified market cap of at least ₹500 Cr (`CATALYST_MIN_MCAP_CR`);
every holding is screened regardless of size. Caps: 260 opportunities, 90 mixed, 140 risks, plus all
holdings.

## Honesty rules

1. No fact is invented: each item quotes its filing, result, disclosure or printed broker call with
   date and link. The thesis sentences are composed only from those facts.
2. No target price, probability or return forecast. Scores are evidence points.
3. Derived ratios (orders ÷ latest quarterly revenue, demand ÷ market cap, move since catalyst) are
   labelled as derived in the card tooltips and the export.
4. Risk is shown, never netted away silently: Mixed ideas carry their risk on the card.
5. "No risk found" is worded as what it is — no matching filing — never a clean governance opinion.

## Publication

`ai-catalysts.json` (version 2, `stage: catalyst-ideas`): `ideas[]` with stance, tier, conviction,
risk, net, pillars, headline, why, risks, lens, watch, KPIs in play (from the ontology), order
summary, result, technical summary, priced-in check and up to 14 evidence items; plus counts,
coverage, the input capture times and the catalyst vocabulary. The build writes only when the ideas
changed or the published copy is more than six hours old. The verified-filing foundation
publication (`ai-recommendations.json`, see `RECOMMENDATION-MODELS.md`) remains independent; where a
deployment installs it, its companies carry a "Verified filing" mark.

## Next steps

- Read the PDF of the top-ranked catalysts (order value, execution period, client) where the filing
  text has no number.
- A forward outcome ledger for catalyst ideas, like the foundation's, before any claim of an edge.
- QoQ and TTM context once the results feed carries more than one comparison.
