const SHELL='barver-compact-shell-a2f9d5269cc4c373',HISTORY='barver-compact-history-v1';
const base=new URL('./',self.location.href),assets=['','index.html','app.js','app.css','crest.webp','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
const assetVersion='e09e97cebbd93af7';
function assetUrl(name){const url=new URL(name,base);if(name&&name!=='index.html')url.searchParams.set('v',assetVersion);return url.href;}
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(assets.map(assetUrl)))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('barver-compact-shell-')&&key!==SHELL)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return;
  const relative=url.pathname.slice(base.pathname.length);
  if(!assets.includes(relative))return;
  if(relative&&relative!=='index.html'&&url.searchParams.get('v')!==assetVersion)return;
  // The whole shell belongs to one build, avoiding mixed old/new JS and CSS.
  event.respondWith(caches.open(SHELL).then(async cache=>(await cache.match(assetUrl(relative)))||fetch(event.request)));
});
function matchId(value){const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null;}
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let payload={};try{payload=event.data?.json()||{};}catch(_){}
  const trainingId=payload.scope==='training'?matchId(payload.trainingId):null,id=trainingId?null:matchId(payload.matchId),notification={id:String(payload.eventId||payload.tag||Date.now()).slice(0,200),title:String(payload.title||'Barver Darts').slice(0,200),body:String(payload.body||'Neue Meldung aus dem Verein.').slice(0,600),data:{matchId:id,...(trainingId?{scope:'training',trainingId}:{})},at:Date.now()};
  // Always show incoming push, even if local history storage is unavailable.
  await self.registration.showNotification(notification.title,{body:notification.body,icon:assetUrl('icon-192.png'),badge:assetUrl('icon-192.png'),tag:String(payload.tag||notification.id).slice(0,200),data:notification.data});
  try{const cache=await caches.open(HISTORY),url=new URL('push-history',base).href,old=await cache.match(url),items=old?await old.json():[];const history=[notification,...items.filter(n=>n.id!==notification.id)].slice(0,50);await cache.put(url,new Response(JSON.stringify(history),{headers:{'Content-Type':'application/json'}}));}catch(_){}
  for(const client of await self.clients.matchAll({type:'window'}))if(new URL(client.url).pathname.startsWith(base.pathname))client.postMessage({type:'BARVER_APP_PUSH',notification});
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();const data=event.notification.data,trainingId=data?.scope==='training'?matchId(data.trainingId):null,id=trainingId?null:matchId(data?.matchId),target=new URL(trainingId?'?training='+trainingId:id?'?match='+id:'',base).href;
  event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});const existing=windows.find(client=>{const url=new URL(client.url);return url.origin===base.origin&&url.pathname.startsWith(base.pathname);});if(existing){await existing.navigate(target);await existing.focus();}else await self.clients.openWindow(target);})());
});
