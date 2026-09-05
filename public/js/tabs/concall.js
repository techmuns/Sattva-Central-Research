// tabs/concall.js — the Con-call tab.
//
// ONE VIEW, TWO EXPLICITLY SEPARATED PROVENANCES.
//   Screener's authenticated market-wide document index supplies retained transcripts, recordings,
//   presentations and summaries. StockScans supplies its current-quarter result score, sentiment
//   tier and highlight bullets. The Worker joins them before this module receives the rows;
//   js/concall/scans.js labels document-only history separately from analysis pending.
//
// WHAT USED TO BE HERE, AND WHY IT IS NOT
//   This tab carried six sub-views behind a left rail. Two were live; the other four — Live Feed,
//   Keyword Scan, Catalysts and Deep Dive — ran on a SYNTHETIC transcript corpus with fictional
//   speakers, because no open source gives us full transcript text. That meant two provenances in
//   one tab, held apart by an amber ribbon on one half and a green pill on the other, and a 2MB
//   corpus downloaded to render invented speech.
//
//   They are gone. The tab is one screen with one source, and there is no longer a ribbon to
//   explain which half you are looking at. If a real transcript feed is ever wired — BSE publishes
//   filed transcript PDFs — the keyword engine and the Deep Dive workspace are in git history and
//   would come back pointed at real text rather than generated text.
//
// THE SCORES ARE STOCKSCANS', NOT OURS. See "Reproducing someone else's analysis" in CLAUDE.md
// before changing anything this renders.

import { sectionHead, companySeededView } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import * as scans from '../concall/scans.js';
import { stopDeepDive } from '../concall/deep-dive.js';
import * as feed from '../data/concall-scans.js';
import { withCompanyDocuments } from '../ui/company-documents.js';

export const meta = {
  id: 'concall',
  title: 'Con-call',
  subtitle: 'The complete Screener concall document index, enriched with current-quarter third-party analysis.',
  // No sub-views: the shell hides the rail entirely when this is empty and the table spans the
  // full width. The schedule is an overlay, not a second page.
  subviews: [],
};

let renderToken = 0;
// Two lifetimes, kept apart on purpose. The panel's listeners die and are rebuilt on every
// repaint; the poller and the change subscription live for as long as the tab is mounted. Folding
// them into one list means the first live tick tears down the poller that produced it.
let panelDisposers = [];
let mountDisposers = [];
let unsubscribe = null;
// The table's search, filters, sort and watchlist toggle, carried across live repaints. Without
// this a call landing mid-session would reset whatever the reader had set up.
let tableView = null;
let routeCompany = null;

function renderFeed(ctx) {
  const token = ++renderToken;
  cleanup();
  const seeded = companySeededView(ctx, routeCompany, tableView);
  routeCompany = seeded.company;
  tableView = seeded.view;
  ctx.root.innerHTML = loadingHtml();

  feed
    .load()
    .then(() => {
      if (token !== renderToken) return;
      paint(ctx);
      unsubscribe = feed.onChange(() => {
        if (token !== renderToken) return;
        paint(ctx);
      });
      mountDisposers.push(feed.startLive(ctx.live));
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[concall] live scan feed failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: 'Concall Scans', description: 'The live con-call feed could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not reach the con-call scan feed</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

function destroyFeed() {
  renderToken++;
  cleanup();
  // Leaving the tab is a deliberate exit; coming back should be a clean table rather than last
  // visit's half-applied filter. Only a live repaint carries the view forward.
  tableView = null;
}

function cleanup() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  // The shell closes overlays on route change with `{ silent: true }`, which skips the workspace's
  // own onClose — so the Deep Dive poller has to be stopped from here or it outlives its panel.
  stopDeepDive();
  disposePanel();
  mountDisposers.forEach((d) => d && d());
  mountDisposers = [];
}

function disposePanel() {
  panelDisposers.forEach((d) => d && d());
  panelDisposers = [];
}

function paint(ctx) {
  // `renderScans` rebuilds the panel, so its listeners go with it — dispose before repainting or
  // every live tick would stack another set on the new DOM.
  disposePanel();
  scans.renderScans(ctx, { disposers: panelDisposers, tableView, onView: (v) => (tableView = v) });
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="skeleton-shimmer h-[520px] rounded-2xl bg-slate-100"></div>`;
}

export const { render, destroy } = withCompanyDocuments({ render: renderFeed, destroy: destroyFeed }, { form: 'concalls', feedLabel: 'Con-call analysis', label: 'Filed con-call documents' });
