// Isolated local preview. No database, credentials or music-player connection.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const files = {'/darts':'darts.html','/static/darts.js':'static/darts.js','/static/darts.css':'static/darts.css','/pics/logo.png':'pics/logo.png'};
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server = http.createServer((req,res)=>{
  const file = files[new URL(req.url,'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type',mime[path.extname(file)]);
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https://portal.3k-darts.com https://live.3k-darts.com; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control','no-store');
  fs.createReadStream(path.join(root,file)).pipe(res);
});
server.listen(0,'127.0.0.1',()=>console.log(`Darts preview: http://127.0.0.1:${server.address().port}/darts`));
