// investors/live.js — Superstar Investors, live off Ticker Finology.
//
//   renderLive(ctx, { disposers })   the whole sub-view
//   openInvestor(slug)               one investor's book, as a workspace
//
// EVERY FIELD THE API RETURNS APPEARS SOMEWHERE, which is the point of the view:
//
//   list      name → card + table       slug → the deep link and the export
//             bio  → card + Profile     imageUrl → the card's portrait
//   portfolio netWorthCr, activeStocks, totalStocks → card and Profile
//             quarters[]        → one table column each, in the source's own order
//             company           → the identity column
//             companySlug       → the link out to Finology's own page
//             quarterlyHoldings → the cells
//             valueCr           → the value column, headed as theirs
//
// THE NUMBERS ARE FINOLOGY'S AND THE PANEL SAYS SO. Holding percentages are what the company
// filed; `valueCr` is Finology's derivation from that percentage and a market cap, exactly as the
// Institutions view treats Trendlyne's value column. Nothing here re-bands or recomputes either.
//
// ONE DERIVED FIGURE: the quarter-over-quarter change, which is subtraction of two of their own
// percentages (see deriveMoves in js/data/finology-shared.js). It is headed "Change (derived)" and
// the help modal says how it is computed.
//
// A BLANK QUARTER IS AN EM DASH, NEVER A ZERO. Finology print "-" where a holder was not on the
// shareholding pattern, which below the disclosure threshold means "not disclosed", not "sold".

import { rankedList, scoreTable, sectionHead, openWorkspace, openModal, closeModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCroreCompact, formatRelativeTime } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { deliveryNote } from '../ui/sources.js';
import * as feed from '../data/super-investors.js';
import * as coverage from '../data/coverage.js';
import * as watchlist from '../core/watchlist.js';
import { scopePossessive } from '../data/scope.js';

const SOURCE = 'Ticker Finology, read live through this dashboard’s Worker.';
const FINOLOGY_INVESTOR = (slug) => `https://ticker.finology.in/investor/${encodeURIComponent(slug)}`;
const FINOLOGY_COMPANY = (slug) => `https://ticker.finology.in/company/${encodeURIComponent(slug)}`;

const dash = '<span class="text-slate-300">—</span>';
const pct = (v) => (v == null ? dash : `${Number(v).toFixed(2)}%`);
const cr = (v) => (v == null ? dash : formatCroreCompact(v));

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function renderLive(ctx, { disposers = [], tableView, onView } = {}) {
  const m = feed.meta();

  if (!m.ok) return renderUnavailable(ctx, m);

  const rows = scopedHoldings(ctx);
  const quarters = feed.quarterLabels();
  const investorList = feed.list();

  const summary = quarterSummaryBlock(ctx, m, rows);
  const table = holdingsTable(ctx, rows, quarters, tableView);
  onView?.(table.view);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Superstar Investors',
      description: `Every tracked investor's book as Ticker Finology publish it, quarter by quarter. ${SOURCE}`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}${scopeSummary({ scope: ctx.scope, count: investorList.length, noun: 'investors' })}</div>`,
    })}
    ${staleStrip(m)}
    ${loadingStrip(m)}
    ${summary.html}
    <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${investorList.map(investorCard).join('')}</div>
    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <span class="text-xs font-bold uppercase tracking-wider text-slate-500">All disclosed positions</span>
      <span class="text-[11px] text-slate-400">${escapeHtml(coverageNote(rows, quarters))}</span>
    </div>
    ${table.html}`;

  summary.wire(ctx.root, disposers);
  disposers.push(table.wire(ctx.root));
  wireLivePill(ctx.root, m);
  wireCards(ctx.root);
}


// ---------------------------------------------------------------------------------------
// THE QUARTER, ACROSS EVERY BOOK — what the three stat tiles became
//
// The page used to open on three KPI cards: investors tracked, combined book value, and a
// "58 new · 400 exits" count. Two of the three were properties of the FEED rather than answers a
// reader came for — how many books loaded, and what they add up to — and the third was a pair of
// numbers with no names attached, so the only way to act on it was to open ninety books.
//
// This is the roll-up instead: who bought what, who sold what, and where more than one tracked
// investor moved on the same company. The counts the third tile carried are kept — as a line of
// text under the heading, where they belong beside the names they describe.
//
// EVERY HONESTY RULE HERE IS ENFORCED IN `quarterSummary` (js/data/super-investors.js), and the
// wording on these panels has to match it:
//
//   · increases and reductions are in PERCENTAGE POINTS of the company, never rupees — `valueCr`
//     is what a position is worth now, not what was traded;
//   · a new position carries no size, so it is ranked by the stake now disclosed;
//   · an exit is "no longer disclosed", never "sold";
//   · consensus is a count of who moved, never a signal, a weight or a score.
// ---------------------------------------------------------------------------------------

