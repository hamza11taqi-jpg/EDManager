const CACHE_NAME = "edmanager-v2";
const BASE_PATH = "/EDManager/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter((key) => key.startsWith("edmanager-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );

      await clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);

      if (cached) return cached;

      if (request.mode === "navigate") {
        return fetch(BASE_PATH);
      }

      return Response.error();
    })
  );
});
