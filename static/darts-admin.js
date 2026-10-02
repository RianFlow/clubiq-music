const $ = selector => document.querySelector(selector);
const state = { password: sessionStorage.getItem('clubiq_darts_admin') || '', players: [], selected: null, pendingPhoto: null, previewUrl: '', sponsors: [], selectedSponsor: null, pendingSponsorLogo: null, events: [], selectedEvent: null, pendingEventImage: null, eventImageObjectUrl: '', socialLinks: [], selectedSocial: null };

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Admin-Password', state.password);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {...options, headers, cache:'no-store'});
  if (!response.ok) {
    let message = 'Die Anfrage konnte nicht ausgeführt werden.';
    try { message = (await response.json()).detail || message; } catch (_) {}
    const error = new Error(message); error.status = response.status; throw error;
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : null;
}

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function personal(player) { return player.personal && typeof player.personal === 'object' ? player.personal : {}; }
function playerLabel(player) { return player.name || `3K-Spieler ${player.playerId}`; }
function photoDataUrl(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.addEventListener('load',()=>resolve(String(reader.result || '')),{once:true});reader.addEventListener('error',()=>reject(new Error('Die Bildvorschau konnte nicht erstellt werden.')),{once:true});reader.readAsDataURL(file);}); }

function mergePlayers(profiles, season) {
  const byId = new Map((profiles || []).map(item => [String(item.playerId), {...item}]));
  for (const team of season?.teams || []) {
    for (const member of team.roster || []) {
      if (!member?.id) continue;
      const key = String(member.id), current = byId.get(key) || {playerId:Number(member.id),published:false,stored:false,personal:{}};
      current.name = member.name || current.name;
      current.role = member.role || current.role || 'Spieler';
      current.team = team.code || current.team || '';
      byId.set(key,current);
    }
  }
  return [...byId.values()].sort((a,b)=>(a.team || 'Z').localeCompare(b.team || 'Z','de') || playerLabel(a).localeCompare(playerLabel(b),'de'));
}

function rosterPlayers(season) {
  const players=[];
  for (const team of season?.teams || []) for (const member of team.roster || []) {
    if (!member?.id || !member?.name || !/^[A-D]$/.test(team.code || '')) continue;
    players.push({player_id:Number(member.id),name:clean(member.name),team:team.code,role:clean(member.role) || 'Spieler'});
  }
  return players;
}

async function loadData() {
  $('#dataStatus').textContent = 'Profile und 3K-Kader werden geladen …';
  const selectedId=state.selected?.playerId;
  const [profilesResult, seasonResult] = await Promise.allSettled([
    api('/api/v1/darts/admin/players'),
    fetch('/api/v1/darts/season',{headers:{Accept:'application/json'},cache:'no-store'}).then(response=>response.ok?response.json():null),
  ]);
  if (profilesResult.status !== 'fulfilled') throw profilesResult.reason;
  const season=seasonResult.status === 'fulfilled' ? seasonResult.value : null;
  state.players = mergePlayers(profilesResult.value.players, season);
  const roster=rosterPlayers(season);
  if (roster.length) api('/api/v1/darts/admin/roster-cache',{method:'POST',body:JSON.stringify({players:roster})}).catch(()=>{});
  $('#dataStatus').textContent = seasonResult.status === 'fulfilled' && seasonResult.value ? `${state.players.length} Profile · 3K-Kader aktuell` : `${state.players.length} Profile · 3K-Kader gerade nicht erreichbar`;
  const selected=state.players.find(item=>item.playerId===selectedId) || state.players[0];
  if (selected) selectPlayer(selected); else renderPlayerList();
}

function renderPlayerList() {
  const query = clean($('#playerSearch').value).toLocaleLowerCase('de-DE');
  const team = $('#teamFilter').value;
  const visible = state.players.filter(player => (team === 'all' || player.team === team) && (!query || `${playerLabel(player)} ${player.alias || ''}`.toLocaleLowerCase('de-DE').includes(query)));
  const fragment = document.createDocumentFragment();
  for (const player of visible) {
    const button = document.createElement('button'); button.type='button';
    if (state.selected?.playerId === player.playerId) button.classList.add('active');
    const name=document.createElement('strong'); name.textContent=playerLabel(player);
    const meta=document.createElement('span'); meta.textContent=`${player.team ? `Barver ${player.team}` : 'Mannschaft offen'} · ${player.published ? 'veröffentlicht' : 'Entwurf'}`;
    button.append(name,meta); button.addEventListener('click',()=>selectPlayer(player)); fragment.append(button);
  }
  if (!visible.length) { const note=document.createElement('p'); note.textContent='Keine passenden Profile.'; fragment.append(note); }
  $('#playerList').replaceChildren(fragment);
}

