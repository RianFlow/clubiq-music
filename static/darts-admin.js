const $ = selector => document.querySelector(selector);
const state = { password: sessionStorage.getItem('clubiq_darts_admin') || '', players: [], selected: null, pendingPhoto: null, previewUrl: '' };

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

async function loadData() {
  $('#dataStatus').textContent = 'Profile und 3K-Kader werden geladen …';
  const selectedId=state.selected?.playerId;
  const [profilesResult, seasonResult] = await Promise.allSettled([
    api('/api/v1/darts/admin/players'),
    fetch('/api/v1/darts/season',{headers:{Accept:'application/json'},cache:'no-store'}).then(response=>response.ok?response.json():null),
  ]);
  if (profilesResult.status !== 'fulfilled') throw profilesResult.reason;
  state.players = mergePlayers(profilesResult.value.players, seasonResult.status === 'fulfilled' ? seasonResult.value : null);
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

async function deletePhoto() {
  if (!state.selected || !state.selected.hasUploadedImage) return;
  if (!confirm('Das hochgeladene Bild wirklich entfernen? Ein eventuell vorhandenes bisheriges Vereinsbild wird danach wieder verwendet.')) return;
  const status=$('#formStatus'); status.hidden=false; status.textContent='Bild wird entfernt …';
  try { await api(`/api/v1/darts/admin/players/${state.selected.playerId}/photo`,{method:'DELETE'}); await loadData(); const updated=state.players.find(item=>item.playerId===state.selected.playerId); if(updated) selectPlayer(updated); status.hidden=false; status.textContent='Eigenes Bild entfernt.'; }
  catch(error){status.textContent=error.message;}
}

async function openAdmin(password) {
  state.password=password;
  await api('/api/v1/music/admin/verify');
  sessionStorage.setItem('clubiq_darts_admin',password);
  $('#loginPanel').hidden=true; $('#adminPanel').hidden=false; $('#logout').hidden=false;
  await loadData();
}

$('#loginForm').addEventListener('submit',async event=>{event.preventDefault();const error=$('#loginError');error.hidden=true;try{await openAdmin($('#adminPassword').value);}catch(problem){state.password='';sessionStorage.removeItem('clubiq_darts_admin');error.textContent=problem.message;error.hidden=false;}});
$('#logout').addEventListener('click',()=>{state.password='';sessionStorage.removeItem('clubiq_darts_admin');location.reload();});
$('#playerSearch').addEventListener('input',renderPlayerList); $('#teamFilter').addEventListener('change',renderPlayerList);
$('#profileForm').addEventListener('submit',saveProfile); $('#deletePhoto').addEventListener('click',deletePhoto);
$('#profilePhoto').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file||!state.selected)return;const status=$('#formStatus');status.hidden=false;status.textContent='Bild wird für schnelle Darstellung optimiert …';try{state.pendingPhoto=await compressPhoto(file);state.previewUrl=await photoDataUrl(state.pendingPhoto);setPreview(state.selected,state.previewUrl);status.textContent=`Bild vorbereitet (${Math.max(1,Math.round(state.pendingPhoto.size/1024))} KB). Zum Übernehmen noch speichern.`;}catch(error){state.pendingPhoto=null;status.textContent=error.message;}});

if (state.password) openAdmin(state.password).catch(()=>{state.password='';sessionStorage.removeItem('clubiq_darts_admin');});
