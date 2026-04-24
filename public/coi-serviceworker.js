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

async function addCOIHeaders(request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return Response.error();
  }
  // Don't touch opaque responses (cross-origin no-cors requests)
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Skip cache-only requests for cross-origin resources (avoids network errors)
  if (event.request.cache === 'only-if-cached' &&
      event.request.mode !== 'same-origin') return;
  event.respondWith(addCOIHeaders(event.request));
});
