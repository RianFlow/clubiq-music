// Isolated live fixtures: no upstream calls, device tokens or production writes.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
const dist=path.resolve(__dirname,'../dist');
let phase=0,fail=false,reportPending=true;
const board=(id,name,points,current)=>({id,board:String(id),active:true,finished:false,lastUpdateNs:Date.now()*1e6,currentPlayerIndex:current,teamScoreHome:phase?6:5,teamScoreGuest:4,home:{name,points,legs:2,average:61.5,lastScore:180},guest:{name:'Demo-Gast '+id,points:410,legs:1,average:55.4,lastScore:60}});
const match=()=>({id:901,home:'SV Barver Darts A',away:'Demo-Gäste',barverTeam:'A',kind:phase===2?'final':'live',score:phase===2?'8:4':'4:4',plannedAt:new Date().toISOString()});
const server=http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://localhost').pathname;
  if(p.startsWith('/api/')){
    if(p.endsWith('/matches/901')){if(reportPending)await new Promise(resolve=>setTimeout(resolve,1500));res.writeHead(503,{'Content-Type':'application/json'}).end('{}');return;}
    if(fail){res.writeHead(503,{'Content-Type':'application/json'}).end('{}');return;}
    const data=p.endsWith('/season')?{matches:[match()],teams:[{code:'A',roster:[]}]}:p.endsWith('/live')?{groups:[{groupKey:'901',matches:[board(1,'Jannik Demo',phase===3?80:phase?140:320,phase?1:0),board(2,'Gastspieler Demo',201,1)]}]}:p.endsWith('/player-profiles')?{players:{}}:{items:[]};
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(data));return;
  }
  const file=p==='/'?'index.html':p.slice(1);if(!['index.html','app.js','app.css','crest.webp'].includes(file)){res.writeHead(404).end();return;}
  let body=await fs.readFile(path.join(dist,file));
  if(file==='index.html')body=body.toString().replace('APP-VORSCHAU · Noch keine veröffentlichte Store-App','DEMO · Simulierte Live-Partien für den App-Test');
  res.writeHead(200,{'Content-Type':{'html':'text/html','js':'text/javascript','css':'text/css','webp':'image/webp'}[file.split('.').pop()]}).end(body);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:'Spiele',exact:true}).click();
    await page.locator('main .card').filter({hasText:'SV Barver Darts A'}).first().click();
    const live=page.getByRole('region',{name:'Live-Spielstand'});
    await live.getByText('320',{exact:true}).waitFor();
    assert.equal(await live.locator('.live-board').count(),2,'all parallel boards are visible before report completes');
    assert.equal(await page.locator('.match-summary .score').innerText(),'5:4');
    assert.match(await live.innerText(),/Jannik Demo/);assert.match(await live.innerText(),/Gastspieler Demo/);
    assert.equal(await live.locator('.live-board').first().locator('.throwing').innerText().then(t=>t.includes('Jannik Demo')),true);
    assert.equal(await page.locator('#detail').evaluate(n=>n.scrollWidth<=n.clientWidth),true,'mobile dialog overflow');
    await page.waitForFunction(()=>document.querySelector('.match-report').textContent.includes('nicht erreichbar'));
    assert.equal(await live.locator('.live-board').count(),2,'report failure never clears live points');
    reportPending=false;phase=1;await page.getByRole('button',{name:'Spielstand aktualisieren'}).click();
    await live.getByText('140',{exact:true}).waitFor();
    assert.equal(await page.locator('.match-summary .score').innerText(),'6:4');
    assert.match(await live.locator('.live-board').first().locator('.throwing').innerText(),/Demo-Gast 1/);
    const output=path.resolve(__dirname,'../../outputs');await fs.mkdir(output,{recursive:true});
    await page.screenshot({path:path.join(output,'barver-app-live-phone.png'),fullPage:true});
    phase=3;await live.getByText('80',{exact:true}).waitFor({timeout:20000});
    assert.equal(await live.getByText('140',{exact:true}).count(),0,'open dialog updates on the automatic live timer without a click');
    await page.setViewportSize({width:820,height:1180});
    assert.equal(await page.locator('#detail').evaluate(n=>n.scrollWidth<=n.clientWidth),true,'tablet dialog overflow');
    fail=true;await page.getByRole('button',{name:'Spielstand aktualisieren'}).click();
    await live.getByText(/Live-Verbindung unterbrochen/).waitFor();
    assert.equal(await live.locator('.throwing').count(),0,'stale data never says someone is currently throwing');
    assert.equal(await live.getByText('80',{exact:true}).count(),1,'last known points remain');
    fail=false;phase=2;await page.getByRole('button',{name:'Spielstand aktualisieren'}).click();
    await page.locator('.match-summary').getByText('Endstand',{exact:true}).waitFor();
    assert.equal(await live.locator('.live-board').count(),0,'official finish removes obsolete live boards');
    assert.equal(await page.locator('.match-summary .score').innerText(),'8:4');
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Teams',exact:true}).click();
    await page.getByRole('button',{name:'Barver A',exact:true}).click();
    assert.match(await page.locator('#detailContent').innerText(),/Kader/);
    assert.equal(await live.count(),0,'team dialog is not overwritten by match polling');
    assert.deepEqual(errors,[]);
    console.log('Browser OK: immediate 2-board live view, score updates, current thrower, report failure, reconnect warning, final, mobile/tablet, dialog navigation.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
