import { escapeHtml } from '../core/dom.js';
import { companyCaptureStatus } from '../data/company-captures.js';
import { watchlistCapture } from '../data/watchlist-capture.js';

export function captureCoverageHtml(kind, tickers = null) {
  const status = companyCaptureStatus(kind, tickers);
  const identityErrors = Object.values(status.identitySources).map(source => source?.error).filter(Boolean);
  const registration = watchlistCapture.status();
  const hasGaps = !status.available || status.error || status.portfolio?.error || status.registration?.error || registration.remaining.length || identityErrors.length || status.gaps.length || status.unresolved.length || status.unavailableLinks;
  const tone = hasGaps ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200';
  const title = kind === 'domestic' ? 'Company filings' : 'Additional BSE / NSE / DRHP announcements';
  const summary = !status.available ? 'Automatic capture has not published a coverage report yet.' :
    `${status.checked} of ${status.total} companies recently checked · ${status.failed} failed · ${status.never} not checked · ${status.stale} overdue · ${status.unregistered} outside automatic capture` +
    (status.backfill ? ` · ${status.backfill} still backfilling history` : '') +
    (status.unresolved.length ? ` · ${status.unresolved.length} unresolved company entries` : '') +
    (status.unavailableLinks ? ` · ${status.unavailableLinks} source links unavailable` : '');
  return `<details class="my-3 rounded-lg p-3 text-xs ring-1 ${tone}" data-capture-coverage>
    <summary class="cursor-pointer font-semibold">${escapeHtml(title)} — ${escapeHtml(summary)}</summary>
    <p class="mt-2">${escapeHtml(status.error || '')} Scheduled capture keeps records between visits. A checked source can still omit records; these counts describe successful reads, not a guarantee of completeness.</p>
    <p class="mt-2">Watched companies enroll for shared capture automatically. Your watchlist membership stays on this device; removing a star does not erase captured filings.</p>
    ${status.portfolio?.error ? `<p class="mt-2">${escapeHtml(status.portfolio.error)}</p>` : ''}
    ${status.registration?.error ? `<p class="mt-2">${escapeHtml(status.registration.error)}</p>` : ''}
    ${registration.remaining.length ? `<p class="mt-2">${registration.remaining.length} watchlist companies awaiting capture registration. ${escapeHtml(registration.error || '')}</p>` : ''}
    ${identityErrors.length ? `<p class="mt-2">${escapeHtml(identityErrors.join(' '))}</p>` : ''}
    ${status.from ? `<p class="mt-2">Announcement backfill window: ${escapeHtml(status.from)} to ${escapeHtml(status.to)}. Captured history is retained beyond this window.</p>` : ''}
    ${status.updatedAt ? `<p class="mt-2">Coverage report updated ${escapeHtml(new Date(status.updatedAt).toLocaleString())}.</p>` : ''}
    ${status.unavailableLinks ? `<p class="mt-2">The source lists ${status.unavailableLinks} unavailable document links.</p>` : ''}
    ${status.unresolved.length ? `<p class="mt-2">Unresolved company identities: ${escapeHtml(status.unresolved.join(', '))}.</p>` : ''}
    ${status.gaps.length ? `<ul class="mt-2 max-h-48 overflow-auto">${status.gaps.map((gap) => `<li class="py-1">${escapeHtml(gap.ticker)}: ${escapeHtml(gap.reason)}${gap.lastSuccessAt ? ` · last success ${escapeHtml(new Date(gap.lastSuccessAt).toLocaleString())}` : ''}</li>`).join('')}</ul>` : ''}
  </details>`;
}
