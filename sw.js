"use strict";

const CACHE = "clubiq-music-shell-20261009-app-tv1";
const SHELL = [
  "/", "/remote", "/party", "/darts", "/training", "/turnier", "/static/darts-training-source.js?v=20261006-training2", "/static/darts-tournament.js?v=20261006-training2", "/static/darts-tournament.css?v=20261006-training2", "/static/darts-trainings.json", "/impressum", "/datenschutz", "/manifest.webmanifest",
  "/static/darts.css?v=20261009-app-tv1", "/static/darts.js?v=20261009-app-tv1", "/static/darts-source-fallback.js?v=20261009-app-tv1", "/static/darts-player-data.js?v=20261006-training1", "/static/darts-broadcast.js?v=20261009-app-tv1", "/static/darts-broadcast.css?v=20261009-app-tv1", "/static/darts-sponsors.json", "/static/darts-events.json", "/static/darts-players.json", "/pics/players/tim-thuerkow-cutout.webp", "/pics/players/christian-fecht-cutout.webp", "/pics/teams/barver-a-team-20261007.webp", "/pics/sv-barver-darts-tight-512.webp", "/pics/events/barver-dart-open-2026.webp", "/pics/teams/barver-b-team-cutout.webp?v=20260927-2",
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
  const cacheableAsset = url.pathname.startsWith("/static/") || url.pathname.startsWith("/pics/");
  if (cacheableAsset && url.pathname.endsWith('.json')) {
    // Editable player/sponsor configuration must not stay frozen in an old cache.
    const refresh=fetch(request).then(async response=>{ if (response.ok) { const cache=await caches.open(CACHE); await cache.put(request,response.clone()); } return response; });
    event.waitUntil(refresh.catch(()=>{}));
    event.respondWith(caches.match(request).then(cached=>cached||refresh));
    return;
  }
  if (cacheableAsset) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(async response => {
      if (response.ok) { const copy=response.clone(); const cache=await caches.open(CACHE); await cache.put(request,copy); }
      return response;
    })));
    return;
  }
  event.respondWith(fetch(request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then(cached => cached || caches.match("/"))));
});

let historyWrite=Promise.resolve();
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  const message = {
    title: typeof payload.title === "string" ? payload.title.slice(0, 120) : "ClubIQ Darts",
    body: typeof payload.body === "string" ? payload.body.slice(0, 240) : "Neue Meldung aus dem Darts-Matchcenter.",
  };
  historyWrite=historyWrite.catch(()=>{}).then(async()=>{
    const cache=await caches.open('clubiq-darts-notifications-v1');
    const previous=await cache.match('/__darts_notification_history__');
    const entries=previous?await previous.json():[];
    const entry={...message,receivedAt:new Date().toISOString(),tag:payload.tag||''};
    await cache.put('/__darts_notification_history__',new Response(JSON.stringify([entry,...entries].slice(0,100)),{headers:{'Content-Type':'application/json'}}));
  });
  const broadcast = clients.matchAll({type:"window",includeUncontrolled:true}).then(windows => {
    for (const client of windows) client.postMessage({type:"clubiq-darts-push",payload:message});
  });
  const notification = self.registration.showNotification(message.title, {
    body: message.body,
    icon: "/pics/pwa-512.png",
    badge: "/pics/logo.png",
    tag: payload.tag || "clubiq-darts",
    renotify: true,
    data: {url: payload.url || "https://barverdarts.clubiq.party/"},
  });
  event.waitUntil(Promise.all([broadcast,notification,historyWrite.catch(()=>{})]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "https://barverdarts.clubiq.party/";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(windows => {
    const existing = windows.find(client => client.url.startsWith("https://barverdarts.clubiq.party/"));
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});
