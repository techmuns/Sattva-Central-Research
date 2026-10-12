import assert from 'node:assert/strict';
import { handleHoldingSizes } from '../worker/holding-sizes.mjs';
const revision = 'a'.repeat(64), token = 'fixture-token-never-a-production-secret';
const reply = () => ({ sizes: { basis: 'listed-market-value', valuation: 'workbook', bookAsOf: '2026-08-31', checkedAt: new Date().toISOString(), archiveVersion: 2, sourceRevision: revision, complete: true },
  holdings: [{ isin: 'INE000000001', ticker: 'EXAMPLE', name: 'Example', sector: 'Test', weightPct: 100 }] });
const body = () => ({ ok: true, storage: 'shared', checkedAt: new Date().toISOString(), revision, positionSizes: reply() });
const request = new Request('https://central.test/api/holding-sizes');
const env = { FAMILY_HOLDINGS_TOKEN: token };
let calls = 0;
const res = await handleHoldingSizes(request, env, async (url, options) => {
  calls++;
  assert.equal(url, 'https://sattva-family.pages.dev/api/research-holdings?include=sizes');
  assert.equal(options.headers.authorization, `Bearer ${token}`);
  assert.equal(options.redirect, 'manual');
  const value = body(); value.positionSizes.holdings[0].account = 'PRIVATE ACCOUNT'; value.positionSizes.sizes.value = 999999;
  return Response.json(value);
});
assert.equal(res.status, 200);
assert.match(res.headers.get('cache-control'), /private, no-store/);
assert.doesNotMatch(await res.text(), /PRIVATE ACCOUNT|999999|fixture-token/);
assert.equal(calls, 1);
for (const corrupt of [v => { v.storage = 'built-in'; }, v => { v.positionSizes.sizes.checkedAt = '2020-01-01'; },
  v => { v.positionSizes.holdings[0].weightPct = 50; }, v => { v.positionSizes.holdings.push(v.positionSizes.holdings[0]); },
  v => { v.positionSizes.sizes.sourceRevision = 'b'.repeat(64); }]) {
  const value = body(); corrupt(value);
  assert.equal((await handleHoldingSizes(request, env, async () => Response.json(value))).status, 503);
}
for (const status of [301, 302, 401, 503]) assert.equal((await handleHoldingSizes(request, env, async () => new Response(null, { status }))).status, 503);
assert.equal((await handleHoldingSizes(request, {}, () => { throw Error('must not fetch'); })).status, 503);
assert.equal((await handleHoldingSizes(new Request(request.url, { method: 'POST' }), env)).status, 405);
console.log('PASS shared sizes: fixed authenticated source, complete denominator, freshness, projection privacy, no persistence and refusal handling');
