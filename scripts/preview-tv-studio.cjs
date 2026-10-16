// Local visual preview: public assets only, no API or database connection.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),preview=path.join(root,'previews/tv-studio');
const pages={'/':'index.html','/tv-preview':'index.html','/tv-studio.css':'tv-studio.css','/tv-studio.js':'tv-studio.js','/watch-qr.svg':'watch-qr.svg'};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  let file=pages[pathname]?path.join(preview,pages[pathname]):null;
  if(!file&&(pathname.startsWith('/pics/')||pathname==='/static/fonts/InterVariable.woff2')){
    const candidate=path.resolve(root,'.'+pathname);
    if(candidate.startsWith(path.join(root,'pics')+path.sep)||candidate===path.join(root,'static/fonts/InterVariable.woff2'))file=candidate;
  }
  if(!file){res.writeHead(404);res.end('Not found');return;}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:data);
  });
});
server.listen(0,'127.0.0.1',()=>console.log(`TV-Vorschau: http://127.0.0.1:${server.address().port}/tv-preview`));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
