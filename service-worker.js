// DOCKET · SERVICE WORKER
// · Caches the app shell only. Never touches the data file — that stays on
//   the File System Access path, entirely outside this worker's reach.
"use strict";

// Bump on every shell change — an old cache would keep serving stale CSS/JS
// to anyone who already loaded the site.
const CACHE = "docket-shell-v16";
const SHELL = [
  "./",
  "./index.html",
  "./css/theme.css",
  "./css/layout.css",
  "./vendor/hairline-kernel.js",
  "./js/hairline-host.js",
  "./js/hairline-pegboard.js",
  "./js/hairline-glance.js",
  "./vendor/sync.js",
  "./js/turso.js",
  "./js/schema.js",
  "./js/storage.js",
  "./js/reminders.js",
  "./js/app.js",
  "./js/guide.js",
  "./manifest.webmanifest",
  "./404.html",
  "./fonts/archivo-black-latin-400.woff2",
  "./fonts/jetbrains-mono-latin-wght.woff2",
];

self.addEventListener("install", (e) => {
  // cache: "reload" skips the HTTP cache. GitHub Pages sends max-age=600, so
  // a plain addAll within ten minutes of the last visit filled the new cache
  // with the previous deploy's files and pinned them there (A21).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    /* Only this app's caches: every app on talon270.github.io shares one CacheStorage, and deleting the rest took their offline copies with it. */
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("docket-shell-") && k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
