/* coi-serviceworker.js — Cross-Origin Isolation Service Worker
 *
 * Adds COOP + COEP headers to every response, setting crossOriginIsolated = true
 * in the main page. This unlocks SharedArrayBuffer, which Emscripten pthreads need.
 *
 * On first install the worker calls clients.claim() then each client reloads
 * once so the new headers take effect immediately.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event =>
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(c => c.navigate(c.url))
      )
    )
  )
);

const CACHE_NAME = 'bitflip64-v1';

async function handleFetch(request) {
  const cache = await caches.open(CACHE_NAME);
  let response;

  try {
    // 1. Network First: Always try to get the newest file
    response = await fetch(request);

    // 2. Add to Cache: Save a copy of successful requests for offline use
    if (response.status === 200 || response.status === 0) {
      cache.put(request, response.clone()).catch(() => {});
    }
  } catch (error) {
    // 3. Offline Fallback: If network fails, pull from the cache
    response = await cache.match(request);
    if (!response) {
      return Response.error();
    }
  }

  // 4. Inject COI Headers (Required for SharedArrayBuffer / WebAssembly constraints)
  if (response.status === 0) return response; // Opaque responses cannot have headers manipulated

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Skip cache-only requests for cross-origin resources (avoids network errors)
  if (event.request.cache === 'only-if-cached' &&
      event.request.mode !== 'same-origin') return;
      
  event.respondWith(handleFetch(event.request));
});
