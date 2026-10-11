// Local fixtures only: delayed profiles, versioned photos and missing-image fallback.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
const dist=path.resolve(__dirname,'../web-dist'),errors=[];
let releaseProfiles,profilesReady=new Promise(resolve=>releaseProfiles=resolve),photoVersion='12';
const profiles=()=>({players:{'1':{name:'Demo Kapitän',team:'D',image:'/api/v1/darts/players/1/photo?v='+photoVersion,alias:'Treffer',personal:{throwingHand:'right',weightGrams:23}},'2':{name:'Demo Gast',team:'D',image:'/api/v1/darts/players/2/photo?v=9'}}});
const season={teams:[{id:100,code:'D',name:'SV Barver Darts D',league:{key:'demo',name:'Demo-Liga'},rank:2,venue:{name:'Vereinshaus',street:'Dartweg 1',city:'Barver'},roster:[{id:1,name:'Demo Kapitän',role:'Kapitän'},{id:2,name:'Demo Gast',role:'Spieler'},{id:3,name:'Ohne Foto',role:'Spieler'}]}],matches:[],leagues:[{league:{key:'demo',name:'Demo-Liga'},standings:[{id:100,name:'SV Barver Darts D',rank:2,pointsFor:5,pointsAgainst:1,played:3,barver:true}]}]};
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    for(const width of [320,390,1280]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      // Serve every request from local fixtures; nothing reaches production.
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());if(url.hostname!=='barverdarts.clubiq.party')return route.abort();assert.equal(route.request().method(),'GET');
        if(url.pathname==='/api/v1/darts/players/1/photo')return route.fulfill({status:200,contentType:'image/webp',body:await fs.readFile(path.join(dist,'crest.webp'))});
        if(url.pathname==='/api/v1/darts/players/2/photo')return route.fulfill({status:404,body:''});
        if(url.pathname.startsWith('/api/')){if(url.pathname.endsWith('/player-profiles'))await profilesReady;const body=url.pathname.endsWith('/season')?season:url.pathname.endsWith('/player-profiles')?profiles():url.pathname.endsWith('/live')?{groups:[]}:url.pathname.endsWith('/trainings')?{events:[]}:{available:false,items:[]};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});}
        const name=url.pathname.slice(5)||'index.html',type={html:'text/html',js:'text/javascript',css:'text/css',webp:'image/webp',png:'image/png',webmanifest:'application/manifest+json'}[name.split('.').pop()];return route.fulfill({status:200,contentType:type,body:await fs.readFile(path.join(dist,name))});
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://barverdarts.clubiq.party/app/',{waitUntil:'domcontentloaded'});
      await page.getByRole('button',{name:'Teams',exact:true}).click();await page.locator('main .team-compact').filter({hasText:'Barver D'}).filter({hasText:'Demo-Liga'}).click({timeout:10000}).catch(async e=>{console.error(JSON.stringify({main:await page.locator('main').innerText(),errors}));throw e;});
      await page.getByRole('button',{name:'Demo Kapitän, Profil öffnen',exact:true}).waitFor();
      assert.equal(await page.locator('#detail details[data-panel="roster-D"]').evaluate(n=>n.open),true);
      assert.match(await page.locator('.team-metrics').innerText(),/5:1/);assert.match(await page.locator('#detail').innerText(),/Vereinshaus/);
      await page.getByRole('button',{name:'Demo Kapitän, Profil öffnen',exact:true}).click();
      releaseProfiles();await page.waitForFunction(()=>document.querySelector('.player-photo')?.src.includes('/players/1/photo?v=12')&&document.querySelector('.player-photo').complete,{},{timeout:10000}).catch(async e=>{console.error(JSON.stringify({width,dialog:await page.locator('#detail').innerText(),images:await page.locator('#detail img').evaluateAll(nodes=>nodes.map(n=>({src:n.src,complete:n.complete,width:n.naturalWidth}))),errors}));throw e;});
      assert.match(await page.locator('#detail').innerText(),/Rechtshänder/);assert.match(await page.locator('#detail').innerText(),/23 g/);
      photoVersion='13';await page.getByRole('button',{name:'Profil aktualisieren',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.player-photo')?.src.includes('/photo?v=13')&&document.querySelector('.player-photo').naturalWidth>0);
      await page.getByRole('button',{name:'‹ Zurück zum Team',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-member-id="2"] img')?.src.endsWith('/crest.webp'));
      assert.equal(await page.locator('#detail .member img').count(),3);
      assert.equal(await page.locator('[data-member-id="3"] img').getAttribute('alt'),'SV Barver Darts');
      for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await page.locator('#detail').evaluate(n=>n.scrollWidth<=n.clientWidth),true,'team dialog fits '+width+' '+theme);}
      await page.getByRole('button',{name:'Demo Gast, Profil öffnen',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.player-photo')?.src.endsWith('/crest.webp')&&document.querySelector('.player-photo').naturalWidth>0);
      await page.getByRole('button',{name:'‹ Zurück zum Team',exact:true}).click();await page.locator('details[data-panel="roster-D"] summary').click();
      await page.getByRole('button',{name:'Mannschaft aktualisieren',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
      assert.equal(await page.locator('details[data-panel="roster-D"]').evaluate(n=>n.open),false,'refresh preserves collapsed roster');
      await context.close();photoVersion='12';
    }
    assert.deepEqual(errors,[]);console.log('Team checks passed: delayed profile refresh, versioned images, fallback, player details, back navigation, collapsed-state preservation, phone/desktop in both themes.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);releaseProfiles();process.exitCode=1;});
