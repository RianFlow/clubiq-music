import {API_ORIGIN} from './model.js';
export const NATIVE_PUSH_PATH='/api/v1/darts/push/native/';
export function deviceSecret(cryptoApi=globalThis.crypto){
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
}
// Exact endpoint allowlist: device capabilities never reach any admin route.
export function createPushTransport({request,identity,selection,saveIdentity}){
  return {
    configured:false,supportedEventTypes:[],
    async config(){const result=await request('GET',API_ORIGIN+NATIVE_PUSH_PATH+'config');this.configured=result.available===true;this.trainingAvailable=result.trainingAvailable===true;this.supportedEventTypes=Array.isArray(result.eventTypes)?result.eventTypes:['180','high_finish','leg','game','match'];return this.configured;},
    async subscribe({platform,token}){
      // Persist before transmission so retry/unsubscribe keeps the same ownership key.
      identity.token=token;await saveIdentity(identity);
      const chosen=selection();const eventTypes=chosen.eventTypes.filter(type=>this.supportedEventTypes.includes(type));
      const result=await request('POST',API_ORIGIN+NATIVE_PUSH_PATH+'subscribe',{platform,token,deviceSecret:identity.secret,...chosen,eventTypes});
      if(result.ok!==true)throw new Error('Anmeldung nicht bestätigt');
    },
    async unsubscribe({platform,token}){await request('POST',API_ORIGIN+NATIVE_PUSH_PATH+'unsubscribe',{platform,token,deviceSecret:identity.secret});identity.token=null;await saveIdentity(identity);},
    async test({platform,token}){return request('POST',API_ORIGIN+NATIVE_PUSH_PATH+'test',{platform,token,deviceSecret:identity.secret,training:selection().training===true});},
  };
}
