/* Public training discovery and independent 3K data, normalized before storage. */
(() => {
  'use strict';
  const api='https://backend4.3k-darts.com/2k-backend4/api/v1/frontend/event';
  const live='https://live.3k-darts.com/dartsscorer-liveticker/api/v1';
  const text=value=>String(value||'').trim().replace(/\s+/g,' ').slice(0,160);
  const number=value=>Number.isFinite(value)&&value>=0&&value<=10000000?value:null;
  function source(value) {
    const url=new URL(value),match=url.pathname.match(/^\/frontend\/events\/5\/event\/([1-9]\d{0,7})(?:\/[A-Za-z0-9/_-]*)?\/?$/);
    if(url.protocol!=='https:'||url.hostname!=='portal.3k-darts.com'||url.username||url.password||url.port||!match||Number(match[1])>10000000)throw new Error('Bitte einen öffentlichen 3K-Trainingslink eingeben.');
    return Number(match[1]);
  }
  function eventModel(raw) {
    if(!raw||raw.mandantKey!==1931||raw.dbId!==undefined&&raw.dbId!==5||!Number.isSafeInteger(raw.id)||raw.id<=0||raw.id>10000000||!text(raw.name).toLocaleLowerCase('de-DE').includes('training'))return null;
    return {id:raw.id,name:text(raw.name),date:typeof raw.datetime==='string'?raw.datetime:null,status:text(raw.statusCd),source:`https://portal.3k-darts.com/frontend/events/5/event/${raw.id}/participants`};
  }
  function select(events,now=Date.now()) {
    const berlin=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).filter(p=>['year','month','day'].includes(p.type)).sort((a,b)=>['year','month','day'].indexOf(a.type)-['year','month','day'].indexOf(b.type)).map(p=>p.value).join('-');
    const dated=events.filter(e=>Number.isFinite(Date.parse(e.date))&&!['CANCELLED','CANCELED','ABORTED'].includes(e.status)),time=e=>Date.parse(e.date);
    const active=dated.filter(e=>['ACTIVE','RUNNING','STARTED'].includes(e.status)).sort((a,b)=>time(b)-time(a));
    const next=dated.filter(e=>!['FINISH','CANCELLED','CANCELED','ABORTED'].includes(e.status)&&berlin(e.date)>=berlin(now)).sort((a,b)=>time(a)-time(b))[0];
    const latest=[...dated].sort((a,b)=>time(b)-time(a))[0];
    return {selectedId:(active[0]||next||latest)?.id||null,nextId:next?.id||null};
  }
  async function read(url,signal) {
    const response=await fetch(url,{credentials:'omit',headers:{Accept:'application/json'},cache:'no-store',redirect:'error',signal});
    if(!response.ok)throw new Error('3K ist gerade nicht erreichbar.');return response.json();
  }
  async function discover(known=[]) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000),events=new Map(known.filter(e=>Number.isSafeInteger(e.id)&&e.id>0&&e.id<=10000000&&text(e.name).toLocaleLowerCase('de-DE').includes('training')).map(e=>[e.id,{id:e.id,name:text(e.name),date:typeof e.date==='string'?e.date:null,status:text(e.status),source:`https://portal.3k-darts.com/frontend/events/5/event/${e.id}/participants`} ]));
    try {
      for(let page=0;page<10;page++) {
        const data=await read(`${api}/page?mandantKey=1931&eventTypeCd=TOURNAMENT&filterText=Training&page=${page}&size=100`,controller.signal);
        if(!Array.isArray(data.content)||!Number.isInteger(data.totalPages)||data.totalPages<0||data.totalPages>10)throw new Error('Die Trainingsliste ist unvollständig.');
        for(const raw of data.content){const item=eventModel(raw);if(item)events.set(item.id,item);}
        if(page+1>=data.totalPages)break;
      }
      const ids=[...new Set([32260,31849,20147,...events.keys()])].slice(0,50);
      const queue=[...ids],checks=[];await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){const id=queue.shift();try{const data=await read(`${api}/${id}`,controller.signal),item=eventModel(data.event);if(!item||item.id!==id)throw new Error('Ungültiges Training');events.set(id,item);}catch(_){checks.push({status:'rejected'});}}}));
      const ordered=[...events.values()].sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,50),stale=checks.some(p=>p.status==='rejected');
      return {available:true,stale,degraded:stale,events:ordered,updatedAt:stale?null:new Date().toISOString(),source:'browser-3k',...select(ordered)};
    }finally{clearTimeout(timer);}
  }
  function matchModel(raw) {
    if(!Number.isSafeInteger(raw.id)||raw.id<=0||raw.byeHome||raw.byeAway)return null;
    const kind=raw.statusCd==='FINISH'?'final':['ACTIVE','RUNNING','STARTED'].includes(raw.statusCd)||raw.beginDate&&!raw.endDate?'live':'upcoming';
    return {id:raw.id,kind,board:text(raw.board),home:text(raw.participantHome?.displayName)||'Noch offen',away:text(raw.participantGuest?.displayName)||'Noch offen',homeLegs:number(kind==='final'?raw.legsHome:raw.liveLegsHome),awayLegs:number(kind==='final'?raw.legsAway:raw.liveLegsAway),round:text(raw.round?.name),phase:text(raw.phase?.name),updatedAt:text(raw.endDate||raw.lastUpdate),live:null};
  }
  function groupModels(data,phase,round) {
    return (data.tableInfo?.tableEntries||[]).filter(g=>Array.isArray(g.tableEntries)).map((g,i)=>({id:`${phase}-${round}-${i}`,name:text(g.name)||'Gruppe',phaseId:phase,roundId:round,entries:g.tableEntries.map(r=>({rank:text(r.placement),name:text(r.participantName),played:number(r.matchCount),wins:number(r.win),lost:number(r.lost),pointsFor:number(r.points1),pointsAgainst:number(r.points2),legsFor:number(r.legs1),legsAgainst:number(r.legs2)}))}));
  }
  function performances(data) {
    if(!Array.isArray(data?.performanceCatalog))throw new Error('Bestleistungen unvollständig');return data.performanceCatalog.flatMap(group=>!['HS','HF','SG','SGD'].includes(group.performanceTypeCd)?[]:(group.playerPerformances||[]).filter(p=>p.participant?.displayName&&number(p.value)!==null&&(group.performanceTypeCd!=='HS'||p.value===180)).map(p=>({type:group.performanceTypeCd,name:text(p.participant.displayName),value:number(p.value),count:number(p.count)})));
  }
  function placements(data) {
    if(!Array.isArray(data))throw new Error('Platzierungen unvollständig');return data.filter(p=>p.participant?.displayName).map(p=>({rank:text(p.place),name:text(p.participant.displayName)}));
  }
  async function loadEvent(id,signal) {
    if(!Number.isSafeInteger(id)||id<=0||id>10000000)throw new Error('Ungültiges Training.');
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,20000);signal?.addEventListener('abort',abort,{once:true});
    try {
      if(signal?.aborted)throw new Error('Training abgebrochen');
      const base=`${api}/${id}`,detail=await read(base,controller.signal),event=eventModel(detail.event);
      if(!event||event.id!==id)throw new Error('Dieser Link gehört nicht zu einem Training von SV Barver.');
      const participants=await read(`${base}/participant`,controller.signal);if(!Array.isArray(participants))throw new Error('Teilnehmer konnten nicht geladen werden.');
      const result={event:{id,database:5,name:event.name,date:event.date,status:event.status},source:event.source,participants:participants.map(p=>({id:number(p.id),name:text(p.displayName),waiting:p.waitingList===true})),groups:[],matches:[],performances:[],placements:[],stale:false,updatedAt:new Date().toISOString(),sourceConnection:'browser-3k',scheduleReady:false,livePointsAvailable:false};
      const jobs=[];if(!Array.isArray(detail.phases)||detail.phases.length>16)throw new Error('Trainingsphasen unvollständig');
      for(const phase of (detail.phases||[]).slice(0,16)) {
        if(!Number.isSafeInteger(phase.id)||phase.id<=0)continue;
        const data=await read(`${base}/phase/${phase.id}`,controller.signal);if(!Array.isArray(data.rounds))throw new Error('Trainingsphase unvollständig');
        for(const round of data.rounds||[])if(Number.isSafeInteger(round.id)&&round.id>0)jobs.push([phase.id,round.id]);
      }
      if(jobs.length>128)throw new Error('Der Trainingsspielplan ist zu groß.');
      result.scheduleReady=jobs.length>0;
      const queue=[...jobs],rows=new Map();
      await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){const [phase,round]=queue.shift(),data=await read(`${base}/phase/${phase}/round/${round}`,controller.signal);if(!Array.isArray(data.matches))throw new Error('Spielplan unvollständig');for(const raw of data.matches){const m=matchModel(raw);if(m)rows.set(m.id,m);}result.groups.push(...groupModels(data,phase,round));}}));
      result.matches=[...rows.values()];result.groups.sort((a,b)=>a.phaseId-b.phaseId||a.roundId-b.roundId||a.id.localeCompare(b.id));
      await Promise.allSettled([
        (async()=>{try{result.performances=performances(await read(`${base}/performance`,controller.signal));}catch(_){result.performancesUnavailable=true;result.degraded=true;}})(),
        (async()=>{try{result.placements=placements(await read(`${base}/placement`,controller.signal));}catch(_){result.placementsUnavailable=true;result.degraded=true;}})(),
        (async()=>{
          if(event.status==='FINISH')return;
          try{const payload=await read(`${live}/match/5/0/${id}`,controller.signal);for(const raw of payload.data||[]){const m=rows.get(Number(raw.matchKey));if(!m||!raw.statusActive||raw.statusFinished||!Array.isArray(raw.matchPlayers)||raw.matchPlayers.length<2)continue;const side=index=>{const members=raw.matchPlayers.filter((_,i)=>i%2===index),p=members[0]||{};return {name:members.map(p=>text(p.playerName)).join(' & '),points:number(p.points),darts:number(p.darts),legs:number(p.legs),count180:number(p.count180),highFinish:number(p.highFinish)};};m.kind='live';m.board=text(raw.board)||m.board;m.live={home:side(0),guest:side(1),currentPlayerIndex:Number.isInteger(raw.currentplayerIndex)?raw.currentplayerIndex%2:null};result.livePointsAvailable=true;}}catch(_){/* Pairings stay usable without the scorer. */}
        })(),
      ]);
      if(controller.signal.aborted)throw new Error('Trainingsabruf dauert zu lange.');return result;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  const exported={source,eventModel,select,discover,loadEvent,matchModel,groupModels,performances,placements};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;else window.DartsTrainingSource=exported;
})();
