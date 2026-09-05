// investors/filed.js — the REAL half of the Institutions view.
//
//   renderFiled(ctx, { disposers })   the fund picker, the identity block and the holdings table
//
// EVERY NUMBER IN HERE IS SOMEBODY'S DISCLOSURE. There are two kinds of them and the entire file is
// organised around not letting them blur, because they are both "a percentage against a company"
// and they measure opposite things:
//
//   `shareholding`  Trendlyne, quarterly. The COMPANY files who owns it. The percentage is HOW MUCH
//                   OF THE COMPANY this fund holds. Only holders above 1% are named at all, so the
//                   list is the fund's large positions and nothing else. The rupee value is
//                   Trendlyne's derivation — a filing never states one.
//
//   `portfolio`     the AMC, monthly. The FUND publishes its own book. The percentage is % TO NAV,
//                   HOW MUCH OF THE FUND is in that company. Every line appears however small, and
//                   the rupee value is the AMC's own published figure.
//
// A 2.5 in one is a large stake in a company; a 2.5 in the other is a small slice of a fund. So the
// column headings differ, the pill differs, the provenance modal differs, the drill differs and the
// export banner differs — and `columnsFor()` is the one place that decides which. What does NOT
// differ is the furniture: same table, same sorting, same watchlist, same layout knobs, because the
// reader is doing the same job in both.
//
// NOT ONE FIGURE ON THIS PANEL IS AVERAGED WITH A SYNTHETIC ONE, and no headline number is summed
// across the two kinds. A "combined book" adding a stake in a company to a slice of a fund would be
// arithmetic on two different units.

import { rankedList, scoreTable, sectionHead, openDrill, openModal } from '../ui/screener.js';
import { scopeSummary, tabBar } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { scopePossessive } from '../data/scope.js';
import { formatNumber, formatCroreCompact, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as filed from '../data/institution-holdings.js';
import * as coverage from '../data/coverage.js';

const isFiling = (fund) => fund.disclosure !== 'portfolio';

/** The one-line description under the title, which has to say which measurement is on screen. */
const DESCRIPTION = {
  shareholding:
    'Indian shareholdings as filed with the exchanges, quarter by quarter. The percentage is how much of each company the fund owns. Share counts and holding percentages are the filings; the ₹ value is Trendlyne’s own derivation.',
  portfolio:
    'The fund’s own portfolio as the AMC discloses it, month by month. The percentage is % to NAV — how much of the fund sits in each company, not how much of the company it owns. Weights and values are the AMC’s published figures.',
};

const SECTIONS = [
  { id: 'institutions', label: 'All Institutions' },
  { id: 'quarterly-changes', label: 'Quarterly Changes' },
];

export function renderFiled(ctx, { disposers = [], section = 'institutions', onSection } = {}) {
  const funds = filed.all();
  const m = filed.meta();
  if (!funds.length) return { html: '', wire: () => {} };

  const wanted = ctx.params?.fund;
  const fund = funds.find((f) => f.investorId === wanted) || funds[0];
  const activeSection = SECTIONS.some((item) => item.id === section) ? section : SECTIONS[0].id;
  const sectionTabs = tabBar({ tabs: SECTIONS, activeId: activeSection, onSelect: onSection || (() => {}) });

  if (activeSection === 'quarterly-changes') {
    const summary = quarterSummaryBlock(ctx);
    return {
      html: `
        ${sectionHead({
          title: 'Institutions',
          description:
            'Quarterly exchange-filed shareholdings across every tracked institution. Monthly AMC portfolios stay in All Institutions because % to NAV measures something different.',
        })}
        <div class="mb-5 rounded-2xl bg-white px-3 shadow-sm ring-1 ring-slate-100" data-filed-section-tabs>
          ${sectionTabs.html}
        </div>
        <div role="tabpanel" aria-label="Quarterly Changes" data-filed-panel="quarterly-changes">
          ${summary.html}
        </div>`,
      wire(root) {
        disposers.push(sectionTabs.wire(root.querySelector('[data-filed-section-tabs]')));
        summary.wire(root, disposers);
      },
    };
  }

  const rows = filed.holdingsForScope(ctx.scope, coverage.holdings(), fund.holdings);
  const label0 = fund.periodLabels[0];
  const filing = isFiling(fund);

  const table = scoreTable({
    rows,
    // An AMC line that resolved to no NSE symbol still needs a stable id for the watchlist, so the
    // instrument name stands in. It is unique within a fund — the importer merges a company's
    // repeat spells into one row and fails the run on two companies sharing a symbol.
    key: (r) => r.ticker || r.name,
    // An AMC line that resolved to no NSE symbol has a row key but nothing to track: the watchlist
    // matches symbols, so a name would sit in it matching nothing for ever.
    watchKey: (r) => r.ticker || null,
    watchName: (r) => r.name,
    name: (r) => r.name,
    nameLabel: filing ? 'Stock' : 'Instrument',
    // The ticker earns the sub-line because it is the join key everywhere else in the dashboard.
    // Where an AMC line has none, saying so beats a blank: the row is still a real holding, it is
    // simply one this dashboard cannot cross-reference. The drill gives the reason.
    sub: (r) => r.ticker || (filing ? '' : 'no NSE symbol'),
    // No rank column: this is a portfolio, and "#7" against a value-sorted list is a position in
    // the current sort rather than a ranking of anything. The watchlist star moves into the
    // identity cell, which is what `showRank: false` does.
    showRank: false,
    dense: true,
    wrapHeads: true,
    // No gradient mark: the identity column is text, and the ~46px it costs is exactly what a
    // ten-to-thirteen column table needs to stop truncating company names.
    showAvatar: false,
    nameMaxPx: filing ? 165 : 210,
    stickyHead: 'max(320px, calc(100vh - 300px))',
    columns: columnsFor(fund),
    filters: filtersFor(fund),
    searchable: (r) => `${r.name} ${r.ticker || ''} ${r.sector || ''} ${r.industry || ''}`,
    initialView: ctx.params?.company ? { q: String(ctx.params.company).trim().toUpperCase() } : null,
    initialSort: { key: filing ? 'Holding Value' : 'Value (AMC)', dir: 'desc' },
    onRowClick: (r) => drillHolding(r, fund),
    exportName: `sattva-${fund.investorId}-holdings`,
    onExport: (visible) => exportFund(visible, fund),
    emptyMessage: scopePossessive(ctx.scope) ? `This fund holds none of ${scopePossessive(ctx.scope)}.` : 'No holding matches your filters.',
  });

  // ONE TABLE AND NOTHING ELSE, the way the Earnings Hub is built. No stat strip, no ranking grid:
  // this is a portfolio listing and the reader came for the rows. The provenance did not go away —
  // it moved behind the pill, which is one click from anywhere on the page. See the "honesty rules
  // for the kit" section of CLAUDE.md: decluttering is fine, deleting the accountability is not.
  const html = `
    ${sectionHead({
      title: 'Institutions',
      description: DESCRIPTION[filing ? 'shareholding' : 'portfolio'],
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${disclosurePill(fund)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'holdings', book: coverage.meta() })}</div>`,
    })}
    <div class="mb-5 rounded-2xl bg-white px-3 shadow-sm ring-1 ring-slate-100" data-filed-section-tabs>
      ${sectionTabs.html}
    </div>
    ${funds.length > 1 ? fundPicker(funds, fund) : ''}
    <div role="tabpanel" aria-label="All Institutions" data-filed-panel="institutions">
      <div class="mb-4 flex flex-wrap items-center gap-3">
        ${avatarBlock(fund)}
        <div class="min-w-0 flex-1">
          <div class="font-display text-base font-bold text-slate-900">${escapeHtml(fund.name)}</div>
          <div class="text-xs text-slate-500">${escapeHtml(identityLine(fund, label0))}</div>
        </div>
        <a href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener"
           class="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">${escapeHtml(filing ? 'Trendlyne source ↗' : 'Bandhan source ↗')}</a>
      </div>
      ${table.html}
    </div>
  `;

  return {
    html,
    wire(root) {
      disposers.push(sectionTabs.wire(root.querySelector('[data-filed-section-tabs]')));
      const off = table.wire(root);
      if (off) disposers.push(off);
      for (const btn of root.querySelectorAll('[data-fund]')) {
        btn.addEventListener('click', () => ctx.setParams({ ...ctx.params, fund: btn.dataset.fund }));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// THE QUARTER ACROSS INSTITUTION BOOKS
//
// Only `shareholding` books enter this view. AMC books publish monthly portfolio weights (% to
// NAV), so putting them beside quarterly stakes (% of a company) would make two opposite measures
// look like one ranking. They remain fully available under All Institutions.
// ---------------------------------------------------------------------------------------

const filingPp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} pp`);
const filingPct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const andOthers = (names) => (names.length <= 2 ? names.join(' & ') : `${names[0]}, ${names[1]} +${names.length - 2}`);