const pp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)} pp`);
const andOthers = (names) => (names.length <= 2 ? names.join(' & ') : `${names[0]}, ${names[1]} +${names.length - 2}`);

function quarterSummaryBlock(ctx, m, rows) {
  const include = scopeFilter(ctx);
  const q = feed.quarterSummary({ include, limit: 5 });

  const panels = [
    rankedList({
      key: 'si-consensus-buys',
      title: 'Bought by more than one investor',
      note: 'Added to, or newly disclosed, by two or more tracked investors.',
      items: q.consensusBuys.map((c) => ({
        name: c.company,
        sub: andOthers(c.investors.map((i) => i.investor)),
        value: `${c.count} investors`,
        badge: c.sized ? pp(c.sumPp) : null,
        tone: 'pos',
      })),
      empty: 'No company was bought by more than one tracked investor this quarter.',
    }),
    rankedList({
      key: 'si-new',
      title: 'New entrants',
      note: 'First quarter disclosed. Ranked by the stake now held — an appearance has no trade size.',
      items: q.newEntrants.map((mv) => ({
        name: mv.company,
        sub: mv.investor,
        value: mv.now == null ? '—' : `${Number(mv.now).toFixed(2)}%`,
        tone: 'pos',
      })),
      empty: 'No new position was disclosed this quarter.',
    }),
    rankedList({
      key: 'si-adds',
      title: 'Largest increases',
      note: 'Percentage points of the company, latest quarter minus the one before — derived.',
      items: q.topAdds.map((mv) => ({ name: mv.company, sub: mv.investor, value: pp(mv.deltaPp), tone: 'pos' })),
      empty: 'No position was increased this quarter.',
    }),
    rankedList({
      key: 'si-consensus-exits',
      title: 'Sold down by more than one investor',
      note: 'Trimmed, or no longer disclosed, by two or more tracked investors.',
      items: q.consensusExits.map((c) => ({
        name: c.company,
        sub: andOthers(c.investors.map((i) => i.investor)),
        value: `${c.count} investors`,
        badge: c.sized ? pp(c.sumPp) : null,
        tone: 'neg',
      })),
      empty: 'No company was sold down by more than one tracked investor this quarter.',
    }),
    rankedList({
      key: 'si-trims',
      title: 'Largest reductions',
      note: 'Percentage points of the company, latest quarter minus the one before — derived.',
      items: q.topTrims.map((mv) => ({ name: mv.company, sub: mv.investor, value: pp(mv.deltaPp), tone: 'neg' })),
      empty: 'No position was reduced this quarter.',
    }),
    rankedList({
      key: 'si-exits',
      title: 'No longer disclosed',
      note: 'Off the shareholding pattern this quarter. Below the disclosure threshold that is not the same as sold.',
      items: q.exits.map((mv) => ({
        name: mv.company,
        sub: mv.investor,
        // The stake they last disclosed, labelled as the prior quarter's — NOT a size for the
        // exit, which has none. An em dash where even that is missing.
        value: mv.before == null ? '—' : `was ${Number(mv.before).toFixed(2)}%`,
        tone: 'neg',
      })),
      empty: 'Every position disclosed last quarter is still disclosed.',
    }),
  ];

  const html = `
    <section class="mb-6" data-quarter-summary>
      ${summaryHead(q)}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${panels.map((p) => p.html).join('')}</div>
    </section>`;

  function wire(root, disposers) {
    for (const panel of panels) disposers.push(panel.wire(root));
    const btn = root.querySelector('[data-summary-help]');
    if (btn) btn.addEventListener('click', () => openModal(summaryHelpBody(q), { size: 'wide' }));
  }

  return { html, wire };
}

/**
 * The heading, and the counts the removed tile carried.
 *
 * `clause()` is the Sources-modal rule applied here: a figure goes at the END of a sentence that
 * survives without it, so a count of zero drops its clause rather than printing "0 new".
 */
function summaryHead(q) {
  const c = q.counts;
  const clause = (n, text) => (n ? text : null);
  const parts = [
    clause(c.new, `${formatNumber(c.new)} new`),
    clause(c.added, `${formatNumber(c.added)} increased`),
    clause(c.trimmed, `${formatNumber(c.trimmed)} reduced`),
    clause(c.exited, `${formatNumber(c.exited)} no longer disclosed`),
  ].filter(Boolean);

  const span =
    q.pairs.length === 1 && q.pairs[0].latest
      ? `${escapeHtml(q.pairs[0].latest)} vs ${escapeHtml(q.pairs[0].prior)}`
      : `${q.pairs.length} different quarter pairs`;

  return `
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-display text-lg font-bold text-slate-900">The quarter across every book</h2>
      <button type="button" data-summary-help
        class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        <span>How this is derived</span><span aria-hidden="true">?</span>
      </button>
    </div>
    <p class="mb-3 text-xs text-slate-500">
      ${parts.length ? `${escapeHtml(parts.join(' · '))} across ${formatNumber(q.contributingBooks)} of ${formatNumber(q.comparableBooks)} comparable books` : 'No position moved in any comparable book.'}
      <span class="text-slate-400">· ${span}${q.singleQuarterBooks ? ` · ${formatNumber(q.singleQuarterBooks)} book${q.singleQuarterBooks === 1 ? '' : 's'} publish only one quarter and cannot be compared` : ''}</span>
    </p>`;
}

function summaryHelpBody(q) {
  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">How the quarter's moves are derived</h2>
          <p class="mt-1 text-sm text-slate-500">${escapeHtml(SOURCE)}</p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">&times;</button>
      </div>
      <div class="space-y-3 text-[13px] leading-relaxed text-slate-700">
        <p>Finology publish a holding <strong>percentage</strong> per company per quarter. The change is the latest quarter minus the one before it, per company, per investor — <strong>the only computed figure on this page</strong>. Everything else is reproduced as they publish it.</p>
        <p><strong>A blank quarter is not a zero.</strong> Where a holder is not on the shareholding pattern the source prints "-", which below the Indian disclosure threshold means <em>not disclosed</em> rather than <em>sold</em>. So a position appearing counts as <strong>new</strong> and one disappearing as <strong>no longer disclosed</strong> — and neither carries a percentage-point figure, because printing ±the whole holding would invent a trade size that nobody disclosed.</p>
        <p><strong>Increases and reductions are in percentage points of the company, not rupees.</strong> The ₹ figure beside a holding is Finology's derivation of what the position is worth <em>now</em>, from a percentage and a market cap. It is not what was traded, so ranking "largest buys" by it would answer a different question and attach a rupee amount to a trade nobody stated.</p>
        <p><strong>"Bought by more than one investor" is a count, not a signal.</strong> It says how many tracked investors added to or newly disclosed the same company. It is not weighted, not scored and not a recommendation — this dashboard adds no model of its own to somebody else's filings.</p>
        <p><strong>The books are not all on the same quarter.</strong> Each is compared against its own two most recent published quarters, so this roll-up can span several quarter pairs; ${q.pairs.length === 1 ? 'in the current data they all land on one.' : `the current data spans ${q.pairs.length}.`} A book that publishes only one quarter is not comparable and contributes nothing, rather than counting as entirely new${q.singleQuarterBooks ? ` — ${formatNumber(q.singleQuarterBooks)} of them right now` : ''}.</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// States where there is nothing to show — and each says which
// ---------------------------------------------------------------------------------------

const REASONS = {
  'no-route': {
    title: 'The live investor feed needs the Worker',
    body: 'This origin serves the static files only, so there is no <code>/api/super-investors</code> route to answer. Run <code>npx wrangler dev</code>, or open the deployed site.',
  },
  'no-token': {
    title: 'No API token is configured',
    body: 'The super-investor API requires a bearer token, and this deployment has none. An operator sets it with <code>npx wrangler secret put MUNS_TOKEN</code> — it lives on the Worker and never reaches the browser.',
  },
  unauthorised: {
    title: 'The API rejected the token',
    body: 'The token configured on the Worker was refused, which usually means it has expired. Renewing it is <code>npx wrangler secret put MUNS_TOKEN</code>.',
  },
  // This is a deployment fact, not a data condition, so it says so rather than implying the
  // investor list came back empty. The credential is fine; the endpoint is simply not there.
  'route-missing': {
    title: 'That service does not have the super-investor endpoints',
    body: 'The token works, but <code>GET /super-investors</code> returns 404 on the host this dashboard is pointed at. Its own OpenAPI document (<code>/api-json</code>) lists no route matching "investor", so this is not a bad path on our side — the endpoint is not deployed there. Whoever owns that backend needs to ship it, or point us at the host that already has it.',
  },
  timeout: {
    title: 'The super-investor API did not answer in time',
    body: 'The request was given 15 seconds and retried, and the upstream did not respond. It answers in about a second when healthy, so this usually means the service is restarting.',
  },
  unreachable: { title: 'The super-investor API could not be reached', body: 'The upstream service did not answer. Nothing is wrong with this page; there is nothing to show until it does.' },
  upstream: { title: 'The super-investor API returned an error', body: 'The upstream answered, but not with data. This usually clears on its own.' },
  shape: { title: 'The super-investor API returned something unreadable', body: 'The response was not JSON in the shape this dashboard knows. That is a change on their side worth looking at.' },
};

/**
 * Nothing to show, and why.
 *
 * Deliberately NOT `pendingPanel()`. That component means "not built yet" and draws shimmering
 * skeletons, which here would promise data that is not coming: nothing arrives until an operator
 * sets a token or the upstream recovers. It also escapes its body, so the very command a reader
 * needs would render as literal angle brackets. This says what happened, what fixes it, and shows
 * no furniture pretending to fill.
 */
function renderUnavailable(ctx, m) {
  const r = REASONS[m.reason] || REASONS.upstream;
  const operator = m.reason === 'no-token' || m.reason === 'unauthorised';
  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Superstar Investors',
      description: `Every tracked investor's book as Ticker Finology publish it, quarter by quarter. ${SOURCE}`,
      meta: scopeSummary({ scope: ctx.scope, count: 0, noun: 'investors' }),
    })}
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-start gap-3">
        <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${operator ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' : 'bg-slate-100 text-slate-500'}" aria-hidden="true">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${operator ? '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'}
          </svg>
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(r.title)}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-600">${r.body}</p>
          ${m.message ? `<p class="mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-500">${escapeHtml(m.message)}</p>` : ''}
          <p class="mt-3 text-xs leading-relaxed text-slate-500">
            <strong>No positions are shown.</strong> Not an empty book and not last week's figures — there is nothing to display
            until the feed answers, and inventing furniture to fill the space would be worse than the gap.
          </p>
        </div>
      </div>
    </div>`;
}

/**
 * The upstream could not be reached and the Worker served its last good read instead.
 *
 * THIS IS NOT THE MOCK RIBBON AND IT MUST NOT READ AS ONE. Every figure below it is a real filing,
 * read from the real source; what is wrong with it is its AGE, and the strip says exactly that and
 * gives the age. The alternative this replaced was showing nothing at all — a reader with a
 * twenty-minute-old copy of a quarterly disclosure got a page of prose about a restarting service.
 *
 * It sits above the grid rather than inside the provenance modal because a caveat that has to be
 * clicked for is a caveat most readers never see, and this one changes what the numbers mean.
 */
function staleStrip(m) {
  if (!m.stale) return '';
  const age = m.fetchedAt ? formatRelativeTime(Date.parse(m.fetchedAt)) : null;
  const which =
    m.staleReason || !m.staleBooks
      ? 'The source did not answer just now'
      : `${formatNumber(m.staleBooks)} of these books could not be re-read just now`;
  return `
    <div class="mb-5 flex items-start gap-3 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
      <span class="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700" aria-hidden="true">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      </span>
      <p class="text-xs leading-relaxed text-amber-900">
        <strong>Showing the last good read${age ? `, from ${escapeHtml(age)}` : ''}.</strong>
        ${escapeHtml(which)}, so the Worker served the copy it already had rather than nothing at all.
        These are real filed holdings of that age — not estimates, and not this moment's figures.
        ${m.staleReason ? `<span class="mt-1 block font-mono text-[11px] text-amber-800/80">${escapeHtml(m.staleReason)}</span>` : ''}
      </p>
    </div>`;
}

/** While the books are still arriving, say so — a half-filled grid should explain itself. */
function loadingStrip(m) {
  if (!m.pending && !m.inFlight) return '';
  return `
    <div class="mb-5 flex items-center gap-3 rounded-2xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">
      <span class="relative flex h-2 w-2 flex-shrink-0">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75"></span>
        <span class="relative inline-flex h-2 w-2 rounded-full bg-indigo-600"></span>
      </span>
      <p class="text-xs text-slate-600">
        Reading <strong>${escapeHtml(formatNumber(m.pending))}</strong> more ${m.pending === 1 ? 'book' : 'books'} from Finology.
        Each is a separate page on their side, so they arrive a few at a time and the figures above fill in as they land.
      </p>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// The Live pill and its provenance modal
