import {build} from 'esbuild';
import {mkdir,copyFile,access,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(root+'dist',{recursive:true});
const firebaseConfigured=await access(root+'android/app/google-services.json').then(()=>true,()=>false);
if(firebaseConfigured){
  const config=JSON.parse(await readFile(root+'android/app/google-services.json','utf8'));
  if(config.private_key||!config.project_info?.project_id||!(config.client||[]).some(client=>client.client_info?.android_client_info?.package_name==='party.clubiq.barverdarts'))throw new Error('Firebase-Datei muss die öffentliche Android-App-Konfiguration für party.clubiq.barverdarts sein; keine privaten Server-Schlüssel verwenden.');
}
await build({entryPoints:[root+'src/app.js'],bundle:true,outfile:root+'dist/app.js',minify:true,platform:'browser',target:['safari16','chrome110'],define:{__ANDROID_FIREBASE_CONFIGURED__:JSON.stringify(firebaseConfigured)}});
for(const file of ['index.html','app.css']) await copyFile(root+'src/'+file,root+'dist/'+file);
await copyFile(root+'../pics/sv-barver-darts-tight-512.webp',root+'dist/crest.webp');
console.log('Öffentliche App-Oberfläche gebaut; keine Verwaltungsdateien enthalten.');
