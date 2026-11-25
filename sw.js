const CACHE_NAME = "fath-pwa-v5.5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./theme.jpg",
  "./data/list.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/fonts/Vazirmatn-Light.woff2",
  "./assets/fonts/Vazirmatn-Regular.woff2",
  "./assets/fonts/Vazirmatn-Medium.woff2",
  "./assets/fonts/Vazirmatn-Bold.woff2",
  "./assets/fonts/AmiriQuran.woff2"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const isAudio = event.request.destination === "audio" || url.pathname.startsWith("/data/sounds/");

  if (isAudio) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.status === 200) {
            const cloned = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then((networkResponse) => {
        const cloned = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        return networkResponse;
      });
    })
  );
});