function quarterSummaryBlock(ctx) {
  const book = coverage.holdings();
  const include = (row) => filed.holdingsForScope(ctx.scope, book, [row]).length > 0;
  const q = filed.quarterlySummary({ include, limit: 5 });
  const openCompany = (item) => openInstitutionCompany(item.companyKey || item.key);

  const panels = [
    rankedList({
      key: 'institution-consensus-buys',
      title: 'Added by more than one institution',
      note: 'Increased, or newly disclosed, by two or more quarterly filing books.',
      items: q.consensusBuys.map((item) => ({
        name: item.company,
        companyKey: item.key,
        sub: andOthers(item.institutions.map((i) => i.institution)),
        value: `${item.count} institutions`,
        badge: item.sized ? filingPp(item.sumPp) : null,
        tone: 'pos',
      })),
      empty: 'No company was added by more than one institution this quarter.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'institution-new',
      title: 'New entrants',
      note: 'First quarter disclosed. Ranked by the stake now held — an appearance has no trade size.',
      items: q.newEntrants.map((row) => ({
        name: row.company,
        companyKey: row.key,
        sub: row.institution,
        value: filingPct(row.now),
        tone: 'pos',
      })),
      empty: 'No new position was disclosed this quarter.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'institution-adds',
      title: 'Largest increases',
      note: 'Percentage points of the company, latest filed quarter minus the one before — derived.',
      items: q.topAdds.map((row) => ({
        name: row.company,
        companyKey: row.key,
        sub: row.institution,
        value: filingPp(row.deltaPp),
        tone: 'pos',
      })),
      empty: 'No filed position was increased this quarter.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'institution-consensus-exits',
      title: 'Reduced by more than one institution',
      note: 'Trimmed, or no longer disclosed, by two or more quarterly filing books.',
      items: q.consensusExits.map((item) => ({
        name: item.company,
        companyKey: item.key,
        sub: andOthers(item.institutions.map((i) => i.institution)),
        value: `${item.count} institutions`,
        badge: item.sized ? filingPp(item.sumPp) : null,
        tone: 'neg',
      })),
      empty: 'No company was reduced by more than one institution this quarter.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'institution-trims',
      title: 'Largest reductions',
      note: 'Percentage points of the company, latest filed quarter minus the one before — derived.',
      items: q.topTrims.map((row) => ({
        name: row.company,
        companyKey: row.key,
        sub: row.institution,
        value: filingPp(row.deltaPp),
        tone: 'neg',
      })),
      empty: 'No filed position was reduced this quarter.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'institution-exits',
      title: 'No longer disclosed',
      note: 'Off the shareholding pattern this quarter. Below the disclosure threshold is not the same as sold.',
      items: q.exits.map((row) => ({
        name: row.company,
        companyKey: row.key,
        sub: row.institution,
        value: row.before == null ? '—' : `was ${filingPct(row.before)}`,
        tone: 'neg',
      })),
      empty: 'Every position disclosed last quarter is still disclosed.',
      onSelect: openCompany,
    }),
  ];

  return {
    html: `
      <section class="mb-6" data-institution-quarter-summary>
        ${institutionSummaryHead(q)}
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${panels.map((panel) => panel.html).join('')}</div>
      </section>`,
    wire(root, disposers) {
      for (const panel of panels) disposers.push(panel.wire(root));
      root.querySelector('[data-institution-summary-help]')?.addEventListener('click', () =>
        openModal(institutionSummaryHelp(q), { size: 'wide' })
      );
    },
  };
}

