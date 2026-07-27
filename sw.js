/* sw.js — offline shell.
 *
 * Cache-first for the app's own files, because they only change when a new
 * version ships. Bumping CACHE is what triggers an update: the new worker
 * pre-caches everything, then deletes older caches once it takes over.
 *
 * Note the app's data is NOT here — that lives in IndexedDB and is never
 * touched by cache eviction.
 */
const CACHE = 'fin-v1';
const SHELL = [
  './', './index.html', './app.css',
  './app.js', './core.js', './db.js', './store.js', './ui.js', './sheets.js', './charts.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; a single 404 would leave the app with no
      // offline copy at all, so failures are tolerated per file.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Navigations: try the network first so a deployed update is picked up
  // promptly, but fall back to the cached shell the moment it isn't reachable.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Assets: serve the cached copy immediately, and refresh it in the
  // background. Without the background refresh a deployed update would never
  // reach anyone who already had the app installed.
  e.respondWith(
    caches.match(request).then((hit) => {
      const live = fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || live;
    })
  );
});

// Lets the page trigger an immediate takeover when the user accepts an update.
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
