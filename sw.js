/* File: sw.js — task-v4.11.2-1 */
'use strict';

const CACHE = 'task-v4.11.2-1';

const INDEX = new URL('./index.html', self.registration.scope).href;
const ROOT = new URL('./', self.registration.scope).href;
const QUICK = new URL('./quick-add.html', self.registration.scope).href;

const REQUIRED_FILES = [
  './index.html',
  './quick-add.html',
  './tabler.css?v=1.0.0',
  './task-ui.css?v=4.11.1',
  './task-core.js?v=4.11.2',
  './task-core.js?v=4.8',
  './wish-client.js?v=4.10',
  './manifest.webmanifest',
  './icon-check-32.png',
  './icon-check-180.png',
  './icon-check-192.png',
  './icon-check-512.png'
];

const OPTIONAL_FILES = [
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

async function checkedResponse(file) {
  const url = new URL(file, self.registration.scope).href;

  const response = await fetch(new Request(url, {
    cache: 'reload'
  }));

  if (!response.ok) {
    throw new Error('画面の必須ファイルを取得できませんでした。');
  }

  if (
    file.indexOf('.css') >= 0 ||
    file.indexOf('.js') >= 0 ||
    file === './index.html'
  ) {
    const text = await response.clone().text();

    if (
      file === './index.html' &&
      text.indexOf("const VERSION = 'v4.11.2';") < 0
    ) {
      throw new Error('画面の版が揃っていません。');
    }

    if (
      file.indexOf('./task-core.js') === 0 &&
      text.indexOf("const BUILD = 'v4.11.2';") < 0
    ) {
      throw new Error('共通処理の版が揃っていません。');
    }

    if (
      file.indexOf('./task-ui.css') === 0 &&
      text.indexOf('--task-ui-version: v4.11.1;') < 0
    ) {
      throw new Error('UIスタイルの版が揃っていません。');
    }

    if (
      file.indexOf('./tabler.css') === 0 &&
      (
        text.indexOf('--tblr-') < 0 ||
        text.indexOf('.btn') < 0
      )
    ) {
      throw new Error('TablerのCSSを確認できませんでした。');
    }

    if (
      file !== './index.html' &&
      /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text)
    ) {
      throw new Error('CSSまたはJavaScriptの代わりにHTMLが返されました。');
    }
  }

  return {
    url: url,
    response: response
  };
}

async function saveOptionalFile(cache, file) {
  const url = new URL(file, self.registration.scope).href;

  try {
    const response = await fetch(new Request(url, {
      cache: 'reload'
    }));

    if (response.ok) {
      await cache.put(url, response);
    }
  } catch (error) {
    const saved = await caches.match(url);

    if (saved) {
      await cache.put(url, saved);
    }
  }
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    // 必須ファイルの取得・版の確認が全部済むまでは有効化しない。
    const responses = await Promise.all(
      REQUIRED_FILES.map(checkedResponse)
    );

    const cache = await caches.open(CACHE);

    await Promise.all(responses.map(function (entry) {
      return cache.put(entry.url, entry.response);
    }));

    await Promise.all(OPTIONAL_FILES.map(function (file) {
      return saveOptionalFile(cache, file);
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  // この更新では旧画面用のキャッシュを削除しない。
  // IndexedDBや送信待ちの記録には触れない。
  event.waitUntil(self.clients.claim());
});

function unavailablePage() {
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>タスク</title>
</head>
<body>
  <h2>画面の準備が必要です</h2>
  <p>通信できる状態で一度開いてください。</p>
  <p>端末の記録は消していません。</p>
</body>
</html>`,
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    }
  );
}

async function documentResponse(documentUrl) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(documentUrl);

  if (saved) {
    return saved;
  }

  try {
    const response = await fetch(new Request(documentUrl, {
      cache: 'no-store'
    }));

    return response.ok ? response : unavailablePage();
  } catch (error) {
    return unavailablePage();
  }
}

self.addEventListener('fetch', function (event) {
  // GASへのPOST通信は処理しない。
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
    event.respondWith(documentResponse(INDEX));
    return;
  }

  if (url.pathname === quick.pathname) {
    event.respondWith(documentResponse(QUICK));
    return;
  }

  if (url.pathname.indexOf(root.pathname) !== 0) {
    return;
  }

  event.respondWith((async function () {
    const cache = await caches.open(CACHE);
    const current = await cache.match(event.request);

    if (current) {
      return current;
    }

    const previous = await caches.match(event.request);

    if (previous) {
      return previous;
    }

    return fetch(event.request);
  })());
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
