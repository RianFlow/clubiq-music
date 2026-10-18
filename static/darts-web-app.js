'use strict';
(() => {
  const inApp=location.pathname.startsWith('/app/');
  // Retain existing app preferences and opt-outs; never replace website choices.
  if(inApp)try{
    const read=key=>JSON.parse(localStorage.getItem('CapacitorStorage.barver-app-'+key)||'null');
    const saved=read('preferences');
    if(saved&&!localStorage.getItem('clubiq_darts_preferences_v1'))localStorage.setItem('clubiq_darts_preferences_v1',JSON.stringify(saved));
    if(saved?.favorite&&!localStorage.getItem('clubiq_darts_favorite'))localStorage.setItem('clubiq_darts_favorite',saved.favorite);
    const theme=read('appearance');
    if(['light','dark'].includes(theme)&&!localStorage.getItem('clubiq_darts_theme'))localStorage.setItem('clubiq_darts_theme',theme);
    const enabled=read('broadcast-enabled');
    if(typeof enabled==='boolean'&&!localStorage.getItem('clubiq_darts_broadcast_enabled'))localStorage.setItem('clubiq_darts_broadcast_enabled',String(enabled));
  }catch(_){}
  const params=new URLSearchParams(location.search),training=params.get('training');
  if(inApp&&/^[1-9]\d{0,7}$/.test(training||'')){location.replace('/app/training?event='+training);return;}
  let installPrompt;
  const install=document.createElement('button');install.type='button';install.id='webAppInstall';install.textContent='Web-App installieren';install.hidden=true;
  document.querySelector('.personal-push-actions')?.append(install);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;if(install)install.hidden=false;});
  window.addEventListener('appinstalled',()=>{installPrompt=null;if(install)install.hidden=true;});
  install?.addEventListener('click',async()=>{if(!installPrompt)return;await installPrompt.prompt();installPrompt=null;install.hidden=true;});
  if(!inApp||!('serviceWorker' in navigator)||!window.isSecureContext)return;
  const registration=navigator.serviceWorker.register('/app/sw.js?v=20261018-shared1',{scope:'/app/',updateViaCache:'none'});
  window.DartsWebApp={registration};
  registration.then(async reg=>{
    // Copy history without touching the registration or its push subscription.
    try{
      const old=await caches.open('barver-compact-history-v1'),response=await old.match(new URL('/app/push-history',location.origin));
      if(response){
        const target=await caches.open('clubiq-darts-notifications-v1'),existing=await target.match('/__darts_notification_history__');
        const current=existing?await existing.json():[],items=(await response.json()).map(item=>({title:item.title,body:item.body,receivedAt:new Date(item.at).toISOString(),tag:item.id}));
        const seen=new Set(),merged=[...current,...items].sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt)).filter(item=>{const key=item.tag||JSON.stringify(item);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,100);
        await target.put('/__darts_notification_history__',new Response(JSON.stringify(merged),{headers:{'Content-Type':'application/json'}}));
      }
    }catch(_){}
    const offer=()=>{
      if(!reg.waiting)return;
      let button=document.querySelector('#webAppUpdate');
      if(!button){button=document.createElement('button');button.id='webAppUpdate';button.type='button';button.textContent='Update verfügbar · jetzt neu laden';document.querySelector('.personal-push-actions')?.append(button);}
      button.onclick=()=>{navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});reg.waiting?.postMessage({type:'ACTIVATE_UPDATE'});};
    };
    offer();reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',offer));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update().catch(()=>{});});
  }).catch(()=>{});
})();
