import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../web-dist/',import.meta.url));
const files={'index.html':'text/html','app.js':'text/javascript','app.css':'text/css','crest.webp':'image/webp','sw.js':'text/javascript','manifest.webmanifest':'application/manifest+json','icon-192.png':'image/png','icon-512.png':'image/png','apple-touch-icon.png':'image/png'};
const api=new Set(['season','live','highlights','player-profiles','push/config']);
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  try{
    // Preview cannot register production subscriptions or send messages.
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(pathname==='/api/v1/darts/push/config'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({available:false,previewOnly:true,eventTypes:['180','high_finish','leg','game','match','player_start']}));return;}
    if(pathname.startsWith('/api/v1/darts/')){const suffix=pathname.slice('/api/v1/darts/'.length);if(!api.has(suffix)&&!/^matches\/\d+$/.test(suffix)){res.writeHead(404).end();return;}const response=await fetch('https://barverdarts.clubiq.party'+pathname,{redirect:'error',signal:AbortSignal.timeout(45000)});res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(await response.text());return;}
    if(pathname==='/'||pathname==='/app'){res.writeHead(302,{Location:'/app/'}).end();return;}
    const file=pathname==='/app/'?'index.html':pathname.startsWith('/app/')?pathname.slice(5):'';
    if(!files[file]){res.writeHead(404).end();return;}const body=await readFile(root+file);res.writeHead(200,{'Content-Type':files[file],'Cache-Control':'no-cache'}).end(body);
  }catch(_){res.writeHead(503,{'Content-Type':'application/json'}).end('{"detail":"Verbindung gerade nicht verfügbar"}');}
});server.listen(Number(process.env.PORT)||0,'127.0.0.1',()=>console.log(`Web-App-Vorschau: http://127.0.0.1:${server.address().port}/app/ · nur lesend`));
