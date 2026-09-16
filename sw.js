/* 第2段階：起動保持のみ。通信は毎回サーバーへ */
var CACHE = 'boot-test-v2';
var FILES = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;      // 送り先への通信は触らない
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(function (hit) {
    return hit || fetch(e.request).catch(function () { return caches.match('./index.html'); });
  }));
});
