/* Lightweight anonymous page presence, independent of 3K. */
(function () {
  'use strict';
  const badge=document.getElementById('onlineVisitors');
  if(!badge||!window.crypto?.randomUUID)return;
  const session=crypto.randomUUID();
  let timer=null,controller=null,generation=0;
  function body(active){return JSON.stringify({session_id:session,active});}
  function leave() {
    ++generation;clearTimeout(timer);controller?.abort();
    navigator.sendBeacon?.('/api/v1/darts/presence',new Blob([body(false)],{type:'application/json'}));
  }
  async function heartbeat() {
    clearTimeout(timer);
    if(document.hidden)return;
    const current=++generation;
    controller?.abort();const requestController=new AbortController();controller=requestController;
    const timeout=setTimeout(()=>requestController.abort(),8000);
    try {
      const response=await fetch('/api/v1/darts/presence',{method:'POST',
        headers:{'Content-Type':'application/json'},body:body(true),cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('Presence unavailable');
      const data=await response.json();
      if(current!==generation)return;
      if(!Number.isSafeInteger(data.online)||data.online<0)throw new Error('Invalid presence count');
      badge.textContent=`${data.online.toLocaleString('de-DE')} online${data.demo?' · Demo':''}`;
      badge.setAttribute('aria-label',`${data.online} aktive Seitenansichten${data.demo?' in der Demo':''}`);
      badge.classList.add('is-current');
    } catch (_) {
      if(current!==generation)return;
      badge.textContent='– online';badge.classList.remove('is-current');
      badge.setAttribute('aria-label','Online-Zähler gerade nicht erreichbar');
    } finally {
      clearTimeout(timeout);
      if(current===generation&&!document.hidden)timer=setTimeout(heartbeat,45000);
    }
  }
  document.addEventListener('visibilitychange',()=>document.hidden?leave():heartbeat());
  window.addEventListener('pagehide',leave);
  window.addEventListener('pageshow',event=>{if(event.persisted)heartbeat();});
  window.addEventListener('online',heartbeat);
  heartbeat();
})();
