export const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
export const isAppleMobile=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
export async function prepareWebApp({onUpdate,onMessage}){
  if(!('serviceWorker' in navigator)||!window.isSecureContext)return null;
  const registration=await navigator.serviceWorker.register('./sw.js?v='+__WEB_BUILD_ID__,{scope:'./',updateViaCache:'none'});
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)location.reload();});
  const offer=()=>{if(registration.waiting&&registration.active&&registration.waiting!==registration.active)onUpdate(()=>{reloading=true;registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});});};
  offer();registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)offer();});});
  navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='BARVER_APP_PUSH')onMessage(event.data.notification);});
  if(registration.active?.state!=='activated')await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Web-App konnte noch nicht offline gespeichert werden.')),20000);
    const worker=registration.installing||registration.waiting;
    if(!worker){clearTimeout(timer);reject(Error('Web-App-Worker fehlt.'));return;}
    const changed=()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}else if(worker.state==='redundant'){clearTimeout(timer);reject(Error('Web-App-Worker konnte nicht gestartet werden.'));}};
    worker.addEventListener('statechange',changed);changed();
  });
  return registration;
}
export async function webPushRequest(method,path,data){
  if(!['config','subscribe','unsubscribe','test'].includes(path))throw Error('Unbekannte Push-Aktion.');
  const response=await fetch('/api/v1/darts/push/'+path,{method,headers:{Accept:'application/json','Content-Type':'application/json','X-ClubIQ-Push':'1'},...(data?{body:JSON.stringify(data)}:{}),cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(response.status===429?'Bitte kurz warten.':'Push-Server gerade nicht erreichbar.');
  return response.json();
}
