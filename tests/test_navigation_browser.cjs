// Optional real-browser regression test: NODE_PATH=<playwright packages> node tests/test_navigation_browser.cjs
// Uses a temporary local server, fake API and a fresh browser profile. Never contacts the Raspberry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const requested = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(error ? 'Not found' : data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}) });
  try {
    const context = await browser.newContext({ viewport:{width:1280,height:900}, serviceWorkers:'block' });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    let mode = 'active';
    let failResults = false;
    const now = Date.now();
    const date = delta => new Date(now + delta).toISOString();
    const closed = {id:1,name:'Letzter Vereinsabend',status:'closed',starts_at:date(-172800000),closes_at:date(-86400000),max_budget:10};
    const active = {id:2,name:'Training am Freitag',status:'active',starts_at:date(-3600000),closes_at:date(3600000),max_budget:10};
    const planned = {id:3,name:'Nächster Vereinsabend',status:'planned',starts_at:date(86400000),closes_at:date(90000000),max_budget:10};
    const song = (id,title,artist,points=0) => ({suggestion_id:id,rank:id,title,channel_title:artist,external_id:String(id).repeat(11),provider:'youtube',total_points:10,my_points:points,thumbnail_url:'/pics/logo.png'});
    const songs = [song(1,'The Final Countdown','Europe',2),song(2,'Über den Wolken','Reinhard Mey')];
    const oldSongs = [song(3,'Bohemian Rhapsody','Queen'),song(4,'Dancing Queen','ABBA')];
    const member = {member_id:'fixture-dj',display_name:'Test-DJ',can_control_player:true};
    const player = {available:true,queue:[{title:'Aktuelle Musik',artist:'Test',source:'votes'}],current_index:0,current:{title:'Aktuelle Musik',artist:'Test'},duration:200,position:40,volume:70,playing:false,repeat:'off',speaker:{name:'Test-Box',connected:true}};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/music/**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      if (req.method() !== 'GET') writes.push(p);
      let data = {items:[],stations:[],leaders:[]};
      if (p.endsWith('/cycles')) data = {cycles:mode === 'empty' ? [] : mode === 'planned' ? [planned] : mode === 'closed' ? [closed,{...active,status:'closed'},planned] : [active,closed,planned]};
      else if (p.endsWith('/members')) data = {members:['Test-DJ']};
      else if (p.endsWith('/auth/login') || p.endsWith('/auth/me')) data = {token:'fixture-session',member,budget:{maximum:10,remaining:8},active_cycle_id:2};
      else if (p.endsWith('/state')) data = player;
      else if (p.endsWith('/bluetooth/saved')) data = {devices:[]};
      else if (p.endsWith('/previous-playlist')) data = {cycle:closed,songs:oldSongs};
      else if (p.endsWith('/playlist')) {
        if (failResults && p.includes('/cycles/1/')) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Test: kurz nicht erreichbar'})});
        data = {playlist:p.includes('/cycles/1/') ? oldSongs : songs};
      } else if (p.endsWith('/provider/search')) data = {results:[song(5,'Don’t Stop Me Now','Queen')]};
      else if (p.endsWith('/suggestions')) {
        const body = req.postDataJSON();
        songs.push(oldSongs.find(item => item.external_id === body.external_id) || song(5,'Don’t Stop Me Now','Queen'));
        data = {ok:true};
      }
      else if (p.endsWith('/votes')) data = {budget_remaining:7};
      else if (p.includes('/player/queue/cycles/')) data = {...player,playlist_build:{total:2}};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(origin);
    await page.getByRole('heading',{name:'Training am Freitag',exact:true}).waitFor();
    const nav = page.getByRole('navigation',{name:'Musikbereiche'});
    assert.deepEqual(await nav.getByRole('button').allTextContents(), ['Abstimmen','Playlists','Player ✓']);
    assert.equal(await page.locator('#budgetCard').isVisible(),true);
    assert.equal(await page.locator('#cycleSelect').isVisible(),false);
    await nav.getByRole('button',{name:'Playlists',exact:true}).click();
    await page.locator('#resultSongs').getByText('Bohemian Rhapsody',{exact:true}).waitFor();
    assert.equal(await page.locator('#resultSongs [data-vote]').count(),0);
    assert.equal(await page.locator('#budgetCard').isVisible(),false);
    assert.equal(await page.locator('#queueSelectedPlaylist').isVisible(),false);
    assert.equal(await page.locator('#cycleSelect').inputValue(),'1');
    assert.equal(writes.length,0,'browsing must never send player or voting commands');
    await nav.getByRole('button',{name:'Abstimmen',exact:true}).click();
    assert.equal(await page.getByRole('heading',{name:'Training am Freitag',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'+ Song vorschlagen',exact:true}).click();
    assert.equal(await page.locator('#memberDialog').isVisible(),true);
    await page.locator('#loginForm').getByLabel('Name',{exact:true}).fill('Test-DJ');
    await page.locator('#loginForm').getByLabel('PIN',{exact:true}).fill('1234');
    await page.locator('#loginForm').getByRole('button',{name:'Anmelden',exact:true}).click();
    await page.getByRole('button',{name:'Test-DJ · Abmelden',exact:true}).waitFor();
    await page.getByRole('button',{name:'Meine Punkte',exact:false}).click();
    assert.equal(await page.locator('#myVotesView').isVisible(),true);
    assert.equal(await page.locator('#allVotesView').isVisible(),false);
    await page.getByRole('button',{name:'+ Song vorschlagen',exact:true}).click();
    assert.equal(await page.locator('#suggestDialog').isVisible(),true);
    assert.equal(await page.locator('#previousPlaylist').getByText('Bohemian Rhapsody',{exact:true}).isVisible(),true);
    await page.locator('#suggestDialog').getByLabel('Titel oder Interpret',{exact:true}).fill('Queen');
    await page.locator('#searchForm').getByRole('button',{name:'Suchen',exact:true}).click();
    await page.locator('#searchResults').getByRole('button',{name:'Vorschlagen',exact:true}).click();
    await page.locator('#suggestDialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#allVotesView').isVisible(),true);
    assert.equal(await page.locator('#playlist').getByText('Don’t Stop Me Now',{exact:true}).isVisible(),true);
    assert.equal(writes.filter(p => p.endsWith('/suggestions')).at(-1),'/api/v1/music/cycles/2/suggestions');
    await page.getByRole('button',{name:'+ Song vorschlagen',exact:true}).click();
    await page.locator('#previousPlaylist').getByRole('button',{name:'Wieder vorschlagen',exact:true}).first().click();
    await page.locator('#suggestDialog').waitFor({state:'hidden'});
    assert.equal(writes.filter(p => p.endsWith('/suggestions')).length,2,'proposal lock must release after saving');
    await page.locator('#playlist').getByRole('button',{name:'Einen Punkt hinzufügen'}).first().click();
    assert.equal(writes.filter(p => p.endsWith('/votes')).at(-1),'/api/v1/music/cycles/2/votes');
    await nav.getByRole('button',{name:'Playlists',exact:true}).click();
    await page.locator('#resultSongs').getByText('Bohemian Rhapsody',{exact:true}).waitFor();
    await page.getByLabel('In dieser Playlist suchen').fill('ABBA');
    assert.equal(await page.locator('#resultSongs .song-card').count(),1);
    await page.getByLabel('Playlist auswählen',{exact:true}).selectOption('2');
    await page.locator('#resultPhase').getByText('Zwischenstand',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('In dieser Playlist suchen').inputValue(),'');
    assert.equal(await page.locator('#resultSongs [data-vote]').count(),0);
    await page.getByLabel('Playlist auswählen',{exact:true}).selectOption('1');
    await page.getByRole('button',{name:'Diese Playlist in den Player laden',exact:true}).click();
    await page.locator('#queueConfirmDialog').getByRole('button',{name:'Abbrechen',exact:true}).click();
    assert.equal(writes.filter(p => p.includes('/player/queue/')).length,0);
    await page.getByRole('button',{name:'Diese Playlist in den Player laden',exact:true}).click();
    await page.locator('#queueConfirmDialog').getByRole('button',{name:'Playlist ersetzen',exact:true}).click();
    await page.locator('#tab-player').waitFor({state:'visible'});
    assert.equal(writes.filter(p => p.includes('/player/queue/')).at(-1),'/api/v1/music/player/queue/cycles/1');
    assert.equal(await page.locator('#budgetCard').isVisible(),false);
    await page.getByRole('button',{name:'Playlist auswählen',exact:true}).click();
    await page.locator('#resultSongs').getByText('Bohemian Rhapsody',{exact:true}).waitFor();
    failResults = true;
    await page.locator('#refreshResults').click();
    await page.locator('#resultSongs').getByText(/Test: kurz nicht erreichbar/).waitFor();
    assert.equal(await page.locator('#resultSongs .song-card').count(),0,'never label stale data as a new result');
    failResults = false;
    await page.locator('#refreshResults').click();
    await page.locator('#resultSongs').getByText('Bohemian Rhapsody',{exact:true}).waitFor();
    await page.locator('#toast.show').waitFor({state:'hidden'});
    if (process.env.NAV_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.NAV_SCREENSHOT_DIR,'music-playlists-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,'mobile playlist must not overflow horizontally');
    const brand = await page.locator('.topbar .brand').boundingBox();
    const actions = await page.locator('.top-actions').boundingBox();
    assert.ok(brand.x + brand.width <= actions.x, 'mobile brand never overlaps account actions');
    await nav.getByRole('button',{name:'Abstimmen',exact:true}).click();
    if (process.env.NAV_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.NAV_SCREENSHOT_DIR,'music-voting-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,'mobile voting must not overflow horizontally');
    await page.getByRole('button',{name:'+ Song vorschlagen',exact:true}).click();
    if (process.env.NAV_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.NAV_SCREENSHOT_DIR,'music-suggest-mobile.png')});
    assert.equal(await page.locator('#suggestDialog').evaluate(el => el.scrollWidth <= el.clientWidth),true,'suggestion dialog fits mobile');
    await page.getByRole('button',{name:'Songvorschläge schließen'}).click();
    mode = 'closed';
    await page.locator('#refreshPlaylist').click();
    await page.getByRole('heading',{name:'Nächster Vereinsabend',exact:true}).waitFor();
    assert.equal(await page.locator('#openSuggest').isDisabled(),true);
    assert.equal(await page.locator('#budgetCard').isVisible(),false);
    await page.getByRole('button',{name:'Zu den Playlists'}).click();
    await page.getByRole('heading',{name:'Training am Freitag',exact:true}).waitFor();
    assert.equal(await page.locator('#resultPhase').textContent(),'Abgeschlossen');
    for (const scenario of ['empty','planned']) {
      mode = scenario;
      await page.locator('#refreshResults').click();
      await page.getByRole('heading',{name:'Noch keine Playlist',exact:true}).waitFor();
      assert.equal(await page.locator('#queueSelectedPlaylist').isDisabled(),true);
      assert.equal(await page.locator('#cycleSelect').isDisabled(),true);
    }
    assert.deepEqual(errors,[]);
    console.log('Browser navigation OK: independent voting/results, suggestion dialog, role gates, queue confirmation, mobile layout, expiry, empty and planned states.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; }).finally(() => server.close());
