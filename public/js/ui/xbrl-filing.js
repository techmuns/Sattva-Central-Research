// One document reader for every scope, tab, card and dynamically inserted source link.
// Source records retain NSE's URL. Navigation uses the readable page, including copied links,
// keyboard activation, middle clicks and the browser's Open in new tab menu.

import { escapeHtml } from '../core/dom.js';
import { openModal, closeModal } from './screener.js';
import { isXbrlFilingUrl, readableFilingUrl } from '../data/nse-xbrl-shared.js';

export { isXbrlFilingUrl };

const REQUEST_TIMEOUT_MS = 20000;

// The panel is a singleton, like the modal it lives in, and the fetch behind it is not instant. A
// reader who closes one filing and opens another before the first lands must not have the first
// painted over the second, so every open takes a token and only the current one may write.
let openToken = 0;

const shell = (inner) => `
  <div class="scrollbar-thin max-h-[85vh] overflow-y-auto px-7 py-6" data-xbrl-panel>${inner}</div>`;

function head({ title, sub, meta }) {
  return `
    <div class="mb-4 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
        ${sub ? `<p class="mt-1 text-sm font-semibold text-slate-700">${escapeHtml(sub)}</p>` : ''}
        ${meta ? `<p class="mt-1 text-xs text-slate-500">${meta}</p>` : ''}
      </div>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">&times;</button>
    </div>`;
}

const readableLink = (url) => isXbrlFilingUrl(url) ? `
  <a href="${escapeHtml(readableFilingUrl(url))}" target="_blank" rel="noopener noreferrer" data-xbrl-page
     class="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">Open full readable filing &#8599;</a>` : '';

const sourceDetails = (url) => isXbrlFilingUrl(url) ? `
  <details class="mt-4 text-xs text-slate-500">
    <summary class="cursor-pointer">Source file details</summary>
    <p class="mt-2">NSE published this filing as an XML data file. The readable view reproduces its fields without changing their values.</p>
    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-xbrl-original
       class="mt-2 inline-flex text-xs font-semibold text-indigo-600 hover:text-indigo-800">View raw XML on NSE (technical file) &#8599;</a>
  </details>` : '';

/**
 * One fact. The label is the exchange's own tag, spaced into words; the value is the company's own,
 * unchanged — a date stays a date, `true` stays `true`, and a number keeps its digits and gains
 * only the unit the document itself declared. Nothing here rounds, converts or re-words anything.
 */
function factRow(fact) {
  const unit = fact.unit ? ` <span class="text-[11px] font-semibold uppercase text-slate-400">${escapeHtml(fact.unit)}</span>` : '';
  return `
    <div class="border-t border-slate-100 py-2 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt class="text-xs font-semibold text-slate-500">${escapeHtml(fact.label || fact.tag)}</dt>
      <dd class="mt-0.5 whitespace-pre-line break-words text-sm text-slate-800 sm:col-span-2 sm:mt-0">${escapeHtml(fact.value)}${unit}</dd>
    </div>`;
}