// ---------------------------------------------------------------------------------------

/**
 * The pill, which is the one always-visible statement of where these figures came from.
 *
 * IT MAY NOT SAY "LIVE" FOR BYTES NOBODY CONFIRMED IN THIS SESSION. It used to say it
 * unconditionally, in emerald, which was survivable while every paint really was a fresh read of
 * all ninety-one routes — and stopped being true the moment the grid could be painted from the
 * committed snapshot or from this device without asking anyone. `meta().origin` distinguishes the
 * three and this follows it: a file this deployment ships reads *Captured*, a copy this browser
 * kept reads *Cached*, and only a set of books confirmed against the server now reads *Live*.
 */
function livePill(m) {
  const done = m.pending === 0;
  const confirmed = m.origin === 'live';
  const label = confirmed ? 'Live' : m.origin === 'snapshot' ? 'Captured' : 'Cached';
  const cls = confirmed
    ? 'bg-emerald-50 text-emerald-800 ring-emerald-300 hover:bg-emerald-100'
    : 'bg-sky-50 text-sky-800 ring-sky-300 hover:bg-sky-100';
  const dot = confirmed
    ? done
      ? '<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>'
      : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>'
    : done
      ? '<span class="h-1.5 w-1.5 rounded-full bg-sky-500"></span>'
      : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500"></span></span>';
  return `
    <button type="button" data-si-info title="Where this comes from, and what is ours versus theirs"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}">
      ${dot}
      <span>${escapeHtml(label)}</span>
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.loadedBooks))} of ${escapeHtml(formatNumber(m.total))} books</span>
    </button>`;
}

