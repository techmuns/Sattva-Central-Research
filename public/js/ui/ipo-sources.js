// Source-panel presentation only: reads the IPO tab's existing feed, never starts a fetch.
import * as feed from '../data/ipo-filings.js';
import { IPO_ALL_SOURCE_IDS, ipoSourceIsStale, filingUrl } from '../data/ipo-filings-shared.js';
import { escapeHtml } from '../core/dom.js';

const NAMES = ['NSE mainboard', 'NSE SME', 'BSE SME', 'SEBI drafts', 'SEBI red herring', 'SEBI final offers', 'SEBI other documents', 'IPOPlatform catalogue & DRHPs'];
const stamp = (at) => Number.isFinite(Date.parse(at))
  ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
  : 'Not yet checked';
const cadence = 'Checks on opening or returning to IPOs, then every five minutes while visible. Shared responses may be cached for five minutes. IPOPlatform is collected hourly by GitHub Actions even while closed; schedules and source publication can lag. Official-source reads remain on demand.';

export function ipoSourceGroup(meta = feed.meta(), now = Date.now()) {
  const hasCapture = meta.sources.length > 0;
  const notes = [
    cadence,
    'SEBI supplies recent listing windows, supplemented by NSE mainboard, NSE SME, BSE SME and retained history. Older SEBI pages are not automatically crawled. BSE-only mainboard filings absent from these sources may be missing.',
    'IPOPlatform supplements discovery, not official verification. Exact official document URLs suppress duplicate secondary copies; different URLs are not assumed identical. Missing exchange filing dates are not inferred from publisher document dates. Filing does not mean an IPO is approved or open.',
    'Each successful collection carries forward prior history. GitHub artifacts have 30-day retention; a longer collector outage needs archive recovery. This is not a complete historical archive.',
  ];
  if (hasCapture) notes.unshift(`${meta.count.toLocaleString('en-IN')} captured documents · ${meta.undated.toLocaleString('en-IN')} without a supplied filing date.`);
  if (meta.liveFailed && meta.loaded) notes.push('Live feed unavailable. Retained captures have not been confirmed on this visit.');
  if (meta.snapshotFailed) notes.push('Bundled history unavailable; previously captured records may be missing.');
  if (meta.capped) notes.push('Local history limit reached; older records may be omitted.');
  return {
    id: 'ipo-filings', title: 'IPO filings', icon: '📄', tabs: 'IPOs · All Alerts', notes,
    items: IPO_ALL_SOURCE_IDS.map((id, index) => {
      const source = meta.sources.find((s) => s.id === id);
      const stale = ipoSourceIsStale(source, now);
      const readState = !source ? 'unchecked' : source.status !== 'ok' ? 'unavailable'
        : !meta.loaded || meta.liveFailed ? 'unconfirmed' : stale ? 'dated' : source.unmapped ? 'partial' : 'read';
      const readLabel = { unchecked: 'Not checked', unavailable: 'Unavailable', unconfirmed: 'Unconfirmed', dated: 'Dated', partial: 'Partial', read: source?.delivery === 'scheduled' ? 'Collected' : 'Read' }[readState];
      const details = [
        source ? `Last check: ${stamp(source.checkedAt)}.` : 'Open IPOs to check this source. No source read has completed in this session.',
        ...(source?.status === 'ok' && Number.isFinite(source.count) ? [`${source.count.toLocaleString('en-IN')} documents in the last successful response.`] : []),
        source?.note || 'Official public-issue documents, including issuers without listed symbols.',
        ...(readState === 'unconfirmed' || readState === 'dated' ? ['Retained reading; not a freshly confirmed source response.'] : []),
      ];
      return {
        id, name: NAMES[index], url: filingUrl(source?.url),
        // The live-feed count measures configured refresh feeds, not successful latest reads.
        // The independent read state controls the row's dot and explicit health label.
        status: 'live', readState, readLabel, details,
        feeds: `<strong>${escapeHtml(readLabel)}.</strong> ${details.map(escapeHtml).join(' ')}`,
        cadence, file: 'worker/ipo-filings.mjs · public/js/data/ipo-filings.js',
      };
    }),
  };
}
