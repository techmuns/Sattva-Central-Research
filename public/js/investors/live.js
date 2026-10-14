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

import { rankedList, scoreTable, sectionHead, openWorkspace, openModal } from '../ui/screener.js';
import { tabBar } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCroreCompact, formatRelativeTime, formatDate } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as feed from '../data/super-investors.js';
import * as coverage from '../data/coverage.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import { scopePossessive, scopeLabel } from '../data/scope.js';
// The ONE classifier — this view used to carry a second copy of it. See `classifyHolding` there.
import { classifyHolding, companyKey, filedPair, isMove, quarterOrder } from '../data/finology-shared.js';
import { deriveMoves, comparisonPeriods, disclosureStatus, periodEnd } from '../data/finology-shared.js';
import { renderChanges } from './changes.js';
import { wireIntegrity, ensureHoldingsFresh, associatedEvidenceHtml } from './integrity.js';
import { loadEvidence } from '../data/holding-evidence.js';
import * as publicHoldings from '../data/public-holdings.js';
import { publicDisclosuresHtml, wirePublicDisclosures } from './public-disclosures.js';
import { sectionsFor, renderManagers } from './my-managers.js';

const SOURCE = 'Ticker Finology via this dashboard’s Worker; scheduled daily and checked automatically while visible. Exchange completeness is unverified.';
const FINOLOGY_COMPANY = (slug) => `https://ticker.finology.in/company/${encodeURIComponent(slug)}`;

const dash = '<span class="text-slate-300">—</span>';
const pct = (v) => (v == null ? dash : `${Number(v).toFixed(2)}%`);
const cr = (v) => (v == null ? dash : formatCroreCompact(v));
// THE DATE A SHAREHOLDING PATTERN STATES THE HOLDING ON is the quarter end its label names. Every
// row that compares two patterns prints both dates rather than leaving "Jun 2026" to imply one —
// and never a trade date, because a pattern carries none. `readDate` is the separate fact of when
// this dashboard last read the source for that book.
const patternDate = (label) => (periodEnd(label) ? formatDate(periodEnd(label)) : label || '—');
const patternSpan = (prior, latest) => `${patternDate(prior)} → ${patternDate(latest)}`;
const readDate = (at) => (Number.isFinite(Date.parse(at || '')) ? formatDate(at) : '—');

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

const SECTIONS = [
  { id: 'investors', label: 'All Investors' },
  { id: 'quarterly-changes', label: 'Changes' },
  { id: 'data-table', label: 'Data Table' },
];

export function renderLive(ctx, { disposers = [], section = 'quarterly-changes', tableView, onView, onSection, changesView, onChangesView, managersView, onManagersView, embedded = false, toolbarControls, overviewView = {}, onOverviewView = () => {} } = {}) {
  const m = feed.meta();

  disposers.push(feed.watchFreshness(), publicHoldings.watchFreshness());
  const rows = scopedHoldings(ctx);
  const quarters = feed.quarterLabels();
  const investorList = feed.list();
  const sections = sectionsFor(SECTIONS);
  const activeSection = sections.some((item) => item.id === section) ? section : sections[0].id;
  const sectionTabs = tabBar({ tabs: sections, activeId: activeSection, onSelect: onSection || (() => {}) });

  const summary = activeSection === 'quarterly-changes' ? renderChanges(ctx, { view: changesView, onView: onChangesView, openInvestor, includeHolding: scopeFilter(ctx), embedded, toolbarControls }) : null;
  const mine = activeSection === 'my-managers' ? renderManagers(ctx, { view: managersView, onView: onManagersView }) : null;
  const table = activeSection === 'data-table' ? holdingsTable(ctx, rows, quarters, tableView, { embedded, toolbarControls, onFilterChange: () => onView?.(table.view) }) : null;
  if (table) onView?.(table.view);

  const panel =
    mine ? mine.html : activeSection === 'quarterly-changes'
      ? summary.html
      : !feed.isLoaded()
      ? '<div role="status" aria-busy="true" class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"><span class="sr-only">Loading investor holdings…</span></div>'
      : !m.ok
      ? unavailableHtml(m)
      : activeSection === 'data-table'
        ? `
        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">All disclosed positions</span>
          <span class="text-[11px] text-slate-400">${escapeHtml(coverageNote(rows, quarters))}</span>
        </div>
        ${table.html}`
        : `${embedded ? `<div class="investor-overview-controls"><label>Find an investor<input data-investor-search type="search" aria-label="Search investors" value="${escapeHtml(overviewView.query || '')}" placeholder="Investor name"></label>${toolbarControls?.html || ''}</div>` : ''}<div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-investor-cards>${investorList.map(investorCard).join('')}</div><p data-investor-empty class="text-sm text-slate-500" hidden>No matching investors. Try another name or clear the search.</p>`;

  ctx.root.innerHTML = `
    ${embedded ? '' : sectionHead({
      title: 'Superstar Investors',
      description: 'Follow your managers and tracked investors through holdings, ledger activity and reported bulk/block deals.',
    })}
    ${feed.isLoaded() && !m.ok && activeSection === 'quarterly-changes' && changesView?.audience === 'investors' ? unavailableHtml(m) : ''}
    ${embedded ? '' : `<div class="mb-5 rounded-2xl bg-white px-3 shadow-sm ring-1 ring-slate-100" data-live-section-tabs>
      ${sectionTabs.html}
    </div>`}
    <div role="tabpanel" aria-label="${escapeHtml(sections.find((item) => item.id === activeSection)?.label || '')}" data-live-panel="${escapeHtml(activeSection)}">
      ${panel}
    </div>`;

  // The sources the audit reads are revalidated on mount whether or not the audit is opened:
  // "refresh on opening" is a standing requirement, not a side effect of a panel.
  ensureHoldingsFresh().catch(() => {});

  if (!embedded) disposers.push(sectionTabs.wire(ctx.root.querySelector('[data-live-section-tabs]')));
  summary?.wire(ctx.root, disposers);
  mine?.wire(ctx.root, disposers);
  if (table) disposers.push(table.wire(ctx.root));
  if (activeSection === 'investors') {
    wireCards(ctx.root);
    const search = ctx.root.querySelector('[data-investor-search]');
    if (search) {
      const filter = () => {
        overviewView.query = search.value; onOverviewView(overviewView);
        const cards = [...ctx.root.querySelector('[data-investor-cards]').children];
        cards.forEach((card, index) => card.hidden = !investorList[index].name.toLowerCase().includes(search.value.trim().toLowerCase()));
        ctx.root.querySelector('[data-investor-empty]').hidden = cards.some(card => !card.hidden);
      };
      search.addEventListener('input', filter); filter();
      disposers.push(toolbarControls?.wire?.(ctx.root));
    }
  }
}


