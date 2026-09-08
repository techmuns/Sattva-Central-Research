import { authHeaders, hostToken, onHostContext } from '../core/host-context.js';
import { boundedJson } from './family-book-contract.js';
import { validateSummaryBody, SUMMARY_TRANSPORT_LIMIT, SUMMARY_RECORD_LIMIT } from './concall-summaries-shared.js';

const ENDPOINT = 'api/concall-summaries';
const INTERVAL = 60000;
let state = null, checked = 0, pending = null, generation = 0, mounted = 0;
const bodies = new Map();
let savedIds = new Set();
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };
export const status = () => state;
export const available = (ids = null) => !!state && !['access', 'no-session'].includes(state.reason) &&
  (state.enabled === true || (ids ? ids.some(id => savedIds.has(id)) : savedIds.size > 0));
export const onChange = listener => { listeners.add(listener); return () => listeners.delete(listener); };

async function request(options = {}) {
  if (!hostToken()) throw Object.assign(Error('Sign in through Munshot to read private summaries.'), { reason: 'no-session' });
  const response = await fetch(ENDPOINT, { ...options, cache: 'no-store', redirect: 'error',
    headers: { accept: 'application/json', ...authHeaders(ENDPOINT), ...(options.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20000) });
  const payload = await boundedJson(new Response(response.body), SUMMARY_TRANSPORT_LIMIT);
  if (!response.ok || payload.ok !== true) throw Object.assign(Error('Private summaries could not be read.'), { reason: payload.reason || 'unavailable' });
  return payload;
}
export function refresh({ force = false } = {}) {
  if (pending) return pending;
  if (!force && Date.now() - checked < INTERVAL) return Promise.resolve(state);
  const epoch = generation;
  checked = Date.now();
  pending = request().then(result => {
    if (epoch !== generation) return state;
    if (!Array.isArray(result.holdings) || result.holdings.length > 5000) throw Error('Summary coverage response is invalid');
    if (!Array.isArray(result.readyIds) || result.readyIds.length > SUMMARY_RECORD_LIMIT || result.readyIds.length !== result.ready ||
        result.readyIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) || new Set(result.readyIds).size !== result.readyIds.length)
      throw Error('Saved summary identities are invalid');
    savedIds = new Set(result.readyIds);
    state = result;
    emit();
    return state;
  }).catch(error => {
    if (epoch !== generation) return state;
    const privateFailure = ['access', 'no-session'].includes(error.reason);
    if (privateFailure) { bodies.clear(); savedIds.clear(); }
    state = privateFailure ? { ok: false, enabled: false, reason: error.reason } : { ...state, ok: false, discoveryStatus: 'unavailable' };
    emit();
    return state;
  }).finally(() => { if (epoch === generation) pending = null; });
  return pending;
}
export async function read(ids) {
  if (!hostToken()) throw Error('Sign in through Munshot to read private summaries.');
  const epoch = generation;
  const missing = [...new Set(ids)].filter(id => !bodies.has(id));
  const fetched = new Map();
  for (let offset = 0; offset < missing.length; offset += 10) {
    const batch = missing.slice(offset, offset + 10);
    let result;
    try { result = await request({ method: 'POST', body: JSON.stringify({ ids: batch }) }); }
    catch (error) {
      if (epoch === generation && ['access', 'no-session'].includes(error.reason)) {
        bodies.clear(); savedIds.clear(); state = { ok: false, reason: error.reason }; emit();
      }
      throw error;
    }
    if (epoch !== generation) throw Error('The signed-in session changed. Reopen the summary.');
    if (!Array.isArray(result.records) || result.records.length !== batch.length ||
        new Set(result.records.map(record => record.id)).size !== batch.length || result.records.some(record => !batch.includes(record.id)))
      throw Error('Summary response identity could not be verified.');
    for (const record of result.records) {
      if (record.status === 'ready') record.body = validateSummaryBody(record.body);
      if (record.status === 'ready') bodies.set(record.id, record);
      fetched.set(record.id, record);
    }
  }
  // Pending states stay local to this read: partial batch failures cannot cache them either.
  const result = [...new Set(ids)].map(id => bodies.get(id) || fetched.get(id));
  // Only in-session convenience storage; the durable server archive retains all reports.
  while (bodies.size > 100) bodies.delete(bodies.keys().next().value);
  return result;
}
export function clear() {
  generation++; pending = null; checked = 0; state = null; bodies.clear(); savedIds.clear(); emit();
}
export function start() {
  mounted++;
  const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
  for (const event of ['focus', 'online']) window.addEventListener(event, resume);
  document.addEventListener('visibilitychange', resume);
  const timer = setInterval(resume, INTERVAL);
  void refresh();
  return () => {
    mounted--; clearInterval(timer);
    for (const event of ['focus', 'online']) window.removeEventListener(event, resume);
    document.removeEventListener('visibilitychange', resume);
  };
}
// Session privacy outlives the tab: logging out elsewhere must clear saved in-memory bodies too.
onHostContext((_context, changes) => {
  if (changes?.session) {
    clear();
    if (mounted && document.visibilityState === 'visible') void refresh();
  }
});
