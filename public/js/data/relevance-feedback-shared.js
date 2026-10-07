// data/relevance-feedback-shared.js — ONE SHARED RELEVANCE PREFERENCE, LEARNED FROM THE DESK'S VOTES.
//
// Important / Not important, with an optional "Why?", on Corporate Announcements, News and All
// Alerts. Every vote trains the SAME preference for the whole deployment — not a model per person —
// and that preference re-orders all three surfaces. This module is the one definition of a vote and
// of what votes mean, imported by the browser (to score rows), the feedback store (to aggregate) and
// the announcement index (to rank server-side). It is pure: no fetch, no DOM, no storage.
//
// HOW A VOTE BECOMES A WEIGHT. A vote carries the FEATURES of the item it was cast on — its category
// tags, its company's size band and sector, how large any stated amount is against the company's
// size, its direction — as plain keys (see relevance.js). For every key the store keeps how many
// votes on items carrying it said Important and how many said Not important. A key's learned weight
// is a smoothed log-odds of those two counts, shrunk toward zero while there are few votes behind it:
//
//     w = clamp(RATE × ln((important + 1) / (not + 1)), ±KEY_CAP) × n / (n + SHRINK)
//
// so one vote nudges, several agree before a topic moves far, and a key nobody voted on is exactly
// zero. An item's learned adjustment is the sum over its keys, capped at ±ITEM_CAP — enough to
// reorder a day, never enough to bury an item: every item stays in the list, only its place moves.
// The item voted on (and the filings stitched to it) also carries a direct adjustment, so the
// person who voted sees the effect at once.
//
// EACH TAB CAN RANK INDEPENDENTLY. Every key is learned twice: globally, from every surface's votes,
// and per surface, from that surface's votes alone. A surface reads both, so a desk that treats
// news about order wins differently from the filings themselves gets two different answers — while
// a vote cast anywhere still teaches every surface something.

export const FEEDBACK_VERSION = 1;
export const SURFACES = Object.freeze(['announcements', 'news', 'alerts']);
export const VOTES = Object.freeze({ important: 1, 'not-important': -1 });
export const WHY_MAX = 500;
export const FEATURES_MAX = 48;
export const LABEL_MAX = 300;
export const FEEDBACK_REQUEST_BYTES = 16 * 1024;

// Learning constants (see the header). Changing them re-weights every past vote; that is intended.
export const RATE = 1.1;
export const KEY_CAP = 2.5;
export const SHRINK = 3;
export const ITEM_CAP = 6;
export const DIRECT_STEP = 2.5;
export const DIRECT_CAP = 5;
export const EVENT_SHARE = 0.5;
// How many directly-voted items the published model carries. Older direct entries still shape the
// key weights; only their per-item nudge stops being published.
export const DIRECT_ITEMS_MAX = 4000;
export const RECENT_MAX = 40;

const KEY_PATTERN = /^[a-z0-9][a-z0-9:_.|&-]{0,95}$/;

/**
 * THE FEATURE KEYS AN ITEM IS LEARNED ON — one definition, used by the relevance reading in the
 * browser and on the runner, and by the announcement index in the Worker, so a vote cast on one
 * surface lands on exactly the keys every other surface reads. Every input is a plain field.
 */
export function featureKeys({ categories = [], band = 'unknown', group = null, kind = 'filing', feed = null, impact = null,
  direction = null, prospective = false, processUpdate = false, duplicate = false, repeat = false, importance = null, match = null } = {}) {
  const keys = categories.map((id) => `cat:${id}`);
  keys.push(`size:${band || 'unknown'}`, `kind:${kind === 'alert' ? `alert-${feed || 'other'}` : kind}`);
  if (prospective) keys.push('prospective');
  if (processUpdate) keys.push('process-update');
  if (group) {
    keys.push(`sector:${group}`);
    for (const id of categories) keys.push(`sc:${group}:${id}`);
  }
  if (impact) keys.push(`impact:${impact}`);
  if (direction) keys.push(`dir:${direction}`);
  if (duplicate) keys.push('dup');
  if (repeat) keys.push('repeat');
  if (kind === 'alert' && importance === 'high') keys.push('alert:high');
  // Outside All Alerts the feed is still learnable where it names a source type (an X post in News).
  if (feed && kind !== 'alert') keys.push(`src:${feed}`);
  if (match) keys.push(`match:${match}`);
  return [...new Set(keys)].filter((k) => KEY_PATTERN.test(k)).slice(0, FEATURES_MAX);
}
const ITEM_PATTERN = /^[\x21-\x7e]{1,300}$/;
const DEVICE_PATTERN = /^[a-z0-9-]{8,64}$/;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A vote as the store accepts it, or an Error naming what is wrong. Unauthenticated, so every field
 * is bounded and nothing a caller sends can name another vote: a device may only replace its own.
 */
