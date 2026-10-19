/*
 * Service worker: offline support.
 * - App shell is precached and served cache-first (bump VERSION on release).
 * - OpenCV.js (~10 MB, versioned CDN URL) is cached on install and served
 *   cache-first forever, so tracking works offline after the first visit.
 */
const VERSION = 'tracit-v1';
const CV_CACHE = 'tracit-opencv-4.10.0-r1';
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/camera.js',
  'js/gestures.js',
  'js/math.js',
  'js/renderer.js',
  'js/storage.js',
  'js/tracker-client.js',
  'js/tracker-core.js',
  'js/tracker-worker.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(APP_FILES);
    // OpenCV is best-effort here; it is also cached on first use below.
    try {
      const cv = await caches.open(CV_CACHE);
      if (!(await cv.match(OPENCV_URL))) await cv.add(new Request(OPENCV_URL, { mode: 'cors' }));
    } catch (err) { /* offline during install: cached later */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([VERSION, CV_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.url === OPENCV_URL) {
    event.respondWith(cacheFirst(CV_CACHE, req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network first for the page so updates show up; fall back to the cached shell offline.
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put('index.html', copy));
      return res;
    }).catch(async () => (await caches.match('index.html')) || Response.error()));
    return;
  }
  event.respondWith(staleWhileRevalidate(VERSION, req));
});

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}
