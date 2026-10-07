// Local server and synthetic sporting events only; no production subscriptions.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
const dist=path.resolve(__dirname,'../web-dist'),posts=[];let nextBuild=false,degraded=false;
const types={html:'text/html',js:'text/javascript',css:'text/css',webp:'image/webp',png:'image/png',webmanifest:'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/site-sw.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");return;}
  if(url.pathname==='/website/'){res.writeHead(200,{'Content-Type':'text/html'}).end('<html><title>Website fixture</title><p>Website bleibt unabhängig.</p></html>');return;}
  if(url.pathname.startsWith('/api/')){
    let payload=null;if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);posts.push({path:url.pathname,payload});}
    const trainingFeed={event:{id:32751,name:'DEMO · Training',status:'ACTIVE',date:new Date().toISOString()},participants:[{id:1,name:'Demo Spieler'},{id:2,name:'Demo Gast'}],groups:[{name:'Gruppe 1',entries:[{rank:'1',name:'Demo Spieler',played:1,wins:1,pointsFor:2,pointsAgainst:0,legsFor:3,legsAgainst:0}]},{name:'Gruppe 2',entries:[{rank:'1',name:'Demo Gast',played:1,wins:1,pointsFor:2,pointsAgainst:0,legsFor:3,legsAgainst:1}]}],matches:[{id:902,kind:'final',home:'Demo Spieler',away:'Demo Gast',homeLegs:3,awayLegs:0}],performances:[{type:'HS',name:'Demo Spieler',value:180,count:1}],stale:false};
    const trainingLive={eventId:32751,updatedAt:new Date().toISOString(),stale:false,matches:[{id:'901',matchKey:'901',groupKey:'32751',board:'1',active:true,finished:false,lastUpdateNs:Date.now()*1e6,currentPlayerIndex:0,home:{name:'Demo Spieler',points:0,legs:2,average:61.5},guest:{name:'Demo Gast',points:201,legs:1,average:51.3}}]};
    const trainingData=url.pathname.endsWith('/trainings')?{events:[{id:32751,name:'DEMO · Training',date:new Date().toISOString(),status:'ACTIVE'}],selectedId:32751,stale:false}:url.pathname==='/api/v1/darts/training'?trainingFeed:url.pathname==='/api/v1/darts/training/live'?trainingLive:null;
    if(trainingData){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(trainingData));return;}
    const data=url.pathname.endsWith('/push/config')?{available:true,trainingAvailable:true,publicKey:'BA'+ 'A'.repeat(85),eventTypes:['180','high_finish','leg','game','match','player_start']}:req.method==='POST'?{ok:true}:url.pathname.endsWith('/season')?{matches:[{id:901,home:'SV Barver Darts A',away:'Demo-Gäste',barverTeam:'A',kind:'upcoming',plannedAt:new Date(Date.now()+86400000).toISOString()}],teams:[{code:'A',league:{key:'demo',name:'Demo-Liga'},roster:[{id:1,name:'Demo Spieler'}]}],leagues:[{league:{key:'demo',name:'Demo-Liga'},standings:[{name:'SV Barver Darts A',rank:1,played:3,pointsFor:6,pointsAgainst:0,barver:true}]}]}:url.pathname.endsWith('/live')?{groups:[]}:url.pathname.includes('/matches/')?{games:[]}:url.pathname.endsWith('/player-profiles')?{players:{}}:{items:[]};if(degraded&&url.pathname.endsWith('/season')){data.degraded=true;data.matches=[];data.leagues=[];data.teams=[];}res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data));return;
  }
  const name=url.pathname==='/app/'?'index.html':url.pathname.slice(5);
  if(!url.pathname.startsWith('/app/')||!['index.html','app.js','app.css','crest.webp','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'].includes(name)){res.writeHead(404).end();return;}
  let body=await fs.readFile(path.join(dist,name));if(name==='sw.js'&&nextBuild)body=body.toString().replace(/barver-compact-shell-[a-f0-9]+/,'barver-compact-shell-fixture-next');
  res.writeHead(200,{'Content-Type':types[name.split('.').pop()],'Cache-Control':'no-store'}).end(body);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const origin=`http://127.0.0.1:${server.address().port}`,context=await browser.newContext({viewport:{width:390,height:844},permissions:['notifications']});
    await context.route('https://backend4.3k-darts.com/**',route=>route.abort());await context.route('https://live.3k-darts.com/**',route=>route.abort());
    await context.addInitScript(()=>{
      // Browser subscription simulation never contacts a push service.
      let subscription=null;window.__permissionCalls=0;
      const make=()=>({endpoint:'https://example.invalid/local-fixture',toJSON:()=>({endpoint:'https://example.invalid/local-fixture',keys:{auth:'fixture-auth',p256dh:'fixture-key'}}),unsubscribe:async()=>{subscription=null;return true;}});
      PushManager.prototype.getSubscription=async()=>subscription;
      PushManager.prototype.subscribe=async()=>{window.__permissionCalls++;subscription=make();return subscription;};
    });
    const website=await context.newPage();await website.goto(origin+'/website/');await website.evaluate(async()=>{await navigator.serviceWorker.register('/site-sw.js',{scope:'/'});await navigator.serviceWorker.ready;await caches.open('clubiq-website-test');await caches.open('barver-compact-shell-obsolete');});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/app/');await page.locator('.welcome .favorite-choice').filter({hasText:'Barver A'}).click();
    await page.waitForFunction(()=>navigator.serviceWorker.controller&&new URL(navigator.serviceWorker.controller.scriptURL).pathname==='/app/sw.js');
    assert.equal(await page.evaluate(()=>window.__permissionCalls),0,'startup never requests push permission');assert.equal(await page.getByRole('button',{name:'Update verfügbar · jetzt neu laden',exact:true}).count(),0,'first app installation does not announce an update because of the website worker');
    assert.equal(await page.evaluate(async()=>{const keys=await caches.keys();return keys.includes('clubiq-website-test')&&!keys.includes('barver-compact-shell-obsolete');}),true,'website cache survives app activation');
    const manifest=await page.evaluate(async()=>fetch('/app/manifest.webmanifest').then(r=>r.json()));assert.equal(manifest.start_url,'/app/');assert.equal(manifest.scope,'/app/');assert.equal(manifest.display,'standalone');
    await page.getByRole('button',{name:'Training',exact:true}).click();await page.locator('main .live-board').waitFor();assert.match(await page.locator('main').innerText(),/CHECK/);assert.match(await page.locator('main').innerText(),/Demo Spieler/);
    for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'training fits mobile '+theme);}
    const trainingOutput=process.env.BARVER_OUTPUT||path.resolve(__dirname,'../../outputs');await fs.mkdir(trainingOutput,{recursive:true});await page.screenshot({path:path.join(trainingOutput,'Barver-App-Training.png'),fullPage:true});
    await page.getByRole('button',{name:'Gruppen',exact:true}).click();assert.equal(await page.locator('.training-table').count(),2);assert.match(await page.locator('main').innerText(),/Pkt./);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'group tables scroll inside cards');
    await page.getByRole('button',{name:'Ergebnisse',exact:true}).click();assert.match(await page.locator('main').innerText(),/3 : 0/);
    await page.getByRole('button',{name:'Bestleistungen',exact:true}).click();assert.match(await page.locator('main').innerText(),/180er: 180/);
    await page.getByRole('button',{name:'Mein Darts',exact:true}).click();await page.getByRole('button',{name:'Teams, Spieler & Ereignisse',exact:false}).click();assert.equal(await page.getByRole('checkbox',{name:'Vereinstraining verfolgen',exact:true}).isChecked(),false);await page.getByRole('checkbox',{name:'Vereinstraining verfolgen',exact:true}).check();
    await page.getByRole('button',{name:'Mein Darts',exact:true}).click();await page.getByRole('button',{name:'Auf dem Handy installieren',exact:false}).click();assert.match(await page.locator('main').innerText(),/eigenes Symbol/);
    await page.getByRole('button',{name:'‹ Zurück zum Menü',exact:true}).click();await page.getByRole('button',{name:'Pushmeldungen',exact:false}).click();
    await page.getByRole('button',{name:'Pushmeldungen aktivieren',exact:true}).click();await page.getByRole('button',{name:'Pushmeldungen deaktivieren',exact:true}).waitFor();assert.equal(posts.filter(p=>p.path.endsWith('/subscribe')).length,1);assert.equal(posts.find(p=>p.path.endsWith('/subscribe')).payload.training,true);assert.equal(await page.evaluate(()=>window.__permissionCalls),1);
    await page.getByRole('button',{name:'Testnachricht senden',exact:true}).click();await page.getByText('Testnachricht beim Server angefordert. Bitte auch bei gesperrtem Handy prüfen.',{exact:true}).waitFor();assert.equal(posts.find(p=>p.path.endsWith('/test')).payload.training,true);
    const worker=context.serviceWorkers().find(w=>new URL(w.url()).pathname==='/app/sw.js');assert(worker);
    await worker.evaluate(()=>{self.__shown=[];self.registration.showNotification=async(title,options)=>self.__shown.push({title,...options});});
    await worker.evaluate(()=>self.dispatchEvent(new PushEvent('push',{data:JSON.stringify({title:'DEMO · Spielerstart',body:'Demo Spieler startet an Board 2.',matchId:901,eventId:'fixture-start',tag:'fixture-start',url:'https://example.invalid/ignored'})})));
    await page.waitForFunction(async()=>{const cache=await caches.open('barver-compact-history-v1');const r=await cache.match(location.origin+'/app/push-history');return !!r&&(await r.json())[0]?.id==='fixture-start';});
    const notifications=await worker.evaluate(()=>self.__shown);assert.equal(notifications[0].data.matchId,901);
    await worker.evaluate(async()=>{const matchAll=self.clients.matchAll.bind(self.clients);self.clients.matchAll=async options=>(await matchAll(options)).map(client=>({url:client.url,navigate:url=>client.navigate(url),focus:async()=>{},postMessage:data=>client.postMessage(data)}));const event=new Event('notificationclick'),promises=[];event.notification={...self.__shown[0],close(){}};event.waitUntil=promise=>promises.push(promise);self.dispatchEvent(event);await Promise.all(promises);});
    await page.waitForURL('**/app/?match=901');await page.locator('#detail[open]').waitFor();assert.match(await page.locator('#detailContent').innerText(),/SV Barver Darts A gegen Demo-Gäste/);assert.equal(website.url(),origin+'/website/','notification never navigates the website tab');
    await page.keyboard.press('Escape');
    await worker.evaluate(()=>self.dispatchEvent(new PushEvent('push',{data:JSON.stringify({title:'DEMO · Training · 180er',body:'Demo Spieler wirft 180.',scope:'training',trainingId:32751,matchId:32751,eventId:'fixture-training',tag:'fixture-training'})})));
    await worker.evaluate(async()=>{while(self.__shown.length<2)await new Promise(resolve=>setTimeout(resolve,10));const event=new Event('notificationclick'),promises=[];event.notification={...self.__shown[1],close(){}};event.waitUntil=p=>promises.push(p);self.dispatchEvent(event);await Promise.all(promises);});
    await page.waitForURL('**/app/?training=32751');await page.locator('main .live-board').waitFor();assert.equal(await page.locator('#detail').evaluate(n=>n.open),false,'training alerts never open a league report');
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Mein Darts',exact:true}).click();await page.getByRole('button',{name:'Empfangene Meldungen',exact:false}).click();assert.match(await page.locator('main').innerText(),/Demo Spieler startet/);
    await page.getByRole('button',{name:'Start',exact:true}).click();
    const output=process.env.BARVER_OUTPUT||path.resolve(__dirname,'../../outputs');await fs.mkdir(output,{recursive:true});await page.locator('#preview').evaluate(n=>{n.textContent='DEMO · WEB-APP MIT TESTDATEN';});await page.screenshot({path:path.join(output,'Barver-Web-App-Vorschau.png'),fullPage:true});
    await context.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Barver A',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Letzter bekannter Stand'));await page.getByRole('button',{name:'Teams',exact:true}).click();assert.equal(await page.locator('main .standings tbody tr').count(),1);assert.equal(await page.locator('body').evaluate(n=>n.scrollWidth<=innerWidth),true,'phone fits without horizontal overflow');
    await context.setOffline(false);await page.reload();await page.waitForFunction(()=>navigator.serviceWorker.controller&&new URL(navigator.serviceWorker.controller.scriptURL).pathname==='/app/sw.js');
    degraded=true;await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Letzter bekannter Stand'));assert.equal(await page.locator('main .card').filter({hasText:'Demo-Gäste'}).count(),1,'partial source does not erase cached matches');degraded=false;nextBuild=true;await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration('/app/');await registration.update();});await page.getByRole('button',{name:'Update verfügbar · jetzt neu laden',exact:true}).waitFor();
    await page.getByRole('button',{name:'Start',exact:true}).click();await page.locator('main .card').filter({hasText:'Demo-Gäste'}).click();assert.equal(await page.locator('#detail').evaluate(n=>n.open),true,'waiting update does not reload an open match');
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Update verfügbar · jetzt neu laden',exact:true}).click();await page.waitForFunction(async()=>{const keys=await caches.keys();return keys.includes('barver-compact-shell-fixture-next')&&keys.filter(k=>k.startsWith('barver-compact-shell-')).length===1;});
    assert.deepEqual(errors,[]);console.log('Web-App browser checks passed: scoped installation, no startup prompt, filters, worker notification/navigation/history, offline favorites/tables, safe update, website cache/tab preserved.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
