"use strict";
const DARTS_TEAMS = [
  {id:'a',name:'SV Barver Darts A',event:'1445',participant:'174110',league:'Kreisligen 04'},
  {id:'b',name:'SV Barver Darts B',event:'1445',participant:'174111',league:'Kreisligen 04'},
  {id:'c',name:'SV Barver Darts C',event:'1445',participant:'174112',league:'Kreisligen 04'},
  {id:'d',name:'SV Barver Darts D',event:'1460',participant:'174266',league:'Kreisklasse 11'},
];
const DARTS_STORAGE = 'clubiq_darts_matches_2026_27';
function dartsTheme(value, prefersDark=false) {
  return value === 'dark' || value === 'light' ? value : prefersDark ? 'dark' : 'light';
}
function pushApplicationKey(value) {
  const padded = `${value}${'='.repeat((4-value.length%4)%4)}`.replace(/-/g,'+').replace(/_/g,'/');
  const raw = atob(padded);
  return Uint8Array.from(raw, character=>character.charCodeAt(0));
}
function dartsSponsors(config, now=Date.now()) {
  const displaySeconds = Number.isFinite(config?.displaySeconds) ? Math.min(60,Math.max(6,Math.round(config.displaySeconds))) : 12;
  const sponsors = Array.isArray(config?.sponsors) ? config.sponsors.flatMap((item,index)=>{
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) return [];
    const image = typeof item.image === 'string' && /^\/pics\/sponsors\/[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|svg|webp)$/i.test(item.image) ? item.image : '';
    let href = '';
    if (typeof item.href === 'string' && item.href) {
      try { const url=new URL(item.href); if (url.protocol==='https:' && !url.username && !url.password) href=url.href; } catch (_) {}
    }
    const starts = item.startsAt ? Date.parse(item.startsAt) : -Infinity;
    const ends = item.endsAt ? Date.parse(item.endsAt) : Infinity;
    if (Number.isNaN(starts) || Number.isNaN(ends) || starts > ends || now < starts || now > ends) return [];
    const placements = Array.isArray(item.placements) ? [...new Set(item.placements.filter(value=>value==='top'||value==='inline'))] : ['top','inline'];
    if (!placements.length) return [];
    return [{id:String(item.id || index),name:item.name.trim(),image,href,placements}];
  }) : [];
  return {displaySeconds,sponsors};
}
function dartsLayout(raw) {
  const ids = DARTS_TEAMS.map(t=>t.id);
  const count = [1,2,3,4].includes(raw?.count) ? raw.count : 4;
  const selected = [...new Set(Array.isArray(raw?.selected) ? raw.selected.filter(id=>ids.includes(id)) : [])];
  for (const id of ids) if (selected.length < count && !selected.includes(id)) selected.push(id);
  const modes = {};
  for (const id of ids) modes[id] = ['team','report','live'].includes(raw?.modes?.[id]) ? raw.modes[id] : 'team';
  return {count,selected:selected.slice(0,count),modes,auto:raw?.auto === true};
}
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
  const themeKey = 'clubiq_darts_theme';
  function applyTheme(theme, remember=false) {
    const selected=dartsTheme(theme);
    document.documentElement.dataset.theme=selected;
    q('meta[name="theme-color"]').content=selected==='dark'?'#0b1412':'#163c36';
    q('#themeToggle').setAttribute('aria-checked',String(selected==='dark'));
    q('#themeToggle').setAttribute('title',selected==='dark'?'Hellen Modus einschalten':'Dunklen Modus einschalten');
    if (remember) { try { localStorage.setItem(themeKey,selected); } catch (_) {} }
  }
  let savedTheme=null;
  try { savedTheme=localStorage.getItem(themeKey); } catch (_) {}
  applyTheme(dartsTheme(savedTheme,window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  q('#themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark',true));
  function renderSponsor(slot, sponsor) {
    const content=document.createElement(sponsor.href?'a':'div'); content.className='sponsor-banner';
    if (sponsor.href) { content.href=sponsor.href; content.target='_blank'; content.rel='noopener noreferrer sponsored'; }
    const caption=document.createElement('span'); caption.className='sponsor-caption'; caption.textContent='Unterstützt von';
    const identity=document.createElement('span'); identity.className='sponsor-identity';
    if (sponsor.image) { const logo=document.createElement('img'); logo.src=sponsor.image; logo.alt=''; logo.loading='lazy'; logo.decoding='async'; identity.append(logo); }
    const name=document.createElement('strong'); name.textContent=sponsor.name; identity.append(name);
    content.append(caption,identity); slot.replaceChildren(content); slot.hidden=false;
  }
  function startSponsorRotation(config) {
    const slots=[...document.querySelectorAll('.sponsor-slot')];
    const states=slots.map((slot,offset)=>({slot,items:config.sponsors.filter(item=>item.placements.includes(slot.dataset.placement)),index:offset}));
    const show=state=>{
      if (!state.items.length) { state.slot.hidden=true; state.slot.replaceChildren(); return; }
      renderSponsor(state.slot,state.items[state.index % state.items.length]); state.index+=1;
    };
    states.forEach(show);
    if (states.some(state=>state.items.length>1)) window.setInterval(()=>states.forEach(show),config.displaySeconds*1000);
  }
  fetch('/static/darts-sponsors.json',{headers:{Accept:'application/json'},cache:'no-store'})
    .then(response=>response.ok?response.json():Promise.reject(new Error('sponsors unavailable')))
    .then(config=>startSponsorRotation(dartsSponsors(config)))
    .catch(()=>document.querySelectorAll('.sponsor-slot').forEach(slot=>{ slot.hidden=true; slot.replaceChildren(); }));
  let livePushAlertTimer=0;
  function closeLivePushAlert() {
    window.clearTimeout(livePushAlertTimer);
    const alert=q('#livePushAlert');
    alert.classList.remove('show');
    alert.hidden=true;
  }
  function showLivePushAlert(payload) {
    if (!payload || typeof payload !== 'object') return;
    const title=typeof payload.title === 'string' ? payload.title.trim().slice(0,120) : '';
    const body=typeof payload.body === 'string' ? payload.body.trim().slice(0,240) : '';
    if (!title && !body) return;
    q('#livePushTitle').textContent=title || 'ClubIQ Darts';
    q('#livePushBody').textContent=body || 'Neue Meldung aus dem Darts-Matchcenter.';
    const alert=q('#livePushAlert');
    alert.hidden=false;
    alert.classList.remove('show');
    void alert.offsetWidth;
    alert.classList.add('show');
    window.clearTimeout(livePushAlertTimer);
    livePushAlertTimer=window.setTimeout(closeLivePushAlert,15000);
  }
  q('#closeLivePushAlert').addEventListener('click',closeLivePushAlert);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',event=>{
    if (event.data?.type === 'clubiq-darts-push') showLivePushAlert(event.data.payload);
  });
  async function pushRequest(path, payload) {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-ClubIQ-Push':'1'},body:JSON.stringify(payload)});
    if (!response.ok) { let detail='Push-Aktion fehlgeschlagen.'; try { detail=(await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    return response.json();
  }
  async function initPushNotifications() {
    const button=q('#pushToggle');
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      button.textContent='Push nicht verfügbar'; button.disabled=true; return;
    }
    let registration;
    try {
      registration=await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const update=async()=>{
        const subscription=await registration.pushManager.getSubscription();
        button.dataset.active=subscription?'true':'false';
        button.setAttribute('aria-pressed',String(Boolean(subscription)));
        button.textContent=subscription?'🔔 Push aktiv':'🔔 Push aktivieren';
        button.title=subscription?'Klicken, um Push-Benachrichtigungen auf diesem Gerät auszuschalten':'180er, High Finishes, Legs und Ergebnisse erhalten';
      };
      await update();
      if (Notification.permission==='denied') { button.textContent='Push blockiert'; button.disabled=true; return; }
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try {
          const current=await registration.pushManager.getSubscription();
          if (current) {
            await pushRequest('/api/v1/darts/push/unsubscribe',{endpoint:current.endpoint});
            await current.unsubscribe();
            message('Push-Benachrichtigungen sind auf diesem Gerät ausgeschaltet.');
          } else {
            const permission=await Notification.requestPermission();
            if (permission!=='granted') throw new Error('Benachrichtigungen wurden nicht erlaubt. Du kannst sie in den Browser-Einstellungen wieder freigeben.');
            const configResponse=await fetch('/api/v1/darts/push/config',{headers:{Accept:'application/json'},cache:'no-store'});
            const config=await configResponse.json();
            if (!configResponse.ok || !config.available || !config.publicKey) throw new Error('Push-Benachrichtigungen sind auf dem Server noch nicht eingerichtet.');
            const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:pushApplicationKey(config.publicKey)});
            try { await pushRequest('/api/v1/darts/push/subscribe',{...subscription.toJSON(),teams:['A','B','C','D']}); }
            catch (error) { await subscription.unsubscribe(); throw error; }
            message('Push ist aktiv: 180er, High Finishes, gewonnene Legs sowie Einzel- und Mannschaftsergebnisse.');
          }
          await update();
        } catch (error) { message(error.message || 'Push-Benachrichtigungen konnten nicht geändert werden.'); }
        finally { button.disabled=Notification.permission==='denied'; }
      });
    } catch (_) { button.textContent='Push nicht verfügbar'; button.disabled=true; }
  }
  initPushNotifications();
  const favoriteKey = 'clubiq_darts_favorite';
  let tickerDelay = 30000, tickerData = {items:[]}, favorite = 'all';
  try { favorite = ['A','B','C','D'].includes(localStorage.getItem(favoriteKey)) ? localStorage.getItem(favoriteKey) : 'all'; } catch (_) { /* Optional preference. */ }
  function tickerTime(item) {
    if (!item.plannedAt) return '';
    try { return new Intl.DateTimeFormat('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(item.plannedAt)); }
    catch (_) { return ''; }
  }
  function barverTeam(item) {
    return `${item.home || ''} ${item.away || ''}`.match(/SV Barver Darts ([A-D])/)?.[1] || '';
  }
  function renderMatchCenter(data) {
    const center = q('#matchCenterGrid');
    if (!center) return;
    const labels = {live:'LIVE',upcoming:'NÄCHSTES',final:'ERGEBNIS'};
    const fragment = document.createDocumentFragment();
    const codes = ['A','B','C','D'].sort((a,b)=>favorite === a ? -1 : favorite === b ? 1 : 0);
    for (const code of codes) {
      const item = Array.isArray(data.items) ? data.items.find(entry=>barverTeam(entry)===code) : null;
      const card = document.createElement(item?.url ? 'a' : 'article');
      card.className=`match-center-card ${item?.kind || 'empty'}`;
      if (item?.url?.startsWith('https://portal.3k-darts.com/')) { card.href=item.url; card.target='_blank'; card.rel='noopener noreferrer'; }
      const top=document.createElement('span'); top.className='match-center-team'; top.textContent=`BARVER ${code}`;
      const status=document.createElement('b'); status.className='match-center-status'; status.textContent=item ? labels[item.kind] : 'KEIN TERMIN';
      const text=document.createElement('strong'); text.textContent=item?.text || 'Keine Begegnung im aktuellen Zeitraum';
      const when=document.createElement('span'); when.className='match-center-time'; when.textContent=item ? tickerTime(item) : '3K-Spielplan prüfen';
      card.append(top,status,text,when); fragment.append(card);
    }
    center.replaceChildren(fragment);
  }
  function renderToday(data) {
    const target = q('#todayGrid');
    if (!target) return;
    const items = Array.isArray(data.items) ? data.items.slice() : [];
    const wanted = favorite === 'all' ? items : items.filter(item=>barverTeam(item)===favorite);
    const live = wanted.filter(item=>item.kind==='live');
    const upcoming = wanted.filter(item=>item.kind==='upcoming');
    const finals = wanted.filter(item=>item.kind==='final');
    const shown = (live.length ? live : upcoming.length ? upcoming : finals).slice(0,4);
    const today = new Date().toLocaleDateString('de-DE');
    const playingToday = shown.some(item=>item.plannedAt && new Date(item.plannedAt).toLocaleDateString('de-DE')===today);
    q('#todayHeading').textContent = live.length || playingToday ? 'Heute spielen' : upcoming.length ? 'Nächste Spiele' : 'Letzte Ergebnisse';
    q('#todaySubtitle').textContent = live.length ? `${live.length} Begegnung${live.length===1?'':'en'} läuft gerade.` : upcoming.length ? 'Die nächsten Begegnungen sind vorbereitet.' : 'Letzte Ergebnisse der Barver-Teams.';
    if (!shown.length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent='Für die Auswahl ist aktuell keine Begegnung vorhanden.'; target.replaceChildren(empty); return; }
    const fragment=document.createDocumentFragment();
    for (const item of shown) {
      const card=document.createElement('a'); card.className=`today-game ${item.kind}`; card.href=item.url; card.target='_blank'; card.rel='noopener noreferrer';
      const code=barverTeam(item); const badge=document.createElement('b'); badge.textContent=item.kind==='live'?'LIVE':item.kind==='final'?'ERGEBNIS':'NÄCHSTES SPIEL';
      const team=document.createElement('span'); team.className='today-team'; team.textContent=code?`BARVER ${code}`:'SV BARVER';
      const text=document.createElement('strong'); text.textContent=item.text;
      const when=document.createElement('span'); when.className='today-time'; when.textContent=tickerTime(item);
      card.append(badge,team,text,when); fragment.append(card);
    }
    target.replaceChildren(fragment);
  }
  function renderTicker(data) {
    const track = q('#tickerTrack');
    tickerData = data;
    renderMatchCenter(data);
    renderToday(data);
    if (!Array.isArray(data.items) || !data.items.length) {
      const empty = document.createElement('span'); empty.className='ticker-loading'; empty.textContent='Derzeit keine Barver-Begegnungen im aktuellen Zeitraum.';
      track.replaceChildren(empty); return;
    }
    const group = document.createElement('div'); group.className='ticker-group';
    for (const item of data.items) {
      const link = document.createElement('a'); link.className=`ticker-item ${item.kind}`; link.target='_blank'; link.rel='noopener noreferrer';
      if (typeof item.url === 'string' && item.url.startsWith('https://portal.3k-darts.com/')) link.href=item.url;
      const teamCode = barverTeam(item);
      if (teamCode) { const team=document.createElement('b'); team.className='ticker-team'; team.textContent=`BARVER ${teamCode}`; link.append(team); }
      const text = document.createElement('span'); text.textContent=item.text; link.append(text);
      const when = tickerTime(item); if (when) { const time=document.createElement('span'); time.className='ticker-time'; time.textContent=when; link.append(time); }
      group.append(link);
    }
    const duplicate = group.cloneNode(true); duplicate.setAttribute('aria-hidden','true'); duplicate.querySelectorAll('a').forEach(link=>link.tabIndex=-1);
    track.replaceChildren(group,duplicate);
    const updated = new Date(data.updatedAt);
    q('#tickerUpdated').textContent = `${data.stale ? 'Letzter Stand' : 'Stand'} ${updated.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  }
  async function loadTicker() {
    if (document.hidden) { setTimeout(loadTicker,tickerDelay); return; }
    const controller = new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const response = await fetch('/api/v1/darts/ticker',{headers:{Accept:'application/json'},signal:controller.signal});
      if (!response.ok) throw new Error('ticker unavailable');
      renderTicker(await response.json()); tickerDelay=30000;
    } catch (_) {
      q('#tickerUpdated').textContent='3K nicht erreichbar'; tickerDelay=Math.min(120000,tickerDelay*2);
    } finally { clearTimeout(timeout); setTimeout(loadTicker,tickerDelay); }
  }
  loadTicker();
  const activityUrl = 'https://portal.3k-darts.com/frontend/events/5/mandant/1931';
  let activityLoaded = false;
  const layoutKey = 'clubiq_darts_layout';
  let layout = dartsLayout(null), focused = null;
  try { layout = dartsLayout(JSON.parse(localStorage.getItem(layoutKey))); } catch (_) { /* Use defaults. */ }
  function saveLayout() {
    for (const [id,c] of cards) layout.modes[id] = c.select.value;
    try { localStorage.setItem(layoutKey,JSON.stringify(layout)); }
    catch (_) { message('Diese Auswahl gilt nur für die aktuelle Sitzung.'); }
  }
  function applyLayout() {
    const ids = focused ? [focused] : layout.selected;
    grid.dataset.count = String(ids.length);
    grid.classList.toggle('focused',ids.length === 1);
    q('#gameCount').value = String(layout.count);
    q('#autoLoad').checked = layout.auto;
    for (const [id,c] of cards) {
      c.card.hidden = !ids.includes(id);
      c.focus.textContent = focused === id ? 'Zurück' : 'Groß';
      c.focus.setAttribute('aria-pressed',String(focused === id));
      c.focus.setAttribute('aria-label',focused === id ? 'Zurück zur Auswahl' : `${DARTS_TEAMS.find(t=>t.id===id).name} vergrößern`);
    }
    for (const button of q('#teamChoices').querySelectorAll('button')) button.setAttribute('aria-pressed',String(layout.selected.includes(button.dataset.team)));
  }
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
  const centerControllers = new Map();
  function formatDate(value, options={weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}) {
    try { return new Intl.DateTimeFormat('de-DE',options).format(new Date(value)); } catch (_) { return ''; }
  }
  function renderLeague(data) {
    const block=q(`.league-block[data-league="${data.league.key}"]`);
    if (!block) return;
    const inside=selector=>block.querySelector(selector);
    const round = data.selectedRound || {};
    inside('[data-role="round-heading"]').textContent = `${round.name || 'Spieltag'} · ${data.league.short}`;
    inside('[data-role="round-date"]').textContent = formatDate(round.dateFrom);
    const roundSelect=inside('[data-role="round"]');
    const current=String(round.id || '');
    roundSelect.replaceChildren(...(data.rounds || []).map(item=>{
      const option=document.createElement('option'); option.value=String(item.id); option.textContent=`${item.name} · ${formatDate(item.dateFrom,{day:'2-digit',month:'2-digit'})}`; return option;
    }));
    roundSelect.value=current;
    const games=document.createDocumentFragment();
    for (const item of data.matches || []) {
      const link=document.createElement('a'); link.className=`round-match ${item.kind}`; link.href=item.url; link.target='_blank'; link.rel='noopener noreferrer';
      const home=document.createElement('span'); home.textContent=item.home;
      const score=document.createElement('b'); score.textContent=item.score || '–';
      const away=document.createElement('span'); away.textContent=item.away;
      const state=document.createElement('small'); state.textContent=item.kind==='final'?'Endstand':item.kind==='live'?'Live':tickerTime(item);
      link.append(home,score,away,state); games.append(link);
    }
    inside('[data-role="matches"]').replaceChildren(games.childNodes.length ? games : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Keine Begegnungen an diesem Spieltag.'}));
    const table=document.createDocumentFragment();
    for (const entry of data.standings || []) {
      const row=document.createElement('li'); if (entry.barver) row.className='barver';
      const rank=document.createElement('b'); rank.textContent=entry.rank || '–';
      const name=document.createElement('span'); name.textContent=entry.name;
      row.append(rank,name); table.append(row);
    }
    inside('[data-role="standings"]').replaceChildren(table.childNodes.length ? table : Object.assign(document.createElement('li'),{className:'panel-loading',textContent:'Noch keine Rangfolge verfügbar.'}));
    const eventList=document.createDocumentFragment();
    for (const item of data.events || []) {
      const event=document.createElement('div'); event.className=`darts-event ${item.type}`;
      const icons={180:'180',high_finish:'HF',match:'🏁',game:'✓'};
      const icon=document.createElement('b'); icon.textContent=icons[item.type] || '→';
      const copy=document.createElement('div'); const title=document.createElement('strong'); title.textContent=item.title; const text=document.createElement('span'); text.textContent=item.text;
      copy.append(title,text); event.append(icon,copy); eventList.append(event);
    }
    inside('[data-role="events"]').replaceChildren(eventList.childNodes.length ? eventList : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Für diesen Spieltag sind noch keine Highlights erfasst.'}));
  }
  async function loadLeague(leagueKey,roundId=null) {
    centerControllers.get(leagueKey)?.abort();
    const controller=new AbortController(); centerControllers.set(leagueKey,controller);
    const block=q(`.league-block[data-league="${leagueKey}"]`); if (!block) return;
    const round=/^\d+$/.test(String(roundId || '')) ? `&round_id=${encodeURIComponent(roundId)}` : '';
    block.querySelector('[data-role="matches"]').innerHTML='<p class="panel-loading">Spiele werden geladen …</p>';
    try {
      const response=await fetch(`/api/v1/darts/center?league=${encodeURIComponent(leagueKey)}${round}`,{headers:{Accept:'application/json'},signal:controller.signal});
      if (!response.ok) throw new Error('league unavailable');
      renderLeague(await response.json());
    } catch (error) {
      if (error.name!=='AbortError') message('Der 3K-Spieltag konnte gerade nicht geladen werden. Bitte noch einmal aktualisieren.');
    }
  }
  function setSection(section) {
    const teams = section === 'teams';
    grid.hidden = !teams; q('.intro').hidden = !teams;
    q('#layoutControls').hidden = !teams;
    q('#activityPanel').hidden = section !== 'activity';
    q('#trainingPanel').hidden = section !== 'training';
    q('#todayPanel').hidden = section !== 'today';
    q('#leaguePanel').hidden = section !== 'league';
    q('#todayView').setAttribute('aria-pressed',String(section === 'today'));
    q('#leagueView').setAttribute('aria-pressed',String(section === 'league'));
    q('#gridView').setAttribute('aria-pressed',String(section === 'teams'));
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
  q('#todayView').addEventListener('click',()=>setSection('today'));
  q('#leagueView').addEventListener('click',()=>{ setSection('league'); for (const block of q('#leagueOverview').querySelectorAll('.league-block')) loadLeague(block.dataset.league,block.querySelector('[data-role="round"]').value); });
  q('#favoriteTeam').value=favorite;
  q('#favoriteTeam').addEventListener('change',()=>{ favorite=q('#favoriteTeam').value; try { localStorage.setItem(favoriteKey,favorite); } catch (_) {} renderTicker(tickerData); });
  for (const block of q('#leagueOverview').querySelectorAll('.league-block')) {
    const select=block.querySelector('[data-role="round"]');
    select.addEventListener('change',()=>loadLeague(block.dataset.league,select.value));
    block.querySelector('[data-role="reload"]').addEventListener('click',()=>loadLeague(block.dataset.league,select.value));
  }
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
    focused = id; applyLayout();
  }
  for (const team of DARTS_TEAMS) {
    const card = document.createElement('article'); card.className='team-card'; card.id=`team-${team.id}`;
    // Only fixed app-owned team labels are interpolated. Links are assigned via DOM properties.
    card.innerHTML = `<div class="team-head"><span class="team-letter">${team.id.toUpperCase()}</span><span class="club-logo team-club-logo" aria-hidden="true"></span><div><h2>${team.name}</h2><p class="match-note"></p></div><button class="focus-team" type="button" aria-label="${team.name} vergrößern" aria-pressed="false">Groß</button></div>
      <div class="team-tools"><select aria-label="Ansicht für ${team.name}"><option value="team">Spielplan & Ergebnisse</option><option value="report" disabled>Gewählter Spielbericht</option><option value="live" disabled>Gewähltes Spiel live</option></select><button class="configure" type="button">Spiel wählen</button><button class="reload" type="button" aria-label="${team.name} neu laden">Neu laden</button><a class="external" target="_blank" rel="noopener noreferrer">Bei 3K öffnen ↗</a></div>
      <div class="frame-wrap"><div class="placeholder"><strong>${team.league}</strong><p>Spielplan und Ergebnisse dieser Mannschaft von 3K Darts laden.</p><button class="load-team primary" type="button">${team.id.toUpperCase()} anzeigen</button></div></div><p class="frame-note">Noch keine Verbindung zu 3K. Die Musik wird durch diese Ansicht nicht gesteuert.</p>`;
    grid.append(card);
    const c = {card,wrap:card.querySelector('.frame-wrap'),select:card.querySelector('select'),open:card.querySelector('.external'),note:card.querySelector('.frame-note'),matchNote:card.querySelector('.match-note'),focus:card.querySelector('.focus-team'),loaded:false};
    cards.set(team.id,c); c.select.value = layout.modes[team.id]; sync(team);
    c.focus.addEventListener('click',()=>focusTeam(focused === team.id ? null : team.id));
    c.select.addEventListener('change',()=>{ load(team); saveLayout(); });
    card.querySelector('.load-team').addEventListener('click',()=>load(team));
    card.querySelector('.reload').addEventListener('click',()=>load(team));
    card.querySelector('.configure').addEventListener('click',()=>{
      editing=team; q('#matchHeading').textContent=`Begegnung für Barver ${team.id.toUpperCase()}`;
      q('#matchUrl').value=selections[team.id]?.report || selections[team.id]?.live || '';
      q('#matchError').hidden=true; q('#clearMatch').disabled=!selections[team.id]; q('#matchDialog').showModal();
    });
    const choice = document.createElement('button');
    choice.type = 'button'; choice.dataset.team = team.id; choice.setAttribute('aria-label',`Barver ${team.id.toUpperCase()} auswählen`);
    const choiceLetter=document.createElement('b'); choiceLetter.textContent=team.id.toUpperCase();
    const choiceName=document.createElement('span'); choiceName.textContent='Barver';
    choice.append(choiceLetter,choiceName);
    choice.addEventListener('click',()=>{
      if (layout.selected.includes(team.id)) {
        if (layout.count === 1) return;
        layout.selected = layout.selected.filter(id=>id!==team.id); layout.count = layout.selected.length;
      } else { layout.selected = [...layout.selected.slice(1),team.id]; }
      focused = null; applyLayout(); saveLayout();
      if (layout.auto && layout.selected.includes(team.id) && !c.loaded) load(team);
    });
    q('#teamChoices').append(choice);
  }
  applyLayout();
  setSection('today');
  q('#gameCount').addEventListener('change',()=>{
    layout = dartsLayout({...layout,count:Number(q('#gameCount').value)});
    focused = null; applyLayout(); saveLayout();
    if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id) && !cards.get(t.id).loaded).forEach(load);
  });
  q('#autoLoad').addEventListener('change',()=>{ layout.auto=q('#autoLoad').checked; saveLayout(); if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load); });
  if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load);
  q('#loadAll').addEventListener('click',()=>{ focusTeam(null); DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load); });
  q('#gridView').addEventListener('click',()=>focusTeam(null));
  q('#closeMatch').addEventListener('click',()=>q('#matchDialog').close());
  q('#matchForm').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      selections[editing.id]=dartsMatch(q('#matchUrl').value,editing); save(); sync(editing);
      cards.get(editing.id).select.value=selections[editing.id].report ? 'report' : 'live';
      load(editing); saveLayout(); q('#matchDialog').close();
    } catch (error) { q('#matchError').textContent=error.message; q('#matchError').hidden=false; }
  });
  q('#clearMatch').addEventListener('click',()=>{
    delete selections[editing.id]; save(); sync(editing);
    saveLayout();
    if (cards.get(editing.id).loaded) load(editing);
    q('#matchDialog').close();
  });
  q('#fullscreen').addEventListener('click',async()=>{
    try { if (document.fullscreenElement) await document.exitFullscreen(); else { setSection('today'); if (document.body.requestFullscreen) await document.body.requestFullscreen(); else message('TV-Modus wird hier nicht unterstützt. Du kannst die Heute-Ansicht normal verwenden.'); } }
    catch (_) { message('Vollbild nicht verfügbar. Bitte die Browser-Vollbildfunktion oder „Groß“ verwenden.'); }
  });
  document.addEventListener('fullscreenchange',()=>{ q('#fullscreen').textContent=document.fullscreenElement ? 'TV-Modus beenden' : 'TV-Modus'; });
}
