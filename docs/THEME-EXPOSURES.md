# Indirect theme exposure on AI Alerts (built on Glow 28 October 2026, ported to Sattva 29 October 2026)

> **On Sattva:** the measurements and holdings named below (OneSource, Glenmark, "the book") are
> Glow's, from where this was built. None of the mapped companies is in Sattva's book on
> 29 October 2026, so the copies appear under Universe and Watchlist. Add a Sattva book company
> only with a captured source that states its exposure.

The desk's ask: Eli Lilly receiving an EU recommendation for an oral GLP-1 pill bears on OneSource,
which makes injectable GLP-1 pens, and on the Indian generic semaglutide sellers. Nothing on the
dashboard connected them, because every rule that puts a story on a company's card requires the
story to name the company. Those rules stay. This adds a third relationship beside "names the
company" and "names a reviewed related entity": **exposed through a theme**.

`public/js/data/theme-exposures.js` is the whole feature: the reviewed map, the headline match and
the labelled copies. `scripts/verify-theme-exposures.mjs` is the offline test.

## Phase one: what it does

1. **A reviewed map.** A theme names its terms (molecules, brands, the drug class), the originators
   and challengers whose developments move it, the stages that make a story a development
   (regulatory decision, launch, pricing, trial result, patent ruling, supply), the market
   segments (oral, injectable, generic) and how each segment bears on another. Each exposed company
   names its segment, its role in the source's words, and **the captured story that states it**.
2. **A headline match.** A market-wide story qualifies when its headline names the theme and either
   a named originator or peer, or a development in a named segment. Commentary on the theme alone,
   demand-side stories (beer, snacks, beauty), crime and lifestyle stories do not qualify.
3. **A labelled copy per exposed company**, made in the alert assembly beside the portfolio
   discovery mapping and before scope. A narrowed scope therefore admits a copy exactly when its
   company is in that scope. The original story is unchanged and stays in Universe.
4. **AI Alerts takes decisive copies only.** One decisive copy, published today, on a book
   company scores exactly `MIN_SCORE` (30 + 6 + 16 + 12 = 64). That surfaces the company that day;
   the next day the score falls below the line. A copy can never make a card Must see on its own.
   Several publishers' accounts of one development fold to one row. The fold key is the theme, the
   day, the named company and the kind of development (the first stage the headline names), so
   Lilly's trial readout and Lilly's approval on the same day stay two rows. Of the folded
   accounts, the one whose read-across is most specific is kept. Low-importance copies stay out
   of cards entirely. A card's timeline shows every record it holds, and before this rule theme
   commentary took 6 of the 14 rows on OneSource's card.

   The row is tagged INDIRECT and states the read-across, with a *Why mapped* link to the source
   that states the company's exposure. A card led by a copy says so first, using
   `Indirect (GLP-1): <headline>. <read-across>`, with the kicker *Indirect* and the badge
   *Indirect exposure*. Where no reviewed segment pair applies, the read-across states the
   company's own exposure instead. The AI event-type filter offers *Indirect exposure*.
   **Compact**, the default view, tags the row *Indirect · GLP-1* and writes the headline followed
   by the read-across. The company's own material evidence always leads its Compact row ahead of an
   indirect story. Another company's results story is never folded into this company's result row.
   The view's one-story-one-row rule still applies, so a story leading OneSource's row does not
   lead Glenmark's too.
5. **All Alerts** shows each copy under Market news on the exposed company, labelled
   *Indirect · GLP-1 exposure*. Its detail line states that the story does not name the company,
   gives the exposure and its source, and gives the read-across.

Measured on the shipped captures (28 October 2026): **12 of 33,343** market-wide stories bear on
the GLP-1 theme and **4** are decisive. They fall on two days in two months. Glenmark is the book's
mapped holding. OneSource left the book in the 28 October statement refresh; it stays mapped and
reaches Watchlist and Universe like every other exposure.

## The rules

- **An exposure needs a cited source.** Gland Pharma and Biocon are in the book and plausible.
  Neither has a captured source stating a GLP-1 exposure, so neither is mapped. VBL's demand-side
  exposure through PepsiCo is the same case. To add a company, add its evidence.
- **Only the headline promotes** (`news-keywords.js` rule 0).
- **A story that names the company is its own news.** A company named in the headline, or one the
  portfolio discovery mapping already attributed the story to, gets no copy.
- **No direction.** Copies are neutral. A read-across is a reviewed statement of a mechanism
  ("a potential substitute", "could compete", "bears on"). It is never a measured or predicted
  effect, and the suite refuses verdict words in it.
- **Indirect is never direct.** A copy carries `attribution.status: 'theme'` and
  `aiEligible: false`. `newsCanSupportAI` refuses it, so it cannot corroborate, set a card's
  direction, fire a confluence pattern, keep a card for the review window, name a KPI or a driver,
  or count as the company's news. `storyRecord` refuses it, so it is **never sent for story
  grouping, which is a model call**, and it does not mark the page *Ungrouped*. The publisher dedupe
  leaves it beside the company's own report of the same article. The ranking dedupe folds a
  syndicated headline, so it appears on a card once.
- **Copies are derived readings, not source records.** A feed's `sourceCount` is taken before
  them.

## The precomputed pool

The pool carries market-wide source events, and the copies are made in the browser's assembly. So
the complete pool and the live path build the same copies. **The portfolio slice of the AI pool
keeps a market-wide story only when it can matter to the book.** It now also keeps a story that
bears on a book company through a theme (`bearsOnBook` in `alert-pool-projection.js`). Its
signature moved to `portfolio-pool-v2` and carries `themeSignature()`, so two kinds of slice are
refused and the reader falls back to the complete AI pool until the next build:

- a slice built before this change;
- a slice built before an edit to any theme.

The suite builds a pool and asserts that the slice and the complete pool assemble identical copies
and counts.

## Adding a theme or an exposure

Add an entry to `THEMES` (or to a theme's `exposures`). Give each exposure its segments, its role
and at least one evidence item, each with an https link, a date, the publisher and the headline.
Then:

```bash
node scripts/verify-theme-exposures.mjs
```

The suite checks:

- every exposure resolves to a tracked company;
- a book company's ISIN is the book's;
- every read-across names real segments and carries no verdict;
- the funnel over the shipped captures stays under half a percent.

## Not in phase one

- **Theme-axis collection.** Phase one reads only the market-wide publisher captures. A GLP-1
  story that reached us only through a per-company search (for example *"Novo's semaglutide
  protection weakens after European ruling"*, filed under Glenmark's search) is not mapped. Such
  rows are uncertain matches and are not in the AI pool, so mapping them would make the pool and
  live paths disagree. Phase two adds theme searches and the regulators' own feeds.
- **A model reading of cause and effect.** Phase three: a bounded, budgeted, stored model reading
  of the mechanism and a possible headwind or tailwind, run only on the stories this match selects,
  never on render or scroll.
