// Local fixtures only: live averages, official highlights and transition handling.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
let step=0,stale=false,partial=false;
const event={id:33228,database:5,name:'Training · Testdaten',date:'2026-10-20T17:30:00Z',status:'ACTIVE'};
function payload(id=33228){
  const empty=id!==33228;
  return {event:{...event,id},participants:[{id:1,name:'Testspielerin Eins'},{id:2,name:'Testspieler Zwei'}],scheduleReady:true,stale,degraded:partial,performancesUnavailable:partial,updatedAt:'2026-10-20T18:00:00Z',
    groups:[{id:'1',name:'Gruppe 1',entries:[{rank:'1.',name:'Testspielerin Eins',played:1,wins:1,pointsFor:2,pointsAgainst:0,legsFor:3,legsAgainst:1}]}],
    performances:empty||partial?[]:[{type:'HS',name:'Testspielerin Eins',value:180,count:step?2:1},{type:'HS',name:'Testspieler Zwei',value:180,count:2},{type:'HF',name:'Testspieler Zwei',value:124,count:1},{type:'SG',name:'Testspielerin Eins',value:step?18:20,count:1}],
    matches:Array.from({length:8},(_,i)=>({id:i+1,kind:'live',board:String(i+1),home:'Testspielerin Eins',away:'Testspieler Zwei',
      live:{currentPlayerIndex:0,home:{name:'Testspielerin Eins',points:320,darts:12,average:empty?null:step?51.4:48.2,legs:step?2:1,count180:step?2:1,highFinish:0},guest:{name:'Testspieler Zwei',points:410,darts:9,average:empty?null:42,legs:0,count180:0,highFinish:0}}})),
    source:`https://portal.3k-darts.com/frontend/events/5/event/${id}/participants`};
}
const json=(res,body)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local'),p=url.pathname;
  if(p==='/api/v1/darts/trainings'||p==='/static/darts-trainings.json')return json(res,{events:[event,{...event,id:33000}],selectedId:33228,nextId:33228,stale:false,updatedAt:'2026-10-20T18:00:00Z'});
  if(p==='/api/v1/darts/training')return json(res,payload(Number(url.searchParams.get('event_id')||33228)));
  const file=path.resolve(root,'.'+(['/training','/app/training'].includes(p)?'/turnier.html':p));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,body)=>res.writeHead(error?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'})[path.extname(file)]||'application/octet-stream'}).end(error?'':body));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.route('https://**',route=>route.abort());
    // Existing training tests cover polling. Drive observations explicitly here,
    // so interval requests cannot race the fixture changes and toast expiry.
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.clock.install({time:new Date('2026-10-20T18:00:00Z')});await page.goto(origin+'/training?tv=1');
    await page.locator('.player-average').filter({hasText:'AVG 48,2'}).first().waitFor();
    await page.waitForFunction(()=>!busy&&!trainingSearchBusy);
    assert.equal(await page.locator('#trainingHighlightCards article').count(),3);
    assert.match(await page.locator('#trainingHighlightCards').innerText(),/3 × 180/);assert.match(await page.locator('#trainingHighlightCards').innerText(),/124/);assert.match(await page.locator('#trainingHighlightCards').innerText(),/20 Darts/);
    assert.equal(await page.locator('#groupSidebar #trainingHighlights').count(),1,'TV highlights share the existing sidebar');
    assert.equal(await page.locator('#highlight').isVisible(),false,'initial results do not replay as new achievements');
    for(const value of await page.locator('.board').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {bottom:r.bottom,scroll:n.scrollHeight,height:n.clientHeight};})))assert(value.bottom<=1080&&value.scroll<=value.height+1,JSON.stringify(value));
    fs.mkdirSync(path.join(root,'outputs/training-highlights'),{recursive:true});await page.screenshot({path:path.join(root,'outputs/training-highlights/tv.png')});
    await page.evaluate(()=>refresh());assert.equal(await page.locator('#highlight').isVisible(),false,'unchanged counters do not celebrate');
    step=1;await page.evaluate(()=>refresh());await page.locator('#highlight').filter({hasText:'AVG 51,4'}).waitFor();
    assert.match(await page.locator('#trainingHighlightCards').innerText(),/18 Darts/);
    // Repeat the same source observation after the toast expires: no replay.
    await page.clock.runFor(15010);await page.waitForFunction(()=>!busy);await page.evaluate(()=>refresh());assert.equal(await page.locator('#highlight').isVisible(),false);
    stale=true;step=2;await page.evaluate(()=>refresh());assert.equal(await page.locator('#highlight').isVisible(),false);assert.equal(await page.locator('#trainingHighlightsState').innerText(),'Letzter bekannter Stand');
    stale=false;partial=true;await page.evaluate(()=>refresh());assert.equal(await page.locator('#trainingHighlightCards article').count(),3,'a partial refresh keeps known official highlights');
    assert.equal(await page.locator('#trainingHighlightsState').innerText(),'Letzter bekannter Stand');partial=false;
    await page.locator('#showTrainingHighlights').click();assert.equal(await page.locator('#view').inputValue(),'performances');assert.equal(await page.locator('#trainingHighlights').isVisible(),false);
    await page.selectOption('#view','live');assert.equal(await page.locator('#trainingHighlights').isVisible(),true);
    for(const [width,height]of[[390,844],[320,568],[844,390]]){await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);assert.equal(await page.locator('main > #trainingHighlights').count(),1);}
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'outputs/training-highlights/mobile.png'),fullPage:true});
    await page.selectOption('#tournamentChoice','33000');await page.waitForFunction(()=>!busy&&!trainingSearchBusy&&data?.event.id===33000);assert.equal(await page.locator('#trainingHighlights').isVisible(),false,'changing events clears previous highlights');assert.equal(await page.locator('.player-average').first().innerText(),'AVG –');
    await page.goto(origin+'/app/training');await page.locator('.player-average').filter({hasText:'AVG 51,4'}).first().waitFor();assert.equal(await page.locator('#trainingHighlights').isVisible(),true);assert.deepEqual(errors,[]);
    console.log('Training highlights: game AVG, no fabricated values, official 180/HF/shortgames, no history replay, partial recovery, TV fit, mobile and Web-App passed');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
