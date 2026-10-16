/* TV presentation of the existing public live feed. No separate polling or demo data. */
(function(root){
  'use strict';
  const CREST='/pics/sv-barver-darts-tight-512.webp';
  const PHOTOS={A:'/pics/teams/barver-a-team-20261007.webp',B:'/pics/teams/barver-b-team-20261016.webp',D:'/pics/teams/barver-d-team-20261016-v4.webp'};
  let host=null,context=null,controls=null,controlsHome=null,hideTimer=null,clockTimer=null,resultTimer=null,statusObserver=null,sponsorObserver=null,highlight=null;
  const tiles=new Map(),finished=new Map();
  const el=(tag,cls,value)=>{const n=root.document.createElement(tag);n.className=cls||'';if(value!==undefined)n.textContent=value;return n;};
  const q=selector=>root.document.querySelector(selector);
  const code=name=>String(name||'').match(/(?:SV\s+)?Barver(?:\s+Darts)?\s+([A-D])$/i)?.[1]?.toUpperCase()||'';
  const num=value=>Number.isInteger(value)&&value>=0?String(value):'–';
  const avg=player=>Number.isInteger(player?.darts)&&player.darts>0&&Number.isInteger(player.remaining)&&player.remaining>=0&&player.remaining<=501?((501-player.remaining)*3/player.darts).toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1}):player?.darts===0&&player.remaining===501?'0,0':'–';
  const teamImage=team=>PHOTOS[team]||CREST;
  function image(src,alt,cls){const n=el('img',cls);n.src=src;n.alt=alt;n.decoding='async';n.classList.toggle('is-logo',src===CREST);n.addEventListener('error',()=>{n.src=CREST;n.alt='SV Barver Darts';n.classList.add('is-logo');},{once:true});return n;}
  function teamCodes(item){return (item.barverTeams?.length?item.barverTeams:[code(item.home),code(item.away)]).filter(c=>context.selected.includes(c));}
  function ownSide(item,team){const side=item.barverSides?.[team]||(code(item.home)===team?'home':code(item.away)===team?'away':'');return side==='guest'?'away':side;}
  function outcome(item,team,score=item.score){const parts=String(score||'').match(/^(\d+)\s*:\s*(\d+)$/);const side=ownSide(item,team);if(!parts||!side)return null;const own=Number(parts[side==='home'?1:2]),other=Number(parts[side==='home'?2:1]);return own>other?'win':own<other?'loss':'draw';}
  function updateClock(){if(host)host.querySelector('.studio-clock').textContent=new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'}).format(new Date());}
  function showControls(){if(!host)return;clearTimeout(hideTimer);host.classList.remove('controls-hidden');controls.inert=false;host.querySelector('.studio-control-toggle').setAttribute('aria-expanded','true');hideTimer=root.setTimeout(hideControls,5000);}
  function hideControls(){if(!host)return;if(controls.contains(root.document.activeElement)){hideTimer=root.setTimeout(hideControls,5000);return;}host.classList.add('controls-hidden');controls.inert=true;host.querySelector('.studio-control-toggle').setAttribute('aria-expanded','false');}
  function keydown(event){if(!host)return;if(event.key==='Tab'||event.key.toLowerCase()==='b')showControls();}
  function mount(container){
    if(host)return;
    host=el('section','ds-tv');host.id='tvStudio';host.tabIndex=-1;host.setAttribute('aria-label','TV-Ansicht der Mannschaftsspiele');
    const header=el('header','studio-header'),mast=el('div','studio-masthead'),brand=el('div','studio-brand');
    brand.append(image(CREST,'',''),el('strong','','SV BARVER DARTS'));
    const status=el('span','studio-connection'),clock=el('time','studio-clock');mast.append(brand,status,clock);header.append(mast,el('div','studio-summary'));
    const content=el('div','studio-content'),foot=el('footer','studio-footer'),partner=el('div','studio-partner');partner.setAttribute('aria-label','TV-Partner');partner.hidden=true;foot.append(el('span','','GEMEINSAM FÜR BARVER.'),partner);
    controls=el('aside','studio-controls');controls.setAttribute('aria-label','TV-Ansicht bedienen');const existing=q('#tvTeamControls');controlsHome=existing.parentNode;controls.append(existing);
    const tools=el('div','studio-tools'),theme=el('button','','Hell / Dunkel'),exit=el('button','','TV-Modus beenden');theme.type=exit.type='button';
    theme.addEventListener('click',()=>q('#themeToggle').click());exit.addEventListener('click',()=>{if(root.location.pathname==='/app/live')root.location.assign('/app/');else root.document.exitFullscreen?.();});
    tools.append(theme,exit);controls.append(tools,el('small','','Maus bewegen oder B drücken · die Bedienung blendet sich nach 5 Sekunden aus.'));
    const toggle=el('button','studio-control-toggle','Bedienung');toggle.type='button';toggle.setAttribute('aria-expanded','true');toggle.addEventListener('click',showControls);
    host.append(header,content,foot,controls,toggle);container.replaceChildren(host);host.addEventListener('pointermove',showControls,{passive:true});host.addEventListener('pointerdown',showControls,{passive:true});root.document.addEventListener('keydown',keydown);
    const source=q('#liveDataStatus');if(source){const sync=()=>{status.textContent=source.textContent;status.dataset.state=source.dataset.state||'';};statusObserver=new MutationObserver(sync);statusObserver.observe(source,{childList:true,subtree:true,characterData:true,attributes:true});sync();}
    // Reuse the configured TV placement and rotation, even when the game feed is idle.
    const sponsorSource=q('#sponsorTv');if(sponsorSource){const sync=()=>{
      const banner=sponsorSource.hidden?null:sponsorSource.querySelector('.sponsor-banner');partner.hidden=!banner;
      if(!banner){partner.replaceChildren();return;}
      const copy=banner.cloneNode(true);for(const logo of copy.querySelectorAll('img')){logo.loading='eager';logo.addEventListener('error',()=>{logo.hidden=true;},{once:true});}
      partner.replaceChildren(copy);
    };sponsorObserver=new MutationObserver(sync);sponsorObserver.observe(sponsorSource,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','src','href']});sync();}
    updateClock();clockTimer=root.setInterval(updateClock,1000);showControls();
  }
  function close(){
    if(!host)return;
    clearTimeout(hideTimer);clearTimeout(resultTimer);clearInterval(clockTimer);statusObserver?.disconnect();sponsorObserver?.disconnect();root.document.removeEventListener('keydown',keydown);
    const original=q('#tvTeamControls');if(original&&controlsHome)controlsHome.insertBefore(original,q('#todayGrid'));
    host.remove();host=null;context=null;controls=null;highlight=null;tiles.clear();finished.clear();
  }
  function player(playerData,throwing,item,side){
    const data={...playerData,remaining:playerData.remaining??playerData.points},node=el('div','studio-player'+(throwing?' throwing':'')),identity=el('div','studio-player-copy'),name=context.playerNode(data.name||'Spieler',item.id,side);
    name.classList.add('studio-player-name','today-player-name');identity.append(name);
    const facts=el('p','studio-leg-facts');facts.textContent=`${avg(data)} AVG · ${num(data.darts)} Darts · ${Number.isInteger(data.remaining)&&data.remaining>=0&&data.remaining<=501?501-data.remaining:'–'} Pkt.`;identity.append(facts);
    const score=el('strong','studio-rest',data.remaining===0?'CHECK':num(data.remaining));score.prepend(el('small','',throwing?'AM WURF':'RESTPUNKTE'));
    node.append(identity,score);return node;
  }
  function board(game,item){
    const node=el('article','studio-board today-live-game'),head=el('header','studio-board-head'),legs=el('b','studio-legs',`${num(game.homeLegs)} : ${num(game.awayLegs)}`);legs.append(el('small','','LEGS'));
    head.append(el('span','',`BOARD ${game.board||'–'} · ${String(game.homeName||'').includes('&')||String(game.awayName||'').includes('&')?'DOPPEL':'EINZEL'}`),legs);
    const score=el('div','studio-board-players today-live-score');score.append(player({...game.home,name:game.homeName,remaining:game.homeRemaining},game.currentSide==='home',item,'home'),player({...game.away,name:game.awayName,remaining:game.awayRemaining},game.currentSide==='away',item,'away'));
    node.append(head,score,el('footer','','Restpunkte, AVG, Darts und Punkte aus dem aktuellen Leg'));return node;
  }
  function idle(model){
    const item=model.item,team=teamCodes(item)[0],section=el('section','studio-pause');
    const title=item.kind==='final'?outcome(item,team)==='win'?`Mannschaftssieg für Barver ${team}`:outcome(item,team)==='draw'?'Unentschieden':'Mannschaftsspiel beendet':model.stale?'Verbindung wird aktualisiert':model.loaded?'Zwischen den Partien':'Boarddaten werden geladen';
    section.append(el('p','studio-eyebrow',item.kind==='final'?'ENDSTAND':model.loaded&&!model.stale?'SPIELPAUSE':'LIVE-DATEN'),el('h2','',title));
    if(item.kind==='final')section.append(el('strong','studio-final-score',item.score||'–'));
    section.append(image(teamImage(team),PHOTOS[team]?`Mannschaftsfoto von Barver ${team}`:'Vereinslogo von SV Barver','studio-team-photo'),el('p','studio-pause-note',item.kind==='final'?'Danke fürs Mitfiebern!':model.stale?'Der letzte Spielstand bleibt erhalten. Wir verbinden uns automatisch neu.':'Sobald das nächste Board beginnt, erscheint es hier automatisch.'));
    return section;
  }
  function models(input){
    const now=Date.now(),current=new Map(input.models.map(m=>[String(m.item.id),m]));
    for(const [id,previous] of tiles){if(current.has(id))continue;const item=input.items.find(i=>String(i.id)===id);if(item?.kind==='final'&&!finished.has(id))finished.set(id,{model:{...previous.model,item,games:[]},until:now+90000});}
    for(const [id,result] of finished){if(result.until<=now&&String(highlight?.event.matchId)!==id||!teamCodes(result.model.item).length){finished.delete(id);continue;}if(!current.has(id))current.set(id,result.model);}
    clearTimeout(resultTimer);if(finished.size)resultTimer=root.setTimeout(()=>{if(context)render(context);},Math.max(1000,Math.min(...[...finished.values()].map(r=>r.until-now))));
    return [...current.values()].sort((a,b)=>teamCodes(a.item).join().localeCompare(teamCodes(b.item).join()));
  }
  function render(input){
    context=input;mount(input.container);const display=models(input),content=host.querySelector('.studio-content'),summary=host.querySelector('.studio-summary'),summaryNodes=[],wanted=new Set();
    content.dataset.count=String(Math.max(1,display.length));content.className='studio-content'+(!display.length?' is-empty':'');if(display.length)content.querySelector('.studio-no-games')?.remove();
    for(const model of display){
      const item=model.item,id=String(item.id),own=teamCodes(item),team=own[0],summaryItem=el('div','studio-summary-item');summaryItem.append(el('span','',own.map(c=>'BARVER '+c).join(' / ')),el('strong','',item.score||'–'),el('small','',item.kind==='final'?'ENDSTAND':model.stale?'LETZTER STAND':'LIVE'));summaryNodes.push(summaryItem);wanted.add(id);
      let tile=tiles.get(id);if(!tile){const node=el('article','studio-team today-game live');node.dataset.matchId=id;node.setAttribute('aria-label',`Barver ${team}: ${item.home} gegen ${item.away}`);node.append(el('header','studio-team-head'),el('div','studio-team-body'));tile={node};tiles.set(id,tile);}tile.model=model;
      const title=el('div','studio-team-title'),opponent=ownSide(item,team)==='home'?item.away:item.home;title.append(el('h2','',own.map(c=>'BARVER '+c).join(' / ')),el('span','',`gegen ${opponent||'Gäste'}${model.stale?' · letzter Stand':''}`));
      const report=el('button','studio-report','Spielbericht öffnen');report.type='button';report.addEventListener('click',()=>input.openMatch(item.id));
      tile.node.querySelector('.studio-team-head').replaceChildren(title,el('strong','studio-team-score',item.score||'–'),report);
      tile.node.classList.toggle('is-stale',Boolean(model.stale));tile.node.classList.toggle('is-finished',item.kind==='final');
      const body=tile.node.querySelector('.studio-team-body'),boards=el('div','studio-boards');boards.dataset.boards=String(model.games.length);for(const game of model.games)boards.append(board(game,item));
      const previous=body.querySelector('.studio-boards,.studio-pause');const next=model.games.length?boards:idle(model);if(previous)previous.replaceWith(next);else body.prepend(next);
      if(tile.node.parentNode!==content)content.append(tile.node);
    }
    for(const [id,tile] of tiles)if(!wanted.has(id)){tile.node.remove();tiles.delete(id);}
    summary.replaceChildren(...summaryNodes);
    if(!display.length){const blank=el('section','studio-no-games app-tv-empty');blank.append(el('p','studio-eyebrow','BEREIT FÜRS NÄCHSTE SPIEL'),el('h1','','Gerade läuft keine Begegnung deiner Auswahl.'),image(teamImage(input.selected.length===1?input.selected[0]:''),'SV Barver Darts','studio-team-photo'),el('p','','Sobald eine Partie beginnt, erscheint sie hier automatisch.'));content.replaceChildren(blank);}
    if(highlight)placeHighlight();
  }
  function confetti(){const wrap=el('div','studio-confetti');wrap.setAttribute('aria-hidden','true');for(let i=0;i<28;i++){const bit=el('i');bit.style.setProperty('--x',`${2+i*3.5}%`);bit.style.setProperty('--delay',`${i%6*.09}s`);bit.style.setProperty('--drift',`${i%2?-55:55}px`);wrap.append(bit);}return wrap;}
  function placeHighlight(){
    if(!highlight||!host)return;const tile=tiles.get(String(highlight.event.matchId));if(!tile)return;
    const parent=tile.node.querySelector('.studio-team-body');if(highlight.node.parentNode!==parent)parent.append(highlight.node);
  }
  function showHighlight(event,view,portraits){
    if(!host)return false;
    const tile=tiles.get(String(event.matchId));if(!tile||!teamCodes(tile.model.item).includes(code(event.team)))return 'ignored';
    const compact=event.barverWon===false&&['leg','game'].includes(event.type),team=code(event.team),result=event.type==='match'?outcome(tile.model.item,team,event.score):null,complete=event.type==='game'&&event.barverWon===true||result==='win';
    const wrap=el('div','studio-event'+(compact?' is-loss':'')),card=el('section',`studio-event-card darts-broadcast-card type-${event.type.replace('_','-')}${complete?' complete-win':''}`);
    wrap.setAttribute('role','status');wrap.setAttribute('aria-live','polite');
    const visual=el('div','studio-event-portraits');if(event.type==='match')visual.append(image(teamImage(team),PHOTOS[team]?`Mannschaftsfoto von Barver ${team}`:'Vereinslogo von SV Barver','studio-event-team-photo'));else for(const p of portraits)visual.append(image(p.image,p.fallback?`Vereinslogo für ${p.name}`:`Porträt von ${p.name}`,p.fallback?'is-logo':''));
    const copy=el('div','studio-event-copy'),label=event.type==='match'?result==='win'?'MANNSCHAFTSSIEG':result==='draw'?'UNENTSCHIEDEN':'MANNSCHAFTSSPIEL BEENDET':event.type==='game'&&event.barverWon?portraits.length>1?'DOPPEL GEWONNEN':'EINZEL GEWONNEN':view.label;
    copy.append(el('p','studio-eyebrow',label),el('strong','studio-event-name darts-broadcast-headline',event.type==='match'?`Barver ${team}`:portraits.length?portraits.map(p=>p.name).join('\n'):view.headline));
    const side=event.barverSide||ownSide(tile.model.item,team),home=event.homeLegs,away=event.awayLegs;
    const score=event.type==='match'?event.score:Number.isInteger(home)&&Number.isInteger(away)?side==='home'?`${home} : ${away}`:side==='away'||side==='guest'?`${away} : ${home}`:'':event.type==='leg'?`${num(event.legCount)} Legs`:'';
    if(score)copy.append(el('b','studio-event-score',score));copy.append(el('span','studio-event-detail',view.detail),el('small','studio-event-foot',event.team));
    if(!compact&&visual.children.length)card.append(visual);else card.classList.add('no-photo');card.append(copy);if(complete){card.append(confetti());const check=el('span','studio-win-check','✓');check.setAttribute('aria-hidden','true');card.append(check);}wrap.append(card);
    highlight={event,node:wrap};placeHighlight();q('#tvStudio').focus({preventScroll:true});hideControls();return true;
  }
  function clearHighlight(){highlight?.node.remove();highlight=null;}
  root.DartsTvStudio={render,close,showHighlight,clearHighlight,teamImage,isActive:()=>Boolean(host)};
  if(typeof module!=='undefined'&&module.exports)module.exports={avg,outcome,teamImage};
})(typeof window!=='undefined'?window:globalThis);
