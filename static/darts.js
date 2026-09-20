"use strict";
const DARTS_TEAMS = [
  {id:'a',name:'SV Barver Darts A',event:'1445',participant:'174110',league:'Kreisligen 04'},
  {id:'b',name:'SV Barver Darts B',event:'1445',participant:'174111',league:'Kreisligen 04'},
  {id:'c',name:'SV Barver Darts C',event:'1445',participant:'174112',league:'Kreisligen 04'},
  {id:'d',name:'SV Barver Darts D',event:'1460',participant:'174266',league:'Kreisklasse 11'},
];
const DARTS_STORAGE = 'clubiq_darts_matches_2026_27';
function dartsMatch(raw, team) {
  const error = () => { throw new Error('Bitte einen vollständigen 3K-Spielbericht-Link mit matchId oder einen 3K-Live-Link einfügen.'); };
  if (typeof raw !== 'string' || raw.length > 600) return error();
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return error(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return error();
  if (url.hostname === 'portal.3k-darts.com') {
    const parts = url.pathname.match(/^\/frontend\/events\/10\/event\/(\d{1,10})\/phase\/(\d{1,10})\/group\/(\d{1,10})\/?$/);
    const match = url.searchParams.get('matchId');
    if (!parts || !/^\d{1,10}$/.test(match || '') || [...url.searchParams.keys()].some(key=>key!=='matchId') || url.searchParams.getAll('matchId').length!==1) return error();
    if (parts[1] !== team.event) throw new Error('Der Link gehört nicht zur Liga dieser Mannschaft. Bitte die passende Begegnung wählen.');
    return {report:`https://portal.3k-darts.com${url.pathname}?matchId=${match}`,live:`https://live.3k-darts.com/event/10/${match}`,match};
  }
  if (url.hostname === 'live.3k-darts.com' && !url.search) {
    const parts = url.pathname.match(/^\/event\/10\/(\d{1,10})\/?$/);
    if (parts) return {report:null,live:`https://live.3k-darts.com/event/10/${parts[1]}`,match:parts[1]};
  }
  return error();
}

function dartsTraining(raw) {
  const invalid = () => { throw new Error('Bitte einen 3K-Trainingslink mit Teilnehmern, Bestleistungen, Platzierung oder Gruppe einfügen.'); };
  if (typeof raw !== 'string' || raw.length > 600) return invalid();
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'portal.3k-darts.com' || url.username || url.password || url.port || url.search || url.hash) return invalid();
  const parts = url.pathname.match(/^\/frontend\/events\/5\/event\/(\d{1,10})\/(participants|performances|placement|phase\/(\d{1,10})\/group\/(\d{1,10}))\/?$/);
  if (!parts) return invalid();
  const base = `https://portal.3k-darts.com/frontend/events/5/event/${parts[1]}`;
  return {event:parts[1], source:url.href, participants:`${base}/participants`, performances:`${base}/performances`, placement:`${base}/placement`, games:parts[3] ? `${base}/phase/${parts[3]}/group/${parts[4]}` : null};
}

if (typeof document !== 'undefined') initDarts();

