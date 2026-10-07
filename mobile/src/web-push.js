// Web subscriptions stay scoped to the compact app's worker. Never reuse the website worker.
export function vapidKey(value){
  const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export function createWebPush({registration,request,selection,onStatus,notifications=globalThis.Notification}){
  let subscription=null,lastSelection='',enabled=false;
  const api={configured:false,supportedEventTypes:[],get enabled(){return enabled;},
    async config(){const result=await request('GET','config');api.previewOnly=result.previewOnly===true;api.configured=result.available===true&&!!result.publicKey;api.publicKey=result.publicKey;api.trainingAvailable=result.trainingAvailable===true;api.supportedEventTypes=result.eventTypes||['180','high_finish','leg','game','match'];return api.configured;},
    async restore(wanted){subscription=await registration.pushManager.getSubscription();enabled=!!subscription&&wanted;if(enabled&&notifications.permission==='granted')await api.sync();else if(wanted)onStatus('denied');else onStatus('off');},
    async enable(){
      if(!api.configured)throw Error('Der Push-Server ist gerade nicht verfügbar.');
      // subscribe is called from the button handler; iOS requires user interaction.
      onStatus('registering');subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidKey(api.publicKey)});
      enabled=true;lastSelection='';await api.sync();
    },
    async sync(){
      if(!enabled||!subscription)return;
      const chosen=selection(),payload={...subscription.toJSON(),...chosen,eventTypes:chosen.eventTypes.filter(t=>api.supportedEventTypes.includes(t))};
      const fingerprint=JSON.stringify(payload);if(fingerprint===lastSelection){onStatus('active');return;}
      try{const result=await request('POST','subscribe',payload);if(result.ok!==true)throw Error('Anmeldung nicht bestätigt.');lastSelection=fingerprint;onStatus('active');}catch(error){onStatus('registration_failed');throw error;}
    },
    async test(){if(!subscription||!enabled)throw Error('Bitte zuerst Pushmeldungen aktivieren.');return request('POST','test',{...subscription.toJSON(),training:selection().training===true});},
    async disable(){
      subscription=subscription||await registration.pushManager.getSubscription();
      if(subscription){await request('POST','unsubscribe',{endpoint:subscription.endpoint});if(await subscription.unsubscribe()===false)throw Error('Abmeldung am Gerät noch nicht bestätigt.');}
      subscription=null;enabled=false;lastSelection='';onStatus('off');
    }
  };return api;
}
