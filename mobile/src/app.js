import {Capacitor,CapacitorHttp} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {Preferences} from '@capacitor/preferences';
import {PushNotifications} from '@capacitor/push-notifications';
import {API_ORIGIN,TYPES,apiUrl,publicLink,cleanPreferences,matchesFor,sections,roleRank,notificationTarget,liveBoardView} from './model.js';
import {createNativePush} from './native-push.js';
import {createPushTransport,deviceSecret} from './push-transport.js';
const q=s=>document.querySelector(s),native=Capacitor.isNativePlatform();
let state={season:{matches:[],teams:[]},live:{groups:[]},highlights:{items:[]},profiles:{players:{}}},cacheTimes={},failures={},preferences=cleanPreferences(),view='home',team='',busy=false,foreground=true;
let detailSequence=0,toastTimer,selectedMatch=null;
let push=null,pushTransport=null,pushIdentity=null,pushState='off',pushReady=false,pushBusy=false,pushHistory=[],pushCheckBusy=false;
const firebaseBundled=__ANDROID_FIREBASE_CONFIGURED__;
async function savePushIdentity(value){await Preferences.set({key:'barver-app-push-device',value:JSON.stringify(value)});}
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
    else if(pushReady&&pushIdentity.enabled){const permission=await PushNotifications.checkPermissions();if(permission.receive==='granted'){if(pushState==='active')await push.sync();else await push.enable();}else pushStatus('denied');}
  }catch(_){pushReady=false;if(pushIdentity.enabled)pushStatus('registration_failed');}
  finally{pushCheckBusy=false;if(view==='settings')render();}
}
async function togglePush(){
  if(pushBusy||!push)return;pushBusy=true;
  try{if(pushIdentity.enabled){pushIdentity.enabled=false;await savePushIdentity(pushIdentity);await push.disable();}else{pushIdentity.enabled=true;await savePushIdentity(pushIdentity);await push.enable();}}
  catch(error){pushStatus(pushIdentity.enabled?'registration_failed':'disable_failed');toast(error.message||'Push-Aktion fehlgeschlagen. Bitte erneut versuchen.');}
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
  if(native){const result=await CapacitorHttp.get({url,headers:{Accept:'application/json'},connectTimeout:10000,readTimeout:45000});if(result.status!==200)throw new Error('Daten nicht verfügbar');return typeof result.data==='string'?JSON.parse(result.data):result.data;}
  const response=await fetch(path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(45000),cache:'no-store'});if(!response.ok)throw new Error('Daten nicht verfügbar');return response.json();
}
async function external(path){try{const url=publicLink(path);if(native)await Browser.open({url});else window.open(url,'_blank','noopener,noreferrer');}catch(_){toast('Dieser Link ist in der App nicht verfügbar.');}}
function toast(message){q('#toast').textContent=message;q('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{q('#toast').hidden=true;},15000);}
function status(){
  const stamp=cacheTimes.season,age=stamp?Date.now()-stamp:Infinity;
  q('#status').textContent=!stamp?(failures.season?'Daten gerade nicht erreichbar · erneuter Versuch automatisch':'Spielplan wird geladen …'):failures.season||state.season.stale||age>180000?`Letzter bekannter Stand · ${date(stamp)} · Verbindung wird erneut versucht`:failures.live||Date.now()-(cacheTimes.live||0)>45000?'Live-Verbindung unterbrochen · letzter Stand bleibt sichtbar · erneuter Versuch automatisch':`Daten aktualisiert · ${date(stamp)}`;
}
function matchCard(m){
  const card=button('',()=>openMatch(m.id));
  const labels={live:'LIVE',upcoming:'DEMNÄCHST',final:'ENDSTAND',pending:'VORLÄUFIG BEENDET'};
  const uncertain=m.kind==='live'&&(failures.live||Date.now()-(cacheTimes.live||0)>45000||(m.boards||[]).some(b=>b.stale||Date.now()-Number(b.lastUpdateNs)/1e6>60000));
  card.append(node('span',uncertain?'LIVE · LETZTER STAND':labels[m.kind]||'BEGEGNUNG','badge '+(m.kind==='live'?'live':'')));
  const row=node('div',undefined,'match'),names=node('div');names.append(node('strong',m.home),node('div','gegen '+m.away,'muted'));row.append(names,node('strong',m.score||'–','score'));card.append(row,node('small',date(m.plannedAt)));
  if(m.kind==='pending')card.append(node('p','Bestätigung durch den Veranstalter ausstehend.','muted'));
  for(const board of m.boards||[]){const b=node('div',undefined,'board');b.append(node('small','Board '+(board.board||'–')),node('div',`${board.home?.name||'Heim'} · ${board.home?.legs??'–'} : ${board.guest?.legs??'–'} · ${board.guest?.name||'Gast'}`),node('strong',`Im Leg: ${board.home?.points??'–'} : ${board.guest?.points??'–'}`));card.append(b);}
  return card;
}
function list(parent,title,matches,limit=6){parent.append(node('h2',title));const wrap=node('div',undefined,'list');for(const match of matches.slice(0,limit))wrap.append(matchCard(match));if(!matches.length)wrap.append(node('p','Aktuell keine Begegnungen.','empty'));parent.append(wrap);}
function filter(parent){const wrap=node('label',undefined,'filter');wrap.append(node('span','Mannschaft'));const select=node('select');for(const code of ['','A','B','C','D']){const option=node('option',code?'Barver '+code:'Alle Teams');option.value=code;select.append(option);}select.value=team;select.addEventListener('change',()=>{team=select.value;render();});wrap.append(select);parent.append(wrap);}
function teamButtons(parent){const grid=node('div',undefined,'grid');for(const code of ['A','B','C','D'])grid.append(button('Barver '+code,()=>openTeam(code)));parent.append(grid);}
function home(parent){
  const hero=node('section',undefined,'hero');hero.append(node('small','VIER TEAMS · DEIN VEREIN'),node('h1','Barver am Oche'),node('p','Spiele, Ergebnisse und deine Mannschaft.'));parent.append(hero);teamButtons(parent);filter(parent);
  const grouped=sections(matchesFor(state.season,state.live,team));
  if(grouped.live.length)list(parent,'Jetzt live',grouped.live,8);
  list(parent,'Heute',grouped.today,6);list(parent,'Demnächst',grouped.next,4);list(parent,'Letzte Ergebnisse',grouped.results,4);
  parent.append(node('h2','Vereinstraining'),node('p','Dienstags und donnerstags · 19:30 Uhr','muted'),button('Turnier & TV öffnen',()=>external('/turnier')));
  moments(parent,4);
}
function moments(parent,limit=30){parent.append(node('h2','Momente zum Nachlesen'));for(const item of (state.highlights.items||[]).slice(0,limit)){const n=node('article',undefined,'card');n.append(node('strong',item.title),node('p',item.body),node('small',date(item.occurredAt)));parent.append(n);}if(!(state.highlights.items||[]).length)parent.append(node('p','Noch keine besonderen Momente gemeldet.','empty'));}
function teams(parent){parent.append(node('h1','Unsere Mannschaften'));teamButtons(parent);parent.append(node('p','Mannschaft auswählen: Kader, Spielplan und letzte Ergebnisse.','muted'));}
function settings(parent){
  parent.append(node('h1','Mein Darts'));const favorite=node('label',undefined,'filter');favorite.append(node('span','Lieblingsmannschaft'));const select=node('select');for(const code of ['','A','B','C','D']){const o=node('option',code?'Barver '+code:'Alle Teams');o.value=code;select.append(o);}select.value=preferences.favorite;select.addEventListener('change',async()=>{preferences.favorite=select.value;team=select.value;await store('preferences',preferences);});favorite.append(select);parent.append(favorite);
  parent.append(node('h2','Deine Pushmeldungen'),node('p','Wähle Mannschaften, Spieler und die Momente, die dich interessieren.','muted'));
  for(const [key,title,options]of [['teams','Mannschaften',Object.fromEntries(['A','B','C','D'].map(c=>[c,'Barver '+c]))],['eventTypes','Ereignisse',TYPES]]){
    parent.append(node('h3',title));const fields=node('div',undefined,'fields');for(const [value,label]of Object.entries(options)){const row=node('label'),box=node('input');box.type='checkbox';box.checked=preferences[key].includes(value);box.addEventListener('change',async()=>{preferences[key]=box.checked?[...new Set([...preferences[key],value])]:preferences[key].filter(x=>x!==value);await saveSelection();});row.append(box,node('span',label));fields.append(row);}parent.append(fields,node('p',''));
  }
  parent.append(node('h3','Einzelne Spieler'),node('p','Zusätzlich zu den Mannschaften abonnieren. Für Meldungen nur zu einzelnen Spielern: alle Mannschaften abwählen.','muted'));
  const playerFields=node('div',undefined,'fields');const names=[...new Set([...(state.season.teams||[]).flatMap(t=>(t.roster||[]).map(p=>p.name)),...preferences.players])].filter(Boolean).sort((a,b)=>a.localeCompare(b,'de'));
  for(const name of names){const row=node('label'),box=node('input');box.type='checkbox';box.checked=preferences.players.includes(name);box.addEventListener('change',async()=>{preferences.players=box.checked?[...preferences.players,name]:preferences.players.filter(p=>p!==name);await saveSelection();});row.append(box,node('span',name));playerFields.append(row);}parent.append(playerFields);
  const configured=native&&Capacitor.getPlatform()==='android'&&firebaseBundled&&pushReady;
  const messages={active:'Gerät am Push-Server angemeldet. Die Anzeige hängt auch von deinen Android-Einstellungen ab.',registering:'Gerät wird angemeldet …',denied:'Android erlaubt derzeit keine Benachrichtigungen. Bitte in den App-Einstellungen freigeben.',registration_failed:'Anmeldung oder Abgleich fehlgeschlagen · automatischer neuer Versuch im Vordergrund.',disable_failed:'Abmeldung nicht bestätigt. Bitte erneut versuchen.',off:'Pushmeldungen sind ausgeschaltet.'};
  const activate=button(pushIdentity?.enabled?'Pushmeldungen deaktivieren':pushState==='disable_failed'?'Abmeldung erneut versuchen':'Pushmeldungen aktivieren',()=>pushState==='disable_failed'?push.disable().catch(()=>toast('Abmeldung noch nicht möglich.')):togglePush());
  activate.disabled=!configured||pushBusy;parent.append(activate,node('p',!native?'Pushmeldungen aktivierst du in der installierten Android-App.':!firebaseBundled?'Für diese Test-APK fehlt noch die Firebase-App-Konfiguration.':!pushReady?'Der Push-Server ist noch nicht eingerichtet oder nicht erreichbar.':messages[pushState]||messages.off,'muted'));
  if(pushState==='active'){const test=button('Testnachricht senden',async()=>{test.disabled=true;try{await push.test();toast('Testnachricht beim Server angefordert. Bitte auch bei gesperrtem Handy prüfen.');}catch(error){toast(error.message);}finally{test.disabled=false;}});parent.append(test);}
  parent.append(node('h2','In der App empfangen'),node('p','Hier stehen Meldungen, die die App geöffnet empfangen oder die du angetippt hast. Kein vollständiger Zustellnachweis.','muted'));
  for(const item of pushHistory){const card=button('',()=>{const id=notificationTarget(item.data);if(id)openMatch(id);});card.append(node('strong',item.title),node('p',item.body),node('small',date(item.at)));parent.append(card);}if(!pushHistory.length)parent.append(node('p','Noch keine empfangenen Meldungen.','empty'));moments(parent);
  parent.append(node('h2','Über Barver Darts'),button('Impressum',()=>external('/impressum')),button('Datenschutz',()=>external('/datenschutz')));
}
function render(){
  const root=q('#content');root.replaceChildren();q('#pageTitle').textContent={home:'Dein Spieltag',matches:'Alle Spiele',teams:'Unsere Teams',settings:'Mein Darts'}[view];
  for(const b of document.querySelectorAll('nav button'))b.setAttribute('aria-current',b.dataset.view===view?'page':'false');
  if(view==='home')home(root);else if(view==='teams')teams(root);else if(view==='settings')settings(root);else{filter(root);const grouped=sections(matchesFor(state.season,state.live,team));list(root,'Live',grouped.live,50);list(root,'Heute',grouped.today,50);list(root,'Kommende Spiele',grouped.next,50);list(root,'Ergebnisse',grouped.results,50);}status();
}
async function refresh(onlyLive=false){
  if(busy||!foreground)return;busy=true;q('#refresh').disabled=true;
  const jobs=onlyLive?['live']:['season','live','highlights','profiles'];
  await Promise.all(jobs.map(async key=>{try{const payload=await get('/api/v1/darts/'+(key==='profiles'?'player-profiles':key));if(!payload||typeof payload!=='object')throw new Error('Ungültige Daten');state[key]=payload;cacheTimes[key]=Date.now();failures[key]=false;await store('snapshot-'+key,{payload,savedAt:cacheTimes[key]});render();updateMatchLive();}catch(_){failures[key]=true;}}));busy=false;q('#refresh').disabled=false;render();updateMatchLive();if(!onlyLive&&selectedMatch)loadMatchReport(selectedMatch);
}
function dialog(title){selectedMatch=null;const root=q('#detailContent');root.replaceChildren(node('h2',title));if(!q('#detail').open)q('#detail').showModal();return root;}
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
    card.append(node('small','Punkte im aktuellen Leg','points-label'));
    for(const player of board.players){
      const row=node('div',undefined,'live-player'+(player.throwing?' throwing':'')),copy=node('div');
      copy.append(node('strong',player.name));if(player.throwing)copy.append(node('small','● Am Wurf'));
      copy.append(node('small',`Average ${player.average??'–'} · Letzter Wurf ${player.lastScore??'–'}`));
      row.append(copy,node('strong',player.points===0?'CHECK':player.points??'–','live-points'));card.append(row);
    }
    card.append(node('div',`Legs ${board.players[0].legs??'–'} : ${board.players[1].legs??'–'}`,'live-legs'));fragment.append(card);
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
  const ticket=++detailSequence,m=matchesFor(state.season,state.live).find(x=>x.id===id),root=dialog(m?m.home+' gegen '+m.away:'Begegnung');
  const summary=node('div',undefined,'match-summary'),label=node('span','Gesamtstand'),score=node('strong','–','score');summary.append(label,score);
  const live=node('section',undefined,'match-live'),report=node('section',undefined,'match-report');live.setAttribute('aria-label','Live-Spielstand');
  report.append(node('p','Spielbericht und Statistiken werden geladen; das kann einige Sekunden dauern.','muted'));root.append(summary,button('Spielstand aktualisieren',()=>refresh(),'detail-refresh'),live,report);
  selectedMatch={id,ticket,live,report,label,score,loading:false,loaded:false};updateMatchLive();loadMatchReport(selectedMatch);refresh(true);
}
function openTeam(code){
  ++detailSequence;const selected=(state.season.teams||[]).find(t=>t.code===code),root=dialog('SV Barver Darts '+code);root.append(node('p',selected?.league?.name||'Mannschaftsdaten werden geladen.','muted'));const roster=[...(selected?.roster||[])].sort((a,b)=>roleRank(a)-roleRank(b)||String(a.name).localeCompare(String(b.name),'de'));
  root.append(node('h3','Kader'));for(const member of roster){const profile=state.profiles.players?.[String(member.id)]||{},card=button('',()=>openPlayer(member,profile),'card member');const imagePath=profile.image||'';if(/^\/(pics\/players\/[^?#]+\.webp|api\/v1\/darts\/players\/\d+\/photo)$/.test(imagePath)){const img=node('img');img.src=API_ORIGIN+imagePath;img.alt='';img.loading='lazy';card.append(img);}const copy=node('div');copy.append(node('strong',member.name),node('small',[profile.alias,member.role].filter(Boolean).join(' · ')));card.append(copy);root.append(card);}if(!roster.length)root.append(node('p','Kader noch nicht verfügbar.','muted'));const grouped=sections(matchesFor(state.season,state.live,code));if(grouped.live.length)list(root,'Jetzt live',grouped.live,8);if(grouped.today.length)list(root,'Heute',grouped.today,4);list(root,'Demnächst',grouped.next,4);list(root,'Letzte Ergebnisse',grouped.results,4);
}
function openPlayer(member,profile){
  ++detailSequence;const root=dialog(member.name);if(profile.alias)root.append(node('p','„'+profile.alias+'“'));for(const [key,title]of [['darts','Darts'],['weightGrams','Gewicht'],['favoritePdcPlayer','Lieblingsspieler'],['favoriteFinish','Lieblingsfinish'],['finishRoute','Weg zum Finish'],['walkOnSong','Einlaufmusik']])if(profile.personal?.[key])root.append(node('h3',title),node('p',String(profile.personal[key])+(key==='weightGrams'?' g':'')));if(!Object.keys(profile.personal||{}).length)root.append(node('p','Persönliche Angaben werden noch ergänzt.','muted'));
}
function rememberPush(n){const id=String(n.data?.eventId||n.id||'');if(id&&pushHistory.some(h=>h.id===id))return;pushHistory.unshift({id,title:String(n.title||'Barver Darts').slice(0,200),body:String(n.body||'').slice(0,600),data:{matchId:notificationTarget(n.data)},at:Date.now()});pushHistory=pushHistory.slice(0,50);store('push-history',pushHistory);if(view==='settings')render();}
async function initPush(){
  pushHistory=await read('push-history',[]);if(!Array.isArray(pushHistory))pushHistory=[];
  if(!native||Capacitor.getPlatform()!=='android'||!firebaseBundled)return;
  pushIdentity=await read('push-device',null);if(!/^[a-f0-9]{64}$/.test(pushIdentity?.secret||'')){pushIdentity={secret:deviceSecret(),token:null,enabled:false};await savePushIdentity(pushIdentity);}
  pushTransport=createPushTransport({request:pushRequest,identity:pushIdentity,selection:()=>({teams:preferences.teams,players:preferences.players,eventTypes:preferences.eventTypes}),saveIdentity:savePushIdentity});
  push=createNativePush({plugin:PushNotifications,transport:pushTransport,platform:'android',initialToken:pushIdentity.token,onStatus:pushStatus,onReceived:n=>{rememberPush(n);toast((n.title||'Barver Darts')+' · '+(n.body||''));},onOpen:n=>{rememberPush(n);const id=notificationTarget(n.data);if(id)openMatch(id);}});
  await checkPush();
}
for(const b of document.querySelectorAll('nav button'))b.addEventListener('click',()=>{view=b.dataset.view;render();window.scrollTo(0,0);});
q('#refresh').addEventListener('click',()=>refresh());q('#closeDetail').addEventListener('click',()=>{detailSequence++;selectedMatch=null;q('#detail').close();});q('#detail').addEventListener('close',()=>{detailSequence++;selectedMatch=null;});
window.addEventListener('online',()=>refresh());document.addEventListener('visibilitychange',()=>{foreground=!document.hidden;if(foreground)refresh();});
if(native){q('#preview').textContent='ANDROID-TESTVERSION';App.addListener('appStateChange',({isActive})=>{foreground=isActive;if(isActive){refresh();checkPush();}});App.addListener('backButton',()=>{if(q('#detail').open){detailSequence++;q('#detail').close();}else if(view!=='home'){view='home';render();}else App.minimizeApp();});}
async function start(){preferences=cleanPreferences(await read('preferences',{}));team=preferences.favorite;for(const key of Object.keys(state)){const cached=await read('snapshot-'+key,null);if(cached?.payload&&typeof cached.payload==='object'){state[key]=cached.payload;cacheTimes[key]=Number(cached.savedAt)||0;}}render();refresh();initPush().catch(()=>toast('Push-Einstellungen konnten nicht geladen werden.'));setInterval(()=>refresh(true),15000);setInterval(()=>{refresh();if(foreground)checkPush();},60000);}
start();
