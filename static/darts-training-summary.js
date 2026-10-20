(function(root){
  'use strict';
  const berlin=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  function localTime(value){
    const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
    const parts=Object.fromEntries(berlin.formatToParts(date).map(part=>[part.type,part.value]));
    return {day:`${parts.year}-${parts.month}-${parts.day}`,minutes:Number(parts.hour)*60+Number(parts.minute)};
  }
  const score=value=>Number.isInteger(value)&&value>=0?value:null;
  function overview(data,now=Date.now()){
    const event=data.event||{},date=typeof event.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(event.date)?{day:event.date}:event.date?localTime(event.date):null,current=localTime(now);
    const due=event.status==='FINISH'||!!(date&&current&&(date.day<current.day||date.day===current.day&&current.minutes>=21*60+30));
    const matches=data.matches||[],finished=matches.filter(match=>match.kind==='final'),live=matches.filter(match=>match.kind==='live'),upcoming=matches.filter(match=>match.kind==='upcoming');
    let legs=0,hasLegs=false;
    for(const match of [...finished,...live]){const home=score(match.live?.home?.legs??match.homeLegs),away=score(match.live?.guest?.legs??match.awayLegs);if(home!==null&&away!==null){legs+=home+away;hasLegs=true;}}
    // A scheduled end is an opportunity for a recap, never proof that a live game ended.
    const complete=live.length===0&&(event.status==='FINISH'||due&&!data.stale&&upcoming.length===0&&finished.length>0);
    const automatic=live.length===0&&(event.status==='FINISH'||due&&!data.stale&&finished.length>0);
    return {due,complete,automatic,finished,live,upcoming,legs:hasLegs?legs:null,participants:(data.participants||[]).length};
  }
  function highlights(data){
    const rows=(data.performances||[]).filter(row=>typeof row.name==='string'&&Number.isFinite(row.value)&&row.value>0),result=[];
    const highs=rows.filter(row=>row.type==='HS'&&row.value===180),finishes=rows.filter(row=>row.type==='HF'&&row.value<=170).sort((a,b)=>b.value-a.value),shorts=rows.filter(row=>['SG','SGD'].includes(row.type)).sort((a,b)=>a.value-b.value);
    const names=items=>{const all=[...new Set(items.map(row=>row.name))];return all.slice(0,2).join(' · ')+(all.length>2?' u. a.':'');};
    if(highs.length)result.push({label:'180er',value:`${highs.reduce((sum,row)=>sum+(Number.isInteger(row.count)&&row.count>0?row.count:1),0)} × 180`,name:names(highs)});
    if(finishes.length)result.push({label:'Höchstes Finish',value:String(finishes[0].value),name:names(finishes.filter(row=>row.value===finishes[0].value))});
    if(shorts.length)result.push({label:shorts[0].type==='SGD'?'Kürzestes Leg im Doppel':'Kürzestes Leg',value:`${shorts[0].value} Darts`,name:names(shorts.filter(row=>row.value===shorts[0].value&&row.type===shorts[0].type))});
    return result;
  }
  const api={overview,highlights};if(typeof module==='object'&&module.exports)module.exports=api;else root.DartsTrainingSummary=api;
})(typeof window==='object'?window:globalThis);
