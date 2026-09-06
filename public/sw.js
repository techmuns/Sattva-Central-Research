// Repeat visits should read like opening an app, not like rebuilding a report.
//
// The cache contains only public static assets and public committed snapshots.
// `/api/*`, requests carrying Authorization, and explicit `no-store` reads are
// always network-only, so Family holdings, research answers and private document
// lookups never cross the persistence boundary.

// BUMP THIS ON EVERY CHANGE TO A FILE UNDER /js/, WITHOUT EXCEPTION.
// `revalidateInBackground` below deliberately excludes /js/ — modules are treated as immutable and
// the service-worker file plus this name ARE the code version boundary. So a returning reader with
// a warm cache keeps the old module graph for ever unless this string changes: the browser only
// re-installs when sw.js itself differs byte for byte, and only an install re-walks the graph and
// only an activate evicts the previous cache. A feature can therefore be deployed, correct, and
// completely invisible to everyone who has visited before — which is exactly what would have
// happened to the Telegram section, whose new module is reachable from app.js but would never have
// been requested. Nothing fails and nothing looks wrong; the feature simply is not there.
const CACHE_PREFIX = 'sattva-dashboard-';
const CACHE_NAME = `${CACHE_PREFIX}2026-09-06-research-conversation-recovery-v2`;
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
    // A REDIRECTED RESPONSE MAY NOT ANSWER A NAVIGATION, AND THIS CACHE ANSWERS EVERY NAVIGATION.
    //
    // Cloudflare's static assets 307 `/index.html` to `/` (html_handling: auto-trailing-slash), so
    // `cacheOne('/index.html')` follows that hop and stores a response whose `redirected` flag is
    // set. `cacheKey()` then hands exactly that entry to every navigation — and the spec forbids a
    // service worker answering a navigation with a redirected response, so the browser fails the
    // load outright: net::ERR_FAILED, a dead tab, no console error of ours.
    //
    // Measured against a server that reproduces the 307: the entry is stored `redirected: true`
    // with url `/`, the next reload dies, and the load AFTER that succeeds only because the
    // background revalidation has quietly overwritten it from the navigation's own request. So it
    // self-heals — at the cost of one hard-failed page load per cache generation, per reader,
    // which reads as the site being down rather than as anything to do with a deploy.
    //
    // A constructed Response carries no redirect flag. Rebuilding one costs nothing (the body is
    // piped, not buffered) and it is done for every asset rather than special-casing index.html,
    // because any path the host decides to redirect later lands in the same trap.
    if (response.ok || response.type === 'opaque') {
      const copy = response.clone();
      await cache.put(input, copy.redirected
        ? new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers: copy.headers })
        : copy);
    }
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
    // Explicit data revalidation must reach the server in THIS request. Returning
    // the held body while updating it behind the scenes made Refresh one capture
    // late and hid outages as successful checks. The feed owns its last-good rows.
    if (url.pathname.startsWith('/data/') && !request.headers.has('x-sattva-bootstrap') && ['no-cache', 'reload'].includes(request.cache)) {
      return (await fetchAndCache(cache, request, key)) || Response.error();
    }
    const held = await cache.match(key);
    if (held) {
      if (revalidateInBackground(request, url)) event.waitUntil(fetchAndCache(cache, request, key));
      return held;
    }
    return (await fetchAndCache(cache, request, key)) ||
      (request.mode === 'navigate' ? cache.match('/index.html') : Response.error());
  })());
});
