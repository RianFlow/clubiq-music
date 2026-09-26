const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},stored=new Map(),shown=[],broadcasts=[];
const context=vm.createContext({URL,Response,console,
  self:{location:{origin:'https://barverdarts.clubiq.party'},addEventListener:(type,fn)=>handlers[type]=fn,
    registration:{showNotification:async(title,options)=>shown.push({title,...options})}},
  clients:{matchAll:async()=>[{postMessage:message=>broadcasts.push(message)}]},
  caches:{open:async name=>({match:async key=>stored.get(name+key)?.clone(),put:async(key,response)=>stored.set(name+key,response.clone())})},
});
vm.runInContext(fs.readFileSync('sw.js','utf8'),context);
(async()=>{
  const work=[];
  for(let n=0;n<105;n++) handlers.push({data:{json:()=>({title:`Meldung ${n}`,body:'Spieler meldet 180',tag:`event-${n}`})},waitUntil:promise=>work.push(promise)});
  await Promise.all(work);
  const history=await stored.get('clubiq-darts-notifications-v1/__darts_notification_history__').json();
  assert.equal(history.length,100);assert.equal(history[0].title,'Meldung 104');assert.equal(history[99].title,'Meldung 5');
  assert.equal(shown.length,105);assert.equal(broadcasts.length,105);
  assert.ok(history[0].receivedAt);
  console.log('Push history: concurrent delivery, persistent storage, 100-entry limit, notification + popup OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