const blockHtml = (block) => `
  <section class="mt-4">
    ${block.title ? `<h3 class="mb-1 text-xs font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(block.title)}</h3>` : ''}
    <dl class="border-b border-slate-100">${block.facts.map(factRow).join('')}</dl>
  </section>`;

/**
 * The state where the filing could not be read.
 *
 * IT NAMES THE FAILURE AND KEEPS THE DOCUMENT REACHABLE. "Could not be rendered" and "the filing is
 * gone" are different claims and only the first one is true here — the file is still on NSE's
 * archive and the button below goes to it. `no-worker` is the honest answer on a static origin,
 * where nothing is broken and there is simply no route: saying "NSE is unreachable" there would
 * send somebody to look at a healthy exchange.
 */
function failureHtml({ url, title, sub, reason, detail }) {
  const words = reason === 'no-worker'
    ? 'The readable filing is unavailable on this copy of the dashboard.'
    : reason === 'unsupported'
      ? 'This document is not one of NSE’s XBRL announcement files, so there is nothing here to lay out.'
      : 'NSE could not be read for this filing just now.';
  return shell(`
    ${head({ title, sub, meta: 'Filed to NSE as an XBRL data file' })}
    <p class="text-sm text-slate-600">${escapeHtml(words)}</p>
    ${detail ? `<p class="mt-1 text-xs text-slate-400">${escapeHtml(detail)}</p>` : ''}
    ${isXbrlFilingUrl(url) ? '<button data-filing-retry class="mt-3 text-xs font-semibold text-indigo-600">Try again</button>' : ''}
    ${sourceDetails(url)}`);
}

function filingHtml(filing, { url, title, sub, meta }) {
  return shell(`
    ${head({ title: filing.company || title, sub, meta })}
    <div class="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
      Reproduced from the company’s own XBRL filing to NSE. Every field below is the exchange’s
      label and the company’s value, unchanged — this dashboard adds no reading of its own.
    </div>
    ${filing.blocks.map(blockHtml).join('')}
    <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
      <span class="text-xs text-slate-400">${filing.factCount} field${filing.factCount === 1 ? '' : 's'} as filed</span>
      ${readableLink(url)}
    </div>
    ${sourceDetails(url)}`);
}

/** The identification line under the title: the row's own subject and time, then the filing's ids. */
function metaLine(filing, { subject, when }) {
  const bits = [];
  if (subject) bits.push(escapeHtml(subject));
  if (when) bits.push(escapeHtml(when));
  if (filing?.isin) bits.push(`ISIN ${escapeHtml(filing.isin)}`);
  if (filing?.scripCode) bits.push(`BSE ${escapeHtml(filing.scripCode)}`);
  return bits.join(' &middot; ');
}

/**
 * Open one NSE XBRL filing, readable.
 *
 * `context` is what the ROW already knows — company, ticker, subject and filed time. It titles the
 * panel while the document is being read and stands in for anything the filing itself does not
 * carry, so the reader is never shown a blank heading or, worse, a guessed one.
 */
export async function openFilingReader(url, context = {}) {
  const token = ++openToken;
  const title = context.company || context.ticker || 'NSE filing';
  const sub = context.ticker && context.company ? context.ticker : null;
  const stale = () => token !== openToken || !document.querySelector('[data-xbrl-panel]');

  if (!isXbrlFilingUrl(url)) {
    openModal(failureHtml({ url, title, sub, reason: 'unsupported' }), { size: 'wide' });
    return;
  }

  openModal(shell(`
    ${head({ title, sub, meta: metaLine(null, context) })}
    <p class="text-sm text-slate-500">Reading the filing from NSE&hellip;</p>`), { size: 'wide' });

  let payload = null;
  let reason = 'unreachable';
  let detail = '';
  try {
    const res = await fetch(`api/nse-filing?src=${encodeURIComponent(url)}`, {
      // `no-cache` revalidates and reuses; `no-store` would forbid reuse outright and re-download a
      // document that can never change. Same rule as every other read in this codebase.
      cache: 'no-cache',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A STATIC ORIGIN IS NOT A BROKEN DEPLOYMENT. With no Worker there is no `/api/`, and what comes
    // back is the shell page or a 404 rather than JSON — which must not be reported as NSE failing.
    const type = res.headers.get('content-type') || '';
    if (res.status === 404 || res.status === 405 || res.status === 501 || !type.includes('json')) {
      reason = 'no-worker';
    } else {
      const body = await res.json();
      if (body?.ok) payload = body;
      else { reason = body?.reason || 'unreachable'; detail = body?.error || ''; }
    }
  } catch (err) {
    detail = String(err?.message || err);
  }

  if (stale()) return;
  const content = document.getElementById('modal-content');
  if (!content) return;
  // Swap the body rather than re-opening the modal: `openModal` installs a fresh Escape handler on
  // every call and only ever removes the newest, so calling it twice for one panel would leave one
  // behind. `trapFocus` re-queries its focusables on each Tab, so replacing the markup is safe --
  // only the close buttons, whose listeners went with the old nodes, have to be wired again.
  content.innerHTML = payload
    ? filingHtml(payload, { url, title, sub, meta: metaLine(payload, context) })
    : failureHtml({ url, title, sub, reason, detail });
  content.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', closeModal));
  content.querySelector('[data-filing-retry]')?.addEventListener('click', () => {
    closeModal();
    void openFilingReader(url, context);
  });
}

/** Row actions share the same rule as anchors. PDFs and other readable sources stay native. */
export function openFilingSource(url, context = {}) {
  if (isXbrlFilingUrl(url)) return openFilingReader(url, context);
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Install once for all scopes, including links inserted by later refreshes and drilldowns. */
export function installFilingReader(root = document) {
  if (root.__xbrlFilingReader) return () => {};
  const prepare = (anchor) => {
    if (!anchor?.matches('a[href]') || anchor.hasAttribute('data-xbrl-original')) return null;
    if (isXbrlFilingUrl(anchor.href)) anchor.href = readableFilingUrl(anchor.href);
    let url;
    try { url = new URL(anchor.href); } catch { return null; }
    const src = url.searchParams.get('src');
    if (url.origin !== location.origin || url.pathname !== '/filing' || !isXbrlFilingUrl(src)) return null;
    const href = new URL(readableFilingUrl(src), location.origin).href;
    if (anchor.href !== href) anchor.href = href;
    return src;
  };
  const scan = (node) => {
    if (node.matches?.('a[href]')) prepare(node);
    node.querySelectorAll?.('a[href]').forEach(prepare);
  };
  // Observe only added subtrees and changed hrefs, never rescan the full dashboard per update.
  // Writing real hrefs makes the browser menu and copied links readable without a click handler.
  scan(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') prepare(record.target);
      else record.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  const prepareEvent = (e) => prepare(e.target.closest?.('a[href]'));
  const onClick = (e) => {
    const anchor = e.target.closest?.('a[href]');
    const src = prepare(anchor);
    if (!src || anchor.hasAttribute('data-xbrl-page')) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const row = anchor.closest('[data-row-key]');
    void openFilingReader(src, {
      company: anchor.dataset.filingCompany || row?.querySelector('[data-watch]')?.dataset.watchName || null,
      ticker: anchor.dataset.filingTicker || row?.querySelector('[data-watch]')?.dataset.watch || null,
      subject: anchor.dataset.filingSubject || null,
    });
  };
  root.addEventListener('click', onClick, true);
  // Also cover an anchor inserted/changed synchronously just before activation.
  for (const event of ['pointerdown', 'contextmenu', 'auxclick']) root.addEventListener(event, prepareEvent, true);
  root.__xbrlFilingReader = true;
  return () => {
    observer.disconnect();
    root.removeEventListener('click', onClick, true);
    for (const event of ['pointerdown', 'contextmenu', 'auxclick']) root.removeEventListener(event, prepareEvent, true);
    root.__xbrlFilingReader = false;
  };
}
