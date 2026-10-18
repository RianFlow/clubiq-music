// Shared public website, scoped PWA upgrade, local fixtures; no real push sends.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),posts=[],seen=[];
const deadline=setTimeout(()=>{console.error('Shared PWA browser test exceeded its deadline');process.exit(1);},120000).unref();
const upcoming={id:100,eventId:1445,home:'SV Barver Darts A',away:'Demo Gäste',barverTeam:'A',barverTeams:['A'],kind:'upcoming',plannedAt:new Date(Date.now()+86400000).toISOString()},old={...upcoming,id:99,kind:'pending',away:'Gegner von gestern',plannedAt:new Date(Date.now()-18*3600000).toISOString()};
function api(p){
  if(p.endsWith('/season'))return {available:true,teams:[{code:'A',name:'SV Barver Darts A',league:{key:'kl04',name:'Kreisligen 04'},roster:[{id:89019,name:'Denis Dieckmann',role:'Spieler'}],matches:[old,upcoming],record:{}}],matches:[old,upcoming],leagues:[],stale:false,updatedAt:new Date().toISOString()};
  if(p.endsWith('/ticker'))return {available:true,items:[old,upcoming],updatedAt:new Date().toISOString()};
  if(p.endsWith('/player-profiles'))return {players:{}};
  if(p.endsWith('/live'))return {groups:[]};
  if(p.endsWith('/center'))return {rounds:[],matches:[],standings:[],barverMatches:[],pushEvents:[]};
  if(p.endsWith('/matches/100'))return {available:true,reportAvailable:false,match:upcoming,games:[],liveGames:[]};
  if(p.endsWith('/posts'))return {posts:[]};if(p.endsWith('/social-links'))return {links:[]};if(p.endsWith('/sponsors'))return {sponsors:[]};
  if(p.endsWith('/config'))return {available:false};
  return {available:true,items:[],events:[],rows:[],stale:false,updatedAt:new Date().toISOString()};
}
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.webp':'image/webp','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const shared=file=>fs.readFileSync(file,'utf8').replace(/href="\/darts(?=[?\"])/g,'href="/app/').replaceAll('href="/training','href="/app/training').replaceAll('href="/turnier','href="/app/turnier').replaceAll('href="/"','href="/app/"');
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;seen.push(p);
  if(p.startsWith('/api/')){if(req.method!=='GET')posts.push(p);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(api(p)));return;}
  if(p==='/seed'){res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Migration fixture</title>');return;}
  if(p==='/legacy-worker.js'){res.writeHead(200,{'Content-Type':'text/javascript','Service-Worker-Allowed':'/app/'}).end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/app/')e.respondWith(caches.open('barver-compact-shell-old').then(c=>c.match('/app/')));});");return;}
  if(['/app/','/app/index.html','/app/live'].includes(p)){res.writeHead(200,{'Content-Type':'text/html'}).end(shared(path.join(root,'darts.html')));return;}
  if(['/app/training','/app/turnier'].includes(p)){res.writeHead(200,{'Content-Type':'text/html'}).end(shared(path.join(root,'turnier.html')));return;}
  const local=p==='/darts'?'/darts.html':p==='/app/sw.js'?'/static/darts-web-app-sw.js':p.startsWith('/app/')?'/static/barver-app/'+p.slice(5):p;
  const file=path.resolve(root,'.'+local);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(error?'Not found':data);});
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));await context.route('https://*.3k-darts.com/**',r=>r.abort());
   await page.goto(origin+'/seed');
   await page.evaluate(async()=>{
    localStorage.setItem('CapacitorStorage.barver-app-appearance','"dark"');localStorage.setItem('CapacitorStorage.barver-app-preferences',JSON.stringify({favorite:'A',teams:['A'],players:[],eventTypes:[],training:true}));
    const cache=await caches.open('barver-compact-shell-old');await cache.put('/app/',new Response('<!doctype html><title>Old app</title><script>navigator.serviceWorker.register("/app/sw.js?v=old",{scope:"/app/"})</script>',{headers:{'Content-Type':'text/html'}}));
    const history=await caches.open('barver-compact-history-v1');await history.put('/app/push-history',new Response(JSON.stringify([{id:'old-event',title:'Vorhandene Meldung',body:'Bleibt erhalten',at:Date.now()}])));
    const reg=await navigator.serviceWorker.register('/legacy-worker.js',{scope:'/app/'});await new Promise(resolve=>{if(reg.active?.state==='activated')return resolve();const w=reg.installing||reg.waiting;w.addEventListener('statechange',()=>{if(w.state==='activated')resolve();});});
   });
   await page.goto(origin+'/app/');await page.locator('#teamGrid').waitFor({state:'attached',timeout:30000});
   await page.waitForFunction(()=>navigator.serviceWorker.controller&&new URL(navigator.serviceWorker.controller.scriptURL).pathname==='/app/sw.js');
   assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clubiq_darts_preferences_v1')).eventTypes.length),0,'preserve opt-out');
   assert.equal(await page.locator('link[rel=icon]').getAttribute('href'),'/static/barver-app/icon-192.png?v=20261018-logo1');
   const manifest=await page.evaluate(()=>fetch('/app/manifest.webmanifest').then(r=>r.json()));assert.equal(manifest.id,'/app/');assert.equal(manifest.scope,'/app/');
   await page.waitForFunction(()=>document.querySelector('#homeTeamOverview')?.textContent.includes('Demo Gäste'));
   assert(!(await page.locator('#homeTeamOverview').innerText()).includes('Gegner von gestern'));
   await page.waitForFunction(async()=>{const c=await caches.open('clubiq-darts-notifications-v1'),r=await c.match('/__darts_notification_history__');return r&&(await r.json()).some(n=>n.title==='Vorhandene Meldung');});
   assert(!(await page.evaluate(()=>caches.keys())).some(key=>key.startsWith('barver-compact-shell-')));
   if(width===390){
    const worker=context.serviceWorkers().find(w=>new URL(w.url()).pathname==='/app/sw.js');assert(worker);
    await worker.evaluate(()=>{self.__shown=[];self.registration.showNotification=async(title,options)=>self.__shown.push({title,...options});self.dispatchEvent(new PushEvent('push',{data:JSON.stringify({title:'Demo · Partie gewonnen',body:'Spieler gewinnt 3:1',matchId:100,eventId:'local-result',url:'https://example.invalid/ignored'})}));});
    await page.waitForFunction(async()=>{const c=await caches.open('clubiq-darts-notifications-v1'),r=await c.match('/__darts_notification_history__');return r&&(await r.json())[0]?.tag==='local-result';});
    await worker.evaluate(async()=>{
     const all=self.clients.matchAll.bind(self.clients);self.clients.matchAll=async options=>(await all(options)).map(client=>({url:client.url,navigate:url=>client.navigate(url),focus:async()=>{},postMessage:data=>client.postMessage(data)}));
     const event=new Event('notificationclick'),pending=[];event.notification={...self.__shown[0],close(){}};event.waitUntil=promise=>pending.push(promise);self.dispatchEvent(event);await Promise.all(pending);
    });
    await page.waitForURL('**/app/?match=100');await page.locator('#matchDialog[open]').waitFor();
   }
   await page.goto(origin+'/app/?view=teams');await page.locator('#seasonTeams button[data-team="A"]').waitFor();await page.locator('#seasonTeams button[data-team="A"]').click();await page.locator('#teamDialog[open]').waitFor();assert((await page.locator('#teamProfile').innerText()).includes('Denis Dieckmann'));
   await page.goto(origin+'/app/?match=100');await page.locator('#matchDialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('#matchDetail')?.textContent.includes('Demo Gäste'));
   await page.goto(origin+'/app/?training=32751');await page.waitForURL('**/app/training?event=32751');assert.equal(await page.locator('#trainingControls').isVisible(),true);assert((await page.locator('#tvLink').getAttribute('href')).startsWith('/app/training'));
   await page.goto(origin+'/app/live?teams=A');await page.locator('#tvStudio').waitFor({timeout:20000});assert.equal(await page.locator('.darts-header .brand').getAttribute('href'),'/app/');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await context.close();
  }
  assert(!posts.some(p=>/\/push\/(subscribe|unsubscribe|test)$/.test(p)),'migration never changes push subscriptions');
  assert(!seen.includes('/app/app.js'),'public Web-App no longer loads the separate compact frontend');
  console.log('Shared website/PWA: phone, PC, legacy-cache upgrade, preferences/history, icons, reports, teams, training and TV passed.');
 }finally{clearTimeout(deadline);await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
