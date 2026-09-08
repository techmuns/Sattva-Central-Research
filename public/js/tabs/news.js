// tabs/news.js — recent news for the companies in scope.
//
// IT LOADS ON ITS OWN, AND IT DID NOT USED TO. This tab once opened on a company picker: the news
// upstream is a per-company SEARCH with no date index to flip to (announcements had one and moved
// to it), so a live walk of the universe is 603 requests against a sixty-a-minute cap, and asking
// the reader to name companies was the honest way to spend a budget that could not cover everyone.
//
// What changed is not the budget but where the rows come from. `scripts/scrape-filings.mjs` already
// walks THE BOOK FIRST on a schedule and commits the result, so the rows a scoped view needs are in
// `public/data/news.json` and cost one conditional GET — the same deal Corp Announcements and
// Insider Trades get. Measured on the shipped capture: all 123 book tickers covered, 1,217 articles,
// no failures. Making the reader pick first was spending their attention to avoid a cost that had
// already been paid.
//
// The on-demand rule is intact, which is the part worth checking if you touch this: NOTHING WALKS
// ON A PAGE LOAD. The snapshot paints, the strip says how many companies the capture has not
// checked since, and the header's Refresh button is still the only thing that sends a request per
// company.
//
// The articles are somebody else's and stay that way: the headline, the outlet and the date are
// reproduced, the article is linked, and nothing is summarised into our own words. See the header
// of tabs/filings-tab.js for the machinery all three of these tabs share.
//
// NO SENTIMENT COLUMN AND NO RANKING. The upstream returns articles in its own relevance order and
// this preserves it as the tie-break; scoring a headline as positive or negative would be a
// judgement of ours presented beside somebody else's reporting. Public Chatter already carries
// sentiment, and it is StockScans' — computed, attributed, and about forum volume rather than news.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { canonicalPublisherName, newsPublisherFilter } from '../core/news-publishers.js';
import { newsViewStatus } from '../core/news-view-status.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { recentNews as feed } from '../data/filings.js';
import { newsPeriodFilter, newsPublicationDay } from '../data/news-window.js';
import * as marketNews from './market-news-view.js';
import { KEYWORDS, GROUPS, classifyStory, topicFilterOptions, matchesTopic, groupLabel } from '../data/news-keywords.js';
import { filterByScope as filterTickerRows } from '../data/scope.js';
import { attributionFor, attributionLabel, newsSearchText } from '../data/company-news-attribution.js';
import { filterCompanyNewsByScope } from '../data/company-news-identity.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// ---------------------------------------------------------------------------------------
// THE TRACKED-KEYWORD LAYER — what makes this feed usable rather than merely present.
//
// The upstream is a SEARCH BY COMPANY NAME, so the capture is a name match and names collide: the
// shipped file holds 11,060 stories across 559 companies, and a company called iDream Film collects
// Bollywood coverage while GOCL collects "stock on fire". Three quarters of it is somebody else's
// company. Filtering by the desk's thirty keywords leaves 2,889 rows.
//
// THE READING IS CACHED PER ROW, not recomputed per keystroke. `scoreTable` asks `match(row, value)`
// for every row on every search and filter change, and each reading is thirty regexes over a
// headline and a standfirst — 330,000 tests per keystroke without this. A WeakMap keyed by the row
// object is right because the rows are stable objects owned by the feed: the entry dies with the
// row, and a row whose text changed would be a new object.
//
// AND IT IS A TOPIC, NEVER A SENTIMENT. This tab's own header says it carries no ranking or
// judgement of ours over somebody else's reporting, and that is untouched: a keyword says what a
// story is about. See js/data/news-keywords.js.
const readings = new WeakMap();
function readingFor(row) {
  let reading = readings.get(row);
  if (!reading) {
    reading = classifyStory(row);
    readings.set(row, reading);
  }
  return reading;
}

