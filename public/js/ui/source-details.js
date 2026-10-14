// The active reader supplies its own measured collection details. The source
// beacon never imports a tab renderer or starts a source read to show this link.
let active = null;
const listeners = new Set();
export const collectionDetails = () => active?.read() || null;
export function setCollectionDetails(owner, read) {
  active = { owner, read };
  notifyCollectionDetails(owner);
}
export function notifyCollectionDetails(owner) {
  if (active?.owner === owner) for (const listener of listeners) listener();
}
export function clearCollectionDetails(owner) {
  if (active?.owner !== owner) return;
  active = null;
  for (const listener of listeners) listener();
}
export function onCollectionDetailsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
