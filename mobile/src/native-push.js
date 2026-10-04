// Gate native registration on configured server delivery. Permission is not delivery.
export function createNativePush({plugin,transport,onReceived,onOpen,onStatus,platform,initialToken=null}){
  let ready=false,handles=[],token=initialToken,enabled=false,generation=0;
  async function prepare(){
    if(ready)return;
    handles.push(await plugin.addListener('registration',async result=>{
      if(!enabled)return;
      const current=generation;
      token=result.value;
      try{await transport.subscribe({platform,token});if(enabled&&current===generation)onStatus('active');else await transport.unsubscribe({platform,token:result.value});}catch(_){if(enabled&&current===generation)onStatus('registration_failed');}
    }));
    handles.push(await plugin.addListener('registrationError',()=>{if(enabled)onStatus('registration_failed');}));
    handles.push(await plugin.addListener('pushNotificationReceived',n=>{if(enabled)onReceived(n);}));
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
      enabled=true;generation++;
      if(platform==='android')await plugin.createChannel({id:'barver-sport',name:'Barver Darts',description:'Spielstände und Highlights',importance:4,visibility:1,vibration:true});
      onStatus('registering');try{await plugin.register();}catch(error){onStatus('registration_failed');throw error;}
    },
    async sync(){if(!enabled||!token)return;const current=generation;try{await transport.subscribe({platform,token});if(enabled&&current===generation)onStatus('active');}catch(_){if(enabled&&current===generation)onStatus('registration_failed');}},
    async test(){if(!enabled||!token)throw new Error('Bitte zuerst Pushmeldungen aktivieren.');await transport.test({platform,token});},
    async disable(){enabled=false;generation++;if(token)await transport.unsubscribe({platform,token});await plugin.unregister();token=null;onStatus('off');},
    async dispose(){for(const handle of handles)await handle.remove();handles=[];ready=false;}
  };
}