function wireLivePill(root, m) {
  root.querySelector('[data-si-info]')?.addEventListener('click', () => {
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">Live superstar holdings</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          <p><strong>Real, live</strong> from <a class="font-semibold text-indigo-600 hover:underline" href="https://ticker.finology.in/superstar-portfolios" target="_blank" rel="noopener">Ticker Finology &rarr; Superstar Portfolios</a>,
             read through this dashboard's Worker because the API needs a credential the browser must never hold.</p>
          <p class="mt-2"><strong>${escapeHtml(formatNumber(m.total))}</strong> investors tracked ·
             <strong>${escapeHtml(formatNumber(m.loadedBooks))}</strong> books read${m.failedBooks ? ` · <strong class="text-amber-700">${escapeHtml(formatNumber(m.failedBooks))}</strong> could not be read` : ''}${m.pending ? ` · ${escapeHtml(formatNumber(m.pending))} still arriving` : ''}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Whose numbers these are</h3>
          <p class="mt-1 text-xs"><strong>Not ours.</strong> The holding percentage in every cell is what the company filed with the exchanges, as Finology publish it. The <strong>₹ value is Finology's own derivation</strong> from that percentage and a market cap — a filing never states a rupee amount. Both are reproduced unchanged.</p>
          <p class="mt-2 text-xs">The <strong>one figure this dashboard computes</strong> is the quarter-over-quarter change, which is their latest percentage minus their previous one. It is headed <em>Change (derived)</em> wherever it appears.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What a blank quarter means</h3>
          <p class="mt-1 text-xs">Finology print "-" where a holder does not appear on that quarter's shareholding pattern. Below the disclosure threshold a real holding is invisible, so a blank means <strong>not disclosed</strong> — not zero, and not necessarily sold. Every blank renders as an em dash and is excluded from totals rather than counted as nil.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How often it is read</h3>
          <p class="mt-1 text-xs">Once per visit, never polled: shareholding data moves when a company files, which is four times a year.</p>
          <p class="mt-2 text-xs">Every book is stored on this device under the server's own fingerprint, and a return visit <strong>paints from that store before asking the network anything</strong> — ninety-one confirmations, four at a time, was the wait, not the bytes.</p>
          <p class="mt-2 text-xs">Those confirmations are now skipped for any book the server vouched for <strong>within the last six hours</strong>, which is the window the Worker's own edge cache holds. Asking again inside it cannot learn anything new — the same bytes come back — so a quick return visit costs one request rather than ninety-one. A book that has never been read, or that arrived as a last-good copy during an outage, is always asked for.</p>
          ${deliveryNote({ origin: m.origin, checkedAt: m.checkedAt, fetchedAt: m.fetchedAt, persisted: m.persisted })}
          <p class="mt-3">
            <button type="button" data-si-reread
              class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
              Re-read everything now
            </button>
            <span class="ml-2 text-[11px] text-slate-400">Discards every confirmation and asks the source again.</span>
          </p>
          ${m.dropped ? `<p class="mt-3 text-xs text-amber-700">${escapeHtml(formatNumber(m.dropped))} investor${m.dropped === 1 ? '' : 's'} in their list carried no usable id and could not be opened, so ${m.dropped === 1 ? 'it is' : 'they are'} not shown.</p>` : ''}
        </div>
      </div>`,
      { size: 'default' }
    );

    // The escape hatch for the six-hour revalidation skip. It is what keeps that skip honest: a
    // reader who wants to know whether anything has moved since the last confirmation has a control
    // that asks, rather than a cache deciding on their behalf that the question is not worth a
    // request. Nothing calls this on a timer, and it is the only thing that clears a confirmation.
    document.getElementById('modal-content')?.querySelector('[data-si-reread]')?.addEventListener('click', () => {
      closeModal();
      feed.refresh();
    });
  });
}

// THERE IS NO FRESHNESS HERO ON THIS VIEW, deliberately.
//
// It used to carry a fourth, gradient "Last read · 6 minutes ago" card. Shareholding data moves
// when a company files — four times a year — so a relative clock ticking beside it invited the
// reader to read staleness into a number that had not changed and could not have. It was also the
// third thing on screen claiming to describe freshness, after the header's status pill and this
// view's own Live pill.
//
// The provenance did not go away: `deliveryNote()` inside the Live pill's modal still reports where
// the paint came from and when the server last confirmed it, which is the same fact stated once
// rather than three times. See "the header, and the alert stack" in CLAUDE.md — a freshness control
// that cannot be wrong is worth more than one that is merely present.

// ---------------------------------------------------------------------------------------
// The investor cards
// ---------------------------------------------------------------------------------------

/**
 * One investor.
 *
 * `imageUrl` is an address from an external API, so it is only ever used as an `src` when it is
 * an http(s) URL, and a failure to load falls back to the deterministic gradient mark used
 * everywhere else in the app rather than a broken image.
 */
function investorCard(inv) {
  const b = feed.book(inv.slug);
  const t = feed.totalsFor(inv.slug);
  const fail = feed.failureFor(inv.slug);
  const { color, initials } = avatarFor(inv.name || inv.slug);
  const portrait =
    inv.imageUrl && /^https?:\/\//i.test(inv.imageUrl)
      ? `<img src="${escapeHtml(inv.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
           class="h-11 w-11 flex-shrink-0 rounded-xl object-cover ring-1 ring-slate-200"
           onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-xs font-bold text-white',textContent:'${escapeHtml(initials)}'}))" />`
      : `<span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-xs font-bold text-white">${escapeHtml(initials)}</span>`;

  return `
    <button type="button" data-open-investor="${escapeHtml(inv.slug)}"
      class="flex flex-col rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <div class="flex items-center gap-3">
        ${portrait}
        <span class="min-w-0">
          <span class="block truncate font-display text-sm font-bold text-slate-900">${escapeHtml(inv.name || inv.slug)}</span>
          <span class="block truncate text-[11px] text-slate-500">${escapeHtml(b?.quarters?.[0] ? `as of ${b.quarters[0]}` : fail ? 'not read' : 'reading…')}</span>
        </span>
      </div>
      ${inv.bio ? `<p class="mt-2.5 line-clamp-2 text-[11px] leading-snug text-slate-500">${escapeHtml(inv.bio)}</p>` : ''}
      ${
        fail
          ? `<p class="mt-3 rounded-lg bg-amber-50 p-2 text-[11px] leading-snug text-amber-800 ring-1 ring-amber-200">This book could not be read${fail.reason === 'unauthorised' ? ' — the token was refused' : ''}. Not shown as empty.</p>`
          : b
            ? `<div class="mt-3 grid grid-cols-2 gap-2">
                 ${statCell(t?.disclosedCount, 'holdings')}
                 ${statCell(t?.valueCr == null ? null : cr(t.valueCr), 'book (Finology)', true)}
                 ${statCell(b.netWorthCr == null ? null : cr(b.netWorthCr), 'net worth', true)}
                 ${statCell(b.activeStocks == null ? null : `${formatNumber(b.activeStocks)}${b.totalStocks != null ? ` / ${formatNumber(b.totalStocks)}` : ''}`, 'active / total', true)}
               </div>`
            : `<div class="mt-3 h-[68px] animate-pulse rounded-lg bg-slate-50"></div>`
      }
    </button>`;
}

const statCell = (value, label, raw = false) => `
  <span class="rounded-lg bg-slate-50 px-2 py-1.5">
    <span class="block text-sm font-bold tabular-nums text-slate-900">${value == null ? dash : raw ? value : escapeHtml(formatNumber(value))}</span>
    <span class="block text-[10px] uppercase tracking-wide text-slate-400">${escapeHtml(label)}</span>
  </span>`;

function wireCards(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-investor]');
    if (btn) openInvestor(btn.dataset.openInvestor);
  });
}

