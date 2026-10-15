/* Existing Barver editors share the CMS session and navigation. */
(() => {
  'use strict';
  const frame=document.querySelector('#dartsWorkspace'), note=document.querySelector('#dartsWorkspaceStatus');
  const views=new Set(['players','sponsors','events','notices','social','tournament','training']);
  let allowed=false, ready=false, wanted=null, timer=null;
  const send=message=>frame.contentWindow?.postMessage(message,location.origin);
  function open(view,team='') {
    if(!allowed||!views.has(view))return;
    wanted={view,team};frame.title={players:'Spielerprofile',sponsors:'Sponsoren',events:'Veranstaltungen & Banner',notices:'Spiel- & Terminhinweise',social:'Vereinskanäle',tournament:'Turniere & TV',training:'Training'}[view];
    if(ready){send({type:'clubiq-admin-open',...wanted,theme:document.documentElement.dataset.theme});return;}
    note.textContent='Verwaltung wird geladen …';note.hidden=false;
    if(!frame.hasAttribute('src')){
      frame.src='/darts-admin?embedded=1';
      clearTimeout(timer);timer=setTimeout(()=>{if(!ready){note.textContent='Die Verwaltung konnte nicht geladen werden. Bitte erneut versuchen.';document.querySelector('#retryDartsWorkspace').hidden=false;}},20000);
    }
  }
  function clear() {
    try{frame.contentWindow?.DartsAdminWorkspace?.discard();}catch(_){}
    clearTimeout(timer);ready=false;wanted=null;frame.removeAttribute('src');frame.style.height='360px';
    note.hidden=true;document.querySelector('#retryDartsWorkspace').hidden=true;
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame.contentWindow||!allowed)return;
    const message=event.data;
    if(message?.type==='clubiq-admin-ready'){
      ready=true;clearTimeout(timer);note.hidden=true;document.querySelector('#retryDartsWorkspace').hidden=true;
      if(wanted)open(wanted.view,wanted.team);
    }else if(message?.type==='clubiq-admin-height'&&Number.isFinite(message.height)){
      frame.style.height=Math.min(25000,Math.max(320,Math.ceil(message.height)))+'px';
    }else if(message?.type==='clubiq-admin-auth-required'){
      ready=false;clearTimeout(timer);note.textContent='Bitte erneut anmelden. Deine Eingaben bleiben erhalten.';note.hidden=false;
      window.dispatchEvent(new CustomEvent('clubiq-admin-auth-required'));
    }else if(message?.type==='clubiq-admin-dirty'){
      window.dispatchEvent(new CustomEvent('clubiq-admin-change'));
    }else if(message?.type==='clubiq-admin-error'){
      clearTimeout(timer);ready=false;note.textContent=typeof message.message==='string'?message.message:'Die Verwaltung ist gerade nicht erreichbar.';note.hidden=false;document.querySelector('#retryDartsWorkspace').hidden=false;
    }
  });
  document.querySelector('#retryDartsWorkspace').addEventListener('click',()=>{
    const target=wanted;if(ready||!target)return;
    // Retry the existing editor in place so a renewed login retains pending changes.
    try{const api=frame.contentWindow?.DartsAdminWorkspace;if(api){api.authenticate();return;}}catch(_){}
    frame.removeAttribute('src');open(target.view,target.team);
  });
  window.ClubAdminWorkspace={
    views,open,clear,
    configure(value){allowed=value;if(!allowed)clear();},
    hasChanges(){try{return allowed&&!!frame.contentWindow?.DartsAdminWorkspace?.hasChanges();}catch(_){return false;}},
    theme(){if(ready)send({type:'clubiq-admin-theme',theme:document.documentElement.dataset.theme});},
    resume(){if(!allowed||!wanted)return;try{frame.contentWindow?.DartsAdminWorkspace?.authenticate();}catch(_){open(wanted.view,wanted.team);}}
  };
})();
