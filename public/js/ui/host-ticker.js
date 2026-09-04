// ui/host-ticker.js — the company the HOST has selected, named in this dashboard's header.
//
// The Munshot host carries a selected company across every dashboard embedded in it, and pushes it
// down the SDK channel as `context.market.selectedTicker`. Receiving it and doing nothing with it
// would make the integration inert, so this is the surface: one chip beside the scope toggle,
// naming the selection and opening All Alerts filtered to it.
//
// WHY THIS IS A CHIP AND NOT A FILTER OVER THE WHOLE DASHBOARD, which is the obvious alternative:
//
//   * **This dashboard is not ticker-bound and must not become so.** Every tab here is a
//     multi-company screener whose row set is decided by the scope toggle — Portfolio, Watchlist,
//     Universe. A host selection silently narrowing all eleven tabs to one company would be a
//     fourth scope that the toggle does not show and the reader did not set, and the scope is the
//     single most important fact about any number on this page (see CLAUDE.md, *Three scopes*).
//   * **So there is nothing here to gate on a null ticker.** The published pattern says a
//     ticker-bound widget shows an empty state and sends no ticker-dependent request when the host
//     has selected nothing. Not one widget in this dashboard is ticker-bound and not one request
//     here takes a ticker from the host, so the honest rendering of "no selection" is no chip at
//     all — never eleven tabs of "No stock selected" over feeds that are complete without one.
//   * **It navigates rather than filters.** `#/research/daily-alerts?company=<ticker>` is the
//     route AI Alerts already uses to hand a company to All Alerts, so the host's selection
//     lands the reader exactly where a company clicked inside this dashboard would.
//
// Off-host — a plain static origin, which is how the verification suite drives this — there is no
// context, so this renders nothing and costs nothing.

import { escapeHtml } from '../core/dom.js';
import { getHostContext, onHostContext } from '../core/host-context.js';
import { state } from '../core/state.js';

/**
 * Markup for the chip, or an empty string when the host has selected nothing.
 *
 * Colours are the ticker-badge tokens from the Munshot UI standard — `#eef2ff` ground, `#e0e7ff`
 * border, `#4338ca` text — which sit on this dashboard's own indigo brand ramp rather than beside
 * it, so the chip reads as part of the header instead of as a second design.
 */
function chipHtml() {
  const { ticker, tickerCompany } = getHostContext();
  if (!ticker) return '';

  // The company name when the host sent one, the symbol when it did not. Never the symbol printed
  // where a name belongs and dressed as one — the same rule the watchlist follows.
  const label = tickerCompany || ticker;
  const sub = tickerCompany ? ticker : null;

  return `
    <button
      type="button"
      data-host-ticker="${escapeHtml(ticker)}"
      class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition hover:brightness-95"
      style="background:#eef2ff;border-color:#e0e7ff;color:#4338ca"
      title="Selected in Munshot: ${escapeHtml(label)}. Opens All Alerts filtered to this company."
    >
      <span class="h-1.5 w-1.5 rounded-full" style="background:#4f46e5"></span>
      <span class="max-w-[13rem] truncate">${escapeHtml(label)}</span>
      ${sub ? `<span class="font-semibold opacity-70">${escapeHtml(sub)}</span>` : ''}
    </button>`;
}

/**
 * Mount the chip into `mountEl` and keep it in step with the host.
 *
 * Returns a disposer. The subscription is the shell's, not a tab's: the host can change its
 * selection at any moment, whichever tab is open, and the header outlives every route change.
 */
export function mountHostTicker(mountEl) {
  if (!mountEl) return () => {};

  const paint = () => {
    const html = chipHtml();
    mountEl.innerHTML = html;
    // `hidden` as a property, not a class: the header lays its cluster out with `gap-2`, so an
    // empty-but-present mount would show a gap with nothing in it on every static-origin load.
    mountEl.hidden = !html;
  };

  paint();

  const onClick = (event) => {
    const button = event.target.closest('[data-host-ticker]');
    if (!button || !mountEl.contains(button)) return;
    const ticker = button.getAttribute('data-host-ticker');
    if (!ticker) return;
    // The reader's own scope is preserved: the host said WHICH company, not which list to read it
    // against, and silently widening to Universe would answer a question nobody asked.
    location.hash = `#/research/daily-alerts?scope=${encodeURIComponent(state.scope)}&company=${encodeURIComponent(ticker)}`;
  };

  mountEl.addEventListener('click', onClick);

  // Repaint only when the host's MARKET context actually changed. `onHostContext` already fires on
  // real changes rather than on every message, and checking `changed.market` keeps a token refresh
  // from rebuilding a chip that says the same thing.
  const off = onHostContext((_ctx, changed) => {
    if (changed?.market || changed?.first) paint();
  });

  return () => {
    off();
    mountEl.removeEventListener('click', onClick);
    mountEl.innerHTML = '';
  };
}
