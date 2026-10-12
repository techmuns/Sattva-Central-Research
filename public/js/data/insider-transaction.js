import { pickField } from './filings-shared.js';

const TRANSACTION_KEYS = ['transaction', 'transaction type', 'acq/disp', 'acquisition/disposal'].map(key => [key]);

/** Preserve source wording, but a share count/security description is not an action. */
export function transactionText(value) {
  const text = String(value ?? '').trim();
  return text && /[A-Za-z]/.test(text) && !/^[+-]?\d/.test(text) ? text : null;
}

/** A malformed preferred field must not mask a usable source heading. */
export function insiderTransactionType(row) {
  for (const key of TRANSACTION_KEYS) {
    const value = transactionText(pickField(row?.cells, key));
    if (value) return value;
  }
  return null;
}