// ---------------------------------------------------------------------------------------
// The all-positions table
//
// Thirteen-ish columns once a few quarters land, so it borrows the Institutions recipe wholesale:
// no rank, no avatar, dense padding, wrapped headings and a hard cap on the identity column. That
// combination is what keeps a wide numeric table inside 1440px instead of growing its own
// horizontal scrollbar — see the layout-knobs table in CLAUDE.md.
// ---------------------------------------------------------------------------------------

function holdingsTable(ctx, rows, quarters, initialView) {
  const investorNames = [...new Set(rows.map((r) => r.investor))].sort();

  return scoreTable({
    rows,
    key: (r) => `${r.slug}|${r.company}`,
    // NO STAR ON THIS TABLE. The watchlist is a list of NSE symbols — that is what every scope
    // filter on this dashboard matches — and this upstream discloses a company NAME and no symbol
    // at all. A star here would either store a name where a symbol is expected, which nothing could
    // match, or quietly do nothing at all; both are worse than not offering the control.
    watchKey: () => null,
    name: (r) => r.company,
    nameLabel: 'Company',
    sub: (r) => r.investor,
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 200,
    stickyHead: 'max(320px, calc(100vh - 340px))',
    columns: [
      ...quarters.map((q) => ({
        label: q,
        get: (r) => pct(r.quarterlyHoldings[q]),
        html: true,
        align: 'right',
        sortValue: (r) => r.quarterlyHoldings[q] ?? -1,
      })),
      {
        // Ours, and headed as such.
        label: 'Change (derived)',
        get: (r) => changeCell(r),
        html: true,
        align: 'right',
        sortValue: (r) => changeOf(r)?.deltaPp ?? -999,
      },
      {
        // STILL THEIRS, though the heading no longer says so. A filing states a percentage and
        // never a rupee amount, so this figure is Finology's derivation from that percentage and a
        // market cap — reproduced, not recomputed. The attribution moved off the column head and
        // onto the cell, into the Live pill's modal and into row 1 of the export, which is the one
        // place it cannot be skipped: a workbook travels without any of this page around it.
        label: 'Value',
        get: (r) =>
          r.valueCr == null
            ? dash
            : `<span title="Ticker Finology's own derivation from the holding percentage and a market cap — a filing never states a rupee amount">${cr(r.valueCr)}</span>`,
        html: true,
        align: 'right',
        sortValue: (r) => r.valueCr ?? -1,
      },
    ],
    filters: [
      {
        label: 'Investor',
        options: [{ value: 'all', label: 'All investors' }, ...investorNames.map((n) => ({ value: n, label: n }))],
        match: (r, v) => r.investor === v,
      },
      {
        label: 'This quarter',
        options: [
          { value: 'all', label: 'Any change' },
          { value: 'new', label: 'New positions' },
          { value: 'added', label: 'Added to' },
          { value: 'trimmed', label: 'Trimmed' },
          { value: 'exited', label: 'No longer disclosed' },
          { value: 'held', label: 'Unchanged' },
        ],
        match: (r, v) => changeOf(r)?.action === v,
      },
    ],
    searchable: (r) => `${r.company} ${r.investor} ${r.companySlug || ''}`,
    initialSort: { key: 'Value', dir: 'desc' },
    onRowClick: (r) => openInvestor(r.slug),
    exportName: `sattva-superinvestors-${todayStamp()}`,
    onExport: () => runExport(),
    emptyMessage: scopePossessive(ctx.scope) ? `None of ${scopePossessive(ctx.scope)} is disclosed by a tracked investor.` : 'No positions match your filters.',
    initialView,
  });
}

