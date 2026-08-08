/**
 * sw.js — minimal service worker for PWA installability + basic offline resilience.
 *
 * Deliberately does NOT precache or cache-first the JS/CSS app bundles — those
 * are content-hashed per build, and aggressively caching them would risk
 * serving a stale, broken app after a deploy. Instead:
 *  - Static, rarely-changing assets (icons, manifest) are cache-first.
 *  - Everything else (HTML navigations, API calls, hashed JS/CSS) goes to the
 *    network first, only falling back to cache/offline page if the network
 *    request fails outright (e.g. no connectivity).
 */

const CACHE_NAME = "wabizz-static-v1";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/wabizz-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => {
        // Best-effort — don't block install if one asset 404s.
      }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Static assets: cache-first, refresh cache in the background.
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchAndUpdate = fetch(request)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchAndUpdate;
      }),
    );
    return;
  }

  // Page navigations: network-first, so a fresh deploy is always picked up;
  // fall back to whatever's cached only when fully offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () => caches.match(request) || caches.match("/") || Response.error(),
      ),
    );
    return;
  }

  // Everything else (hashed JS/CSS, API calls): pass straight through.
});
