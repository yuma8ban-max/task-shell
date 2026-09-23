/* File: sw.js — task-v4.2-1 */
const CACHE = 'task-v4.2-1';

const INDEX = new URL('./index.html', self.registration.scope).href;
const ROOT = new URL('./', self.registration.scope).href;

const OPTIONAL_FILES = [
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
        return Promise.all(OPTIONAL_FILES.map(function (file) {
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
    return cache.match(INDEX).then(function (saved) {
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
    通信できる状態で一度アプリを開いてください。
    準備後は、取得済みのタスクを通信がないときも操作できます。
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
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  const index = new URL(INDEX);
  const root = new URL(ROOT);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (
    url.pathname === index.pathname ||
    url.pathname === root.pathname
  ) {
    event.respondWith(
      fetch(new Request(event.request, {
        cache: 'no-cache'
      })).then(function (response) {
        if (!response.ok) {
          return offlinePage();
        }

        const copied = response.clone();

        return caches.open(CACHE).then(function (cache) {
          return cache.put(INDEX, copied);
        }).catch(function () {
          return null;
        }).then(function () {
          return response;
        });
      }).catch(offlinePage)
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
