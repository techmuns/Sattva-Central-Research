import { boundedJson } from '../public/js/data/family-book-contract.js';
import { BREAKOUT_ENDPOINT, BREAKOUT_WORKFLOW } from '../public/js/data/breakout-live-shared.js';
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = `${ISSUER}/.well-known/jwks`;
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));

// No long-lived upload secret: only this fixed main-branch workflow may change the private store.
export async function breakoutCollectorIdentity(request, { fetcher = fetch, now = Date.now() } = {}) {
  const token = /^Bearer ([A-Za-z0-9_.-]{1,16000})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) throw Error('Collector identity required');
  const parts = token.split('.');
  if (parts.length !== 3) throw Error('Invalid collector identity');
  const header = parse(parts[0]), claims = parse(parts[1]), seconds = now / 1000;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 ||
      claims.iss !== ISSUER || claims.aud !== BREAKOUT_ENDPOINT ||
      claims.repository !== 'techmuns/Sattva-Central-Research' || String(claims.repository_id) !== '1329567087' ||
      String(claims.repository_owner_id) !== '278697674' || claims.ref !== 'refs/heads/main' ||
      claims.workflow_ref !== `${'techmuns/Sattva-Central-Research'}/.github/workflows/${BREAKOUT_WORKFLOW}@refs/heads/main` ||
      !['push', 'schedule', 'workflow_dispatch', 'repository_dispatch'].includes(claims.event_name) ||
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
