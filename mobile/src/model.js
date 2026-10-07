export const API_ORIGIN='https://barverdarts.clubiq.party';
export const TYPES={'180':'180er',high_finish:'High Finishes',leg:'Gewonnene Legs',game:'Einzelne Partien',match:'Mannschaftsergebnisse',player_start:'Spieler startet seine Partie'};
export const API_PATH=/^\/api\/v1\/darts\/(season|live|highlights|player-profiles|matches\/\d+|trainings|training(?:\/live)?(?:\?event_id=[1-9]\d{0,7})?)$/;
export function apiUrl(path){if(!API_PATH.test(path))throw new Error('Nicht öffentlicher App-Endpunkt');return API_ORIGIN+path;}
export function publicLink(path){
  const url=new URL(path,API_ORIGIN);
  if(url.origin!==API_ORIGIN||!['/','/turnier','/training','/impressum','/datenschutz'].includes(url.pathname)||url.username||url.password)throw new Error('Nicht öffentlicher App-Link');
  return url.href;
}
export function cleanPreferences(value={}){
  return {training:value.training===true,favorite:['A','B','C','D'].includes(value.favorite)?value.favorite:'',teams:[...new Set((Array.isArray(value.teams)?value.teams:['A','B','C','D']).filter(x=>['A','B','C','D'].includes(x)))],players:[...new Set((Array.isArray(value.players)?value.players:[]).filter(x=>typeof x==='string'&&x.trim()&&x.length<=100).map(x=>x.trim()))].slice(0,50),eventTypes:[...new Set((Array.isArray(value.eventTypes)?value.eventTypes:Object.keys(TYPES).filter(type=>type!=='player_start')).filter(x=>Object.hasOwn(TYPES,x)))]};
}
export function activeBoards(group,now=Date.now()){
  if(group.retired||group.finished)return [];
  return(group.matches||[]).filter(m=>m.active&&!m.finished&&Number(m.lastUpdateNs)>0&&now-Math.floor(Number(m.lastUpdateNs)/1e6)>=0&&now-Math.floor(Number(m.lastUpdateNs)/1e6)<600000);
}
export function matchesFor(season,live,team='',now=Date.now()){
  return(season.matches||[]).filter(m=>!team||(m.barverTeams||[m.barverTeam]).includes(team)).map(m=>{
    const group=(live.groups||[]).find(g=>Number(g.groupKey)===m.id);
    const boards=group&&m.kind!=='final'?activeBoards(group,now):[];
    const latest=[...boards].sort((a,b)=>Number(b.lastUpdateNs)-Number(a.lastUpdateNs))[0];
    const score=Number.isInteger(latest?.teamScoreHome)&&Number.isInteger(latest?.teamScoreGuest)?`${latest.teamScoreHome}:${latest.teamScoreGuest}`:m.score;
    return {...m,score,boards,liveStale:!!group?.stale,kind:m.kind==='final'?'final':boards.length?'live':m.kind};
  }).sort((a,b)=>a.plannedAt&&b.plannedAt?String(a.plannedAt).localeCompare(String(b.plannedAt)):a.plannedAt?-1:b.plannedAt?1:0);
}
export function liveBoardView(board,now=Date.now(),unavailable=false){
  const stamp=Math.floor(Number(board.lastUpdateNs)/1e6);
  const stale=unavailable||!!board.stale||!Number.isFinite(stamp)||now-stamp>60000||stamp>now;
  const value=n=>Number.isInteger(n)&&n>=0?n:null;
  return {board:board.board||'–',stale,mode:board.mode||'',players:[board.home,board.guest].map((player,index)=>({
    name:player?.name|| (index===0?'Heim':'Gast'),points:value(player?.points),legs:value(player?.legs),
    average:Number.isFinite(player?.average)?player.average:null,lastScore:value(player?.lastScore),
    throwing:!stale&&board.currentPlayerIndex===index,
  }))};
}
export function sections(matches,now=new Date()){
  const day=d=>new Date(d).toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'});
  const today=day(now);
  return {live:matches.filter(m=>m.kind==='live'),today:matches.filter(m=>m.kind==='upcoming'&&m.plannedAt&&day(m.plannedAt)===today),next:matches.filter(m=>m.kind==='upcoming'),results:matches.filter(m=>['final','pending'].includes(m.kind)).reverse()};
}
export function roleRank(member){return /kapitän|captain/i.test(member.role||'')?0:/stellvertret|vize/i.test(member.role||'')?1:2;}
export function trainingNotificationTarget(data){if(data?.scope!=='training')return null;const id=Number(data.trainingId);return Number.isSafeInteger(id)&&id>0&&id<=10000000?id:null;}
export function notificationTarget(data){if(data?.scope==='training')return null;const id=Number(data?.matchId);return Number.isSafeInteger(id)&&id>0?id:null;}

export function matchLocation(match){
  const v=match?.homeVenue||{};
  return [v.name,v.street,[v.postalCode,v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
export function matchSide(match,favorite=''){
  const sides=match.barverSides||{};
  const code=favorite&&(match.barverTeams||[match.barverTeam]).includes(favorite)?favorite:match.barverTeam;
  return sides[code]==='home'?'Heimspiel':sides[code]==='away'?'Auswärtsspiel':'Begegnung';
}
export function routeUrl(match){const location=matchLocation(match);return location?'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(location):null;}
export function calendarEvent(match){
  const begin=Date.parse(match.plannedAt);if(!Number.isFinite(begin))return null;
  return {title:match.home+' gegen '+match.away,location:matchLocation(match),begin,end:begin+3*60*60*1000,description:'Barver Darts · Ende geschätzt. Aktueller Spielplan: '+API_ORIGIN+'/'};
}
export function calendarFile(match){
  const event=calendarEvent(match);if(!event)return null;
  const escape=value=>String(value).replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const stamp=value=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ClubIQ//Barver Darts//DE','BEGIN:VEVENT','UID:barver-match-'+match.id+'@clubiq.party','DTSTAMP:'+stamp(Date.now()),'DTSTART:'+stamp(event.begin),'DTEND:'+stamp(event.end),'SUMMARY:'+escape(event.title),'LOCATION:'+escape(event.location),'DESCRIPTION:'+escape(event.description),'END:VEVENT','END:VCALENDAR'];
  // RFC 5545 folds long lines at 75 UTF-8 bytes, without splitting characters.
  return lines.map(line=>{let out='',part='',bytes=0;for(const ch of line){const size=new TextEncoder().encode(ch).length;if(bytes+size>75){out+=part+'\r\n';part=' ';bytes=1;}part+=ch;bytes+=size;}return out+part;}).join('\r\n')+'\r\n';
}
