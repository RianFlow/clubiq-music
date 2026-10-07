import {build} from 'esbuild';
import {mkdir,copyFile,access,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const web=process.argv.includes('--web'),output=root+(web?'web-dist/':'dist/');
const sourceHash=createHash('sha256');
if(web)for(const file of ['scripts/build.mjs','src/app.js','src/training.js','../static/darts-training-source.js','src/app.css','src/index.html','src/web-app.js','src/web-push.js','src/web-sw.js','src/model.js','src/native-push.js','src/push-transport.js','web-icons/icon-192.png','web-icons/icon-512.png','web-icons/apple-touch-icon.png','../pics/sv-barver-darts-tight-512.webp'])sourceHash.update(await readFile(root+file));
const webBuildId=web?sourceHash.digest('hex').slice(0,16):'';
await mkdir(output,{recursive:true});
const firebaseConfigured=!web&&await access(root+'android/app/google-services.json').then(()=>true,()=>false);
if(firebaseConfigured){
  const config=JSON.parse(await readFile(root+'android/app/google-services.json','utf8'));
  if(config.private_key||!config.project_info?.project_id||!(config.client||[]).some(client=>client.client_info?.android_client_info?.package_name==='party.clubiq.barverdarts'))throw new Error('Firebase-Datei muss die öffentliche Android-App-Konfiguration für party.clubiq.barverdarts sein; keine privaten Server-Schlüssel verwenden.');
}
await build({entryPoints:[root+'src/app.js'],bundle:true,outfile:output+'app.js',minify:true,platform:'browser',target:['safari16','chrome110'],define:{__ANDROID_FIREBASE_CONFIGURED__:JSON.stringify(firebaseConfigured),__WEB_APP__:JSON.stringify(web),__WEB_BUILD_ID__:JSON.stringify(webBuildId)}});
for(const file of ['index.html','app.css']) await copyFile(root+'src/'+file,output+file);
await copyFile(root+'../pics/sv-barver-darts-tight-512.webp',output+'crest.webp');
if(web){
  const html=(await readFile(output+'index.html','utf8')).replace('Barver Darts · App-Vorschau','Barver Darts').replace('</head>','<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Barver Darts"><meta name="apple-mobile-web-app-capable" content="yes"></head>').replace(/(app\.js|app\.css|crest\.webp|manifest\.webmanifest|apple-touch-icon\.png)"/g,'$1?v='+webBuildId+'"');await writeFile(output+'index.html',html);
  const manifest={id:'/app/',name:'SV Barver Darts',short_name:'Barver Darts',lang:'de',start_url:'/app/',scope:'/app/',display:'standalone',background_color:'#f6f5f1',theme_color:'#f6f5f1',description:'Spiele, Live-Stände, Teams und Tabellen des SV Barver Darts.',icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'}]};
  for(const icon of manifest.icons)icon.src+='?v='+webBuildId;
  await writeFile(output+'manifest.webmanifest',JSON.stringify(manifest,null,2));
  for(const file of ['icon-192.png','icon-512.png','apple-touch-icon.png'])await copyFile(root+'web-icons/'+file,output+file);
  const hash=createHash('sha256');for(const file of ['index.html','app.js','app.css','manifest.webmanifest','crest.webp','icon-192.png','icon-512.png','apple-touch-icon.png','../src/web-sw.js'])hash.update(await readFile(output+file));
  await writeFile(output+'sw.js',(await readFile(root+'src/web-sw.js','utf8')).replace('__BUILD_VERSION__',hash.digest('hex').slice(0,16)).replace('__ASSET_VERSION__',webBuildId));
}
console.log('Öffentliche App-Oberfläche gebaut; keine Verwaltungsdateien enthalten.');
