/* File: sw.js — task-v4.4.1-1 */
const CACHE = 'task-v4.4.1-1';

const INDEX = new URL('./index.html', self.registration.scope).href;
const ROOT = new URL('./', self.registration.scope).href;
const QUICK = new URL('./quick-add.html', self.registration.scope).href;

const OPTIONAL_FILES = [
  './quick-add.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.add(new Request(INDEX, {
        cache: 'reload'
      })).then(function () {
        return Promise.all(
          OPTIONAL_FILES.map(function (file) {
            return cache.add(new Request(
              new URL(file, self.registration.scope).href,
              {
                cache: 'reload'
              }
            )).catch(function () {
              return null;
            });
          })
        );
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE && /^task-v/.test(key)) {
            return caches.delete(key);
          }

          return null;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function offlinePage(documentUrl) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(documentUrl).then(function (saved) {
      if (saved) {
        return saved;
      }

      return new Response(
        `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>タスク</title>
</head>
<body>
  <h2>初回の準備が必要です</h2>
  <p>
    通信できる状態で一度この画面を開いてください。
    準備後は、通信がないときも開けるようになります。
  </p>
  <p>
    保存済みのタスクや未送信の記録は消していません。
  </p>
</body>
</html>`,
        {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        }
      );
    });
  });
}

function documentResponse(request, documentUrl) {
  return fetch(new Request(request, {
    cache: 'no-cache'
  })).then(function (response) {
    if (!response.ok) {
      return offlinePage(documentUrl);
    }

    const copied = response.clone();

    return caches.open(CACHE).then(function (cache) {
      return cache.put(documentUrl, copied);
    }).catch(function () {
      return null;
    }).then(function () {
      return response;
    });
  }).catch(function () {
    return offlinePage(documentUrl);
  });
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  const index = new URL(INDEX);
  const root = new URL(ROOT);
  const quick = new URL(QUICK);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (
    url.pathname === index.pathname ||
    url.pathname === root.pathname
  ) {
    event.respondWith(
      documentResponse(event.request, INDEX)
    );

    return;
  }

  if (url.pathname === quick.pathname) {
    event.respondWith(
      documentResponse(event.request, QUICK)
    );

    return;
  }

  if (url.pathname.indexOf(root.pathname) !== 0) {
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(event.request).then(function (saved) {
        return saved || fetch(event.request);
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
