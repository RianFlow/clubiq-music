import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNativePush} from '../src/native-push.js';
function fixture(configured=true){
  const listeners={},states=[],calls=[];
  const plugin={addListener:async(name,fn)=>{listeners[name]=fn;return{remove:async()=>{}};},checkPermissions:async()=>({receive:'prompt'}),requestPermissions:async()=>({receive:'granted'}),register:async()=>{calls.push('register');},unregister:async()=>{},createChannel:async()=>{calls.push('channel');}};
  const transport={configured,subscribe:async()=>{calls.push('subscribe');},unsubscribe:async()=>{}};
  return {listeners,states,calls,plugin,transport,options:{plugin,transport,platform:'android',onReceived:()=>{},onOpen:()=>{},onStatus:s=>states.push(s)}};
}
test('without configured delivery no permission/token requested',async()=>{
  const f=fixture(false),push=createNativePush(f.options);await assert.rejects(push.enable());assert.deepEqual(f.calls,[]);assert.deepEqual(f.listeners,{});
});
test('permission is not a successful registration',async()=>{
  const f=fixture(),push=createNativePush(f.options);await push.enable();assert.deepEqual(f.states,['registering']);await f.listeners.registration({value:'mock-device-token'});assert.deepEqual(f.states,['registering','active']);assert.deepEqual(f.calls,['channel','register','subscribe']);
});
test('server registration failures never show active',async()=>{
  const f=fixture();f.transport.subscribe=async()=>{throw Error('offline');};await createNativePush(f.options).enable();await f.listeners.registration({value:'mock-device-token'});assert.equal(f.states.at(-1),'registration_failed');assert(!f.states.includes('active'));
});
test('denied permission never registers',async()=>{
  const f=fixture();f.plugin.requestPermissions=async()=>({receive:'denied'});await createNativePush(f.options).enable();assert.deepEqual(f.states,['denied']);assert.deepEqual(f.calls,[]);
});
test('disable while registration is in flight never reactivates and removes late subscription',async()=>{
  const f=fixture();let complete;f.transport.subscribe=()=>new Promise(resolve=>{complete=resolve;});f.transport.unsubscribe=async()=>f.calls.push('unsubscribe');
  const push=createNativePush(f.options);await push.enable();const pending=f.listeners.registration({value:'token'});await push.disable();complete();await pending;
  assert(!f.states.includes('active'));assert.equal(f.calls.filter(x=>x==='unsubscribe').length,2);
});
test('preferences sync re-registers and test uses owned token',async()=>{
  const f=fixture();f.transport.test=async({token})=>f.calls.push('test-'+token);const push=createNativePush(f.options);
  await assert.rejects(push.test());await push.enable();await f.listeners.registration({value:'token'});await push.sync();await push.test();
  assert.equal(f.calls.filter(x=>x==='subscribe').length,2);assert(f.calls.includes('test-token'));
});