export function normaliseVote(input = {}) {
  const surface = String(input.surface || '');
  if (!SURFACES.includes(surface)) throw new Error('Invalid feedback surface');
  const vote = String(input.vote || '');
  if (!(vote in VOTES) && vote !== 'clear') throw new Error('Invalid feedback vote');
  const itemKey = String(input.itemKey || '');
  if (!ITEM_PATTERN.test(itemKey)) throw new Error('Invalid feedback item');
  const eventKey = input.eventKey == null || input.eventKey === '' ? null : String(input.eventKey);
  if (eventKey !== null && !ITEM_PATTERN.test(eventKey)) throw new Error('Invalid feedback event');
  const device = String(input.device || '');
  if (!DEVICE_PATTERN.test(device)) throw new Error('Invalid feedback device');
  const features = [...new Set((Array.isArray(input.features) ? input.features : []).map(String))];
  if (features.length > FEATURES_MAX || features.some((f) => !KEY_PATTERN.test(f))) throw new Error('Invalid feedback features');
  return {
    surface, vote, itemKey, eventKey, device, features,
    why: clean(input.why, WHY_MAX) || null,
    label: clean(input.label, LABEL_MAX) || null,
    company: clean(input.company, 120) || null,
    categories: (Array.isArray(input.categories) ? input.categories : []).map(String).filter((c) => KEY_PATTERN.test(c)).slice(0, 8),
  };
}

const ln = Math.log;
const clamp = (n, cap) => Math.max(-cap, Math.min(cap, n));
export function keyWeight(important = 0, notImportant = 0) {
  const n = important + notImportant;
  if (!n) return 0;
  return clamp(RATE * ln((important + 1) / (notImportant + 1)), KEY_CAP) * (n / (n + SHRINK));
}
export const directWeight = (net) => (net ? Math.sign(net) * Math.min(DIRECT_CAP, DIRECT_STEP + Math.abs(net) - 1) : 0);

/**
 * The published model from the current votes (one per device and item — a later vote replaces an
 * earlier one, and `clear` withdraws it). Pure, so the store, the tests and any re-build agree.
 *
 * @param {Array<{surface, vote, itemKey, eventKey, features, why, label, company, categories, at}>} votes
 */
export function aggregateModel(votes = [], { now = Date.now() } = {}) {
  const global = new Map();
  const bySurface = Object.fromEntries(SURFACES.map((s) => [s, new Map()]));
  const items = new Map();
  const events = new Map();
  let counted = 0, latest = 0;
  const bump = (map, key, value) => {
    const entry = map.get(key) || [0, 0];
    entry[value > 0 ? 0 : 1] += 1;
    map.set(key, entry);
  };
  for (const vote of votes) {
    const value = VOTES[vote.vote];
    if (!value) continue;
    counted++;
    latest = Math.max(latest, Number(vote.at) || 0);
    for (const feature of vote.features || []) {
      bump(global, feature, value);
      bump(bySurface[vote.surface] || new Map(), feature, value);
    }
    items.set(vote.itemKey, (items.get(vote.itemKey) || 0) + value);
    if (vote.eventKey) events.set(vote.eventKey, (events.get(vote.eventKey) || 0) + value);
  }
  const weights = (map) => Object.fromEntries([...map].map(([key, [yes, no]]) => [key, round(keyWeight(yes, no))]).filter(([, w]) => w !== 0).sort());
  const direct = (map) => Object.fromEntries([...map].filter(([, net]) => net).slice(-DIRECT_ITEMS_MAX).map(([key, net]) => [key, round(directWeight(net))]));
  const recent = votes.filter((v) => VOTES[v.vote]).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, RECENT_MAX)
    .map((v) => ({ surface: v.surface, vote: v.vote, label: v.label, company: v.company, categories: v.categories || [], why: v.why, at: v.at ? new Date(Number(v.at)).toISOString() : null }));
  const model = {
    version: FEEDBACK_VERSION,
    votes: counted,
    updatedAt: latest ? new Date(latest).toISOString() : null,
    builtAt: new Date(now).toISOString(),
    weights: weights(global),
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, weights(bySurface[s])])),
    items: direct(items),
    events: direct(events),
    recent,
    constants: { RATE, KEY_CAP, SHRINK, ITEM_CAP, DIRECT_STEP, DIRECT_CAP, EVENT_SHARE },
  };
  model.revision = revisionOf(model);
  return model;
}

const round = (n) => Math.round(n * 1000) / 1000;

// FNV-1a over the parts that change an answer; `builtAt` is not one of them.
export function revisionOf(model) {
  const text = JSON.stringify([model.version, model.votes, model.weights, model.surfaces, model.items, model.events]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `fb${FEEDBACK_VERSION}-${(h >>> 0).toString(16)}-${model.votes}`;
}

export const EMPTY_MODEL = Object.freeze(aggregateModel([], { now: 0 }));

/**
 * The learned part of one item's relevance: its keys' global and per-surface weights (capped at
 * ±ITEM_CAP together), plus the direct nudge from votes on this very item and on its event.
 */
export function learnedAdjustment(model, { keys = [], surface = null, itemKey = null, eventKey = null } = {}) {
  if (!model || !model.votes) return 0;
  const surfaceWeights = (surface && model.surfaces?.[surface]) || null;
  let total = 0;
  for (const key of keys) {
    total += model.weights?.[key] || 0;
    if (surfaceWeights) total += surfaceWeights[key] || 0;
  }
  total = clamp(total, ITEM_CAP);
  if (itemKey && model.items?.[itemKey]) total += model.items[itemKey];
  else if (eventKey && model.events?.[eventKey]) total += model.events[eventKey] * EVENT_SHARE;
  return round(total);
}
