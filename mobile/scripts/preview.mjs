import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
// Read-only proxy for browser previews. Native builds use CapacitorHttp directly.
const paths=new Set(['/api/v1/darts/season','/api/v1/darts/live','/api/v1/darts/highlights','/api/v1/darts/player-profiles']);
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  try {
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(paths.has(url.pathname)||/^\/api\/v1\/darts\/matches\/\d+$/.test(url.pathname)){
      const upstream=await fetch('https://barverdarts.clubiq.party'+url.pathname,{signal:AbortSignal.timeout(45000),redirect:'error'});
      res.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await upstream.text());return;
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','app.js','app.css','crest.webp'].includes(name)){res.writeHead(404).end();return;}
    const types={'html':'text/html','js':'text/javascript','css':'text/css','webp':'image/webp'};
    res.writeHead(200,{'Content-Type':types[name.split('.').pop()]});res.end(await readFile(root+name));
  }catch(_){res.writeHead(503,{'Content-Type':'application/json'}).end('{"detail":"Daten gerade nicht erreichbar"}');}
});
server.listen(0,'127.0.0.1',()=>console.log(`App-Vorschau: http://127.0.0.1:${server.address().port}/ · öffentliche Echt-Daten, keine Schreibzugriffe`));
