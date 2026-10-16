/* Standalone visual rehearsal. All scores and statistics below are examples. */
(() => {
  'use strict';
  const q = selector => document.querySelector(selector);
  const PHOTO = '/pics/players/';
  const players = [
    {name:'Robin Tiedemann',alias:'The Chipper',image:PHOTO+'robin-tiedemann-cutout.webp',average:62.4,count180:4,finish:124},
    {name:'Max Lowak',alias:'Max',image:PHOTO+'max-lowak-cutout.webp',average:59.1,count180:2,finish:112},
    {name:'René Lange',alias:'Full Metal',image:PHOTO+'rene-lange-cutout.webp',average:60.8,count180:3,finish:118},
  ];
  const CREST='/pics/sv-barver-darts-tight-512.webp';
  const demoPlayer=(name,file)=>({name,image:file?PHOTO+file+'-cutout.webp':CREST});
  const teams = [
    {id:'A',opponent:'Demo-Gäste A',score:[4,4],photo:'/pics/teams/barver-a-team-20261007.webp',players:[demoPlayer('Jannik Kläning','jannik-klaening'),demoPlayer('Till Schulze','till-schulze'),demoPlayer('Tim Thürkow','tim-thuerkow')]},
    {id:'B',opponent:'DC Brenndorf E',score:[5,3],photo:'/pics/teams/barver-b-team-cutout.webp?v=20260927-2',players},
    {id:'C',opponent:'Demo-Gäste C',score:[3,5],photo:CREST,players:[demoPlayer('Ralf Scheland'),demoPlayer('Spieler C 2'),demoPlayer('Spieler C 3')]},
    {id:'D',opponent:'Demo-Gäste D',score:[2,2],photo:CREST,players:[demoPlayer('Jasmin Kolle'),demoPlayer('Merle Brammeyer'),demoPlayer('Emely Albrecht')]},
  ];
  const requestedCount=Number(new URLSearchParams(location.search).get('teams'));
  let teamCount=[1,2,3,4].includes(requestedCount)?requestedCount:1,eventTeam='B';
  const activeTeams=()=>teamCount===1?[teams[1]]:teams.slice(0,teamCount);
  const selectedTeam=()=>teams.find(team=>team.id===eventTeam);
  const boards = [
    {number:'01',type:'EINZEL',round:'3. EINZELBLOCK',home:{name:'Robin Tiedemann',points:84,darts:18,legs:1,last:60},away:{name:'Gastspieler 1',points:146,darts:21,legs:1,last:45},throwing:'home'},
    {number:'02',type:'DOPPEL',round:'2. DOPPELBLOCK',home:{name:'Max Lowak & René Lange',points:221,darts:12,legs:1,last:85},away:{name:'Gästepaar 1 & Gästepaar 2',points:89,darts:18,legs:2,last:100},throwing:'away'},
  ];
  let scene='live', boardCount=2, profileIndex=0, profilePaused=false, profileRemaining=8000;
  let profileDeadline=0, profileTimer=null, controlsTimer=null, momentTimer=null, pinned=false;
  let legWon=false,singleWon=false,doubleWon=false;
  const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value.toLocaleString('de-DE',{maximumFractionDigits:1,minimumFractionDigits:1});
  const announce = value => {q('#announcer').textContent=value;};

  function playerMarkup(player, throwing) {
    const double=player.name.includes(' & '),names=player.name.split(' & ');
    const average=player.darts?(501-player.points)*3/player.darts:0;
    return `<section class="player${throwing?' throwing':''}"><span class="turn${throwing?'':' waiting'}">AM WURF</span><div class="player-header"><h2${double?' class="double-name"':''}>${names.map(name=>`<span>${escape(name)}</span>`).join('')}</h2></div><strong class="remaining">${player.points}</strong><span class="remaining-label">RESTPUNKTE IM LEG</span><dl class="metrics"><div><dt>AVG im Leg</dt><dd>${number(average)}</dd></div><div><dt>Darts im Leg</dt><dd>${player.darts}</dd></div></dl><span class="scored">Geworfen: <b>${501-player.points} Punkte</b></span></section>`;
  }

  function displayedBoards(team=teams[1]) {
    return boards.map(board=>{
      const pair=board.number==='02';
      board={...board,home:{...board.home,name:pair?team.players.slice(1).map(player=>player.name).join(' & '):team.players[0].name}};
      if(team.id!==eventTeam)return board;
      if(board.number==='01'&&singleWon)return {...board,finished:true,throwing:null,home:{...board.home,legs:3,points:0,darts:21},away:{...board.away,points:58}};
      if(board.number==='01'&&legWon)return {...board,home:{...board.home,legs:2,points:501,darts:0,last:0},away:{...board.away,points:501,darts:0,last:0}};
      if(board.number==='02'&&doubleWon)return {...board,finished:true,throwing:null,home:{...board.home,legs:3,points:0,darts:21},away:{...board.away,points:58}};
      return board;
    });
  }

  const teamScore=team=>scene==='result'&&team.id===eventTeam?[7,5]:[team.score[0]+(team.id===eventTeam&&(singleWon||doubleWon)?1:0),team.score[1]];
  function compactPlayer(player,throwing) {
    const avg=player.darts?(501-player.points)*3/player.darts:0;
    return `<div class="compact-player${throwing?' throwing':''}"><div><h3>${player.name.split(' & ').map(escape).join('<span class="pair-separator"> & </span>')}</h3><p><b>${number(avg)}</b> AVG · <b>${player.darts}</b> Darts · <b>${501-player.points}</b> Pkt.</p></div><strong><small>${throwing?'AM WURF':'REST'}</small>${player.points}</strong></div>`;
  }
  function multiMarkup() {
    return `<div class="stage-heading"><h1>Alle Mannschaften im Blick <span>Bis zu ${teamCount*2} Partien gleichzeitig</span></h1><span class="signal">Werte aus dem aktuellen Leg · Best of 5</span></div><div class="multi-grid teams-${teamCount}">${activeTeams().map(team=>{
      const score=teamScore(team),won=scene==='result'&&team.id===eventTeam;
      return `<article class="team-tile${won?' finished':''}" data-team="${team.id}" aria-label="Barver ${team.id}"><header class="tile-header"><div><h2>BARVER ${team.id}</h2><span>gegen ${escape(team.opponent)}</span></div><strong>${score[0]} : ${score[1]}</strong><span class="tile-state">${won?'ENDSTAND':'BEISPIELSPIEL'}</span></header><div class="tile-body">${won?resultMarkup(team):`<div class="compact-boards">${displayedBoards(team).map(board=>`<section class="compact-board" aria-label="Barver ${team.id} Board ${board.number}"><header><span>BOARD ${board.number} · ${board.type}</span><b>${board.home.legs} : ${board.away.legs} <small>LEGS</small></b></header>${compactPlayer(board.home,board.throwing==='home')}${compactPlayer(board.away,board.throwing==='away')}<footer>${board.finished?'PARTIE BEENDET · PUNKT FÜR BARVER '+team.id:'Restpunkte, AVG und Darts nur aus diesem Leg'}</footer></section>`).join('')}</div>`}</div></article>`;
    }).join('')}</div>`;
  }
  function liveMarkup() {
    if(teamCount>1)return multiMarkup();
    const displayed=displayedBoards();
    return `<div class="stage-heading"><h1>Jetzt am Board <span>Einzel & Doppel</span></h1><span class="signal">Simuliertes Spiel · Best of 5</span></div><div class="boards${boardCount===1?' single':''}">${displayed.map(board=>`<article class="board" aria-label="Beispielboard ${board.number}"><header class="board-top"><span class="board-number"><b>${board.number}</b> ${board.type}</span><span class="leg-state">${board.finished?'PARTIE BEENDET':`LEG ${board.home.legs+board.away.legs+1} VON MAX. 5`}</span></header><div class="board-players">${playerMarkup(board.home,board.throwing==='home')}<div class="legs"><small>LEGS</small><strong>${board.home.legs} : ${board.away.legs}</strong><span>${board.finished?'Endstand':'First to 3'}</span></div>${playerMarkup(board.away,board.throwing==='away')}</div><footer class="board-bottom"><span>${board.round}</span><span>${board.finished?'Punkt für Barver B':`Letzte Aufnahme: <b>${board[board.throwing==='home'?'away':'home'].last}</b> <span class="throw-dots">•••</span>`}</span></footer></article>`).join('')}</div>`;
  }

  function profileMarkup() {
    const player=players[profileIndex],parts=player.name.split(' ');
    return `<section class="profile-scene" aria-label="Spielerpräsentation"><div class="profile-visual"><img src="${player.image}" alt="Vereinsfoto von ${escape(player.name)}"></div><div class="profile-copy"><p class="eyebrow">UNSERE MANNSCHAFT · BARVER B</p><h1>${parts.map(part=>`<span>${escape(part)}</span>`).join('')}</h1><p class="alias">„${escape(player.alias)}“</p><div class="profile-details"><span>SV Barver Darts B</span><span>Spieler</span></div><dl class="portrait-stats"><div><dt>Average</dt><dd>${number(player.average)}</dd></div><div><dt>180er</dt><dd>${player.count180}</dd></div><div><dt>High Finish</dt><dd>${player.finish}</dd></div></dl><p class="example-note">Beispielwerte für die Vorschau · keine aktuellen Spielerstatistiken</p><p class="profile-caption">${profileIndex+1} / ${players.length} · Spielerpräsentation · 8 Sekunden</p></div><div class="profile-progress${profilePaused?' paused':''}" aria-hidden="true"></div></section>`;
  }

  function breakMarkup() {
    return `<section class="break-scene"><div class="break-main"><p class="eyebrow">KURZ DURCHATMEN.</p><h1>Gleich geht’s<span>weiter.</span></h1><p>Eine gute Gelegenheit, die Mannschaft kennenzulernen. Der Spielstand bleibt oben im Blick.</p><img class="team-photo" src="/pics/teams/barver-b-team-cutout.webp?v=20260927-2" alt="Mannschaftsfoto von Barver B"></div><div class="break-side"><article class="next-fixture"><p class="eyebrow">ALS NÄCHSTES AM BOARD</p><h2>Robin Tiedemann<br>gegen Gastspieler 2</h2><p>Board 01 · Einzel · Best of 5 Legs</p><span class="fixture-demo">Beispiel für die nächste Partie</span></article><article class="watch-card"><img src="/watch-qr.svg" alt="QR-Code zur Barver-Darts-Website"><div><h2>Das Spiel mitnehmen.</h2><p>Auf dem Handy mitverfolgen – auch wenn du gerade nicht vor dem Fernseher stehst.</p><a href="https://barverdarts.clubiq.party/darts" target="_blank" rel="noopener noreferrer">barverdarts.clubiq.party ↗</a></div></article><p class="break-notice">Pausenansicht als Vorschau · „Live-Bild“ bringt dich zurück.</p></div></section>`;
  }

  function resultMarkup(team=selectedTeam()) {
    const confetti=Array.from({length:32},(_,i)=>`<span style="--left:${2+i*3.1}%;--delay:${(i%6)*.09}s;--drift:${i%2?-62:62}px;--turn:${i%2?220:-195}deg"></span>`).join('');
    return `<section class="result-scene celebrating${teamCount>1?' tile-result':''}"><div class="victory-confetti" aria-hidden="true">${confetti}</div><div class="victory-emblem" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M21 10h22v14c0 12-5 18-11 18s-11-6-11-18V10Zm0 6H11v6c0 9 5 13 13 13m19-19h10v6c0 9-5 13-13 13M32 42v10m-12 4h24M25 52h14"/></svg></div><p class="eyebrow">GEMEINSAM GEHOLT.</p><h1>Mannschaftssieg für Barver ${team.id}</h1><strong class="final-score">7 : 5</strong><p>SV Barver Darts ${team.id} gegen ${escape(team.opponent)}<br>Beispiel-Endstand · vielen Dank fürs Mitfiebern!</p><img class="team-photo${team.photo===CREST?' is-logo':''}" src="${team.photo}" alt="${team.photo===CREST?'Vereinslogo von SV Barver':'Die Mannschaft von Barver '+team.id}"></section>`;
  }

  function clearProfileTimer() {clearTimeout(profileTimer);profileTimer=null;}
  function scheduleProfile() {
    clearProfileTimer();
    if(scene!=='profile'||profilePaused)return;
    profileDeadline=performance.now()+profileRemaining;
    profileTimer=setTimeout(()=>advanceProfile(1),profileRemaining);
  }
  function advanceProfile(step) {
    clearProfileTimer();
    if(profileIndex+step>=players.length){setScene('live');return;}
    profileIndex=Math.max(0,profileIndex+step);profileRemaining=8000;renderScene();
  }
  function toggleProfilePause() {
    if(scene!=='profile')return;
    if(!profilePaused)profileRemaining=Math.max(0,profileDeadline-performance.now());
    profilePaused=!profilePaused;
    q('#pauseProfile').textContent=profilePaused?'Fortsetzen':'Pause';
    q('#pauseProfile').setAttribute('aria-pressed',String(profilePaused));
    q('.profile-progress').classList.toggle('paused',profilePaused);
    if(profilePaused)clearProfileTimer();else scheduleProfile();
  }
  function renderScene() {
    document.body.classList.toggle('multi-team',teamCount>1);
    q('#stage').innerHTML=scene==='profile'?profileMarkup():scene==='break'?breakMarkup():scene==='result'?(teamCount>1?multiMarkup():resultMarkup()):liveMarkup();
    q('#profileControls').hidden=scene!=='profile';
    q('#profileControls').innerHTML=scene==='profile'?`<span>SPIELERPRÄSENTATION</span><button id="previousProfile"${profileIndex===0?' disabled':''}>← Zurück</button><button id="pauseProfile" aria-pressed="${profilePaused}">${profilePaused?'Fortsetzen':'Pause'}</button><button id="nextProfile">${profileIndex===players.length-1?'Zum Spiel':'Weiter →'}</button><small>${profileIndex+1} / ${players.length} · 8 Sekunden</small>`:'';
    for(const button of document.querySelectorAll('[data-scene]'))button.setAttribute('aria-pressed',String(button.dataset.scene===scene));
    q('#homeScore').textContent=scene==='result'?'7':singleWon||doubleWon?'6':'5';q('#awayScore').textContent=scene==='result'?'5':'3';
    q('.scorebar').classList.toggle('team-won',scene==='result');
    q('.scorebar').classList.toggle('multiple',teamCount>1);
    q('#multiScores').hidden=teamCount===1;
    q('#multiScores').innerHTML=activeTeams().map(team=>{const score=teamScore(team);return `<div${scene==='result'&&team.id===eventTeam?' class="won"':''}><span>BARVER ${team.id}</span><strong>${score[0]} : ${score[1]}</strong><small>${scene==='result'&&team.id===eventTeam?'ENDSTAND':'BEISPIELSPIEL'}</small></div>`;}).join('');
    q('#boardCount').hidden=teamCount>1;
    q('#eventTeam').disabled=teamCount===1;
    q('#matchState').innerHTML='<i></i> '+({live:'BEISPIELSPIEL',profile:'KADERPRÄSENTATION',break:'SPIELPAUSE',result:'BEISPIEL-ENDSTAND'}[scene]);
    q('#footerLabel').textContent={live:'AM BOARD',profile:'UNSER TEAM',break:'SPIELPAUSE',result:'GEMEINSAM'}[scene];
    q('#footerCopy').textContent={live:'Zwei Boards. Eine Mannschaft. Gemeinsam für Barver.',profile:'Lerne die Menschen hinter unserer Mannschaft kennen.',break:'Gleich wieder am Board. Zeit für unsere Mannschaft und Partner.',result:'Für jeden Dart. Für jedes Leg. Für unseren Verein.'}[scene];
    if(teamCount>1&&(scene==='live'||scene==='result'))q('#footerCopy').textContent=`${teamCount} Mannschaften · bis zu ${teamCount*2} Partien · gemeinsam für Barver.`;
    if(scene==='profile'){
      q('#previousProfile').addEventListener('click',()=>advanceProfile(-1));q('#nextProfile').addEventListener('click',()=>advanceProfile(1));q('#pauseProfile').addEventListener('click',toggleProfilePause);scheduleProfile();
    }
    if(scene==='break')q('.watch-card img').addEventListener('error',()=>q('.watch-card').classList.add('qrless'),{once:true});
  }
  function setScene(next) {
    clearProfileTimer();clearTimeout(momentTimer);q('#moment').hidden=true;scene=next;profileIndex=0;profilePaused=false;profileRemaining=8000;legWon=false;singleWon=false;doubleWon=false;renderScene();window.scrollTo({top:0,behavior:'instant'});
    announce({live:'Beispielspiel mit laufenden Boards',profile:'Spielerprofile, jeweils acht Sekunden',break:'Pausenbildschirm',result:'Beispiel für einen Mannschaftssieg'}[scene]);
    if(next==='result'){q('#stage').focus({preventScroll:true});hideControls();}
  }
  function showMoment(type) {
    setScene('live');
    if(type==='leg')legWon=true;else if(type==='single')singleWon=true;else doubleWon=true;
    renderScene();
    const team=selectedTeam(),double=type==='double',partie=type!=='leg',selected=double?team.players.slice(1):[team.players[0]],host=q('#moment');
    host.className='moment hero '+(partie?'won '+type:'leg')+(teamCount>1?' in-team'+(teamCount>2?' crowded':''):'');
    const score=double?'3 : 2':partie?'3 : 1':'2 : 1';
    const sparks=partie?`<div class="moment-sparks" aria-hidden="true">${Array.from({length:16},(_,i)=>`<span style="--left:${5+i*6}%;--delay:${(i%4)*.08}s;--drift:${i%2?-40:40}px;--turn:${i%2?180:-180}deg"></span>`).join('')}</div>`:'';
    host.innerHTML=`<section class="moment-card">${sparks}<div class="moment-portraits">${selected.map(p=>`<img src="${p.image}"${p.image===CREST?' class="is-logo"':''} alt="${p.image===CREST?'Vereinslogo für '+escape(p.name):'Vereinsfoto von '+escape(p.name)}">`).join('')}</div><div class="moment-copy"><p class="eyebrow">${double?'DOPPEL GEWONNEN':partie?'EINZEL GEWONNEN':'LEG GEWONNEN'}</p><strong>${selected.map(p=>escape(p.name)).join('<br>')}</strong><p class="moment-alias">${!double&&selected[0].alias?'„'+escape(selected[0].alias)+'“ · ':''}Barver ${team.id}</p><div class="moment-score"><b>${score}</b><span>${partie?'ENDSTAND':'LEGSTAND'}<small>${partie?'Ein Punkt für Barver.':'Das nächste Leg beginnt.'}</small></span></div><p class="moment-demo">VORSCHAU · BEISPIELERGEBNIS</p></div>${partie?'<div class="moment-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></div>':''}</section>`;
    for(const image of host.querySelectorAll('img'))image.addEventListener('error',()=>{image.src='/pics/sv-barver-darts-tight-512.webp';image.alt='Vereinslogo als Ersatz für das Spielerfoto';image.classList.add('is-logo');},{once:true});
    host.hidden=false;q('#stage').focus({preventScroll:true});hideControls();positionMoment();
    if(teamCount>1&&innerWidth<=650){q(`.team-tile[data-team="${eventTeam}"]`).scrollIntoView({block:'start',behavior:'instant'});positionMoment();}
    momentTimer=setTimeout(()=>{host.hidden=true;},partie?8000:6000);
  }

  function positionMoment() {
    const host=q('#moment'),tile=teamCount>1?q(`.team-tile[data-team="${eventTeam}"] .tile-body`):null;
    if(tile){const bounds=tile.getBoundingClientRect();host.style.left=`${bounds.left}px`;host.style.right='auto';host.style.width=`${bounds.width}px`;host.style.top=`${bounds.top}px`;host.style.bottom='auto';host.style.height=`${bounds.height}px`;return;}
    host.style.left='';host.style.right='';host.style.width='';host.style.height='';
    const top=q('#demoControls').getBoundingClientRect().top;
    const footer=q('.broadcast-footer').getBoundingClientRect().height+12;
    q('#moment').style.top=`${q('.broadcast-header').getBoundingClientRect().bottom+10}px`;
    q('#moment').style.bottom=`${document.body.classList.contains('controls-hidden')?footer:Math.max(footer,innerHeight-top+16)}px`;
  }
  function showControls() {
    clearTimeout(controlsTimer);document.body.classList.remove('controls-hidden');q('#demoControls').inert=false;q('#showControls').setAttribute('aria-expanded','true');
    positionMoment();
    if(!pinned)controlsTimer=setTimeout(hideControls,5000);
  }
  function hideControls() {
    if(pinned)return;
    if(q('#demoControls').contains(document.activeElement)){controlsTimer=setTimeout(hideControls,5000);return;}
    document.body.classList.add('controls-hidden');q('#demoControls').inert=true;q('#showControls').setAttribute('aria-expanded','false');
    positionMoment();
  }
  for(const button of document.querySelectorAll('[data-scene]'))button.addEventListener('click',()=>setScene(button.dataset.scene));
  for(const button of document.querySelectorAll('[data-moment]'))button.addEventListener('click',()=>showMoment(button.dataset.moment));
  q('#showControls').addEventListener('click',showControls);
  q('#pinControls').addEventListener('click',()=>{pinned=!pinned;q('#pinControls').setAttribute('aria-pressed',String(pinned));q('#pinControls').textContent=pinned?'Bedienung lösen':'Bedienung festhalten';showControls();});
  q('#boardCount').addEventListener('click',()=>{boardCount=boardCount===2?1:2;q('#boardCount').textContent=boardCount===1?'Zwei Boards':'Ein Board';q('#boardCount').setAttribute('aria-pressed',String(boardCount===1));setScene('live');});
  function updateTeamControls() {
    if(!activeTeams().some(team=>team.id===eventTeam))eventTeam=activeTeams()[0].id;
    q('#teamCount').value=String(teamCount);
    q('#eventTeam').innerHTML=activeTeams().map(team=>`<option value="${team.id}">Barver ${team.id}</option>`).join('');q('#eventTeam').value=eventTeam;
  }
  q('#teamCount').addEventListener('change',()=>{teamCount=Number(q('#teamCount').value);updateTeamControls();setScene('live');});
  q('#eventTeam').addEventListener('change',()=>{eventTeam=q('#eventTeam').value;setScene('live');});
  const setTheme=theme=>{const light=theme==='light';document.documentElement.dataset.theme=light?'light':'dark';q('#themeToggle').textContent=light?'Dunkel':'Hell';q('#themeToggle').setAttribute('aria-pressed',String(light));};
  setTheme(new URLSearchParams(location.search).get('theme'));
  q('#themeToggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme!=='light'?'light':'dark'));
  q('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{announce('Vollbild wird in diesem Fenster nicht unterstützt. Die Vorschau bleibt bedienbar.');}});
  q('#demoControls').addEventListener('click',event=>{if(event.detail>0&&event.target.closest('button'))q('#stage').focus({preventScroll:true});});
  document.addEventListener('fullscreenchange',()=>{q('#fullscreen').textContent=document.fullscreenElement?'Vollbild beenden':'Vollbild';});
  document.addEventListener('pointermove',showControls,{passive:true});document.addEventListener('pointerdown',showControls,{passive:true});
  window.addEventListener('resize',positionMoment);
  window.addEventListener('scroll',positionMoment,{passive:true});
  document.addEventListener('keydown',event=>{
    if(event.key.toLowerCase()==='b'||event.key==='Tab')showControls();
    if(scene==='profile'&&event.key==='ArrowRight'){event.preventDefault();advanceProfile(1);}
    if(scene==='profile'&&event.key==='ArrowLeft'){event.preventDefault();advanceProfile(-1);}
    if(event.key==='Escape'){clearTimeout(momentTimer);q('#moment').hidden=true;if(scene!=='live')setScene('live');q('#stage').focus({preventScroll:true});hideControls();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&scene==='profile'&&!profilePaused)toggleProfilePause();});
  const updateClock=()=>{q('#clock').textContent=new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'}).format(new Date());};
  const partners=['Küster Barver','Küchenlounge Wagenfeld','A,B-Zett'];let partnerIndex=0;
  setInterval(()=>{partnerIndex=(partnerIndex+1)%partners.length;q('#partnerName').textContent=partners[partnerIndex];},12000);
  updateTeamControls();updateClock();setInterval(updateClock,1000);renderScene();showControls();
})();
