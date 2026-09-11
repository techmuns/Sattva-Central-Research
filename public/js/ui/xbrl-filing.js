// ui/xbrl-filing.js — an NSE XBRL announcement, opened as a filing rather than as XML.
//
// THE PROBLEM THIS CLOSES. Nine per cent of NSE's announcement feed links to a raw XBRL file
// instead of a PDF (measured: 150 of 1,693 items on one live pull), and every one of those rows —
// on NSE Filings, on All Alerts, on an AI Alerts card — sent the reader to a browser page reading
// "This XML file does not appear to have any style information associated with it" above a tree of
// SEBI namespaces. The filing was there the whole time; nothing was rendering it. NSE publish no
// readable twin and no CORS header, so the Worker route `/api/nse-filing` reads the file and the
// shared parser turns it into the exchange's own facts, in the exchange's own order.
//
// ONE INTERCEPTOR, NOT A CHECK IN EVERY TAB. Every surface that offers one of these filings does it
// the same way — an `<a href>` at the URL — so this installs a single delegated listener and asks
// one question of the href. Spreading `isXbrlFilingUrl` through five tabs is how a rule ends up
// with five spellings that disagree; the row-click path in All Alerts opens the URL with
// `window.open` rather than an anchor, so that one calls `openFilingReader` directly.
//
// AND IT IS NEVER WORSE THAN THE LINK IT REPLACED. On a static origin there is no Worker, so there
// is no `/api/nse-filing`: the panel says so in those words and offers the original document, which
// is exactly where the click used to land. A failure here costs the reader one extra click; it can
// never cost them the filing.

import { escapeHtml } from '../core/dom.js';
import { openModal, closeModal } from './screener.js';
import { isXbrlFilingUrl } from '../data/nse-xbrl-shared.js';

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

const sourceLink = (url, label) => `
  <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
     class="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">${escapeHtml(label)} &#8599;</a>`;

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
    ? 'This copy of the dashboard is served without its Worker, so it has no route that can read NSE. The filing itself is fine.'
    : reason === 'unsupported'
      ? 'This document is not one of NSE’s XBRL announcement files, so there is nothing here to lay out.'
      : 'NSE could not be read for this filing just now.';
  return shell(`
    ${head({ title, sub, meta: 'Filed to NSE as an XBRL data file' })}
    <p class="text-sm text-slate-600">${escapeHtml(words)}</p>
    ${detail ? `<p class="mt-1 text-xs text-slate-400">${escapeHtml(detail)}</p>` : ''}
    <p class="mt-4 text-xs text-slate-500">The original is published by the exchange and opens in a new tab. It is XBRL, so a browser shows it as data rather than as a page.</p>
    <div class="mt-3">${sourceLink(url, 'Open the original file on NSE')}</div>`);
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
      ${sourceLink(url, 'Open the original file on NSE')}
    </div>`);
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
}

/**
 * Install the one delegated listener, once, for the whole app.
 *
 * CAPTURE PHASE AND A NARROW PREDICATE. It runs before the tables' own delegated handlers so the
 * anchor never opens its tab, and it acts only on a left click, unmodified, on an `<a>` whose href
 * passes the strict URL guard — so a middle click, a ctrl-click and "open in new tab" all still do
 * exactly what the reader asked, which is to have the raw document.
 */
export function installFilingReader(root = document) {
  if (root.__xbrlFilingReader) return () => {};
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = e.target.closest?.('a[href]');
    if (!anchor || !isXbrlFilingUrl(anchor.href)) return;
    e.preventDefault();
    e.stopPropagation();
    const row = anchor.closest('[data-row-key]');
    void openFilingReader(anchor.href, {
      company: anchor.dataset.filingCompany || row?.querySelector('[data-watch]')?.dataset.watchName || null,
      ticker: anchor.dataset.filingTicker || row?.querySelector('[data-watch]')?.dataset.watch || null,
      subject: anchor.dataset.filingSubject || null,
    });
  };
  root.addEventListener('click', onClick, true);
  root.__xbrlFilingReader = true;
  return () => { root.removeEventListener('click', onClick, true); root.__xbrlFilingReader = false; };
}
