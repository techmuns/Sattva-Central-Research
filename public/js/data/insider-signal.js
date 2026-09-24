// data/insider-signal.js — THE INSIDER / BULK / BLOCK / SAST READING, in one pure module.
//
// General Alerts read a trade's direction off the upstream's own transaction word and its importance
// off two stated thresholds. The team brief now carries the same rows in the email, and a second copy
// of these regexes in the Worker is exactly the "two predicates over one question" this codebase
// keeps having to un-write — so the rule lives here, with no DOM, no storage and no network, and
// `daily-alerts.js` re-exports it unchanged for every consumer that already reads it from there.

export const INSIDER_HIGH_PCT = 1;
export const INSIDER_HIGH_VALUE = 100_000_000; // ₹10 crore

const DIRECTION = { POSITIVE: 'positive', NEGATIVE: 'negative', NEUTRAL: 'neutral' };
const IMPORTANCE = { HIGH: 'high', LOW: 'low' };

/**
 * A rupee amount or a percentage as the upstream printed it — "2.25 crore", "74.84 lacs", "0.51",
 * "1,20,000" — as a number, or null where nothing numeric was carried.
 */
export const parseIndianAmount = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/\d/.test(text)) return null;
  const n = Number(text.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/\b(?:crore|cr)\b/i.test(text)) return n * 10_000_000;
  if (/\b(?:lakh|lac|lacs)\b/i.test(text)) return n * 100_000;
  return n;
};

/** Transaction direction plus comparable, stated thresholds; unknown transaction words stay neutral. */
export function insiderSignal(cells = {}) {
  const transaction = String(cells.Transaction ?? cells['Acq/Disp'] ?? '').trim();
  const mode = String(cells.Mode ?? '').trim();
  const transactionWords = transaction.toLowerCase();
  const modeWords = mode.toLowerCase();
  let direction = DIRECTION.NEUTRAL;
  let basis = 'No recognised directional transaction word was carried; shown as neutral.';
  // Transaction is the authoritative action. Mode describes how it happened and is consulted
  // only for a generic/pledge transaction; otherwise "Disposal · Market Purchase" becomes a buy.
  if (/\b(?:revoke|revocation|release)\w*\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream transaction wording.';
  } else if (/\binvoke\w*\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream transaction wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sold|sale)\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream transaction wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|bought|purchase)\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream transaction wording.';
  } else if (/\bpledge\b/.test(transactionWords)) {
    if (/\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
      direction = DIRECTION.POSITIVE;
      basis = 'Pledge release/revocation in the upstream mode wording.';
    } else {
      direction = DIRECTION.NEGATIVE;
      basis = 'Pledge creation/invocation in the upstream transaction wording.';
    }
  } else if (/\b(?:revoke|revocation|release)\w*\b.*\bpledge\b|\bpledge\b.*\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream mode wording.';
  } else if (/\b(?:invoke\w*|creat\w*)\b.*\bpledge\b|\bpledge\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream mode wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sold|sale)\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream mode wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|bought|purchase)\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream mode wording.';
  }

  const pct = parseIndianAmount(cells['Trade %']);
  const value = parseIndianAmount(cells['Trade Value']);
  const highPct = pct != null && Math.abs(pct) >= INSIDER_HIGH_PCT;
  const highValue = value != null && Math.abs(value) >= INSIDER_HIGH_VALUE;
  const importance = highPct || highValue ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
  const why = [
    highPct ? `${Math.abs(pct).toFixed(2)}% is at least ${INSIDER_HIGH_PCT}%` : null,
    highValue ? `₹${(Math.abs(value) / 10_000_000).toFixed(1)} crore is at least ₹${INSIDER_HIGH_VALUE / 10_000_000} crore` : null,
  ].filter(Boolean);
  const signalReason = basis;
  const importanceReason = why.length ? `High: ${why.join(' and ')}.` : `Low: below ${INSIDER_HIGH_PCT}% and ₹${INSIDER_HIGH_VALUE / 10_000_000} crore, or those values were not carried.`;
  return {
    direction,
    importance,
    signalReason,
    importanceReason,
    // Kept for notification/backward compatibility: a negative reading is an alert, every other an update.
    severity: direction === DIRECTION.NEGATIVE ? 'alert' : 'update',
    reason: signalReason,
  };
}
