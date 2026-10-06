"use strict";
const DARTS_TEAMS = [
  {id:'a',name:'SV Barver Darts A',event:'1445',participant:'174110',league:'Kreisligen 04'},
  {id:'b',name:'SV Barver Darts B',event:'1445',participant:'174111',league:'Kreisligen 04'},
  {id:'c',name:'SV Barver Darts C',event:'1445',participant:'174112',league:'Kreisligen 04'},
  {id:'d',name:'SV Barver Darts D',event:'1460',participant:'174266',league:'Kreisklasse 11'},
];
const DARTS_FALLBACK_ROSTERS = {
  A: [
    {id:89019,name:'Denis Dieckmann',role:'Spieler'},
    {id:89022,name:'Eike Feldhaus',role:'Stellvertretung'},
    {id:89027,name:'Jannik Kläning',role:'Spieler'},
    {id:89038,name:'Till Schulze',role:'Spieler'},
  ],
  B: [
    {id:89034,name:'Jörg Renzelmann',role:'Spieler'},
    {id:89029,name:'Patrick Lammers',role:'Spieler'},
    {id:89017,name:'Justin Albrecht',role:'Spieler'},
    {id:89030,name:'Max Lowak',role:'Spieler'},
    {id:116999,name:'René Lange',role:'Spieler'},
    {id:52376,name:'Robin Tiedemann',role:'Spieler'},
  ],
};
const DARTS_STORAGE = 'clubiq_darts_matches_2026_27';
function dartsTableRank(entry) {
  return entry?.rankSource==='3k-placement'&&Number.isSafeInteger(entry.rank)&&entry.rank>0?entry.rank:null;
}
function dartsSeasonRanks(data) {
  return {...data,teams:(data.teams||[]).map(team=>({...team,rank:dartsTableRank(team)}))};
}
const DARTS_EVENT_LABELS = {'180':'180er',high_finish:'High Finishes',leg:'Gewonnene Legs',game:'Einzel- & Doppelpartien',match:'Gesamtergebnisse'};
function dartsPreferences(value={}) {
  const list=(key,allowed,fallback)=>Array.isArray(value?.[key])?[...new Set(value[key].filter(v=>allowed.includes(v)))]:fallback;
  return {teams:list('teams',['A','B','C','D'],['A','B','C','D']),eventTypes:list('eventTypes',Object.keys(DARTS_EVENT_LABELS),Object.keys(DARTS_EVENT_LABELS)),
    players:Array.isArray(value?.players)?[...new Set(value.players.filter(v=>typeof v==='string'&&v.trim()&&v.length<=100).map(v=>v.trim()))].slice(0,100):[]};
}
function dartsLocalDay(value) {
  const date=new Date(value); if (!value || !Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function dartsHomeGroups(items, filters={}, now=new Date()) {
  const today=dartsLocalDay(now);
  const matches=items.filter(item=>(!filters.team||filters.team==='all'||(item.barverTeams||[item.barverTeam||dartsTeamCode(`${item.home} ${item.away}`)]).includes(filters.team))
    && (!filters.league||filters.league==='all'||(filters.league==='special'?item.isSpecial:String(item.eventId)===filters.league))
    && (!filters.date||dartsLocalDay(item.plannedAt)===filters.date));
  const byTime=(a,b)=>String(a.plannedAt||'').localeCompare(String(b.plannedAt||''));
  return {today:matches.filter(m=>m.kind==='live'||dartsLocalDay(m.plannedAt)===today).sort(byTime),
    upcoming:matches.filter(m=>m.kind==='upcoming'&&dartsLocalDay(m.plannedAt)>today).sort(byTime),
    final:matches.filter(m=>(m.kind==='final'||m.kind==='pending')&&dartsLocalDay(m.plannedAt)!==today).sort((a,b)=>byTime(b,a))};
}
function dartsLiveGroupActive(group,now=Date.now()) {
  if(group?.retired||group?.finished)return false;
  return (group?.matches||[]).some(m=>m.active&&!m.finished&&Number(m.lastUpdateNs)>0&&now-Number(m.lastUpdateNs)/1e6>=0&&now-Number(m.lastUpdateNs)/1e6<600000);
}
function dartsCupActive(season) {
  if(!season||season.stale||season.specialEventsAvailable===false)return true;
  const matches=(season.matches||[]).filter(m=>m.competitionType==='cup'||m.competitionBadge==='POKAL');
  if(!matches.length)return false;
  const latest=new Map();
  for(const m of [...matches].sort((a,b)=>String(a.plannedAt||a.updatedAt||'').localeCompare(String(b.plannedAt||b.updatedAt||''))))
    for(const code of m.barverTeams||[m.barverTeam])if(code)latest.set(`${m.eventId}:${code}`,{m,code});
  const known=new Set([...latest.values()].map(x=>x.code));
  if(!['A','B','C','D'].every(code=>known.has(code)))return true;
  return [...latest.values()].some(({m,code})=>{
    const score=String(m.score||'').match(/^(\d+):(\d+)$/),side=m.barverSides?.[code];
    if(m.kind!=='final'||!score||!side)return true;
    const own=Number(score[side==='home'?1:2]),other=Number(score[side==='home'?2:1]);
    return own>=other;
  });
}
function dartsTheme(value, prefersDark=false) {
  return value === 'dark' || value === 'light' ? value : prefersDark ? 'dark' : 'light';
}
function dartsRoster(members) {
  const roleRank = role => {
    const value=String(role || '').toLocaleLowerCase('de-DE');
    if (value.includes('stell')) return 1;
    if (value.includes('kapit')) return 0;
    return 2;
  };
  return [...(Array.isArray(members) ? members : [])].sort((left,right)=>
    roleRank(left?.role)-roleRank(right?.role) || String(left?.name || '').localeCompare(String(right?.name || ''),'de',{sensitivity:'base'})
  );
}
function dartsGender(value) {
  const marker=String(value || '').trim().toLocaleLowerCase('de-DE');
  if (['female','f','w','weiblich','frau'].includes(marker)) return 'female';
  if (['male','m','männlich','maennlich','mann'].includes(marker)) return 'male';
  if (['diverse','divers','d'].includes(marker)) return 'diverse';
  return '';
}
function dartsMemberRole(member={}, profile={}) {
  const role=String(member.role || 'Spieler').trim() || 'Spieler';
  if (dartsGender(profile.gender || member.gender)!=='female') {
    return role.toLocaleLowerCase('de-DE').includes('stell') ? 'Stellvertretender Kapitän' : role;
  }
  const normalized=role.toLocaleLowerCase('de-DE');
  if (normalized.includes('stell')) return 'Stellvertretende Kapitänin';
  if (normalized.includes('kapit')) return 'Kapitänin';
  if (normalized.includes('spieler')) return 'Spielerin';
  return role;
}
function dartsRoleSentence(member={}, team={}, profile={}) {
  const role=dartsMemberRole(member,profile), name=String(member.name || 'Dieses Mitglied'), teamName=String(team.name || `Barver ${team.code || ''}`).trim();
  if (role==='Kapitän') return `${name} führt ${teamName} als Kapitän an.`;
  if (role==='Kapitänin') return `${name} führt ${teamName} als Kapitänin an.`;
  if (role==='Stellvertretender Kapitän') return `${name} unterstützt ${teamName} als stellvertretender Kapitän.`;
  if (role==='Stellvertretende Kapitänin') return `${name} unterstützt ${teamName} als stellvertretende Kapitänin.`;
  return `${name} spielt für ${teamName}.`;
}
function dartsMatchCenterItem(items, code) {
  const candidates=(Array.isArray(items)?items:[]).filter(entry=>(entry.barverTeams || [entry.barverTeam || dartsTeamCode(`${entry.home || ''} ${entry.away || ''}`)]).includes(code));
  const live=candidates.filter(entry=>entry.kind==='live').sort((a,b)=>new Date(b.plannedAt||0)-new Date(a.plannedAt||0));
  const upcoming=candidates.filter(entry=>entry.kind==='upcoming').sort((a,b)=>new Date(a.plannedAt||'9999-12-31')-new Date(b.plannedAt||'9999-12-31'));
  const finals=candidates.filter(entry=>entry.kind==='final').sort((a,b)=>new Date(b.plannedAt||0)-new Date(a.plannedAt||0));
  return live[0] || upcoming[0] || candidates.find(entry=>entry.kind==='pending') || finals[0] || null;
}
function dartsTeamRoster(team) {
  const merged=[], seen=new Set();
  for (const member of [...(Array.isArray(team?.roster)?team.roster:[]),...(DARTS_FALLBACK_ROSTERS[team?.code] || [])]) {
    const key=member?.id ? `id:${member.id}` : `name:${String(member?.name || '').toLocaleLowerCase('de-DE')}`;
    if (!member?.name || seen.has(key)) continue;
    seen.add(key); merged.push(member);
  }
  return dartsRoster(merged);
}
function dartsTeamCode(value) {
  const match=String(value || '').match(/(?:SV\s+)?Barver(?:\s+Darts)?\s+([A-D1-4])\b/i);
  if (!match) return '';
  const code=match[1].toLocaleUpperCase('de-DE');
  return ({1:'A',2:'B',3:'C',4:'D'})[code] || code;
}
function dartsPlayerProfiles(config) {
  const result={};
  for (const [id,raw] of Object.entries(config?.players || {})) {
    if (!/^\d{1,12}$/.test(id)) continue;
    const item=typeof raw==='string'?{image:raw}:raw;
    if (!item || typeof item!=='object') continue;
    const image=typeof item.image==='string' && (/^\/pics\/players\/[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|webp)$/i.test(item.image) || /^\/api\/v1\/darts\/players\/\d{1,12}\/photo(?:\?v=\d+)?$/i.test(item.image)) ? item.image : '';
    const alias=typeof item.alias==='string' ? item.alias.trim().slice(0,50) : '';
    const gender=dartsGender(item.gender);
    const playerNumber=typeof item.playerNumber==='string' && /^[A-Z0-9]{3,12}$/i.test(item.playerNumber.trim()) ? item.playerNumber.trim().toLocaleUpperCase('de-DE') : '';
    const numericAverage=typeof item.average==='number' ? item.average : Number.NaN;
    const average=Number.isFinite(numericAverage) && numericAverage>=0 && numericAverage<=180 ? Math.round(numericAverage*10)/10 : null;
    const rawPersonal=item.personal && typeof item.personal==='object' ? item.personal : {};
    const cleanPersonalText=(value,max=100)=>typeof value==='string' ? value.trim().slice(0,max) : '';
    const numericWeight=typeof rawPersonal.weightGrams==='number' ? rawPersonal.weightGrams : Number.NaN;
    const numericFinish=typeof rawPersonal.favoriteFinish==='number' ? rawPersonal.favoriteFinish : Number.NaN;
    const personal={
      darts:cleanPersonalText(rawPersonal.darts,80),
      throwingHand:['left','right'].includes(rawPersonal.throwingHand)?rawPersonal.throwingHand:null,
      weightGrams:Number.isFinite(numericWeight) && numericWeight>=10 && numericWeight<=60 ? Math.round(numericWeight*10)/10 : null,
      favoritePdcPlayer:cleanPersonalText(rawPersonal.favoritePdcPlayer,80),
      favoriteFinish:Number.isFinite(numericFinish) && numericFinish>=2 && numericFinish<=170 ? Math.round(numericFinish) : (cleanPersonalText(rawPersonal.favoriteFinish,30) || cleanPersonalText(rawPersonal.favoriteDouble,30) || null),
      finishRoute:cleanPersonalText(rawPersonal.finishRoute,80),
      walkOnSong:cleanPersonalText(rawPersonal.walkOnSong,100),
    };
    const hasPersonal=personal.throwingHand || personal.darts || personal.weightGrams!==null || personal.favoritePdcPlayer || personal.favoriteFinish!==null || personal.finishRoute || personal.walkOnSong;
    const name=cleanPersonalText(item.name,100), team=/^[A-D]$/.test(item.team || '')?item.team:'', role=cleanPersonalText(item.role,50);
    result[id]={image,alias,average,playerNumber,...(name?{name}:{}),...(team?{team}:{}),...(role?{role}:{}),...(gender?{gender}:{}),...(hasPersonal?{personal}:{})};
  }
  return result;
}
function dartsPlayerStats(config) {
  const result={};
  const integer=(value,max=10000)=>Number.isInteger(value)&&value>=0&&value<=max?value:0;
  for (const [id,item] of Object.entries(config?.players || {})) {
    if (!/^\d{1,12}$/.test(id) || !item || typeof item!=='object') continue;
    const average=typeof item.average==='number'&&Number.isFinite(item.average)&&item.average>=0&&item.average<=180?Math.round(item.average*10)/10:null;
    const highFinish=Number.isInteger(item.highFinish)&&item.highFinish>=2&&item.highFinish<=170?item.highFinish:null;
    const playerNumber=typeof item.playerNumber==='string'&&/^[A-Z0-9]{3,12}$/i.test(item.playerNumber.trim())?item.playerNumber.trim().toLocaleUpperCase('de-DE'):'';
    const parsed={
      average,playerNumber,gamesPlayed:integer(item.gamesPlayed),gamesWon:integer(item.gamesWon),gamesLost:integer(item.gamesLost),
      legsFor:integer(item.legsFor),legsAgainst:integer(item.legsAgainst),singlesPlayed:integer(item.singlesPlayed),
      count180:integer(item.count180),highFinishes:integer(item.highFinishes),highFinish,
      winRate:Number.isInteger(item.winRate)&&item.winRate>=0&&item.winRate<=100?item.winRate:null,
      statsUpdatedAt:typeof item.statsUpdatedAt==='string'?item.statsUpdatedAt:typeof config.updatedAt==='string'?config.updatedAt:'',statsStale:config.stale===true||item.statsStale===true,
    };
    if (item.statsSource==='3k') {
      parsed.statsSource='3k';
      parsed.average9=typeof item.average9==='number'&&Number.isFinite(item.average9)?Math.round(item.average9*10)/10:null;
      parsed.average12=typeof item.average12==='number'&&Number.isFinite(item.average12)?Math.round(item.average12*10)/10:null;
      parsed.average15=typeof item.average15==='number'&&Number.isFinite(item.average15)?Math.round(item.average15*10)/10:null;
      parsed.average18=typeof item.average18==='number'&&Number.isFinite(item.average18)?Math.round(item.average18*10)/10:null;
    }
    result[id]=parsed;
  }
  return result;
}
function pushApplicationKey(value) {
  const padded = `${value}${'='.repeat((4-value.length%4)%4)}`.replace(/-/g,'+').replace(/_/g,'/');
  const raw = atob(padded);
  return Uint8Array.from(raw, character=>character.charCodeAt(0));
}
function dartsSponsors(config, now=Date.now()) {
  const displaySeconds = Number.isFinite(config?.displaySeconds) ? Math.min(60,Math.max(6,Math.round(config.displaySeconds))) : 12;
  const sponsors = Array.isArray(config?.sponsors) ? config.sponsors.flatMap((item,index)=>{
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) return [];
    const image = typeof item.image === 'string' && (
      /^\/pics\/sponsors\/[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|svg|webp)$/i.test(item.image)
      || /^\/api\/v1\/darts\/sponsors\/\d+\/logo(?:\?v=\d+)?$/i.test(item.image)
    ) ? item.image : '';
    let href = '';
    if (typeof item.href === 'string' && item.href) {
      try { const url=new URL(item.href); if (url.protocol==='https:' && !url.username && !url.password) href=url.href; } catch (_) {}
    }
    const starts = item.startsAt ? Date.parse(item.startsAt) : -Infinity;
    const ends = item.endsAt ? Date.parse(item.endsAt) : Infinity;
    if (Number.isNaN(starts) || Number.isNaN(ends) || starts > ends || now < starts || now > ends) return [];
    const placements = Array.isArray(item.placements)
      ? [...new Set(item.placements.filter(value=>['top','inline','footer','tv','match'].includes(value)))]
      : ['footer'];
    if (!placements.length) return [];
    const type=['main','club','team','event'].includes(item.type)?item.type:'club';
    const teams=Array.isArray(item.teams)?[...new Set(item.teams.filter(value=>['A','B','C','D'].includes(value)))]:[];
    const eventMatchIds=Array.isArray(item.eventMatchIds)?[...new Set(item.eventMatchIds.map(Number).filter(value=>Number.isInteger(value)&&value>0))]:[];
    const priority=Number.isInteger(item.priority)?Math.max(-1000,Math.min(1000,item.priority)):0;
    return [{id:String(item.id || index),name:item.name.trim(),image,href,placements,type,teams,eventName:typeof item.eventName==='string'?item.eventName.trim():'',eventMatchIds,priority}];
  }).sort((a,b)=>b.priority-a.priority||a.name.localeCompare(b.name,'de')) : [];
  return {displaySeconds,sponsors};
}
function dartsClubEvents(config, now=Date.now()) {
  const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
  return (Array.isArray(config?.events)?config.events:[]).flatMap((item,index)=>{
    if (item?.active===false) return [];
    const title=clean(item?.title,100); if (!title) return [];
    const starts=item.startsAt?Date.parse(item.startsAt):-Infinity;
    const ends=item.endsAt?Date.parse(item.endsAt):Infinity;
    if (Number.isNaN(starts)||Number.isNaN(ends)||starts>ends||now<starts||now>=ends) return [];
    let href='';
    if (typeof item.href==='string'&&item.href) {
      try { const url=new URL(item.href); if (url.protocol==='https:'&&!url.username&&!url.password) href=url.href; } catch (_) {}
    }
    const image=typeof item.image==='string'&&(/^[\/]pics\/events\/[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|webp)$/i.test(item.image)||/^\/api\/v1\/darts\/events\/\d+\/image(?:\?v=\d+)?$/.test(item.image))?item.image:'';
    return [{id:String(item.id||index),title,kicker:clean(item.kicker,50)||'Aus dem Verein',description:clean(item.description,600),date:clean(item.date,100),location:clean(item.location,120),calendarDate:/^\d{4}-\d{2}-\d{2}$/.test(item.calendarDate||'')?item.calendarDate:'',buttonLabel:clean(item.buttonLabel,40)||'Mehr erfahren',href,image,priority:Number.isInteger(item.priority)?item.priority:0}];
  }).sort((left,right)=>right.priority-left.priority||left.title.localeCompare(right.title,'de'));
}
function dartsSocialLinks(config) {
  const labels={whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook',youtube:'YouTube',tiktok:'TikTok',website:'Webseite',x:'X'};
  return (Array.isArray(config?.links)?config.links:[]).flatMap(item=>{
    if (!item || item.active===false || !labels[item.platform]) return [];
    try {
      const url=new URL(item.href);
      if (url.protocol!=='https:'||url.username||url.password) return [];
      return [{teaser:typeof item.teaser==='string'&&item.teaser.trim()?item.teaser.trim().slice(0,80):'Neueste Infos',showInBanner:item.showInBanner!==false,platform:item.platform,label:typeof item.label==='string'&&item.label.trim()?item.label.trim().slice(0,80):labels[item.platform],href:url.href,priority:Number.isInteger(item.priority)?item.priority:0}];
    } catch (_) { return []; }
  }).sort((a,b)=>b.priority-a.priority||a.label.localeCompare(b.label,'de'));
}
function dartsLayout(raw) {
  const ids = DARTS_TEAMS.map(t=>t.id);
  const count = [1,2,3,4].includes(raw?.count) ? raw.count : 4;
  const selected = [...new Set(Array.isArray(raw?.selected) ? raw.selected.filter(id=>ids.includes(id)) : [])];
  for (const id of ids) if (selected.length < count && !selected.includes(id)) selected.push(id);
  const modes = {};
  for (const id of ids) modes[id] = ['team','report','live'].includes(raw?.modes?.[id]) ? raw.modes[id] : 'team';
  return {count,selected:selected.slice(0,count),modes,auto:raw?.auto === true};
}
function dartsMatch(raw, team) {
  const error = () => { throw new Error('Bitte einen vollständigen 3K-Spielbericht-Link mit matchId oder einen 3K-Live-Link einfügen.'); };
  if (typeof raw !== 'string' || raw.length > 600) return error();
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return error(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return error();
  if (url.hostname === 'portal.3k-darts.com') {
    const parts = url.pathname.match(/^\/frontend\/events\/10\/event\/(\d{1,10})\/phase\/(\d{1,10})\/group\/(\d{1,10})\/?$/);
    const match = url.searchParams.get('matchId');
    if (!parts || !/^\d{1,10}$/.test(match || '') || [...url.searchParams.keys()].some(key=>key!=='matchId') || url.searchParams.getAll('matchId').length!==1) return error();
    if (parts[1] !== team.event) throw new Error('Der Link gehört nicht zur Liga dieser Mannschaft. Bitte die passende Begegnung wählen.');
    return {report:`https://portal.3k-darts.com${url.pathname}?matchId=${match}`,live:`https://live.3k-darts.com/event/10/${match}`,match};
  }
  if (url.hostname === 'live.3k-darts.com' && !url.search) {
    const parts = url.pathname.match(/^\/event\/10\/(\d{1,10})\/?$/);
    if (parts) return {report:null,live:`https://live.3k-darts.com/event/10/${parts[1]}`,match:parts[1]};
  }
  return error();
}

function dartsTraining(raw) {
  const invalid = () => { throw new Error('Bitte einen 3K-Trainingslink mit Teilnehmern, Bestleistungen, Platzierung oder Gruppe einfügen.'); };
  if (typeof raw !== 'string' || raw.length > 600) return invalid();
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'portal.3k-darts.com' || url.username || url.password || url.port || url.search || url.hash) return invalid();
  const parts = url.pathname.match(/^\/frontend\/events\/5\/event\/(\d{1,10})\/(participants|performances|placement|phase\/(\d{1,10})\/group\/(\d{1,10}))\/?$/);
  if (!parts) return invalid();
  const base = `https://portal.3k-darts.com/frontend/events/5/event/${parts[1]}`;
  return {event:parts[1], source:url.href, participants:`${base}/participants`, performances:`${base}/performances`, placement:`${base}/placement`, games:parts[3] ? `${base}/phase/${parts[3]}/group/${parts[4]}` : null};
}

if (typeof document !== 'undefined') initDarts();

function initDarts() {
  const q = selector => document.querySelector(selector);
  const grid = q('#teamGrid'), cards = new Map(), selections = {};
  const onlineNode = q('#dartsOnline');
  const presenceKey = 'clubiq_darts_presence_id';
  let presenceId = '';
  try {
    presenceId = localStorage.getItem(presenceKey) || '';
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(presenceId)) {
      presenceId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(presenceKey,presenceId);
    }
  } catch (_) {
    presenceId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
  async function updatePresence() {
    if (!onlineNode || document.hidden || !presenceId) return;
    try {
      const response = await fetch('/api/v1/darts/presence',{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({clientId:presenceId}),
        cache:'no-store',
        signal:AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Presence unavailable');
      const data = await response.json();
      const online = Number.isInteger(data.online) && data.online >= 0 ? data.online : null;
      if (online !== null) {
        onlineNode.textContent = `${online} online${data.demo?' · Demo':''}`;
        onlineNode.classList.add('is-current');
        onlineNode.setAttribute('aria-label',`${online} aktive Browser${data.demo?' in der Demo':''}`);
      }
    } catch (_) {
      onlineNode.textContent='– online';onlineNode.classList.remove('is-current');
      onlineNode.setAttribute('aria-label','Online-Zähler gerade nicht erreichbar');
    }
  }
  const demoLive = ['127.0.0.1','localhost'].includes(location.hostname) && new URLSearchParams(location.search).get('demo') === 'live';
  let broadcastEnabled=true;
  try { broadcastEnabled=localStorage.getItem('clubiq_darts_broadcast_enabled')!=='false'; } catch (_) {}
  q('#broadcastEnabled').checked=broadcastEnabled;
  window.DartsBroadcast?.configure({enabled:broadcastEnabled,tv:false});
  q('#broadcastEnabled').addEventListener('change',()=>{
    broadcastEnabled=q('#broadcastEnabled').checked;
    try { localStorage.setItem('clubiq_darts_broadcast_enabled',String(broadcastEnabled)); } catch (_) {}
    window.DartsBroadcast?.configure({enabled:broadcastEnabled});
  });
  const broadcastBaselines=new Set();
  // Initialize the transition stream even when the initial snapshot has no events.
  window.DartsBroadcast?.ingest([],{baseline:true});
  const themeKey = 'clubiq_darts_theme';
  function applyTheme(theme, remember=false) {
    const selected=dartsTheme(theme);
    document.documentElement.dataset.theme=selected;
    q('meta[name="theme-color"]').content=selected==='dark'?'#0b1412':'#163c36';
    q('#themeToggle').setAttribute('aria-checked',String(selected==='dark'));
    q('#themeToggle').setAttribute('title',selected==='dark'?'Hellen Modus einschalten':'Dunklen Modus einschalten');
    if (remember) { try { localStorage.setItem(themeKey,selected); } catch (_) {} }
  }
  let savedTheme=null;
  try { savedTheme=localStorage.getItem(themeKey); } catch (_) {}
  applyTheme(dartsTheme(savedTheme,window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  q('#themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark',true));
  const tvTeamKey='clubiq_darts_tv_teams', allTvTeams=['A','B','C','D'];
  let tvTeams=new Set(allTvTeams);
  try {
    const queryTeams=new URLSearchParams(location.search).get('teams');
    const stored=queryTeams ? queryTeams.split(',') : JSON.parse(localStorage.getItem(tvTeamKey) || '[]');
    const valid=[...new Set((Array.isArray(stored)?stored:[]).filter(code=>allTvTeams.includes(code)))];
    if (valid.length) tvTeams=new Set(valid);
  } catch (_) {}
  function updateTvTeamControls() {
    const count=q('#tvTeamCount'); if(count) count.textContent=`${tvTeams.size} ${tvTeams.size===1?'Mannschaft':'Mannschaften'}`;
    q('#tvTeamControls')?.querySelectorAll('[data-tv-team]').forEach(button=>{
      const code=button.dataset.tvTeam;
      button.setAttribute('aria-pressed',String(code==='all'?tvTeams.size===allTvTeams.length:tvTeams.has(code)));
    });
  }
  function rememberTvTeams() {
    try { localStorage.setItem(tvTeamKey,JSON.stringify([...tvTeams])); } catch (_) {}
  }
  function sponsorContext(slot) {
    const placement=slot.dataset.placement || '';
    if (placement==='tv') {
      const live=(tickerData?.items || []).filter(item=>item.kind==='live' && (item.barverTeams || [barverTeam(item)]).filter(Boolean).some(code=>tvTeams.has(code)));
      return {teams:new Set([...tvTeams]),matchIds:new Set(live.map(item=>Number(item.id)).filter(Number.isInteger))};
    }
    if (placement==='match') {
      return {
        teams:new Set(String(slot.dataset.teams || '').split(',').filter(code=>allTvTeams.includes(code))),
        matchIds:new Set(String(slot.dataset.matchId || '').split(',').map(Number).filter(Number.isInteger)),
      };
    }
    return {teams:new Set(),matchIds:new Set()};
  }
  function sponsorEligible(sponsor, slot) {
    if (!sponsor.placements.includes(slot.dataset.placement)) return false;
    const context=sponsorContext(slot);
    if (sponsor.type==='team') return sponsor.teams.some(code=>context.teams.has(code));
    if (sponsor.type==='event') {
      if (sponsor.eventMatchIds.length) return sponsor.eventMatchIds.some(id=>context.matchIds.has(id));
      if (sponsor.teams.length && context.teams.size) return sponsor.teams.some(code=>context.teams.has(code));
      return true;
    }
    return true;
  }
  function sponsorCaption(sponsor) {
    if (sponsor.type==='main') return 'Hauptpartner';
    if (sponsor.type==='event') return sponsor.eventName || 'Veranstaltungspartner';
    if (sponsor.type==='team') return sponsor.teams.length===1?`Partner Barver ${sponsor.teams[0]}`:'Teampartner';
    return 'Unterstützt von';
  }
  function renderSponsor(slot, sponsor) {
    const content=document.createElement(sponsor.href?'a':'div'); content.className=`sponsor-banner sponsor-${sponsor.type}`;
    if (sponsor.href) { content.href=sponsor.href; content.target='_blank'; content.rel='noopener noreferrer sponsored'; }
    const caption=document.createElement('span'); caption.className='sponsor-caption'; caption.textContent=sponsorCaption(sponsor);
    const identity=document.createElement('span'); identity.className='sponsor-identity';
    if (sponsor.image) { const logo=document.createElement('img'); logo.src=sponsor.image; logo.alt=''; logo.loading='lazy'; logo.decoding='async'; identity.append(logo); }
    const name=document.createElement('strong'); name.textContent=sponsor.name; identity.append(name);
    content.append(caption,identity); slot.replaceChildren(content); slot.hidden=false;
  }
  let sponsorConfig={displaySeconds:12,sponsors:[]}, sponsorTimer=null;
  const sponsorIndexes=new Map();
  function refreshSponsorSlots(advance=false) {
    for (const slot of document.querySelectorAll('.sponsor-slot')) {
      const items=sponsorConfig.sponsors.filter(item=>sponsorEligible(item,slot));
      if (!items.length) { slot.hidden=true; slot.replaceChildren(); continue; }
      const current=sponsorIndexes.get(slot.id)||0;
      const index=advance?(current+1)%items.length:current%items.length;
      sponsorIndexes.set(slot.id,index);
      renderSponsor(slot,items[index]);
    }
  }
  function startSponsorRotation(config) {
    sponsorConfig=config; sponsorIndexes.clear(); refreshSponsorSlots(false);
    if (sponsorTimer) window.clearInterval(sponsorTimer);
    if (config.sponsors.length>1) sponsorTimer=window.setInterval(()=>refreshSponsorSlots(true),config.displaySeconds*1000);
  }
  fetch('/api/v1/darts/sponsors',{headers:{Accept:'application/json'},cache:'no-store'})
    .then(response=>response.ok?response.json():Promise.reject(new Error('sponsor api unavailable')))
    .catch(()=>fetch('/static/darts-sponsors.json',{headers:{Accept:'application/json'}}).then(response=>response.ok?response.json():Promise.reject(new Error('sponsors unavailable'))))
    .then(config=>startSponsorRotation(dartsSponsors(config)))
    .catch(()=>document.querySelectorAll('.sponsor-slot').forEach(slot=>{ slot.hidden=true; slot.replaceChildren(); }));
  let clubSocialLinks=[], calendarEvents=null;
  function renderClubEvent(event) {
    const banner=q('#clubEventBanner');
    if (!event) { banner.hidden=true; return; }
    q('#clubEventKicker').textContent=event.kicker;
    q('#clubEventTitle').textContent=event.title;
    q('#clubEventDescription').textContent=event.description;
    const meta=q('#clubEventMeta'); meta.replaceChildren();
    for (const value of [event.date,event.location].filter(Boolean)) { const span=document.createElement('span'); span.textContent=value; meta.append(span); }
    const link=q('#clubEventLink');
    if (event.href) { link.href=event.href; link.textContent=event.buttonLabel; link.target='_blank'; link.rel='noopener noreferrer'; link.hidden=false;const channel=clubSocialLinks.find(item=>item.href===link.href);if(channel)link.prepend(window.DartsSocialIcons.create(channel.platform)); }
    else { link.removeAttribute('href'); link.hidden=true; }
    const image=q('#clubEventImage');
    const poster=q('#clubEventPoster');poster.hidden=!event.image;
    if(event.image){poster.href=event.image;poster.setAttribute('aria-label',`Plakat zu ${event.title} ansehen`);}else poster.removeAttribute('href');
    if (event.image) { image.src=event.image; image.alt=`Plakat: ${event.title}`; image.hidden=false; }
    else { image.removeAttribute('src'); image.alt=''; image.hidden=true; }
    banner.classList.toggle('has-event-image',Boolean(event.image));
    banner.hidden=false;
  }
  let clubEvents=[],clubEventIndex=0,clubEventConfig={events:[]};
  q('#clubEventPoster').addEventListener('click',event=>{
    const image=q('#clubEventImage');
    if(!image.getAttribute('src')) return;
    event.preventDefault();
    q('#clubPosterFull').src=image.src;
    q('#clubPosterFull').alt=image.alt;
    q('#clubPosterHeading').textContent=q('#clubEventTitle').textContent;
    q('#clubPosterDialog').showModal();
  });
  q('#closeClubPoster').addEventListener('click',()=>q('#clubPosterDialog').close());
  q('#clubPosterDialog').addEventListener('click',event=>{
    if(event.target!==event.currentTarget) return;
    const bounds=event.currentTarget.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) event.currentTarget.close();
  });
  function showClubEvent(index) {
    clubEventIndex=clubEvents.length?(index+clubEvents.length)%clubEvents.length:0;
    renderClubEvent(clubEvents[clubEventIndex]);
    q('#clubEventControls').hidden=clubEvents.length<2;
    q('#clubEventCount').textContent=`${clubEventIndex+1} / ${clubEvents.length}`;
  }
  window.setInterval(()=>{const next=dartsClubEvents(clubEventConfig);if(JSON.stringify(next)!==JSON.stringify(clubEvents)){clubEvents=next;showClubEvent(clubEventIndex);}},1000);
  q('#previousClubEvent').addEventListener('click',()=>showClubEvent(clubEventIndex-1));
  q('#nextClubEvent').addEventListener('click',()=>showClubEvent(clubEventIndex+1));
  fetch('/api/v1/darts/events',{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(8000)})
    .then(response=>response.ok?response.json():Promise.reject(new Error('events api unavailable')))
    .catch(()=>fetch('/static/darts-events.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)}).then(response=>response.ok?response.json():Promise.reject(new Error('events unavailable'))))
    .then(config=>{clubEventConfig=config;clubEvents=dartsClubEvents(config);showClubEvent(0);renderExperience();})
    .catch(()=>renderClubEvent(null));
  fetch('/api/v1/darts/appointments',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)}).then(response=>response.ok?response.json():Promise.reject(new Error('appointments unavailable'))).then(config=>{calendarEvents=dartsClubEvents({events:(config.events||[]).map(item=>({...item,startsAt:null,endsAt:null}))});renderExperience();}).catch(()=>{});
  fetch('/api/v1/darts/social-links',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)})
    .then(response=>response.ok?response.json():Promise.reject(new Error('events unavailable')))
    .then(config=>{
      const links=dartsSocialLinks(config),target=q('#socialLinksList');clubSocialLinks=links;renderJoin();
      target.replaceChildren(...links.map(item=>{const link=document.createElement('a');link.href=item.href;const copy=document.createElement('span');const label=document.createElement('strong');label.textContent=item.label;copy.append(label);if(item.showInBanner){const hint=document.createElement('small');hint.textContent=item.teaser;copy.append(hint);}link.append(window.DartsSocialIcons.create(item.platform),copy);link.target='_blank';link.rel='noopener noreferrer';link.dataset.platform=item.platform;return link;}));
      q('#socialLinks').hidden=!links.length;
      const eventLink=q('#clubEventLink'),match=links.find(item=>item.href===eventLink.href);
      if(match&&!eventLink.hidden&&!eventLink.querySelector('svg'))eventLink.prepend(window.DartsSocialIcons.create(match.platform));
    }).catch(()=>{});
  updateTvTeamControls();
  let playerProfiles={}, playerProfileBase={}, playerStatCache={};
  let playerDataLoader=null,activePlayerProfile=null,activeTeamProfile=null;
  const runWhenIdle=callback=>{
    if ('requestIdleCallback' in window) window.requestIdleCallback(callback,{timeout:2200});
    else window.setTimeout(callback,1200);
  };
  const mergePlayerProfiles=()=>{
    const ids=new Set([...Object.keys(playerProfileBase),...Object.keys(playerStatCache)]);
    playerProfiles=Object.fromEntries([...ids].map(id=>[id,{...(playerProfileBase[id]||{}),...(playerStatCache[id]||{}),playerNumber:playerProfileBase[id]?.playerNumber||playerStatCache[id]?.playerNumber||''}]));
  };
  const syncProfileRosters=()=>{
    for (const [id,profile] of Object.entries(playerProfileBase)) {
      if (!profile.name || !profile.team) continue;
      DARTS_FALLBACK_ROSTERS[profile.team] ||= [];
      const member={id:Number(id),name:profile.name,role:profile.role || 'Spieler'};
      const index=DARTS_FALLBACK_ROSTERS[profile.team].findIndex(item=>String(item.id)===id);
      if(index>=0) DARTS_FALLBACK_ROSTERS[profile.team][index]=member; else DARTS_FALLBACK_ROSTERS[profile.team].push(member);
    }
  };
  function applyPlayerData(state) {
    playerProfileBase=state.profiles.players;playerStatCache=state.stats.players;
    syncProfileRosters();mergePlayerProfiles();
    if(activePlayerProfile&&q('#playerDialog').open)renderPlayerProfile(activePlayerProfile.member,activePlayerProfile.team);
    if(activeTeamProfile&&q('#teamDialog').open)renderTeamProfile(activeTeamProfile);
  }
  function loadPlayerData(force=false) {
    if(!playerDataLoader) {
      let storage;try{storage=window.localStorage;}catch(_){}
      playerDataLoader=window.DartsPlayerData.create({parseProfiles:dartsPlayerProfiles,parseStats:dartsPlayerStats,storage,
        knownPlayers:()=>['A','B','C','D'].flatMap(code=>dartsTeamRoster(seasonData?.teams?.find(team=>team.code===code)||{code}).map(member=>({id:member.id,name:member.name,team:code}))),
        directStats:players=>window.DartsSourceFallback.loadPlayerStats(players),onUpdate:applyPlayerData});
      applyPlayerData(playerDataLoader.state);
    }
    return playerDataLoader.load(force);
  }
  let livePushAlertTimer=0;
  function closeLivePushAlert() {
    window.clearTimeout(livePushAlertTimer);
    const alert=q('#livePushAlert');
    alert.classList.remove('show');
    alert.hidden=true;
  }
  function showLivePushAlert(payload) {
    if (!payload || typeof payload !== 'object') return;
    const title=typeof payload.title === 'string' ? payload.title.trim().slice(0,120) : '';
    const body=typeof payload.body === 'string' ? payload.body.trim().slice(0,240) : '';
    if (!title && !body) return;
    q('#livePushTitle').textContent=title || 'ClubIQ Darts';
    q('#livePushBody').textContent=body || 'Neue Meldung von SV Barver Darts.';
    const alert=q('#livePushAlert');
    alert.hidden=false;
    alert.classList.remove('show');
    void alert.offsetWidth;
    alert.classList.add('show');
    window.clearTimeout(livePushAlertTimer);
    livePushAlertTimer=window.setTimeout(closeLivePushAlert,15000);
  }
  q('#closeLivePushAlert').addEventListener('click',closeLivePushAlert);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',event=>{
    if (event.data?.type === 'clubiq-darts-push') showLivePushAlert(event.data.payload);
  });
  async function pushRequest(path, payload) {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-ClubIQ-Push':'1'},body:JSON.stringify(payload)});
    if (!response.ok) { let detail='Push-Aktion fehlgeschlagen.'; try { detail=(await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    return response.json();
  }
  const preferencesKey='clubiq_darts_preferences_v1';
  let preferences=dartsPreferences(), recentHighlights=[];
  try { preferences=dartsPreferences(JSON.parse(localStorage.getItem(preferencesKey)||'{}')); } catch (_) {}
  function preferenceCheckbox(target,group,value,label,selected) {
    const row=document.createElement('label'), input=document.createElement('input');
    input.type='checkbox'; input.name=group; input.value=value; input.checked=selected;
    row.append(input,document.createTextNode(label)); target.append(row);
  }
  for (const code of ['A','B','C','D']) preferenceCheckbox(q('#pushTeams'),'teams',code,`Barver ${code}`,preferences.teams.includes(code));
  for (const [type,label] of Object.entries(DARTS_EVENT_LABELS)) preferenceCheckbox(q('#pushTypes'),'eventTypes',type,label,preferences.eventTypes.includes(type));
  function renderPlayerOptions() {
    const names=new Map();
    for (const team of seasonData?.teams || []) for (const member of dartsTeamRoster({...team,roster:team.roster || team.members || []})) {
      if (member.name) names.set(member.name,`${member.name} · ${team.code}`);
    }
    for (const name of preferences.players) if (!names.has(name)) names.set(name,name);
    q('#pushPlayers').replaceChildren();
    for (const [name,label] of [...names].sort((a,b)=>a[0].localeCompare(b[0],'de'))) preferenceCheckbox(q('#pushPlayers'),'players',name,label,preferences.players.includes(name));
    q('#playerOptionsStatus').textContent=names.size?'Du kannst auch einzelne Spieler auswählen, ohne ihre Mannschaft auszuwählen.':'Kader noch nicht verfügbar. Bitte später erneut öffnen.';
  }
  async function renderNotificationHistory() {
    try {
      const cache=await caches.open('clubiq-darts-notifications-v1');
      const response=await cache.match('/__darts_notification_history__');
      const entries=response?await response.json():[];
      const target=q('#notificationHistory'); target.replaceChildren();
      for (const item of entries.slice(0,5)) {
        const row=document.createElement('article'), title=document.createElement('strong'), body=document.createElement('p'), time=document.createElement('small');
        title.textContent=item.title; body.textContent=item.body; time.textContent=new Date(item.receivedAt).toLocaleString('de-DE'); row.append(title,body,time); target.append(row);
      }
      if (!entries.length) target.textContent='Du hast auf diesem Gerät noch keine Meldungen erhalten.';
    } catch (_) { q('#notificationHistory').textContent='Dein Browser kann die letzten Meldungen nicht anzeigen.'; }
  }
  q('#personalSettings').addEventListener('toggle',async()=>{
    if (!q('#personalSettings').open) return;
    renderNotificationHistory(); await Promise.all([loadSeason(),loadPlayerData()]); renderPlayerOptions();
  });
  q('#preferencesForm').addEventListener('submit',async event=>{
    event.preventDefault(); const form=event.currentTarget, button=form.querySelector('button[type="submit"]'); button.disabled=true;
    const data=new FormData(form), next=dartsPreferences({teams:data.getAll('teams'),players:data.getAll('players'),eventTypes:data.getAll('eventTypes')});
    try {
      const registration='serviceWorker' in navigator?await navigator.serviceWorker.getRegistration():null;
      const subscription=await registration?.pushManager.getSubscription();
      if (subscription) await pushRequest('/api/v1/darts/push/subscribe',{...subscription.toJSON(),...next});
      preferences=next;
      try { localStorage.setItem(preferencesKey,JSON.stringify(next)); } catch (_) { throw new Error('Die Auswahl gilt nur bis zum Schließen; der Browser blockiert das Speichern.'); }
      q('#preferencesStatus').textContent=subscription?'Gespeichert. Deine Benachrichtigungen wurden aktualisiert.':'Gespeichert. Aktiviere oben die Benachrichtigungen.';
    } catch (error) { q('#preferencesStatus').textContent=error.message||'Speichern fehlgeschlagen. Bitte erneut versuchen.'; }
    finally { button.disabled=false; }
  });
  async function initPushNotifications() {
    const button=q('#pushToggle');
    const health=q('#pushHealth');
    const updateHealth=async()=>{
      if (button.dataset.active !== 'true') { health.hidden=true; return; }
      try {
        const response=await fetch('/api/v1/darts/push/status',{headers:{Accept:'application/json'},cache:'no-store'});
        const status=await response.json();
        if (!response.ok) throw new Error('status unavailable');
        health.hidden=false;
        const age=Date.now()-Date.parse(status.lastSuccess||'');
        if (!status.configured) { health.dataset.state='warn'; health.textContent='Benachrichtigungen sind noch nicht eingerichtet'; }
        else if (!Number.isFinite(age)||age>180000) { health.dataset.state='warn'; health.textContent='Benachrichtigungen werden geprüft'; }
        else if (status.failed>0) { health.dataset.state='warn'; health.textContent='Meldungen konnten nicht zugestellt werden'; }
        else if (status.upstreamAvailable === true) { health.dataset.state='ok'; health.textContent='Benachrichtigungen sind bereit'; }
        else if (status.upstreamAvailable === false) { health.dataset.state='warn'; health.textContent='3K-Verbindung gestört'; }
        else { health.dataset.state='wait'; health.textContent='Benachrichtigungen werden vorbereitet'; }
        health.title=status.lastSuccess ? `Letzte erfolgreiche Prüfung: ${new Date(status.lastSuccess).toLocaleString('de-DE')}` : 'Der erste Datenabgleich läuft.';
      } catch (_) { health.hidden=false; health.dataset.state='warn'; health.textContent='Status derzeit nicht verfügbar'; }
    };
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      button.textContent='Benachrichtigungen nicht verfügbar'; button.disabled=true; return;
    }
    let registration;
    try {
      registration=await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const update=async()=>{
        const subscription=await registration.pushManager.getSubscription();
        button.dataset.active=subscription?'true':'false';
        button.setAttribute('aria-pressed',String(Boolean(subscription)));
        button.textContent=subscription?'Benachrichtigungen aktiv':'Benachrichtigungen aktivieren';
        button.title=subscription?'Klicken, um Push-Benachrichtigungen auf diesem Gerät auszuschalten':'180er, High Finishes, Legs und Ergebnisse erhalten';
      };
      await update();
      await updateHealth();
      window.setInterval(()=>{ if (!document.hidden) updateHealth(); },60000);
      if (Notification.permission==='denied') { button.textContent='Benachrichtigungen im Browser blockiert'; button.disabled=true; return; }
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try {
          const current=await registration.pushManager.getSubscription();
          if (current) {
            await pushRequest('/api/v1/darts/push/unsubscribe',{endpoint:current.endpoint});
            await current.unsubscribe();
            message('Push-Benachrichtigungen sind auf diesem Gerät ausgeschaltet.');
          } else {
            const permission=await Notification.requestPermission();
            if (permission!=='granted') throw new Error('Benachrichtigungen wurden nicht erlaubt. Du kannst sie in den Browser-Einstellungen wieder freigeben.');
            const configResponse=await fetch('/api/v1/darts/push/config',{headers:{Accept:'application/json'},cache:'no-store'});
            const config=await configResponse.json();
            if (!configResponse.ok || !config.available || !config.publicKey) throw new Error('Push-Benachrichtigungen sind auf dem Server noch nicht eingerichtet.');
            const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:pushApplicationKey(config.publicKey)});
            try { await pushRequest('/api/v1/darts/push/subscribe',{...subscription.toJSON(),...preferences}); }
            catch (error) { await subscription.unsubscribe(); throw error; }
            message('Push ist aktiv: 180er, High Finishes, gewonnene Legs sowie Einzel- und Mannschaftsergebnisse.');
          }
          await update();
          await updateHealth();
        } catch (error) { message(error.message || 'Push-Benachrichtigungen konnten nicht geändert werden.'); }
        finally { button.disabled=Notification.permission==='denied'; }
      });
    } catch (_) { button.textContent='Benachrichtigungen nicht verfügbar'; button.disabled=true; }
  }
  initPushNotifications();
  const favoriteKey = 'clubiq_darts_favorite';
  let tickerDelay = 30000, tickerData = {items:[]}, favorite = 'all', liveCenters = [];
  const serverLiveGroups = new Map();
  let serverLiveConnected = false, activeMatchDetailData = null;
  function liveRemaining(value) {
    return Number.isInteger(value) ? (value === 0 ? 'CHECK' : String(value)) : '–';
  }
  const LIVE_FINISH_GRACE_MS = 20_000;
  function normalizedLiveGames(group) {
    const now=Date.now();
    return (group?.matches || []).filter(match=>{
      if (match.active || !match.finished) return true;
      const updatedMs=Number(match.lastUpdateNs)/1e6;
      return Number.isFinite(updatedMs) && now-updatedMs<=LIVE_FINISH_GRACE_MS;
    }).map(match=>({
      id:match.id, matchKey:match.matchKey, board:match.board, mode:match.mode,
      home:{name:match.home?.name || 'Heim',remaining:match.home?.points,legs:match.home?.legs,average:match.home?.average,lastScore:match.home?.lastScore,highFinish:match.home?.highFinish,count180:match.home?.count180},
      away:{name:match.guest?.name || 'Gast',remaining:match.guest?.points,legs:match.guest?.legs,average:match.guest?.average,lastScore:match.guest?.lastScore,highFinish:match.guest?.highFinish,count180:match.guest?.count180},
      currentSide:match.currentPlayerIndex===0?'home':match.currentPlayerIndex===1?'away':null,
      lastUpdated:match.lastUpdate, active:match.active, finished:match.finished,
    }));
  }
  function liveGroupAsCenter(group) {
    const matchId=Number(group?.meta?.id || group?.groupKey);
    return {liveGroup:true,barverMatches:[{id:matchId}],pushEvents:normalizedLiveGames(group).map(game=>({
      type:'live_game',matchId,liveGameId:game.id,updatedAt:game.lastUpdated,
      text:`${game.home.name} ${Number.isInteger(game.home.legs)?game.home.legs:'–'}:${Number.isInteger(game.away.legs)?game.away.legs:'–'} ${game.away.name}`,
      homeName:game.home.name,awayName:game.away.name,homeLegs:game.home.legs,awayLegs:game.away.legs,
      homeRemaining:game.home.remaining,awayRemaining:game.away.remaining,currentSide:game.currentSide,board:game.board,
    }))};
  }
  function upsertServerLiveTickerItem(group) {
    if (!group?.groupKey) return null;
    const matchId=Number(group.meta?.id || group.groupKey);
    const existing=(tickerData.items||[]).find(entry=>entry.id===matchId);
    if (group.stale||tickerData.source==='browser-3k') return existing || null;
    if(!group.finished&&!dartsLiveGroupActive(group))return existing || null;
    if(existing?.kind==='final'&&!group.finished)return existing;
    const latest=(group.matches || []).slice().sort((a,b)=>(b.lastUpdateNs||0)-(a.lastUpdateNs||0))[0];
    let item=(tickerData.items || []).find(entry=>entry.id===matchId);
    if (!item && group.meta && !group.finished) {
      item={
        id:matchId,
        home:group.meta.home || 'Heim',
        away:group.meta.away || 'Gast',
        barverTeam:group.meta.barverTeam || null,
        barverTeams:Array.isArray(group.meta.barverTeams)?group.meta.barverTeams:[],
        barverSides:group.meta.barverSides || {},
        league:group.meta.league || null,
        competitionBadge:group.meta.competitionBadge || null,
        plannedAt:group.meta.plannedAt || null,
        url:group.meta.url || null,
        kind:'live',
        score:null,
        updatedAt:group.lastUpdate || null,
        text:`${group.meta.home || 'Heim'} gegen ${group.meta.away || 'Gast'}`,
      };
      tickerData.items=[item,...(tickerData.items || [])];
    }
    if (item) {
      if (group.finished && group.meta?.score) item.score=group.meta.score;
      else if (latest && Number.isInteger(latest.teamScoreHome)&&Number.isInteger(latest.teamScoreGuest)) item.score=`${latest.teamScoreHome}:${latest.teamScoreGuest}`;
      item.kind=group.finished?'final':'live'; item.updatedAt=group.lastUpdate || item.updatedAt;
      item.text=`${item.home} ${item.score || '–'} ${item.away}`;
    }
    return item;
  }
  function applyServerLiveGroup(group) {
    if (!group?.groupKey) return;
    serverLiveGroups.set(String(group.groupKey),group);
    if (group.stale||tickerData.source==='browser-3k') return;
    if (!demoLive && !group.stale && Array.isArray(group.events)) window.DartsBroadcast?.ingest(group.events);
    const serverCenters=[...serverLiveGroups.values()].filter(entry=>dartsLiveGroupActive(entry)).map(liveGroupAsCenter);
    const ids=new Set(serverCenters.flatMap(center=>center.barverMatches.map(match=>match.id)));
    liveCenters=[...serverCenters,...liveCenters.filter(center=>!center.liveGroup&&!(center.barverMatches || []).some(match=>ids.has(match.id)))];
    const item=upsertServerLiveTickerItem(group);
    if ((group.finished||dartsLiveGroupActive(group)) && activeMatchDetailData && q('#matchDialog')?.open && Number(q('#matchDialog').dataset.matchId)===Number(group.meta?.id || group.groupKey)) {
      activeMatchDetailData={...activeMatchDetailData,liveGames:normalizedLiveGames(group),match:{...activeMatchDetailData.match,kind:group.finished?'final':'live',score:item?.score || activeMatchDetailData.match?.score}};
      renderMatchDetail(activeMatchDetailData);
    }
    renderCompleteMatchCenter(); renderToday(tickerData); updateFreshness(!group.connected);
  }
  function initServerLiveStream() {
    if (!('EventSource' in window) || demoLive) return;
    const stream=new EventSource('/api/v1/darts/live/stream');
    const receive=event=>{
      try {
        const payload=JSON.parse(event.data);
        if (Array.isArray(payload.groups)) payload.groups.forEach(applyServerLiveGroup);
        else if (payload.group) applyServerLiveGroup(payload.group);
      } catch (_) { /* A malformed upstream update must not break the page. */ }
    };
    stream.addEventListener('snapshot',receive); stream.addEventListener('update',receive); stream.addEventListener('status',receive);
    stream.onopen=()=>{serverLiveConnected=true;updateFreshness();};
    stream.onerror=()=>{serverLiveConnected=false;updateFreshness(true);};
  }
  try { favorite = ['A','B','C','D'].includes(localStorage.getItem(favoriteKey)) ? localStorage.getItem(favoriteKey) : 'all'; } catch (_) { /* Optional preference. */ }
  function tickerTime(item) {
    if (!item.plannedAt) return '';
    try { return new Intl.DateTimeFormat('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(item.plannedAt)); }
    catch (_) { return ''; }
  }
  function barverTeam(item) {
    if (item?.barverTeam) return item.barverTeam;
    const suffix=`${item?.home || ''} ${item?.away || ''}`.match(/SV Barver Darts ([A-D1-4])/)?.[1] || '';
    return ({1:'A',2:'B',3:'C',4:'D'})[suffix] || suffix;
  }
  function renderMatchCenter(data) {
    const center = q('#matchCenterGrid');
    if (!center) return;
    const labels = {live:'LIVE',upcoming:'NÄCHSTES',final:'ERGEBNIS',pending:'VORLÄUFIG BEENDET'};
    const fragment = document.createDocumentFragment();
    const codes = ['A','B','C','D'].sort((a,b)=>favorite === a ? -1 : favorite === b ? 1 : 0);
    for (const code of codes) {
      const item=dartsMatchCenterItem(data.items,code);
      const card = document.createElement(item?.id ? 'a' : 'article');
      card.className=`match-center-card ${item?.kind || 'empty'}`;
      if (item?.id) { card.href=`#match-${item.id}`; card.addEventListener('click',event=>{ event.preventDefault(); openMatch(item.id); }); }
      const top=document.createElement('span'); top.className='match-center-team'; top.append(makeTeamJump(code,`BARVER ${code}`));
      const status=document.createElement('b'); status.className='match-center-status'; status.textContent=item ? (item.isSpecial&&item.kind==='upcoming'?competitionLabel(item):labels[item.kind]) : 'KEIN TERMIN';
      const text=document.createElement('strong'); appendTeamAwareText(text,item ? (item.text || `${item.home} ${item.score||'vs'} ${item.away}`) : 'Keine Begegnung im aktuellen Zeitraum');
      const when=document.createElement('span'); when.className='match-center-time'; when.textContent=item ? tickerTime(item) : '3K-Spielplan prüfen';
      card.append(top,status,text,when);
      const entry=document.createElement('div');entry.className='match-center-entry';
      const roster=document.createElement('button');roster.type='button';roster.className='present-team-roster';
      roster.textContent='Kader vorstellen';roster.setAttribute('aria-label',`Kader Barver ${code} vorstellen`);
      roster.addEventListener('click',()=>presentTeamRoster(code));
      entry.append(card,roster);fragment.append(entry);
    }
    center.replaceChildren(fragment);
  }
  function renderToday(data) {
    const target = q('#todayGrid');
    if (!target) return;
    const items = Array.isArray(data.items) ? data.items.slice() : [];
    const teamOrder=item=>({A:0,B:1,C:2,D:3})[barverTeam(item)] ?? 99;
    const wanted = items.sort((a,b)=>
      Number(barverTeam(b)===favorite)-Number(barverTeam(a)===favorite)
      || teamOrder(a)-teamOrder(b)
      || String(a.plannedAt || '').localeCompare(String(b.plannedAt || ''))
      || Number(a.id || 0)-Number(b.id || 0)
    );
    const liveAll = wanted.filter(item=>item.kind==='live');
    const tvActive=document.body.classList.contains('tv-live');
    const live = tvActive ? liveAll.filter(item=>(item.barverTeams || [barverTeam(item)]).filter(Boolean).some(code=>tvTeams.has(code))) : liveAll;
    const upcoming = wanted.filter(item=>item.kind==='upcoming');
    const finals = wanted.filter(item=>item.kind==='final');
    const shown = tvActive ? live : live.slice(0,1);
    target.hidden=!shown.length;
    target.dataset.liveCount=String(shown.length);
    const today = new Date().toLocaleDateString('de-DE');
    const playingToday = shown.some(item=>item.plannedAt && new Date(item.plannedAt).toLocaleDateString('de-DE')===today);
    q('#todayHeading').textContent = live.length ? 'Jetzt am Board' : 'Barver im Überblick';
    q('#todaySubtitle').textContent = tvActive && liveAll.length && !live.length
      ? 'Für deine TV-Auswahl läuft gerade keine Begegnung.'
      : live.length ? `${live.length} Begegnung${live.length===1?'':'en'} ${live.length===1?'läuft':'laufen'} gerade. Weitere Spiele findest du unter „Spiele & Mannschaften“.` : 'Heute, nächste Termine und Ergebnisse – alle Mannschaften im Blick.';
    if (!shown.length) { target.replaceChildren(); return; }
    const fragment=document.createDocumentFragment();
    for (const item of shown) {
      const card=document.createElement('article'); card.className=`today-game ${item.kind}`;
      const code=barverTeam(item); const badge=document.createElement('b'); badge.textContent=item.kind==='live'?'LIVE':item.kind==='final'?'ERGEBNIS':item.isSpecial?competitionLabel(item):'NÄCHSTES SPIEL';
      const team=document.createElement('span'); team.className='today-team';
      if (code) team.append(makeTeamJump(code,`BARVER ${code}`)); else team.textContent='SV BARVER';
      const matchLabel=document.createElement('span'); matchLabel.className='today-match-label'; matchLabel.textContent='MANNSCHAFTSSPIEL';
      const matchup=document.createElement('div'); matchup.className='today-matchup';
      const home=clubNameNode(item.home || 'Heim');
      const score=document.createElement('b'); score.textContent=item.score || 'VS';
      const away=clubNameNode(item.away || 'Gast');
      matchup.append(home,score,away);
      const when=document.createElement('span'); when.className='today-time'; when.textContent=tickerTime(item);
      card.append(badge,team,matchLabel,matchup);
      const center=liveCenters.find(entry=>(entry.barverMatches || []).some(match=>match.id===item.id));
      const events=(center?.pushEvents || []).filter(event=>event.matchId===item.id);
      const liveGames=events.filter(event=>event.type==='live_game').sort((a,b)=>{
        const boardA=Number.parseInt(a.board,10), boardB=Number.parseInt(b.board,10);
        return (Number.isFinite(boardA)?boardA:999)-(Number.isFinite(boardB)?boardB:999)
          || String(a.liveGameId || '').localeCompare(String(b.liveGameId || ''));
      });
      const current=liveGames[0]
        || events.filter(event=>event.type==='leg').sort((a,b)=>(b.order || 0)-(a.order || 0))[0]
        || events.filter(event=>event.type==='game').sort((a,b)=>(b.order || 0)-(a.order || 0))[0];
      if (current && item.kind!=='upcoming') {
        const detail=document.createElement('div'); detail.className='today-detail';
        const label=document.createElement('b'); label.className='today-boards-label'; label.textContent=liveGames.length>1?`LAUFENDE BOARDS · ${liveGames.length}`:item.kind==='live'?'LAUFENDES BOARD':'LETZTES BOARD';
        if (liveGames.length && item.kind==='live') {
          const list=document.createElement('span'); list.className='today-live-games';
          for (const game of liveGames) {
            const liveGame=document.createElement('span'); liveGame.className='today-live-game';
            if (game.board) {
              const board=document.createElement('small'); board.className='today-live-board'; board.textContent=`BOARD ${game.board}`;
              liveGame.append(board);
            }
            const scoreline=document.createElement('span'); scoreline.className='today-live-score';
            const homeSide=document.createElement('span'); homeSide.className=game.currentSide==='home'?'throwing':'';
            const homeName=matchPlayerNode(game.homeName,item.id,'home');homeName.classList.add('today-player-name');
            const homePoints=document.createElement('strong'); homePoints.textContent=liveRemaining(game.homeRemaining);
            const middle=document.createElement('span'); middle.className='today-live-middle';
            const legs=document.createElement('small'); legs.className='today-live-legs'; legs.textContent=Number.isInteger(game.homeLegs)&&Number.isInteger(game.awayLegs)?`LEGS ${game.homeLegs} : ${game.awayLegs}`:'LEG LÄUFT';
            const colon=document.createElement('b'); colon.textContent=':';
            const awaySide=document.createElement('span'); awaySide.className=game.currentSide==='away'?'throwing':'';
            const awayPoints=document.createElement('strong'); awayPoints.textContent=liveRemaining(game.awayRemaining);
            const awayName=matchPlayerNode(game.awayName,item.id,'away');awayName.classList.add('today-player-name');
            homeSide.append(homeName,homePoints); middle.append(legs,colon); awaySide.append(awayName,awayPoints); scoreline.append(homeSide,middle,awaySide);
            scoreline.setAttribute('aria-label',`${game.homeName} ${homePoints.textContent} zu ${awayPoints.textContent} ${game.awayName}. ${legs.textContent}.`);
            const fingerprint=JSON.stringify([game.homeRemaining,game.awayRemaining,game.homeLegs,game.awayLegs,game.currentSide]);const key=`${item.id}:${game.liveGameId}`;const previous=liveSnapshots.get(key);const changed=previous&&previous.fingerprint!==fingerprint;const changedAt=changed?Date.now():previous?.changedAt||0;liveSnapshots.set(key,{fingerprint,changedAt});if(liveSnapshots.size>256)liveSnapshots.delete(liveSnapshots.keys().next().value);if(changedAt&&Date.now()-changedAt<4000)liveGame.classList.add('score-updated');
            liveGame.append(scoreline);const updated=document.createElement('small');updated.className='live-game-updated';const observed=Date.parse(game.updatedAt||item.updatedAt||data.updatedAt||'');updated.textContent=Number.isFinite(observed)?`Stand: ${new Date(observed).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'})} Uhr`:'Aktualisierung wird geprüft';liveGame.append(updated);
            if (!Number.isInteger(game.homeRemaining) || !Number.isInteger(game.awayRemaining)) {
              const wait=document.createElement('small'); wait.className='today-live-wait'; wait.textContent='Punktestand wird noch geladen'; liveGame.append(wait);
            }
            list.append(liveGame);
          }
          detail.append(label,list);
        } else {
          const copy=document.createElement('span'); copy.className='today-current';
          const text=document.createElement('span'); text.textContent=current.text;
          copy.append(text); detail.append(label,copy);
        }
        card.append(detail);
      }
      const highlights=events.filter(event=>event.type==='180'||event.type==='high_finish').slice(-3);
      if (highlights.length) {
        const list=document.createElement('div'); list.className='today-highlights';
        for (const event of highlights) { const chip=document.createElement('span'); chip.textContent=event.type==='180'?`🎯 180 · ${event.player}`:`🔥 HF ${event.value} · ${event.player}`; list.append(chip); }
        card.append(list);
      }
      const report=document.createElement('button');report.type='button';report.className='calendar-button';report.textContent='Spielbericht öffnen';report.addEventListener('click',()=>openMatch(item.id));card.append(when,report); fragment.append(card);
    }
    target.replaceChildren(fragment);
  }
  const resultSnapshots=new Map(),recentResults=new Map();
  function rememberResults(matches){
    const now=Date.now();
    for(const match of matches){const previous=resultSnapshots.get(match.id),fingerprint=`${match.kind}:${match.score||''}`;if(previous&&previous!==fingerprint&&match.kind==='final')recentResults.set(match.id,now);resultSnapshots.set(match.id,fingerprint);}
    for(const [id,time] of recentResults)if(now-time>60000)recentResults.delete(id);
    while(resultSnapshots.size>256)resultSnapshots.delete(resultSnapshots.keys().next().value);
  }
  function resultBadge(match,code){
    const result=window.DartsUsability.outcome(match,code);if(!result)return null;
    const badge=document.createElement('span');badge.className=`result-badge result-${result.kind}`;badge.textContent=`${result.symbol} ${result.label}`;badge.setAttribute('aria-label',`${result.label} für Barver ${code}`);return badge;
  }
  function renderHomeTeam(matches){
    const target=q('#homeTeamOverview');target.replaceChildren();const team=teamByCode(favorite);
    q('#homeTeamHeading').textContent=team?team.name:'Mein Verein';
    if(!team){const copy=document.createElement('p');copy.textContent=favorite==='all'?'Wähle deine Mannschaft. Ihre Termine, Ergebnisse und der Tabellenplatz erscheinen dann hier.':'Mannschaftsdaten werden geladen …';target.append(copy);const choices=document.createElement('div');choices.className='home-team-choices';for(const code of ['A','B','C','D']){const button=document.createElement('button');button.type='button';button.textContent=`Barver ${code}`;button.addEventListener('click',()=>selectFavorite(code));choices.append(button);}target.append(choices);return;}
    const next=[...matches].filter(match=>(match.barverTeams||[barverTeam(match)]).includes(favorite)&&['upcoming','live'].includes(match.kind)).sort((a,b)=>Date.parse(a.plannedAt)-Date.parse(b.plannedAt))[0];
    const last=[...matches].filter(match=>match.kind==='final'&&(match.barverTeams||[barverTeam(match)]).includes(favorite)).sort((a,b)=>Date.parse(b.plannedAt||b.updatedAt||0)-Date.parse(a.plannedAt||a.updatedAt||0))[0];
    const rank=document.createElement('article');rank.className='home-team-fact';const label=document.createElement('small');label.textContent='Tabellenplatz';const number=document.createElement('strong');number.className='home-team-rank';number.textContent=team.rank||'–';const league=document.createElement('span');league.textContent=team.league?.name||'Saison 2026 / 2027';const open=document.createElement('button');open.type='button';open.textContent='Mannschaft ansehen';open.addEventListener('click',()=>openTeamByCode(favorite));rank.append(label,number,league,open);target.append(rank);
    for(const [match,title] of [[next,next?.kind==='live'?'Aktuelles Spiel':'Nächstes Spiel'],[last,'Letztes Ergebnis']]){const card=document.createElement('article');card.className='home-team-fact';const label=document.createElement('small');label.textContent=title;card.append(label);if(match){card.append(makeProfileMatch(match,favorite));if(match===next){const location=appointmentLocation({kind:'match',match});if(location){const address=document.createElement('p');address.className='home-team-address';address.textContent=location;card.append(address);const route=document.createElement('a');route.className='external home-team-route';route.href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;route.target='_blank';route.rel='noopener noreferrer';route.textContent='Route öffnen ↗';card.append(route);}}}else{const empty=document.createElement('p');empty.textContent=title==='Letztes Ergebnis'?'Noch kein Ergebnis veröffentlicht.':'Noch kein weiteres Spiel veröffentlicht.';card.append(empty);}target.append(card);}
  }
  function renderJoin(){
    const location=appointmentLocation({kind:'training'});q('#joinAddress').textContent=location||'Die Vereinsadresse konnte noch nicht geladen werden. Bitte frage beim Vereinskontakt nach.';q('#joinRoute').hidden=!location;if(location)q('#joinRoute').href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;
    const next=window.DartsExperience.nextTraining();next.location=location;q('#joinCalendar').replaceChildren(calendarButton(next));
    const links=document.createDocumentFragment();for(const item of clubSocialLinks){const link=document.createElement('a');link.href=item.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=item.label;link.prepend(window.DartsSocialIcons.create(item.platform));links.append(link);}q('#joinSocialLinks').replaceChildren(links);
  }
  function appointmentLocation(item) {
    if(item.location)return item.location;
    const code=item.kind==='training'?'A':dartsTeamCode(item.match?.home||'');
    const venue=item.match?.homeVenue?.street||item.match?.homeVenue?.city?item.match.homeVenue:(code?teamByCode(code)?.venue:null);
    return venue?[venue.name,venue.street,[venue.postalCode,venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', '):'';
  }
  function calendarButton(item) {
    const button=document.createElement('button');button.type='button';button.className='calendar-button';button.textContent='Zum Kalender hinzufügen';
    button.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([window.DartsExperience.calendar(item)],{type:'text/calendar;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`barver-${String(item.id).replace(/[^a-z0-9-]/gi,'')}.ics`;document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);});return button;
  }
  let experienceSignature='';
  function renderExperience() {
    const target=q('#nextAppointmentsList');if(!target||!window.DartsExperience)return;for(const [id,time] of recentResults)if(Date.now()-time>60000)recentResults.delete(id);
    const matches=new Map((seasonData?.matches||[]).map(m=>[m.id,m]));for(const m of tickerData.items||[])matches.set(m.id,{...matches.get(m.id),...m});
    const items=window.DartsExperience.agenda([...matches.values()],calendarEvents===null?clubEvents:calendarEvents,favorite);
    for(const item of items)item.location=appointmentLocation(item);
    const selectedTeam=teamByCode(favorite);const lastResult=[...matches.values()].filter(m=>m.kind==='final'&&(m.barverTeams||[barverTeam(m)]).includes(favorite)).sort((a,b)=>Date.parse(b.plannedAt||b.updatedAt||0)-Date.parse(a.plannedAt||a.updatedAt||0))[0];
    const signature=JSON.stringify([favorite,selectedTeam?.name,selectedTeam?.rank,items.map(item=>[item.id,item.title,item.start,item.location,item.href]),lastResult?.id,lastResult?.score,lastResult?.plannedAt,[...recentResults.keys()]]);if(signature===experienceSignature)return;experienceSignature=signature;
    renderHomeTeam([...matches.values()]);renderJoin();
    target.replaceChildren();
    for(const item of items){const card=document.createElement('article');card.className='appointment-card';const type=document.createElement('small');type.textContent={match:'Mannschaftsspiel',training:'Training',event:'Veranstaltung'}[item.kind];const title=document.createElement('h3');title.textContent=item.title;const date=document.createElement('time');date.dateTime=item.start;date.textContent=new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',weekday:'short',day:'2-digit',month:'2-digit',...(item.allDay?{}:{hour:'2-digit',minute:'2-digit'})}).format(new Date(item.start))+(item.allDay?' · ganztägig':' Uhr');const location=document.createElement('p');location.textContent=item.location||'Spielort noch nicht hinterlegt';const actions=document.createElement('div');actions.className='appointment-actions';actions.append(calendarButton(item));if(item.location){const route=document.createElement('a');route.href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(item.location)}`;route.target='_blank';route.rel='noopener noreferrer';route.textContent='Route öffnen';actions.append(route);}if(item.match){const open=document.createElement('button');open.type='button';open.textContent='Spiel ansehen';open.addEventListener('click',()=>openMatch(item.match.id));actions.append(open);}else if(item.kind==='training'){const open=document.createElement('button');open.type='button';open.textContent='Trainingsbereich öffnen';open.addEventListener('click',()=>setSection('training'));actions.append(open);}else if(item.href){const open=document.createElement('a');open.href=item.href;open.target='_blank';open.rel='noopener noreferrer';open.textContent='Mehr erfahren';actions.append(open);}card.append(type,title,date,location,actions);target.append(card);}
    q('#nextAppointmentsNote').textContent=favorite==='all'?'Alle Mannschaften und der Verein':`Barver ${favorite} und der Verein`;
    const summary=q('#myTeamSummary');summary.replaceChildren();const team=teamByCode(favorite);if(team){const heading=document.createElement('h3');heading.textContent=team.name;const rank=document.createElement('p');rank.textContent=team.rank?`Tabellenplatz ${team.rank}`:'Tabellenplatz noch nicht verfügbar';summary.append(heading,rank);const next=items.find(i=>i.kind==='match');if(next){const label=document.createElement('p');label.textContent='Nächstes Spiel';summary.append(label,makeProfileMatch(next.match,favorite));}const recent=[...matches.values()].filter(m=>m.kind==='final'&&(m.barverTeams||[barverTeam(m)]).includes(favorite)).sort((a,b)=>Date.parse(b.plannedAt||b.updatedAt||0)-Date.parse(a.plannedAt||a.updatedAt||0))[0];if(recent){const label=document.createElement('p');label.textContent='Letztes Ergebnis';summary.append(label,makeProfileMatch(recent,favorite));}const open=document.createElement('button');open.type='button';open.textContent='Mannschaft öffnen';open.addEventListener('click',()=>openTeamByCode(favorite));summary.append(open);}else{const text=document.createElement('p');text.textContent=favorite==='all'?'Wähle deine Mannschaft, um ihre Termine und Ergebnisse zuerst zu sehen.':'Die Mannschaftsdaten werden geladen …';summary.append(text);}
  }
  let profileReturnMatch=null;
  function matchPlayerNode(name,matchId,side) {
    const source=activeMatchDetailData?.match?.id===matchId?activeMatchDetailData.match:(tickerData.items||[]).find(m=>m.id===matchId)||(seasonData?.matches||[]).find(m=>m.id===matchId);
    const code=dartsTeamCode(source?.[side]||'');
    const matches=[];for(const team of seasonData?.teams||[])for(const member of dartsTeamRoster(team))if(team.code===code&&memberNameKey(member.name)===memberNameKey(name))matches.push({member,team});
    if(matches.length!==1){const span=document.createElement('span');span.textContent=name;return span;}
    const button=document.createElement('button');button.type='button';button.className='linked-player-name';button.textContent=name;button.setAttribute('aria-label',`Spielerprofil von ${name} öffnen`);button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();q('#matchDialog').close();profileReturnMatch=matchId;openPlayerProfile(matches[0].member,matches[0].team);});return button;
  }
  const liveSnapshots=new Map();
  function renderHomeSchedule() {
    const byId=new Map((seasonData?.matches||[]).map(item=>[item.id,item]));
    for (const item of tickerData.items||[]) byId.set(item.id,{...byId.get(item.id),...item});
    rememberResults([...byId.values()]);
    const groups=dartsHomeGroups([...byId.values()],{team:q('#homeTeam').value,league:q('#homeLeague').value,date:q('#homeDate').value});
    const filterSummary=q('#homeFilterSummary');
    const filters=[q('#homeTeam').value==='all'?'Alle Mannschaften':`Barver ${q('#homeTeam').value}`,q('#homeLeague').selectedOptions[0].textContent];
    if(q('#homeDate').value)filters.push(new Date(q('#homeDate').value+'T12:00:00').toLocaleDateString('de-DE'));
    filterSummary.textContent=filters.join(' · ');
    q('#homeFilters').classList.toggle('has-filters',q('#homeTeam').value!=='all'||q('#homeLeague').value!=='all'||!!q('#homeDate').value);
    const target=q('#homeSchedule'); target.replaceChildren();
    for (const [key,title] of [['today','Heute'],['upcoming','Demnächst'],['final','Letzte Ergebnisse']]) {
      const section=document.createElement('section'), heading=document.createElement('h3'); heading.textContent=title; section.append(heading);
      section.classList.toggle('is-empty',!groups[key].length);
      const limit=key==='today'?4:3;
      for (const item of groups[key].slice(0,limit)) section.append(makeProfileMatch(item,barverTeam(item)));
      if (!groups[key].length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent=seasonLoading?'Spielplan wird ergänzt …':'Keine Begegnungen für diese Auswahl.'; section.append(empty); }
      if (groups[key].length>limit) { const more=document.createElement('button'); more.type='button'; more.textContent=`Alle ${groups[key].length} Spiele anzeigen`; more.addEventListener('click',()=>{setSection('teams');q('#seasonTeam').value=q('#homeTeam').value;seasonStatus=key==='final'?'final':'upcoming';renderSeason();}); section.append(more); }
      target.append(section);
    }
    renderExperience();
  }
  function renderCompleteMatchCenter() {
    const byId=new Map((seasonData?.matches || []).map(item=>[item.id,item]));
    for (const item of tickerData.items || []) byId.set(item.id,{...byId.get(item.id),...item});
    renderMatchCenter({items:[...byId.values()]});
  }
  function renderTicker(data) {
    const track = q('#tickerTrack');
    tickerData = {...data,items:Array.isArray(data.items)?data.items.slice():[]};
    for (const group of serverLiveGroups.values()) upsertServerLiveTickerItem(group);
    renderCompleteMatchCenter();
    renderToday(tickerData);
    renderHomeSchedule();
    refreshSponsorSlots(false);
    if (!Array.isArray(tickerData.items) || !tickerData.items.length) {
      const empty = document.createElement('span'); empty.className='ticker-loading'; empty.textContent='Derzeit keine Barver-Begegnungen im aktuellen Zeitraum.';
      track.replaceChildren(empty); return;
    }
    const group = document.createElement('div'); group.className='ticker-group';
    for (const item of tickerData.items) {
      const link = document.createElement('a'); link.className=`ticker-item ${item.kind}`; link.href=`#match-${item.id}`;
      link.addEventListener('click',event=>{ event.preventDefault(); openMatch(item.id); });
      const teamCode = barverTeam(item);
      if (teamCode) { const team=document.createElement('b'); team.className='ticker-team'; team.append(makeTeamJump(teamCode,`BARVER ${teamCode}`)); link.append(team); }
      if (item.isSpecial) { const competition=document.createElement('b'); competition.className='ticker-competition'; competition.textContent=competitionLabel(item); link.append(competition); }
      const text = document.createElement('span'); appendTeamAwareText(text,item.text || `${item.home} ${item.score||'vs'} ${item.away}`); link.append(text);
      const when = tickerTime(item); if (when) { const time=document.createElement('span'); time.className='ticker-time'; time.textContent=when; link.append(time); }
      group.append(link);
    }
    for (const item of recentHighlights.filter(item=>['180','high_finish','game','match'].includes(item.type)).slice(0,12)) {
      const link=document.createElement('a'); link.className='ticker-item highlight'; link.href=`#match-${item.matchId}`;
      link.textContent=`Rückblick ${new Date(item.occurredAt).toLocaleDateString('de-DE')} · ${item.title} · ${item.body}`;
      group.append(link);
    }
    const duplicate = group.cloneNode(true); duplicate.setAttribute('aria-hidden','true'); duplicate.querySelectorAll('a,[role="link"]').forEach(link=>link.tabIndex=-1);
    track.replaceChildren(group,duplicate);
    const pixelsPerSecond=window.matchMedia('(max-width:800px)').matches?18:21;
    const duration=Math.max(80,Math.min(300,Math.round(Math.max(group.scrollWidth,window.innerWidth)/pixelsPerSecond)));
    track.style.setProperty('--ticker-duration',`${duration}s`);
    const updated = new Date(data.updatedAt);
    q('#tickerUpdated').textContent = `${data.stale ? 'Letzter Stand' : 'Stand'} ${updated.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  }
  function demoTicker(data) {
    const copy=JSON.parse(JSON.stringify(data));
    const upcoming=(copy.items || []).filter(item=>item.kind==='upcoming').slice(0,2);
    const scores=['5:4','3:2'];
    upcoming.forEach((item,index)=>{ item.kind='live'; item.score=scores[index]; item.updatedAt=new Date().toISOString(); item.text=`LIVE: ${item.home} ${item.score} ${item.away}`; });
    copy.items=[...upcoming,...(copy.items || []).filter(item=>!upcoming.some(live=>live.id===item.id))];
    copy.updatedAt=new Date().toISOString(); copy.demo=true;
    return copy;
  }
  async function loadTicker() {
    clearTimeout(tickerTimer);
    if (tickerLoading) return;
    if (document.hidden) { tickerTimer=setTimeout(loadTicker,tickerDelay); return; }
    tickerLoading=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    let payload=null;
    try {
      try {
        const response=await fetch('/api/v1/darts/ticker',{headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error('ticker unavailable');
        payload=await response.json();
        if (!Array.isArray(payload.items)) throw new Error('invalid ticker');
      } catch (_) { /* Try the independent public connection below. */ }
      clearTimeout(timeout);
      const serverFresh=payload&&!payload.stale&&Date.now()-Date.parse(payload.updatedAt||'')<180000;
      if (!demoLive&&!serverFresh&&window.DartsSourceFallback) {
        try {payload=await window.DartsSourceFallback.load();}
        catch (_) { /* Keep the server snapshot or previously displayed data. */ }
      }
      if (!payload) throw new Error('no connection');
      const rendered=demoLive?demoTicker(payload):payload;
      renderTicker(rendered);tickerDelay=payload.stale?60000:30000;
      if (!demoLive&&!payload.stale) {try {localStorage.setItem('clubiq_darts_last_ticker',JSON.stringify(payload));} catch (_) {}}
      updateFreshness();
      if (demoLive||(rendered.items||[]).some(item=>item.kind==='live')) loadLiveDetails();
      else {liveCenters=[];updateFreshness();}
    } catch (_) {
      tickerData={...tickerData,stale:true};
      tickerDelay=Math.min(120000,tickerDelay*2);updateFreshness(true);
    } finally {tickerLoading=false;clearTimeout(timeout);tickerTimer=setTimeout(loadTicker,tickerDelay);}
  }
  let tickerTimer, tickerLoading=false;
  function updateFreshness(reconnecting=false) {
    const age=Date.now()-Date.parse(tickerData.updatedAt||'');
    const detailsAge=Date.now()-(liveDetailsLoadedAt||liveDetailsFirstAttempt);
    const directDetailsFailed=tickerData.source==='browser-3k'&&(tickerData.centers||[]).some(center=>center.stale);
    const detailsStale=directDetailsFailed||((tickerData.items||[]).some(m=>m.kind==='live')&&liveDetailsFirstAttempt>0&&detailsAge>180000);
    const activeServerGroups=[...serverLiveGroups.values()].filter(group=>!group.finished&&!group.stale);
    const upstreamLiveConnected=activeServerGroups.some(group=>group.connected);
    const serverFallback=activeServerGroups.length>0&&(!serverLiveConnected||!upstreamLiveConnected);
    const serverUpdates=activeServerGroups.map(group=>Date.parse(group.lastSuccess||group.lastUpdate||'')).filter(Number.isFinite);
    const serverLiveStale=tickerData.source!=='browser-3k'&&serverUpdates.length>0&&Date.now()-Math.max(...serverUpdates)>180000;
    const stale=tickerData.stale||!Number.isFinite(age)||age>180000||detailsStale||serverLiveStale;
    const status=q('#liveDataStatus'); status.dataset.state=stale?'warn':reconnecting?'wait':'ok';
    if (demoLive) status.textContent='Demo-Live aktiv';
    else if (!Number.isFinite(age)) status.textContent='Verbindung wird aufgebaut';
    else if (tickerData.stale||age>180000) status.textContent=`Letzter Stand: ${Math.max(1,Math.floor(age/60000))} Min. alt · erneuter Abruf automatisch`;
    else if (directDetailsFailed) status.textContent='Live-Punkte nicht erreichbar · Spielstand aktuell';
    else if (detailsStale||serverLiveStale) status.textContent='Live-Punkte veraltet · erneuter Abruf automatisch';
    else if (tickerData.source==='browser-3k') status.textContent='Alternative 3K-Verbindung aktiv';
    else if (serverFallback) status.textContent='Live-Fallback aktiv · letzter Stand sichtbar';
    else if (activeServerGroups.length) status.textContent='Live-Verbindung aktiv';
    else if (reconnecting) status.textContent='Verbindung wird erneuert · letzter Stand sichtbar';
    else status.textContent='3K-Daten aktuell';
    status.title=tickerData.updatedAt?`Letzter Datenabruf: ${new Date(tickerData.updatedAt).toLocaleString('de-DE')}${tickerData.source==='browser-3k'?' · Liga-Ergebnisse direkt von 3K. Saison und Einzelpartien haben einen eigenen Datenstand.':''}`:'Noch kein Datenabruf erfolgreich';
  }
  let highlightsLoading=false, highlightsLoadedAt=0;
  async function loadHighlights() {
    if (highlightsLoading||Date.now()-highlightsLoadedAt<60000) return;
    highlightsLoading=true;
    try {
      const response=await fetch('/api/v1/darts/highlights',{signal:AbortSignal.timeout(8000)});
      if (!response.ok) return;
      recentHighlights=(await response.json()).items||[]; highlightsLoadedAt=Date.now();
      if (tickerData.items?.length) renderTicker(tickerData);
    } catch (_) { /* Keep highlights on transient failures. */ }
    finally { highlightsLoading=false; }
  }
  q('#tickerTrack').addEventListener('click',event=>{
    if (event.defaultPrevented) return;
    const team=event.target.closest('[data-team-code]');
    if (team) {event.preventDefault();openTeamByCode(team.dataset.teamCode);return;}
    const match=event.target.closest('a[href^="#match-"]');
    if (match) { event.preventDefault(); openMatch(Number(match.hash.slice(7))); }
  });
  window.addEventListener('online',()=>{loadTicker();loadHighlights();});
  document.addEventListener('visibilitychange',()=>{if (!document.hidden) {loadTicker();loadHighlights();renderNotificationHistory();}});
  window.setInterval(()=>{if (!document.hidden) {updateFreshness();loadHighlights();}},30000);
  let liveDetailsLoading=false, liveDetailsLoadedAt=0, liveDetailsFirstAttempt=0;
  async function loadLiveDetails(force=false) {
    if (tickerData.source==='browser-3k'&&Array.isArray(tickerData.centers)) {
      liveCenters=tickerData.centers;
      if (!liveDetailsFirstAttempt) liveDetailsFirstAttempt=Date.now();
      if (liveCenters.every(center=>!center.stale)) liveDetailsLoadedAt=Date.parse(tickerData.updatedAt);
      renderToday(tickerData);updateFreshness();return;
    }
    if (liveDetailsLoading || (!force && Date.now()-liveDetailsLoadedAt < 40000)) return;
    liveDetailsLoading=true;
    if (!liveDetailsFirstAttempt) liveDetailsFirstAttempt=Date.now();
    const controller=new AbortController(), timeout=window.setTimeout(()=>controller.abort(),12000);
    try {
      const results=await Promise.allSettled(['kl04','kk11'].map(async league=>{
        const response=await fetch(`/api/v1/darts/center?league=${league}`,{headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error('center unavailable');
        return response.json();
      }));
      const available=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
      if (available.length) {
        if (!demoLive) for (const center of available) {
          const key=center.league?.key;
          if (!key||center.stale) continue;
          const baseline=!broadcastBaselines.has(key);broadcastBaselines.add(key);
          const matches=new Map((center.barverMatches||[]).map(item=>[item.id,item]));
          const events=(center.pushEvents||[]).flatMap(event=>{
            const match=matches.get(event.matchId);
            if (!match || match.kind!=='live') return [];
            const code=dartsTeamCode(event.team),side=match.barverSides?.[code] || (dartsTeamCode(match.home)===code?'home':dartsTeamCode(match.away)===code?'away':'');
            return [{...event,barverSide:side}];
          });
          // Remember report facts quietly while SSE supplies the live transitions.
          // This also seeds the fallback when a stream loses its connection.
          const streamEvents=events.filter(event=>serverLiveGroups.get(String(event.matchId))?.connected);
          window.DartsBroadcast?.ingest(streamEvents,{baseline:true});
          window.DartsBroadcast?.ingest(events.filter(event=>!streamEvents.includes(event)),{baseline});
        }
        liveCenters=[...available,...liveCenters.filter(old=>!available.some(fresh=>fresh.league?.key===old.league?.key))];
        if (demoLive) {
          const liveItems=(tickerData.items || []).filter(item=>item.kind==='live');
          liveCenters.unshift({barverMatches:liveItems,pushEvents:liveItems.flatMap((item,index)=>[
            {type:'live_game',liveGameId:item.id*10+1,matchId:item.id,updatedAt:new Date().toISOString(),text:index?'Dennis Beispiel 2:1 Gegner Zwei':'Jannik Beispiel 2:1 Gegner Eins',homeName:index?'Dennis Beispiel':'Jannik Beispiel',awayName:index?'Gegner Zwei':'Gegner Eins',homeLegs:2,awayLegs:1,homeRemaining:index?167:320,awayRemaining:index?221:410,currentSide:index?'away':'home'},
            {type:'live_game',liveGameId:item.id*10+2,matchId:item.id,updatedAt:new Date(Date.now()-1000).toISOString(),text:index?'Robin Beispiel 1:1 Gegner Vier':'Tim Beispiel 1:0 Gegner Drei',homeName:index?'Robin Beispiel':'Tim Beispiel',awayName:index?'Gegner Vier':'Gegner Drei',homeLegs:1,awayLegs:index?1:0,homeRemaining:index?284:201,awayRemaining:index?356:298,currentSide:index?'home':'away'},
            {type:'180',matchId:item.id,player:index?'Tim Beispiel':'Jannik Beispiel',value:180},
            ...(index?[{type:'high_finish',matchId:item.id,player:'Dennis Beispiel',value:121}]:[]),
          ])});
        }
        if (available.length===2 && available.every(center=>!center.stale)) liveDetailsLoadedAt=Date.now();
        renderToday(tickerData);
        const stale=available.some(center=>center.stale);
        updateFreshness(stale);
      } else throw new Error('no centers');
    } catch (_) {
      updateFreshness(true);
    } finally { window.clearTimeout(timeout); liveDetailsLoading=false; }
  }
  let seasonData=null, seasonStatus='upcoming', seasonLoading=false, seasonPromise=null;
  let clubMembers=null, membersLoading=false, membersPromise=null, membersError='';
  try { const saved=JSON.parse(localStorage.getItem('clubiq_darts_last_ticker')||'null'); if (Array.isArray(saved?.items)) {renderTicker({...saved,stale:true});updateFreshness(true);} } catch (_) {}
  try { const saved=JSON.parse(localStorage.getItem('clubiq_darts_last_season')||'null'); if (Array.isArray(saved?.matches)&&Array.isArray(saved?.teams)) {seasonData=dartsSeasonRanks({...saved,stale:true});renderSeason();renderHomeSchedule();renderCompleteMatchCenter();} } catch (_) {}
  loadTicker(); initServerLiveStream();
  runWhenIdle(()=>{ loadHighlights(); loadPlayerData(); });
  for (const id of ['#homeTeam','#homeLeague','#homeDate']) q(id).addEventListener('change',renderHomeSchedule);
  q('#resetHomeFilters').addEventListener('click',()=>{q('#homeTeam').value='all';q('#homeLeague').value='all';q('#homeDate').value='';renderHomeSchedule();});
  function teamByCode(code) {
    const normalized=dartsTeamCode(`Barver ${code}`);
    return (seasonData?.teams || []).find(team=>team.code===normalized) || null;
  }
  async function openTeamByCode(code) {
    const normalized=dartsTeamCode(`Barver ${code}`);
    if (!normalized) return;
    if (!seasonData) await loadSeason();
    const team=teamByCode(normalized);
    if (!team) return;
    for (const selector of ['#matchDialog','#playerDialog','#teamDialog']) {
      const dialog=q(selector); if (dialog?.open) dialog.close();
    }
    await openTeamProfile(team);
  }
  function makeTeamJump(code, label=`Barver ${code}`) {
    const jump=document.createElement('span'); jump.className='barver-team-link'; jump.textContent=label;
    jump.dataset.teamCode=code;
    jump.setAttribute('role','link'); jump.tabIndex=0; jump.setAttribute('aria-label',`${label}, Mannschaftsseite öffnen`);
    const open=event=>{ event.preventDefault(); event.stopPropagation(); openTeamByCode(code); };
    jump.addEventListener('click',open);
    jump.addEventListener('keydown',event=>{ if (event.key==='Enter' || event.key===' ') open(event); });
    return jump;
  }
  function appendTeamCodes(target, codes, prefix='Barver ') {
    const values=[...new Set((codes || []).map(code=>dartsTeamCode(`Barver ${code}`)).filter(Boolean))];
    values.forEach((code,index)=>{ if (index) target.append(' / '); target.append(makeTeamJump(code,`${prefix}${code}`)); });
  }
  function clubNameNode(name, tag='strong') {
    const element=document.createElement(tag); const code=dartsTeamCode(name);
    if (code) element.append(makeTeamJump(code,name)); else element.textContent=name;
    return element;
  }
  function appendTeamAwareText(target, value) {
    const text=String(value || ''); const expression=/(SV\s+Barver\s+Darts\s+[A-D1-4]|Barver\s+[A-D])\b/gi;
    let start=0;
    for (const match of text.matchAll(expression)) {
      target.append(text.slice(start,match.index),makeTeamJump(dartsTeamCode(match[0]),match[0])); start=match.index+match[0].length;
    }
    target.append(text.slice(start));
  }
  function matchDate(item) {
    return formatDate(item.plannedAt || item.updatedAt,{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function matchLocation(item, team='') {
    const codes=Array.isArray(item.barverTeams) ? item.barverTeams : item.barverTeam ? [item.barverTeam] : [];
    if (codes.length>1 && !team) return 'Vereinsduell';
    const code=team || codes[0] || item.barverTeam;
    return item.barverSides?.[code]==='home' ? 'Heimspiel' : item.barverSides?.[code]==='away' ? 'Auswärtsspiel' : '';
  }
  function competitionLabel(item) {
    return item?.competitionBadge || item?.leagueShort || '3K';
  }
  function renderSpecialEvents() {
    const panel=q('#specialEvents'), target=q('#specialEventsList');
    const events=seasonData?.specialEvents || [];
    const matches=(seasonData?.matches || []).filter(item=>item.isSpecial);
    const cupActive=dartsCupActive(seasonData);q('#cupView').hidden=!cupActive;
    if(!cupActive&&q('#cupView').getAttribute('aria-pressed')==='true')setSection('today');
    panel.hidden=false;
    if (!events.length) {
      q('#specialEventsCount').textContent='Noch kein Termin erkannt';
      const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent=seasonLoading?'Pokalspiele werden geladen …':'Aktuell ist in 3K kein Pokalspiel für Barver erkannt.';
      target.replaceChildren(empty); return;
    }
    q('#specialEventsCount').textContent=`${matches.length} ${matches.length===1?'Begegnung':'Begegnungen'} erkannt`;
    const fragment=document.createDocumentFragment();
    for (const event of events) {
      const eventMatches=matches.filter(item=>item.league===`special-${event.id}`);
      const upcoming=eventMatches.find(item=>item.kind!=='final');
      const latest=[...eventMatches].reverse().find(item=>item.kind==='final');
      const featured=upcoming || latest;
      const card=document.createElement('article'); card.className='special-event-card';
      const badge=document.createElement('b'); badge.textContent=event.badge || 'SONDERSPIEL';
      const copy=document.createElement('div');
      const title=document.createElement('strong'); title.textContent=event.name;
      const meta=document.createElement('span'); meta.textContent=featured ? `${featured.round?.name || 'Wettbewerb'} · ${matchDate(featured)}` : `${event.matchCount || 0} Spiele gefunden`;
      const matchup=document.createElement('small');
      if (featured) matchup.append(clubNameNode(featured.home,'span'),` ${featured.score || 'gegen'} `,clubNameNode(featured.away,'span'));
      else matchup.textContent='Automatisch mit 3K abgeglichen';
      copy.append(title,meta,matchup); card.append(badge,copy);
      if (featured?.id) {
        const open=document.createElement('button'); open.type='button'; open.textContent=featured.kind==='final'?'Ergebnis':'Spiel öffnen'; open.addEventListener('click',()=>openMatch(featured.id)); card.append(open);
      }
      fragment.append(card);
    }
    target.replaceChildren(fragment);
  }
  function makeProfileMatch(item, code) {
    const row=document.createElement('button'); row.type='button'; row.className=`team-profile-match ${item.kind}`;
    const meta=document.createElement('span'); meta.textContent=`${competitionLabel(item)} · ${item.round?.name || 'Spiel'} · ${matchLocation(item,code)} · ${matchDate(item)}`;
    if(item.kind==='pending')meta.textContent+=' · Vorläufig beendet – Bestätigung ausstehend';
    const score=document.createElement('strong'); score.append(clubNameNode(item.home,'span'),`  ${item.score || 'vs'}  `,clubNameNode(item.away,'span'));
    row.append(meta,score);const outcome=resultBadge(item,code);if(outcome)row.append(outcome);if(recentResults.has(item.id)){row.classList.add('fresh-result');const badge=document.createElement('span');badge.className='new-result-badge';badge.textContent='Neues Ergebnis';row.append(badge);} row.addEventListener('click',()=>{ q('#teamDialog').close(); openMatch(item.id); });
    return row;
  }
  function playerInitials(name) {
    const parts=String(name || '').trim().split(/\s+/).filter(Boolean);
    return (parts.length>1 ? `${parts[0][0]}${parts.at(-1)[0]}` : parts[0]?.slice(0,2) || 'SV').toLocaleUpperCase('de-DE');
  }
  function playerAvatar(member, large=false) {
    const avatar=document.createElement('span'); avatar.className=`player-avatar${large?' large':''}`;
    const photo=member?.id ? playerProfiles[String(member.id)]?.image : '';
    if (photo) {
      const image=document.createElement('img'); image.src=photo; image.alt=`Porträt von ${member.name}`; image.loading=large?'eager':'lazy'; image.fetchPriority=large?'high':'low'; image.decoding='async';
      image.addEventListener('error',()=>{ avatar.replaceChildren(document.createTextNode(playerInitials(member.name))); avatar.classList.add('avatar-fallback'); },{once:true});
      avatar.append(image);
    } else { avatar.textContent=playerInitials(member?.name); avatar.classList.add('avatar-fallback'); }
    return avatar;
  }
  function openPlayerProfile(member, team) {
    if (!member || !team) return;
    activePlayerProfile={member,team,returnMatch:profileReturnMatch};profileReturnMatch=null;
    q('#playerProfileHeading').textContent=member.name;
    renderPlayerProfile(member,team);
    if (!q('#playerDialog').open) q('#playerDialog').showModal();
    loadPlayerData();
  }
  function renderPlayerProfile(member,team) {
    const target=q('#playerProfile');
    const profile=playerProfiles[String(member.id || '')] || {};
    const hero=document.createElement('section'); hero.className='player-profile-hero';
    const copy=document.createElement('div'); copy.className='player-profile-identity';
    const displayRole=dartsMemberRole(member,profile);
    const roleFlag=document.createElement('strong'); roleFlag.className='player-profile-kicker'; roleFlag.textContent=profile.alias ? `„${profile.alias}“` : displayRole;
    const name=document.createElement('h3'); name.textContent=member.name;
    const meta=document.createElement('p'); meta.append(`${displayRole} · `,makeTeamJump(team.code,team.name),` · ${team.league?.short || 'Verein'}`);
    const photoNote=document.createElement('small'); photoNote.textContent=profile.image?'Vereinsfoto':'Vereinsfoto kann später ergänzt werden';
    copy.append(roleFlag,name,meta,photoNote);
    const visual=document.createElement('div'); visual.className='player-profile-visual';
    const teamMark=document.createElement('b'); teamMark.className='player-profile-team-mark'; teamMark.textContent=team.code;
    visual.append(teamMark,playerAvatar(member,true)); hero.append(copy,visual);
    const facts=document.createElement('section'); facts.className='player-profile-facts';
    for (const [label,value] of [['Mannschaft',`Barver ${team.code}`],['Liga',team.league?.short || '–'],['Funktion',displayRole],['3K-Spielernummer',profile.playerNumber || 'Noch offen']]) {
      const item=document.createElement('div'); const text=document.createElement('span'); text.textContent=label; const strong=document.createElement('strong');
      if (label==='Mannschaft') strong.append(makeTeamJump(team.code,value)); else strong.textContent=value;
      item.append(text,strong); facts.append(item);
    }
    const performance=document.createElement('section'); performance.className='team-profile-section player-performance-section';
    const performanceHeader=document.createElement('div'); performanceHeader.className='player-performance-header';
    const performanceTitle=document.createElement('h3'); performanceTitle.textContent='Saisonleistung';
    const performanceSource=document.createElement('span'); performanceSource.className='player-performance-source';
    performanceSource.textContent=profile.statsSource==='3k'?'OFFIZIELLE 3K-STATISTIK':'SAISONWERTE';
    performanceHeader.append(performanceTitle,performanceSource); performance.append(performanceHeader);
    if (profile.statsUpdatedAt) {
      const performanceBody=document.createElement('div'); performanceBody.className='player-performance-body';
      const averageCard=document.createElement('div'); averageCard.className='player-performance-average';
      const averageLabel=document.createElement('span'); averageLabel.textContent=profile.statsSource==='3k'?'3K Liga-Average':'Aktueller Average';
      const averageValue=document.createElement('strong'); averageValue.textContent=profile.average===null || profile.average===undefined?'–':profile.average.toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1});
      averageCard.append(averageLabel,averageValue);
      if (profile.statsSource==='3k' && profile.average9!==null && profile.average9!==undefined) {
        const firstNine=document.createElement('small'); firstNine.className='player-performance-first9';
        firstNine.textContent=`First 9 Ø ${profile.average9.toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1})}`;
        averageCard.append(firstNine);
      }
      const metrics=document.createElement('div'); metrics.className='player-performance-metrics';
      const metricValues=[
        ['Partien',profile.gamesPlayed],
        ['Siege',profile.gamesWon],
        ['Siegquote',profile.winRate===null || profile.winRate===undefined?'–':`${profile.winRate} %`],
        ['Legs',`${profile.legsFor} : ${profile.legsAgainst}`],
        ['180er',profile.count180],
        ['Bestes Finish',profile.highFinish || '–'],
      ];
      for (const [label,value] of metricValues) {
        const item=document.createElement('div'); item.className='player-performance-metric';
        const text=document.createElement('span'); text.textContent=label;
        const strong=document.createElement('strong'); strong.textContent=value;
        item.append(text,strong); metrics.append(item);
      }
      performanceBody.append(averageCard,metrics);
      const source=document.createElement('small'); source.className='player-performance-note';
      source.textContent=profile.statsSource==='3k'
        ? `Werte aus der offiziellen 3K-Ligastatistik${profile.statsStale?' · letzter gespeicherter Stand':''}.`
        : `Aus den bisherigen Einzelpartien berechnet${profile.statsStale?' · letzter gespeicherter Stand':''}.`;
      const observed=new Date(profile.statsUpdatedAt);if(Number.isFinite(observed.getTime()))source.textContent+=` Stand: ${observed.toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} Uhr.`;
      performance.append(performanceBody,source);
    } else {
      const loading=document.createElement('p'); loading.className='player-profile-copy'; loading.textContent=playerDataLoader?.state.stats.loading?'Saisonwerte werden geladen …':playerDataLoader?.state.stats.error?'Die Saisonwerte sind gerade nicht erreichbar. Wir versuchen es automatisch erneut.':'Für diesen Spieler liegen noch keine Saisonwerte vor.';
      performance.append(loading);
    }
    const personal=profile.personal || {};
    const personalSection=document.createElement('section'); personalSection.className='team-profile-section player-personal-section';
    const personalTitle=document.createElement('h3'); personalTitle.textContent='Persönlich';
    const personalIntro=document.createElement('p'); personalIntro.className='player-profile-copy'; personalIntro.textContent='Setup, Vorbilder und die persönlichen Favoriten am Oche.';
    const personalGrid=document.createElement('div'); personalGrid.className='player-personal-grid';
    const personalFacts=[
      ['Wurfhand',({left:'Linkshänder',right:'Rechtshänder'})[personal.throwingHand] || 'Keine Angabe'],
      ['Darts',personal.darts || 'Noch offen'],
      ['Gewicht',personal.weightGrams===null || personal.weightGrams===undefined ? 'Noch offen' : `${personal.weightGrams.toLocaleString('de-DE',{maximumFractionDigits:1})} g`],
      ['PDC-Lieblingsspieler',personal.favoritePdcPlayer || 'Noch offen'],
      ['Lieblingsfinish',personal.favoriteFinish===null || personal.favoriteFinish===undefined ? 'Noch offen' : String(personal.favoriteFinish)],
      ['Checkout-Weg',personal.finishRoute || 'Noch offen'],
      ['Einlaufsong',personal.walkOnSong || 'Noch offen'],
    ];
    for (const [label,value] of personalFacts) {
      const item=document.createElement('div'); item.className=`player-personal-item${value==='Noch offen'?' is-empty':''}`;
      const text=document.createElement('span'); text.textContent=label;
      const strong=document.createElement('strong'); strong.textContent=value;
      item.append(text,strong); personalGrid.append(item);
    }
    personalSection.append(personalTitle,personalIntro,personalGrid);
    const grid=document.createElement('div'); grid.className='player-profile-grid';
    const sport=document.createElement('section'); sport.className='team-profile-section'; const sportTitle=document.createElement('h3'); sportTitle.textContent='Sportlicher Überblick'; sport.append(sportTitle);
    const role=document.createElement('p'); role.className='player-profile-copy'; role.textContent=dartsRoleSentence(member,team,profile);
    sport.append(role);
    if (team.nextMatch) { const label=document.createElement('p'); label.className='eyebrow'; label.textContent='Nächster Mannschaftstermin'; sport.append(label,makeProfileMatch(team.nextMatch,team.code)); }
    const results=document.createElement('section'); results.className='team-profile-section'; const resultsTitle=document.createElement('h3'); resultsTitle.textContent='Letzte Mannschaftsergebnisse'; results.append(resultsTitle);
    const recent=(team.matches || []).filter(item=>item.kind==='final').slice(-3).reverse();
    for (const item of recent) results.append(makeProfileMatch(item,team.code));
    if (!recent.length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent='Noch keine Ergebnisse vorhanden.'; results.append(empty); }
    const back=document.createElement('button'); back.type='button'; back.className='primary'; back.textContent=`Zurück zu Barver ${team.code}`; back.addEventListener('click',()=>{ q('#playerDialog').close(); openTeamProfile(team); });
    const actions=document.createElement('div'); actions.className='player-profile-actions'; actions.append(back);if(activePlayerProfile?.returnMatch){const returnId=activePlayerProfile.returnMatch;const returnButton=document.createElement('button');returnButton.type='button';returnButton.textContent='Zurück zum Spielbericht';returnButton.addEventListener('click',()=>{q('#playerDialog').close();openMatch(returnId);});actions.append(returnButton);}
    const status=document.createElement('div');status.className='player-data-status';status.setAttribute('role','status');
    const note=document.createElement('small'),state=playerDataLoader?.state;
    note.textContent=state?.profiles.error?'Profilangaben: letzter gespeicherter Stand. Wir versuchen es automatisch erneut.':state?.profiles.loading?'Profilangaben werden aktualisiert …':state?.stats.loading?'Saisonwerte werden aktualisiert …':profile.statsStale?'Saisonwerte: letzter gespeicherter Stand. Wir versuchen es automatisch erneut.':'';
    const retry=document.createElement('button');retry.type='button';retry.textContent='Daten aktualisieren';retry.disabled=Boolean(state?.profiles.loading||state?.stats.loading);retry.addEventListener('click',()=>loadPlayerData(true));status.append(note,retry);
    grid.append(sport,results); target.replaceChildren(hero,status,facts,performance,personalSection,grid,actions);
  }
  function openTeamProfile(team) {
    if (!team) return;
    activeTeamProfile=team;
    q('#teamProfileHeading').textContent=team.name;
    renderTeamProfile(team);
    if (!q('#teamDialog').open) q('#teamDialog').showModal();
    loadPlayerData();
  }
  function renderTeamProfile(team) {
    const target=q('#teamProfile');
    const record=team.record || {}, rosterMembers=dartsTeamRoster(team);
    const hero=document.createElement('section'); hero.className='team-profile-hero';
    const identity=document.createElement('div');
    const mark=document.createElement('b'); mark.textContent=team.code;
    const title=document.createElement('div'); const name=document.createElement('h3'); name.textContent=team.name;
    const league=document.createElement('p'); league.textContent=`${team.league?.name || ''}${team.rank?` · Tabellenplatz ${team.rank}`:''}`;
    title.append(name,league); identity.append(mark,title);
    const form=document.createElement('div'); form.className='team-form'; const formLabel=document.createElement('span'); formLabel.textContent='Form'; form.append(formLabel);
    for (const result of record.form || []) { const chip=document.createElement('b'); chip.className=result==='S'?'win':result==='N'?'loss':'draw'; chip.textContent=result; form.append(chip); }
    if (!(record.form || []).length) { const empty=document.createElement('small'); empty.textContent='Noch keine Ergebnisse'; form.append(empty); }
    hero.append(identity,form);
    const teamPhoto=['A','B'].includes(team.code) ? document.createElement('figure') : null;
    if (teamPhoto) {
      teamPhoto.className='team-group-photo';
      const wordmark=document.createElement('span'); wordmark.className='team-group-wordmark';
      const clubName=document.createElement('small'); clubName.textContent='SV BARVER DARTS';
      const teamName=document.createElement('strong'); teamName.textContent=`BARVER ${team.code}`;
      wordmark.append(clubName,teamName);
      const crest=document.createElement('img'); crest.className='team-group-crest'; crest.src='/pics/sv-barver-darts-tight-512.webp'; crest.alt=''; crest.width=340; crest.height=340; crest.loading='lazy'; crest.decoding='async';
      const image=document.createElement('img'); image.className='team-group-players'; image.src=team.code==='A'?'/pics/teams/barver-a-team-cutout.png?v=20261004-upper1':'/pics/teams/barver-b-team-cutout.webp?v=20260927-2'; image.alt=`Mannschaftsfoto SV Barver Darts ${team.code}`; image.width=team.code==='A'?1846:1600; image.height=team.code==='A'?852:738; image.loading='lazy'; image.decoding='async';
      const caption=document.createElement('figcaption'); caption.textContent=`SV Barver Darts ${team.code} · Mannschaft 2026 / 2027`;
      teamPhoto.append(wordmark,crest,image,caption);
    }
    const stats=document.createElement('section'); stats.className='team-profile-stats';
    for (const [label,value] of [['Spiele',record.played ?? 0],['Siege',record.wins ?? 0],['Unentschieden',record.draws ?? 0],['Niederlagen',record.losses ?? 0],['Spielpunkte',`${record.setsFor ?? 0}:${record.setsAgainst ?? 0}`],['Kader',rosterMembers.length]]) {
      const item=document.createElement('div'); const number=document.createElement('strong'); number.textContent=value; const text=document.createElement('span'); text.textContent=label; item.append(number,text); stats.append(item);
    }
    const grid=document.createElement('div'); grid.className='team-profile-grid';
    const schedule=document.createElement('section'); schedule.className='team-profile-section team-schedule'; const scheduleTitle=document.createElement('h3'); scheduleTitle.textContent='Spiele'; schedule.append(scheduleTitle);
    if (team.nextMatch) { const label=document.createElement('p'); label.className='eyebrow'; label.textContent='Als Nächstes'; schedule.append(label,makeProfileMatch(team.nextMatch,team.code)); }
    const recent=(team.matches || []).filter(item=>item.kind==='final').slice(-5).reverse();
    if (recent.length) { const label=document.createElement('p'); label.className='eyebrow'; label.textContent='Letzte Ergebnisse'; schedule.append(label); for (const item of recent) schedule.append(makeProfileMatch(item,team.code)); }
    if (!team.nextMatch && !recent.length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent='Noch keine Begegnungen vorhanden.'; schedule.append(empty); }
    const squad=document.createElement('section'); squad.className='team-profile-section team-squad'; const squadTitle=document.createElement('h3'); squadTitle.textContent='Kader'; squad.append(squadTitle);
    const roster=document.createElement('div'); roster.className='team-roster';
    for (const member of rosterMembers) {
      const profile=playerProfiles[String(member.id || '')] || {};
      const player=document.createElement('button'); player.type='button'; player.className='player-roster-card'; player.setAttribute('aria-label',`${member.name}, Profil öffnen`);
      player.append(playerAvatar(member));
      const playerCopy=document.createElement('span'); const playerName=document.createElement('strong'); playerName.textContent=member.name; const role=document.createElement('small'); role.textContent=dartsMemberRole(member,profile); playerCopy.append(playerName,role);
      const open=document.createElement('b'); open.textContent='›'; open.setAttribute('aria-hidden','true'); player.append(playerCopy,open);
      player.addEventListener('click',()=>{ q('#teamDialog').close(); openPlayerProfile(member,team); }); roster.append(player);
    }
    if (!rosterMembers.length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent='Kader wird von 3K noch nicht bereitgestellt.'; roster.append(empty); }
    squad.append(roster);
    if (rosterMembers.length && window.DartsBroadcast) {
      const present=document.createElement('button');present.type='button';present.className='primary';present.textContent='Kader präsentieren';
      present.addEventListener('click',()=>{
        q('#teamDialog').close();
        presentTeamRoster(team.code);
      });
      squad.append(present);
    }
    const venue=team.venue || {}; const venueSection=document.createElement('section'); venueSection.className='team-profile-section team-venue'; const venueTitle=document.createElement('h3'); venueTitle.textContent='Heimspielstätte'; venueSection.append(venueTitle);
    const venueName=document.createElement('strong'); venueName.textContent=venue.name || 'Dorfgemeinschaftshaus Barver'; const address=document.createElement('span'); address.textContent=[venue.street,[venue.postalCode,venue.city].filter(Boolean).join(' ')].filter(Boolean).join(' · '); venueSection.append(venueName,address);
    if (venue.boards) { const boards=document.createElement('small'); boards.textContent=`${venue.boards} Boards an der Spielstätte`; venueSection.append(boards); }
    const filter=document.createElement('button'); filter.type='button'; filter.className='primary'; filter.textContent='Nur Spiele dieser Mannschaft anzeigen'; filter.addEventListener('click',()=>{ q('#teamDialog').close(); q('#seasonTeam').value=team.code; renderSeason(); q('#seasonMatches').scrollIntoView({behavior:'smooth',block:'start'}); }); venueSection.append(filter);
    grid.append(schedule,squad,venueSection); target.replaceChildren(hero,...(teamPhoto?[teamPhoto]:[]),stats,grid);
  }
  function renderSeasonTeams() {
    const target=q('#seasonTeams');
    const fragment=document.createDocumentFragment();
    for (const team of seasonData?.teams || []) {
      const card=document.createElement('button'); card.type='button'; card.className='native-team-card'; card.dataset.team=team.code;
      if (q('#seasonTeam').value===team.code) card.setAttribute('aria-pressed','true');
      const badge=document.createElement('b'); badge.textContent=team.code;
      const copy=document.createElement('span');
      const title=document.createElement('strong'); title.textContent=team.name;
      const meta=document.createElement('span'); meta.textContent=`${team.league.short} · ${team.rank ? `Platz ${team.rank}` : 'Platz noch nicht verfügbar'} · ${team.record?.wins || 0} Siege`;
      const next=document.createElement('small'); next.textContent=team.nextMatch ? `${matchLocation(team.nextMatch,team.code)} · ${matchDate(team.nextMatch)}` : 'Kein weiterer Termin';
      copy.append(title,meta,next); card.append(badge,copy);
      card.addEventListener('click',()=>openTeamProfile(team));
      fragment.append(card);
    }
    target.replaceChildren(fragment.childNodes.length ? fragment : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Keine Mannschaftsdaten verfügbar.'}));
  }
  function renderSeasonMatches() {
    const team=q('#seasonTeam').value;
    let matches=(seasonData?.matches || []).filter(item=>team==='all'||(item.barverTeams || [item.barverTeam]).includes(team));
    if (seasonStatus==='upcoming') matches=matches.filter(item=>item.kind==='upcoming'||item.kind==='live');
    if (seasonStatus==='final') matches=matches.filter(item=>item.kind==='final'||item.kind==='pending').reverse();
    const headings={upcoming:'Kommende Begegnungen',final:'Ergebnisse',all:'Alle Saisonspiele'};
    q('#seasonListHeading').textContent=headings[seasonStatus];
    q('#seasonCount').textContent=`${matches.length} ${matches.length===1?'Spiel':'Spiele'}`;
    const fragment=document.createDocumentFragment();
    for (const item of matches) {
      const row=document.createElement('button'); row.type='button'; row.className=`native-match-row ${item.kind}`;
      const codes=(item.barverTeams || [item.barverTeam]).filter(Boolean);
      const info=document.createElement('span'); info.className='native-match-meta';
      appendTeamCodes(info,codes); info.append(` · ${matchLocation(item,team==='all'?'':team)} · ${competitionLabel(item)} · ${item.round?.name || 'Spieltag'} · ${matchDate(item)}`);
      const teams=document.createElement('span'); teams.className='native-match-score';
      const home=clubNameNode(item.home);
      const score=document.createElement('b'); score.textContent=item.score || 'vs';
      const away=clubNameNode(item.away);
      const state=document.createElement('span'); state.className='native-match-state'; state.textContent=item.kind==='live'?'LIVE':item.kind==='final'?'Endstand':item.kind==='pending'?'Vorläufig beendet · Bestätigung ausstehend':'Geplant';const result=resultBadge(item,team==='all'?barverTeam(item):team);if(result)state.replaceChildren(result);if(recentResults.has(item.id))row.classList.add('fresh-result');
      teams.append(home,score,away); row.append(info,teams,state);
      row.addEventListener('click',()=>openMatch(item.id)); fragment.append(row);
    }
    q('#seasonMatches').replaceChildren(fragment.childNodes.length ? fragment : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Für diese Auswahl sind keine Begegnungen vorhanden.'}));
  }
  function memberNameKey(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase('de-DE');
  }
  function memberDirectory() {
    const people=new Map();
    for (const name of clubMembers || []) {
      const clean=String(name || '').trim().slice(0,100), key=memberNameKey(clean);
      if (key) people.set(key,{name:clean,teams:[],member:null,team:null,kind:'club'});
    }
    for (const team of seasonData?.teams || []) for (const member of dartsTeamRoster({...team,roster:team.roster || team.members || []})) {
      const key=memberNameKey(member.name); if (!key) continue;
      const current=people.get(key) || {name:member.name,teams:[],member:null,team:null,kind:'teams'};
      if (!current.teams.includes(team.code)) current.teams.push(team.code);
      current.kind='teams'; current.member ||= member; current.team ||= team;
      people.set(key,current);
    }
    return [...people.values()].sort((left,right)=>left.name.localeCompare(right.name,'de',{sensitivity:'base'}));
  }
  function renderMembers() {
    const target=q('#membersGrid'), query=memberNameKey(q('#memberSearch').value), group=q('#memberGroup').value;
    const members=memberDirectory().filter(item=>(group==='all'||item.kind===group) && (!query||memberNameKey(item.name).includes(query)));
    const fragment=document.createDocumentFragment();
    for (const item of members) {
      const clickable=Boolean(item.member && item.team), card=document.createElement(clickable?'button':'article');
      if (clickable) card.type='button';
      card.className=`member-card ${item.kind}`;
      const avatar=item.member ? playerAvatar(item.member) : document.createElement('span');
      if (!item.member) { avatar.className='player-avatar avatar-fallback'; avatar.textContent=playerInitials(item.name); }
      const copy=document.createElement('span'), name=document.createElement('strong'), meta=document.createElement('small');
      name.textContent=item.name;
      if (clickable) {
        const profile=playerProfiles[String(item.member.id || '')] || {}, role=dartsMemberRole(item.member,profile);
        meta.textContent=`${role} · ${item.teams.map(code=>`Barver ${code}`).join(' · ')}`;
        card.setAttribute('aria-label',`${item.name}, Profil öffnen`);
        card.addEventListener('click',()=>openPlayerProfile(item.member,item.team));
      } else meta.textContent='Vereinsmitglied';
      copy.append(name,meta); card.append(avatar,copy);
      if (clickable) { const open=document.createElement('b'); open.textContent='›'; open.setAttribute('aria-hidden','true'); card.append(open); }
      fragment.append(card);
    }
    target.replaceChildren(fragment.childNodes.length ? fragment : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Für diese Auswahl wurden keine Mitglieder gefunden.'}));
    q('#memberCount').textContent=`${members.length} ${members.length===1?'Mitglied':'Mitglieder'}`;
    q('#membersStatus').hidden=!membersError && Array.isArray(clubMembers);
    q('#membersStatus').textContent=membersError || 'Hier findest du unsere Vereinsmitglieder und Mannschaften.';
  }
  async function loadClubMembers(force=false) {
    if (membersLoading) return membersPromise;
    if (clubMembers && !force) { renderMembers(); return; }
    membersLoading=true; q('#membersStatus').hidden=false; q('#membersStatus').textContent='Mitglieder werden geladen …';
    membersPromise=(async()=>{
      try {
        const response=await fetch('/api/v1/darts/members',{headers:{Accept:'application/json'},cache:force?'reload':'default',signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error('members unavailable');
        const data=await response.json(); clubMembers=Array.isArray(data.members)?data.members:[]; membersError='';
      } catch (_) {
        if (!clubMembers) clubMembers=[];
        membersError='Weitere Vereinsmitglieder konnten gerade nicht geladen werden. Die Mannschaftskader bleiben sichtbar.';
      } finally { membersLoading=false; renderMembers(); }
    })();
    return membersPromise;
  }
  function renderSeason() {
    renderSpecialEvents(); renderSeasonTeams(); renderSeasonMatches();
    if (!q('#membersPanel').hidden) renderMembers();
    for (const button of q('#seasonStatus').querySelectorAll('button')) button.setAttribute('aria-pressed',String(button.dataset.status===seasonStatus));
  }
  async function loadSeason(force=false) {
    if (seasonLoading) return seasonPromise;
    if (seasonData && !force) { renderSeason(); return; }
    seasonLoading=true; q('#seasonFreshness').textContent='Saison wird geladen'; q('#seasonFreshness').dataset.state='wait';
    seasonPromise=(async()=>{
    try {
      const response=await fetch('/api/v1/darts/season',{headers:{Accept:'application/json'},cache:force?'reload':'default',signal:AbortSignal.timeout(45000)});
      if (!response.ok) throw new Error('season unavailable');
      const incoming=await response.json();
      if (!Array.isArray(incoming.matches)||!Array.isArray(incoming.teams)) throw new Error('invalid season');
      if (incoming.degraded&&seasonData?.matches?.length) throw new Error('partial season');
      seasonData=dartsSeasonRanks(incoming);
      if (!demoLive&&!seasonData.stale&&!seasonData.degraded) { try {localStorage.setItem('clubiq_darts_last_season',JSON.stringify(seasonData));} catch (_) {} }
      if (demoLive) {
        const liveById=new Map((tickerData.items || []).filter(item=>item.kind==='live').map(item=>[item.id,item]));
        for (const item of seasonData.matches || []) if (liveById.has(item.id)) Object.assign(item,liveById.get(item.id),{kind:'live'});
        for (const team of seasonData.teams || []) {
          team.matches=(seasonData.matches || []).filter(item=>(item.barverTeams || [item.barverTeam]).includes(team.code));
          team.nextMatch=team.matches.find(item=>item.kind!=='final') || null;
        }
      }
      renderSeason(); renderHomeSchedule(); renderCompleteMatchCenter();
      if (q('#personalSettings').open) renderPlayerOptions();
      const seasonPartial=seasonData.degraded===true;
      const freshnessText=seasonData.stale?'Letzter verfügbarer Stand':seasonPartial?'3K teilweise erreichbar':'Mit 3K abgeglichen';
      const freshnessState=seasonData.stale||seasonPartial?'warn':'ok';
      q('#seasonFreshness').textContent=freshnessText; q('#seasonFreshness').dataset.state=freshnessState;
      q('#cupFreshness').textContent=freshnessText; q('#cupFreshness').dataset.state=freshnessState;
    } catch (_) {
      q('#seasonFreshness').textContent=seasonData?'Letzter verfügbarer Stand · erneuter Abruf automatisch':'3K gerade nicht erreichbar'; q('#seasonFreshness').dataset.state='warn';
      q('#cupFreshness').textContent=seasonData?'Letzter verfügbarer Stand · erneuter Abruf automatisch':'3K gerade nicht erreichbar'; q('#cupFreshness').dataset.state='warn';
      if (!seasonData) q('#seasonMatches').innerHTML='<p class="panel-loading">Der Saisonspielplan konnte gerade nicht geladen werden.</p>';
    } finally { seasonLoading=false; }
    })();
    return seasonPromise;
  }
  function renderMatchSummary(data) {
    const target=q('#matchDetail'),match=data.match||{};
    q('#matchHeading').textContent=`${match.home||'Heim'} gegen ${match.away||'Gast'}`;
    const summary=document.createElement('section');summary.className=`native-match-summary match-page-hero ${match.kind||''}`;
    const status=document.createElement('b');status.className='live-data-status';status.dataset.state=data.checking?'wait':data.stale||data.reportUnavailable?'warn':'ok';
    status.textContent=data.checking?'Spielplan wird geprüft':data.stale?'Letzter verfügbarer Spielplan':data.source==='browser-3k'?'Direkt von 3K geladen':'Mit 3K abgeglichen';
    const matchup=document.createElement('div');matchup.className='native-match-score large';const score=document.createElement('b');score.textContent=match.score||'vs';matchup.append(clubNameNode(match.home||'Heim'),score,clubNameNode(match.away||'Gast'));
    const facts=document.createElement('dl');facts.className='match-fixture-facts';
    const planned=Date.parse(match.plannedAt||''),location=appointmentLocation({kind:'match',match});
    const dateText=Number.isFinite(planned)?new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',weekday:'long',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(planned))+' Uhr':'Termin noch nicht bekannt';
    for(const [label,value] of [['Termin',dateText],['Spielort',location||'Spielort noch nicht hinterlegt']]) {const row=document.createElement('div'),term=document.createElement('dt'),text=document.createElement('dd');term.textContent=label;text.textContent=value;row.append(term,text);facts.append(row);}
    const note=document.createElement('p');note.className='match-detail-empty';
    note.textContent=match.kind==='upcoming'?'Die Begegnung steht noch bevor. Aufstellung und Ergebnisse folgen, sobald sie bei 3K veröffentlicht sind.':data.checking?'Der Spielbericht wird geladen. Die bekannten Begegnungsdaten bleiben sichtbar.':'Der Spielbericht ist gerade nicht erreichbar. Angezeigt werden die bekannten Begegnungsdaten.';
    const actions=document.createElement('div');actions.className='appointment-actions';
    if(Number.isFinite(planned))actions.append(calendarButton({id:match.id,title:`${match.home} gegen ${match.away}`,start:match.plannedAt,location}));
    if(location){const route=document.createElement('a');route.href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;route.target='_blank';route.rel='noopener noreferrer';route.textContent='Route öffnen';actions.append(route);}
    try {const url=new URL(data.sourceUrl||match.url);if(url.protocol==='https:'&&url.hostname==='portal.3k-darts.com'&&!url.username&&!url.password){const source=document.createElement('a');source.href=url.href;source.target='_blank';source.rel='noopener noreferrer';source.textContent='Bei 3K öffnen';actions.append(source);}} catch(_){}
    const retry=document.createElement('button');retry.type='button';retry.textContent='Aktualisieren';retry.addEventListener('click',()=>openMatch(match.id));actions.append(retry);
    summary.append(status,matchup,facts,note,actions);target.replaceChildren(summary);
  }
  function renderMatchDetail(data) {
    const target=q('#matchDetail'), match=data.match || {};
    if ((data.reportAvailable===false&&!(data.liveGames||[]).length)||(!(data.games||[]).length&&!(data.liveGames||[]).length)) {renderMatchSummary(data);return;}
    q('#matchHeading').textContent=`${match.home || 'Heim'} ${match.score || '–'} ${match.away || 'Gast'}`;
    const finished=(data.games || []).filter(game=>game.status==='FINISH'&&Number.isInteger(game.homeLegs)&&Number.isInteger(game.awayLegs));
    const homeWins=finished.filter(game=>game.homeLegs>game.awayLegs).length, awayWins=finished.filter(game=>game.awayLegs>game.homeLegs).length;
    const homeLegs=finished.reduce((sum,game)=>sum+game.homeLegs,0), awayLegs=finished.reduce((sum,game)=>sum+game.awayLegs,0);
    const homeAverages=finished.map(game=>game.home.average).filter(Number.isFinite), awayAverages=finished.map(game=>game.away.average).filter(Number.isFinite);
    const mean=values=>values.length ? (values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(1) : '–';
    const allPlayers=finished.flatMap(game=>[{name:game.home.name,average:game.home.average},{name:game.away.name,average:game.away.average}]).filter(item=>Number.isFinite(item.average));
    const best=allPlayers.sort((a,b)=>b.average-a.average)[0];
    const throws180=(data.performances || []).filter(event=>event.type==='180').reduce((sum,event)=>sum+(event.count || 1),0);
    const highFinishes=(data.performances || []).filter(event=>event.type==='high_finish'); const bestFinish=highFinishes.length?Math.max(...highFinishes.map(event=>event.value || 0)):'–';
    const uniqueNames=side=>[...new Set((data.games || []).map(game=>game[side]?.name).filter(name=>name&&name!=='–'))];
    const homeNames=uniqueNames('home'), awayNames=uniqueNames('away');
    const playerSide=player=>{
      const needle=String(player || '').toLocaleLowerCase('de-DE');
      if (homeNames.some(name=>String(name).toLocaleLowerCase('de-DE').includes(needle)||needle.includes(String(name).toLocaleLowerCase('de-DE')))) return 'home';
      if (awayNames.some(name=>String(name).toLocaleLowerCase('de-DE').includes(needle)||needle.includes(String(name).toLocaleLowerCase('de-DE')))) return 'away';
      return '';
    };
    const performancesBySide=side=>(data.performances || []).filter(event=>playerSide(event.player)===side);
    const home180=performancesBySide('home').filter(event=>event.type==='180').reduce((sum,event)=>sum+(event.count||1),0);
    const away180=performancesBySide('away').filter(event=>event.type==='180').reduce((sum,event)=>sum+(event.count||1),0);
    const sideFinish=side=>{ const values=performancesBySide(side).filter(event=>event.type==='high_finish').map(event=>event.value||0); return values.length?Math.max(...values):0; };
    const makeLiveScores=()=>{
      const liveScores=document.createElement('div'); liveScores.className='native-live-scores';
      for (const live of data.liveGames || []) {
        const panel=document.createElement('section'); panel.className='native-live-score';
        const label=document.createElement('b'); label.textContent=live.board?`BOARD ${live.board}`:'AKTUELLES LEG';
        const leg=document.createElement('span'); leg.textContent=Number.isInteger(live.home?.legs)&&Number.isInteger(live.away?.legs)?`Legstand ${live.home.legs}:${live.away.legs}`:'Leg läuft';
        const scoreline=document.createElement('div');
        const homeLive=document.createElement('span'); homeLive.className=live.currentSide==='home'?'throwing':'';
        const awayLive=document.createElement('span'); awayLive.className=live.currentSide==='away'?'throwing':'';
        const homePoints=document.createElement('strong'); homePoints.textContent=liveRemaining(live.home?.remaining);
        const awayPoints=document.createElement('strong'); awayPoints.textContent=liveRemaining(live.away?.remaining);
        const homeName=matchPlayerNode(live.home?.name || 'Heim',match.id,'home');
        const awayName=matchPlayerNode(live.away?.name || 'Gast',match.id,'away');
        const divider=document.createElement('em'); divider.textContent=':';
        homeLive.append(homePoints,homeName); awayLive.append(awayPoints,awayName); scoreline.append(homeLive,divider,awayLive);
        const facts=document.createElement('div'); facts.className='native-live-facts';
        const factLine=side=>{
          const player=live[side] || {}, line=document.createElement('small');
          const values=[];
          if (Number.isInteger(player.lastScore)) values.push(`Letzte Aufnahme ${player.lastScore}`);
          if (Number.isFinite(player.average)) values.push(`Ø ${player.average.toFixed(1)}`);
          if (Number.isInteger(player.count180)&&player.count180>0) values.push(`${player.count180}× 180`);
          if (Number.isInteger(player.highFinish)&&player.highFinish>0) values.push(`HF ${player.highFinish}`);
          line.textContent=`${player.name || (side==='home'?'Heim':'Gast')}: ${values.join(' · ') || 'Werte werden geladen'}`;
          return line;
        };
        facts.append(factLine('home'),factLine('away'));
        panel.append(label,leg,scoreline,facts); liveScores.append(panel);
      }
      if (!liveScores.childNodes.length) { const empty=document.createElement('p'); empty.className='match-detail-empty'; empty.textContent=match.kind==='live'?'3K Darts liefert noch keine Live-Spielstände.':'Diese Begegnung ist derzeit nicht live.'; liveScores.append(empty); }
      return liveScores;
    };
    const makeStats=()=>{
      const stats=document.createElement('div'); stats.className='native-match-stats';
      for (const [label,value] of [['Partien',`${homeWins}:${awayWins}`],['Legs',`${homeLegs}:${awayLegs}`],['Ø Partien',`${mean(homeAverages)} : ${mean(awayAverages)}`],['Bestes Average',best?`${best.average} · ${best.name}`:'–'],['180er',String(throws180)],['High Finish',String(bestFinish)]]) {
        const stat=document.createElement('div'); const small=document.createElement('span'); small.textContent=label; const strong=document.createElement('strong'); strong.textContent=value; stat.append(small,strong); stats.append(stat);
      }
      return stats;
    };
    const makeHighlights=()=>{
      const highlights=document.createElement('div'); highlights.className='native-highlights';
      for (const event of data.performances || []) { const chip=document.createElement('span'); chip.textContent=event.type==='180'?`🎯 180 · ${event.player}`:`🔥 High Finish ${event.value} · ${event.player}`; highlights.append(chip); }
      if (!highlights.childNodes.length) { const empty=document.createElement('p'); empty.className='match-detail-empty'; empty.textContent='Noch keine Highlights in dieser Begegnung.'; highlights.append(empty); }
      return highlights;
    };
    const tickerItems=[];
    if (match.score) tickerItems.push(`${match.kind==='final'?'🏁 Endstand':'Zwischenstand'}: ${match.home} ${match.score} ${match.away}`);
    for (const event of data.performances || []) tickerItems.push(event.type==='180'?`🎯 180 von ${event.player}`:`🔥 High Finish ${event.value} von ${event.player}`);
    for (const game of finished) { const homeWon=game.homeLegs>game.awayLegs; tickerItems.push(`✓ Spiel ${game.number}: ${homeWon?game.home.name:game.away.name} gewinnt ${homeWon?game.homeLegs:game.awayLegs}:${homeWon?game.awayLegs:game.homeLegs}`); }
    const ticker=document.createElement('div'); ticker.className='match-highlight-ticker'; ticker.setAttribute('aria-label','Highlights dieser Begegnung');
    const tickerLabel=document.createElement('strong'); tickerLabel.textContent='HIGHLIGHTS'; const tickerWindow=document.createElement('div'); const tickerTrack=document.createElement('div'); tickerTrack.className='match-highlight-track';
    for (const text of tickerItems.length?tickerItems:['Noch keine Highlights erfasst']) { const span=document.createElement('span'); span.textContent=text; tickerTrack.append(span); }
    tickerWindow.append(tickerTrack); ticker.append(tickerLabel,tickerWindow);
    const makeGames=()=>{
      const games=document.createElement('div'); games.className='native-games';
      let lastBlock='';
      for (const game of data.games || []) {
        if (game.block!==lastBlock) { const block=document.createElement('h3'); block.textContent=game.block; games.append(block); lastBlock=game.block; }
        const row=document.createElement('div'); row.className=`native-game ${game.status.toLowerCase()}`;
        const number=document.createElement('b'); number.textContent=game.number || '–';
        const homePlayer=matchPlayerNode(game.home.name,match.id,'home');if(game.home.average!==null)homePlayer.append(` (${game.home.average})`);
        const gameScore=document.createElement('strong'); gameScore.textContent=Number.isInteger(game.homeLegs)&&Number.isInteger(game.awayLegs)?`${game.homeLegs}:${game.awayLegs}`:'–';
        const awayPlayer=matchPlayerNode(game.away.name,match.id,'away');if(game.away.average!==null)awayPlayer.append(` (${game.away.average})`);
        row.append(number,homePlayer,gameScore,awayPlayer); games.append(row);
      }
      if (!(data.games || []).length) { const empty=document.createElement('p'); empty.className='panel-loading'; empty.textContent='Der Spielbericht enthält noch keine Einzelergebnisse.'; games.append(empty); }
      return games;
    };
    const makeTimeline=()=>{
      const timeline=document.createElement('div'); timeline.className='match-timeline';
      for (const live of data.liveGames || []) {
        const item=document.createElement('div'); item.className='match-timeline-item live';
        const mark=document.createElement('b'); mark.textContent='LIVE';
        const copy=document.createElement('span'); const title=document.createElement('strong'); title.textContent=`${live.home?.name || 'Heim'} gegen ${live.away?.name || 'Gast'}`;
        const detail=document.createElement('small'); detail.textContent=`${liveRemaining(live.home?.remaining)} : ${liveRemaining(live.away?.remaining)} · Legs ${Number.isInteger(live.home?.legs)?live.home.legs:'–'}:${Number.isInteger(live.away?.legs)?live.away.legs:'–'}`;
        copy.append(title,detail); item.append(mark,copy); timeline.append(item);
      }
      for (const event of data.performances || []) {
        const item=document.createElement('div'); item.className='match-timeline-item highlight';
        const mark=document.createElement('b'); mark.textContent=event.type==='180'?'180':'HF';
        const copy=document.createElement('span'); const title=document.createElement('strong'); title.textContent=event.type==='180'?`${event.player} wirft eine 180`:`High Finish ${event.value} von ${event.player}`;
        const detail=document.createElement('small'); detail.textContent=event.type==='180'?'Maximum in dieser Partie':`Finish über ${event.value} Punkte`; copy.append(title,detail); item.append(mark,copy); timeline.append(item);
      }
      for (const game of [...finished].reverse().slice(0,8)) {
        const homeWon=game.homeLegs>game.awayLegs; const winner=homeWon?game.home.name:game.away.name;
        const item=document.createElement('div'); item.className='match-timeline-item';
        const mark=document.createElement('b'); mark.textContent=String(game.number);
        const copy=document.createElement('span'); const title=document.createElement('strong'); title.textContent=`${winner} gewinnt Partie ${game.number}`;
        const detail=document.createElement('small'); detail.textContent=`${game.home.name} ${game.homeLegs}:${game.awayLegs} ${game.away.name}`; copy.append(title,detail); item.append(mark,copy); timeline.append(item);
      }
      if (!timeline.childNodes.length) { const empty=document.createElement('p'); empty.className='match-detail-empty'; empty.textContent='Der Spielverlauf füllt sich automatisch, sobald 3K Ergebnisse liefert.'; timeline.append(empty); }
      return timeline;
    };
    const makeComparison=()=>{
      const comparison=document.createElement('div'); comparison.className='match-comparison';
      const values=[
        ['Ø Partien',mean(homeAverages),mean(awayAverages)],
        ['Gewonnene Legs',homeLegs,awayLegs],
        ['180er',home180,away180],
        ['Bestes Finish',sideFinish('home')||'–',sideFinish('away')||'–'],
      ];
      for (const [label,left,right] of values) {
        const row=document.createElement('div'); const homeValue=document.createElement('strong'); homeValue.textContent=left; const center=document.createElement('span'); center.textContent=label; const awayValue=document.createElement('strong'); awayValue.textContent=right; row.append(homeValue,center,awayValue); comparison.append(row);
      }
      return comparison;
    };
    const makeLineups=()=>{
      const lineups=document.createElement('div'); lineups.className='match-lineups';
      for (const [side,label,names] of [['home',match.home || 'Heim',homeNames],['away',match.away || 'Gast',awayNames]]) {
        const column=document.createElement('section'); const title=document.createElement('h4'); title.append(clubNameNode(label,'span')); column.append(title);
        for (const name of names) { const player=matchPlayerNode(name,match.id,side); column.append(player); }
        if (!names.length) { const empty=document.createElement('small'); empty.textContent='Noch keine Aufstellung verfügbar'; column.append(empty); }
        lineups.append(column);
      }
      return lineups;
    };
    const header=document.createElement('section'); header.className=`native-match-summary match-page-hero ${match.kind || ''}`;
    const metaRow=document.createElement('div'); metaRow.className='match-page-meta';
    const meta=document.createElement('span'); appendTeamCodes(meta,(match.barverTeams || [match.barverTeam]).filter(Boolean)); meta.append(` · ${matchLocation(match)} · ${competitionLabel(match)} · ${match.round?.name || ''} · ${matchDate(match)}`);
    const freshness=document.createElement('b'); freshness.textContent=`${match.kind==='live'?'● LIVE':match.kind==='final'?'ENDSTAND':match.kind==='pending'?'VORLÄUFIG BEENDET · Bestätigung durch den Veranstalter ausstehend':'GEPLANT'} · ${data.stale?'letzter verfügbarer Stand':data.source==='browser-3k'?'direkt von 3K geladen':'mit 3K abgeglichen'}`; metaRow.append(meta,freshness);
    const matchup=document.createElement('div'); matchup.className='native-match-score large';
    const home=clubNameNode(match.home || 'Heim'); const score=document.createElement('b'); score.textContent=match.score || 'vs'; const away=clubNameNode(match.away || 'Gast'); matchup.append(home,score,away);
    const progress=document.createElement('small'); progress.textContent=`${finished.length} von ${(data.games || []).length || 12} Partien beendet`;
    header.append(metaRow,matchup,progress);
    const tabs=document.createElement('div'); tabs.className='match-detail-tabs'; tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','Begegnungsansicht');
    const panels=document.createElement('div'); panels.className='match-detail-panels';
    const tabDefinitions=[['overview','Übersicht'],['live','Live'],['games','Einzelpartien'],['stats','Statistiken']];
    const panelMap=new Map();
    for (const [id,label] of tabDefinitions) {
      const button=document.createElement('button'); button.type='button'; button.id=`match-tab-${id}`; button.textContent=label; button.setAttribute('role','tab'); button.setAttribute('aria-controls',`match-panel-${id}`); button.setAttribute('aria-selected',String(id==='overview'));
      const panel=document.createElement('section'); panel.id=`match-panel-${id}`; panel.className='match-detail-panel'; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id); panel.hidden=id!=='overview';
      button.addEventListener('click',()=>{ for (const tab of tabs.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected',String(tab===button)); for (const item of panels.querySelectorAll('[role="tabpanel"]')) item.hidden=item!==panel; });
      tabs.append(button); panels.append(panel); panelMap.set(id,panel);
    }
    const overview=panelMap.get('overview');
    if ((data.liveGames || []).length) overview.append(makeLiveScores());
    const overviewGrid=document.createElement('div'); overviewGrid.className='match-overview-grid';
    const flowSection=document.createElement('section'); flowSection.className='match-detail-section'; flowSection.innerHTML='<div class="match-detail-section-head"><h3>Spielverlauf</h3><span>Highlights und gewonnene Partien</span></div>'; flowSection.append(makeTimeline());
    const sideColumn=document.createElement('div'); sideColumn.className='match-overview-side';
    const comparisonSection=document.createElement('section'); comparisonSection.className='match-detail-section'; comparisonSection.innerHTML='<div class="match-detail-section-head"><h3>Mannschaftsvergleich</h3></div>'; comparisonSection.append(makeComparison());
    const lineupSection=document.createElement('section'); lineupSection.className='match-detail-section'; lineupSection.innerHTML='<div class="match-detail-section-head"><h3>Aufstellung</h3><span>Gemeldete Spielerinnen und Spieler</span></div>'; lineupSection.append(makeLineups());
    sideColumn.append(comparisonSection,lineupSection); overviewGrid.append(flowSection,sideColumn); overview.append(overviewGrid);
    const livePanel=panelMap.get('live'); livePanel.append(makeLiveScores()); const liveFlow=document.createElement('section'); liveFlow.className='match-detail-section'; liveFlow.innerHTML='<div class="match-detail-section-head"><h3>Live-Ereignisse</h3></div>'; liveFlow.append(makeTimeline()); livePanel.append(liveFlow);
    panelMap.get('games').append(makeGames());
    const statsPanel=panelMap.get('stats'); statsPanel.append(makeStats()); const statsGrid=document.createElement('div'); statsGrid.className='match-stats-grid';
    const compareStats=document.createElement('section'); compareStats.className='match-detail-section'; compareStats.innerHTML='<div class="match-detail-section-head"><h3>Mannschaftsvergleich</h3></div>'; compareStats.append(makeComparison());
    const performanceStats=document.createElement('section'); performanceStats.className='match-detail-section'; performanceStats.innerHTML='<div class="match-detail-section-head"><h3>Bestleistungen</h3></div>'; performanceStats.append(makeHighlights()); statsGrid.append(compareStats,performanceStats); statsPanel.append(statsGrid);
    const matchCalendar=Number.isFinite(Date.parse(match.plannedAt))?calendarButton({id:`match-${match.id}`,title:`${match.home} gegen ${match.away}`,start:match.plannedAt,location:appointmentLocation({kind:'match',match})}):null;
    const source=document.createElement('a'); source.className='external match-source'; source.href=data.sourceUrl; source.target='_blank'; source.rel='noopener noreferrer'; source.textContent='Offizielle Quelle bei 3K ↗';
    target.replaceChildren(header,ticker,tabs,panels,...(matchCalendar?[matchCalendar]:[]),source);
  }
  function demoMatchData(base) {
    const code=barverTeam(base) || 'A';
    const side=(base.home || '').includes(`Barver Darts ${code}`)?'home':'away';
    const scores=[[3,1],[2,3],[3,0],[3,2],[1,3],[3,2],[2,3],[3,2],[1,3]];
    const barverPlayers=['Jannik Beispiel','Tim Beispiel','Dennis Beispiel','Robin Beispiel','Jannik & Tim','Dennis & Robin','Max Beispiel','Jannik Beispiel','Tim Beispiel','Dennis Beispiel','Doppel Barver','Doppel Barver 2'];
    const opponents=['Gegner Eins','Gegner Zwei','Gegner Drei','Gegner Vier','Doppel Gegner','Doppel Gegner 2','Gegner Fünf','Gegner Sechs','Gegner Sieben','Gegner Acht','Doppel Gegner 3','Doppel Gegner 4'];
    const homePlayers=side==='home'?barverPlayers:opponents, awayPlayers=side==='away'?barverPlayers:opponents;
    const games=Array.from({length:12},(_,index)=>{
      const number=index+1, finished=number<=9, active=number===10, pair=finished?scores[index]:active?[2,1]:[null,null];
      return {id:9000+number,number,block:number<=4?'1. Block · Einzel':number<=6?'2. Block · Doppel':number<=10?'3. Block · Einzel':'4. Block · Doppel',status:finished?'FINISH':active?'ACTIVE':'OPEN',home:{name:homePlayers[index],average:finished?45.2+index:null},away:{name:awayPlayers[index],average:finished?41.4+index/2:null},homeLegs:pair[0],awayLegs:pair[1]};
    });
    const match={...base,kind:'live',barverTeam:code,barverTeams:[code],barverSides:{[code]:side},leagueShort:'DEMO',round:{name:'Live-Simulation'},score:'5:4'};
    const liveGames=side==='home'
      ? [{id:9010,matchKey:'demo-10',home:{name:'Jannik Beispiel',remaining:320,legs:2},away:{name:'Gegner Eins',remaining:410,legs:1},currentSide:'home',lastUpdated:new Date().toISOString()},{id:9011,matchKey:'demo-11',home:{name:'Tim Beispiel',remaining:201,legs:1},away:{name:'Gegner Drei',remaining:298,legs:0},currentSide:'away',lastUpdated:new Date(Date.now()-1000).toISOString()}]
      : [{id:9010,matchKey:'demo-10',home:{name:'Gegner Eins',remaining:410,legs:1},away:{name:'Jannik Beispiel',remaining:320,legs:2},currentSide:'away',lastUpdated:new Date().toISOString()},{id:9011,matchKey:'demo-11',home:{name:'Gegner Drei',remaining:298,legs:0},away:{name:'Tim Beispiel',remaining:201,legs:1},currentSide:'home',lastUpdated:new Date(Date.now()-1000).toISOString()}];
    return {available:true,stale:false,demo:true,match,games,liveGames,performances:[{type:'180',player:'Jannik Beispiel',count:2,value:180},{type:'high_finish',player:'Dennis Beispiel',count:1,value:121}],sourceUrl:base.url || '#'};
  }
  let matchLoadSequence=0,matchRequestController=null;
  async function openMatch(matchId) {
    matchId=Number(matchId);if(!Number.isSafeInteger(matchId)||matchId<=0)return;
    const sequence=++matchLoadSequence;
    matchRequestController?.abort();
    const controller=new AbortController();matchRequestController=controller;
    q('#matchDialog').dataset.matchId=String(matchId);
    const scheduled=(seasonData?.matches||[]).find(item=>item.id===matchId);
    const latest=(tickerData.items||[]).find(item=>item.id===matchId);
    const knownMatch=scheduled||latest?{...scheduled,...latest}:null;
    const summary=knownMatch?{available:true,stale:true,checking:true,reportAvailable:false,match:knownMatch,games:[],liveGames:[],performances:[],sourceUrl:knownMatch.url}:null;
    const sponsorSlot=q('#sponsorMatch');sponsorSlot.dataset.teams=(knownMatch?.barverTeams||[barverTeam(knownMatch)]).filter(Boolean).join(',');refreshSponsorSlots(false);
    activeMatchDetailData=summary;
    if(summary)renderMatchDetail(summary);
    else {q('#matchHeading').textContent='Begegnung';q('#matchDetail').innerHTML='<p class="panel-loading">Spielbericht wird geladen …</p>';}
    if(!q('#matchDialog').open)q('#matchDialog').showModal();
    let payload=null;
    try {
      if(demoLive&&knownMatch?.kind==='live'){activeMatchDetailData=demoMatchData(knownMatch);renderMatchDetail(activeMatchDetailData);q('#matchHeading').textContent=`DEMO · ${q('#matchHeading').textContent}`;return;}
      const timeout=setTimeout(()=>controller.abort(),6000);
      try {
        const response=await fetch(`/api/v1/darts/matches/${matchId}`,{headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('match unavailable');
        payload=await response.json();
        if(payload.match?.id!==matchId)throw new Error('wrong match');
      } catch(_) { /* Try the independent public source or retain known facts. */ }
      finally {clearTimeout(timeout);}
      if(sequence!==matchLoadSequence||!q('#matchDialog').open)return;
      if((!payload||payload.stale||payload.reportAvailable===false)&&knownMatch&&window.DartsSourceFallback?.loadMatch){
        // The server timeout must not cancel the independent connection.
        const directController=new AbortController();matchRequestController=directController;
        try {
          const scheduledNow=(seasonData?.matches||[]).find(item=>item.id===matchId);
          const direct=await window.DartsSourceFallback.loadMatch({...scheduledNow,...payload?.match,...knownMatch},directController.signal);
          if(direct.reportAvailable||!payload?.games?.length)payload=direct;
        } catch(_) { /* The known fixture remains useful if both sources fail. */ }
      }
      if(sequence!==matchLoadSequence||!q('#matchDialog').open)return;
      if(!payload&&summary)payload={...summary,checking:false,reportUnavailable:true};
      if(!payload)throw new Error('no known match');
      activeMatchDetailData=payload;
      const group=serverLiveGroups.get(String(matchId));
      if(group&&!group.stale&&payload.source!=='browser-3k'&&tickerData.source!=='browser-3k')activeMatchDetailData={...payload,liveGames:normalizedLiveGames(group)};
      renderMatchDetail(activeMatchDetailData);
    } catch(_) {
      if(sequence!==matchLoadSequence||!q('#matchDialog').open)return;
      if(summary){activeMatchDetailData={...summary,checking:false,reportUnavailable:true};renderMatchDetail(activeMatchDetailData);}
      else q('#matchDetail').innerHTML='<p class="error">Für diese Begegnung sind gerade keine Daten verfügbar.</p>';
    }
  }
  const activityUrl = 'https://portal.3k-darts.com/frontend/events/5/mandant/1931';
  let activityLoaded = false;
  const layoutKey = 'clubiq_darts_layout';
  let layout = dartsLayout(null), focused = null;
  try { layout = dartsLayout(JSON.parse(localStorage.getItem(layoutKey))); } catch (_) { /* Use defaults. */ }
  layout.auto = false;
  function saveLayout() {
    for (const [id,c] of cards) layout.modes[id] = c.select.value;
    try { localStorage.setItem(layoutKey,JSON.stringify(layout)); }
    catch (_) { message('Diese Auswahl gilt nur für die aktuelle Sitzung.'); }
  }
  function applyLayout() {
    const ids = focused ? [focused] : layout.selected;
    grid.dataset.count = String(ids.length);
    grid.classList.toggle('focused',ids.length === 1);
    q('#gameCount').value = String(layout.count);
    q('#autoLoad').checked = layout.auto;
    for (const [id,c] of cards) {
      c.card.hidden = !ids.includes(id);
      c.focus.textContent = focused === id ? 'Zurück' : 'Groß';
      c.focus.setAttribute('aria-pressed',String(focused === id));
      c.focus.setAttribute('aria-label',focused === id ? 'Zurück zur Auswahl' : `${DARTS_TEAMS.find(t=>t.id===id).name} vergrößern`);
    }
    for (const button of q('#teamChoices').querySelectorAll('button')) button.setAttribute('aria-pressed',String(layout.selected.includes(button.dataset.team)));
  }
  const trainingKey = 'clubiq_darts_training';
  const exampleTraining = 'https://portal.3k-darts.com/frontend/events/5/event/32260/participants';
  let training = dartsTraining(exampleTraining);
  try { const saved = localStorage.getItem(trainingKey); if (saved) training = dartsTraining(saved); } catch (_) { /* Keep the verified example; no external request. */ }
  function syncTraining() {
    q('#trainingUrl').value = training.source;
    q('#trainingLabel').textContent = training.event === '32260' ? 'Training 22.09.2026' : `Training · 3K-Veranstaltung ${training.event}`;
    q('#trainingMode').querySelector('[value="games"]').disabled = !training.games;
    if (!training[q('#trainingMode').value]) q('#trainingMode').value = 'participants';
    q('#trainingExternal').href = training[q('#trainingMode').value];
  }
  function openJoin(){setSection('join');renderJoin();loadSeason().then(renderJoin);}
  q('#joinView').addEventListener('click',openJoin);q('#joinTeaserButton').addEventListener('click',openJoin);
  function focusSection(){const ids={today:'homeTeamHeading',teams:'seasonHeading',league:'leagueHeading',ranking:'rankingHeading',tv:'tvScheduleHeading',join:'joinHeading',members:'membersHeading',training:'trainingHeading',cup:'cupHeading'};const heading=q(`#${ids[currentSection]||'homeTeamHeading'}`);if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});heading.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});}}
  const mobileTargets={today:'todayView',teams:'gridView',league:'leagueView'};
  for(const button of document.querySelectorAll('[data-mobile-section]'))button.addEventListener('click',()=>{const section=button.dataset.mobileSection;if(section==='more')q('#mobileMenuDialog').showModal();else{q(`#${mobileTargets[section]}`).click();focusSection();}});
  q('#closeMobileMenu').addEventListener('click',()=>q('#mobileMenuDialog').close());
  for(const button of document.querySelectorAll('[data-menu-target]'))button.addEventListener('click',()=>{q('#mobileMenuDialog').close();q(`#${button.dataset.menuTarget}`).click();if(!['personalSettingsToggle','fullscreen'].includes(button.dataset.menuTarget))focusSection();});
  function loadTraining() {
      syncTraining();
    const iframe = document.createElement('iframe');
    iframe.title = `Vereinstraining – ${q('#trainingMode').selectedOptions[0].textContent}`;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = training[q('#trainingMode').value];
    q('#trainingFrame').replaceChildren(iframe);
    q('#trainingNote').textContent = 'Das Training wird direkt aus 3K Darts angezeigt. Falls die Ansicht leer bleibt, wähle „Bei 3K öffnen“.';
  }
  const centerControllers = new Map();
  const savedCenters = new Map();
  const visibleCenters = new Map();
  try {
    const saved=JSON.parse(localStorage.getItem('clubiq_darts_last_centers')||'[]');
    for(const data of Array.isArray(saved)?saved.slice(-12):[])if(['kl04','kk11'].includes(data?.league?.key)&&Number.isSafeInteger(data.selectedRound?.id)&&Array.isArray(data.matches)&&Array.isArray(data.standings))savedCenters.set(`${data.league.key}:${data.selectedRound.id}`,data);
  } catch(_) { /* Stored public data is optional. */ }
  function storedCenter(key,roundId) {
    const candidates=[...savedCenters.values()].filter(data=>data.league.key===key&&(roundId===null||data.selectedRound.id===Number(roundId)));
    return candidates.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
  }
  function centerStatus(block,text,warn=false) {
    const status=block.querySelector('[data-role="source-status"]');
    status.textContent=text;status.dataset.state=warn?'warn':'ok';
  }
  function formatDate(value, options={weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}) {
    try { return new Intl.DateTimeFormat('de-DE',options).format(new Date(value)); } catch (_) { return ''; }
  }
  function renderLeague(data) {
    const block=q(`.league-block[data-league="${data.league.key}"]`);
    if (!block) return;
    const inside=selector=>block.querySelector(selector);
    const round = data.selectedRound || {};
    visibleCenters.set(data.league.key,data);
    const partial=data.degraded||data.matchesUnavailable||data.standingsUnavailable||data.eventsUnavailable;
    const checked=formatDate(data.updatedAt,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    centerStatus(block,data.stale?`Letzter verfügbarer Stand · ${checked}`:partial?'Ein Teil der Daten ist gerade nicht erreichbar.':data.source==='browser-3k'?'Direkt von 3K geladen':'3K-Daten aktuell',Boolean(data.stale||partial));
    inside('[data-role="round-heading"]').textContent = `${round.name || 'Spieltag'} · ${data.league.short}`;
    inside('[data-role="round-date"]').textContent = formatDate(round.dateFrom);
    const roundStatus=inside('[data-role="round-status"]'), status=data.roundStatus || {};
    if (roundStatus) {
      roundStatus.dataset.state=status.complete?'complete':'open';
      roundStatus.textContent=data.matchesUnavailable?'Spielstatus nicht verfügbar':status.complete
        ? 'Spieltag abgeschlossen'
        : `${status.openMatches || 0} Spiel${status.openMatches===1?'':'e'} offen${status.movedMatches?` · ${status.movedMatches} verlegt`:''}`;
    }
    const roundSelect=inside('[data-role="round"]');
    const current=String(round.id || '');
    roundSelect.replaceChildren(...(data.rounds || []).map(item=>{
      const option=document.createElement('option'); option.value=String(item.id); option.textContent=`${item.name} · ${formatDate(item.dateFrom,{day:'2-digit',month:'2-digit'})}`; return option;
    }));
    roundSelect.value=current;
    const games=document.createDocumentFragment();
    for (const item of data.matches || []) {
      const link=document.createElement('a'); link.className=`round-match ${item.kind}`; link.href=`#match-${item.id}`; link.addEventListener('click',event=>{ event.preventDefault(); openMatch(item.id); });
      const home=document.createElement('span'); home.textContent=item.home;
      const score=document.createElement('b'); score.textContent=item.score || '–';
      const away=document.createElement('span'); away.textContent=item.away;
      const state=document.createElement('small'); state.textContent=item.kind==='final'?'Endstand':item.kind==='live'?'Live':item.kind==='pending'?'Vorläufig beendet · Bestätigung ausstehend':tickerTime(item);
      link.append(home,score,away,state); games.append(link);
    }
    inside('[data-role="matches"]').replaceChildren(games.childNodes.length ? games : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:data.matchesUnavailable?'Die Begegnungen sind gerade nicht erreichbar.':'Keine Begegnungen an diesem Spieltag.'}));
    const table=document.createElement('table');table.className='league-standings-table';
    const caption=document.createElement('caption');caption.textContent=data.stale||data.standingsStale?`Offizielle 3K-Tabelle · letzter verfügbarer Stand (${formatDate(data.standingsUpdatedAt||data.updatedAt,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})})`:'Offizielle 3K-Tabelle · aktueller Gesamtstand';table.append(caption);
    const columns=[['Pl.','rank'],['Mannschaft','name'],['Punkte','points'],['Sp.','played'],['S','wins'],['U','draws'],['N','losses'],['Sets','sets'],['Legs','legs']];
    const head=document.createElement('thead'),header=document.createElement('tr');
    for(const [label] of columns){const th=document.createElement('th');th.scope='col';th.textContent=label;header.append(th);}head.append(header);table.append(head);
    const body=document.createElement('tbody');
    const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('de-DE'):'–';
    const pair=(left,right)=>typeof left==='number'&&typeof right==='number'?`${number(left)}:${number(right)}`:'–';
    for(const entry of data.standings || []){
      const row=document.createElement('tr');if(entry.barver)row.className='barver';
      const values={...entry,rank:dartsTableRank(entry),points:pair(entry.pointsFor,entry.pointsAgainst),sets:pair(entry.setsFor,entry.setsAgainst),legs:pair(entry.legsFor,entry.legsAgainst)};
      for(const [,key] of columns){const cell=document.createElement(key==='name'?'th':'td');if(key==='name')cell.scope='row';cell.textContent=key==='name'?entry.name:['points','sets','legs'].includes(key)?values[key]:number(values[key]);row.append(cell);}body.append(row);
    }
    table.append(body);
    const root=inside('[data-role="standings"]');
    root.replaceChildren(body.childNodes.length?table:Object.assign(document.createElement('p'),{className:'panel-loading',textContent:data.standingsUnavailable?'Die Tabelle ist gerade nicht erreichbar.':'Noch keine Tabelle verfügbar.'}));
    const eventList=document.createDocumentFragment();
    for (const item of data.events || []) {
      const event=document.createElement('div'); event.className=`darts-event ${item.type}`;
      const icons={180:'180',high_finish:'HF',match:'🏁',game:'✓'};
      const icon=document.createElement('b'); icon.textContent=icons[item.type] || '→';
      const copy=document.createElement('div'); const title=document.createElement('strong'); title.textContent=item.title; const text=document.createElement('span'); text.textContent=item.text;
      copy.append(title,text); event.append(icon,copy); eventList.append(event);
    }
    if(data.eventsUnavailable)eventList.append(Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Weitere Highlights sind gerade nicht erreichbar.'}));
    inside('[data-role="events"]').replaceChildren(eventList.childNodes.length ? eventList : Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Für diesen Spieltag sind noch keine Highlights erfasst.'}));
  }
  async function loadLeague(leagueKey,roundId=null) {
    if(!['kl04','kk11'].includes(leagueKey))return;
    centerControllers.get(leagueKey)?.abort();
    const controller=new AbortController(); centerControllers.set(leagueKey,controller);
    const block=q(`.league-block[data-league="${leagueKey}"]`); if (!block) return;
    const wanted=/^\d+$/.test(String(roundId || ''))?Number(roundId):null;
    const round=wanted!==null?`&round_id=${wanted}`:'';
    const cached=storedCenter(leagueKey,wanted);
    if(cached)renderLeague({...cached,stale:true});
    centerStatus(block,'Daten werden aktualisiert …');
    const reload=block.querySelector('[data-role="reload"]');reload.disabled=true;
    const current=()=>centerControllers.get(leagueKey)===controller&&!controller.signal.aborted;
    let payload=null;
    try {
      const primary=new AbortController(),abort=()=>primary.abort(),timeout=setTimeout(abort,6000);
      controller.signal.addEventListener('abort',abort,{once:true});
      try {
        const response=await fetch(`/api/v1/darts/center?league=${encodeURIComponent(leagueKey)}${round}`,{headers:{Accept:'application/json'},signal:primary.signal});
        if(!response.ok)throw new Error('league unavailable');
        const data=await response.json();
        if(data.league?.key!==leagueKey||!Number.isSafeInteger(data.selectedRound?.id)||(wanted!==null&&data.selectedRound.id!==wanted)||!Array.isArray(data.standings)||!Array.isArray(data.matches))throw new Error('Invalid league response');
        if(data.standings.some(row=>row.rankSource!=='3k-placement'||!Object.hasOwn(row,'pointsFor')||!Object.hasOwn(row,'played'))){data.standingsUnavailable=true;data.degraded=true;}
        payload=data;
        if(current())renderLeague(data);
      } catch(_) { /* Try the independent public connection below. */ }
      finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',abort);}
      if(!current())return;
      if((!payload||payload.stale||payload.degraded||Date.now()-Date.parse(payload.updatedAt)>120000)&&window.DartsSourceFallback?.loadCenter) {
        centerStatus(block,payload?'Letzter verfügbarer Stand · Verbindung wird geprüft …':'Alternative Verbindung wird geprüft …',Boolean(payload));
        try {
          const direct=await window.DartsSourceFallback.loadCenter(leagueKey,wanted,controller.signal);
          if(!current())return;
          const previous=payload||storedCenter(leagueKey,direct.selectedRound.id);
          const tablePrevious=previous||visibleCenters.get(leagueKey);
          if(direct.standingsUnavailable&&tablePrevious?.standings?.length){direct.standings=tablePrevious.standings;direct.standingsStale=true;direct.standingsUpdatedAt=tablePrevious.standingsUpdatedAt||tablePrevious.updatedAt;}
          if(direct.matchesUnavailable&&previous?.selectedRound.id===direct.selectedRound.id&&previous.matches?.length){direct.matches=previous.matches;direct.matchesStale=true;direct.matchesUpdatedAt=previous.matchesUpdatedAt||previous.updatedAt;}
          payload=direct;
        } catch(_) { /* Keep the dated server or browser snapshot. */ }
      }
      if(!current())return;
      if(!payload&&cached)payload={...cached,stale:true};
      if(!payload)throw new Error('League sources unavailable');
      renderLeague(payload);
      if(!payload.stale) {
        savedCenters.set(`${leagueKey}:${payload.selectedRound.id}`,payload);
        if(savedCenters.size>12)savedCenters.delete(savedCenters.keys().next().value);
        try{localStorage.setItem('clubiq_darts_last_centers',JSON.stringify([...savedCenters.values()]));}catch(_){}
      }
    } catch (error) {
      if(!current())return;
      const previous=visibleCenters.get(leagueKey);
      if(previous){renderLeague({...previous,stale:true});centerStatus(block,'Der gewählte Spieltag ist gerade nicht erreichbar. Der letzte verfügbare Stand bleibt sichtbar.',true);}
      else {
        for(const role of ['matches','standings','events'])block.querySelector(`[data-role="${role}"]`).replaceChildren(Object.assign(document.createElement('p'),{className:'panel-loading',textContent:'Die Daten sind gerade nicht erreichbar. Bitte später aktualisieren oder bei 3K öffnen.'}));
        block.querySelector('[data-role="round"]').replaceChildren(Object.assign(document.createElement('option'),{textContent:'Spieltag nicht verfügbar',value:''}));
        block.querySelector('[data-role="round-status"]').textContent='Nicht erreichbar';
        centerStatus(block,'Beide Verbindungen sind gerade nicht erreichbar.',true);
      }
    } finally {
      if(centerControllers.get(leagueKey)===controller)reload.disabled=false;
    }
  }
  let rankingData=null, rankingLoading=false,rankingPage=0,rankingOurs=false;
  const rankingNumber=value=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(value):'–';
  function renderRanking() {
    if(!rankingData)return;
    const search=q('#rankingSearch').value.trim().toLocaleLowerCase('de-DE'),roundId=Number(q('#rankingRound').value)||null;
    q('#rankingRoundHeading').hidden=!roundId;
    const fragment=document.createDocumentFragment();
    const result=window.DartsUsability.rankingPage(rankingData.rows,{search,ours:rankingOurs,names:memberDirectory().map(member=>member.name),page:rankingPage});rankingPage=result.page;
    q('#rankingPrevious').disabled=rankingPage===0;q('#rankingNextPage').disabled=rankingPage+1>=result.pages;q('#rankingPageStatus').textContent=result.total?`${result.from}–${result.to} von ${result.total} ${result.total===1?'Spieler':'Spielern'}`:'Keine passenden Spieler';
    for(const row of result.rows){
      const tr=document.createElement('tr');
      for(const value of [rankingNumber(row.rank),row.name,rankingNumber(row.points),rankingNumber(row.appearances),rankingNumber(row.average)]){const cell=document.createElement('td');cell.textContent=value;tr.append(cell);}
      if(roundId){const round=(row.rounds||[]).find(item=>item.id===roundId);const cell=document.createElement('td');cell.textContent=round?(rankingNumber(round.points)+(round.rated?'':' · nicht gewertet')):'–';tr.append(cell);}
      fragment.append(tr);
    }
    if(!fragment.childNodes.length){const tr=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=roundId?6:5;cell.textContent='Keine Spieler für diese Suche gefunden.';tr.append(cell);fragment.append(tr);}
    q('#rankingRows').replaceChildren(fragment);
  }
  async function loadRanking(force=false) {
    if(rankingLoading||(!force&&rankingData&&Date.now()-rankingData.loadedAt<600000))return;
    rankingLoading=true;q('#reloadRanking').disabled=true;q('#rankingStatus').textContent='DBD-Rangliste wird geladen …';
    try {
      const response=await fetch('/api/v1/darts/ranking');if(!response.ok)throw new Error('Rangliste nicht verfügbar');
      rankingData={...await response.json(),loadedAt:Date.now()};
      q('#rankingHeading').textContent=rankingData.name;
      const selected=q('#rankingRound').value;const all=document.createElement('option');all.value='';all.textContent='Alle Runden';q('#rankingRound').replaceChildren(all);
      const events=[...(rankingData.events||[])].sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));
      const fragment=document.createDocumentFragment();let hasFuture=false;
      for(const event of events){
        const option=document.createElement('option');option.value=event.id;option.textContent=event.name;q('#rankingRound').append(option);
        const card=document.createElement('details');card.className='ranking-round';const summary=document.createElement('summary');const title=document.createElement('span');title.textContent=event.name;summary.append(title);card.append(summary);const date=document.createElement('p');const validDate=Number.isFinite(Date.parse(event.start));date.textContent=validDate?new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(event.start))+' Uhr':'Termin noch nicht hinterlegt';const location=document.createElement('p');location.textContent=event.city||'Ort noch nicht hinterlegt';const link=document.createElement('a');link.className='external';link.href=event.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Ergebnisse bei 3K';const display=document.createElement('a');display.className='external';display.href=`/turnier?event=${event.id}`;display.textContent='In der Turnieranzeige öffnen';const content=document.createElement('div');content.className='ranking-round-content';content.append(date,location,display,link);card.append(content);if(validDate&&Date.parse(event.start)>Date.now()){hasFuture=true;link.textContent='Turnier bei 3K öffnen';content.append(calendarButton({id:`dbd-${event.id}`,title:event.name,start:event.start,location:event.city}));}fragment.append(card);
      }
      if([...q('#rankingRound').options].some(option=>option.value===selected))q('#rankingRound').value=selected;
      q('#rankingEvents').replaceChildren(fragment);q('#rankingNext').textContent=hasFuture?'Die veröffentlichten Termine und bisherigen Ergebnisse:':'Ein weiterer Termin ist in 3K noch nicht veröffentlicht. Hier findest du die bisherigen Runden.';
      q('#rankingStatus').textContent=rankingData.stale?'3K ist gerade nicht erreichbar. Angezeigt wird der zuletzt geladene Stand.':`${rankingData.rows?.length||0} Spieler · ${events.length} Runden · Stand: ${new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(rankingData.updatedAt))} Uhr`;
      renderRanking();
    }catch(_){q('#rankingStatus').textContent='Die Rangliste konnte gerade nicht geladen werden. Bitte versuche es erneut oder öffne die Gesamtwertung bei 3K.';}
    finally{rankingLoading=false;q('#reloadRanking').disabled=false;}
  }
  q('#rankingView').addEventListener('click',()=>{setSection('ranking');loadRanking();loadSeason().then(()=>renderRanking());});
  q('#reloadRanking').addEventListener('click',()=>loadRanking(true));
  q('#rankingSearch').addEventListener('input',()=>{rankingPage=0;renderRanking();});q('#rankingRound').addEventListener('change',renderRanking);
  q('#rankingPrevious').addEventListener('click',()=>{rankingPage--;renderRanking();});q('#rankingNextPage').addEventListener('click',()=>{rankingPage++;renderRanking();});
  for(const button of document.querySelectorAll('[data-ranking-filter]'))button.addEventListener('click',async()=>{rankingOurs=button.dataset.rankingFilter==='ours';rankingPage=0;for(const item of document.querySelectorAll('[data-ranking-filter]'))item.setAttribute('aria-pressed',String(item===button));if(rankingOurs)await Promise.allSettled([loadSeason(),loadClubMembers()]);renderRanking();});
  window.setInterval(()=>{if(!q('#rankingPanel').hidden)loadRanking();},60000);
  let tvScheduleData=null,tvScheduleLoading=false,tvScheduleLoadedAt=0;
  const tvDate=value=>new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value))+' Uhr';
  function tvScheduleEvents(){return (tvScheduleData?.events||[]).filter(item=>{try{const url=new URL(item.url);return Date.parse(item.start)>Date.now()&&url.protocol==='https:'&&url.hostname==='www.sport1.de'&&url.pathname.startsWith('/tv-video/stream/');}catch(_){return false;}}).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).slice(0,12);}
  function renderTvSchedule(){
    const events=tvScheduleEvents(),next=events[0],fragment=document.createDocumentFragment();
    q('#tvTeaserHeading').textContent=next?next.title:'Wann läuft wieder Darts?';q('#tvTeaserCopy').textContent=next?`${tvDate(next.start)} · SPORT1 · Livestream`:tvScheduleData?.available?'Noch kein weiterer Livestream veröffentlicht.':'Kommende Livestreams und Anbieterprogramme.';
    for(const item of events){const card=document.createElement('article');card.className='tv-schedule-card';const date=document.createElement('time');date.dateTime=item.start;date.textContent=tvDate(item.start);const title=document.createElement('h2');title.textContent=item.title;const provider=document.createElement('span');provider.className='tv-provider';provider.textContent='SPORT1 · Livestream';const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';link.className='external';link.textContent='Zum Livestream ↗';card.append(date,title,provider,link);fragment.append(card);}
    if(!events.length){const empty=document.createElement('p');empty.className='tv-schedule-empty';empty.textContent=tvScheduleData?.available?'SPORT1 hat hier noch keinen weiteren Darts-Livestream veröffentlicht. Schau auch in die Anbieterprogramme unten.':'Die Termine konnten gerade nicht geladen werden. Du kannst die Anbieterprogramme unten direkt öffnen.';fragment.append(empty);}
    q('#tvScheduleList').replaceChildren(fragment);
    const checked=tvScheduleData?.updatedAt;const validChecked=Number.isFinite(Date.parse(checked));q('#tvScheduleStatus').textContent=tvScheduleData?.stale?'Die Quelle ist gerade nicht erreichbar. Angezeigt wird der zuletzt geprüfte Stand.':validChecked?`Quelle: SPORT1 · Geprüft: ${tvDate(checked)} · Termine werden automatisch aktualisiert.`:'Quelle: SPORT1 · Termine werden automatisch aktualisiert.';
  }
  async function loadTvSchedule(force=false){
    if(tvScheduleLoading||(!force&&Date.now()-tvScheduleLoadedAt<300000))return;
    tvScheduleLoading=true;q('#reloadTvSchedule').disabled=true;
    try{const response=await fetch('/api/v1/darts/tv',{headers:{Accept:'application/json'}});if(!response.ok)throw new Error();tvScheduleData=await response.json();tvScheduleLoadedAt=Date.now();}catch(_){if(tvScheduleData)tvScheduleData={...tvScheduleData,stale:true};else tvScheduleData={available:false,events:[]};}finally{renderTvSchedule();tvScheduleLoading=false;q('#reloadTvSchedule').disabled=false;}
  }
  q('#tvScheduleView').addEventListener('click',()=>{setSection('tv');loadTvSchedule();});q('#tvTeaserButton').addEventListener('click',()=>{q('#tvScheduleView').click();focusSection();});q('#reloadTvSchedule').addEventListener('click',()=>loadTvSchedule(true));
  window.setInterval(()=>{renderTvSchedule();if(!document.hidden)loadTvSchedule();},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){renderTvSchedule();loadTvSchedule();}});
  const requestedSection=new URLSearchParams(location.search).get('view');
  let currentSection='today',sectionNavigationReady=false;
  function setSection(section) {
    currentSection=section;if(sectionNavigationReady){const url=new URL(location.href);if(section==='today')url.searchParams.delete('view');else url.searchParams.set('view',section);history.replaceState(null,'',url);}window.scrollTo({top:0,behavior:'instant'});
    const teams = section === 'teams';
    grid.hidden = true; q('.intro').hidden = !teams;
    q('#layoutControls').hidden = true;
    q('#seasonPanel').hidden = !teams;
    q('#activityPanel').hidden = section !== 'activity';
    q('#trainingPanel').hidden = section !== 'training';
    q('#tvSchedulePanel').hidden=section!=='tv';q('#tvScheduleTeaser').hidden=section!=='today';q('#tvScheduleView').setAttribute('aria-pressed',String(section==='tv'));
    q('#rankingPanel').hidden = section !== 'ranking';
    q('#rankingView').setAttribute('aria-pressed',String(section==='ranking'));
    q('#todayPanel').hidden = section !== 'today';q('#nextAppointments').hidden=section!=='today';q('#homeTeamPanel').hidden=section!=='today';q('#joinTeaser').hidden=section!=='today';q('#joinPanel').hidden=section!=='join';
    for(const button of document.querySelectorAll('[data-mobile-section]'))button.setAttribute('aria-pressed',String(button.dataset.mobileSection===section||(button.dataset.mobileSection==='more'&&!['today','teams','league'].includes(section))));
    q('#leaguePanel').hidden = section !== 'league';
    q('#cupPanel').hidden = section !== 'cup';
    q('#membersPanel').hidden = section !== 'members';
    q('#todayView').setAttribute('aria-pressed',String(section === 'today'));
    q('#leagueView').setAttribute('aria-pressed',String(section === 'league'));
    q('#cupView').setAttribute('aria-pressed',String(section === 'cup'));
    q('#gridView').setAttribute('aria-pressed',String(section === 'teams'));
    q('#membersView').setAttribute('aria-pressed',String(section === 'members'));
    q('#trainingView').setAttribute('aria-pressed',String(section === 'training'));
    q('#moreNavigation').open=false;
  }
  function loadActivity() {
    const iframe = document.createElement('iframe');
    iframe.title = 'Aktuelle Veranstaltungen von SV Barver bei 3K Darts';
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = activityUrl;
    q('#activityFrame').replaceChildren(iframe);
    q('#activityNote').textContent = 'Veranstaltungen werden direkt aus 3K Darts angezeigt. Wähle „Aktualisieren“ für neue Einträge oder „Bei 3K öffnen“, falls die Ansicht leer bleibt.';
    activityLoaded = true;
  }
  syncTraining();
  q('#todayView').addEventListener('click',()=>setSection('today'));
  q('#leagueView').addEventListener('click',()=>{
    setSection('league');
    loadSeason();
    for (const block of q('#leagueOverview').querySelectorAll('.league-block')) {
      const league=seasonData?.leagues?.find(item=>item.league?.key===block.dataset.league);
      const selected=visibleCenters.get(block.dataset.league)?.selectedRound.id || league?.selectedRound?.id || block.querySelector('[data-role="round"]').value || null;
      loadLeague(block.dataset.league,selected);
    }
  });
  q('#cupView').addEventListener('click',()=>{ setSection('cup'); loadSeason(); });
  q('#membersView').addEventListener('click',async()=>{ setSection('members'); await Promise.all([loadSeason(),loadClubMembers()]); renderMembers(); });
  q('#personalSettingsToggle').addEventListener('click',()=>{
    q('#moreNavigation').open=false;
    q('#personalSettings').open=true;
    q('#personalSettings').scrollIntoView({behavior:'smooth',block:'start'});
  });
  q('#memberSearch').addEventListener('input',renderMembers);
  q('#memberGroup').addEventListener('change',renderMembers);
  q('#seasonTeam').addEventListener('change',renderSeason);
  q('#seasonStatus').addEventListener('click',event=>{ const button=event.target.closest('button[data-status]'); if (!button) return; seasonStatus=button.dataset.status; renderSeason(); });
  q('#reloadSeason').addEventListener('click',()=>loadSeason(true));
  q('#favoriteTeam').value=favorite;q('#myFavoriteTeam').value=favorite;q('#homeTeam').value=favorite;
  function selectFavorite(value){favorite=value;try{localStorage.setItem(favoriteKey,favorite);}catch(_){}q('#favoriteTeam').value=favorite;q('#myFavoriteTeam').value=favorite;q('#homeTeam').value=favorite;renderTicker(tickerData);}
  q('#myFavoriteTeam').addEventListener('change',()=>selectFavorite(q('#myFavoriteTeam').value));window.setInterval(renderExperience,60000);
  q('#favoriteTeam').addEventListener('change',()=>selectFavorite(q('#favoriteTeam').value));
  q('#tvTeamControls').addEventListener('click',event=>{
    const button=event.target.closest('button[data-tv-team]'); if(!button) return;
    const code=button.dataset.tvTeam;
    if (code==='all') tvTeams=new Set(allTvTeams);
    else if (allTvTeams.includes(code)) {
      if (tvTeams.has(code) && tvTeams.size>1) tvTeams.delete(code); else tvTeams.add(code);
    }
    rememberTvTeams(); updateTvTeamControls(); renderToday(tickerData); refreshSponsorSlots(false);
  });
  for (const block of q('#leagueOverview').querySelectorAll('.league-block')) {
    const select=block.querySelector('[data-role="round"]');
    select.addEventListener('change',()=>loadLeague(block.dataset.league,select.value));
    block.querySelector('[data-role="reload"]').addEventListener('click',()=>loadLeague(block.dataset.league,select.value));
  }
  q('#reloadActivity').addEventListener('click',loadActivity);
  q('#trainingView').addEventListener('click',()=>setSection('training'));
  q('#loadTraining').addEventListener('click',loadTraining);
  q('#trainingMode').addEventListener('change',loadTraining);
  q('#trainingForm').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      training = dartsTraining(q('#trainingUrl').value);
      q('#trainingError').hidden = true;
      try { localStorage.setItem(trainingKey,training.source); message('Training auf diesem Gerät gespeichert.'); }
      catch (_) { message('Training nur für diese Sitzung übernommen; dauerhaftes Speichern ist nicht möglich.'); }
      loadTraining();
    } catch (error) { q('#trainingError').textContent=error.message; q('#trainingError').hidden=false; }
  });
  let editing = null;
  function message(text) { q('#pageStatus').textContent = text; q('#pageStatus').hidden = !text; }
  try {
    const stored = JSON.parse(localStorage.getItem(DARTS_STORAGE) || '{}');
    for (const team of DARTS_TEAMS) {
      if (stored?.[team.id]) {
        try { selections[team.id] = dartsMatch(stored[team.id],team); } catch (_) { /* Ignore old or invalid saved links. */ }
      }
    }
  } catch (_) { message('Gespeicherte Begegnungen konnten nicht gelesen werden. Du kannst die Ansichten trotzdem verwenden.'); }
  function save() {
    const data = Object.fromEntries(Object.entries(selections).map(([id,value])=>[id,value.report || value.live]));
    try { localStorage.setItem(DARTS_STORAGE,JSON.stringify(data)); message('Begegnung auf diesem Gerät gespeichert.'); }
    catch (_) { message('Die Auswahl gilt für diese Sitzung. Dein Browser erlaubt gerade kein dauerhaftes Speichern.'); }
  }
  function urlFor(team, mode) {
    const match = selections[team.id];
    if (mode === 'live') return match?.live;
    if (mode === 'report') return match?.report;
    return `https://portal.3k-darts.com/frontend/events/10/event/${team.event}/participants/${team.participant}`;
  }
  function sync(team) {
    const c = cards.get(team.id), selected = selections[team.id];
    c.select.querySelector('[value="report"]').disabled = !selected?.report;
    c.select.querySelector('[value="live"]').disabled = !selected?.live;
    if (!urlFor(team,c.select.value)) c.select.value = 'team';
    c.open.href = urlFor(team,c.select.value);
    c.matchNote.textContent = selected ? `Begegnung #${selected.match} gespeichert · Zuordnung manuell` : team.league;
  }
  function load(team) {
    const c = cards.get(team.id), url = urlFor(team,c.select.value);
    if (!url) return;
    sync(team);
    const iframe = document.createElement('iframe');
    iframe.title = `${team.name} – ${c.select.selectedOptions[0].textContent}`;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.src = url;
    // A cross-origin load event cannot confirm an actual live score or success.
    c.wrap.replaceChildren(iframe);
    c.loaded = true;
    c.note.textContent = 'Die Spiele werden direkt aus 3K Darts angezeigt. Falls die Ansicht leer bleibt, wähle „Bei 3K öffnen“.';
  }
  function focusTeam(id) {
    setSection('teams');
    focused = id; applyLayout();
  }
  for (const team of DARTS_TEAMS) {
    const card = document.createElement('article'); card.className='team-card'; card.id=`team-${team.id}`;
    // Only fixed app-owned team labels are interpolated. Links are assigned via DOM properties.
    card.innerHTML = `<div class="team-head"><span class="team-letter">${team.id.toUpperCase()}</span><span class="club-logo team-club-logo" aria-hidden="true"></span><div><h2>${team.name}</h2><p class="match-note"></p></div><button class="focus-team" type="button" aria-label="${team.name} vergrößern" aria-pressed="false">Groß</button></div>
      <div class="team-tools"><select aria-label="Ansicht für ${team.name}"><option value="team">Spielplan & Ergebnisse</option><option value="report" disabled>Gewählter Spielbericht</option><option value="live" disabled>Gewähltes Spiel live</option></select><button class="configure" type="button">Spiel wählen</button><button class="reload" type="button" aria-label="${team.name} neu laden">Neu laden</button><a class="external" target="_blank" rel="noopener noreferrer">Bei 3K öffnen ↗</a></div>
      <div class="frame-wrap"><div class="placeholder"><strong>${team.league}</strong><p>Spielplan und Ergebnisse dieser Mannschaft von 3K Darts laden.</p><button class="load-team primary" type="button">${team.id.toUpperCase()} anzeigen</button></div></div><p class="frame-note">Wähle „Anzeigen“, um die Spiele aus 3K Darts zu laden.</p>`;
    card.querySelector('h2').replaceChildren(makeTeamJump(team.id.toUpperCase(),team.name));
    const rosterButton=document.createElement('button');rosterButton.type='button';rosterButton.className='present-team-roster';
    rosterButton.textContent='Kader vorstellen';rosterButton.setAttribute('aria-label',`Kader Barver ${team.id.toUpperCase()} vorstellen`);
    rosterButton.addEventListener('click',()=>presentTeamRoster(team.id.toUpperCase()));
    card.querySelector('.team-tools').append(rosterButton);
    grid.append(card);
    const c = {card,wrap:card.querySelector('.frame-wrap'),select:card.querySelector('select'),open:card.querySelector('.external'),note:card.querySelector('.frame-note'),matchNote:card.querySelector('.match-note'),focus:card.querySelector('.focus-team'),loaded:false};
    cards.set(team.id,c); c.select.value = layout.modes[team.id]; sync(team);
    c.focus.addEventListener('click',()=>focusTeam(focused === team.id ? null : team.id));
    c.select.addEventListener('change',()=>{ load(team); saveLayout(); });
    card.querySelector('.load-team').addEventListener('click',()=>load(team));
    card.querySelector('.reload').addEventListener('click',()=>load(team));
    card.querySelector('.configure').addEventListener('click',()=>{
      editing=team; q('#matchHeading').textContent=`Begegnung für Barver ${team.id.toUpperCase()}`;
      q('#matchUrl').value=selections[team.id]?.report || selections[team.id]?.live || '';
      q('#matchError').hidden=true; q('#clearMatch').disabled=!selections[team.id]; q('#matchDialog').showModal();
    });
    const choice = document.createElement('button');
    choice.type = 'button'; choice.dataset.team = team.id; choice.setAttribute('aria-label',`Barver ${team.id.toUpperCase()} auswählen`);
    const choiceLetter=document.createElement('b'); choiceLetter.textContent=team.id.toUpperCase();
    const choiceName=document.createElement('span'); choiceName.textContent='Barver';
    choice.append(choiceLetter,choiceName);
    choice.addEventListener('click',()=>{
      if (layout.selected.includes(team.id)) {
        if (layout.count === 1) return;
        layout.selected = layout.selected.filter(id=>id!==team.id); layout.count = layout.selected.length;
      } else { layout.selected = [...layout.selected.slice(1),team.id]; }
      focused = null; applyLayout(); saveLayout();
      if (layout.auto && layout.selected.includes(team.id) && !c.loaded) load(team);
    });
    q('#teamChoices').append(choice);
  }
  applyLayout();
  setSection('today');
  loadTvSchedule();
  q('#todayView').textContent='Startseite';
  q('#todayGrid').before(q('#nextAppointments'));
  q('#todayGrid').after(q('.match-center'));
  q('.match-center').after(q('#clubEventBanner'));
  q('#trainingForm').before(q('.club-training'));
  q('#scheduleDetails').after(q('#sponsorInline'));
  q('#todayGrid').classList.add('featured-live');
  // The light ticker paints first; the complete season can arrive later.
  window.setTimeout(()=>loadSeason(true),500);
  window.setInterval(()=>{if (!document.hidden) loadSeason(true);},600000);
  if (demoLive) message('DEMO-MODUS: Die angezeigten Live-Spielstände und Highlights sind simuliert und werden nicht gespeichert.');
  q('#gameCount').addEventListener('change',()=>{
    layout = dartsLayout({...layout,count:Number(q('#gameCount').value)});
    focused = null; applyLayout(); saveLayout();
    if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id) && !cards.get(t.id).loaded).forEach(load);
  });
  q('#autoLoad').addEventListener('change',()=>{ layout.auto=q('#autoLoad').checked; saveLayout(); if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load); });
  if (layout.auto) DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load);
  q('#loadAll').addEventListener('click',()=>{ focusTeam(null); DARTS_TEAMS.filter(t=>layout.selected.includes(t.id)).forEach(load); });
  q('#gridView').addEventListener('click',()=>{ setSection('teams'); loadSeason(); });
  q('#closeMatch').addEventListener('click',()=>q('#matchDialog').close());
  q('#matchDialog').addEventListener('close',()=>{if(!q('#matchDialog').open){matchLoadSequence++;matchRequestController?.abort();activeMatchDetailData=null;}});
  q('#closeTeamProfile').addEventListener('click',()=>q('#teamDialog').close());
  q('#closePlayerProfile').addEventListener('click',()=>q('#playerDialog').close());
  q('#playerDialog').addEventListener('close',()=>{if(!q('#playerDialog').open)activePlayerProfile=null;});
  q('#teamDialog').addEventListener('close',()=>{if(!q('#teamDialog').open)activeTeamProfile=null;});
  window.setInterval(()=>{if(!document.hidden)loadPlayerData();},30000);
  window.addEventListener('online',()=>loadPlayerData(true));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadPlayerData();});
  async function presentTeamRoster(code) {
    try {
      if (!seasonData) await loadSeason();
      await loadPlayerData();
      const team=teamByCode(code)||{code,name:`SV Barver Darts ${code}`};
      const players=dartsTeamRoster(team).map(member=>({...playerProfiles[String(member.id||'')],...member,role:dartsMemberRole(member,playerProfiles[String(member.id||'')]||{})}));
      if (!window.DartsBroadcast?.presentRoster({code,name:team.name,players})) message('Für diese Mannschaft ist noch kein Kader verfügbar.');
    } catch (_) { message('Der Kader konnte gerade nicht geladen werden. Bitte erneut versuchen.'); }
  }
  q('#presentTvRoster').addEventListener('click',()=>presentTeamRoster(q('#presentationTeam').value));
  updatePresence();
  window.setInterval(updatePresence,30000);
  window.addEventListener('online',updatePresence);
  document.addEventListener('visibilitychange',()=>{ if (!document.hidden) updatePresence(); });

  let tvChoicesLoaded=false;
  async function loadTvChoices(){if(tvChoicesLoaded)return;try{const response=await fetch('/api/v1/darts/ranking');if(!response.ok)throw new Error();const data=await response.json();const group=document.createElement('optgroup');group.label=data.name;for(const event of [...data.events].sort((a,b)=>Date.parse(b.start)-Date.parse(a.start))){const option=document.createElement('option');option.value=event.id;option.textContent=event.name;group.append(option);}q('#tvTournamentChoice').append(group);tvChoicesLoaded=true;}catch(_){q('#tvLauncherNote').textContent='Das aktuelle Vereinsturnier ist verfügbar. Die DBD-Runden konnten gerade nicht geladen werden.';}}
  q('#fullscreen').addEventListener('click',()=>{if(document.fullscreenElement){document.exitFullscreen().catch(()=>{});return;}q('#tvTeamChoice').value=favorite;q('#tvLauncher').showModal();loadTvChoices();});
  q('#closeTvLauncher').addEventListener('click',()=>q('#tvLauncher').close());
  q('#tvLauncherForm').addEventListener('change',()=>{const tournament=q('#tvLauncherForm input[name="tvType"]:checked').value==='tournament';q('#tvTeamField').hidden=tournament;q('#tvTournamentField').hidden=!tournament;});
  q('#tvLauncherForm').addEventListener('submit',async event=>{event.preventDefault();const type=q('#tvLauncherForm input[name="tvType"]:checked').value;q('#tvLauncher').close();if(type==='tournament'){const id=q('#tvTournamentChoice').value;location.href='/turnier?tv=1'+(id?`&event=${encodeURIComponent(id)}`:'');return;}const code=q('#tvTeamChoice').value;tvTeams=code==='all'?new Set(allTvTeams):new Set([code]);rememberTvTeams();updateTvTeamControls();setSection('today');renderToday(tickerData);try{if(document.body.requestFullscreen)await document.body.requestFullscreen();else message('Vollbild wird hier nicht unterstützt. Die Spiele bleiben in der normalen Ansicht verfügbar.');}catch(_){message('Vollbild konnte nicht gestartet werden. Nutze bei Bedarf die Vollbildfunktion deines Browsers.');}});
  document.addEventListener('fullscreenchange',()=>{
    const active=Boolean(document.fullscreenElement);
    document.body.classList.toggle('tv-live',active);
    window.DartsBroadcast?.configure({tv:active});
    updateTvTeamControls(); renderToday(tickerData); refreshSponsorSlots(false);
    q('#fullscreen').textContent=active ? 'TV-Modus beenden' : 'TV-Modus';
  });
  sectionNavigationReady=true;
  const sectionTargets={teams:'gridView',league:'leagueView',ranking:'rankingView',tv:'tvScheduleView',join:'joinView',members:'membersView',training:'trainingView',cup:'cupView'};
  if(sectionTargets[requestedSection])q(`#${sectionTargets[requestedSection]}`).click();
}
