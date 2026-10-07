import TrainingSource from '../../static/darts-training-source.js';
import {liveBoardView} from './model.js';

export function createTraining({node,button,get,read,store,render,onSettings}){
  let catalog=null,feed=null,live=null,selected='',tab='live',busy=false,liveBusy=false,error=false,controller=null,sequence=0;
  const day=value=>new Date(value).toLocaleDateString('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric'});
  const id=()=>Number(selected)||catalog?.selectedId||feed?.event?.id;
  const source=()=>TrainingSource;
  async function init(){
    catalog=await read('training-catalog',null);feed=await read('training-feed',null);live=await read('training-live',null);
    if(live)live={...live,stale:true};
  }
  function select(value){
    sequence++;controller?.abort();selected=String(value||'');feed=null;live=null;tab='live';error=false;render();refresh();
  }
  async function refresh(onlyLive=false){
    if(onlyLive){
      const eventId=id();if(liveBusy||!eventId)return;liveBusy=true;const ticket=sequence;
      try{const next=await get(`/api/v1/darts/training/live?event_id=${eventId}`);if(ticket!==sequence||next.eventId!==id())return;live=next;await store('training-live',next);render();}
      catch(_){if(ticket===sequence&&live){live={...live,stale:true};render();}}
      finally{liveBusy=false;}return;
    }
    if(busy)return;busy=true;const ticket=sequence;
    try{
      let next;try{next=await get('/api/v1/darts/trainings');}catch(_){}
      if(!next||next.stale){try{next=await source().discover(next?.events||catalog?.events||[]);}catch(_) {}}
      if(ticket!==sequence)return;
      if(next?.events){catalog=next;if(feed&&feed.event.id!==id())feed=null;if(live&&live.eventId!==id())live=null;await store('training-catalog',next);render();}
      const eventId=id();if(!eventId)throw Error('Noch kein Training hinterlegt.');
      // The independent live poll continues while full groups/results are loading.
      refresh(true);let result;
      try{result=await get(`/api/v1/darts/training?event_id=${eventId}`);}catch(_){}
      if(!result||result.stale){try{controller=new AbortController();result=await source().loadEvent(eventId,controller.signal);}catch(_) {}}
      if(ticket!==sequence||eventId!==id())return;
      if(!result?.event||result.event.id!==eventId)throw Error('Training gerade nicht erreichbar.');
      if(!result.degraded||!feed||feed.event.id!==eventId)feed=result;
      else feed={...result,groups:result.groups.length?result.groups:feed.groups,performances:result.performancesUnavailable?feed.performances:result.performances};
      if(feed.event.status==='FINISH'&&tab==='live')tab='groups';
      error=false;await store('training-feed',feed);render();
    }catch(_){if(ticket===sequence){error=true;render();}}
    finally{busy=false;if(ticket!==sequence)refresh();}
  }
  function boards(parent){
    const rows=(live?.matches||[]).filter(m=>m.active&&!m.finished);
    const uncertain=!live||live.stale||Date.now()-Date.parse(live.updatedAt)>30000;
    parent.append(node('p',uncertain?'Live-Verbindung wird erneut geprüft. Vorhandene Spielstände bleiben sichtbar.':'Spielstände werden automatisch alle 10 Sekunden aktualisiert.','muted training-note'));
    for(const raw of rows){
      const model=liveBoardView(raw,Date.now(),uncertain),card=node('article',undefined,'live-board'),head=node('div',undefined,'board-heading');
      head.append(node('strong','Board '+model.board),node('span',model.stale?'LETZTER STAND':'LIVE','badge '+(model.stale?'':'live')));card.append(head);
      card.append(node('small','Punkte im aktuellen Leg','points-label'));
      for(const p of model.players){const row=node('div',undefined,'live-player'+(p.throwing?' throwing':'')),copy=node('div');copy.append(node('strong',p.name));if(p.throwing)copy.append(node('small','● Am Wurf'));row.append(copy,node('strong',p.points===0?'CHECK':p.points??'–','live-points'));card.append(row);}
      card.append(node('div',`Legs ${model.players[0].legs??'–'} : ${model.players[1].legs??'–'}`,'live-legs'));
      card.append(node('small',model.players.map(p=>`${p.name}: Ø ${p.average??'–'}`).join(' · ')));parent.append(card);
    }
    if(!rows.length)parent.append(node('p',feed?.event?.status==='FINISH'?'Dieses Training ist beendet. Gruppen und Ergebnisse findest du oben.':!feed?'Trainingsdaten werden geladen …':'Gerade keine laufende Partie gemeldet.','empty'));
  }
  function groups(parent){
    for(const group of feed?.groups||[]){
      parent.append(node('h2',group.name));const wrap=node('div',undefined,'standings training-table'),table=node('table'),head=node('thead'),row=node('tr');
      table.append(node('caption','Sp. = Spiele · S = Siege · Pkt. = Punkte'));
      for(const title of ['Pl.','Spieler','Sp.','S','Pkt.','Legs']){const th=node('th',title);th.scope='col';row.append(th);}head.append(row);table.append(head);
      const body=node('tbody');for(const e of group.entries||[]){const line=node('tr'),name=node('th',e.name);name.scope='row';line.append(node('td',e.rank||'–'),name,node('td',e.played??'–'),node('td',e.wins??'–'),node('td',e.pointsFor==null?'–':`${e.pointsFor}:${e.pointsAgainst??'–'}`),node('td',e.legsFor==null?'–':`${e.legsFor}:${e.legsAgainst??'–'}`));body.append(line);}table.append(body);wrap.append(table);parent.append(wrap);
    }
    if(!(feed?.groups||[]).length)parent.append(node('p','Gruppen sind noch nicht veröffentlicht.','empty'));
  }
  function results(parent){
    const rows=new Map((feed?.matches||[]).filter(m=>m.kind==='final').map(m=>[String(m.id),m]));
    for(const b of live?.matches||[])if(b.finished)rows.set(b.matchKey,{id:b.matchKey,home:b.home.name,away:b.guest.name,homeLegs:b.home.legs,awayLegs:b.guest.legs,board:b.board});
    for(const m of rows.values()){const card=node('article',undefined,'card');card.append(node('small',m.round||('Board '+(m.board||'–'))),node('h3',`${m.home} ${m.homeLegs??'–'} : ${m.awayLegs??'–'} ${m.away}`));parent.append(card);}
    if(!rows.size)parent.append(node('p','Noch keine Ergebnisse veröffentlicht.','empty'));
  }
  function show(parent){
    const hero=node('section',undefined,'hero training-hero');hero.append(node('small','UNSER VEREINSTRAINING'),node('h1',feed?.event?.name||'Training'),node('p','Live-Partien, Gruppen und Ergebnisse.','muted'));parent.append(hero);
    const label=node('label',undefined,'filter training-choice'),choice=node('select');choice.dataset.focus='training-choice';label.append(node('span','Training'));
    for(const e of [{id:'',name:'Aktuelles Training automatisch'},...(catalog?.events||[])]){const option=node('option',e.id?e.name+' · '+day(e.date):e.name);option.value=String(e.id);choice.append(option);}
    if(selected&&![...choice.options].some(o=>o.value===selected))choice.append(Object.assign(node('option','Ausgewähltes Training'),{value:selected}));
    choice.value=selected;choice.addEventListener('change',()=>select(choice.value));label.append(choice);hero.append(label);
    hero.append(button(preferencesText(),onSettings,'compact-action'));
    if(error||feed?.stale)parent.append(node('p','Letzter bekannter Stand. Die Verbindung wird automatisch erneut geprüft.','muted training-note'));
    const tabs=node('div',undefined,'training-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','Trainingsansicht');
    for(const [key,title]of [['live','Live'],['groups','Gruppen'],['results','Ergebnisse'],['players','Teilnehmer'],['performances','Bestleistungen']]){const b=button(title,()=>{tab=key;render();},'training-tab');b.setAttribute('aria-pressed',String(tab===key));tabs.append(b);}parent.append(tabs);
    if(tab==='live')boards(parent);if(tab==='groups')groups(parent);if(tab==='results')results(parent);
    if(tab==='players'){for(const p of feed?.participants||[])parent.append(node('article',p.name+(p.waiting?' · Warteliste':''),'card'));if(!feed?.participants?.length)parent.append(node('p','Teilnehmer sind noch nicht veröffentlicht.','empty'));}
    if(tab==='performances'){for(const p of feed?.performances||[])parent.append(node('article',`${p.name} · ${{HS:'180er',HF:'High Finish',SG:'Short Game',SGD:'Short Game Doppel'}[p.type]||p.type}: ${p.value}${p.count>1?' · '+p.count+'×':''}`,'card'));if(!feed?.performances?.length)parent.append(node('p',feed?.performancesUnavailable?'Bestleistungen werden erneut geladen.':'Noch keine Bestleistungen veröffentlicht.','empty'));}
  }
  let preferencesText=()=> 'Trainingsmeldungen einstellen';
  return {init,refresh,show,select,id,participants:()=> (feed?.participants||[]).map(p=>p.name),setPreferenceLabel:fn=>{preferencesText=fn;}};
}
