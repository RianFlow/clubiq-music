export const API_ORIGIN='https://barverdarts.clubiq.party';
export const TYPES={'180':'180er',high_finish:'High Finishes',leg:'Gewonnene Legs',game:'Einzelne Partien',match:'Gesamtergebnisse'};
export const API_PATH=/^\/api\/v1\/darts\/(season|live|highlights|player-profiles|matches\/\d+)$/;
export function apiUrl(path){if(!API_PATH.test(path))throw new Error('Nicht öffentlicher App-Endpunkt');return API_ORIGIN+path;}
export function publicLink(path){
  const url=new URL(path,API_ORIGIN);
  if(url.origin!==API_ORIGIN||!['/','/turnier','/impressum','/datenschutz'].includes(url.pathname)||url.username||url.password)throw new Error('Nicht öffentlicher App-Link');
  return url.href;
}
export function cleanPreferences(value={}){
  return {favorite:['A','B','C','D'].includes(value.favorite)?value.favorite:'',teams:[...new Set((Array.isArray(value.teams)?value.teams:['A','B','C','D']).filter(x=>['A','B','C','D'].includes(x)))],players:[...new Set((Array.isArray(value.players)?value.players:[]).filter(x=>typeof x==='string'&&x.trim()&&x.length<=100).map(x=>x.trim()))].slice(0,50),eventTypes:[...new Set((Array.isArray(value.eventTypes)?value.eventTypes:Object.keys(TYPES)).filter(x=>Object.hasOwn(TYPES,x)))]};
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
  }).sort((a,b)=>String(a.plannedAt||'').localeCompare(String(b.plannedAt||'')));
}
export function liveBoardView(board,now=Date.now(),unavailable=false){
  const stamp=Number(board.lastUpdateNs)/1e6;
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
  return {live:matches.filter(m=>m.kind==='live'),today:matches.filter(m=>m.kind!=='live'&&m.plannedAt&&day(m.plannedAt)===today),next:matches.filter(m=>m.kind==='upcoming'&&m.plannedAt&&day(m.plannedAt)>today),results:matches.filter(m=>['final','pending'].includes(m.kind)).reverse()};
}
export function roleRank(member){return /kapitän|captain/i.test(member.role||'')?0:/stellvertret|vize/i.test(member.role||'')?1:2;}
export function notificationTarget(data){const id=Number(data?.matchId);return Number.isSafeInteger(id)&&id>0?id:null;}
