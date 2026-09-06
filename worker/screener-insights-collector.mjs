import {
  SCREENER_INSIGHTS_ARTIFACT, SCREENER_INSIGHTS_COMPRESSED_LIMIT, SCREENER_INSIGHTS_LIMIT,
  SCREENER_INSIGHTS_REPO, validateScreenerInsightsCapture,
} from '../public/js/data/screener-insights-shared.js';
import { INSIGHTS_STATE_ARTIFACT, INSIGHTS_STATE_LIMIT, validateInsightState,
  insightCollectionFailed, insightCoolingDown } from '../public/js/data/screener-insights-state.js';
import { insightArtifactReader } from './screener-insights-artifact.mjs';

export async function readScreenerInsightsCollector({ allowMissing = false, now = Date.now, ...options } = {}) {
  const read = insightArtifactReader(options);
  // Restore control even before the first successful company. An unreadable cooldown fails closed.
  const control = await read({ name: INSIGHTS_STATE_ARTIFACT, compressedLimit: INSIGHTS_STATE_LIMIT,
    rawLimit: INSIGHTS_STATE_LIMIT, validate: value => validateInsightState(value, now()) });
  const data = await read({ name: SCREENER_INSIGHTS_ARTIFACT, compressedLimit: SCREENER_INSIGHTS_COMPRESSED_LIMIT,
    rawLimit: SCREENER_INSIGHTS_LIMIT, validate: value => validateScreenerInsightsCapture(value, now()) });
  const state = control?.value || null;
  if (!data && !allowMissing) {
    const error = Error('No Screener Insights capture is available');
    error.insightsCooldownUntil = state?.cooldownUntil || null;
    throw error;
  }
  if (!data) return { capture: null, state, source: null };
  const capture = data.value;
  // A setup/restore failure may publish no artifacts, but must not disappear from source health.
  const latest = await read.latestRun() || (control && control.run.id > data.run.id ? control.run : data.run);
  const failed = insightCollectionFailed(state) || latest.conclusion !== 'success';
  return { capture, state, source: {
    id: 'screener-insights', status: failed ? 'partial' : 'ok', checkedAt: capture.checkedAt,
    targets: capture.targetCount, companies: capture.companies.length,
    metrics: capture.companies.reduce((sum, company) => sum + company.rows.length, 0), fullCoverage: capture.fullCoverage,
    collectorRunId: data.run.id, collectorRunUrl: `https://github.com/${SCREENER_INSIGHTS_REPO}/actions/runs/${data.run.id}`,
    collectorLatestFailed: failed, collectorLatestConclusion: latest.conclusion,
    collection: state ? { attemptedAt: state.attemptedAt, outcome: state.outcome, reason: state.reason,
      cooldownUntil: state.cooldownUntil, coolingDown: insightCoolingDown(state, now()), counts: state.counts } : null,
  } };
}
