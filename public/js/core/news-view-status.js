// Reader-side completeness is independent of the newest file timestamp. The shared reader owns
// source checks; this maps its measured state into a compact label without hiding retained rows.
function enrichmentCheckCurrent(coverage, now = Date.now()) {
  const checked = Date.parse(coverage?.capturedAt || '');
  return Number.isFinite(checked) && checked <= now + 10 * 60_000 && now - checked <= 24 * 3600_000;
}

export function enrichmentCoverageIncomplete(coverage, now = Date.now()) {
  // Legacy snapshots can omit this extension. Absence is unknown coverage, not a failed fetch;
  // callers must retain their missing-coverage explanation rather than inventing a success time.
  if (!coverage) return false;
  return !enrichmentCheckCurrent(coverage, now) ||
    ['staleOrIncompleteQueries', 'pagesFailed'].some(key => !Number.isSafeInteger(coverage[key]) || coverage[key] !== 0) ||
    (coverage.documentsPending != null && (!Number.isSafeInteger(coverage.documentsPending) || coverage.documentsPending !== 0));
}

export function newsViewStatus(meta) {
  const delivery = meta.newsDelivery || {};
  const parts = Object.values(delivery).filter(part => part && typeof part === 'object' && 'status' in part);
  const enrichment = meta.enrichmentCoverage || {};
  const enrichmentPartial = enrichmentCoverageIncomplete(meta.enrichmentCoverage);
  const failed = parts.some(part => part.historyError || (part.status !== 'pending' && part.error) || ['partial', 'unavailable', 'failed'].includes(part.status)) ||
    !!meta.reason || !!meta.failed || !!meta.newsHistory?.error || !!meta.tradingViewReadError || enrichmentPartial;
  const pending = parts.some(part => part.pending || part.status === 'pending') ||
    meta.loaded === false || !!meta.pending || !!meta.inFlight;
  const hasRows = meta.rowCount > 0;
  if (failed) return {
    state: 'partial', label: hasRows ? 'Partial coverage · retained articles shown' : 'Some sources unavailable',
    detail: 'At least one source, discovery or history read is incomplete. Available articles remain searchable; missing results are not proof of no news.' +
      (meta.enrichmentCoverage && !enrichmentCheckCurrent(meta.enrichmentCoverage) ? ' Related-company / official-site discovery check time is stale or unverified.' : '') +
      (enrichmentPartial ? ` Related-company / official-site discovery: ${Number(enrichment.staleOrIncompleteQueries) || 0} queries awaiting completion; ${Number(enrichment.pagesFailed) || 0} page reads failed; ${Number(enrichment.documentsPending) || 0} documents not yet read.` : ''),
  };
  if (pending) return {
    state: 'loading', label: hasRows ? 'Loading remaining sources · partial view' : 'Loading news sources…',
    detail: 'Articles and publisher choices appear as each source arrives. This is not the complete loaded view yet.',
  };
  if (parts.some(part => part.historyPending) || meta.newsHistory?.pending || meta.newsHistory?.loaded === false) return {
    state: 'loading', label: 'Loading retained history · partial view',
    detail: 'Latest articles remain searchable while archived news is loaded. Historical results are not complete yet.',
  };
  // "Loaded" is about delivery to this browser, not a claim that every upstream company query
  // succeeded recently. Exact source checks and capture gaps remain in the coverage details.
  return {
    state: 'loaded', label: 'Published sources loaded',
    detail: 'The available published feeds and retained history are loaded. Source check times and coverage gaps are shown in collection details; this is not a real-time or exhaustive-coverage guarantee.',
  };
}