function institutionSummaryHead(q) {
  const c = q.counts;
  const parts = [
    c.new ? `${formatNumber(c.new)} new` : null,
    c.added ? `${formatNumber(c.added)} increased` : null,
    c.trimmed ? `${formatNumber(c.trimmed)} reduced` : null,
    c.exited ? `${formatNumber(c.exited)} no longer disclosed` : null,
  ].filter(Boolean);
  const span =
    q.pairs.length === 1
      ? `${escapeHtml(q.pairs[0].latest)} vs ${escapeHtml(q.pairs[0].prior)}`
      : `${formatNumber(q.pairs.length)} different quarter pairs`;

  return `
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-display text-lg font-bold text-slate-900">The quarter across institution filings</h2>
      <button type="button" data-institution-summary-help
        class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        <span>How this is derived</span><span aria-hidden="true">?</span>
      </button>
    </div>
    <p class="mb-3 text-xs text-slate-500">
      ${parts.length ? `${escapeHtml(parts.join(' · '))} across ${formatNumber(q.contributingBooks)} of ${formatNumber(q.comparableBooks)} comparable institution books` : 'No position moved in a comparable institution book.'}
      <span class="text-slate-400"> · ${span}${q.singleQuarterBooks ? ` · ${formatNumber(q.singleQuarterBooks)} book${q.singleQuarterBooks === 1 ? '' : 's'} publish only one quarter` : ''}</span>
    </p>`;
}

function institutionSummaryHelp(q) {
  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">How the institution quarter is derived</h2>
          <p class="mt-1 text-sm text-slate-500">Exchange-filed shareholdings aggregated by Trendlyne.</p>
        </div>
        <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="space-y-3 text-[13px] leading-relaxed text-slate-700">
        <p><strong>Only quarterly shareholding books are included.</strong> The Bandhan AMC books are monthly portfolios whose percentage is % to NAV. Mixing them with a filed stake in a company would compare two different measurements, so they remain in All Institutions.</p>
        <p>For each institution, the latest filed holding percentage is compared with the quarter before it. A measured increase or reduction is the difference in <strong>percentage points of the company</strong> — the only figure calculated here.</p>
        <p><strong>A blank is not zero.</strong> A new appearance is labelled newly disclosed, and a disappearance is labelled no longer disclosed because falling below the disclosure threshold is not proof of a sale. Neither is assigned an invented trade size.</p>
        <p><strong>Filing Awaited is never treated as an exit.</strong> A company can still be held while its newest shareholding pattern is pending; that row contributes no move until the filing arrives.</p>
        <p><strong>Consensus is only a count.</strong> It says how many tracked institution books moved on the same company, not a score, weight or recommendation. Current rupee values are Trendlyne's derivations, not amounts bought or sold.</p>
        ${q.pairs.length > 1 ? `<p>The current institution data spans ${formatNumber(q.pairs.length)} different latest/prior quarter pairs, so each book is compared against its own two newest published quarters.</p>` : ''}
      </div>
    </div>`;
}

const INSTITUTION_ACTION = {
  new: ['Newly disclosed', 'bg-indigo-50 text-indigo-700 ring-indigo-200'],
  added: ['Increased', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  held: ['Unchanged', 'bg-slate-100 text-slate-600 ring-slate-200'],
  trimmed: ['Reduced', 'bg-amber-50 text-amber-800 ring-amber-200'],
  exited: ['No longer disclosed', 'bg-rose-50 text-rose-700 ring-rose-200'],
  awaiting: ['Filing awaited', 'bg-amber-50 text-amber-800 ring-amber-200'],
  unknown: ['Not comparable', 'bg-slate-100 text-slate-500 ring-slate-200'],
};

function openInstitutionCompany(key) {
  const details = filed.quarterlyCompany(key);
  const company = details[0]?.company || 'Company';
  const ticker = details[0]?.ticker || null;
  const current = details.filter((row) => row.now != null).length;
  const awaiting = details.filter((row) => row.action === 'awaiting').length;
  const changed = details.filter((row) => ['new', 'added', 'trimmed', 'exited'].includes(row.action)).length;
  const rows = details
    .map((row) => {
      const [label, cls] = INSTITUTION_ACTION[row.action] || INSTITUTION_ACTION.unknown;
      const deltaClass = row.deltaPp > 0 ? 'text-emerald-700' : row.deltaPp < 0 ? 'text-rose-700' : 'text-slate-400';
      return `
        <tr class="border-t border-slate-100" data-company-institution-row>
          <td class="px-3 py-3 align-top">
            <div class="font-semibold text-slate-900">${escapeHtml(row.institution)}</div>
            ${row.house || row.category ? `<div class="mt-0.5 text-[11px] text-slate-500">${escapeHtml([row.house, row.category].filter(Boolean).join(' · '))}</div>` : ''}
          </td>
          <td class="whitespace-nowrap px-3 py-3 align-top"><span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(label)}</span></td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top">
            <span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(row.prior || 'Not published')}</span>
            <span class="mt-0.5 block font-semibold tabular-nums text-slate-700">${row.before == null ? dash('not disclosed in the prior quarter') : escapeHtml(filingPct(row.before))}</span>
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top">
            <span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(row.latest || 'Not published')}</span>
            <span class="mt-0.5 block font-semibold tabular-nums text-slate-900">${row.now == null ? dash(row.action === 'awaiting' ? 'the latest filing is awaited' : 'not disclosed in the latest quarter') : escapeHtml(filingPct(row.now))}</span>
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top font-semibold tabular-nums ${deltaClass}">${row.deltaPp == null ? dash('no measurable percentage-point change') : escapeHtml(filingPp(row.deltaPp))}</td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top font-semibold tabular-nums text-slate-700">${row.valueCr == null ? dash('no current value published') : escapeHtml(formatCroreCompact(row.valueCr))}</td>
          <td class="whitespace-nowrap px-3 py-3 text-right align-top tabular-nums text-slate-700">${row.qty == null ? dash('no current share count filed') : escapeHtml(groupInt(row.qty))}</td>
        </tr>`;
    })
    .join('');

  openModal(
    `<div class="scrollbar-thin max-h-[82vh] overflow-y-auto" data-company-institution-detail>
      <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-5 backdrop-blur sm:px-7">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[11px] font-bold uppercase tracking-wider text-indigo-600">Across quarterly institution filings</p>
            <h2 class="font-display mt-1 text-xl font-bold text-slate-900">${escapeHtml(company)}</h2>
            <p class="mt-1 text-xs text-slate-500">
              ${ticker ? `${escapeHtml(ticker)} · ` : ''}${formatNumber(details.length)} institution book${details.length === 1 ? '' : 's'} in the latest comparison ·
              ${formatNumber(current)} currently disclosed${awaiting ? ` · ${formatNumber(awaiting)} awaiting filing` : ''} · ${formatNumber(changed)} changed
            </p>
          </div>
          <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
      </div>
      <div class="px-6 py-5 sm:px-7">
        <p class="mb-4 text-xs leading-relaxed text-slate-500">
          Percentages are stakes in the company from each institution's own latest and prior quarterly filings.
          <strong class="text-slate-600">Current value is Trendlyne's derivation, not an amount bought or sold.</strong>
          A dash means not disclosed, not zero.
        </p>
        <div class="table-scroll-surface overflow-x-auto rounded-xl ring-1 ring-slate-200" tabindex="0" role="region" aria-label="Company institution comparison table">
          <table class="min-w-[980px] w-full text-sm">
            <thead class="bg-slate-50"><tr>
              <th scope="col" class="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">Institution</th>
              <th scope="col" class="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">Status</th>
              <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Previous stake</th>
              <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Current stake</th>
              <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Change (derived)</th>
              <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Current value (Trendlyne)</th>
              <th scope="col" class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500">Shares held</th>
            </tr></thead>
            <tbody>${rows || `<tr><td colspan="7" class="px-4 py-10 text-center text-sm text-slate-500">No comparable institution filing is available for this company.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>`,
    { size: 'wide' }
  );
}

