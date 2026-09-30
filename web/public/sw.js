/* Syncle service worker (MW1 PWA, minimal — no push).
 *
 * Strategy:
 *  - Static assets (js / css / images) → cache-first, versioned cache.
 *  - HTML (/, /index.html and other navigations) → network-first, fall back
 *    to cached index.html when offline.
 *  - activate → delete any cache that isn't the current version.
 */
const CACHE = "syncle-v1";
const OFFLINE_FALLBACK = "/index.html";

self.addEventListener("install", (event) => {
  // Pre-cache the app shell so first offline load works.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_FALLBACK]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const isStaticAsset = (url) =>
  /\.(?:js|css|png|jpe?g|gif|webp|svg|woff2?|json)$/i.test(url.pathname);

const isHtmlNavigation = (request) =>
  request.mode === "navigate" ||
  request.destination === "document" ||
  request.headers.get("accept")?.includes("text/html");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isHtmlNavigation(request)) {
    // Network-first for HTML; fall back to the cached app shell.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(OFFLINE_FALLBACK)),
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Cache-first for static assets (js/css/images).
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