function setPreview(player, source = '') {
  const root=$('#photoPreview'); root.replaceChildren();
  const imageSource=source || player.image || '';
  if (imageSource) {
    const image=document.createElement('img'); image.src=imageSource; image.alt=`Porträt von ${playerLabel(player)}`;
    image.addEventListener('error',()=>{root.replaceChildren(Object.assign(document.createElement('span'),{textContent:'Foto'}));},{once:true});
    root.append(image);
  } else root.append(Object.assign(document.createElement('span'),{textContent:'Foto'}));
}

function selectPlayer(player) {
  state.selected=player; state.pendingPhoto=null;
  state.previewUrl='';
  $('#editorEmpty').hidden=true; $('#profileForm').hidden=false;
  $('#playerId').value=player.playerId; $('#profileTeam').textContent=player.team ? `SV Barver Darts ${player.team}` : 'Mannschaft offen';
  $('#profileName').textContent=playerLabel(player); $('#profileRole').textContent=player.role || 'Spielerprofil';
  $('#displayName').value=player.name || ''; $('#profileTeamCode').value=player.team || 'A'; $('#profileRosterRole').value=player.role || 'Spieler';
  $('#alias').value=player.alias || ''; $('#playerNumber').value=player.playerNumber || ''; $('#gender').value=player.gender || '';
  const details=personal(player);
  $('#darts').value=details.darts || ''; $('#weightGrams').value=details.weightGrams ?? '';
  $('#favoritePdcPlayer').value=details.favoritePdcPlayer || ''; $('#favoriteFinish').value=details.favoriteFinish ?? '';
  $('#finishRoute').value=details.finishRoute || ''; $('#walkOnSong').value=details.walkOnSong || '';
  $('#published').checked=player.published === true; $('#profilePhoto').value='';
  $('#deletePhoto').disabled=!player.hasUploadedImage; $('#formStatus').hidden=true;
  setPreview(player); renderPlayerList();
}

async function compressPhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Bitte ein JPEG-, PNG- oder WebP-Bild auswählen.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Das Ausgangsbild darf höchstens 15 MB groß sein.');
  const bitmap=await createImageBitmap(file), maximumWidth=1200, maximumHeight=1600;
  const scale=Math.min(1,maximumWidth/bitmap.width,maximumHeight/bitmap.height);
  const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d',{alpha:true}); context.imageSmoothingEnabled=true; context.imageSmoothingQuality='high'; context.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.84));
  if (!blob) throw new Error('Das Bild konnte nicht verarbeitet werden.');
  return new File([blob],'spielerprofil.webp',{type:'image/webp'});
}
async function compressBanner(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Bitte ein JPEG-, PNG- oder WebP-Bild auswählen.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Das Ausgangsbild darf höchstens 15 MB groß sein.');
  const bitmap=await createImageBitmap(file), scale=Math.min(1,1600/bitmap.width,900/bitmap.height);
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d',{alpha:true});context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.84));if(!blob)throw new Error('Das Banner konnte nicht verarbeitet werden.');return new File([blob],'veranstaltung.webp',{type:'image/webp'});
}

async function saveProfile(event) {
  event.preventDefault(); if (!state.selected) return;
  const status=$('#formStatus'); status.hidden=false; status.textContent='Änderungen werden gespeichert …';
  const payload={
    display_name:clean($('#displayName').value),team:$('#profileTeamCode').value,role:$('#profileRosterRole').value,
    player_number:clean($('#playerNumber').value),alias:clean($('#alias').value),gender:$('#gender').value,
    darts:clean($('#darts').value),weight_grams:$('#weightGrams').value ? Number($('#weightGrams').value) : null,
    favorite_pdc_player:clean($('#favoritePdcPlayer').value),favorite_finish:clean($('#favoriteFinish').value),
    finish_route:clean($('#finishRoute').value),walk_on_song:clean($('#walkOnSong').value),published:$('#published').checked,
  };
  try {
    await api(`/api/v1/darts/admin/players/${state.selected.playerId}`,{method:'PUT',body:JSON.stringify(payload)});
    if (state.pendingPhoto) {
      const form=new FormData(); form.set('photo',state.pendingPhoto);
      await api(`/api/v1/darts/admin/players/${state.selected.playerId}/photo`,{method:'POST',body:form});
    }
    const successMessage=payload.published?'Gespeichert und veröffentlicht.':'Als Entwurf gespeichert.';
    await loadData();
    const updated=state.players.find(item=>item.playerId===state.selected.playerId); if (updated) selectPlayer(updated);
    status.hidden=false; status.textContent=successMessage;
  } catch (error) { status.textContent=error.message; }
}

