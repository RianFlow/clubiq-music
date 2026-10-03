// Entirely fictional scores, isolated from public data and push notifications.
export function demoData(tick=0){
  const names=['Jannik Beispiel','Patrick Beispiel','Alex Beispiel','Kim Beispiel','Robin Beispiel','Sam Beispiel','Max Beispiel','Jörg Beispiel','Denis Beispiel','Eike Beispiel','Till Beispiel','René Beispiel'];
  const groups=Array.from({length:6},(_,g)=>({id:`demo-${g}`,name:`Gruppe ${String.fromCharCode(65+g)}`,entries:Array.from({length:6},(_,i)=>({rank:`${i+1}.`,name:names[(g*2+i)%names.length],played:4,wins:Math.max(0,4-i),lost:Math.min(4,i),pointsFor:Math.max(0,8-i*2),pointsAgainst:Math.min(8,i*2),legsFor:Math.max(2,12-i*2),legsAgainst:3+i*2}))}));
  const matches=Array.from({length:16},(_,i)=>{
    const home=names[i%12],away=names[(i+5)%12],leg=Math.floor(tick/12)%3;
    return{id:i+1,kind:'live',board:String(i+1),home,away,round:`Gruppe ${String.fromCharCode(65+i%6)}`,phase:'Gruppenphase',homeLegs:leg,awayLegs:1,
      live:{currentPlayerIndex:(tick+i)%2,home:{name:home,points:Math.max(24,501-((tick*45+i*37)%470)),darts:9+(tick+i)%15,legs:leg,count180:0,highFinish:0},guest:{name:away,points:Math.max(32,501-((tick*39+i*29+90)%450)),darts:12+(tick+i)%12,legs:1,count180:0,highFinish:0}}};
  });
  matches.push({id:101,kind:'final',board:'2',home:'Alex Beispiel',away:'Sam Beispiel',homeLegs:3,awayLegs:1,updatedAt:new Date().toISOString()});
  return{event:{id:0,database:0,name:'Barver DartsOpen · Turnier-Demo',date:'2026-10-03T11:00:00Z'},participants:names.map(name=>({name})),groups,matches,scheduleReady:true,stale:false,updatedAt:new Date().toISOString()};
}
