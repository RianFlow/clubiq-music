/* Loaded only by the local --serve fixture, never by the production page. */
(function () {
  'use strict';
  const panel=document.createElement('section');
  panel.className='message';
  panel.style.cssText='display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:18px;border:2px solid #c7a84f';
  const title=document.createElement('strong');title.textContent='ANIMATIONS-DEMO · Keine echten Leistungen';panel.append(title);
  const status=document.createElement('span');status.setAttribute('aria-live','polite');
  let serial=Date.now(),automatic;
  function highlight(types) {
    clearTimeout(automatic);
    const api=window.DartsBroadcast;if(!api)return;
    api.closeRoster();api.configure({enabled:true,tv:true});
    api.ingest([],{baseline:true});
    const matchId=++serial;
    api.ingest(types.map(type=>({type,matchId,gameId:matchId,team:'SV Barver Darts A',
      player:'Demo · Jannik Kläning',count:1,value:type==='180'?180:121,
      legCount:1,darts:15,barverWon:true,winnerSide:'home',barverSide:'home',
      score:'8:4',text:'Simuliertes Ereignis – kein echtes Ergebnis'})));
    status.textContent='Demo läuft – jede Einblendung bleibt ungefähr 3 Sekunden.';
  }
  async function roster() {
    clearTimeout(automatic);
    const response=await fetch('/api/v1/darts/player-profiles');
    if(!response.ok)return;
    const profiles=await response.json();
    const players=Object.values(profiles.players||{}).filter(player=>player.team==='B');
    window.DartsBroadcast.configure({enabled:true,tv:true});
    window.DartsBroadcast.presentRoster({code:'B',name:'SV Barver Darts B',players});
    status.textContent='Kader-Präsentation · Pause, Zurück und Weiter sind verfügbar.';
  }
  function button(label,action) {
    const node=document.createElement('button');node.type='button';node.textContent=label;
    node.addEventListener('click',()=>Promise.resolve(action()).catch(()=>{status.textContent='Demo konnte nicht geladen werden.';}));
    panel.append(node);
  }
  button('180 ansehen',()=>highlight(['180']));
  button('Checkout ansehen',()=>highlight(['high_finish']));
  button('Highlight-Abfolge',()=>highlight(['180','high_finish','short_leg','match']));
  button('Kader Barver B präsentieren',roster);
  panel.append(status);document.querySelector('main')?.prepend(panel);
  status.textContent='Die Highlight-Abfolge startet gleich automatisch. Du kannst sie hier jederzeit wiederholen.';
  automatic=setTimeout(()=>highlight(['180','high_finish','short_leg','match']),2500);
})();
