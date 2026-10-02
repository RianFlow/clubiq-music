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
const teams=['A','B','C','D'].map((code,i)=>({code,name:`SV Barver Darts ${code}`,league:{name:code==='D'?'Kreisklasse 11':'Kreisligen 04'},record:{},matches:matches.filter(m=>m.barverTeam===code),roster:[{id:89027+i,name:code==='A'?'Jannik Kläning':`Demo-Spieler ${code}`,role:'Kapitän'}]}));
teams[1].roster=[{id:89029,name:'Patrick Lammers',role:'Kapitän'}];
let fail=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(p.startsWith('/api/')) {
    if(fail) {res.writeHead(503);res.end('{}');return;}
    let data={};
    if(p==='/api/v1/darts/presence') data={online:7,windowSeconds:120,demo:true};
    if(p.endsWith('/ticker')) data={items:matches,updatedAt:now(),stale:false};
    if(p.endsWith('/season')) data={matches,teams,updatedAt:now(),specialEvents:[{id:500,name:'Bezirkspokal',badge:'POKAL',matchCount:1}]};
    if(p.endsWith('/center')) data={league:{key:url.searchParams.get('league')},updatedAt:now(),barverMatches:matches.filter(m=>m.kind==='live'),pushEvents:matches.filter(m=>m.kind==='live').flatMap(m=>[1,2].map(i=>({type:'live_game',matchId:m.id,homeName:i===1?'Jannik Beispiel':'Spieler Zwei',awayName:`Gast ${i}`,homeRemaining:i===1?320:201,awayRemaining:410,homeLegs:2,awayLegs:1,currentSide:'home'})))};
    if(p.endsWith('/highlights')) data={items:[{type:'180',matchId:904,title:'180! Demo-Spieler C',body:'Barver C · Rückblick',occurredAt:day(-2)}]};
    if(p.endsWith('/config')) data={available:false};
    if(p.endsWith('/status')) data={configured:false};
    if(p.endsWith('/members')) data={members:['Patrick Lammers','Erika Beispiel']};
    if(p==='/api/v1/darts/events') data={events:[{id:1,title:'11. Barver Dart Open',description:'Einzel und Doppel in Barver',image:'/pics/events/barver-dart-open-2026.webp',active:true,priority:100},{id:2,title:'Vereinsabend',description:'Zweite Veranstaltung',active:true},{id:3,title:'Entwurf',active:false}]};
    if(p==='/api/v1/darts/social-links') data={links:[{id:1,platform:'whatsapp',label:'WhatsApp-Kanal',href:'https://whatsapp.com/channel/0029Vb1TkYQ5K3zONLbu0C0l',active:true}]};
    if(p.endsWith('/player-profiles')) data=JSON.parse(fs.readFileSync(path.join(root,'static/darts-players.json'),'utf8'));
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const file=path.resolve(root,`.${p==='/'||p==='/darts'?'/darts.html':p}`);
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
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${origin}/darts`);
    await page.getByText('7 online · Demo',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:/Voting/i}).count(),0);
    assert.equal(await page.locator('.personal-settings #pushToggle').count(),1);
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#clubEventTitle').getByText('11. Barver Dart Open',{exact:true}).waitFor();
    await page.click('#nextClubEvent');assert.equal(await page.locator('#clubEventTitle').textContent(),'Vereinsabend');
    await page.click('#previousClubEvent');assert.equal(await page.locator('#clubEventCount').innerText(),'1 / 2');
    await page.locator('#socialLinksList a').waitFor();assert.match(await page.locator('#socialLinksList a').getAttribute('href'),/whatsapp.com\/channel/);
    await page.locator('#todayGrid .today-live-game').nth(1).waitFor();
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
    await page.locator('#moreNavigation summary').click();await page.click('#personalSettingsToggle');
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').waitFor();
    for(const input of await page.locator('#pushTeams input').all()) await input.uncheck();
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').check();
    await page.locator('#pushTypes input[value="leg"]').uncheck();
    await page.locator('#preferencesForm button[type="submit"]').click();
    assert.match(await page.locator('#preferencesStatus').innerText(),/Gespeichert/);
    await page.reload();
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#moreNavigation summary').click();await page.click('#personalSettingsToggle');
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').waitFor();
    assert.equal(await page.locator('#pushPlayers input[value="Jannik Kläning"]').isChecked(),true);
    assert.equal(await page.locator('#pushTeams input:checked').count(),0);
    assert.equal(await page.locator('#pushTypes input[value="leg"]').isChecked(),false);
    await page.locator('#personalSettings summary').click();
    fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#matchCenterGrid .match-center-card').count(),4);
    assert.match(await page.locator('#liveDataStatus').innerText(),/erneuert/);
    fail=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(300);
    assert.match(await page.locator('#liveDataStatus').innerText(),/aktuell/);
    fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
    await page.screenshot({path:path.join(root,'outputs/darts-home-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile horizontal overflow');
    await page.screenshot({path:path.join(root,'outputs/darts-home-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1080});
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
    await quiet.locator('#clubEventPoster').click();
    assert.equal(await quiet.locator('#clubPosterDialog').evaluate(node=>node.open),true);
    assert.match(await quiet.locator('#clubPosterFull').getAttribute('src'),/barver-dart-open-2026.webp/);
    await quiet.keyboard.press('Escape');
    assert.equal(await quiet.locator('#clubPosterDialog').evaluate(node=>node.open),false);
    assert.equal(await quiet.evaluate(()=>Boolean(document.querySelector('.match-center').compareDocumentPosition(document.querySelector('#clubEventBanner'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await quiet.setViewportSize({width:390,height:844});
    await quiet.locator('#clubEventImage').scrollIntoViewIfNeeded();
    assert.ok((await quiet.locator('#clubEventImage').boundingBox()).width>=280,'poster readable on mobile');
    assert.ok((await quiet.locator('#clubEventBanner').boundingBox()).height<650,'mobile event card must not have empty stretched rows');
    assert.equal(await quiet.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'quiet mobile overflow');
    await quiet.screenshot({path:path.join(root,'outputs/darts-home-quiet-mobile.png'),fullPage:true});
    await quiet.setViewportSize({width:1440,height:1000});
    await quiet.screenshot({path:path.join(root,'outputs/darts-home-quiet-desktop.png'),fullPage:true});
    await quiet.close();
    assert.deepEqual(errors,[]);
    console.log('Browser: homepage, two boards, favorites, filters, saved player/type preferences, reconnect, mobile OK');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
