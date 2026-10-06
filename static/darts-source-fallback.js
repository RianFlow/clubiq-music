/* Public read-only 3K fallback. No login or stored personal data is sent. */
(() => {
  'use strict';
  const api='https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend/event';
  const leagues=[
    {key:'kl04',name:'Kreisligen 04',short:'KL 04',event:1445,phase:2139,teams:{174110:'A',174111:'B',174112:'C'}},
    {key:'kk11',name:'Kreisklasse 11',short:'KK 11',event:1460,phase:2154,teams:{174266:'D'}},
  ];
  let pending=null, last=null, retryAt=0;
  const date=value=>{const time=Date.parse(value||'');return Number.isFinite(time)?time:null;};
  const iso=value=>date(value)===null?null:new Date(date(value)).toISOString();
  function relevantRounds(rounds, now) {
    const dated=rounds.filter(r=>Number.isSafeInteger(r.id)&&date(r.dateFrom)!==null);
    const before=dated.filter(r=>date(r.dateFrom)<=now).sort((a,b)=>date(b.dateFrom)-date(a.dateFrom))[0];
    const after=dated.filter(r=>date(r.dateFrom)>=now).sort((a,b)=>date(a.dateFrom)-date(b.dateFrom))[0];
    return [...new Map([before,after].filter(Boolean).map(r=>[r.id,r])).values()];
  }
  function normalize(raw, league, roundId, now) {
    const homeId=raw.participantHome?.id,awayId=raw.participantGuest?.id;
    if (!Number.isSafeInteger(raw.id)||!homeId||!awayId||raw.byeHome||raw.byeAway||(!league.teams[homeId]&&!league.teams[awayId])) return null;
    const home=String(raw.participantHome?.displayName||'Unbekannt').slice(0,160),away=String(raw.participantGuest?.displayName||'Unbekannt').slice(0,160);
    const scored=Number.isInteger(raw.setsHome)&&Number.isInteger(raw.setsAway);
    const plannedAt=iso(raw.datePlanned),updatedAt=iso(raw.endDate||raw.lastUpdate)||plannedAt;
    let kind=raw.statusCd==='FINISH'&&scored?'final':scored?'live':'upcoming',text=`${home} gegen ${away}`;
    if(kind==='final') {
      text=raw.setsHome===raw.setsAway?`${home} und ${away} trennen sich ${raw.setsHome}:${raw.setsAway}`:raw.setsHome>raw.setsAway?`${home} gewinnt ${raw.setsHome}:${raw.setsAway} gegen ${away}`:`${away} gewinnt ${raw.setsAway}:${raw.setsHome} gegen ${home}`;
    } else if(kind==='live') text=`Zwischenstand: ${home} ${raw.setsHome}:${raw.setsAway} ${away}`;
    if(kind!=='final'&&plannedAt&&now-date(plannedAt)>8*3600000) {kind='pending';text=`${home} gegen ${away} · Vorläufig beendet – Bestätigung ausstehend`;}
    const sides={};if(league.teams[homeId])sides[league.teams[homeId]]='home';if(league.teams[awayId])sides[league.teams[awayId]]='away';
    const codes=Object.keys(sides).sort();
    return {id:raw.id,eventId:league.event,phaseId:league.phase,roundId,kind,text,home,away,homeTeamId:homeId,awayTeamId:awayId,score:scored?`${raw.setsHome}:${raw.setsAway}`:null,plannedAt,updatedAt,league:league.key,leagueName:league.name,leagueShort:league.short,barverTeam:codes[0],barverTeams:codes,barverSides:sides,competitionType:'league',competitionBadge:league.short,isSpecial:false,url:`https://portal.3k-darts.com/frontend/events/10/event/${league.event}/phase/${league.phase}/group/${roundId}?matchId=${raw.id}`};
  }
  async function read(url, signal) {
    const response=await fetch(url,{credentials:'omit',headers:{Accept:'application/json'},cache:'no-store',signal});
    if(!response.ok)throw new Error('3K alternative unavailable');
    return response.json();
  }
  function liveEvents(payload, match) {
    const games=Array.isArray(payload)?payload:payload?.data;
    if(!Array.isArray(games))return [];
    return games.filter(game=>game&&(game.statusActive===true||game.status===1)&&Array.isArray(game.matchPlayers)&&game.matchPlayers.length>=2).map(game=>{
      const players=game.matchPlayers.filter(p=>p&&typeof p==='object');
      const side=parity=>{
        const members=players.filter((_,i)=>i%2===parity),p=members[0]||{};
        return {name:members.map(p=>String(p.playerName||'').trim()).filter(Boolean).join(' & ').slice(0,160)||'Noch offen',remaining:Number.isInteger(p.points)&&p.points>=0&&p.points<=501?p.points:null,legs:Number.isInteger(p.legs)&&p.legs>=0&&p.legs<=25?p.legs:null};
      };
      const home=side(0),away=side(1),score=home.legs!==null&&away.legs!==null?`${home.legs}:${away.legs}`:'–';
      return {type:'live_game',title:'Aktuelle Partie',text:`${home.name} ${score} ${away.name}`,matchId:match.id,liveGameId:Number.isSafeInteger(game.id)?game.id:0,homeName:home.name,awayName:away.name,homeLegs:home.legs,awayLegs:away.legs,homeRemaining:home.remaining,awayRemaining:away.remaining,currentSide:Number.isInteger(game.currentplayerIndex)?game.currentplayerIndex%2===0?'home':'away':null,updatedAt:iso(game.lastUpdate)};
    });
  }
  function publicGame(raw) {
    const number=Number.isSafeInteger(raw.gameNr)?raw.gameNr:Number.isSafeInteger(raw.gameNrRound)?raw.gameNrRound:0;
    const player=value=>({name:String(value?.displayName||'Noch offen').slice(0,160),average:Number.isFinite(value?.score)&&Number.isFinite(value?.darts)&&value.darts>0?Math.round(value.score*300/value.darts)/100:null});
    const legs=(finished,live)=>Number.isInteger(finished)?finished:Number.isInteger(live)?live:null;
    return {id:Number.isSafeInteger(raw.id)?raw.id:0,number,block:number<=4?'1. Block · Einzel':number<=6?'2. Block · Doppel':number<=10?'3. Block · Einzel':'4. Block · Doppel',status:String(raw.statusCd||'OPEN').toUpperCase().slice(0,20),home:player(raw.participantHome),away:player(raw.participantGuest),homeLegs:legs(raw.legsHome,raw.liveLegsHome),awayLegs:legs(raw.legsAway,raw.liveLegsAway)};
  }
  function publicPerformances(payload, matchId) {
    if(!Array.isArray(payload))return [];
    return payload.flatMap(raw=>{
      const type=raw.performanceTypeCd==='HS'&&raw.value===180?'180':raw.performanceTypeCd==='HF'&&Number.isInteger(raw.value)&&raw.value>=2&&raw.value<=170?'high_finish':null;
      return type?[{type,matchId,player:String(raw.participant?.displayName||'Spieler').slice(0,100),team:String(raw.team?.name||'Mannschaft').slice(0,120),count:Number.isInteger(raw.count)&&raw.count>0?raw.count:1,value:raw.value}]:[];
    });
  }
  const matchCache=new Map();
  async function loadMatch(known, signal) {
    const league=leagues.find(item=>item.event===Number(known?.eventId)),roundId=known?.roundId||known?.round?.id;
    if(!league||!Number.isSafeInteger(known?.id)||known.id<=0||!Number.isSafeInteger(roundId)||roundId<=0)throw new Error('Unsupported match source');
    if(signal?.aborted)throw new Error('Match request cancelled');
    const key=`${league.event}:${known.id}`,cached=matchCache.get(key);
    if(cached&&Date.now()-Date.parse(cached.updatedAt)<(known.kind==='live'?30000:600000))return cached;
    const controller=new AbortController(),abort=()=>controller.abort(),timeout=setTimeout(abort,12000);
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const round=await read(`${api}/${league.event}/phase/${league.phase}/round/${roundId}`,controller.signal);
      if(!Array.isArray(round.matches))throw new Error('Invalid match round');
      const raw=round.matches.find(item=>item.id===known.id),fresh=raw&&normalize(raw,league,roundId,Date.now());
      if(!fresh)throw new Error('Match does not belong to Barver');
      const match={...known,...fresh},result={available:true,stale:false,source:'browser-3k',updatedAt:new Date().toISOString(),match,games:[],liveGames:[],performances:[],reportAvailable:false,sourceUrl:fresh.url};
      if(!match.homeVenue?.street&&!match.homeVenue?.city&&Number.isSafeInteger(match.homeTeamId)) {
        try {
          const data=await read(`${api.replace(/\/event$/,'')}/participant/${match.homeTeamId}`,controller.signal);
          const venue=data.participant?.teamSeason?.playingVenue;
          if(venue)match.homeVenue={name:String(venue.name||'').slice(0,160),street:String(venue.locationStreet||'').slice(0,160),postalCode:String(venue.locationPostalCode||'').slice(0,20),city:String(venue.locationCity||'').slice(0,120)};
        } catch(_) { /* Keep known venue information if its source is unavailable. */ }
      }
      if(match.kind!=='upcoming') {
        try {
          const report=await read(`${api}/${league.event}/match/${match.id}/report`,controller.signal);
          if(!Array.isArray(report))throw new Error('Invalid match report');
          result.games=report.filter(item=>item&&typeof item==='object').map(publicGame).sort((a,b)=>a.number-b.number);
          result.reportAvailable=result.games.length>0;
        } catch(error) {if(controller.signal.aborted)throw error;result.reportUnavailable=true;}
        const extras=await Promise.allSettled([
          read(`${api}/${league.event}/performance/match/${match.id}?matchReport=1`,controller.signal),
          match.kind==='live'?read(`https://live.3k-darts.com/dartsscorer-liveticker/api/v1/match/10/0/${match.id}`,controller.signal):Promise.resolve(null),
        ]);
        if(extras[0].status==='fulfilled')result.performances=publicPerformances(extras[0].value,match.id);
        if(extras[1].status==='fulfilled'&&extras[1].value)result.liveGames=liveEvents(extras[1].value,match).map(event=>({id:event.liveGameId,home:{name:event.homeName,remaining:event.homeRemaining,legs:event.homeLegs},away:{name:event.awayName,remaining:event.awayRemaining,legs:event.awayLegs},currentSide:event.currentSide,lastUpdated:event.updatedAt}));
        result.reportAvailable=result.reportAvailable||result.liveGames.length>0;
      }
      if(controller.signal.aborted)throw new Error('Match request cancelled');
      if(!result.reportUnavailable) {matchCache.set(key,result);if(matchCache.size>24)matchCache.delete(matchCache.keys().next().value);}
      return result;
    } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  }
  async function load() {
    const now=Date.now();
    if(last&&now-Date.parse(last.updatedAt)<30000)return last;
    if(pending)return pending;
    if(now<retryAt)throw new Error('3K alternative cooling down');
    pending=(async()=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
      try {
        const groups=await Promise.all(leagues.map(async league=>{
          const phaseUrl=`${api}/${league.event}/phase/${league.phase}`;
          const phase=await read(phaseUrl,controller.signal);
          if(!Array.isArray(phase.rounds))throw new Error('Invalid 3K phase');
          const rounds=relevantRounds(phase.rounds,now);
          if(!rounds.length)throw new Error('No published 3K rounds');
          const matches=(await Promise.all(rounds.map(async round=>{
            const data=await read(`${phaseUrl}/round/${round.id}`,controller.signal);
            if(!Array.isArray(data.matches))throw new Error('Invalid 3K round');
            return data.matches.map(raw=>normalize(raw,league,round.id,now)).filter(Boolean);
          }))).flat();
          return matches;
        }));
        const items=[...new Map(groups.flat().map(item=>[item.id,item])).values()];
        const centers=await Promise.all(leagues.map(async league=>{
          const barverMatches=items.filter(item=>item.league===league.key);
          const results=await Promise.allSettled(barverMatches.filter(item=>item.kind==='live').map(async item=>liveEvents(await read(`https://live.3k-darts.com/dartsscorer-liveticker/api/v1/match/10/0/${item.id}`,controller.signal),item)));
          return {league:{key:league.key,name:league.name,short:league.short},barverMatches,pushEvents:results.filter(result=>result.status==='fulfilled').flatMap(result=>result.value),stale:results.some(result=>result.status==='rejected'),source:'browser-3k'};
        }));
        const priority={live:0,upcoming:1,pending:2,final:3};
        items.sort((a,b)=>priority[a.kind]-priority[b.kind]||(a.kind==='upcoming'?date(a.plannedAt)-date(b.plannedAt):(date(b.updatedAt)||0)-(date(a.updatedAt)||0)));
        last={available:true,stale:false,source:'browser-3k',scope:'league',updatedAt:new Date(now).toISOString(),items:items.slice(0,12),centers};
        retryAt=0;return last;
      } catch(error) {retryAt=Date.now()+30000;throw error;}
      finally {clearTimeout(timeout);pending=null;}
    })();
    return pending;
  }
  const exported={load,loadMatch,normalize,relevantRounds,liveEvents,publicGame,publicPerformances};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
  else window.DartsSourceFallback=exported;
})();
