'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'outputs'),{recursive:true});let next=false,fail=false,searches=0;
const brief=id=>({id,name:`Training ${id}`,date:id===33000?'2026-10-07T22:00:00Z':'2026-09-21T22:00:00Z',status:id===33000?'CREATED':'FINISH',source:`https://portal.3k-darts.com/frontend/events/5/event/${id}/participants`});
const catalog=()=>({events:[brief(32260),brief(31849),...(next?[brief(33000)]:[])],selectedId:next?33000:32260,nextId:next?33000:null,stale:false,updatedAt:'2026-10-06T10:00:00Z'});
const payload=id=>({event:{...brief(id),database:5},source:brief(id).source,participants:[{id:1,name:'Spieler A'},{id:2,name:'Spieler B'}],groups:id===33000?[]:[{id:'7-8-0',name:'Gruppe 1',entries:[{rank:'1.',name:'Spieler A',played:1,wins:1,pointsFor:2,pointsAgainst:0,legsFor:3,legsAgainst:1}]}],matches:id===33000?[]:[{id:44,kind:'final',home:'Spieler A',away:'Spieler B',homeLegs:3,awayLegs:1}],performances:[{type:'HS',name:'Spieler A',count:2,value:180}],placements:[],stale:false,scheduleReady:id!==33000,updatedAt:'2026-10-06T10:00:00Z'});
const json=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local'),p=url.pathname;
  if(p==='/api/v1/darts/trainings'){searches++;return json(res,catalog(),fail?503:200);}
  if(p==='/api/v1/darts/training')return json(res,payload(Number(url.searchParams.get('event_id')||32260)),fail?503:200);
  const file=path.resolve(root,`.${['/training','/turnier'].includes(p)?'/turnier.html':p}`);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,body)=>{res.writeHead(err?404:200,{'Content-Type':{'.html':'text/html','.css':'text/css','.js':'text/javascript','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream'});res.end(err?'':body);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://backend4.3k-darts.com/**',async route=>{
      if(fail)return route.abort();
      const p=new URL(route.request().url()).pathname,id=Number(p.split('/event/')[1].split('/')[0]);let body;
      if(p.endsWith('/participant'))body=[{id:1,displayName:'Spieler A',paid:true}];
      else if(p.endsWith('/performance'))body={performanceCatalog:[]};else if(p.endsWith('/placement'))body=[];
      else body={event:{id,mandantKey:id===999?9:1931,dbId:5,name:`Training ${id}`,statusCd:'FINISH',datetime:'2026-09-21T22:00:00Z'},phases:[]};
      await route.fulfill({json:body});
    });
    await page.clock.install({time:new Date('2026-10-06T10:00:00Z')});await page.goto(`${origin}/training`);
    await page.getByRole('heading',{name:'Training 32260',exact:true}).waitFor();await page.locator('#boards tbody tr').waitFor();
    assert.equal(await page.locator('#view').inputValue(),'groups');assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.locator('#trainingControls').isVisible(),true);assert.equal(await page.locator('#eventInfo').innerText(),'22.9.2026 · 2 Teilnehmer · 0 laufende Spiele · 1 Gruppe');
    await page.selectOption('#view','performances');await page.getByText('2 × 180',{exact:true}).waitFor();
    await page.selectOption('#view','placement');await page.getByText('Noch keine offiziellen Platzierungen veröffentlicht.').waitFor();
    await page.waitForFunction(()=>!trainingSearchBusy&&!busy);next=true;await page.click('#findTrainings');await page.getByRole('heading',{name:'Training 33000',exact:true}).waitFor();
    assert.equal(await page.locator('#view').inputValue(),'participants');assert.equal(await page.locator('#boards .board').count(),2);
    await page.selectOption('#tournamentChoice','31849');await page.getByRole('heading',{name:'Training 31849',exact:true}).waitFor();assert.match(await page.locator('#tvLink').getAttribute('href'),/^\/training\?tv=1&event=31849$/);
    await page.click('#findTrainings');await page.waitForFunction(()=>!trainingSearchBusy);assert.equal(await page.locator('#eventTitle').innerText(),'Training 31849');
    const before=searches;await page.clock.runFor(300010);await page.waitForFunction(()=>!trainingSearchBusy);assert.ok(searches>before);
    await page.uncheck('#autoTrainingSearch');const disabledSearches=searches;await page.clock.runFor(300010);assert.equal(searches,disabledSearches);
    await page.locator('#trainingControls summary').click();await page.fill('#trainingLink','https://portal.3k-darts.com/frontend/events/5/event/999/participants');await page.click('#trainingLinkForm button');await page.getByText('Dieser Link gehört nicht zu einem Training von SV Barver.').waitFor();assert.equal(await page.locator('#eventTitle').innerText(),'Training 31849');
    await page.fill('#trainingLink','https://portal.3k-darts.com/frontend/events/5/event/32260/participants');await page.click('#trainingLinkForm button');await page.getByRole('heading',{name:'Training 32260',exact:true}).waitFor();assert.match(page.url(),/event=32260/);
    // Both connections fail after a complete snapshot: reload keeps the correct event.
    fail=true;await page.reload();await page.getByRole('heading',{name:'Training 32260',exact:true}).waitFor();await page.getByText(/Die letzten Daten bleiben sichtbar/).waitFor();assert.equal(await page.locator('#boards .board').count(),1);
    assert.equal(await page.locator('#autoTrainingSearch').isChecked(),false);
    for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow at ${width}`);}
    await page.screenshot({path:path.join(root,'outputs/training-mobile.png'),fullPage:true});
    fail=false;await page.goto(`${origin}/training?tv=1&event=31849`);await page.locator('#boards .standings').waitFor();assert.equal(await page.locator('#trainingControls').isVisible(),false);
    await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:path.join(root,'outputs/training-tv.png'),fullPage:true});
    assert.deepEqual(errors,[]);console.log('Training browser: common view, results, next search, pinned history, 5-minute timer, manual validation, offline reload, TV and mobile OK');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
