/* Staff calendar service worker.
   Network-first: the calendar shows live bookings, so the network always wins.
   The cache is only an offline fallback for the page shell. API calls go to a
   separate workers.dev origin and are never touched. */
var CACHE = "willow-staff-v1";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0) return;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () { return caches.match(e.request); }));
});
