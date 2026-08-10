/**
 * Offline support: stale-while-revalidate for all same-origin GETs.
 * The whole site is static, and vessel positions are simulated from the
 * schedule — so once visited, everything works with no signal mid-bay.
 */
const CACHE = 'ferryride-v2';

self.addEventListener('install', (e) => {
  const siteRoot = new URL('./', self.location.href).href;
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([siteRoot])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin)
    return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      // serve cache instantly, refresh in the background
      return cached ?? network;
    }),
  );
});