function deliveryDetails(meta) {
  const formatCheck = (value) => {
    const at = typeof value === 'number' ? value : Date.parse(value || '');
    return Number.isFinite(at) ? new Date(at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' IST' : 'Not yet confirmed';
  };
  const sources = Object.entries({ core: 'Company-name news searches', publishers: 'Dedicated publisher feeds', tradingView: 'TradingView company news' })
    .map(([key, label]) => {
      const part = meta.newsDelivery?.[key];
      if (!part) return '';
      const state = part.status === 'ok' ? 'Checked' : part.status === 'pending' ? 'Loading' : 'Partial / unavailable';
      return `<p class="mt-2 text-xs" data-news-source-check="${key}"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(state)}.
        Last source check: ${escapeHtml(formatCheck(part.checkedAt))}.${part.pending ? ' Checking the published capture…' : ''}
        ${part.historyPending ? ' Retained history is still loading.' : ''}${part.historyError ? ' Some retained history could not be read.' : ''}</p>`;
    }).join('');
  const enrichment = meta.enrichmentCoverage;
  if (!enrichment) return sources;
  const queries = Number(enrichment.staleOrIncompleteQueries) || 0, pages = Number(enrichment.pagesFailed) || 0,
    documents = Number(enrichment.documentsPending) || 0;
  return sources + `<p class="mt-2 text-xs" data-news-source-check="enrichment"><strong>Related-company and official-site discovery</strong> —
    ${queries || pages || documents ? 'Coverage remains partial.' : 'No pending gaps reported in this capture.'}
    ${escapeHtml(formatNumber(queries))} queries awaiting completion; ${escapeHtml(formatNumber(pages))} page reads failed;
    ${escapeHtml(formatNumber(documents))} documents not yet read. Last discovery capture: ${escapeHtml(formatCheck(enrichment.capturedAt))}.
    Previously captured stories remain visible; a partial discovery run does not retract them.</p>`;
}

const tab = makeFilingsTab({
  id: 'news',
  title: 'News',
  subtitle:
    'Last 30 days of company news, updated automatically. Choose a shorter period or This month (IST). ' +
    'Undated stories have their own filter; older news stays saved in All Alerts.',
  feed,
  preserveReadingPosition: true,
  noun: 'articles',
  emptyMessage: (m) => {
    const status = newsViewStatus(m);
    if (status.state === 'loading') return 'Sources are still loading. Matching articles will appear as they arrive; an empty view is not a completed check.';
    if (status.state === 'partial') return 'No loaded articles match this view. Some source checks are incomplete; this does not mean there is no news.';
    return 'No captured articles match your search and filters. Try the company name, ticker or headline, or clear a filter.';
  },
  // The scrape records a company it searched and found nothing for as a single all-null row. That
  // is a statement about the SEARCH, not an article, and it must not become a row: the company is
  // still counted as covered by the note under the table.
  keepRow: (r) => !!(r.title || r.url),
  nameLabel: 'Headline',
  // WIDE, BECAUSE THE HEADLINE IS THE ROW. At 520px two genuinely different stories truncated to
  // the same string — "Buy Prestige Estates Projects; target of Rs 1…" was Prabhudas Lilladher at
  // ₹1,800 and Motilal Oswal at ₹1,830, on different days — and a table that shows the same words
  // three times reads as duplicated even when every row is a distinct article. The three columns
  // beside it are a date, an outlet and a link icon, so there is room; 1440px still fits without a
  // scrollbar of its own, which `verify-ui.mjs` measures.
  nameMaxPx: 780,
  rowName: (r) => r.title || '(untitled)',
  rowSub: (r) => [attributionLabel(r), r.company || r.ticker, r.company && r.ticker, canonicalPublisherName(r.source)].filter(Boolean).join(' · '),
  searchable: newsSearchText,
  // News is name-searched and can therefore scope private/BSE-only companies by stable entity id.
  // Watchlist remains symbol-based because a saved watch item is a ticker by construction.
  filterByScope: (rows, scope, holdings) =>
    filterCompanyNewsByScope(rows, scope, holdings) ?? filterTickerRows(rows, scope, holdings),
  columns: () => [
    {
      label: 'Date',
      get: (r) => (newsPublicationDay(r) ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(newsPublicationDay(r)))}</span>` : dash('the article carried no readable date')),
      html: true,
      // A row with no date sorts last rather than first. An unreadable date is not "today".
      sortValue: (r) => newsPublicationDay(r) || '',
    },
    {
      // THE TOPIC COLUMN TOOK THE OUTLET COLUMN'S PLACE RATHER THAN BEING ADDED BESIDE IT. The
      // outlet was already printed in the identity cell's sub-line under every headline, so the
      // column was a second copy of it — and the headline is capped at 780px here precisely because
      // two different stories truncate to the same string below that. Spending width on a
      // duplication to make the thing that is not duplicated fit is the wrong way round. The outlet
      // is still in the sub-line, still its own filter, and still a column in the export.
      label: 'Topic',
      get: (r) => {
        const reading = readingFor(r);
        if (!reading.tracked) {
          return `<span class="text-slate-300" title="No tracked keyword matched this headline or standfirst. It is in the capture because the company's own name search returned it.">untracked</span>`;
        }
        // The relationship label is always present in the row, even without a tracked topic.
        const unnamed =
          reading.attribution.status !== 'confirmed'
            ? `<span class="ml-1 text-[10px] font-semibold text-amber-600" title="${escapeHtml(reading.attribution.reason)}">?</span>`
            : '';
        // AT MOST TWO CHIPS, AND THE REST AS A COUNT. A story can carry five keywords — "Receipt of
        // order worth Rs 240 crore; orderbook at a record" carries three on its own — and five
        // chips make this column wider than the headline it sits beside. Measured: uncapped, the
        // News table ran 1390px inside a 1352px viewport at 1440, which is the horizontal scrollbar
        // `verify-ui.mjs` exists to catch. The full list stays in the cell's tooltip, in the export
        // and in the filter, so nothing is lost — only the width.
        const CHIPS = 2;
        const shown = reading.keywords.slice(0, CHIPS);
        const rest = reading.keywords.length - shown.length;
        // A HEADLINE MATCH AND A STANDFIRST MATCH ARE NOT THE SAME EVIDENCE, so they do not look
        // the same. The publisher chose the headline; several outlets fill the standfirst with a
        // related-links strip, which is how one Business Today sidebar tagged stories about MCX and
        // aircraft leasing as Resignation. A muted chip keeps the row findable without dressing a
        // sidebar hit as a lead. It is also the rule General Alerts promotes on — see `newsSignal`.
        const chip = (k) =>
          `<span class="mr-1 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ring-1 ${
            k.where === 'title' ? 'bg-indigo-50 text-indigo-700 ring-indigo-100' : 'bg-slate-50 text-slate-500 ring-slate-200'
          }" title="${escapeHtml(
            `${groupLabel(k.group)} · matched in the ${k.where === 'title' ? 'headline' : "standfirst only — the headline does not carry it, and some outlets fill this field with a related-links strip rather than the story's own summary"}${k.note ? `. ${k.note}` : ''}`
          )}">${escapeHtml(k.label)}</span>`;
        const more = rest
          ? `<span class="text-[10px] font-semibold text-slate-400" title="${escapeHtml(`Also: ${reading.labels.slice(CHIPS).join(', ')}`)}">+${rest}</span>`
          : '';
        return shown.map(chip).join('') + more + unnamed;
      },
      html: true,
      // Sorts tracked rows to one end and orders them by their first keyword, so a sort on this
      // column groups the feed by topic rather than scattering it.
      sortValue: (r) => {
        const reading = readingFor(r);
        return reading.tracked ? `1${reading.labels[0]}` : '0';
      },
    },
  ],
  filters: (rows) => {
    // THE COUNTS ARE MEASURED, NOT TYPED. Every option carries how many of the rows currently in
    // scope it would leave, computed from those rows — the same rule the source registry follows
    // (`sourceGroups()` is a function so no figure can go stale). A reader can then see that
    // "Order" is 12 rows here before spending a click on it, and can see a keyword that matches
    // nothing today, which is how a pattern that is quietly too narrow gets noticed.
    const readingsFor = rows.map(readingFor);
    const counted = (value) => readingsFor.filter((reading) => matchesTopic(reading, value)).length;
    const topic = {
      label: 'Topic',
      options: topicFilterOptions(counted),
      match: (r, v) => matchesTopic(readingFor(r), v),
    };
    const relationship = {
      label: 'Company relationship',
      options: [
        { value: 'all', label: 'Matched + possible news' },
        { value: 'confirmed', label: `Company matched · ${rows.filter(r => attributionFor(r).status === 'confirmed').length}` },
        { value: 'uncertain', label: `Possible matches · ${rows.filter(r => attributionFor(r).status === 'uncertain').length}` },
      ],
      match: (r, v) => attributionFor(r).status === v,
    };
    // AN ARRAY, so the two AND together — "Order" and "Business Standard" are different questions
    // and folding them into one dropdown would make them mutually exclusive for no reason.
    return [topic, relationship, newsPublisherFilter(rows), newsPeriodFilter()];
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Company news</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real, and not ours.</strong> Articles come from independently captured dedicated publisher feeds and TradingView company feeds,
           plus company-name searches through the Muns news API (<code class="rounded bg-slate-100 px-1">POST /tools/news-search</code>).
           Only the Muns search route uses the API credential held by this dashboard's Worker; it is never sent to the browser.</p>
        <p class="mt-2 text-xs">Already captured publisher stories are matched to reviewed company identities directly in this view;
           they do not wait for another company-search enrichment run. Unmatched originals remain available in Universe.
           Publisher names are shown consistently in the filter; the original source name, headline and URL remain in the capture and export.</p>
        ${deliveryDetails(m)}

        <p class="mt-2 text-xs"><strong>Incremental and permanent.</strong> Portfolio identities are checked every few hours
           with a 48-hour overlap. Every returned article is written to a permanent monthly archive before this fast 30-day
           head is derived. This view loads only the recent period and undated stories; it opens on the last 30 calendar days,
           including today in IST. This month starts on the first calendar day (up to 31 days). Older news remains available in
           <a class="text-indigo-600 underline" href="#/research/daily-alerts?scope=portfolio">All Alerts</a> and is never deleted by a filter.
           A successful empty search never retracts an article captured earlier. ${m.newsHistory?.error ? escapeHtml(m.newsHistory.error) : ''} Companies without an NSE
           ticker are searched by legal name and remain linked to the portfolio by ISIN.</p>

        <p class="mt-2 text-xs"><strong>TradingView enrichment.</strong> An independent background capture targets every 15 minutes,
           around the clock, with automatic portfolio membership and permanent headline retention. Open dashboards revalidate
           the published captures every two minutes while visible; these are snapshots, not a guaranteed real-time stream.
           ${m.tradingViewCoverage ? `Last source check: ${escapeHtml(m.tradingViewCoverage.checkedAt)}.
           ${m.tradingViewCoverage.staleOrFailedSymbols} stale/failed symbol reads; ${m.tradingViewCoverage.unresolvedCompanies} companies without a verified symbol;
           ${m.tradingViewCoverage.possibleGapSymbols} possible public-window gaps.` : 'The first independent capture has not been published yet.'}
           ${m.tradingViewHealth?.ok === false || m.tradingViewReadError ? 'Coverage needs attention; retained headlines are still shown.' : ''}
           Restricted headlines are not extracted. A 45-minute stale threshold is checked independently.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why a search feed needs a topic filter</h3>
        <p class="mt-1 text-xs">The upstream is a <strong>search endpoint, not a feed</strong>: there is no request that returns
           everything published today, only one that answers a <strong>company-name query</strong>. Search engines can return
           unrelated stories, and a returned row is not proof that the article concerns the searched company.</p>
        <p class="mt-2 text-xs">The <strong>Topic</strong> filter is the other half of the query. The tracked topics listed below
           say what a story has to be <em>about</em>; company attribution is assessed separately. Every option shows how many rows
           it would leave, counted from the rows in scope rather than typed in — including
           <strong>“No tracked keyword”</strong>, which is there so a pattern that is quietly too narrow can be found rather
           than mistaken for a quiet week.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The ${KEYWORDS.length} tracked topics</h3>
        <div class="mt-1 space-y-1.5 text-xs">
          ${GROUPS.map(
            (g) =>
              `<p><span class="font-semibold text-slate-700">${escapeHtml(g.label)}</span> — ${KEYWORDS.filter((k) => k.group === g.id)
                .map((k) => escapeHtml(k.label))
                .join(', ')}</p>`
          ).join('')}
        </div>
        <p class="mt-2 text-xs">A keyword names a <strong>topic, never a direction</strong>. “Lawsuit” is something a company can
           be on either side of and “Approval” can be somebody else's, so nothing here is scored positive or negative — that
           would put our judgement beside somebody else's reporting, which this tab does not do. Several patterns are
           deliberately narrower than the plain word (a bare “trial” matched free-trial boilerplate; a bare “fire” matched
           “stock on fire”); hover a chip to see where and why.</p>
        <p class="mt-2 text-xs"><strong>Company matched</strong> means a whole identity name, reviewed alias or identifiable
           symbol occurs in the headline or a bounded article body. It does not verify the reported event.
           <strong>Possible match — unverified</strong> stays visible and searchable by company by default, including
           snippet-only, subsidiary and unknown-brand coverage. A missing name never proves irrelevance. The optional
           relationship filter shows counts. Only an explicitly reviewed article-company mismatch loses its company label;
           its source record remains archived and findable by headline in All Alerts / Universe.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is reproduced and what is not</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Headline, outlet and date</strong> — the upstream's, unchanged.</li>
          <li><strong>The article itself</strong> — not here. Every row links to the publisher, and nothing is summarised
              into our words.</li>
          <li><strong>No sentiment or investment ranking of ours.</strong> Stories are merged newest source date/time first;
              undated articles remain undated, never borrowing their capture time. A topic identifies the subject, not a trade recommendation.</li>
          <li><strong>Company matching</strong> is ours. A search query alone is only a possible match. Company-matched rows
              have name or reviewed-alias evidence in the headline or bounded article body; this identifies the company, not the truth of the reported claim.</li>
        </ul>

        ${coverageBlock(m)}

        <p class="mt-4 text-xs text-slate-500">A dash means <em>the article did not carry it</em> — never zero, and never a
           date we guessed.</p>
      </div>
    </div>`,
  onExport: async (visible, m) => {
    await exportRows({
      filename: 'sattva-news',
      sheetName: 'News',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `REAL DATA, NOT OURS. Company news from company-search, dedicated publisher and TradingView captures, including retained history loaded in this view, exported ${new Date().toISOString()}. ` +
                `HEADLINES, OUTLETS AND DATES ARE THE PUBLISHERS' — reproduced unchanged, never summarised into our words, and carrying no sentiment or ranking of ours. ` +
                `Company matching is ours: search-only associations remain possible matches; confirmed identity evidence is recorded separately and does not verify the event. ` +
                `TRACKED TOPICS ARE OURS AND ARE A SUBJECT READING, NEVER A DIRECTION — a keyword says what a story is about, so nothing in this workbook is scored positive or negative. ` +
                `Company relationship and evidence are separate columns. A possible match is unverified coverage, not proof about the company. A blank name-match value means uncertain; only an explicit reviewed mismatch means no. ` +
                `${m.covered} companies represented${m.failed ? `; ${m.failed} latest company checks failed and previously retained stories may still appear` : ''}. ` +
                `A blank means the article did not carry that field.`
              : r.date || '',
        },
        { header: 'Company', key: 'c', width: 28, get: (r) => (r.__banner ? '' : r.company || r.ticker || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Company relationship', key: 'attribution', width: 28, get: (r) => r.__banner ? '' : attributionLabel(r) },
        { header: 'Searched company (not attribution)', key: 'queryCompany', width: 32, get: (r) => r.__banner ? '' : attributionFor(r).queryCompany || '' },
        { header: 'Attribution evidence', key: 'evidence', width: 70, get: (r) => r.__banner ? '' : JSON.stringify(attributionFor(r)) },
        { header: 'Headline', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.title || '') },
        { header: 'Outlet', key: 'o', width: 24, get: (r) => (r.__banner ? '' : canonicalPublisherName(r.source)) },
        { header: 'Outlet as captured', key: 'rawOutlet', width: 24, get: (r) => (r.__banner ? '' : r.source || '') },
        // THE WORKBOOK IS THE ONE ARTEFACT NOBODY CAN SEE A CHIP ON, so the topics travel as their
        // own column and the banner says what they are and are not. A reader who merges two exports
        // in Excel has nothing else to go on.
        { header: 'Tracked topics', key: 'k', width: 30, get: (r) => (r.__banner ? '' : readingFor(r).labels.join(', ')) },
        {
          header: 'Names the company',
          key: 'n',
          width: 18,
          get: (r) => {
            if (r.__banner) return '';
            const named = readingFor(r).namesCompany;
            // Three answers, and the blank is the third: no search term to check against is not the
            // same as a story that does not name the company.
            return named === true ? 'yes' : named === false ? 'no' : '';
          },
        },
        { header: 'URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
        { header: 'Summary (publisher)', key: 's', width: 80, get: (r) => (r.__banner ? '' : r.summary || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;

// ---------------------------------------------------------------------------------------
// TWO FEEDS UNDER ONE TAB, CHOSEN BY THE SCOPE TOGGLE
//
// Portfolio scope keeps the per-company search: the Muns news API answers one company at a time,
// so the reader names the companies and each is searched in full.
//
// Universe scope cannot work that way — 603 searches is ten minutes of somebody else's service —
// so it asks a different question entirely: not "what has been written about these companies" but
// "what has been published". Moneycontrol publish exactly that, market-wide, and a scheduled
// Action captures it because neither the browser nor the Worker can read their site (403 by TLS
// fingerprint, measured both ways — see js/data/market-news.js).
//
// The two halves are DIFFERENT PUBLISHERS ANSWERING DIFFERENT QUESTIONS, and each says so in its
// own description. A reader flipping the toggle must never have to guess why the rows changed
// completely; that is also why neither half is presented as a subset of the other.
//
// `render()` runs on every scope change, so it must tear the OTHER half down — otherwise the
// unmounted view keeps its subscription and repaints into a root that now belongs to the other
// feed. `destroy()` is only called when leaving the tab entirely, which is too late for that.
// ---------------------------------------------------------------------------------------

let mounted = null; // 'universe' | 'companies'

export function render(ctx) {
  // MARKET-WIDE NEWS CARRIES NO COMPANY, so it cannot be narrowed to a book or a watchlist — see
  // the chatter rule in CLAUDE.md: filtering rows that have no ticker BY ticker would report "your
  // companies are not in the news" when the truth is that nothing on those rows says whose they
  // are. Universe gets the market-wide capture; both narrowed scopes get the per-company search.
  const wanted = ctx.scope === 'universe' ? 'universe' : 'companies';
  if (mounted && mounted !== wanted) {
    if (mounted === 'universe') marketNews.destroy();
    else tab.destroy();
  }
  mounted = wanted;
  if (wanted === 'universe') marketNews.render(ctx);
  else tab.render(ctx);
}

export function destroy() {
  if (mounted === 'universe') marketNews.destroy();
  else if (mounted === 'companies') tab.destroy();
  mounted = null;
}