// ---------------------------------------------------------------------------------------
// Columns — the one place that decides what each percentage is called
// ---------------------------------------------------------------------------------------

// "Jun 2026" -> "Jun 26". Thirteen columns is a lot to fit at 1440px and the year spelled out costs
// ~30px eight times over; the full label lives in each cell's title attribute.
const shortLabel = (label) => label.replace(/\s(\d{2})(\d{2})$/, ' $2');

function columnsFor(fund) {
  const filing = isFiling(fund);
  const [latest] = fund.periodLabels;
  const suffix = filing ? 'Holding %' : '% to NAV';

  // Every prior period, tinted against the one before it.
  const history = fund.periods.slice(1).map((p, i) => {
    const label = fund.periodLabels[i + 1];
    const prev = fund.periods[i + 2] || null;
    return {
      label: `${shortLabel(label)} %`,
      get: (r) => pctCell(r.pctByPeriod?.[p], prev ? r.pctByPeriod?.[prev] : null, label, fund),
      html: true,
      align: 'right',
      sortValue: (r) => r.pctByPeriod?.[p] ?? -1,
    };
  });

  const value = filing
    ? {
        label: 'Holding Value',
        get: (r) => (r.valueCr == null ? dash('no value published') : crCell(r.valueCr, 'Trendlyne’s derivation: holding % × market cap')),
        html: true,
        align: 'right',
        sortValue: (r) => r.valueCr ?? -1,
      }
    : {
        // Headed as the AMC's, not because it is a derivation — it is not, they publish it — but
        // because it is theirs. Naming the source is the same discipline either way.
        label: 'Value (AMC)',
        get: (r) => (r.valueCr == null ? dash('the AMC published no value for this line') : crCell(r.valueCr, 'The market value of the position, as the AMC published it')),
        html: true,
        align: 'right',
        sortValue: (r) => r.valueCr ?? -1,
      };

  const change = {
    label: `${shortLabel(latest)} Change ${filing ? '%' : '(pp)'}`,
    get: (r) => changeCell(r, fund),
    html: true,
    align: 'right',
    // A label sorts below every number but above a blank, so "New" rows group together at the
    // bottom of a descending sort instead of scattering.
    sortValue: (r) => (r.changePp != null ? r.changePp : r.changeNote ? -998 : -999),
  };

  const current = {
    label: `${shortLabel(latest)} ${suffix}`,
    get: (r) => pctCell(r.pct, r.pctByPeriod?.[fund.periods[1]], latest, fund, { bold: true }),
    html: true,
    align: 'right',
    sortValue: (r) => r.pct ?? -1,
  };

  if (filing) {
    return [
      value,
      {
        label: 'Qty Held',
        get: (r) => (r.qty == null ? dash('no share count filed') : `<span class="tabular-nums" title="Shares held, as filed">${escapeHtml(groupInt(r.qty))}</span>`),
        html: true,
        align: 'right',
        sortValue: (r) => r.qty ?? -1,
      },
      change,
      current,
      ...history,
    ];
  }

  // NO QUANTITY COLUMN for an AMC portfolio, rather than a column of dashes. A monthly portfolio
  // disclosure states a weight and a value and does not state a share count — so the column is not
  // missing data, it is a question this disclosure does not answer, and rendering 258 em dashes
  // would imply we expected an answer and did not get one.
  return [value, change, current, ...history];
}

