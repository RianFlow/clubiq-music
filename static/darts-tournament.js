'use strict';
const q=s=>document.querySelector(s), params=new URLSearchParams(location.search), initialTv=params.get('tv')==='1';
const trainingPage=['/training','/app/training'].includes(location.pathname);
let trainingCatalog=null,trainingSearchBusy=false,trainingSearchAt=0,trainingSearchTimer,requestController=null,viewChosen=false;
// No production subscriptions or network calls in the localhost-only demo.
const demo=['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&params.get('demo')==='tournament';
let selectedEvent=/^[1-9][0-9]*$/.test(params.get('event')||'')?params.get('event'):'',selectionVersion=0;
if(trainingPage){
  document.title='Barver Darts · Training';q('.brand').lastChild.textContent='Training';q('.eyebrow').textContent='Barver Darts · Unser Training';q('#eventTitle').textContent='Vereinstraining';q('#eventInfo').textContent='Trainingsdaten werden geladen …';q('#trainingControls').hidden=false;q('#eventChoiceLabel').textContent='Training';q('#tournamentChoice option').textContent='Aktuelles Training automatisch';q('#source').textContent='Offizielle Trainingsseite ↗';
  try{trainingCatalog=JSON.parse(localStorage.getItem('clubiq_darts_training_catalog')||'null');q('#autoTrainingSearch').checked=localStorage.getItem('clubiq_darts_training_auto')!=='off';}catch(_){}
}else for(const option of q('#view').querySelectorAll('[value=performances],[value=placement],[value=summary]'))option.remove();
let tv=initialTv,data=null,page=0,groupIndex=0,groupPage=0,alternateTable=false,busy=false,previous=new Map(),initialized=false,highlightTimer,demoPaused=false,demoTick=0;
const boardHighlights=new Map(),panelStorage='clubiq_darts_board_panels_v1';
let summaryAutoSelected=false,lastSummaryDue=null;
let panelState={};try{const saved=JSON.parse(localStorage.getItem(panelStorage)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))panelState=saved;}catch(_){}
document.body.classList.toggle('tv',tv);document.body.classList.toggle('demo',demo);
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function average(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=180?value.toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1}):'–';}
function highlightClass(label){return 'training-highlight achievement-'+(label==='180er'?'180':label.includes('Finish')?'finish':'shortgame');}
function savePanels(){try{localStorage.setItem(panelStorage,JSON.stringify(panelState));}catch(_){}}
function displayPanels(){
  const displayOpen=panelState.display!==false,highlightsOpen=panelState.highlights!==false;
  q('#displayControlsFields').hidden=!displayOpen;q('#displayCollapsedSummary').hidden=displayOpen;
  q('#toggleDisplayControls').textContent=displayOpen?'Bedienung einklappen':'Bedienung aufklappen';q('#toggleDisplayControls').setAttribute('aria-expanded',String(displayOpen));
  q('#trainingHighlightCards').hidden=!highlightsOpen;q('#toggleTrainingHighlights').textContent=highlightsOpen?'Einklappen':'Aufklappen';q('#toggleTrainingHighlights').setAttribute('aria-expanded',String(highlightsOpen));
  q('#trainingHighlights').classList.toggle('is-collapsed',!highlightsOpen);
}
q('#trainingControls').open=panelState.search!==false;displayPanels();
q('#trainingControls').addEventListener('toggle',()=>{panelState.search=q('#trainingControls').open;savePanels();render();});
q('#toggleDisplayControls').addEventListener('click',()=>{panelState.display=panelState.display===false;savePanels();displayPanels();render();});
q('#toggleTrainingHighlights').addEventListener('click',()=>{panelState.highlights=panelState.highlights===false;savePanels();displayPanels();render();});
function sorted(kind){return(data?.matches||[]).filter(m=>m.kind===kind).sort((a,b)=>kind==='final'?String(b.updatedAt).localeCompare(String(a.updatedAt)):String(a.board).localeCompare(String(b.board),'de',{numeric:true})||a.id-b.id);}
function rememberBoardHighlight(match,text){
  const entry={text,expiresAt:Date.now()+15000,animate:true};boardHighlights.set(match.id,entry);
  setTimeout(()=>{if(boardHighlights.get(match.id)===entry){boardHighlights.delete(match.id);render();}},15000);
}
function boardHighlightsView(match){
  const root=node('div',undefined,'board-highlights'),entry=boardHighlights.get(match.id);
  root.append(node('small','Highlights im Spiel','board-highlights-label'));
  if(entry&&entry.expiresAt>Date.now()){
    const type=entry.text.startsWith('180 geworfen!')?'180':entry.text.startsWith('High Finish')?'finish':'other';
    const notice=node('strong',entry.text,'board-highlight-notice achievement-'+type+(entry.animate?' is-new':''));notice.title=entry.text;entry.animate=false;root.append(notice);
  }else{
    const counters=node('div',undefined,'board-highlight-counters');
    // Live counters belong to this match, not necessarily to its current leg.
    // Training-wide performances cannot safely be assigned to an individual board.
    for(const [name,side]of[[match.home,match.live?.home],[match.away,match.live?.guest]]){
      const values=[];if(Number.isInteger(side?.count180)&&side.count180>0)values.push({text:`${side.count180} × 180`,type:'180'});if(Number.isFinite(side?.highFinish)&&side.highFinish>=100)values.push({text:`HF ${side.highFinish}`,type:'finish'});
      if(values.length){const chip=node('span',undefined,'board-highlight-counter');chip.title=`${name}: ${values.map(value=>value.text).join(' · ')}`;chip.append(node('span',name,'board-highlight-name'));for(const value of values)chip.append(node('strong',value.text,'achievement-score achievement-'+value.type));counters.append(chip);}
    }
    root.append(counters.childElementCount?counters:node('span',match.live?'Noch keine Bestleistungen gemeldet.':'Highlights warten auf 3K-Daten.','board-highlight-empty'));
  }
  return root;
}
function card(m){
  const n=node('article',undefined,'board'),head=node('div',undefined,'board-head');
  head.append(node('strong',m.board?`Board ${m.board}`:'Board noch offen'),node('span',m.kind==='live'?'LIVE':m.kind==='final'?'ENDSTAND':m.round||m.phase,m.kind==='live'?'live-badge':''));n.append(head);
  for(const[i,name,side]of[[0,m.home,m.live?.home],[1,m.away,m.live?.guest]]){const row=node('div',undefined,'player'+(m.live?.currentPlayerIndex===i?' throwing':'')),identity=node('span',undefined,'player-identity'),stats=node('span',undefined,'player-live');identity.append(node('span',name,'player-name'));if(m.kind==='live'){const avg=node('small',`AVG ${average(side?.average)}`,'player-average');avg.title='3-Dart-Average im gesamten Spiel';identity.append(avg);}stats.append(node('strong',side?.points??'–','points'));if(Number.isInteger(side?.darts))stats.append(node('small',`${side.darts} Darts`,'darts-count'));row.append(identity,stats);n.append(row);}
  n.append(node('div',`Legs ${m.live?.home?.legs??m.homeLegs??'–'} : ${m.live?.guest?.legs??m.awayLegs??'–'}`,'legs'));
  if(m.kind==='live'||boardHighlights.has(m.id))n.append(boardHighlightsView(m));
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
function renderHighlights(sidebar){
  const root=q('#trainingHighlights');if(!root)return;
  const inSidebar=tv&&sidebar&&matchMedia('(min-width:1101px)').matches;
  root.classList.toggle('in-sidebar',inSidebar);
  if(inSidebar){if(root.parentElement!==q('#groupSidebar'))q('#groupSidebar').prepend(root);}else if(root.parentElement!==q('main'))q('main').insertBefore(root,q('#notice'));
  const rows=(data?.performances||[]).filter(row=>typeof row.name==='string'&&Number.isFinite(row.value)&&row.value>0),cards=[];
  const highs=rows.filter(row=>row.type==='HS'&&row.value===180),finishes=rows.filter(row=>row.type==='HF'&&row.value<=170).sort((a,b)=>b.value-a.value),shorts=rows.filter(row=>['SG','SGD'].includes(row.type)).sort((a,b)=>a.value-b.value);
  if(highs.length){const total=highs.reduce((sum,row)=>sum+(Number.isInteger(row.count)&&row.count>0?row.count:1),0);cards.push(['180er',`${total} × 180`,highs.length===1?highs[0].name:`${highs[0].name} u. a.`]);}
  if(finishes.length)cards.push(['High Finish',String(finishes[0].value),finishes[0].name]);
  if(shorts.length)cards.push([shorts[0].type==='SGD'?'Shortgame im Doppel':'Shortgame',`${shorts[0].value} Darts`,shorts[0].name]);
  root.hidden=!trainingPage||!cards.length||['performances','placement','summary'].includes(q('#view').value);q('#trainingHighlightCards').replaceChildren();
  q('#trainingHighlightsState').textContent=data?.stale||data?.performancesUnavailable?'Letzter bekannter Stand':'Offizielle Bestleistungen';
  for(const[label,value,name]of cards){const item=node('article',undefined,highlightClass(label));item.append(node('span',label,'highlight-label'),node('strong',value,'highlight-value'),node('span',name,'highlight-player'));q('#trainingHighlightCards').append(item);}
}
function trainingSummary(state){
  const root=node('section',undefined,'training-summary'),head=node('div',undefined,'summary-head'),intro=node('div');
  intro.append(node('p','Unser Trainingsabend','eyebrow'),node('h2',state.complete||state.due&&!state.live.length?'Trainingsrückblick':'Zwischenstand','summary-title'));
  const status=data.stale?'Letzter bekannter Stand · Die Verbindung wird erneut versucht.':state.live.length?`${state.live.length} ${state.live.length===1?'Spiel läuft':'Spiele laufen'} noch. Die Ergebnisse werden weiter aktualisiert.`:!state.complete&&state.upcoming.length?`Bei 3K ${state.upcoming.length===1?'ist':'sind'} noch ${state.upcoming.length} ${state.upcoming.length===1?'Begegnung':'Begegnungen'} offen. Hier stehen die bisher gemeldeten Ergebnisse.`:state.complete?'Die gemeldeten Ergebnisse und Bestleistungen im Überblick.':'Die Zusammenfassung wächst mit den Ergebnissen · automatisch ab 21:30 Uhr.';
  intro.append(node('p',status,'summary-status'));head.append(intro);
  if(state.live.length){const back=node('button','Zu den Live-Boards');back.type='button';back.addEventListener('click',()=>{q('#view').value='live';q('#view').dispatchEvent(new Event('change'));});head.append(back);}root.append(head);
  const stats=node('div',undefined,'summary-stats');
  for(const[label,value]of[['Teilnehmer',state.participants],['Beendete Spiele',state.finished.length],['Gemeldete Legs',state.legs??'–'],['Noch live',state.live.length]]){const item=node('div',undefined,'summary-stat');item.append(node('strong',value),node('span',label));stats.append(item);}root.append(stats);
  const highlights=node('section',undefined,'summary-highlights');highlights.append(node('h3','Bestleistungen'));
  if(data.performancesUnavailable)highlights.append(node('p','Bestleistungen werden erneut geladen. Angezeigt wird der letzte bekannte Stand.','summary-status'));
  const cards=node('div',undefined,'training-highlight-cards');
  for(const item of window.DartsTrainingSummary.highlights(data)){const card=node('article',undefined,highlightClass(item.label));card.append(node('span',item.label,'highlight-label'),node('strong',item.value,'highlight-value'),node('span',item.name,'highlight-player'));cards.append(card);}
  highlights.append(cards.childElementCount?cards:node('p',data.performancesUnavailable?'Noch keine Bestleistungen verfügbar.':'Noch keine Bestleistungen von 3K gemeldet.','summary-status'));root.append(highlights);
  const columns=node('div',undefined,'summary-columns'),results=node('section',undefined,'summary-panel');results.append(node('h3','Zuletzt entschieden'));
  const matches=sorted('final');for(const match of matches.slice(0,tv?6:12)){const row=node('div',undefined,'summary-result');row.append(node('span',match.home),node('strong',`${match.homeLegs??'–'} : ${match.awayLegs??'–'}`),node('span',match.away));results.append(row);}
  if(!matches.length)results.append(node('p','Noch keine abgeschlossenen Begegnungen gemeldet.','summary-status'));
  const allResults=node('button','Alle Ergebnisse ansehen');allResults.type='button';allResults.addEventListener('click',()=>{q('#view').value='final';q('#view').dispatchEvent(new Event('change'));});results.append(allResults);columns.append(results);
  const standings=node('section',undefined,'summary-panel summary-standings'),placements=data.placements||[],groups=data.groups||[];
  if(placements.length){
    standings.append(node('h3','Offizielle Platzierungen'));if(data.placementsUnavailable)standings.append(node('p','Letzter bekannter Stand','summary-status'));
    const list=node('ol',undefined,'summary-placements');for(const row of tv?placements.slice(0,8):placements){const item=node('li');item.append(node('strong',row.rank||'–'),node('span',row.name));list.append(item);}standings.append(list);
    const all=node('button','Alle Platzierungen ansehen');all.type='button';all.addEventListener('click',()=>{q('#view').value='placement';q('#view').dispatchEvent(new Event('change'));});standings.append(all);
  }else if(groups.length){
    standings.append(node('h3','Gruppentabellen'));for(const group of tv?[currentGroup()]:groups)standings.append(table(group,groupPage,tv));
    if(tv&&groups.length>1)standings.append(node('p',`Gruppe ${groupIndex+1} von ${groups.length}${q('#rotate').checked?' · automatischer Wechsel':''}`,'summary-status'));
  }else standings.append(node('h3','Tabellen & Platzierungen'),node('p','Noch nicht von 3K veröffentlicht.','summary-status'));
  columns.append(standings);root.append(columns);return root;
}
function render(){
  if(!data)return;const summary=trainingPage?window.DartsTrainingSummary.overview(data):null;
  if(summary){
    lastSummaryDue=summary.due;
    if(summary.automatic&&(!viewChosen||q('#view').value==='live')){q('#view').value='summary';summaryAutoSelected=true;}
    else if(summaryAutoSelected&&!summary.automatic){q('#view').value=summary.live.length?'live':data.scheduleReady?'upcoming':'participants';summaryAutoSelected=false;}
    q('#trainingWrapUp').hidden=!summary.due||q('#view').value==='summary';q('#trainingWrapUpStatus').textContent=data.stale?'Der letzte bekannte Stand bleibt verfügbar.':summary.live.length?`${summary.live.length} ${summary.live.length===1?'Spiel läuft':'Spiele laufen'} noch · Die Live-Anzeige bleibt aktiv.`:summary.upcoming.length?'Weitere Begegnungen sind noch offen.':'Ergebnisse und Bestleistungen des Trainings ansehen.';
  }
  const kind=q('#view').value,size=Number(q('#pageSize').value),groups=data.groups||[];
  const tablesOnly=kind==='groups'||(tv&&kind==='live'&&q('#tableMode').value==='alternate'&&alternateTable),sidebar=!tablesOnly&&!['participants','performances','placement','summary'].includes(kind)&&q('#tableMode').value==='sidebar';
  q('#stage').classList.toggle('with-sidebar',sidebar);q('#groupSidebar').hidden=!sidebar;q('#boards').classList.toggle('tables-only',tablesOnly);document.body.classList.toggle('compact',tv&&(size>=12||sidebar));q('#boards').replaceChildren();
  q('#boards').classList.toggle('summary-view',kind==='summary');document.body.classList.toggle('training-recap',kind==='summary');
  renderHighlights(sidebar);
  document.body.classList.toggle('many-boards',tv&&size>=12);
  const group=currentGroup();q('#groupTable').replaceChildren(group?table(group,groupPage,true):node('p','Gruppen und Tabellen erscheinen hier, sobald 3K sie veröffentlicht.','group-empty'));
  if(kind==='summary'){
    q('#boards').append(trainingSummary(summary));q('#pageCount').textContent=tv&&groups.length&&!data.placements?.length?`Gruppe ${groupIndex+1} / ${groups.length}`:'Trainingsrückblick';q('#previous').disabled=q('#next').disabled=!tv||!groups.length||!!data.placements?.length;
  }else if(kind==='performances'||kind==='placement'){
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
  q('#displayCollapsedSummary').textContent=q('#view').selectedOptions[0].textContent;
  q('#stage').style.setProperty('--stage-top',`${Math.ceil(q('#stage').getBoundingClientRect().top)}px`);
}
function announce(text){clearTimeout(highlightTimer);q('#highlight').textContent=text;q('#highlight').hidden=false;highlightTimer=setTimeout(()=>q('#highlight').hidden=true,15000);}
function changes(next){
  if(data&&(data.event.id!==next.event.id||data.event.database!==next.event.database)){previous.clear();boardHighlights.clear();initialized=false;page=groupIndex=groupPage=0;alternateTable=false;clearTimeout(highlightTimer);q('#highlight').hidden=true;}
  const notices=[];
  const notice=(match,text)=>{notices.push(text);rememberBoardHighlight(match,text);};
  for(const m of next.matches){const old=previous.get(m.id);if(old&&initialized){if(m.kind==='final'&&old.kind!=='final'&&Number.isFinite(m.homeLegs)&&Number.isFinite(m.awayLegs))notice(m,`${m.homeLegs>m.awayLegs?m.home:m.away} gewinnt · ${m.homeLegs}:${m.awayLegs}`);if(m.live&&old.live)for(const key of['home','guest']){const a=old.live[key],b=m.live[key];if(b.count180>a.count180)notice(m,`180 geworfen! ${b.name} · Board ${m.board}`);if(b.highFinish>a.highFinish&&b.highFinish>=100)notice(m,`High Finish ${b.highFinish} · ${b.name}`);if(b.legs>a.legs)notice(m,`Leg für ${b.name} · Board ${m.board} · AVG ${average(b.average)}`);}}previous.set(m.id,m);}
  if(trainingPage&&data&&initialized&&data.event.id===next.event.id&&!data.performancesUnavailable&&!next.performancesUnavailable){for(const row of next.performances||[]){if(!['SG','SGD'].includes(row.type)||!Number.isFinite(row.value)||row.value<=0)continue;const before=(data.performances||[]).find(old=>old.type===row.type&&old.name===row.name&&old.value===row.value);if(!before||(row.count??1)>(before.count??1))notices.push(`Shortgame: ${row.value} Darts · ${row.name}`);}}
  const ids=new Set(next.matches.map(m=>m.id));for(const id of previous.keys())if(!ids.has(id))previous.delete(id);initialized=true;if(notices.length)announce(notices.slice(0,3).join(' · '));
}
function accept(next){
  if(trainingPage&&!viewChosen&&(!data||data.event.id!==next.event.id)){summaryAutoSelected=false;q('#view').value=next.event.status==='FINISH'?(next.groups?.length?'groups':next.matches?.length?'final':'participants'):next.scheduleReady?'live':'participants';}
  if(trainingPage&&next.degraded){for(const key of ['performances','placements'])if(next[key+'Unavailable']&&data?.event.id===next.event.id)next[key]=data[key]||[];}
  if(trainingPage){const event={id:next.event.id,name:next.event.name,date:next.event.date,status:next.event.status,source:next.source};trainingCatalog={...(trainingCatalog||{}),events:[...new Map([...(trainingCatalog?.events||[]),event].map(e=>[e.id,e])).values()]};renderTrainingChoices();}
  if(!next.stale)changes(next);data=next;groupOptions();q('#eventTitle').textContent=data.event.name;q('#eventInfo').textContent=`${data.event.date?new Date(data.event.date).toLocaleDateString('de-DE',{timeZone:'Europe/Berlin'})+' · ':''}${data.participants.length} Teilnehmer · ${sorted('live').length} laufende Spiele · ${(data.groups||[]).length} ${(data.groups||[]).length===1?'Gruppe':'Gruppen'}`;
  q('#status').textContent=`${demo?'DEMO · Beispielstände':data.stale?'Letzter bekannter Stand':data.sourceConnection==='browser-3k'?'Direkt von 3K geladen':'3K-Daten aktualisiert'} · ${new Date(data.updatedAt).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin'})}`;q('#notice').textContent=data.stale?'3K ist gerade nicht erreichbar. Der letzte bekannte Stand bleibt sichtbar; wir versuchen es automatisch erneut.':data.degraded?'Einzelne Bereiche konnten nicht aktualisiert werden. Wir versuchen es automatisch erneut.':'';
  if(trainingPage&&!next.stale&&!next.degraded){try{localStorage.setItem(`clubiq_darts_training_event_${next.event.id}`,JSON.stringify(next));}catch(_){}}
  if(data.source&&/^https:\/\/portal\.3k-darts\.com\//.test(data.source))q('#source').href=data.source;render();
}
async function refresh(){
  if(busy||demo)return;busy=true;const version=selectionVersion,id=Number(selectedEvent||trainingCatalog?.selectedId||32751);requestController=new AbortController();
  if(trainingPage&&!data){try{const saved=JSON.parse(localStorage.getItem(`clubiq_darts_training_event_${id}`)||'null');if(saved?.event?.id===id)accept({...saved,stale:true});}catch(_){}}
  try{
    let next;const timeout=setTimeout(()=>requestController.abort(),trainingPage?5000:30000);
    try{const response=await fetch((trainingPage?'/api/v1/darts/training':'/api/v1/darts/tournament')+(trainingPage?`?event_id=${id}`:selectedEvent?`?event_id=${selectedEvent}`:''),{cache:'no-store',signal:requestController.signal});if(!response.ok)throw Error('feed');next=await response.json();if(!next.event||!Array.isArray(next.matches)||!Array.isArray(next.groups)||!Array.isArray(next.participants)||trainingPage&&next.event.id!==id)throw Error('Invalid event');}catch(error){if(!trainingPage||version!==selectionVersion)throw error;}finally{clearTimeout(timeout);}
    if(version!==selectionVersion)return;
    if(trainingPage&&(!next||next.stale)){try{requestController=new AbortController();next=await window.DartsTrainingSource.loadEvent(id,requestController.signal);}catch(error){if(!next)throw error;}}
    if(version===selectionVersion)accept(next);
  }catch(_){if(version!==selectionVersion)return;q('#status').textContent='Verbindung wird erneut versucht';q('#notice').textContent=data?'Die letzten Daten bleiben sichtbar. Automatische Neuverbindung läuft.':'3K ist vorübergehend nicht erreichbar. Automatische Neuverbindung läuft.';}finally{busy=false;if(version!==selectionVersion)refresh();}
}
function tournamentLink(){q('#tvLink').href=(location.pathname.startsWith('/app/')?'/app':'')+(trainingPage?'/training':'/turnier')+'?tv=1'+(selectedEvent?`&event=${selectedEvent}`:'');}
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
    renderTrainingChoices();let incoming;
    try{const r=await fetch('/api/v1/darts/trainings'+(force?'?refresh=true':''),{cache:'no-store',signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();incoming=await r.json();if(!Array.isArray(incoming.events))throw Error();}catch(_){}
    if(!incoming||incoming.stale){try{incoming=await window.DartsTrainingSource.discover(trainingCatalog?.events||[]);}catch(_){if(!incoming)throw Error();}}
    const events=[...new Map([...(trainingCatalog?.events||[]),...incoming.events].map(e=>[e.id,e])).values()];
    trainingCatalog={...incoming,updatedAt:incoming.updatedAt||trainingCatalog?.updatedAt,events,...window.DartsTrainingSource.select(events)};renderTrainingChoices();
    if(!incoming.stale){try{localStorage.setItem('clubiq_darts_training_catalog',JSON.stringify(trainingCatalog));}catch(_){} }
    const checked=new Date(incoming.updatedAt).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});
    q('#trainingSearchStatus').textContent=incoming.stale?'3K ist gerade nicht erreichbar. Die bekannten Trainings bleiben auswählbar.':`${events.length} Trainings gefunden · Suche um ${checked} Uhr. ${events.some(e=>e.id===trainingCatalog.selectedId&&['ACTIVE','RUNNING','STARTED'].includes(e.status))?'Ein laufendes Training ist verfügbar.':trainingCatalog.nextId?'Das nächste veröffentlichte Training ist verfügbar.':'Noch kein neues Training bei 3K veröffentlicht. Angezeigt wird das letzte bekannte Training.'}`;
    if(!selectedEvent&&trainingCatalog.selectedId&&data?.event.id!==trainingCatalog.selectedId)chooseEvent('');
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
function chooseEvent(value){summaryAutoSelected=false;q('#trainingWrapUp').hidden=true;q('#trainingHighlights').hidden=true;selectedEvent=value;selectionVersion++;requestController?.abort();viewChosen=false;alternateTable=false;clearTimeout(highlightTimer);q('#highlight').hidden=true;params.delete('event');if(selectedEvent)params.set('event',selectedEvent);history.replaceState(null,'',location.pathname+(params.size?'?'+params.toString():''));tournamentLink();data=null;previous.clear();boardHighlights.clear();initialized=false;page=groupIndex=groupPage=0;q('#boards').replaceChildren();q('#results').replaceChildren();q('#groupTable').replaceChildren();q('#groupChoice').replaceChildren(node('option','Alle Gruppen · wechselnd'));q('#groupChoice').firstChild.value='auto';q('#eventTitle').textContent=trainingPage?'Training wird geladen …':'Turnier wird geladen …';q('#eventInfo').textContent='';q('#source').removeAttribute('href');q('#notice').textContent='';refresh();}
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
      selectedEvent=String(id);selectionVersion++;requestController?.abort();viewChosen=false;data=null;previous.clear();boardHighlights.clear();initialized=false;
      params.set('event',selectedEvent);history.replaceState(null,'',location.pathname+'?'+params.toString());tournamentLink();accept(next);
      try{localStorage.setItem('clubiq_darts_training',next.source);localStorage.setItem('clubiq_darts_training_catalog',JSON.stringify(trainingCatalog));}catch(_){}
      q('#trainingLinkForm').closest('details').open=false;
    }catch(error){q('#trainingLinkError').textContent=error.message;q('#trainingLinkError').hidden=false;}
    finally{button.disabled=false;}
  });
}
function advanceGroup(direction=1){const group=currentGroup(),pages=Math.max(1,Math.ceil((group?.entries.length||0)/8));if(direction===1&&groupPage+1<pages)groupPage++;else{groupPage=0;if(q('#groupChoice').value==='auto')groupIndex+=direction;}render();}
q('#view').addEventListener('change',()=>{viewChosen=true;summaryAutoSelected=false;page=0;alternateTable=false;render();});q('#pageSize').addEventListener('change',()=>{page=0;render();});q('#tableMode').addEventListener('change',()=>{alternateTable=false;render();});q('#groupChoice').addEventListener('change',()=>{groupPage=0;render();});q('#rotate').addEventListener('change',render);
q('#showTrainingHighlights')?.addEventListener('click',()=>{q('#view').value='performances';q('#view').dispatchEvent(new Event('change'));});
q('#showTrainingSummary').addEventListener('click',()=>{q('#view').value='summary';q('#view').dispatchEvent(new Event('change'));});
q('#previous').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')||q('#view').value==='summary'){q('#groupChoice').value='auto';advanceGroup(-1);}else{page--;render();}});q('#next').addEventListener('click',()=>{if(q('#boards').classList.contains('tables-only')||q('#view').value==='summary'){q('#groupChoice').value='auto';advanceGroup();}else{page++;render();}});q('#groupPrevious').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup(-1);});q('#groupNext').addEventListener('click',()=>{q('#groupChoice').value='auto';advanceGroup();});
q('#fullscreen').addEventListener('click',async()=>{tv=true;document.body.classList.add('tv');try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(_){q('#notice').textContent='TV-Ansicht aktiv. Vollbild ist in diesem Browser nicht verfügbar.';}render();});
document.addEventListener('fullscreenchange',()=>{tv=initialTv||!!document.fullscreenElement;document.body.classList.toggle('tv',tv);render();});window.addEventListener('online',refresh);
setInterval(()=>{if(!document.hidden){if(trainingPage&&data&&window.DartsTrainingSummary.overview(data).due!==lastSummaryDue)render();refresh();}},15000);setInterval(()=>{if(tv&&q('#rotate').checked&&!document.hidden&&!(demo&&demoPaused)){page++;render();}},12000);
setInterval(()=>{if(!q('#rotate').checked||document.hidden||(demo&&demoPaused))return;advanceGroup();if(tv&&q('#tableMode').value==='alternate'){alternateTable=!alternateTable;render();}},20000);
window.addEventListener('resize',render);
if(demo){
  q('#demoPanel').hidden=false;import('/static/darts-tournament-demo.js?v=20261003-2').then(({demoData})=>{const tick=()=>accept(demoData(demoTick++));tick();setInterval(()=>{if(!demoPaused&&!document.hidden)tick();},4000);q('#demoPause').addEventListener('click',()=>{demoPaused=!demoPaused;q('#demoPause').textContent=demoPaused?'Demo fortsetzen':'Demo pausieren';});q('#demoHighlight').addEventListener('click',()=>announce('DEMO · 180 geworfen! Jannik Beispiel · Board 1'));q('#demoLeg').addEventListener('click',()=>announce('DEMO · Leg für Patrick Beispiel · Board 2'));}).catch(()=>{q('#notice').textContent='Demo konnte nicht geladen werden.';});
}else refresh();
