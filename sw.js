/* v2.4 — 画面を直したら、この1行目の数字も必ず変えること */
var CACHE = 'task-v2.4-1';
var FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(FILES.map(function (f) {
        return c.add(new Request(f, { cache: 'reload' })).catch(function () { return null; });
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

function offlinePage() {
  return caches.match('./index.html').then(function (hit) {
    if (hit) return hit;
    return caches.match('./').then(function (h2) {
      if (h2) return h2;
      return new Response(
        '<!doctype html><meta charset="utf-8">' +
        '<body style="font-family:-apple-system,sans-serif;padding:24px">' +
        '<h3>まだ準備ができていません</h3>' +
        '<p>通信できる場所で一度このアプリを開いてください。' +
        'それ以降はオフラインでも開けるようになります。</p></body>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    });
  });
}

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
        caches.open(CACHE).then(function (c) {
          c.put('./index.html', copy.clone());
          c.put('./', copy);
        });
        return r;
      }).catch(offlinePage)
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).catch(function () { return Response.error(); });
    })
  );
});
