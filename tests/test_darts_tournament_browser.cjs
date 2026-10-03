// Local-only fixture, including a volatile demonstration of tournament administration.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');let empty=false,fail=false;
let setting={event:{name:'DEMO · Barver Open',date:'2026-10-03T11:00:00Z'},source:'https://portal.3k-darts.com/frontend/events/5/event/22536/participants'};
const payload=()=>({event:setting.event,participants:[{name:'<script>Spielerin</script>'}],groups:empty?[]:[{id:'1',name:'Gruppe A',entries:Array.from({length:12},(_,i)=>({rank:`${i+1}.`,name:`Teilnehmer ${i+1}`,played:4,wins:2,pointsFor:4,pointsAgainst:4,legsFor:6,legsAgainst:6}))},{id:'2',name:'Gruppe B',entries:[{rank:'1.',name:'<script>Safe</script>',played:2,wins:1}]}],scheduleReady:!empty,stale:false,updatedAt:new Date().toISOString(),matches:empty?[]:Array.from({length:25},(_,i)=>({id:i+1,kind:'live',board:String(i+1),home:`Spieler ${i+1}`,away:'Gast',homeLegs:1,awayLegs:2,live:{currentPlayerIndex:0,home:{points:320,legs:1,count180:0,highFinish:0},guest:{points:410,legs:2,count180:0,highFinish:0}}}))});
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local'),p=url.pathname;
  if(p.startsWith('/api/')){
    if(p.includes('/admin/')){
      if(req.headers['x-admin-password']!=='demo')return json(res,{detail:'Demo-Kennwort: demo'},401);
      if(p==='/api/v1/music/admin/verify')return json(res,{status:'ok'});
      if(p==='/api/v1/darts/admin/tournament'&&req.method==='GET')return json(res,setting);
      if(p==='/api/v1/darts/admin/tournament/preview'||(p==='/api/v1/darts/admin/tournament'&&req.method==='PUT')){
        let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const source=JSON.parse(body).source;
          if(!/^https:\/\/portal\.3k-darts\.com\/frontend\/events\/(5|10)\/event\/\d+/.test(source))return json(res,{detail:'Bitte einen öffentlichen 3K-Turnierlink eingeben.'},422);
          const checked={source,event:{name:'DEMO · Nächstes Dartturnier',date:'2026-10-04T10:00:00Z'}};if(req.method==='PUT')setting=checked;json(res,checked);});return;
      }
      return json(res,{players:[],sponsors:[],events:[],links:[]});
    }
    if(p.endsWith('/season'))return json(res,{teams:[],matches:[]});
    return json(res,payload(),fail?503:200);
  }
  const file=path.resolve(root,`.${p==='/turnier'?'/turnier.html':p==='/darts-admin'?'/darts-admin.html':p}`);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,body)=>{const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'};
    if(!err&&p==='/darts-admin')body=Buffer.from(body.toString().replace('<main>','<main><p>DEMO · Änderungen werden nur hier simuliert. Kennwort: demo</p>'));
    res.writeHead(err?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(err?'':body);
  });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  if(process.argv.includes('--serve')){console.log(`Demo: ${origin}/turnier?tv=1&demo=tournament\nVerwaltung: ${origin}/darts-admin (Kennwort: demo)`);return;}
  const{chromium}=require('playwright'),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();await page.goto(`${origin}/turnier?tv=1`);await page.getByText('320',{exact:true}).first().waitFor();
    assert.equal(await page.locator('.board').count(),8);assert.equal(await page.locator('#pageCount').innerText(),'1 / 4');
    assert.equal(await page.locator('#groupTable tbody tr').count(),8);await page.click('#groupNext');assert.equal(await page.locator('#groupTable tbody tr').count(),4);
    await page.click('#groupNext');assert.equal(await page.locator('#groupTable h2').innerText(),'Gruppe B');assert.equal(await page.locator('#groupTable script').count(),0);
    await page.locator('#next').click();assert.equal(await page.locator('#pageCount').innerText(),'2 / 4');
    await page.locator('#pageSize').selectOption('16');assert.equal(await page.locator('.board').count(),16);
    await page.selectOption('#tableMode','alternate');await page.clock.runFor(20000);assert.equal(await page.locator('#boards .standings').count(),1);
    await page.click('#next');await page.clock.runFor(20000);assert.ok(await page.locator('.board').count()>0);assert.ok(await page.locator('.board').count()<=16);
    await page.selectOption('#view','groups');assert.equal(await page.locator('#boards .standings').count(),1);
    await page.selectOption('#view','participants');assert.equal(await page.locator('.board').innerText(),'<script>Spielerin</script>');assert.equal(await page.locator('.board script').count(),0);
    await page.selectOption('#tableMode','sidebar');await page.selectOption('#view','live');await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.goto(`${origin}/turnier`);await page.locator('.board').first().waitFor();assert.equal(await page.locator('.board').count(),25);
    fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByText('Die letzten Daten bleiben sichtbar. Automatische Neuverbindung läuft.').waitFor();assert.equal(await page.locator('.board').count(),25);
    fail=false;empty=true;await page.reload();await page.getByText(/Die Gruppen und Paarungen sind noch nicht veröffentlicht/).waitFor();
    let liveRequests=0;page.on('request',r=>{if(r.url().includes('/api/'))liveRequests++;});await page.goto(`${origin}/turnier?tv=1&demo=tournament`);
    await page.getByText('DEMO · Keine echten Ergebnisse').waitFor();await page.locator('.board').first().waitFor();assert.equal(await page.locator('.board').count(),8);assert.equal(liveRequests,0);
    await page.click('#demoHighlight');await page.locator('#highlight').getByText(/180 geworfen/).waitFor();await page.click('#demoPause');await page.getByRole('button',{name:'Demo fortsetzen'}).waitFor();
    await page.goto(`${origin}/darts-admin`);await page.fill('#adminPassword','demo');await page.click('#loginForm button');await page.click('#tournamentAdminTab');
    await page.getByText('Aktiv: DEMO · Barver Open',{exact:false}).waitFor();assert.equal(await page.isDisabled('#activateTournament'),true);
    await page.fill('#tournamentSource','https://portal.3k-darts.com/frontend/events/5/event/123/participants');await page.click('#checkTournament');await page.getByText(/Gefunden: DEMO · Nächstes Dartturnier/).waitFor();
    await page.fill('#tournamentSource','https://portal.3k-darts.com/frontend/events/5/event/124/participants');assert.equal(await page.isDisabled('#activateTournament'),true);
    await page.click('#checkTournament');await page.waitForFunction(()=>!document.querySelector('#activateTournament').disabled);page.on('dialog',d=>d.accept());await page.click('#activateTournament');await page.getByText(/Turnier aktiviert/).waitFor();assert.match(setting.source,/124/);
    assert.deepEqual(errors,[]);console.log('Tournament: groups/rotation, 25 boards, mobile, reconnect, isolated demo and admin selection OK');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