async function createPlayer(event) {
  event.preventDefault(); const error=$('#newPlayerError'); error.hidden=true;
  try {
    const created=await api('/api/v1/darts/admin/players',{method:'POST',body:JSON.stringify({name:clean($('#newPlayerName').value),team:$('#newPlayerTeam').value,role:$('#newPlayerRole').value})});
    $('#newPlayerDialog').close(); $('#newPlayerForm').reset();
    state.selected={playerId:created.player_id}; await loadData();
    const player=state.players.find(item=>item.playerId===created.player_id); if(player) selectPlayer(player);
  } catch(problem) { error.textContent=problem.message; error.hidden=false; }
}

async function deletePhoto() {
  if (!state.selected || !state.selected.hasUploadedImage) return;
  if (!confirm('Das hochgeladene Bild wirklich entfernen? Ein eventuell vorhandenes bisheriges Vereinsbild wird danach wieder verwendet.')) return;
  const status=$('#formStatus'); status.hidden=false; status.textContent='Bild wird entfernt …';
  try { await api(`/api/v1/darts/admin/players/${state.selected.playerId}/photo`,{method:'DELETE'}); await loadData(); const updated=state.players.find(item=>item.playerId===state.selected.playerId); if(updated) selectPlayer(updated); status.hidden=false; status.textContent='Eigenes Bild entfernt.'; }
  catch(error){status.textContent=error.message;}
}

const sponsorTypeLabels={main:'Hauptpartner',club:'Vereinspartner',team:'Teampartner',event:'Veranstaltungspartner'};

function localDateTimeValue(value) {
  if (!value) return '';
  const date=new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}
