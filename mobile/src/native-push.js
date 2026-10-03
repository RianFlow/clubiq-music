// Native transport is deliberately not enabled until a server-side APNs/FCM
// registration and delivery service is configured. Never confuse permission with delivery.
export function createNativePush({plugin,transport,onReceived,onOpen,onStatus,platform}){
  let ready=false,handles=[],token=null;
  async function prepare(){
    if(ready)return;
    handles.push(await plugin.addListener('registration',async result=>{
      token=result.value;
      try{await transport.subscribe({platform,token});onStatus('active');}catch(_){onStatus('registration_failed');}
    }));
    handles.push(await plugin.addListener('registrationError',()=>onStatus('registration_failed')));
    handles.push(await plugin.addListener('pushNotificationReceived',onReceived));
    handles.push(await plugin.addListener('pushNotificationActionPerformed',action=>onOpen(action.notification)));
    ready=true;
  }
  return {
    async enable(){
      if(!transport?.configured)throw new Error('Native Pushzustellung ist noch nicht eingerichtet.');
      await prepare();
      let permission=await plugin.checkPermissions();
      if(['prompt','prompt-with-rationale'].includes(permission.receive))permission=await plugin.requestPermissions();
      if(permission.receive!=='granted'){onStatus('denied');return;}
      if(platform==='android')await plugin.createChannel({id:'barver-sport',name:'Barver Darts',description:'Spielstände und Highlights',importance:4,visibility:1,vibration:true});
      onStatus('registering');await plugin.register();
    },
    async disable(){if(token)await transport.unsubscribe({platform,token});await plugin.unregister();token=null;onStatus('off');},
    async dispose(){for(const handle of handles)await handle.remove();handles=[];ready=false;}
  };
}
