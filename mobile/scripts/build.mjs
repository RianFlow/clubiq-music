import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(root+'dist',{recursive:true});
await build({entryPoints:[root+'src/app.js'],bundle:true,outfile:root+'dist/app.js',minify:true,platform:'browser',target:['safari16','chrome110']});
for(const file of ['index.html','app.css']) await copyFile(root+'src/'+file,root+'dist/'+file);
await copyFile(root+'../pics/sv-barver-darts-tight-512.webp',root+'dist/crest.webp');
console.log('Öffentliche App-Oberfläche gebaut; keine Verwaltungsdateien enthalten.');