function checkedValues(selector) { return [...document.querySelectorAll(selector)].filter(node=>node.checked).map(node=>node.value); }
function setCheckedValues(selector, values) {
  const selected=new Set(Array.isArray(values)?values:[]);
  document.querySelectorAll(selector).forEach(node=>{node.checked=selected.has(node.value);});
}
function sponsorPreview(sponsor, source='') {
  const root=$('#sponsorLogoPreview'); root.replaceChildren();
  const imageSource=source || sponsor?.image || '';
  if (imageSource) {
    const image=document.createElement('img'); image.src=imageSource; image.alt=`Logo ${sponsor?.name || ''}`;
    image.addEventListener('error',()=>root.replaceChildren(Object.assign(document.createElement('span'),{textContent:'Logo'})),{once:true});
    root.append(image);
  } else root.append(Object.assign(document.createElement('span'),{textContent:'Logo'}));
}
function renderSponsorList() {
  const query=clean($('#sponsorSearch').value).toLocaleLowerCase('de-DE');
  const type=$('#sponsorTypeFilter').value;
  const visible=state.sponsors.filter(item=>(type==='all'||item.type===type)&&(!query||`${item.name||''} ${item.eventName||''}`.toLocaleLowerCase('de-DE').includes(query)));
  const fragment=document.createDocumentFragment();
  for (const sponsor of visible) {
    const button=document.createElement('button'); button.type='button';
    if (state.selectedSponsor?.id===sponsor.id) button.classList.add('active');
    const name=document.createElement('strong'); name.textContent=sponsor.name;
    const meta=document.createElement('span');
    const teamText=(sponsor.teams||[]).length?` · ${sponsor.teams.map(code=>`Barver ${code}`).join(', ')}`:'';
    meta.textContent=`${sponsorTypeLabels[sponsor.type]||'Sponsor'}${teamText} · ${sponsor.active?'aktiv':'inaktiv'}`;
    button.append(name,meta); button.addEventListener('click',()=>selectSponsor(sponsor)); fragment.append(button);
  }
  if (!visible.length) fragment.append(Object.assign(document.createElement('p'),{textContent:'Keine passenden Sponsoren.'}));
  $('#sponsorList').replaceChildren(fragment);
}
function selectSponsor(sponsor) {
  state.selectedSponsor=sponsor; state.pendingSponsorLogo=null;
  $('#sponsorEditorEmpty').hidden=true; $('#sponsorForm').hidden=false;
  $('#sponsorId').value=sponsor.id||'';
  $('#sponsorName').value=sponsor.name||''; $('#sponsorType').value=sponsor.type||'club';
  $('#sponsorWebsite').value=sponsor.href||''; $('#sponsorPriority').value=sponsor.priority??0;
  $('#sponsorEventName').value=sponsor.eventName||''; $('#sponsorMatchIds').value=(sponsor.eventMatchIds||[]).join(', ');
  $('#sponsorStartsAt').value=localDateTimeValue(sponsor.startsAt); $('#sponsorEndsAt').value=localDateTimeValue(sponsor.endsAt);
  $('#sponsorActive').checked=sponsor.active!==false;
  setCheckedValues('[data-sponsor-team]',sponsor.teams||[]);
  setCheckedValues('[data-sponsor-placement]',sponsor.placements?.length?sponsor.placements:['footer']);
  $('#sponsorLogo').value=''; $('#deleteSponsorLogo').disabled=!sponsor.hasLogo;
  $('#deleteSponsor').disabled=!sponsor.id;
  $('#sponsorNameHeading').textContent=sponsor.name||'Neuer Sponsor';
  $('#sponsorTypeLabel').textContent=sponsorTypeLabels[sponsor.type]||'Sponsor';
  $('#sponsorMeta').textContent=sponsor.id?`Sponsor #${sponsor.id}`:'Noch nicht gespeichert';
  $('#sponsorFormStatus').hidden=true; sponsorPreview(sponsor); renderSponsorList();
}
function newSponsor() {
  selectSponsor({id:null,name:'',type:'club',href:'',teams:[],placements:['footer'],eventName:'',eventMatchIds:[],startsAt:null,endsAt:null,priority:0,active:true,hasLogo:false});
  $('#sponsorName').focus();
}
async function loadSponsors() {
  $('#sponsorDataStatus').textContent='Sponsoren werden geladen …';
  const selectedId=state.selectedSponsor?.id;
  const result=await api('/api/v1/darts/admin/sponsors');
  state.sponsors=Array.isArray(result.sponsors)?result.sponsors:[];
  $('#sponsorDataStatus').textContent=`${state.sponsors.length} Sponsor${state.sponsors.length===1?'':'en'}`;
  const selected=state.sponsors.find(item=>item.id===selectedId);
  if (selected) selectSponsor(selected); else { state.selectedSponsor=null; $('#sponsorForm').hidden=true; $('#sponsorEditorEmpty').hidden=false; renderSponsorList(); }
}
async function saveSponsor(event) {
  event.preventDefault();
  const status=$('#sponsorFormStatus'); status.hidden=false; status.textContent='Sponsor wird gespeichert …';
  const ids=clean($('#sponsorMatchIds').value).split(/[\s,;]+/).filter(Boolean).map(value=>Number(value));
  if (ids.some(value=>!Number.isInteger(value)||value<=0)) { status.textContent='Bitte nur gültige 3K Match-IDs eintragen.'; return; }
  const dateValue=id=>$('#'+id).value ? new Date($('#'+id).value).toISOString() : null;
  const payload={
    name:clean($('#sponsorName').value),sponsor_type:$('#sponsorType').value,website:clean($('#sponsorWebsite').value)||null,
    teams:checkedValues('[data-sponsor-team]'),placements:checkedValues('[data-sponsor-placement]'),
    event_name:clean($('#sponsorEventName').value)||null,event_match_ids:[...new Set(ids)],
    starts_at:dateValue('sponsorStartsAt'),ends_at:dateValue('sponsorEndsAt'),
    priority:Number($('#sponsorPriority').value||0),active:$('#sponsorActive').checked,
  };
  try {
    const existingId=Number($('#sponsorId').value)||null;
    const saved=await api(existingId?`/api/v1/darts/admin/sponsors/${existingId}`:'/api/v1/darts/admin/sponsors',{method:existingId?'PUT':'POST',body:JSON.stringify(payload)});
    const sponsorId=existingId||saved.id;
    if (state.pendingSponsorLogo) {
      const form=new FormData(); form.set('logo',state.pendingSponsorLogo);
      await api(`/api/v1/darts/admin/sponsors/${sponsorId}/logo`,{method:'POST',body:form});
    }
    state.selectedSponsor={id:sponsorId}; state.pendingSponsorLogo=null;
    await loadSponsors(); const updated=state.sponsors.find(item=>item.id===sponsorId); if(updated) selectSponsor(updated);
    status.hidden=false; status.textContent='Sponsor gespeichert.';
  } catch(error) { status.textContent=error.message; }
}
async function deleteSponsor() {
  const id=Number($('#sponsorId').value); if(!id) return;
  if(!confirm('Diesen Sponsor wirklich vollständig löschen?')) return;
  const status=$('#sponsorFormStatus'); status.hidden=false; status.textContent='Sponsor wird gelöscht …';
  try {
    await api(`/api/v1/darts/admin/sponsors/${id}`,{method:'DELETE'});
    state.selectedSponsor=null; await loadSponsors(); status.hidden=true;
  } catch(error){status.textContent=error.message;}
}
async function deleteSponsorLogo() {
  const id=Number($('#sponsorId').value); if(!id||!state.selectedSponsor?.hasLogo) return;
  if(!confirm('Sponsorlogo wirklich entfernen?')) return;
  const status=$('#sponsorFormStatus'); status.hidden=false; status.textContent='Logo wird entfernt …';
  try { await api(`/api/v1/darts/admin/sponsors/${id}/logo`,{method:'DELETE'}); await loadSponsors(); const updated=state.sponsors.find(item=>item.id===id); if(updated) selectSponsor(updated); status.hidden=false; status.textContent='Logo entfernt.'; }
  catch(error){status.textContent=error.message;}
}
function showAdminView(view) {
  for (const name of ['players','sponsors','events','social']) {
    const visible=view===name;
    $(`#${name}AdminView`).hidden=!visible;
    $(`#${name}AdminTab`).classList.toggle('active',visible);
  }
}

