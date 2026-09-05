// Repeat visits should read like opening an app, not like rebuilding a report.
//
// The cache contains only public static assets and public committed snapshots.
// `/api/*`, requests carrying Authorization, and explicit `no-store` reads are
// always network-only, so Family holdings, research answers and private document
// lookups never cross the persistence boundary.

const CACHE_PREFIX = 'sattva-dashboard-';
const CACHE_NAME = `${CACHE_PREFIX}2026-09-05-v2`;
const APP_ENTRY = '/js/app.js';
const CORE = ['/', '/index.html', '/css/tailwind.css', '/data/portfolio-companies.json'];
const MUNSHOT_SDK = 'https://munshot.s3.ap-south-1.amazonaws.com/SDK+script/munshot-dashboard-sdk.v1.0.0.min.js';
const WARM_CONCURRENCY = 8;

function moduleSpecifiers(source) {
  const found = new Set();
  const pattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source))) found.add(match[1] || match[2]);
  return [...found];
}

async function cacheOne(cache, input, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { cache: 'reload', signal: controller.signal, ...init });
    if (response.ok || response.type === 'opaque') await cache.put(input, response.clone());
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheRequired(cache, input) {
  const response = await cacheOne(cache, input);
  if (!response?.ok) throw new Error(`Required app asset unavailable: ${new URL(input, self.location.origin).pathname}`);
  return response;
}

async function mapBounded(items, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

/** Follow the native ES-module graph so every tab's code is warm without a hand-maintained list. */
async function cacheModuleGraph(cache, entry) {
  const first = new URL(entry, self.location.origin);
  const seen = new Set([first.href]);
  let pending = [first];

  // Walk one breadth at a time. A promise-per-module traversal can deadlock on
  // perfectly valid circular imports (A waits for B while B waits for A).
  while (pending.length) {
    const current = pending;
    pending = [];
    // Bound the warm-up so a first visit's post-paint install cannot monopolise
    // the connection pool while the reader is already interacting with the app.
    const sources = await mapBounded(current, async (url) => {
      const response = await cacheRequired(cache, url.href);
      return response.text();
    });
    sources.forEach((source, index) => {
      const parent = current[index];
      moduleSpecifiers(source).forEach((specifier) => {
        const url = new URL(specifier, parent.href);
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/js/') || seen.has(url.href)) return;
        seen.add(url.href);
        pending.push(url);
      });
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A new version activates only when its whole required shell is complete;
    // otherwise the previous worker/cache remains the safe fallback.
    await Promise.all(CORE.map((asset) => cacheRequired(cache, asset)));
    await cacheModuleGraph(cache, APP_ENTRY);
    // The SDK is a small, versioned public script but its S3 response has no
    // Cache-Control header. Keep an opaque copy so it cannot block every return visit.
    await cacheOne(cache, MUNSHOT_SDK, { mode: 'no-cors' }, 4000);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function cacheKey(request, url) {
  if (request.mode === 'navigate') return new Request(new URL('/index.html', self.location.origin));
  return request;
}

function cacheable(request, url) {
  if (request.method !== 'GET' || request.headers.has('authorization') || request.cache === 'no-store') return false;
  if (url.href === MUNSHOT_SDK) return true;
  if (url.origin !== self.location.origin || url.pathname === '/sw.js' || url.pathname.startsWith('/api/')) return false;
  return request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' ||
    url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/data/');
}

function revalidateInBackground(request, url) {
  // The service-worker file and cache name are the version boundary for code.
  // Rechecking a hundred immutable modules on every navigation creates the very
  // network/CPU burst this cache is meant to remove. Public data and the HTML
  // shell are mutable, so those still refresh quietly behind the retained view.
  return request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' ||
    url.pathname.startsWith('/data/');
}

async function fetchAndCache(cache, request, key) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return null;
  }
  const control = response.headers.get('cache-control') || '';
  if (response.ok && !/\b(?:private|no-store)\b/i.test(control)) {
    try { await cache.put(key, response.clone()); } catch { /* A storage failure must not fail the network read. */ }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!cacheable(request, url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const key = cacheKey(request, url);
    const held = await cache.match(key);
    if (held) {
      if (revalidateInBackground(request, url)) event.waitUntil(fetchAndCache(cache, request, key));
      return held;
    }
    return (await fetchAndCache(cache, request, key)) ||
      (request.mode === 'navigate' ? cache.match('/index.html') : Response.error());
  })());
});
