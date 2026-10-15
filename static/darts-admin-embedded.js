(() => {
  'use strict';
  if(!state.cookieMode)return;
  const baselines=new Map(), forms=['profileForm','sponsorForm','eventForm','socialForm','tournamentForm','noticeForm'];
  const send=message=>parent.postMessage(message,location.origin);
  const fingerprint=id=>JSON.stringify([...document.getElementById(id).elements]
    .filter(node=>/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName))
    .map(node=>[node.id||node.name,node.value,node.checked,[...(node.files||[])].map(file=>[file.name,file.size,file.lastModified])]));
  const dirty=id=>baselines.has(id)&&baselines.get(id)!==fingerprint(id);
  const hasChanges=()=>forms.some(dirty);
  const changed=()=>send({type:'clubiq-admin-dirty',dirty:hasChanges()});
  const mark=id=>{baselines.set(id,fingerprint(id));changed();};
  const originalPlayer=selectPlayer, originalSponsor=selectSponsor, originalEvent=selectEvent, originalSocial=selectSocial, originalTournament=loadTournament;
  selectPlayer=(...args)=>{originalPlayer(...args);mark('profileForm');};
  selectSponsor=(...args)=>{originalSponsor(...args);mark('sponsorForm');};
  selectEvent=(...args)=>{originalEvent(...args);mark('eventForm');};
  const originalNotice=selectAppointmentNotice;
  selectAppointmentNotice=(...args)=>{originalNotice(...args);mark('noticeForm');};
  selectSocial=(...args)=>{originalSocial(...args);mark('socialForm');};
  loadTournament=async(...args)=>{await originalTournament(...args);mark('tournamentForm');};
  document.addEventListener('input',changed);document.addEventListener('change',changed);
  document.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    const form=target.closest('#playerList')||target.id==='newPlayer'?'profileForm':
      target.closest('#sponsorList')||target.id==='newSponsor'?'sponsorForm':
      target.closest('#eventList')||target.id==='newEvent'?'eventForm':target.closest('#socialList')||target.id==='newSocial'?'socialForm':null;
    if(form&&dirty(form)&&!confirm('Es gibt ungespeicherte Änderungen. Möchtest du sie verwerfen?')){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  let loaded=false, trainingLoaded=false;
  async function authenticate(){
    try{if(loaded)await api('/api/v1/darts/admin/verify');else {await openAdmin('','');loaded=true;}
      send({type:'clubiq-admin-ready'});
    }catch(error){$('#dataStatus').textContent=error.message;send({type:[401,403].includes(error.status)?'clubiq-admin-auth-required':'clubiq-admin-error',message:error.message});}
  }
  async function loadTrainings(refresh=false){
    const status=$('#trainingAdminStatus'), button=$('#refreshAdminTrainings');
    status.textContent='Trainings werden geprüft …';button.disabled=true;
    try{
      const result=await api('/api/v1/darts/trainings'+(refresh?'?refresh=true':''));
      const events=Array.isArray(result.events)?result.events:[], today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'});
      const foundToday=events.some(event=>new Date(event.date).toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'})===today);
      const updated=result.updatedAt?new Date(result.updatedAt).toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'}):'noch kein Datenstand';
      status.textContent=(result.stale||result.degraded?'Letzter verfügbarer Stand':'Letzte erfolgreiche Abfrage')+': '+updated+' Uhr. '+(foundToday?'Ein Training für heute ist hinterlegt.':'Für heute wurde noch kein Training gefunden.');
      const list=$('#trainingAdminList');list.replaceChildren();
      for(const item of events){
        const article=document.createElement('article'),copy=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('small'),link=document.createElement('a');
        title.textContent=item.name;meta.textContent=({FINISH:'Beendet',ACTIVE:'Aktiv',RUNNING:'Aktiv',STARTED:'Aktiv',CREATED:'Vorbereitet'})[item.status]||'Status offen';
        link.textContent='Training ansehen ↗';link.href='/training?event='+encodeURIComponent(item.id);link.target='_blank';link.rel='noopener';copy.append(title,meta);article.append(copy,link);list.append(article);
      }
      if(!events.length)list.textContent='Noch keine Trainings gefunden.';
      trainingLoaded=true;
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  }
  $('#refreshAdminTrainings').addEventListener('click',()=>loadTrainings(true));
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent)return;
    const message=event.data;
    if(message?.type==='clubiq-admin-theme'||message?.type==='clubiq-admin-open')applyAdminTheme(message.theme==='dark'?'dark':'light');
    if(message?.type==='clubiq-admin-open'&&['players','sponsors','events','social','tournament','training'].includes(message.view)){
      showAdminView(message.view);
      if(message.view==='players'&&/^[A-D]$/.test(message.team||'')){$('#teamFilter').value=message.team;renderPlayerList();}
      if(message.view==='training'&&!trainingLoaded)loadTrainings();
    }
  });
  let height=0;
  new ResizeObserver(()=>requestAnimationFrame(()=>{const next=Math.ceil(document.querySelector('main').getBoundingClientRect().height)+2;if(next!==height){height=next;send({type:'clubiq-admin-height',height});}})).observe(document.querySelector('main'));
  window.DartsAdminWorkspace={hasChanges,authenticate,discard(){for(const id of forms)mark(id);}};
  authenticate();
})();