function eventImagePreview(item, source='') {
  const root=$('#eventImagePreview'); root.replaceChildren();
  const src=source||item?.image||'';
  if(src){const img=document.createElement('img');img.src=src;img.alt=`Banner ${item?.title||''}`;img.addEventListener('error',()=>root.replaceChildren(Object.assign(document.createElement('span'),{textContent:'Banner'})),{once:true});root.append(img);}
  else root.append(Object.assign(document.createElement('span'),{textContent:'Banner'}));
}
function revokeEventImagePreview(){if(state.eventImageObjectUrl){URL.revokeObjectURL(state.eventImageObjectUrl);state.eventImageObjectUrl='';}}
async function loadProtectedEventImage(item){
  revokeEventImagePreview();
  if(!item?.id||!item.hasImage)return;
  const selectedId=item.id;
  try{
    const response=await fetch(`/api/v1/darts/admin/events/${selectedId}/image`,{headers:{'X-Admin-Password':state.password},cache:'no-store'});
    if(!response.ok)throw new Error('Banner-Vorschau nicht verfügbar.');
    const url=URL.createObjectURL(await response.blob());
    if(state.selectedEvent?.id!==selectedId){URL.revokeObjectURL(url);return;}
    state.eventImageObjectUrl=url;eventImagePreview(item,url);
  }catch(_){if(state.selectedEvent?.id===selectedId)eventImagePreview(item);}
}
function renderEventList(){
  const q=clean($('#eventSearch').value).toLocaleLowerCase('de-DE'), fragment=document.createDocumentFragment();
  for(const item of state.events.filter(e=>!q||`${e.title||''} ${e.location||''}`.toLocaleLowerCase('de-DE').includes(q))){
    const button=document.createElement('button');button.type='button';if(state.selectedEvent?.id===item.id)button.classList.add('active');
    const name=document.createElement('strong');name.textContent=item.title||'Unbenannte Veranstaltung';const meta=document.createElement('span');meta.textContent=`${item.date||'Ohne Datum'} · ${item.active?'veröffentlicht':'Entwurf'}`;
    button.append(name,meta);button.addEventListener('click',()=>selectEvent(item));fragment.append(button);
  }
  if(!fragment.childNodes.length)fragment.append(Object.assign(document.createElement('p'),{textContent:'Keine passenden Veranstaltungen.'}));$('#eventList').replaceChildren(fragment);
}
function selectEvent(item){
  revokeEventImagePreview();state.selectedEvent=item;state.pendingEventImage=null;$('#eventEditorEmpty').hidden=true;$('#eventForm').hidden=false;$('#eventId').value=item.id||'';
  $('#eventTitle').value=item.title||'';$('#eventKicker').value=item.kicker||'';$('#eventDescription').value=item.description||'';$('#eventDate').value=item.date||'';$('#eventLocation').value=item.location||'';$('#eventHref').value=item.href||'';$('#eventButtonLabel').value=item.buttonLabel||'';$('#eventPriority').value=item.priority??0;$('#eventStartsAt').value=localDateTimeValue(item.startsAt);$('#eventEndsAt').value=localDateTimeValue(item.endsAt);$('#eventActive').checked=item.active===true;
  $('#eventHeading').textContent=item.title||'Neue Veranstaltung';$('#eventMeta').textContent=item.id?`Veranstaltung #${item.id}`:'Noch nicht gespeichert';$('#eventImage').value='';$('#deleteEventImage').disabled=!item.hasImage;$('#deleteEvent').disabled=!item.id;$('#eventFormStatus').hidden=true;eventImagePreview(item.image&&!String(item.image).includes('/api/v1/darts/admin/events/')?item:null);if(item.hasImage)loadProtectedEventImage(item);renderEventList();
}
function newEvent(){selectEvent({id:null,title:'',kicker:'',description:'',date:'',location:'',href:'',buttonLabel:'',priority:0,active:false,hasImage:false});$('#eventTitle').focus();}
async function loadEvents(){
  $('#eventDataStatus').textContent='Veranstaltungen werden geladen …';const keep=state.selectedEvent?.id;const result=await api('/api/v1/darts/admin/events');
  state.events=Array.isArray(result.events)?result.events:[];$('#eventDataStatus').textContent=`${state.events.length} Veranstaltung${state.events.length===1?'':'en'}`;
  const selected=state.events.find(e=>e.id===keep);if(selected)selectEvent(selected);else{state.selectedEvent=null;$('#eventForm').hidden=true;$('#eventEditorEmpty').hidden=false;renderEventList();}
}
async function saveEvent(event){
  event.preventDefault();const status=$('#eventFormStatus');status.hidden=false;status.textContent='Veranstaltung wird gespeichert …';
  const dateValue=id=>$('#'+id).value?new Date($('#'+id).value).toISOString():null;
  const payload={title:clean($('#eventTitle').value),kicker:clean($('#eventKicker').value),description:clean($('#eventDescription').value),date_label:clean($('#eventDate').value),location:clean($('#eventLocation').value),website:clean($('#eventHref').value)||null,button_label:clean($('#eventButtonLabel').value)||null,starts_at:dateValue('eventStartsAt'),ends_at:dateValue('eventEndsAt'),priority:Number($('#eventPriority').value||0),active:$('#eventActive').checked};
  try{const id=Number($('#eventId').value)||null;const saved=await api(id?`/api/v1/darts/admin/events/${id}`:'/api/v1/darts/admin/events',{method:id?'PUT':'POST',body:JSON.stringify(payload)});const eventId=id||saved.id;
    if(state.pendingEventImage){const form=new FormData();form.set('image',state.pendingEventImage);await api(`/api/v1/darts/admin/events/${eventId}/image`,{method:'POST',body:form});}
    state.selectedEvent={id:eventId};state.pendingEventImage=null;await loadEvents();const updated=state.events.find(e=>e.id===eventId);if(updated)selectEvent(updated);status.hidden=false;status.textContent='Veranstaltung gespeichert.';
  }catch(error){status.textContent=error.message;}
}
async function deleteEvent(){const id=Number($('#eventId').value);if(!id||!confirm('Diese Veranstaltung wirklich löschen?'))return;const status=$('#eventFormStatus');status.hidden=false;status.textContent='Veranstaltung wird gelöscht …';try{await api(`/api/v1/darts/admin/events/${id}`,{method:'DELETE'});state.selectedEvent=null;await loadEvents();status.hidden=true;}catch(error){status.textContent=error.message;}}
async function deleteEventImage(){const id=Number($('#eventId').value);if(!id||!state.selectedEvent?.hasImage||!confirm('Veranstaltungsbanner wirklich entfernen?'))return;const status=$('#eventFormStatus');status.hidden=false;status.textContent='Banner wird entfernt …';try{await api(`/api/v1/darts/admin/events/${id}/image`,{method:'DELETE'});await loadEvents();const item=state.events.find(e=>e.id===id);if(item)selectEvent(item);status.hidden=false;status.textContent='Banner entfernt.';}catch(error){status.textContent=error.message;}}

