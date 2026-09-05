import assert from 'node:assert/strict';
import worker from '../worker/index.js';
const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
const cache = new Map(), pending = [], requests = [];
globalThis.caches = { default: { match: async key => cache.get(key.url)?.clone(),
  put: async (key, response) => { cache.set(key.url, response.clone()); } } };
globalThis.fetch = async (_, options) => {
  requests.push(JSON.parse(options.body));
  return Response.json({ articles: [{ title: 'Company statement', url: 'https://example.test/story' }] });
};
try {
  const route = async country => {
    const response = await worker.fetch(new Request(`https://fixture.test/api/news?q=Datasel&country=${country}`),
      { MUNS_TOKEN: 'fixture-only', MUNS_NEWS_TOKEN: 'fixture-only' }, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending.splice(0));
    return response;
  };
  assert.equal((await (await route('IN')).json()).ok, true);
  assert.equal(requests[0].country, 'IN');
  assert.equal((await (await route('ALL')).json()).country, 'ALL');
  assert(!Object.hasOwn(requests[1], 'country'), 'global search omits the upstream country field');
  await route('all');
  assert.equal(requests.length, 2, 'global cache normalizes case, separate from India');
  await route('EE');
  assert.equal(requests[2].country, 'EE');
  assert.equal((await route('invalid-country')).status, 400);
  assert.equal(requests.length, 3);
  assert(!JSON.stringify([...cache.values()]).includes('fixture-only'));
} finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
console.log('PASS country validation, unrestricted upstream search and region-separated edge caches.');
