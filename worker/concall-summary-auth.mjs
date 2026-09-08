import { boundedJson } from '../public/js/data/family-book-contract.js';
import { SUMMARY_ORIGIN, SUMMARY_REPO, SUMMARY_WORKFLOW } from '../public/js/data/concall-summaries-shared.js';
import { callerToken } from './muns.mjs';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = `${ISSUER}/.well-known/jwks`;
const PROFILE = 'https://fastapi.muns.io/auth/me';
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));

// No long-lived upload secret: only this fixed main-branch workflow may change the private store.
export async function summaryCollectorIdentity(request, { fetcher = fetch, now = Date.now() } = {}) {
  const token = /^Bearer ([A-Za-z0-9_.-]{1,16000})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) throw Error('Collector identity required');
  const parts = token.split('.');
  if (parts.length !== 3) throw Error('Invalid collector identity');
  const header = parse(parts[0]), claims = parse(parts[1]), seconds = now / 1000;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 ||
      claims.iss !== ISSUER || claims.aud !== `${SUMMARY_ORIGIN}/api/concall-summaries/collector` ||
      claims.repository !== SUMMARY_REPO || String(claims.repository_id) !== '1329567087' ||
      String(claims.repository_owner_id) !== '278697674' || claims.ref !== 'refs/heads/main' ||
      claims.workflow_ref !== `${SUMMARY_REPO}/.github/workflows/${SUMMARY_WORKFLOW}@refs/heads/main` ||
      !['schedule', 'workflow_dispatch', 'repository_dispatch'].includes(claims.event_name) ||
      !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) ||
      claims.iat > seconds + 30 || seconds - claims.iat > 600 || !Number.isFinite(claims.nbf) || claims.nbf > seconds + 30 ||
      !/^\d+$/.test(String(claims.run_id || '')) || !/^\d+$/.test(String(claims.run_attempt || '')))
    throw Error('Collector identity refused');
  const response = await fetcher(JWKS, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const payload = await boundedJson(response, 64000);
  const candidates = (payload.keys || []).filter(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256');
  if (candidates.length !== 1) throw Error('Collector signing key unavailable');
  const key = await crypto.subtle.importKey('jwk', candidates[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))
    throw Error('Collector signature refused');
  return `${claims.run_id}:${claims.run_attempt}`;
}

function profileEmail(profile) {
  // Verified API response only. A JWT's unverified claims and host-supplied display email are
  // never an authorisation decision. Ambiguous response identities fail closed.
  const emails = [...new Set([profile?.email, profile?.user?.email, profile?.data?.email, profile?.user_data?.email]
    .filter(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254)
    .map(value => value.toLowerCase()))];
  if (emails.length !== 1) throw Error('Private reader identity unavailable');
  return emails[0];
}
async function readProfile(token, fetcher) {
  const response = await fetcher(PROFILE, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  return profileEmail(await boundedJson(response, 64000));
}
export async function authoriseSummaryReader(request, env, { fetcher = fetch } = {}) {
  const token = callerToken(request);
  if (!token) return { ok: false, reason: 'no-session' };
  // Run before withCallerToken(): the caller must never become the configured account owner.
  const allowlist = String(env.SCREENER_SUMMARY_READER_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.length && !env.MUNS_TOKEN) return { ok: false, reason: 'access' };
  try {
    const reader = await readProfile(token, fetcher);
    if (allowlist.length) return { ok: allowlist.includes(reader), reason: 'access' };
    const owner = await readProfile(env.MUNS_TOKEN, fetcher);
    return { ok: reader === owner, reason: 'access' };
  } catch { return { ok: false, reason: 'access' }; }
}