function initDarts() {
  const q = selector => document.querySelector(selector);
  const grid = q('#teamGrid'), cards = new Map(), selections = {};
  const activityUrl = 'https://portal.3k-darts.com/frontend/events/5/mandant/1931';
  let activityLoaded = false;
  const trainingKey = 'clubiq_darts_training';
  const exampleTraining = 'https://portal.3k-darts.com/frontend/events/5/event/31849/phase/53660/group/403948';
  let training = dartsTraining(exampleTraining);
  try { const saved = localStorage.getItem(trainingKey); if (saved) training = dartsTraining(saved); } catch (_) { /* Keep the verified example; no external request. */ }
  function syncTraining() {
    q('#trainingUrl').value = training.source;
    q('#trainingLabel').textContent = training.event === '31849' ? 'Beispiel: Training Doppel 10.09.' : `Training · 3K-Event ${training.event}`;
    q('#trainingMode').querySelector('[value="games"]').disabled = !training.games;
    if (!training[q('#trainingMode').value]) q('#trainingMode').value = 'participants';
    q('#trainingExternal').href = training[q('#trainingMode').value];
  }
  function loadTraining() {
    syncTraining();
    const iframe = document.createElement('iframe');
    iframe.title = `Vereinstraining – ${q('#trainingMode').selectedOptions[0].textContent}`;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = training[q('#trainingMode').value];
    q('#trainingFrame').replaceChildren(iframe);
    q('#trainingNote').textContent = '3K-Ansicht angefordert. Bleibt sie leer, nutze „Bei 3K öffnen“. Keine eigene Live-Erkennung von 180 oder Leg-Siegern; die Aktualisierung übernimmt 3K.';
  }
  function setSection(section) {
    const teams = section === 'teams';
    grid.hidden = !teams; q('.intro').hidden = !teams;
    q('#activityPanel').hidden = section !== 'activity';
    q('#trainingPanel').hidden = section !== 'training';
    q('#activityView').setAttribute('aria-pressed',String(section === 'activity'));
    q('#trainingView').setAttribute('aria-pressed',String(section === 'training'));
  }
  function loadActivity() {
    const iframe = document.createElement('iframe');
    iframe.title = 'Aktuelle Veranstaltungen von SV Barver bei 3K Darts';
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = activityUrl;
    q('#activityFrame').replaceChildren(iframe);
    q('#activityNote').textContent = 'Aktuelle 3K-Veranstalterübersicht angefordert. Neue Einträge erscheinen nach „Aktualisieren“. Bleibt die Ansicht leer, nutze „Bei 3K öffnen“.';
    activityLoaded = true;
  }
  syncTraining();
  q('#activityView').addEventListener('click',()=>{ setSection('activity'); if (!activityLoaded) loadActivity(); });
  q('#reloadActivity').addEventListener('click',loadActivity);
  q('#trainingView').addEventListener('click',()=>setSection('training'));
  q('#loadTraining').addEventListener('click',loadTraining);
  q('#trainingMode').addEventListener('change',loadTraining);
  q('#trainingForm').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      training = dartsTraining(q('#trainingUrl').value);
      q('#trainingError').hidden = true;
      try { localStorage.setItem(trainingKey,training.source); message('Training auf diesem Gerät gespeichert.'); }
      catch (_) { message('Training nur für diese Sitzung übernommen; dauerhaftes Speichern ist nicht möglich.'); }
      loadTraining();
    } catch (error) { q('#trainingError').textContent=error.message; q('#trainingError').hidden=false; }
  });
  let editing = null;
  function message(text) { q('#pageStatus').textContent = text; q('#pageStatus').hidden = !text; }
  try {
    const stored = JSON.parse(localStorage.getItem(DARTS_STORAGE) || '{}');
    for (const team of DARTS_TEAMS) {
      if (stored?.[team.id]) {
        try { selections[team.id] = dartsMatch(stored[team.id],team); } catch (_) { /* Ignore old or invalid saved links. */ }
      }
    }
  } catch (_) { message('Gespeicherte Begegnungen konnten nicht gelesen werden. Du kannst die Ansichten trotzdem verwenden.'); }
  function save() {
    const data = Object.fromEntries(Object.entries(selections).map(([id,value])=>[id,value.report || value.live]));
    try { localStorage.setItem(DARTS_STORAGE,JSON.stringify(data)); message('Begegnung auf diesem Gerät gespeichert.'); }
    catch (_) { message('Die Auswahl gilt für diese Sitzung. Dein Browser erlaubt gerade kein dauerhaftes Speichern.'); }
  }
  function urlFor(team, mode) {
    const match = selections[team.id];
    if (mode === 'live') return match?.live;
    if (mode === 'report') return match?.report;
    return `https://portal.3k-darts.com/frontend/events/10/event/${team.event}/participants/${team.participant}`;
  }
  function sync(team) {
    const c = cards.get(team.id), selected = selections[team.id];
    c.select.querySelector('[value="report"]').disabled = !selected?.report;
    c.select.querySelector('[value="live"]').disabled = !selected?.live;
    if (!urlFor(team,c.select.value)) c.select.value = 'team';
    c.open.href = urlFor(team,c.select.value);
    c.matchNote.textContent = selected ? `Begegnung #${selected.match} gespeichert · Zuordnung manuell` : team.league;
  }
  function load(team) {
    const c = cards.get(team.id), url = urlFor(team,c.select.value);
    if (!url) return;
    sync(team);
    const iframe = document.createElement('iframe');
    iframe.title = `${team.name} – ${c.select.selectedOptions[0].textContent}`;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = url;
    // A cross-origin load event cannot confirm an actual live score or success.
    c.wrap.replaceChildren(iframe);
    c.loaded = true;
    c.note.textContent = '3K-Ansicht angefordert. Leer oder keine Übertragung? „Bei 3K öffnen“ verwenden. Aktualisierung und Inhalte steuert 3K.';
  }
  function focusTeam(id) {
    setSection('teams');
    grid.classList.toggle('focused',Boolean(id));
    for (const [key,c] of cards) {
      c.card.hidden = Boolean(id) && key!==id;
      c.focus.textContent = key===id ? 'Raster' : 'Groß';
      c.focus.setAttribute('aria-pressed',String(key===id));
      c.focus.setAttribute('aria-label',key===id ? 'Zurück zum Vierer-Raster' : `SV Barver Darts ${key.toUpperCase()} vergrößern`);
    }
    q('#gridView').textContent = id ? 'Zurück zu allen vier' : 'Alle Mannschaften';
  }
  for (const team of DARTS_TEAMS) {
    const card = document.createElement('article'); card.className='team-card'; card.id=`team-${team.id}`;
    // Only fixed app-owned team labels are interpolated. Links are assigned via DOM properties.
    card.innerHTML = `<div class="team-head"><span class="team-letter">${team.id.toUpperCase()}</span><div><h2>${team.name}</h2><p class="match-note"></p></div><button class="focus-team" type="button" aria-label="${team.name} vergrößern" aria-pressed="false">Groß</button></div>
      <div class="team-tools"><select aria-label="Ansicht für ${team.name}"><option value="team">Spielplan & Ergebnisse</option><option value="report" disabled>Gewählter Spielbericht</option><option value="live" disabled>Gewähltes Spiel live</option></select><button class="configure" type="button">Spiel wählen</button><button class="reload" type="button" aria-label="${team.name} neu laden">Neu laden</button><a class="external" target="_blank" rel="noopener noreferrer">Bei 3K öffnen ↗</a></div>
      <div class="frame-wrap"><div class="placeholder"><strong>${team.league}</strong><p>Spielplan und Ergebnisse dieser Mannschaft von 3K Darts laden.</p><button class="load-team primary" type="button">${team.id.toUpperCase()} anzeigen</button></div></div><p class="frame-note">Noch keine Verbindung zu 3K. Die Musik wird durch diese Ansicht nicht gesteuert.</p>`;
    grid.append(card);
    const c = {card,wrap:card.querySelector('.frame-wrap'),select:card.querySelector('select'),open:card.querySelector('.external'),note:card.querySelector('.frame-note'),matchNote:card.querySelector('.match-note'),focus:card.querySelector('.focus-team'),loaded:false};
    cards.set(team.id,c); sync(team);
    c.focus.addEventListener('click',()=>focusTeam(grid.classList.contains('focused') && !card.hidden ? null : team.id));
    c.select.addEventListener('change',()=>load(team));
    card.querySelector('.load-team').addEventListener('click',()=>load(team));
    card.querySelector('.reload').addEventListener('click',()=>load(team));
    card.querySelector('.configure').addEventListener('click',()=>{
      editing=team; q('#matchHeading').textContent=`Begegnung für Barver ${team.id.toUpperCase()}`;
      q('#matchUrl').value=selections[team.id]?.report || selections[team.id]?.live || '';
      q('#matchError').hidden=true; q('#clearMatch').disabled=!selections[team.id]; q('#matchDialog').showModal();
    });
  }
  q('#loadAll').addEventListener('click',()=>{ focusTeam(null); DARTS_TEAMS.forEach(load); });
  q('#gridView').addEventListener('click',()=>focusTeam(null));
  q('#closeMatch').addEventListener('click',()=>q('#matchDialog').close());
  q('#matchForm').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      selections[editing.id]=dartsMatch(q('#matchUrl').value,editing); save(); sync(editing);
      cards.get(editing.id).select.value=selections[editing.id].report ? 'report' : 'live';
      load(editing); q('#matchDialog').close();
    } catch (error) { q('#matchError').textContent=error.message; q('#matchError').hidden=false; }
  });
  q('#clearMatch').addEventListener('click',()=>{
    delete selections[editing.id]; save(); sync(editing);
    if (cards.get(editing.id).loaded) load(editing);
    q('#matchDialog').close();
  });
  q('#fullscreen').addEventListener('click',async()=>{
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.body.requestFullscreen) await document.body.requestFullscreen(); else message('Vollbild wird hier nicht unterstützt. Du kannst eine Mannschaft mit „Groß“ anzeigen.'); }
    catch (_) { message('Vollbild nicht verfügbar. Bitte die Browser-Vollbildfunktion oder „Groß“ verwenden.'); }
  });
  document.addEventListener('fullscreenchange',()=>{ q('#fullscreen').textContent=document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild'; });
}
