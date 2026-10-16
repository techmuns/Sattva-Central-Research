import {hash} from './mutual-funds-seal.mjs';
export const BACKGROUND_FEATURES=['mutual-funds','breakouts','summaries','price-levels','newsletter'];
// This identifies the prepared-file contract, independently of changing source
// observations and unrelated dashboard commits. Incompatible formats advance it.
export async function backgroundContract(feature) {
  if(!BACKGROUND_FEATURES.includes(feature)&&feature!=='breakouts-live')throw Error('Unknown prepared background feature');
  return hash(new TextEncoder().encode(`research-prepared-static:${feature}:v1`));
}
