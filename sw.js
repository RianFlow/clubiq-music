"use strict";

const CACHE = "clubiq-music-shell-20260925-2";
const SHELL = [
  "/", "/remote", "/party", "/darts", "/manifest.webmanifest",
  "/static/darts.css?v=20260925-2", "/static/darts.js?v=20260925-2", "/static/darts-sponsors.json", "/pics/sv-barver-darts-tight.png",
  "/static/app.css?v=20260915-1", "/static/app.js?v=20260919-1",
  "/static/song-info.js?v=20260917-1", "/static/comfort.js?v=20260919-1", "/static/comfort.css?v=20260917-1",
  "/static/reliability.js?v=20260919-1",
  "/static/mobile.css?v=20260919-2", "/static/mobile.js?v=20260919-2",
  "/static/images.js?v=20260902-3", "/static/radio-placeholder.svg",
  "/static/range-control.js?v=20260902-3",
  "/static/companion.css?v=20260902-3", "/static/remote.js?v=20260919-1",
  "/static/party.js?v=20260915-1", "/static/soundboard-credits.html", "/pics/logo.png", "/pics/pwa-512.png",
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

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  event.waitUntil(self.registration.showNotification(payload.title || "ClubIQ Darts", {
    body: payload.body || "Neue Meldung aus dem Darts-Matchcenter.",
    icon: "/pics/pwa-512.png",
    badge: "/pics/logo.png",
    tag: payload.tag || "clubiq-darts",
    renotify: true,
    data: {url: payload.url || "https://barverdarts.clubiq.party/"},
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "https://barverdarts.clubiq.party/";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(windows => {
    const existing = windows.find(client => client.url.startsWith("https://barverdarts.clubiq.party/"));
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});
