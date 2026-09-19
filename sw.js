/* v2.2 — 画面を直したら、この1行目の数字も必ず変えること */
var CACHE = 'task-v2.2-1';
var FILES = ['./index.html', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(FILES.map(function (f) {
        return c.add(f).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      return k === CACHE ? null : caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  var isDoc = e.request.mode === 'navigate' ||
              /\.html$/.test(u.pathname) ||
              u.pathname.slice(-1) === '/';

  if (isDoc) {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return r;
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) { return hit || fetch(e.request); })
  );
});
