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
import { withoutPublisherName } from '../core/source-copy.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { news as feed } from '../data/filings.js';
import * as marketNews from './market-news-view.js';
import { KEYWORDS, GROUPS, classifyStory, topicFilterOptions, matchesTopic, groupLabel } from '../data/news-keywords.js';
import { filterByScope as filterTickerRows } from '../data/scope.js';
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

const tab = makeFilingsTab({
  id: 'news',
  title: 'News',
  subtitle:
    'The latest stories for every company in scope, from the scheduled capture — no company to pick first. ' +
    'Refresh re-searches whatever the capture has not covered. Switch to Universe for the complete market-wide publisher feed.',
  feed,
  noun: 'articles',
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
  rowName: (r) => withoutPublisherName(r.title) || '(untitled)',
  rowSub: (r) => [r.company || r.ticker, r.company && r.ticker, withoutPublisherName(r.source)].filter(Boolean).join(' · '),
  searchable: (r) => `${r.title || ''} ${r.source || ''} ${r.company || ''} ${r.ticker || ''} ${r.summary || ''}`,
  // News is name-searched and can therefore scope private/BSE-only companies by stable entity id.
  // Watchlist remains symbol-based because a saved watch item is a ticker by construction.
  filterByScope: (rows, scope, holdings) =>
    filterCompanyNewsByScope(rows, scope, holdings) ?? filterTickerRows(rows, scope, holdings),
  columns: () => [
    {
      label: 'Date',
      get: (r) => (r.date ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}</span>` : dash('the article carried no readable date')),
      html: true,
      // A row with no date sorts last rather than first. An unreadable date is not "today".
      sortValue: (r) => r.date || '',
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
        // The name-match caveat rides on the chip rather than removing the row: `namesCompany` is a
        // heuristic that reads false for a company known by a brand its search term omits, so it
        // marks a row and never drops one. See js/data/news-keywords.js.
        const unnamed =
          reading.namesCompany === false
            ? `<span class="ml-1 text-[10px] font-semibold text-amber-600" title="The story does not appear to name this company. It is filed here because the company's own name search returned it — worth opening before acting on.">?</span>`
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
    const outlets = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
    // AN ARRAY, so the two AND together — "Order" and "Business Standard" are different questions
    // and folding them into one dropdown would make them mutually exclusive for no reason.
    if (outlets.length < 2) return [topic];
    return [
      topic,
      {
        label: 'Outlet',
        options: [{ value: 'all', label: 'All outlets' }, ...outlets.slice(0, 40).map((o) => ({ value: o, label: withoutPublisherName(o) }))],
        match: (r, v) => r.source === v,
      },
    ];
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Company news</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real, and not ours.</strong> Articles come from the Muns news API
           (<code class="rounded bg-slate-100 px-1">POST /tools/news-search</code>), one search per reviewed company identity name, read through this
           dashboard's Worker because the API needs a credential the browser must never hold.</p>

        <p class="mt-2 text-xs"><strong>Incremental and permanent.</strong> Portfolio identities are checked every few hours
           with a 48-hour overlap. Every returned article is written to a permanent monthly archive before this fast 30-day
           view is derived, so a successful empty search never retracts an article captured earlier. Companies without an NSE
           ticker are searched by legal name and remain linked to the portfolio by ISIN.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why a search feed needs a topic filter</h3>
        <p class="mt-1 text-xs">The upstream is a <strong>search endpoint, not a feed</strong>: there is no request that returns
           everything published today, only one that answers “what has been written about this company”. So every row here was
           found by matching a <strong>company name</strong> — and names collide. A company called iDream Film collects film
           coverage; GOCL collects “stock on fire”. Measured on this capture, roughly three stories in four are about somebody
           else.</p>
        <p class="mt-2 text-xs">The <strong>Topic</strong> filter is the other half of the query. Thirty keywords, listed below,
           say what a story has to be <em>about</em>; the search already supplied the company. Every option shows how many rows
           it would leave, counted from the rows in scope rather than typed in — including
           <strong>“No tracked keyword”</strong>, which is there so a pattern that is quietly too narrow can be found rather
           than mistaken for a quiet week.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The thirty tracked keywords</h3>
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
        <p class="mt-2 text-xs">A chip followed by an amber <strong>?</strong> means the story does not appear to name the company
           it is filed under. It is <strong>marked and never removed</strong>: the check is a name heuristic and reads false for a
           company known by a brand its search term omits, so it flags a row for a second look rather than deciding on your
           behalf. <em>Tracked keyword · names the company</em> in the Topic filter is the strict reading if you want it.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is reproduced and what is not</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Headline, outlet and date</strong> — the upstream's, unchanged.</li>
          <li><strong>The article itself</strong> — not here. Every row links to the publisher, and nothing is summarised
              into our words.</li>
          <li><strong>No sentiment, no ranking of ours.</strong> Articles keep the order the API returned them in. Scoring a
              headline would put our judgement beside somebody else's reporting.</li>
          <li><strong>The company a story is filed under</strong> is ours — it is the search term, not something the article
              declares. A story can be about several companies and will appear under whichever we asked about.</li>
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
              ? `REAL DATA, NOT OURS. Company news via the Muns news API, reaching back ${m.windowDays} days, exported ${new Date().toISOString()}. ` +
                `HEADLINES, OUTLETS AND DATES ARE THE PUBLISHERS' — reproduced unchanged, never summarised into our words, and carrying no sentiment or ranking of ours. ` +
                `The company each story is filed under is OUR search term, not a claim by the article: a story about several companies appears under whichever was asked about. ` +
                `TRACKED TOPICS ARE OURS AND ARE A SUBJECT READING, NEVER A DIRECTION — a keyword says what a story is about, so nothing in this workbook is scored positive or negative. ` +
                `"Names the company" is a name heuristic over the search term: "no" flags a story for a second look and never means the row was filtered out; a blank means there was no search term to check. ` +
                `${m.covered} companies covered${m.failed ? `; ${m.failed} could not be read and are ABSENT rather than shown as having no news` : ''}. ` +
                `A blank means the article did not carry that field.`
              : r.date || '',
        },
        { header: 'Company', key: 'c', width: 28, get: (r) => (r.__banner ? '' : r.company || r.ticker || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Headline', key: 'h', width: 70, get: (r) => (r.__banner ? '' : withoutPublisherName(r.title)) },
        { header: 'Outlet', key: 'o', width: 24, get: (r) => (r.__banner ? '' : withoutPublisherName(r.source)) },
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
        { header: 'Summary (publisher)', key: 's', width: 80, get: (r) => (r.__banner ? '' : withoutPublisherName(r.summary)) },
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
