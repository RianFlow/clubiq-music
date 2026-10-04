import {cp,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await access(root+'android/app/build.gradle');
await cp(root+'android-overrides/res',root+'android/app/src/main/res',{recursive:true});
await copyFile(root+'../pics/sv-barver-darts-tight-512.webp',root+'android/app/src/main/res/drawable/barver_crest.webp');
// Mechanical adjustments to the generated Capacitor template; all source overrides above are versioned.
const manifest=root+'android/app/src/main/AndroidManifest.xml';
let xml=await readFile(manifest,'utf8');
xml=xml.replace(/android:allowBackup="(?:true|false)"/,'android:allowBackup="false"');
if(!xml.includes('android:usesCleartextTraffic='))xml=xml.replace('<application','<application\n        android:usesCleartextTraffic="false"');
// No Firebase token/analytics initialization before the user's explicit consent.
if(!xml.includes('firebase_messaging_auto_init_enabled'))xml=xml.replace('</application>','    <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />\n        <meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />\n    </application>');
await writeFile(manifest,xml);
const gradle=root+'android/app/build.gradle';
let source=await readFile(gradle,'utf8');
source=source.replace(/versionName "[^"]*"/,'versionName "0.1.1-test"').replace(/versionCode \d+/,'versionCode 2');
if(!source.includes('rootProject.file("debug.keystore")'))source=source.replace('    buildTypes {','    signingConfigs {\n        debug { storeFile rootProject.file("debug.keystore") }\n    }\n    buildTypes {');
await writeFile(gradle,source);
const wrapper=root+'android/gradle/wrapper/gradle-wrapper.properties';
let props=await readFile(wrapper,'utf8');
// Gradle 9.1 fixes Windows immutable-workspace locks (gradle/gradle#34369).
props=props.replace(/gradle-[\d.]+-(?:all|bin)\.zip/,'gradle-9.1.0-bin.zip');
const sha='a17ddd85a26b6a7f5ddb71ff8b05fc5104c0202c6e64782429790c933686c806';
if(props.includes('distributionSha256Sum='))props=props.replace(/distributionSha256Sum=[^\r\n]*/,'distributionSha256Sum='+sha);
else props+='\ndistributionSha256Sum='+sha+'\n';
await writeFile(wrapper,props);
console.log('Android-Testversion: Vereinslogo, HTTPS-only, keine Cloud-Sicherung, Version 0.1.1-test.');
