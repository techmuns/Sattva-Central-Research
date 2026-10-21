// Weekly edition, independent of the public-market brief's settings and ledger.
export const PRIVATE_MARKETS_TITLE = 'Private Markets Intelligence';
export const PRIVATE_MARKETS_EDITION = 'private-markets';
export const IST = 19800000, WEEK = 7 * 86400000;
export function privateMarketsSlot(at = Date.now(), { next = false } = {}) {
  const local = new Date(at + IST), day = local.toISOString().slice(0, 10);
  const midnight = Date.parse(day + 'T00:00:00Z');
  let slot = midnight - ((local.getUTCDay() + 6) % 7) * 86400000 + 9 * 3600000 - IST;
  if (next && slot <= at) slot += WEEK;
  if (!next && slot > at) slot -= WEEK;
  return { at: slot, day: new Date(slot + IST).toISOString().slice(0, 10), key: `private-markets:${new Date(slot + IST).toISOString().slice(0, 10)}` };
}