/** The derived move for one row, computed from the two most recent quarters of its own book. */
function changeOf(r) {
  const [latest, prior] = r.quarters || [];
  if (!latest || !prior) return null;
  const now = r.quarterlyHoldings[latest];
  const before = r.quarterlyHoldings[prior];
  if (now == null && before == null) return null;
  if (before == null) return { action: 'new', deltaPp: null };
  if (now == null) return { action: 'exited', deltaPp: null };
  const deltaPp = Math.round((now - before) * 100) / 100;
  return { action: deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held', deltaPp };
}

const ACTION = {
  new: ['New', 'bg-indigo-50 text-indigo-700 ring-indigo-200'],
  added: ['Added', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  held: ['Held', 'bg-slate-100 text-slate-600 ring-slate-200'],
  trimmed: ['Trimmed', 'bg-amber-50 text-amber-800 ring-amber-200'],
  exited: ['Undisclosed', 'bg-rose-50 text-rose-700 ring-rose-200'],
};

function changeCell(r) {
  const c = changeOf(r);
  if (!c) return `<span class="text-slate-300" title="Only one quarter is published for this investor, so there is nothing to compare.">—</span>`;
  const [label, cls] = ACTION[c.action];
  const delta =
    c.deltaPp == null
      ? ''
      : `<span class="mr-1.5 font-semibold tabular-nums ${c.deltaPp > 0 ? 'text-emerald-700' : c.deltaPp < 0 ? 'text-rose-700' : 'text-slate-400'}">${c.deltaPp > 0 ? '+' : ''}${c.deltaPp.toFixed(2)}pp</span>`;
  const why =
    c.action === 'exited'
      ? 'Not on the latest shareholding pattern. Below the disclosure threshold a holding is invisible, so this is "no longer disclosed", not necessarily "sold".'
      : c.action === 'new'
        ? 'Not disclosed in the prior quarter, disclosed in the latest.'
        : 'Latest disclosed percentage minus the prior one.';
  return `<span class="inline-flex items-center whitespace-nowrap" title="${escapeHtml(why)}">${delta}<span class="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${label}</span></span>`;
}

// ---------------------------------------------------------------------------------------
// One investor, as a workspace
// ---------------------------------------------------------------------------------------

let open = null;

export function openInvestor(slug) {
  const inv = feed.list().find((i) => i.slug === slug);
  const b = feed.book(slug);
  if (!inv && !b) return;
  open = { slug, inv, b };

  openWorkspace({
    title: b?.name || inv?.name || slug,
    subtitle: `Ticker Finology${b?.quarters?.length ? ` · ${b.quarters.length} quarters published · latest ${b.quarters[0]}` : ''}`,
    avatarName: b?.name || inv?.name || slug,
    badges: ['<span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">Filed holdings</span>'],
    actionsHtml: `<a href="${escapeHtml(FINOLOGY_INVESTOR(slug))}" target="_blank" rel="noopener" class="rounded-lg px-3 py-1.5 text-xs font-bold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50">Open on Finology ↗</a>`,
    tabs: [
      { id: 'holdings', label: 'Holdings', badge: b?.holdings?.length ?? undefined, render: holdingsPanel },
      { id: 'moves', label: 'This quarter', render: movesPanel },
      { id: 'profile', label: 'Profile', render: profilePanel },
    ],
    activeTab: 'holdings',
    onClose: () => (open = null),
  });
}

function holdingsPanel() {
  const b = open?.b;
  if (!b) return `<p class="py-10 text-center text-sm text-slate-500">This investor's book has not been read yet.</p>`;
  if (!b.holdings.length) return `<p class="py-10 text-center text-sm text-slate-500">Finology publish no positions for this investor.</p>`;
  // NO EXPLANATORY PARAGRAPH ABOVE THE TABLE. It said three things — the quarters are theirs, a
  // dash is "not disclosed" rather than zero, and the ₹ value is their derivation — on every visit
  // to every investor, above a table where the same facts are one hover away and already spelled
  // out in the Live pill's modal and in row 1 of the export. The disclosure did not go anywhere;
  // the repetition did.
  return `
    <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
      <table class="w-full text-sm">
        <thead class="bg-slate-50">
          <tr>
            <th scope="col" class="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-600">Company</th>
            ${b.quarters.map((q) => `<th scope="col" class="whitespace-nowrap px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-600">${escapeHtml(q)}</th>`).join('')}
            <th scope="col" title="Ticker Finology's own derivation from the holding percentage and a market cap — a filing never states a rupee amount" class="px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-600">Value</th>
          </tr>
        </thead>
        <tbody>
          ${b.holdings
            .map(
              (h) => `<tr class="border-t border-slate-100">
                <td class="px-3 py-2 font-semibold text-slate-900">${
                  h.companySlug ? `<a href="${escapeHtml(FINOLOGY_COMPANY(h.companySlug))}" target="_blank" rel="noopener" class="hover:text-indigo-700 hover:underline">${escapeHtml(h.company)}</a>` : escapeHtml(h.company)
                }</td>
                ${b.quarters.map((q) => `<td class="px-3 py-2 text-right tabular-nums text-slate-700">${pct(h.quarterlyHoldings[q])}</td>`).join('')}
                <td class="px-3 py-2 text-right tabular-nums text-slate-700">${cr(h.valueCr)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function movesPanel() {
  const { comparable, latest, prior, moves } = feed.movesFor(open?.slug);
  if (!comparable) {
    return `<p class="py-10 text-center text-sm text-slate-500">Finology publish only one quarter for this investor, so there is nothing to compare it against. No moves are shown rather than calling every position new.</p>`;
  }
  const order = ['new', 'added', 'trimmed', 'exited', 'held'];
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">
      <strong>Derived</strong> — ${escapeHtml(latest)} minus ${escapeHtml(prior)}, per company, from Finology's own disclosed percentages.
      A position appearing or disappearing carries no percentage-point figure, because a blank quarter means <em>not disclosed</em> rather than a trade of the whole holding.
    </p>
    ${order
      .map((action) => {
        const group = moves.filter((m) => m.action === action);
        if (!group.length) return '';
        const [label, cls] = ACTION[action];
        return `<div class="mb-4">
          <div class="mb-1.5 flex items-baseline gap-2">
            <span class="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${label}</span>
            <span class="text-xs text-slate-400">${group.length}</span>
          </div>
          <div class="grid gap-1.5 sm:grid-cols-2">
            ${group
              .map(
                (m) => `<div class="flex items-baseline justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
                  <span class="min-w-0 truncate text-sm text-slate-800">${escapeHtml(m.company)}</span>
                  <span class="flex-shrink-0 text-xs tabular-nums text-slate-500">${pct(m.before)} → ${pct(m.now)}${m.deltaPp != null ? ` <span class="${m.deltaPp > 0 ? 'text-emerald-700' : m.deltaPp < 0 ? 'text-rose-700' : ''}">(${m.deltaPp > 0 ? '+' : ''}${m.deltaPp.toFixed(2)}pp)</span>` : ''}</span>
                </div>`
              )
              .join('')}
          </div>
        </div>`;
      })
      .join('')}`;
}

function profilePanel() {
  const { inv, b, slug } = open || {};
  const t = feed.totalsFor(slug);
  const rows = [
    ['Name', b?.name || inv?.name],
    ['Finology id', slug],
    ['Net worth', b?.netWorthCr == null ? null : cr(b.netWorthCr)],
    ['Active stocks', b?.activeStocks == null ? null : formatNumber(b.activeStocks)],
    ['Total stocks', b?.totalStocks == null ? null : formatNumber(b.totalStocks)],
    ['Quarters published', b?.quarters?.length ? `${b.quarters.length} — ${b.quarters.join(', ')}` : null],
    ['Positions listed', t ? formatNumber(t.rowCount) : null],
    ['Disclosed in the latest quarter', t ? formatNumber(t.disclosedCount) : null],
    ['Book value (Finology)', t?.valueCr == null ? null : `${cr(t.valueCr)} across ${formatNumber(t.valuedCount)} of ${formatNumber(t.rowCount)} positions`],
  ];
  return `
    ${inv?.bio ? `<p class="mb-4 text-sm leading-relaxed text-slate-700">${escapeHtml(inv.bio)}</p>` : '<p class="mb-4 text-sm text-slate-400">Finology publish no biography for this investor.</p>'}
    <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      ${rows
        .map(
          ([k, v]) => `<div class="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1">
            <dt class="text-xs text-slate-500">${escapeHtml(k)}</dt>
            <dd class="text-right text-sm font-semibold text-slate-900">${v == null ? dash : v}</dd>
          </div>`
        )
        .join('')}
    </dl>
    <p class="mt-4 text-xs leading-relaxed text-slate-500">
      Every field above is exactly as the Ticker Finology API returns it. Where one is blank the source did not publish it — nothing here is inferred or filled in.
    </p>`;
}

// ---------------------------------------------------------------------------------------
// Scope, totals and the export
// ---------------------------------------------------------------------------------------

/**
 * Universe is every disclosed position; Portfolio and Watchlist narrow to companies the reader has
 * a stake in.
 *
 * MATCHED BY NAME, NOT BY TICKER, because that is all this upstream gives: Finology's books carry
 * a company name and no symbol. The watchlist carries the name the row was starred under, which is
 * the same kind of string, so the two scopes use one comparison.
 */
/**
 * ONE PREDICATE, used by the summary AND by the table under it.
 *
 * `null` means "this scope does not narrow" — the same convention `scopeTickers()` uses, and for
 * the same reason: an empty watchlist must narrow to nothing rather than to everything.
 *
 * It is factored out because the summary panels and the all-positions table answer the same
 * question about the same companies. Two predicates over one question is what had the filings
 * tabs reporting different sets in two places on one screen.
 */
function scopeFilter(ctx) {
  if (ctx.scope === 'universe') return null;
  const names = (
    ctx.scope === 'watchlist'
      ? watchlist.all().map((w) => String(w.name || ''))
      : coverage.holdings().map((h) => String(h.name || ''))
  )
    .map((n) => n.toLowerCase())
    .filter(Boolean);
  return (company) => names.some((n) => String(company).toLowerCase().includes(n.slice(0, 12)));
}

function scopedHoldings(ctx) {
  const all = feed.allHoldings();
  const include = scopeFilter(ctx);
  if (!include) return all;
  return all.filter((r) => include(r.company));
}

/**
 * Rows still disclosed in their own book's latest quarter.
 *
 * `allHoldings()` returns every company that has ever appeared in a book, because the table shows
 * the full quarterly history. A "combined book" figure must not: summing positions that dropped
 * off the shareholding pattern quarters ago would state as currently held something the source
 * stopped disclosing.
 */
const stillHeld = (rows) => rows.filter((r) => r.latest && r.quarterlyHoldings[r.latest] != null);

const sumValue = (rows) => {
  const valued = stillHeld(rows).filter((r) => r.valueCr != null);
  return valued.length ? Math.round(valued.reduce((a, r) => a + r.valueCr, 0) * 100) / 100 : null;
};
const valuedNote = (rows) => {
  const held = stillHeld(rows);
  const valued = held.filter((r) => r.valueCr != null).length;
  if (!held.length) return 'no positions are disclosed in the latest quarter';
  return valued === held.length
    ? `Finology’s value, all ${formatNumber(held.length)} currently disclosed positions`
    : `Finology’s value, ${formatNumber(valued)} of ${formatNumber(held.length)} currently disclosed positions carry one`;
};
const coverageNote = (rows, quarters) => {
  const total = sumValue(rows);
  // The value clause drops out entirely when nothing carries one, rather than printing a nil: a
  // feed with no valued position and a feed worth zero are different claims.
  const value = total == null ? null : `${formatCroreCompact(total)} — ${valuedNote(rows)}`;
  return [
    `${formatNumber(rows.length)} investor-company rows`,
    `${quarters.length} quarter${quarters.length === 1 ? '' : 's'} published`,
    value,
    'a dash is a quarter with no disclosure, not a zero',
  ]
    .filter(Boolean)
    .join(' · ');
};

async function runExport() {
  const m = feed.meta();
  const quarters = feed.quarterLabels();
  const rows = feed.allHoldings();
  await exportSheets({
    filename: `sattva-superinvestors-${todayStamp()}`,
    banner:
      `REAL FILED HOLDINGS, NOT OURS. Superstar investor shareholdings via Ticker Finology (ticker.finology.in), read ${new Date().toISOString()}. ` +
      `Each percentage is what the company filed with the exchanges for that quarter, as Finology publish it. The "Value Cr (Finology)" column is THEIR derivation ` +
      `from that percentage and a market cap — a shareholding filing never states a rupee amount. A BLANK QUARTER MEANS NOT DISCLOSED, NOT ZERO: below the ` +
      `disclosure threshold a real holding is invisible, so it is neither a nil position nor necessarily a sale. The only figure computed by this dashboard is ` +
      `"Change (derived)", the latest disclosed percentage minus the prior one.`,
    sheets: [
      {
        name: 'Holdings',
        columns: [
          { header: 'Investor', width: 26, get: (r) => r.investor },
          { header: 'Finology Id', width: 22, get: (r) => r.slug },
          { header: 'Company', width: 34, get: (r) => r.company },
          { header: 'Company Id', width: 24, get: (r) => r.companySlug || '' },
          ...quarters.map((q) => ({ header: `${q} %`, width: 13, get: (r) => (r.quarterlyHoldings[q] == null ? '' : r.quarterlyHoldings[q]) })),
          { header: 'Value Cr (Finology)', width: 20, get: (r) => (r.valueCr == null ? '' : r.valueCr) },
        ],
        rows,
      },
      {
        name: 'Investors',
        columns: [
          { header: 'Investor', width: 26, get: (r) => r.name },
          { header: 'Finology Id', width: 22, get: (r) => r.slug },
          { header: 'Net Worth Cr', width: 16, get: (r) => (r.netWorthCr == null ? '' : r.netWorthCr) },
          { header: 'Active Stocks', width: 14, get: (r) => (r.activeStocks == null ? '' : r.activeStocks) },
          { header: 'Total Stocks', width: 14, get: (r) => (r.totalStocks == null ? '' : r.totalStocks) },
          { header: 'Quarters Published', width: 40, get: (r) => (r.quarters || []).join(' | ') },
          { header: 'Bio', width: 70, get: (r) => feed.list().find((i) => i.slug === r.slug)?.bio || '' },
        ],
        rows: feed.books(),
      },
      {
        name: 'This quarter (derived)',
        columns: [
          { header: 'Investor', width: 26, get: (r) => r.investor },
          { header: 'Company', width: 34, get: (r) => r.company },
          { header: 'Action', width: 14, get: (r) => r.action },
          { header: 'Prior %', width: 12, get: (r) => (r.before == null ? '' : r.before) },
          { header: 'Latest %', width: 12, get: (r) => (r.now == null ? '' : r.now) },
          { header: 'Change pp', width: 12, get: (r) => (r.deltaPp == null ? '' : r.deltaPp) },
          { header: 'Value Cr (Finology)', width: 20, get: (r) => (r.valueCr == null ? '' : r.valueCr) },
        ],
        rows: feed.allMoves(),
      },
    ],
  });
  return m;
}
