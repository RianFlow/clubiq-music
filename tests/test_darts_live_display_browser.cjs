// Regression: a scorer starts before the league schedule marks the fixture live.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),streams=new Set();
const fixture={id:1280527,home:'DC Brenndorf E',away:'SV Barver Darts B',barverTeam:'B',barverTeams:['B'],kind:'upcoming',score:null,eventId:1445,league:'kl04',plannedAt:new Date(Date.now()+300000).toISOString(),url:'https://portal.3k-darts.com/'};
let remaining=416,paused=false,moments=[];
function group(){return {groupKey:String(fixture.id),meta:fixture,events:moments,connected:true,stale:false,finished:false,matches:[{id:99,matchKey:'1280782',board:'2',active:!paused,finished:paused,teamScoreHome:0,teamScoreGuest:1,currentPlayerIndex:1,lastUpdate:new Date().toISOString(),lastUpdateNs:Date.now()*1e6,home:{name:'Marvin Schwenker',points:501,legs:1},guest:{name:'Max Lowak',points:remaining,legs:2}}]};}
function publish(){for(const res of streams)res.write(`event: update\ndata: ${JSON.stringify({group:group()})}\n\n`);}
const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://localhost').pathname;
  if(p==='/api/v1/darts/live/stream'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    res.write(`event: snapshot\ndata: ${JSON.stringify({groups:[group()]})}\n\n`);
    streams.add(res);req.on('close',()=>streams.delete(res));return;
  }
  if(p.startsWith('/api/')){
    let data={};
    if(p.endsWith('/ticker'))data={items:[fixture],updatedAt:new Date().toISOString(),stale:false,source:'browser-3k',centers:[]};
    if(p.endsWith('/season'))data={matches:[fixture],teams:['A','B','C','D'].map(code=>({code,name:`SV Barver Darts ${code}`,roster:[],matches:code==='B'?[fixture]:[]})),updatedAt:new Date().toISOString()};
    if(p.endsWith('/live'))data={groups:[group()]};
    if(p.includes('/matches/'))data={match:fixture,reportAvailable:true,games:[{id:100,number:2,status:'FINISH',homeLegs:0,awayLegs:3,home:{name:'Tim Hammann'},away:{name:'René Lange'}}],liveGames:[],performances:[],sourceUrl:fixture.url};
    if(p.endsWith('/center'))data={league:{},rounds:[],matches:[],standings:[],barverMatches:[],pushEvents:[]};
    if(p.endsWith('/ranking'))data={name:'DBD',events:[],rows:[]};
    if(p.endsWith('/player-profiles'))data={players:{
      '89030':{name:'Max Lowak',team:'B',image:'/pics/players/max-lowak-cutout.webp'},
      '116999':{name:'René Lange',team:'B',image:'/pics/players/rene-lange-cutout.webp'},
    }};
    if(p.endsWith('/sponsors'))data={sponsors:[]};
    if(p.endsWith('/events')||p.endsWith('/appointments'))data={events:[]};
    if(p.endsWith('/social-links'))data={links:[]};
    if(p.endsWith('/highlights'))data={items:[]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const file=path.resolve(root,`.${p==='/'||p==='/darts'?'/darts.html':p}`);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,body)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream'});res.end(err?'Not found':body);});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
    await context.route('https://*.3k-darts.com/**',route=>route.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});
    await page.goto(`http://127.0.0.1:${server.address().port}/darts`);
    try{await page.locator('#todayGrid .today-live-game').waitFor({timeout:10000});}catch(e){console.error('Live state:',await page.locator('#todayPanel').innerText(),'streams',streams.size);throw e;}
    assert.match(await page.locator('#todayGrid').innerText(),/Max Lowak/);
    assert.match(await page.locator('#todayGrid').innerText(),/416/);
    await page.locator('#todayGrid').getByRole('button',{name:'Spielbericht öffnen'}).click();
    await page.getByRole('tab',{name:'Live',exact:true}).click();
    assert.match(await page.locator('#matchHeading').innerText(),/0:1/);
    await page.locator('#match-panel-live').getByText('416',{exact:true}).waitFor();
    remaining=180;publish();
    await page.locator('#todayGrid').getByText('180',{exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'Live',exact:true}).getAttribute('aria-selected'),'true');
    await page.locator('#match-panel-live').getByText('180',{exact:true}).waitFor();
    moments=[{type:'game',matchId:fixture.id,gameId:88,team:'SV Barver Darts B',player:'Max Lowak',barverWon:false,homeLegs:3,awayLegs:1,text:'Max Lowak verliert 1:3 gegen Marvin Schwenker · AVG 55,6 / 60,2',occurred_at:new Date().toISOString()}];publish();
    await page.locator('#tickerTrack .ticker-group').first().getByText(/Partie verloren.*AVG 55,6/).waitFor();
    publish();
    assert.equal(await page.locator('#tickerTrack .ticker-group').first().getByText(/Partie verloren.*AVG 55,6/).count(),1,'repeated stream frames do not duplicate the result');
    moments=[{...moments[0],gameId:89,barverWon:true,homeLegs:1,awayLegs:3,text:'Max Lowak gewinnt 3:1 gegen Marvin Schwenker · AVG 55,6 / 60,2'}];publish();
    const single=page.locator('.darts-broadcast-card.type-game img');
    await single.waitFor();
    assert.equal(await single.getAttribute('alt'),'Porträt von Max Lowak');
    await page.waitForFunction(()=>document.querySelector('.darts-broadcast-card img')?.naturalWidth>0);
    await page.locator('.darts-broadcast-card.type-game').waitFor({state:'detached'});
    moments=[];
    await page.click('#closeMatch');
    await page.click('#fullscreen');await page.selectOption('#tvTeamChoice','B');
    // Chromium's native fullscreen cannot be resized. Choose the mobile viewport
    // before launching TV mode, as a real phone already has its screen size.
    await page.setViewportSize({width:390,height:844});
    await page.locator('#tvLauncherForm button[type=submit]').click();
    await page.waitForFunction(()=>document.body.classList.contains('tv-live'));
    assert.equal(await page.locator('#todayGrid').getAttribute('data-live-count'),'1');
    assert.match(await page.locator('#todayGrid').innerText(),/Brenndorf/i);
    moments=[{type:'game',matchId:fixture.id,gameId:90,team:'SV Barver Darts B',player:'M. Lowak & R. Lange',barverWon:true,homeLegs:1,awayLegs:3,text:'M. Lowak & R. Lange gewinnt 3:1 · AVG 55,6 / 60,2',occurred_at:new Date().toISOString()}];publish();
    await page.locator('.darts-broadcast.is-tv .darts-broadcast-card.type-game img').nth(1).waitFor();
    assert.equal(await page.locator('.darts-broadcast-card img').count(),2);
    assert.deepEqual(await page.locator('.darts-broadcast-card img').evaluateAll(images=>images.map(img=>img.alt)),['Porträt von Max Lowak','Porträt von René Lange']);
    await page.waitForFunction(()=>[...document.querySelectorAll('.darts-broadcast-card img')].every(img=>img.naturalWidth>0));
    await page.locator('.darts-broadcast-card').evaluate(card=>Promise.all(card.getAnimations().map(animation=>animation.finished)));
    const bounds=await page.locator('.darts-broadcast-card').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844,'double victory fits the mobile TV screen');
    if(process.env.DARTS_SCREENSHOT)await page.screenshot({path:process.env.DARTS_SCREENSHOT});
    moments=[];
    paused=true;publish();
    await page.locator('#todayGrid .today-game.live').waitFor();
    assert.equal(await page.locator('#todayGrid').isVisible(),true,'keep the team match visible between board blocks');
    assert.deepEqual(errors,[]);
    console.log('Live report, throw updates, result ticker with AVG, duplicate protection, single/double portraits, mobile TV and board pauses passed');
  }finally{await browser.close();for(const res of streams)res.end();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
