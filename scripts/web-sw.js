/*
  The service worker of the web app at `/web`. This file is a template:
  `scripts/build-web-sw.mjs` puts `VERSION` and `PRECACHE` in front of it and
  writes the result to `dist/web-sw.js`. Only `/web` registers it, and its
  scope is `/web`, so the website itself is never in its control.

  One cache holds one build: the page, its scripts and the renderer. The page asks for the renderer by a versioned url, and the glue
  finds its `.wasm` next to it, so all of them must come from the same build.
  For that reason, the worker serves every file of the list from the cache and
  never mixes the cache with the network for them. A new build is a new
  worker with a new cache. The worker deletes the old cache only when it takes
  control, which is when no page of the old build is open, or when the user
  restarts into the new version.
*/

/* global VERSION, PRECACHE */
const CACHE = `odr-web-${VERSION}`;
const LISTED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (path) => {
          // `reload`, because the cache of the browser can hold an older copy.
          const response = await fetch(new Request(path, { cache: 'reload' }));
          if (!response.ok) throw new Error(`${path}: ${response.status}`);
          // A redirected response cannot answer a navigation, so keep only
          // its body and headers.
          const stored = response.redirected
            ? new Response(await response.blob(), { headers: response.headers })
            : response;
          await cache.put(path, stored);
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('odr-web-') && name !== CACHE) await caches.delete(name);
      }
      // The first worker takes control of the page that registered it, so
      // that page works offline without a reload.
      await self.clients.claim();
    })(),
  );
});

// The page sends this when the user chooses to restart into a new version.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  let path = url.pathname;
  if (path === '/web.html') path = '/web';
  if (!LISTED.has(path)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(path, { cacheName: CACHE });
      return cached ?? fetch(request);
    })(),
  );
});
