const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
 const p=new URL(req.url,'http://localhost').pathname;
 if(p==='/'){
  res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/darts.css"><link rel="stylesheet" href="/static/darts-tv-studio.css"><body class="tv-live app-tv"><button id="themeToggle" hidden></button><div id="todayPanel"><div id="tvTeamControls"><span>Mannschaften</span><button>A</button></div><div id="todayGrid"></div></div><script src="/static/darts-tv-studio.js"></script></body></html>');return;
 }
 const file=path.resolve(root,'.'+p);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(error,body)=>{res.writeHead(error?404:200,{'Content-Type':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.webp')?'image/webp':'image/png'});res.end(error?'Missing':body);});
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.clock.install();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(()=>{
   const now=Date.now(),game=(n)=>({id:n,homeName:'Spieler Barver '+n,awayName:'Gast '+n,homeLegs:3,awayLegs:1,home:{name:'Spieler Barver '+n,count180:n===1?1:0,highFinish:n===2?121:0},away:{name:'Gast '+n}});
   const items=['A','B','C','D'].map((code,i)=>({id:i+1,home:'SV Barver Darts '+code,away:'Gäste '+code,barverTeam:code,kind:i===0?'final':'live',score:i===0?'8:4':'3:2',plannedAt:new Date(now-7200000).toISOString(),...(i===0?{finishedAt:new Date(now).toISOString(),summaryUntil:new Date(now+600000).toISOString(),resultGames:Array.from({length:12},(_,n)=>game(n+1))}:{})}));
   window.testContext={container:document.querySelector('#todayGrid'),selected:['A','B','C','D'],items,openMatch:()=>{},playerNode:name=>{const a=document.createElement('span');a.textContent=name;return a;},models:items.slice(1).map(item=>({item,loaded:true,games:[]}))};DartsTvStudio.render(testContext);
  });
  assert.equal(await page.locator('.studio-team').count(),4);assert.equal(await page.locator('.studio-result-row').count(),12);await page.clock.fastForward(1000);assert.equal(await page.locator('.studio-result-row:visible').count(),4);assert.match(await page.locator('.studio-result-highlights').innerText(),/180.*121/s);assert.equal(await page.locator('.studio-team[data-match-id="1"] .studio-final-score').innerText(),'8:4');
  const out=path.join(root,'outputs/tv-studio-live');fs.mkdirSync(out,{recursive:true});await page.clock.fastForward(5000);const lastRow=await page.locator('.studio-result-row:visible').last().boundingBox(),resultList=await page.locator('.studio-result-list').boundingBox();assert(lastRow.y+lastRow.height<=resultList.y+resultList.height+1,'all four result rows fit in a four-team layout');await page.screenshot({path:path.join(out,'ten-minute-recap.png'),animations:'disabled'});
  const heading=await page.locator('.studio-result-list>strong').innerText();await page.clock.fastForward(8000);assert.notEqual(await page.locator('.studio-result-list>strong').innerText(),heading,'results paginate without another data request');
  await page.clock.fastForward(585000);assert.equal(await page.locator('.studio-result').count(),1,'recap remains for the full ten minutes');await page.clock.fastForward(2000);assert.equal(await page.locator('.studio-result').count(),0,'recap expires while other teams continue');assert.equal(await page.locator('.studio-team').count(),3);
  await page.evaluate(()=>{testContext.selected=['A'];testContext.models=[];testContext.items.push({id:5,home:'SV Barver Darts A',away:'Nächster Gegner',barverTeam:'A',kind:'upcoming',plannedAt:new Date(Date.now()+86400000).toISOString()});DartsTvStudio.render(testContext);});assert.equal(await page.locator('.studio-countdown').count(),1,'next countdown follows the finished summary');assert.equal(await page.locator('.studio-result').count(),0,'refresh never restarts the expired recap');assert.deepEqual(errors,[]);
  console.log('TV recap: fixed ten-minute lifetime, result pages, highlights, concurrent teams and next countdown passed');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
