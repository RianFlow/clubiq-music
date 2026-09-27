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
const teams=['A','B','C','D'].map((code,i)=>({code,name:`SV Barver Darts ${code}`,league:{name:code==='D'?'Kreisklasse 11':'Kreisligen 04'},record:{},matches:matches.filter(m=>m.barverTeam===code),roster:[{id:89027+i,name:code==='A'?'Jannik Kläning':`Demo-Spieler ${code}`,role:'Kapitän'}]}));
teams[1].roster=[{id:89029,name:'Patrick Lammers',role:'Spieler'}];
let fail=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(p.startsWith('/api/')) {
    if(fail) {res.writeHead(503);res.end('{}');return;}
    let data={};
    if(p.endsWith('/ticker')) data={items:matches,updatedAt:now(),stale:false};
    if(p.endsWith('/season')) data={matches,teams,updatedAt:now(),specialEvents:[{id:500,name:'Bezirkspokal',badge:'POKAL',matchCount:1}]};
    if(p.endsWith('/center')) data={league:{key:url.searchParams.get('league')},updatedAt:now(),barverMatches:matches.filter(m=>m.kind==='live'),pushEvents:matches.filter(m=>m.kind==='live').flatMap(m=>[1,2].map(i=>({type:'live_game',matchId:m.id,homeName:i===1?'Jannik Beispiel':'Spieler Zwei',awayName:`Gast ${i}`,homeRemaining:i===1?320:201,awayRemaining:410,homeLegs:2,awayLegs:1,currentSide:'home'})))};
    if(p.endsWith('/highlights')) data={items:[{type:'180',matchId:904,title:'180! Demo-Spieler C',body:'Barver C · Rückblick',occurredAt:day(-2)}]};
    if(p.endsWith('/config')) data={available:false};
    if(p.endsWith('/status')) data={configured:false};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const file=path.resolve(root,`.${p==='/'||p==='/darts'?'/darts.html':p}`);
  if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,body)=>{
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.json':'application/json','.svg':'image/svg+xml'};
    if(!error&&file.endsWith('darts.html')) body=Buffer.from(body.toString().replace('<main>','<main><p class="message">VORSCHAU · Simulierte Begegnungen, keine echten Spielstände</p>'));
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
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#todayGrid .today-live-game').nth(1).waitFor();
    assert.equal(await page.locator('#matchCenterGrid .match-center-card').count(),4);
    assert.equal(await page.locator('#todayGrid .today-game').count(),1);
    assert.equal(await page.locator('#homeSchedule > section').count(),3);
    await page.selectOption('#favoriteTeam','D');
    assert.match(await page.locator('#todayGrid').innerText(),/BARVER D/);
    await page.selectOption('#homeTeam','D');
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
    await page.locator('#personalSettings summary').click();
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').waitFor();
    for(const input of await page.locator('#pushTeams input').all()) await input.uncheck();
    await page.locator('#pushPlayers input[value="Jannik Kläning"]').check();
    await page.locator('#pushTypes input[value="leg"]').uncheck();
    await page.locator('#preferencesForm button[type="submit"]').click();
    assert.match(await page.locator('#preferencesStatus').innerText(),/Gespeichert/);
    await page.reload();
    await page.locator('#homeSchedule .team-profile-match').first().waitFor();
    await page.locator('#personalSettings summary').click();
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
    assert.equal(await page.locator('.team-group-crest').getAttribute('src'),'/pics/sv-barver-darts-tight.png');
    assert.equal(await page.locator('.player-roster-card').count(),6);
    assert.equal(await page.locator('.player-roster-card img').count(),6);
    await page.getByRole('button',{name:'Patrick Lammers, Spielerprofil öffnen'}).click();
    await page.getByText('95K von Aspinall',{exact:true}).waitFor();
    assert.match(await page.locator('#playerProfile').innerText(),/D16/);
    assert.match(await page.locator('#playerProfile').innerText(),/Lieblingsfinish/i);
    assert.doesNotMatch(await page.locator('#playerProfile').innerText(),/Lieblingsdoppel/i);
    assert.match(await page.locator('#playerProfile').innerText(),/Journey/);
    await page.screenshot({path:path.join(root,'outputs/peddy-personal.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Browser: homepage, two boards, favorites, filters, saved player/type preferences, reconnect, mobile OK');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
