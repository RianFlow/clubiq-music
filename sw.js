"use strict";

const CACHE = "clubiq-music-shell-20260901-2";
const SHELL = [
  "/", "/remote", "/party", "/manifest.webmanifest",
  "/static/app.css?v=20260901-2", "/static/app.js?v=20260901-2",
  "/static/companion.css?v=20260813-5", "/static/remote.js?v=20260813-5",
  "/static/party.js?v=20260813-5", "/pics/logo.png", "/pics/pwa-512.png",
  "/pics/clubiq-symbol-gold.png", "/pics/sv-barver-darts.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("clubiq-music-shell-") && key !== CACHE).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then(cached => cached || caches.match("/"))));
});