function renderSocialList(){const q=clean($('#socialSearch').value).toLocaleLowerCase('de-DE'),fragment=document.createDocumentFragment();for(const item of state.socialLinks.filter(x=>!q||`${x.platform||''} ${x.label||''}`.toLocaleLowerCase('de-DE').includes(q))){const button=document.createElement('button');button.type='button';if(state.selectedSocial?.id===item.id)button.classList.add('active');const name=document.createElement('strong');name.textContent=item.label||item.platform;const meta=document.createElement('span');meta.textContent=`${item.platform} · ${item.active?'veröffentlicht':'Entwurf'}`;button.append(name,meta);button.addEventListener('click',()=>selectSocial(item));fragment.append(button);}if(!fragment.childNodes.length)fragment.append(Object.assign(document.createElement('p'),{textContent:'Keine passenden Links.'}));$('#socialList').replaceChildren(fragment);}
function selectSocial(item){state.selectedSocial=item;$('#socialEditorEmpty').hidden=true;$('#socialForm').hidden=false;$('#socialId').value=item.id||'';$('#socialPlatform').value=item.platform||'instagram';$('#socialLabel').value=item.label||'';$('#socialHref').value=item.href||'';$('#socialPriority').value=item.priority??0;$('#socialActive').checked=item.active===true;$('#socialHeading').textContent=item.label||'Neuer Link';$('#socialMeta').textContent=item.id?`Social Link #${item.id}`:'Noch nicht gespeichert';$('#deleteSocial').disabled=!item.id;$('#socialFormStatus').hidden=true;renderSocialList();}
function newSocial(){selectSocial({id:null,platform:'instagram',label:'',href:'',priority:0,active:false});$('#socialLabel').focus();}
async function loadSocial(){ $('#socialDataStatus').textContent='Social Links werden geladen …';const keep=state.selectedSocial?.id;const result=await api('/api/v1/darts/admin/social-links');state.socialLinks=Array.isArray(result.links)?result.links:[];$('#socialDataStatus').textContent=`${state.socialLinks.length} Link${state.socialLinks.length===1?'':'s'}`;const item=state.socialLinks.find(x=>x.id===keep);if(item)selectSocial(item);else{state.selectedSocial=null;$('#socialForm').hidden=true;$('#socialEditorEmpty').hidden=false;renderSocialList();}}
async function saveSocial(event){event.preventDefault();const status=$('#socialFormStatus');status.hidden=false;status.textContent='Link wird gespeichert …';try{const id=Number($('#socialId').value)||null;const payload={platform:$('#socialPlatform').value,label:clean($('#socialLabel').value),website:clean($('#socialHref').value),priority:Number($('#socialPriority').value||0),active:$('#socialActive').checked};if(!/^https:\/\//i.test(payload.website)){status.textContent='Bitte einen HTTPS-Link eingeben.';return;}const saved=await api(id?`/api/v1/darts/admin/social-links/${id}`:'/api/v1/darts/admin/social-links',{method:id?'PUT':'POST',body:JSON.stringify(payload)});const savedId=id||saved.id;state.selectedSocial={id:savedId};await loadSocial();const updated=state.socialLinks.find(x=>x.id===savedId);if(updated)selectSocial(updated);status.hidden=false;status.textContent='Link gespeichert.';}catch(error){status.textContent=error.message;}}
async function deleteSocial(){const id=Number($('#socialId').value);if(!id||!confirm('Diesen Social-Link wirklich löschen?'))return;const status=$('#socialFormStatus');status.hidden=false;status.textContent='Link wird gelöscht …';try{await api(`/api/v1/darts/admin/social-links/${id}`,{method:'DELETE'});state.selectedSocial=null;await loadSocial();status.hidden=true;}catch(error){status.textContent=error.message;}}

async function openAdmin(password) {
  state.password=password;
  await api('/api/v1/music/admin/verify');
  sessionStorage.setItem('clubiq_darts_admin',password);
  $('#loginPanel').hidden=true; $('#adminPanel').hidden=false; $('#logout').hidden=false;
  const results=await Promise.allSettled([loadData(),loadSponsors(),loadEvents(),loadSocial()]);
  const targets=['#dataStatus','#sponsorDataStatus','#eventDataStatus','#socialDataStatus'];
  results.forEach((result,index)=>{if(result.status==='rejected')$(targets[index]).textContent=`Laden fehlgeschlagen: ${result.reason?.message||'Unbekannter Fehler'}`;});
}

$('#playersAdminTab').addEventListener('click',()=>showAdminView('players'));
$('#sponsorsAdminTab').addEventListener('click',()=>showAdminView('sponsors'));
$('#eventsAdminTab').addEventListener('click',()=>showAdminView('events'));
$('#socialAdminTab').addEventListener('click',()=>showAdminView('social'));
$('#sponsorSearch').addEventListener('input',renderSponsorList);
$('#sponsorTypeFilter').addEventListener('change',renderSponsorList);
$('#newSponsor').addEventListener('click',newSponsor);
$('#sponsorForm').addEventListener('submit',saveSponsor);
$('#deleteSponsor').addEventListener('click',deleteSponsor);
$('#deleteSponsorLogo').addEventListener('click',deleteSponsorLogo);
$('#sponsorLogo').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file||!state.selectedSponsor)return;
  const status=$('#sponsorFormStatus'); status.hidden=false; status.textContent='Logo wird optimiert …';
  try {
    state.pendingSponsorLogo=await compressPhoto(file);
    const preview=await photoDataUrl(state.pendingSponsorLogo); sponsorPreview(state.selectedSponsor,preview);
    status.textContent=`Logo vorbereitet (${Math.max(1,Math.round(state.pendingSponsorLogo.size/1024))} KB). Zum Übernehmen noch speichern.`;
  } catch(error){state.pendingSponsorLogo=null;status.textContent=error.message;}
});
$('#sponsorType').addEventListener('change',()=>{$('#sponsorTypeLabel').textContent=sponsorTypeLabels[$('#sponsorType').value]||'Sponsor';});
$('#eventSearch').addEventListener('input',renderEventList);$('#newEvent').addEventListener('click',newEvent);$('#eventForm').addEventListener('submit',saveEvent);$('#deleteEvent').addEventListener('click',deleteEvent);$('#deleteEventImage').addEventListener('click',deleteEventImage);
$('#eventImage').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file||!state.selectedEvent)return;revokeEventImagePreview();const status=$('#eventFormStatus');status.hidden=false;status.textContent='Banner wird optimiert …';try{state.pendingEventImage=await compressBanner(file);eventImagePreview(state.selectedEvent,await photoDataUrl(state.pendingEventImage));status.textContent=`Banner vorbereitet (${Math.max(1,Math.round(state.pendingEventImage.size/1024))} KB). Zum Übernehmen noch speichern.`;}catch(error){state.pendingEventImage=null;status.textContent=error.message;}});
$('#eventTitle').addEventListener('input',()=>$('#eventHeading').textContent=clean($('#eventTitle').value)||'Neue Veranstaltung');
$('#socialSearch').addEventListener('input',renderSocialList);$('#newSocial').addEventListener('click',newSocial);$('#socialForm').addEventListener('submit',saveSocial);$('#deleteSocial').addEventListener('click',deleteSocial);$('#socialLabel').addEventListener('input',()=>$('#socialHeading').textContent=clean($('#socialLabel').value)||'Neuer Link');

