const $ = selector => document.querySelector(selector);
const state = { password: sessionStorage.getItem('clubiq_darts_admin') || '', players: [], selected: null, pendingPhoto: null, previewUrl: '', sponsors: [], selectedSponsor: null, pendingSponsorLogo: null };

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
  const sponsors=view==='sponsors';
  $('#playersAdminView').hidden=sponsors; $('#sponsorsAdminView').hidden=!sponsors;
  $('#playersAdminTab').classList.toggle('active',!sponsors); $('#sponsorsAdminTab').classList.toggle('active',sponsors);
}

async function openAdmin(password) {
  state.password=password;
  await api('/api/v1/music/admin/verify');
  sessionStorage.setItem('clubiq_darts_admin',password);
  $('#loginPanel').hidden=true; $('#adminPanel').hidden=false; $('#logout').hidden=false;
  await Promise.all([loadData(),loadSponsors()]);
}

$('#playersAdminTab').addEventListener('click',()=>showAdminView('players'));
$('#sponsorsAdminTab').addEventListener('click',()=>showAdminView('sponsors'));
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

$('#loginForm').addEventListener('submit',async event=>{event.preventDefault();const error=$('#loginError');error.hidden=true;try{await openAdmin($('#adminPassword').value);}catch(problem){state.password='';sessionStorage.removeItem('clubiq_darts_admin');error.textContent=problem.message;error.hidden=false;}});
$('#logout').addEventListener('click',()=>{state.password='';sessionStorage.removeItem('clubiq_darts_admin');location.reload();});
$('#playerSearch').addEventListener('input',renderPlayerList); $('#teamFilter').addEventListener('change',renderPlayerList);
$('#profileForm').addEventListener('submit',saveProfile); $('#deletePhoto').addEventListener('click',deletePhoto);
$('#newPlayer').addEventListener('click',()=>{$('#newPlayerError').hidden=true;$('#newPlayerDialog').showModal();$('#newPlayerName').focus();});
$('#newPlayerForm').addEventListener('submit',createPlayer);
$('[data-close-new-player]').addEventListener('click',()=>$('#newPlayerDialog').close());
$('#profilePhoto').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file||!state.selected)return;const status=$('#formStatus');status.hidden=false;status.textContent='Bild wird für schnelle Darstellung optimiert …';try{state.pendingPhoto=await compressPhoto(file);state.previewUrl=await photoDataUrl(state.pendingPhoto);setPreview(state.selected,state.previewUrl);status.textContent=`Bild vorbereitet (${Math.max(1,Math.round(state.pendingPhoto.size/1024))} KB). Zum Übernehmen noch speichern.`;}catch(error){state.pendingPhoto=null;status.textContent=error.message;}});

if (state.password) openAdmin(state.password).catch(()=>{state.password='';sessionStorage.removeItem('clubiq_darts_admin');});
