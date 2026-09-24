import { loadCapturedDomesticFilings, loadDomesticFilings } from '../data/domestic-filings.js';
import { earningsReportDocument, earningsAnnouncementDocument, earningsDocumentUrl } from '../data/domestic-filings-shared.js';

import { capturedCompany } from '../data/company-captures.js';

export async function resolveEarningsReport(ticker, period, { signal, resultDate } = {}) {
  try {
    const captured = await capturedCompany('announcements', ticker);
    signal?.throwIfAborted();
    const filing = earningsAnnouncementDocument(captured.value.rows, ticker, period, resultDate);
    if (filing) return earningsDocumentUrl(filing.url);
  } catch (error) { if (error.name === 'AbortError') throw error; }

  let captured;
  try { captured = await loadCapturedDomesticFilings(ticker, 'earnings_report'); } catch { /* Try the source when the capture is unavailable. */ }
  signal?.throwIfAborted();
  const saved = earningsReportDocument(captured?.documents, ticker, period);
  if (saved) return earningsDocumentUrl(saved.url);
  let live;
  try { live = await loadDomesticFilings(ticker, 'earnings_report', { signal }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('The filing could not be checked. Please try again later.');
  }
  const report = earningsReportDocument(live.documents, ticker, period);
  if (report) return earningsDocumentUrl(report.url);
  if (live.stale) throw new Error('The filing could not be checked. Please try again later.');
  throw new Error(`The ${period || 'selected quarter'} filing for ${ticker} is not available yet. Please check back.`);
}

/** Open synchronously so a slow source read cannot turn a click into a blocked popup. */
export function wireEarningsReports(root) {
  const pending = new Set();
  const onClick = async event => {
    const button = event.target.closest('[data-earnings-report]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const ticker = button.dataset.earningsReport, period = button.dataset.reportPeriod;
    const popup = window.open('about:blank', '_blank');
    if (!popup) { window.alert('Please allow a new tab to open this filing, then click Reports again.'); return; }
    popup.opener = null;
    popup.document.title = `${ticker} — ${period} filing`;
    popup.document.documentElement.style.colorScheme = 'light dark';
    popup.document.body.style.cssText = 'font:16px system-ui,sans-serif;line-height:1.6;margin:48px;';
    const status = popup.document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = `Opening ${ticker} ${period} filing…`;
    popup.document.body.append(status);
    const controller = new AbortController();
    const request = { controller, popup };
    pending.add(request);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url = await resolveEarningsReport(ticker, period, { signal: controller.signal, resultDate: button.dataset.reportDate });
      if (!controller.signal.aborted && !popup.closed) popup.location.replace(url);
    } catch (error) {
      if (!popup.closed) status.textContent = error.name === 'AbortError'
        ? 'The filing request timed out. Return to the dashboard and click Reports to try again.'
        : error.message;
    } finally { clearTimeout(timer); pending.delete(request); }
  };
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    for (const { controller, popup } of pending) { controller.abort(); if (!popup.closed) popup.close(); }
    pending.clear();
  };
}