$('#loginForm').addEventListener('submit',async event=>{event.preventDefault();const error=$('#loginError');error.hidden=true;try{await openAdmin($('#adminPassword').value);}catch(problem){state.password='';sessionStorage.removeItem('clubiq_darts_admin');error.textContent=problem.message;error.hidden=false;}});
$('#logout').addEventListener('click',()=>{revokeEventImagePreview();state.password='';sessionStorage.removeItem('clubiq_darts_admin');location.reload();});
$('#playerSearch').addEventListener('input',renderPlayerList); $('#teamFilter').addEventListener('change',renderPlayerList);
$('#profileForm').addEventListener('submit',saveProfile); $('#deletePhoto').addEventListener('click',deletePhoto);
$('#newPlayer').addEventListener('click',()=>{$('#newPlayerError').hidden=true;$('#newPlayerDialog').showModal();$('#newPlayerName').focus();});
$('#newPlayerForm').addEventListener('submit',createPlayer);
$('[data-close-new-player]').addEventListener('click',()=>$('#newPlayerDialog').close());
$('#profilePhoto').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file||!state.selected)return;const status=$('#formStatus');status.hidden=false;status.textContent='Bild wird für schnelle Darstellung optimiert …';try{state.pendingPhoto=await compressPhoto(file);state.previewUrl=await photoDataUrl(state.pendingPhoto);setPreview(state.selected,state.previewUrl);status.textContent=`Bild vorbereitet (${Math.max(1,Math.round(state.pendingPhoto.size/1024))} KB). Zum Übernehmen noch speichern.`;}catch(error){state.pendingPhoto=null;status.textContent=error.message;}});

if (state.password) openAdmin(state.password).catch(()=>{state.password='';sessionStorage.removeItem('clubiq_darts_admin');});
