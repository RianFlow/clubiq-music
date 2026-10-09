// Regression: a scorer starts before the league schedule marks the fixture live.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),streams=new Set();
const fixture={id:1280527,home:'DC Brenndorf E',away:'SV Barver Darts B',barverTeam:'B',barverTeams:['B'],kind:'upcoming',score:null,eventId:1445,league:'kl04',plannedAt:new Date(Date.now()+300000).toISOString(),url:'https://portal.3k-darts.com/'};
let remaining=416,paused=false,moments=[],darts=12,lastScore=85,gameLegs=2,gameKey='1280782',teamFinished=false;
const league={key:'kl04',name:'Kreisligen 04',short:'KL 04',event:1445};
const tableRows=[{rank:1,rankSource:'3k-placement',name:fixture.away,barver:true,played:3,pointsFor:6,pointsAgainst:0},{rank:2,rankSource:'3k-placement',name:fixture.home,played:3,pointsFor:4,pointsAgainst:2}];
function group(){return {groupKey:String(fixture.id),meta:fixture,events:moments,connected:true,stale:false,finished:teamFinished,matches:[{id:99,matchKey:gameKey,board:'2',mode:'Best of 5 Legs',active:!paused,finished:paused,teamScoreHome:teamFinished?2:0,teamScoreGuest:teamFinished?10:1,currentPlayerIndex:1,lastUpdate:new Date().toISOString(),lastUpdateNs:Date.now()*1e6,home:{name:'Marvin Schwenker',points:501,legs:1,darts:9,totalDarts:54,totalScore:1050,average:58.3,lastScore:45},guest:{name:'Max Lowak',points:remaining,legs:gameLegs,darts,totalDarts:66,totalScore:1300,average:59.1,lastScore}},
{id:98,matchKey:'1280790',board:'2',mode:'Best of 5 Legs',active:false,finished:false,teamScoreHome:0,teamScoreGuest:1,lastUpdate:new Date(Date.now()-60000).toISOString(),lastUpdateNs:(Date.now()-60000)*1e6,home:{name:'Jannik Drieling',points:64,legs:1},guest:{name:'Robin Tiedemann',points:0,legs:3}}]};}
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
    if(p.endsWith('/season'))data={matches:[fixture],leagues:[{league,standings:tableRows}],teams:['A','B','C','D'].map(code=>({code,league,name:`SV Barver Darts ${code}`,roster:[],matches:code==='B'?[fixture]:[]})),updatedAt:new Date().toISOString()};
    if(p.endsWith('/live'))data={groups:[group()]};
    if(p.includes('/matches/'))data={match:fixture,reportAvailable:true,games:[{id:100,number:2,status:'FINISH',homeLegs:0,awayLegs:3,home:{name:'Tim Hammann'},away:{name:'René Lange'}}],liveGames:[],performances:[],sourceUrl:fixture.url};
    if(p.endsWith('/center')){const query=new URL(req.url,'http://localhost').searchParams,key=query.get('league'),roundId=Number(query.get('round_id'))||4;data={league:{...league,key},selectedRound:{id:roundId,name:'Spieltag '+roundId,dateFrom:fixture.plannedAt},rounds:[2,4].map(id=>({id,name:'Spieltag '+id,dateFrom:fixture.plannedAt})),matches:key==='kl04'&&roundId===4?[fixture]:[],standings:key==='kl04'?tableRows:[],barverMatches:[],events:[],pushEvents:[],updatedAt:new Date().toISOString()};}
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
  const file=p==='/app/'?path.resolve(root,'mobile/web-dist/index.html'):p.startsWith('/app/')&&p!=='/app/live'?path.resolve(root,'mobile/web-dist',p.slice(5)):path.resolve(root,`.${p==='/'||p==='/darts'||p==='/app/live'?'/darts.html':p}`);
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
    const ownAvatar=page.locator('#todayGrid .today-live-score .game-player-icons img');
    await page.waitForFunction(()=>document.querySelector('#todayGrid .game-player-icons img')?.getAttribute('src')?.includes('max-lowak-cutout'));
    assert.match(await ownAvatar.getAttribute('src'),/max-lowak-cutout/);
    assert.equal(await page.locator('#todayGrid .today-live-score>span').first().locator('img').count(),0,'opponents never receive the Barver crest');
    await ownAvatar.evaluate(img=>img.dispatchEvent(new Event('error')));
    assert.equal(await ownAvatar.getAttribute('src'),'/pics/sv-barver-darts-tight-512.webp','a failed live portrait switches to the crest');
    assert.doesNotMatch(await page.locator('#todayGrid').innerText(),/Robin Tiedemann|Jannik Drieling/,'completed game with missing finished flag never lingers');
    assert.equal(await page.locator('#todayGrid .today-live-game').count(),1);
    await page.click('#leagueView');
    const leagueBlock=page.locator('.league-block[data-league="kl04"]');
    await leagueBlock.locator('.round-match.is-live .table-live-badge').waitFor();
    assert.equal(await leagueBlock.locator('.league-standings-table .table-live-team').count(),2,'both teams link to their live fixture');
    await leagueBlock.getByRole('link',{name:'SV Barver Darts B: laufendes Spiel öffnen'}).focus();
    remaining=415;publish();
    await page.waitForFunction(()=>document.querySelector('#todayGrid .today-live-score')?.textContent.includes('415'));
    assert.match(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||''),/SV Barver Darts B: laufendes Spiel öffnen/,'score updates retain keyboard focus on the live team link');
    remaining=416;publish();
    await leagueBlock.locator('[data-role="round"]').selectOption('2');
    await leagueBlock.locator('[data-role="matches"]').getByText('Keine Begegnungen an diesem Spieltag.').waitFor();
    assert.equal(await leagueBlock.locator('.league-standings-table .table-live-team').count(),2,'standings show current live fixtures even when another round is selected');
    await leagueBlock.locator('[data-role="round"]').selectOption('4');
    await leagueBlock.locator('.round-match.is-live .table-live-badge').waitFor();
    await leagueBlock.getByRole('link',{name:'SV Barver Darts B: laufendes Spiel öffnen'}).click();
    await page.locator('#matchDialog[open]').waitFor();await page.click('#closeMatch');await page.click('#todayView');
    const ownFacts=page.locator('#todayGrid .today-live-facts').getByRole('group',{name:'Wurfwerte Max Lowak'});
    assert.match(await ownFacts.innerText(),/59,1/);assert.match(await ownFacts.innerText(),/Darts im Leg\s+12/);assert.match(await ownFacts.innerText(),/Letzter Wurf\s+85/);assert.match(await ownFacts.innerText(),/Geworfen im Leg: 85 Punkte/);assert.doesNotMatch(await ownFacts.innerText(),/1\.300|66 Darts|Partie gesamt/);
    await page.locator('#todayGrid').getByRole('button',{name:'Spielbericht öffnen'}).click();
    await page.getByRole('tab',{name:'Live',exact:true}).click();
    assert.match(await page.locator('#matchHeading').innerText(),/0:1/);
    await page.locator('#match-panel-live').getByText('416',{exact:true}).waitFor();
    assert.match(await page.locator('#match-panel-live .native-live-facts').innerText(),/Darts im Leg/);
    remaining=180;darts=15;lastScore=54;publish();
    await page.locator('#todayGrid').getByText('180',{exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'Live',exact:true}).getAttribute('aria-selected'),'true');
    await page.locator('#match-panel-live').getByText('180',{exact:true}).waitFor();
    assert.match(await ownFacts.innerText(),/Darts im Leg\s+15/);assert.match(await ownFacts.innerText(),/Letzter Wurf\s+54/);
    assert.match(await ownFacts.innerText(),/Geworfen im Leg: 321 Punkte/);
    remaining=501;darts=0;lastScore=0;publish();
    await page.waitForFunction(()=>document.querySelector('#todayGrid .today-live-facts')?.textContent.includes('Geworfen im Leg: 0 Punkte'));
    assert.match(await ownFacts.innerText(),/Darts im Leg\s+0/);
    assert.doesNotMatch(await ownFacts.innerText(),/1\.300|66 Darts|Partie gesamt/,'next leg never reuses match totals');
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
    await page.locator('.darts-broadcast-card.type-game').waitFor({state:'detached'});
    moments=[{...moments[0],gameId:91,barverWon:false,homeLegs:3,awayLegs:1,text:'M. Lowak & R. Lange verliert 1:3 gegen die Gäste · AVG 55,6 / 60,2'}];publish();
    const loss=page.locator('.darts-broadcast.is-tv.is-loss');await loss.waitFor();
    await page.locator('.darts-broadcast-card.is-loss').evaluate(card=>Promise.all(card.getAnimations().map(animation=>animation.finished)));
    const compactBounds=await loss.boundingBox();
    assert.ok(compactBounds.width<=360&&compactBounds.height<250&&compactBounds.y>400,'opponent result stays a small corner notice in TV mode');
    assert.equal(await loss.locator('img').count(),0,'losses do not show winner portraits');
    assert.match(await loss.innerText(),/PARTIE VERLOREN/);
    if(process.env.DARTS_LOSS_SCREENSHOT)await page.screenshot({path:process.env.DARTS_LOSS_SCREENSHOT});
    moments=[];
    paused=true;publish();
    await page.locator('#todayGrid .today-game.live').waitFor();
    assert.equal(await page.locator('#todayGrid').isVisible(),true,'keep the team match visible between board blocks');
    await page.evaluate(()=>document.exitFullscreen());
    paused=false;moments=[];remaining=180;darts=15;
    await page.goto(`http://127.0.0.1:${server.address().port}/app/`);
    await page.getByRole('button',{name:'Barver B',exact:true}).click();
    await page.locator('#appLiveStrip .live-chip').waitFor();
    assert.match(await page.locator('#appLiveStrip').innerText(),/501 : 180/);
    assert.doesNotMatch(await page.locator('#appLiveStrip').innerText(),/1300/);
    await page.locator('#appLiveStrip .live-chip').click();
    await page.getByRole('button',{name:/Verkleinern: Marvin Schwenker gegen Max Lowak/}).waitFor();
    const appAvatar=page.locator('.compact-board .game-player-icons img');await appAvatar.waitFor();
    await appAvatar.evaluate(img=>img.dispatchEvent(new Event('error')));
    assert.equal(await appAvatar.getAttribute('src'),'crest.webp','the Web-App uses its cached crest when a portrait fails');
    assert.equal(await page.locator('.compact-board .fold p').first().isVisible(),true,'expanded app board shows the additional live values');
    await page.getByRole('button',{name:/Verkleinern: Marvin Schwenker gegen Max Lowak/}).click();
    assert.equal(await page.locator('.compact-board .board-expand').getAttribute('aria-expanded'),'false');
    await page.click('#closeDetail');
    await page.locator('nav button[data-view="teams"]').click();
    await page.getByRole('button',{name:'SV Barver Darts B: laufendes Spiel öffnen'}).waitFor();
    await page.getByRole('button',{name:'TV-Modus öffnen',exact:true}).first().click();
    await page.waitForURL('**/app/live?**');
    assert.equal(new URL(page.url()).searchParams.get('teams'),'B');
    await page.waitForFunction(()=>document.body.classList.contains('app-tv'));
    await page.locator('#todayGrid .today-live-game').waitFor();
    const compact=page.locator('#todayGrid .today-live-game');
    const compactHeight=(await compact.boundingBox()).height;
    assert.ok(compactHeight<220,'mobile board overview stays small');
    assert.equal(await compact.locator('.today-live-facts').isVisible(),false);
    await compact.getByRole('button',{name:/Vergrößern:/}).click();
    assert.equal(await compact.locator('.today-live-facts').isVisible(),true);
    assert.ok((await compact.boundingBox()).height>compactHeight+80,'tap expands the game');
    remaining=76;publish();
    await compact.getByText('76',{exact:true}).waitFor();
    assert.equal(await compact.locator('.today-board-toggle').getAttribute('aria-expanded'),'true','live updates preserve expansion');
    await compact.getByRole('button',{name:/Verkleinern:/}).click();
    assert.equal(await compact.locator('.today-live-facts').isVisible(),false);
    // Background tap is also a usable target; a finished game resets the selection.
    await compact.locator('.today-live-brief').click();
    assert.equal(await compact.locator('.today-board-toggle').getAttribute('aria-expanded'),'true');
    gameLegs=3;publish();
    await page.locator('#todayGrid .today-board-wait').waitFor();
    assert.equal(await page.locator('#todayGrid .today-live-game').count(),0,'winning score removes the board without a finished flag');
    gameKey='1280792';gameLegs=0;remaining=501;publish();
    await page.locator('#todayGrid .today-live-game').waitFor();
    assert.equal(await compact.locator('.today-board-toggle').getAttribute('aria-expanded'),'false','next game on the same board starts compact');
    for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'compact and expanded boards fit '+width);await compact.getByRole('button',{name:/Vergrößern:/}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await compact.getByRole('button',{name:/Verkleinern:/}).click();}
    if(process.env.DARTS_COMPACT_SCREENSHOT)await page.screenshot({path:process.env.DARTS_COMPACT_SCREENSHOT});
    assert.equal(await page.evaluate(()=>document.fullscreenElement),null,'installed app TV mode also works without Fullscreen API');
    assert.equal(await page.locator('#liveDataStatus').isVisible(),true,'connection status stays visible on the phone');
    assert.equal(await page.locator('.darts-header .brand').getAttribute('href'),'/app/','club logo also returns within the app scope');
    for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Web-App TV fits the phone in '+theme);}
    moments=[{type:'leg',matchId:fixture.id,gameId:100,team:'SV Barver Darts B',player:'M. Lowak & R. Lange',barverWon:true,winnerSide:'guest',legCount:4,text:'M. Lowak & R. Lange gewinnt das Leg',occurred_at:new Date().toISOString()}];publish();
    await page.locator('.darts-broadcast.is-tv .darts-broadcast-card.type-leg img').nth(1).waitFor();
    assert.deepEqual(await page.locator('.darts-broadcast-card img').evaluateAll(images=>images.map(img=>img.alt)),['Porträt von Max Lowak','Porträt von René Lange']);
    await page.waitForFunction(()=>[...document.querySelectorAll('.darts-broadcast-card img')].every(img=>img.naturalWidth>0));
    await page.locator('.darts-broadcast-card.type-leg').evaluate(card=>Promise.all(card.getAnimations().map(animation=>animation.finished)));
    if(process.env.DARTS_APP_TV_SCREENSHOT)await page.screenshot({path:process.env.DARTS_APP_TV_SCREENSHOT});
    await page.locator('.darts-broadcast-card.type-leg').waitFor({state:'detached'});
    moments=[{type:'game',matchId:fixture.id,gameId:101,team:'SV Barver Darts B',player:'M. Lowak & Spieler ohne Foto',barverWon:true,homeLegs:1,awayLegs:3,text:'Doppel gewinnt 3:1',occurred_at:new Date().toISOString()}];publish();
    const mixedPortraits=page.locator('.darts-broadcast-card.type-game img');await mixedPortraits.nth(1).waitFor();
    assert.deepEqual(await mixedPortraits.evaluateAll(images=>images.map(img=>img.alt)),['Porträt von Max Lowak','Vereinslogo für Spieler ohne Foto']);
    assert.equal(await mixedPortraits.nth(1).getAttribute('src'),'/pics/sv-barver-darts-tight-512.webp');
    await mixedPortraits.first().evaluate(img=>img.dispatchEvent(new Event('error')));
    assert.equal(await mixedPortraits.first().getAttribute('alt'),'Vereinslogo für Max Lowak','failed victory photos retain their slot with the crest');
    await page.waitForFunction(()=>[...document.querySelectorAll('.darts-broadcast-card img')].every(img=>img.naturalWidth>0));
    await page.locator('.darts-broadcast-card.type-game').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Alle',exact:true}).click();
    await page.locator('#tvTeamControls [data-tv-team="B"]').click();
    await page.locator('#todayGrid .app-tv-empty').waitFor();
    assert.match(await page.locator('#todayGrid').innerText(),/erscheint sie hier automatisch/);
    await page.getByRole('button',{name:'Zurück zur App',exact:true}).click();
    await page.waitForURL('**/app/');
    await page.getByRole('heading',{name:'Barver B',exact:true}).waitFor();
    await page.locator('nav button[data-view="teams"]').click();
    await page.getByRole('button',{name:'SV Barver Darts B: laufendes Spiel öffnen'}).waitFor();
    teamFinished=true;await page.getByRole('button',{name:'Daten aktualisieren',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.table-live-team'));
    await page.setViewportSize({width:1440,height:1000});await page.goto(`http://127.0.0.1:${server.address().port}/darts`);await page.click('#leagueView');
    await leagueBlock.locator('.league-standings-table').waitFor();
    assert.equal(await leagueBlock.locator('.table-live-badge').count(),0,'finished team fixture loses all live markers');
    assert.deepEqual(errors,[]);
    console.log('Live report, darts/AVG/throw updates, result ticker, win portraits, compact opponent animation, mobile TV and board pauses passed');
  }finally{await browser.close();for(const res of streams)res.end();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
