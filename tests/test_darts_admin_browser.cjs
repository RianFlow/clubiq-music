// Local fixture server + real-browser regression. No production writes or 3K calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'); let saved=null,savedSponsor=null,savedEvent=null,savedSocial=null,eventHasImage=false;
const profiles={players:[
  {playerId:89029,alias:'Peddy',published:true,stored:false,image:'/pics/players/patrick-lammers-cutout.webp',personal:{darts:'95K von Aspinall',favoriteFinish:'D16'}},
  {playerId:89017,alias:'',published:false,stored:true,personal:{}},
]};
const season={teams:[{code:'B',roster:[{id:89029,name:'Patrick Lammers',role:'Kapitän'},{id:89017,name:'Justin Albrecht',role:'Spieler'}]}]};
const sponsors={sponsors:[{id:1,name:'Muster Hauptpartner',type:'main',href:'https://example.com/',teams:[],placements:['footer','tv'],eventName:'',eventMatchIds:[],startsAt:null,endsAt:null,priority:100,active:true,hasLogo:false}]};
const events={events:[]},socialLinks={links:[]};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(p.startsWith('/api/')) {
    if((req.headers['x-admin-password']!=='secret'||req.headers['x-admin-username']!=='admin') && p!=='/api/v1/darts/season'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"detail":"Verwaltungskennwort ungültig."}');return;}
    if(p==='/api/v1/darts/admin/verify'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ok"}');return;}
    if(p==='/api/v1/darts/admin/players'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(profiles));return;}
    if(p==='/api/v1/darts/admin/sponsors'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(sponsors));return;}
    if(p==='/api/v1/darts/admin/events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(events));return;}
    if(p==='/api/v1/darts/admin/social-links'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(socialLinks));return;}
    if(p==='/api/v1/darts/admin/events'&&req.method==='POST'){let body='';req.on('data',part=>body+=part);req.on('end',()=>{savedEvent=JSON.parse(body);events.events=[{id:22,title:savedEvent.title,kicker:savedEvent.kicker,description:savedEvent.description,date:savedEvent.date_label,calendarDate:savedEvent.calendar_date,location:savedEvent.location,href:savedEvent.website,buttonLabel:savedEvent.button_label,startsAt:savedEvent.starts_at,endsAt:savedEvent.ends_at,priority:savedEvent.priority,active:savedEvent.active,image:'/api/v1/darts/admin/events/22/image?v=fixture',hasImage:eventHasImage}];res.writeHead(201,{'Content-Type':'application/json'});res.end('{"id":22}');});return;}
    if(p==='/api/v1/darts/admin/events/22/image'&&req.method==='POST'){req.resume();req.on('end',()=>{eventHasImage=true;events.events[0].hasImage=true;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"success"}');});return;}
    if(p==='/api/v1/darts/admin/events/22/image'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'pics/logo.png')));return;}
    if(p==='/api/v1/darts/admin/social-links'&&req.method==='POST'){let body='';req.on('data',part=>body+=part);req.on('end',()=>{savedSocial=JSON.parse(body);socialLinks.links=[{id:31,platform:savedSocial.platform,label:savedSocial.label,href:savedSocial.website,priority:savedSocial.priority,active:savedSocial.active,teaser:savedSocial.teaser,showInBanner:savedSocial.show_in_banner}];res.writeHead(201,{'Content-Type':'application/json'});res.end('{"id":31}');});return;}
    if(p==='/api/v1/darts/season'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(season));return;}
    if(/^\/api\/v1\/darts\/admin\/players\/\d+$/.test(p)&&req.method==='PUT'){
      let body='';req.on('data',part=>body+=part);req.on('end',()=>{saved=JSON.parse(body);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"success"}');});return;
    }
    if(p==='/api/v1/darts/admin/sponsors/1'&&req.method==='PUT'){
      let body='';req.on('data',part=>body+=part);req.on('end',()=>{savedSponsor=JSON.parse(body);Object.assign(sponsors.sponsors[0],{name:savedSponsor.name,type:savedSponsor.sponsor_type,priority:savedSponsor.priority,active:savedSponsor.active,placements:savedSponsor.placements,teams:savedSponsor.teams});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"success","id":1}');});return;
    }
    res.writeHead(404);res.end();return;
  }
  const file=path.resolve(root,`.${p==='/'||p==='/darts-admin'?'/darts-admin.html':p}`);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,body)=>{const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp'};res.writeHead(error?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(error?'Not found':body);});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=require('playwright');
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:'Europe/Berlin'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/darts-admin`);
    await page.fill('#adminUsername','admin');await page.fill('#adminPassword','wrong');await page.click('#loginForm button');await page.getByText('Verwaltungskennwort ungültig.').waitFor();
    await page.fill('#adminUsername','admin');await page.fill('#adminPassword','secret');await page.click('#loginForm button');await page.locator('#playerList').getByText('Patrick Lammers',{exact:true}).waitFor();
    await page.locator('#playerList').getByText('Patrick Lammers',{exact:true}).click();
    assert.equal(await page.inputValue('#alias'),'Peddy');assert.equal(await page.inputValue('#favoriteFinish'),'D16');
    assert.equal(await page.inputValue('#throwingHand'),'');await page.selectOption('#throwingHand','left');await page.fill('#playerNumber','Q8V4');await page.fill('#walkOnSong','Don\'t Stop Believin\' – Journey');await page.check('#published');await page.click('#profileForm button[type="submit"]');
    await page.getByText('Gespeichert und veröffentlicht.').waitFor();assert.equal(saved.player_number,'Q8V4');assert.equal(saved.published,true);assert.equal(saved.throwing_hand,'left');
    await page.click('#sponsorsAdminTab');await page.locator('#sponsorList').getByText('Muster Hauptpartner',{exact:true}).waitFor();await page.locator('#sponsorList').getByText('Muster Hauptpartner',{exact:true}).click();
    assert.equal(await page.inputValue('#sponsorPriority'),'100');assert.equal(await page.isChecked('[data-sponsor-placement][value="tv"]'),true);
    await page.fill('#sponsorPriority','120');await page.click('#sponsorForm button[type="submit"]');await page.getByText('Sponsor gespeichert.').waitFor();assert.equal(savedSponsor.priority,120);assert.equal(savedSponsor.sponsor_type,'main');
    await page.click('#eventsAdminTab');await page.click('#newEvent');await page.fill('#eventCalendarDate','2026-10-24');await page.fill('#eventTitle','Sommerturnier');await page.fill('#eventKicker','SV Barver');await page.fill('#eventDescription','Offenes Dartturnier für alle.');await page.fill('#eventDate','Samstag, 15. August');await page.fill('#eventLocation','Sporthalle Barver');await page.fill('#eventHref','https://example.org/turnier');await page.fill('#eventButtonLabel','Jetzt anmelden');await page.fill('#eventPriority','7');await page.fill('#eventStartsAt','2026-08-15T14:30');await page.fill('#eventEndsAt','2026-08-15T22:00');await page.check('#eventActive');await page.setInputFiles('#eventImage',path.join(root,'pics/logo.png'));await page.getByText(/Banner vorbereitet/).waitFor();await page.click('#eventForm button[type="submit"]');await page.getByText('Veranstaltung gespeichert.').waitFor();assert.equal(savedEvent.title,'Sommerturnier');assert.equal(savedEvent.calendar_date,'2026-10-24');assert.equal(await page.inputValue('#eventCalendarDate'),'2026-10-24');assert.equal(savedEvent.description,'Offenes Dartturnier für alle.');assert.equal(savedEvent.website,'https://example.org/turnier');assert.equal(savedEvent.active,true);assert.equal(savedEvent.starts_at,'2026-08-15T12:30:00.000Z');await page.locator('#eventImagePreview img[src^="blob:"]').waitFor();
    await page.click('#socialAdminTab');await page.click('#newSocial');await page.selectOption('#socialPlatform','instagram');await page.fill('#socialLabel','SV Barver auf Instagram');await page.fill('#socialHref','https://instagram.com/svbarver');await page.fill('#socialPriority','4');await page.fill('#socialTeaser','Neueste Vereinsinfos');assert.equal(await page.isChecked('#socialShowInBanner'),true);assert.equal(await page.locator('#socialForm .social-icon-preview svg').count(),1);await page.click('#socialForm button[type="submit"]');await page.getByText('Link gespeichert.').waitFor();assert.equal(savedSocial.website,'https://instagram.com/svbarver');assert.equal(savedSocial.active,true);assert.equal(savedSocial.teaser,'Neueste Vereinsinfos');assert.equal(savedSocial.show_in_banner,true);
    for(const theme of ['light','dark']) {
      if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await page.click('#adminThemeToggle');
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(root,`outputs/darts-admin-${theme}.png`),fullPage:true});
    }
    await page.screenshot({path:path.join(root,'outputs/darts-admin-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});for(const tab of ['#playersAdminTab','#sponsorsAdminTab','#eventsAdminTab','#socialAdminTab']){await page.click(tab);const mobile=await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth,width:document.documentElement.scrollWidth,viewport:innerWidth,wide:[...document.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(node=>`${node.tagName}.${node.className}`)}));assert.equal(mobile.fits,true,`${tab}: ${JSON.stringify(mobile)}`);}await page.screenshot({path:path.join(root,'outputs/darts-admin-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);console.log('Browser: player, sponsor, event/banner, social admin and mobile tabs OK');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
