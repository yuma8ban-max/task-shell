/* File: sw.js — task-v3.0-1 */
var CACHE = 'task-v3.0-1';

var FILES = [
  './',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

var INDEX_URL = new URL('./index.html', self.registration.scope).href;
var ROOT_URL = new URL('./', self.registration.scope).href;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.add(new Request(INDEX_URL, {
        cache: 'reload'
      })).then(function () {
        return Promise.all(FILES.map(function (file) {
          return cache.add(new Request(
            new URL(file, self.registration.scope).href,
            {
              cache: 'reload'
            }
          )).catch(function () {
            return null;
          });
        }));
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE && /^task-v/.test(key)) {
          return caches.delete(key);
        }

        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function offlinePage() {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(INDEX_URL).then(function (hit) {
      if (hit) {
        return hit;
      }

      return cache.match(ROOT_URL).then(function (rootHit) {
        if (rootHit) {
          return rootHit;
        }

        return new Response(
          `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>タスク</title>
</head>
<body style="font-family: -apple-system, sans-serif; padding: 24px;">
  <h3>まだ準備ができていません</h3>
  <p>
    通信できる場所で一度このアプリを開いてください。<br>
    それ以降はオフラインでも開けるようになります。
  </p>
</body>
</html>`,
          {
            headers: {
              'Content-Type': 'text/html; charset=utf-8'
            }
          }
        );
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  var index = new URL(INDEX_URL);
  var root = new URL(ROOT_URL);

  if (
    url.origin !== self.location.origin ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  var isAppDocument =
    url.pathname === index.pathname ||
    url.pathname === root.pathname;

  if (isAppDocument) {
    event.respondWith(
      fetch(new Request(event.request, {
        cache: 'no-cache'
      })).then(function (response) {
        if (!response.ok) {
          return offlinePage();
        }

        var indexCopy = response.clone();
        var rootCopy = response.clone();

        return caches.open(CACHE).then(function (cache) {
          return Promise.all([
            cache.put(INDEX_URL, indexCopy),
            cache.put(ROOT_URL, rootCopy)
          ]);
        }).catch(function () {
          return null;
        }).then(function () {
          return response;
        });
      }).catch(function () {
        return offlinePage();
      })
    );

    return;
  }

  if (url.pathname.indexOf(root.pathname) !== 0) {
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(event.request).then(function (hit) {
        if (hit) {
          return hit;
        }

        return fetch(event.request).catch(function () {
          return Response.error();
        });
      });
    })
  );
});

self.addEventListener('message', function (event) {
  if (
    event.data &&
    event.data.type === 'TASK_VERSION' &&
    event.ports &&
    event.ports[0]
  ) {
    event.ports[0].postMessage({
      cacheName: CACHE
    });
  }
});
