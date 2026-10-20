'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..'),summary=require('../static/darts-training-summary.js');
const winter={event:{date:'2026-12-01T18:30:00Z',status:'ACTIVE'},matches:[{kind:'final',homeLegs:3,awayLegs:1}],participants:[]};
assert.equal(summary.overview(winter,'2026-12-01T20:29:59Z').due,false);
assert.equal(summary.overview(winter,'2026-12-01T20:30:00Z').automatic,true,'21:30 Berlin in winter');
assert.equal(summary.overview({...winter,event:{date:null,status:'ACTIVE'}},'2026-12-01T22:00:00Z').due,false,'unknown date is not guessed');
assert.equal(summary.overview({...winter,stale:true},'2026-12-01T20:30:00Z').automatic,false,'a stale unfinished source does not force a recap');
assert.equal(summary.overview({...winter,event:{...winter.event,status:'FINISH'},matches:[...winter.matches,{kind:'live'}]},'2026-12-01T20:30:00Z').automatic,false,'a contradictory event status never hides a reported live game');
assert.equal(summary.overview({...winter,matches:[...winter.matches,{kind:'upcoming'}]},'2026-12-01T20:30:00Z').automatic,true,'unplayed planned rounds do not block an evening recap');
assert.equal(summary.overview({...winter,matches:[...winter.matches,{kind:'upcoming'}]},'2026-12-01T20:30:00Z').complete,false,'a recap does not declare unplayed pairings finished');
assert.equal(summary.overview({...winter,matches:[{kind:'final',homeLegs:null,awayLegs:null}]},'2026-12-01T20:30:00Z').legs,null);
assert.deepEqual(summary.highlights({performances:[{type:'HF',name:'Test',value:180}]}),[]);
let phase='live',partial=false;
const event={id:33228,database:5,name:'Training · Zusammenfassung mit Testdaten',date:'2026-10-20T17:30:00Z',status:'ACTIVE'};
function payload(id=33228){
  const future=id!==33228;
  const finals=Array.from({length:9},(_,i)=>({id:i+1,kind:'final',home:`Testspieler ${i+1}`,away:`Testspielerin ${i+10}`,homeLegs:3,awayLegs:1,updatedAt:`2026-10-20T18:${String(i+10).padStart(2,'0')}:00Z`}));
  const last={id:10,board:'1',home:'Testspieler 1',away:'Testspielerin 10',kind:phase==='live'?'live':phase==='pending'?'upcoming':'final',homeLegs:3,awayLegs:2,updatedAt:'2026-10-20T19:30:00Z'};
  if(phase==='live')last.live={home:{name:last.home,legs:1,points:120,darts:18,average:45,count180:0,highFinish:0},guest:{name:last.away,legs:0,points:240,darts:15,average:43,count180:0,highFinish:0}};
  return {event:{...event,id,date:future?'2026-10-22T17:30:00Z':event.date,status:future?'CREATED':phase==='finished'?'FINISH':'ACTIVE'},participants:Array.from({length:18},(_,i)=>({id:i+1,name:`Testperson ${i+1}`})),
    matches:future?[]:[...finals,last],groups:future?[]:Array.from({length:3},(_,g)=>({id:String(g+1),name:`Gruppe ${g+1}`,entries:Array.from({length:6},(_,i)=>({rank:`${i+1}.`,name:`Testperson ${g*6+i+1}`,played:5,wins:5-i,pointsFor:(5-i)*2,pointsAgainst:i*2,legsFor:15-i,legsAgainst:i+1}))})),
    performances:partial?[]:[{type:'HS',name:'Testspieler 1',value:180,count:2},{type:'HS',name:'Testspielerin 10',value:180,count:1},{type:'HF',name:'Testspieler 2',value:124,count:1},{type:'SG',name:'Testspielerin 11',value:18,count:1}],placements:phase==='finished'?[{rank:'1.',name:'Testspielerin 11'},{rank:'2.',name:'Testspieler 2'}]:[],
    scheduleReady:!future,stale:false,degraded:partial,performancesUnavailable:partial,updatedAt:'2026-10-20T19:30:00Z'};
}
const json=(res,body)=>res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local'),p=url.pathname;
  if(p==='/api/v1/darts/trainings'||p==='/static/darts-trainings.json')return json(res,{events:[event,{...event,id:33000,date:'2026-10-22T17:30:00Z',status:'CREATED'}],selectedId:33228,stale:false,updatedAt:'2026-10-20T19:30:00Z'});
  if(p==='/api/v1/darts/training')return json(res,payload(Number(url.searchParams.get('event_id')||33228)));
  if(p==='/api/v1/darts/tournament')return json(res,payload());if(p==='/api/v1/darts/ranking')return json(res,{name:'Testdaten',events:[]});
  const file=path.resolve(root,'.'+(['/training','/app/training','/turnier'].includes(p)?'/turnier.html':p));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(error,body)=>res.writeHead(error?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'})[path.extname(file)]||'application/octet-stream'}).end(error?'':body));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080},timezoneId:'America/New_York'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.clock.install({time:new Date('2026-10-20T19:29:45Z')});await page.goto(origin+'/training?tv=1');await page.waitForFunction(()=>!busy&&!trainingSearchBusy&&data?.event?.id===33228);
    assert.equal(await page.locator('#trainingWrapUp').isVisible(),false);assert.equal(await page.locator('#view').inputValue(),'live');
    await page.selectOption('#view','summary');assert.equal(await page.locator('.summary-title').innerText(),'Zwischenstand');assert.match(await page.locator('.summary-status').first().innerText(),/1 Spiel läuft noch/);
    await page.getByRole('button',{name:'Zu den Live-Boards',exact:true}).click();await page.clock.runFor(15010);await page.waitForFunction(()=>!busy);
    assert.equal(await page.locator('#trainingWrapUp').isVisible(),true,'the 21:30 Berlin boundary is recognized automatically');assert.equal(await page.locator('#view').inputValue(),'live','live boards are not interrupted by the scheduled end');
    phase='pending';await page.evaluate(()=>refresh());assert.equal(await page.locator('#view').inputValue(),'summary','planned rounds do not block an evening recap');assert.match(await page.locator('.summary-status').first().innerText(),/noch 1 Begegnung offen/);
    phase='done';await page.evaluate(()=>refresh());assert.equal(await page.locator('#view').inputValue(),'summary');assert.equal(await page.locator('.summary-title').innerText(),'Trainingsrückblick');
    assert.deepEqual(await page.locator('.summary-stat strong').allTextContents(),['18','10','41','0']);assert.match(await page.locator('.summary-highlights').innerText(),/3 × 180/);assert.match(await page.locator('.summary-highlights').innerText(),/124/);assert.match(await page.locator('.summary-highlights').innerText(),/18 Darts/);
    const before=await page.locator('.summary-standings h2').innerText();await page.locator('#next').click();assert.notEqual(await page.locator('.summary-standings h2').innerText(),before);
    for(const size of await page.locator('.training-summary,.summary-panel').evaluateAll(nodes=>nodes.map(n=>({bottom:n.getBoundingClientRect().bottom,height:n.clientHeight,scroll:n.scrollHeight}))))assert(size.bottom<=1080&&size.scroll<=size.height+1,JSON.stringify(size));
    fs.mkdirSync(path.join(root,'outputs/training-summary'),{recursive:true});await page.screenshot({path:path.join(root,'outputs/training-summary/tv.png')});
    phase='live';await page.evaluate(()=>refresh());assert.equal(await page.locator('#view').inputValue(),'live','a new live game restores automatic live coverage');
    phase='finished';await page.evaluate(()=>refresh());assert.equal(await page.locator('#view').inputValue(),'summary');assert.match(await page.locator('.summary-placements').innerText(),/Testspielerin 11/);
    await page.selectOption('#view','groups');await page.evaluate(()=>refresh());assert.equal(await page.locator('#view').inputValue(),'groups','an explicit table view is respected');
    await page.selectOption('#view','summary');partial=true;await page.evaluate(()=>refresh());assert.match(await page.locator('.summary-highlights').innerText(),/3 × 180/);assert.match(await page.locator('.summary-highlights').innerText(),/Letzte|letzte/);partial=false;
    for(const [width,height]of[[390,844],[320,568],[844,390]]){await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);}
    await page.setViewportSize({width:390,height:844});await page.goto(origin+'/app/training');await page.locator('.summary-title').waitFor();assert.equal(await page.locator('#view').inputValue(),'summary');await page.screenshot({path:path.join(root,'outputs/training-summary/mobile.png'),fullPage:true});
    await page.selectOption('#tournamentChoice','33000');await page.waitForFunction(()=>!busy&&data?.event?.id===33000);assert.equal(await page.locator('#view').inputValue(),'participants');assert.equal(await page.locator('#trainingWrapUp').isVisible(),false,'the next training never inherits the prior recap');
    await page.goto(origin+'/turnier');await page.waitForFunction(()=>!busy&&!!data);assert.equal(await page.locator('#view option[value=summary]').count(),0,'league tournaments keep their existing navigation');assert.deepEqual(errors,[]);
    console.log('Training recap: Berlin 21:30 incl. winter, no premature finish, continued live coverage, exact totals, official highlights/placements, group paging, partial recovery, mobile, Web-App and event isolation passed');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
