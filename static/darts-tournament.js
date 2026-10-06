'use strict';
const q=s=>document.querySelector(s), params=new URLSearchParams(location.search), initialTv=params.get('tv')==='1';
const trainingPage=location.pathname==='/training';
let trainingCatalog=null,trainingSearchBusy=false,trainingSearchAt=0,trainingSearchTimer,requestController=null,viewChosen=false;
// No production subscriptions or network calls in the localhost-only demo.
const demo=['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&params.get('demo')==='tournament';
let selectedEvent=/^[1-9][0-9]*$/.test(params.get('event')||'')?params.get('event'):'',selectionVersion=0;
if(trainingPage){
  document.title='Barver Darts · Training';q('.brand').lastChild.textContent='Training';q('.eyebrow').textContent='Barver Darts · Unser Training';q('#eventTitle').textContent='Vereinstraining';q('#eventInfo').textContent='Trainingsdaten werden geladen …';q('#trainingControls').hidden=false;q('#eventChoiceLabel').textContent='Training';q('#tournamentChoice option').textContent='Aktuelles Training automatisch';q('#source').textContent='Offizielle Trainingsseite ↗';
  try{trainingCatalog=JSON.parse(localStorage.getItem('clubiq_darts_training_catalog')||'null');q('#autoTrainingSearch').checked=localStorage.getItem('clubiq_darts_training_auto')!=='off';}catch(_){}
}else for(const option of q('#view').querySelectorAll('[value=performances],[value=placement]'))option.remove();
let tv=initialTv,data=null,page=0,groupIndex=0,groupPage=0,alternateTable=false,busy=false,previous=new Map(),initialized=false,highlightTimer,demoPaused=false,demoTick=0;
document.body.classList.toggle('tv',tv);document.body.classList.toggle('demo',demo);
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function sorted(kind){return(data?.matches||[]).filter(m=>m.kind===kind).sort((a,b)=>kind==='final'?String(b.updatedAt).localeCompare(String(a.updatedAt)):String(a.board).localeCompare(String(b.board),'de',{numeric:true})||a.id-b.id);}
function card(m){
  const n=node('article',undefined,'board'),head=node('div',undefined,'board-head');
  head.append(node('strong',m.board?`Board ${m.board}`:'Board noch offen'),node('span',m.kind==='live'?'LIVE':m.kind==='final'?'ENDSTAND':m.round||m.phase,m.kind==='live'?'live-badge':''));n.append(head);
  for(const[i,name,side]of[[0,m.home,m.live?.home],[1,m.away,m.live?.guest]]){const row=node('div',undefined,'player'+(m.live?.currentPlayerIndex===i?' throwing':'')),stats=node('span',undefined,'player-live');stats.append(node('strong',side?.points??'–','points'));if(Number.isInteger(side?.darts))stats.append(node('small',`${side.darts} Darts`,'darts-count'));row.append(node('span',name),stats);n.append(row);}
  n.append(node('div',`Legs ${m.live?.home?.legs??m.homeLegs??'–'} : ${m.live?.guest?.legs??m.awayLegs??'–'}`,'legs'));
  if(m.kind==='live'&&!m.live)n.append(node('small','Aktuelle Leg-Punkte noch nicht von 3K verfügbar.'));return n;
}
function table(group,tablePage=0,limited=false){
  const root=node('section',undefined,'standings');root.append(node('p',demo?'DEMO · Beispieltabelle':'Offizielle Rangfolge · 3K','eyebrow'),node('h2',group.name));
  const t=node('table'),caption=node('caption',`${group.name} · Rang, Spiele, Siege, Punkte und Legs`),head=node('thead'),hr=node('tr');
  for(const label of['#','Teilnehmer','Sp.','S','Pkt.','Legs']){const th=node('th',label);th.scope='col';hr.append(th);}head.append(hr);
  const body=node('tbody'),rows=group.entries||[];
  for(const row of limited?rows.slice(tablePage*8,(tablePage+1)*8):rows){const tr=node('tr');for(const value of[row.rank,row.name,row.played??'–',row.wins??'–',`${row.pointsFor??'–'}:${row.pointsAgainst??'–'}`,`${row.legsFor??'–'}:${row.legsAgainst??'–'}`])tr.append(node('td',value));body.append(tr);}
  t.append(caption,head,body);root.append(t);if(!rows.length)root.append(node('p','Die Tabelle ist noch nicht veröffentlicht.'));return root;
}
function currentGroup(){
  const groups=data?.groups||[],choice=q('#groupChoice').value;if(choice!=='auto')groupIndex=Math.max(0,groups.findIndex(g=>g.id===choice));groupIndex=groups.length?(groupIndex+groups.length)%groups.length:0;
  const group=groups[groupIndex],pages=Math.max(1,Math.ceil((group?.entries.length||0)/8));groupPage%=pages;
  q('#groupPosition').textContent=group?`Gruppe ${groupIndex+1} von ${groups.length}${pages>1?` · Tabellen-Seite ${groupPage+1}/${pages}`:''}${q('#rotate').checked?' · Wechsel alle 20 Sek.':''}`:'';return group;
}
function groupOptions(){const select=q('#groupChoice'),keep=select.value;select.replaceChildren(Object.assign(node('option','Alle Gruppen · wechselnd'),{value:'auto'}));for(const g of data.groups||[])select.append(Object.assign(node('option',g.name),{value:g.id}));select.value=[...select.options].some(o=>o.value===keep)?keep:'auto';}
function render(){
  if(!data)return;const kind=q('#view').value,size=Number(q('#pageSize').value),groups=data.groups||[];
  const tablesOnly=kind==='groups'||(tv&&kind==='live'&&q('#tableMode').value==='alternate'&&alternateTable),sidebar=!tablesOnly&&!['participants','performances','placement'].includes(kind)&&q('#tableMode').value==='sidebar';
  q('#stage').classList.toggle('with-sidebar',sidebar);q('#groupSidebar').hidden=!sidebar;q('#boards').classList.toggle('tables-only',tablesOnly);document.body.classList.toggle('compact',tv&&(size>=12||sidebar));q('#boards').replaceChildren();
  document.body.classList.toggle('many-boards',tv&&size>=12);
  const group=currentGroup();q('#groupTable').replaceChildren(group?table(group,groupPage,true):node('p','Gruppen und Tabellen erscheinen hier, sobald 3K sie veröffentlicht.','group-empty'));
  if(kind==='performances'||kind==='placement'){
    const key=kind==='performances'?'performances':'placements',rows=data[key]||[];if(data[key+'Unavailable'])q('#boards').append(node('p',rows.length?'Letzter bekannter Stand · Dieser Bereich wird erneut geladen.':'Dieser Bereich ist gerade nicht erreichbar. Wir versuchen es automatisch erneut.','empty'));
    for(const row of rows){const item=node('article',undefined,'board');item.append(node('h2',row.name));item.append(node('p',kind==='placement'?`Platz ${row.rank||'–'}`:row.type==='HS'?`${row.count??1} × 180`:row.type==='HF'?`High Finish: ${row.value}`:`Shortgame: ${row.value} Darts`,'legs'));q('#boards').append(item);}
    if(!rows.length&&!data[key+'Unavailable'])q('#boards').append(node('p',kind==='placement'?'Noch keine offiziellen Platzierungen veröffentlicht.':'Noch keine Bestleistungen veröffentlicht.','empty'));
    q('#pageCount').textContent=`${rows.length} Einträge`;q('#previous').disabled=q('#next').disabled=true;
  }else if(tablesOnly){for(const item of tv?(group?[group]:[]):groups)q('#boards').append(table(item,groupPage,tv));if(!groups.length)q('#boards').append(node('p','Noch keine Gruppentabellen veröffentlicht.','empty'));q('#pageCount').textContent=tv?`Gruppe ${groupIndex+1} / ${groups.length}`:`${groups.length} Gruppen`;q('#previous').disabled=q('#next').disabled=!tv||!groups.length;}
  else{
    const items=kind==='participants'?data.participants:sorted(kind),paging=tv&&kind!=='participants',pages=Math.max(1,Math.ceil(items.length/size));page=((page%pages)+pages)%pages;q('#pageCount').textContent=paging?`${page+1} / ${pages}`:`${items.length} ${kind==='participants'?'Teilnehmer':'Spiele'}`;q('#previous').disabled=q('#next').disabled=!paging||pages===1;
    for(const item of paging?items.slice(page*size,(page+1)*size):items)q('#boards').append(kind==='participants'?node('article',item.name,'board'):card(item));
    if(!items.length)q('#boards').append(node('div',kind==='live'?(data.scheduleReady?'Gerade kein laufendes Spiel gemeldet. Neue Spiele erscheinen automatisch.':'Die Gruppen und Paarungen sind noch nicht veröffentlicht. Die Anzeige übernimmt sie automatisch, sobald 3K sie freigibt.'):kind==='upcoming'?'Noch keine kommenden Paarungen veröffentlicht.':'Noch keine Ergebnisse verfügbar.','empty'));
  }
  q('#results').replaceChildren(...sorted('final').slice(0,6).map(m=>node('div',`${m.home} ${m.homeLegs??'–'}:${m.awayLegs??'–'} ${m.away}`,'result')));
  q('#stage').style.setProperty('--stage-top',`${Math.ceil(q('#stage').getBoundingClientRect().top)}px`);
}
function announce(text){clearTimeout(highlightTimer);q('#highlight').textContent=text;q('#highlight').hidden=false;highlightTimer=setTimeout(()=>q('#highlight').hidden=true,15000);}
function changes(next){
  if(data&&(data.event.id!==next.event.id||data.event.database!==next.event.database)){previous.clear();initialized=false;page=groupIndex=groupPage=0;alternateTable=false;clearTimeout(highlightTimer);q('#highlight').hidden=true;}
  const notices=[];
  for(const m of next.matches){const old=previous.get(m.id);if(old&&initialized){if(m.kind==='final'&&old.kind!=='final'&&m.homeLegs!==null&&m.awayLegs!==null)notices.push(`${m.homeLegs>m.awayLegs?m.home:m.away} gewinnt · ${m.homeLegs}:${m.awayLegs}`);if(m.live&&old.live)for(const key of['home','guest']){const a=old.live[key],b=m.live[key];if(b.count180>a.count180)notices.push(`180 geworfen! ${b.name} · Board ${m.board}`);if(b.highFinish>a.highFinish&&b.highFinish>=100)notices.push(`High Finish ${b.highFinish} · ${b.name}`);if(b.legs>a.legs)notices.push(`Leg für ${b.name} · Board ${m.board}`);}}previous.set(m.id,m);}
  const ids=new Set(next.matches.map(m=>m.id));for(const id of previous.keys())if(!ids.has(id))previous.delete(id);initialized=true;if(notices.length)announce(notices.slice(0,3).join(' · '));
}
function accept(next){
  if(trainingPage&&!viewChosen&&(!data||data.event.id!==next.event.id)){q('#view').value=next.event.status==='FINISH'?(next.groups?.length?'groups':next.matches?.length?'final':'participants'):next.scheduleReady?'live':'participants';}
  if(trainingPage&&next.degraded){for(const key of ['performances','placements'])if(next[key+'Unavailable']&&data?.event.id===next.event.id)next[key]=data[key]||[];}
  if(trainingPage){const event={id:next.event.id,name:next.event.name,date:next.event.date,status:next.event.status,source:next.source};trainingCatalog={...(trainingCatalog||{}),events:[...new Map([...(trainingCatalog?.events||[]),event].map(e=>[e.id,e])).values()]};renderTrainingChoices();}
  if(!next.stale)changes(next);data=next;groupOptions();q('#eventTitle').textContent=data.event.name;q('#eventInfo').textContent=`${data.event.date?new Date(data.event.date).toLocaleDateString('de-DE',{timeZone:'Europe/Berlin'})+' · ':''}${data.participants.length} Teilnehmer · ${sorted('live').length} laufende Spiele · ${(data.groups||[]).length} ${(data.groups||[]).length===1?'Gruppe':'Gruppen'}`;
  q('#status').textContent=`${demo?'DEMO · Beispielstände':data.stale?'Letzter bekannter Stand':data.sourceConnection==='browser-3k'?'Direkt von 3K geladen':'3K-Daten aktualisiert'} · ${new Date(data.updatedAt).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin'})}`;q('#notice').textContent=data.stale?'3K ist gerade nicht erreichbar. Der letzte bekannte Stand bleibt sichtbar; wir versuchen es automatisch erneut.':data.degraded?'Einzelne Bereiche konnten nicht aktualisiert werden. Wir versuchen es automatisch erneut.':'';
  if(trainingPage&&!next.stale&&!next.degraded){try{localStorage.setItem(`clubiq_darts_training_event_${next.event.id}`,JSON.stringify(next));}catch(_){}}
  if(data.source&&/^https:\/\/portal\.3k-darts\.com\//.test(data.source))q('#source').href=data.source;render();
}
async function refresh(){
  if(busy||demo)return;busy=true;const version=selectionVersion,id=Number(selectedEvent||trainingCatalog?.selectedId||32260);requestController=new AbortController();
  if(trainingPage&&!data){try{const saved=JSON.parse(localStorage.getItem(`clubiq_darts_training_event_${id}`)||'null');if(saved?.event?.id===id)accept({...saved,stale:true});}catch(_){}}
  try{
    let next;const timeout=setTimeout(()=>requestController.abort(),trainingPage?5000:30000);
    try{const response=await fetch((trainingPage?'/api/v1/darts/training':'/api/v1/darts/tournament')+(trainingPage?`?event_id=${id}`:selectedEvent?`?event_id=${selectedEvent}`:''),{cache:'no-store',signal:requestController.signal});if(!response.ok)throw Error('feed');next=await response.json();if(!next.event||!Array.isArray(next.matches)||!Array.isArray(next.groups)||!Array.isArray(next.participants)||trainingPage&&next.event.id!==id)throw Error('Invalid event');}catch(error){if(!trainingPage||version!==selectionVersion)throw error;}finally{clearTimeout(timeout);}
    if(version!==selectionVersion)return;
    if(trainingPage&&(!next||next.stale)){try{requestController=new AbortController();next=await window.DartsTrainingSource.loadEvent(id,requestController.signal);}catch(error){if(!next)throw error;}}
    if(version===selectionVersion)accept(next);
  }catch(_){if(version!==selectionVersion)return;q('#status').textContent='Verbindung wird erneut versucht';q('#notice').textContent=data?'Die letzten Daten bleiben sichtbar. Automatische Neuverbindung läuft.':'3K ist vorübergehend nicht erreichbar. Automatische Neuverbindung läuft.';}finally{busy=false;if(version!==selectionVersion)refresh();}
}
function tournamentLink(){q('#tvLink').href=(trainingPage?'/training':'/turnier')+'?tv=1'+(selectedEvent?`&event=${selectedEvent}`:'');}
function renderTrainingChoices(){
  if(!trainingPage)return;
  const select=q('#tournamentChoice');select.replaceChildren(Object.assign(node('option','Aktuelles Training automatisch'),{value:''}));
  for(const event of [...(trainingCatalog?.events||[])].sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)))select.append(Object.assign(node('option',event.name),{value:String(event.id)}));
  if(selectedEvent&&![...select.options].some(o=>o.value===selectedEvent))select.append(Object.assign(node('option','Ausgewähltes Training'),{value:selectedEvent}));select.value=selectedEvent;
}
async function loadTrainingChoices(force=false){
  if(trainingSearchBusy||!force&&Date.now()-trainingSearchAt<300000)return;
  trainingSearchBusy=true;trainingSearchAt=Date.now();q('#findTrainings').disabled=true;q('#trainingSearchStatus').textContent='Trainings werden gesucht …';
  try{
    if(!Array.isArray(trainingCatalog?.events)){try{const r=await fetch('/static/darts-trainings.json',{signal:AbortSignal.timeout(2000)});if(r.ok)trainingCatalog=await r.json();}catch(_){} }
    renderTrainingChoices();const previousId=trainingCatalog?.selectedId;let incoming;
    try{const r=await fetch('/api/v1/darts/trainings'+(force?'?refresh=true':''),{cache:'no-store',signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();incoming=await r.json();if(!Array.isArray(incoming.events))throw Error();}catch(_){}
    if(!incoming||incoming.stale){try{incoming=await window.DartsTrainingSource.discover(trainingCatalog?.events||[]);}catch(_){if(!incoming)throw Error();}}
    const events=[...new Map([...(trainingCatalog?.events||[]),...incoming.events].map(e=>[e.id,e])).values()];
    trainingCatalog={...incoming,updatedAt:incoming.updatedAt||trainingCatalog?.updatedAt,events,...window.DartsTrainingSource.select(events)};renderTrainingChoices();
    if(!incoming.stale){try{localStorage.setItem('clubiq_darts_training_catalog',JSON.stringify(trainingCatalog));}catch(_){} }
    const checked=new Date(incoming.updatedAt).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});
    q('#trainingSearchStatus').textContent=incoming.stale?'3K ist gerade nicht erreichbar. Die bekannten Trainings bleiben auswählbar.':`${events.length} Trainings gefunden · Suche um ${checked} Uhr. ${events.some(e=>e.id===trainingCatalog.selectedId&&['ACTIVE','RUNNING','STARTED'].includes(e.status))?'Ein laufendes Training ist verfügbar.':trainingCatalog.nextId?'Das nächste veröffentlichte Training ist verfügbar.':'Noch kein neues Training bei 3K veröffentlicht. Angezeigt wird das letzte bekannte Training.'}`;
    if(!selectedEvent&&previousId!==trainingCatalog.selectedId&&trainingCatalog.selectedId)chooseEvent('');
  }catch(_){q('#trainingSearchStatus').textContent='Die Suche ist gerade nicht erreichbar. Vorhandene Trainings bleiben auswählbar; bitte später erneut versuchen.';renderTrainingChoices();}
  finally{trainingSearchBusy=false;q('#findTrainings').disabled=false;scheduleTrainingSearch();}
}
function scheduleTrainingSearch(){
  clearTimeout(trainingSearchTimer);if(!trainingPage||demo||!q('#autoTrainingSearch').checked)return;
  trainingSearchTimer=setTimeout(()=>{if(!document.hidden)loadTrainingChoices();else trainingSearchTimer=setTimeout(scheduleTrainingSearch,300000);},Math.max(1,300000-(Date.now()-trainingSearchAt)));
}
async function loadTournamentChoices(){
  if(demo)return;
  if(trainingPage)return loadTrainingChoices();
  try{const response=await fetch('/api/v1/darts/ranking');if(!response.ok)return;const ranking=await response.json();const group=document.createElement('optgroup');group.label=ranking.name;for(const event of [...ranking.events].sort((a,b)=>Date.parse(b.start)-Date.parse(a.start))){const option=node('option',event.name);option.value=String(event.id);group.append(option);}q('#tournamentChoice').append(group);if(selectedEvent&&ranking.events.some(event=>String(event.id)===selectedEvent))q('#tournamentChoice').value=selectedEvent;}catch(_){}
}
function chooseEvent(value){selectedEvent=value;selectionVersion++;requestController?.abort();viewChosen=false;alternateTable=false;clearTimeout(highlightTimer);q('#highlight').hidden=true;params.delete('event');if(selectedEvent)params.set('event',selectedEvent);history.replaceState(null,'',location.pathname+(params.size?'?'+params.toString():''));tournamentLink();data=null;previous.clear();initialized=false;page=groupIndex=groupPage=0;q('#boards').replaceChildren();q('#results').replaceChildren();q('#groupTable').replaceChildren();q('#groupChoice').replaceChildren(node('option','Alle Gruppen · wechselnd'));q('#groupChoice').firstChild.value='auto';q('#eventTitle').textContent=trainingPage?'Training wird geladen …':'Turnier wird geladen …';q('#eventInfo').textContent='';q('#source').removeAttribute('href');q('#notice').textContent='';refresh();}
q('#tournamentChoice').addEventListener('change',()=>chooseEvent(q('#tournamentChoice').value));
tournamentLink();q('#tournamentChoice').disabled=demo;if(selectedEvent)q('#eventTitle').textContent='Turnier wird geladen …';loadTournamentChoices();
if(trainingPage&&!demo){
  if(selectedEvent)q('#eventTitle').textContent='Training wird geladen …';
  q('#findTrainings').addEventListener('click',()=>loadTrainingChoices(true));
  q('#autoTrainingSearch').addEventListener('change',()=>{try{localStorage.setItem('clubiq_darts_training_auto',q('#autoTrainingSearch').checked?'on':'off');}catch(_){} scheduleTrainingSearch();});
  scheduleTrainingSearch();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&q('#autoTrainingSearch').checked){loadTrainingChoices();refresh();}});
  q('#trainingLinkForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=q('#trainingLinkForm button');button.disabled=true;q('#trainingLinkError').hidden=true;
    try{
      const id=window.DartsTrainingSource.source(q('#trainingLink').value),next=await window.DartsTrainingSource.loadEvent(id);
      selectedEvent=String(id);selectionVersion++;requestController?.abort();viewChosen=false;data=null;previous.clear();initialized=false;
      params.set('event',selectedEvent);history.replaceState(null,'',location.pathname+'?'+params.toString());tournamentLink();accept(next);
      try{localStorage.setItem('clubiq_darts_training',next.source);localStorage.setItem('clubiq_darts_training_catalog',JSON.stringify(trainingCatalog));}catch(_){}
      q('#trainingLinkForm').closest('details').open=false;
    }catch(error){q('#trainingLinkError').textContent=error.message;q('#trainingLinkError').hidden=false;}
    finally{button.disabled=false;}
  });
}
function advanceGroup(direction=1){const group=currentGroup(),pages=Math.max(1,Math.ceil((group?.entries.length||0)/8));if(direction===1&&groupPage+1<pages)groupPage++;else{groupPage=0;if(q('#groupChoice').value==='auto')groupIndex+=direction;}render();}
q('#view').addEventListener('change',()=>{viewChosen=true;page=0;alternateTable=false;render();});q('#pageSize').addEventListener('change',()=>{page=0;render();});q('#tableMode').addEventListener('change',()=>{alternateTable=false;render();});q('#groupChoice').addEventListener('change',()=>{groupPage=0;render();});q('#rotate').addEventListener('change',render);
q('#previous').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')){q('#groupChoice').value='auto';advanceGroup(-1);}else{page--;render();}});q('#next').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')){q('#groupChoice').value='auto';advanceGroup();}else{page++;render();}});q('#groupPrevious').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup(-1);});q('#groupNext').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup();});
q('#fullscreen').addEventListener('click',async()=>{tv=true;document.body.classList.add('tv');try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(_){q('#notice').textContent='TV-Ansicht aktiv. Vollbild ist in diesem Browser nicht verfügbar.';}render();});
document.addEventListener('fullscreenchange',()=>{tv=initialTv||!!document.fullscreenElement;document.body.classList.toggle('tv',tv);render();});window.addEventListener('online',refresh);
setInterval(()=>{if(!document.hidden)refresh();},15000);setInterval(()=>{if(tv&&q('#rotate').checked&&!document.hidden&&!(demo&&demoPaused)){page++;render();}},12000);
setInterval(()=>{if(!q('#rotate').checked||document.hidden||(demo&&demoPaused))return;advanceGroup();if(tv&&q('#tableMode').value==='alternate'){alternateTable=!alternateTable;render();}},20000);
window.addEventListener('resize',render);
if(demo){
  q('#demoPanel').hidden=false;import('/static/darts-tournament-demo.js?v=20261003-2').then(({demoData})=>{const tick=()=>accept(demoData(demoTick++));tick();setInterval(()=>{if(!demoPaused&&!document.hidden)tick();},4000);q('#demoPause').addEventListener('click',()=>{demoPaused=!demoPaused;q('#demoPause').textContent=demoPaused?'Demo fortsetzen':'Demo pausieren';});q('#demoHighlight').addEventListener('click',()=>announce('DEMO · 180 geworfen! Jannik Beispiel · Board 1'));q('#demoLeg').addEventListener('click',()=>announce('DEMO · Leg für Patrick Beispiel · Board 2'));}).catch(()=>{q('#notice').textContent='Demo konnte nicht geladen werden.';});
}else refresh();