// ---------------------------------------------------------------------------------------
// THE QUARTER, ACROSS EVERY BOOK — the Quarterly Changes in-page tab
//
// This roll-up replaced three KPI cards: investors tracked, combined book value, and a
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

function quarterSummaryBlock(ctx, m) {
  const include = scopeFilter(ctx);
  const q = feed.quarterSummary({ include, limit: 5 });
  const openCompany = (item) => openCompanyDetail(item, q);
  const scope = scopeLabel(ctx.scope);
  const universe = ctx.scope !== 'universe' ? feed.quarterSummary({ include: scopeFilter({ scope: 'universe' }), limit: 0 }) : q;
  const empty = (what) => q.comparableBooks === 0
    ? `No comparable books are available for ${scope}.`
    : `No ${what} found in the available ${scope} disclosures for ${q.latest} vs ${q.prior}.`;
  const sourceDates = feed.books().map((b) => Date.parse(b.sourceCheckedAt || b.fetchedAt || ''));
  const sourceDate = sourceDates.length && sourceDates.every(Number.isFinite)
    ? new Date(Math.min(...sourceDates)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unavailable';

  const panels = [
    rankedList({
      key: 'si-consensus-buys',
      title: 'Increased or new stakes · 2+ investors',
      note: 'Higher or newly disclosed stakes in the same quarter pair. This does not establish purchases.',
      items: q.consensusBuys.map((c) => ({
        name: c.company,
        company: c.company,
        companySlug: c.companySlug,
        sub: `${andOthers(c.investors.map((i) => i.investor))} · ${patternSpan(q.prior, q.latest)}`,
        value: `${c.count} investors`,
        badge: c.sumPp != null ? pp(c.sumPp) : null,
        tone: 'pos',
      })),
      empty: empty('shared increases or new disclosures'),
      onSelect: openCompany,
    }),
    rankedList({
      key: 'si-new',
      title: 'Newly disclosed',
      note: 'Disclosed now but absent in the comparison quarter; this may be a re-entry. Ranked by reported stake.',
      items: q.newEntrants.map((mv) => ({
        name: mv.company,
        company: mv.company,
        companySlug: mv.companySlug,
        sub: `${mv.investor} · ${patternSpan(mv.prior, mv.latest)}`,
        value: mv.now == null ? '—' : `${Number(mv.now).toFixed(2)}%`,
        tone: 'pos',
      })),
      empty: empty('new disclosures'),
      onSelect: openCompany,
    }),
    rankedList({
      key: 'si-adds',
      title: 'Largest increases',
      note: 'Percentage points of the company, latest quarter minus the one before — derived.',
      items: q.topAdds.map((mv) => ({ name: mv.company, company: mv.company, companySlug: mv.companySlug, sub: `${mv.investor} · ${patternSpan(mv.prior, mv.latest)}`, value: pp(mv.deltaPp), tone: 'pos' })),
      empty: empty('stake increases'),
      onSelect: openCompany,
    }),
    rankedList({
      key: 'si-consensus-exits',
      title: 'Reduced or undisclosed · 2+ investors',
      note: 'Lower or no longer disclosed stakes in the same quarter pair. This does not establish sales.',
      items: q.consensusExits.map((c) => ({
        name: c.company,
        company: c.company,
        companySlug: c.companySlug,
        sub: `${andOthers(c.investors.map((i) => i.investor))} · ${patternSpan(q.prior, q.latest)}`,
        value: `${c.count} investors`,
        badge: c.sumPp != null ? pp(c.sumPp) : null,
        tone: 'neg',
      })),
      empty: empty('shared reductions or disclosure removals'),
      onSelect: openCompany,
    }),
    rankedList({
      key: 'si-trims',
      title: 'Largest reductions',
      note: 'Percentage points of the company, latest quarter minus the one before — derived.',
      items: q.topTrims.map((mv) => ({ name: mv.company, company: mv.company, companySlug: mv.companySlug, sub: `${mv.investor} · ${patternSpan(mv.prior, mv.latest)}`, value: pp(mv.deltaPp), tone: 'neg' })),
      empty: empty('stake reductions'),
      onSelect: openCompany,
    }),
    rankedList({
      key: 'si-exits',
      title: 'No longer disclosed',
      note: 'Off the shareholding pattern this quarter. Below the disclosure threshold that is not the same as sold.',
      items: q.exits.map((mv) => ({
        name: mv.company,
        company: mv.company,
        companySlug: mv.companySlug,
        sub: `${mv.investor} · ${patternSpan(mv.prior, mv.latest)}`,
        // The stake they last disclosed, labelled as the prior quarter's — NOT a size for the
        // exit, which has none. An em dash where even that is missing.
        value: mv.before == null ? '—' : `was ${Number(mv.before).toFixed(2)}%`,
        tone: 'neg',
      })),
      empty: empty('confirmed disclosure removals'),
      onSelect: openCompany,
    }),
  ];

  const html = `
    <section class="mb-6" data-quarter-summary>
      ${summaryHead(q, scope)}
      <div class="mb-3 rounded-xl bg-white px-4 py-3 text-xs text-slate-500 ring-1 ring-slate-200" data-si-coverage>
        <p><strong>${escapeHtml(scope)} companies</strong> · ${q.comparableBooks} of ${m.total} tracked books have the same comparison pair · ${q.coveredBooks} contain data in this scope.</p>
        <p class="mt-1">${q.loadedBooks} books loaded · ${q.missingBooks} unavailable · ${q.excludedBooks.length} excluded for missing comparison quarters · ${q.counts.awaiting} incomplete positions in this scope.</p>
        <p class="mt-1">${q.latest && q.prior ? `Patterns dated ${escapeHtml(patternSpan(q.prior, q.latest))} — a shareholding pattern states the holding on the quarter end and carries no trade date. ` : ''}Ticker Finology · read ${escapeHtml(sourceDate)}. Results cover available disclosures and may change as data arrives.</p>
        ${ctx.scope !== 'universe' ? `<button type="button" data-si-universe class="mt-2 font-semibold text-indigo-600 hover:underline">View Universe: ${universe.consensusBuyCount} ${universe.consensusBuyCount === 1 ? 'company' : 'companies'} with shared increases or new disclosures</button>` : ''}
      </div>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${panels.map((p) => p.html).join('')}</div>
    </section>`;

  function wire(root, disposers) {
    for (const panel of panels) disposers.push(panel.wire(root));
    root.querySelector('[data-si-universe]')?.addEventListener('click', () => {
      const [path, search = ''] = location.hash.split('?');
      const params = new URLSearchParams(search);
      params.set('scope', 'universe');
      location.hash = `${path}?${params}`;
    });
  }

  return { html, wire };
}

/**
 * The provenance modal: the derivation prose, the freshness paragraph and — beneath them — the
 * coverage audit, painted live into its own host and disposed with the modal. `onClose` is what
 * releases the audit's subscriptions; without it every open would stack another repainter.
 */
function openDerivation(q, m) {
  const audit = [];
  openModal(summaryHelpBody(q, m), { size: 'wide', onClose: () => audit.forEach((d) => d?.()) });
  const host = document.getElementById('modal-content')?.querySelector('[data-holdings-integrity]');
  if (host) wireIntegrity(host, audit, openInvestor);
}

const COMPANY_ACTION = {
  new: ['Newly disclosed', 'bg-indigo-50 text-indigo-700 ring-indigo-200'],
  added: ['Increased', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  held: ['Unchanged', 'bg-slate-100 text-slate-600 ring-slate-200'],
  trimmed: ['Reduced', 'bg-amber-50 text-amber-800 ring-amber-200'],
  exited: ['No longer disclosed', 'bg-rose-50 text-rose-700 ring-rose-200'],
  awaiting: ['Incomplete data', 'bg-slate-100 text-slate-500 ring-slate-200'],
  unknown: ['Not comparable', 'bg-slate-100 text-slate-500 ring-slate-200'],
};

/**
 * One company across every tracked book, opened from any Quarterly Changes row.
 *
 * The summary card is intentionally compact, so a consensus row shortens three names to "+1" and
 * a largest-move row shows only the investor who produced that ranked move. The drill must not
 * inherit either shortcut: it reads the full holdings set and includes every investor whose own
 * latest/prior pair contains the company, including an unchanged holder. That is what answers
 * "which investors hold this, and how much?" rather than merely expanding the text already shown.
 */
function openCompanyDetail(item, comparison) {
  const company = item.company || item.name;
  const details = feed
    .allHoldings()
    .filter((r) => companyKey(r) === companyKey({ company, companySlug: item.companySlug }))
    .map((r) => {
      const { latest, prior } = comparisonPeriods(r);
      const now = latest ? r.quarterlyHoldings[latest] : null;
      const before = prior ? r.quarterlyHoldings[prior] : null;
      return { ...r, latest, prior, now, before, change: classifyHolding(r, latest, prior) };
    })
    // A disclosure that ended before both comparison quarters is real history, but it did not
    // contribute to the quarter the reader clicked. Keeping it out prevents an old holder from
    // looking like a current participant. A one-quarter book with a current stake still belongs.
    .filter((r) => r.now != null || r.before != null)
    .sort((a, b) => (b.now != null) - (a.now != null) || (b.now ?? -1) - (a.now ?? -1) || a.investor.localeCompare(b.investor));

  const current = details.filter((r) => r.now != null).length;
  const changed = details.filter((r) => isMove(r.change?.action)).length;
  const rows = details
    .map((r) => {
      const action = r.change?.action || 'unknown';
      const [label, cls] = COMPANY_ACTION[action] || COMPANY_ACTION.unknown;
      const delta = r.change?.deltaPp;
      const deltaClass = delta > 0 ? 'text-emerald-700' : delta < 0 ? 'text-rose-700' : 'text-slate-400';
      const currentValue = r.now != null && r.valueCr != null ? formatCroreCompact(r.valueCr) : '—';
      return `
        <tr class="border-t border-slate-100" data-company-investor-row>
          <td class="px-3 py-3 align-top">
            <a href="https://ticker.finology.in/investor/${encodeURIComponent(r.slug)}" target="_blank" rel="noopener" class="font-semibold text-indigo-600 hover:underline">${escapeHtml(r.investor)}</a>
          </td>
          <td class="whitespace-nowrap px-3 py-3 align-top">
            <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(label)}</span>
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top">
            <span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(r.prior ? `${r.prior} · ${patternDate(r.prior)}` : 'Not published')}</span>
            <span class="mt-0.5 block font-semibold tabular-nums text-slate-700">${r.before == null ? escapeHtml(r.quarterlyNotes?.[r.prior] || '—') : escapeHtml(`${Number(r.before).toFixed(2)}%`)}</span>
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top">
            <span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(r.latest ? `${r.latest} · ${patternDate(r.latest)}` : 'Not published')}</span>
            <span class="mt-0.5 block font-semibold tabular-nums text-slate-900">${r.now == null ? escapeHtml(r.quarterlyNotes?.[r.latest] || '—') : escapeHtml(`${Number(r.now).toFixed(2)}%`)}</span>
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top font-semibold tabular-nums ${deltaClass}">${delta == null ? dash : escapeHtml(pp(delta))}</td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top font-semibold tabular-nums text-slate-700">${escapeHtml(currentValue)}</td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top tabular-nums text-slate-500" title="When this dashboard last read the source for this investor's book">${escapeHtml(readDate(r.fetchedAt))}</td>
        </tr>`;
    })
    .join('');

  openModal(
    `<div class="scrollbar-thin max-h-[82vh] overflow-y-auto" data-company-investor-detail>
      <div class="sticky top-0 z-10 border-b border-slate-100 bg-white px-6 py-5  sm:px-7">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[11px] font-bold uppercase tracking-wider text-indigo-600">Across all superstar investors</p>
            <h2 class="font-display mt-1 text-xl font-bold text-slate-900">${escapeHtml(company)}</h2>
            <p class="mt-1 text-xs text-slate-500">
              ${escapeHtml(formatNumber(details.length))} tracked investor${details.length === 1 ? '' : 's'} in the latest comparison ·
              ${escapeHtml(formatNumber(current))} currently disclosed · ${escapeHtml(formatNumber(changed))} changed
            </p>
          </div>
          <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
      </div>
      <div class="px-6 py-5 sm:px-7">
        <p class="mb-4 text-xs leading-relaxed text-slate-500">
          Percentages use ${escapeHtml(comparison.latest || 'unavailable')} vs ${escapeHtml(comparison.prior || 'unavailable')}, the same pair as the summary — patterns dated ${escapeHtml(patternSpan(comparison.prior, comparison.latest))}; a pattern carries no trade date. Investor names link to the source.
          <strong class="text-slate-600">Current value is Finology's estimate of the position now, not an amount bought or sold.</strong>
          A dash means not disclosed, not zero.
        </p>
        <div class="table-scroll-surface overflow-x-auto rounded-xl ring-1 ring-slate-200" tabindex="0" role="region" aria-label="Company investor comparison table">
          <table data-column-layout="live:1" class="min-w-[850px] w-full text-sm">
            <thead class="bg-slate-50">
              <tr>
                <th scope="col" class="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">Investor</th>
                <th scope="col" class="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">Status</th>
                <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Previous stake</th>
                <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Current stake</th>
                <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Change (derived)</th>
                <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Current value (Finology)</th>
                <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Source read</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="7" class="px-4 py-10 text-center text-sm text-slate-500">No comparable investor disclosure is available for this company.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>`,
    { size: 'wide' }
  );
}

/**
 * The heading, and the counts the removed tile carried.
 *
 * `clause()` is the Sources-modal rule applied here: a figure goes at the END of a sentence that
 * survives without it, so a count of zero drops its clause rather than printing "0 new".
 */
function summaryHead(q, scope) {
  const c = q.counts;
  const clause = (n, text) => (n ? text : null);
  const parts = [
    clause(c.new, `${formatNumber(c.new)} new`),
    clause(c.added, `${formatNumber(c.added)} increased`),
    clause(c.trimmed, `${formatNumber(c.trimmed)} reduced`),
    clause(c.exited, `${formatNumber(c.exited)} no longer disclosed`),
  ].filter(Boolean);
  // Said separately from the moves, because it is not one. See `counts` in data/super-investors.js.
  const outstanding = c.awaiting ? `${formatNumber(c.awaiting)} position${c.awaiting === 1 ? '' : 's'} with incomplete comparison data` : null;

  const span =
    q.pairs.length === 1 && q.pairs[0].latest
      ? `${escapeHtml(q.pairs[0].latest)} vs ${escapeHtml(q.pairs[0].prior)}`
      : 'No complete quarter pair';

  return `
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-display text-lg font-bold text-slate-900">Quarterly changes · ${escapeHtml(scope)}</h2>
      <button type="button" data-summary-help
        class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        <span>How this is derived</span><span aria-hidden="true">?</span>
      </button>
    </div>
    <p class="mb-3 text-xs text-slate-500">
      ${parts.length ? `${escapeHtml(parts.join(' · '))} across ${formatNumber(q.contributingBooks)} of ${formatNumber(q.comparableBooks)} comparable books` : 'No reportable changes found in the available scoped disclosures.'}
      <span class="text-slate-400">· ${span}${outstanding ? ` · ${escapeHtml(outstanding)}` : ''}</span>
    </p>`;
}

/**
 * The provenance door for everything the head no longer prints.
 *
 * The amber strip and the coverage block's diagnostics line both came out of the chrome, and this
 * is where they went — NOT where they were deleted. "An explanation with no door is worse than no
 * explanation": what a reader gets on the page is the age, and what they get when they ask is the
 * whole mechanism, the upstream's own words for the failure included.
 */
function freshnessProvenance(m) {
  const read = Date.parse(m.fetchedAt || m.capturedAt || '');
  const where =
    m.origin === 'live'
      ? 'Every book on screen was confirmed against the source in this session.'
      : m.origin === 'snapshot'
        ? 'Books are painted from the capture this deployment ships, which is committed on a schedule.'
        : 'Books are painted from the copy this browser kept from an earlier visit.';
  // A retained book whose latest re-check did not answer is real filed data of a known age. It is
  // stated as exactly that, and never as a book that could not be read — that phrase is reserved
  // for an investor with nothing to show, which is a different fact.
  const unchecked = Number(m.uncheckedBooks || 0);
  const missing = Number(m.failedBooks || 0);
  return `
    <p><strong>Freshness.</strong> ${Number.isFinite(read) ? `The source was last read ${escapeHtml(formatRelativeTime(read))}.` : 'The source read time is not recorded.'} ${escapeHtml(where)}
    Shareholding data changes when a company files, so a reading of this age is normally the same figure the source would give now.</p>
    ${
      m.stale || unchecked || missing
        ? `<p><strong>What did not answer.</strong> ${[
            m.stale ? 'The source did not answer the latest check, so the Worker served the last good read it already held rather than nothing at all.' : null,
            unchecked ? `${formatNumber(unchecked)} book${unchecked === 1 ? '' : 's'} on screen could not be re-checked just now and ${unchecked === 1 ? 'is' : 'are'} shown at the age above — real filed holdings, not estimates.` : null,
            missing ? `${formatNumber(missing)} tracked investor${missing === 1 ? ' has' : 's have'} no book available at all and ${missing === 1 ? 'is' : 'are'} shown as such rather than as an empty book.` : null,
          ]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' ')}${m.staleReason ? ` <span class="font-mono text-[11px] text-slate-500">${escapeHtml(m.staleReason)}</span>` : ''}</p>`
        : ''
    }`;
}

function summaryHelpBody(q, m = {}) {
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
        <p>Finology publishes a holding <strong>percentage</strong> per company per quarter. Changes subtract the prior percentage from the latest one. Counts and rankings are derived from those disclosures; these are not independently verified exchange filings.</p>
        <p><strong>Every book uses the same comparison pair:</strong> ${escapeHtml(q.latest || 'unavailable')} vs ${escapeHtml(q.prior || 'unavailable')}. Only consecutive calendar quarters that have ended are eligible. ${q.excludedBooks.length} loaded books lack this pair and are excluded; the dashboard does not mix older periods into this quarter.</p>
        <p><strong>A missing or conflicting figure is incomplete data.</strong> Filing notes survive the feed and cache. An unavailable prior quarter cannot establish a new entrant. Only an explicit non-disclosure in the source establishes that a prior stake is no longer disclosed. A zero valuation cannot turn a missing stake into an exit.</p>
        <p><strong>A blank is not zero, and a new disclosure is not necessarily a new investment.</strong> A holder may reappear or cross the disclosure threshold. Appearances and disappearances carry no percentage-point trade size.</p>
        <p><strong>Stake changes do not establish purchases or sales.</strong> Issuance, buybacks and other changes in share capital can change ownership percentages. Current rupee values estimate holdings, not money traded.</p>
        <p><strong>Shared changes count distinct investors in the same company and quarter pair.</strong> Source company identifiers join names; duplicate rows never add votes. A combined percentage-point change is shown only when every included change has a measured delta.</p>
        <p><strong>The selected scope filters companies.</strong> Portfolio and Watchlist results do not describe the whole Universe. Missing books, excluded periods and incomplete positions are shown above the cards; an empty card means no match in the available data, not proof of no activity.</p>
        <p><strong>Every row is dated.</strong> A shareholding pattern states the holding on the quarter end its label names — ${escapeHtml(q.latest && q.prior ? patternSpan(q.prior, q.latest) : 'the two quarter ends compared')} — and carries no trade date, so no row here implies a day inside the quarter. "Source read" is the separate date this dashboard last read the source for that book.</p>
        ${freshnessProvenance(m)}
      </div>
      <section class="mt-5 border-t border-slate-100 pt-4" data-holdings-integrity aria-label="Coverage and source checks"></section>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// States where there is nothing to show — and each says which
// ---------------------------------------------------------------------------------------

const REASONS = {
  'no-route': {
    title: 'Investor holdings unavailable',
    body: 'The investor source is unavailable at this address. Please open Sattva Central Research from your usual dashboard link.',
  },
  'no-token': {
    title: 'Investor source access unavailable',
    body: 'Access to the investor source needs attention. Please check back.',
  },
  unauthorised: {
    title: 'Investor source access unavailable',
    body: 'The investor source could not be accessed. Please check back.',
  },
  // This is a deployment fact, not a data condition, so it says so rather than implying the
  // investor list came back empty. The credential is fine; the endpoint is simply not there.
  'route-missing': {
    title: 'Investor holdings unavailable',
    body: 'The investor source could not be found. Please check back.',
  },
  timeout: {
    title: 'Investor source took too long to respond',
    body: 'Holdings could not be checked. Please try again later.',
  },
  unreachable: { title: 'Investor source could not be reached', body: 'Holdings could not be checked. Please try again later.' },
  upstream: { title: 'Investor holdings temporarily unavailable', body: 'The source did not supply a usable holdings book. Please check back.' },
  shape: { title: 'Investor holdings could not be verified', body: 'The source reading was incomplete or invalid. Please check back.' },
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
function unavailableHtml(m) {
  const r = REASONS[m.reason] || REASONS.upstream;
  const operator = m.reason === 'no-token' || m.reason === 'unauthorised';
  return `
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
          <p class="mt-3 text-xs leading-relaxed text-slate-500">
            No verified holdings are available to display. This does not establish that an investor has no holdings.
          </p>
        </div>
      </div>
    </div>`;
}

// THERE IS NO FRESHNESS HERO ON THIS VIEW, deliberately.
//
// It used to carry a fourth, gradient "Last read · 6 minutes ago" card. Shareholding data moves
// when a company files — four times a year — so a relative clock ticking beside it invited the
// reader to read staleness into a number that had not changed and could not have. It was also the
// third thing on screen claiming to describe freshness, after the header's status control and the
// old per-view status pill. Superstar Investors now relies on that one global control and keeps the
// source attribution in its description, cells and exports rather than adding more chrome.

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
  // Only a genuine gap — an investor with NO book. A retained book whose latest re-check did not
  // answer is not a failure to report on the card: the figures below are that investor's real
  // filed holdings, and the honest statement about them is their age, which the one freshness
  // label in the head already makes for the whole view. See `failureFor` in the data module.
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
          <span class="block truncate text-[11px] text-slate-500">${escapeHtml(t?.latestQuarter ? `${t.latestQuarter} disclosures · as of ${patternDate(t.latestQuarter)}${t.offCycleCount ? ` · ${t.offCycleCount} later updates` : ''}` : fail ? 'no book published' : 'reading…')}</span>
        </span>
      </div>
      ${inv.bio ? `<p class="mt-2.5 line-clamp-2 text-[11px] leading-snug text-slate-500">${escapeHtml(inv.bio)}</p>` : ''}
      ${
        // THE BOOK LEADS, AND ONLY A GENUINE GAP GETS A PANEL. This used to ask `fail` first and
        // print an amber "Refresh failed" strip, which was right while `failureFor` also answered
        // for a retained book whose latest re-check did not answer. It no longer does — that is
        // `uncheckedFor`, a freshness condition the head's one label already states for the whole
        // view — so an alarm here could only ever sit over an investor who has no book at all,
        // which is an absence and not a failure.
        b
          ? `<div class="mt-3 grid grid-cols-2 gap-2">
               ${statCell(t?.disclosedCount, 'quarter disclosures')}
               ${statCell(t?.valueCr == null ? null : cr(t.valueCr), 'book (Finology)', true)}
               ${statCell(b.netWorthCr == null ? null : cr(b.netWorthCr), 'net worth', true)}
               ${statCell(b.activeStocks == null ? null : `${formatNumber(b.activeStocks)}${b.totalStocks != null ? ` / ${formatNumber(b.totalStocks)}` : ''}`, 'active / total', true)}
             </div>${t?.missingValues ? `<p class="mt-2 text-xs text-amber-800">${t.missingValues} disclosed stakes lack usable valuations.</p>` : ''}`
          : fail
            ? // `Not shown as empty` stays: a fund that discloses nothing and a fund whose book
              // could not be read must never render the same, and the muted register is the point —
              // this is an absence, in the same voice as every other absence on the page.
              `<p class="mt-3 rounded-lg bg-slate-50 p-2 text-[11px] leading-snug text-slate-500">No book published for this investor yet. Not shown as empty.</p>`
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

function holdingsTable(ctx, rows, quarters, initialView, { embedded = false, toolbarControls, onFilterChange } = {}) {
  const investorNames = [...new Set(rows.map((r) => r.investor))].sort();

  return scoreTable({
    rows,
    bookmarkDate: () => quarters[0],
    bookmarkSource: row => row.investor,
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
        get: (r) => r.quarterlyHoldings[q] == null && r.quarterlyNotes?.[q] ? escapeHtml(r.quarterlyNotes[q]) : pct(r.quarterlyHoldings[q]),
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
        // onto the cell and into row 1 of the export, which is the one place it cannot be skipped:
        // a workbook travels without any of this page around it.
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
          { value: 'awaiting', label: 'Incomplete data' },
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
    toolbarControls, onFilterChange, showWatchFilter: embedded ? 'selected' : true,
  });
}

/**
 * The derived move for one row, asked of the SHARED classifier rather than re-implemented.
 *
 * This function used to hold its own copy of the five branches, reading `quarters[0]` and `[1]`
 * directly — so when a book's newest column was an unfiled "Filing Due" period it printed
 * "Undisclosed" against a company the investor plainly still held, and it would have gone on
 * printing it after `deriveMoves` was fixed. See `classifyHolding` in js/data/finology-shared.js.
 */
function changeOf(r) {
  const d = deriveMoves({ quarters: r.quarters, holdings: [r] });
  // The pair the move was measured on travels with it, so the cell can print both pattern dates.
  return d.moves[0] ? { ...d.moves[0], latest: d.latest, prior: d.prior } : null;
}

const ACTION = {
  unknown: ['Unconfirmed', 'bg-slate-100 text-slate-600 ring-slate-200'],
  awaiting: ['Filing due', 'bg-slate-100 text-slate-600 ring-slate-200'],
  new: ['Newly disclosed', 'bg-indigo-50 text-indigo-700 ring-indigo-200'],
  added: ['Added', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  held: ['Held', 'bg-slate-100 text-slate-600 ring-slate-200'],
  trimmed: ['Trimmed', 'bg-amber-50 text-amber-800 ring-amber-200'],
  exited: ['Undisclosed', 'bg-rose-50 text-rose-700 ring-rose-200'],
  // NEUTRAL, AND DELIBERATELY NOT ROSE. An outstanding filing is the absence of an answer, not a
  // negative one; giving it the exit's colour would put a sale back on the screen in everything
  // but the word.
  awaiting: ['Incomplete data', 'bg-slate-100 text-slate-500 ring-slate-200'],
};

function changeCell(r) {
  const c = changeOf(r);
  if (!c) return `<span class="text-slate-300" title="No comparable consecutive completed quarters are available.">—</span>`;
  const [label, cls] = ACTION[c.action];
  const delta =
    c.deltaPp == null
      ? ''
      : `<span class="mr-1.5 font-semibold tabular-nums ${c.deltaPp > 0 ? 'text-emerald-700' : c.deltaPp < 0 ? 'text-rose-700' : 'text-slate-400'}">${c.deltaPp > 0 ? '+' : ''}${c.deltaPp.toFixed(2)}pp</span>`;
  const why =
    c.action === 'exited'
      ? 'Not on the latest shareholding pattern. Below the disclosure threshold a holding is invisible, so this is "no longer disclosed", not necessarily "sold".'
      : ['unknown', 'awaiting'].includes(c.action) ? 'A missing or awaited source cell cannot establish a purchase or sale.'
      : c.action === 'new'
        ? 'Not disclosed in the prior quarter, disclosed in the latest.'
        : 'Latest disclosed percentage minus the prior one.';
  // THREE LINES, NO NEW COLUMN. The two pattern dates and the source-read date are two different
  // facts and both belong on every row — but a column for the second put the table 118px into its
  // own horizontal scroll at 1440px (measured: 1,359px → 1,470px against a 1,352px viewport). The
  // change cell already stacks, so the dates stack beneath the badge and the width stays where it
  // was; the export carries the same two dates as their own columns, where width costs nothing.
  return `<span class="inline-flex flex-col items-end whitespace-nowrap" title="${escapeHtml(why)}"><span class="inline-flex items-center">${delta}<span class="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${label}</span></span><span class="mt-0.5 text-[10px] tabular-nums text-slate-400" data-pattern-dates>${escapeHtml(patternSpan(c.prior, c.latest))}</span><span class="text-[10px] tabular-nums text-slate-400" data-source-read title="When this dashboard last read the source for this investor's book">read ${escapeHtml(readDate(r.fetchedAt))}</span></span>`;
}

// ---------------------------------------------------------------------------------------
// One investor, as a workspace
// ---------------------------------------------------------------------------------------

let open = null;

export async function openInvestor(slug) {
  await Promise.all([loadEvidence(), publicHoldings.load()]);
  const inv = feed.list().find((i) => i.slug === slug);
  const b = feed.book(slug);
  if (!inv && !b) return;
  open = { slug, inv, b };

  openWorkspace({
    title: b?.name || inv?.name || slug,
    avatarName: b?.name || inv?.name || slug,
    tabs: [
      { id: 'holdings', label: 'Holdings', badge: b?.holdings?.length ?? undefined, render: holdingsPanel, wire: (host) => wirePublicDisclosures(host, slug, 'investor', true) },
      { id: 'exchange', label: 'Exchange disclosures', badge: publicHoldings.forPerson(slug).length || undefined,
        render: () => publicDisclosuresHtml(slug), wire: (host) => wirePublicDisclosures(host, slug) },
      { id: 'moves', label: 'Quarterly comparison', render: movesPanel },
      { id: 'profile', label: 'Profile', render: profilePanel },
    ],
    activeTab: 'holdings',
    onClose: () => (open = null),
  });
}

function holdingsPanel() {
  const b = open?.b;
  const primary = publicDisclosuresHtml(open?.slug, 'investor', true);
  if (!b) return primary + `<p class="py-10 text-center text-sm text-slate-500">This investor's source book has not been read yet.</p>`;
  if (!b.holdings.length) return primary + `<p class="py-10 text-center text-sm text-slate-500">No dated holdings were supplied by the secondary source.</p>`;
  // NO EXPLANATORY PARAGRAPH ABOVE THE TABLE. It said three things — the quarters are theirs, a
  // dash is "not disclosed" rather than zero, and the ₹ value is their derivation — on every visit
  // to every investor, above a table where the same facts are one hover away and already spelled
  // out in row 1 of the export. The disclosure did not go anywhere; the repetition did.
  return `
    ${primary}
    ${publicHoldings.forPerson(open?.slug).length ? '' : associatedEvidenceHtml(open?.slug)}
    <p class="mb-3 text-xs text-slate-500">Dated source disclosures. Off-cycle columns cover individual updates. Unconfirmed cells have no reliable filing status; they do not establish a purchase or sale.</p>
    <div class="table-scroll-surface overflow-x-auto rounded-xl ring-1 ring-slate-200" tabindex="0" role="region" aria-label="Investor holdings table">
      <table data-column-layout="live:2" class="w-full text-sm">
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
                ${b.quarters.map((q) => `<td class="px-3 py-2 text-right tabular-nums text-slate-700">${h.quarterlyHoldings[q] != null ? pct(h.quarterlyHoldings[q]) : disclosureStatus(h, q) === 'filing_due' ? 'Filing due' : disclosureStatus(h, q) === 'not_disclosed' ? 'Not disclosed' : 'Unconfirmed'}</td>`).join('')}
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
    return `<p class="py-10 text-center text-sm text-slate-500">Two consecutive completed calendar quarters are needed for a comparison. Partial monthly filings remain in Holdings.</p>`;
  }
  const order = ['new', 'added', 'trimmed', 'exited', 'awaiting', 'unknown', 'held'];
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">
      <strong>Derived</strong> — ${escapeHtml(latest)} minus ${escapeHtml(prior)}, per company, from Finology's own disclosed percentages.
      The two patterns state the holding on <strong>${escapeHtml(patternDate(prior))}</strong> and <strong>${escapeHtml(patternDate(latest))}</strong>; a pattern carries no trade date. Source read ${escapeHtml(readDate(open?.b?.sourceCheckedAt || open?.b?.fetchedAt))}.
      Only consecutive completed quarters are compared. Filing due and unexplained blanks are unconfirmed; an explicit missing disclosure does not prove a sale.
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
                (m) => `<div class="rounded-lg bg-slate-50 px-3 py-1.5">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="min-w-0 truncate text-sm text-slate-800">${escapeHtml(m.company)}</span>
                    <span class="flex-shrink-0 text-xs tabular-nums text-slate-500">${pct(m.before)} → ${pct(m.now)}${m.deltaPp != null ? ` <span class="${m.deltaPp > 0 ? 'text-emerald-700' : m.deltaPp < 0 ? 'text-rose-700' : ''}">(${m.deltaPp > 0 ? '+' : ''}${m.deltaPp.toFixed(2)}pp)</span>` : ''}</span>
                  </div>
                  <div class="mt-0.5 text-[11px] tabular-nums text-slate-400" data-pattern-dates>${escapeHtml(patternSpan(prior, latest))}</div>
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
    ['Disclosed in the latest completed quarter', t ? formatNumber(t.disclosedCount) : null],
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
  const normalName = (name) => String(name || '').toLowerCase().replace(/\b(limited|ltd)\b/g, '').replace(/[^a-z0-9]/g, '');
  const entries = ctx.scope === 'universe' ? scopeLists.removed('universe')
    : ctx.scope === 'watchlist' ? watchlist.all() : coverage.holdings();
  if (ctx.scope === 'universe' && !entries.length) return null;
  const tickers = new Set(entries.map((e) => String(e.ticker || '').toUpperCase()).filter(Boolean));
  const names = new Set(entries.map((e) => normalName(e.name)).filter(Boolean));
  return (company, holding = {}) => {
    const match = tickers.has(String(holding.companySlug || '').toUpperCase()) || names.has(normalName(company));
    return ctx.scope === 'universe' ? !match : match;
  };
}

function scopedHoldings(ctx) {
  const all = feed.allHoldings();
  const include = scopeFilter(ctx);
  if (!include) return all;
  return all.filter((r) => include(r.company, r));
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
  const held = stillHeld(rows);
  const valued = held.filter((r) => r.valueCr != null && (r.valueCr > 0 || r.pct === 0));
  return valued.length === held.length && valued.length ? Math.round(valued.reduce((a, r) => a + r.valueCr, 0) * 100) / 100 : null;
};
const valuedNote = (rows) => {
  const held = stillHeld(rows);
  const valued = held.filter((r) => r.valueCr != null && (r.valueCr > 0 || r.pct === 0)).length;
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
    `${quarters.length} reporting periods published`,
    value,
    'a blank is unconfirmed unless the source explicitly identifies an absent disclosure',
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
      `from that percentage and a market cap — a shareholding filing never states a rupee amount. BLANK CELLS ARE UNCONFIRMED unless the source explicitly distinguishes filing due from not disclosed. Below the ` +
      `disclosure threshold a real holding is invisible, so it is neither a nil position nor necessarily a sale. The only figure computed by this dashboard is ` +
      `"Change (derived)", comparing consecutive completed calendar quarters. Unknown/awaited cells do not establish purchases or sales. ` +
      `DATES: a pattern date is the quarter end the shareholding pattern states the holding on; "Source read" is when this dashboard last read the source. A pattern carries no trade date.`,
    sheets: [
      {
        name: 'Holdings',
        columns: [
          { header: 'Investor', width: 26, get: (r) => r.investor },
          { header: 'Finology Id', width: 22, get: (r) => r.slug },
          { header: 'Company', width: 34, get: (r) => r.company },
          { header: 'Company Id', width: 24, get: (r) => r.companySlug || '' },
          ...quarters.flatMap((q) => [{ header: `${q} %`, width: 13, get: (r) => r.quarterlyHoldings[q] ?? '' }, { header: `${q} status`, width: 18, get: (r) => disclosureStatus(r, q) }]),
          { header: 'Value Cr (Finology)', width: 20, get: (r) => (r.valueCr == null ? '' : r.valueCr) },
          { header: 'Latest pattern date', width: 18, get: (r) => periodEnd(r.latest) || '' },
          { header: 'Source read', width: 22, get: (r) => r.fetchedAt || '' },
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
        name: 'Quarter comparison (derived)',
        columns: [
          { header: 'Investor', width: 26, get: (r) => r.investor },
          { header: 'Company', width: 34, get: (r) => r.company },
          { header: 'Action', width: 14, get: (r) => r.action },
          { header: 'Prior period', width: 16, get: (r) => r.prior },
          { header: 'Prior pattern date', width: 18, get: (r) => periodEnd(r.prior) || '' },
          { header: 'Latest period', width: 16, get: (r) => r.latest },
          { header: 'Latest pattern date', width: 18, get: (r) => periodEnd(r.latest) || '' },
          { header: 'Prior status', width: 18, get: (r) => r.beforeStatus },
          { header: 'Latest status', width: 18, get: (r) => r.nowStatus },
          { header: 'Prior %', width: 12, get: (r) => (r.before == null ? '' : r.before) },
          { header: 'Latest %', width: 12, get: (r) => (r.now == null ? '' : r.now) },
          { header: 'Change pp', width: 12, get: (r) => (r.deltaPp == null ? '' : r.deltaPp) },
          { header: 'Value Cr (Finology)', width: 20, get: (r) => (r.valueCr == null ? '' : r.valueCr) },
          { header: 'Source read', width: 22, get: (r) => feed.book(r.slug)?.fetchedAt || '' },
        ],
        rows: feed.allMoves(),
      },
    ],
  });
  return m;
}
