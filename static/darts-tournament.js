'use strict';
const q=s=>document.querySelector(s), params=new URLSearchParams(location.search), initialTv=params.get('tv')==='1';
// No production subscriptions or network calls in the localhost-only demo.
const demo=['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&params.get('demo')==='tournament';
let selectedEvent=/^[1-9][0-9]*$/.test(params.get('event')||'')?params.get('event'):'',selectionVersion=0;
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
  const tablesOnly=kind==='groups'||(tv&&kind==='live'&&q('#tableMode').value==='alternate'&&alternateTable),sidebar=!tablesOnly&&kind!=='participants'&&q('#tableMode').value==='sidebar';
  q('#stage').classList.toggle('with-sidebar',sidebar);q('#groupSidebar').hidden=!sidebar;q('#boards').classList.toggle('tables-only',tablesOnly);document.body.classList.toggle('compact',tv&&(size>=12||sidebar));q('#boards').replaceChildren();
  document.body.classList.toggle('many-boards',tv&&size>=12);
  const group=currentGroup();q('#groupTable').replaceChildren(group?table(group,groupPage,true):node('p','Gruppen und Tabellen erscheinen hier, sobald 3K sie veröffentlicht.','group-empty'));
  if(tablesOnly){for(const item of tv?(group?[group]:[]):groups)q('#boards').append(table(item,groupPage,tv));if(!groups.length)q('#boards').append(node('p','Noch keine Gruppentabellen veröffentlicht.','empty'));q('#pageCount').textContent=tv?`Gruppe ${groupIndex+1} / ${groups.length}`:`${groups.length} Gruppen`;q('#previous').disabled=q('#next').disabled=!tv||!groups.length;}
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
  if(!next.stale)changes(next);data=next;groupOptions();q('#eventTitle').textContent=data.event.name;q('#eventInfo').textContent=`${data.event.date?new Date(data.event.date).toLocaleDateString('de-DE')+' · ':''}${data.participants.length} Teilnehmer · ${sorted('live').length} laufende Spiele · ${(data.groups||[]).length} Gruppen`;
  q('#status').textContent=`${demo?'DEMO · Beispielstände':data.stale?'Letzter bekannter Stand':'3K-Daten aktualisiert'} · ${new Date(data.updatedAt).toLocaleTimeString('de-DE')}`;q('#notice').textContent=data.stale?'3K ist gerade nicht erreichbar. Der letzte bekannte Stand bleibt sichtbar; wir versuchen es automatisch erneut.':'';
  if(data.source&&/^https:\/\/portal\.3k-darts\.com\//.test(data.source))q('#source').href=data.source;render();
}
async function refresh(){
  if(busy||demo)return;busy=true;const version=selectionVersion;try{const response=await fetch('/api/v1/darts/tournament'+(selectedEvent?`?event_id=${selectedEvent}`:''),{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('feed');const next=await response.json();if(version===selectionVersion)accept(next);}catch(_){if(version!==selectionVersion)return;q('#status').textContent='Verbindung wird erneut versucht';q('#notice').textContent=data?'Die letzten Daten bleiben sichtbar. Automatische Neuverbindung läuft.':'3K ist vorübergehend nicht erreichbar. Automatische Neuverbindung läuft.';}finally{busy=false;if(version!==selectionVersion)refresh();}
}
function tournamentLink(){q('#tvLink').href='/turnier?tv=1'+(selectedEvent?`&event=${selectedEvent}`:'');}
async function loadTournamentChoices(){
  if(demo)return;
  try{const response=await fetch('/api/v1/darts/ranking');if(!response.ok)return;const ranking=await response.json();const group=document.createElement('optgroup');group.label=ranking.name;for(const event of [...ranking.events].sort((a,b)=>Date.parse(b.start)-Date.parse(a.start))){const option=node('option',event.name);option.value=String(event.id);group.append(option);}q('#tournamentChoice').append(group);if(selectedEvent&&ranking.events.some(event=>String(event.id)===selectedEvent))q('#tournamentChoice').value=selectedEvent;}catch(_){}
}
q('#tournamentChoice').addEventListener('change',()=>{selectedEvent=q('#tournamentChoice').value;selectionVersion++;alternateTable=false;clearTimeout(highlightTimer);q('#highlight').hidden=true;params.delete('event');if(selectedEvent)params.set('event',selectedEvent);history.replaceState(null,'',location.pathname+(params.size?'?'+params.toString():''));tournamentLink();data=null;previous.clear();initialized=false;page=groupIndex=groupPage=0;q('#boards').replaceChildren();q('#results').replaceChildren();q('#groupTable').replaceChildren();q('#groupChoice').replaceChildren(node('option','Alle Gruppen · wechselnd'));q('#groupChoice').firstChild.value='auto';q('#eventTitle').textContent='Turnier wird geladen …';q('#eventInfo').textContent='';q('#source').removeAttribute('href');q('#notice').textContent='';refresh();});
tournamentLink();q('#tournamentChoice').disabled=demo;if(selectedEvent)q('#eventTitle').textContent='Turnier wird geladen …';loadTournamentChoices();
function advanceGroup(direction=1){const group=currentGroup(),pages=Math.max(1,Math.ceil((group?.entries.length||0)/8));if(direction===1&&groupPage+1<pages)groupPage++;else{groupPage=0;if(q('#groupChoice').value==='auto')groupIndex+=direction;}render();}
q('#view').addEventListener('change',()=>{page=0;alternateTable=false;render();});q('#pageSize').addEventListener('change',()=>{page=0;render();});q('#tableMode').addEventListener('change',()=>{alternateTable=false;render();});q('#groupChoice').addEventListener('change',()=>{groupPage=0;render();});q('#rotate').addEventListener('change',render);
q('#previous').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')){q('#groupChoice').value='auto';advanceGroup(-1);}else{page--;render();}});q('#next').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')){q('#groupChoice').value='auto';advanceGroup();}else{page++;render();}});q('#groupPrevious').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup(-1);});q('#groupNext').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup();});
q('#fullscreen').addEventListener('click',async()=>{tv=true;document.body.classList.add('tv');try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(_){q('#notice').textContent='TV-Ansicht aktiv. Vollbild ist in diesem Browser nicht verfügbar.';}render();});
document.addEventListener('fullscreenchange',()=>{tv=initialTv||!!document.fullscreenElement;document.body.classList.toggle('tv',tv);render();});window.addEventListener('online',refresh);
setInterval(()=>{if(!document.hidden)refresh();},15000);setInterval(()=>{if(tv&&q('#rotate').checked&&!document.hidden&&!(demo&&demoPaused)){page++;render();}},12000);
setInterval(()=>{if(!q('#rotate').checked||document.hidden||(demo&&demoPaused))return;advanceGroup();if(tv&&q('#tableMode').value==='alternate'){alternateTable=!alternateTable;render();}},20000);
window.addEventListener('resize',render);
if(demo){
  q('#demoPanel').hidden=false;import('/static/darts-tournament-demo.js?v=20261003-2').then(({demoData})=>{const tick=()=>accept(demoData(demoTick++));tick();setInterval(()=>{if(!demoPaused&&!document.hidden)tick();},4000);q('#demoPause').addEventListener('click',()=>{demoPaused=!demoPaused;q('#demoPause').textContent=demoPaused?'Demo fortsetzen':'Demo pausieren';});q('#demoHighlight').addEventListener('click',()=>announce('DEMO · 180 geworfen! Jannik Beispiel · Board 1'));q('#demoLeg').addEventListener('click',()=>announce('DEMO · Leg für Patrick Beispiel · Board 2'));}).catch(()=>{q('#notice').textContent='Demo konnte nicht geladen werden.';});
}else refresh();
