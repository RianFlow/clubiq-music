(function(root){
  'use strict';
  const zone='Europe/Berlin';
  const wallParts=value=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  function berlinTime(day,time='19:30') {
    const desired=Date.parse(`${day}T${time}:00Z`);let instant=desired;
    for(let i=0;i<3;i++){const p=wallParts(instant);instant+=desired-Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);}
    return new Date(instant).toISOString();
  }
  function nextTraining(now=Date.now()) {
    const p=wallParts(now),today=`${p.year}-${p.month}-${p.day}`;
    for(let offset=0;offset<8;offset++){const day=new Date(`${today}T12:00:00Z`);day.setUTCDate(day.getUTCDate()+offset);if(![2,4].includes(day.getUTCDay()))continue;const date=day.toISOString().slice(0,10),start=berlinTime(date);if(Date.parse(start)>now)return {id:`training-${date}`,kind:'training',title:'Vereinstraining',start,allDay:false};}
  }
  const escape=value=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
  function fold(line){let result='',bytes=0;for(const char of line){const length=new TextEncoder().encode(char).length;if(bytes+length>75){result+='\r\n ';bytes=1;}result+=char;bytes+=length;}return result;}
  function calendar(item,now=new Date()) {
    const stamp=date=>new Date(date).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SV Barver Darts//Vereinstermine//DE','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${escape(item.id)}@barverdarts.clubiq.party`,`DTSTAMP:${stamp(now)}`,`SUMMARY:${escape(item.title)}`];
    if(item.allDay){const day=item.start.slice(0,10),end=new Date(`${day}T12:00:00Z`);end.setUTCDate(end.getUTCDate()+1);lines.push(`DTSTART;VALUE=DATE:${day.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${end.toISOString().slice(0,10).replace(/-/g,'')}`);}else lines.push(`DTSTART:${stamp(item.start)}`);
    if(item.location)lines.push(`LOCATION:${escape(item.location)}`);
    if(item.description)lines.push(`DESCRIPTION:${escape(item.description)}`);
    lines.push('END:VEVENT','END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
  }
  function agenda(matches,events,favorite='all',now=Date.now()) {
    const byId=new Map();for(const match of matches||[])byId.set(String(match.id),match);
    const games=[...byId.values()].filter(m=>m.kind==='upcoming'&&Date.parse(m.plannedAt)>now&&(favorite==='all'||(m.barverTeams||[m.barverTeam]).includes(favorite))).sort((a,b)=>Date.parse(a.plannedAt)-Date.parse(b.plannedAt)).slice(0,2).map(m=>({id:`match-${m.id}`,kind:'match',title:`${m.home} gegen ${m.away}`,start:m.plannedAt,match:m,allDay:false}));
    const dated=(events||[]).filter(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.calendarDate||'')&&e.calendarDate>=(p=>`${p.year}-${p.month}-${p.day}`)(wallParts(now))).map(e=>({id:`event-${e.id}`,kind:'event',title:e.title,start:e.calendarDate,allDay:true,location:e.location,description:e.description,href:e.href}));
    return [...games,nextTraining(now),...dated].filter(Boolean).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).slice(0,3);
  }
  const api={berlinTime,nextTraining,calendar,agenda};root.DartsExperience=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