function filtersFor(fund) {
  const filing = isFiling(fund);
  const position = {
    label: 'Position',
    options: filing
      ? [
          { value: 'all', label: 'All positions' },
          { value: 'up', label: 'Increased' },
          { value: 'down', label: 'Trimmed' },
          { value: 'new', label: 'Newly disclosed' },
          { value: 'pending', label: 'Awaiting filing' },
        ]
      : [
          { value: 'all', label: 'All positions' },
          { value: 'up', label: 'Weight up' },
          { value: 'down', label: 'Weight down' },
          { value: 'new', label: 'New this month' },
        ],
    match: (r, v) => {
      if (v === 'up') return r.changePp != null && r.changePp > 0;
      if (v === 'down') return r.changePp != null && r.changePp < 0;
      if (v === 'new') return r.changeNote === 'New';
      if (v === 'pending') return r.pct == null;
      return true;
    },
  };
  if (filing) return [position];

  // A small fund is all equity and a class dropdown with one option is noise; the Small Cap fund
  // holds gold and a debt line as well, and those are genuinely different instruments.
  const classes = [...new Set(fund.holdings.map((h) => h.assetClass).filter(Boolean))];
  if (classes.length < 2) return [position];
  return [
    position,
    {
      label: 'Asset class',
      options: [{ value: 'all', label: 'All asset classes' }, ...classes.map((c) => ({ value: c, label: c }))],
      match: (r, v) => v === 'all' || r.assetClass === v,
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

// Trendlyne group share counts internationally — 14,947,573, not the Indian 1,49,47,573 — and
// matching them keeps the column both faithful and two characters narrower.
const groupInt = (n) => n.toLocaleString('en-US');

/** A dash that says why it is a dash. Never a zero — see the header of this file. */
const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

const crCell = (v, why) => `<span class="tabular-nums" title="${escapeHtml(why)}">${escapeHtml(formatCrore(v))}</span>`;

/** "1,104.2 Cr" — the source's own unit, so the column reads the same as their page. */
function formatCrore(v) {
  if (v == null) return '—';
  return `${v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Cr`;
}

/** What a blank cell means, which is not the same thing in the two disclosures. */
const blankMeans = (fund, label) => (isFiling(fund) ? `${label}: not filed` : `${label}: not held`);

/**
 * One period's percentage, tinted against the period before it.
 *
 * The tint is arithmetic on two of the source's own numbers, not a judgement: higher than last
 * period is emerald, lower is rose. Trendlyne shade their grid the same way and it is what makes a
 * two-year row readable at a glance instead of nine numbers to diff by eye.
 *
 * TWO DECIMALS FOR A FUND WEIGHT, ONE FOR A SHAREHOLDING. An AMC publishes weights to two places
 * and the small end of a 258-line book lives there — rounding 0.04% and 0.02% both to "0.0%" would
 * erase the difference between the fund's smallest positions. A shareholding percentage is
 * published to one place, and printing a second would invent precision.
 */
function pctCell(v, prev, label, fund, { bold = false } = {}) {
  if (v == null) return dash(blankMeans(fund, label));
  const dp = isFiling(fund) ? 1 : 2;
  const tint = prev == null ? '' : v > prev ? 'bg-emerald-50' : v < prev ? 'bg-rose-50' : '';
  const was = prev == null ? '' : ` · was ${prev}% the ${fund.periodNoun} before`;
  return `<span class="-mx-1 inline-block rounded px-1 tabular-nums ${tint} ${bold ? 'font-semibold text-slate-900' : 'text-slate-700'}" title="${escapeHtml(label)}${escapeHtml(was)}">${v.toFixed(dp)}%</span>`;
}

/**
 * The change column.
 *
 * "New", "Below 1% first time" and "Filing Awaited" are the source's own labels for a disclosure
 * event, not a measurement, so they stay words — turning them into a percentage would invent a
 * figure no disclosure contains. The same applies to an AMC line bought this month: the weight did
 * not rise from zero, the position did not exist.
 */
function changeCell(r, fund) {
  if (r.changePp == null) {
    if (!r.changeNote) return dash('no change published');
    const tone = r.changeNote === 'New' ? 'text-emerald-700' : r.changeNote === 'Filing Awaited' ? 'text-amber-700' : 'text-slate-500';
    const why = isFiling(fund) ? 'Trendlyne’s own label for this row' : 'the fund did not hold this line in the previous month, so there is no change to state';
    return `<span class="whitespace-nowrap font-medium ${tone}" title="${escapeHtml(why)}">${escapeHtml(r.changeNote)}</span>`;
  }
  const dp = isFiling(fund) ? 1 : 2;
  if (r.changePp === 0) return `<span class="tabular-nums text-slate-400">${(0).toFixed(dp)}</span>`;
  const cls = r.changePp > 0 ? 'text-emerald-700' : 'text-rose-700';
  return `<span class="font-semibold tabular-nums ${cls}" title="Change in percentage points against the previous ${escapeHtml(fund.periodNoun)}">${r.changePp.toFixed(dp)}</span>`;
}

// ---------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------

function avatarBlock(fund) {
  const { color, initials } = avatarFor(fund.name);
  return `<span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-sm font-bold text-white">${escapeHtml(initials)}</span>`;
}

function identityLine(fund, label0) {
  const bits = [fund.house, fund.category].filter(Boolean);
  const held = `${formatNumber(fund.stocksHeld)} holdings worth ${formatCrore(fund.portfolioValueCr)} as of ${label0}`;
  const prior = fund.former?.length ? `${formatNumber(fund.former.length)} previously held` : null;
  return [bits.join(' · '), held, prior].filter(Boolean).join(' · ');
}

function fundPicker(funds, active) {
  return `
    <div class="mb-4 flex flex-wrap gap-2">
      ${funds
        .map(
          (f) => `<button type="button" data-fund="${escapeHtml(f.investorId)}" aria-pressed="${f.investorId === active.investorId}"
            title="${escapeHtml(isFiling(f) ? 'Shareholding filings — how much of each company this fund owns' : 'The AMC’s own monthly portfolio — how much of this fund is in each company')}"
            class="rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${
              f.investorId === active.investorId ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-indigo-50'
            }">${escapeHtml(f.name)}</button>`
        )
        .join('')}
    </div>`;
}

/**
 * The pill, which is the only always-visible statement of WHICH disclosure is on screen.
 *
 * Both are real and both are green; what differs is the word. "Filed" means the company filed who
 * owns it; "Disclosed" means the fund published what it owns. A reader who reads nothing else
 * should still not confuse the two percentages.
 */
function disclosurePill(fund) {
  const filing = isFiling(fund);
  return `
    <span data-filed-info title="${filing ? 'Exchange-filed shareholdings' : 'AMC portfolio disclosure'}"
      class="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-300">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span>${filing ? 'Filed' : 'Disclosed'}</span>
      <span class="font-normal opacity-70">${escapeHtml(fund.periodLabels[0])} · ${filing ? 'exchange filings' : '% to NAV, AMC portfolio'}</span>
    </span>`;
}

// THERE IS NO FOOTNOTE UNDER THIS TABLE, AND THAT IS A DELIBERATE MOVE, NOT A LOSS.
//
// Both kinds used to carry a dense paragraph: what the percentage measures, whose the value is,
// what a blank means, how many lines have no ticker, how many are no longer held. All of it true,
// all of it under every table on every visit, and by the fifth reading none of it read at all.
//
// Every one of those facts is still one click away in the pill's modal — which is the right home,
// because "what does this number mean" and "where did it come from" are the same question — and
// each cell that could mislead carries its own title attribute: a dash says whether it means *not
// filed* or *not held*, the value column says whose figure it is, an unresolved row says why it has
// no symbol. Row 1 of the exported sheet still spells out all of it, because a workbook is the one
// artefact that travels without any of this chrome.
//
// The rule this respects is the one in CLAUDE.md: decluttering a page is fine, deleting its
// accountability is not. What was removed is the repetition, not the disclosure.

// ---------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------

function openProvenance(fund, m) {
  openModal(isFiling(fund) ? filingProvenance(fund, m) : portfolioProvenance(fund, m), { size: 'default' });
}

function filingProvenance(fund, m) {
  return `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Filed shareholdings</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real data.</strong> Indian listed companies file their shareholding pattern with the exchanges every
           quarter, naming each holder above 1% with the number of shares and the percentage of the company held.
           <a class="font-semibold text-indigo-600 hover:underline" href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener">Trendlyne</a>
           aggregate those filings by holder, which is how one page can list every Indian company
           <strong>${escapeHtml(fund.name)}</strong> appears in.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What the percentage measures</h3>
        <p class="mt-1 text-xs"><strong>How much of the company this fund owns.</strong> That is the opposite of the % to NAV
           on this view's AMC portfolios, which say how much of the fund is in a company. The two are never summed, averaged or
           ranked against each other.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Which numbers are filings, and which is not</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Shares held</strong> and <strong>holding %</strong> — the filing itself, as submitted by the company.</li>
          <li><strong>Change</strong> — the difference between two filed percentages, in percentage points. Trendlyne publish
              their own change figure for the quarter and the two agree on every row of this pull; where no number applies
              they print a label instead (<em>New</em>, <em>Below 1% first time</em>, <em>Filing Awaited</em>) and so do we.</li>
          <li><strong>Value</strong> — <strong>Trendlyne's derivation</strong>, holding % × market cap, reproduced unchanged.
              A filing never discloses a rupee amount. We do not recompute it: a number of ours under their label would
              read as theirs. Our total and theirs agree to the rupee — ₹${escapeHtml(formatNumber(fund.portfolioValueCr))} Cr
              across ${escapeHtml(formatNumber(fund.stocksHeld))} holdings.</li>
          <li><strong>Sector</strong> — from the NSE-500 export, so companies outside it show none.</li>
        </ul>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why a percentage can be missing</h3>
        <p class="mt-1 text-xs">Companies file within weeks of a quarter closing, not on the same day.
           <strong>${escapeHtml(formatNumber(fund.filedThisQuarter))}</strong> of ${escapeHtml(formatNumber(fund.stocksHeld))}
           have filed for ${escapeHtml(fund.periodLabels[0])}${fund.awaitingFiling?.length ? `; ${fund.awaitingFiling.map((t) => `<strong>${escapeHtml(t)}</strong>`).join(', ')} ${fund.awaitingFiling.length === 1 ? 'has' : 'have'} not` : ''}.
           Those rows read <em>not filed yet</em> and keep their share count and value. A zero there would report a position
           that is still held as sold.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How fresh it is</h3>
        <p class="mt-1 text-xs">Shareholding is a quarterly disclosure, so this is scraped on a schedule and committed, not
           polled. Last read ${m?.generatedAt ? escapeHtml(formatRelativeTime(Date.parse(m.generatedAt))) : '—'} by
           <code class="rounded bg-slate-100 px-1">${escapeHtml(m?.generator || 'scripts/scrape-institution-holdings.mjs')}</code>,
           which refuses to write the file unless its own totals match Trendlyne's stated figures.</p>

        <p class="mt-4 text-xs text-slate-500">A dash means <em>not disclosed</em> — never zero.</p>
      </div>
    </div>`;
}

function portfolioProvenance(fund) {
  const unresolved = fund.holdings.filter((h) => !h.ticker);
  return `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">The fund's own portfolio</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real data.</strong> Indian AMCs publish the full portfolio of every scheme each month.
           <a class="font-semibold text-indigo-600 hover:underline" href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(fund.house || 'The AMC')}</a>
           disclose each instrument with its weight and its market value, and this is
           <strong>${escapeHtml(fund.name)}</strong>'s book across ${escapeHtml(String(fund.periods.length))} months to
           ${escapeHtml(fund.periodLabels[0])}.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What the percentage measures — and what it does not</h3>
        <p class="mt-1 text-xs"><strong>% to NAV: how much of this fund sits in the company.</strong> It is <em>not</em> how much
           of the company the fund owns, which is what the holding percentages on this view's shareholding funds mean.
           A 3% here is a slice of a fund; a 3% there is a stake in a business. Nothing on this page adds the two together.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Whose numbers these are</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Weight, value, asset class and industry</strong> — the AMC's own disclosure, reproduced unchanged.
              Unlike a shareholding filing, a portfolio disclosure <em>does</em> state a rupee amount, so the value column is
              published rather than derived.</li>
          <li><strong>Change (pp)</strong> — <strong>the one figure computed here</strong>: this month's weight minus last
              month's, in percentage points.</li>
          <li><strong>The NSE symbol</strong> — also ours. The disclosure names instruments the way the AMC writes them, so a
              symbol is resolved from the feeds this dashboard already carries.
              ${
                unresolved.length
                  ? `<strong>${escapeHtml(formatNumber(unresolved.length))}</strong> of ${escapeHtml(formatNumber(fund.stocksHeld))} could not be matched and are shown without one rather than guessed at — a wrong symbol would hand one company another's weights.`
                  : 'Every line in this book resolved.'
              }</li>
        </ul>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Totals, and why they do not tie to the stated AUM</h3>
        <p class="mt-1 text-xs">The ${escapeHtml(formatNumber(fund.stocksHeld))} lines held at ${escapeHtml(fund.periodLabels[0])}
           sum to <strong>${escapeHtml(formatCrore(fund.portfolioValueCr))}</strong> and to
           <strong>${escapeHtml(sumWeights(fund))}%</strong> of NAV — the rest is cash and equivalents, which the disclosure
           reports as an asset-mix line rather than a holding${fund.assetMix?.length ? ` (${escapeHtml(fund.assetMix.map((a) => `${a.label} ${a.pct}%`).join(', '))})` : ''}.
           ${fund.summaryLine ? `The AMC's own summary line reads: <em>${escapeHtml(fund.summaryLine)}</em>.` : ''}</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What a blank month means</h3>
        <p class="mt-1 text-xs">The fund <strong>did not hold that line</strong> that month — not a weight of zero. A company
           the fund sold and later bought back is disclosed on two separate lines, and those are folded into one row here
           <em>only</em> because their months do not overlap; nothing is summed to produce a figure the AMC did not publish.
           ${fund.reboughtCount ? `<strong>${escapeHtml(formatNumber(fund.reboughtCount))}</strong> ${fund.reboughtCount === 1 ? 'company was' : 'companies were'} re-entered after an exit in this window.` : ''}</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How fresh it is</h3>
        <p class="mt-1 text-xs">Monthly, and imported rather than scraped: the workbook is committed at
           <code class="rounded bg-slate-100 px-1">${escapeHtml(fund.sourceFile || 'scripts/fixtures/')}</code> and read by
           <code class="rounded bg-slate-100 px-1">${escapeHtml(fund.generator || 'scripts/import-amc-portfolio.mjs')}</code>,
           so the import reproduces from the same bytes. A new month means a new workbook and one re-run.</p>
      </div>
    </div>`;
}

const sumWeights = (fund) => fund.holdings.reduce((a, h) => a + (h.pct || 0), 0).toFixed(2);

// ---------------------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------------------

function drillHolding(h, fund) {
  const filing = isFiling(fund);
  const dp = filing ? 1 : 2;
  const rows = fund.periods.map((p, i) => ({ label: fund.periodLabels[i], pct: h.pctByPeriod?.[p] ?? null, value: h.valueByPeriod?.[p] ?? null }));

  openDrill({
    name: h.name,
    sub: [h.ticker, h.sector || h.industry].filter(Boolean).join(' · ') || 'no NSE symbol',
    link: h.url,
    linkLabel: filing ? 'Shareholding on Trendlyne ↗' : null,
    headerStats: [
      {
        label: `${fund.periodLabels[0]} ${filing ? 'holding' : 'weight'}`,
        value: h.pct == null ? (filing ? 'not filed' : 'not held') : `${h.pct.toFixed(dp)}%`,
        caption: filing ? (h.pct == null ? 'the company has not filed yet' : 'of the company, as filed') : 'of the fund’s NAV, as disclosed',
        tone: 'neutral',
      },
      filing
        ? { label: 'Shares held', value: h.qty == null ? '—' : formatNumber(h.qty), caption: 'as filed', tone: 'neutral' }
        : { label: 'Asset class', value: h.assetClass || '—', caption: h.industry || 'as classified by the AMC', tone: 'neutral' },
      {
        label: 'Value',
        value: h.valueCr == null ? '—' : formatCroreCompact(h.valueCr),
        caption: filing ? 'Trendlyne’s derivation' : 'the AMC’s own figure',
        tone: 'neutral',
      },
    ],
    groups: [
      {
        category: `${filing ? 'Filed holding' : 'Weight in the fund'} · ${fund.periodLabels[fund.periodLabels.length - 1]} to ${fund.periodLabels[0]}`,
        items: rows.map((r, i) => ({
          label: r.label,
          value:
            r.pct == null
              ? filing
                ? 'not filed'
                : 'not held'
              : `${r.pct.toFixed(dp)}% ${filing ? 'of the company' : 'of NAV'}${r.value == null ? '' : ` · ${formatCrore(r.value)}`}`,
          // `na` rather than a zero. For a filing the company simply has not filed; for a portfolio
          // the fund was out of the line. Neither is a position of nothing, and the drill is the one
          // place that distinction has room to be spelled out.
          status: r.pct == null ? 'na' : 'pass',
          note:
            r.pct == null
              ? filing
                ? 'the company had not filed for this quarter when this was read'
                : 'the fund did not hold this line in this month'
              : i === 0
                ? filing
                  ? 'most recent filing'
                  : 'most recent disclosure'
                : null,
        })),
      },
      {
        category: 'Provenance',
        items: filing
          ? [
              { label: 'Shares held and holding %', value: 'exchange filing, as submitted by the company', status: 'pass' },
              { label: 'Rupee value', value: 'Trendlyne’s derivation: holding % × market cap', status: 'partial', note: 'a filing never discloses a rupee amount; this is reproduced, not recomputed' },
              { label: 'Change in pp', value: 'the difference between two filed percentages', status: 'pass' },
              { label: 'Sector', value: h.sector || 'not in the NSE-500 export', status: h.sector ? 'pass' : 'na' },
              { label: 'Holder', value: fund.name, status: 'pass' },
            ]
          : [
              { label: 'What the percentage is', value: '% to NAV — how much of the fund is in this company', status: 'pass', note: 'not how much of the company the fund owns' },
              { label: 'Weight and value', value: `${fund.house || 'The AMC'}’s own monthly disclosure`, status: 'pass', note: 'a portfolio disclosure states a rupee value, so this one is published rather than derived' },
              { label: 'Change in pp', value: 'the difference between two of their own weights', status: 'partial', note: 'the only figure computed here' },
              { label: 'Industry', value: h.industry || 'not classified in the disclosure', status: h.industry ? 'pass' : 'na' },
              {
                label: 'NSE symbol',
                value: h.ticker ? `${h.ticker} — matched ${h.resolvedBy ? `via ${h.resolvedBy}` : 'from our feeds'}` : 'none',
                status: h.ticker ? 'pass' : 'na',
                note: h.ticker ? 'ours, not the AMC’s — the disclosure names instruments, not symbols' : h.unresolvedReason || 'no symbol could be matched, so none is shown',
              },
              ...(h.spells > 1
                ? [{ label: 'Held across', value: `${h.spells} separate spells`, status: 'pass', note: 'the AMC discloses a re-entered position on a new line; the months do not overlap, so they are shown as one row' }]
                : []),
              { label: 'Holder', value: fund.name, status: 'pass' },
            ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// Export — the one artefact that leaves without the page's chrome, so the banner carries it
// ---------------------------------------------------------------------------------------

async function exportFund(visible, fund) {
  const filing = isFiling(fund);
  const banner = {
    __banner: filing
      ? `REAL DATA. ${fund.name} — Indian shareholdings as filed with the exchanges, quarter ending ${fund.periodLabels[0]}. ` +
        `THE PERCENTAGE IS HOW MUCH OF EACH COMPANY THE FUND OWNS. ` +
        `Share counts and holding percentages are the filings. THE RUPEE VALUE IS TRENDLYNE'S OWN DERIVATION (holding % x market cap), ` +
        `reproduced unchanged, not recomputed — a filing never discloses a rupee amount. ` +
        `${fund.filedThisQuarter} of ${fund.stocksHeld} holdings have filed for ${fund.periodLabels[0]}; a blank percentage means NOT YET FILED, not sold. ` +
        `Source: ${fund.sourceUrl}. Exported ${new Date().toISOString()}.`
      : `REAL DATA. ${fund.name} — the fund's own portfolio as ${fund.house || 'the AMC'} disclose it, month ending ${fund.periodLabels[0]}. ` +
        `THE PERCENTAGE IS % TO NAV: HOW MUCH OF THE FUND IS IN EACH COMPANY, NOT HOW MUCH OF THE COMPANY THE FUND OWNS. ` +
        `It is NOT comparable with the holding percentages in a shareholding-filing export and must not be summed with them. ` +
        `Weights, values, asset class and industry are the AMC's own published figures; the value is disclosed, not derived. ` +
        `THE ONLY COMPUTED COLUMN IS Change (pp), this month's weight minus last month's. ` +
        `A blank month means the fund DID NOT HOLD that line then, not a weight of zero. ` +
        `The NSE symbol is ours, resolved from other feeds; ${fund.stocksHeld - fund.resolvedCount} of ${fund.stocksHeld} lines could not be matched and carry none. ` +
        `Source: ${fund.sourceUrl} via ${fund.sourceFile}. Exported ${new Date().toISOString()}.`,
  };

  const shared = [
    { header: 'Ticker (ours)', key: 't', width: 16, get: (r) => (r.__banner ? r.__banner : r.ticker || '') },
    { header: filing ? 'Company' : 'Instrument', key: 'c', width: 40, get: (r) => (r.__banner ? '' : r.name) },
  ];

  const columns = filing
    ? [
        ...shared,
        { header: 'Sector', key: 's', width: 26, get: (r) => (r.__banner ? '' : r.sector || '') },
        { header: 'Shares held (filed)', key: 'q', width: 20, get: (r) => (r.__banner ? '' : r.qty ?? '') },
        { header: `${fund.periodLabels[0]} holding % of company (filed)`, key: 'p', width: 34, get: (r) => (r.__banner ? '' : r.pct ?? '') },
        { header: 'Change (pp)', key: 'd', width: 14, get: (r) => (r.__banner ? '' : r.changePp ?? '') },
        { header: 'Trendlyne label', key: 'n', width: 20, get: (r) => (r.__banner ? '' : r.changeNote || '') },
        { header: 'Value Rs Cr (Trendlyne derived)', key: 'v', width: 30, get: (r) => (r.__banner ? '' : r.valueCr ?? '') },
      ]
    : [
        ...shared,
        { header: 'Asset class', key: 'a', width: 14, get: (r) => (r.__banner ? '' : r.assetClass || '') },
        { header: 'Industry', key: 's', width: 30, get: (r) => (r.__banner ? '' : r.industry || '') },
        { header: `${fund.periodLabels[0]} % to NAV (AMC disclosed)`, key: 'p', width: 32, get: (r) => (r.__banner ? '' : r.pct ?? '') },
        { header: 'Change (pp, computed here)', key: 'd', width: 26, get: (r) => (r.__banner ? '' : r.changePp ?? '') },
        { header: 'Label', key: 'n', width: 14, get: (r) => (r.__banner ? '' : r.changeNote || '') },
        { header: 'Value Rs Cr (AMC disclosed)', key: 'v', width: 28, get: (r) => (r.__banner ? '' : r.valueCr ?? '') },
        { header: 'Why no ticker', key: 'u', width: 40, get: (r) => (r.__banner ? '' : r.ticker ? '' : r.unresolvedReason || '') },
      ];

  await exportRows({
    filename: `sattva-${fund.investorId}-holdings`,
    sheetName: filing ? 'Filed holdings' : 'Fund portfolio',
    columns: [
      ...columns,
      ...fund.periods.map((p, i) => ({
        header: `${fund.periodLabels[i]} %`,
        key: `h${i}`,
        width: 12,
        get: (r) => (r.__banner ? '' : r.pctByPeriod?.[p] ?? ''),
      })),
    ],
    rows: [banner, ...visible],
  });
}
