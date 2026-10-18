'use strict';
const SHELL='barver-website-shell-20261018-shared1';
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(SHELL).then(async cache=>{
    const response=await fetch('/app/',{cache:'reload'});
    if(!response.ok)throw Error('Web-App nicht erreichbar');
    await cache.put('/app/',response);
  }));
  // One-time migration from the old cache-first compact app. Subscription stays.
  self.skipWaiting();
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const keys=await caches.keys(),migration=keys.some(key=>key.startsWith('barver-compact-shell-'));
  for(const key of keys)if((key.startsWith('barver-compact-shell-')||key.startsWith('barver-website-shell-'))&&key!==SHELL)await caches.delete(key);
  await self.clients.claim();
  if(migration)for(const client of await self.clients.matchAll({type:'window'})){
    const url=new URL(client.url);
    // Navigation waits for activation; awaiting it here would deadlock activation.
    if(url.origin===self.location.origin&&['/app/','/app/index.html'].includes(url.pathname))client.navigate(client.url).catch(()=>{});
  }
})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  const page=request.mode==='navigate'&&['/app/','/app/index.html','/app/live','/app/training','/app/turnier'].includes(url.pathname);
  const asset=url.pathname.startsWith('/pics/')||url.pathname.startsWith('/static/')&&!url.pathname.startsWith('/static/barver-app/');
  if(!page&&!asset)return;
  // Data/config and HTML always use the network. Never freeze an old match.
  event.respondWith((async()=>{
    const cache=await caches.open(SHELL);
    try{const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;}
    catch(error){const saved=await cache.match(request);if(saved)return saved;if(page)return (await cache.match('/app/'))||Response.error();throw error;}
  })());
});
let historyWrite=Promise.resolve();
function id(value){const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:null;}
self.addEventListener('push',event=>{
  let payload={};try{payload=event.data?.json()||{};}catch(_){}
  const trainingId=payload.scope==='training'?id(payload.trainingId):null,matchId=trainingId?null:id(payload.matchId);
  const message={title:String(payload.title||'Barver Darts').slice(0,200),body:String(payload.body||'Neue Meldung aus dem Verein.').slice(0,600)};
  const tag=String(payload.eventId||payload.tag||Date.now()).slice(0,200);
  historyWrite=historyWrite.catch(()=>{}).then(async()=>{
    const cache=await caches.open('clubiq-darts-notifications-v1'),previous=await cache.match('/__darts_notification_history__'),items=previous?await previous.json():[];
    await cache.put('/__darts_notification_history__',new Response(JSON.stringify([{...message,tag,receivedAt:new Date().toISOString()},...items.filter(item=>item.tag!==tag)].slice(0,100)),{headers:{'Content-Type':'application/json'}}));
  });
  event.waitUntil(Promise.all([
    self.registration.showNotification(message.title,{body:message.body,icon:'/static/barver-app/icon-192.png',badge:'/static/barver-app/icon-192.png',tag:String(payload.tag||tag),data:{matchId,trainingId}}),
    historyWrite.catch(()=>{}),
    self.clients.matchAll({type:'window'}).then(windows=>{for(const client of windows)if(new URL(client.url).pathname.startsWith('/app/'))client.postMessage({type:'clubiq-darts-push',payload:message});}),
  ]));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const data=event.notification.data||{},trainingId=id(data.trainingId),matchId=id(data.matchId);
  const target=new URL(trainingId?'/app/training?event='+trainingId:matchId?'/app/?match='+matchId:'/app/',self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>{const url=new URL(client.url);return url.origin===self.location.origin&&url.pathname.startsWith('/app/');});
    if(existing){await existing.navigate(target);await existing.focus();}else await self.clients.openWindow(target);
  })());
});
