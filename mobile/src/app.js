import {Capacitor,CapacitorHttp,registerPlugin} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {Preferences} from '@capacitor/preferences';
import {PushNotifications} from '@capacitor/push-notifications';
import {API_ORIGIN,TYPES,apiUrl,publicLink,cleanPreferences,matchesFor,sections,roleRank,notificationTarget,trainingNotificationTarget,liveBoardView,matchLocation,matchSide,routeUrl,calendarEvent,calendarFile} from './model.js';
import {createTraining} from './training.js';
import {createNativePush} from './native-push.js';
import {createPushTransport,deviceSecret} from './push-transport.js';
import {createWebPush} from './web-push.js';
import {prepareWebApp,webPushRequest,isStandalone,isAppleMobile} from './web-app.js';
const q=s=>document.querySelector(s),native=Capacitor.isNativePlatform();
const webApp=__WEB_APP__;let webRegistration=null,installPrompt=null,applyWebUpdate=null;
let state={season:{matches:[],teams:[]},live:{groups:[]},highlights:{items:[]},profiles:{players:{}}},cacheTimes={},failures={},preferences=cleanPreferences(),view='home',team='',busy=false,foreground=true;
const training=createTraining({node,button,get,read,store,render:()=>{if(view==='training')render();},onSettings:()=>{navigate('settings');settingsPage='selection';render();}});
training.setPreferenceLabel(()=>preferences.training?'Trainingsmeldungen: ausgewählt':'Trainingsmeldungen einstellen');
let detailSequence=0,toastTimer,selectedMatch=null;
let appearance='system',settingsPage='',onboardingDone=false,detailTeam='',teamScroll=0,detailBack=null;
const Calendar=registerPlugin('BarverCalendar'),scrollPositions={},openPanels=new Set();
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
function applyAppearance(){
  const dark=appearance==='dark'||(appearance==='system'&&systemTheme.matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  q('meta[name="theme-color"]').content=dark?'#071813':'#f6f5f1';
  q('#themeToggle').setAttribute('aria-pressed',String(dark));
  q('#themeToggle').setAttribute('aria-label',dark?'Helle Darstellung aktivieren':'Dunkle Darstellung aktivieren');
}
systemTheme.addEventListener('change',applyAppearance);
let push=null,pushTransport=null,pushIdentity=null,pushState='off',pushReady=false,pushBusy=false,pushHistory=[],pushCheckBusy=false;
const firebaseBundled=__ANDROID_FIREBASE_CONFIGURED__;
async function savePushIdentity(value){await Preferences.set({key:webApp?'barver-app-push-device-web':'barver-app-push-device',value:JSON.stringify(value)});}
function pushStatus(value){pushState=value;if(value==='active'){pushIdentity.enabled=true;savePushIdentity(pushIdentity).catch(()=>toast('Push-Einstellung konnte nicht gespeichert werden.'));}if(view==='settings')render();}
async function pushRequest(method,url,data){
  if(!native||Capacitor.getPlatform()!=='android')throw new Error('Nur in der Android-App verfügbar.');
  const result=await CapacitorHttp.request({method,url,headers:{Accept:'application/json','Content-Type':'application/json','X-ClubIQ-Push':'1'},data,connectTimeout:10000,readTimeout:15000});
  if(result.status<200||result.status>=300)throw new Error(result.status===429?'Bitte kurz warten und erneut versuchen.':'Push-Server gerade nicht erreichbar oder noch nicht eingerichtet.');
  return typeof result.data==='string'?JSON.parse(result.data):result.data;
}
async function checkPush(){
  if(!pushTransport||pushCheckBusy||pushBusy)return;pushCheckBusy=true;
  try{pushReady=await pushTransport.config();if(pushReady&&pushIdentity.token&&!pushIdentity.enabled)await push.disable();
    else if(pushReady&&pushIdentity.enabled){if(webApp){await push.restore(true);}else{const permission=await PushNotifications.checkPermissions();if(permission.receive==='granted'){if(pushState==='active')await push.sync();else await push.enable();}else pushStatus('denied');}}
  }catch(_){pushReady=false;if(pushIdentity.enabled)pushStatus('registration_failed');}
  finally{pushCheckBusy=false;if(view==='settings')render();}
}
async function togglePush(){
  if(pushBusy||!push)return;pushBusy=true;
  const disabling=!!pushIdentity.enabled;
  try{if(webApp){if(disabling){await push.disable();pushIdentity.enabled=false;await savePushIdentity(pushIdentity);}else await push.enable();}else if(disabling){pushIdentity.enabled=false;await savePushIdentity(pushIdentity);await push.disable();}else{pushIdentity.enabled=true;await savePushIdentity(pushIdentity);await push.enable();}}
  catch(error){if(webApp&&!disabling){pushIdentity.enabled=push.enabled;await savePushIdentity(pushIdentity);}pushStatus(disabling?'disable_failed':globalThis.Notification?.permission==='denied'?'denied':'registration_failed');toast(error.message||'Push-Aktion fehlgeschlagen. Bitte erneut versuchen.');}
  finally{pushBusy=false;if(view==='settings')render();}
}
async function saveSelection(){await store('preferences',preferences);if(push&&pushIdentity.enabled)await push.sync();}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
function button(text,action,cls='card'){const n=node('button',text,cls);n.type='button';n.addEventListener('click',action);return n;}
function date(value){const d=new Date(value);return Number.isNaN(d.valueOf())?'Termin noch offen':d.toLocaleString('de-DE',{timeZone:'Europe/Berlin',weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
async function store(key,value){try{await Preferences.set({key:'barver-app-'+key,value:JSON.stringify(value)});}catch(_){if(key==='preferences')toast('Dein Gerät erlaubt das Speichern der Einstellungen gerade nicht.');}}
async function read(key,fallback){try{const item=await Preferences.get({key:'barver-app-'+key});return item.value?JSON.parse(item.value):fallback;}catch(_){return fallback;}}
async function get(path){
  const url=apiUrl(path);
  if(native){const result=await CapacitorHttp.get({url,headers:{Accept:'application/json'},connectTimeout:10000,readTimeout:path.includes('training')?12000:45000});if(result.status!==200)throw new Error('Daten nicht verfügbar');return typeof result.data==='string'?JSON.parse(result.data):result.data;}
  const response=await fetch(path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(path.includes('training')?12000:45000),cache:'no-store'});if(!response.ok)throw new Error('Daten nicht verfügbar');return response.json();
}
async function external(path){try{const url=publicLink(path);if(native)await Browser.open({url});else window.open(url,'_blank','noopener,noreferrer');}catch(_){toast('Dieser Link ist in der App nicht verfügbar.');}}
function toast(message){q('#toast').textContent=message;q('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{q('#toast').hidden=true;},15000);}
function status(){
  if(view==='training'){q('#status').textContent='Unser Vereinstraining · Live-Stände aktualisieren sich automatisch';return;}
  const stamp=cacheTimes.season,age=stamp?Date.now()-stamp:Infinity;
  q('#status').title=stamp?'Aktualisiert: '+date(stamp):'';q('#status').textContent=!stamp?(failures.season?'Daten gerade nicht erreichbar · erneuter Versuch automatisch':'Spielplan wird geladen …'):failures.season||state.season.stale||age>180000?`Letzter bekannter Stand · ${date(stamp)} · Verbindung wird erneut versucht`:state.season.degraded?'Sportdaten von 3K gerade unvollständig · erneuter Versuch automatisch':failures.live||Date.now()-(cacheTimes.live||0)>45000?'Live-Verbindung unterbrochen · letzter Stand bleibt sichtbar · erneuter Versuch automatisch':'● Verbunden';
}
function collapsible(parent,title,key,fill){
  const panel=node('details',undefined,'fold');panel.dataset.panel=key;panel.open=openPanels.has(key);panel.append(node('summary',title));
  const body=node('div',undefined,'fold-body');fill(body);panel.append(body);
  panel.addEventListener('toggle',()=>{if(!panel.isConnected)return;if(panel.open)openPanels.add(key);else openPanels.delete(key);});parent.append(panel);return body;
}
async function chooseFavorite(code){preferences.favorite=code;team=code;onboardingDone=true;await store('preferences',preferences);await store('onboarding-done',true);render();}
function favoriteChoices(parent){const grid=node('div',undefined,'favorite-choices');for(const code of ['A','B','C','D']){const b=button('Barver '+code,()=>chooseFavorite(code),'favorite-choice');b.setAttribute('aria-pressed',String(preferences.favorite===code));grid.append(b);}parent.append(grid);}
async function openRoute(match){const url=routeUrl(match);if(!url)return;try{if(native)await Browser.open({url});else window.open(url,'_blank','noopener,noreferrer');}catch(_){toast('Die Karten-App konnte nicht geöffnet werden.');}}
async function addCalendar(match){
  const event=calendarEvent(match);if(!event)return;
  if(native&&Capacitor.getPlatform()==='android'){try{await Calendar.addEvent(event);}catch(_){toast('Kein Kalender verfügbar. Bitte installiere oder aktiviere eine Kalender-App.');}return;}
  const file=calendarFile(match),url=URL.createObjectURL(new Blob([file],{type:'text/calendar;charset=utf-8'})),link=node('a');link.href=url;link.download='barver-'+match.id+'.ics';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function appointmentActions(parent,match){
  parent.append(node('p',matchLocation(match)||'Spielort noch nicht hinterlegt.','muted venue'));
  const actions=node('div',undefined,'appointment-actions');if(routeUrl(match))actions.append(button('Route öffnen',()=>openRoute(match),'compact-action'));
  if(calendarEvent(match))actions.append(button('Zum Kalender hinzufügen',()=>addCalendar(match),'compact-action'));parent.append(actions);
}
function matchCard(m){
  const card=button('',()=>openMatch(m.id));
  const labels={live:'LIVE',upcoming:'DEMNÄCHST',final:'ENDSTAND',pending:'VORLÄUFIG BEENDET'};
  const uncertain=m.kind==='live'&&(failures.live||Date.now()-(cacheTimes.live||0)>45000||(m.boards||[]).some(b=>b.stale||Date.now()-Number(b.lastUpdateNs)/1e6>60000));
  const meta=node('div',undefined,'match-meta');card.dataset.kind=m.kind;meta.append(node('span',uncertain?'LIVE · LETZTER STAND':labels[m.kind]||'BEGEGNUNG','badge '+(m.kind==='live'?'live':'')),node('small',date(m.plannedAt)));card.append(meta);
  const row=node('div',undefined,'match');row.append(node('strong',m.home,'match-team'),node('strong',m.score||(m.kind==='upcoming'?'vs':'–'),'score'),node('strong',m.away,'match-team'));card.append(row,node('small',matchSide(m,preferences.favorite),'match-side'));if(matchLocation(m))card.append(node('small',matchLocation(m),'card-venue'));
  if(m.kind==='pending')card.append(node('p','Bestätigung durch den Veranstalter ausstehend.','muted'));
  for(const board of m.boards||[]){const model=liveBoardView(board,Date.now(),!!uncertain),b=node('div',undefined,'board');b.append(node('small','Board '+model.board));for(const player of model.players){const row=node('div',undefined,'board-preview'+(player.throwing?' throwing':''));row.append(node('span',player.name+(player.throwing?' · Am Wurf':'')),node('strong',player.points??'–'));b.append(row);}b.append(node('small',`Legs ${model.players[0].legs??'–'} : ${model.players[1].legs??'–'}`));card.append(b);}
  return card;
}
function list(parent,title,matches,limit=6){parent.append(node('h2',title));const wrap=node('div',undefined,'list');for(const match of matches.slice(0,limit))wrap.append(matchCard(match));if(!matches.length)wrap.append(node('p','Aktuell keine Begegnungen.','empty'));parent.append(wrap);}
function filter(parent){const wrap=node('label',undefined,'filter');wrap.append(node('span','Mannschaft'));const select=node('select');select.dataset.focus='team-filter';for(const code of ['','A','B','C','D']){const option=node('option',code?'Barver '+code:'Alle Teams');option.value=code;select.append(option);}select.value=team;select.addEventListener('change',()=>{team=select.value;render();});wrap.append(select);parent.append(wrap);}
function teamButtons(parent){const grid=node('div',undefined,'grid');for(const code of ['A','B','C','D'])grid.append(button('Barver '+code,()=>openTeam(code)));parent.append(grid);}
function navigate(next){if(webApp&&next!=='training'){const url=new URL(location.href);url.searchParams.delete('training');history.replaceState(null,'',url);}scrollPositions[view]=window.scrollY;view=next;settingsPage='';render();window.scrollTo(0,scrollPositions[next]||0);if(next==='training')training.refresh();}
function openTv(code=preferences.favorite){
  const url=new URL('/app/live',location.origin);
  if(['A','B','C','D'].includes(code))url.searchParams.set('teams',code);else url.searchParams.set('teams','A,B,C,D');
  url.searchParams.set('appTheme',document.documentElement.dataset.theme==='dark'?'dark':'light');
  location.assign(url.href);
}
function liveStrip(){
  const strip=q('#appLiveStrip');
  if(!webApp||view==='training'){strip.hidden=true;return;}
  const matches=matchesFor(state.season,state.live,preferences.favorite);
  const fragment=document.createDocumentFragment();
  for(const match of matches)for(const raw of match.boards||[]){
    const board=liveBoardView(raw,Date.now(),!!failures.live||Date.now()-(cacheTimes.live||0)>45000||!!match.liveStale);
    const chip=button('',()=>openMatch(match.id),'live-chip');
    const names=board.players.map(p=>p.name).join(' / ');
    chip.append(node('small',`${board.stale?'Letzter Stand':'Live'} · Barver ${match.barverTeam||''} · Board ${board.board}`),node('span',names,'live-chip-names'),node('strong',board.players.map(p=>p.points??'–').join(' : ')));
    chip.setAttribute('aria-label',`Board ${board.board}: ${names}. Restpunkte im aktuellen Leg: ${board.players.map(p=>p.points??'unbekannt').join(' zu ')}${board.stale?'. Letzter bekannter Stand':''}. Spiel öffnen.`);
    fragment.append(chip);
  }
  strip.replaceChildren(fragment);strip.hidden=!strip.childElementCount;
}
function home(parent){
  const hero=node('section',undefined,'hero');hero.append(node('small','DEIN VEREIN AUF EINEN BLICK'),node('h1',preferences.favorite?'Barver '+preferences.favorite:'Barver Darts'),node('p',preferences.favorite?'Deine Termine, Ergebnisse und Mannschaft.':'Alle Mannschaften im Blick.','muted'));parent.append(hero);
  if(!preferences.favorite&&!onboardingDone){hero.classList.add('welcome');hero.append(node('p','Wähle deine Mannschaft für deinen persönlichen Spieltag.','welcome-note'));favoriteChoices(hero);hero.append(button('Später auswählen',async()=>{onboardingDone=true;await store('onboarding-done',true);render();},'menu-back'));}
  else{const favorite=node('label',undefined,'filter hero-choice'),select=node('select');favorite.append(node('span','Meine Mannschaft'));select.dataset.focus='home-favorite';select.setAttribute('aria-label','Meine Mannschaft');for(const code of ['','A','B','C','D']){const option=node('option',code?'Barver '+code:'Alle Mannschaften');option.value=code;select.append(option);}select.value=preferences.favorite;select.addEventListener('change',()=>chooseFavorite(select.value));favorite.append(select);hero.append(favorite);}
  const grouped=sections(matchesFor(state.season,state.live,preferences.favorite));
  if(grouped.live.length)list(parent,'Jetzt live',grouped.live,Infinity);
  if(webApp)parent.append(button('TV-Modus öffnen',()=>openTv(),'card more-matches'));
  if(grouped.today.length)list(parent,'Heute',grouped.today,Infinity);
  if(!grouped.live.length&&!grouped.today.length){
    const next=grouped.next[0];if(next){parent.append(node('h2','Nächster Spieltag'),matchCard(next));}
    else parent.append(node('p',state.season.degraded?'Spielplan gerade nicht verfügbar. Die Sportdatenquelle liefert noch keinen vollständigen Stand.':'Heute steht keine Begegnung an.','empty'));
  }
  parent.append(button('Training verfolgen →',()=>navigate('training'),'card more-matches'));
  parent.append(button('Alle Spiele & Ergebnisse →',()=>navigate('matches'),'card more-matches'));
}
function moments(parent,limit=30){parent.append(node('h2','Momente zum Nachlesen'));for(const item of (state.highlights.items||[]).slice(0,limit)){const n=node('article',undefined,'card');n.append(node('strong',item.title),node('p',item.body),node('small',date(item.occurredAt)));parent.append(n);}if(!(state.highlights.items||[]).length)parent.append(node('p','Noch keine besonderen Momente gemeldet.','empty'));}
function standings(parent,league){
  parent.append(node('h3',league?.league?.name||league?.name||'Ligatabelle','league-heading'));
  const rows=league?.standings||[];
  if(!rows.length){parent.append(node('p','Tabelle noch nicht verfügbar.','muted'));return;}
  const wrap=node('div',undefined,'standings'),table=node('table'),head=node('thead'),tr=node('tr');
  table.append(node('caption','Sp. = Spiele · Pkt. = Punkte'));
  for(const title of ['Pl.','Mannschaft','Sp.','Pkt.']){const th=node('th',title);th.scope='col';tr.append(th);}head.append(tr);table.append(head);
  const body=node('tbody');for(const row of rows){const line=node('tr');if(row.barver)line.className='barver';line.append(node('td',row.rank??'–'));const name=node('th',row.name);name.scope='row';line.append(name,node('td',row.played??'–'),node('td',row.pointsFor==null?'–':row.pointsFor+(row.pointsAgainst==null?'':':'+row.pointsAgainst)));body.append(line);}table.append(body);wrap.append(table);parent.append(wrap);
}
function teams(parent){
  parent.append(node('small','BARVER A–D','eyebrow'),node('h1','Teams & Tabellen'));const grid=node('div',undefined,'team-grid');
  for(const code of ['A','B','C','D']){const t=(state.season.teams||[]).find(x=>x.code===code);const card=button('',()=>openTeam(code),'card team-compact'),letter=node('span',code,'team-letter'),copy=node('div',undefined,'team-copy');letter.setAttribute('aria-hidden','true');copy.append(node('strong','Barver '+code),node('small',t?.league?.name||'Liga noch nicht verfügbar'),node('span',t?.rank?'Platz '+t.rank:'Kader & Spiele'));card.append(letter,copy);grid.append(card);}parent.append(grid);
  for(const league of state.season.leagues||[])standings(parent,league);
  if(!(state.season.leagues||[]).length)parent.append(node('p','Ligatabellen werden geladen.','muted'));
}
function settings(parent){
  parent.append(node('h1','Mein Darts'));
  const pages={general:'Darstellung & Lieblingsteam',push:'Pushmeldungen',selection:'Teams, Spieler & Ereignisse',history:'Empfangene Meldungen',moments:'Besondere Momente',about:'Über Barver Darts'};
  if(webApp)pages.install='Auf dem Handy installieren';
  if(!settingsPage){for(const [key,title] of Object.entries(pages)){const entry=button('',()=>{settingsPage=key;render();window.scrollTo(0,0);},'card menu-entry');entry.append(node('strong',title),node('span','›'));parent.append(entry);}return;}
  parent.append(button('‹ Zurück zum Menü',()=>{settingsPage='';render();window.scrollTo(0,0);},'menu-back'),node('h2',pages[settingsPage]));
  if(settingsPage==='install'){
    parent.append(node('p',isStandalone()?'Du nutzt Barver Darts bereits als Startbildschirm-App.':'Die App bekommt ein eigenes Symbol und öffnet sich ohne Browserleiste.'));
    if(!isStandalone()){
      if(installPrompt)parent.append(button('App installieren',async()=>{const prompt=installPrompt;installPrompt=null;await prompt.prompt();await prompt.userChoice;render();}));
      parent.append(node('p',isAppleMobile()?'Auf dem iPhone: In Safari öffnen → Teilen → Zum Home-Bildschirm → Als Web-App öffnen aktivieren, falls angeboten → Hinzufügen.':'Im Browsermenü „App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen.','muted'));
    }
    parent.append(node('p','Spielplan, Teams, Tabellen und deine Auswahl bleiben in dieser Oberfläche. Ohne Verbindung siehst du den zuletzt geladenen Stand. Live-Daten brauchen Internet.','muted'));
  }
  if(settingsPage==='general'){
  if(webApp){const label=node('label',undefined,'training-push-option'),input=node('input');input.type='checkbox';try{input.checked=localStorage.getItem('clubiq_darts_broadcast_enabled')!=='false';}catch(_){input.checked=true;}input.addEventListener('change',()=>{try{localStorage.setItem('clubiq_darts_broadcast_enabled',String(input.checked));}catch(_){toast('Die Animationseinstellung konnte nicht gespeichert werden.');}});label.append(input,node('span','Sieganimationen im TV-Modus'));parent.append(label);}
  const look=node('label',undefined,'filter');look.append(node('span','Darstellung'));const themeSelect=node('select');themeSelect.dataset.focus='appearance';themeSelect.setAttribute('aria-label','Darstellung');
  for(const [value,label] of [['system','Wie mein Handy'],['light','Hell'],['dark','Dunkel']]){const option=node('option',label);option.value=value;themeSelect.append(option);}
  themeSelect.value=appearance;themeSelect.addEventListener('change',async()=>{appearance=themeSelect.value;applyAppearance();await store('appearance',appearance);});look.append(themeSelect);parent.append(look);
  favoriteChoices(parent);
  const favorite=node('label',undefined,'filter');favorite.append(node('span','Lieblingsmannschaft'));const select=node('select');select.dataset.focus='team-filter';for(const code of ['','A','B','C','D']){const o=node('option',code?'Barver '+code:'Alle Teams');o.value=code;select.append(o);}select.value=preferences.favorite;select.addEventListener('change',async()=>{preferences.favorite=select.value;team=select.value;await store('preferences',preferences);});favorite.append(select);parent.append(favorite);
  }
  if(settingsPage==='selection'){
    const trainingRow=node('label',undefined,'training-push-option'),trainingBox=node('input');trainingBox.type='checkbox';trainingBox.dataset.focus='training-push';trainingBox.checked=preferences.training;trainingBox.addEventListener('change',async()=>{preferences.training=trainingBox.checked;try{await saveSelection();}catch(_){toast('Auswahl gespeichert; Serverabgleich wird erneut versucht.');}});trainingRow.append(trainingBox,node('strong','Vereinstraining verfolgen'));parent.append(trainingRow,node('p','Trainingsmeldungen sind eine eigene Auswahl. Ohne Spielerauswahl bekommst du die gewählten Ereignisse von allen Trainingsspielern; mit Spielerauswahl nur von diesen Spielern.','muted'));
    parent.append(node('p','Schnell auswählen oder deine Auswahl im Detail anpassen.','muted'));
    const preset=button('Alle Ergebnisse meines Teams',async()=>{if(!preferences.favorite){toast('Bitte zuerst unter Darstellung & Lieblingsteam ein Team wählen.');return;}preferences.teams=[preferences.favorite];preferences.players=[];preferences.eventTypes=['game','match'];await saveSelection();render();});parent.append(preset);
    for(const [key,title,options] of [['teams','Mannschaften',Object.fromEntries(['A','B','C','D'].map(c=>[c,'Barver '+c]))],['eventTypes','Ereignisse',TYPES]]){
      collapsible(parent,title+' · '+preferences[key].length+' ausgewählt','selection-'+key,body=>{const fields=node('div',undefined,'fields');for(const [value,label]of Object.entries(options)){const row=node('label'),box=node('input');box.type='checkbox';box.dataset.focus=key+'-'+value;box.checked=preferences[key].includes(value);const supported=value!=='player_start'||(!native&&!webApp)||pushTransport?.supportedEventTypes.includes(value);box.disabled=!supported;box.addEventListener('change',async()=>{preferences[key]=box.checked?[...new Set([...preferences[key],value])]:preferences[key].filter(x=>x!==value);try{await saveSelection();}catch(_){toast('Auswahl gespeichert; Serverabgleich wird erneut versucht.');}});row.append(box,node('span',label+(!supported?' · Serverupdate erforderlich':'')));fields.append(row);}body.append(fields);});
    }
    collapsible(parent,'Einzelne Spieler · '+preferences.players.length+' ausgewählt','selection-players',body=>{
      body.append(node('p','Spieler werden zusätzlich zu den Teams abonniert. Für ausschließlich Spieler alle Teams abwählen.','muted'));
      const fields=node('div',undefined,'fields'),names=[...new Set([...(state.season.teams||[]).flatMap(t=>(t.roster||[]).map(p=>p.name)),...training.participants(),...preferences.players])].filter(Boolean).sort((a,b)=>a.localeCompare(b,'de'));
      for(const name of names){const row=node('label'),box=node('input');box.type='checkbox';box.dataset.focus='player-'+name;box.checked=preferences.players.includes(name);box.addEventListener('change',async()=>{preferences.players=box.checked?[...preferences.players,name]:preferences.players.filter(p=>p!==name);try{await saveSelection();}catch(_){toast('Auswahl gespeichert; Serverabgleich wird erneut versucht.');}});row.append(box,node('span',name));fields.append(row);}body.append(fields);
    });
    parent.append(node('p','Spielerstarts melden den Beginn einer Live-Partie. Ein Aufruf vor Spielbeginn ist in den Quelldaten nicht verfügbar.','muted'));
  }
  if(settingsPage==='push'){
  const configured=webApp?!!push&&pushReady:native&&Capacitor.getPlatform()==='android'&&firebaseBundled&&pushReady;
  const messages={active:'Gerät am Push-Server angemeldet. Die Anzeige hängt auch von deinen Android-Einstellungen ab.',registering:'Gerät wird angemeldet …',denied:'Android erlaubt derzeit keine Benachrichtigungen. Bitte in den App-Einstellungen freigeben.',registration_failed:'Anmeldung oder Abgleich fehlgeschlagen · automatischer neuer Versuch im Vordergrund.',disable_failed:'Abmeldung nicht bestätigt. Bitte erneut versuchen.',off:'Pushmeldungen sind ausgeschaltet.'};
  if(webApp){messages.active='Web-App am Push-Server angemeldet. Bitte den Empfang auch bei gesperrtem Handy prüfen.';messages.denied='Benachrichtigungen sind gesperrt. Bitte in den Einstellungen für diese Web-App freigeben.';}
  const activate=button(pushState==='disable_failed'?'Abmeldung erneut versuchen':pushIdentity?.enabled?'Pushmeldungen deaktivieren':'Pushmeldungen aktivieren',()=>pushState==='disable_failed'&&!webApp?push.disable().catch(()=>toast('Abmeldung noch nicht möglich.')):togglePush());
  const webMessage=pushTransport?.previewOnly?'In der lokalen Vorschau ist Push deaktiviert. Nach Veröffentlichung kannst du dein Handy anmelden.':isAppleMobile()&&!isStandalone()?'Für iPhone-Push: Erst zum Home-Bildschirm hinzufügen und die App dort öffnen. Benötigt iOS 16.4 oder neuer.':!push?'Dieser Browser unterstützt Web-Push hier noch nicht.':!pushReady?'Der Push-Server ist gerade nicht erreichbar.':messages[pushState]||messages.off;
  activate.disabled=!configured||pushBusy;parent.append(activate,node('p',webApp?webMessage:!native?'Pushmeldungen aktivierst du in der installierten Android-App.':!firebaseBundled?'Für diese Test-APK fehlt noch die Firebase-App-Konfiguration.':!pushReady?'Der Push-Server ist noch nicht eingerichtet oder nicht erreichbar.':messages[pushState]||messages.off,'muted'));
  if(pushState==='active'){const test=button('Testnachricht senden',async()=>{test.disabled=true;try{await push.test();toast('Testnachricht beim Server angefordert. Bitte auch bei gesperrtem Handy prüfen.');}catch(error){toast(error.message);}finally{test.disabled=false;}});parent.append(test);}
  parent.append(button('Auswahl bearbeiten',()=>{settingsPage='selection';render();}));
  }
  if(settingsPage==='history'){parent.append(node('p','Hier stehen Meldungen, die die App geöffnet empfangen oder die du angetippt hast. Kein vollständiger Zustellnachweis.','muted'));
  for(const item of pushHistory){const card=button('',()=>{openNotification(item.data);});card.append(node('strong',item.title),node('p',item.body),node('small',date(item.at)));parent.append(card);}if(!pushHistory.length)parent.append(node('p','Noch keine empfangenen Meldungen.','empty'));}
  if(settingsPage==='moments')moments(parent);
  if(settingsPage==='about')parent.append(button('Impressum',()=>external('/impressum')),button('Datenschutz',()=>external('/datenschutz')));
}
function render(){
  liveStrip();
  const root=q('#content'),scroll=window.scrollY,focus=document.activeElement?.dataset?.focus;root.replaceChildren();q('#pageTitle').textContent={home:'Dein Spieltag',training:'Unser Training',matches:'Alle Spiele',teams:'Unsere Teams',settings:'Mein Darts'}[view];
  if(applyWebUpdate)root.append(button('Update verfügbar · jetzt neu laden',()=>applyWebUpdate(),'update-action'));
  for(const b of document.querySelectorAll('nav button'))b.setAttribute('aria-current',b.dataset.view===view?'page':'false');
  if(view==='home')home(root);else if(view==='training')training.show(root);else if(view==='teams')teams(root);else if(view==='settings')settings(root);else{filter(root);const grouped=sections(matchesFor(state.season,state.live,team));if(grouped.live.length)list(root,'Live',grouped.live,Infinity);list(root,'Kommende Spiele',grouped.next,Infinity);list(root,'Ergebnisse',grouped.results,Infinity);}status();if(focus){const target=[...root.querySelectorAll('[data-focus]')].find(n=>n.dataset.focus===focus);target?.focus({preventScroll:true});}window.scrollTo(0,scroll);
}
async function refresh(onlyLive=false){
  if(busy||!foreground)return;busy=true;q('#refresh').disabled=true;
  const jobs=onlyLive?['live']:['season','live','highlights','profiles'];
  await Promise.all(jobs.map(async key=>{try{const payload=await get('/api/v1/darts/'+(key==='profiles'?'player-profiles':key));if(!payload||typeof payload!=='object')throw new Error('Ungültige Daten');if(key==='season'&&payload.degraded&&!state.season.degraded&&((state.season.matches||[]).length||(state.season.leagues||[]).some(l=>(l.standings||[]).length)))throw new Error('Teilstand ersetzt keine vollständigen gespeicherten Sportdaten');state[key]=payload;cacheTimes[key]=Date.now();failures[key]=false;await store('snapshot-'+key,{payload,savedAt:cacheTimes[key]});render();updateMatchLive();}catch(_){failures[key]=true;}}));busy=false;q('#refresh').disabled=false;render();updateMatchLive();if(!onlyLive&&selectedMatch)loadMatchReport(selectedMatch);
}
function dialog(title,back=null){detailBack=back;selectedMatch=null;const root=q('#detailContent');root.replaceChildren();if(back)root.append(button('‹ Zurück zum Team',back,'menu-back'));root.append(node('h2',title));if(!q('#detail').open)q('#detail').showModal();return root;}
function updateMatchLive(){
  const detail=selectedMatch;if(!detail||!q('#detail').open)return;
  const match=matchesFor(state.season,state.live).find(m=>m.id===detail.id);
  const unavailable=!!failures.live||Date.now()-(cacheTimes.live||0)>45000||!!match?.liveStale;
  detail.score.textContent=match?.score||'–';
  detail.label.textContent=match?.kind==='final'?'Endstand':match?.kind==='pending'?'Vorläufig beendet · Bestätigung ausstehend':'Gesamtstand';
  const boards=(match?.boards||[]).map(board=>liveBoardView(board,Date.now(),unavailable));
  const fragment=document.createDocumentFragment();
  fragment.append(node('h3',boards.length?`${boards.length===1?'Laufende Partie':`${boards.length} laufende Partien`}`:'Live-Partien'));
  fragment.append(node('p',unavailable?'Live-Verbindung unterbrochen · letzter bekannter Stand · erneuter Versuch automatisch':'Automatische Aktualisierung alle 15 Sekunden.','muted live-note'));
  for(const board of boards){
    const card=node('article',undefined,'live-board'),head=node('div',undefined,'board-heading');
    head.append(node('strong','Board '+board.board),node('span',board.stale?'LETZTER STAND':'LIVE','badge '+(board.stale?'':'live')));card.append(head);
    if(board.mode)card.append(node('small',board.mode));
    card.append(node('small','Restpunkte im aktuellen Leg','points-label'));
    for(const player of board.players){
      const row=node('div',undefined,'live-player'+(player.throwing?' throwing':'')),copy=node('div');
      copy.append(node('strong',player.name));if(player.throwing)copy.append(node('small','● Am Wurf'));

      row.append(copy,node('strong',player.points===0?'CHECK':player.points??'–','live-points'));card.append(row);
    }
    card.append(node('div',`Legs ${board.players[0].legs??'–'} : ${board.players[1].legs??'–'}`,'live-legs'));collapsible(card,'Weitere Statistiken','board-'+detail.id+'-'+board.board,body=>{for(const player of board.players)body.append(node('p',`${player.name}: AVG (Partie) ${player.average??'–'} · Darts im Leg ${player.darts??'–'} · Letzter Wurf ${player.lastScore??'–'}`,'muted'));});fragment.append(card);
  }
  if(!boards.length)fragment.append(node('p',match?.kind==='final'?'Diese Begegnung ist beendet.':match?.kind==='pending'?'Keine aktuellen Live-Daten. Die offizielle Bestätigung steht noch aus.':'Noch keine laufende Partie von 3K gemeldet.','empty'));
  detail.live.replaceChildren(fragment);
}
async function loadMatchReport(detail){
  if(detail.loading||selectedMatch!==detail||!q('#detail').open)return;detail.loading=true;
  try{const report=await get('/api/v1/darts/matches/'+detail.id);if(selectedMatch!==detail||detail.ticket!==detailSequence||!q('#detail').open)return;
    const fragment=document.createDocumentFragment();fragment.append(node('h3','Spielbericht & Statistiken'));
    for(const game of report.games||[]){const card=node('article',undefined,'card');card.append(node('small',game.block||'Partie'),node('h3',`${game.home?.name||'Heim'} ${game.homeLegs??'–'} : ${game.awayLegs??'–'} ${game.away?.name||'Gast'}`),node('p',`Average ${game.home?.average??'–'} : ${game.away?.average??'–'}`,'muted'));fragment.append(card);}
    if(!(report.games||[]).length)fragment.append(node('p','Spielbericht noch nicht veröffentlicht.','muted'));
    detail.report.replaceChildren(fragment);detail.loaded=true;
  }catch(_){if(selectedMatch===detail&&q('#detail').open){if(!detail.loaded)detail.report.replaceChildren(node('p','Spielbericht gerade nicht erreichbar. Die Live-Anzeige darüber läuft unabhängig weiter.','muted'));else if(!detail.report.querySelector('.report-warning'))detail.report.prepend(node('p','Statistiken: letzter bekannter Stand · erneuter Versuch automatisch.','muted report-warning'));}}
  finally{detail.loading=false;}
}
function openMatch(id){
  const returnTeam=q('#detail').open?detailTeam:'';detailTeam='';
  const ticket=++detailSequence,m=matchesFor(state.season,state.live).find(x=>x.id===id),root=dialog(m?m.home+' gegen '+m.away:'Begegnung',returnTeam?()=>openTeam(returnTeam,true):null);
  const summary=node('div',undefined,'match-summary'),label=node('span','Gesamtstand'),score=node('strong','–','score');summary.append(label,score);
  const live=node('section',undefined,'match-live'),report=node('section',undefined,'match-report');live.setAttribute('aria-label','Live-Spielstand');
  report.append(node('p','Spielbericht und Statistiken werden geladen; das kann einige Sekunden dauern.','muted'));root.append(summary);if(m){root.append(node('small',date(m.plannedAt)+' · '+matchSide(m,preferences.favorite)));appointmentActions(root,m);}q('#detail').scrollTop=0;root.append(button('Spielstand aktualisieren',()=>refresh(),'detail-refresh'),live);collapsible(root,'Spielbericht & Statistiken','report-'+id,body=>body.append(report));
  selectedMatch={id,ticket,live,report,label,score,loading:false,loaded:false};updateMatchLive();loadMatchReport(selectedMatch);refresh(true);
  if(webApp)root.append(button('Im TV-Modus verfolgen',()=>openTv(m?.barverTeam),'card more-matches'));
}
function openTeam(code,restore=false){
  detailTeam=code;
  ++detailSequence;const selected=(state.season.teams||[]).find(t=>t.code===code),root=dialog('SV Barver Darts '+code);root.append(node('p',selected?.league?.name||'Mannschaftsdaten werden geladen.','muted'));const roster=[...(selected?.roster||[])].sort((a,b)=>roleRank(a)-roleRank(b)||String(a.name).localeCompare(String(b.name),'de'));
  const league=(state.season.leagues||[]).find(l=>(l.league?.key||l.key)===selected?.league?.key);if(league)standings(root,league);const rosterRoot=collapsible(root,'Kader · '+roster.length+' Spieler','roster-'+code,()=>{});for(const member of roster){const profile=state.profiles.players?.[String(member.id)]||{},card=button('',()=>{teamScroll=q('#detail').scrollTop;openPlayer(member,profile,code);},'card member');const imagePath=profile.image||'';if(/^\/(pics\/players\/[^?#]+\.webp|api\/v1\/darts\/players\/\d+\/photo)$/.test(imagePath)){const img=node('img');img.src=API_ORIGIN+imagePath;img.alt='';img.loading='lazy';card.append(img);}const copy=node('div');copy.append(node('strong',member.name),node('small',[profile.alias,member.role].filter(Boolean).join(' · ')));card.append(copy);rosterRoot.append(card);}if(!roster.length)rosterRoot.append(node('p','Kader noch nicht verfügbar.','muted'));const grouped=sections(matchesFor(state.season,state.live,code));if(grouped.live.length)list(root,'Jetzt live',grouped.live,8);if(grouped.today.length)list(root,'Heute',grouped.today,4);list(root,'Demnächst',grouped.next,4);collapsible(root,'Letzte Ergebnisse','team-results-'+code,body=>list(body,'Ergebnisse',grouped.results,Infinity));q('#detail').scrollTop=restore?teamScroll:0;
}
function openPlayer(member,profile,code){
  detailTeam=code;
  ++detailSequence;const root=dialog(member.name,()=>openTeam(code,true));q('#detail').scrollTop=0;if(profile.alias)root.append(node('p','„'+profile.alias+'“'));for(const [key,title]of [['darts','Darts'],['weightGrams','Gewicht'],['favoritePdcPlayer','Lieblingsspieler'],['favoriteFinish','Lieblingsfinish'],['finishRoute','Weg zum Finish'],['walkOnSong','Einlaufmusik']])if(profile.personal?.[key])root.append(node('h3',title),node('p',String(profile.personal[key])+(key==='weightGrams'?' g':'')));if(!Object.keys(profile.personal||{}).length)root.append(node('p','Persönliche Angaben werden noch ergänzt.','muted'));
}
function openNotification(data){const trainingId=trainingNotificationTarget(data);if(trainingId){if(q('#detail').open)q('#detail').close();view='training';training.select(trainingId);render();}else{const id=notificationTarget(data);if(id)openMatch(id);}}
function rememberPush(n){const id=String(n.data?.eventId||n.id||'');if(id&&pushHistory.some(h=>h.id===id))return;pushHistory.unshift({id,title:String(n.title||'Barver Darts').slice(0,200),body:String(n.body||'').slice(0,600),data:{matchId:notificationTarget(n.data),...(trainingNotificationTarget(n.data)?{scope:'training',trainingId:trainingNotificationTarget(n.data)}:{})},at:Number(n.at)||Date.now()});pushHistory=pushHistory.slice(0,50);store('push-history',pushHistory);if(view==='settings')render();}
async function initPush(){
  pushHistory=await read('push-history',[]);if(!Array.isArray(pushHistory))pushHistory=[];
  if(webApp){
    webRegistration=await prepareWebApp({onUpdate:apply=>{applyWebUpdate=apply;render();},onMessage:n=>{rememberPush(n);toast(n.title+' · '+n.body);}});
    if(webRegistration){try{const cache=await caches.open('barver-compact-history-v1'),response=await cache.match(new URL('push-history',webRegistration.scope).href);if(response){for(const item of (await response.json()).reverse())rememberPush({...item,data:{...item.data,eventId:item.id}});}}catch(_){}
      if('PushManager' in window&&'Notification' in window&&(!isAppleMobile()||isStandalone())){
        pushIdentity=await read('push-device-web',{enabled:false});pushTransport=push=createWebPush({registration:webRegistration,request:webPushRequest,selection:()=>({teams:preferences.teams,players:preferences.players,eventTypes:preferences.eventTypes,training:preferences.training}),onStatus:pushStatus});
        pushReady=await push.config();await push.restore(!!pushIdentity.enabled);
      }
    }if(view==='settings')render();return;
  }
  if(!native||Capacitor.getPlatform()!=='android'||!firebaseBundled)return;
  pushIdentity=await read('push-device',null);if(!/^[a-f0-9]{64}$/.test(pushIdentity?.secret||'')){pushIdentity={secret:deviceSecret(),token:null,enabled:false};await savePushIdentity(pushIdentity);}
  pushTransport=createPushTransport({request:pushRequest,identity:pushIdentity,selection:()=>({teams:preferences.teams,players:preferences.players,eventTypes:preferences.eventTypes,training:preferences.training}),saveIdentity:savePushIdentity});
  push=createNativePush({plugin:PushNotifications,transport:pushTransport,platform:'android',initialToken:pushIdentity.token,onStatus:pushStatus,onReceived:n=>{rememberPush(n);toast((n.title||'Barver Darts')+' · '+(n.body||''));},onOpen:n=>{rememberPush(n);openNotification(n.data);}});
  await checkPush();
}
for(const b of document.querySelectorAll('nav button'))b.addEventListener('click',()=>{navigate(b.dataset.view);});
q('#themeToggle').addEventListener('click',async()=>{appearance=document.documentElement.dataset.theme==='dark'?'light':'dark';applyAppearance();await store('appearance',appearance);});
q('#refresh').addEventListener('click',()=>{refresh();training.refresh();});q('#closeDetail').addEventListener('click',()=>{detailSequence++;selectedMatch=null;detailTeam='';q('#detail').close();});q('#detail').addEventListener('close',()=>{detailSequence++;selectedMatch=null;detailBack=null;detailTeam='';if(webApp){const url=new URL(location.href);url.searchParams.delete('match');history.replaceState(null,'',url);}});
window.addEventListener('online',()=>refresh());document.addEventListener('visibilitychange',()=>{foreground=!document.hidden;if(foreground){refresh();if(view==='training')training.refresh();}});
if(webApp){document.documentElement.dataset.runtime='web';q('#webTv').hidden=false;q('#webTv').addEventListener('click',()=>openTv());q('#preview').textContent='BARVER DARTS · WEB-APP';window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;if(view==='settings')render();});window.addEventListener('appinstalled',()=>{installPrompt=null;if(view==='settings')render();});}
if(native){q('#preview').textContent='ANDROID-TESTVERSION';App.addListener('appStateChange',({isActive})=>{foreground=isActive;if(isActive){refresh();checkPush();}});App.addListener('backButton',()=>{if(q('#detail').open){if(detailBack){detailBack();}else{detailSequence++;q('#detail').close();}}else if(view==='settings'&&settingsPage){settingsPage='';render();}else if(view!=='home'){navigate('home');}else App.minimizeApp();});}
async function start(){const savedAppearance=await read('appearance','system');appearance=['system','light','dark'].includes(savedAppearance)?savedAppearance:'system';applyAppearance();preferences=cleanPreferences(await read('preferences',{}));onboardingDone=await read('onboarding-done',false);team=preferences.favorite;for(const key of Object.keys(state)){const cached=await read('snapshot-'+key,null);if(cached?.payload&&typeof cached.payload==='object'){state[key]=cached.payload;cacheTimes[key]=Number(cached.savedAt)||0;}}await training.init();render();training.refresh();const initialRefresh=refresh();initPush().catch(()=>toast('Push-Einstellungen konnten nicht geladen werden.'));if(webApp){const query=new URL(location.href).searchParams,trainingId=trainingNotificationTarget({scope:'training',trainingId:query.get('training')});if(trainingId){view='training';training.select(trainingId);}const id=notificationTarget({matchId:query.get('match')});if(id){await initialRefresh;openMatch(id);}}setInterval(()=>refresh(true),15000);setInterval(()=>{if(foreground&&view==='training')training.refresh(true);},10000);setInterval(()=>{refresh();if(foreground){checkPush();if(view==='training')training.refresh();}},60000);}
start();
