import {mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),target=root+'../static/barver-app/';
await mkdir(target,{recursive:true});
for(const file of ['index.html','app.js','app.css','crest.webp','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'])await copyFile(root+'web-dist/'+file,target+file);
console.log('Web-App lokal unter static/barver-app bereitgestellt. Kein Upload.');
