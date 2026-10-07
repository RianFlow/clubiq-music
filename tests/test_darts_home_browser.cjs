// Local fixture server + real-browser regression. No production writes or 3K calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const now=()=>new Date().toISOString();
const day=n=>{const d=new Date();d.setDate(d.getDate()+n);d.setHours(19,30,0,0);return d.toISOString();};
const matches=[
  {id:901,barverTeam:'A',home:'SV Barver Darts A',away:'Demo-Gäste A',kind:'live',score:'5:4',eventId:1445,plannedAt:day(0)},
  {id:902,barverTeam:'D',home:'Demo-Gäste D',away:'SV Barver Darts D',kind:'live',score:'3:2',eventId:1460,plannedAt:day(0)},
  {id:903,barverTeam:'B',home:'SV Barver Darts B',away:'Demo-Team B',kind:'upcoming',eventId:1445,plannedAt:day(2),isSpecial:true,league:'special-500',competitionBadge:'POKAL',round:{name:'Runde 1'}},
  {id:904,barverTeam:'C',home:'Demo-Team C',away:'SV Barver Darts C',kind:'final',score:'4:8',eventId:1445,plannedAt:day(-2)},
];
if(process.argv.includes('--quiet'))for(const match of matches)if(match.kind==='live'){match.kind='upcoming';delete match.score;}
const teams=['A','B','C','D'].map((code,i)=>({code,rank:i+2,rankSource:'3k-placement',name:`SV Barver Darts ${code}`,league:{name:code==='D'?'Kreisklasse 11':'Kreisligen 04'},record:{},matches:matches.filter(m=>m.barverTeam===code),roster:[{id:89027+i,name:code==='A'?'Jannik Kläning':`Demo-Spieler ${code}`,role:'Kapitän'}],venue:{name:'Testspielstätte',street:'Teststraße 1',postalCode:'49453',city:'Barver'}}));
teams[1].roster=[{id:89029,name:'Patrick Lammers',role:'Kapitän'}];
let fail=false,tvEmpty=false,fallbackEnabled=false,futureMode=false,centerFailure=false,centerTableFailure=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(p.startsWith('/api/')) {
    if(fail||(centerFailure&&p.endsWith('/center')&&url.searchParams.get('league')==='kl04')) {res.writeHead(503);res.end('{}');return;}
    let data={};
    if(p==='/api/v1/darts/presence') data={online:7,windowSeconds:120,demo:true};
    if(p.endsWith('/tournament'))data={event:{id:30458,name:'DBD 9. Runde',date:day(-2)},participants:[],groups:[],matches:[],scheduleReady:false,updatedAt:now()};
    if(p.endsWith('/ticker')) data={items:matches,updatedAt:now(),stale:false};
    if(p.endsWith('/tv'))data={available:true,stale:false,updatedAt:now(),events:tvEmpty?[]:[{title:'Testturnier · Runde 2',start:day(1),url:'https://www.sport1.de/tv-video/stream/test__1'},{title:'Schon vorbei',start:day(-1),url:'https://www.sport1.de/tv-video/stream/past__2'},{title:'Falscher Anbieterlink',start:day(2),url:'https://example.com/'}]};
    if(p.endsWith('/ranking')) data={name:'DBD Rangliste 2026',updatedAt:now(),events:[{id:30458,name:'DBD 9. Runde',start:day(-2),city:'Diepholz',sourceUrl:'https://portal.3k-darts.com/frontend/events/5/event/30458/participants'}],rows:[{rank:3,name:'Jannik Kläning',points:122,appearances:6,average:20.3,rounds:[{id:30458,points:0,rated:true}]},{rank:1,name:'<script>Test</script>',points:128,appearances:7,average:18.3,rounds:[]},...Array.from({length:20},(_,i)=>({rank:i+4,name:`Demo-Gast ${i+1}`,points:40-i,appearances:3,average:10,rounds:[]}))]};
    if(p.endsWith('/season')) data={matches,teams,updatedAt:now(),specialEvents:[{id:500,name:'Bezirkspokal',badge:'POKAL',matchCount:1}]};
    if(p.endsWith('/center')) data={league:{key:url.searchParams.get('league'),short:'DEMO'},selectedRound:{id:1,name:'Spieltag 1'},rounds:[{id:1,name:'Spieltag 1'}],matches:[],standings:[{id:1,rank:1,rankSource:'3k-placement',name:'Demo-Team',played:3,wins:2,draws:1,losses:0,pointsFor:5,pointsAgainst:1,setsFor:24,setsAgainst:12,legsFor:70,legsAgainst:41}],updatedAt:now(),barverMatches:matches.filter(m=>m.kind==='live'),pushEvents:matches.filter(m=>m.kind==='live').flatMap(m=>[1,2].map(i=>({type:'live_game',matchId:m.id,homeName:i===1?'Jannik Kläning':'Spieler Zwei',awayName:`Gast ${i}`,homeRemaining:i===1?320:201,awayRemaining:410,homeLegs:2,awayLegs:1,currentSide:'home'})))};
    if(p==='/api/v1/darts/matches/901')data={match:matches[0],games:[{number:1,status:'FINISH',block:'Einzel',home:{name:'Jannik Kläning',average:45},away:{name:'Gast',average:40},homeLegs:3,awayLegs:1}],liveGames:[],performances:[],sourceUrl:'https://portal.3k-darts.com/'};
    if(p.endsWith('/highlights')) data={items:[{type:'180',matchId:904,title:'180! Demo-Spieler C',body:'Barver C · Rückblick',occurredAt:day(-2)}]};
    if(p.endsWith('/config')) data={available:false};
    if(p.endsWith('/status')) data={configured:false};
    if(p.endsWith('/members')) data={members:['Patrick Lammers','Erika Beispiel']};
    if(p==='/api/v1/darts/events'||p==='/api/v1/darts/appointments') data={events:[{id:1,title:'11. Barver Dart Open',description:'Einzel und Doppel in Barver',image:'/pics/events/barver-dart-open-2026.webp',active:true,priority:100},{id:2,title:'Vereinsabend',description:'Zweite Veranstaltung',calendarDate:day(3).slice(0,10),location:'Testvereinsheim',active:true},{id:3,title:'Entwurf',active:false}]};
    if(p==='/api/v1/darts/appointments')data.events=data.events.map(e=>e.id===2?{...e,startsAt:day(9)}:e);
    if(p==='/api/v1/darts/social-links') data={links:[{id:1,platform:'whatsapp',label:'WhatsApp-Kanal',href:'https://whatsapp.com/channel/0029Vb1TkYQ5K3zONLbu0C0l',active:true},{id:2,platform:'instagram',label:'Instagram · SV Barver Darts',href:'https://www.instagram.com/svbarverdarts/',teaser:'Bilder aus dem Verein',showInBanner:true,active:true},{id:3,platform:'facebook',label:'Ausgeblendeter Kanal',href:'https://www.facebook.com/',active:false}]};
    if(p==='/api/v1/darts/sponsors') data={displaySeconds:12,sponsors:[{id:1,name:'Testpartner',type:'main',placements:['top','inline']}]};
    if(p.endsWith('/player-profiles')) {data=JSON.parse(fs.readFileSync(path.join(root,'static/darts-players.json'),'utf8'));data.players['89029'].personal.throwingHand='right';}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const file=path.resolve(root,`.${p==='/'||p==='/darts'?'/darts.html':p==='/turnier'?'/turnier.html':p}`);
  if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,body)=>{
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.json':'application/json','.svg':'image/svg+xml'};
    if(!error&&file.endsWith('darts.html')) {
      let html=body.toString().replace('<main>','<main><p class="message">VORSCHAU · Simulierte Begegnungen, keine echten Spielstände</p>');
      if(process.argv.includes('--serve')&&url.searchParams.get('preview')!=='home') html=html.replace('</body>','<script src="/tests/darts-motion-demo.js"></script></body>');
      body=Buffer.from(html);
    }
    res.writeHead(error?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(error?'Not found':body);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  if(process.argv.includes('--serve')) {console.log(`Preview: ${origin}/darts`);return;}
  const {chromium}=require('playwright');
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'});
    await context.route('https://backend-ddv.3k-darts.com/**',async route=>{
      if(!fallbackEnabled)return route.abort();
      const url=route.request().url(),event=url.includes('/event/1445/')?1445:1460;
      if(url.endsWith('/table')&&centerTableFailure)return route.abort();
      const body=url.endsWith('/table')?{tableEntries:[{tableEntries:[{participantId:174110,participantName:'SV Barver Darts A',participantRankingPos:3,placement:'1.',matchCount:3,win:2,tie:1,lost:0,points1:5,points2:1,sets1:24,sets2:12,legs1:70,legs2:41,email:'private@example.test'},{participantId:888,participantName:'Alternative Gäste',participantRankingPos:1,placement:'2.',points1:6,points2:0}]}]}:url.includes('/round/')?{matches:[{id:event===1445?901:902,eventId:event,statusCd:'OPEN',setsHome:futureMode?null:8,setsAway:futureMode?null:3,datePlanned:day(futureMode?2:0),participantHome:{id:event===1445?174110:174266,displayName:event===1445?'SV Barver Darts A':'SV Barver Darts D',email:'private@example.test'},participantGuest:{id:888,displayName:'Alternative Gäste'}}]}:{rounds:[{id:123,name:'Spieltag 4',dateFrom:day(-1),dateTo:day(1)},{id:124,name:'Spieltag 5',dateFrom:day(10),dateTo:day(12)}]};
      await route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},contentType:'application/json',body:JSON.stringify(body)});
    });
    await context.route('https://live.3k-darts.com/**',async route=>{
      if(!fallbackEnabled)return route.abort();
      await route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},contentType:'application/json',body:JSON.stringify({data:[{id:55,statusActive:true,currentplayerIndex:0,matchPlayers:[{playerName:'Jannik Kläning',points:121,legs:2,email:'private@example.test'},{playerName:'Gast',points:180,legs:1}]}]})});
    });
    await context.route(`${origin}/api/v1/darts/live`,async route=>{
      if(!fallbackEnabled)return route.continue();
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({groups:[{groupKey:'901',connected:false,stale:true,finished:false,lastSuccess:day(-1),meta:{id:901,home:'SV Barver Darts A',away:'Gäste',barverTeams:['A']},matches:[{id:999,active:true,finished:false,teamScoreHome:1,teamScoreGuest:1,home:{name:'Alt',points:320,legs:0},guest:{name:'Alt',points:501,legs:0},lastUpdateNs:Date.now()*1e6}]}]})});
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});
    await page.goto(`${origin}/darts`);
    assert.equal(await page.locator('#scheduleDetails').evaluate(n=>n.open),false);await page.locator('#scheduleDetails').evaluate(n=>n.open=true);
    await page.getByText('7 online · Demo',{exact:true}).waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.fonts.check('16px Inter')),true);
    assert.match(await page.locator('h2').first().evaluate(node=>getComputedStyle(node).fontFamily),/Inter/);
    await page.click('#leagueView');await page.locator('.league-standings-table').first().waitFor();
    assert.match(await page.locator('.league-standings-table').first().innerText(),/Punkte/);
    assert.match(await page.locator('.league-standings-table').first().innerText(),/5:1/);
    await page.screenshot({path:path.join(root,'outputs/darts-standings-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'standings mobile overflow');
    await page.screenshot({path:path.join(root,'outputs/darts-standings-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1080});await page.click('#todayView');

    assert.equal(await page.getByRole('link',{name:/Voting/i}).count(),0);
    assert.equal(await page.locator('.personal-settings #pushToggle').count(),1);
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#nextAppointmentsList .appointment-card').first().waitFor();assert.ok(await page.locator('.calendar-button').count()>0);await page.locator('#nextAppointmentsList').getByRole('heading',{name:'Vereinsabend'}).waitFor();assert.ok(await page.locator('#nextAppointmentsList').getByRole('link',{name:'Route öffnen'}).count()>0);
    const downloadPromise=page.waitForEvent('download');await page.locator('#nextAppointmentsList .calendar-button').first().click();const calendarDownload=await downloadPromise;assert.match(calendarDownload.suggestedFilename(),/barver-.*\.ics/);
    await page.locator('#clubEventTitle').getByText('11. Barver Dart Open',{exact:true}).waitFor();
    await page.click('#nextClubEvent');assert.equal(await page.locator('#clubEventTitle').textContent(),'Vereinsabend');
    await page.click('#previousClubEvent');assert.equal(await page.locator('#clubEventCount').innerText(),'1 / 2');
    await page.locator('#socialLinksList a').first().waitFor();assert.equal(await page.locator('#socialLinksList svg').count(),2);await page.locator('#socialLinks').getByText('Neueste Infos',{exact:true}).waitFor();assert.match(await page.locator('#socialLinksList a[data-platform=whatsapp]').getAttribute('href'),/whatsapp.com\/channel/);
    await page.locator('#socialLinks').getByText('Bilder aus dem Verein',{exact:true}).waitFor();assert.equal(await page.locator('#socialLinksList a[data-platform=instagram]').getAttribute('href'),'https://www.instagram.com/svbarverdarts/');assert.equal(await page.locator('#socialLinksList a[data-platform=facebook]').count(),0);
    await page.locator('#todayGrid .today-live-game').nth(1).waitFor();
    await page.locator('#todayGrid').getByRole('button',{name:'Spielerprofil von Jannik Kläning öffnen'}).first().click();await page.locator('#playerDialog').getByRole('button',{name:'Zurück zum Spielbericht'}).click();await page.locator('#matchDialog').waitFor();await page.getByRole('tab',{name:'Einzelpartien'}).click();await page.locator('#matchDialog').getByRole('button',{name:'Spielerprofil von Jannik Kläning öffnen'}).click();await page.locator('#playerDialog').getByRole('button',{name:'Zurück zum Spielbericht'}).click();await page.click('#closeMatch');
    assert.equal(await page.locator('#matchCenterGrid .match-center-card').count(),4);
    assert.equal(await page.locator('#matchCenterGrid .present-team-roster').count(),4);
    assert.equal(await page.locator('#teamGrid .present-team-roster').count(),4);
    for (const code of ['A','B','C','D']) {
      await page.locator('#matchCenterGrid').getByRole('button',{name:`Kader Barver ${code} vorstellen`,exact:true}).click();
      await page.locator('.darts-roster-slide').waitFor();
      assert.match(await page.locator('.darts-roster-team').innerText(),new RegExp(`Darts ${code}`,'i'));
      assert.equal(await page.locator('#teamDialog').evaluate(node=>node.open),false);
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.locator('#todayGrid .today-game').count(),1);
    assert.equal(await page.locator('#homeSchedule > section').count(),3);
    await page.selectOption('#favoriteTeam','D');
    assert.match(await page.locator('#todayGrid').innerText(),/BARVER D/);
    assert.equal(await page.locator('#homeFilters').evaluate(node=>node.open),false);
    await page.locator('#homeFilters summary').click();
    await page.selectOption('#homeTeam','D');
    assert.match(await page.locator('#homeFilterSummary').innerText(),/Barver D/);
    assert.equal(await page.locator('#homeSchedule .team-profile-match').count(),1);
    await page.click('#resetHomeFilters');
    await page.click('#cupView');
    await page.getByText('Bezirkspokal',{exact:true}).waitFor();
    assert.match(await page.locator('#specialEventsList').innerText(),/Demo-Team B/);
    await page.click('#todayView');
    assert.equal(await page.locator('#homeSchedule .team-profile-match').count(),4);
    await page.selectOption('#homeLeague','1460');
    assert.equal(await page.locator('#homeSchedule .team-profile-match').count(),1);
    await page.click('#resetHomeFilters');
    await page.evaluate(async()=>{const cache=await caches.open('clubiq-darts-notifications-v1');await cache.put('/__darts_notification_history__',new Response(JSON.stringify(Array.from({length:8},(_,i)=>({title:`Meldung ${i+1}`,body:'Testmeldung',receivedAt:new Date().toISOString()})))));});
    await page.locator('#moreNavigation summary').click();await page.click('#personalSettingsToggle');
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('#notificationHistory article').length===5);assert.equal(await page.locator('#notificationHistory article').last().locator('strong').innerText(),'Meldung 5');assert.equal(await page.locator('#socialPromoBanner').count(),0);assert.equal(await page.locator('#socialLinks a').count(),2);
    await page.selectOption('#myFavoriteTeam','A');assert.equal(await page.inputValue('#favoriteTeam'),'A');assert.match(await page.locator('#myTeamSummary').innerText(),/SV Barver Darts A/);
    for(const input of await page.locator('#pushTeams input').all()) await input.uncheck();
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').check();
    await page.locator('#pushTypes input[value="leg"]').uncheck();
    await page.locator('#preferencesForm button[type="submit"]').click();
    assert.match(await page.locator('#preferencesStatus').innerText(),/Gespeichert/);
    await page.reload();await page.locator('#scheduleDetails').evaluate(n=>n.open=true);
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#moreNavigation summary').click();await page.click('#personalSettingsToggle');
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').waitFor();
    assert.equal(await page.locator('#pushPlayers input[value="Jannik Kläning"]').isChecked(),true);
    assert.equal(await page.inputValue('#myFavoriteTeam'),'A');assert.equal(await page.inputValue('#favoriteTeam'),'A');assert.match(await page.locator('#nextAppointmentsNote').innerText(),/Barver A/);
    assert.equal(await page.locator('#pushTeams input:checked').count(),0);
    assert.equal(await page.locator('#pushTypes input[value="leg"]').isChecked(),false);
    await page.locator('#personalSettings summary').click();
    fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#matchCenterGrid .match-center-card').count(),4);
    assert.match(await page.locator('#liveDataStatus').innerText(),/Letzter Stand/);
    fail=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(300);
    assert.match(await page.locator('#liveDataStatus').innerText(),/aktuell/);
    fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
    for(const theme of ['light','dark']) {
      if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await page.click('#themeToggle');
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(root,`outputs/darts-colors-${theme}-desktop.png`),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} mobile overflow`);
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(root,`outputs/darts-colors-${theme}-mobile.png`),fullPage:true});
      await page.setViewportSize({width:1440,height:1080});
    }
    await page.click('#themeToggle');
    await page.locator('#scheduleDetails').evaluate(n=>n.open=false);await page.screenshot({path:path.join(root,'outputs/darts-home-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile horizontal overflow');
    await page.screenshot({path:path.join(root,'outputs/darts-home-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1080});
    await page.locator('#matchCenterGrid [data-team-code="A"]').first().click();
    await page.locator('.team-group-players').waitFor();
    assert.equal(await page.locator('.team-group-wordmark strong').innerText(),'BARVER A');
    assert.match(await page.locator('.team-group-players').getAttribute('src'),/barver-a-team-20261007\.webp/);
    await page.waitForFunction(()=>{const image=document.querySelector('.team-group-players');return image.complete&&image.naturalWidth>0;});
    await page.locator('.team-group-photo').screenshot({path:path.join(root,'outputs/barver-a-team-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile team photo overflow');
    await page.locator('.team-group-photo').screenshot({path:path.join(root,'outputs/barver-a-team-mobile.png')});
    await page.click('#closeTeamProfile');await page.setViewportSize({width:1440,height:1080});
    await page.locator('#matchCenterGrid [data-team-code="B"]').first().click();
    await page.locator('.team-group-players').waitFor();
    assert.equal(await page.locator('.team-group-players').getAttribute('src'),'/pics/teams/barver-b-team-cutout.webp?v=20260927-2');
    assert.equal(await page.locator('.team-group-wordmark strong').innerText(),'BARVER B');
    assert.equal(await page.locator('.team-group-crest').getAttribute('src'),'/pics/sv-barver-darts-tight-512.webp');
    assert.equal(await page.locator('.player-roster-card').count(),6);
    assert.equal(await page.locator('.player-roster-card img').count(),6);
    await page.getByRole('button',{name:'Kader präsentieren'}).click();
    await page.locator('.darts-roster-slide').waitFor();
    assert.match(await page.locator('.darts-roster-slide').innerText(),/VEREINSKADER/);
    await page.locator('.darts-roster-pause').click();await page.waitForTimeout(400);
    await page.screenshot({path:path.join(root,'outputs/darts-roster-intro.png')});
    await page.keyboard.press('ArrowRight');await page.waitForTimeout(400);
    assert.equal(await page.locator('.darts-roster-player').textContent(),'Patrick Lammers');
    assert.match(await page.locator('.darts-roster-role').innerText(),/Kapitän/);
    await page.screenshot({path:path.join(root,'outputs/darts-roster-player.png')});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile roster overflow');
    await page.setViewportSize({width:1440,height:1080});
    await page.keyboard.press('Escape');assert.equal(await page.locator('.darts-roster-slide').count(),0);
    await page.locator('#matchCenterGrid [data-team-code="B"]').first().click();
    await page.locator('.player-roster-card').first().waitFor();
    await page.getByRole('button',{name:'Patrick Lammers, Profil öffnen'}).click();
    await page.getByText('95K von Aspinall',{exact:true}).waitFor();
    assert.match(await page.locator('#playerProfile').innerText(),/D16/);
    assert.match(await page.locator('#playerProfile').innerText(),/Rechtshänder/);
    assert.match(await page.locator('#playerProfile').innerText(),/Lieblingsfinish/i);
    assert.doesNotMatch(await page.locator('#playerProfile').innerText(),/Lieblingsdoppel/i);
    assert.match(await page.locator('#playerProfile').innerText(),/Journey/);
    await page.locator('#playerDialog #closePlayerProfile').click();
    await page.locator('#moreNavigation summary').click();await page.click('#membersView');
    await page.getByText('Erika Beispiel',{exact:true}).waitFor();
    assert.match(await page.locator('#membersPanel').innerText(),/Vereinsmitglied/);
    assert.match(await page.locator('#membersPanel').innerText(),/Patrick Lammers/);
    await page.screenshot({path:path.join(root,'outputs/darts-members-desktop.png'),fullPage:true});
    await page.screenshot({path:path.join(root,'outputs/peddy-personal.png'),fullPage:true});
    await page.evaluate(()=>{window.DartsBroadcast.configure({enabled:true,tv:true});window.DartsBroadcast.ingest([
      {type:'180',matchId:9009,team:'SV Barver Darts A',player:'Demo-Spieler',count:1,value:180},
      {type:'high_finish',matchId:9009,team:'SV Barver Darts A',player:'Demo-Spieler',count:1,value:121},
    ]);});
    await page.locator('.darts-broadcast-card.type-180').waitFor();await page.waitForTimeout(400);
    assert.equal(await page.locator('.darts-broadcast-card').count(),1);await page.screenshot({path:path.join(root,'outputs/darts-highlight-demo.png')});
    await page.locator('.darts-broadcast-card.type-high-finish').waitFor();
    assert.equal(await page.locator('.darts-broadcast-card').count(),1);
    await page.locator('.darts-broadcast-card').waitFor({state:'detached'});
    assert.equal(await page.locator('.darts-broadcast').isVisible(),false,'TV backdrop must disappear with highlight');
    const quiet=await context.newPage();
    await quiet.route('**/api/v1/darts/ticker',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({items:matches.map(item=>({...item,kind:item.kind==='live'?'upcoming':item.kind})),updatedAt:now(),stale:false})}));
    await quiet.goto(`${origin}/darts`);
    await quiet.getByText('Barver im Überblick',{exact:true}).waitFor();
    assert.equal(await quiet.locator('#todayGrid').isVisible(),false,'no empty live block');
    assert.equal(await quiet.locator('#homeFilters').evaluate(node=>node.open),false);
    assert.equal(await quiet.locator('#clubEventPoster').getAttribute('href'),'/pics/events/barver-dart-open-2026.webp');
    assert.equal(await quiet.locator('#clubEventImage').getAttribute('loading'),'lazy');
    assert.match(await quiet.locator('.club-training').innerText(),/Dienstag & Donnerstag/);
    assert.match(await quiet.locator('.club-training').innerText(),/19:30 Uhr/);
    assert.equal(await quiet.locator('.match-center .club-training').count(),0,'training has its own section');
    await quiet.locator('#sponsorInline .sponsor-banner').waitFor();
    assert.equal(await quiet.locator('.home-schedule-panel #sponsorInline').count(),1,'inline sponsor belongs below the schedule, not beside the top sponsor');
    assert.equal(await quiet.locator('#sponsorTop').isVisible(),true);
    assert.equal(await quiet.locator('#sponsorInline').evaluate(node=>node.previousElementSibling.id), 'scheduleDetails');
    await quiet.locator('#clubEventPoster').click();
    assert.equal(await quiet.locator('#clubPosterDialog').evaluate(node=>node.open),true);
    assert.match(await quiet.locator('#clubPosterFull').getAttribute('src'),/barver-dart-open-2026.webp/);
    await quiet.keyboard.press('Escape');
    assert.equal(await quiet.locator('#clubPosterDialog').evaluate(node=>node.open),false);
    assert.equal(await quiet.evaluate(()=>Boolean(document.querySelector('.match-center').compareDocumentPosition(document.querySelector('#clubEventBanner'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await quiet.setViewportSize({width:390,height:844});
    await quiet.locator('#clubEventImage').scrollIntoViewIfNeeded();
    assert.ok((await quiet.locator('#clubEventImage').boundingBox()).width>=280,'poster readable on mobile');
    assert.ok((await quiet.locator('#clubEventBanner').boundingBox()).height<(await quiet.locator('#clubEventImage').boundingBox()).height+260,'mobile event card must not have empty stretched rows');
    assert.equal(await quiet.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'quiet mobile overflow');
    await quiet.screenshot({path:path.join(root,'outputs/darts-home-quiet-mobile.png'),fullPage:true});
    await quiet.setViewportSize({width:1440,height:1000});
    await quiet.screenshot({path:path.join(root,'outputs/darts-home-quiet-desktop.png'),fullPage:true});
    await quiet.close();
    await page.locator('#moreNavigation summary').click();await page.click('#rankingView');await page.locator('#rankingRows tr').first().waitFor();
    assert.equal(await page.locator('#rankingRows tr').count(),12);assert.match(await page.locator('#rankingPageStatus').innerText(),/1–12 von 22/);await page.click('#rankingNextPage');assert.equal(await page.locator('#rankingRows tr').count(),10);await page.click('[data-ranking-filter=ours]');await page.waitForFunction(()=>document.querySelectorAll('#rankingRows tr').length===1);assert.match(await page.locator('#rankingRows').innerText(),/Jannik Kläning/);assert.match(await page.locator('#rankingRows tr td').first().innerText(),/3/);await page.click('[data-ranking-filter=all]');assert.equal(await page.locator('#rankingRows script').count(),0);
    await page.fill('#rankingSearch','Jannik');assert.equal(await page.locator('#rankingRows tr').count(),1);await page.selectOption('#rankingRound','30458');assert.equal(await page.locator('#rankingRows tr td').last().innerText(),'0');
    assert.equal(await page.locator('#rankingEvents a[href="/turnier?event=30458"]').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.click('#todayView');await page.selectOption('#favoriteTeam','C');assert.match(await page.locator('#homeTeamHeading').innerText(),/Barver Darts C/);assert.match(await page.locator('#homeTeamOverview .result-win').innerText(),/Sieg/);
    await page.selectOption('#favoriteTeam','B');assert.equal(await page.locator('#homeTeamOverview .home-team-rank').innerText(),'3');assert.match(await page.locator('#homeTeamOverview').innerText(),/Teststraße 1/);
    matches[2].kind='final';matches[2].score='8:4';await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.locator('#homeTeamOverview .new-result-badge').waitFor();assert.match(await page.locator('#homeTeamOverview .result-win').innerText(),/Sieg/);
    await page.click('#fullscreen');await page.selectOption('#tvTeamChoice','D');await page.locator('#tvLauncherForm button[type=submit]').click();await page.waitForFunction(()=>document.body.classList.contains('tv-live'));assert.equal(await page.locator('#homeTeamPanel').isVisible(),false);assert.equal(await page.locator('#todayGrid').getAttribute('data-live-count'),'1');await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.body.classList.contains('tv-live'));
    await page.setViewportSize({width:390,height:844});await page.click('[data-mobile-section=teams]');assert.equal(await page.locator('#seasonPanel').isVisible(),true);assert.equal(await page.locator('[data-mobile-section=teams]').getAttribute('aria-pressed'),'true');
    await page.click('[data-mobile-section=league]');assert.equal(await page.locator('#leaguePanel').isVisible(),true);await page.click('[data-mobile-section=more]');assert.equal(await page.locator('#mobileMenuDialog').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#mobileMenuDialog').isVisible(),false);
    await page.click('[data-mobile-section=more]');await page.click('[data-menu-target=joinView]');assert.equal(await page.locator('#joinPanel').isVisible(),true);assert.match(await page.locator('#joinAddress').innerText(),/Teststraße 1/);assert.match(await page.locator('#joinRoute').getAttribute('href'),/Teststra/);assert.match(await page.locator('#joinPanel .primary-action').getAttribute('href'),/mailto:allgemein@sportverein-barver.de/);
    await page.click('[data-mobile-section=more]');await page.click('[data-menu-target=rankingView]');assert.equal(await page.locator('#rankingPanel').isVisible(),true);assert.equal(await page.locator('#rankingEvents details[open]').count(),0);await page.locator('#rankingEvents summary').first().click();assert.equal(await page.locator('#rankingEvents details[open]').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'ranking mobile overflow');
    assert.match(page.url(),/view=ranking/);await page.reload();await page.locator('#rankingRows tr').first().waitFor();assert.equal(await page.locator('#rankingPanel').isVisible(),true);await page.click('[data-mobile-section=today]');assert.equal(await page.inputValue('#favoriteTeam'),'B');assert.equal(await page.locator('#homeTeamPanel').isVisible(),true);await page.click('#joinTeaserButton');assert.equal(await page.locator('#joinPanel').isVisible(),true);
    await page.click('[data-mobile-section=today]');await page.locator('#tvTeaserHeading').getByText('Testturnier · Runde 2',{exact:true}).waitFor();await page.click('#tvTeaserButton');assert.equal(await page.locator('#tvSchedulePanel').isVisible(),true);assert.equal(await page.locator('.tv-schedule-card').count(),1);assert.match(await page.locator('.tv-schedule-card').innerText(),/SPORT1 · Livestream/);assert.equal(await page.locator('.tv-schedule-card a').getAttribute('href'),'https://www.sport1.de/tv-video/stream/test__1');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'TV service mobile overflow');assert.match(page.url(),/view=tv/);await page.reload();await page.locator('.tv-schedule-card').waitFor();assert.equal(await page.locator('#tvSchedulePanel').isVisible(),true);
    tvEmpty=true;await page.click('#reloadTvSchedule');await page.locator('.tv-schedule-empty').waitFor();assert.match(await page.locator('.tv-schedule-empty').innerText(),/keinen weiteren/);assert.equal(await page.locator('.tv-schedule-card').count(),0);tvEmpty=false;await page.click('#reloadTvSchedule');await page.locator('.tv-schedule-card').waitFor();fail=true;await page.click('#reloadTvSchedule');await page.waitForFunction(()=>!document.querySelector('#reloadTvSchedule').disabled);assert.match(await page.locator('#tvScheduleStatus').innerText(),/zuletzt geprüfte/);assert.equal(await page.locator('.tv-schedule-card').count(),1);fail=false;
    await page.screenshot({path:path.join(root,'outputs/darts-tv-service-mobile.png')});await page.click('[data-mobile-section=more]');await page.click('[data-menu-target=tvScheduleView]');assert.equal(await page.locator('#tvSchedulePanel').isVisible(),true);
    await page.click('[data-mobile-section=more]');await page.click('[data-menu-target=fullscreen]');assert.equal(await page.locator('#tvLauncher').isVisible(),true);await page.locator('input[name=tvType][value=tournament]').check();assert.equal(await page.locator('#tvTournamentField').isVisible(),true);await page.selectOption('#tvTournamentChoice','30458');await page.locator('#tvLauncherForm button[type=submit]').click();await page.waitForURL('**/turnier?tv=1&event=30458');await page.getByRole('heading',{name:'DBD 9. Runde',exact:true}).waitFor();assert.equal(await page.locator('body').evaluate(n=>n.classList.contains('tv')),true);
    await page.goto(`${origin}/darts`);await page.click('[data-mobile-section=today]');await page.selectOption('#favoriteTeam','all');
    fail=true;fallbackEnabled=true;await page.reload();
    await page.getByText('Alternative 3K-Verbindung aktiv',{exact:true}).waitFor();
    assert.match(await page.locator('#todayGrid').innerText(),/121/);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clubiq_darts_last_ticker')).items.find(m=>m.id===901).score),'8:3','stale server live state must not overwrite the independent fresh source');
    assert.equal((await page.evaluate(()=>localStorage.getItem('clubiq_darts_last_ticker'))).includes('private@example.test'),false);
    assert.equal(await page.locator('#matchCenterGrid .match-center-card').count(),4,'season snapshot survives both server failures');
    fail=false;fallbackEnabled=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelector('#liveDataStatus').textContent==='3K-Daten aktuell');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clubiq_darts_last_ticker')).source||null),null,'healthy server replaces browser fallback');
    // The exact reported failure: upcoming match opens despite a failed server report.
    fail=true;fallbackEnabled=true;futureMode=true;await page.reload();
    await page.getByText('Alternative 3K-Verbindung aktiv',{exact:true}).waitFor();
    const nextA=page.locator('#nextAppointmentsList .appointment-card').filter({hasText:'SV Barver Darts A'});
    await nextA.getByRole('button',{name:'Spiel ansehen'}).click();
    await page.locator('#matchDialog').getByText('Direkt von 3K geladen',{exact:true}).waitFor();
    assert.match(await page.locator('#matchHeading').innerText(),/SV Barver Darts A gegen Alternative Gäste/);
    assert.match(await page.locator('#matchDetail').innerText(),/Die Begegnung steht noch bevor/);
    assert.match(await page.locator('#matchDetail').innerText(),/Teststraße 1/);
    assert.equal(await page.locator('#matchDetail .error').count(),0);
    assert.equal(await page.locator('#matchDetail [role=tablist]').count(),0,'no fabricated pre-match statistics');
    assert.equal(await page.locator('#matchDetail .calendar-button').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'upcoming detail mobile overflow');
    await page.click('#closeMatch');
    // Both connections fail: the saved fixture still opens and keeps its real facts.
    fallbackEnabled=false;await page.reload();
    await nextA.getByRole('button',{name:'Spiel ansehen'}).click();
    await page.locator('#matchDetail').getByText('Letzter verfügbarer Spielplan',{exact:true}).waitFor();
    assert.match(await page.locator('#matchHeading').innerText(),/SV Barver Darts A gegen Alternative Gäste/);
    assert.equal(await page.locator('#matchDetail .error').count(),0);
    await page.click('#closeMatch');
    await page.route('**/api/v1/darts/matches/901',async route=>{await new Promise(resolve=>setTimeout(resolve,300));await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({match:matches[0],games:[],reportAvailable:false})}).catch(()=>{});});
    await nextA.getByRole('button',{name:'Spiel ansehen'}).click();await page.click('#closeMatch');
    await page.locator('#nextAppointmentsList .appointment-card').filter({hasText:'SV Barver Darts D'}).getByRole('button',{name:'Spiel ansehen'}).click();
    await page.waitForTimeout(500);
    assert.match(await page.locator('#matchHeading').innerText(),/SV Barver Darts D/,'late response must not replace a different opened fixture');
    await page.click('#closeMatch');
    // A single failed league must recover without blocking its healthy neighbour.
    fail=false;centerFailure=true;fallbackEnabled=true;futureMode=true;
    let releaseCenter;const heldCenter=new Promise(resolve=>{releaseCenter=resolve;});
    const holdCenter=async route=>{await heldCenter;await route.abort().catch(()=>{});};
    await page.route('**/api/v1/darts/center?league=kl04',holdCenter);
    await page.route('**/api/v1/darts/season',holdCenter);
    await page.setViewportSize({width:1440,height:1080});await page.reload();await page.click('#leagueView');
    const kl=page.locator('.league-block[data-league=kl04]'),kk=page.locator('.league-block[data-league=kk11]');
    await kl.getByText('Direkt von 3K geladen',{exact:true}).waitFor();
    releaseCenter();await page.unroute('**/api/v1/darts/center?league=kl04',holdCenter);
    await page.unroute('**/api/v1/darts/season',holdCenter);
    await kk.getByText('3K-Daten aktuell',{exact:true}).waitFor();
    assert.equal(await kl.locator('tbody tr').count(),2);assert.match(await kl.locator('table').innerText(),/5:1/);
    assert.equal(await kl.locator('tbody tr').first().locator('td').first().innerText(),'1','use official placement instead of participant seed');
    assert.match(await kl.locator('[data-role=matches]').innerText(),/Alternative Gäste/);
    assert.equal((await page.evaluate(()=>localStorage.getItem('clubiq_darts_last_centers'))).includes('private@example.test'),false);
    // A failed table refresh keeps the table while a different round still loads.
    centerTableFailure=true;await kl.locator('[data-role=round]').selectOption('124');
    await kl.getByText('Ein Teil der Daten ist gerade nicht erreichbar.',{exact:true}).waitFor();
    assert.equal(await kl.locator('[data-role=round]').inputValue(),'124');
    assert.match(await kl.locator('table caption').innerText(),/letzter verfügbarer Stand/);assert.equal(await kl.locator('tbody tr').count(),2);
    // Reload with both connections down: saved round and standings stay readable.
    fallbackEnabled=false;await page.reload();
    await kl.locator('[data-role=source-status]').filter({hasText:'Letzter verfügbarer Stand'}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-league=kl04] [data-role=reload]').disabled);
    assert.equal(await kl.locator('tbody tr').count(),2);assert.equal(await kl.locator('[data-role=round]').inputValue(),'124');
    assert.doesNotMatch(await kl.innerText(),/wird geladen|werden geladen|Lädt/);
    assert.equal(await kk.locator('tbody tr').count(),1);
    // Old saved participant seeds must disappear even during a complete outage.
    await page.evaluate(()=>{
      const saved=JSON.parse(localStorage.getItem('clubiq_darts_last_centers'));
      for(const data of saved)for(const row of data.standings){delete row.rankSource;row.rank=77;}
      localStorage.setItem('clubiq_darts_last_centers',JSON.stringify(saved));
    });await page.reload();
    await page.waitForFunction(()=>!document.querySelector('[data-league=kl04] [data-role=reload]').disabled);
    assert.equal(await kl.locator('tbody tr').count(),2);
    assert.equal(await kl.locator('tbody tr').first().locator('td').first().innerText(),'–','do not reuse the wrong rank from old snapshots');
    // Without a saved snapshot a failure must end every loading indicator.
    await page.evaluate(()=>localStorage.removeItem('clubiq_darts_last_centers'));await page.reload();
    await kl.getByText('Beide Verbindungen sind gerade nicht erreichbar.',{exact:true}).waitFor();
    assert.doesNotMatch(await kl.innerText(),/wird geladen|werden geladen|Lädt/);assert.equal(await kk.locator('tbody tr').count(),1);
    centerFailure=false;centerTableFailure=false;
    // Independent profile loads, late responses, durable public cache and same-page recovery.
    const playerContext=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'});
    let playerMode='hold',releaseStats;
    const heldStats=new Promise(resolve=>releaseStats=resolve);
    const verifiedStats={statsSchema:1,updatedAt:now(),players:{89027:{average:65.9,gamesPlayed:6,gamesWon:6,legsFor:18,legsAgainst:5,count180:3,statsSource:'3k'},89029:{average:50.1,gamesPlayed:4,statsSource:'3k'}}};
    await playerContext.route('**/api/v1/darts/player-profiles',route=>playerMode==='fail'?route.abort():route.continue());
    await playerContext.route('**/api/v1/darts/player-stats',async route=>{
      if(playerMode==='fail')return route.abort();
      if(playerMode==='hold')await heldStats;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(playerMode==='zero'?{updatedAt:now(),matchesScanned:0,officialLeagues:[],players:{89027:{average:null,gamesPlayed:0},89029:{average:null,gamesPlayed:0}}}:verifiedStats)}).catch(()=>{});
    });
    await playerContext.route('https://backend-ddv.3k-darts.com/**',route=>{
      if(playerMode!=='zero'||!route.request().url().endsWith('/statistics'))return route.abort();
      const rows=route.request().url().includes('/1445/')?[{displayName:'Jannik Kläning',team:{name:'SV Barver Darts A'},scoreTotal:11421,dartsTotal:520,matchesTotal:6,matchesWon:6,count180:3,email:'private@example.test'},{displayName:'Patrick Lammers',team:{name:'SV Barver Darts B'},scoreTotal:5010,dartsTotal:300,matchesTotal:4}]:[];
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(rows)});
    });
    await playerContext.route('https://live.3k-darts.com/**',route=>route.abort());
    const playerPage=await playerContext.newPage();playerPage.on('pageerror',e=>errors.push(e.message));
    await playerPage.goto(`${origin}/darts`);
    await playerPage.locator('#matchCenterGrid [data-team-code="A"]').first().click();
    await playerPage.getByRole('button',{name:'Jannik Kläning, Profil öffnen'}).click();
    await playerPage.locator('#playerProfile .player-profile-visual img').waitFor({timeout:2000});
    assert.match(await playerPage.locator('#playerProfile').innerText(),/Saisonwerte werden geladen/,'profile is usable while statistics are pending');
    await playerPage.click('#closePlayerProfile');
    await playerPage.locator('#matchCenterGrid [data-team-code="B"]').first().click();await playerPage.getByRole('button',{name:'Patrick Lammers, Profil öffnen'}).click();
    await playerPage.getByText('Rechtshänder',{exact:true}).waitFor();
    await playerPage.click('#closePlayerProfile');releaseStats();
    await playerPage.waitForFunction(()=>JSON.parse(localStorage.getItem('clubiq_darts_public_stats_v1')||'null')?.players['89029']?.average===50.1);
    assert.equal(await playerPage.locator('#playerDialog').evaluate(n=>n.open),false,'late data never reopens a closed profile');
    playerMode='zero';await playerPage.evaluate(()=>window.dispatchEvent(new Event('online')));
    await playerPage.locator('#matchCenterGrid [data-team-code="B"]').first().click();await playerPage.getByRole('button',{name:'Patrick Lammers, Profil öffnen'}).click();
    await playerPage.locator('.player-performance-average strong').getByText('50,1',{exact:true}).waitFor();
    await playerPage.waitForFunction(()=>!document.querySelector('.player-data-status button').disabled);
    assert.equal((await playerPage.evaluate(()=>localStorage.getItem('clubiq_darts_public_stats_v1'))).includes('private@example.test'),false);
    playerMode='fail';await playerPage.getByRole('button',{name:'Daten aktualisieren'}).click();
    await playerPage.waitForFunction(()=>!document.querySelector('.player-data-status button').disabled);
    assert.equal(await playerPage.locator('.player-performance-average strong').innerText(),'50,1');
    assert.match(await playerPage.locator('.player-performance-note').innerText(),/letzter gespeicherter Stand/);await playerPage.getByText('Rechtshänder',{exact:true}).waitFor();
    await playerPage.reload();await playerPage.locator('#matchCenterGrid [data-team-code="B"]').first().click();await playerPage.getByRole('button',{name:'Patrick Lammers, Profil öffnen'}).click();
    await playerPage.getByText('Rechtshänder',{exact:true}).waitFor();assert.equal(await playerPage.locator('.player-performance-average strong').innerText(),'50,1','reload during outage retains statistics');
    await playerPage.waitForFunction(()=>!document.querySelector('.player-data-status button').disabled);
    playerMode='good';await playerPage.getByRole('button',{name:'Daten aktualisieren'}).click();
    await playerPage.waitForFunction(()=>!document.querySelector('.player-data-status button').disabled);
    assert.doesNotMatch(await playerPage.locator('.player-performance-note').innerText(),/letzter gespeicherter Stand/);
    await playerPage.setViewportSize({width:390,height:844});assert.equal(await playerPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'player profile mobile overflow');
    await playerPage.screenshot({path:path.join(root,'outputs/darts-player-recovery-mobile.png')});await playerContext.close();
    assert.deepEqual(errors,[]);
    console.log('Browser: homepage, two boards, favorites, filters, saved player/type preferences, reconnect, mobile OK');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
