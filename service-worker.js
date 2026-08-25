// DOCKET · SERVICE WORKER
// · Caches the app shell only. Never touches the data file — that stays on
//   the File System Access path, entirely outside this worker's reach.
"use strict";

const CACHE = "docket-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./css/theme.css",
  "./css/layout.css",
  "./js/schema.js",
  "./js/storage.js",
  "./js/reminders.js",
  "./js/app.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
