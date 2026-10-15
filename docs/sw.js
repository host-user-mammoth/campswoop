// CampSwoop service worker: makes the site installable and keeps its shell available offline.
// Network first, so a deploy shows up on the next visit; cached copies are only a fallback.
const CACHE = "campswoop-v3"; // bump with each redesign so old shells are cleared
const SHELL = ["./", "index.html", "assets/site.css", "assets/app.js", "assets/map.js", "assets/icon.svg",
               "assets/hero-night.webp", "assets/hero-day.webp", "manifest.webmanifest"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  // Only this site's own GET requests; the API, map tiles, fonts and videos go straight to the network.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.headers.has("range") || request.url.endsWith(".mp4")) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then(hit => hit || caches.match("index.html"))));
});
